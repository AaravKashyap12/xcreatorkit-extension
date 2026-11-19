// Built extension, disposable profile, synthetic data only.
// Three surfaces are checked separately and named as such:
//   real popup  - Chrome's own action popup, opened with chrome.action.openPopup() and driven over CDP
//   popup page  - launcher.html in a 340px page with chrome.tabs.getCurrent() reporting "not a tab"
//   tab         - launcher.html opened as an ordinary tab (the Following settings route from tool pages)
//
// The reader redesign (docs/v1/EXTENSION-READER.md) retired three checks; each is replaced, none is dropped:
//   "Chooser keyboard starts at Analytics" / "Read current X tab is last"
//        -> Read is the popup's first control, then the six tools, and Following settings is last
//   "Desktop: current tool is filled and underlined, without a focus ring"
//        -> the current tool is a paper chip (white face, ink text), still without a focus ring
// New: the reader strip and UTC readout, the three groups, the eyes travelling during a read, and the result slip.
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
assert.equal(manifest.action.default_popup, 'launcher.html', 'Toolbar click must open the tool chooser');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-nav-')), {
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
  headless: true, args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
});
let checks = 1;
const check = (name, ok, detail) => { assert.ok(ok, detail === undefined ? name : `${name}: ${detail}`); console.log(`PASS ${name}`); checks++; };
const errors = [], requests = [];
ctx.on('page', p => p.on('pageerror', e => errors.push(String(e))));
ctx.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
const shots = 'verification/navigation';
mkdirSync(shots, { recursive: true });
const RUN = 'xgd:run';
const TOUR = 'xck:quick-tour-pending';
const LONG_RUN = {
  id: 'synthetic-long', startedAt: '2026-10-30T10:00:00Z', finishedAt: '2026-10-30T10:00:05Z', account: null,
  steps: {
    analytics: { state: 'skipped', message: 'not refreshed: x.com access is not granted and the tab you clicked from was not X Analytics' },
    rewards: { state: 'skipped', message: 'not refreshed: x.com access is not granted and the tab you clicked from was not the rewards page' },
    profile: { state: 'failed', message: 'failed: rewards page shows @fixture_creator_a, analytics showed @fixture_creator_b; not saved' },
  },
};

/** Chrome's real action popup. Playwright does not list it as a Page, so attach to its target over CDP. */
async function openRealPopup(worker, anchor, context = ctx) {
  await anchor.bringToFront();
  const opened = await worker.evaluate(async () => { try { await chrome.action.openPopup(); return 'ok'; } catch (e) { return String(e.message); } });
  if (opened !== 'ok') return { error: opened };
  const cdp = await context.newCDPSession(anchor);
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.type === 'page' && /\/launcher\.html(#.*)?$/.test(t.url));
    if (!target) await new Promise(r => setTimeout(r, 100));
  }
  if (!target) return { error: 'popup target did not appear' };
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let id = 0; const waiting = new Map();
  cdp.on('Target.receivedMessageFromTarget', ({ sessionId: s, message }) => {
    const m = JSON.parse(message);
    if (s === sessionId && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const mid = ++id;
    waiting.set(mid, m => m.error ? fail(new Error(m.error.message)) : ok(m.result));
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: mid, method, params }) }).catch(fail);
  });
  const evaluate = async (fn, arg) => {
    const res = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  };
  const screenshot = async (file) => writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const key = async (key, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}),
    });
  };
  const close = async () => {
    const { targetId } = target;
    await cdp.send('Target.closeTarget', { targetId });
    // Chrome acknowledges the close before the old toolbar popup disappears.
    const deadline = Date.now() + 5000;
    while ((await cdp.send('Target.getTargets')).targetInfos.some(t => t.targetId === targetId)) {
      assert(Date.now() < deadline, 'Chrome did not close the previous popup');
      await anchor.waitForTimeout(25);
    }
    await cdp.detach();
  };
  return { evaluate, screenshot, key, close };
}
const popupMetrics = () => ({
  width: innerWidth, height: innerHeight, content: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
  view: document.querySelector('#following-view').hidden ? 'tools' : 'following',
  captureBottom: document.querySelector('#capture').getBoundingClientRect().bottom,
  footerBottom: document.querySelector('footer').getBoundingClientRect().bottom,
});
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const readyPopup = popup => popup.evaluate(() => new Promise(resolve => {
  const ready = () => document.documentElement.dataset.ready ? resolve() : setTimeout(ready, 20);
  ready();
}));

async function testInstallAndUpgrade() {
  // An installed older build has the same extension ID and profile on restart.
  // Its fixture worker represents a version before walkthrough storage existed.
  const root = mkdtempSync(join(tmpdir(), 'xck-nav-upgrade-'));
  const extension = join(root, 'extension');
  cpSync('dist', extension, { recursive: true });
  const launch = () => chromium.launchPersistentContext(join(root, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const installedWorker = async context => context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const complete = async (context, worker) => {
    const anchor = await context.newPage();
    const popup = await openRealPopup(worker, anchor, context);
    assert(!popup.error, popup.error);
    await readyPopup(popup);
    check('Another fresh native popup offers the walkthrough', await popup.evaluate(() => !document.querySelector('#quick-tour').hidden));
    for (const label of ['Next', 'Next', 'Done']) {
      await popup.evaluate(() => document.querySelector('.tour-next').click());
      if (label !== 'Done') check(`Fresh walkthrough ${label} focuses its new step`, await popup.evaluate(() => document.activeElement.id === 'tour-title'));
    }
    check('Done dismisses the fresh tour and focuses Quick tour', await popup.evaluate(() => document.querySelector('#quick-tour').hidden && document.activeElement.id === 'tour-replay'));
    check('Completion clears the first-install marker', !(await worker.evaluate(key => chrome.storage.local.get(key), TOUR))[TOUR]);
    await popup.close();
    const reopened = await openRealPopup(worker, anchor, context);
    assert(!reopened.error, reopened.error);
    await readyPopup(reopened);
    check('Fresh completion stays dismissed on reopen', await reopened.evaluate(() => document.querySelector('#quick-tour').hidden));
    await reopened.close();
  };
  let profile;
  try {
    profile = await launch();
    await complete(profile, await installedWorker(profile));
    await profile.close();
    rmSync(join(root, 'profile'), { recursive: true, force: true });
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ ...manifest, version: '0.2.0' }));
    writeFileSync(join(extension, 'background.js'), `chrome.runtime.onInstalled.addListener(({reason}) => {
      if (reason === 'install') void chrome.storage.local.set({ 'xck:reply-consent': 1 });
    });`);
    profile = await launch();
    const previous = await installedWorker(profile);
    const before = await previous.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(before, { 'xck:reply-consent': 1 });
    const id = new URL(previous.url()).host;
    await profile.close();
    cpSync('dist', extension, { recursive: true });
    profile = await launch();
    const upgraded = await installedWorker(profile);
    assert.equal(new URL(upgraded.url()).host, id);
    assert.equal(await upgraded.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
    assert.deepEqual(await upgraded.evaluate(() => chrome.storage.local.get(null)), before);
    const anchor = await profile.newPage();
    const popup = await openRealPopup(upgraded, anchor, profile);
    assert(!popup.error, popup.error);
    await readyPopup(popup);
    check('Upgrade preserves existing consent and shows only the manual tour entry', await popup.evaluate(() => document.querySelector('#quick-tour').hidden && !document.querySelector('#tour-replay').hidden));
    await popup.evaluate(() => document.querySelector('#tour-replay').click());
    check('An upgraded profile can replay the tour', await popup.evaluate(() => !document.querySelector('#quick-tour').hidden));
    await popup.close();
  } finally {
    await profile?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The chooser page as the popup sees itself: chrome.tabs.getCurrent() resolves to undefined in a popup. */
async function chooserPage(base, { url = 'launcher.html', activeUrl, width = 340, init, waitForReady = true } = {}) {
  const p = await ctx.newPage();
  if (init) await p.addInitScript(init);
  await p.addInitScript((activeUrl) => {
    chrome.tabs.getCurrent = async () => undefined;
    if (activeUrl) chrome.tabs.query = async () => [{ id: 999, url: activeUrl }];
    window.permissionAddedListeners = [];
    const add = chrome.permissions.onAdded.addListener.bind(chrome.permissions.onAdded);
    chrome.permissions.onAdded.addListener = (listener) => { window.permissionAddedListeners.push(listener); add(listener); };
  }, activeUrl ?? null);
  await p.setViewportSize({ width, height: 600 });
  await p.goto(`${base}/${url}`);
  await p.locator('#tools-title', { hasText: 'Choose a tool' }).waitFor({ state: 'attached' });
  if (waitForReady) await p.locator('html[data-ready]').waitFor({ state: 'attached' });
  return p;
}
const bodyHeight = (p) => p.evaluate(() => Math.round(document.body.getBoundingClientRect().height));
const layoutAudit = (p) => p.evaluate(() => {
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const small = [...document.querySelectorAll('a, button, input')].filter(visible).map(el => {
    const r = (el.labels?.[0] && el.type === 'checkbox' ? el.labels[0] : el).getBoundingClientRect();
    return { el: el.id || el.textContent.trim(), w: r.width, h: r.height };
  }).filter(t => t.w < 24 || t.h < 24);
  const tiny = [...document.querySelectorAll('body *')].filter(el => visible(el) && !el.closest('.sr-only') && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
    .map(el => ({ text: el.textContent.trim().slice(0, 30), size: parseFloat(getComputedStyle(el).fontSize) })).filter(t => t.size < 12.5);
  const rows = [...document.querySelectorAll('.tool-link, #following-open')].filter(visible).map(el => el.getBoundingClientRect().height);
  return { small, tiny, rows, overflow: document.documentElement.scrollWidth - innerWidth };
});

try {
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(worker.url()).host}`;

  // ---------- Real popup: Chrome sizes the window from the page ----------
  const anchor = await ctx.newPage();
  await anchor.goto('about:blank');
  const tabsBeforeTour = ctx.pages().length;
  const pop = await openRealPopup(worker, anchor);
  check('Real popup: chrome.action.openPopup opens the chooser', !pop.error, pop.error);
  await readyPopup(pop);
  const fresh = await pop.evaluate(() => ({
    step: document.querySelector('#tour-count').textContent,
    first: document.querySelector('#capture').hasAttribute('data-tour-anchor'),
    focused: document.activeElement.tagName,
    read: !document.querySelector('#capture').disabled,
    fits: document.documentElement.scrollWidth <= innerWidth,
  }));
  check('Fresh native popup anchors its tour to Read and leaves the action and focus available', fresh.first && fresh.step === 'Quick tour · 1 of 3' && fresh.focused === 'BODY' && fresh.read && fresh.fits, JSON.stringify(fresh));
  await wait(200);
  await pop.screenshot(`${shots}/popup-native-tour-read.png`);
  await pop.key('Tab', 'Tab', 9);
  check('Read is still the first keyboard action during the tour', await pop.evaluate(() => document.activeElement.id === 'capture'));
  await pop.key('Tab', 'Tab', 9);
  check('Skip tour is available directly by keyboard', await pop.evaluate(() => document.activeElement.textContent === 'Skip tour'));
  await pop.key('Enter', 'Enter', 13);
  check('Skipping immediately restores focus to Quick tour', await pop.evaluate(() => document.querySelector('#quick-tour').hidden && document.activeElement.id === 'tour-replay'));
  check('Skipping clears the fresh-install marker', !(await worker.evaluate(key => chrome.storage.local.get(key), TOUR))[TOUR]);
  check('Fresh tour never performs a capture, opts into drafting or creates a tab', requests.length === 0 && ctx.pages().length === tabsBeforeTour && await worker.evaluate(async () => !(await chrome.storage.session.get('xgd:run'))['xgd:run'] && !(await chrome.storage.local.get('xck:reply-consent'))['xck:reply-consent']));
  await wait(300);
  const native = await pop.evaluate(popupMetrics);
  check('Real popup: 340px wide', native.width === 340, JSON.stringify(native));
  check('Real popup: default height within 460–480', native.height >= 460 && native.height <= 480, JSON.stringify(native));
  check('Real popup: default content fits without scrolling', native.content <= native.height && native.scrollWidth <= native.width, JSON.stringify(native));
  check('Real popup: Read button and trust line are visible', native.captureBottom <= native.height && native.footerBottom <= native.height, JSON.stringify(native));
  check('Real popup: first use has no prefilled account', await pop.evaluate(() => document.querySelector('#handle').value === ''));
  await pop.screenshot(`${shots}/popup-native-default.png`);
  await pop.evaluate(() => document.querySelector('#following-open').click());
  await wait(400);
  const nativeFollowing = await pop.evaluate(popupMetrics);
  check('Real popup: Following view opens in place', nativeFollowing.view === 'following');
  check('Real popup: Following view keeps the popup size', Math.abs(nativeFollowing.height - native.height) <= 1 && nativeFollowing.content <= nativeFollowing.height, JSON.stringify(nativeFollowing));
  await pop.screenshot(`${shots}/popup-native-following.png`);
  await pop.evaluate(() => { document.querySelector('#handle').value = 'not a handle!'; document.querySelector('#open-following').click(); });
  await wait(200);
  const nativeError = await pop.evaluate(() => ({ ...({ height: innerHeight, content: document.documentElement.scrollHeight }), error: document.querySelector('#handle-error').textContent, errorBottom: document.querySelector('#open-following').getBoundingClientRect().bottom }));
  check('Real popup: handle error fits without clipping', /valid X handle/.test(nativeError.error) && nativeError.content <= nativeError.height && nativeError.errorBottom <= nativeError.height, JSON.stringify(nativeError));
  await pop.screenshot(`${shots}/popup-native-handle-error.png`);
  // The page does not claim Escape; it stays with the browser. CDP keys reach the page, not Chrome's own
  // popup accelerator, so this proves only that the page leaves the view alone (native close is a manual check).
  await pop.key('Escape', 'Escape', 27);
  check('Real popup: page does not hijack Escape', (await pop.evaluate(popupMetrics)).view === 'following');
  await pop.evaluate(() => document.querySelector('#back').click());
  await wait(300);
  check('Real popup: Back returns to tools at the same size', (await pop.evaluate(popupMetrics)).view === 'tools' && (await pop.evaluate(popupMetrics)).height === native.height);
  await worker.evaluate(run => chrome.storage.session.set({ 'xgd:run': run }), LONG_RUN);
  await wait(500);
  const nativeLong = await pop.evaluate(() => {
    const s = document.querySelector('#capture-status');
    return { height: innerHeight, content: document.documentElement.scrollHeight, lines: s.querySelectorAll('li').length, clipped: s.scrollHeight - s.clientHeight, footerBottom: document.querySelector('footer').getBoundingClientRect().bottom };
  });
  check('Real popup: long read results show every step', nativeLong.lines === 3, JSON.stringify(nativeLong));
  // Chrome caps popups at 600px; this headless build caps them lower (498px), so a long result may scroll here.
  // Either way nothing may be cut off: the content stays under Chrome's cap and the end scrolls into view.
  const longEnd = await pop.evaluate(() => { scrollTo(0, document.documentElement.scrollHeight); const r = { bottom: document.querySelector('footer').getBoundingClientRect().bottom, height: innerHeight, overflowY: getComputedStyle(document.documentElement).overflowY, bodyOverflowY: getComputedStyle(document.body).overflowY }; scrollTo(0, 0); return r; });
  check('Real popup: long read results are never clipped (content ≤ 600, end reachable)', nativeLong.clipped <= 0 && nativeLong.content <= 600 && longEnd.bottom <= longEnd.height + 1 && longEnd.overflowY !== 'hidden' && longEnd.bodyOverflowY !== 'hidden', JSON.stringify({ nativeLong, longEnd }));
  console.log(`  real popup with long results: ${nativeLong.height}px window for ${nativeLong.content}px content`);
  await pop.screenshot(`${shots}/popup-native-long-result.png`);
  await worker.evaluate(() => chrome.storage.session.remove('xgd:run'));
  await pop.close();
  const replay = await openRealPopup(worker, anchor);
  assert(!replay.error, replay.error);
  await readyPopup(replay);
  check('Skipped tour stays dismissed on reopen', await replay.evaluate(() => document.querySelector('#quick-tour').hidden));
  await replay.evaluate(() => document.querySelector('#tour-replay').focus());
  await replay.key('Enter', 'Enter', 13);
  check('Replay starts at the Read step and focuses its heading', await replay.evaluate(() => document.activeElement.id === 'tour-title' && document.querySelector('#capture').hasAttribute('data-tour-anchor')));
  const advance = () => replay.evaluate(() => document.querySelector('.tour-next').click());
  await advance();
  check('Next anchors to the real Analytics link', await replay.evaluate(() => document.querySelector('[data-tour-anchor]').getAttribute('href') === 'analytics.html' && document.activeElement.id === 'tour-title'));
  await replay.evaluate(() => Array.from(document.querySelectorAll('#quick-tour button')).find(b => b.textContent === 'Back').click());
  check('Back returns to Read', await replay.evaluate(() => document.querySelector('#capture').hasAttribute('data-tour-anchor')));
  await advance(); await advance();
  check('Final step points to Reply drafter and keeps Done in view', await replay.evaluate(() => document.querySelector('[data-tour-anchor]').getAttribute('href') === 'reply.html' && document.querySelector('.tour-next').textContent === 'Done' && document.querySelector('.tour-next').getBoundingClientRect().bottom <= innerHeight));
  await wait(200);
  await replay.screenshot(`${shots}/popup-native-tour-reply.png`);
  await replay.key('Escape', 'Escape', 27);
  check('Escape dismisses the active tour and returns focus', await replay.evaluate(() => document.querySelector('#quick-tour').hidden && document.activeElement.id === 'tour-replay'));
  await replay.close();
  await anchor.close();
  await testInstallAndUpgrade();

  await worker.evaluate(key => chrome.storage.local.set({ [key]: 1 }), TOUR);
  const slow = await chooserPage(base, { waitForReady: false, init: () => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async key => {
      const value = await get(key);
      if (key === 'xck:quick-tour-pending' && !window.releaseTourRead) await new Promise(resolve => { window.releaseTourRead = resolve; });
      return value;
    };
  } });
  await slow.waitForFunction(() => typeof window.releaseTourRead === 'function');
  check('Quick tour waits for the first-install marker', await slow.locator('#tour-replay').isHidden());
  await slow.evaluate(() => window.releaseTourRead());
  await slow.getByRole('button', { name: 'Skip tour' }).click();
  await slow.waitForFunction(async () => !(await chrome.storage.local.get('xck:quick-tour-pending'))['xck:quick-tour-pending']);
  check('Skip after a delayed read keeps the tour dismissed', await slow.locator('#quick-tour').isHidden());
  await slow.close();

  // ---------- Popup page: first use and the tool routes ----------
  const page = await chooserPage(base);
  check('Opening chooser does not capture', !(await page.evaluate(async () => (await chrome.storage.session.get('xgd:run'))['xgd:run'])));
  check('Opening chooser does not request X', requests.length === 0);
  check('First use has no prefilled account', await page.getByLabel('Your X handle').inputValue() === '');
  const defaultHeight = await bodyHeight(page);
  check('Popup page: 340px wide and 460–480px tall', await page.evaluate(() => document.body.getBoundingClientRect().width) === 340 && defaultHeight >= 460 && defaultHeight <= 480, String(defaultHeight));
  const audit = await layoutAudit(page);
  check('Popup page: no horizontal overflow', audit.overflow <= 0, JSON.stringify(audit));
  check('Popup page: targets at least 24×24, rows at least 40px', audit.small.length === 0 && audit.rows.length === 7 && audit.rows.every(h => h >= 40), JSON.stringify(audit));
  check('Popup page: no visible text under 12.5px', audit.tiny.length === 0, JSON.stringify(audit.tiny));
  await page.screenshot({ path: `${shots}/launcher.png`, fullPage: true });
  for (const [name, file] of [['Analytics', 'analytics.html'], ['Ledger', 'report.html'], ['Rewards pace', 'dashboard.html'], ['Receipts', 'receipt.html'], ['Post to image', 'postcard.html']]) {
    const target = ctx.waitForEvent('page');
    await page.getByRole('link', { name, exact: false }).first().click();
    const opened = await target;
    await opened.waitForURL(`${base}/${file}`);
    await opened.getByRole('navigation', { name: 'Kit tools' }).waitFor({ state: 'attached' });
    check(`${name} opens directly with shared navigation`, await opened.locator('.xck-nav a[aria-current="page"]').textContent() === name);
    check(`${name} has all seven destinations`, await opened.locator('.xck-nav a').count() === 7);
    for (const width of [390, 320]) {
      await opened.setViewportSize({ width, height: 844 });
      // The bar is measured, not the page: page content below it belongs to the tool's own layout.
      const narrow = await opened.evaluate(() => { const shell = document.querySelector('.xck-shell'); return { overflow: Math.max(shell.getBoundingClientRect().right - innerWidth, shell.scrollWidth - shell.clientWidth), toggle: document.querySelector('.xck-menu-toggle').textContent }; });
      check(`${name} navigation fits at ${width}px and names the current tool`, narrow.overflow <= 0 && narrow.toggle === name && await opened.getByRole('button', { name: `${name}, tools menu`, exact: true }).isVisible(), JSON.stringify(narrow));
    }
    await opened.close();
  }
  // Reply drafting stays beside the current page; other tools retain their tab routes.
  await page.evaluate(() => { globalThis.panelCalls=[]; chrome.sidePanel.open=async options=>{panelCalls.push(options);}; });
  const tabCount=ctx.pages().length;
  await page.getByRole('link',{name:'Reply drafter',exact:true}).first().click();
  check('Reply drafter opens current-window side panel without a new tab', await page.evaluate(async()=>panelCalls.length===1 && panelCalls[0].windowId===(await chrome.windows.getCurrent()).id) && ctx.pages().length===tabCount);
  check('Browsing tools never triggers capture', !(await page.evaluate(async () => (await chrome.storage.session.get('xgd:run'))['xgd:run'])));

  // ---------- Following view: open, Back, focus ----------
  await page.getByRole('button', { name: /Following settings/ }).click();
  const opened = await page.evaluate(() => ({ tools: document.querySelector('#tools-view').hidden, following: document.querySelector('#following-view').hidden, focus: document.activeElement?.id, hash: location.hash }));
  check('Following row opens the Following view and focuses its title', opened.tools && !opened.following && opened.focus === 'following-title' && opened.hash === '#following', JSON.stringify(opened));
  check('Following view keeps the popup height', Math.abs(await bodyHeight(page) - defaultHeight) <= 1);
  await page.keyboard.press('Shift+Tab');
  check('Back comes before the title in keyboard order', await page.evaluate(() => document.activeElement?.id) === 'back');
  await page.keyboard.press('Enter');
  const back = await page.evaluate(() => ({ tools: document.querySelector('#tools-view').hidden, focus: document.activeElement?.id, hash: location.hash }));
  check('Back (keyboard) returns to tools and restores focus to Following settings', !back.tools && back.focus === 'following-open' && back.hash === '', JSON.stringify(back));
  await page.keyboard.press('Space');
  check('Following row opens with Space', await page.evaluate(() => !document.querySelector('#following-view').hidden));
  await page.keyboard.press('Tab');
  check('Following view keyboard order starts at the switch', await page.evaluate(() => document.activeElement?.id) === 'highlight');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  check('Following view keyboard order: handle, then Open your Following', await page.evaluate(() => document.activeElement?.id) === 'open-following');

  // ---------- Handle and permission errors ----------
  await page.getByLabel('Your X handle').fill('not a handle!');
  await page.getByRole('button', { name: 'Open your Following' }).click();
  const invalid = await page.evaluate(() => ({ error: document.querySelector('#handle-error').textContent, hidden: document.querySelector('#handle-error').hidden, invalid: document.querySelector('#handle').getAttribute('aria-invalid'), described: document.querySelector('#handle').getAttribute('aria-describedby'), value: document.querySelector('#handle').value, focus: document.activeElement?.id }));
  // Was: #following-status carried every message. The handle problem now sits above the field and is tied to it.
  check('Invalid handles rejected at the field, value kept and focused', /valid X handle/.test(invalid.error) && !invalid.hidden && invalid.invalid === 'true' && invalid.described === 'handle-error' && invalid.value === 'not a handle!' && invalid.focus === 'handle', JSON.stringify(invalid));
  check('Handle error keeps the popup height', await bodyHeight(page) <= 480);
  await page.screenshot({ path: `${shots}/launcher-handle-error.png`, fullPage: true });
  await page.getByLabel('Your X handle').fill('@samplecreator');
  // Native permission dialog is simulated; storage and checkbox handlers are real.
  await page.evaluate(() => { chrome.permissions.request = async () => false; });
  await page.getByLabel('Highlight non-follow-backs').click();
  await page.getByText('Allow x.com access to enable highlighting.', { exact: true }).waitFor();
  check('Permission denial resets checkbox', !(await page.getByLabel('Highlight non-follow-backs').isChecked()));
  const denied = await page.evaluate(async () => ({ status: document.querySelector('#following-status').className, field: document.querySelector('#handle-error').hidden, invalid: document.querySelector('#handle').hasAttribute('aria-invalid'), saved: (await chrome.storage.local.get('xgd:v1'))['xgd:v1']?.settings?.followBackEnabled }));
  check('Permission denial is reported on the switch, not the handle, and saves nothing', denied.status === 'error' && denied.field && !denied.invalid && denied.saved !== true, JSON.stringify(denied));
  check('Switch is described by its status', await page.getByRole('switch', { name: 'Highlight non-follow-backs' }).getAttribute('aria-describedby') === 'following-status');
  await page.evaluate(() => {
    chrome.permissions.contains = async () => true;
    chrome.permissions.request = () => new Promise(resolve => {
      window.finishGrant = () => resolve(true);
      for (const listener of window.permissionAddedListeners) listener({ origins: ['https://x.com/*'] });
    });
  });
  await page.getByLabel('Highlight non-follow-backs').click();
  // Permission events can refresh the form before the permission request resolves.
  await page.waitForTimeout(100);
  check('Permission synchronization preserves the pending handle', await page.getByLabel('Your X handle').inputValue() === '@samplecreator');
  await page.evaluate(() => window.finishGrant());
  await page.getByText(/Highlighting is on/).waitFor();
  const saved = await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1']);
  check('Tick saves account and enables immediately', saved.settings.expectedHandle === 'samplecreator' && saved.settings.followBackEnabled === true);
  await page.screenshot({ path: `${shots}/launcher-following-on.png`, fullPage: true });
  await page.getByRole('button', { name: 'Back to tools' }).click();
  check('Tools row reports highlighting on', (await page.locator('#following-state').textContent()) === 'On');
  await page.getByRole('button', { name: /Following settings/ }).click();
  check('Back clears messages from the last attempt', (await page.locator('#following-status').textContent()) === '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('Highlight non-follow-backs').uncheck();
  await page.getByText(/Highlighting is off/).waitFor();
  check('Untick persists immediately', await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].settings.followBackEnabled === false));
  check('Reduced motion leaves static confirmation', await page.locator('#following-status').evaluate(el => getComputedStyle(el).transform === 'none' && getComputedStyle(el).opacity === '1'));
  await page.getByRole('button', { name: 'Back to tools' }).click();
  check('Reduced motion swaps views without animating', await page.evaluate(() => getComputedStyle(document.querySelector('#tools-view')).opacity === '1' && getComputedStyle(document.querySelector('#tools-view')).transform === 'none'));
  check('Tools row reports highlighting off', (await page.locator('#following-state').textContent()) === 'Off');
  await page.getByRole('button', { name: /Following settings/ }).click();
  // Assert the native tab request without visiting a real account.
  await page.evaluate(() => { chrome.tabs.create = async options => { window.followingDestination = options.url; return { id: 999 }; }; });
  await page.getByRole('button', { name: 'Open your Following' }).click();
  await page.waitForFunction(() => window.followingDestination);
  check('Open Following requests configured account', await page.evaluate(() => window.followingDestination) === 'https://x.com/samplecreator/following');
  // A second page changes the setting while the chooser remains open, in each view.
  const second = await ctx.newPage();
  await second.goto(`${base}/launcher.html`);
  await second.evaluate(async () => { const s = (await chrome.storage.local.get('xgd:v1'))['xgd:v1']; s.settings.followBackEnabled = true; await chrome.storage.local.set({ 'xgd:v1': s }); });
  await page.waitForFunction(() => document.querySelector('#highlight').checked);
  await page.getByRole('button', { name: 'Back to tools' }).click();
  check('Tools row follows a change made on another page', (await page.locator('#following-state').textContent()) === 'On');
  await second.evaluate(async () => { const s = (await chrome.storage.local.get('xgd:v1'))['xgd:v1']; s.settings.followBackEnabled = false; await chrome.storage.local.set({ 'xgd:v1': s }); });
  await page.waitForFunction(() => !document.querySelector('#highlight').checked && document.querySelector('#following-state').textContent === 'Off');
  check('Following switch synchronizes across pages', !(await page.getByLabel('Highlight non-follow-backs').isChecked()));
  await page.getByRole('button', { name: /Following settings/ }).click();
  // Even an old view cannot write its checkbox via the navigation button.
  await page.evaluate(() => { document.querySelector('#highlight').checked = true; });
  await page.getByRole('button', { name: 'Open your Following' }).click();
  check('Open Following preserves the latest toggle preference', await second.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].settings.followBackEnabled === false));
  await second.close();

  const restored = await chooserPage(base, { url: 'launcher.html#following' });
  await restored.waitForFunction(() => document.querySelector('#handle').value === 'samplecreator');
  check('Saved account restored', await restored.getByLabel('Your X handle').inputValue() === 'samplecreator');
  check('Following route opens the Following view with the handle focused', await restored.evaluate(() => !document.querySelector('#following-view').hidden && document.activeElement?.id === 'handle'));
  await restored.close();
  const keyboard = await chooserPage(base);
  await keyboard.keyboard.press('Tab');
  const firstStop = await keyboard.evaluate(() => ({ id: document.activeElement?.id, ring: getComputedStyle(document.activeElement).outlineStyle, name: document.activeElement?.textContent }));
  check('Chooser keyboard starts at Read current X tab, with a ring', firstStop.id === 'capture' && firstStop.ring !== 'none' && firstStop.name === 'Read current X tab', JSON.stringify(firstStop));
  await keyboard.keyboard.press('Tab');
  check('The first tool, Analytics, comes next', await keyboard.evaluate(() => document.activeElement?.textContent?.includes('Analytics')));
  const ring = await keyboard.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check('Keyboard focus shows a ring', ring !== 'none', ring);
  for (let i = 0; i < 6; i++) await keyboard.keyboard.press('Tab');
  check('Chooser keyboard reaches Following settings after the six tools', await keyboard.evaluate(() => document.activeElement?.id) === 'following-open');
  await keyboard.keyboard.press('Tab');
  check('Quick tour is the last keyboard stop in the tools view', await keyboard.evaluate(() => document.activeElement.id === 'tour-replay' && [...document.querySelectorAll('#tools-view a, #tools-view button')].filter(el => el.getBoundingClientRect().height > 0).at(-1)?.id === 'tour-replay'));
  // The strip: the reader and the time in UTC, both decoration or plain text, neither a control.
  const strip = await keyboard.evaluate(() => {
    const mark = document.querySelector('.strip .xck-rd');
    const now = new Date();
    return { arms: mark?.querySelectorAll('svg.xck-arm').length, eyes: mark?.querySelectorAll('.xck-eye').length, hidden: mark?.getAttribute('aria-hidden'), utc: document.querySelector('.strip .xck-utc')?.textContent,
      expected: `UTC ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`, stops: document.querySelectorAll('.strip a, .strip button, .strip [tabindex]').length,
      cap: document.querySelector('#capture .cap')?.getAttribute('aria-hidden') };
  });
  check('Strip shows the reader (two arms, two eyes), hidden from assistive technology', strip.arms === 2 && strip.eyes === 2 && strip.hidden === 'true' && strip.cap === 'true' && strip.stops === 0, JSON.stringify(strip));
  check('Strip shows the current time in UTC', /^UTC \d\d:\d\d$/.test(strip.utc) && strip.utc === strip.expected, JSON.stringify(strip));
  check('Tools are grouped: a hairline starts Make (Receipts) and On X (Reply drafter)', JSON.stringify(await keyboard.evaluate(() => [...document.querySelectorAll('.tool-link.group-start strong')].map(el => el.textContent))) === JSON.stringify(['Receipts', 'Reply drafter']));
  // Hover closes the reader's brackets around a row; keyboard focus is the ring. The two are drawn differently.
  await keyboard.locator('.tool-link').nth(1).hover();
  await keyboard.waitForTimeout(250);
  const rowStates = await keyboard.evaluate(() => { const rows = [...document.querySelectorAll('.tool-link')]; const css = (el) => ({ b: getComputedStyle(el).getPropertyValue('--b').trim(), ring: getComputedStyle(el).outlineStyle }); return { hovered: css(rows[1]), rest: css(rows[2]) }; });
  check('A hovered tool row draws brackets, not a focus ring', rowStates.hovered.b !== 'transparent' && rowStates.hovered.ring === 'none' && rowStates.rest.b === 'transparent', JSON.stringify(rowStates));
  check('Chooser fits popup width', await keyboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // 200% zoom: rows and lines wrap, the page scrolls vertically only, every control stays reachable.
  for (const view of ['tools', 'following']) {
    if (view === 'following') await keyboard.getByRole('button', { name: /Following settings/ }).click();
    const zoomed = await keyboard.evaluate(() => {
      document.documentElement.style.zoom = '2';
      const controls = [...document.querySelectorAll('a, button, input')].filter(el => el.getBoundingClientRect().height > 0);
      const unreachable = controls.filter(el => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(hit && (hit === el || el.contains(hit) || hit.contains(el) || el.labels?.[0]?.contains(hit))); }).map(el => el.id || el.textContent.trim());
      const result = { overflow: document.documentElement.scrollWidth - innerWidth, unreachable };
      document.documentElement.style.zoom = '';
      scrollTo(0, 0);
      return result;
    });
    check(`200% zoom (${view}): no sideways scroll and every control reachable`, zoomed.overflow <= 0 && zoomed.unreachable.length === 0, JSON.stringify(zoomed));
  }
  await keyboard.close();

  // ---------- Opening behaviour and the URL-only tab hint ----------
  const own = await chooserPage(base, { activeUrl: 'https://x.com/samplecreator/following' });
  check('Own Following tab opens the Following view', await own.evaluate(() => !document.querySelector('#following-view').hidden));
  await own.close();
  for (const [kind, url, text] of [
    ['X Analytics', 'https://x.com/i/account_analytics', 'X Analytics · Read saves loaded figures, @handle and UTC capture time locally.'],
    ['Rewards', 'https://x.com/i/jf/creators/original_content_rewards', 'X Rewards · Read saves its figure, @handle and UTC capture time locally.'],
    ['a profile', 'https://x.com/samplecreator', 'Your X profile · Read saves follower counts, @handle and UTC capture time locally.'],
    ['another X page', 'https://x.com/home', 'Read saves loaded X figures, @handle and UTC capture time locally for charts and receipts.'],
    ['a non-X page', 'https://example.com/', 'This tab isn’t X.'],
  ]) {
    const hinted = await chooserPage(base, { activeUrl: url });
    check(`Tab hint for ${kind} comes from the URL alone`, (await hinted.locator('#capture-status').textContent()).startsWith(text) && await hinted.evaluate(() => document.querySelector('#tools-view').hidden === false));
    await hinted.close();
  }
  check('Tab hints read nothing from pages', requests.length === 0);

  const queryFailure = await chooserPage(base);
  await queryFailure.evaluate(() => {
    window.captureMessages = 0;
    chrome.tabs.getCurrent = async () => { throw new Error('synthetic tab lookup failure'); };
    chrome.runtime.sendMessage = async () => { window.captureMessages++; return { error: 'must not start' }; };
  });
  await queryFailure.getByRole('button', { name: 'Read current X tab' }).click();
  await queryFailure.getByText('Could not read X: synthetic tab lookup failure', { exact: true }).waitFor({ timeout: 2000 });
  check('Tab lookup failure is explained and Read recovers', await queryFailure.locator('#capture').isEnabled() && await queryFailure.locator('#capture-status').getAttribute('class') === 'error');
  check('Tab lookup failure never starts a capture', await queryFailure.evaluate(() => window.captureMessages === 0));
  await queryFailure.close();

  // ---------- Settings that cannot be read are reported in the open view ----------
  const broken = await chooserPage(base, { init: () => { chrome.storage.local.get = async () => { throw new Error('synthetic storage failure'); }; } });
  const brokenView = await broken.evaluate(() => ({ text: document.querySelector('#settings-alert').textContent, visible: !document.querySelector('#settings-alert').hidden && document.querySelector('#settings-alert').getBoundingClientRect().height > 0, role: document.querySelector('#settings-alert').getAttribute('role'), state: document.querySelector('#following-state').textContent, tools: !document.querySelector('#tools-view').hidden, height: Math.round(document.body.getBoundingClientRect().height) }));
  check('Settings load failure is visible in the Tools view, state unknown', brokenView.tools && brokenView.visible && brokenView.role === 'alert' && /Could not load settings/.test(brokenView.text) && brokenView.state === '—' && brokenView.height <= 600, JSON.stringify(brokenView));
  await broken.screenshot({ path: `${shots}/launcher-settings-failure.png`, fullPage: true });
  await broken.getByRole('button', { name: /Following settings/ }).click();
  check('Settings load failure is also shown in the Following view', /Could not load settings/.test(await broken.locator('#following-status').textContent()));
  await broken.close();
  const reload = await chooserPage(base);
  await reload.evaluate(() => { window.realGet = chrome.storage.local.get.bind(chrome.storage.local); chrome.storage.local.get = async () => { throw new Error('synthetic storage failure'); }; });
  const writer = await ctx.newPage();
  await writer.goto(`${base}/launcher.html`);
  // Chrome only reports a change when the stored value differs, so the writer toggles a probe field.
  const touch = () => writer.evaluate(async () => { const s = (await chrome.storage.local.get('xgd:v1'))['xgd:v1']; if ('navProbe' in s) delete s.navProbe; else s.navProbe = 1; await chrome.storage.local.set({ 'xgd:v1': s }); });
  await touch();
  await reload.waitForFunction(() => !document.querySelector('#settings-alert').hidden);
  check('Settings reload failure is visible in the Tools view', /Could not reload settings/.test(await reload.locator('#settings-alert').textContent()));
  await reload.evaluate(() => { chrome.storage.local.get = window.realGet; });
  await touch();
  await reload.waitForFunction(() => document.querySelector('#settings-alert').hidden);
  check('A later successful reload clears the failure', await reload.locator('#following-state').textContent() !== '—');
  await writer.close();
  await reload.close();

  // ---------- Tab mode: launcher.html opened as a tab never reads itself ----------
  const tab = await ctx.newPage();
  await tab.setViewportSize({ width: 1280, height: 800 });
  await tab.addInitScript(() => {
    window.sentMessages = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, ...rest) => { window.sentMessages.push(msg?.type); return send(msg, ...rest); };
  });
  await tab.goto(`${base}/launcher.html#following`);
  await tab.locator('.xck-shell').waitFor();
  const tabState = await tab.evaluate(() => ({
    current: document.querySelector('.xck-nav a[aria-current="page"]')?.textContent,
    following: !document.querySelector('#following-view').hidden,
    focus: document.activeElement?.id,
  }));
  check('Tab: shared navigation marks Following settings current (hash stripped)', tabState.current === 'Following settings' && tabState.following && tabState.focus === 'handle', JSON.stringify(tabState));
  await tab.screenshot({ path: `${shots}/launcher-tab.png` });
  await tab.getByRole('button', { name: 'Back to tools' }).click();
  const tabTools = await tab.evaluate(() => ({ read: getComputedStyle(document.querySelector('#capture')).display, note: !document.querySelector('#tab-note').hidden && getComputedStyle(document.querySelector('#tab-note')).display !== 'none', target: document.querySelector('.tool-link').getAttribute('target') }));
  check('Tab: Read is replaced by the toolbar note', tabTools.read === 'none' && tabTools.note, JSON.stringify(tabTools));
  check('Tab: tool rows open in the same tab', tabTools.target === null);
  await tab.evaluate(() => document.querySelector('#capture').click());
  await tab.waitForTimeout(300);
  check('Tab: a forced Read click sends nothing and starts nothing', await tab.evaluate(async () => !window.sentMessages.includes('xck:capture-current') && !(await chrome.storage.session.get('xgd:run'))['xgd:run']));
  await tab.getByRole('link', { name: 'Ledger', exact: true }).first().click();
  await tab.waitForURL(`${base}/report.html`);
  check('Tab: shared navigation leaves the chooser', await tab.locator('.xck-nav a[aria-current="page"]').textContent() === 'Ledger');
  await tab.close();

  // ---------- Full-page navigation: desktop bar ----------
  const full = await ctx.newPage();
  await full.setViewportSize({ width: 1280, height: 800 });
  await full.goto(`${base}/analytics.html`);
  await full.locator('.xck-shell').waitFor();
  const desk = await full.evaluate(() => {
    const shell = document.querySelector('.xck-shell');
    const links = [...document.querySelectorAll('.xck-nav a')];
    const current = document.querySelector('.xck-nav a[aria-current="page"]');
    return { height: shell.getBoundingClientRect().height, visible: links.filter(a => a.getBoundingClientRect().width > 0).length, toggle: getComputedStyle(document.querySelector('.xck-menu-toggle')).display,
      tops: new Set(links.map(a => Math.round(a.getBoundingClientRect().top))).size, overflow: document.documentElement.scrollWidth - innerWidth,
      currentBg: getComputedStyle(current).backgroundColor, currentRing: getComputedStyle(current).outlineStyle, underline: getComputedStyle(current.parentElement, '::after').backgroundColor };
  });
  check('Desktop: one bar, seven visible routes on one line, no menu button', desk.height <= 56 && desk.visible === 7 && desk.tops === 1 && desk.toggle === 'none' && desk.overflow <= 0, JSON.stringify(desk));
  check('Desktop: current tool is a paper chip, without a focus ring', desk.currentBg === 'rgb(255, 255, 255)' && desk.currentRing === 'none', JSON.stringify(desk));
  const bar = await full.evaluate(() => { const mark = document.querySelector('.xck-wordmark .xck-rd'); return { arms: mark?.querySelectorAll('svg.xck-arm').length, eyes: mark?.querySelectorAll('.xck-eye').length, hidden: mark?.getAttribute('aria-hidden'), utc: document.querySelector('.xck-shell .xck-utc')?.textContent,
    groups: [...document.querySelectorAll('.xck-links li[data-group]')].map(li => `${li.dataset.group}:${li.textContent}`), bg: getComputedStyle(document.querySelector('.xck-shell')).backgroundColor }; });
  check('Desktop: ink bar with the reader, the UTC readout and three groups', bar.arms === 2 && bar.eyes === 2 && bar.hidden === 'true' && /^UTC \d\d:\d\d$/.test(bar.utc) && bar.bg === 'rgb(19, 19, 19)' && JSON.stringify(bar.groups) === JSON.stringify(['Numbers:Analytics', 'Make:Receipts', 'On X:Reply drafter']), JSON.stringify(bar));
  await full.locator('.xck-nav a', { hasText: 'Ledger' }).hover();
  await full.waitForTimeout(250);
  const hoverLook = await full.evaluate(() => { const a = [...document.querySelectorAll('.xck-nav a')].find(x => x.textContent === 'Ledger'); return { b: getComputedStyle(a).getPropertyValue('--b').trim(), bg: getComputedStyle(a).backgroundColor, ring: getComputedStyle(a).outlineStyle }; });
  check('Desktop: hover draws brackets; it is neither the chip nor the focus ring', hoverLook.b === '#fff' && hoverLook.bg === 'rgba(0, 0, 0, 0)' && hoverLook.ring === 'none', JSON.stringify(hoverLook));
  await full.mouse.move(0, 400);
  check('Desktop: no ledger numbers in route names', await full.evaluate(() => [...document.querySelectorAll('.xck-nav a')].every(a => getComputedStyle(a, '::before').content === 'none')));
  await full.keyboard.press('Tab');
  const deskFocus = await full.evaluate(() => ({ text: document.activeElement?.textContent, ring: getComputedStyle(document.activeElement).outlineStyle }));
  check('Desktop: keyboard reaches the first route with a ring', deskFocus.text === 'Analytics' && deskFocus.ring !== 'none', JSON.stringify(deskFocus));
  check('Desktop: bar stays in view while scrolling', await full.evaluate(async () => { document.body.style.minHeight = '3000px'; scrollTo(0, 1500); await new Promise(r => requestAnimationFrame(r)); const top = document.querySelector('.xck-shell').getBoundingClientRect().top; document.body.style.minHeight = ''; scrollTo(0, 0); return top === 0; }));
  for (const width of [1180, 861]) {
    await full.setViewportSize({ width, height: 800 });
    const fits = await full.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, tops: new Set([...document.querySelectorAll('.xck-nav a')].map(a => Math.round(a.getBoundingClientRect().top))).size, toggle: getComputedStyle(document.querySelector('.xck-menu-toggle')).display }));
    check(`Desktop bar fits at ${width}px`, fits.overflow <= 0 && fits.tops === 1 && fits.toggle === 'none', JSON.stringify(fits));
  }
  await full.screenshot({ path: `${shots}/nav-861.png`, clip: { x: 0, y: 0, width: 861, height: 120 } });

  // ---------- Full-page navigation: narrow disclosure ----------
  for (const width of [860, 390, 320]) {
    await full.setViewportSize({ width, height: 844 });
    const toggle = full.locator('.xck-menu-toggle');
    const closed = await full.evaluate(() => ({ expanded: document.querySelector('.xck-menu-toggle').getAttribute('aria-expanded'), links: [...document.querySelectorAll('.xck-nav a')].filter(a => a.getBoundingClientRect().height > 0).length, height: document.querySelector('.xck-shell').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth - innerWidth }));
    check(`${width}px: one compact bar with the menu closed`, closed.expanded === 'false' && closed.links === 0 && closed.height <= 56 && closed.overflow <= 0 && await toggle.isVisible(), JSON.stringify(closed));
    check(`${width}px: menu button names the current tool`, (await toggle.getAttribute('aria-controls')) === 'xck-nav' && await full.getByRole('button', { name: 'Analytics, tools menu', exact: true }).isVisible());
    await toggle.focus();
    await full.keyboard.press('Enter');
    const open = await full.evaluate(() => {
      const links = [...document.querySelectorAll('.xck-nav a')];
      return { expanded: document.querySelector('.xck-menu-toggle').getAttribute('aria-expanded'), heights: links.map(a => Math.round(a.getBoundingClientRect().height)), right: Math.max(...links.map(a => a.getBoundingClientRect().right)), overflow: document.documentElement.scrollWidth - innerWidth, trust: getComputedStyle(document.querySelector('.xck-trust')).display };
    });
    check(`${width}px: Enter opens all seven routes at 44px, inside the page`, open.expanded === 'true' && open.heights.length === 7 && open.heights.every(h => h >= 44) && open.right <= width && open.overflow <= 0 && open.trust !== 'none', JSON.stringify(open));
    if (width === 390 || width === 320) await full.waitForTimeout(200), await full.screenshot({ path: `${shots}/nav-${width}-open.png`, clip: { x: 0, y: 0, width, height: 460 } });
    await full.keyboard.press('Tab');
    check(`${width}px: Tab moves from the button into the routes`, await full.evaluate(() => document.activeElement?.textContent) === 'Analytics');
    await full.keyboard.press('Escape');
    check(`${width}px: Escape closes and returns focus to the button`, await full.evaluate(() => document.querySelector('.xck-menu-toggle').getAttribute('aria-expanded') === 'false' && document.activeElement === document.querySelector('.xck-menu-toggle')));
    await toggle.click();
    await full.mouse.click(2, 836); // page margin below the open menu, away from any control
    check(`${width}px: clicking outside closes the menu`, await toggle.getAttribute('aria-expanded') === 'false');
    if (width === 390 || width === 320) await full.screenshot({ path: `${shots}/nav-${width}.png`, clip: { x: 0, y: 0, width, height: 120 } });
  }
  // Crossing the breakpoint both ways: no stale open state, and focus never stays on a hidden link.
  await full.setViewportSize({ width: 900, height: 800 });
  await full.locator('.xck-nav a').nth(1).focus();
  await full.setViewportSize({ width: 800, height: 800 });
  await full.waitForTimeout(100);
  const shrunk = await full.evaluate(() => ({ focus: document.activeElement?.className, expanded: document.querySelector('.xck-menu-toggle').getAttribute('aria-expanded'), links: [...document.querySelectorAll('.xck-nav a')].filter(a => a.getBoundingClientRect().height > 0).length }));
  check('900 → 800: menu closed and focus moves from the hidden link to the menu button', shrunk.focus === 'xck-menu-toggle' && shrunk.expanded === 'false' && shrunk.links === 0, JSON.stringify(shrunk));
  await full.keyboard.press('Enter');
  await full.keyboard.press('Tab');
  await full.setViewportSize({ width: 900, height: 800 });
  await full.waitForTimeout(100);
  const grown = await full.evaluate(() => ({ focus: document.activeElement?.textContent, visible: document.activeElement?.getBoundingClientRect().height > 0, expanded: document.querySelector('.xck-menu-toggle').getAttribute('aria-expanded'), toggle: getComputedStyle(document.querySelector('.xck-menu-toggle')).display }));
  check('800 (open) → 900: inline bar, menu state reset, focused link still visible', grown.expanded === 'false' && grown.toggle === 'none' && grown.visible && grown.focus === 'Analytics', JSON.stringify(grown));
  await full.setViewportSize({ width: 800, height: 800 });
  await full.waitForTimeout(100);
  const again = await full.evaluate(() => ({ focus: document.activeElement?.className, expanded: document.querySelector('.xck-menu-toggle').getAttribute('aria-expanded') }));
  check('900 → 800 again: closed, focus on the menu button', again.focus === 'xck-menu-toggle' && again.expanded === 'false', JSON.stringify(again));
  await full.setViewportSize({ width: 390, height: 844 });
  await full.locator('.xck-menu-toggle').click();
  await full.setViewportSize({ width: 1280, height: 800 });
  await full.waitForTimeout(100);
  check('Widening past the breakpoint drops a stale open menu', await full.locator('.xck-menu-toggle').getAttribute('aria-expanded') === 'false');
  await full.screenshot({ path: `${shots}/nav-1280.png`, clip: { x: 0, y: 0, width: 1280, height: 120 } });
  await full.emulateMedia({ reducedMotion: 'reduce' });
  check('Reduced motion: navigation does not animate', await full.evaluate(() => [...document.querySelectorAll('.xck-nav a, .xck-chevron')].every(el => getComputedStyle(el).transitionDuration.split(',').every(d => parseFloat(d) === 0))));
  await full.close();

  const post = await ctx.newPage();
  await post.goto(`${base}/postcard.html`);
  await post.getByRole('heading', { name: 'Make an image of a post' }).waitFor();
  check('Post entry explains selection instead of showing an error', /right-click/i.test(await post.locator('#app').textContent()));
  const refused = await post.evaluate(() => chrome.runtime.sendMessage({ type: 'xck:capture-current' }));
  check('Capture request accepted only from chooser', refused?.error === 'Open the tool chooser to read the current tab.');
  check('No page errors', errors.length === 0, errors.join('\n'));
  check('Navigation makes no web requests', requests.length === 0, requests.join('\n'));

  // Run the actual account detector on synthetic X DOM; bridge only the injection boundary.
  await ctx.route('https://x.com/**', route => route.fulfill({ body: readFileSync('test/fixtures/following.html', 'utf8'), contentType: 'text/html' }));
  const fixture = await ctx.newPage();
  await fixture.goto('https://x.com/byaarav/following');
  const detector = await chooserPage(base, { url: 'launcher.html#following' });
  await detector.exposeFunction('fixtureRead', source => fixture.evaluate(`(${source})()`));
  await detector.evaluate(() => {
    chrome.permissions.request = async () => true; chrome.permissions.contains = async () => true;
    chrome.tabs.query = async () => [{ id: 999, url: 'https://x.com/byaarav/following' }];
    chrome.scripting.executeScript = async options => [{ result: await window.fixtureRead(options.func.toString()) }];
  });
  await detector.getByLabel('Your X handle').fill('');
  await detector.getByLabel('Highlight non-follow-backs').check();
  await detector.getByText(/Highlighting is on/).waitFor();
  check('Own Following infers account without typing', await detector.getByLabel('Your X handle').inputValue() === 'byaarav');
  await detector.getByLabel('Highlight non-follow-backs').uncheck();
  await detector.getByText(/Highlighting is off/).waitFor();
  await fixture.goto('https://x.com/someoneelse/following');
  await detector.evaluate(() => { chrome.tabs.query = async () => [{ id: 999, url: 'https://x.com/someoneelse/following' }]; });
  await detector.getByLabel('Your X handle').fill('');
  await detector.getByLabel('Highlight non-follow-backs').click();
  await detector.getByText(/Enter your X handle, or open your own Following page/).waitFor();
  check('Someone else’s Following cannot set your account', !(await detector.getByLabel('Highlight non-follow-backs').isChecked()));
  const missing = await detector.evaluate(() => ({ field: document.querySelector('#handle-error').textContent, invalid: document.querySelector('#handle').getAttribute('aria-invalid'), focus: document.activeElement?.id, height: Math.round(document.body.getBoundingClientRect().height) }));
  check('Missing handle is reported at the field and focuses it', /Enter your X handle/.test(missing.field) && missing.invalid === 'true' && missing.focus === 'handle' && missing.height <= 480, JSON.stringify(missing));
  // The capture checks below read @byaarav's profile, so this leaves that account saved.
  await detector.getByLabel('Your X handle').fill('@byaarav');
  await detector.evaluate(() => { chrome.tabs.query = async () => [{ id: 999, url: 'https://example.com/' }]; });
  await detector.getByLabel('Highlight non-follow-backs').check();
  await detector.getByText(/Highlighting is on/).waitFor();
  check('A successful tick clears the field error', await detector.evaluate(() => document.querySelector('#handle-error').hidden && !document.querySelector('#handle').hasAttribute('aria-invalid')));
  await detector.close();

  // Real chooser click -> real worker listener -> real capture pipeline.
  // Only browser tab/permission/injection boundaries return synthetic values.
  await worker.evaluate(() => { chrome.tabs.query = async () => [{ id: 999, url: 'chrome://newtab' }]; });
  const capturePage = await chooserPage(base);
  await capturePage.getByRole('button', { name: 'Read current X tab' }).click();
  await capturePage.getByText(/Open X Analytics, Rewards or your profile, then use the toolbar menu/).waitFor();
  check('Current-tab capture rejects a non-X tab', !(await post.evaluate(async () => (await chrome.storage.session.get('xgd:run'))['xgd:run'])));
  check('Rejection is shown as an error in the status line', await capturePage.locator('#capture-status').getAttribute('class') === 'error');
  await worker.evaluate(() => {
    chrome.tabs.query = async () => [{ id: 999, url: 'https://x.com/byaarav' }];
    chrome.permissions.contains = async () => false;
    chrome.scripting.executeScript = async options => {
      globalThis.selectedCaptureTab = options.target.tabId;
      await new Promise(resolve => setTimeout(resolve, 500));
      return [{ result: { ok: true, account: 'byaarav', followersText: '42' } }];
    };
  });
  const idle = await capturePage.locator('#capture').boundingBox();
  await capturePage.getByRole('button', { name: 'Read current X tab' }).click({ noWaitAfter: true });
  await capturePage.getByRole('button', { name: 'Reading X…' }).waitFor();
  await capturePage.waitForTimeout(200); // let the 140ms press transition settle
  const busy = await capturePage.locator('#capture').boundingBox();
  const busyLabel = await capturePage.locator('#capture').getAttribute('aria-busy');
  check('Reading keeps the button size and says so', busy.width === idle.width && busy.height === idle.height && busyLabel === 'true', JSON.stringify({ idle, busy, busyLabel }));
  const reading = await capturePage.evaluate(() => ({ mark: document.querySelector('.strip .xck-rd').classList.contains('reading'), eyes: getComputedStyle(document.querySelector('.strip .xck-eye')).animationName, cap: getComputedStyle(document.querySelector('#capture .cap i')).animationName }));
  check('While a read runs the reader\'s eyes travel, in the strip and on the key', reading.mark && reading.eyes === 'xck-scan' && reading.cap === 'cap-scan', JSON.stringify(reading));
  for (let i = 0; i < 50; i++) {
    if (await post.evaluate(async () => !!(await chrome.storage.session.get('xgd:run'))['xgd:run'])) break;
    await post.waitForTimeout(100);
  }
  await capturePage.close();
  for (let i = 0; i < 50; i++) {
    if (await post.evaluate(async () => !!(await chrome.storage.session.get('xgd:run'))['xgd:run']?.finishedAt)) break;
    await post.waitForTimeout(100);
  }
  const captureDebug = await post.evaluate(async () => ({ state: (await chrome.storage.local.get('xgd:v1'))['xgd:v1'], run: (await chrome.storage.session.get('xgd:run'))['xgd:run'] }));
  const captured = captureDebug.state.accounts.byaarav?.observations ?? [];
  check('Capture worker reaches a finished state', !!captureDebug.run.finishedAt);
  check('Accepted capture uses the originating X tab', await worker.evaluate(() => globalThis.selectedCaptureTab) === 999);
  check('Capture finishes after chooser closes and stores the reading', captured.some(o => o.metric === 'followers_total' && o.value === 42 && o.provenance === 'captured'));
  const reopened = await chooserPage(base);
  const steps = await reopened.evaluate(() => [...document.querySelectorAll('#capture-status li')].map(li => li.querySelector('.name').textContent));
  check('Reopened chooser lists each step of the last read', steps.join(',') === 'Analytics,Rewards,Profile', steps.join(','));
  const settled = await reopened.evaluate(() => ({ clip: getComputedStyle(document.querySelector('#capture-status')).clipPath, reading: document.querySelector('.strip .xck-rd').classList.contains('reading'), busy: document.querySelector('#capture').getAttribute('aria-busy') }));
  check('An earlier result is shown as it stands: no feed animation, the reader at rest', settled.clip === 'none' && !settled.reading && settled.busy !== 'true', JSON.stringify(settled));
  // A read that finishes while the chooser is open prints its slip: it feeds out from under the key.
  const feed = async (page, id) => {
    await page.evaluate(id => chrome.storage.session.set({ 'xgd:run': { id, startedAt: '2026-10-30T10:00:00Z', finishedAt: '2026-10-30T10:00:05Z', account: null, steps: { profile: { state: 'done', message: 'read 42 followers' } } } }), id);
    await page.locator('#capture-status li').first().waitFor();
    return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(getComputedStyle(document.querySelector('#capture-status')).clipPath))));
  };
  const fed = await feed(reopened, 'synthetic-feed-1');
  await reopened.waitForTimeout(700);
  const fedAfter = await reopened.evaluate(() => ({ clip: getComputedStyle(document.querySelector('#capture-status')).clipPath, text: document.querySelector('#capture-status').textContent }));
  check('A read finishing now feeds its slip out, then rests fully shown', fed !== 'none' && fedAfter.clip === 'none' && /read 42 followers/.test(fedAfter.text), JSON.stringify({ fed, fedAfter }));
  await reopened.emulateMedia({ reducedMotion: 'reduce' });
  const still = await feed(reopened, 'synthetic-feed-2');
  check('Reduced motion: the slip appears at once', still === 'none', still);
  await reopened.emulateMedia({ reducedMotion: 'no-preference' });
  const mid = await feed(reopened, 'synthetic-feed-3');
  await reopened.emulateMedia({ reducedMotion: 'reduce' });
  // The feed runs 260ms; well inside that, the media change must already have cleared it.
  const cleared = await reopened.evaluate(() => new Promise(resolve => setTimeout(() => resolve(getComputedStyle(document.querySelector('#capture-status')).clipPath), 120)));
  check('Switching to reduced motion mid-feed settles the slip', mid !== 'none' && cleared === 'none', JSON.stringify({ mid, cleared }));
  await reopened.emulateMedia({ reducedMotion: 'no-preference' });
  const visibleFeed = await feed(reopened, 'synthetic-feed-4');
  await reopened.screenshot({ path: `${shots}/popup-slip-feeding.png` });
  await reopened.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('Hiding the popup settles the capture slip and stops the reader eyes', visibleFeed !== 'none' && await reopened.evaluate(() => getComputedStyle(document.querySelector('#capture-status')).clipPath === 'none' && getComputedStyle(document.querySelector('.xck-eye')).animationName === 'none'));
  const hiddenFeed = await feed(reopened, 'synthetic-feed-5');
  check('Capture result rendered while hidden stays settled', hiddenFeed === 'none');
  await reopened.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  check('Returning to the popup does not replay its last capture', await reopened.locator('#capture-status').evaluate(element => getComputedStyle(element).clipPath === 'none'));
  await reopened.emulateMedia({ reducedMotion: 'reduce' });
  await reopened.getByRole('button', { name: 'Quick tour', exact: true }).click();
  check('Replay in reduced motion is immediately visible and focused', await reopened.locator('#quick-tour').evaluate(el => !el.hidden && !el.style.transform && document.activeElement.id === 'tour-title'));
  await reopened.getByRole('button', { name: 'Next', exact: true }).press('Enter');
  check('Keyboard advances the tour with no tween in reduced motion', await reopened.locator('#quick-tour').evaluate(el => !el.style.transform && document.querySelector('#tour-count').textContent.endsWith('2 of 3')));
  await reopened.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await reopened.evaluate(() => chrome.storage.session.remove('xgd:run'));
  await reopened.close();

  // Keep the audience boundary honest: unknown must never overwrite either series.
  const audiencePage = await chooserPage(base);
  for (const audience of [false, true, null, 'missing']) {
    const before = await post.evaluate(async () => JSON.stringify((await chrome.storage.local.get('xgd:v1'))['xgd:v1']));
    await worker.evaluate(audience => {
      chrome.tabs.query = async () => [{ id: 999, url: 'https://x.com/i/account_analytics' }];
      chrome.scripting.executeScript = async () => [{ result: {
        ok: true, account: 'fixture_creator', ...(audience === 'missing' ? {} : { verifiedOnly: audience }),
        capturedAt: '2026-10-28T12:00:00Z', range: { from: '2026-10-27', to: '2026-10-28' },
        points: [{ t: Date.parse('2026-10-28T00:00:00Z'), m: { Impressions: audience === false ? 200 : 17 } }],
        followers: { verified: null, total: null }, appliedRange: false,
      } }];
    }, audience);
    const previousId = await post.evaluate(async () => (await chrome.storage.session.get('xgd:run'))['xgd:run']?.id);
    await audiencePage.getByRole('button', { name: 'Read current X tab' }).click();
    await post.waitForFunction(async previousId => {
      const run = (await chrome.storage.session.get('xgd:run'))['xgd:run'];
      return run?.id !== previousId && run?.finishedAt;
    }, previousId);
    const result = await post.evaluate(async () => ({ state: (await chrome.storage.local.get('xgd:v1'))['xgd:v1'], run: (await chrome.storage.session.get('xgd:run'))['xgd:run'] }));
    if (typeof audience === 'boolean') {
      const kind = audience ? 'verified' : 'all';
      check(`${kind} audience capture succeeds`, result.run.steps.analytics.state === 'done');
      check(`${kind} audience stored in its own series`, result.state.accounts.fixture_creator.daily[kind].rows['2026-10-28'].metrics.Impressions === (audience ? 17 : 200));
    } else {
      check(`${audience} audience fails with actionable explanation`, result.run.steps.analytics.state === 'failed' && /audience filter/.test(result.run.steps.analytics.message));
      check(`${audience} audience preserves all stored data`, JSON.stringify(result.state) === before);
    }
  }
  await audiencePage.close();
  check('No page errors after capture', errors.length === 0, errors.join('\n'));
  console.log(`${checks}/${checks} navigation checks passed`);
} finally { await ctx.close(); }
