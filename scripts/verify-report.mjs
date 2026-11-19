import { capture as syntheticCapture } from './fixtures/analytics.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('verification', { recursive: true });
// Renders report.html in a throwaway Chromium profile with the BUILT extension and exports the PNG.
// Uses deterministic synthetic data on every run.
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath(), ...(local ? ['chromium-1243', 'chromium-1234'].map((v) => join(local, v, 'chrome-win64', 'chrome.exe')) : [])].find((p) => p && existsSync(p));
const capture = syntheticCapture;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xgd-rep-')), {
  executablePath, headless: true, acceptDownloads: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1440, height: 980 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.clock.setFixedTime(new Date(capture.capturedAt));
await page.goto(`chrome-extension://${id}/report.html`);
await page.waitForSelector('#stage');
await page.screenshot({ path: 'verification/report-empty.png' });

await page.evaluate(async (c) => {
  const today = c.capturedAt.slice(0, 10);
  const rows = {};
  for (const p of c.points) {
    const date = new Date(p.t).toISOString().slice(0, 10);
    rows[date] = { date, metrics: p.m, capturedAt: c.capturedAt, partial: date >= today };
  }
  const base = { account: 'byaarav', accountSource: 'page', provenance: 'captured', reportingTimeZone: 'UTC', reportingDate: '2026-10-02', periodStart: null, periodEnd: null, lastSeenAt: c.capturedAt, capturedAt: c.capturedAt };
  const observations = [
    { ...base, id: 'r1', metric: 'rewards_vht_90d', displayText: '109.2K', value: 109200, precision: 'rounded', roundingHalfStep: 50, sourceUrl: 'https://x.com/i/jf/creators/original_content_rewards', sourceLabel: 'X Creator Studio · Original Content Rewards', windowType: 'rolling_90d', verifiedOnly: true, excludesReplies: true },
    { ...base, id: 'f1', metric: 'followers_verified', displayText: '749', value: 749, precision: 'exact', roundingHalfStep: 0, sourceUrl: 'https://x.com/i/account_analytics', sourceLabel: 'X Analytics · follower card', windowType: 'unknown', verifiedOnly: null, excludesReplies: null },
    { ...base, id: 'f2', metric: 'followers_total', displayText: '1K', value: 1000, precision: 'rounded', roundingHalfStep: 500, sourceUrl: 'https://x.com/i/account_analytics', sourceLabel: 'X Analytics · follower card', windowType: 'unknown', verifiedOnly: null, excludesReplies: null },
  ];
  const state = { schemaVersion: 1, settings: { expectedHandle: 'byaarav', reportingTimeZone: 'UTC', cycleCutoffHour: 0, utcOnly: true, dayAnchor: { date: '2026-09-30', day: 30 }, dayOverrides: { '2026-10-01': 31 }, rewardsTarget: 500000, staleAfterHours: 24 }, accounts: { byaarav: { observations, attempts: [], daily: { all: { rows, lastCaptureAt: c.capturedAt, lastRange: c.range, source: 'x_web_account_analytics' } } } } };
  await chrome.storage.local.set({ 'xgd:v1': state });
}, capture);
await page.waitForFunction(() => document.querySelector('.rw-hero')?.textContent === '109.2K');
await page.waitForTimeout(300);
console.log('stage size', await page.evaluate(() => { const s = document.getElementById('stage'); return [s.scrollWidth, s.scrollHeight, document.body.scrollHeight, document.querySelectorAll('svg').length]; }));
page.on('crash', () => console.log('PAGE CRASHED'));
for (const d of ['30D', '7D', '90D']) {
  await page.getByRole('button', { name: d, exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `verification/report-page-${d}.png` });
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG' }).click();
  const file = await dl;
  await file.saveAs(`verification/report-${d}.png`);
}
await page.getByRole('button', { name: '30D', exact: true }).click();
await page.waitForTimeout(400);
// Comparison toggle on: export a second variant.
await page.getByLabel('Compare', { exact: true }).check();
await page.waitForTimeout(300);
{ const dl = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PNG' }).click(); await (await dl).saveAs('verification/report-30D-compare.png'); }
await page.getByLabel('Compare', { exact: true }).uncheck();
await page.waitForTimeout(300);
// X-feed size check: downscale the exported PNG to ~X desktop (600px) and mobile (390px css @3x ≈ 1170px) widths.
const png = readFileSync('verification/report-30D.png').toString('base64');
for (const w of [600, 1170]) {
  const out = await page.evaluate(async ([b64, w]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round(img.height * w / img.width);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }, [png, w]);
  writeFileSync(`verification/report-30D-feed-${w}.png`, Buffer.from(out, 'base64'));
}
// Narrow screens: the export sits under the preview; zoom makes the card readable without widening the page.
let narrowOk = true;
{
  const box = (sel) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; });
  const frame = await box('.frame'); const dl = await box('.export-row button.primary');
  const below = dl.top >= frame.bottom && dl.top - frame.bottom < 48;
  console.log('Export button sits under the preview:', below, JSON.stringify({ frame, dl }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const zoom = page.getByRole('button', { name: 'Zoom to read' });
  const fitted = (await box('.frame')).width;
  await zoom.click();
  await page.waitForTimeout(150);
  const zoomed = await page.evaluate(() => ({ frame: document.querySelector('.frame').getBoundingClientRect().width, page: document.documentElement.scrollWidth - innerWidth, scroller: document.querySelector('.frame-scroll').scrollWidth > document.querySelector('.frame-scroll').clientWidth, pressed: document.querySelector('.export-row .zoom').getAttribute('aria-pressed'), label: document.querySelector('.export-row .zoom').textContent, left: document.querySelector('.frame').getBoundingClientRect().left }));
  const zoomOk = zoomed.frame >= 700 && zoomed.frame > fitted * 1.5 && zoomed.page <= 0 && zoomed.scroller && zoomed.pressed === 'true' && zoomed.label === 'Fit to screen' && zoomed.left >= 0;
  console.log('Zoom to read at 390px:', zoomOk, JSON.stringify({ fitted, ...zoomed }));
  await page.screenshot({ path: 'verification/report-390-zoom.png', fullPage: true });
  const dlz = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PNG' }).click();
  const zpng = readFileSync(await (await dlz).path());
  const sameSize = zpng.readUInt32BE(16) === 2400 && zpng.readUInt32BE(20) === 1500;
  console.log('Zoomed preview exports the same 2400×1500 PNG:', sameSize);
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  narrowOk = below && zoomOk && sameSize;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(150);
  const wideHidden = await page.locator('.export-row .zoom').isHidden();
  console.log('Zoom stays out of the way when the card is readable:', wideHidden);
  narrowOk &&= wideHidden;
}
// Page styles must never reach the artwork preview: the old global `.bar { height: 3px }` once squashed every daily bar.
await page.getByRole('button', { name: '30D', exact: true }).click();
await page.waitForTimeout(250);
const bars = await page.$$eval('#stage rect.bar', (rs) => rs.map((r) => ({ attr: Number(r.getAttribute('height')), drawn: r.getBBox().height, css: getComputedStyle(r).height })));
const tall = bars.filter((b) => b.attr > 3);
const barsOk = tall.length >= 10 && tall.every((b) => Math.abs(b.drawn - b.attr) < 0.5 && (b.css === 'auto' || Math.abs(parseFloat(b.css) - b.attr) < 0.5));
console.log('Ledger preview bars keep their own heights (no UI CSS leak):', barsOk, `${tall.length} bars over 3px`, barsOk ? '' : JSON.stringify(tall.slice(0, 4)));
const story = await page.$$eval('.mo .tr-title, .mo .ef-sub, .mo .end-val, .mo .end-unit', (l) => l.map((x) => x.textContent));
const tiles = await page.$$eval('.tile', (l) => l.map((x) => x.innerText.replace(/\n/g, ' | ')));
const overflow = await page.evaluate(() => [...document.querySelectorAll('#stage .card')].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).map((c) => c.className + ' ' + (c.querySelector('.eyebrow,.tr-title,.st-title')?.textContent ?? '')));
console.log('Tiles:\n ' + tiles.join('\n '));
console.log('Story:\n ' + story.join('\n '));
console.log('Overflowing cards:', overflow.length ? overflow : 'none');
console.log('Console errors:', errors.length ? errors : 'none');
await page.evaluate(async () => {
  const state = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  const reward = state.accounts.byaarav.observations.find(r => r.metric === 'rewards_vht_90d');
  reward.provenance = 'manual'; reward.sourceUrl = null;
  reward.lastSeenAt = new Date(Date.parse(reward.lastSeenAt) - 3600000).toISOString();
  await chrome.storage.local.set({ 'xgd:v1': state });
});
await page.waitForTimeout(400);
const sourceText = await page.locator('.r-foot').innerText();
const manualOk = /hand-entered Rewards/.test(sourceText) && /rewards entered/.test(sourceText) && !/Captured:.*rewards|Rewards rounded by X/.test(sourceText);
console.log('Manual Rewards never claim captured provenance in Ledger:', manualOk, sourceText);
await ctx.close();

if (overflow.length || errors.length || !narrowOk || !barsOk || !manualOk) process.exitCode = 1;
