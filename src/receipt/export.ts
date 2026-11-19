// Renders a receipt scene straight to a 2× PNG: static markup (no NumberFlow, no animation) inside an
// SVG foreignObject, with fonts and textures already inlined as data URLs.
import { RECEIPT_CSS } from './assets';
import { renderScene } from './scenes';
import type { ReceiptData } from './data';

export const ART_W = 1080;
export const ART_H = 1350;

export async function receiptPng(sceneId: number, colourway: number, data: ReceiptData, scale = 2): Promise<Blob> {
  // Make sure the faces are decoded in this document so the rasteriser has them ready.
  await document.fonts.ready;
  const html = renderScene(sceneId, colourway, data);
  const css = RECEIPT_CSS.replace(/</g, '\\3c ');
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${ART_W * scale}" height="${ART_H * scale}" viewBox="0 0 ${ART_W} ${ART_H}"><foreignObject x="0" y="0" width="${ART_W}" height="${ART_H}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${toXhtml(html)}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(doc);
  await img.decode();
  // Give the rasteriser one more frame for fonts inside the SVG.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.createElement('canvas');
  c.width = ART_W * scale;
  c.height = ART_H * scale;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
}

/** Parse HTML and reserialise as XHTML (void elements closed) so it is valid inside the SVG. */
function toXhtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return [...tpl.content.childNodes].map((n) => new XMLSerializer().serializeToString(n)).join('');
}
