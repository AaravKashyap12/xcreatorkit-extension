import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/model/types';
import { followingOn, setFollowing } from '../src/ui/following';
import { loadState } from '../src/store/chromeStore';

// SYNTHETIC settings only. A minimal chrome.storage / permissions boundary.
let stored: Record<string, unknown> = {};
const request = vi.fn(async () => true);
beforeEach(() => {
  stored = {};
  request.mockReset().mockResolvedValue(true);
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: { get: async (k: string) => (k in stored ? { [k]: stored[k] } : {}), set: async (v: Record<string, unknown>) => void Object.assign(stored, v) } },
    permissions: { request },
  };
});
const saved = () => (stored['xgd:v1'] as { settings: ReturnType<typeof defaultSettings> } | undefined)?.settings;

describe('default account', () => {
  it('starts with no handle on a new install', () => expect(defaultSettings().expectedHandle).toBe(''));
  it('keeps a stored handle and preferences', async () => {
    stored['xgd:v1'] = { schemaVersion: 1, settings: { expectedHandle: 'kept_handle', followBackEnabled: false }, accounts: {} };
    const s = (await loadState()).settings;
    expect([s.expectedHandle, s.followBackEnabled]).toEqual(['kept_handle', false]);
  });
});

describe('explicit Following choice', () => {
  it('does not enable from an account and a grant alone, including an old default', async () => {
    for (const legacy of [{}, { followBackEnabled: true }]) {
      stored['xgd:v1'] = { schemaVersion: 1, settings: { expectedHandle: 'samplecreator', ...legacy }, accounts: {} };
      expect(followingOn((await loadState()).settings, true, true)).toBe(false);
    }
  });
});

describe('followingOn', () => {
  const s = { ...defaultSettings(), expectedHandle: 'samplecreator', followBackEnabled: true, followBackOptIn: true };
  it('needs stored settings, the preference, x.com access and a valid handle', () => {
    expect(followingOn(s, true, true)).toBe(true);
    expect(followingOn(s, false, true)).toBe(false);
    expect(followingOn(s, true, false)).toBe(false);
    expect(followingOn({ ...s, followBackEnabled: false }, true, true)).toBe(false);
    expect(followingOn({ ...s, expectedHandle: '' }, true, true)).toBe(false);
  });
});

describe('setFollowing', () => {
  it('asks for x.com access first, then saves the account and the preference', async () => {
    const account = vi.fn(async () => {
      expect(request).toHaveBeenCalledTimes(1);
      return 'samplecreator';
    });
    expect(await setFollowing(true, account, 'missing')).toBe('samplecreator');
    expect([saved()?.expectedHandle, saved()?.followBackEnabled, saved()?.followBackOptIn]).toEqual(['samplecreator', true, true]);
    expect(followingOn((await loadState()).settings, true, true)).toBe(true);
  });
  it('saves nothing when access is refused', async () => {
    request.mockResolvedValue(false);
    await expect(setFollowing(true, () => 'samplecreator', 'missing')).rejects.toThrow('Allow x.com access');
    expect(saved()).toBeUndefined();
  });
  it('saves nothing without an account and names the fix', async () => {
    await expect(setFollowing(true, () => null, 'Enter your X handle')).rejects.toThrow('Enter your X handle');
    expect(saved()).toBeUndefined();
  });
  it('turns off without a prompt', async () => {
    await setFollowing(false, () => null, 'missing');
    expect(request).not.toHaveBeenCalled();
    expect(saved()?.followBackEnabled).toBe(false);
  });
});
