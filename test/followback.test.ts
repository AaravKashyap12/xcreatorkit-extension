import { describe, expect, it, vi } from 'vitest';
import { emptyState } from '../src/store/state';
import { installFollowBack } from '../src/followback/register';

describe('follow-back registration', () => {
  it('registers only with optional access, injects open tabs, and unregisters on revocation', async () => {
    let allowed = false;
    let registered = false;
    const callbacks: Record<string, (() => void)[]> = { added: [], removed: [], startup: [], installed: [] };
    const on = (key: keyof typeof callbacks) => ({ addListener: (fn: () => void) => callbacks[key]!.push(fn) });
    const register = vi.fn(async () => { registered = true; });
    const unregister = vi.fn(async () => { registered = false; });
    const inject = vi.fn(async () => []);
    const notify = vi.fn(async () => undefined);
    const state = emptyState();
    const fake = {
      permissions: {
        contains: vi.fn(async () => allowed),
        onAdded: on('added'),
        onRemoved: on('removed'),
      },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => registered ? [{ id: 'xck-followback' }] : []),
        registerContentScripts: register,
        unregisterContentScripts: unregister,
        executeScript: inject,
      },
      tabs: {
        query: vi.fn(async (query: { url?: string[] }) => query.url ? [{ id: 7 }] : [{ id: 7 }]),
        sendMessage: notify,
      },
      storage: {
        local: { get: vi.fn(async () => ({ 'xgd:v1': state })) },
        onChanged: { addListener: vi.fn() },
      },
      runtime: {
        onStartup: on('startup'),
        onInstalled: on('installed'),
        onMessage: { addListener: vi.fn() },
      },
    };
    vi.stubGlobal('chrome', fake);
    try {
      installFollowBack();
      await vi.waitFor(() => expect(fake.permissions.contains).toHaveBeenCalled());
      expect(register).not.toHaveBeenCalled();
      allowed = true;
      callbacks.added![0]!();
      await vi.waitFor(() => expect(inject).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['followback.js'] }));
      expect(register).toHaveBeenCalledWith([expect.objectContaining({
        id: 'xck-followback', matches: ['https://x.com/*'], persistAcrossSessions: true,
      })]);
      allowed = false;
      callbacks.removed![0]!();
      await vi.waitFor(() => expect(unregister).toHaveBeenCalledWith({ ids: ['xck-followback'] }));
      expect(notify).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
