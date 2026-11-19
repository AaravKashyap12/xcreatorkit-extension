// Bakes the receipt studio's textures to PNG with SVG filters in Chromium. Everything is procedural,
// so there are no third-party image licences to track. Output: studio/textures/*.png, then
// python scripts/optimise-textures.py writes the shipped JPEGs to src/receipt/textures.
//   node scripts/bake-textures.mjs
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve('studio/textures'); // raw bakes; then run scripts/optimise-textures.py to write src/receipt/textures
mkdirSync(out, { recursive: true });
const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
const executablePath = [chromium.executablePath(), ...(local ? ['chromium-1243', 'chromium-1234'].map((v) => join(local, v, 'chrome-win64', 'chrome.exe')) : [])].find((p) => p && existsSync(p));

const textures = {
  // Crumpled thermal paper: low-frequency turbulence lit from the top-left. Used with multiply.
  crumple: {
    w: 1200, h: 1800, bg: '#ffffff',
    svg: `<filter id="f" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.006 0.009" numOctaves="5" seed="7" result="n"/>
      <feDiffuseLighting in="n" surfaceScale="6" lighting-color="#ffffff" result="l"><feDistantLight azimuth="235" elevation="58"/></feDiffuseLighting>
      <feComponentTransfer in="l"><feFuncR type="linear" slope="0.85" intercept="0.22"/><feFuncG type="linear" slope="0.85" intercept="0.22"/><feFuncB type="linear" slope="0.85" intercept="0.22"/></feComponentTransfer>
    </filter><rect width="100%" height="100%" filter="url(#f)"/>`,
  },
  // Fine fibre grain for any paper. Used with multiply at low opacity.
  grain: {
    w: 800, h: 800, bg: '#ffffff',
    svg: `<filter id="f"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3"/><feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncR type="linear" slope="0.5" intercept="0.62"/><feFuncG type="linear" slope="0.5" intercept="0.62"/><feFuncB type="linear" slope="0.5" intercept="0.62"/></feComponentTransfer>
    </filter><rect width="100%" height="100%" filter="url(#f)"/>`,
  },
  // Ink grunge mask for rubber stamps: opaque with speckled gaps (alpha mask).
  grunge: {
    w: 600, h: 600, bg: 'transparent',
    svg: `<filter id="f"><feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" seed="11"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -7 0 0 0 4.6"/></filter>
      <rect width="100%" height="100%" filter="url(#f)"/>`,
  },
};

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
for (const [name, t] of Object.entries(textures)) {
  await page.setViewportSize({ width: t.w, height: t.h });
  await page.setContent(`<html><body style="margin:0;background:${t.bg}"><svg width="${t.w}" height="${t.h}" xmlns="http://www.w3.org/2000/svg">${t.svg}</svg></body></html>`);
  await page.screenshot({ path: join(out, `${name}.png`), omitBackground: t.bg === 'transparent' });
  console.log('baked', name);
}
await browser.close();
