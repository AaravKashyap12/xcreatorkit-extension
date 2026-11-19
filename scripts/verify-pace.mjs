// Verifies the rewards pace section of the dashboard with SYNTHETIC readings in a
// throwaway Chromium profile. Screenshots go to verification/pace-*.png.
//   node scripts/verify-pace.mjs
import { chromium } from 'playwright';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath(), ...(local ? ['chromium-1243', 'chromium-1234'].map((v) => join(local, v, 'chrome-win64', 'chrome.exe')) : [])].find((p) => p && existsSync(p));

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5));
const reading = (i, display, value, at) => ({
  id: `r${i}`, account: 'byaarav', accountSource: 'page', metric: 'rewards_vht_90d', displayText: display, value, precision: 'rounded', roundingHalfStep: 50, provenance: 'captured',
  sourceUrl: 'https://x.com/i/jf/creators/original_content_rewards', sourceLabel: 'X Creator Studio', capturedAt: at, lastSeenAt: at, reportingTimeZone: 'UTC', reportingDate: at.slice(0, 10),
  periodStart: null, periodEnd: null, windowType: 'rolling_90d', verifiedOnly: true, excludesReplies: true,
});
/** Daily readings from `from`; values in K (null = day not captured); the last one at `lastHour` UTC. */
const series = (from, ks, lastHour = '07:30') =>
  ks.flatMap((k, i) => (k == null ? [] : [reading(i, `${k.toFixed(1)}K`, Math.round(k * 1000), `${addDays(from, i)}T${i === ks.length - 1 ? lastHour : '18:00'}:00.000Z`)]));
const state = (observations) => ({
  schemaVersion: 1,
  settings: { expectedHandle: 'byaarav', reportingTimeZone: 'UTC', cycleCutoffHour: 0, dayAnchor: { date: '2026-09-30', day: 30 }, dayOverrides: {}, rewardsTarget: 500000, staleAfterHours: 24, utcOnly: true },
  accounts: { byaarav: { observations, attempts: [] } },
});

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xgd-pace-')), {
  executablePath, headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1100, height: 1200 }, timezoneId: 'Asia/Kolkata',
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const base = `chrome-extension://${sw.url().split('/')[2]}`;
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const open = async (now, st) => {
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${base}/dashboard.html`);
  await page.evaluate(async (s) => chrome.storage.local.set({ 'xgd:v1': s }), st);
  await page.reload();
  await page.waitForSelector('.xck-hero');
};
const tiles = async () => Object.fromEntries(await page.$$eval('.xck-stat-row .xck-stat', (els) => els.map((e) => [e.querySelector('.xck-figure-label').textContent, { v: e.querySelector('.xck-figure').textContent, s: e.querySelector('.xck-figure-sub').textContent }])));
const text = async (sel) => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

// Empty state: account impressions are deliberately excluded from rewards pace.
const accountOnly = { ...reading(0, '900.0K', 900000, '2026-10-09T07:30:00.000Z'), metric: 'account_impressions' };
await open('2026-10-09T07:40:00Z', state([accountOnly]));
check('Empty: account impressions never become a rewards reading', /No rewards reading yet/.test(await text('.xck-hero')) && /— · Pace appears/.test(await text('main')) && await page.locator('.xck-readings').count() === 0);
check('Empty: hand entry opens by default when there is no reading', await page.locator('#rw-manual').evaluate((d) => d.open));
check('Empty: shared kit navigation names Rewards pace and includes Ledger', await page.title() === 'Rewards pace · X Creator Kit' && await page.locator('.xck-nav a[aria-current="page"]').innerText() === 'Rewards pace' && await page.locator('.xck-nav a[href="report.html"]').innerText() === 'Ledger');
await page.goto(`${base}/receipt.html`);
await page.getByRole('link', { name: 'Rewards pace' }).click();
await page.waitForURL(`${base}/dashboard.html`);
check('Receipt header opens Rewards pace', await page.title() === 'Rewards pace · X Creator Kit');

// ---- Ahead: +6,000/day for 8 days (400.0K → 448.0K), today's reading at 07:30 UTC.
await open('2026-10-09T07:40:00Z', state(series('2026-10-01', [400, 406, 412, 418, 424, 430, 436, 442, 448])));
let t = await tiles();
check('Ahead: hero shows latest reading and to-go', /448\.0K/.test(await text('.xck-hero-num')) && /≈52\.0K to go/.test(await text('.xck-meter-legend')), await text('.xck-meter-legend'));
check('Ahead: Your rate = ≈+6K per day over 8 days', t['Your rate']?.v === '≈+6K' && /over 8 days \(1 Oct → 9 Oct\)/.test(t['Your rate']?.s), JSON.stringify(t['Your rate']));
check('Ahead: You need = +5.6K per day sustained (500K ÷ 90)', t['You need']?.v === '+5.6K' && /500K ÷ 90 days/.test(t['You need']?.s), JSON.stringify(t['You need']));
check('Ahead: Full window at this rate = ≈540K, above target', t['Full window at this rate']?.v === '≈540K' && /above target/.test(t['Full window at this rate']?.s), JSON.stringify(t['Full window at this rate']));
check('Ahead: Hits 500K on 18 Oct in ~9 days', t['Hits 500K']?.v === '18 Oct' && /in ~9 days at this rate$/.test(t['Hits 500K']?.s), JSON.stringify(t['Hits 500K']));
check("Ahead: callout says you're ahead with the holding arithmetic", /You're ahead/.test(await text('.xck-callout')) && /≈540K/.test(await text('.xck-callout')) && / 444 a day above/.test(await text('.xck-callout')), await text('.xck-callout'));
const charts = await page.$$eval('svg.chart', (s) => s.length);
check('Ahead: progress + daily-change charts rendered', charts === 2, `charts=${charts}`);
const dashed = await page.$$eval('svg.chart polyline[stroke-dasharray="5 4"]', (s) => s.length);
const solid = await page.$$eval('svg.chart polyline[stroke-dasharray="none"]', (s) => s.length);
check('Ahead: projection is the only dashed line; measured line is solid', dashed === 1 && solid === 1, `dashed=${dashed} solid=${solid}`);
check('Ahead: projection labelled as a straight line, not a forecast', /not a forecast of X/.test(await text('main')));
const refs = await page.$$eval('svg.chart text.axis', (ts) => ts.map((t) => t.textContent).filter((s) => /target|to hold/.test(s)));
check('Ahead: target line and holding-pace line labelled', refs.includes('500K target') && refs.includes('+5.6K/day to hold 500K'), refs.join(' | '));
const bars = await page.$$eval('svg.chart rect[rx]', (rs) => rs.filter((r) => Number(r.getAttribute('height')) > 0).length);
check('Ahead: 8 daily-change bars (first day has no previous reading)', bars === 8, `bars=${bars}`);
const hatched = await page.$$eval('svg.chart rect[fill="url(#partial-hatch)"]', (s) => s.length);
check("Ahead: today's bar hatched as partial", hatched === 1, `hatched=${hatched}`);
await page.screenshot({ path: 'verification/pace-ahead.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 850 });
check('Narrow charts stay within the page width', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('svg.chart')].every((chart) => chart.getBoundingClientRect().right <= innerWidth)));
await page.setViewportSize({ width: 1100, height: 1200 });

// ---- Single reading: no rate, no charts, plain reason.
await open('2026-10-02T19:10:00Z', state(series('2026-10-02', [109.2], '18:49')));
t = await tiles();
check('Single: tiles present but rate/ETA are "—" with a reason', t['Your rate']?.v === '—' && /two days apart/.test(t['Your rate']?.s) && t['Hits 500K']?.v === '—', JSON.stringify(t));
check('Single: no chart, no projection text', (await page.$$eval('svg.chart', (s) => s.length)) === 0 && /One reading so far/.test(await text('main')) && !/not a forecast/.test(await text('main')));
check('Single: measured captured figure remains visible', /109\.2K/.test(await text('.xck-hero-num')) && /Captured/.test(await text('.xck-hero .xck-hero-meta')));
await page.screenshot({ path: 'verification/pace-single.png', fullPage: true });

// Reached: target state stays visible without projecting further growth.
await open('2026-10-03T19:10:00Z', state(series('2026-10-01', [495, 499, 503])));
t = await tiles();
check('Reached: target and holding pace, no ETA projection', /Target reached/.test(await text('.xck-callout')) && t['Hits 500K']?.v === 'Reached' && (await page.$$eval('svg.chart polyline[stroke-dasharray="5 4"]', (s) => s.length)) === 0);
await page.screenshot({ path: 'verification/pace-reached.png', fullPage: true });

await open('2026-10-03T19:10:00Z', state([{ ...reading(0, '503.0K', 503000, '2026-10-03T18:00:00.000Z'), provenance: 'imported' }]));
check('Imported reading is labelled imported, never captured', /Imported/.test(await text('.xck-hero .xck-hero-meta')) && !/Captured/.test(await text('.xck-hero .xck-hero-meta')));

// UTC reporting remains stable when Chromium itself uses a non-UTC timezone.
const crossing = state([
  { ...reading(0, '100.0K', 100000, '2026-10-08T23:30:00.000Z'), reportingTimeZone: 'Asia/Kolkata', reportingDate: '2026-10-09' },
  reading(1, '101.0K', 101000, '2026-10-09T12:00:00.000Z'),
]);
crossing.settings = { ...crossing.settings, reportingTimeZone: 'Asia/Kolkata', cycleCutoffHour: 4, utcOnly: true };
crossing.accounts.byaarav.daily = { all: { rows: { '2026-10-08': { date: '2026-10-08', metrics: { Impressions: 25 }, capturedAt: '2026-10-08T23:30:00.000Z', partial: false } }, lastCaptureAt: '2026-10-08T23:30:00.000Z', lastRange: null, source: 'x_web_account_analytics' } };
await open('2026-10-09T13:00:00Z', crossing);
const dashboardDates = await page.locator('.xck-readings tbody tr td:first-child').allTextContents();
check('Dashboard keeps legacy and current readings on two UTC checkpoints', JSON.stringify(dashboardDates) === JSON.stringify(['2026-10-09', '2026-10-08']), JSON.stringify(dashboardDates));
check('UTC-only stores with custom legacy timezone still display UTC timestamps', /9 Oct 2026, 12:00 UTC/.test(await text('.xck-hero .xck-hero-meta')), await text('.xck-hero .xck-hero-meta'));
await page.evaluate(() => localStorage.setItem('xgd:receipt', JSON.stringify({ scene: 1, colourway: 0, metrics: ['impressionsDelta'], period: 'day' })));
await page.goto(`${base}/receipt.html`);
await page.waitForSelector('.stage-frame .art');
check('Receipt uses the two UTC checkpoints for yesterday change', (await page.locator('.stage-frame [data-row="0"] .num').getAttribute('data-value')) === '≈+1,000', await page.locator('.stage-frame [data-row="0"] .num').getAttribute('data-value'));
const receiptHistory = await page.evaluate(async () => {
  const stored = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  return { oldDate: stored.accounts.byaarav.observations[0].reportingDate, daily: stored.accounts.byaarav.daily.all.rows['2026-10-08'].metrics.Impressions };
});
check('Receipt read leaves legacy history and daily imports stored intact', receiptHistory.oldDate === '2026-10-09' && receiptHistory.daily === 25, JSON.stringify(receiptHistory));
// Receipts no longer repeats the Following setting (the shared navigation reaches it); its Day 1 field is a real settings write.
check('Receipts has no duplicate Following setting', await page.locator('#followback-enabled').count() === 0 && await page.getByText('Highlight accounts that don’t follow you back').count() === 0);
await page.locator('#day-one').fill('2026-09-05');
await page.locator('#day-one').dispatchEvent('change');
await page.waitForFunction(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].settings.dayAnchor?.date === '2026-09-05');
const afterSetting = await page.evaluate(async () => {
  const stored = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  return { oldDate: stored.accounts.byaarav.observations[0].reportingDate, daily: stored.accounts.byaarav.daily.all.rows['2026-10-08'].metrics.Impressions };
});
check('A settings write preserves legacy observations and daily imports', afterSetting.oldDate === '2026-10-09' && afterSetting.daily === 25, JSON.stringify(afterSetting));
const legacy = state([{
  ...reading(0, '109.2K', 109200, '2026-10-08T23:30:00.000Z'),
  reportingTimeZone: 'Asia/Kolkata', reportingDate: '2026-10-09',
}]);
legacy.settings = { ...legacy.settings, reportingTimeZone: 'Asia/Kolkata', cycleCutoffHour: 4, utcOnly: false };
await open('2026-10-09T01:00:00Z', legacy);
check('Legacy local reporting day displays as UTC without rewriting stored history', (await text('.xck-readings tbody tr td:first-child')) === '2026-10-08' && /8 Oct 2026, 23:30 UTC/.test(await text('.xck-hero .xck-hero-meta')) && (await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].accounts.byaarav.observations[0].reportingDate)) === '2026-10-09');
check('Settings offer Day 1 in UTC without timezone or cutoff controls', await page.getByLabel('Day 1 (UTC date)').count() === 1 && await page.getByLabel('Reporting timezone').count() === 0 && await page.getByLabel(/Cycle cutoff/).count() === 0);
check('Setup groups start closed when readings exist; their fields stay reachable', !(await page.locator('#rw-manual').evaluate((d) => d.open)) && !(await page.locator('#rw-settings').evaluate((d) => d.open)));
await page.locator('#rw-manual > summary').click();
// A bad value names the problem beside its field, keeps what was typed, and saves nothing.
await page.getByLabel('Rewards reading as shown by X').fill('lots');
await page.getByRole('button', { name: 'Save manual reading' }).click();
const valueInput = page.getByLabel('Rewards reading as shown by X');
check('Manual: invalid value is identified beside the field and kept', await valueInput.inputValue() === 'lots' && await valueInput.getAttribute('aria-invalid') === 'true' &&
  /exactly as X shows it/.test(await page.locator('#f-rewards-reading-as-shown-by-x-error').textContent()) && /f-rewards-reading-as-shown-by-x-error/.test(await valueInput.getAttribute('aria-describedby')) &&
  await page.evaluate(() => document.activeElement?.id) === 'f-rewards-reading-as-shown-by-x' && /Nothing was saved/.test(await text('#rw-manual .xck-form-status')));
check('Manual: nothing saved on error', (await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].accounts.byaarav.observations.length)) === 1);
await page.getByLabel('Rewards reading as shown by X').fill('110.0K');
await page.getByLabel('Read at (UTC)').fill('2026-10-08T23:45');
await page.getByRole('button', { name: 'Save manual reading' }).click();
await page.waitForFunction(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].accounts.byaarav.observations.length === 2);
const savedManual = await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].accounts.byaarav.observations.find((o) => o.provenance === 'manual'));
check('Manual date and time are interpreted as UTC in a non-UTC browser', savedManual?.capturedAt === '2026-10-08T23:45:00.000Z' && savedManual?.reportingDate === '2026-10-08' && savedManual?.reportingTimeZone === 'UTC', JSON.stringify(savedManual));
check('Manual save confirms after the page redraws, with the group still open', /Saved 110\.0K \(user-reported\)/.test(await text('#rw-manual .xck-form-status')) && await page.locator('#rw-manual').evaluate((d) => d.open));
check('Manual value stays user-reported, without a captured claim', /Entered/.test(await text('.xck-hero .xck-hero-meta')) && !/Captured/.test(await text('.xck-hero .xck-hero-meta')) && /User-reported/.test(await text('.xck-flags')));
await page.locator('#rw-settings > summary').click();
await page.getByLabel('Rewards target').fill('0');
await page.getByRole('button', { name: 'Save settings' }).click();
check('Settings: a zero target is refused beside its field and kept', await page.getByLabel('Rewards target').inputValue() === '0' && /whole-number target above 0/.test(await text('#f-rewards-target-error')) && (await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].settings.rewardsTarget)) === 500000);
await page.getByLabel('Rewards target').fill('500000');
await page.getByLabel('Day 1 (UTC date)').fill('2026-09-02');
await page.getByRole('button', { name: 'Save settings' }).click();
await page.waitForFunction(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].settings.dayAnchor.date === '2026-09-02');
const savedSettings = await page.evaluate(async () => (await chrome.storage.local.get('xgd:v1'))['xgd:v1'].settings);
check('Settings persist a UTC Day 1 and UTC reporting', savedSettings.dayAnchor.day === 1 && savedSettings.reportingTimeZone === 'UTC' && savedSettings.cycleCutoffHour === 0 && savedSettings.utcOnly === true);
await page.setViewportSize({ width: 390, height: 850 });
const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, nodes: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((el) => `${el.tagName}.${el.className}`) }));
check('Narrow layout has no page-wide horizontal overflow', overflow.scroll <= overflow.width, JSON.stringify(overflow));
check('Narrow layout keeps navigation and reading visible', await page.getByRole('button', { name: 'Rewards pace, tools menu' }).isVisible() && await page.locator('.xck-hero-num').isVisible());
await page.screenshot({ path: 'verification/pace-mobile.png', fullPage: true });
await page.setViewportSize({ width: 1100, height: 1200 });

// ---- Gap + behind: +2K/day with one missing day.
await open('2026-10-07T07:40:00Z', state(series('2026-10-01', [100, 102, null, 106, 108, 110, 112])));
t = await tiles();
check('Behind: rate +2K/day, full window ≈180K below target, Hits 500K far out with the expiry caveat', t['Your rate']?.v === '≈+2K' && t['Full window at this rate']?.v === '≈180K' && /below target/.test(t['Full window at this rate']?.s) && /only if nothing expires/.test(t['Hits 500K']?.s), JSON.stringify(t));
check('Behind: callout names the shortfall', /Behind the holding pace/.test(await text('.xck-callout')) && / 3\.6K a day short/.test(await text('.xck-callout')), await text('.xck-callout'));
const gapBars = await page.$$eval('svg.chart rect[rx]', (rs) => rs.filter((r) => Number(r.getAttribute('height')) > 0).length);
check('Behind: missing day leaves two gaps in the daily bars (not zeros)', gapBars === 4, `bars=${gapBars}`);
check('Behind: projection cut at 120 days and says so', /cut at 120 days \(500K would be 194 days out\)/.test(await text('main')));
await page.screenshot({ path: 'verification/pace-behind-gap.png', fullPage: true });

// ---- Sparse: weekly readings over a long projection keep every measured point visible, unjoined.
const weekly = [0, 7, 14, 21, 28].map((d, i) => reading(i, `${(200 + i * 14).toFixed(1)}K`, (200 + i * 14) * 1000, `${addDays('2026-09-01', d)}T12:00:00.000Z`));
await open('2026-09-29T13:00:00Z', state(weekly));
const sparse = await page.evaluate(() => {
  const chart = document.querySelector('svg.chart[aria-label^="Progress"]');
  return { cats: chart.querySelectorAll('text.axis').length, points: chart.querySelectorAll('circle').length, solid: chart.querySelectorAll('polyline[stroke-dasharray="none"]').length, dashed: chart.querySelectorAll('polyline[stroke-dasharray="5 4"]').length, titles: [...chart.querySelectorAll('circle title')].map((t) => t.textContent.split('\n')[1]) };
});
check('Sparse: all five weekly readings drawn as points on a >60-day chart, gaps not joined', sparse.points === 5 && sparse.solid === 0 && sparse.dashed === 1 && sparse.titles[4] === 'Measured readings: 256,000', JSON.stringify(sparse));
check('Sparse: values table lists each measured reading', (await page.locator('#rw-progress-values tbody tr').count()) === 6 && /256,000/.test(await text('#rw-progress-values tbody')));
await page.screenshot({ path: 'verification/pace-sparse.png', fullPage: true });

// ---- Falling window.
await open('2026-10-05T07:40:00Z', state(series('2026-10-01', [120, 118, 116, 113, 111])));
t = await tiles();
check('Falling: negative rate, no date, no full-window figure, shrinking explanation', t['Your rate']?.v === '≈−2.3K' && t['Hits 500K']?.v === '—' && t['Full window at this rate']?.v === '—' && /window shrinking/.test(t['Hits 500K']?.s) && /expiring faster/.test(await text('.xck-callout')), JSON.stringify(t));
check('Falling: no projection line', (await page.$$eval('svg.chart polyline[stroke-dasharray="5 4"]', (s) => s.length)) === 0);
await page.screenshot({ path: 'verification/pace-falling.png', fullPage: true });

check('No console errors', errors.length === 0, errors.join(' | '));
await ctx.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
