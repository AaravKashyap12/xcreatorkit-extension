// Analytics in the BUILT extension, throwaway Chromium profile, pinned clock, synthetic data only.
// Four question tiles drive one main chart; Breakdowns and a disclosed Explore follow. Checks calendar ranges, gaps,
// unreported fields, in-progress days, comparisons, keyboard use, audiences, accounts, custom dates, the compare
// filter, per-section share images (dialog, PNG size and pixels, clipboard, hidden handle) and narrow layouts.
import { capture } from './fixtures/analytics.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const shots = 'verification/_analytics';
mkdirSync(shots, { recursive: true });
let checks = 0;
const check = (name, ok, detail = '') => { assert.ok(ok, `${name}${detail ? ` · ${detail}` : ''}`); console.log(`PASS ${name}`); checks++; };

// ---------- Expected values straight from the synthetic fixture ----------
const TODAY = capture.capturedAt.slice(0, 10); // 2026-10-02, in progress
const byDate = Object.fromEntries(capture.points.map((p) => [new Date(p.t).toISOString().slice(0, 10), p.m]));
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const days = (end, n) => Array.from({ length: n }, (_, i) => addDays(end, i - n + 1));
const sum = (ds, k) => ds.reduce((s, d) => s + byDate[d][k], 0);
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const longDate = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
const cur28 = days('2026-10-01', 28);
const prev28 = days('2026-09-03', 28);
const imp28 = sum(cur28, 'Impressions');
const impChange = ((imp28 - sum(prev28, 'Impressions')) / sum(prev28, 'Impressions')) * 100;
const er = (ds) => sum(ds, 'Engagements') / sum(ds, 'Impressions');
const erPts = (er(cur28) - er(prev28)) * 100;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-an-')), {
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, viewport: { width: 1280, height: 1000 },
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
});
const errors = []; const requests = [];
ctx.on('request', (r) => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const base = `chrome-extension://${new URL(worker.url()).host}`;
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.addInitScript(() => {
  const Native = window.ResizeObserver; window.activeChartTargets = new Set();
  window.ResizeObserver = class extends Native {
    targets = new Set();
    observe(t, o) { this.targets.add(t); window.activeChartTargets.add(t); super.observe(t, o); }
    disconnect() { for (const t of this.targets) window.activeChartTargets.delete(t); this.targets.clear(); super.disconnect(); }
  };
  // Chromium will not grant clipboard permissions to an extension origin, so record what the page hands to the
  // async clipboard API (types and decoded size) instead of reading the system clipboard back.
  window.clips = [];
  if (navigator.clipboard) navigator.clipboard.write = async (items) => { for (const it of items) for (const t of it.types) { const b = await it.getType(t); const im = await createImageBitmap(b); window.clips.push({ type: t, w: im.width, h: im.height }); } };
});
await page.clock.setFixedTime(new Date(capture.capturedAt));

/** Store state built from the fixture; `edit(rows)` may change rows before saving. */
const seed = (accounts) => page.evaluate(async ({ c, accounts }) => {
  const rowsOf = (scale = 1) => { const rows = {}; for (const p of c.points) { const date = new Date(p.t).toISOString().slice(0, 10); rows[date] = { date, metrics: Object.fromEntries(Object.entries(p.m).map(([k, v]) => [k, v * scale])), capturedAt: c.capturedAt, partial: date >= c.capturedAt.slice(0, 10) }; } return rows; };
  const series = (rows) => ({ rows, lastCaptureAt: c.capturedAt, lastRange: c.range, source: 'x_web_account_analytics' });
  const acc = {};
  for (const [handle, kinds] of Object.entries(accounts)) acc[handle] = { observations: [], attempts: [], daily: Object.fromEntries(Object.entries(kinds).map(([k, scale]) => [k, series(rowsOf(scale))])) };
  await chrome.storage.local.set({ 'xgd:v1': { schemaVersion: 1, settings: { expectedHandle: Object.keys(accounts)[0] ?? '', reportingTimeZone: 'UTC', cycleCutoffHour: 0, utcOnly: true, dayAnchor: { date: '2026-09-30', day: 30 }, dayOverrides: {}, rewardsTarget: 500000, staleAfterHours: 24 }, accounts: acc } });
}, { c: capture, accounts });
/** Edit stored rows in place with one declarative operation per date (extension pages forbid eval). */
const edit = (handle, kind, dates, op) => page.evaluate(async ({ handle, kind, dates, op }) => {
  const { 'xgd:v1': st } = await chrome.storage.local.get('xgd:v1');
  const rows = st.accounts[handle].daily[kind].rows;
  for (const date of dates) {
    if (op.drop) delete rows[date];
    else if (op.row) rows[date] = { ...op.row, date };
    else if (!rows[date]) continue;
    else if (op.dropField) delete rows[date].metrics[op.dropField];
    else if (op.partial) rows[date].partial = true;
    else if (op.metric) rows[date].metrics[op.metric[0]] = op.metric[1];
  }
  await chrome.storage.local.set({ 'xgd:v1': st });
}, { handle, kind, dates, op });
// A tile by its own label: the engagement-rate tile also mentions impressions in its denominator line.
const tile = (label) => page.locator('.xck-tile').filter({ has: page.locator('.xck-figure-label', { hasText: new RegExp(`^${label}$`) }) });
// Tile names are set in capitals by CSS (the DOM text is unchanged), so the two checks that anchor on a name ignore case.
const tileText = async (label) => (await tile(label).innerText()).replace(/\s+/g, ' ');
const context = () => page.locator('#analytics-source').innerText();
const notes = async () => (await page.locator('#analytics-notes').count()) ? page.locator('#analytics-notes').innerText() : '';
const readout = () => page.locator('.xck-main-chart .xck-readout').innerText();
const mainBox = () => page.locator('.xck-main-chart .chart-box');
/** Reach the main chart from the keyboard, as a person would: Tab from the control before it. */
const focusChart = async () => { await page.locator('[data-key="share:main"]').focus(); await page.keyboard.press('Tab'); };
const compareTo = async (label) => { await page.getByRole('group', { name: 'Compare' }).getByRole('button', { name: label }).click(); await waitFor((l) => document.querySelector(`[data-key="Compare:${l === 'Off' ? 'off' : 'prev'}"]`)?.getAttribute('aria-pressed') === 'true', label); };
const openValues = async (id) => { const d = page.locator(`#${id}-values`); if (!(await d.evaluate((x) => x.open))) await d.locator('summary').click(); return d; };
const valueRows = async (id) => (await openValues(id)).locator('tbody tr').allInnerTexts();
const waitFor = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 });

// ---------- Loading and first use ----------
check('Loading state is a static skeleton marked busy', /aria-busy="true"/.test(readFileSync('dist/analytics.html', 'utf8')) && /xck-skeleton/.test(readFileSync('dist/analytics.html', 'utf8')));
await page.goto(`${base}/analytics.html`);
await page.getByRole('heading', { name: 'No X Analytics captured yet' }).waitFor();
check('Empty Analytics finishes its loading announcement', await page.locator('main').getAttribute('aria-busy') !== 'true');
check('First use: one explanation, three steps, Open X Analytics, no chart or sample numbers',
  await page.locator('.xck-steps li').count() === 3 && await page.getByRole('button', { name: 'Open X Analytics ↗' }).count() >= 1 && await page.locator('svg.chart').count() === 0 && await page.locator('.xck-tile').count() === 0);
check('First use says Read current X tab reads only the range loaded on that page, and promises no automatic refresh',
  /reads only the range that page has loaded/.test(await page.locator('.xck-steps').innerText()) && !/automatic|every source|all sources|in the background|X-approved|compliant/i.test(await page.locator('main').innerText()));

// ---------- Populated, default: last 28 complete UTC days ----------
await seed({ fixture: { all: 1 } });
await tile('Impressions').waitFor();
check('Populated Analytics is not permanently busy', await page.locator('main').getAttribute('aria-busy') !== 'true');
check('Default range is 28 calendar days ending yesterday (UTC)', /4 Sep – 1 Oct 2026 · UTC · 28 of 28 days captured · last read 2 Oct 2026, 18:08 UTC/.test(await context()), await context());
check('Today is named as left out, not as missing', /Today \(2 Oct\) is in progress and not included\./.test(await notes()) && !/not captured/.test(await notes()), await notes());
check('Four question tiles in order, Impressions selected', JSON.stringify(await page.$$eval('.xck-tile .xck-figure-label', (l) => l.map((x) => x.textContent))) === JSON.stringify(['Impressions', 'Engagement rate', 'Profile visits', 'Net follows']) && await page.getByRole('radio', { name: /Impressions/ }).isChecked());
check('Impressions tile: exact total and its change against the complete prior 28 days', (await tileText('Impressions')).includes(fmt(imp28)) && (await tileText('Impressions')).includes(`${impChange >= 0 ? '+' : '−'}${Math.abs(impChange).toFixed(1)}% vs 7 Aug – 3 Sep 2026`), await tileText('Impressions'));
check('Engagement rate is weighted and its change is in percentage points', (await tileText('Engagement rate')).includes(`${(er(cur28) * 100).toFixed(2)}%`) && (await tileText('Engagement rate')).includes(`${Math.abs(erPts).toFixed(2)} pts vs 7 Aug – 3 Sep 2026`), await tileText('Engagement rate'));
check('Net follows: follows minus unfollows, with a difference rather than a percent', (await tileText('Net follows')).includes(`+${sum(cur28, 'Follows') - sum(cur28, 'Unfollows')}`) && /±0 vs 7 Aug – 3 Sep 2026/i.test(await tileText('Net follows')) && !/%/i.test(await tileText('Net follows')), await tileText('Net follows'));
check('Impressions caption says views, not people, and not the Rewards metric', /one person can count more than once/.test(await page.locator('#analytics-metric-note').innerText()) && /not the Verified Home Timeline Rewards metric/.test(await page.locator('#analytics-metric-note').innerText()));
check('The impressions-per-new-item ratio is gone', !/per item published|Reach per item/i.test(await page.locator('main').innerText()));
check('Readout starts on the latest complete day with the same day of the previous 28', (await readout()) === `${longDate('2026-10-01')} (UTC) · Impressions ${fmt(byDate['2026-10-01'].Impressions)} · Previous 28 days ${fmt(byDate['2026-09-03'].Impressions)}`, await readout());
await compareTo('Off');
check('Compare off: no changes on the tiles, and the 7-day average returns', !/ vs /.test(await page.locator('.xck-tiles').innerText()) && (await readout()) === `${longDate('2026-10-01')} (UTC) · Impressions ${fmt(byDate['2026-10-01'].Impressions)} · 7-day average ${fmt(Math.round(sum(days('2026-10-01', 7), 'Impressions') / 7))}`, await readout());
await compareTo('Previous period');
check('Compare on: the main chart names the previous period and its dates', /The thin grey line is the previous 28 days \(7 Aug – 3 Sep 2026\), day for day\./.test(await page.locator('#analytics-metric-note').innerText()));
const rows28 = await valueRows('an-main');
check('Show values lists one exact row per calendar day', rows28.length === 28 && rows28[0].startsWith(longDate('2026-09-04')) && rows28.at(-1).includes(fmt(byDate['2026-10-01'].Impressions)), `${rows28.length} ${rows28[0]}`);
check('Chart colours come from the slate and Analytics tokens', await page.$$eval('svg.chart rect[rx]', (rs) => rs.every((r) => /var\(--xck-/.test(r.getAttribute('style') ?? ''))));
const mainLook = await page.locator('.xck-main-chart svg.chart').evaluate((svg) => ({
  bars: svg.querySelectorAll('rect[rx]').length,
  areas: [...svg.querySelectorAll('polygon.area')].map((a) => a.getAttribute('fill')),
  stops: [...svg.querySelectorAll('linearGradient stop')].map((st) => +st.getAttribute('stop-opacity')),
  line: [...svg.querySelectorAll('polyline')].map((l) => l.getAttribute('style') ?? '')[0],
  shown: [...svg.querySelectorAll('circle.pt')].filter((c) => c.getAttribute('visibility') === 'visible').map((c) => c.dataset.i),
  prevDots: [...svg.querySelectorAll('circle')].filter((c) => /series-2/.test(c.getAttribute('style') ?? '')).length,
}));
check('Daily impressions draw as a muted blue line over pale shading, not solid bars', mainLook.bars === 0 && mainLook.areas.length === 1 && /^url\(#xck-area-/.test(mainLook.areas[0]) && mainLook.stops.every((o) => o > 0 && o <= 0.2) && /stroke:var\(--xck-an-line\)/.test(mainLook.line), JSON.stringify(mainLook));
check('Only the read-out day carries a marker; the previous-period line stays quiet', JSON.stringify(mainLook.shown) === '["27"]' && mainLook.prevDots === 0, JSON.stringify(mainLook));
const tileLook = await page.$$eval('.xck-tile', (ts) => ts.map((t) => ({ spark: !!t.querySelector('svg.xck-spark[aria-hidden="true"] polyline'), border: getComputedStyle(t).borderTopColor, shadow: getComputedStyle(t).boxShadow, pill: t.querySelector('.xck-change') ? (({ borderRadius, backgroundColor }) => ({ r: parseFloat(borderRadius), bg: backgroundColor }))(getComputedStyle(t.querySelector('.xck-change'))) : null })));
check('Each tile carries its own trend line and a subdued change pill', tileLook.every((t) => t.spark && t.pill.r >= 4 && t.pill.bg !== 'rgba(0, 0, 0, 0)') && tileLook[0].pill.bg === 'rgb(251, 233, 230)' && tileLook[1].pill.bg === 'rgb(227, 242, 232)', JSON.stringify(tileLook));
// Was: outlined in the line blue. The plotted metric is now held by an ink edge, with the reader's brackets around its name.
check('The selected tile is held by an ink edge, distinct from the others', tileLook[0].border === 'rgb(19, 19, 19)' && tileLook[0].shadow !== tileLook[1].shadow && tileLook.slice(1).every((t) => t.border !== tileLook[0].border), JSON.stringify(tileLook.map((t) => t.border)));
// Was: a raised white chip. Selection is an ink face everywhere in the kit; keyboard focus stays a separate ring.
check('The selected segment is an ink face', await page.getByRole('group', { name: 'Compare' }).getByRole('button', { name: 'Previous period' }).evaluate((b) => getComputedStyle(b).backgroundColor === 'rgb(19, 19, 19)' && getComputedStyle(b).color === 'rgb(255, 255, 255)' && getComputedStyle(b).fontWeight === '600'));

// ---------- Keyboard: chart readout and metric selection ----------
await focusChart();
check('The chart takes keyboard focus with a visible ring', await mainBox().evaluate((el) => getComputedStyle(el).outlineStyle !== 'none'));
await page.keyboard.press('ArrowLeft');
check('Left arrow reads the previous day', (await readout()).startsWith(`${longDate('2026-09-30')} (UTC) · Impressions ${fmt(byDate['2026-09-30'].Impressions)}`), await readout());
await page.keyboard.press('Home');
check('Home reads the first day; the column is highlighted', (await readout()).startsWith(longDate('2026-09-04')) && await page.locator('.xck-main-chart .focus-band').count() === 1);
check('…and the line marker moves to that day', JSON.stringify(await page.locator('.xck-main-chart circle.pt[visibility="visible"]').evaluateAll((cs) => cs.map((c) => c.dataset.i))) === '["0"]');
await page.keyboard.press('End');
check('End reads the last day', (await readout()).startsWith(longDate('2026-10-01')));
await page.getByRole('radio', { name: /Impressions/ }).focus();
await page.keyboard.press('ArrowRight');
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Engagement rate per day');
check('Arrow keys move the metric selection, swap the main chart and keep focus on the tile', await page.getByRole('radio', { name: /Engagement rate/ }).isChecked() && await page.evaluate(() => document.activeElement?.dataset.key) === 'metric:EngagementRate' && await page.locator('.xck-main-chart polyline').count() >= 1);
check('The focused tile shows a ring distinct from the selected fill', await tile('Engagement rate').evaluate((el) => getComputedStyle(el).outlineStyle !== 'none' && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'));
await tile('Net follows').click();
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Follows and unfollows per day');
check('Net follows draws follows above zero, unfollows below, and the net in the readout', /Follows 5 · Unfollows 1 · Net follows \+4$/.test(await readout()), await readout());
check('Followers breakdown is not repeated while it is the main chart', await page.locator('.xck-breakdowns section[aria-label="Followers"]').count() === 0);
await tile('Impressions').click();
await page.screenshot({ path: `${shots}/an-1280.png`, fullPage: true });

// ---------- Calendar gap ----------
await edit('fixture', 'all', ['2026-09-20'], { drop: true });
await waitFor(() => /27 of 28 days captured/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
// Coverage strip: one mark per UTC day of the range; the day that was not read is a gap, never a filled mark.
const cover = () => page.$eval('#analytics-coverage', (el) => ({ hidden: el.getAttribute('aria-hidden'), days: [...el.children].map((c) => c.className), titles: [...el.children].map((c) => c.title), dense: el.className }));
const gapCover = await cover();
check('Coverage strip marks the uncaptured day as a gap and says so on hover', gapCover.days.length === 28 && gapCover.days.filter((d) => d === 'gap').length === 1 && gapCover.days.indexOf('gap') === 16 && gapCover.titles[16] === '20 Sep 2026 (UTC) · not captured' && gapCover.days.filter((d) => d === 'read').length === 27 && gapCover.hidden === 'true', JSON.stringify({ days: gapCover.days.join(','), title: gapCover.titles[16] }));
check('The gap is drawn hollow, a captured day in blue ink', await page.$eval('#analytics-coverage', (el) => { const gap = getComputedStyle(el.querySelector('.gap')); const read = getComputedStyle(el.querySelector('.read')); return gap.backgroundColor === 'rgba(0, 0, 0, 0)' && read.backgroundColor === 'rgb(33, 64, 201)'; }));
check('A missing day keeps its calendar place and is named once', /1 day in this range was not captured and shows as a gap\./.test(await notes()) && await page.locator('.xck-main-chart .missing-mark').count() === 1, await notes());
check('The gap breaks the line and its shading: nothing joins across the missing day', await page.locator('.xck-main-chart svg.chart').evaluate((svg) => {
  const areas = [...svg.querySelectorAll('polygon.area')]; const plot = svg.dataset.plot.split(' ').map(Number); const gapX = plot[0] + (plot[2] / plot[4]) * 16.5;
  const xs = (el) => el.getAttribute('points').trim().split(/\s+/).map((p) => +p.split(',')[0]);
  const own = [...svg.querySelectorAll('polyline')].filter((l) => /--xck-an-line/.test(l.getAttribute('style') ?? '')); // the previous period keeps its own complete days
  return areas.length === 2 && own.length === 2 && [...areas, ...own].every((el) => { const x = xs(el); return !(Math.min(...x) < gapX && Math.max(...x) > gapX); });
}));
check('The gap is a dash in the exact values, never 0', (await valueRows('an-main')).find((r) => r.startsWith(longDate('2026-09-20')))?.includes('—'));
check('Tiles label a captured subtotal and drop the comparison', /Captured subtotal · 27 of 28 days/i.test(await tileText('Impressions')) && !/vs /i.test(await tileText('Impressions')), await tileText('Impressions'));
await focusChart(); await page.keyboard.press('End');
for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowLeft');
check('The readout names the current gap and retains the available previous-period value', (await readout()) === `${longDate('2026-09-20')} (UTC) · current period not captured · Impressions — · Previous 28 days ${fmt(byDate['2026-08-23'].Impressions)}`, await readout());
await compareTo('Off');
check('The 7-day average needs seven consecutive captured days', (await valueRows('an-main')).filter((r) => r.trim().endsWith('—')).length >= 7);
await compareTo('Previous period');
check('A gap blocks the change and the notes say which two periods need to be complete', /No changes shown: comparing needs every day of 4 Sep – 1 Oct 2026 and of 7 Aug – 3 Sep 2026 captured and complete\./.test(await notes()), await notes());

// ---------- Mixed fields: one day each without visits, posts and unfollows ----------
await edit('fixture', 'all', ['2026-09-20'], { row: { metrics: byDate['2026-09-20'], capturedAt: capture.capturedAt, partial: false } });
await edit('fixture', 'all', ['2026-09-15'], { dropField: 'ProfileVisits' });
await edit('fixture', 'all', ['2026-09-16'], { dropField: 'CreateTweet' });
await edit('fixture', 'all', ['2026-09-17'], { dropField: 'Unfollows' });
await waitFor(() => /Follows or unfollows missing/.test(document.querySelector('main')?.textContent ?? ''));
check('Context still counts captured days (rows), while tiles count their own field', /28 of 28 days captured/.test(await context()) && /Captured subtotal · 27 of 28 days/i.test(await tileText('Profile visits')) && !/Captured subtotal/i.test(await tileText('Impressions')), await tileText('Profile visits'));
check('Net follows is a dash when either field is missing on a captured day, and cannot drive the chart', /—/i.test(await tileText('Net follows')) && /Follows or unfollows missing on 1 captured day/i.test(await tileText('Net follows')) && await page.getByRole('radio', { name: /Net follows/ }).isDisabled(), await tileText('Net follows'));
check('A figure shown as a dash draws no trend line', await tile('Net follows').locator('svg.xck-spark').count() === 0 && await tile('Impressions').locator('svg.xck-spark').count() === 1);
check('…and the Followers image cannot be made, with its reason', await page.locator('[data-key="share:followers"]').isDisabled() && /every captured day/.test(await page.locator('#share-why-followers').textContent()));
// The head's text without its Share image control (button and hidden reason), which every breakdown now carries.
const breakdownText = async (label) => (await page.locator(`.xck-breakdowns section[aria-label="${label}"] .xck-section-head`).evaluate((el) => { const share = el.querySelector('.xck-share-open'); return share ? el.innerText.replace(share.innerText, '') : el.innerText; })).replace(/\s+/g, ' ').trim();
check('Visits per 1K impressions says it covers 27 of 28 captured days', /over 27 of 28 captured days/.test(await breakdownText('Profile visits per 1K impressions')), await breakdownText('Profile visits per 1K impressions'));
check('Publishing qualifies the posts total, not the complete replies total', /posts · 27 of 28 captured days · [\d,]+ replies published$/.test(await breakdownText('Publishing')), await breakdownText('Publishing'));
check('Followers totals use the days with both fields and say so', /27 of 28 captured days/.test(await breakdownText('Followers')), await breakdownText('Followers'));
await page.getByRole('combobox', { name: 'Range' }).selectOption('90');
await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Week' }).click();
await tile('Profile visits').click();
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Profile visits per week');
const weekRow = async () => (await valueRows('an-main')).find((r) => r.startsWith('Week of 14 Sep 2026')) ?? '';
check('A complete week missing one visits field is partial for the visits chart', /^Week of 14 Sep 2026 \(partial\)/.test(await weekRow()), await weekRow());
await tile('Impressions').click();
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Impressions per week');
check('The same week is complete for impressions', /^Week of 14 Sep 2026\s/.test(await weekRow()) && !/partial/.test(await weekRow()), await weekRow());
check('Weekly totals stay bars: pale bodies with a line-blue outline', await page.locator('.xck-main-chart svg.chart').evaluate((svg) => { const r = [...svg.querySelectorAll('rect[rx]')]; return r.length >= 12 && r.every((x) => /fill:var\(--xck-an-fill\);stroke:var\(--xck-an-line\)/.test(x.getAttribute('style') ?? '')) && !svg.querySelector('polygon.area'); }));
check('Grouped publishing chart marks the week with an unreported posts day', (await valueRows('an-publish')).find((r) => r.startsWith('Week of 14 Sep 2026'))?.includes('(partial)'));
await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Day' }).click();
await page.getByRole('combobox', { name: 'Range' }).selectOption('28');
await focusChart(); await page.keyboard.press('End');
for (let i = 0; i < 16; i++) await page.keyboard.press('ArrowLeft');
check('Daily readout still names the impressions on the visits-less day', (await readout()).startsWith(`${longDate('2026-09-15')} (UTC) · Impressions`), await readout());

// ---------- Today in progress, and a stale in-progress capture ----------
await seed({ fixture: { all: 1 } });
await tile('Impressions').waitFor();
await page.getByRole('checkbox', { name: 'Show today (in progress)' }).check();
await waitFor(() => /5 Sep – 2 Oct 2026/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
const todayCover = await cover();
check('Coverage strip shows today as read while in progress, the settled days as captured', todayCover.days.length === 28 && todayCover.days.at(-1) === 'part' && todayCover.titles.at(-1) === '2 Oct 2026 (UTC) · read while in progress' && todayCover.days.slice(0, -1).every((d) => d === 'read'), JSON.stringify({ days: todayCover.days.join(','), title: todayCover.titles.at(-1) }));
const partialLook = () => page.locator('.xck-main-chart svg.chart').evaluate((svg) => ({ hollow: svg.querySelectorAll('circle.pt-partial').length, dashed: svg.querySelectorAll('polyline.partial-link').length, lastArea: Math.max(...[...svg.querySelectorAll('polygon.area')].flatMap((a) => a.getAttribute('points').trim().split(/\s+/).map((p) => +p.split(',')[0]))), partialX: +svg.querySelector('circle.pt-partial')?.getAttribute('cx') }));
const todayLook = await partialLook();
check('Opting in to today ends the range today and marks it in progress: a hollow point on a dashed link, outside the shading', todayLook.hollow === 1 && todayLook.dashed === 1 && todayLook.lastArea < todayLook.partialX && (await valueRows('an-main')).at(-1).startsWith(`${longDate('2026-10-02')} (partial)`), JSON.stringify(todayLook));
check('The readout still starts on the latest complete day', (await readout()).startsWith(longDate('2026-10-01')));
check('Today in the range blocks the comparison', !/vs /i.test(await tileText('Impressions')));
await page.getByRole('checkbox', { name: 'Show today (in progress)' }).uncheck();
await edit('fixture', 'all', ['2026-10-02'], { drop: true });
await edit('fixture', 'all', ['2026-10-01'], { partial: true });
await waitFor(() => /read while still in progress/.test(document.querySelector('#analytics-notes')?.textContent ?? ''));
check('A day read while in progress stays incomplete and is named by its date', /1 Oct was read while still in progress, so its total is incomplete until X Analytics is read again\./.test(await notes()) && !/Today/.test(await notes()), await notes());
check('It is marked in progress, not compared, and the readout says so', (await partialLook()).hollow === 1 && (await partialLook()).dashed === 1 && !/vs /i.test(await tileText('Impressions')) && (await readout()).startsWith(longDate('2026-09-30')));
await focusChart(); await page.keyboard.press('End');
check('Its readout calls it read while in progress', (await readout()).startsWith(`${longDate('2026-10-01')} (UTC, read while in progress)`), await readout());

// ---------- Ranges, grouping and an empty range ----------
await seed({ fixture: { all: 1 } });
await tile('Impressions').waitFor();
await page.getByRole('combobox', { name: 'Range' }).selectOption('7');
await waitFor(() => /25 Sep – 1 Oct 2026 · UTC · 7 of 7 days/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
check('7 days: grouping offers days only', await page.getByRole('group', { name: 'Group' }).count() === 0 && (await valueRows('an-main')).length === 7);
await page.getByRole('combobox', { name: 'Range' }).selectOption('365');
await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Month' }).click();
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Impressions per month');
const months = await valueRows('an-main');
check('365 days by month: every month keeps its place; uncaptured months are dashes', months.length === 13 && months[0].includes('—') && /\(partial\)/.test(months.find((r) => r.startsWith('Mar 2026')) ?? ''), months.slice(0, 3).join(' | '));
await page.getByRole('combobox', { name: 'Range' }).selectOption('all');
await waitFor(() => /17 Mar – 1 Oct 2026 · UTC · 199 of 199 days/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
const allCover = await cover();
check('Coverage strip keeps one mark per day on a long range, drawn narrower, inside the page', allCover.days.length === 199 && /\bdense\b/.test(allCover.dense) && await page.evaluate(() => document.querySelector('#analytics-coverage').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth), JSON.stringify({ n: allCover.days.length, cls: allCover.dense }));
check('All captured days spans first to last captured day, without comparisons', !/vs /i.test(await tileText('Impressions')));
check('All captured days: Compare with the previous period is disabled with its reason', await page.getByRole('group', { name: 'Compare' }).getByRole('button', { name: 'Previous period' }).isDisabled() && /no earlier period/.test(await page.locator('#compare-availability').innerText()));
await page.getByRole('combobox', { name: 'Range' }).selectOption('28');
await edit('fixture', 'all', days('2026-10-02', 12), { drop: true });
await page.getByRole('combobox', { name: 'Range' }).selectOption('7');
await page.getByText('No days captured between 25 Sep and 1 Oct 2026.').waitFor();
check('Empty range: tiles show dashes and offer two ways forward', /—/i.test(await tileText('Impressions')) && await page.getByRole('button', { name: 'Show all captured days' }).count() === 1);
check('Empty range: the main Share image is disabled with its reason', await page.locator('[data-key="share:main"]').isDisabled() && (await page.locator('[data-key="share:main"]').getAttribute('aria-describedby')) === 'share-why-main');
await page.getByRole('button', { name: 'Show all captured days' }).click();
await waitFor(() => /17 Mar – 20 Sep 2026/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
check('Show all captured days recovers the captured history', (await page.getByRole('combobox', { name: 'Range' }).inputValue()) === 'all');
await page.getByRole('combobox', { name: 'Range' }).selectOption('28');

// ---------- Audiences: separate series, honest absence, recovery ----------
await seed({ fixture: { all: 1 } });
await tile('Impressions').waitFor();
const allTiles = await page.locator('.xck-tiles').innerText();
check('Missing Verified series is disabled with its reason beside it', await page.getByRole('button', { name: 'Verified only', exact: true }).isDisabled() && /Verified only: not captured yet\. On X Analytics choose Verified only/.test(await page.locator('#verified-availability').innerText()));
await page.evaluate(async () => {
  const { 'xgd:v1': st } = await chrome.storage.local.get('xgd:v1');
  const all = st.accounts.fixture.daily.all;
  st.accounts.fixture.daily.verified = { ...all, rows: Object.fromEntries(Object.entries(all.rows).map(([d, r]) => [d, { ...r, metrics: { Impressions: 17 } }])) };
  await chrome.storage.local.set({ 'xgd:v1': st });
});
await page.getByRole('button', { name: 'Verified only', exact: true }).click();
await waitFor(() => /^Verified only/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
check('Verified uses its own series; absent fields stay dashes', /476/i.test(await tileText('Impressions')) && /—/i.test(await tileText('Profile visits')) && /Not in this capture/i.test(await tileText('Profile visits')) && (await page.locator('#main-chart-title').innerText()).startsWith('Verified viewers:'));
await page.getByRole('button', { name: 'All viewers', exact: true }).click();
await waitFor((t) => document.querySelector('.xck-tiles')?.innerText === t, allTiles);
check('Switching back restores All viewers exactly', true);
await page.getByRole('button', { name: 'Verified only', exact: true }).click();
await page.evaluate(async () => { const { 'xgd:v1': st } = await chrome.storage.local.get('xgd:v1'); delete st.accounts.fixture.daily.verified; await chrome.storage.local.set({ 'xgd:v1': st }); });
await page.getByRole('heading', { name: 'No Verified-only analytics captured yet' }).waitFor();
check('A removed Verified series never borrows All-viewers numbers and keeps the way back', await page.locator('.xck-tile').count() === 0 && await page.getByRole('button', { name: 'All viewers', exact: true }).isEnabled());
await page.getByRole('button', { name: 'All viewers', exact: true }).click();
await waitFor((t) => document.querySelector('.xck-tiles')?.innerText === t, allTiles);
check('Removed Verified series: All viewers recovers', true);

// ---------- Accounts: the list survives redraws ----------
await seed({ fixture: { all: 1 }, second: { all: 2 } });
await tile('Impressions').waitFor();
const account = page.getByRole('combobox', { name: 'Account' });
check('Both captured accounts are offered', JSON.stringify(await account.locator('option').allTextContents()) === JSON.stringify(['@fixture', '@second']));
await account.selectOption('second');
await waitFor((v) => document.querySelector('.xck-tile')?.textContent?.includes(v), fmt(imp28 * 2));
await page.getByRole('combobox', { name: 'Range' }).selectOption('90');
await tile('Profile visits').click();
await page.getByRole('combobox', { name: 'Range' }).selectOption('28');
check('After range and metric changes the account list is intact and still on @second', (await account.locator('option').count()) === 2 && (await account.inputValue()) === 'second');
await account.selectOption('fixture');
await waitFor((v) => document.querySelector('.xck-tile')?.textContent?.includes(v), fmt(imp28));
check('Switching back shows @fixture’s own numbers', (await tileText('Impressions')).includes(fmt(imp28)));

// ---------- All-zero capture and zero denominators ----------
await seed({ quiet: { all: 0 } });
await tile('Impressions').waitFor();
check('An all-zero capture is real coverage: zeros, not dashes or "not captured"', /^Impressions 0 /i.test(await tileText('Impressions')) && /28 of 28 days captured/.test(await context()) && !/Not in this capture/.test(await page.locator('.xck-tiles').innerText()), await tileText('Impressions'));
check('Zero impressions give no engagement rate or visit ratio', /^Engagement rate — /i.test(await tileText('Engagement rate')) && /—$/.test(await breakdownText('Profile visits per 1K impressions')), await tileText('Engagement rate'));
check('Net follows of zero activity reads ±0, not missing', /Net follows ±0/i.test(await tileText('Net follows')), await tileText('Net follows'));

// ---------- Explore ----------
await seed({ fixture: { all: 1 } });
await tile('Impressions').waitFor();
const exploreWasClosed = !(await page.locator('#an-explore').evaluate((d) => d.open));
await page.locator('#an-explore > summary').click();
check('Explore is disclosed: closed until opened, then its tabs show', exploreWasClosed && await page.getByRole('tab', { name: 'History' }).isVisible());
check('History tab: monthly history and running totals of captured days', await page.locator('#an-monthly-values').count() === 1 && /Totals of captured days only/.test(await page.locator('#explore-panel').innerText()));
check('28 complete days give every UTC weekday its four days, so weekday averages show', await page.locator('#an-weekday-values').count() === 1 && /describe past days only/.test(await page.locator('#explore-panel').innerText()));
await page.getByRole('combobox', { name: 'Range' }).selectOption('14');
await page.getByText('Appears when every weekday has at least 4 complete days in this range.').waitFor();
check('Fewer complete days: weekday averages wait instead of guessing', await page.locator('#an-weekday-values').count() === 0);
await page.getByRole('combobox', { name: 'Range' }).selectOption('28');
await page.getByRole('tab', { name: 'History' }).focus();
await page.keyboard.press('ArrowRight');
await waitFor(() => document.activeElement?.getAttribute('aria-selected') === 'true' && document.activeElement?.textContent === 'Any metric');
check('Tabs move with arrow keys and keep focus', await page.getByRole('tab', { name: 'Any metric' }).getAttribute('aria-selected') === 'true');
await page.getByRole('combobox', { name: 'Metric' }).selectOption('ProfileVisits');
await page.getByRole('group', { name: 'Chart type' }).getByRole('button', { name: 'Line' }).click();
check('Any metric charts a chosen field as a line', await page.locator('#explore-panel polyline').count() >= 1 && (await page.getByRole('tab', { name: 'Any metric' }).getAttribute('aria-selected')) === 'true');
await page.getByRole('tab', { name: 'Days to look at' }).click();
await page.getByRole('combobox', { name: 'Sort by' }).selectOption('NetFollows');
check('Days to look at: ten complete days with a plain limit', (await page.locator('#an-days tbody tr').count()) === 10 && /cannot tell which post drove a day/.test(await page.locator('#explore-panel').innerText()));
await page.getByRole('tab', { name: 'History' }).click();
for (const r of ['7', '90', '28']) await page.getByRole('combobox', { name: 'Range' }).selectOption(r);
check('Redraws release detached chart observers', await page.evaluate(() => [...window.activeChartTargets].every((t) => t.isConnected)));

// ---------- Narrow widths and reduced motion ----------
await edit('fixture', 'all', Object.keys(byDate), { metric: ['Impressions', 987654] });
await waitFor(() => /27,654,312/.test(document.querySelector('.xck-tiles')?.textContent ?? ''));
check('Small visits-per-1K values have distinct axis labels rather than repeated zeroes', await page.locator('section[aria-label="Profile visits per 1K impressions"] text.axis[text-anchor="end"]').evaluateAll(nodes => { const labels = nodes.map(n => n.textContent); return labels.length >= 5 && new Set(labels).size === labels.length && labels.some(t => /0\.00[1-9]/.test(t)); }));
for (const width of [1440, 768, 390, 320]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(200);
  const fit = await page.$$eval('.xck-tile .xck-figure', (vals) => vals.map((v) => ({ over: v.scrollWidth > v.parentElement.clientWidth + 1, size: parseFloat(getComputedStyle(v).fontSize) })));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const axis = await page.$$eval('svg.chart text.axis', (ts) => Math.min(...ts.filter((t) => t.getBoundingClientRect().height && t.checkVisibility()).map((t) => t.getBoundingClientRect().height)));
  check(`${width}px: long figures fit, no sideways scroll, axis text readable`, fit.every((f) => !f.over && f.size >= 20) && overflow <= 0 && axis >= 11, JSON.stringify({ fit, overflow, axis }));
  await page.screenshot({ path: `${shots}/an-${width}.png`, fullPage: true });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/an-${width}-top.png` });
}
await page.setViewportSize({ width: 390, height: 900 });
await page.locator('#an-mix > summary').click();
await page.waitForTimeout(250);
const mix = await page.locator('#an-mix svg.chart').evaluate((s) => ({ drawn: s.viewBox.baseVal.width, shown: Math.round(s.getBoundingClientRect().width) }));
check('A chart opened from a closed disclosure redraws at its real width', Math.abs(mix.drawn - mix.shown) <= 8, JSON.stringify(mix));
const mixContrast = () => page.locator('#an-mix svg.chart').evaluate(svg => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const luminance = paint => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = paint; ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => v / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  };
  return [...svg.querySelectorAll('rect[rx]')].filter(bar => +bar.getAttribute('height') > 0).map(bar => {
    const style = getComputedStyle(bar);
    // Pale bars need a readable boundary; narrow bars fall back to the solid series colour.
    return 1.05 / (luminance(style.stroke !== 'none' ? style.stroke : style.fill) + 0.05);
  });
});
const narrowMixContrast = await mixContrast();
check('390px: every visible interaction bar has a 3:1 solid fill or outline against the white card', narrowMixContrast.length > 0 && narrowMixContrast.every(r => r >= 3), JSON.stringify(narrowMixContrast));
await page.setViewportSize({ width: 1280, height: 1000 });
await page.waitForTimeout(200);
const wideMixContrast = await mixContrast();
check('1280px: pale interaction bars retain a 3:1 outline against the white card', wideMixContrast.length > 0 && wideMixContrast.every(r => r >= 3), JSON.stringify(wideMixContrast));
await page.emulateMedia({ reducedMotion: 'reduce' });
check('Reduced motion: controls do not animate', await page.evaluate(() => [...document.querySelectorAll('button, input, select')].every((el) => getComputedStyle(el).transitionDuration.split(',').every((d) => parseFloat(d) === 0))));
await page.emulateMedia({ reducedMotion: 'no-preference' });

// Independent series must retain known fields when a different field was not reported.
await seed({ fixture: { all: 1 } });
await edit('fixture', 'all', cur28, { row: { metrics: { Impressions: 1000, Engagements: 50, ProfileVisits: 10, Follows: 5, Unfollows: 2, CreateTweet: 4, Likes: 10, Replies: 2 }, capturedAt: capture.capturedAt, partial: false } });
await edit('fixture', 'all', ['2026-09-30'], { metric: ['Share', 1] });
await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Day' }).click();
const publishing = page.locator('.xck-breakdowns section[aria-label="Publishing"]');
await publishing.locator('.chart-box').focus();
await page.keyboard.press('End');
check('Publishing readout keeps captured posts and a dash for absent replies', /Posts published 4 · Replies published —/.test(await publishing.locator('.xck-readout').innerText()));
if (!(await page.locator('#an-mix').evaluate(el => el.open))) await page.locator('#an-mix > summary').click();
await page.locator('#an-mix .chart-box').focus();
await page.keyboard.press('End');
check('Interactions readout keeps likes/replies when shares are absent', /Likes 10 · Replies received 2 · Shares —/.test(await page.locator('#an-mix .xck-readout').innerText()));
await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Week' }).click();
await publishing.locator('.chart-box').focus();
await page.keyboard.press('Home');
await page.keyboard.press('ArrowRight');
const weeklyPublishing = await publishing.locator('.xck-readout').innerText();
check('Weekly independent fields name their own coverage and preserve known totals', /Posts published: 7 of 7 days; Replies published: 0 of 7 days/.test(weeklyPublishing) && /Posts published 28 · Replies published —/.test(weeklyPublishing), weeklyPublishing);
check('Incomplete independent-series weeks stay marked partial in exact values', (await valueRows('an-publish')).find(r => r.startsWith('Week of 7 Sep 2026'))?.includes('(partial)'));
await edit('fixture', 'all', ['2026-10-01'], { dropField: 'Impressions' });
await page.getByRole('tab', { name: 'History' }).click();
const runningChart = page.locator('.xck-chart-block').filter({ has: page.locator('#an-running-values') });
await runningChart.locator('.chart-box').focus();
await page.keyboard.press('End');
check('Running totals retain net follows when impressions were not reported', /Impressions so far — · Net follows so far \+84/.test(await runningChart.locator('.xck-readout').innerText()));

// ---------- Custom dates (UTC) ----------
await seed({ fixture: { all: 1 } });
await tile('Impressions').waitFor();
await page.getByRole('combobox', { name: 'Range' }).selectOption('custom');
await page.getByLabel('From (UTC)').waitFor();
check('Custom dates start from the range on screen and offer labelled UTC date fields', (await page.getByLabel('From (UTC)').inputValue()) === '2026-09-04' && (await page.getByLabel('To (UTC)').inputValue()) === '2026-10-01' && (await page.getByLabel('To (UTC)').getAttribute('max')) === TODAY);
await page.getByLabel('From (UTC)').fill('2026-09-10');
await page.getByLabel('To (UTC)').fill('2026-09-19');
await waitFor(() => /10 Sep – 19 Sep 2026 · UTC · 10 of 10 days captured/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
const cur10 = days('2026-09-19', 10), prev10 = days('2026-09-09', 10);
const ch10 = ((sum(cur10, 'Impressions') - sum(prev10, 'Impressions')) / sum(prev10, 'Impressions')) * 100;
check('Custom dates: totals and change against the 10 days just before', (await tileText('Impressions')).includes(fmt(sum(cur10, 'Impressions'))) && (await tileText('Impressions')).includes(`${ch10 >= 0 ? '+' : '−'}${Math.abs(ch10).toFixed(1)}% vs 31 Aug – 9 Sep 2026`), await tileText('Impressions'));
check('Custom dates keep keyboard focus on the date field after the redraw', await page.evaluate(() => document.activeElement?.dataset.key) === 'custom-to');
await page.getByLabel('From (UTC)').fill('2026-09-25');
await page.getByRole('alert').filter({ hasText: 'start date is after the end date' }).waitFor();
check('A start after the end is refused, named beside the fields, and the last valid range stays', (await page.getByLabel('From (UTC)').getAttribute('aria-invalid')) === 'true' && /10 Sep – 19 Sep 2026/.test(await context()));
await page.getByLabel('From (UTC)').fill('2026-09-10');
await waitFor(() => !document.querySelector('[aria-invalid]'));

// ---------- Share images ----------
const dlg = page.locator('dialog.xck-share');
const card = dlg.locator('.xck-sc');
const cardText = async () => (await card.innerText()).replace(/\s+/g, ' ');
/** PNG width and height from the IHDR chunk, and decoded pixel facts. */
const pngFacts = async (buf) => ({ sig: buf.subarray(1, 4).toString(), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ...(await page.evaluate(async (b64) => {
  const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let line = 0, shade = 0, cobalt = 0, ink = 0, opaque = true;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] !== 255) opaque = false;
    if (Math.abs(d[i] - 0x4a) < 12 && Math.abs(d[i + 1] - 0x6f) < 12 && Math.abs(d[i + 2] - 0xb5) < 12) line++;
    if (Math.abs(d[i] - 0x2b) < 12 && Math.abs(d[i + 1] - 0x55) < 12 && Math.abs(d[i + 2] - 0xe6) < 12) cobalt++;
    if (d[i + 2] - d[i] >= 10 && d[i] >= 200 && d[i + 2] >= 238) shade++; // pale blue shading under the line
    if (d[i] < 40 && d[i + 1] < 45 && d[i + 2] < 60) ink++;
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', d))].map((n) => n.toString(16).padStart(2, '0')).join('');
  return { line, shade, cobalt, ink, opaque, digest };
}, buf.toString('base64'))) });
const downloadPng = async () => { const ev = page.waitForEvent('download'); await dlg.getByRole('button', { name: 'Download PNG' }).click(); const d = await ev; const file = join(shots, `share-${d.suggestedFilename()}`); await d.saveAs(file); return { name: d.suggestedFilename(), buf: readFileSync(file) }; };
await page.getByRole('combobox', { name: 'Range' }).selectOption('28');
await waitFor(() => /4 Sep – 1 Oct 2026/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
await tile('Impressions').click();
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Impressions per day');
await page.getByRole('button', { name: 'Share image: Impressions' }).click();
await card.waitFor();
check('Share image opens a modal dialog named for its section, with focus inside', await dlg.evaluate((d) => d.open && d.matches(':modal')) && /Share image: Impressions/.test(await dlg.getByRole('heading').innerText()) && await dlg.evaluate((d) => d.contains(document.activeElement)));
const mainCard = await cardText();
check('The image states title, grouping, audience, UTC range, account, total, change, coverage and attribution',
  ['Impressions', 'Per day · All viewers · 4 Sep – 1 Oct 2026 · UTC', '@fixture', fmt(imp28), `${impChange >= 0 ? '+' : '−'}${Math.abs(impChange).toFixed(1)}% vs 7 Aug – 3 Sep 2026`, '28 of 28 days captured', 'Not the Rewards metric', 'X Creator Kit'].every((t) => mainCard.includes(t)), mainCard);
check('The image holds no controls and fits its 1200 × 675 frame', await card.evaluate((c) => !c.querySelector('button, input, select, a, details') && c.offsetWidth === 1200 && c.offsetHeight === 675 && [...c.querySelectorAll('*')].every((e) => { const r = e.getBoundingClientRect(), b = c.getBoundingClientRect(); return r.width === 0 || (r.right <= b.right + 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1); })));
check('The image chart draws the previous period beside the range', await card.locator('svg.chart polyline').count() >= 1 && /Previous 28 days/.test(mainCard));
const png1 = await downloadPng();
const f1 = await pngFacts(png1.buf);
check('Download PNG: named for account, section, UTC range and audience', png1.name === 'fixture-impressions-2026-09-04_2026-10-01-all-utc.png', png1.name);
check('Download PNG: a real 2400 × 1350 PNG, opaque, with a muted blue line over pale shading, ink type and no solid cobalt', f1.sig === 'PNG' && f1.w === 2400 && f1.h === 1350 && f1.opaque && f1.line > 8000 && f1.shade > 200000 && f1.cobalt === 0 && f1.ink > 5000, JSON.stringify({ ...f1, digest: undefined }));
check('The image shows no hover marker: only the page readout moves one', await card.locator('svg.chart circle.pt[visibility="visible"]').count() === 0 && await card.locator('svg.chart polygon.area').count() === 1);
const png1b = await downloadPng();
check('The same filters export the same pixels', (await pngFacts(png1b.buf)).digest === f1.digest);
const rebuild = await page.evaluate(() => {
  const box = document.querySelector('[data-key="share-handle"]');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  const disabled = [...document.querySelectorAll('.xck-share-buttons button')].every(b => b.disabled);
  const hidden = !document.querySelector('.xck-share-scale .xck-sc');
  document.querySelector('[data-key="share-copy"]').click();
  return { disabled, hidden, clips: window.clips.length };
});
check('Changing handle visibility clears the stale preview and disables export immediately', rebuild.disabled && rebuild.hidden && rebuild.clips === 0);
await waitFor(() => !document.querySelector('dialog.xck-share .xck-sc-handle'));
const pngHidden = await downloadPng();
check('Hiding the handle removes it from the picture and the file name, and changes the pixels', !/@fixture/.test(await cardText()) && pngHidden.name === 'analytics-impressions-2026-09-04_2026-10-01-all-utc.png' && (await pngFacts(pngHidden.buf)).digest !== f1.digest, pngHidden.name);
await dlg.getByRole('checkbox', { name: 'Show @handle' }).check();
await dlg.getByRole('button', { name: 'Copy image' }).click();
await dlg.locator('.xck-share-status').filter({ hasText: /copied|Could not copy/ }).waitFor();
const clips = await page.evaluate(() => window.clips);
check('Copy image hands one 2400 × 1350 PNG to the clipboard and says so', /Image copied/.test(await dlg.locator('.xck-share-status').innerText()) && clips.length === 1 && clips[0].type === 'image/png' && clips[0].w === 2400 && clips[0].h === 1350, JSON.stringify(clips));
await page.keyboard.press('Escape');
await waitFor(() => !document.querySelector('dialog.xck-share')?.open);
check('Escape closes the dialog and returns focus to its Share image button', await page.evaluate(() => document.activeElement?.dataset.key) === 'share:main');

// Filters reach the export: Week grouping, Engagement rate, then a gap and Verified only (27 captured days: 54 follows, 135 unfollows).
await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Week' }).click();
await tile('Engagement rate').click();
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Engagement rate per week');
await page.getByRole('button', { name: 'Share image: Engagement rate' }).click();
await card.waitFor();
const erCard = await cardText();
check('Engagement-rate image: weighted rate, change in points, and its denominator spelled out', erCard.includes('Per week · All viewers') && erCard.includes(`${(er(cur28) * 100).toFixed(2)}%`) && erCard.includes(`${Math.abs(erPts).toFixed(2)} pts vs 7 Aug – 3 Sep 2026`) && erCard.includes(`${fmt(sum(cur28, 'Engagements'))} engagements ÷ ${fmt(imp28)} impressions`), erCard);
const pngEr = await downloadPng();
check('Its file and pixels follow the filters', pngEr.name === 'fixture-engagement-rate-2026-09-04_2026-10-01-all-utc.png' && (await pngFacts(pngEr.buf)).digest !== f1.digest, pngEr.name);
await edit('fixture', 'all', ['2026-09-20'], { drop: true });
await waitFor(() => /27 of 28 days captured/.test(document.querySelector('dialog.xck-share .xck-sc')?.textContent ?? ''));
check('An open dialog follows new data: the gap is named as partial and the change is withdrawn', await card.locator('.xck-sc-coverage.partial').count() === 1 && !/ pts vs /.test(await cardText()), await cardText());
await page.keyboard.press('Escape');
await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Day' }).click();
await page.evaluate(async () => {
  const { 'xgd:v1': st } = await chrome.storage.local.get('xgd:v1');
  const all = st.accounts.fixture.daily.all;
  st.accounts.fixture.daily.verified = { ...all, rows: Object.fromEntries(Object.entries(all.rows).map(([d, r]) => [d, { ...r, metrics: { Impressions: 17, Follows: 2, Unfollows: 5 } }])) };
  await chrome.storage.local.set({ 'xgd:v1': st });
});
await page.getByRole('button', { name: 'Verified only', exact: true }).click();
await waitFor(() => /^Verified only/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
await tile('Net follows').click();
await waitFor(() => document.querySelector('#main-chart-title')?.textContent === 'Verified viewers: Follows and unfollows per day');
await page.getByRole('button', { name: 'Share image: Net follows' }).click();
await card.waitFor();
check('Net follows share axis labels zero exactly once', await card.locator('svg.chart text.axis').evaluateAll(nodes => nodes.filter(n => n.textContent === '0').length === 1));
const vCard = await cardText();
const pngV = await downloadPng();
check('Verified-only net-follows image: its own series, a negative total kept negative, red, not borrowed from All viewers', vCard.includes('Per day · Verified only') && vCard.includes('−81') && vCard.includes('54 follows · 135 unfollows') && await card.locator('.xck-sc-value.down').count() === 1 && pngV.name.endsWith('-verified-utc.png') && (await pngFacts(pngV.buf)).w === 2400, vCard);
check('Unfollows are drawn below zero in the image', await card.evaluate((c) => { const svg = c.querySelector('svg.chart'); const zero = [...svg.querySelectorAll('line.zero')].at(-1).getAttribute('y1'); return [...svg.querySelectorAll('rect[rx]')].some((r) => +r.getAttribute('y') >= +zero - 0.5 && +r.getAttribute('height') > 2); }));
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'All viewers', exact: true }).click();
await tile('Impressions').click();
await page.getByRole('button', { name: 'Share image: Interactions' }).click();
await card.waitFor();
const iCard = await cardText();
const likesPct = (30 / (30 + 10 + 2 + 1 + 0) * 100).toFixed(1);
check('Interactions image: each type with its share of listed interactions, the denominator defined', iCard.includes(`${likesPct}%`) && iCard.includes('each type ÷ all listed interactions') && iCard.includes('27 of 28 days captured'), iCard);
await page.keyboard.press('Escape');
for (const width of [1440, 768, 390, 320]) {
  await page.setViewportSize({ width, height: 900 });
  await page.getByRole('button', { name: 'Share image: Publishing' }).click();
  await card.waitFor();
  await page.waitForTimeout(150);
  const fit = await page.evaluate(() => { const d = document.querySelector('dialog.xck-share'); const r = d.getBoundingClientRect(); const f = d.querySelector('.xck-share-frame').getBoundingClientRect(); const b = [...d.querySelectorAll('.xck-share-buttons button')].map((x) => x.getBoundingClientRect()); return { inside: r.left >= 0 && r.right <= innerWidth, frame: f.width <= r.width, buttons: b.every((x) => x.right <= r.right && x.width > 0), overflow: document.documentElement.scrollWidth - innerWidth }; });
  check(`${width}px: the share dialog, its preview and its buttons fit the screen`, fit.inside && fit.frame && fit.buttons && fit.overflow <= 0, JSON.stringify(fit));
  await page.screenshot({ path: `${shots}/an-share-${width}.png` });
  await page.keyboard.press('Escape');
}
await page.setViewportSize({ width: 1280, height: 1000 });

// ---------- Storage that cannot be read ----------
// Independent-review regressions: comparison provenance and identical interaction bases.
await seed({ fixture: { all: 1 } });
await page.reload();
await tile('Impressions').waitFor();
await page.getByRole('combobox', { name: 'Range' }).selectOption('7');
await edit('fixture', 'all', ['2026-09-18'], { partial: true });
await waitFor(() => /complete value for every prior day/.test(document.querySelector('#analytics-metric-note')?.textContent ?? ''));
await page.getByRole('button', { name: 'Share image: Impressions' }).click();
await card.waitFor();
check('An in-progress prior day cannot appear as a settled previous-period line in the image', !/Previous 7 days/.test(await cardText()) && await card.locator('.xck-sc-change').count() === 0);
await page.keyboard.press('Escape');
await edit('fixture', 'all', ['2026-09-18'], { row: { metrics: byDate['2026-09-18'], capturedAt: capture.capturedAt, partial: false } });
await waitFor(() => /The thin grey line is the previous 7 days/.test(document.querySelector('#analytics-metric-note')?.textContent ?? ''));
await page.getByRole('button', { name: 'Share image: Impressions' }).click();
await card.waitFor();
check('Every exported comparison line names its prior dates and complete coverage', /Previous period: 18 Sep – 24 Sep 2026 · 7 of 7 days complete/.test(await cardText()));
await page.keyboard.press('Escape');
await edit('fixture', 'all', ['2026-10-01'], { drop: true });
await waitFor(() => /6 of 7 days captured/.test(document.querySelector('#analytics-source')?.textContent ?? ''));
await focusChart(); await page.keyboard.press('End');
check('Keyboard End retains a previous-series value beside a missing current day', (await readout()).includes(`current period not captured · Impressions — · Previous 7 days ${fmt(byDate['2026-09-24'].Impressions)}`));
await edit('fixture', 'all', days('2026-10-01', 7), { row: { metrics: { Impressions: 100, Likes: 6, Replies: 2, Bookmark: 1 }, capturedAt: capture.capturedAt, partial: false } });
await edit('fixture', 'all', ['2026-09-25'], { row: { metrics: { Impressions: 100, Likes: 1000, Replies: 2 }, capturedAt: capture.capturedAt, partial: false } });
await waitFor(() => /54 in all/.test(document.querySelector('section[aria-label="Interactions"]')?.textContent ?? ''));
const interactionCounts = await page.locator('#an-interactions .xck-num').allTextContents();
check('Partial Interactions list uses the same six days for its counts, percentages and total', interactionCounts.join(',') === '36,12,6' && /6 of 7 captured days/.test(await breakdownText('Interactions')));
await page.getByRole('button', { name: 'Share image: Interactions' }).click();
await card.waitFor();
check('Partial Interactions export matches every displayed count and names its coverage', (await card.locator('.xck-sc-bars .n').allTextContents()).join(',') === interactionCounts.join(',') && /Every type reported on 6 of them/.test(await cardText()));
await downloadPng();
await page.keyboard.press('Escape');

const broken = await ctx.newPage();
broken.on('pageerror', (e) => errors.push(String(e)));
await broken.addInitScript(() => { chrome.storage.local.get = () => Promise.reject(new Error('synthetic read failure')); });
await broken.goto(`${base}/analytics.html`);
await broken.getByRole('heading', { name: 'Could not read your saved analytics' }).waitFor();
check('Unreadable storage: says so, changes nothing, offers Try again, not busy', /Nothing was changed or deleted/.test(await broken.locator('main').innerText()) && await broken.getByRole('button', { name: 'Try again' }).count() === 1 && await broken.locator('main').getAttribute('aria-busy') !== 'true');
await broken.close();

check('No page errors', errors.length === 0, errors.join('\n'));
check('No web requests', requests.length === 0, requests.join(', '));
console.log(`${checks}/${checks} analytics checks passed. Screenshots in ${shots}/`);
await ctx.close();
