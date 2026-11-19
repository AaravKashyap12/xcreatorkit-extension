import { addReplyMenu, registerReply, replyMenuClicked, replyMessage } from './reply/background';
// Service worker. The toolbar opens the chooser; capture starts only on request.
import { RUN_KEY, runCapture, type RunStatus } from './capture/run';
import { installFollowBack } from './followback/register';
import { addPostcardMenu, postcardMenuClicked, postcardMessage, registerPostcard } from './postcard/background';
import { TOUR_KEY } from './ui/walkthrough';

const page = (p: string) => chrome.runtime.getURL(p);

let running: Promise<RunStatus> | null = null;
function start(active: chrome.tabs.Tab | undefined) {
  // Ignore double-clicks while a capture is in flight.
  running ??= runCapture(active).finally(() => (running = null));
  return running;
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  if (replyMessage(msg, _sender, reply)) return true;
  if (postcardMessage(msg, _sender, reply)) return true;
  if (msg?.type === 'xck:capture-current') {
    if (_sender.id !== chrome.runtime.id || _sender.url?.split('#')[0] !== page('launcher.html')) {
      reply({ error: 'Open the tool chooser to read the current tab.' });
      return false;
    }
    void chrome.tabs.query({ active: true, lastFocusedWindow: true })
      .then(async ([tab]) => {
        if (!/^https:\/\/x\.com\//.test(tab?.url ?? '')) return { error: 'Open X Analytics, Rewards or your profile, then use the toolbar menu to read it.' };
        return start(tab);
      })
      .then(reply, () => reply({ error: 'The current tab could not be read. Open X and try again.' }));
    return true;
  }
  if (msg?.type === 'xgd:recapture') {
    reply({ error: 'Open a source page on X, then choose Read current X tab from the toolbar.' });
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    const items: [string, string][] = [
      ['receipt', 'X Creator Kit · Print growth receipt'],
      ['report', 'X Creator Kit · Ledger report'],
      ['dashboard', 'X Creator Kit · Rewards pace'],
      ['analytics', 'X Creator Kit · All analytics charts'],
    ];
    for (const [id, title] of items) chrome.contextMenus.create({ id, title, contexts: ['action'] });
    addPostcardMenu();
    addReplyMenu();
  });
  void chrome.storage.session.remove(RUN_KEY);
  if (reason === 'install') void chrome.storage.local.set({ [TOUR_KEY]: 1 }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'postcard') return;
  const map: Record<string, string> = { receipt: 'receipt.html', report: 'report.html', dashboard: 'dashboard.html', analytics: 'analytics.html' };
  const p = map[String(info.menuItemId)];
  if (p) void chrome.tabs.create({ url: page(p) });
});

installFollowBack();
chrome.contextMenus.onClicked.addListener((info, tab) => { void postcardMenuClicked(info, tab); });
registerPostcard();

registerReply();
chrome.contextMenus.onClicked.addListener((info, tab) => { void replyMenuClicked(info, tab); });
