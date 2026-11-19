import { loadState } from '../store/chromeStore';
import { normalizeHandle } from '../store/state';

const SCRIPT_ID = 'xck-followback';
const ORIGINS = ['https://x.com/*'];
const REFRESH = 'xck:followback:refresh';

async function config() {
  const allowed = await chrome.permissions.contains({ origins: ORIGINS });
  const settings = (await loadState()).settings;
  return {
    allowed,
    enabled: settings.followBackEnabled === true && settings.followBackOptIn === true,
    handle: normalizeHandle(settings.expectedHandle),
  };
}

async function notifyOpenTabs() {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) void chrome.tabs.sendMessage(tab.id, { type: REFRESH }).catch(() => {});
  }
}

async function syncRegistration() {
  const allowed = await chrome.permissions.contains({ origins: ORIGINS });
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0;
  if (allowed && !registered) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      matches: ORIGINS,
      js: ['followback.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  } else if (!allowed && registered) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  }
  if (allowed) {
    // Registration covers future loads; these tabs were open before access was granted.
    for (const tab of await chrome.tabs.query({ url: ORIGINS })) {
      if (tab.id !== undefined) void chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['followback.js'] }).catch(() => {});
    }
  }
  await notifyOpenTabs();
}

let pending = Promise.resolve();
function queueSync() {
  pending = pending.then(syncRegistration).catch((error) => console.error('Follow-back registration failed', error));
}

export function installFollowBack() {
  chrome.permissions.onAdded.addListener(queueSync);
  chrome.permissions.onRemoved.addListener(queueSync);
  chrome.runtime.onStartup.addListener(queueSync);
  chrome.runtime.onInstalled.addListener(queueSync);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['xgd:v1']) void notifyOpenTabs();
  });
  chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, reply) => {
    if (message?.type !== 'xck:followback:config') return false;
    void config().then(reply).catch(() => reply({ allowed: false, enabled: false, handle: null }));
    return true;
  });
  queueSync();
}
