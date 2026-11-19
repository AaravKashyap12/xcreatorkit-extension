// Verifies the receipt page in the BUILT extension (throwaway Chromium profile, synthetic data):
// sample state, every scene, colourway and metric pickers, the loading animation, PNG export and layout safety.
//   node scripts/verify-receipt.mjs
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath(), ...(local ? ['chromium-1243', 'chromium-1234'].map((v) => join(local, v, 'chrome-win64', 'chrome.exe')) : [])].find((p) => p && existsSync(p));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
check('Manifest: X Creator Kit name and toolbar title', manifest.name === 'X Creator Kit' && manifest.action.default_title === 'X Creator Kit · Choose a tool' && manifest.action.default_popup === 'launcher.html');
for (const size of [16, 32, 48, 128]) {
  const path = `icons/icon-${size}.png`;
  const png = readFileSync(join(dist, path));
  check(`Icon ${size}: wired in manifest and ${size}×${size} PNG`, manifest.icons?.[size] === path && manifest.action.default_icon?.[size] === path && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === size && png.readUInt32BE(20) === size);
}

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xgd-rcpt-')), {
  executablePath, headless: true, acceptDownloads: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1440, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const base = `chrome-extension://${sw.url().split('/')[2]}`;
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => (m.type() === 'error' || (m.type() === 'warning' && /GSAP target.*not found/.test(m.text()))) && errors.push(m.text()));

const layoutIssues = () => page.evaluate(() => {
  const art = document.querySelector('.stage-frame .art');
  const k = art.getBoundingClientRect().width / 1080;
  const a = art.getBoundingClientRect();
  const out = [];
  const paper = art.querySelector('.paper').getBoundingClientRect();
  if (paper.bottom > a.bottom - 70 * k || paper.top < a.top) out.push(`paper outside safe area by ${Math.round((paper.bottom - a.bottom + 70 * k) / k)}px`);
  const stamp = art.querySelector('.slot:not(.empty) .stamp')?.getBoundingClientRect();
  if (stamp) for (const el of art.querySelectorAll('.paper .val, .paper .bar, .paper .eta, .paper .barcode, .paper .thanks, .paper .script, .paper table')) {
    const b = el.getBoundingClientRect();
    if (!(stamp.right <= b.left || stamp.left >= b.right || stamp.bottom <= b.top || stamp.top >= b.bottom)) out.push(`stamp overlaps ${el.className || el.tagName} by ${Math.round(Math.min(stamp.bottom - b.top, b.bottom - stamp.top) / k)}px`);
  }
  for (const el of art.querySelectorAll('.items td, .check td')) if (el.getBoundingClientRect().right > paper.right - 16 * k) out.push(`cell past paper: ${el.textContent}`);
  const kicker = art.querySelector('.paper .k');
  if (kicker) {
    const b = kicker.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(kicker).fontSize);
    if (b.left < paper.left + 16 * k || b.right > paper.right - 16 * k || kicker.offsetHeight > line * 1.5 || kicker.scrollWidth > kicker.clientWidth) out.push(`kicker does not fit on one line: ${kicker.textContent}`);
  }
  const hero = art.querySelector('.paper .hero');
  if (hero) {
    const b = hero.getBoundingClientRect();
    if (b.left < paper.left + 16 * k || b.right > paper.right - 16 * k || hero.scrollWidth > hero.clientWidth) out.push(`hero exceeds paper: ${hero.textContent}`);
  }
  const printerBrand = art.querySelector('.printer .brand');
  if (printerBrand && printerBrand.getBoundingClientRect().right > art.querySelector('.printer').getBoundingClientRect().right - 16 * k) out.push('printer brand exceeds the printer');
  const ref = art.querySelector('.ref').getBoundingClientRect();
  if (ref.top < paper.bottom - 2) out.push(`referral overlaps paper by ${Math.round((paper.bottom - ref.top) / k)}px`);
  return out;
});

async function baselineShift(selector) {
  const el = page.locator(selector).first();
  const clip = await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x - 6, y: r.y - 8, width: r.width + 12, height: r.height + 16 };
  });
  const flow = await page.screenshot({ clip });
  await el.evaluate((node) => { node.textContent = node.dataset.value; });
  const still = await page.screenshot({ clip });
  return page.evaluate(async ([animated, staticPng]) => {
    const pixels = async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
    };
    const a = await pixels(animated), b = await pixels(staticPng);
    const bg = [a.data[0], a.data[1], a.data[2]];
    const ink = (p, x, y) => {
      const i = (y * p.width + x) * 4;
      return Math.abs(p.data[i] - bg[0]) + Math.abs(p.data[i + 1] - bg[1]) + Math.abs(p.data[i + 2] - bg[2]) > 120;
    };
    const score = (shift) => {
      let n = 0;
      for (let y = 5; y < a.height - 5; y++) for (let x = 3; x < a.width - 3; x++)
        if (y + shift >= 0 && y + shift < b.height && ink(a, x, y) !== ink(b, x, y + shift)) n++;
      return n;
    };
    return [-2, -1, 0, 1, 2].map((shift) => ({ shift, mismatches: score(shift) })).sort((x, y) => x.mismatches - y.mismatches)[0];
  }, [flow.toString('base64'), still.toString('base64')]);
}

// ---------- Sample receipt (no data stored) ----------
await page.goto(`${base}/receipt.html`);
await page.waitForSelector('.stage-frame .art');
const iconsLoad = await page.evaluate(async () => Promise.all([16, 32, 48, 128].map(async (size) => {
  const img = new Image();
  img.src = chrome.runtime.getURL(`icons/icon-${size}.png`);
  await img.decode();
  return img.naturalWidth === size && img.naturalHeight === size;
})));
check('Extension page loads all four paper and ink icons', iconsLoad.every(Boolean), JSON.stringify(iconsLoad));
check('Receipt page head names the tool and the kit', (await page.locator('.xck-receipt-head h1').textContent()) === 'Receipts' && /X Creator Kit/.test(await page.locator('.xck-receipt-head').textContent()));
check('No data: sample receipt with a note', /Showing a sample receipt/.test(await page.textContent('.xck-controls')));
await page.waitForTimeout(700);
const midFlows = await page.$$eval('number-flow', (els) => els.length);
check('Animation: numbers mounted as rolling digits', midFlows >= 4, `number-flow elements: ${midFlows}`);
await page.screenshot({ path: 'verification/receipt-page-printing.png' });
await page.waitForTimeout(3200);
const finalText = await page.$$eval('.stage-frame number-flow', (els) => els.map((e) => e._internals?.ariaLabel ?? ''));
check('Animation: numbers land on the exact values', finalText.join('|').includes('450,800') && finalText.join('|').includes('+29,100'), finalText.join(' | '));
const stamped = await page.$$eval('.stage-frame .slot:not(.empty) .stamp', (l) => l.length);
const status = await page.textContent('.xck-status-line');
check('Sample is never stamped or called captured', stamped === 0 && /Not captured yet/.test(status), `${stamped} stamps · ${status}`);
await page.screenshot({ path: 'verification/receipt-page.png' });
await page.setViewportSize({ width: 390, height: 844 });
const narrow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, header: document.querySelector('.xck-receipt-head h1').getBoundingClientRect().right,
  periods: [...document.querySelectorAll('.xck-period-button')].map((b) => ({ left: b.getBoundingClientRect().left, right: b.getBoundingClientRect().right })) }));
check('Receipt page: full brand and period controls fit at 390px', narrow.width <= 390 && narrow.header <= 390 && narrow.periods.length === 3 && narrow.periods.every((b) => b.left >= 0 && b.right <= 390), JSON.stringify(narrow));
await page.setViewportSize({ width: 1440, height: 1000 });

// ---------- Day 1: picked by the creator, saved, counted in UTC days ----------
const heroText = () => page.$eval('.stage-frame .art .hero', (e) => e.textContent.trim().toUpperCase());
const fresh = await page.evaluate(() => ({ ask: document.querySelector('.xck-dayone').classList.contains('ask'), hint: document.querySelector('#day-one-hint').textContent, value: document.querySelector('#day-one').value }));
check('Fresh install: asks for Day 1 and counts today as Day 1', fresh.ask && /When did your journey start/.test(fresh.hint) && fresh.value === '' && (await heroText()) === 'DAY 1', JSON.stringify(fresh));
const ymd = (d) => d.toISOString().slice(0, 10);
const day1 = ymd(new Date(Date.now() - 42 * 86400000));
await page.fill('#day-one', day1);
await page.waitForTimeout(800);
const picked = await page.evaluate(async () => ({ hint: document.querySelector('#day-one-hint').textContent, ask: document.querySelector('.xck-dayone').classList.contains('ask'), saved: (await chrome.storage.local.get('xgd:v1'))['xgd:v1']?.settings?.dayAnchor }));
check('Picking Day 1 saves it and the receipt counts from it (42 days ago = Day 43)', !picked.ask && /Today is Day 43/.test(picked.hint) && picked.saved?.date === day1 && picked.saved?.day === 1 && (await heroText()) === 'DAY 43', JSON.stringify({ ...picked, hero: await heroText() }));
await page.reload();
await page.waitForSelector('.stage-frame .art');
await page.waitForTimeout(600);
check('Day 1 survives a reload', (await page.$eval('#day-one', (i) => i.value)) === day1 && (await heroText()) === 'DAY 43');
await page.fill('#day-one', ymd(new Date(Date.now() + 3 * 86400000)));
await page.waitForTimeout(800);
const future = await page.evaluate(async () => ({ error: document.querySelector('.xck-dayone .xck-error')?.textContent, saved: (await chrome.storage.local.get('xgd:v1'))['xgd:v1']?.settings?.dayAnchor?.date }));
check('A Day 1 after today is refused and nothing changes', /after today/.test(future.error ?? '') && future.saved === day1 && (await heroText()) === 'DAY 43', JSON.stringify(future));
await page.screenshot({ path: 'verification/receipt-page-dayone.png' });

// ---------- Every scene and its layout ----------
for (let i = 0; i < 6; i++) {
  await page.locator('.xck-scene').nth(i).click();
  await page.waitForTimeout(3300);
  const issues = await layoutIssues();
  const name = await page.locator('.xck-scene').nth(i).getAttribute('title');
  const referral = await page.locator('.stage-frame .ref').textContent();
  const brand = await page.locator('.stage-frame .paper .k, .stage-frame .printer .brand').allTextContents();
  await page.locator('.stage-frame .art').screenshot({ path: `verification/receipt-scene-${i + 1}.png` });
  check(`Scene ${i + 1} (${name}): no overlap, inside the safe area`, issues.length === 0, issues.join('; '));
  if (i !== 2) check(`Scene ${i + 1}: kicker uses X Creator Kit`, brand.length > 0 && brand.every((text) => text.startsWith('X Creator Kit')), brand.join(' | '));
  check(`Scene ${i + 1}: exact referral`, referral === 'print yours → xcreatorkit.com', referral);
  const noTexture = await page.addStyleTag({ content: '.paper::before,.paper::after{display:none!important}' });
  const rowBaseline = await baselineShift('.stage-frame tr[data-row] .num');
  const totalBaseline = await baselineShift('.stage-frame .total .num, .stage-frame tr.tot .num');
  check(`Scene ${i + 1}: rolled figures share the static baseline`, rowBaseline.shift === 0 && totalBaseline.shift === 0, JSON.stringify({ rowBaseline, totalBaseline }));
  await noTexture.evaluate((node) => node.remove());
}

// ---------- Colourways and metrics ----------
await page.locator('.xck-scene').first().click();
await page.locator('.xck-swatch-dot').nth(3).click();
await page.waitForTimeout(400);
const field = await page.$eval('.stage-frame .art', (a) => getComputedStyle(a).getPropertyValue('--field').trim());
check('Colourway switch changes the field colour', field === '#1f5a3d', field);
const uncheck = page.locator('.xck-line', { hasText: 'Posts' }).locator('input');
await uncheck.uncheck();
await page.waitForTimeout(300);
check('Unticking a metric removes its line', (await page.locator('.stage-frame .items tbody tr').count()) === 3);
await page.locator('.xck-line', { hasText: 'Likes' }).locator('input').check();
await page.locator('.xck-line', { hasText: 'Profile visits' }).locator('input').check().catch(() => {});
const disabled = await page.locator('.xck-line input:disabled').count();
check('At most four lines: the rest are disabled once four are ticked', disabled === 4, `${disabled} disabled`);

// ---------- Captured data (synthetic) ----------
await page.evaluate(async () => {
  const now = new Date();
  const ymd = (d) => d.toISOString().slice(0, 10);
  const at = (days) => new Date(now.getTime() - days * 86400000);
  const rows = {};
  for (let i = 9; i >= 0; i--) {
    const date = ymd(at(i));
    rows[date] = { date, metrics: i === 0 ? { Impressions: 38420, Engagements: 1614, Follows: 24, CreateTweet: 6, CreateReply: 87, Likes: 1212 } : { Impressions: 30000, Engagements: 900, Follows: 9, CreateTweet: 4, CreateReply: 60 }, capturedAt: now.toISOString(), partial: i === 0 };
  }
  const rw = (id, value, text, d) => ({ id, account: 'byaarav', accountSource: 'page', provenance: 'captured', reportingTimeZone: 'UTC', reportingDate: ymd(d), periodStart: null, periodEnd: null, lastSeenAt: d.toISOString(), capturedAt: d.toISOString(),
    metric: 'rewards_vht_90d', displayText: text, value, precision: 'rounded', roundingHalfStep: 50, sourceUrl: 'https://x.com/i/jf/creators/original_content_rewards', sourceLabel: 'test', windowType: 'rolling_90d', verifiedOnly: true, excludesReplies: true });
  const observations = [rw('a', 101200, '101.2K', at(1)), rw('b', 104500, '104.5K', now)];
  const state = { schemaVersion: 1, settings: { expectedHandle: 'byaarav', reportingTimeZone: 'UTC', cycleCutoffHour: 0, utcOnly: true, dayAnchor: { date: '2026-09-30', day: 30 }, dayOverrides: {}, rewardsTarget: 500000, staleAfterHours: 24 },
    accounts: { byaarav: { observations, attempts: [], daily: { all: { rows, lastCaptureAt: now.toISOString(), lastRange: null, source: 'x_web_account_analytics' } } } } };
  await chrome.storage.local.set({ 'xgd:v1': state });
});
await page.reload();
await page.waitForSelector('.stage-frame .art');
await page.waitForTimeout(3300);
const cap = await page.evaluate(() => ({ status: document.querySelector('.xck-status-line').textContent, demo: !!document.querySelector('.xck-note'), stamp: !!document.querySelector('.stage-frame .slot:not(.empty) .stamp'),
  rows: [...document.querySelectorAll('.stage-frame tr[data-row]')].map((r) => [...r.querySelectorAll('td')].map((td) => td.querySelector('number-flow')?._internals?.ariaLabel ?? td.textContent.trim()).join(' ')) }));
check('Captured data: stamped, no sample note, status says captured', cap.stamp && !cap.demo && /Captured from X/.test(cap.status), JSON.stringify(cap));
check('Captured data: lines show the numbers for today', cap.rows.some((r) => r.includes('+24')) && cap.rows.some((r) => r.includes('1,212')), cap.rows.join(' | '));
await page.screenshot({ path: 'verification/receipt-page-captured.png' });
const oldStampTime = await page.locator('.stage-frame .stamp span').textContent();
const changedAt = await page.evaluate(async () => {
  const state = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  const date = new Date().toISOString().slice(0, 10);
  const at = new Date(Date.now() - 300_000).toISOString();
  state.accounts.byaarav.daily.all.rows[date].capturedAt = at;
  state.accounts.byaarav.daily.all.lastCaptureAt = at;
  await chrome.storage.local.set({ 'xgd:v1': state });
  return at;
});
await page.waitForTimeout(300);
const newStampTime = await page.locator('.stage-frame .stamp span').textContent();
check('Re-capture with unchanged values updates the printed UTC stamp', newStampTime !== oldStampTime && newStampTime.includes(`${changedAt.slice(11, 16)} UTC`), `${oldStampTime} → ${newStampTime}`);

// ---------- Recaps: complete UTC windows through yesterday, all shared scenes and colourways ----------
await page.emulateMedia({ reducedMotion: 'reduce' });
for (const [period, title] of [['Week', 'LAST 7 DAYS'], ['Month', new Date().toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toUpperCase()]]) {
  await page.getByRole('button', { name: period, exact: true }).click();
  await page.waitForTimeout(500);
  const heading = await heroText();
  const coverage = await page.locator('.stage-frame .period-detail').textContent();
  check(`${period}: explicit UTC heading and complete-day coverage`, heading.startsWith(title) && /complete UTC days captured/.test(coverage) && /today excluded/.test(coverage), `${heading} · ${coverage}`);
  check(`${period}: period picker hides daily-only impressions delta`, (await page.locator('.xck-line', { hasText: 'Impressions vs yesterday' }).count()) === 0);
  check(`${period}: impressions picker uses a period label`, (await page.locator('.xck-line', { hasText: 'Impressions today' }).count()) === 0 && (await page.locator('.xck-line', { hasText: 'Impressions' }).count()) >= 1);
  if (period === 'Week') {
    for (const name of ['New followers', 'Replies', 'Likes']) await page.locator('.xck-line', { hasText: name }).locator('input').uncheck();
    for (const name of ['Best day', 'Days posted', 'Posting streak']) await page.locator('.xck-line', { hasText: name }).locator('input').check();
    await page.waitForFunction(() => document.querySelectorAll('.stage-frame tr[data-row]').length === 4);
    const recapValues = await page.locator('.stage-frame tr[data-row] .num').allTextContents();
    check('Week: recap-only lines show observed best day, posting days and streak', recapValues.length === 4 && recapValues[1]?.includes('·') && recapValues[2] === '7' && recapValues[3] === '7 DAYS', recapValues.join(' | '));
    check('Week: fully covered analytics lines earn the capture stamp', await page.locator('.stage-frame .slot:not(.empty) .stamp').count() === 1);
  } else {
    const [, got, expected] = coverage.match(/(\d+) of (\d+) complete UTC days captured/) ?? [];
    const monthComplete = Number(got) === Number(expected) && Number(expected) > 0;
    check('Month: stamp follows complete-day coverage', got != null && (await page.locator('.stage-frame .slot:not(.empty) .stamp').count() === 1) === monthComplete, `${coverage} · complete=${monthComplete}`);
  }
  for (let i = 0; i < 6; i++) {
    await page.locator('.xck-scene').nth(i).click();
    await page.waitForTimeout(150);
    if (i === 0) await page.locator('.stage-frame .art').screenshot({ path: `verification/receipt-${period.toLowerCase()}-receiptify.png` });
    for (let c = 0; c < 6; c++) {
      await page.locator('.xck-swatch-dot').nth(c).click();
      await page.waitForTimeout(80);
      const issues = await layoutIssues();
      check(`${period} scene ${i + 1} colourway ${c + 1}: safe layout`, issues.length === 0, issues.join('; '));
    }
    const dlRecap = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PNG' }).click();
    const recapDownload = await dlRecap;
    const recapPng = readFileSync(await recapDownload.path());
    check(`${period} scene ${i + 1}: PNG export`, recapPng.readUInt32BE(16) === 2160 && recapPng.readUInt32BE(20) === 2700 && recapPng.length > 100_000 && recapDownload.suggestedFilename().includes(`-${period.toLowerCase()}-`), `${recapDownload.suggestedFilename()} · ${recapPng.length} bytes`);
  }
}
// A recap has a text Best day between numeric rows. A settings refresh must update each row's own value.
await page.evaluate(async () => {
  const st = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  const dates = Object.keys(st.accounts.byaarav.daily.all.rows).sort().slice(-8, -1);
  dates.forEach((date, i) => { st.accounts.byaarav.daily.all.rows[date].metrics.CreateTweet = i % 2 ? 0 : 2; });
  await chrome.storage.local.set({ 'xgd:v1': st });
});
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.getByRole('button', { name: 'Week', exact: true }).click();
await page.waitForTimeout(3300);
const recapFigures = () => page.$eval('.stage-frame .art', (art) => [...art.querySelectorAll('[data-row]')].map((row) => {
  const num = row.querySelector('.num');
  return num.querySelector('number-flow')?._internals?.ariaLabel ?? num.textContent.trim();
}));
check('Normal recap starts with distinct posting days and streak', JSON.stringify((await recapFigures()).slice(-2)) === JSON.stringify(['4', '1 DAY']), JSON.stringify(await recapFigures()));
// A settings write from elsewhere (here: the stale-after hours) re-renders the receipt from storage.
await page.evaluate(async () => { const st = (await chrome.storage.local.get('xgd:v1'))['xgd:v1']; st.settings.staleAfterHours = 25; await chrome.storage.local.set({ 'xgd:v1': st }); });
await page.waitForTimeout(1100);
const previewMatchesStatic = () => page.$eval('.stage-frame .art', (art) => [...art.querySelectorAll('[data-row] .num')].every((num) => (num.querySelector('number-flow')?._internals?.ariaLabel ?? num.textContent.trim()) === num.dataset.value));
check('A settings write keeps each normal-motion recap value on its own row', JSON.stringify((await recapFigures()).slice(-3)) === JSON.stringify([await page.locator('[data-row="1"] .num').getAttribute('data-value'), '4', '1 DAY']) && await previewMatchesStatic(), JSON.stringify(await recapFigures()));
await page.evaluate(async () => {
  const st = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  const date = Object.keys(st.accounts.byaarav.daily.all.rows).sort().slice(-8, -1)[1];
  st.accounts.byaarav.daily.all.rows[date].metrics.CreateTweet = 2;
  await chrome.storage.local.set({ 'xgd:v1': st });
});
await page.waitForTimeout(1100);
check('Fresh recap values and singular/plural suffix roll on their own rows', JSON.stringify((await recapFigures()).slice(-2)) === JSON.stringify(['5', '3 DAYS']) && await previewMatchesStatic(), JSON.stringify(await recapFigures()));
const changedExport = page.waitForEvent('download');
await page.getByRole('button', { name: 'Download PNG' }).click();
const changedPng = readFileSync(await (await changedExport).path());
check('Updated recap exports from the same receipt renderer', changedPng.readUInt32BE(16) === 2160 && changedPng.readUInt32BE(20) === 2700 && changedPng.length > 100_000);
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.getByRole('button', { name: 'Replay animation' }).click();
await page.evaluate(async () => {
  const st = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  for (const row of Object.values(st.accounts.byaarav.daily.all.rows)) row.metrics.CreateTweet = 2;
  await chrome.storage.local.set({ 'xgd:v1': st });
});
await page.waitForTimeout(300);
check('Reduced-motion recap updates static rows after a reading changes', JSON.stringify((await recapFigures()).slice(-2)) === JSON.stringify(['7', '7 DAYS']) && await previewMatchesStatic(), JSON.stringify(await recapFigures()));
await page.evaluate(async () => {
  const st = (await chrome.storage.local.get('xgd:v1'))['xgd:v1'];
  const date = Object.keys(st.accounts.byaarav.daily.all.rows).sort().slice(-8, -1)[0];
  delete st.accounts.byaarav.daily.all.rows[date].metrics.Impressions;
  await chrome.storage.local.set({ 'xgd:v1': st });
});
await page.waitForTimeout(300);
check('Recap text row updates when its source figure becomes unavailable', (await recapFigures())[1] === '—', JSON.stringify(await recapFigures()));
await page.getByRole('button', { name: 'Month', exact: true }).click();
await page.reload();
await page.waitForSelector('.stage-frame .art');
check('Month period and recap line choices survive reload', (await page.locator('.xck-period-button.on').textContent()) === 'Month' && (await heroText()).includes(String(new Date().getUTCFullYear())) && await page.locator('.xck-line input:checked').count() === 4);
await page.getByRole('button', { name: 'Day', exact: true }).click();
await page.waitForTimeout(400);
check('Day switch removes recap-only lines from the picker and receipt', (await page.locator('.xck-line', { hasText: 'Best day' }).count()) === 0 && (await page.locator('.stage-frame tr[data-row]').count()) <= 4);

// ---------- Following lives in one place: the shared navigation (verify-navigation covers its rules) ----------
check('Receipts has no duplicate Following setting; navigation links to Following settings',
  await page.locator('#followback-enabled').count() === 0 && await page.getByRole('navigation', { name: 'Kit tools' }).getByRole('link', { name: 'Following settings' }).getAttribute('href') === 'launcher.html#following');

// ---------- PNG export ----------
const dl = page.waitForEvent('download');
await page.getByRole('button', { name: 'Download PNG' }).click();
const file = await (await dl).path();
const png = readFileSync(file);
const w = png.readUInt32BE(16), hgt = png.readUInt32BE(20);
check('Download: 2160×2700 PNG (4:5, rendered at 2×)', w === 2160 && hgt === 2700, `${w}×${hgt}, ${Math.round(png.length / 1024)} KB`);
// Look at the export itself: field colour in the corner, paper in the middle, inked text, and stamp ink (mask + blend survived).
const colours = await page.$eval('.stage-frame .art', (a) => { const cs = getComputedStyle(a); return { field: cs.getPropertyValue('--field').trim(), stamp: cs.getPropertyValue('--stamp').trim() }; });
const px = await page.evaluate(async ({ b64, colours }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = 540; c.height = 675; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 540, 675);
  const d = x.getImageData(0, 0, 540, 675).data;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const near = (i, [r, g, b], t) => Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < t;
  const at = (x0, y0) => (y0 * 540 + x0) * 4;
  let ink = 0, stamp = 0; const st = hex(colours.stamp);
  for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] < 150) ink++; if (near(i, st, 90)) stamp++; }
  let light = 0, n = 0;
  for (let y = 200; y < 500; y += 4) for (let x0 = 150; x0 < 390; x0 += 4) { const i = at(x0, y); n++; if (d[i] + d[i + 1] + d[i + 2] > 600) light++; }
  return { corner: near(at(8, 8), hex(colours.field), 70), paper: light / n > 0.6, ink, stamp };
}, { b64: png.toString('base64'), colours });
check('Export: field, paper, text and stamp ink all rendered', px.corner && px.paper && px.ink > 3000 && px.stamp > 300, JSON.stringify(px));
await page.evaluate(async (b64) => { document.body.innerHTML = `<img src="data:image/png;base64,${b64}" style="width:540px">`; }, png.toString('base64'));
await page.waitForTimeout(300);
await page.screenshot({ path: 'verification/receipt-export.png', clip: { x: 0, y: 0, width: 540, height: 675 } });

check('No console errors or missing animation targets', errors.length === 0, errors.join(' | '));
await ctx.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
