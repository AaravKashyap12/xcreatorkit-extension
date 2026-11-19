// Share images for Analytics sections: one card markup is the on-page preview and the PNG, drawn on this device.
// Copy image and Download PNG only; nothing is posted or sent anywhere.
import geist from '../../static/fonts/geist.woff2';
import mono from '../../static/fonts/geist-mono-latin.woff2';
import cardCss from './analyticsShare.css';
import { compact, legend, xyChart } from '../chart/xy';
import { download, h } from './dom';
import type { ShareCard } from '../analytics/view';

export const SHARE_W = 1200;
export const SHARE_H = 675;
export const SHARE_SCALE = 2;
export const SHARE_CSS = `@font-face{font-family:XckShareSans;src:url(${geist}) format('woff2');font-weight:100 900}@font-face{font-family:XckShareMono;src:url(${mono}) format('woff2');font-weight:100 900}` + cardCss;

let styled = false;
async function ready() {
  if (!styled) {
    const style = document.createElement('style');
    style.dataset.share = 'analytics';
    style.textContent = SHARE_CSS;
    document.head.append(style);
    styled = true;
  }
  await Promise.all(['400 16px XckShareSans', '600 16px XckShareSans', '400 13px XckShareMono'].map((f) => document.fonts.load(f).catch(() => [])));
}

/** What the picture says, for its accessible name and the preview's label. */
export const cardSummary = (c: ShareCard) => [c.title, c.headline ? `${c.headline.value} ${c.headline.label}` : null, c.change?.text, c.range, c.handle ? `@${c.handle}` : null].filter(Boolean).join(', ');

/**
 * Lay out a card at full size off screen, then draw its chart to exactly the room that is left, so nothing is cut
 * off whatever the notes or figures say. Returns the finished card element, detached.
 */
export async function buildShareCard(card: ShareCard): Promise<HTMLElement> {
  await ready();
  const slot = h('div', { class: 'xck-sc-slot' });
  const body = card.chart
    ? h('div', { class: 'xck-sc-body' }, card.chart.series.length > 1 ? legend(card.chart.series) : h('span', {}), slot)
    : h('div', { class: 'xck-sc-body' }, h('span', {}), h('ul', { class: 'xck-sc-bars' }, ...(card.bars ?? []).map((b) => h('li', {},
      h('span', {}, b.label), h('span', { class: 'n' }, b.value), h('span', { class: 'p' }, b.share ?? '—'),
      h('span', { class: 'b' }, h('i', { style: `width:${(Math.max(0, Math.min(1, b.frac)) * 100).toFixed(1)}%` }))))));
  const el = h('div', { class: 'xck-sc', 'data-card': card.id },
    h('div', { class: 'xck-sc-panel' },
      h('div', { class: 'xck-sc-head' },
        h('div', {}, h('h3', { class: 'xck-sc-title' }, card.title), h('p', { class: 'xck-sc-kicker' }, `${card.kicker} · ${card.range}`)),
        card.handle ? h('span', { class: 'xck-sc-handle' }, `@${card.handle}`) : null),
      card.headline ? h('div', { class: 'xck-sc-hero' },
        h('p', { class: `xck-sc-value${card.headline.tone && card.headline.tone !== 'flat' ? ` ${card.headline.tone}` : ''}` }, card.headline.value),
        h('div', { class: 'xck-sc-aside' },
          h('span', { class: 'xck-sc-label' }, card.headline.label),
          card.change ? h('span', { class: `xck-sc-change ${card.change.tone}` }, card.change.text) : null,
          card.figures.length ? h('span', { class: 'xck-sc-figures' }, card.figures.join(' · ')) : null)) : h('div', {}),
      body,
      h('div', { class: 'xck-sc-foot' },
        h('div', { class: 'xck-sc-notes' }, h('p', { class: `xck-sc-coverage${card.partial ? ' partial' : ''}` }, card.coverage), h('p', { class: 'xck-sc-def' }, card.definition)),
        h('span', { class: 'xck-sc-brand' }, h('i', {}), 'X Creator Kit'))));
  if (card.chart) {
    const holder = h('div', { style: `position:fixed;left:-100000px;top:0;width:${SHARE_W}px;height:${SHARE_H}px`, 'aria-hidden': 'true' }, el);
    document.body.append(holder);
    try {
      const width = Math.round(slot.clientWidth);
      const height = Math.max(120, Math.floor(slot.clientHeight));
      const pctFmt = (v: number) => `${compact(v * 100)}%`;
      slot.append(xyChart(card.chart.categories, card.chart.series, {
        ariaLabel: `${card.title}, ${card.range}`, width, height,
        yFormat: card.chart.percent ? pctFmt : compact,
      }));
    } finally { holder.remove(); }
  }
  return el;
}

/** Serialise the card into an SVG foreignObject with its own fonts and styles, and rasterise it at 2×. */
export async function shareCardPng(el: HTMLElement, scale = SHARE_SCALE): Promise<Blob> {
  await ready();
  const xhtml = new XMLSerializer().serializeToString(el);
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_W * scale}" height="${SHARE_H * scale}" viewBox="0 0 ${SHARE_W} ${SHARE_H}"><foreignObject x="0" y="0" width="${SHARE_W}" height="${SHARE_H}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${SHARE_CSS.replace(/</g, '\\3c ')}</style>${xhtml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(doc);
  await img.decode();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = document.createElement('canvas');
  c.width = SHARE_W * scale;
  c.height = SHARE_H * scale;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
}

// ---------- The share dialog ----------

export interface ShareSource {
  /** Builds the card for the current filters; `showHandle` comes from the dialog. */
  card: (showHandle: boolean) => ShareCard;
  fileName: (card: ShareCard) => string;
}

let dialog: HTMLDialogElement | null = null;
let current: { id: string; opener: string | null } | null = null;
let sources: Record<string, ShareSource> = {};
let showHandle = true;
let built: { card: ShareCard; el: HTMLElement } | null = null;
let seq = 0;

function parts() {
  if (dialog) return dialog;
  const close = h('button', { type: 'button', class: 'xck-share-close', 'aria-label': 'Close', 'data-key': 'share-close', onclick: () => dialog!.close() }, '×');
  const handleBox = h('input', { type: 'checkbox', 'data-key': 'share-handle', checked: true, onchange: (e) => { showHandle = (e.target as HTMLInputElement).checked; void preview(); } });
  dialog = h('dialog', { class: 'xck-share', 'aria-labelledby': 'share-title' },
    h('div', { class: 'xck-share-head' }, h('h2', { class: 'xck-section-title', id: 'share-title' }, 'Share image'), close),
    h('p', { class: 'xck-share-lede' }, 'A picture of this section with the filters you chose. Made on this device; copy it or save it, then post it yourself.'),
    h('div', { class: 'xck-share-frame' }, h('div', { class: 'xck-share-scale', role: 'img' })),
    h('div', { class: 'xck-share-actions' },
      h('label', { class: 'xck-check' }, handleBox, h('span', { class: 'xck-share-handle-label' }, 'Show @handle')),
      h('span', { class: 'xck-size' }, `PNG · ${SHARE_W * SHARE_SCALE} × ${SHARE_H * SHARE_SCALE}`),
      h('div', { class: 'xck-row xck-share-buttons' },
        h('button', { type: 'button', class: 'xck-primary', 'data-key': 'share-copy', onclick: () => void exportCard(true) }, 'Copy image'),
        h('button', { type: 'button', 'data-key': 'share-download', onclick: () => void exportCard(false) }, 'Download PNG'))),
    h('p', { class: 'xck-share-status', role: 'status', 'aria-live': 'polite' }));
  dialog.addEventListener('close', () => {
    seq++;
    const key = current?.opener;
    current = null;
    built = null;
    if (key) document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  });
  window.addEventListener('resize', fit);
  document.body.append(dialog);
  return dialog;
}

const status = (text: string, error = false) => {
  const s = dialog?.querySelector<HTMLElement>('.xck-share-status');
  if (s) { s.textContent = text; s.classList.toggle('xck-err', error); }
};

function exportReady(ready: boolean) {
  dialog?.querySelectorAll<HTMLButtonElement>('.xck-share-buttons button').forEach(button => { button.disabled = !ready; });
}

function fit() {
  const frame = dialog?.querySelector<HTMLElement>('.xck-share-frame');
  const scale = dialog?.querySelector<HTMLElement>('.xck-share-scale');
  if (!frame || !scale) return;
  const k = Math.min(1, frame.clientWidth / SHARE_W);
  scale.style.transform = `scale(${k})`;
  frame.style.height = `${Math.round(SHARE_H * k)}px`;
}

async function preview() {
  if (!dialog || !current) return;
  const src = sources[current.id];
  if (!src) { dialog.close(); return; }
  const mine = ++seq;
  built = null;
  exportReady(false);
  dialog.querySelector('.xck-share-scale')?.replaceChildren();
  status('Preparing image…');
  const hasHandle = !!src.card(true).handle;
  const box = dialog.querySelector<HTMLInputElement>('[data-key="share-handle"]')!;
  box.disabled = !hasHandle;
  box.checked = hasHandle && showHandle;
  const card = src.card(showHandle && hasHandle);
  let el: HTMLElement;
  try { el = await buildShareCard(card); }
  catch (error) {
    if (mine === seq && current) status(`Could not prepare the image: ${(error as Error).message}`, true);
    return;
  }
  if (mine !== seq || !current) return;
  built = { card, el };
  const scale = dialog.querySelector<HTMLElement>('.xck-share-scale')!;
  scale.setAttribute('aria-label', `Preview: ${cardSummary(card)}`);
  // The preview is one image to assistive tech: its label says what the picture says.
  el.setAttribute('aria-hidden', 'true');
  scale.replaceChildren(el);
  dialog.querySelector('#share-title')!.textContent = `Share image: ${card.title}`;
  fit();
  exportReady(true);
  status('');
}

async function exportCard(copy: boolean) {
  if (!built || !current) return;
  const { card, el } = built;
  const src = sources[current.id];
  try {
    if (copy) {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('this browser cannot copy images');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': shareCardPng(el) })]);
      status('Image copied. Paste it into your post on X.');
    } else {
      download(src ? src.fileName(card) : `${card.id}.png`, await shareCardPng(el));
      status('PNG downloaded.');
    }
  } catch (e) {
    status(copy ? `Could not copy the image (${(e as Error).message}). Use Download PNG instead.` : `Could not export: ${(e as Error).message}`, true);
  }
}

/** Replace the sections the page can share (after every redraw); an open dialog follows the new filters. */
export function setShareSources(next: Record<string, ShareSource>) {
  sources = next;
  if (dialog?.open && current) void preview();
}

/** Open the dialog for one section. `opener` is the data-key that gets focus back on close. */
export function openShare(id: string, opener: string | null) {
  const d = parts();
  current = { id, opener };
  status('');
  if (!d.open) d.showModal();
  void preview();
}

/** For tests and the verifier: the card currently previewed. */
export const sharedCard = () => built?.card ?? null;
