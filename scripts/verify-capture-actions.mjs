// Built extension, synthetic empty storage. Browser API calls are intercepted;
// no real X page, permission prompt or account is used.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const results = [];
const check = (label, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-capture-actions-')), {
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
  headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  await context.route(/^https?:/, route => route.abort());
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const base = `chrome-extension://${worker.url().split('/')[2]}`;
  await context.addInitScript(() => {
    if (!globalThis.chrome?.tabs) return;
    window.captureCalls = { tabs: [], permissions: 0, messages: [] };
    chrome.tabs.create = async options => { window.captureCalls.tabs.push(options); return { id: 900 }; };
    chrome.permissions.request = async () => { window.captureCalls.permissions++; return false; };
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => { window.captureCalls.messages.push(args[0]?.type); return send(...args); };
  });
  for (const name of ['report', 'receipt']) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/${name}.html`);
    const open = page.getByRole('button', { name: 'Open X Analytics ↗', exact: true });
    await open.waitFor();
    check(`${name}: opening the tool does not open X`, await page.evaluate(() => window.captureCalls.tabs.length === 0));
    await open.click();
    const calls = await page.evaluate(() => window.captureCalls);
    check(`${name}: button opens one visible Analytics tab`, calls.tabs.length === 1 && calls.tabs[0].url === 'https://x.com/i/account_analytics' && calls.tabs[0].active === true);
    check(`${name}: button requests neither host access nor capture`, calls.permissions === 0 && !calls.messages.some(type => /capture|read/i.test(type ?? '')));
    check(`${name}: no page errors`, errors.length === 0);
    if (name === 'report') {
      const legacy = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'xgd:recapture' }));
      check('Legacy recapture message refuses hidden capture with an actionable error', typeof legacy?.error === 'string' && /Read current X tab/.test(legacy.error));
    }
    await page.close();
  }
} finally { await context.close(); }
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
if (!results.every(Boolean)) process.exitCode = 1;
