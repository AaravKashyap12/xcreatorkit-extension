// Fonts and textures inlined as data URLs, so the receipt renders identically on the page and in the
// PNG export (an SVG foreignObject cannot fetch external files). All fonts are OFL/Apache.
import css from './receipt.css';
import archivo from '@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2';
import bricolage from '@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wdth-normal.woff2';
import martian from '@fontsource-variable/martian-mono/files/martian-mono-latin-wdth-normal.woff2';
import plex400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2';
import plex500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2';
import plex700 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2';
import serifItalic from '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2';
import zilla700 from '@fontsource/zilla-slab/files/zilla-slab-latin-700-normal.woff2';
import courier400 from '@fontsource/courier-prime/files/courier-prime-latin-400-normal.woff2';
import courier700 from '@fontsource/courier-prime/files/courier-prime-latin-700-normal.woff2';
import yellowtail from '@fontsource/yellowtail/files/yellowtail-latin-400-normal.woff2';
import crumple from './textures/crumple.jpg';
import grain from './textures/grain.jpg';
import grunge from './textures/grunge.jpg';

const face = (family: string, url: string, extra = '') => `@font-face{font-family:'${family}';src:url(${url}) format('woff2');${extra}}`;

export const FONT_CSS = [
  face('Archivo', archivo, 'font-weight:100 900;font-stretch:62% 125%;'),
  face('Bricolage', bricolage, 'font-weight:200 800;font-stretch:75% 100%;'),
  face('Martian Mono', martian, 'font-weight:100 800;font-stretch:75% 112.5%;'),
  face('Plex Mono', plex400, 'font-weight:400;'),
  face('Plex Mono', plex500, 'font-weight:500;'),
  face('Plex Mono', plex700, 'font-weight:700;'),
  face('Instrument Serif', serifItalic, 'font-style:italic;'),
  face('Zilla Slab', zilla700, 'font-weight:700;'),
  face('Courier Prime', courier400, 'font-weight:400;'),
  face('Courier Prime', courier700, 'font-weight:700;'),
  face('Yellowtail', yellowtail),
].join('');

export const TEXTURE_CSS = `.art{--tx-crumple:url(${crumple});--tx-grain:url(${grain});--tx-grunge:url(${grunge});}`;

/** Everything a page or export needs to draw receipts. */
export const RECEIPT_CSS = FONT_CSS + TEXTURE_CSS + css;

let injected = false;
export function injectReceiptCss(doc: Document = document): void {
  if (injected) return;
  injected = true;
  const style = doc.createElement('style');
  style.textContent = RECEIPT_CSS;
  doc.head.append(style);
}

let fontsLoaded: Promise<void> | null = null;
/** Loads every receipt face up front. Rolling digits are sized from the real font's metrics, so animate only after this
 *  resolves; a fallback font would pin rows taller than the static receipt (and the PNG export). */
export function receiptFontsReady(doc: Document = document): Promise<void> {
  injectReceiptCss(doc);
  fontsLoaded ??= Promise.all(
    ['900 30px "Archivo"', '800 30px "Bricolage"', '800 30px "Martian Mono"', '400 30px "Plex Mono"', '500 30px "Plex Mono"', '700 30px "Plex Mono"',
      'italic 400 30px "Instrument Serif"', '700 30px "Zilla Slab"', '400 30px "Courier Prime"', '700 30px "Courier Prime"', '400 30px "Yellowtail"'].map((f) => doc.fonts.load(f)),
  ).then(() => undefined, () => undefined);
  return fontsLoaded;
}
