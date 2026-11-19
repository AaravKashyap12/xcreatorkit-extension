import { capture as syntheticCapture } from './fixtures/analytics.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('verification', { recursive: true });
// Verifies Today / 7D / 30D / 90D against captured source data, plus the
// "today missing" and "analytics not refreshed" scenarios, in the BUILT extension
// (throwaway Chromium profile). Synthetic expected values are recomputed independently of src/.
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath(), ...(local ? ['chromium-1243', 'chromium-1234'].map((v) => join(local, v, 'chrome-win64', 'chrome.exe')) : [])].find((p) => p && existsSync(p));
const cap = syntheticCapture;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const utc = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (ymd, n) => utc(Date.parse(ymd + 'T00:00:00Z') + n * 864e5);
const compact = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(Math.abs(v) >= 1e7 ? 0 : 1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(Math.abs(v) >= 1e5 ? 0 : 1)}K` : Math.round(v).toLocaleString('en-US'));
const tileFmt = (v) => (v >= 10_000 ? compact(v) : v.toLocaleString('en-US'));

// Pin the clock so results don't depend on when the suite runs (fixture captured 2 Oct 18:08 UTC).
const FIXED_NOW = new Date(process.env.XGD_NOW ?? '2026-10-02T18:49:00Z');
const today = utc(FIXED_NOW.getTime());
const byDate = new Map(cap.points.map((p) => [utc(p.t), p.m]));
const capturedToday = utc(Date.parse(cap.capturedAt)) === today;
console.log(`now (UTC day) = ${today}; capture = ${cap.capturedAt}; today's row ${byDate.has(today) ? 'present' : 'absent'}`);

function seed(points, capturedAt, intraday = undefined) {
  const capDay = utc(Date.parse(capturedAt));
  const rows = {};
  for (const p of points) {
    const date = utc(p.t);
    rows[date] = { date, metrics: p.m, capturedAt, partial: date >= capDay };
  }
  const base = { account: 'byaarav', accountSource: 'page', provenance: 'captured', reportingTimeZone: 'UTC', reportingDate: capDay, periodStart: null, periodEnd: null, lastSeenAt: capturedAt, capturedAt };
  return {
    schemaVersion: 1,
    settings: { expectedHandle: 'byaarav', reportingTimeZone: 'UTC', cycleCutoffHour: 0, utcOnly: true, dayAnchor: { date: '2026-09-30', day: 30 }, dayOverrides: { '2026-10-01': 31 }, rewardsTarget: 500000, staleAfterHours: 24 },
    accounts: {
      byaarav: {
        observations: [
          { ...base, id: 'r1', metric: 'rewards_vht_90d', displayText: '109.2K', value: 109200, precision: 'rounded', roundingHalfStep: 50, sourceUrl: 'https://x.com/i/jf/creators/original_content_rewards', sourceLabel: 'X Creator Studio', windowType: 'rolling_90d', verifiedOnly: true, excludesReplies: true },
          { ...base, id: 'f1', metric: 'followers_verified', displayText: '748', value: 748, precision: 'exact', roundingHalfStep: 0, sourceUrl: null, sourceLabel: 'X Analytics', windowType: 'unknown', verifiedOnly: null, excludesReplies: null },
          { ...base, id: 'f2', metric: 'followers_total', displayText: '1K', value: 1000, precision: 'rounded', roundingHalfStep: 500, sourceUrl: null, sourceLabel: 'X Analytics', windowType: 'unknown', verifiedOnly: null, excludesReplies: null },
        ],
        attempts: [],
        daily: { all: { rows, lastCaptureAt: capturedAt, lastRange: cap.range, source: 'x_web_account_analytics' } },
        ...(intraday ? { intraday } : {}),
      },
    },
  };
}

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xgd-rng-')), {
  executablePath, headless: true, acceptDownloads: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1440, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.clock.setFixedTime(FIXED_NOW);
await page.goto(`chrome-extension://${id}/report.html`);
await page.waitForSelector('#stage');

const setState = (st) => page.evaluate(async (s) => chrome.storage.local.set({ 'xgd:v1': s }), st);
const setRun = (r) => page.evaluate(async (v) => (v ? chrome.storage.session.set({ 'xgd:run': v }) : chrome.storage.session.remove('xgd:run')), r);
const pick = async (label) => {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(350);
};
const exportAs = async (file) => {
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG' }).click();
  await (await dl).saveAs(file);
};
const tileVal = (label) => page.locator('.tile', { hasText: label }).locator('.tile-val').evaluate((e) => e.firstChild.textContent);

// ---------- Scenario A: real capture with today's in-progress row ----------
await setState(seed(cap.points, cap.capturedAt));
await setRun(null);
await page.waitForFunction(() => document.querySelector('.rw-hero')?.textContent === '109.2K');

for (const [label, days] of [['Today (1D)', 1], ['7D', 7], ['30D', 30], ['90D', 90]]) {
  await pick(label);
  const start = addDays(today, -(days - 1));
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const rows = dates.map((d) => byDate.get(d)).filter(Boolean);
  const imp = rows.reduce((s, m) => s + (m.Impressions ?? 0), 0);
  const visits = rows.reduce((s, m) => s + (m.ProfileVisits ?? 0), 0);
  const netF = rows.reduce((s, m) => s + (m.Follows ?? 0) - (m.Unfollows ?? 0), 0);
  const sub = await page.textContent('#stage .r-line');
  const chip = (await page.textContent('#stage .r-line')).trim();
  check(`${label}: dates ${start} → ${today} (UTC)`, sub.includes('UTC') && sub.includes(days === 1 ? ' · Today · ' : ` · ${label} · `), sub);
  check(`${label}: one compact reporting line with period + capture time`, capturedToday ? new RegExp(days === 1 ? `^${today.slice(8).replace(/^0/, '')} Oct · Today · ${cap.capturedAt.slice(11, 16)} UTC · In progress$` : `^.+ · ${label} · ${cap.capturedAt.slice(11, 16)} UTC · Today in progress$`).test(chip) : /unavailable/.test(chip), chip);
  check(`${label}: impressions tile = sum of captured days incl. today (${imp})`, (await tileVal('Impressions')) === tileFmt(imp), await tileVal('Impressions'));
  check(`${label}: profile visits tile (${visits})`, (await tileVal('Profile visits')) === tileFmt(visits));
  // Single day: the waterfall's net bar. Ranges (landscape): follows and unfollows ride on the momentum sub-line.
  const netText = `${netF > 0 ? '+' : netF < 0 ? '−' : ''}${Math.abs(netF).toLocaleString('en-US')}`;
  if (days === 1) {
    const wfNet = await page.locator('.fw svg text.lbl').nth(2).textContent().catch(() => null);
    check(`${label}: waterfall net = Σ(follows − unfollows) (${netF})`, wfNet === netText, String(wfNet));
  } else {
    const sub = await page.textContent('.mo .ef-sub');
    check(`${label}: momentum sub-line carries follows and unfollows (net ${netF})`, /[+−]\d[\d,]* follows · [+−]\d[\d,]* unfollows/.test(sub), sub);
  }
  const bars = await page.locator('.tr svg rect').count();
  if (days > 1) check(`${label}: one bar per captured day (${rows.length})`, bars === rows.length, `bars=${bars}`);
  const todayBar = await page.locator('.tr svg rect title').last().textContent();
  if (days > 1) check(`${label}: today's bar is marked in progress`, /in progress/.test(todayBar), todayBar);
  if (days === 1) {
    const t = byDate.get(today);
    check('Today: no comparison badges', (await page.locator('#stage .tile-delta').count()) === 0);
    check('Today: no repeated "so far" text on the artboard', !/so far/i.test(await page.textContent('#stage')));
    check('Today: no placeholders on the artboard', (await page.locator('#stage .empty').count()) === 0);
    check('Today: no follower momentum panel', (await page.locator('#stage .mo').count()) === 0);
    const eb = await page.$$eval('#stage .cv .eb-row', (rows) => rows.map((r) => r.querySelector('.eb-label').textContent + '=' + r.querySelector('.eb-val').textContent));
    check('Today: Conversation activity = Likes and Replies with captured counts', eb.join(',') === `Likes=${t.Likes},Replies received=${t.Replies},Replies you wrote=${t.CreateReply}`, eb.join(', '));
    const rp = ((t.Replies / t.Impressions) * 1000).toFixed(1);
    check(`Today: replies per 1K impressions = ${rp} (same period)`, (await page.textContent('#stage .cv-metric b')) === rp && /replies received per 1K impressions/.test(await page.textContent('#stage .cv-metric')));
    check('Today: reposts/bookmarks not on the artboard, but in the private view', !/Reposts|Bookmarks/.test(await page.textContent('#stage')) && new RegExp(`Reposts ${t.Retweets} · Bookmarks ${t.Bookmark}`).test(await page.textContent('.xck-private')));
    check('Today: Engagements tile keeps the full source total', (await tileVal('Engagements')) === t.Engagements.toLocaleString('en-US'));
    const gap = await page.evaluate(() => {
      const c = document.querySelector('#stage .cv');
      const kids = [...c.children].map((k) => k.getBoundingClientRect());
      const box = c.getBoundingClientRect();
      const scale = box.width / c.offsetWidth;
      // Largest vertical gap between consecutive blocks (title → bars → metric).
      let worst = 0;
      for (let i = 1; i < kids.length; i++) worst = Math.max(worst, kids[i].top - kids[i - 1].bottom);
      return Math.round(worst / scale);
    });
    check('Today: conversation card is compact (no large internal gaps)', gap <= 60, `largest gap ≈ ${gap}px`);
    const per1k = ((t.ProfileVisits / t.Impressions) * 1000).toFixed(1);
    check(`Today: reach efficiency shown once, inline in Profile visits (${per1k} per 1K), no extra panel, no net-follow repeat`, (await page.textContent('#stage .tile-aside')) === `${per1k} per 1K impr.` && (await page.locator('#stage .ef').count()) === 0);
    check('Today: chart labelled "7-day context · today highlighted"', (await page.textContent('#stage .tr-meta')) === '7-day context · today highlighted');
    check('Today: received vs written replies shown as separate groups', /On your posts.*Replies received.*By you.*Replies you wrote/s.test(await page.textContent('#stage .cv')));
    check('Today: detailed source timestamps in the private view, not the artboard', /captured \d+ \w+, \d\d:\d\d UTC/.test(await page.locator('.xck-private', { hasText: 'Sources (private)' }).textContent()));
    check('Today: diagnostics live in the private controls, not the artboard', /hourly/.test(await page.textContent('.xck-diag')) && !/hourly/i.test(await page.textContent('#stage')));
  } else {
    const k = days - 1;
    const pStart = addDays(start, -k);
    const basisCur = Array.from({ length: k }, (_, i) => byDate.get(addDays(start, i))?.Impressions ?? NaN).reduce((a, b) => a + b, 0);
    const basisPrev = Array.from({ length: k }, (_, i) => byDate.get(addDays(pStart, i))?.Impressions ?? NaN).reduce((a, b) => a + b, 0);
    const r = basisCur / basisPrev;
    const expectChip = r >= 2 ? `▲ ${r.toFixed(1)}×` : `${r >= 1 ? '▲' : '▼'} ${Math.abs((r - 1) * 100).toFixed(0)}%`;
    const chipText = await page.locator('.tile', { hasText: 'Impressions' }).locator('.tile-delta').textContent();
    check(`${label}: change = ${k} full days vs prior ${k} (excl. today) → ${expectChip}`, chipText === expectChip && (await page.locator('.tile', { hasText: 'Impressions' }).locator('.tile-prev').textContent()) === `${k} full days vs prior ${k}`, chipText);
    const endLbl = await page.locator('.mo .end-val').textContent();
    check(`${label}: momentum ends at net ${netF} (incl. today so far)`, endLbl === `${netF > 0 ? '+' : netF < 0 ? '−' : ''}${Math.abs(netF).toLocaleString('en-US')}`, endLbl);
  }
  // Today label: present, names today's value, and its box intersects no bar and no other label.
  const lab = await page.evaluate(() => {
    const svgEl = document.querySelector('.tr svg');
    const texts = [...svgEl.querySelectorAll('text.lbl, text.lbl-soft')];
    const todayT = texts.find((t) => /so far/.test(t.textContent)) ?? (texts.length === 1 ? texts[0] : null);
    if (!todayT) return { found: false };
    const b = todayT.getBBox();
    const hit = (r) => !(r.x + r.width <= b.x || r.x >= b.x + b.width || r.y + r.height <= b.y || r.y >= b.y + b.height);
    const bars = [...svgEl.querySelectorAll('rect')].filter((r) => hit(r.getBBox())).length;
    const others = texts.filter((t) => t !== todayT).filter((t) => hit(t.getBBox())).length;
    return { found: true, text: todayT.textContent, bars, others };
  });
  const todayImp = byDate.get(today)?.Impressions;
  if (days > 1) check(`${label}: today's label on the latest bar, no overlaps`, lab.found && (days === 1 ? lab.text === todayImp.toLocaleString('en-US') : lab.text === `Today so far · ${compact(todayImp)}`) && lab.bars === 0 && lab.others === 0, JSON.stringify(lab));
  if (days > 1) check(`${label}: multi-day keeps follower momentum`, (await page.locator('#stage .mo').count()) === 1);
  check(`${label}: UTC only (no local clock times on the artboard)`, !/GMT[+-]|IST/.test(await page.textContent('#stage')));
  check(`${label}: Day N badge present`, /^Day\s*\d+$/.test((await page.textContent('#stage .r-day')).trim()));
  // Ledger design: KPI labels are plain sentence-case text, no icon tiles.
  check(`${label}: KPI labels carry no icons or uppercase eyebrows`, (await page.locator('#stage .tile-label svg').count()) === 0 && (await page.$$eval('#stage .tile-label', (els) => els.every((e) => getComputedStyle(e).textTransform === 'none'))));
  const foot = await page.textContent('#stage .r-foot');
  check(`${label}: compact source footer`, foot.startsWith('Sources: X Analytics (UTC); Creator Studio Rewards (rolling 90 days, replies excluded). Rewards rounded by X.') && foot.length < 260, `${foot.length} chars`);
  check(`${label}: rewards unchanged by range`, (await page.textContent('.rw-hero')) === '109.2K');
  const overflow = await page.evaluate(() => [...document.querySelectorAll('#stage .card')].filter((c) => c.scrollHeight > c.clientHeight + 1).map((c) => `${c.className}:+${c.scrollHeight - c.clientHeight}px`));
  const outside = await page.evaluate(() => { const st = document.getElementById('stage').getBoundingClientRect(); return [...document.querySelectorAll('#stage .card, #stage .r-head > *, #stage .r-foot')].filter((c) => { const b = c.getBoundingClientRect(); return b.left < st.left - 1 || b.right > st.right + 1 || b.top < st.top - 1 || b.bottom > st.bottom + 1; }).map((c) => c.className); });
  check(`${label}: every card inside the artboard`, outside.length === 0, outside.join(', '));
  check(`${label}: no overflowing cards`, overflow.length === 0, overflow.join(', '));
  await exportAs(`verification/range-${days === 1 ? 'today' : days + 'd'}.png`);
}

// ---------- Scenario B: today's data missing (last capture yesterday) ----------
const yCap = `${addDays(today, -1)}T22:00:00.000Z`;
await setState(seed(cap.points.filter((p) => utc(p.t) < today), yCap));
await page.waitForTimeout(300);
await pick('Today (1D)');
check('Missing today: reporting line says unavailable; footer keeps the stale capture time', /Today's data unavailable/.test(await page.textContent('#stage .r-line.stale')) && /Analytics last captured .* UTC/.test(await page.textContent('#stage .r-foot')), await page.textContent('#stage .r-line'));
check('Missing today: tiles show — (no invented zero)', (await tileVal('Impressions')) === '—');
check('Missing today: stated once (header line), chart shows a dash, not a zero bar', /Today's data unavailable/.test(await page.textContent('#stage .r-line')) && (await page.textContent('#stage .tr .empty')) === '—' && (await page.locator('#stage .tr svg rect').count()) === 0);
await exportAs('verification/range-today-missing.png');
await pick('7D');
const bars7 = await page.locator('.tr svg rect').count();
check('Missing today (7D): 6 bars, no bar for today', bars7 === 6, `bars=${bars7}`);
check('Missing today (7D): no "No comparison" badges or placeholders', !/No comparison/.test(await page.textContent('#stage')) && (await page.locator('#stage .empty').count()) === 0);
check('Missing today (7D): header line says today not captured', /Today not captured/.test(await page.textContent('#stage .r-line')));
check('Missing today (7D): momentum does not claim to include today', !/incl\. today/.test(await page.textContent('.mo')) && /captured mid-day/.test(await page.textContent('.mo')), await page.textContent('.mo .ef-sub'));
check('Missing today (7D): partial 1 Oct bar explained in legend', /Partial day \(captured before it ended\)/.test(await page.textContent('.tr-legend')));
await exportAs('verification/range-7d-today-missing.png');

// ---------- Scenario D: Today in context (last 7 UTC days, today highlighted) ----------
{
  await setState(seed(cap.points, cap.capturedAt));
  await setRun(null);
  await page.waitForTimeout(350);
  await pick('Today (1D)');
  const dates14 = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const expected = dates14.filter((d) => byDate.has(d)).length;
  const bars = await page.$$eval('#stage .tr svg rect', (rs) => rs.map((r) => ({ fill: r.getAttribute('class'), t: r.querySelector('title')?.textContent })));
  check(`Context: one bar per captured day of the last 7 (${expected})`, bars.length === expected, `bars=${bars.length}`);
  check('Context: exactly one highlighted bar, and it is today', bars.filter((b) => b.fill === 'bar focus').length === 1 && /\(UTC\): /.test(bars.at(-1).t) && bars.at(-1).fill === 'bar focus');
  const vals = bars.map((b) => Number(b.t.split(': ')[1].replace(/[^0-9]/g, '')));
  const exp = dates14.filter((d) => byDate.has(d)).map((d) => byDate.get(d).Impressions);
  check('Context: every bar equals X\'s stored daily total', JSON.stringify(vals) === JSON.stringify(exp), vals.join(','));
  check('Context: today labelled "Today · value"', (await page.textContent('#stage .tr svg text.lbl-today')) === `Today · ${byDate.get(today).Impressions.toLocaleString('en-US')}`);
  check('Context: no caveat marks (no dotted connector, no "not observed")', (await page.locator('#stage [stroke-dasharray]').count()) === 0 && !/not observed/i.test(await page.textContent('#stage')));
  check('Context: no overflow', (await page.evaluate(() => [...document.querySelectorAll('#stage .card')].filter((c) => c.scrollHeight > c.clientHeight + 1).length)) === 0);
  await exportAs('verification/range-today-context.png');
}

// ---------- Scenario E: Today without engagement-type fields → panel removed, layout reflows ----------
{
  const stripped = cap.points.map((p) => (utc(p.t) === today ? { ...p, m: Object.fromEntries(Object.entries(p.m).filter(([k]) => !['Likes', 'Replies', 'Retweets', 'Bookmark'].includes(k))) } : p));
  await setState(seed(stripped, cap.capturedAt));
  await page.waitForTimeout(350);
  await pick('Today (1D)');
  check('No Likes/Replies fields: conversation panel removed (not inferred from total)', (await page.locator('#stage .cv').count()) === 0);
  check('No engagement fields: conversation removed, chart goes full width, visits per 1K stays inline, no placeholder', (await page.locator('#stage .r-stack').count()) === 0 && (await page.locator('#stage .tile-aside').count()) === 1 && (await page.locator('#stage .empty').count()) === 0);
  check('No engagement fields: no overflow', (await page.evaluate(() => [...document.querySelectorAll('#stage .card')].filter((c) => c.scrollHeight > c.clientHeight + 1).length)) === 0);
  await exportAs('verification/range-today-no-engagement.png');
}

// ---------- Scenario C: analytics not refreshed while rewards re-confirmed ----------
await setState(seed(cap.points, cap.capturedAt));
await setRun({
  id: 'x', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), account: 'byaarav',
  steps: {
    analytics: { state: 'skipped', message: 'not refreshed: open X Analytics and use Read current X tab', at: new Date().toISOString() },
    rewards: { state: 'done', message: 're-confirmed: 109.2K', at: new Date().toISOString() },
  },
});
await page.waitForTimeout(400);
const statusText = await page.textContent('.xck-sources');
check('Refresh status: analytics shown as NOT refreshed, separately', /! Analytics not refreshed/.test(statusText) && /showing capture from/.test(statusText), statusText.slice(0, 160));
check('Refresh status: rewards shown as re-confirmed, separately', /✓ Rewards re-confirmed: 109\.2K/.test(statusText));
check('Source guidance replaces the cross-page permission prompt', /Choose a range on X, then use Read current X tab/.test(statusText) && !/Allow x\.com access and refresh/.test(statusText) && await page.getByRole('button', { name: 'Open X Analytics ↗', exact: true }).count() === 1);
await page.screenshot({ path: 'verification/status-not-refreshed.png', clip: { x: 0, y: 0, width: 1440, height: 140 } });

// ---------- Export quality + feed-size previews ----------
{
  const pngInfo = (f) => { const b = readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), kb: Math.round(b.length / 1024), sig: b.subarray(1, 4).toString() }; };
  const now = pngInfo('verification/range-today-context.png');
  check('Export: PNG (not JPEG), 2400×1500 (2× of 1200×750)', now.sig === 'PNG' && now.w === 2400 && now.h === 1500, JSON.stringify(now));
  console.log('INFO  sizes:', JSON.stringify({ new_today: pngInfo('verification/range-today-context.png'), new_7d: pngInfo('verification/range-7d.png'), ...(existsSync('verification/before/today.png') ? { before_today: pngInfo('verification/before/today.png'), before_7d: pngInfo('verification/before/7d.png') } : {}) }));
  // Downscale with a high-quality resampler to X feed widths, old and new side by side at the SAME width.
  for (const w of [360, 600]) {
    for (const [name, src] of [['new-today', 'verification/range-today-context.png'], ['new-7d', 'verification/range-7d.png'], ['old-today', 'verification/before/today.png'], ['old-7d', 'verification/before/7d.png']]) {
      if (!existsSync(src)) continue;
      const out = await page.evaluate(async ([b64, w]) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = w; c.height = Math.round(img.height * w / img.width);
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/png').split(',')[1];
      }, [readFileSync(src).toString('base64'), w]);
      writeFileSync(`verification/feed-${w}-${name}.png`, Buffer.from(out, 'base64'));
    }
  }
}
check('No console errors', errors.length === 0, errors.join(' | '));
await ctx.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
