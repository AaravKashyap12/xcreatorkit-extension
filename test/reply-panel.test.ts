import { beforeEach, expect, it, vi } from 'vitest';
let allowed: boolean;
let writes: Record<string, any>[];
let collect: ReturnType<typeof vi.fn>;
const tab = { id: 7, windowId: 9, url: 'https://x.com/home' } as chrome.tabs.Tab;
const source = (text: string) => ({ ok: true, sourceUrl: tab.url, source: { text, author: 'Synthetic', url: 'https://x.com/test/status/1' } });
beforeEach(() => {
  vi.resetModules(); allowed = true; writes = []; collect = vi.fn(async () => source('Chosen post'));
  vi.stubGlobal('chrome', {
    sidePanel: { open: vi.fn(async () => {}) },
    storage: { local: { get: vi.fn(async () => ({ 'xck:reply-consent': 1 })) }, session: { set: vi.fn(async value => { writes.push(value); }) } },
    permissions: { contains: vi.fn(async () => allowed) },
    tabs: { sendMessage: collect, get: vi.fn(async () => tab), create: vi.fn() },
  });
});
it('opens in the original gesture before asynchronous reads and never creates a tab', async () => {
  const { replyMenuClicked } = await import('../src/reply/background');
  const work = replyMenuClicked({ menuItemId: 'reply', editable: false, frameId: 0, pageUrl: 'https://x.com/home' }, tab);
  expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 9 });
  await work;
  expect(writes[0]?.['xck:reply-panel:9'].source.text).toBe('Chosen post');
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});
it('permission revoked during collection cannot publish the captured text', async () => {
  collect.mockImplementation(async () => { allowed = false; return source('Must not hand off'); });
  const { replyMenuClicked } = await import('../src/reply/background');
  await replyMenuClicked({ menuItemId: 'reply', editable: false, frameId: 0, pageUrl: 'https://x.com/home' }, tab);
  expect(writes.every(w => !w['xck:reply-panel:9']?.source)).toBe(true);
});
it('a late older capture cannot overwrite the latest selection', async () => {
  let finish!: (value: unknown) => void;
  collect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { replyMenuClicked } = await import('../src/reply/background');
  const first = replyMenuClicked({ menuItemId: 'reply', editable: false, frameId: 0, pageUrl: 'https://x.com/home' }, tab);
  await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
  await replyMenuClicked({ menuItemId: 'reply', editable: false, frameId: 0, pageUrl: 'https://x.com/home' }, tab);
  finish(source('Old post')); await first;
  expect(writes).toHaveLength(1);
  expect(writes[0]?.['xck:reply-panel:9'].source.text).toBe('Chosen post');
});
