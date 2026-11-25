// Exercises the shipped screenshot editor in a disposable extension profile. Every image is synthetic. Geometry and
// colour are asserted on the decoded files the editor saves, not on the preview.
// Run `npm run build` first. Pictures and exported fixtures land in verification/screenshot-editor/ (ignored by Git).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const profile = mkdtempSync(join(tmpdir(), 'xck-screenshot-'));
const dist = resolve('dist');
const out = resolve('verification/screenshot-editor');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const checks = [];
const ok = (name, value, detail = '') => { assert(value, `${name} ${detail}`); checks.push(name); };
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
// The catalogue is read from its source, so a wallpaper added there is checked here without an edit.
const ARTWORK = [...readFileSync('src/screenshot/wallpapers.ts', 'utf8').matchAll(/\{ id: '([^']+)', name: '([^']+)', file: '([^']+)'/g)].map(m => ({ id: m[1], name: m[2], file: m[3] }));

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
  headless: true, acceptDownloads: true, viewport: { width: 1440, height: 900 },
  args: ['--load-extension=' + dist, '--disable-extensions-except=' + dist],
});
try {
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const base = 'chrome-extension://' + new URL(worker.url()).host;
  const page = await ctx.newPage();
  const network = [], errors = [];
  page.on('request', r => { if (!/^(chrome-extension|data|blob):/.test(r.url())) network.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__decodes = 0;
    const real = window.createImageBitmap.bind(window);
    window.createImageBitmap = (...a) => { window.__decodes++; return real(...a); };
  });
  await page.goto(base + '/launcher.html');
  await page.getByRole('link', { name: 'Screenshot editor', exact: true }).last().click();
  await page.waitForURL('**/screenshot.html');

  // ---------- Helpers ----------
  const canvas = page.locator('#canvas');
  const status = text => page.waitForFunction(t => document.querySelector('#status').textContent.includes(t), text);
  const alertSays = text => page.waitForFunction(t => { const a = document.querySelector('#alert'); return !a.hidden && a.textContent.includes(t); }, text);
  const load = async (buffer, name = 'fixture.png', mimeType = 'image/png') => {
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await status(`${name} opened`);
  };
  const draw = (body, type = 'image/png', w = 400, hgt = 200) => page.evaluate(([body, type, w, hgt]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    new Function('g', body)(c.getContext('2d'));
    return c.toDataURL(type, 0.95).split(',')[1];
  }, [body, type, w, hgt]).then(b => Buffer.from(b, 'base64'));
  const tab = name => page.locator(`#tab-${name}`).click();
  const seg = (field, value) => page.locator(`[data-field=${field}] button[value=${value}]`).click();
  const setNum = async (id, v) => { await page.locator(`#${id}`).fill(String(v)); await page.locator(`#${id}`).press('Enter'); await page.locator(`#${id}`).blur(); };
  const undo = () => page.locator('#undo').click();
  const redo = () => page.locator('#redo').click();
  /** Export through the dialog, decode the saved file and return a sampler. */
  const save = async ({ format = 'PNG', scale = 1, file, quality } = {}) => {
    await page.locator('#export-open').click();
    await page.locator('#format button', { hasText: format }).click();
    await page.locator('#scale button').nth(scale - 1).click();
    if (quality) await page.locator('#quality').fill(String(quality));
    const pending = page.waitForEvent('download');
    await page.locator('#export-save').click();
    const dl = await pending;
    const bytes = readFileSync(await dl.path());
    if (file) writeFileSync(join(out, file), bytes);
    await page.locator('#export-close').click();
    const mime = { PNG: 'image/png', JPEG: 'image/jpeg', WebP: 'image/webp' }[format];
    const size = await page.evaluate(async ([b64, mime]) => {
      const img = new Image(); img.src = `data:${mime};base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      window.__out = g.getImageData(0, 0, c.width, c.height);
      return [c.width, c.height];
    }, [bytes.toString('base64'), mime]);
    const at = (x, y) => page.evaluate(([x, y]) => { const d = window.__out, i = (y * d.width + x) * 4; return [...d.data.slice(i, i + 3)]; }, [x, y]);
    return { bytes, name: dl.suggestedFilename(), size, at };
  };
  /** Bounds of every output pixel within `tol` of a colour. */
  const bounds = (rgb, tol = 6) => page.evaluate(([rgb, tol]) => {
    const d = window.__out; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
      const i = (y * d.width + x) * 4;
      if (rgb.every((v, k) => Math.abs(d.data[i + k] - v) <= tol)) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n } : null;
  }, [rgb, tol]);
  /** Drag across the canvas between two points given as fractions of it. */
  const drag = async (a, b, opts = {}) => {
    const r = await canvas.boundingBox();
    await page.mouse.move(r.x + r.width * a[0], r.y + r.height * a[1]);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * b[0], r.y + r.height * b[1], { steps: 6 });
    if (!opts.hold) await page.mouse.up();
  };
  const clickAt = async (x, y) => { const r = await canvas.boundingBox(); await page.mouse.click(r.x + r.width * x, r.y + r.height * y); };
  const tool = name => page.locator(`.ss-tool[value=${name}]`).click();
  const layers = () => page.locator('.ss-layer:not([data-key="layer:image"])').count();
  const pickImage = async () => { await tab('layers'); const row = page.locator('[data-key="layer:image"]'); if (await row.getAttribute('aria-pressed') !== 'true') await row.click(); };
  /** A bare frame: what is measured is exactly the screenshot on a white canvas. */
  const bare = async () => {
    await tab('frame');
    await setNum('padding-n', 0); await setNum('radius-n', 0);
    await seg('shadow', 'none'); await seg('border', 'none'); await seg('window', 'none');
    await tab('background'); await page.getByRole('button', { name: 'White', exact: true }).click();
  };

  // ---------- Empty state ----------
  ok('export, copy and tools wait for an image', await page.locator('#export-open').isDisabled() && await page.locator('#copy').isDisabled() && await page.locator('.ss-tool:enabled').count() === 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, '01-empty.png') });

  // ---------- Refusals happen before decoding ----------
  const pngHeader = (w, hgt) => { const b = Buffer.alloc(64); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(hgt, 20); b[24] = 8; b[25] = 6; return b; };
  const refuse = async (buffer, name, text, type = 'image/png') => {
    const before = await page.evaluate(() => window.__decodes);
    await page.locator('#file').setInputFiles({ name, mimeType: type, buffer });
    await alertSays(text);
    ok(`refused before decoding: ${name}`, await page.evaluate(() => window.__decodes) === before);
  };
  await refuse(pngHeader(20000, 10), 'wide.png', '16,384');
  await refuse(pngHeader(9000, 9000), 'area.png', '81 megapixels');
  await refuse(pngHeader(0, 10), 'none.png', 'no pixels');
  await refuse(Buffer.from('not an image at all, whatever its name says'), 'fake.png', 'PNG, JPEG or WebP');
  const jpegHuge = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108ea60ea600301110002110103110100'.padEnd(120, '0'), 'hex');
  await refuse(jpegHuge, 'huge.jpg', '16,384', 'image/jpeg');
  const webpHuge = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8X'), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0xff, 0xff, 0]), Buffer.alloc(16)]);
  await refuse(webpHuge, 'huge.webp', '16,384', 'image/webp');

  // Importing a portrait into a landscape composition must not move the workspace.
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({width, height: 900});
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#empty').style.width !== '');
    const box = id => page.locator(id).boundingBox();
    const initial = await box('#empty'), board = await box('#board');
    for (const [w,hgt] of [[1200,360],[360,1200]]) {
      await load(await draw("g.fillRect(0,0,100,100)", 'image/png', w, hgt), 'shape-' + w + '.png');
      const after = await box('#canvas'), stage = await box('#board');
      ok('stage and artboard stay put at ' + width + ' for ' + w, ['x','y','width','height'].every(k => Math.abs(initial[k]-after[k]) <= 1 && Math.abs(board[k]-stage[k]) <= 1), JSON.stringify({initial,after,board,stage}));
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.reload();
  await page.locator('.ss-preset[value=fit]').click();
  // ---------- Opening ----------
  const two = "g.fillStyle='#eeaa33';g.fillRect(0,0,400,200);g.fillStyle='#3377cc';g.fillRect(200,0,200,200)";
  for (const [type, name] of [['image/jpeg', 'a.jpg'], ['image/webp', 'a.webp'], ['image/png', 'a.png']]) await load(await draw(two, type), name, type);
  ok('PNG, JPEG and WebP open', /400 × 200/.test(await page.locator('#meta').textContent()));
  const fixture = await draw(two);
  for (const kind of ['paste', 'drop']) {
    await page.evaluate(([kind, b64]) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], kind + '.png', { type: 'image/png' }));
      if (kind === 'paste') document.querySelector('#padding').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      else document.querySelector('#board').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, [kind, fixture.toString('base64')]);
    await status(`${kind}.png opened`);
    ok(`${kind} opens an image`, true);
  }
  await page.locator('#file').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.concat([pngHeader(40, 40), Buffer.from('broken')]) });
  await alertSays('could not be decoded');
  ok('a broken file leaves the open image in place', await page.locator('#export-open').isEnabled() && (await page.locator('#meta').textContent()).startsWith('drop'));
  await load(fixture);

  // Grid is a view control. It changes preview pixels, never the finished image.
  await bare();
  const beforeGrid = await canvas.evaluate(c => c.toDataURL());
  await save({format:'PNG', scale:1});
  const filePixels = () => page.evaluate(() => Array.from(window.__out.data));
  const clean = await filePixels();
  const markArea = await page.evaluate(() => {
    const {width, height, data} = window.__out;
    let text = 0, plate = 0;
    for (let y=Math.floor(height*.92); y<height; y++) for (let x=Math.floor(width*.87); x<width; x++) {
      const [r,g,b] = data.subarray(4*(y*width+x), 4*(y*width+x)+3);
      if (r>150 && g>150 && b>150) text++;
      if (r<60 && g<65 && b<85) plate++;
    }
    return text>0 && plate>0;
  });
  ok('domain imprint paints type and a contrasting plate in the exported lower corner', markArea);
  await page.locator('#guides').click();
  ok('composition grid changes preview', beforeGrid !== await canvas.evaluate(c => c.toDataURL()));
  await save({format:'PNG', scale:1});
  ok('export excludes grid', Buffer.from(clean).equals(Buffer.from(await filePixels())));
  await page.locator('#guides').click();
  // ---------- Custom canvas: exact pixels ----------
  await bare();
  await tab('frame');
  await page.locator('.ss-preset[value=custom]').click();
  ok('Custom starts from the size on screen', await page.locator('#canvas-w').inputValue() === '400' && await page.locator('#canvas-h').inputValue() === '200');
  await setNum('canvas-w', 600); await setNum('canvas-h', 400);
  let r = await save({ file: 'canvas-600x400.png' });
  assert.deepEqual(r.size, [600, 400]);
  let orange = await bounds([238, 170, 51]), blue = await bounds([51, 119, 204]);
  ok('a custom canvas exports its exact size with the screenshot centred', orange.x === 0 && orange.y === 50 && orange.h === 300 && blue.x + blue.w === 600, JSON.stringify([orange, blue]));
  r = await save({ scale: 2 });
  assert.deepEqual(r.size, [1200, 800]);
  ok('2× doubles it', true);
  await page.locator('#canvas-swap').click();
  r = await save();
  assert.deepEqual(r.size, [400, 600]);
  await undo();
  ok('canvas size is one undo step', await page.locator('#canvas-w').inputValue() === '600');
  await redo();
  ok('canvas size can be redone', await page.locator('#canvas-w').inputValue() === '400');
  await undo();
  for (const [w, hgt, text] of [[9000, 400, '16 to 8192'], [8, 400, '16 to 8192'], [300.5, 400, '16 to 8192'], [8192, 8192, '40 megapixels'], ['', 400, '16 to 8192']]) {
    await setNum('canvas-w', 600); await setNum('canvas-h', 400);
    await page.locator('#canvas-w').fill(String(w)); await page.locator('#canvas-w').blur();
    if (hgt !== 400) { await page.locator('#canvas-h').fill(String(hgt)); await page.locator('#canvas-h').blur(); }
    assert((await page.locator('#canvas-error').textContent()).includes(text), `${w} × ${hgt}`);
    assert.equal(await page.locator('#canvas-w').getAttribute('aria-invalid'), 'true');
    assert(/→ (600|8192) × 400/.test(await page.locator('#meta').textContent()) && (hgt !== 400 || /→ 600/.test(await page.locator('#meta').textContent())), 'a refused size must not change the canvas');
  }
  await setNum('canvas-w', 600); await setNum('canvas-h', 400);
  ok('impossible canvas sizes are explained and not applied', await page.locator('#canvas-error').isHidden() && /→ 600 × 400/.test(await page.locator('#meta').textContent()));

  // ---------- Scale, alignment and position ----------
  await pickImage();
  await setNum('image-scale-n', 50);
  r = await save();
  orange = await bounds([238, 170, 51]); blue = await bounds([51, 119, 204]);
  ok('50% scale exports 300 × 150 in the centre', orange.x === 150 && orange.y === 125 && orange.w + blue.w === 300 && orange.h === 150, JSON.stringify([orange, blue]));
  for (const [label, x, y] of [['top left', 0, 0], ['top right', 300, 0], ['bottom left', 0, 250], ['bottom', 150, 250], ['right', 300, 125]]) {
    await page.getByRole('button', { name: `Align ${label}`, exact: true }).click();
    await save(); orange = await bounds([238, 170, 51]);
    ok(`align ${label} lands on the canvas edge`, orange.x === x && orange.y === y, JSON.stringify(orange));
  }
  await setNum('image-x', 40); await setNum('image-y', 60);
  await save({ file: 'placed-x40-y60.png' }); orange = await bounds([238, 170, 51]);
  ok('typed X and Y are exact', orange.x === 40 && orange.y === 60, JSON.stringify(orange));
  // Zooming the view is not scaling the image.
  for (let i = 0; i < 3; i++) await page.locator('#zoom-in').click();
  await save(); let z = await bounds([238, 170, 51]);
  ok('preview zoom leaves the export alone', JSON.stringify(z) === JSON.stringify(orange));
  await page.locator('#zoom-fit').click();
  await canvas.focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  await save(); z = await bounds([238, 170, 51]);
  ok('arrow keys move the screenshot by canvas pixels', z.x === 42 && z.y === 70, JSON.stringify(z));
  ok('the position fields follow', await page.locator('#image-x').inputValue() === '42' && await page.locator('#image-y').inputValue() === '70');
  await undo();
  await save(); z = await bounds([238, 170, 51]);
  ok('a run of nudges is one undo step', z.x === 40 && z.y === 60, JSON.stringify(z));
  await drag([(40 + 100) / 600, (60 + 70) / 400], [(40 + 160) / 600, (60 + 100) / 400]);
  await save(); z = await bounds([238, 170, 51]);
  ok('dragging moves the screenshot', Math.abs(z.x - 100) <= 2 && Math.abs(z.y - 90) <= 2, JSON.stringify(z));
  await drag([(z.x + 60) / 600, (z.y + 60) / 400], [(150 + 60 + 2) / 600, (125 + 60 + 2) / 400]);
  await save(); z = await bounds([238, 170, 51]);
  ok('dragging near the middle snaps to it', z.x === 150 && z.y === 125, JSON.stringify(z));
  await drag([450 / 600, 275 / 400], [525 / 600, 312.5 / 400]);
  await save(); z = await bounds([238, 170, 51]); blue = await bounds([51, 119, 204]);
  ok('a corner handle scales from the opposite corner', z.x === 150 && z.y === 125 && Math.abs(z.w + blue.w - 375) <= 3, JSON.stringify([z, blue]));
  await undo();
  await setNum('image-x', -5000);
  await save(); blue = await bounds([51, 119, 204]);
  ok('the screenshot cannot be lost off the canvas', blue && blue.w >= 30, JSON.stringify(blue));
  await page.locator('[data-key=place-reset]').click();
  await save(); z = await bounds([238, 170, 51]);
  ok('reset placement returns to the fitted centre', z.x === 0 && z.y === 50 && z.h === 300);
  await tab('frame'); await setNum('padding-n', 10); await pickImage(); await setNum('image-scale-n', 50);
  await page.getByRole('button', { name: 'Align top left', exact: true }).click();
  await save(); z = await bounds([238, 170, 51]);
  ok('alignment ignores padding', z.x === 0 && z.y === 0);
  await page.locator('[data-key=place-reset]').click();
  await tab('frame'); await setNum('padding-n', 0);

  // ---------- Custom shadow ----------
  await pickImage(); await setNum('image-scale-n', 50);
  await tab('frame');
  for (const preset of ['soft', 'lifted', 'print']) { await seg('shadow', preset); await save(); const p = await page.evaluate(() => { const d = window.__out; const i = (280 * d.width + 300) * 4; return d.data[i]; }); assert(p < 252, `${preset} casts a shadow (${p})`); }
  ok('one-click shadows still work', await page.locator('#shadow-custom').isHidden());
  await seg('shadow', 'print');
  const printed = (await save()).bytes;
  await seg('shadow', 'custom');
  ok('Custom starts from the preset in use', await page.locator('#shadow-x-n').inputValue() === '6' && await page.locator('#shadow-opacity-n').inputValue() === '100');
  ok('shadow detail appears under its choice', await page.locator('#shadow-custom').isVisible() && printed.length > 0);
  for (const [k, v] of [['x', 30], ['y', 20], ['blur', 0], ['spread', 0], ['opacity', 100]]) await setNum(`shadow-${k}-n`, v);
  await page.locator('#shadow-color').fill('#ff0000');
  r = await save({ file: 'shadow-hard-red.png' });
  let red = await bounds([255, 0, 0]);
  ok('shadow offset is exact', red.x + red.w === 450 + 30 && red.y + red.h === 275 + 20 && (await r.at(465, 285)).join() === '255,0,0' && (await r.at(482, 285)).join() === '255,255,255', JSON.stringify(red));
  r = await save({ scale: 2 }); red = await bounds([255, 0, 0]);
  ok('shadow offset scales with the export', red.x + red.w === 960 && red.y + red.h === 590, JSON.stringify(red));
  await setNum('shadow-spread-n', 10);
  await save(); red = await bounds([255, 0, 0]);
  ok('shadow spread is exact', red.x + red.w === 490 && red.y + red.h === 305, JSON.stringify(red));
  await setNum('shadow-spread-n', 0); await setNum('shadow-opacity-n', 50);
  r = await save();
  ok('shadow opacity is exact', near(await r.at(465, 285), [255, 128, 128], 2), String(await r.at(465, 285)));
  await undo();
  ok('shadow edits undo one at a time', await page.locator('#shadow-opacity-n').inputValue() === '100');
  await setNum('shadow-blur-n', 40);
  r = await save({ file: 'shadow-blur-1x.png' });
  const points = [[455, 200], [470, 200], [480, 200], [490, 200], [300, 290], [300, 300], [480, 290]];
  const one = []; for (const p of points) one.push(await r.at(...p));
  ok('blur softens the edge', one[2][1] > 30 && one[2][1] < 225, String(one[2]));
  r = await save({ scale: 2, file: 'shadow-blur-2x.png' });
  const doubled = []; for (const [x, y] of points) doubled.push(await r.at(x * 2, y * 2));
  ok('a 2× export casts the same shadow', one.every((c, i) => near(c, doubled[i], 6)), JSON.stringify([one, doubled]));
  await page.locator('#shadow-blur').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  ok('shadow sliders work from the keyboard', await page.locator('#shadow-blur-n').inputValue() === '42');
  await page.keyboard.press('Control+z');
  ok('undo works while a slider has focus', await page.locator('#shadow-blur-n').inputValue() === '40');

  await tab('frame');
  await page.locator('#corner-presets button[value="9"]').click();
  ok('round preset sets the exact corner control', await page.locator('#radius-n').inputValue() === '9');
  await setNum('radius-n', 4);
  ok('custom corners deselect the presets', await page.locator('#corner-presets [aria-pressed=true]').count() === 0);
  await page.locator('#undo').click();
  ok('undo restores round selection', await page.locator('#corner-presets button[value="9"]').getAttribute('aria-pressed') === 'true');

  // ---------- Every background ----------
  await seg('shadow', 'none'); await pickImage(); await page.locator('[data-key=place-reset]').click(); await tab('frame');
  await page.locator('.ss-preset[value=x-post]').click(); await setNum('padding-n', 12);
  await tab('background');
  ok('every artwork in the catalogue has a tile and a packaged file', ARTWORK.length >= 7 && await page.locator('[data-art]').count() === ARTWORK.length && ARTWORK.every(a => existsSync(join(dist, a.file))), `${ARTWORK.length}`);
  for (const a of ARTWORK) {
    await page.locator(`[data-art="${a.id}"]`).click();
    r = await save({ format: 'WebP', file: `art-${a.id}.webp` });
    assert.deepEqual(r.size, [1600, 900]);
    const diff = await page.evaluate(async file => {
      const img = new Image(); img.src = file; await img.decode();
      const d = window.__out, c = document.createElement('canvas'); c.width = d.width; c.height = d.height;
      const g = c.getContext('2d'); const s = Math.max(c.width / img.width, c.height / img.height);
      g.drawImage(img, (c.width - img.width * s) / 2, (c.height - img.height * s) / 2, img.width * s, img.height * s);
      let sum = 0, n = 0;
      for (const [x, y] of [[0, 0], [1520, 0], [0, 820], [1520, 725], [760, 0], [760, 820]]) {
        const e = g.getImageData(x, y, 80, 80).data;
        const mean = [0, 0, 0], got = [0, 0, 0];
        for (let j = 0; j < 80; j++) for (let i = 0; i < 80; i++) for (let k = 0; k < 3; k++) { mean[k] += e[(j * 80 + i) * 4 + k] / 6400; got[k] += d.data[((y + j) * d.width + x + i) * 4 + k] / 6400; }
        for (let k = 0; k < 3; k++) { sum += Math.abs(mean[k] - got[k]); n++; }
      }
      return { diff: sum / n, width: img.naturalWidth, height: img.naturalHeight };
    }, a.file);
    ok(`artwork ${a.name} reaches the export`, diff.diff < 4, JSON.stringify(diff));
    ok(`artwork ${a.name} is large enough`, diff.width >= 1600 && diff.height >= 900, JSON.stringify(diff));
  }
  ok('the retired artworks are gone', !ARTWORK.some(a => /pixel|alpine/.test(a.id)));
  await page.screenshot({ path: join(out, '02-backgrounds.png') });
  await page.getByRole('button', { name: 'Graphite', exact: true }).click();
  r = await save(); ok('gradient backgrounds export', near(await r.at(1599, 899), [20, 21, 23], 1) && near(await r.at(0, 0), [69, 71, 76], 1), `${await r.at(0, 0)} ${await r.at(1599, 899)}`);
  await page.locator('#color').fill('#abc123');
  r = await save(); ok('custom colour exports exactly', (await r.at(0, 0)).join() === '171,193,35');
  const paperA = await draw("g.fillStyle='#204060';g.fillRect(0,0,400,200);g.fillStyle='#d0e0f0';g.fillRect(200,0,200,200)");
  await page.locator('#bg-file').setInputFiles({ name: 'private-wallpaper.png', mimeType: 'image/png', buffer: paperA });
  await status('Your image is the background');
  r = await save(); await page.locator('#export-open').click();
  await page.locator('#art-resolution').waitFor({state:'visible'});
  ok('undersized backgrounds show their native dimensions in Export', /original: [0-9]+ × [0-9]+ px/.test(await page.locator('#art-resolution').textContent()));
  await page.locator('#export-close').click();
  ok('your own wallpaper exports', near(await r.at(4, 4), [32, 64, 96], 2));
  await page.locator('#bg-file').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: await draw("g.fillStyle='#663300';g.fillRect(0,0,400,200)") });
  await status('Your image is the background');
  await undo();
  r = await save(); ok('undo brings back the earlier wallpaper', near(await r.at(4, 4), [32, 64, 96], 2));
  await setNum('blur-n', 30);
  r = await save(); const soft1 = [await r.at(780, 20), await r.at(820, 20)];
  r = await save({ scale: 2 }); const soft2 = [await r.at(1560, 40), await r.at(1640, 40)];
  ok('softening looks the same at 1× and 2×', soft1.every((c, i) => near(c, soft2[i], 6)) && soft1[0][0] > 40, JSON.stringify([soft1, soft2]));
  await page.locator('#bg-file').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: pngHeader(30000, 30000) });
  await alertSays('16,384');
  ok('an oversized wallpaper is refused', true);

  // ---------- Frame ----------
  await bare(); await tab('frame'); await seg('border', 'ink'); await setNum('borderWidth-n', 20);
  await page.locator('.ss-preset[value=fit]').click(); await setNum('padding-n', 10);
  r = await save();
  ok('ink border exports', (await r.at(38, 120)).join() === '19,19,19', String(await r.at(38, 120)));
  const plainH = r.size[1];
  await seg('window', 'dark'); await page.locator('#windowTitle').fill('secret-title.example'); await page.locator('#windowTitle').blur();
  r = await save();
  ok('a browser window adds its bar', r.size[1] > plainH, `${r.size}`);
  await seg('window', 'none'); await seg('border', 'none');
  for (const [id, w, hgt] of [['x-post', 1600, 900], ['square', 1080, 1080], ['portrait', 1080, 1350], ['x-header', 1500, 500], ['wide', 1920, 1080], ['story', 1080, 1920]]) {
    await page.locator(`.ss-preset[value=${id}]`).click();
    r = await save(); assert.deepEqual(r.size, [w, hgt]);
  }
  ok('every canvas preset exports its printed size', true);
  await page.locator('.ss-preset[value=x-post]').click();

  // ---------- Formats ----------
  const large = await save({ format: 'JPEG', quality: 100 }), small = await save({ format: 'JPEG', quality: 50 });
  ok('JPEG is a JPEG and quality changes its size', small.bytes.readUInt16BE(0) === 0xffd8 && small.bytes.length < large.bytes.length && small.name === 'fixture-framed.jpg', `${small.bytes.length} ${large.bytes.length} ${small.name}`);
  r = await save({ format: 'WebP' }); ok('WebP is a WebP', r.bytes.toString('ascii', 8, 12) === 'WEBP');
  r = await save({ scale: 3 }); assert.deepEqual(r.size, [4800, 2700]); ok('3× exports', true);
  await page.locator('.ss-preset[value=custom]').click(); await setNum('canvas-w', 8000); await setNum('canvas-h', 4000);
  await page.locator('#export-open').click();
  ok('sizes past the limit are switched off', await page.locator('#scale button').nth(1).isDisabled() && await page.locator('#scale button').nth(0).isEnabled());
  await page.locator('#export-close').click();

  // ---------- Crop ----------
  await page.locator('.ss-preset[value=fit]').click(); await setNum('padding-n', 0);
  await page.keyboard.press('Escape'); await canvas.focus(); await page.keyboard.press('c');
  ok('C opens crop', await page.locator('#panel-crop').isVisible() && await page.locator('#tabs').isHidden());
  let b = await canvas.boundingBox(); const M = 14;
  const cs = (b.width - M * 2) / 400;
  const cropDrag = async (from, to) => { await page.mouse.move(b.x + M + from[0] * cs, b.y + M + from[1] * cs); await page.mouse.down(); await page.mouse.move(b.x + M + to[0] * cs, b.y + M + to[1] * cs, { steps: 5 }); await page.mouse.up(); };
  await cropDrag([400, 200], [300, 150]);
  ok('dragging a crop handle resizes it', await page.locator('#crop-w').inputValue() === '300' && await page.locator('#crop-h').inputValue() === '150', await page.locator('#crop-w').inputValue());
  await cropDrag([150, 75], [200, 100]);
  ok('dragging inside moves it', await page.locator('#crop-x').inputValue() === '50' && await page.locator('#crop-y').inputValue() === '25');
  await canvas.focus();
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Alt+ArrowLeft');
  ok('arrow keys move and Alt arrows resize', await page.locator('#crop-x').inputValue() === '48' && await page.locator('#crop-w').inputValue() === '298', `${await page.locator('#crop-x').inputValue()} ${await page.locator('#crop-w').inputValue()}`);
  await page.locator('#crop-aspect button', { hasText: '1:1' }).click();
  ok('aspect lock holds', await page.locator('#crop-w').inputValue() === await page.locator('#crop-h').inputValue());
  await page.locator('#crop-aspect button', { hasText: 'Free' }).click();
  for (const [k, v] of [['x', 100], ['y', 50], ['w', 200], ['h', 100]]) await setNum(`crop-${k}`, v);
  await page.screenshot({ path: join(out, '03-crop.png') });
  await canvas.focus(); await page.keyboard.press('Enter');
  r = await save();
  assert.deepEqual(r.size, [200, 100]);
  ok('typed crop exports those pixels', (await r.at(50, 50)).join() === '238,170,51' && (await r.at(150, 50)).join() === '51,119,204');
  await undo(); r = await save(); assert.deepEqual(r.size, [400, 200]); ok('crop can be undone', true);
  await canvas.focus(); await page.keyboard.press('c'); await page.locator('#crop-w').press('Tab'); await page.locator('#crop-cancel').focus(); await page.keyboard.press('Escape');
  ok('Escape leaves crop from anywhere', await page.locator('#panel-crop').isHidden());

  // ---------- Redaction ----------
  const secret = "g.fillStyle='#fff';g.fillRect(0,0,400,200);for(let x=160;x<240;x+=2){g.fillStyle=x%4?'#ff0000':'#00ff00';g.fillRect(x,80,2,40)}";
  await load(await draw(secret));
  await tool('redact');
  await clickAt(0.5, 0.5); await status('Nothing was redacted');
  ok('a click is not a redaction', await layers() === 0 && await page.locator('#undo').isDisabled());
  await drag([0.3, 0.5], [0.7, 0.5]); await status('Nothing was redacted');
  ok('a flat drag is not a redaction', await layers() === 0);
  await tab('frame'); await setNum('padding-n', 20); await tool('redact');
  await drag([0.01, 0.01], [0.06, 0.06]); await status('Nothing was redacted');
  ok('a redaction off the screenshot is refused', await layers() === 0);
  await canvas.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await status('Nothing was redacted');
  ok('a zero-area keyboard redaction is refused', await layers() === 0);
  await page.keyboard.press('Escape'); await tab('frame'); await setNum('padding-n', 0); await tool('redact');
  await drag([159.5 / 400, 79.5 / 200], [240.5 / 400, 120.5 / 200]);
  ok('a real redaction is added', await layers() === 1);
  const tinted = () => page.evaluate(() => { const d = window.__out.data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 3) n++; return n; });
  for (const format of ['PNG', 'JPEG', 'WebP']) {
    r = await save({ format, quality: format === 'PNG' ? undefined : 92 });
    ok(`redaction is solid in ${format}`, near(await r.at(200, 100), [19, 19, 19], format === 'PNG' ? 0 : 4) && await tinted() === 0, `${await r.at(200, 100)} ${await tinted()}`);
  }
  await tab('frame'); await page.locator('.ss-preset[value=custom]').click();
  for (const w of [61, 97, 149, 333]) { await setNum('canvas-w', w); await setNum('canvas-h', 100); await save(); ok(`no trace of the hidden area when scaled into ${w} px`, await tinted() === 0, String(await tinted())); }
  await page.locator('.ss-preset[value=fit]').click();
  // It cannot be shrunk away or pushed off the screenshot afterwards.
  await page.keyboard.press('Escape'); await canvas.focus(); await page.keyboard.press('v');
  await drag([240.5 / 400, 120.5 / 200], [159.6 / 400, 79.6 / 200]); await status('has to cover part');
  r = await save(); ok('a redaction cannot be resized to nothing', (await r.at(200, 100)).join() === '19,19,19');
  await page.locator('#panel-layers .ss-chip[aria-label=Paper]').click();
  r = await save(); ok('paper redaction is solid too', (await r.at(200, 100)).join() === '255,255,255');
  await undo();

  // ---------- Marks ----------
  await load(fixture);
  await page.keyboard.press('a'); await drag([0.1, 0.8], [0.3, 0.4]);
  await page.keyboard.press('r'); await drag([0.55, 0.2], [0.9, 0.6]);
  await save();
  const rectangle = Buffer.from(await filePixels());
  await page.locator('[data-key="shape:Oval"]').click();
  await save();
  ok('oval callout changes the exported outline', !rectangle.equals(Buffer.from(await filePixels())));
  await undo();
  ok('undo restores the rectangular outline', await page.locator('[data-key="shape:Rectangle"]').getAttribute('aria-pressed') === 'true');
  await canvas.focus();
  await page.keyboard.press('n'); await clickAt(0.2, 0.2); await clickAt(0.3, 0.2);
  ok('steps number themselves', await page.getByRole('button', { name: 'Step 2', exact: true }).isVisible());
  await page.keyboard.press('t'); await clickAt(0.1, 0.5);
  ok('placing text opens its field', await page.evaluate(() => document.activeElement.id === 'layer-text'));
  await page.keyboard.type('Layer words'); await page.locator('#layer-text').blur();
  ok('five marks, named in the list', await layers() === 5 && await page.locator('.ss-layer', { hasText: 'Layer words' }).count() === 1);
  await page.locator('.ss-layer', { hasText: 'Layer words' }).click();
  if (await page.locator('#layer-text').count() === 0) await page.locator('.ss-layer', { hasText: 'Layer words' }).click();
  await canvas.focus(); await page.keyboard.press('Shift+ArrowRight');
  await page.locator('#layer-size-n').fill('30'); await page.locator('#layer-size-n').blur();
  await page.screenshot({ path: join(out, '04-marks.png') });
  ok('a mark still edits after it was nudged', await page.locator('#layer-size').inputValue() === '30');
  await undo(); await undo();
  ok('size and nudge undo separately', await layers() === 5 && await page.locator('#layer-size').inputValue() !== '30');
  await page.locator('[data-key="act:Duplicate"]').click(); ok('duplicate', await layers() === 6);
  await page.locator('[data-key="act:Backward"]').click();
  ok('reorder', (await page.locator('.ss-layer').first().getAttribute('aria-pressed')) === 'false');
  await canvas.focus(); await page.keyboard.press('Delete'); ok('Delete removes the selected mark', await layers() === 5);
  await page.keyboard.press('Control+z'); ok('undo restores it', await layers() === 6);
  await page.keyboard.press('Control+Shift+z'); ok('redo removes it again', await layers() === 5);
  // Keyboard alone.
  await page.keyboard.press('a'); await canvas.focus(); await page.keyboard.press('Enter'); for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Enter');
  ok('an arrow can be drawn from the keyboard', await layers() === 6);
  // Dragging a mark moves it, not the screenshot.
  await load(fixture); await tool('redact'); await drag([0.4, 0.4], [0.6, 0.6]); await page.keyboard.press('v');
  await drag([0.5, 0.5], [0.75, 0.5]); r = await save();
  ok('dragging a mark moves only it', (await r.at(300, 100)).join() === '19,19,19' && (await r.at(170, 100)).join() === '238,170,51', `${await r.at(300, 100)}`);

  // ---------- Focus and selection look different; status ----------
  const look = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.ss-tool[aria-pressed=true]')), t = getComputedStyle(document.querySelector('.ss-tool[value=arrow]')); return [s.backgroundColor, t.backgroundColor]; });
  await page.locator('.ss-tool[value=select]').focus(); await page.keyboard.press('Tab'); await page.waitForTimeout(250);
  const focused = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { bg: s.backgroundColor, outline: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
  ok('selected is an ink face, focus is a separate ring', look[0] === 'rgb(19, 19, 19)' && look[1] !== look[0] && focused.bg !== look[0] && focused.outline === 'solid' && focused.width >= 2, JSON.stringify([look, focused]));
  ok('status and errors are announced', await page.locator('#status[role=status]').count() === 1 && await page.locator('#alert[role=alert]').count() === 1);
  ok('every control has a name', await page.evaluate(() => [...document.querySelectorAll('main button, main input, main textarea, dialog button, dialog input')].filter(e => e.checkVisibility?.() && !(e.getAttribute('aria-label') || e.textContent.trim() || e.labels?.length)).length) === 0);
  await page.locator('#tab-frame').focus(); await page.keyboard.press('ArrowRight');
  ok('tabs move with the arrow keys', await page.locator('#tab-background').getAttribute('aria-selected') === 'true');

  // ---------- Copy ----------
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copy').click(); await status('Image copied as PNG');
  ok('copy puts a PNG on the clipboard', await page.evaluate(async () => (await navigator.clipboard.read()).some(i => i.types.includes('image/png'))));

  // ---------- Style presets keep styling only ----------
  await load(fixture, 'private-file-name.png');
  await bare(); await tab('frame');
  await page.locator('.ss-preset[value=custom]').click(); await setNum('canvas-w', 640); await setNum('canvas-h', 480);
  await seg('shadow', 'custom'); for (const [k, v] of [['x', 12], ['y', 16], ['blur', 0], ['spread', 4], ['opacity', 80]]) await setNum(`shadow-${k}-n`, v);
  await seg('window', 'light'); await page.locator('#windowTitle').fill('secret-title.example'); await page.locator('#windowTitle').blur();
  await pickImage(); await setNum('image-scale-n', 70); await page.getByRole('button', { name: 'Align bottom right', exact: true }).click();
  await page.keyboard.press('t'); await clickAt(0.8, 0.8); await page.keyboard.type('private layer words'); await page.locator('#layer-text').blur();
  await tab('background'); await page.locator('#bg-file').setInputFiles({ name: 'private-wallpaper.png', mimeType: 'image/png', buffer: paperA }); await status('Your image');
  await tab('frame'); await page.locator('#style-save').click();
  await page.locator('#style-name').fill('Launch look'); await page.screenshot({ path: join(out, '05-style-save.png') });
  await page.locator('#style-name').press('Enter'); await status('Launch look saved');
  const stored = await page.evaluate(() => localStorage.getItem('xck-screenshot-styles'));
  const parsed = JSON.parse(stored);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['name', 'style']);
  assert.deepEqual(Object.keys(parsed[0].style).sort(), ['anchorX', 'anchorY', 'blur', 'border', 'borderWidth', 'canvas', 'canvasH', 'canvasW', 'offsetX', 'offsetY', 'padding', 'radius', 'scale', 'shadow', 'shadowSpec', 'window']);
  ok('a style stores only its listed fields', !/private|secret|data:|blob:|crop|layers|windowTitle|custom","id/.test(stored) && stored.length < 900, stored);
  const wanted = await save();
  await page.reload();
  ok('nothing but styles survives a reload', await page.locator('#export-open').isDisabled() && await page.locator('.ss-style').count() === 1);
  ok('the page stores nothing else', await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('xck-screenshot')).join()) === 'xck-screenshot-styles');
  await load(fixture, 'another.png'); await tab('background'); await page.getByRole('button', { name: 'Pale sage', exact: true }).click(); await tab('frame');
  await page.getByRole('button', { name: 'Apply style Launch look' }).click();
  r = await save({ file: 'style-applied.png' });
  orange = await bounds([238, 170, 51]);
  blue = await bounds([51, 119, 204]);
  assert.deepEqual(r.size, wanted.size);
  ok('a style reapplies canvas, scale, alignment, shadow and window', r.size.join() === '640,480' && blue.x + blue.w === 640 && blue.y + blue.h === 480 && orange.x === 192, JSON.stringify([orange, blue]));
  ok('a style saved over your own wallpaper keeps the current background', (await r.at(2, 2)).join() === '221,228,217', String(await r.at(2, 2)));
  ok('a style leaves the address text alone', await page.locator('#windowTitle').inputValue() === 'x.com');
  await undo();
  ok('applying a style is one undo step', /→ 1600 × 900/.test(await page.locator('#meta').textContent()) && await page.locator('.ss-preset[value=x-post]').getAttribute('aria-pressed') === 'true', await page.locator('#meta').textContent());
  await redo();
  await tab('background'); await page.locator(`[data-art="${ARTWORK[3].id}"]`).click(); await tab('frame');
  await page.locator('#style-save').click(); await page.locator('#style-name').fill('<img src=x onerror=alert(1)>'); await page.locator('#style-form button[type=submit]').click();
  ok('a style name is only ever text', await page.locator('.ss-style-name img').count() === 0 && await page.locator('.ss-style').count() === 2);
  ok('a style keeps packaged artwork by id', JSON.parse(await page.evaluate(() => localStorage.getItem('xck-screenshot-styles')))[1].style.background.id === ARTWORK[3].id);
  const del = page.locator('.ss-style-list .ss-icon-key').nth(1);
  await del.click(); ok('deleting a style asks first', await page.locator('.ss-style').count() === 2);
  await del.click(); ok('a second press deletes it', await page.locator('.ss-style').count() === 1);
  await page.evaluate(() => localStorage.setItem('xck-screenshot-styles', JSON.stringify([{ name: 'Edited', style: { canvas: 'evil', canvasW: 1e9, canvasH: -4, scale: 99999, padding: 'x', shadow: 'custom', shadowSpec: { blur: 1e6, color: 'red;}' }, background: { kind: 'art', id: '../../x' } } }, { name: 7 }, null, 'x'])));
  await page.reload(); await load(fixture); await page.getByRole('button', { name: 'Apply style Edited' }).click();
  await save({ format: 'PNG' });
  await pickImage();
  ok('damaged stored styles are repaired', await page.locator('.ss-style').count() === 1 && await page.locator('#image-scale-n').inputValue() === '400');
  await page.evaluate(() => localStorage.setItem('xck-screenshot-styles', '{broken')); await page.reload();
  ok('unreadable stored styles are ignored', await page.locator('.ss-style').count() === 0);

  // ---------- A finished piece, and the narrow layouts ----------
  const demo = await ctx.newPage();
  await demo.setViewportSize({ width: 1200, height: 720 });
  await demo.setContent(`<style>body{margin:0;background:#f4f4f1;color:#131313;font:15px/1.4 Helvetica,Arial,sans-serif;padding:44px 52px}h1{font-size:40px;letter-spacing:-.04em;margin:0}p{margin:6px 0 26px;color:#55575c}.r{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.r>div,.c{background:#fff;border:1px solid #deded8;border-radius:14px;padding:18px 20px}.r b{display:block;font-size:32px;letter-spacing:-.03em;margin-top:6px}.c{margin-top:16px}</style>
    <h1>Autumn launch</h1><p>Example data · week of 16 Nov, UTC</p>
    <div class=r><div>Signups<b>1,284</b></div><div>Trials<b>412</b></div><div>Paid<b>96</b></div><div>Contact<b>ada@site.example</b></div></div>
    <div class=c>Signups per day<svg viewBox="0 0 1040 300" width="100%" style="display:block;margin-top:10px"><g stroke="#ecece7">${[60, 120, 180, 240].map(y => `<path d="M0 ${y}H1040"/>`).join('')}</g><path d="M0 250L170 220L340 232L510 150L680 170L850 84L1040 40V290H0Z" fill="#e6e6e0"/><path d="M0 250L170 220L340 232L510 150L680 170L850 84L1040 40" fill="none" stroke="#131313" stroke-width="4"/></svg></div>`);
  await demo.locator('b').nth(3).evaluate(e => { e.style.fontSize = '21px'; });
  const shot = await demo.screenshot(); await demo.close();
  const compose = async () => {
    await load(shot, 'autumn-launch.png');
    await tab('frame'); await page.locator('.ss-preset[value=x-post]').click(); await setNum('padding-n', 9); await setNum('radius-n', 2);
    await seg('window', 'light'); await page.locator('#windowTitle').fill('launch.example/week'); await page.locator('#windowTitle').blur();
    await seg('shadow', 'lifted');
    await tab('background'); await page.locator(`[data-art="${ARTWORK[3].id}"]`).click();
    const L = { W: 1600, H: 900, p: 81 }; const bar = 60, ch = 780, k = Math.min((L.W - 162) / 1200, (L.H - 162) / ch);
    const ox = (L.W - 1200 * k) / 2, oy = (L.H - ch * k) / 2 + bar * k;
    const at = (x, y) => [(ox + x * k) / L.W, (oy + y * k) / L.H];
    await tool('redact'); await drag(at(905, 196), at(1090, 240));
    await tool('box'); await drag(at(40, 142), at(328, 275)); await page.keyboard.press('v');
    await tool('step'); await clickAt(...at(328, 142));
    await tool('arrow'); await drag(at(720, 520), at(826, 408));
    await tool('text'); await clickAt(...at(560, 530)); await page.keyboard.type('Launch day'); await page.locator('#layer-text').blur();
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await compose();
  await page.waitForTimeout(5200);
  await page.screenshot({ path: join(out, '06-desktop-marks.png') });
  await save({ scale: 2, file: 'finished-2x.png' });
  await page.locator('#export-open').click(); await page.locator('#format button', { hasText: 'JPEG' }).click(); await page.waitForFunction(() => / KB| MB/.test(document.querySelector('#export-info').textContent)); await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, '07-export.png') }); await page.locator('#export-close').click();
  // Custom canvas, off-centre placement and a custom shadow, then kept as a style.
  await tab('frame'); await page.locator('.ss-preset[value=custom]').click(); await setNum('canvas-w', 1440); await setNum('canvas-h', 1080);
  await seg('shadow', 'custom'); for (const [k, v] of [['x', 26], ['y', 34], ['blur', 60], ['spread', 4], ['opacity', 46]]) await setNum(`shadow-${k}-n`, v);
  await page.locator('#style-save').click(); await page.locator('#style-name').fill('Cloud desk'); await page.locator('#style-form button[type=submit]').click(); await page.waitForTimeout(5200);
  await page.screenshot({ path: join(out, '08-custom-size-and-shadow.png') });
  await page.locator('#shadow-custom').scrollIntoViewIfNeeded(); await page.locator('#shadow-opacity').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, '09-custom-shadow.png') });
  await pickImage(); await setNum('image-scale-n', 118); await page.getByRole('button', { name: 'Align bottom right', exact: true }).click();
  await page.screenshot({ path: join(out, '10-placement.png') });
  await save({ scale: 2, file: 'finished-placed-2x.png' });
  for (const width of [1440, 1100, 1024, 861, 860, 768, 520, 390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(150);
    for (const t of ['frame', 'background', 'layers']) {
      await tab(t);
      const wide = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, spill: [...document.querySelectorAll('main button, main input:not([type=file]), main label')].filter(e => e.checkVisibility() && !e.closest('.ss-board')).filter(e => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).map(e => e.id || e.className || e.textContent) }));
      assert(wide.over <= 0 && !wide.spill.length, `${width} ${t} ${JSON.stringify(wide)}`);
    }
    await tool('crop'); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `crop ${width}`); await page.keyboard.press('Escape');
    if ([1024, 768, 390, 320].includes(width)) { await tab(width === 390 ? 'frame' : 'layers'); await page.waitForTimeout(150); await page.screenshot({ path: join(out, `narrow-${width}.png`), fullPage: true }); }
  }
  ok('nothing spills at any width from 1440 to 320', true);
  await page.locator('#export-open').click();
  ok('the export sheet fits a 320 px screen', await page.evaluate(() => { const r = document.querySelector('#export-dialog').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.querySelector('#export-dialog').scrollWidth <= document.querySelector('#export-dialog').clientWidth; }));
  await page.screenshot({ path: join(out, 'narrow-320-export.png') }); await page.locator('#export-close').click();

  assert.deepEqual(network, []); assert.deepEqual(errors, []);
  ok('no network request and no console error', true);
  console.log(`Screenshot editor: ${checks.length} checks passed, ${ARTWORK.length} artworks exported. Pictures in ${out}`);
} catch (error) {
  console.error(`Failed after ${checks.length} checks; last passed: ${checks.at(-1)}`);
  throw error;
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
