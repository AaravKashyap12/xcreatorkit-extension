/**
 * Screenshot editor: a local image workspace. Open or paste a screenshot, crop it, mark it up, frame it on a
 * background and export PNG, JPEG or WebP. Nothing leaves the page; the only files it loads are its own artwork.
 */
import { mountNavigation } from '../ui/navigation';
import { download, h, keepFocus } from '../ui/dom';
import { ARTWORK, GRADIENTS, MARK_COLORS, SOLIDS } from './wallpapers';
import {
  type Anchor, type Background, type Doc, type Layer, type Layout, type Pt, type Rect, type Tool, CANVAS_PRESETS, History,
  CANVAS_MIN, EXPORT_LONG_EDGE, SCALE_MAX, SCALE_MIN,
  clamp, clampCrop, cropToAspect, exportScales, layout, moveLayer, newDoc, placeAt, redactArea, refuseCanvas, seedShadow,
  segmentDistance, spanRect, toSource,
} from './model';
import { type Assets, MARK_FONT, layerBounds, outlinePath, paintMarks, render, sourceSpace } from './render';
import { decodeImage } from './imagefile';
import { icon, type IconName } from './icons';
import { fillRange } from './controls';
import { MAX_NAME, MAX_STYLES, type SavedStyle, applyStyle, loadStyles, storeStyles, toStyle } from './styles';

mountNavigation();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const board = $('board');
const statusEl = $('status');
const alertEl = $('alert');
const fileInput = $<HTMLInputElement>('file');
const bgInput = $<HTMLInputElement>('bg-file');
const layersPanel = $('panel-layers');
const measure = document.createElement('canvas').getContext('2d')!;

for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  el.prepend(icon(el.dataset.icon as IconName, el.classList.contains('ss-small-key') ? 18 : 20));
}

// ---------- State ----------
let source: ImageBitmap | undefined;
let name = 'screenshot';
let doc: Doc = newDoc(1600, 1000, { kind: 'art', id: ARTWORK[0]?.id ?? '' });
if (!ARTWORK.length) doc.background = { kind: 'gradient', id: GRADIENTS[0]!.id };
const history = new History();
let tool: Tool = 'select';
/** A mark's id, 'image' for the screenshot itself, or nothing. */
let selected: number | 'image' | null = null;
let nextId = 1;
const art = new Map<string, HTMLImageElement>();
/** The user's own wallpapers this visit, by the id the document refers to. Kept so undo can return to one. */
const customs = new Map<number, ImageBitmap>();
let lastCustom = 0;
let customThumb = '';
let zoom: number | null = null;
let opening = 0;
/** Keyboard drawing: a pointer the arrow keys move, and the first corner once Enter has set it. */
let cursor: Pt | null = null;
let anchor: Pt | null = null;
let cropDraft: Rect | null = null;
let cropAspect = 0;
type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'from' | 'to';
type Drag =
  | { kind: 'create'; start: Pt; layer: Layer }
  | { kind: 'move'; id: number; start: Pt; orig: Layer; moved: boolean }
  | { kind: 'handle'; id: number; handle: Handle; orig: Layer }
  | { kind: 'image'; start: Pt; orig: Doc; card: Rect; moved: boolean }
  | { kind: 'image-scale'; handle: Handle; orig: Doc; card: Rect }
  | { kind: 'crop'; mode: Handle | 'move' | 'new'; start: Pt; orig: Rect };
let drag: Drag | null = null;
/** Centre lines shown while the screenshot snaps to the middle of the canvas. */
let snapped = { x: false, y: false };
/** Display geometry of the last paint: doc pixels to CSS pixels (d), and the crop view's source-to-CSS scale. */
let view = { d: 1, L: layout(doc), cropScale: 1 };

const assets = (): Assets => ({ source: source!, art, custom: customs });
const layerById = (id: number | 'image' | null) => doc.layers.find(l => l.id === id);

let sayTimer = 0, sayFrame = 0;
function say(message: string) {
  clearTimeout(sayTimer);
  cancelAnimationFrame(sayFrame);
  statusEl.textContent = '';
  // A fresh text node makes screen readers announce a repeated message again.
  sayFrame = requestAnimationFrame(() => { statusEl.textContent = message; });
  sayTimer = window.setTimeout(() => { statusEl.textContent = ''; }, 5000);
  alertEl.hidden = true;
}
function fail(message: string) {
  clearTimeout(sayTimer);
  cancelAnimationFrame(sayFrame);
  statusEl.textContent = '';
  alertEl.textContent = message;
  alertEl.hidden = false;
}

// ---------- History ----------
function commit(label: string, merge = false) {
  if (!source) return;
  if (history.push(doc, label, merge)) syncChrome();
}
function restore(entry: { doc: Doc; label: string } | null, verb: string) {
  if (!entry) return;
  doc = entry.doc;
  if (selected !== 'image' && !layerById(selected)) selected = null;
  if (tool === 'crop') { cropDraft = null; tool = 'select'; }
  anchor = null;
  say(`${verb}: ${entry.label.toLowerCase()}.`);
  syncAll();
}
const undo = () => restore(history.undo(), 'Undone');
const redo = () => restore(history.redo(), 'Redone');
$('undo').onclick = undo;
$('redo').onclick = redo;

// ---------- Tools ----------
const TOOLS: { id: Tool; name: string; key: string; hint: string }[] = [
  { id: 'select', name: 'Select', key: 'V', hint: 'Click a mark or the screenshot, then drag it or use the arrow keys. Delete removes a mark.' },
  { id: 'crop', name: 'Crop', key: 'C', hint: 'Drag the frame or its handles. Arrow keys move it, Alt with arrow keys resizes, Enter applies.' },
  { id: 'arrow', name: 'Arrow', key: 'A', hint: 'Drag from the tail to the tip. Keyboard: arrow keys move the pointer, Enter sets each end.' },
  { id: 'box', name: 'Box', key: 'R', hint: 'Drag across what to outline. Keyboard: arrow keys move the pointer, Enter sets each corner.' },
  { id: 'text', name: 'Text', key: 'T', hint: 'Click where the text goes, then type in the Layers panel. Keyboard: arrow keys, then Enter.' },
  { id: 'step', name: 'Step', key: 'N', hint: 'Click to place the next number. Keyboard: arrow keys, then Enter.' },
  { id: 'redact', name: 'Redact', key: 'X', hint: 'Drag across what to hide. It is filled solid in every export. Keyboard: Enter at each corner.' },
];
const toolButtons = TOOLS.map(t => {
  const b = h('button', { type: 'button', class: 'ss-tool', value: t.id, 'aria-pressed': 'false', 'aria-keyshortcuts': t.key, title: `${t.name} (${t.key})`, disabled: true },
    icon(t.id as IconName), h('span', {}, t.name));
  b.onclick = () => setTool(t.id);
  $('tools').append(b);
  return b;
});

function setTool(next: Tool) {
  if (!source) return;
  if (tool === 'crop' && next !== 'crop') cropDraft = null;
  tool = next;
  anchor = null;
  drag = null;
  if (next === 'crop') { cropDraft = { ...doc.crop }; selected = null; }
  if (next !== 'select' && next !== 'crop') cursor = null;
  syncAll();
}

// ---------- Rendering ----------
const HANDLE = 9;

/** Margin around the image in the crop view, so handles on the image's edge stay whole and easy to grab. */
const CROP_M = 14;
function fitScale(w: number, h: number, margin = 0) {
  const pad = (innerWidth <= 860 ? 16 : 40) + margin;
  const availW = Math.max(40, board.clientWidth - pad * 2);
  const availH = Math.max(40, board.clientHeight - pad * 2);
  return Math.min(availW / w, availH / h);
}

function sizeCanvas(w: number, h: number) {
  const cssW = Math.max(1, Math.round(w)), cssH = Math.max(1, Math.round(h));
  // Hold the backing store to about 24 megapixels however far the view is zoomed.
  const back = Math.min(devicePixelRatio || 1, Math.sqrt(24e6 / (cssW * cssH)));
  const bw = Math.max(1, Math.round(cssW * back)), bh = Math.max(1, Math.round(cssH * back));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  return bw / cssW;
}

function paint() {
  if (!source) return;
  if (tool === 'crop' && cropDraft) return paintCrop();
  const L = layout(doc);
  const d = fitScale(L.W, L.H) * (zoom ?? 1);
  const back = sizeCanvas(L.W * d, L.H * d);
  view = { d, L, cropScale: 1 };
  render(ctx, doc, L, assets(), d * back, drag !== null);
  // Overlays: drawn in CSS pixels on top of the artwork, never exported.
  ctx.save();
  ctx.setTransform(d * back, 0, 0, d * back, 0, 0);
  if ($('guides').getAttribute('aria-pressed') === 'true') {
    ctx.beginPath();
    for (const fraction of [1 / 3, 2 / 3]) {
      ctx.moveTo(L.W * fraction, 0); ctx.lineTo(L.W * fraction, L.H);
      ctx.moveTo(0, L.H * fraction); ctx.lineTo(L.W, L.H * fraction);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.42)'; ctx.lineWidth = 2 / d; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1 / d; ctx.stroke();
  }
  sourceSpace(ctx, doc, L);
  const px = 1 / (d * L.k);
  const layer = layerById(selected);
  if (snapped.x || snapped.y) {
    const a = toSource(L, doc.crop, { x: L.W / 2, y: L.H / 2 });
    const far = Math.max(L.W, L.H) / L.k;
    ctx.beginPath();
    if (snapped.x) { ctx.moveTo(a.x, a.y - far); ctx.lineTo(a.x, a.y + far); }
    if (snapped.y) { ctx.moveTo(a.x - far, a.y); ctx.lineTo(a.x + far, a.y); }
    ctx.lineWidth = 3 * px; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.lineWidth = px; ctx.strokeStyle = '#131313'; ctx.stroke();
  }
  if (layer || selected === 'image') {
    const b = layer ? layerBounds(measure, layer) : imageBounds();
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.strokeStyle = '#131313';
    ctx.strokeRect(b.x - 4 * px, b.y - 4 * px, b.w + 8 * px, b.h + 8 * px);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.75 * px;
    ctx.strokeRect(b.x - 5.5 * px, b.y - 5.5 * px, b.w + 11 * px, b.h + 11 * px);
    for (const [, p] of layer ? handles(layer) : imageHandles()) drawHandle(p, px);
  }
  const keyboard = document.activeElement === canvas && canvas.matches(':focus-visible');
  if (anchor && cursor) {
    ctx.strokeStyle = '#131313'; ctx.lineWidth = 1.5 * px; ctx.setLineDash([4 * px, 3 * px]);
    if (tool === 'arrow') { ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(cursor.x, cursor.y); ctx.stroke(); }
    else { const r = spanRect(anchor, cursor); ctx.strokeRect(r.x, r.y, r.w, r.h); }
    ctx.setLineDash([]);
  }
  if (cursor && keyboard && tool !== 'select') {
    const s = 9 * px;
    ctx.lineWidth = 3 * px; ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(cursor.x - s, cursor.y); ctx.lineTo(cursor.x + s, cursor.y); ctx.moveTo(cursor.x, cursor.y - s); ctx.lineTo(cursor.x, cursor.y + s); ctx.stroke();
    ctx.lineWidth = 1.5 * px; ctx.strokeStyle = '#131313'; ctx.stroke();
  }
  ctx.restore();
}

function drawHandle(p: Pt, px: number) {
  const s = HANDLE * px;
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#131313'; ctx.lineWidth = 1.5 * px;
  ctx.beginPath(); ctx.rect(p.x - s / 2, p.y - s / 2, s, s); ctx.fill(); ctx.stroke();
}

function handles(layer: Layer): [Handle, Pt][] {
  if (layer.kind === 'arrow') return [['from', layer.from], ['to', layer.to]];
  if (layer.kind === 'box' || layer.kind === 'redact') {
    const r = layer.rect;
    return [['nw', { x: r.x, y: r.y }], ['ne', { x: r.x + r.w, y: r.y }], ['sw', { x: r.x, y: r.y + r.h }], ['se', { x: r.x + r.w, y: r.y + r.h }]];
  }
  return [];
}

/** The framed screenshot, window bar included, in source pixels. */
function imageBounds(): Rect {
  const L = layout(doc);
  const a = toSource(L, doc.crop, L.card);
  return { ...a, w: L.card.w / L.k, h: L.card.h / L.k };
}
function imageHandles(): [Handle, Pt][] {
  const r = imageBounds();
  return [['nw', { x: r.x, y: r.y }], ['ne', { x: r.x + r.w, y: r.y }], ['sw', { x: r.x, y: r.y + r.h }], ['se', { x: r.x + r.w, y: r.y + r.h }]];
}

function cropHandles(r: Rect): [Handle, Pt][] {
  const all: [Handle, Pt][] = [['nw', { x: r.x, y: r.y }], ['ne', { x: r.x + r.w, y: r.y }], ['sw', { x: r.x, y: r.y + r.h }], ['se', { x: r.x + r.w, y: r.y + r.h }]];
  if (!cropAspect) all.push(['n', { x: r.x + r.w / 2, y: r.y }], ['s', { x: r.x + r.w / 2, y: r.y + r.h }], ['w', { x: r.x, y: r.y + r.h / 2 }], ['e', { x: r.x + r.w, y: r.y + r.h / 2 }]);
  return all;
}

function paintCrop() {
  const src = source!, r = cropDraft!;
  const s = fitScale(src.width, src.height, CROP_M);
  const back = sizeCanvas(src.width * s + CROP_M * 2, src.height * s + CROP_M * 2);
  view.cropScale = s;
  ctx.setTransform(back, 0, 0, back, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(s * back, 0, 0, s * back, CROP_M * back, CROP_M * back);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0);
  paintMarks(ctx, doc);
  ctx.fillStyle = 'rgba(19,19,19,.62)';
  ctx.beginPath(); ctx.rect(0, 0, src.width, src.height); ctx.rect(r.x, r.y, r.w, r.h); ctx.fill('evenodd');
  const px = 1 / s;
  ctx.beginPath();
  for (const t of [1 / 3, 2 / 3]) { ctx.moveTo(r.x + r.w * t, r.y); ctx.lineTo(r.x + r.w * t, r.y + r.h); ctx.moveTo(r.x, r.y + r.h * t); ctx.lineTo(r.x + r.w, r.y + r.h * t); }
  ctx.strokeStyle = 'rgba(19,19,19,.35)'; ctx.lineWidth = 2 * px; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = px; ctx.stroke();
  ctx.strokeStyle = '#131313'; ctx.lineWidth = 3.5 * px; ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * px; ctx.strokeRect(r.x, r.y, r.w, r.h);
  for (const [, p] of cropHandles(r)) drawHandle(p, px * 1.15);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---------- Pointer ----------
function eventSource(e: PointerEvent | MouseEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
  if (tool === 'crop' && cropDraft) {
    const s = view.cropScale;
    return { x: (fx * rect.width - CROP_M) / s, y: (fy * rect.height - CROP_M) / s };
  }
  return toSource(view.L, doc.crop, { x: fx * view.L.W, y: fy * view.L.H });
}
/** The pointer in canvas pixels. */
function eventDoc(e: PointerEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / rect.width * view.L.W, y: (e.clientY - rect.top) / rect.height * view.L.H };
}
/** Source pixels per CSS pixel at the current view. */
const perCss = () => tool === 'crop' && cropDraft ? 1 / view.cropScale : 1 / (view.d * view.L.k);

function hitLayer(p: Pt): Layer | undefined {
  const tol = 6 * perCss();
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i]!;
    if (l.kind === 'arrow') { if (segmentDistance(p, l.from, l.to) <= l.width / 2 + tol) return l; continue; }
    const b = layerBounds(measure, l);
    if (l.kind === 'box') {
      measure.lineWidth = l.width + 2 * tol;
      if (measure.isPointInStroke(outlinePath(l), p.x, p.y)) return l;
      continue;
    }
    if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return l;
  }
  return undefined;
}

function hitHandle(list: [Handle, Pt][], p: Pt): Handle | null {
  const tol = (HANDLE / 2 + 5) * perCss();
  for (const [hd, q] of list) if (Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol) return hd;
  return null;
}

const markWidth = () => Math.max(2, Math.round(Math.min(doc.crop.w, doc.crop.h) / 140));
const textSize = () => Math.max(14, Math.round(Math.min(doc.crop.w, doc.crop.h * 1.6) / 34));
const stepSize = () => Math.max(22, Math.round(Math.min(doc.crop.w, doc.crop.h) / 16));
let lastColor = MARK_COLORS[0]!.color;

function newLayer(kind: Tool, p: Pt): Layer | null {
  const id = nextId++;
  switch (kind) {
    case 'arrow': return { id, kind, from: p, to: p, color: lastColor, width: markWidth() };
    case 'box': return { id, kind, rect: { x: p.x, y: p.y, w: 0, h: 0 }, color: lastColor, width: markWidth() };
    case 'redact': return { id, kind, rect: { x: p.x, y: p.y, w: 0, h: 0 }, color: '#131313' };
    case 'text': return { id, kind, at: p, text: 'Label', color: '#131313', size: textSize(), style: 'label' };
    case 'step': return { id, kind, at: p, n: Math.max(0, ...doc.layers.map(l => l.kind === 'step' ? l.n : 0)) + 1, color: lastColor, size: stepSize() };
    default: return null;
  }
}

/** Finish a drawn mark: keep it if it has size, otherwise say what to do. */
function finishCreate(layer: Layer, keyboard = false): boolean {
  const min = Math.max(2, 3 * perCss());
  if (layer.kind === 'arrow' && Math.hypot(layer.to.x - layer.from.x, layer.to.y - layer.from.y) < min * 3) {
    say(keyboard ? 'Move the pointer before setting the tip.' : 'Drag from the tail to the tip to draw an arrow.'); return false;
  }
  if (layer.kind === 'box' && (layer.rect.w < min || layer.rect.h < min)) {
    say(keyboard ? 'Move the pointer to set the opposite corner.' : 'Drag across an area to draw a box.'); return false;
  }
  if (layer.kind === 'redact') {
    const area = redactArea(layer.rect, doc.crop, min);
    if (!area) { say('Nothing was redacted. Drag across part of the screenshot to cover it.'); return false; }
    layer.rect = area;
  }
  doc.layers.push(layer);
  selected = layer.id;
  const label = { arrow: 'Add arrow', box: 'Add box', redact: 'Add redaction', text: 'Add text', step: 'Add step' }[layer.kind];
  commit(label);
  say(`${label.replace('Add ', '')[0]!.toUpperCase()}${label.replace('Add ', '').slice(1)} added.`);
  showTab('layers');
  if (layer.kind === 'text') {
    tool = 'select';
    syncAll();
    const field = document.getElementById('layer-text') as HTMLTextAreaElement | null;
    field?.focus(); field?.select();
  } else syncAll();
  return true;
}

// The canvas takes focus in pointerdown; the default would take it back from the text box a click just opened.
canvas.addEventListener('mousedown', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (!source || !e.isPrimary || e.button !== 0) return;
  canvas.focus({ preventScroll: true });
  const p = eventSource(e);
  if (tool === 'crop' && cropDraft) {
    const hd = hitHandle(cropHandles(cropDraft), p);
    const r = cropDraft;
    const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    drag = { kind: 'crop', mode: hd ?? (inside ? 'move' : 'new'), start: p, orig: { ...r } };
  } else if (tool === 'select') {
    const current = layerById(selected);
    const hd = current ? hitHandle(handles(current), p) : selected === 'image' ? hitHandle(imageHandles(), p) : null;
    const card = { ...view.L.card };
    if (hd) showTab('layers');
    if (current && hd) drag = { kind: 'handle', id: current.id, handle: hd, orig: structuredClone(current) };
    else if (hd) drag = { kind: 'image-scale', handle: hd, orig: structuredClone(doc), card };
    else {
      const hit = hitLayer(p);
      const q = eventDoc(e);
      const onImage = q.x >= card.x && q.x <= card.x + card.w && q.y >= card.y && q.y <= card.y + card.h;
      selected = hit?.id ?? (onImage ? 'image' : null);
      if (selected === 'image') { drag = { kind: 'image', start: q, orig: structuredClone(doc), card, moved: false }; showTab('layers'); }
      if (hit) { drag = { kind: 'move', id: hit.id, start: p, orig: structuredClone(hit), moved: false }; showTab('layers'); }
      syncLayers();
    }
  } else {
    const layer = newLayer(tool, p);
    if (!layer) return;
    if (layer.kind === 'text' || layer.kind === 'step') { finishCreate(layer); return; }
    drag = { kind: 'create', start: p, layer };
  }
  canvas.setPointerCapture(e.pointerId);
  paint();
});

canvas.addEventListener('pointermove', e => {
  if (!source) return;
  if (!drag) {
    if (tool === 'select') {
      const current = layerById(selected);
      const p = eventSource(e);
      const hd = current ? hitHandle(handles(current), p) : selected === 'image' ? hitHandle(imageHandles(), p) : null;
      canvas.style.cursor = hd === 'ne' || hd === 'sw' ? 'nesw-resize' : hd ? 'nwse-resize' : hitLayer(p) ? 'move' : 'default';
    } else if (tool === 'crop' && cropDraft) {
      const p = eventSource(e);
      const hd = hitHandle(cropHandles(cropDraft), p);
      const r = cropDraft;
      canvas.style.cursor = hd ? ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' } as Record<string, string>)[hd] ?? 'move'
        : p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h ? 'move' : 'crosshair';
    } else canvas.style.cursor = 'crosshair';
    return;
  }
  if (!canvas.hasPointerCapture(e.pointerId)) return;
  const p = eventSource(e);
  if (drag.kind === 'crop') { cropDraft = dragCrop(drag, p, e.shiftKey); syncCropFields(); }
  else if (drag.kind === 'create') {
    const l = drag.layer;
    if (l.kind === 'arrow') l.to = p;
    else if (l.kind === 'box' || l.kind === 'redact') l.rect = spanRect(drag.start, p);
    paintWith(l);
    return;
  } else if (drag.kind === 'move') {
    const i = doc.layers.findIndex(l => l.id === (drag as { id: number }).id);
    if (i >= 0) { doc.layers[i] = moveLayer(drag.orig, p.x - drag.start.x, p.y - drag.start.y); drag.moved = true; }
  } else if (drag.kind === 'handle') {
    const i = doc.layers.findIndex(l => l.id === (drag as { id: number }).id);
    if (i >= 0) doc.layers[i] = resizeLayer(drag.orig, drag.handle, p);
  } else if (drag.kind === 'image') dragImage(drag, eventDoc(e), e.altKey);
  else if (drag.kind === 'image-scale') scaleImage(drag, eventDoc(e));
  paint();
});

function dragImage(d: Extract<Drag, { kind: 'image' }>, q: Pt, free: boolean) {
  const dx = q.x - d.start.x, dy = q.y - d.start.y;
  if (!d.moved && Math.hypot(dx, dy) * view.d < 3) return;
  d.moved = true;
  let x = d.card.x + dx, y = d.card.y + dy;
  const near = 6 / view.d;
  const cx = (view.L.W - d.card.w) / 2, cy = (view.L.H - d.card.h) / 2;
  snapped = { x: !free && Math.abs(x - cx) < near, y: !free && Math.abs(y - cy) < near };
  if (snapped.x) x = cx;
  if (snapped.y) y = cy;
  doc = placeAt(d.orig, x, y);
}
/** Scale from a corner; the opposite corner stays where it is. */
function scaleImage(d: Extract<Drag, { kind: 'image-scale' }>, q: Pt) {
  const r = d.card, west = d.handle.includes('w'), north = d.handle.includes('n');
  const fixed = { x: west ? r.x + r.w : r.x, y: north ? r.y + r.h : r.y };
  const ratio = Math.max((west ? fixed.x - q.x : q.x - fixed.x) / r.w, (north ? fixed.y - q.y : q.y - fixed.y) / r.h);
  const scale = Math.round(clamp(d.orig.scale * Math.max(ratio, 0.01), SCALE_MIN, SCALE_MAX) * 10) / 10;
  const next = { ...d.orig, scale };
  const size = layout(next).card;
  doc = placeAt(next, west ? fixed.x - size.w : fixed.x, north ? fixed.y - size.h : fixed.y);
}

/** Preview a mark that is still being drawn. */
function paintWith(layer: Layer) {
  doc.layers.push(layer);
  paint();
  doc.layers.pop();
}

function resizeLayer(orig: Layer, hd: Handle, p: Pt): Layer {
  if (orig.kind === 'arrow') return hd === 'from' ? { ...orig, from: p } : { ...orig, to: p };
  if (orig.kind === 'box' || orig.kind === 'redact') {
    const r = orig.rect;
    const fixed = { x: hd.includes('w') ? r.x + r.w : r.x, y: hd.includes('n') ? r.y + r.h : r.y };
    return { ...orig, rect: spanRect(fixed, p) };
  }
  return orig;
}

function dragCrop(d: Extract<Drag, { kind: 'crop' }>, p: Pt, square: boolean): Rect {
  const W = source!.width, H = source!.height, o = d.orig;
  const aspect = cropAspect || (square ? 1 : 0);
  if (d.mode === 'move') {
    return clampCrop({ ...o, x: o.x + p.x - d.start.x, y: o.y + p.y - d.start.y }, W, H);
  }
  const px = clamp(p.x, 0, W), py = clamp(p.y, 0, H);
  if (d.mode === 'n' || d.mode === 's' || d.mode === 'e' || d.mode === 'w') {
    const r = { ...o };
    if (d.mode === 'n') { r.y = Math.min(py, o.y + o.h - 8); r.h = o.y + o.h - r.y; }
    if (d.mode === 's') r.h = Math.max(8, py - o.y);
    if (d.mode === 'w') { r.x = Math.min(px, o.x + o.w - 8); r.w = o.x + o.w - r.x; }
    if (d.mode === 'e') r.w = Math.max(8, px - o.x);
    return clampCrop(r, W, H);
  }
  const anchorPt = d.mode === 'new' ? d.start : {
    x: d.mode.includes('w') ? o.x + o.w : o.x,
    y: d.mode.includes('n') ? o.y + o.h : o.y,
  };
  if (!aspect) return clampCrop(spanRect(anchorPt, { x: px, y: py }), W, H);
  const dirX = px >= anchorPt.x ? 1 : -1, dirY = py >= anchorPt.y ? 1 : -1;
  const maxW = dirX > 0 ? W - anchorPt.x : anchorPt.x, maxH = dirY > 0 ? H - anchorPt.y : anchorPt.y;
  let w = Math.max(Math.abs(px - anchorPt.x), Math.abs(py - anchorPt.y) * aspect);
  w = Math.max(8, Math.min(w, maxW, maxH * aspect));
  const hgt = w / aspect;
  return clampCrop({ x: dirX > 0 ? anchorPt.x : anchorPt.x - w, y: dirY > 0 ? anchorPt.y : anchorPt.y - hgt, w, h: hgt }, W, H);
}

function keepRedaction(id: number, orig: Layer): boolean {
  const i = doc.layers.findIndex(l => l.id === id);
  const l = doc.layers[i];
  if (l?.kind !== 'redact' || redactArea(l.rect, doc.crop, 2)) return true;
  doc.layers[i] = orig;
  say('A redaction has to cover part of the screenshot, so it is back where it was.');
  return false;
}

function endDrag(e: PointerEvent) {
  if (!drag) return;
  const d = drag;
  drag = null;
  snapped = { x: false, y: false };
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (e.type === 'pointercancel') {
    if (d.kind === 'move' || d.kind === 'handle') { const i = doc.layers.findIndex(l => l.id === d.id); if (i >= 0) doc.layers[i] = d.orig; }
    if (d.kind === 'image' || d.kind === 'image-scale') doc = d.orig;
    if (d.kind === 'crop') cropDraft = d.orig;
    paint();
    return;
  }
  if (d.kind === 'create') {
    const p = eventSource(e);
    const l = d.layer;
    if (l.kind === 'arrow') l.to = p; else if (l.kind === 'box' || l.kind === 'redact') l.rect = spanRect(d.start, p);
    if (!finishCreate(l)) paint();
    return;
  }
  if ((d.kind === 'move' && d.moved) || d.kind === 'handle') {
    // A redaction that has been dragged or shrunk until it hides nothing goes back where it was.
    if (keepRedaction(d.id, d.orig)) commit(d.kind === 'move' ? 'Move mark' : 'Resize mark');
  }
  if (d.kind === 'image' && d.moved) commit('Move screenshot');
  if (d.kind === 'image-scale') commit('Scale screenshot');
  syncAll();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('dblclick', e => {
  const hit = hitLayer(eventSource(e));
  if (hit?.kind === 'text') { selected = hit.id; showTab('layers'); syncAll(); ($('layer-text') as HTMLTextAreaElement | null)?.focus(); }
});
canvas.addEventListener('focus', () => paint());
canvas.addEventListener('blur', () => { anchor = null; paint(); });

// ---------- Keyboard on the canvas ----------
canvas.addEventListener('keydown', e => {
  if (!source || e.metaKey || e.ctrlKey) return;
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const dir = arrows[e.key];
  if (tool === 'crop' && cropDraft) {
    const step = Math.max(1, Math.round(Math.min(source.width, source.height) / 100)) * (e.shiftKey ? 10 : 1);
    if (dir) {
      const r = { ...cropDraft };
      if (e.altKey) { r.w += dir[0] * step; r.h += dir[1] * step; if (cropAspect) { if (dir[0]) r.h = r.w / cropAspect; else r.w = r.h * cropAspect; } }
      else { r.x += dir[0] * step; r.y += dir[1] * step; }
      cropDraft = clampCrop(r, source.width, source.height);
      syncCropFields();
      paint();
    } else if (e.key === 'Enter') applyCrop();
    else if (e.key === 'Escape') cancelCrop();
    else return;
    e.preventDefault();
    return;
  }
  const unit = perCss() * (e.shiftKey ? 10 : 1);
  if (tool === 'select') {
    const layer = layerById(selected);
    if (dir && layer) {
      const i = doc.layers.indexOf(layer);
      doc.layers[i] = moveLayer(layer, dir[0] * unit, dir[1] * unit);
      if (keepRedaction(layer.id, layer)) commit('Nudge mark', true);
      paint();
    } else if (dir && selected === 'image') {
      const c = layout(doc).card, by = e.shiftKey ? 10 : 1;
      doc = placeAt(doc, c.x + dir[0] * by, c.y + dir[1] * by);
      commit('Nudge screenshot', true);
      paint(); syncPlacement();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && layer) deleteLayer(layer.id);
    else if (e.key === 'Escape' && selected !== null) { selected = null; syncAll(); say('Selection cleared.'); }
    else return;
    e.preventDefault();
    return;
  }
  // Drawing tools: the arrow keys move a pointer that starts in the middle of the screenshot.
  cursor ??= { x: doc.crop.x + doc.crop.w / 2, y: doc.crop.y + doc.crop.h / 2 };
  const step = unit * 8;
  if (dir) cursor = { x: clamp(cursor.x + dir[0] * step, doc.crop.x, doc.crop.x + doc.crop.w), y: clamp(cursor.y + dir[1] * step, doc.crop.y, doc.crop.y + doc.crop.h) };
  else if (e.key === 'Enter') {
    if (tool === 'text' || tool === 'step') { const l = newLayer(tool, cursor); if (l) finishCreate(l, true); }
    else if (!anchor) { anchor = cursor; say('First point set. Move with the arrow keys and press Enter again.'); }
    else {
      const l = newLayer(tool, anchor);
      if (l) {
        if (l.kind === 'arrow') l.to = cursor; else if (l.kind === 'box' || l.kind === 'redact') l.rect = spanRect(anchor, cursor);
        if (finishCreate(l, true)) anchor = null;
      }
    }
  } else if (e.key === 'Escape') { if (anchor) { anchor = null; say('Point cleared.'); } else setTool('select'); }
  else return;
  e.preventDefault();
  paint();
});

// ---------- Global shortcuts ----------
document.addEventListener('keydown', e => {
  if ($<HTMLDialogElement>('export-dialog').open || (e.target as HTMLElement).closest('textarea, select, input:not([type=range], [type=color])')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey || !source) return;
  if (e.key === 'Escape' && tool === 'crop') { e.preventDefault(); cancelCrop(); return; }
  if (e.key === 'Escape' && tool !== 'select') { e.preventDefault(); setTool('select'); return; }
  const t = TOOLS.find(x => x.key.toLowerCase() === e.key.toLowerCase());
  if (t) { e.preventDefault(); setTool(t.id); }
});

// ---------- Crop ----------
function syncCropFields() {
  if (!cropDraft) return;
  const r = cropDraft;
  for (const [id, v] of [['crop-x', r.x], ['crop-y', r.y], ['crop-w', r.w], ['crop-h', r.h]] as const) {
    const input = $<HTMLInputElement>(id);
    if (document.activeElement !== input) input.value = String(Math.round(v));
  }
  if (source) { $<HTMLInputElement>('crop-w').max = String(source.width); $<HTMLInputElement>('crop-h').max = String(source.height); }
}
for (const id of ['crop-x', 'crop-y', 'crop-w', 'crop-h']) {
  $<HTMLInputElement>(id).addEventListener('change', () => {
    if (!cropDraft || !source) return;
    const v = (k: string) => $<HTMLInputElement>(k).valueAsNumber;
    let r = { x: v('crop-x'), y: v('crop-y'), w: v('crop-w'), h: v('crop-h') };
    for (const k of ['x', 'y', 'w', 'h'] as const) if (!Number.isFinite(r[k])) r[k] = cropDraft[k];
    if (cropAspect) { if (id === 'crop-h') r.w = r.h * cropAspect; else r.h = r.w / cropAspect; }
    r = clampCrop(r, source.width, source.height);
    cropDraft = r;
    for (const k of ['crop-x', 'crop-y', 'crop-w', 'crop-h']) $<HTMLInputElement>(k).value = String(Math.round(r[k.slice(5) as 'x']));
    paint();
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#crop-aspect button')) {
  b.onclick = () => {
    cropAspect = Number(b.value);
    if (cropAspect && cropDraft && source) cropDraft = cropToAspect(cropDraft, cropAspect, source.width, source.height);
    syncAll();
  };
}
function applyCrop() {
  if (!cropDraft || !source) return;
  doc.crop = clampCrop(cropDraft, source.width, source.height);
  cropDraft = null;
  tool = 'select';
  commit('Crop');
  say(`Cropped to ${doc.crop.w} × ${doc.crop.h} px.`);
  syncAll();
  canvas.focus({ preventScroll: true });
}
function cancelCrop() {
  cropDraft = null; tool = 'select';
  say('Crop cancelled.');
  syncAll();
}
$('crop-apply').onclick = applyCrop;
$('crop-cancel').onclick = cancelCrop;
$('crop-reset').onclick = () => {
  if (!source || !cropDraft) return;
  cropAspect = 0;
  cropDraft = { x: 0, y: 0, w: source.width, h: source.height };
  syncAll();
};

// ---------- Layers ----------
function deleteLayer(id: number) {
  const i = doc.layers.findIndex(l => l.id === id);
  if (i < 0) return;
  const label = layerName(doc.layers[i]!);
  doc.layers.splice(i, 1);
  selected = doc.layers[Math.min(i, doc.layers.length - 1)]?.id ?? null;
  commit('Delete mark');
  say(`${label} deleted.`);
  syncAll();
}
function reorder(id: number, by: number) {
  const i = doc.layers.findIndex(l => l.id === id);
  const j = clamp(i + by, 0, doc.layers.length - 1);
  if (i < 0 || i === j) return;
  const [l] = doc.layers.splice(i, 1);
  doc.layers.splice(j, 0, l!);
  commit(by > 0 ? 'Bring forward' : 'Send backward');
  syncAll();
}
function duplicate(id: number) {
  const l = layerById(id);
  if (!l) return;
  const off = 16 * perCss();
  const copy = { ...moveLayer(structuredClone(l), off, off), id: nextId++ } as Layer;
  if (copy.kind === 'step') copy.n = Math.max(...doc.layers.map(x => x.kind === 'step' ? x.n : 0)) + 1;
  doc.layers.splice(doc.layers.indexOf(l) + 1, 0, copy);
  selected = copy.id;
  commit('Duplicate mark');
  say(`${layerName(copy)} duplicated.`);
  syncAll();
}
function layerName(l: Layer): string {
  switch (l.kind) {
    case 'arrow': return 'Arrow';
    case 'box': return l.oval ? 'Oval' : 'Box';
    case 'redact': return 'Redaction';
    case 'step': return `Step ${l.n}`;
    case 'text': { const t = l.text.trim().split('\n')[0] ?? ''; return t ? `Text “${t.length > 22 ? t.slice(0, 21) + '…' : t}”` : 'Text'; }
  }
}
const KIND_ICON: Record<Layer['kind'], IconName> = { arrow: 'arrow', box: 'box', redact: 'redact', text: 'text', step: 'step' };

/** A slider for a number on the selected mark. The mark is looked up each time: moving it replaces the object. */
function markSlider(id: number, key: 'size' | 'width', label: string, max: number, min: number, commitLabel: string) {
  const el = h('div', {});
  const mark = () => layerById(id) as (Layer & Partial<Record<'size' | 'width', number>>) | undefined;
  fillRange(el, { id: `layer-${key}`, label, min, max, step: 1, unit: 'px', get: () => mark()?.[key] ?? min, set: v => { const m = mark(); if (m) { m[key] = v; paint(); } }, commit: run => commit(commitLabel, run) });
  return el;
}

function colorChips(layer: Layer) {
  const wrap = h('div', { class: 'ss-chips ss-mark-colors', role: 'group', 'aria-label': 'Colour' });
  const options = layer.kind === 'redact' ? [{ name: 'Ink', color: '#131313' }, { name: 'Paper', color: '#ffffff' }] : MARK_COLORS;
  for (const c of options) {
    const b = h('button', { type: 'button', class: 'ss-chip', 'aria-pressed': String(layer.color === c.color), 'aria-label': c.name, title: c.name, 'data-key': `color:${c.color}` });
    b.style.setProperty('--chip', c.color);
    b.onclick = () => {
      const now = layerById(layer.id);
      if (!now) return;
      now.color = c.color;
      if (now.kind !== 'redact' && now.kind !== 'text') lastColor = c.color;
      commit('Change colour');
      syncLayers(); paint();
    };
    wrap.append(b);
  }
  return wrap;
}

let syncPlacement = () => {};
function layerRow(key: string, pressed: boolean, ic: IconName, label: string, onclick: () => void) {
  const b = h('button', { type: 'button', class: 'ss-layer', 'aria-pressed': String(pressed), 'data-key': key }, icon(ic, 18), h('span', {}, label));
  b.onclick = onclick;
  return h('li', {}, b);
}
function pick(id: number | 'image') {
  selected = id === selected ? null : id;
  tool = 'select';
  syncAll();
}

function syncLayers() {
  $('layer-count').textContent = String(doc.layers.length);
  keepFocus(layersPanel, () => {
    layersPanel.replaceChildren();
    syncPlacement = () => {};
    if (!source) {
      layersPanel.append(h('div', { class: 'ss-layers-empty' }, h('p', { class: 'ss-panel-title' }, 'Layers'), h('p', { class: 'ss-note' }, 'Open an image, then draw on it. Each mark is listed here above the screenshot.')));
      return;
    }
    const list = h('ol', { class: 'ss-layer-list', 'aria-label': 'Layers, top first' });
    for (const l of [...doc.layers].reverse()) list.append(layerRow(`layer:${l.id}`, l.id === selected, KIND_ICON[l.kind], layerName(l), () => pick(l.id)));
    list.append(layerRow('layer:image', selected === 'image', 'image', 'Screenshot', () => pick('image')));
    layersPanel.append(list);
    if (selected === 'image') { layersPanel.append(placementPanel()); return; }
    const l = layerById(selected);
    if (!l) { layersPanel.append(h('p', { class: 'ss-note' }, doc.layers.length ? 'Select a layer to change it.' : 'Select the screenshot to scale or align it, or draw a mark with the tools on the left.')); return; }
    layersPanel.append(markPanel(l));
  });
}

/** Scale, alignment and exact position of the screenshot on the canvas. */
function placementPanel() {
  const props = h('section', { class: 'ss-props', 'aria-label': 'Screenshot placement' }, h('h3', { class: 'ss-label' }, 'Placement'));
  const scaleEl = h('div', {});
  const scaleRow = fillRange(scaleEl, { id: 'image-scale', label: 'Scale', min: SCALE_MIN, max: SCALE_MAX, step: 1, unit: '%', get: () => doc.scale, set: v => { doc.scale = v; paint(); syncXY(); }, commit: run => commit('Scale screenshot', run) });
  const grid = h('div', { class: 'ss-align', role: 'group', 'aria-label': 'Align on canvas' });
  const names = [['top left', 'top', 'top right'], ['left', 'centre', 'right'], ['bottom left', 'bottom', 'bottom right']];
  for (const ay of [-1, 0, 1] as Anchor[]) for (const ax of [-1, 0, 1] as Anchor[]) {
    const label = `Align ${names[ay + 1]![ax + 1]}`;
    const b = h('button', { type: 'button', 'data-key': `align:${ax}:${ay}`, 'aria-label': label, title: label });
    b.onclick = () => { Object.assign(doc, { anchorX: ax, anchorY: ay, offsetX: 0, offsetY: 0 }); commit(label); paint(); syncLayers(); };
    b.setAttribute('aria-pressed', String(doc.anchorX === ax && doc.anchorY === ay && Math.abs(doc.offsetX) < 0.5 && Math.abs(doc.offsetY) < 0.5));
    grid.append(b);
  }
  const coord = (axis: 'x' | 'y', label: string) => {
    const input = h('input', { type: 'number', step: '1', id: `image-${axis}`, 'data-key': `image-${axis}`, inputmode: 'numeric' });
    input.addEventListener('change', () => {
      const c = layout(doc).card;
      if (Number.isFinite(input.valueAsNumber)) doc = placeAt(doc, axis === 'x' ? input.valueAsNumber : c.x, axis === 'y' ? input.valueAsNumber : c.y);
      commit('Move screenshot');
      paint(); syncXY(true);
    });
    return { input, el: h('div', { class: 'ss-field' }, h('label', { for: `image-${axis}` }, label), input) };
  };
  const x = coord('x', 'X, px'), y = coord('y', 'Y, px');
  const readout = h('p', { class: 'ss-note ss-mono-note' });
  function syncXY(force = false) {
    const c = layout(doc).card;
    for (const [f, v] of [[x.input, c.x], [y.input, c.y]] as const) if (force || document.activeElement !== f) f.value = String(Math.round(v));
    readout.textContent = `${Math.round(c.w)} × ${Math.round(c.h)} px on the canvas`;
  }
  syncPlacement = () => {
    scaleRow.sync(); syncXY();
    for (const b of grid.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.key === `align:${doc.anchorX}:${doc.anchorY}` && Math.abs(doc.offsetX) < 0.5 && Math.abs(doc.offsetY) < 0.5));
  };
  const reset = h('button', { type: 'button', class: 'ss-act', 'data-key': 'place-reset' }, 'Reset placement');
  reset.onclick = () => { Object.assign(doc, { scale: 100, anchorX: 0, anchorY: 0, offsetX: 0, offsetY: 0 }); commit('Reset placement'); paint(); syncLayers(); };
  props.append(scaleEl, h('p', { class: 'ss-note' }, '100% fills the space inside the padding. Marks move and scale with the screenshot.'),
    h('div', { class: 'ss-place' }, grid, h('div', { class: 'ss-place-xy' }, x.el, y.el)), readout, reset);
  syncXY(true);
  return props;
}

function markPanel(l: Layer) {
  const props = h('section', { class: 'ss-props', 'aria-label': `${layerName(l)} settings` }, h('h3', { class: 'ss-label' }, layerName(l)));
  // Moving a mark replaces its object, so every control reads the current one.
  const cur = <K extends Layer['kind']>(kind: K) => { const m = layerById(l.id); return m?.kind === kind ? m as Extract<Layer, { kind: K }> : undefined; };
  const sizeMax = Math.max(160, Math.round(doc.crop.h / 5));
  if (l.kind === 'text') {
    const ta = h('textarea', { id: 'layer-text', rows: '3', 'data-key': 'layer-text', spellcheck: 'true' });
    ta.value = l.text;
    ta.addEventListener('input', () => { const t = cur('text'); if (t) { t.text = ta.value; paint(); } });
    ta.addEventListener('change', () => {
      commit('Edit text');
      const name = layerName(cur('text') ?? l);
      const row = layersPanel.querySelector(`[data-key="layer:${l.id}"] span`);
      if (row) row.textContent = name;
      props.querySelector('h3')!.textContent = name;
    });
    props.append(h('div', { class: 'ss-field' }, h('label', { for: 'layer-text' }, 'Text'), ta));
    const seg = h('div', { class: 'xck-seg ss-seg', role: 'group', 'aria-label': 'Text style' });
    for (const [v, n] of [['label', 'Label'], ['ink', 'Filled'], ['plain', 'Plain']] as const) {
      const b = h('button', { type: 'button', 'aria-pressed': String(l.style === v), 'data-key': `style:${v}` }, n);
      b.onclick = () => { const t = cur('text'); if (t) { t.style = v; commit('Text style'); syncLayers(); paint(); } };
      seg.append(b);
    }
    props.append(h('p', { class: 'ss-sublabel' }, 'Style'), seg, markSlider(l.id, 'size', 'Size', sizeMax, 8, 'Text size'));
  }
  if (l.kind === 'step') {
    const n = h('input', { type: 'number', id: 'layer-n', min: '0', max: '999', value: String(l.n), 'data-key': 'layer-n', inputmode: 'numeric' });
    n.addEventListener('change', () => { const t = cur('step'); if (t && Number.isFinite(n.valueAsNumber)) { t.n = clamp(Math.round(n.valueAsNumber), 0, 999); commit('Change number'); syncLayers(); paint(); } });
    props.append(h('div', { class: 'ss-field' }, h('label', { for: 'layer-n' }, 'Number'), n), markSlider(l.id, 'size', 'Size', sizeMax, 12, 'Step size'));
  }
  if (l.kind === 'box') {
    const shapes = h('div', {class: 'xck-seg ss-seg', role: 'group', 'aria-label': 'Outline shape'});
    for (const name of ['Rectangle', 'Oval']) {
      const oval = name === 'Oval';
      const button = h('button', {type: 'button', 'aria-pressed': String(!!l.oval === oval), 'data-key': 'shape:' + name}, name);
      button.onclick = () => {
        const box = cur('box');
        if (!box || !!box.oval === oval) return;
        box.oval = oval;
        commit('Outline shape'); syncLayers(); paint();
      };
      shapes.append(button);
    }
    props.append(shapes);
  }
  if (l.kind === 'arrow' || l.kind === 'box') props.append(markSlider(l.id, 'width', 'Weight', Math.max(40, markWidth() * 5), 1, 'Line weight'));
  if (l.kind === 'redact') props.append(h('p', { class: 'ss-note' }, 'Solid fill. What is underneath never reaches the export.'));
  props.append(h('p', { class: 'ss-sublabel' }, 'Colour'), colorChips(l));
  const i = doc.layers.findIndex(x => x.id === l.id);
  const act = (ic: IconName, text: string, fn: () => void, disabled = false, cls = '') => {
    const b = h('button', { type: 'button', class: `ss-act ${cls}`, 'data-key': `act:${text}`, disabled }, icon(ic, 18), h('span', {}, text));
    b.onclick = fn;
    return b;
  };
  props.append(h('div', { class: 'ss-layer-actions' },
    act('up', 'Forward', () => reorder(l.id, 1), i === doc.layers.length - 1),
    act('down', 'Backward', () => reorder(l.id, -1), i === 0),
    act('duplicate', 'Duplicate', () => duplicate(l.id)),
    act('trash', 'Delete', () => deleteLayer(l.id), false, 'xck-danger')));
  return props;
}

// ---------- Inspector: tabs ----------
type Tab = 'frame' | 'background' | 'layers';
const tabs: Tab[] = ['frame', 'background', 'layers'];
function showTab(t: Tab, focus = false) {
  for (const x of tabs) {
    const tab = $(`tab-${x}`);
    tab.setAttribute('aria-selected', String(x === t));
    tab.tabIndex = x === t ? 0 : -1;
    $(`panel-${x}`).hidden = x !== t || tool === 'crop';
  }
  if (focus) $(`tab-${t}`).focus();
}
for (const t of tabs) {
  const tab = $(`tab-${t}`);
  tab.onclick = () => showTab(t);
  tab.onkeydown = e => {
    const i = tabs.indexOf(t);
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % 3] : e.key === 'ArrowLeft' ? tabs[(i + 2) % 3] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[2] : null;
    if (next) { e.preventDefault(); showTab(next, true); }
  };
}

// ---------- Inspector: frame ----------
for (const p of CANVAS_PRESETS) {
  const b = h('button', { type: 'button', class: 'ss-preset', value: p.id, 'aria-pressed': 'false' },
    h('span', { class: 'ss-preset-shape', 'aria-hidden': 'true' }), h('span', { class: 'ss-preset-name' }, p.name),
    h('span', { class: 'ss-preset-size' }, p.w ? `${p.w} × ${p.h}` : p.id === 'custom' ? 'Any size' : 'Image size'));
  const shape = b.firstChild as HTMLElement;
  const ratio = p.w ? p.w / p.h : 1.4;
  shape.style.width = `${Math.round(ratio >= 1 ? 22 : 22 * ratio)}px`;
  shape.style.height = `${Math.round(ratio >= 1 ? 22 / ratio : 22)}px`;
  if (!p.w) shape.classList.add('ss-fit');
  b.onclick = () => {
    // Custom starts from the size on screen, so choosing it changes nothing until a number does.
    if (p.id === 'custom' && doc.canvas !== 'custom') { const L = layout(doc); doc.canvasW = Math.max(CANVAS_MIN, L.W); doc.canvasH = Math.max(CANVAS_MIN, L.H); }
    doc.canvas = p.id;
    commit(`Canvas ${p.name}`); syncAll();
  };
  $('presets').append(b);
}
// Custom canvas, in exact pixels.
const sizeW = $<HTMLInputElement>('canvas-w'), sizeH = $<HTMLInputElement>('canvas-h');
const sizeError = $('canvas-error');
for (const i of [sizeW, sizeH]) { i.min = String(CANVAS_MIN); i.max = String(EXPORT_LONG_EDGE); i.addEventListener('change', applySize); }
function applySize() {
  const w = sizeW.valueAsNumber, hgt = sizeH.valueAsNumber;
  const reason = refuseCanvas(w, hgt);
  const bad = (v: number) => !Number.isInteger(v) || v < CANVAS_MIN || v > EXPORT_LONG_EDGE;
  for (const [i, v] of [[sizeW, w], [sizeH, hgt]] as const) { if (reason && (bad(v) || !(bad(w) || bad(hgt)))) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); }
  sizeError.textContent = reason ?? '';
  sizeError.hidden = !reason;
  if (reason) return;
  doc.canvasW = w; doc.canvasH = hgt;
  commit('Canvas size');
  paint(); syncChrome(); syncPlacement();
}
$('canvas-swap').onclick = () => { [sizeW.value, sizeH.value] = [sizeH.value, sizeW.value]; applySize(); };
function syncSize() {
  $('custom-size').hidden = doc.canvas !== 'custom';
  if (document.activeElement !== sizeW && !sizeW.hasAttribute('aria-invalid')) sizeW.value = String(doc.canvasW);
  if (document.activeElement !== sizeH && !sizeH.hasAttribute('aria-invalid')) sizeH.value = String(doc.canvasH);
}
/** Show the document's size again, dropping a typed size that was refused. */
function resetSize() {
  for (const i of [sizeW, sizeH]) i.removeAttribute('aria-invalid');
  sizeError.hidden = true;
  sizeW.value = String(doc.canvasW); sizeH.value = String(doc.canvasH);
}

const rows: { sync: () => void; disable: (off: boolean) => void }[] = [];
function docRange(key: 'padding' | 'radius' | 'borderWidth' | 'blur', label: string, max: number, step: number, unit: string, min = 0) {
  const row = fillRange(document.querySelector<HTMLElement>(`[data-range="${key}"]`)!, {
    id: key, label, min, max, step, unit, get: () => doc[key],
    set: v => { doc[key] = v; if (key === 'radius') syncCorners(); paint(); syncChrome(); syncPlacement(); }, commit: run => commit(label, run),
  });
  rows.push(row);
  return row;
}
docRange('padding', 'Padding', 30, 0.5, '%');
const cornerPresets = Array.from($('corner-presets').querySelectorAll('button'));
function syncCorners() {
  for (const b of cornerPresets) b.setAttribute('aria-pressed', String(Number(b.value) === doc.radius));
}
for (const b of cornerPresets) b.onclick = () => {
  doc.radius = Number(b.value);
  commit('Corners');
  syncAll();
};
docRange('radius', 'Corners', 12, 0.5, '%');
docRange('borderWidth', 'Width', 30, 1, '', 1);
const blurRow = docRange('blur', 'Soften background', 40, 1, '');
for (const [key, label, min, max, unit] of [
  ['x', 'Offset X', -200, 200, 'px'], ['y', 'Offset Y', -200, 200, 'px'], ['blur', 'Blur', 0, 200, 'px'],
  ['spread', 'Spread', 0, 100, 'px'], ['opacity', 'Opacity', 0, 100, '%'],
] as const) {
  rows.push(fillRange(document.querySelector<HTMLElement>(`[data-shadow="${key}"]`)!, {
    id: `shadow-${key}`, label, min, max, step: 1, unit, get: () => doc.shadowSpec[key],
    set: v => { doc.shadowSpec[key] = v; paint(); }, commit: run => commit(`Shadow ${label.toLowerCase()}`, run),
  }));
}
const shadowColor = $<HTMLInputElement>('shadow-color');
shadowColor.addEventListener('input', () => { doc.shadowSpec.color = shadowColor.value; paint(); });
shadowColor.addEventListener('change', () => commit('Shadow colour'));
for (const seg of document.querySelectorAll<HTMLElement>('[data-field]')) {
  const field = seg.dataset.field as 'shadow' | 'border' | 'window';
  for (const b of seg.querySelectorAll('button')) {
    b.onclick = () => {
      // A custom shadow starts from the preset in use.
      if (field === 'shadow' && b.value === 'custom') doc.shadowSpec = seedShadow(doc, layout(doc));
      (doc as Record<string, unknown>)[field] = b.value;
      commit(`${field[0]!.toUpperCase()}${field.slice(1)} ${b.textContent!.toLowerCase()}`);
      syncAll();
    };
  }
}
const titleInput = $<HTMLInputElement>('windowTitle');
titleInput.addEventListener('input', () => { doc.windowTitle = titleInput.value; paint(); });
titleInput.addEventListener('change', () => commit('Address bar'));

// ---------- Inspector: background ----------
const sameBg = (a: Background, b: Background) => JSON.stringify(a) === JSON.stringify(b);
function setBackground(bg: Background, label: string) {
  doc.background = bg;
  commit(`Background ${label}`);
  syncAll();
}
const loading = new Map<string, Promise<void>>();
/** Resolves once the artwork can be painted. An export waits for it. */
function loadArt(id: string): Promise<void> {
  const a = ARTWORK.find(x => x.id === id);
  if (!a || art.has(id)) return Promise.resolve();
  let job = loading.get(id);
  if (!job) {
    const img = new Image();
    img.src = a.file;
    job = img.decode().then(() => { art.set(id, img); paint(); }, () => { loading.delete(id); throw Error(`${a.name} could not load. Choose another background.`); });
    loading.set(id, job);
  }
  return job;
}
const bgButtons: [HTMLButtonElement, Background][] = [];
for (const a of ARTWORK) {
  const b = h('button', { type: 'button', class: 'ss-art-tile', 'aria-pressed': 'false', 'data-art': a.id },
    h('img', { src: a.file, alt: '', loading: 'lazy', decoding: 'async' }), h('span', {}, a.name));
  b.style.setProperty('--tone', a.tone);
  b.onclick = () => setBackground({ kind: 'art', id: a.id }, a.name);
  $('art').append(b);
  bgButtons.push([b, { kind: 'art', id: a.id }]);
}
for (const g of GRADIENTS) {
  const b = h('button', { type: 'button', class: 'ss-chip ss-swatch', 'aria-pressed': 'false', 'aria-label': g.name, title: g.name });
  b.style.setProperty('--chip', `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`);
  b.onclick = () => setBackground({ kind: 'gradient', id: g.id }, g.name);
  $('gradients').append(b);
  bgButtons.push([b, { kind: 'gradient', id: g.id }]);
}
for (const s of SOLIDS) {
  const b = h('button', { type: 'button', class: 'ss-chip ss-swatch', 'aria-pressed': 'false', 'aria-label': s.name, title: s.name });
  b.style.setProperty('--chip', s.color);
  b.onclick = () => setBackground({ kind: 'solid', color: s.color }, s.name);
  $('solids').append(b);
  bgButtons.push([b, { kind: 'solid', color: s.color }]);
}
const colorInput = $<HTMLInputElement>('color');
colorInput.addEventListener('input', () => { doc.background = { kind: 'solid', color: colorInput.value }; syncBackground(); paint(); syncEmpty(); });
colorInput.addEventListener('change', () => commit('Custom colour'));
$('own-choose').onclick = () => bgInput.click();
bgInput.onchange = async () => {
  const f = bgInput.files?.[0];
  bgInput.value = '';
  if (!f) return;
  try {
    const bmp = await decodeImage(f);
    customs.set(++lastCustom, bmp);
    customThumb = makeThumb(bmp);
    setBackground({ kind: 'custom', id: lastCustom }, 'your image');
    say('Your image is the background.');
  } catch (err) { fail((err as Error).message); }
};
function makeThumb(bmp: ImageBitmap) {
  const c = document.createElement('canvas');
  const s = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
function syncBackground() {
  for (const [b, bg] of bgButtons) b.setAttribute('aria-pressed', String(sameBg(bg, doc.background)));
  const own = $('own');
  own.replaceChildren();
  if (lastCustom) {
    const tile = h('button', { type: 'button', class: 'ss-art-tile ss-own-tile', 'aria-pressed': String(doc.background.kind === 'custom') }, h('img', { src: customThumb, alt: '' }), h('span', {}, 'Your image'));
    tile.onclick = () => setBackground({ kind: 'custom', id: lastCustom }, 'your image');
    own.append(tile);
  }
  const choose = h('button', { type: 'button', id: 'own-choose' }, lastCustom ? 'Replace…' : 'Choose a background…');
  choose.onclick = () => bgInput.click();
  own.append(choose);
  const soft = doc.background.kind === 'art' || doc.background.kind === 'custom';
  blurRow.disable(!soft);
  $('blur-note').textContent = soft ? 'Softens artwork and your own image.' : 'Choose artwork or your own image to soften it.';
  if (doc.background.kind === 'solid') colorInput.value = doc.background.color;
}

// ---------- Chrome sync ----------
function syncChrome() {
  const has = !!source;
  $<HTMLButtonElement>('undo').disabled = !history.canUndo;
  $<HTMLButtonElement>('redo').disabled = !history.canRedo;
  $('undo').title = history.canUndo ? `Undo ${history.label()?.toLowerCase()} (Ctrl or ⌘ Z)` : 'Nothing to undo';
  $('redo').title = history.canRedo ? `Redo ${history.nextLabel()?.toLowerCase()} (Shift Ctrl or ⌘ Z)` : 'Nothing to redo';
  for (const id of ['copy', 'export-open', 'guides', 'zoom-in', 'zoom-out', 'zoom-fit']) $<HTMLButtonElement>(id).disabled = !has || tool === 'crop';
  $('open').querySelector('.ss-btn-text')!.textContent = has ? 'Replace' : 'Open image';
  $('open').setAttribute('aria-label', has ? 'Replace image' : 'Open image');
  if (has) {
    const L = layout(doc);
    $('meta').textContent = `${name} · ${source!.width} × ${source!.height} → ${L.W} × ${L.H} px`;
    canvas.setAttribute('aria-label', tool === 'crop' ? `Crop frame on the ${source!.width} × ${source!.height} px screenshot` : `Canvas, ${L.W} × ${L.H} px, ${doc.layers.length} ${doc.layers.length === 1 ? 'mark' : 'marks'}`);
    $('zoom-fit').textContent = tool === 'crop' ? 'Crop' : `${Math.round(view.d * 100)}%`;
    $('zoom-fit').title = zoom ? 'Fit canvas to view' : 'Fitted to view';
  }
}

function syncAll() {
  syncCorners();
  for (const b of toolButtons) { b.disabled = !source; b.setAttribute('aria-pressed', String(b.value === tool)); }
  for (const b of document.querySelectorAll<HTMLButtonElement>('#presets button')) b.setAttribute('aria-pressed', String(b.value === doc.canvas));
  for (const seg of document.querySelectorAll<HTMLElement>('[data-field]')) {
    const v = doc[seg.dataset.field as 'shadow'];
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.value === v));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('#crop-aspect button')) b.setAttribute('aria-pressed', String(Number(b.value) === cropAspect));
  $('shadow-custom').hidden = doc.shadow !== 'custom';
  shadowColor.value = doc.shadowSpec.color;
  resetSize(); syncSize();
  $('border-width-row').hidden = doc.border === 'none';
  $('window-title-row').hidden = doc.window === 'none';
  if (document.activeElement !== titleInput) titleInput.value = doc.windowTitle;
  for (const r of rows) r.sync();
  syncBackground();
  if (doc.background.kind === 'art') loadArt(doc.background.id).catch((err: Error) => fail(err.message));
  $('panel-crop').hidden = tool !== 'crop';
  $('tabs').hidden = tool === 'crop';
  const current = tabs.find(t => $(`tab-${t}`).getAttribute('aria-selected') === 'true') ?? 'frame';
  showTab(current);
  syncCropFields();
  syncLayers();
  $('hint').textContent = source ? TOOLS.find(t => t.id === tool)!.hint : 'Open an image to start.';
  canvas.classList.toggle('ss-drawing', tool !== 'select' && tool !== 'crop');
  canvas.classList.toggle('ss-cropping', tool === 'crop');
  paint();
  syncChrome();
  syncEmpty();
}

/** Before an image is open, the board previews the chosen background so the choice is visible. */
function syncEmpty() {
  if (!source) {
    const L = layout(doc);
    const fit = fitScale(L.W, L.H);
    $('empty').style.width = Math.round(L.W * fit) + 'px';
    $('empty').style.height = Math.round(L.H * fit) + 'px';
  }
  if (source) { board.style.removeProperty('--empty-bg'); return; }
  const bg = doc.background;
  let css = '#dcdcd5';
  if (bg.kind === 'solid') css = bg.color;
  if (bg.kind === 'gradient') { const g = GRADIENTS.find(x => x.id === bg.id)!; css = `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`; }
  if (bg.kind === 'art') { const a = ARTWORK.find(x => x.id === bg.id); if (a) css = `url("${a.file}") center / cover, ${a.tone}`; }
  if (bg.kind === 'custom' && customThumb) css = `url("${customThumb}") center / cover`;
  board.style.setProperty('--empty-bg', css);
}

// ---------- My styles ----------
let styles: SavedStyle[] = loadStyles();
const styleForm = $<HTMLFormElement>('style-form');
const styleName = $<HTMLInputElement>('style-name');
styleName.maxLength = MAX_NAME;

function styleGround(s: SavedStyle): string {
  const bg = s.style.background;
  if (!bg) return 'var(--xck-sunken)';
  if (bg.kind === 'solid') return bg.color;
  if (bg.kind === 'gradient') { const g = GRADIENTS.find(x => x.id === bg.id)!; return `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`; }
  const a = ARTWORK.find(x => x.id === bg.id)!;
  return `url("${a.file}") center / cover, ${a.tone}`;
}
function storeList(next: SavedStyle[]): boolean {
  if (!storeStyles(next)) { fail('This browser could not keep the style. Free some space and try again.'); return false; }
  styles = next;
  return true;
}
function syncStyles() {
  const list = $('style-list');
  keepFocus(list, () => {
    list.replaceChildren(...styles.map((s, i) => {
      const apply = h('button', { type: 'button', class: 'ss-style', 'data-key': `style-apply:${i}`, 'aria-label': `Apply style ${s.name}` }, h('span', { class: 'ss-style-swatch', 'aria-hidden': 'true' }), h('span', { class: 'ss-style-name' }, s.name));
      apply.firstElementChild!.setAttribute('style', `background:${styleGround(s)}`);
      apply.onclick = () => {
        doc = applyStyle(doc, s.style);
        commit(`Style ${s.name}`);
        syncAll();
        say(`${s.name} applied.`);
      };
      const remove = h('button', { type: 'button', class: 'ss-icon-key ss-small-key', 'data-key': `style-del:${i}`, 'aria-label': `Delete style ${s.name}` }, icon('trash', 18));
      // Saved styles sit outside undo, so deleting one takes a second press.
      remove.onclick = () => {
        if (remove.dataset.sure) {
          if (!storeList(styles.filter((_, j) => j !== i))) return;
          syncStyles();
          say(`${s.name} deleted.`);
          (list.querySelector<HTMLElement>('button') ?? $('style-save')).focus();
          return;
        }
        remove.dataset.sure = '1';
        remove.setAttribute('aria-label', `Press again to delete ${s.name}`);
        remove.classList.add('ss-sure');
        say(`Press again to delete ${s.name}.`);
        setTimeout(() => { if (!remove.isConnected) return; delete remove.dataset.sure; remove.classList.remove('ss-sure'); remove.setAttribute('aria-label', `Delete style ${s.name}`); }, 4000);
      };
      return h('li', {}, apply, remove);
    }));
  });
  list.hidden = !styles.length;
  $('style-empty').hidden = !!styles.length;
  $<HTMLButtonElement>('style-save').disabled = styles.length >= MAX_STYLES;
}
function openStyleForm(open: boolean) {
  styleForm.hidden = !open;
  $('style-save').setAttribute('aria-expanded', String(open));
  if (open) {
    styleName.value = `Style ${styles.length + 1}`;
    $('style-scope').textContent = doc.background.kind === 'custom'
      ? 'Keeps the canvas, placement and frame. Your own wallpaper and address text stay with this image.'
      : 'Keeps the canvas, placement, frame and background. The screenshot, marks and address text stay with this image.';
    styleName.focus(); styleName.select();
  }
}
$('style-save').onclick = () => openStyleForm(styleForm.hidden);
$('style-cancel').onclick = () => { openStyleForm(false); $('style-save').focus(); };
styleForm.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); openStyleForm(false); $('style-save').focus(); } };
styleForm.onsubmit = e => {
  e.preventDefault();
  const name = styleName.value.trim().slice(0, MAX_NAME) || `Style ${styles.length + 1}`;
  if (!storeList([...styles, { name, style: toStyle(doc) }])) return;
  openStyleForm(false);
  syncStyles();
  $('style-save').focus();
  say(`${name} saved in this browser.`);
};

// ---------- Zoom ----------
$('guides').onclick = () => {
  const button = $('guides');
  button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
  paint();
};
$('zoom-in').onclick = () => { zoom = Math.min(8, (zoom ?? 1) * 1.25); syncAll(); };
$('zoom-out').onclick = () => { zoom = Math.max(0.2, (zoom ?? 1) / 1.25); syncAll(); };
$('zoom-fit').onclick = () => { zoom = null; syncAll(); };
new ResizeObserver(() => { if (source) paint(); else syncEmpty(); syncChrome(); }).observe(board);

// ---------- Opening images ----------
async function openImage(f: File | undefined | null) {
  if (!f) return;
  const ticket = ++opening;
  say(`Opening ${f.name || 'image'}…`);
  try {
    const bmp = await decodeImage(f);
    if (ticket !== opening) { bmp.close(); return; }
    source?.close();
    source = bmp;
    name = (f.name || 'screenshot').replace(/\.[^.]+$/, '') || 'screenshot';
    // The look carries over to the next image; marks and crop start fresh.
    doc = { ...newDoc(bmp.width, bmp.height, doc.background), ...toStyle(doc), background: doc.background.kind === 'custom' ? { kind: 'custom', id: lastCustom } : doc.background, windowTitle: doc.windowTitle };
    history.reset(doc);
    // Undo can no longer reach an older wallpaper, so free it.
    for (const [id, old] of customs) if (id !== lastCustom) { old.close(); customs.delete(id); }
    selected = null; anchor = null; cursor = null; cropDraft = null; tool = 'select'; zoom = null;
    canvas.hidden = false;
    $('empty').hidden = true;
    $<HTMLInputElement>('filename').value = `${name}-framed`;
    syncAll();
    say(`${f.name || 'Image'} opened, ${bmp.width} × ${bmp.height} px.`);
  } catch (err) {
    if (ticket === opening) fail((err as Error).message);
  }
}
$('choose').onclick = () => fileInput.click();
$('open').onclick = () => fileInput.click();
fileInput.onchange = () => { void openImage(fileInput.files?.[0]); fileInput.value = ''; };
document.addEventListener('paste', e => {
  if ($<HTMLDialogElement>('export-dialog').open) return;
  const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); void openImage(f); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
board.addEventListener('dragover', e => { e.preventDefault(); board.classList.add('ss-drag'); });
board.addEventListener('dragleave', () => board.classList.remove('ss-drag'));
board.addEventListener('drop', e => { e.preventDefault(); board.classList.remove('ss-drag'); void openImage(e.dataTransfer?.files[0]); });

// ---------- Export ----------
const dialog = $<HTMLDialogElement>('export-dialog');
const exportStatus = $('export-status');
let format = 'image/png';
let scale = 1;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

async function renderBlob(type: string, s: number, quality: number): Promise<Blob> {
  if (doc.background.kind === 'art') await loadArt(doc.background.id);
  await document.fonts.ready;
  const L = layout(doc);
  const out = document.createElement('canvas');
  out.width = Math.round(L.W * s); out.height = Math.round(L.H * s);
  const g = out.getContext('2d');
  if (!g) throw Error('There is not enough memory for this size. Choose a smaller size.');
  render(g, doc, L, assets(), s);
  const blob = await new Promise<Blob | null>(res => out.toBlob(res, type, type === 'image/png' ? undefined : quality));
  out.width = out.height = 0;
  if (!blob) throw Error('The image could not be created at this size. Choose a smaller size.');
  return blob;
}

function syncExport() {
  const L = layout(doc);
  const scales = exportScales(L.W, L.H);
  if (!scales.find(x => x.scale === scale)?.ok) scale = 1;
  const wrap = $('scale');
  keepFocus(wrap, () => {
    wrap.replaceChildren(...scales.map(x => {
      const b = h('button', { type: 'button', 'aria-pressed': String(x.scale === scale), disabled: !x.ok, 'data-key': `scale:${x.scale}` },
        h('strong', {}, `${x.scale}×`), h('span', {}, `${L.W * x.scale} × ${L.H * x.scale}`));
      b.onclick = () => { scale = x.scale; syncExport(); };
      return b;
    }));
  });
  for (const b of $('format').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.value === format));
  const png = format === 'image/png';
  $('quality-row').hidden = png;
  $('png-note').hidden = !png;
  $('quality-out').textContent = `${$<HTMLInputElement>('quality').value}%`;
  $('ext').textContent = '.' + EXT[format];
  $('export-copy').lastChild!.textContent = 'Copy PNG';
  void estimate();
}
function refreshExportPreview(L: Layout) {
  const thumb = document.createElement('canvas');
  const s = Math.min(1, 640 / Math.max(L.W, L.H));
  thumb.width = Math.max(1, Math.round(L.W * s)); thumb.height = Math.max(1, Math.round(L.H * s));
  render(thumb.getContext('2d')!, doc, L, assets(), s);
  const preview = $<HTMLImageElement>('export-thumb');
  preview.src = thumb.toDataURL('image/png');
  preview.hidden = false;
}
let estimateTicket = 0;
async function estimate() {
  const t = ++estimateTicket;
  const L = layout(doc);
  const info = $('export-info');
  $('art-resolution').hidden = true;
  info.textContent = `${L.W * scale} × ${L.H * scale} px · ${EXT[format]!.toUpperCase()} · measuring…`;
  try {
    await new Promise(r => setTimeout(r, 120));
    if (t !== estimateTicket) return;
    const blob = await renderBlob(format, scale, quality());
    if (t !== estimateTicket) return;
    refreshExportPreview(L);
    const bg = doc.background;
    const bitmap = bg.kind === 'art' ? art.get(bg.id) : bg.kind === 'custom' ? customs.get(bg.id) : undefined;
    const note = $('art-resolution');
    note.hidden = !bitmap || (L.W * scale <= bitmap.width && L.H * scale <= bitmap.height);
    if (bitmap && !note.hidden) note.textContent = `Background original: ${bitmap.width} × ${bitmap.height} px. It will be enlarged at this export size.`;
    info.textContent = `${L.W * scale} × ${L.H * scale} px · ${EXT[format]!.toUpperCase()} · ${formatBytes(blob.size)}`;
  } catch (err) { if (t === estimateTicket) info.textContent = (err as Error).message; }
}
const quality = () => $<HTMLInputElement>('quality').valueAsNumber / 100;
const formatBytes = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
for (const b of $('format').querySelectorAll('button')) b.onclick = () => { format = b.value; syncExport(); };
$('quality').addEventListener('input', () => { $('quality-out').textContent = `${$<HTMLInputElement>('quality').value}%`; });
$('quality').addEventListener('change', () => void estimate());

$('export-open').onclick = () => {
  if (!source) return;
  $('export-thumb').hidden = true;
  exportStatus.textContent = '';
  syncExport();
  dialog.showModal();
};
$('export-close').onclick = () => dialog.close();
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

function filename() {
  const base = $<HTMLInputElement>('filename').value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.(png|jpe?g|webp)$/i, '') || `${name}-framed`;
  return `${base}.${EXT[format]}`;
}
$('export-save').onclick = async () => {
  const btn = $<HTMLButtonElement>('export-save');
  btn.disabled = true;
  exportStatus.textContent = 'Preparing…';
  try {
    const blob = await renderBlob(format, scale, quality());
    const file = filename();
    download(file, blob);
    exportStatus.textContent = `${file} is ready to save (${formatBytes(blob.size)}).`;
    say(`${file} is ready to save.`);
  } catch (err) { exportStatus.textContent = (err as Error).message; }
  finally { btn.disabled = false; }
};
async function copyImage(s: number, report: (m: string) => void) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderBlob('image/png', s, 1) })]);
    report('Image copied as PNG.');
  } catch { report('Copy is not available here. Use Export to save the image.'); }
}
$('export-copy').onclick = () => void copyImage(scale, m => { exportStatus.textContent = m; });
$('copy').onclick = () => void copyImage(1, say);

// ---------- Start ----------
void document.fonts.load(`700 32px ${MARK_FONT}`).then(() => paint());
syncStyles();
syncAll();
