// Built-extension smoke test. All post markup and images are synthetic.
import { chromium } from 'playwright';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Headless Chrome cannot confirm its native optional-host prompt. Pregrant x.com in a
// throwaway copy solely for this synthetic verifier; the shipped manifest stays unchanged.
const dist = mkdtempSync(join(tmpdir(), 'xck-postcard-dist-'));
cpSync(resolve('dist'), dist, { recursive: true });
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://x.com/*'];
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest));
const output = resolve('verification'); mkdirSync(output, { recursive: true });
const executablePath = [process.env.CHROMIUM_PATH, chromium.executablePath()].find((p) => p && existsSync(p));
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-postcard-')), { executablePath, headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`], viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const checks = []; const errors = []; const requests = [];
const pick = (p, name, value) => p.locator(`input[name="${name}"][value="${value}"]`).check();
function check(name, yes, detail = '') { checks.push(!!yes); console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
ctx.on('request', (request) => {
  const url = request.url();
  const fixtureNavigation = request.isNavigationRequest() && url === 'https://x.com/home';
  const fixtureAvatar = request.resourceType() === 'image' && (url === 'https://pbs.twimg.com/profile_images/remote.jpg' || url.startsWith('https://pbs.twimg.com/profile_images/fixture/'));
  const photoNavigation = request.isNavigationRequest() && url === 'https://x.com/photos';
  if (/^https?:/.test(url) && !fixtureNavigation && !photoNavigation && !fixtureAvatar) requests.push(url);
});
ctx.on('page', (page) => page.on('pageerror', (e) => errors.push(String(e))));
const ext = await ctx.newPage(); await ext.goto('chrome://extensions');
const ids = await ext.evaluate(() => [...(document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item') ?? [])].map((e) => e.id));
check('Extension loaded', ids.length === 1, ids.join(','));
const base = `chrome-extension://${ids[0]}`;
const shippedManifest = JSON.parse(readFileSync(resolve('dist/manifest.json'), 'utf8'));
check('Shipped manifest adds no host permission or remote avatar access', !shippedManifest.host_permissions && !JSON.stringify(shippedManifest).includes('pbs.twimg.com'));
const fixture = readFileSync('test/fixtures/postcard.html', 'utf8');
await ctx.route('https://x.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
await ctx.route('https://pbs.twimg.com/**', (route) => route.abort());
const x = await ctx.newPage(); await x.goto('https://x.com/home');
const consentWorker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
const consentPrompt = ctx.waitForEvent('page');
await consentWorker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://x.com/home' });
  chrome.contextMenus.onClicked.dispatch({ menuItemId: 'postcard', pageUrl: tab.url, frameId: 0, editable: false }, tab);
});
const grant = await consentPrompt; await grant.waitForLoadState();
check('An existing host grant cannot bypass the photo disclosure', grant.url().endsWith('#grant') && await grant.locator('#post-data-disclosure').isVisible() && await grant.evaluate(async () => !(await chrome.storage.session.get('xck:postcard'))['xck:postcard']));
check('Photo disclosure is visible before consent', await grant.locator('#post-data-disclosure').isVisible() && /screenshots the visible tab/.test(await grant.locator('#post-data-disclosure').textContent()));
await grant.evaluate(() => { chrome.permissions.request = async () => false; });
await grant.getByRole('button', { name: 'Agree and enable post images' }).click();
await grant.getByRole('button', { name: 'Access was not enabled. Try again.' }).waitFor();
check('Refusing access stores no post-image consent', await grant.evaluate(async () => (await chrome.storage.local.get('xck:postcard-consent'))['xck:postcard-consent'] !== 1));
await grant.reload();
await grant.getByRole('button', { name: 'Agree and enable post images' }).click();
await grant.waitForTimeout(1200);
const grantLabel = await grant.locator('#app button').textContent();
check('Grant control recognizes pregranted x.com access', /Access enabled/.test(grantLabel), grantLabel);
const registered = await grant.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
check('Target listener registered with x.com access', registered.includes('xck-postcard-target'), registered.join(','));
const tabId = await grant.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/home' }))[0]?.id);
check('Synthetic X tab visible after grant', Number.isInteger(tabId), String(tabId));
const collect = () => grant.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'xck:postcard:collect' }, { frameId: 0 }), tabId);
await x.locator('body').dispatchEvent('contextmenu');
check('Right click outside a post is rejected', !(await collect()).ok);
await x.locator('#second [data-testid="quote"] [data-testid="tweetText"]').dispatchEvent('contextmenu');
check('Ambiguous nested quote is rejected', !(await collect()).ok);
await x.locator('#second > [data-testid="tweetText"]').dispatchEvent('contextmenu');
const second = await collect();
check('Second feed article chosen, not first', second.ok && second.post.id === '222' && second.post.text.includes('Hello') && !second.post.text.includes('Quoted text'));
check('Remote avatar omitted and absent counts unknown', second.ok && second.post.avatar === null && second.post.counts.replies === null && second.post.counts.likes === '3');
await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');
const first = await collect();
check('Inline synthetic avatar read for rendering', first.ok && first.post.id === '111' && first.post.avatar?.startsWith('data:image/png;base64,'));
await x.locator('#rich [data-testid="tweetText"]').dispatchEvent('contextmenu');
const rich = await collect();
check('Inline emoji and breaks survive selection without nested quote text', rich.ok && rich.post.author === 'Rocket 🚀' && rich.post.text === 'Hello 🚀\nFirst\nSecond', JSON.stringify(rich));
await grant.evaluate(async (id) => {
  await chrome.tabs.sendMessage(id, { type: 'xck:postcard:disable' });
  await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, files: ['postcard-target.js'] });
  await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, files: ['postcard-target.js'] });
}, tabId);
await x.locator('#first [data-testid="tweetText"]').dispatchEvent('contextmenu');
const restored = await collect();
check('Reinjection after disable restores exactly one working target listener', restored.ok && restored.post.id === '111');

await x.locator('#second > [data-testid="tweetText"]').dispatchEvent('contextmenu');
await x.locator('#second').evaluate((el) => el.remove());
check('Detached stale article rejected', !(await collect()).ok);
// The native browser context-menu UI is not controllable in headless Playwright. Seed the
// background's single pending record with the parsed synthetic card to exercise its editor handoff.
const token = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
await grant.evaluate(async ({ token, tabId, post }) => chrome.storage.session.set({ 'xck:postcard': { token, tabId, post } }), { token, tabId, post: first.post });
const denied = await grant.evaluate(async (token) => chrome.runtime.sendMessage({ type: 'xck:postcard:get', token }), token);
check('Card request from wrong extension page denied', denied?.ok === false);
const editor = await ctx.newPage(); await editor.goto(`${base}/postcard.html#${token}`);
await editor.waitForSelector('.postcard-text');
check('Editor shows author, post text and inline avatar', /First Creator/.test(await editor.locator('.postcard-name').textContent()) && /First post/.test(await editor.locator('.postcard-text').textContent()) && await editor.locator('.postcard-avatar img').count() === 1);
await editor.evaluate(() => document.fonts.ready); await editor.waitForTimeout(200);
const shortLayout = await editor.locator('.postcard-scale > .postcard').evaluate((card) => ({ body: parseFloat(getComputedStyle(card.querySelector('.postcard-text')).fontSize), post: card.querySelector('.postcard-post').offsetHeight, card: card.offsetHeight, top: card.querySelector('.postcard-post').offsetTop, safe: card.querySelector('.postcard-safe').offsetHeight }));
// A short post stays at reading size on a content-height post, centred on the field, never blown up into a poster.
check('Short post keeps reading size on a centred, content-height post', shortLayout.body === 50 && shortLayout.post < shortLayout.card * 0.6 && shortLayout.top > 100, JSON.stringify(shortLayout));
check('Unknown counts render as dashes', /— reposts/.test(await editor.locator('.postcard-meta').textContent()));
await pick(editor, 'postcard-style', 'frame');
check('Style changes preview', await editor.locator('.postcard.frame').count() === 1);
check('Four card styles offered as one named radio group', await editor.getByRole('group', { name: 'Style' }).getByRole('radio').count() === 4);
check('Six named backgrounds offered', JSON.stringify(await editor.locator('.xck-post-swatches input').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))) === JSON.stringify(['Paper background', 'Sage background', 'Clay background', 'Sky background', 'Cobalt background', 'Ink background']));
await editor.getByLabel('Sage background', { exact: true }).check();
check('Background changes preview', /#c9d6c3/.test(await editor.locator('.postcard').getAttribute('style')) && await editor.locator('.postcard').evaluate((el) => getComputedStyle(el).backgroundColor) === 'rgb(201, 214, 195)');
await pick(editor, 'postcard-style', 'ink');
check('Dark style sets a dark post on the chosen field', await editor.locator('.postcard.ink').evaluate((el) => getComputedStyle(el).backgroundColor === 'rgb(201, 214, 195)' && getComputedStyle(el.querySelector('.postcard-post')).backgroundColor === 'rgb(22, 24, 27)' && getComputedStyle(el.querySelector('.postcard-text')).color === 'rgb(238, 236, 230)'));
await editor.getByLabel('Cobalt background', { exact: true }).check();
check('Dark field turns the brand line light', await editor.locator('.postcard.ink.on-dark .postcard-brand').evaluate((el) => { const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number); return r + g + b > 450; }));
await editor.getByLabel('Sage background', { exact: true }).check();
await pick(editor, 'postcard-style', 'frame');
await editor.locator('#postcard-counts').uncheck();
check('Counts can be hidden', await editor.locator('.postcard-meta').count() === 0);
for (const style of ['paper', 'ink', 'frame', 'type']) {
  await pick(editor, 'postcard-style', style);
  const without = await editor.locator('.postcard-post').evaluate((el) => el.offsetHeight);
  await editor.locator('#postcard-counts').check();
  const withCounts = await editor.locator('.postcard-post').evaluate((el) => el.offsetHeight);
  await editor.locator('#postcard-counts').uncheck();
  check(`${style}: hiding counts removes the row and its space`, withCounts - without >= 30, `${withCounts} → ${without}`);
}
await pick(editor, 'postcard-style', 'frame');
await editor.locator('#postcard-counts').check();
for (const [format, width, height] of [['portrait', 1080, 1350], ['landscape', 1200, 675]]) {
  await pick(editor, 'postcard-format', format);
  const download = editor.waitForEvent('download', { timeout: 5000 }); await editor.getByRole('button', { name: 'Download PNG' }).click();
  let file; try { file = await (await download).path(); } catch { throw new Error(`Download failed: ${await editor.locator('.xck-post-feedback').textContent()}`); }
  const bytes = readFileSync(file);
  writeFileSync(join(output, `postcard-${format}.png`), bytes);
  const pixels = await editor.evaluate(async (b64) => { const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img,0,0); const data = g.getImageData(0,0,c.width,c.height).data; let dark = 0, light = 0; for(let i=0;i<data.length;i+=400){ if(data[i]+data[i+1]+data[i+2]<300) dark++; if(data[i]+data[i+1]+data[i+2]>550) light++; } return { w:img.width, h:img.height, dark, light }; }, bytes.toString('base64'));
  check(`${format} PNG dimensions and nonblank pixels`, pixels.w === width && pixels.h === height && pixels.dark > 10 && pixels.light > 10, JSON.stringify(pixels));
}
// Preview and export parity: at scale 1 the editor preview and the exported PNG are the same picture.
const samePicture = (a, b) => editor.evaluate(async ([a, b]) => {
  const image = async (s) => { const img = new Image(); img.src = `data:image/png;base64,${s}`; await img.decode(); return img; };
  const [pa, pb] = await Promise.all([image(a), image(b)]);
  // The landscape preview cannot reach scale 1 in the editor column: draw the export at the preview's size.
  const pixels = (img) => { const c = document.createElement('canvas'); c.width = pa.width; c.height = pa.height; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height); return g.getImageData(0, 0, c.width, c.height); };
  if (Math.abs(pa.width / pa.height - pb.width / pb.height) > 0.01) return { size: [pa.width, pa.height, pb.width, pb.height] };
  const [x, y] = [pixels(pa), pixels(pb)];
  let off = 0; for (let i = 0; i < x.data.length; i += 4) if (Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2])) > 48) off++;
  return { off: off / (x.width * x.height), size: [pa.width, pb.width] };
}, [a, b]);
await editor.setViewportSize({ width: 1500, height: 1900 }); await editor.waitForTimeout(250);
for (const [style, format] of [['paper', 'portrait'], ['ink', 'landscape'], ['frame', 'portrait'], ['type', 'landscape']]) {
  await pick(editor, 'postcard-style', style); await pick(editor, 'postcard-format', format); await editor.waitForTimeout(150);
  const unscaled = format === 'landscape' || await editor.locator('.postcard-scale').evaluate((el) => el.style.transform === 'scale(1)');
  const shot = (await editor.locator('.postcard-scale').screenshot()).toString('base64');
  const download = editor.waitForEvent('download', { timeout: 5000 }); await editor.getByRole('button', { name: 'Download PNG' }).click();
  const png = readFileSync(await (await download).path()).toString('base64');
  const diff = await samePicture(shot, png);
  check(`${style} ${format}: preview and exported PNG are the same picture`, unscaled && diff.off < 0.01, JSON.stringify(diff));
}
await editor.setViewportSize({ width: 1280, height: 900 }); await editor.waitForTimeout(200);
await pick(editor, 'postcard-style', 'frame'); await pick(editor, 'postcard-format', 'portrait');
await editor.getByRole('button', { name: 'Copy image' }).click();
await editor.waitForFunction(() => /Image copied|Could not export/.test(document.querySelector('.xck-post-feedback')?.textContent ?? ''));
check('Copy image writes a PNG', /Image copied/.test(await editor.locator('.xck-post-feedback').textContent()));
const token2 = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
await grant.evaluate(async ({ token, tabId, post }) => chrome.storage.session.set({ 'xck:postcard': { token, tabId, post } }), { token: token2, tabId, post: second.post });
const unsafe = await ctx.newPage(); await unsafe.goto(`${base}/postcard.html#${token2}`); await unsafe.waitForSelector('.postcard-text');
check('Injection text remains inert in editor', (await unsafe.locator('.postcard-text').textContent()).includes('<img src=x onerror=alert(1)>') && await unsafe.locator('.postcard-text img').count() === 0);
const richToken = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
if (rich.ok) {
  await grant.evaluate(async ({ token, tabId, post }) => chrome.storage.session.set({ 'xck:postcard': { token, tabId, post } }), { token: richToken, tabId, post: rich.post });
  const richEditor = await ctx.newPage(); await richEditor.goto(`${base}/postcard.html#${richToken}`); await richEditor.waitForSelector('.postcard-text');
  check('Editor displays emoji and explicit breaks', await richEditor.locator('.postcard-name').textContent() === 'Rocket 🚀' && await richEditor.locator('.postcard-text').textContent() === 'Hello 🚀\nFirst\nSecond', JSON.stringify({ name: await richEditor.locator('.postcard-name').textContent(), body: await richEditor.locator('.postcard-text').textContent() }));
}
// ---------- Populated editor: grouped named controls, preview with its actions, errors that say what to do ----------
await pick(editor, 'postcard-style', 'paper'); await pick(editor, 'postcard-format', 'portrait');
for (const name of ['Style', 'Background', 'Details', 'Image size']) check(`Editor control group "${name}" is named`, await editor.getByRole('group', { name, exact: true }).count() === 1);
const layoutBoxes = await editor.evaluate(() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  return { preview: r('.xck-post-preview'), copy: r('button[data-export="copy"]'), controls: r('.xck-post-controls') };
});
check('Preview first, its settings dock and export directly under it and in view', layoutBoxes.preview.width >= 900 && layoutBoxes.controls.top >= layoutBoxes.preview.bottom && layoutBoxes.copy.top >= layoutBoxes.preview.bottom && layoutBoxes.copy.top - layoutBoxes.preview.bottom < 120 && layoutBoxes.copy.bottom <= 900, JSON.stringify(layoutBoxes));
check('Output size is stated beside the actions', (await editor.locator('.xck-post-output').textContent()) === 'PNG · 1080 × 1350');
check('Styles are named for what they look like', JSON.stringify(await editor.getByRole('group', { name: 'Style' }).getByRole('radio').evaluateAll((els) => els.map((el) => el.parentElement.textContent))) === JSON.stringify(['Light', 'Dark', 'Framed', 'Feed']));
await editor.getByRole('radio', { name: 'Light', exact: true }).focus();
await editor.keyboard.press('ArrowRight');
check('Arrow keys move through styles and update the preview', await editor.locator('.postcard.ink').count() === 1 && await editor.getByRole('radio', { name: 'Dark', exact: true }).isChecked());
const ring = await editor.locator('.xck-post-segments label:has(input:focus-visible)').evaluate((el) => ({ outline: getComputedStyle(el).outlineStyle, offset: parseFloat(getComputedStyle(el).outlineOffset), bg: getComputedStyle(el).backgroundColor }));
// Was a cobalt fill. Selected is now an ink face; the ring sits outside it with a gap, so the two stay distinct.
check('Keyboard focus ring is distinct from the selected fill', ring.outline !== 'none' && ring.offset >= 2 && ring.bg === 'rgb(19, 19, 19)', JSON.stringify(ring));
await editor.evaluate(() => { navigator.clipboard.write = async () => { throw new Error('Clipboard access was denied'); }; });
await editor.getByRole('button', { name: 'Copy image' }).click();
await editor.waitForFunction(() => /Could not copy/.test(document.querySelector('.xck-post-feedback')?.textContent ?? ''));
check('Copy failure names the problem and the recovery', /Could not copy the image \(Clipboard access was denied\)\. Use Download PNG instead\./.test(await editor.locator('.xck-post-feedback').textContent()) && await editor.locator('.xck-post-feedback.error').count() === 1);
// Compare both layouts in the same animation frame: the Copy key is still
// returning from its pressed position when clipboard feedback arrives.
const feedbackLayout = await editor.evaluate(() => {
  const copy = document.querySelector('button[data-export="copy"]');
  const message = document.querySelector('.xck-post-feedback');
  const measure = () => ({ button: copy.getBoundingClientRect().toJSON(), height: message.offsetHeight });
  const before = measure();
  message.textContent = 'This synthetic clipboard message wraps across multiple lines. '.repeat(10);
  return { before, after: measure() };
});
check('Feedback below the actions never moves them', feedbackLayout.after.height > feedbackLayout.before.height
  && JSON.stringify(feedbackLayout.before.button) === JSON.stringify(feedbackLayout.after.button), JSON.stringify(feedbackLayout));
await pick(editor, 'postcard-style', 'frame');
await editor.emulateMedia({ reducedMotion: 'reduce' });
await editor.locator('.xck-post-swatches label').nth(1).hover();
check('Reduced motion: swatch hover does not grow', await editor.locator('.xck-post-swatches label').nth(1).locator('span').evaluate((el) => getComputedStyle(el).scale === 'none' || getComputedStyle(el).scale === '1'));
await editor.emulateMedia({ reducedMotion: 'no-preference' });
await editor.screenshot({ path: join(output, 'postcard-editor.png'), fullPage: true });
for (const width of [390, 320]) {
  await editor.setViewportSize({ width, height: 844 });
  await editor.waitForTimeout(200);
  const narrow = await editor.evaluate(() => ({ wide: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().width > innerWidth + 1 && !el.closest('.postcard-scale')).slice(0, 6).map((el) => el.className), overflow: document.documentElement.scrollWidth - innerWidth, preview: document.querySelector('.postcard-scale').getBoundingClientRect().width, previewTop: document.querySelector('.xck-post-preview').getBoundingClientRect().top, controlsTop: document.querySelector('.xck-post-controls').getBoundingClientRect().top }));
  check(`${width}px: preview first, full width, no sideways scroll`, narrow.overflow <= 0 && narrow.preview >= width - 60 && narrow.previewTop < narrow.controlsTop, JSON.stringify(narrow));
  await editor.screenshot({ path: join(output, `postcard-editor-${width}.png`), fullPage: true });
}
await editor.setViewportSize({ width: 1280, height: 900 });
const mediumToken = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
const mediumPost = { ...first.post, text: 'Build something useful and share what you learned. '.repeat(6).trim() };
await grant.evaluate(async ({ token, tabId, post }) => chrome.storage.session.set({ 'xck:postcard': { token, tabId, post } }), { token: mediumToken, tabId, post: mediumPost });
const medium = await ctx.newPage(); await medium.goto(`${base}/postcard.html#${mediumToken}`); await medium.waitForSelector('.postcard-text');
await medium.evaluate(() => document.fonts.ready);
for (const format of ['portrait', 'landscape']) {
  await pick(medium, 'postcard-format', format);
  for (const style of ['paper', 'ink', 'frame', 'type']) {
    await pick(medium, 'postcard-style', style);
    const fits = await medium.locator('.postcard-text').evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
    check(`${style}: complete multi-line text fits ${format} without clipping`, fits && !(await medium.getByRole('button', { name: 'Download PNG' }).isDisabled()));
  }
}
const wideToken = 'ffffffff-ffff-4fff-ffff-ffffffffffff';
const widePost = { ...first.post, author: 'W'.repeat(50), text: mediumPost.text };
await grant.evaluate(async ({ token, tabId, post }) => chrome.storage.session.set({ 'xck:postcard': { token, tabId, post } }), { token: wideToken, tabId, post: widePost });
const wide = await ctx.newPage(); await wide.goto(`${base}/postcard.html#${wideToken}`); await wide.waitForSelector('.postcard-text');
await wide.evaluate(() => document.fonts.ready);
for (const format of ['portrait', 'landscape']) {
  await pick(wide, 'postcard-format', format);
  for (const style of ['paper', 'ink', 'frame', 'type']) {
    await pick(wide, 'postcard-style', style);
    const contained = await wide.locator('.postcard').evaluate((card) => {
      const top = card.querySelector('.postcard-top');
      const name = card.querySelector('.postcard-name');
      const handle = card.querySelector('.postcard-handle');
      const bounds = card.getBoundingClientRect();
      const header = top.getBoundingClientRect();
      return [top, name, handle].every((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) &&
        [name, handle].every((el) => { const rect = el.getBoundingClientRect(); return rect.left >= header.left - 1 && rect.right <= header.right + 1 && rect.top >= header.top - 1 && rect.bottom <= header.bottom + 1; }) &&
        header.left >= bounds.left - 1 && header.right <= bounds.right + 1 && header.top >= bounds.top - 1 && header.bottom <= bounds.bottom + 1;
    });
    const bodyFits = await wide.locator('.postcard-text').evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
    const disabled = await wide.getByRole('button', { name: 'Download PNG' }).isDisabled();
    const detail = contained && bodyFits && !disabled ? '' : JSON.stringify({ contained, bodyFits, disabled, top: await wide.locator('.postcard-top').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.getBoundingClientRect().height })), name: await wide.locator('.postcard-name').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.getBoundingClientRect().height })) });
    check(`${style}: 50-W author contained with normal body in ${format}`, contained && bodyFits && !disabled, detail);
  }
  const download = wide.waitForEvent('download', { timeout: 5000 });
  await wide.getByRole('button', { name: 'Download PNG' }).click();
  const png = readFileSync(await (await download).path());
  const [width, height] = format === 'portrait' ? [1080, 1350] : [1200, 675];
  check(`50-W author exports a ${format} PNG`, png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === width && png.readUInt32BE(20) === height);
}
await wide.evaluate(() => { const style = document.createElement('style'); style.id = 'force-header-overflow'; style.textContent = '.postcard-name{white-space:nowrap!important}'; document.head.append(style); });
await pick(wide, 'postcard-style', 'paper');
check('Clipped header disables both exports', await wide.getByRole('button', { name: 'Download PNG' }).isDisabled() && await wide.getByRole('button', { name: 'Copy image' }).isDisabled() && /too long/i.test(await wide.locator('.xck-post-feedback').textContent()));
await wide.getByRole('button', { name: 'Download PNG' }).evaluate((button) => { button.disabled = false; button.click(); });
await wide.waitForFunction(() => /Could not export/.test(document.querySelector('.xck-post-feedback')?.textContent ?? ''));
check('PNG exporter independently refuses a clipped header', /too long/i.test(await wide.locator('.xck-post-feedback').textContent()));
await wide.evaluate(() => document.getElementById('force-header-overflow')?.remove());
await pick(wide, 'postcard-style', 'frame');
check('Header export recovers when layout fits', !(await wide.getByRole('button', { name: 'Download PNG' }).isDisabled()));
const longToken = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const longPost = { ...first.post, text: 'A complete sentence about creating useful things. '.repeat(60) };
await grant.evaluate(async ({ token, tabId, post }) => chrome.storage.session.set({ 'xck:postcard': { token, tabId, post } }), { token: longToken, tabId, post: longPost });
const longEditor = await ctx.newPage(); await longEditor.goto(`${base}/postcard.html#${longToken}`); await longEditor.waitForSelector('.postcard-text');
await pick(longEditor, 'postcard-format', 'landscape');
await longEditor.waitForTimeout(300);
check('Long text is retained and blocked from silently clipped exports',
  (await longEditor.locator('.postcard-text').textContent()) === longPost.text &&
  await longEditor.getByRole('button', { name: 'Download PNG' }).isDisabled() &&
  /too long/i.test(await longEditor.locator('.xck-post-feedback').textContent()));

// ---------- Profile photo: the real context-menu handler copies the visible photo, or says why not ----------
// The x.com-only context above cannot screenshot: Chrome grants that through activeTab when a person clicks the
// menu item, which headless Playwright cannot do. A dispatched click there must still produce a card, with initials
// and the note. A second throwaway copy then adds <all_urls> to stand in for that grant, so the crop, its guards and
// its pixels run through the real background code. The native activeTab path stays a manual check.
const photoPng = await (async () => {
  const page = await ctx.newPage();
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d'); [['#dc2828', 0, 0], ['#28aa46', 48, 0], ['#2850dc', 0, 48], ['#f0c828', 48, 48]].forEach(([f, x, y]) => { g.fillStyle = f; g.fillRect(x, y, 48, 48); }); return c.toDataURL('image/png').split(',')[1]; });
  await page.close(); return Buffer.from(b64, 'base64');
})();
const photoFixture = readFileSync('test/fixtures/postcard-avatar.html', 'utf8');
const servePhotos = async (context) => {
  await context.route('https://x.com/photos', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: photoFixture }));
  await context.route('https://pbs.twimg.com/profile_images/fixture/**', (route) => route.request().url().endsWith('/quadrants.png') ? route.fulfill({ status: 200, contentType: 'image/png', body: photoPng }) : route.fulfill({ status: 404, body: '' }));
};
const worker = async (context) => context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker');
/** Right-click a synthetic post, then deliver the menu click to the background's real handler. */
async function menuClick(context, page, selector) {
  await page.bringToFront();
  // Settle the preceding disclosure-tab switch before beginning the capture interval.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator(selector).dispatchEvent('contextmenu');
  const sw = await worker(context);
  const opened = context.waitForEvent('page');
  await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://x.com/photos' }); chrome.contextMenus.onClicked.dispatch({ menuItemId: 'postcard', pageUrl: tab.url, frameId: 0, editable: false }, tab); });
  const card = await opened; await card.waitForLoadState();
  const record = await sw.evaluate(async () => (await chrome.storage.session.get('xck:postcard'))['xck:postcard']);
  return { card, record };
}
await servePhotos(ctx);
await x.goto('https://x.com/photos'); await x.waitForFunction(() => document.querySelector('#photo img').naturalWidth > 0);
const ungranted = await menuClick(ctx, x, '#photo [data-testid="tweetText"]');
await ungranted.card.waitForSelector('.postcard-text');
check('Without a screenshot grant the card still opens, with initials and a note saying how to get the photo', ungranted.record?.post?.id === '501' && ungranted.record.post.avatar === null && await ungranted.card.locator('.postcard-avatar span').textContent() === 'PP' && /photo could not be copied/.test(await ungranted.card.locator('.xck-post-note').textContent()));
await ungranted.card.close();

const photoDist = mkdtempSync(join(tmpdir(), 'xck-postcard-photo-dist-'));
cpSync(resolve('dist'), photoDist, { recursive: true });
writeFileSync(join(photoDist, 'manifest.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(photoDist, 'manifest.json'), 'utf8')), host_permissions: ['https://x.com/*', '<all_urls>'] }));
const photoRequests = [];
const pctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'xck-postcard-photo-')), { executablePath, headless: true, args: [`--disable-extensions-except=${photoDist}`, `--load-extension=${photoDist}`], viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2, acceptDownloads: true });
pctx.on('request', (request) => {
  const url = request.url();
  if (/^https?:/.test(url) && !(request.isNavigationRequest() && url === 'https://x.com/photos') && !url.startsWith('https://pbs.twimg.com/profile_images/fixture/')) photoRequests.push(url);
});
pctx.on('page', (page) => page.on('pageerror', (e) => errors.push(String(e))));
await servePhotos(pctx);
const psw = await worker(pctx);
const photoBase = psw.url().split('/').slice(0, 3).join('/');
const helper = await pctx.newPage(); await helper.goto(`${photoBase}/postcard.html`);
check('Host permission alone does not register post selection', !(await helper.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === 'xck-postcard-target'))));
// The disclosure/permission UI is exercised above. Seed its accepted state in this separate crop
// context: Chromium's permission UI resizes its native window but not Playwright's emulated viewport.
await helper.evaluate(() => chrome.storage.local.set({ 'xck:postcard-consent': 1 }));
await helper.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).some(s => s.id === 'xck-postcard-target'));

const px = await pctx.newPage(); await px.goto('https://x.com/photos'); await px.waitForFunction(() => document.querySelector('#photo img').naturalWidth > 0);
const quadrants = (b64, box) => helper.evaluate(async ([b64, box]) => {
  const img = new Image(); img.src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const b = box ?? { x: 0, y: 0, size: img.width };
  const at = (fx, fy) => [...g.getImageData(Math.round(b.x + b.size * fx), Math.round(b.y + b.size * fy), 1, 1).data].slice(0, 3);
  return { width: img.width, height: img.height, tl: at(.3, .3), tr: at(.7, .3), bl: at(.3, .7), br: at(.7, .7) };
}, [b64, box]);
const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= 40);
const isQuadrants = (q) => near(q.tl, [220, 40, 40]) && near(q.tr, [40, 170, 70]) && near(q.bl, [40, 80, 220]) && near(q.br, [240, 200, 40]);

const ok = await menuClick(pctx, px, '#photo [data-testid="tweetText"]');
const photo = ok.record?.post?.avatar;
check('Current X action labels and analytics link capture all counts at displayed precision', ['replies', 'reposts', 'likes', 'views'].every((key, i) => ok.record?.post?.counts[key] === ['0', '14', '2.3K', '45K'][i]), JSON.stringify(ok.record?.post?.counts));
check('Captured counts reach the photo editor', await ok.card.locator('.postcard-meta').textContent() === '0 replies 14 reposts 2.3K likes 45K views');
const pixels = photo ? await quadrants(photo) : null;
// Headless Chrome screenshots at CSS pixels even with a 2x device scale, so the 48 px photo crops to 46 px here.
check('Visible profile photo is copied from the right-clicked post', !!pixels && isQuadrants(pixels) && pixels.width === pixels.height && pixels.width >= 46, JSON.stringify(pixels));
check('Only the small photo is kept, never the screenshot', /^data:image\/png;base64,/.test(photo ?? '') && photo.length < 150_000 && JSON.stringify(ok.record).length < photo.length + 2000, String(JSON.stringify(ok.record ?? null).length));
await ok.card.waitForSelector('.postcard-avatar img');
check('Editor draws the copied photo and shows no fallback note', await ok.card.locator('.postcard-avatar img').count() === 1 && await ok.card.locator('.xck-post-note').count() === 0);
for (const [style, format] of [['paper', 'portrait'], ['type', 'landscape']]) {
  await pick(ok.card, 'postcard-style', style); await pick(ok.card, 'postcard-format', format); await ok.card.waitForTimeout(150);
  const box = await ok.card.locator('.postcard-scale > .postcard').evaluate((card) => { const k = card.getBoundingClientRect().width / card.offsetWidth; const c = card.getBoundingClientRect(), a = card.querySelector('.postcard-avatar').getBoundingClientRect(); return { x: (a.left - c.left) / k, y: (a.top - c.top) / k, size: a.width / k }; });
  const download = ok.card.waitForEvent('download', { timeout: 5000 }); await ok.card.getByRole('button', { name: 'Download PNG' }).click();
  const png = readFileSync(await (await download).path());
  writeFileSync(join(output, `postcard-photo-${style}-${format}.png`), png);
  const exported = await quadrants(png.toString('base64'), box);
  check(`${style} ${format}: exported PNG carries the copied photo`, isQuadrants(exported), JSON.stringify({ box, exported }));
}
await ok.card.close();
for (const [name, selector, before] of [
  ['photo of another account', '#wrong [data-testid="tweetText"]'],
  ['photo after the post text, as in a quoted post', '#order [data-testid="tweetText"]'],
  ['photo covered by another element', '#covered [data-testid="tweetText"]'],
  ['photo that never loaded', '#broken [data-testid="tweetText"]'],
  ['photo cut off at the edge of the screen', '#far [data-testid="tweetText"]', () => px.evaluate(() => { const r = document.querySelector('#far [data-testid="Tweet-User-Avatar"]').getBoundingClientRect(); scrollBy(0, r.top - innerHeight + 20); })],
]) {
  await before?.();
  const result = await menuClick(pctx, px, selector);
  await result.card.waitForSelector('.postcard-text');
  check(`No photo copied for a ${name}; initials and the note instead`, result.record?.post && result.record.post.avatar === null && await result.card.locator('.postcard-avatar img').count() === 0 && await result.card.locator('.xck-post-note').count() === 1, JSON.stringify(result.record?.post?.id));
  await result.card.close();
}
await px.evaluate(() => scrollTo(0, 0));
await px.evaluate(() => {
  const cover = document.createElement('div'); cover.id = 'thin-photo-cover';
  cover.style.cssText = 'position:fixed;z-index:100;left:0;top:0;width:100%;height:20px;background:#ff00ff';
  document.body.append(cover);
});
const thin = await menuClick(pctx, px, '#photo [data-testid="tweetText"]');
await thin.card.waitForSelector('.postcard-text');
check('A thin sticky header covering only the photo edge produces initials, not header pixels', thin.record?.post?.avatar === null && await thin.card.locator('.postcard-avatar span').count() === 1);
await thin.card.close(); await px.evaluate(() => document.getElementById('thin-photo-cover').remove());
// The page in front is not the post's tab: never screenshot it.
const other = await pctx.newPage(); await other.goto(`${photoBase}/postcard.html`);
await px.locator('#photo [data-testid="tweetText"]').dispatchEvent('contextmenu');
const openedBehind = pctx.waitForEvent('page');
await other.bringToFront();
await psw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: 'https://x.com/photos' }); chrome.contextMenus.onClicked.dispatch({ menuItemId: 'postcard', pageUrl: tab.url, frameId: 0, editable: false }, tab); });
const behind = await openedBehind; await behind.waitForSelector('.postcard-text');
const behindRecord = await psw.evaluate(async () => (await chrome.storage.session.get('xck:postcard'))['xck:postcard']);
check('No screenshot when the post’s tab is not the one showing', behindRecord?.post?.id === '501' && behindRecord.post.avatar === null);
await behind.close(); await other.close();
// After the screenshot the page must report the same post, photo box and scroll position.
const ptab = await helper.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/photos' }))[0].id);
const collectPhoto = async () => { await px.locator('#photo [data-testid="tweetText"]').dispatchEvent('contextmenu'); return helper.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'xck:postcard:collect' }, { frameId: 0 }), ptab); };
const recheck = (probe, token = got.avatarToken) => helper.evaluate(([id, probe, token]) => chrome.tabs.sendMessage(id, { type: 'xck:postcard:avatar-check', probe, token }, { frameId: 0 }), [ptab, probe, token]);
let got = await collectPhoto();
check('Photo report carries the device scale', got.ok && got.avatar?.dpr === 2 && got.avatar.size === 48, JSON.stringify(got.avatar));
check('Unchanged page confirms the photo once', (await recheck(got.avatar)).ok === true && (await recheck(got.avatar)).ok === false);
got = await collectPhoto(); await px.evaluate(() => scrollBy(0, 4));
check('Scrolling during the screenshot discards the photo', (await recheck(got.avatar)).ok === false);
await px.evaluate(() => scrollTo(0, 0));
got = await collectPhoto(); await px.evaluate(() => document.querySelector('#photo a[href="/photouser/status/501"]').setAttribute('href', '/photouser/status/599'));
check('A recycled post element discards the photo', (await recheck(got.avatar)).ok === false);
await px.evaluate(() => document.querySelector('#photo a[href="/photouser/status/599"]').setAttribute('href', '/photouser/status/501'));
got = await collectPhoto();
check('A photo box that does not match the page is refused', (await recheck({ ...got.avatar, x: got.avatar.x + 1 })).ok === false);
got = await collectPhoto();
await px.evaluate(() => scrollTo(0, 120));
// Real screenshot while another row occupies the old photo coordinates, then restore the endpoint.
await px.screenshot();
await px.evaluate(() => scrollTo(0, 0));
check('Scroll away, screenshot, scroll back cannot confirm another row’s pixels', (await recheck(got.avatar)).ok === false);
got = await collectPhoto();
await px.setViewportSize({ width: 950, height: 700 }); await px.screenshot();
await px.setViewportSize({ width: 1000, height: 700 });
check('Resize away and back invalidates the screenshot interval', (await recheck(got.avatar)).ok === false);
got = await collectPhoto();
// This headless build keeps background tabs visible. Exercise the delivered visibility event
// explicitly; actual OS tab-switch visibility is a native-browser check, not proved here.
await px.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
check('A visibility-change event invalidates the screenshot interval', (await recheck(got.avatar)).ok === false);
got = await collectPhoto();
await px.evaluate(() => {
  const link = document.querySelector('#photo a[href="/photouser/status/501"]');
  link.setAttribute('href', '/photouser/status/599'); link.setAttribute('href', '/photouser/status/501');
});
check('A post mutation that returns to the original identity still invalidates the photo', (await recheck(got.avatar)).ok === false);
const earlier = await collectPhoto();
await px.evaluate(() => document.querySelector('#photo a[href="/photouser/status/501"]').setAttribute('href', '/photouser/status/599'));
got = await collectPhoto();
check('Stale photo validation rejects the old request without consuming the new one', earlier.post.id === '501' && got.post.id === '599' && earlier.avatarToken !== got.avatarToken && (await recheck(earlier.avatar, earlier.avatarToken)).ok === false && (await recheck(got.avatar)).ok === true);
await px.evaluate(() => document.querySelector('#photo a[href="/photouser/status/599"]').setAttribute('href', '/photouser/status/501'));
check('Photo capture makes no requests of its own', photoRequests.length === 0, photoRequests.join(', '));
await pctx.close();
check('No extension-initiated external requests', requests.length === 0, requests.join(', '));
check('No page errors', errors.length === 0, errors.join(' | '));
await ctx.close();
const passed = checks.filter(Boolean).length; console.log(`\n${passed}/${checks.length} checks passed`); process.exit(passed === checks.length ? 0 : 1);
