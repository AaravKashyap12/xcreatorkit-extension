import { capture as syntheticCapture } from './fixtures/analytics.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('verification', { recursive: true });
// Share-card scenarios in the BUILT extension (throwaway Chromium, pinned clock):
// the Day 33 overlap bug, header follower count, Yesterday · final, portrait 4:5, dark theme,
// and feed-width previews. Uses deterministic synthetic data.
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath(), ...(local ? ['chromium-1243', 'chromium-1234'].map((v) => join(local, v, 'chrome-win64', 'chrome.exe')) : [])].find((p) => p && existsSync(p));
const cap = syntheticCapture;
const utc = (t) => new Date(t).toISOString().slice(0, 10);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

function seed({ points, capturedAt, rewards, followersExact = '1,030' }) {
  const capDay = utc(Date.parse(capturedAt));
  const rows = {};
  for (const p of points) {
    const date = utc(p.t);
    rows[date] = { date, metrics: p.m, capturedAt, partial: date >= capDay };
  }
  const o = (id, metric, displayText, value, precision, at, label, extra = {}) => ({
    id, account: 'byaarav', accountSource: 'page', metric, displayText, value, precision, roundingHalfStep: precision === 'rounded' ? 50 : 0, provenance: 'captured',
    sourceUrl: null, sourceLabel: label, capturedAt: at, lastSeenAt: at, reportingTimeZone: 'UTC', reportingDate: utc(Date.parse(at)), periodStart: null, periodEnd: null,
    windowType: metric === 'rewards_vht_90d' ? 'rolling_90d' : 'unknown', verifiedOnly: metric === 'rewards_vht_90d' ? true : null, excludesReplies: metric === 'rewards_vht_90d' ? true : null, ...extra,
  });
  const observations = [
    ...rewards.map(([text, value, at], i) => o(`r${i}`, 'rewards_vht_90d', text, value, 'rounded', at, 'X Creator Studio')),
    o('fv', 'followers_verified', '745', 745, 'exact', capturedAt, 'X Analytics'),
    o('ft', 'followers_total', '1K', 1000, 'rounded', capturedAt, 'X Analytics'),
    ...(followersExact ? [o('fp', 'followers_total', followersExact, Number(followersExact.replace(/,/g, '')), 'exact', capturedAt, 'X profile')] : []),
  ];
  return {
    schemaVersion: 1,
    settings: { expectedHandle: 'byaarav', reportingTimeZone: 'UTC', cycleCutoffHour: 0, dayAnchor: { date: '2026-09-30', day: 30 }, dayOverrides: { '2026-10-01': 31 }, rewardsTarget: 500000, staleAfterHours: 24, utcOnly: true },
    accounts: { byaarav: { observations, attempts: [], daily: { all: { rows, lastCaptureAt: capturedAt, lastRange: cap.range, source: 'x_web_account_analytics' } } } },
  };
}

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xgd-share-')), {
  executablePath, headless: true, acceptDownloads: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1500, height: 1500 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const open = async (now, state, prefs) => {
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`chrome-extension://${sw.url().split('/')[2]}/report.html`);
  await page.evaluate(async ([s, p]) => {
    for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v);
    await chrome.storage.session.remove('xgd:run');
    await chrome.storage.local.set({ 'xgd:v1': s });
  }, [state, prefs]);
  await page.reload();
  await page.waitForSelector('#stage .r-handle');
  await page.waitForTimeout(400);
};
const overflow = () => page.evaluate(() => {
  const st = document.getElementById('stage').getBoundingClientRect();
  const bad = [];
  for (const c of document.querySelectorAll('#stage .card, #stage .r-head, #stage .r-head > *, #stage .r-foot')) {
    const b = c.getBoundingClientRect();
    if (c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1) bad.push(`${c.className}: content overflow (${c.scrollWidth}x${c.scrollHeight} in ${c.clientWidth}x${c.clientHeight})`);
    if (b.left < st.left - 1 || b.right > st.right + 1 || b.top < st.top - 1 || b.bottom > st.bottom + 1) bad.push(`${c.className}: outside artboard`);
  }
  for (const sp of document.querySelectorAll('#stage .tile-label span')) if (sp.scrollWidth > sp.clientWidth + 1) bad.push(`label truncated: ${sp.textContent}`);
  return bad;
});
const exportAs = async (file) => {
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG' }).click();
  await (await dl).saveAs(file);
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), kb: Math.round(b.length / 1024) };
};
const preview = async (src, w, out) => {
  const data = await page.evaluate(async ([b64, w]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round(img.height * w / img.width);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }, [readFileSync(src).toString('base64'), w]);
  writeFileSync(out, Buffer.from(data, 'base64'));
};

// ---- Scenario 1: the Day 33 card (3 Oct 07:31 UTC, zero follows so far, two rewards readings)
const day33Cap = '2026-10-03T07:31:00.000Z';
const day33Points = [...cap.points.filter((p) => utc(p.t) <= '2026-10-02').map((p) => (utc(p.t) === '2026-10-02' ? { ...p, m: { ...p.m } } : p)),
  { t: Date.parse('2026-10-03T00:00:00Z'), m: { Impressions: 1277, Engagements: 16, ProfileVisits: 4, Likes: 8, Replies: 4, Retweets: 0, Bookmark: 0, Share: 0, Follows: 0, Unfollows: 0, CreateTweet: 1, CreateReply: 6 } }];
const day33 = seed({ points: day33Points, capturedAt: day33Cap, rewards: [['109.2K', 109200, '2026-10-02T18:49:00.000Z'], ['109.7K', 109700, day33Cap]] });
await open('2026-10-03T07:40:00Z', day33, { 'xgd:report:range': 'today', 'xgd:report:format': 'landscape', 'xgd:report:theme': 'light' });
check('Day 33: no overlap/overflow anywhere (follower card fixed)', (await overflow()).length === 0, (await overflow()).join(', '));
check('Day 33: zero follows render as a ±0 stat, not an empty chart', (await page.textContent('#stage .fw-zero b')) === '±0' && (await page.locator('#stage .fw svg').count()) === 0);
const delta = page.locator('#stage .rw-delta');
const dBox = await delta.boundingBox();
check('Day 33: rewards change is one line: "≈+500 since 2 Oct"', /^≈\+500 since 2 Oct$/.test((await delta.textContent()).trim()) && dBox.height < 30, `${(await delta.textContent()).trim()} (h=${Math.round(dBox.height)})`);
check('Header: exact follower count from profile (1,030), not "1K"', (await page.textContent('#stage .r-followers b')) === '1,030' && (await page.textContent('#stage .r-followers span')) === 'followers', await page.textContent('#stage .r-followers'));
check('Header: Day 33 badge', (await page.textContent('#stage .r-day')).replace(/\s+/g, '') === 'Day33');
check('Single-day landscape: visits per 1K inline in the Profile visits tile (no extra panel)', (await page.locator('#stage .tile').count()) === 4 && /^\d+(\.\d)? per 1K impr\.$/.test(await page.textContent('#stage .tile-aside')) && (await page.locator('#stage .ef').count()) === 0, await page.textContent('#stage .tile-aside'));
check('Footer: no "follower total rounded" note when the exact count is known', !/Follower total rounded/.test(await page.textContent('#stage .r-foot')));
const l33 = await exportAs('verification/share-day33-landscape.png');
check('Landscape export 2400×1500 PNG', l33.w === 2400 && l33.h === 1500, JSON.stringify(l33));

// ---- Scenario 2: Yesterday · final (pinned to 3 Oct, so yesterday = 2 Oct, a complete day)
const day2Final = seed({
  points: cap.points.map((p) => p),
  capturedAt: '2026-10-03T00:20:00.000Z', // captured after 2 Oct ended → 2 Oct row is complete
  rewards: [['109.2K', 109200, '2026-10-02T18:49:00.000Z'], ['109.7K', 109700, '2026-10-03T00:20:00.000Z']],
});
await open('2026-10-03T07:40:00Z', day2Final, { 'xgd:report:range': 'yesterday', 'xgd:report:format': 'landscape', 'xgd:report:theme': 'light' });
const yLine = (await page.textContent('#stage .r-line')).trim();
check('Yesterday: header "2 Oct · Yesterday · Final"', yLine === '2 Oct · Yesterday · Final', yLine);
check('Yesterday: Day N follows the reported day (Day 32)', (await page.textContent('#stage .r-day')).replace(/\s+/g, '') === 'Day32');
const y2 = cap.points.find((p) => utc(p.t) === '2026-10-02').m.Impressions;
const y1 = cap.points.find((p) => utc(p.t) === '2026-10-01').m.Impressions;
const r = y2 / y1;
const expChip = r >= 2 ? `▲ ${r.toFixed(1)}×` : `${r >= 1 ? '▲' : '▼'} ${Math.abs((r - 1) * 100).toFixed(0)}%`;
const impTile = page.locator('#stage .tile', { hasText: 'Impressions' });
check(`Yesterday: day-over-day change on Impressions (${y2} vs ${y1} → ${expChip})`, (await impTile.locator('.tile-delta').textContent()) === expChip && (await impTile.locator('.tile-prev').textContent()) === 'vs day before', await impTile.locator('.tile-delta').textContent());
check('Yesterday: chart labelled "7-day context · yesterday highlighted"', (await page.textContent('#stage .tr-meta')) === '7-day context · yesterday highlighted');
check('Yesterday: no overflow', (await overflow()).length === 0, (await overflow()).join(', '));
await exportAs('verification/share-yesterday-landscape.png');

// ---- Scenario 3: portrait 4:5 (today and 7D) + dark theme
for (const [rk, theme, file] of [['today', 'light', 'share-day33-portrait'], ['7d', 'light', 'share-7d-portrait'], ['today', 'dark', 'share-day33-portrait-dark'], ['today', 'dark', 'share-day33-landscape-dark']]) {
  const fmt = file.includes('landscape') ? 'landscape' : 'portrait';
  await open('2026-10-03T07:40:00Z', rk === '7d' ? day2Final : day33, { 'xgd:report:range': rk, 'xgd:report:format': fmt, 'xgd:report:theme': theme });
  const ov = await overflow();
  check(`${file}: no overflow`, ov.length === 0, ov.join(', '));
  const info = await exportAs(`verification/${file}.png`);
  check(`${file}: ${fmt === 'portrait' ? '2160×2700' : '2400×1500'} PNG`, fmt === 'portrait' ? info.w === 2160 && info.h === 2700 : info.w === 2400 && info.h === 1500, JSON.stringify(info));
  if (theme === 'dark') check(`${file}: dark stage background`, await page.evaluate(() => getComputedStyle(document.getElementById('stage')).backgroundColor === 'rgb(18, 20, 19)'));
}

// ---- Feed previews (desktop ~600px wide; mobile ~360px wide)
for (const f of ['share-day33-landscape', 'share-day33-portrait', 'share-7d-portrait', 'share-day33-landscape-dark', 'share-yesterday-landscape']) {
  await preview(`verification/${f}.png`, 600, `verification/feed-600-${f}.png`);
  await preview(`verification/${f}.png`, 360, `verification/feed-360-${f}.png`);
}

check('No console errors', errors.length === 0, errors.join(' | '));
await ctx.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
