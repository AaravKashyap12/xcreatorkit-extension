// End-to-end smoke check of the BUILT extension in a throwaway Chromium profile.
// Never touches the user's own Chrome. Uses synthetic data only; outputs go to verification/.
//   node scripts/verify-extension.mjs
import { chromium } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const out = resolve('verification');
mkdirSync(out, { recursive: true });

const candidates = [process.env.CHROMIUM_PATH, chromium.executablePath()];
const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
if (local) for (const v of ['chromium-1243', 'chromium-1234', 'chromium-1223']) candidates.push(join(local, v, 'chrome-win64', 'chrome.exe'));
const executablePath = candidates.find((p) => p && existsSync(p));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xgd-verify-')), {
  executablePath,
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  viewport: { width: 1100, height: 1400 },
});
const consoleErrors = [];
const externalRequests = [];
ctx.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith('chrome-extension://') && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('chrome://') && !u.startsWith('https://x.com/')) externalRequests.push(u);
});

// Find the extension id from chrome://extensions.
const ext = await ctx.newPage();
await ext.goto('chrome://extensions');
const ids = await ext.evaluate(() => {
  const mgr = document.querySelector('extensions-manager');
  const list = mgr?.shadowRoot?.querySelector('extensions-item-list');
  return [...(list?.shadowRoot?.querySelectorAll('extensions-item') ?? [])].map((e) => e.id);
});
check('Manifest V3 extension loads', ids.length === 1, ids.join(','));
const id = ids[0];
const base = `chrome-extension://${id}`;

// ---------- Dashboard: first run ----------
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await page.goto(`${base}/dashboard.html`);
await page.waitForSelector('.xck-hero');
check('Empty Rewards finishes its loading announcement', await page.locator('main').getAttribute('aria-busy') !== 'true');
const emptyText = await page.textContent('main');
check('Empty state shows no rewards reading and the capture path', /No rewards reading yet/.test(emptyText) && /Open Rewards on X \(Creator Studio\)\.Choose “Read current X tab” in the extension menu\./.test(emptyText) && !/@\./.test(emptyText));
check('Empty state: no chart, ETA or projection', !(await page.$('svg.chart')) && !/ETA|you.re ahead|hits 500K|projected/i.test(emptyText));
check('Card refuses without a reading', /No rewards reading for this account yet/.test(emptyText));
await page.screenshot({ path: join(out, '01-dashboard-empty.png'), fullPage: true });

// ---------- Manual entry (synthetic test value from the brief's observation) ----------
// With no reading yet, hand entry is open; a new install has no account, so it is typed here.
const form = page.locator('#rw-manual');
check('First use: hand entry is open with an empty account field', await form.evaluate((d) => d.open) && await form.getByLabel('Account').inputValue() === '');
await form.locator('input').first().fill('109.2K');
await form.getByLabel('Account').fill('@byaarav');
await form.locator('button[type=submit]').click();
await page.waitForFunction(() => document.querySelector('.xck-hero-num')?.textContent?.startsWith('109.2K'));
const heroText = await page.textContent('.xck-hero');
check('Populated Rewards is not permanently busy', await page.locator('main').getAttribute('aria-busy') !== 'true');
check('Hero shows original display text 109.2K (rounded)', /109\.2K/.test(heroText) && /rounded/.test(heroText));
check('Progress ≈21.8% and ≈390.8K to go', /≈21\.8% of 500K/.test(heroText) && /≈390\.8K to go/.test(heroText));
const health = await page.textContent('.xck-health');
check('Source health ready + flags', /Ready/.test(health) && /User-reported/.test(await page.textContent('.xck-flags')), health.trim());
check('Single reading: chart empty-state, not a fabricated line', !(await page.$('svg.chart')) && /One reading so far/.test(await page.textContent('main')));

// Re-entering the same value the same day must not add a history point.
await form.locator('input').first().fill('109.2K');
await form.locator('button[type=submit]').click();
await page.waitForTimeout(400);
const rows = await page.locator('#rw-readings tbody tr').count();
check('Same-day duplicate re-confirms (1 row)', rows === 1, `rows=${rows}`);

// ---------- Share card ----------
const card = page.locator('section.xck-panel', { hasText: 'EOD share card' });
const dl = card.locator('button.xck-primary');
check('Download disabled until Day is confirmed', await dl.isDisabled());
const daySuggested = await card.locator('input[type=number]').inputValue();
await card.locator('input[type=checkbox]').check();
check('Download enabled after confirmation', !(await dl.isDisabled()), `Day ${daySuggested}`);
const status = await card.locator('p[role=status]').first().textContent();
check('Card status references stored reading', /109\.2K/.test(status) && /Rounded by X/.test(status), status);
for (const fmt of ['portrait', 'landscape']) {
  await card.locator('select').selectOption(fmt);
  const dataUrl = await card.locator('canvas').evaluate((c) => c.toDataURL('image/png'));
  const size = await card.locator('canvas').evaluate((c) => `${c.width}x${c.height}`);
  writeFileSync(join(out, `card-${fmt}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  check(`PNG export (${fmt})`, size === (fmt === 'portrait' ? '1080x1350' : '1600x900'), size);
  check(`Output label matches ${fmt} canvas`, (await card.locator('.xck-size').innerText()).replace(/\s/g, '') === `PNG·${size.replace('x', '×')}`);
}
await card.locator('select').selectOption('portrait');
check('Output label restores portrait after switching back', /1080 × 1350/.test(await card.locator('.xck-size').innerText()));
await page.screenshot({ path: join(out, '02-dashboard-one-reading.png'), fullPage: true });

// ---------- Backup ----------
const backup = await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1']);
check('Stored only under @byaarav', Object.keys(backup.accounts).join(',') === 'byaarav');
const o = backup.accounts.byaarav.observations[0];
check('Provenance recorded', o.provenance === 'manual' && o.precision === 'rounded' && o.metric === 'rewards_vht_90d' && o.roundingHalfStep === 50);

// ---------- No host access without a user gesture ----------
const xTab = await ctx.newPage();
const fixtureHtml = readFileSync(resolve('verification/fixture-rewards.html'), 'utf8');
await ctx.route('https://x.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml }));
await xTab.goto('https://x.com/i/jf/creators/original_content_rewards');
const denied = await page.evaluate(async () => {
  const outcomes = [];
  for (const tb of await chrome.tabs.query({})) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tb.id }, func: () => location.host });
      outcomes.push('allowed');
    } catch (e) {
      outcomes.push('denied');
    }
  }
  return outcomes;
});
check('No silent host access: scripting refused on every tab without a user gesture', !denied.includes('allowed'), denied.join(','));

// ---------- Bundled collector against a SYNTHETIC page served at the real rewards URL ----------
await xTab.addScriptTag({ path: join(dist, 'collector.js') });
const collected = await xTab.evaluate(() => globalThis.__xgdCollect());
check('Bundled collector reads synthetic rewards page', collected.ok && collected.parsed.displayText === '109.2K' && collected.account === 'byaarav', JSON.stringify(collected).slice(0, 160));

// Delayed hydration: value appears after 1.5 s; collector must wait, then return a stable value.
await xTab.evaluate(() => {
  const span = [...document.querySelectorAll('span')].find((s) => s.textContent === '109.2K');
  span.textContent = '';
  setTimeout(() => (span.textContent = '109.3K'), 1500);
});
const t0 = Date.now();
const hydrated = await xTab.evaluate(() => globalThis.__xgdCollect());
check('Collector waits for delayed hydration', hydrated.ok && hydrated.parsed.displayText === '109.3K', `${Date.now() - t0} ms`);

check('No console errors on extension pages', consoleErrors.length === 0, consoleErrors.join(' | '));
check('No external network requests', externalRequests.length === 0, externalRequests.join(', '));

await ctx.close();
writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), executablePath, results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
