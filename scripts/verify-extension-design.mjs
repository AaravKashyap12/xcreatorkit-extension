// Extension visual system (docs/v1/EXTENSION-READER.md): the reader tokens and type on every tool page, shared
// navigation, keys, the Analytics coverage strip, empty states, keyboard focus, contrast and reduced motion. The
// chooser popup itself is covered by verify-navigation.mjs.
//
// Retired slate-and-cobalt checks and what replaced them:
//   "slate canvas, slate text and Geist"                -> "soft ground, ink text and Archivo" (+ the faces are loaded)
//   "Chooser: built on the shared tokens" (#2b55e6)     -> same check, blue ink #2140c9
//   "selected option a raised white chip"               -> "selected option an ink face" (focus is still a separate ring)
//   "white on cobalt"                                   -> "white on blue ink and on ink"
//   "Receipt period uses the kit segmented control"     -> same check, the selected period is an ink face
// Built extension, disposable profile, synthetic data only.
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { capture } from './fixtures/analytics.mjs';

const shots = 'verification/_design';
mkdirSync(shots, { recursive: true });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-design-')), {
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
  headless: true, acceptDownloads: true,
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
});
let checks = 0;
const check = (name, ok, detail = '') => { assert.ok(ok, `${name}${detail ? ` · ${detail}` : ''}`); console.log(`PASS ${name}`); checks++; };
const errors = [], requests = [];
ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e))));
ctx.on('request', (r) => { if (/^https?:/.test(r.url())) requests.push(r.url()); });

const PAGES = [['launcher.html', 'Chooser'], ['analytics.html', 'Analytics'], ['report.html', 'Ledger'], ['dashboard.html', 'Rewards pace'], ['receipt.html', 'Receipts'], ['postcard.html', 'Post to image'], ['screenshot.html', 'Screenshot editor']];
const TOOLS = ['Analytics', 'Ledger', 'Rewards pace', 'Receipts', 'Post to image', 'Screenshot editor', 'Following settings'];
const CANVAS = 'rgb(244, 244, 241)', TEXT = 'rgb(19, 19, 19)', INK = 'rgb(19, 19, 19)';
const AN_CANVAS = CANVAS; // Analytics sits on the same soft ground as every other tool

async function seed(page) {
  await page.evaluate(async (c) => {
    const today = c.capturedAt.slice(0, 10); const rows = {};
    for (const p of c.points) { const date = new Date(p.t).toISOString().slice(0, 10); rows[date] = { date, metrics: p.m, capturedAt: c.capturedAt, partial: date >= today }; }
    const base = { account: 'samplecreator', accountSource: 'page', provenance: 'captured', reportingTimeZone: 'UTC', periodStart: null, periodEnd: null };
    const reading = (id, date, value) => ({ ...base, id, reportingDate: date, lastSeenAt: `${date}T12:00:00.000Z`, capturedAt: `${date}T12:00:00.000Z`, metric: 'rewards_vht_90d', displayText: `${(value / 1000).toFixed(1)}K`, value, precision: 'rounded', roundingHalfStep: 50, sourceUrl: 'https://x.com/i/jf/creators/original_content_rewards', sourceLabel: 'X Creator Studio · Original Content Rewards', windowType: 'rolling_90d', verifiedOnly: true, excludesReplies: true });
    const observations = [reading('r1', '2026-09-25', 94100), reading('r2', '2026-10-02', 109200)];
    const state = { schemaVersion: 1, settings: { expectedHandle: 'samplecreator', reportingTimeZone: 'UTC', cycleCutoffHour: 0, utcOnly: true, dayAnchor: { date: '2026-09-30', day: 30 }, rewardsTarget: 500000, staleAfterHours: 24 }, accounts: { samplecreator: { observations, attempts: [], daily: { all: { rows, lastCaptureAt: c.capturedAt, lastRange: c.range, source: 'x_web_account_analytics' } } } } };
    await chrome.storage.local.set({ 'xgd:v1': state });
  }, capture);
}
const look = (page) => page.evaluate(() => {
  const body = getComputedStyle(document.body);
  return { bg: body.backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.documentElement).backgroundColor : body.backgroundColor, font: body.fontFamily, color: body.color,
    overflow: document.documentElement.scrollWidth - innerWidth };
});

try {
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(capture.capturedAt));

  // ---------- Empty states first (fresh profile, nothing stored) ----------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/dashboard.html`);
  await page.getByRole('heading', { name: 'EOD share card' }).waitFor();
  check('Rewards with no reading hides the blank share-card frame', await page.locator('canvas.card-preview').evaluate((el) => el.hidden && el.getBoundingClientRect().height === 0));
  const emptyHero = await page.evaluate(() => { const hero = document.querySelector('.xck-hero-empty'); const face = getComputedStyle(hero, '::before'); return { stamp: document.querySelectorAll('.xck-stamp').length, face: face.backgroundImage !== 'none' && parseFloat(face.width) === 36, num: document.querySelectorAll('.xck-hero-num').length }; });
  check('Rewards with no reading shows the waiting reader, no figure and no Captured mark', emptyHero.stamp === 0 && emptyHero.face && emptyHero.num === 0, JSON.stringify(emptyHero));
  await page.screenshot({ path: `${shots}/empty-rewards.png`, fullPage: true });
  await page.goto(`${base}/postcard.html`);
  await page.getByRole('heading', { name: 'Make an image of a post' }).waitFor();
  check('Post to image first use lists the three steps in order', JSON.stringify(await page.locator('.xck-post-steps li b').allTextContents()) === JSON.stringify(['Right-click a post', 'Choose “Make an image of this post”', 'Pick a style']));
  await page.goto(`${base}/postcard.html#error`); await page.reload();
  check('Post to image error is a titled notice, not bare text', await page.getByRole('heading', { name: 'The selected post could not be identified' }).isVisible());

  // A new install shows no one else's account anywhere: the receipt sample wears a placeholder.
  for (const [file, name] of PAGES) {
    await page.goto(`${base}/${file}`);
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.value).join(' '));
    check(`${name}: new install shows no default account`, !/byaarav/i.test(text) && !/@(\s|$|\.)/.test(text), text.match(/.{0,30}(byaarav|@\s).{0,30}/i)?.[0]);
  }
  await page.goto(`${base}/receipt.html`);
  await page.locator('.stage-frame .art').waitFor();
  check('Receipt sample uses a placeholder handle until yours is known', /@YOURHANDLE/.test(await page.locator('.stage-frame').textContent()));

  // ---------- One world on every page ----------
  await page.goto(`${base}/launcher.html`);
  await seed(page);
  for (const [file, name] of PAGES) {
    // Desktop, small laptop, tablet, a phone on its side (844 x 390), large and small phones.
    for (const width of [1440, 1024, 768, 844, 390, 320]) {
      await page.setViewportSize({ width: file === 'launcher.html' ? 380 : width, height: width === 844 ? 390 : 900 });
      await page.goto(`${base}/${file}`);
      await page.waitForTimeout(500);
      const l = await look(page);
      if (width === 1440 && file !== 'launcher.html') {
        // Post to image keeps the body face and colour its card preview inherits; its chrome is checked through the title.
        const h1 = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('h1')); return { color: s.color, font: s.fontFamily, weight: s.fontWeight }; });
        check(`${name}: soft ground, ink text and Archivo`, l.bg === (file === 'analytics.html' ? AN_CANVAS : CANVAS) && (/XckArchivo/.test(l.font) || file === 'postcard.html') && (l.color === TEXT || file === 'postcard.html') && h1.color === TEXT && /XckArchivo/.test(h1.font) && h1.weight === '800', JSON.stringify({ l, h1 }));
        check(`${name}: Archivo, Martian Mono and Doto are loaded from the package`, await page.evaluate(async () => { await document.fonts.ready; return ['800 26px XckArchivo', '500 13px XckMartian', '900 14px XckDoto'].every((f) => document.fonts.check(f)); }));
      }
      if (width === 1440 && file === 'launcher.html') check('Chooser: built on the shared tokens', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--xck-accent').trim() === '#2140c9'));
      if (width === 1440 && file !== 'launcher.html') { // the chooser's own text audit lives in verify-navigation.mjs
        // DESIGN.md: nothing under 12.5px in the chrome. Artwork (receipt, card, post image) is excluded.
        const small = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => {
          if (el.closest('.stage-frame, #stage, .postcard-scale, canvas, .tint-sample, [aria-hidden="true"]') || !el.childNodes.length) return false;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          const r = el.getBoundingClientRect();
          if (!own || !r.width || !r.height || !el.checkVisibility()) return false;
          const svg = el.closest('svg');
          const size = parseFloat(getComputedStyle(el).fontSize) * (svg ? svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : 1);
          return size < 12.4;
        }).slice(0, 5).map((el) => `${el.tagName}.${el.className?.baseVal ?? el.className}: ${el.textContent.trim().slice(0, 30)} ${getComputedStyle(el).fontSize}`));
        check(`${name}: chrome text is at least 12.5px`, small.length === 0, small.join(' | '));
      }
      check(`${name}: no sideways scroll at ${file === 'launcher.html' ? 380 : width}px`, l.overflow <= 0, String(l.overflow));
      await page.screenshot({ path: `${shots}/${file.replace('.html', '')}-${width}.png`, fullPage: file !== 'receipt.html' });
      if (file === 'launcher.html') {
        await page.setViewportSize({ width: 320, height: 900 });
        await page.reload(); await page.waitForTimeout(300);
        const narrow = await look(page);
        check('Chooser: no sideways scroll at 320px', narrow.overflow <= 0, String(narrow.overflow));
        await page.screenshot({ path: `${shots}/launcher-320.png`, fullPage: true });
        break;
      }
    }
  }

  // ---------- Shared navigation ----------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/analytics.html`);
  const nav = page.getByRole('navigation', { name: 'Kit tools' });
  for (const tool of TOOLS) check(`Navigation name stays "${tool}" (ledger numbers are not read aloud)`, await nav.getByRole('link', { name: tool, exact: true }).count() === 1);
  check('The current tool is marked in the navigation', await nav.getByRole('link', { name: 'Analytics', exact: true }).getAttribute('aria-current') === 'page');
  check('Trust line states local storage and UTC', (await page.locator('.xck-trust').textContent()) === 'Stored in this browser · Dates in UTC' && await page.locator('.xck-trust').isVisible());
  check('Shell stays in view while scrolling', await page.evaluate(async () => { scrollTo(0, 1500); await new Promise((r) => requestAnimationFrame(r)); return document.querySelector('.xck-shell').getBoundingClientRect().top === 0; }));
  await page.evaluate(() => scrollTo(0, 0));
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => ({ text: document.activeElement?.textContent, outline: getComputedStyle(document.activeElement).outlineStyle }));
  check('Keyboard reaches the first tool with a visible ring', firstFocus.text === 'Analytics' && firstFocus.outline !== 'none', JSON.stringify(firstFocus));
  // Selection and keyboard focus look different (Radix toggle-group reference). Analytics: an ink face vs a separate ring.
  await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Day' }).focus();
  await page.keyboard.press('Tab');
  const seg = await page.evaluate(() => { const f = document.activeElement; const on = document.querySelector('.xck-seg [aria-pressed=true][data-key^="Group"]'); return { key: f.dataset.key, ring: getComputedStyle(f).outlineStyle, focusBg: getComputedStyle(f).backgroundColor, onBg: getComputedStyle(on).backgroundColor, onWeight: getComputedStyle(on).fontWeight, onShadow: getComputedStyle(on).boxShadow, onRing: getComputedStyle(on).outlineStyle }; });
  check('Analytics: focused option shows a ring, selected option an ink face', seg.key === 'Group:weekly' && seg.ring !== 'none' && seg.onRing === 'none' && seg.focusBg !== seg.onBg && seg.onBg === INK && seg.onWeight === '600', JSON.stringify(seg));
  await page.locator('#an-main-values > summary').focus();
  check('Disclosure summaries take a visible focus ring', await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'));
  // Pointer checks come after the keyboard-focus checks above, which need the last input to have been a key.
  // Keys: a paper key is a white face with an ink edge on an ink lip; hover lifts it one pixel, a press sinks it.
  const key = page.getByRole('button', { name: 'Open X Analytics ↗' });
  const keyLook = (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, shadow: s.boxShadow, y: s.translate, border: s.borderTopWidth }; };
  const keyRest = await key.evaluate(keyLook);
  await key.hover(); await page.waitForTimeout(220);
  const keyHover = await key.evaluate(keyLook);
  await page.mouse.down(); await page.waitForTimeout(160);
  const keyDown = await key.evaluate(keyLook);
  await page.mouse.move(0, 500); await page.mouse.up();
  check('A key rests on its lip, lifts on hover and sinks when pressed', keyRest.bg === 'rgb(255, 255, 255)' && /rgb\(19, 19, 19\) 0px 2px 0px 0px/.test(keyRest.shadow) && /inset/.test(keyRest.shadow) && keyRest.border === '0px' && keyHover.y === '0px -1px' && /0px 3px 0px 0px/.test(keyHover.shadow) && keyDown.y === '0px 2px' && /0px 0px 0px 0px/.test(keyDown.shadow), JSON.stringify({ keyRest, keyHover, keyDown }));
  // The plotted metric is named inside the reader's brackets; the others are not.
  const tileNames = await page.$$eval('.xck-tile', (tiles) => tiles.map((t) => { const label = t.querySelector('.xck-figure-label'); return { on: t.querySelector('input').checked, before: getComputedStyle(label, '::before').content, color: getComputedStyle(label).color }; }));
  check('The plotted metric carries the reader\'s brackets in blue ink; the other tiles do not', tileNames[0].on && /\[/.test(tileNames[0].before) && tileNames[0].color === 'rgb(33, 64, 201)' && tileNames.slice(1).every((t) => !t.on && t.before === 'none'), JSON.stringify(tileNames));
  const strip = await page.$eval('#analytics-coverage', (el) => ({ n: el.children.length, read: el.querySelectorAll('.read').length, hidden: el.getAttribute('aria-hidden'), before: el.nextElementSibling?.id }));
  check('Analytics shows one coverage mark per day of the range, above the same facts in words', strip.n === 28 && strip.read === 28 && strip.hidden === 'true' && strip.before === 'analytics-source', JSON.stringify(strip));
  const lines = await page.$eval('.xck-main-chart svg.chart', (svg) => ({ main: getComputedStyle(svg.querySelector('polyline.series-line:not(.quiet)')).strokeWidth, quiet: getComputedStyle(svg.querySelector('polyline.series-line.quiet')).strokeWidth, grid: getComputedStyle(svg.querySelector('.grid')).strokeDasharray }));
  check('Comparison chart: a bold line for the range, a thin one for the period before, a dotted grid', lines.main === '2.5px' && lines.quiet === '1.5px' && lines.grid !== 'none', JSON.stringify(lines));
  await page.setViewportSize({ width: 390, height: 844 });
  check('Trust line steps aside on narrow screens', !(await page.locator('.xck-trust').isVisible()));

  // ---------- Contrast of the shared tokens (WCAG formula) ----------
  const ratios = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.trim().slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const lum = (hex) => { const [r, g, b] = rgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(css.getPropertyValue(a)), lum(css.getPropertyValue(b))].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
    const text = ['--xck-text', '--xck-text-2', '--xck-text-3', '--xck-pos', '--xck-neg', '--xck-warn', '--xck-accent-ink', '--xck-accent'];
    const bar = (hex) => { const l = lum(hex); return +((Math.max(l, lum('#131313')) + 0.05) / (Math.min(l, lum('#131313')) + 0.05)).toFixed(2); };
    return { text: Object.fromEntries(text.flatMap((v) => [[`${v}/surface`, ratio(v, '--xck-surface')], [`${v}/canvas`, ratio(v, '--xck-canvas')]])), onAccent: ratio('--xck-on-accent', '--xck-accent'), onInk: ratio('--xck-on-ink', '--xck-ink'), barText: bar(css.getPropertyValue('--xck-bar-text')), barTrust: bar('#a9abb0'), lcd: +((lum(css.getPropertyValue('--xck-lcd-glow')) + 0.05) / (lum('#070807') + 0.05)).toFixed(2), control: ratio('--xck-control-border', '--xck-surface'), series2: ratio('--xck-series-2', '--xck-surface'),
      // Context text sits on the Analytics canvas; axis labels (text-3) sit on white cards; pills on their own tints.
      analytics: { line: ratio('--xck-an-line', '--xck-surface'), text: ratio('--xck-text', '--xck-an-canvas'), text2: ratio('--xck-text-2', '--xck-an-canvas'), warn: ratio('--xck-warn', '--xck-an-canvas'), axis: ratio('--xck-text-3', '--xck-surface'), pos: ratio('--xck-pos', '--xck-an-pos-soft'), neg: ratio('--xck-neg', '--xck-an-neg-soft'), refEdge: ratio('--xck-series-2', '--xck-surface') } };
  });
  check('Analytics tokens: line-blue text, labels and pill text reach 4.5:1; pale bars keep a 3:1 outline against their card', ['line', 'text', 'text2', 'warn', 'axis', 'pos', 'neg'].every((k) => ratios.analytics[k] >= 4.5) && ratios.analytics.line >= 3 && ratios.analytics.refEdge >= 3, JSON.stringify(ratios.analytics));
  check('Text tokens reach 4.5:1 on surface and canvas; white on blue ink and on ink too', Object.values(ratios.text).every((r) => r >= 4.5) && ratios.onAccent >= 4.5 && ratios.onInk >= 4.5, JSON.stringify(ratios));
  check('Bar text, the trust line and the UTC readout reach 4.5:1 on their grounds', ratios.barText >= 4.5 && ratios.barTrust >= 4.5 && ratios.lcd >= 4.5, JSON.stringify(ratios));
  check('Control borders and the reference series reach 3:1', ratios.control >= 3 && ratios.series2 >= 3, JSON.stringify(ratios));

  // ---------- Reduced motion ----------
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/dashboard.html`);
  await page.locator('.xck-hero-num').waitFor();
  check('Reduced motion: tool-page buttons and checkboxes do not animate', await page.evaluate(() => [...document.querySelectorAll('button, input[type=checkbox], .xck-nav a')].every((el) => getComputedStyle(el).transitionDuration.split(',').every((d) => parseFloat(d) === 0))));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/receipt.html`);
  await page.locator('.stage-frame .art').waitFor();
  await page.locator('.xck-colourways .xck-swatch-dot').nth(1).hover();
  await page.mouse.down();
  const rm = await page.evaluate(() => [...document.querySelectorAll('.xck-swatch-dot, .xck-scene, .xck-actions button')].map((el) => getComputedStyle(el).scale).filter((v) => v !== 'none' && v !== '1'));
  await page.mouse.up();
  check('Reduced motion: receipt swatches and scene buttons do not grow or shrink', rm.length === 0, rm.join(','));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.xck-colourways .xck-swatch-dot').nth(2).hover();
  check('Normal motion keeps the swatch hover response', await page.locator('.xck-colourways .xck-swatch-dot').nth(2).evaluate((el) => getComputedStyle(el).scale) !== 'none');

  // ---------- Rewards share card ----------
  await page.goto(`${base}/dashboard.html`);
  await page.locator('.xck-hero-num').waitFor();
  check('Rewards with a reading shows the share card', await page.locator('canvas.card-preview').isVisible());
  // Product rule 6: the mark and its blue ink belong only to a reading the extension captured.
  const captured = await page.evaluate(() => { const stamp = document.querySelector('.xck-hero .xck-stamp'); return { text: stamp?.textContent, open: stamp && getComputedStyle(stamp, '::before').content, color: getComputedStyle(document.querySelector('.xck-hero-num')).color }; });
  check('A captured reading carries the bracketed Captured from X mark and is set in blue ink', captured.text === 'Captured from X' && /\[/.test(captured.open) && captured.color === 'rgb(33, 64, 201)', JSON.stringify(captured));
  await page.locator('label', { hasText: 'is correct for' }).locator('input[type=checkbox]').check();
  const download = page.waitForEvent('download');
  await page.locator('.xck-panel', { hasText: 'EOD share card' }).getByRole('button', { name: 'Download PNG' }).click();
  const file = (await download).suggestedFilename();
  check('Share-card file is named for the account shown', file.startsWith('samplecreator-day-'), file);

  // ---------- Receipts chrome ----------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/receipt.html`);
  await page.locator('.stage-frame .art').waitFor();
  check('Receipts page head: tool title, then the kit', (await page.locator('.xck-receipt-head h1').textContent()) === 'Receipts' && /X Creator Kit/.test(await page.locator('.xck-receipt-head').textContent()));
  check('Receipts keeps no duplicate Following setting; navigation reaches it', await page.locator('#followback-enabled').count() === 0 && await page.getByRole('navigation', { name: 'Kit tools' }).getByRole('link', { name: 'Following settings' }).count() === 1);
  await page.locator('.xck-scene[title="Diner check"]').click();
  await page.locator('.stage-frame .s3 .top').waitFor({ state: 'attached' });
  const dinerTop = await page.locator('.stage-frame .s3 .top').evaluate((el) => { const s = getComputedStyle(el); return { pad: s.paddingTop, border: s.borderBottomWidth, min: s.minHeight }; });
  check('Page-head styles do not leak into the Diner check receipt', dinerTop.pad === '0px' && dinerTop.border === '0px' && dinerTop.min !== '78px', JSON.stringify(dinerTop));
  const pinned = await page.locator('.stage-frame').evaluate((el) => ({ ink: getComputedStyle(el).getPropertyValue('--ink').trim(), color: getComputedStyle(el).color }));
  check('The receipt stage hands the artwork its previous inherited ink, not the UI text colour', pinned.ink === '#1b1a17' && pinned.color === 'rgb(27, 26, 23)', JSON.stringify(pinned));
  const period = await page.locator('.xck-period').evaluate((el) => ({ radius: getComputedStyle(el).borderRadius, on: getComputedStyle(el.querySelector('.on')).backgroundColor }));
  check('Receipt period uses the kit segmented control', period.radius === '10px' && period.on === INK, JSON.stringify(period));
  // No UI class from the tool pages may match an element inside any artwork.
  const leaks = await page.evaluate(() => [...document.querySelectorAll('.stage-frame [class]')].flatMap((el) => [...el.classList].filter((c) => c.startsWith('xck-'))));
  check('Artwork carries no xck- UI classes', leaks.length === 0, leaks.join(','));

  check('No page errors', errors.length === 0, errors.join('\n'));
  check('Design pages make no web requests', requests.length === 0, requests.join(', '));
  console.log(`${checks}/${checks} design checks passed. Screenshots in ${shots}/`);
} finally {
  await ctx.close();
}
