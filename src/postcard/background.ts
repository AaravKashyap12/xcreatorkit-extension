import { captureAvatar } from './avatar';
import { validPost, type PostcardPost } from './parse';

const ORIGINS = { origins: ['https://x.com/*'] };
const SCRIPT_ID = 'xck-postcard-target';
const MENU_ID = 'postcard';
const KEY = 'xck:postcard';
const page = (token: string) => chrome.runtime.getURL(`postcard.html#${token}`);
const isX = (url: string | undefined) => !!url && /^https:\/\/x\.com\//.test(url);

async function reconcile() {
  const consent = await chrome.storage.local.get('xck:postcard-consent');
  const granted = consent['xck:postcard-consent'] === 1 && await chrome.permissions.contains(ORIGINS);
  const registered = (await chrome.scripting.getRegisteredContentScripts()).some((s) => s.id === SCRIPT_ID);
  if (granted && !registered) {
    await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, js: ['postcard-target.js'], matches: ['https://x.com/*'], runAt: 'document_start' }]);
  }
  if (granted) {
    const tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    await Promise.all(tabs.map((tab) => tab.id ? chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['postcard-target.js'] }).catch(() => {}) : Promise.resolve()));
  }
  if (!granted && registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!granted) {
    // After revocation, URL-filtered queries no longer see x.com tabs. Message our
    // existing scripts by tab ID instead; unrelated tabs have no receiver.
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => tab.id ? chrome.tabs.sendMessage(tab.id, { type: 'xck:postcard:disable' }).catch(() => {}) : Promise.resolve()));
  }
}

export function registerPostcard() {
  let pending = Promise.resolve();
  const schedule = () => { pending = pending.then(reconcile).catch((error) => console.error('Postcard registration failed', error)); };
  schedule();
  chrome.runtime.onStartup.addListener(schedule);
  chrome.permissions.onAdded.addListener(schedule);
  chrome.permissions.onRemoved.addListener(schedule);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['xck:postcard-consent']) schedule();
  });
}

export function addPostcardMenu() {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Make an image of this post', contexts: ['all'], documentUrlPatterns: ['https://x.com/*'] });
}

export async function postcardMenuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (info.menuItemId !== MENU_ID) return false;
  if (!tab?.id || !isX(info.pageUrl) || info.frameId !== undefined && info.frameId !== 0) return true;
  // The shared host grant may have come from Following, without the photo disclosure.
  const consent = await chrome.storage.local.get('xck:postcard-consent');
  if (consent['xck:postcard-consent'] !== 1 || !(await chrome.permissions.contains(ORIGINS))) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('postcard.html#grant'), index: tab.index + 1 });
    return true;
  }
  if (!isX(tab.url)) return true;
  let response: { ok: boolean; post?: PostcardPost; sourceUrl?: string; avatar?: unknown; avatarToken?: unknown } | null = null;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: 'xck:postcard:collect' }, { frameId: 0 }); } catch { /* no target listener in this tab yet */ }
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!response?.ok || !validPost(response.post) || response.sourceUrl !== tab.url || current?.url !== tab.url) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('postcard.html#error'), index: tab.index + 1 });
    return true;
  }
  // X serves profile photos from another origin, so the photo is cropped from a screenshot of this tab instead.
  const photo = response.post.avatar ? null : await captureAvatar(tab, response.avatar, response.avatarToken);
  const post = photo && validPost({ ...response.post, avatar: photo }) ? { ...response.post, avatar: photo } : response.post;
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [KEY]: { token, tabId: tab.id, post } });
  await chrome.tabs.create({ url: page(token), index: tab.index + 1 });
  return true;
}

export function postcardMessage(message: { type?: string; token?: string }, sender: chrome.runtime.MessageSender, reply: (response: unknown) => void): boolean {
  if (message?.type !== 'xck:postcard:get') return false;
  const token = message.token;
  const expected = typeof token === 'string' && /^[a-f0-9-]{36}$/.test(token) ? page(token) : '';
  if (!expected || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.url !== expected || sender.tab?.url !== expected || !sender.tab.id) {
    reply({ ok: false }); return false;
  }
  void chrome.storage.session.get(KEY).then((record) => {
    const card = record[KEY] as { token?: string; tabId?: number; post?: unknown } | undefined;
    reply(card && card.token === token && typeof card.tabId === 'number' && validPost(card.post) ? { ok: true, post: card.post } : { ok: false });
  }).catch(() => reply({ ok: false }));
  return true;
}
