// Built content script on synthetic X DOM. Permission/config messages are simulated in page scope.
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath()].find((path) => path && existsSync(path));
const fixture = readFileSync('test/fixtures/following.html', 'utf8');
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext();
  const requests = [];
  await context.route('https://x.com/**', async (route) => {
    if (route.request().isNavigationRequest()) await route.fulfill({ status: 200, contentType: 'text/html', body: fixture });
    else await route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('request', (request) => {
    if (!request.isNavigationRequest() && /^https?:/.test(request.url())) requests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('https://x.com/byaarav/following');
  await page.evaluate(() => {
    const callbacks = [];
    window.xckConfig = { allowed: false, enabled: true, handle: 'byaarav' };
    window.xckUpdate = (patch) => {
      Object.assign(window.xckConfig, patch);
      callbacks.forEach((callback) => callback({ type: 'xck:followback:refresh' }));
    };
    window.chrome ??= {};
    window.chrome.runtime = {
      sendMessage: async () => ({ ...window.xckConfig }),
      onMessage: { addListener: (callback) => callbacks.push(callback) },
    };
    window.chrome.storage = { onChanged: { addListener: () => {} } };
  });
  await page.addScriptTag({ path: resolve('dist/followback.js') });
  const tinted = (id) => page.locator(`#${id}`).evaluate((row) => row.classList.contains('xck-nofollowback'));
  check('Permission absent leaves the page untouched', !(await tinted('missing')));
  await page.evaluate(() => window.xckUpdate({ allowed: true }));
  await page.waitForFunction(() => document.querySelector('#missing')?.classList.contains('xck-nofollowback'));
  check('Own page: missing badge tinted; localized badge and malformed rows untinted',
    await tinted('missing') && !(await tinted('mutual')) && !(await tinted('unknown')) &&
    !(await tinted('outside-badge')) && !(await tinted('ambiguous')));
  check('Bio mentions do not hide a non-follow-back row', await tinted('bio-mention'));
  check('Bio mentions do not change the localized follow-back badge', !(await tinted('mutual-bio')));
  check('Ambiguous or unknown avatar identity stays untinted', !(await tinted('ambiguous-avatars')) && !(await tinted('unknown-avatar')));
  check('Only one stylesheet is injected', await page.locator('#xck-followback-style').count() === 1);

  await page.evaluate(() => {
    const row = document.createElement('div');
    row.id = 'new-row'; row.dataset.testid = 'cellInnerDiv';
    row.innerHTML = '<div data-testid="UserCell"><a href="/maker_three">Maker Three</a></div>';
    document.querySelector('section').append(row);
  });
  await page.waitForFunction(() => document.querySelector('#new-row')?.classList.contains('xck-nofollowback'));
  check('New row appended by scrolling is tinted', await tinted('new-row'));
  await page.evaluate(() => {
    const oldRegion = document.querySelector('section');
    const replacement = oldRegion.cloneNode(true);
    oldRegion.replaceWith(replacement);
    const row = document.createElement('div');
    row.id = 'after-region-swap'; row.dataset.testid = 'cellInnerDiv';
    row.innerHTML = '<div data-testid="UserCell"><a href="/maker_seven">Maker Seven</a></div>';
    replacement.append(row);
  });
  await page.waitForFunction(() => document.querySelector('#after-region-swap')?.classList.contains('xck-nofollowback'));
  check('SPA timeline replacement rebinds the scoped observer', await tinted('after-region-swap'));
  await page.evaluate(() => document.querySelector('#missing [data-testid="UserCell"]').insertAdjacentHTML('beforeend', '<span data-testid="userFollowIndicator">Te sigue</span>'));
  await page.waitForFunction(() => !document.querySelector('#missing')?.classList.contains('xck-nofollowback'));
  await page.evaluate(() => document.querySelector('#mutual [data-testid="userFollowIndicator"]').remove());
  await page.waitForFunction(() => document.querySelector('#mutual')?.classList.contains('xck-nofollowback'));
  check('Badge changes reevaluate reused rows in both directions', !(await tinted('missing')) && await tinted('mutual'));
  await page.evaluate(() => { document.querySelector('#mutual [data-testid="UserCell"]').innerHTML = '<a href="/recycled">Recycled</a><span data-testid="userFollowIndicator">Te sigue</span>'; });
  await page.waitForFunction(() => !document.querySelector('#mutual')?.classList.contains('xck-nofollowback'));
  check('Virtualized row reuse removes stale tint', !(await tinted('mutual')));
  await page.evaluate(() => window.xckUpdate({ enabled: false }));
  await page.waitForFunction(() => !document.querySelector('.xck-nofollowback'));
  check('Switch off clears every tint', !(await tinted('new-row')));
  await page.evaluate(() => window.xckUpdate({ enabled: true }));
  await page.waitForFunction(() => document.querySelector('#new-row')?.classList.contains('xck-nofollowback'));
  await page.evaluate(() => history.pushState({}, '', '/other/following'));
  await page.waitForFunction(() => !document.querySelector('.xck-nofollowback'));
  check('SPA navigation to another account clears tints', !(await tinted('new-row')));
  await page.evaluate(() => history.pushState({}, '', '/byaarav/following'));
  await page.waitForFunction(() => document.querySelector('#new-row')?.classList.contains('xck-nofollowback'));
  await page.evaluate(() => { document.querySelector('[data-testid="AppTabBar_Profile_Link"]').href = '/other'; });
  await page.waitForFunction(() => !document.querySelector('.xck-nofollowback'));
  check('Signed-in profile mismatch clears tints', !(await tinted('new-row')));
  await page.evaluate(() => { document.querySelector('[data-testid="AppTabBar_Profile_Link"]').href = '/byaarav'; });
  await page.waitForFunction(() => document.querySelector('#new-row')?.classList.contains('xck-nofollowback'));
  await page.evaluate(() => window.xckUpdate({ handle: 'other' }));
  await page.waitForFunction(() => !document.querySelector('.xck-nofollowback'));
  check('Configured handle mismatch clears tints', !(await tinted('new-row')));
  await page.evaluate(() => window.xckUpdate({ handle: 'byaarav' }));
  await page.waitForFunction(() => document.querySelector('#new-row')?.classList.contains('xck-nofollowback'));
  await page.evaluate(() => window.xckUpdate({ allowed: false }));
  await page.waitForFunction(() => !document.querySelector('.xck-nofollowback'));
  check('Permission revocation clears tints', !(await tinted('new-row')));
  await page.evaluate(() => {
    window.xckReads = 0;
    for (const proto of [Document.prototype, Element.prototype]) for (const method of ['querySelector', 'querySelectorAll']) {
      const original = proto[method];
      proto[method] = function (selector, ...args) {
        if (/AppTabBar_Profile_Link|primaryColumn|section|UserCell|cellInnerDiv|userFollowIndicator/.test(selector)) window.xckReads++;
        return original.call(this, selector, ...args);
      };
    }
    const section = document.getElementsByTagName('section')[0];
    section.append(document.createElement('div'));
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForTimeout(1700);
  check('Revocation stops public DOM polling and queued navigation/mutation scans', await page.evaluate(() => window.xckReads === 0));
  await page.evaluate(() => window.xckUpdate({ allowed: true }));
  await page.waitForFunction(() => document.getElementById('new-row').classList.contains('xck-nofollowback'));
  check('Regrant resumes scanning in the already-open page', await tinted('new-row'));
  await page.evaluate(() => history.pushState({}, '', '/i/account_analytics'));
  await page.waitForFunction(() => !document.querySelector('.xck-nofollowback'));
  await page.evaluate(() => { window.xckReads = 0; });
  await page.waitForTimeout(1700);
  check('Enabled Following does not poll Analytics DOM', await page.evaluate(() => window.xckReads === 0));
  await page.evaluate(() => history.pushState({}, '', '/byaarav/following'));
  await page.waitForFunction(() => document.getElementById('new-row').classList.contains('xck-nofollowback'));
  check('Returning from Analytics resumes own Following tint', await tinted('new-row'));
  await page.evaluate(() => window.xckUpdate({ enabled: false }));
  await page.waitForFunction(() => !document.getElementsByClassName('xck-nofollowback').length);
  await page.evaluate(() => { window.xckReads = 0; dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForTimeout(1700);
  check('Disabled switch suspends public DOM polling too', await page.evaluate(() => window.xckReads === 0));
  check('No script-originated HTTP requests or browser errors', requests.length === 0 && errors.length === 0);
  if (requests.length || errors.length) console.error({ requests, errors });
  await context.close();
} finally {
  await browser.close();
}
const dist = resolve('dist');
const extensionContext = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-followback-ui-')), {
  executablePath, headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  let [worker] = extensionContext.serviceWorkers();
  worker ??= await extensionContext.waitForEvent('serviceworker');
  const extensionPage = await extensionContext.newPage();
  // The single Following switch now lives in the chooser's Following view (Receipts no longer repeats it).
  const view = `chrome-extension://${new URL(worker.url()).host}/launcher.html#following`;
  const sw = extensionPage.getByRole('switch', { name: 'Highlight non-follow-backs' });
  await extensionPage.goto(view);
  await sw.waitFor();
  // A new install has neither x.com access nor an account, so the switch must not claim to be on.
  check('Following switch is off on a new install', !(await sw.isChecked()) && (await extensionPage.locator('#following-state').textContent()) === 'Off');
  // Simulated native grant (headless Chrome cannot confirm the optional-host prompt) and a saved account.
  await extensionPage.addInitScript(() => { chrome.permissions.contains = async () => true; chrome.permissions.request = async () => true; });
  await extensionPage.evaluate(async () => chrome.storage.local.set({ 'xgd:v1': { schemaVersion: 1, settings: { expectedHandle: 'samplecreator', followBackEnabled: true }, accounts: {} } }));
  await extensionPage.reload();
  check('A grant for another tool and an old enabled default do not enable Following', !(await sw.isChecked()));
  await sw.check();
  await extensionPage.locator('#highlight:checked').waitFor();
  await extensionPage.waitForFunction(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1']?.settings?.followBackOptIn === true);
  check('Following switch shows on after an explicit tick', (await extensionPage.getByLabel('Your X handle').inputValue()).includes('samplecreator'));
  await sw.uncheck();
  await extensionPage.waitForFunction(async () =>
    (await chrome.storage.local.get('xgd:v1'))['xgd:v1']?.settings?.followBackEnabled === false);
  await extensionPage.reload();
  await sw.waitFor();
  check('Following switch persists off across reload', !(await sw.isChecked()));
  await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/receipt.html`);
  await extensionPage.locator('.stage-frame .art').waitFor();
  check('Receipts carries no second Following switch', await extensionPage.locator('#followback-enabled').count() === 0);
} finally {
  await extensionContext.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
