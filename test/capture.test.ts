import { describe, it, expect, vi } from 'vitest';
import { runCapture } from '../src/capture/run';
vi.mock('../src/store/chromeStore', () => ({ updateState: vi.fn() }));

describe('explicit current-tab capture', () => {
  const setup = () => {
    const executeScript = vi.fn(async () => [{ result: { ok: false, message: 'Synthetic source unavailable' } }]);
    const create = vi.fn(() => { throw new Error('Capture must not create a tab'); });
    vi.stubGlobal('chrome', {
      storage: { session: { set: vi.fn() }, local: { get: vi.fn(async () => ({ 'xgd:v1': { settings: { expectedHandle: 'creator' } } })) } },
      scripting: { executeScript }, tabs: { create },
      permissions: { contains: vi.fn(async () => true) },
    });
    return { executeScript, create };
  };
  it('never opens or reads sources without a selected tab, even with host access', async () => {
    const api = setup(); const result = await runCapture(undefined);
    expect(api.create).not.toHaveBeenCalled(); expect(api.executeScript).not.toHaveBeenCalled();
    expect(Object.values(result.steps).every(s => s.state === 'skipped')).toBe(true);
  });
  it('reads only the chosen Analytics tab and never requests another range', async () => {
    const api = setup(); const result = await runCapture({ id: 7, url: 'https://x.com/i/account_analytics' } as chrome.tabs.Tab);
    expect(api.create).not.toHaveBeenCalled(); expect(api.executeScript).toHaveBeenCalledTimes(1);
    expect(api.executeScript.mock.calls[0]).toEqual([{ target: { tabId: 7 }, world: 'MAIN', func: expect.any(Function), args: [] }]);
    expect(result.steps.analytics.state).toBe('failed'); expect(result.steps.rewards.state).toBe('skipped'); expect(result.steps.profile?.state).toBe('skipped');
  });
  it('does not read unrelated X pages', async () => {
    const api = setup(); await runCapture({ id: 8, url: 'https://x.com/home' } as chrome.tabs.Tab);
    expect(api.create).not.toHaveBeenCalled(); expect(api.executeScript).not.toHaveBeenCalled();
  });
});
