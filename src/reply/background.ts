import { CONSENT, type Source } from './core';
const ORIGINS = { origins: ['https://x.com/*'] };
const SCRIPT = 'xck-reply-target';
const PANEL_PREFIX = 'xck:reply-panel:';
const panelUrl = () => chrome.runtime.getURL('reply.html?panel');
const latest = new Map<number, string>();
let claims = Promise.resolve();
export function addReplyMenu() { chrome.contextMenus.create({ id: 'reply', title: 'Draft a reply to this post', contexts: ['all'], documentUrlPatterns: ORIGINS.origins }); }
async function reconcile() {
  const consent = (await chrome.storage.local.get(CONSENT))[CONSENT] === 1;
  const enabled = consent && await chrome.permissions.contains(ORIGINS);
  if (!consent) {
    latest.clear();
    const records = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(records).filter(k => k.startsWith(PANEL_PREFIX)));
  }
  const registered = (await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === SCRIPT);
  if (enabled && !registered) await chrome.scripting.registerContentScripts([{ id: SCRIPT, js: ['reply-target.js'], matches: ORIGINS.origins, runAt: 'document_start' }]);
  if (!enabled && registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT] });
  const tabs = await chrome.tabs.query(enabled ? { url: 'https://x.com/*' } : {});
  await Promise.all(tabs.map(async tab => {
    if (!tab.id) return;
    try {
      if (enabled) await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['reply-target.js'] });
      else await chrome.tabs.sendMessage(tab.id, { type: 'xck:reply:disable' });
    } catch { /* Closed tabs and pages without a receiver need no action. */ }
  }));
}
export function registerReply() {
  let pending = Promise.resolve();
  const schedule = () => { pending = pending.then(reconcile).catch(() => {}); };
  schedule();
  chrome.runtime.onStartup.addListener(schedule);
  chrome.permissions.onAdded.addListener(schedule);
  chrome.permissions.onRemoved.addListener(schedule);
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[CONSENT]) schedule(); });
  chrome.windows.onRemoved.addListener(id => { latest.delete(id); void chrome.storage.session.remove(PANEL_PREFIX + id); });
}
async function openReply(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (info.menuItemId !== 'reply' || tab?.windowId === undefined || (info.frameId !== undefined && info.frameId !== 0)) return;
  // Chrome requires open() in the original context-menu gesture, before any await.
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  const request = crypto.randomUUID();
  latest.set(tab.windowId, request);
  await opening;
  let source: Source | undefined;
  if (tab?.id && /^https:\/\/x\.com\//.test(tab.url ?? '') && (await chrome.storage.local.get(CONSENT))[CONSENT] === 1 && await chrome.permissions.contains(ORIGINS)) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'xck:reply:collect' }, { frameId: 0 });
      const current = await chrome.tabs.get(tab.id);
      const s = result?.source;
      if (result?.ok && result.sourceUrl === tab.url && current.url === tab.url && s && typeof s.text === 'string' && s.text.trim().length > 0 && s.text.length <= 3000 && typeof s.author === 'string' && s.author.length <= 120 && typeof s.url === 'string' && /^https:\/\/x\.com\/\w{1,15}\/status\/\d{1,25}$/.test(s.url)) source = { text: s.text, author: s.author, url: s.url };
    } catch { /* Offer paste fallback when capture fails. */ }
  }
  if ((await chrome.storage.local.get(CONSENT))[CONSENT] !== 1) return;
  if (!await chrome.permissions.contains(ORIGINS)) source = undefined;
  if (latest.get(tab.windowId) !== request) return;
  // One bounded, temporary handoff per browser window. Only a real side-panel document may claim it.
  await chrome.storage.session.set({ [PANEL_PREFIX + tab.windowId]: { source, at: Date.now() } });
}
export function replyMessage(message: { type?: string; windowId?: unknown }, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) {
  if (message?.type === 'xck:reply:panel-get') {
    if (sender.id !== chrome.runtime.id || sender.url !== panelUrl() || sender.tab || !Number.isInteger(message.windowId) || (message.windowId as number) < 0) { reply({ ok: false }); return false; }
    claims = claims.then(async () => {
      const contexts = await chrome.runtime.getContexts({ documentUrls: [panelUrl()], contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] });
      // Chrome omits sender.documentId and reports windowId -1 for global panels.
      // The exact packaged URL, own extension ID and absence of sender.tab identify
      // this trusted surface; content scripts and lookalike tabs are rejected. The panel supplies
      // chrome.windows.getCurrent().id; ordinary extension tabs/content scripts are rejected above.
      const context = contexts.find(c => c.documentUrl === panelUrl());
      if (!context || (await chrome.storage.local.get(CONSENT))[CONSENT] !== 1) { reply({ ok: false }); return; }
      await chrome.windows.get(message.windowId as number);
      const key = PANEL_PREFIX + message.windowId;
      const record = (await chrome.storage.session.get(key))[key];
      if (!record) { reply({ ok: false }); return; }
      await chrome.storage.session.remove(key);
      const allowed = await chrome.permissions.contains(ORIGINS);
      reply(Date.now() - record.at <= 60_000 ? { ok: true, source: allowed ? record.source : undefined } : { ok: false });
    }).catch(() => reply({ ok: false }));
    return true;
  }
  return false;
}

export function replyMenuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  return openReply(info, tab).catch(() => {});
}
