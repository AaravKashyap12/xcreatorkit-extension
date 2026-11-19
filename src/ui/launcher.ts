import { bindReplyPanelLinks } from '../reply/open';
import { TOOLS, mountNavigation } from './navigation';
import { h } from './dom';
import { loadState, updateState } from '../store/chromeStore';
import { normalizeHandle } from '../store/state';
import { RUN_KEY, X_ORIGINS, isAnalyticsUrl, type RunStatus, type StepState } from '../capture/run';
import { isRewardsUrl } from '../extract/rewards';
import { followingOn, setFollowing } from './following';
import { feedbackMotion } from './motion';
import { reader, utcReadout } from './reader';
import { mountWalkthrough } from './walkthrough';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const toolsView = $('#tools-view');
const followingView = $('#following-view');
const followingTitle = $('#following-title');
const followingOpen = $<HTMLButtonElement>('#following-open');
const status = $('#capture-status');
const capture = $<HTMLButtonElement>('#capture');
const captureLabel = $('#capture-label');
// The strip: the reader and a UTC clock. While a read runs the reader's eyes travel.
const mark = reader();
$('#kit-reader').replaceWith(mark);
$('#kit-utc').replaceWith(utcReadout());
const tabNote = $('#tab-note');
const handle = $<HTMLInputElement>('#handle');
const highlight = $<HTMLInputElement>('#highlight');
const feedback = $('#following-status');
const handleField = $('#handle-field');
const handleError = $('#handle-error');
const followingState = $('#following-state');
const settingsAlert = $('#settings-alert');

const MISSING = 'Enter your X handle, or open your own Following page, then tick again.';
const DEFAULT_HINT = 'Read saves loaded X figures, @handle and UTC capture time locally for charts and receipts.';
// Same patterns the worker and the account detector use, so the hint never promises more than a read does.
const READABLE = /^https:\/\/x\.com\//;
const FOLLOWING_PAGE = /^https:\/\/x\.com\/\w{1,15}\/following\/?(?:[?#]|$)/i;
const PROFILE_PAGE = /^https:\/\/x\.com\/(?!(?:home|explore|notifications|messages|search|settings|compose|i)\/?(?:[?#]|$))\w{1,15}\/?(?:[?#]|$)/i;
const STEP_NAMES: Record<string, string> = { analytics: 'Analytics', rewards: 'Rewards', profile: 'Profile' };
const STEP_MARKS: Record<StepState, string> = { done: '✓', failed: '!', skipped: '–', running: '…', pending: '·' };

let settingsRequest = 0;
let tabMode = false;
let hint = DEFAULT_HINT;
let liveRun = false;
let captureRequest = 0;
let finishedRun: string | undefined;
const motion = feedbackMotion();

document.querySelector('#tool-list')!.append(...TOOLS.slice(0, -1).map((tool, i) => h('a', {
  // A hairline starts each group after the first (Numbers, Make, On X).
  class: i > 0 && tool.group !== TOOLS[i - 1]!.group ? 'tool-link group-start' : 'tool-link', href: tool.href, 'aria-label': tool.name, 'aria-description': tool.description,
  target: '_blank', rel: 'noopener',
}, h('strong', {}, tool.name), h('small', {}, tool.description), h('span', { class: 'go', 'aria-hidden': 'true' }, tool.href === 'reply.html' ? '▥' : '↗'))));

bindReplyPanelLinks(document.querySelector<HTMLElement>('#tool-list')!);

/** What the active tab is, judged from its URL only. Nothing on the page is read. */
function tabHint(url?: string) {
  if (!url) return DEFAULT_HINT;
  if (!READABLE.test(url)) return 'This tab isn’t X. Open your X Analytics, Rewards or profile page to read its numbers.';
  if (isAnalyticsUrl(url)) return 'X Analytics · Read saves loaded figures, @handle and UTC capture time locally.';
  if (isRewardsUrl(url)) return 'X Rewards · Read saves its figure, @handle and UTC capture time locally.';
  if (PROFILE_PAGE.test(url)) return 'Your X profile · Read saves follower counts, @handle and UTC capture time locally.';
  return DEFAULT_HINT;
}

// Two views share the popup. The hash is the only route state, so links to launcher.html#following work.
type View = 'tools' | 'following';
function show(view: View, focus: 'none' | 'heading' | 'handle' | 'row' = 'none') {
  const next = view === 'following' ? followingView : toolsView;
  const previous = view === 'following' ? toolsView : followingView;
  if (next.hidden) {
    motion.stop(previous);
    motion.stop(status);
    motion.stop(feedback);
    previous.hidden = true;
    next.hidden = false;
    motion.lift(next, 5);
  }
  if (focus === 'heading') followingTitle.focus();
  if (focus === 'handle') handle.focus();
  if (focus === 'row') followingOpen.focus();
}
const routedView = (): View => location.hash === '#following' ? 'following' : 'tools';
window.addEventListener('hashchange', () => show(routedView(), routedView() === 'following' ? 'handle' : 'none'));
followingOpen.addEventListener('click', () => {
  history.replaceState(null, '', '#following');
  show('following', 'heading');
});
$('#back').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  // Leaving clears messages about the last attempt; saved settings and the typed handle stay.
  showFeedback('');
  fieldError(null);
  show('tools', 'row');
});

function setBusy(busy: boolean) {
  capture.disabled = busy;
  capture.setAttribute('aria-busy', String(busy));
  captureLabel.textContent = busy ? 'Reading X…' : 'Read current X tab';
  mark.classList.toggle('reading', busy);
}
function showStatus(content: string | Node, error = false) {
  motion.stop(status);
  status.replaceChildren(content);
  status.classList.toggle('error', error);
  if (error) motion.lift(status, 2);
}
function showRun(run?: RunStatus, animate = true) {
  if (run?.finishedAt && run.id === finishedRun) return;
  setBusy(!!run && !run.finishedAt);
  finishedRun = run?.finishedAt ? run.id : undefined;
  if (!run) { showStatus(hint); return; }
  // Storage does not keep key order, so the steps are listed in the order the read runs them.
  const steps = (['analytics', 'rewards', 'profile'] as const).flatMap(key => {
    const step = run.steps[key];
    return step ? [h('li', { class: step.state },
      h('span', { class: 'mark', 'aria-hidden': 'true' }, STEP_MARKS[step.state] ?? ''),
      h('span', {}, h('span', { class: 'name' }, STEP_NAMES[key]!), ` ${step.message}`))] : [];
  });
  showStatus(h('ul', { class: 'run-steps' }, ...steps));
  // A finished read prints its result: the slip feeds out from under the key in printer steps.
  if (run.finishedAt && animate) {
    motion.play(status, { clipPath: 'inset(0 0 65% 0)' }, { clipPath: 'inset(0 0 0% 0)' }, .26, 'steps(5)');
  }
}
function enterTabMode() {
  tabMode = true;
  document.documentElement.classList.add('tab-mode');
  // In a tab the active tab is this page, so reading here could only read itself.
  tabNote.hidden = false;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.tool-link')) { link.removeAttribute('target'); link.removeAttribute('rel'); }
  if (!document.querySelector('.xck-shell')) mountNavigation();
}
capture.addEventListener('click', async () => {
  if (tabMode) { enterTabMode(); return; }
  const request = ++captureRequest;
  liveRun = true;
  setBusy(true);
  showStatus('Reading the current X tab…');
  try {
    // This API can fail too: keep its error and pending state inside the Read recovery path.
    if (await chrome.tabs.getCurrent()) { enterTabMode(); return; }
    const result = await chrome.runtime.sendMessage({ type: 'xck:capture-current' }) as RunStatus | { error: string };
    if (request !== captureRequest) return;
    if ('error' in result) throw new Error(result.error);
    showRun(result);
  } catch (error) {
    if (request === captureRequest) showStatus(`Could not read X: ${(error as Error).message}`, true);
  } finally {
    if (request === captureRequest) setBusy(false);
  }
});

function showHighlight() {
  followingState.textContent = highlight.checked ? 'On' : 'Off';
  followingState.classList.toggle('on', highlight.checked);
}
function showFeedback(message: string, error = false) {
  motion.stop(feedback);
  feedback.textContent = message;
  feedback.classList.toggle('error', error);
}
/** GOV.UK pattern: the message sits above the field, is tied to it and the typed value stays. */
function fieldError(message: string | null) {
  handleError.textContent = message ?? '';
  handleError.hidden = !message;
  handleField.classList.toggle('invalid', !!message);
  if (message) {
    handle.setAttribute('aria-invalid', 'true');
    handle.setAttribute('aria-describedby', 'handle-error');
  } else {
    handle.removeAttribute('aria-invalid');
    handle.removeAttribute('aria-describedby');
  }
}
/** Handle problems belong to the field; permission and service problems to the switch status. */
function problem(message: string, where: 'field' | 'status') {
  if (where === 'field') {
    showFeedback('');
    fieldError(message);
    handle.focus();
  } else {
    showFeedback(message, true);
  }
}
function confirm(message: string) {
  fieldError(null);
  showFeedback(message);
  motion.lift(feedback, 3);
}
async function currentFollowingAccount(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https:\/\/x\.com\/[\w]{1,15}\/following\/?(?:[?#]|$)/i.test(tab.url ?? '')) return null;
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
    const links = document.querySelectorAll<HTMLAnchorElement>('[data-testid="AppTabBar_Profile_Link"]');
    if (links.length !== 1) return null;
    const profile = new URL(links[0]!.href);
    const account = /^\/([a-z0-9_]{1,15})\/?$/i.exec(profile.pathname)?.[1]?.toLowerCase();
    return profile.origin === location.origin && location.pathname.replace(/\/$/, '').toLowerCase() === `/${account}/following` ? account ?? null : null;
  } });
  return result?.result ?? null;
}
highlight.addEventListener('change', async () => {
  const enabled = highlight.checked;
  const enteredHandle = normalizeHandle(handle.value);
  highlight.disabled = true;
  // A new attempt replaces the last one's messages. Nothing here awaits, so the prompt stays in the gesture.
  showFeedback('');
  fieldError(null);
  try {
    // setFollowing asks for x.com access before anything else is awaited: Chrome only prompts inside this click.
    const account = await setFollowing(enabled, async () => (await currentFollowingAccount()) ?? enteredHandle, MISSING);
    if (account) handle.value = account;
    highlight.checked = enabled;
    confirm(enabled ? '✓ Highlighting is on. Look for soft red rows on your Following page.' : 'Highlighting is off. Rows return to normal.');
  } catch (error) {
    highlight.checked = !enabled;
    const message = (error as Error).message;
    problem(message, message === MISSING ? 'field' : 'status');
  } finally { highlight.disabled = false; showHighlight(); }
});
$('#open-following').addEventListener('click', async () => {
  const account = normalizeHandle(handle.value);
  showFeedback('');
  if (!account) { problem('Enter a valid X handle, for example @yourhandle, to open your Following page.', 'field'); return; }
  fieldError(null);
  try {
    await updateState(state => { state.settings.expectedHandle = account; });
    await chrome.tabs.create({ url: `https://x.com/${account}/following` });
  } catch { problem('Could not open Following. Please try again.', 'status'); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[RUN_KEY]) {
    liveRun = true;
    showRun(changes[RUN_KEY].newValue as RunStatus | undefined);
  }
  if (area === 'local' && changes['xgd:v1']) resync();
});
async function syncFollowing() {
  const request = ++settingsRequest;
  const state = await loadState();
  const stored = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  const allowed = await chrome.permissions.contains({ origins: X_ORIGINS });
  if (request !== settingsRequest || highlight.disabled) return;
  settingsAlert.hidden = true;
  if (document.activeElement !== handle) handle.value = stored ? state.settings.expectedHandle : '';
  highlight.checked = followingOn(state.settings, !!stored, allowed);
  showHighlight();
}
const resync = () => void syncFollowing().catch(() => settingsFailed('Could not reload settings. Reopen the menu to try again.'));
chrome.permissions.onAdded.addListener(resync);
chrome.permissions.onRemoved.addListener(resync);

async function init() {
  show(routedView());
  if (await chrome.tabs.getCurrent()) enterTabMode();
  const tour = tabMode ? undefined : mountWalkthrough(toolsView, $<HTMLButtonElement>('#tour-replay'), motion);
  await Promise.all([syncFollowing(), tour]);
  if (!tabMode) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    hint = tabHint(tab?.url);
    if (FOLLOWING_PAGE.test(tab?.url ?? '')) show('following');
  }
  const run = (await chrome.storage.session.get(RUN_KEY))[RUN_KEY] as RunStatus | undefined;
  // A result from an earlier visit is shown as it stands; only a read that finishes now feeds out.
  if (!liveRun) showRun(run, false);
  if (routedView() === 'following') show('following', 'handle');
}
/** Settings could not be read: the state is unknown ("—"), and the message shows in whichever view is open. */
function settingsFailed(message: string) {
  followingState.textContent = '—';
  followingState.classList.remove('on');
  settingsAlert.textContent = message;
  settingsAlert.hidden = false;
  problem(message, 'status');
}
void init().catch(() => settingsFailed('Could not load settings. Reopen the tool chooser to try again.')).finally(() => { document.documentElement.dataset.ready = 'true'; });
