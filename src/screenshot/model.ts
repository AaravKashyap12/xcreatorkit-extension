/**
 * The editable document and the pure geometry around it. Everything here is plain data so a snapshot is a
 * structured clone, which is what undo and redo store.
 *
 * Coordinates: marks and the crop live in source pixels (the opened image), so they stay on the screenshot when
 * the frame, padding or canvas size changes. The canvas ("doc") is measured in output pixels at 1x.
 */
export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export type Tool = 'select' | 'crop' | 'arrow' | 'box' | 'text' | 'step' | 'redact';
export type TextStyle = 'plain' | 'label' | 'ink';
export type Layer =
  | { id: number; kind: 'arrow'; from: Pt; to: Pt; color: string; width: number }
  | { id: number; kind: 'box'; oval?: boolean; rect: Rect; color: string; width: number }
  | { id: number; kind: 'redact'; rect: Rect; color: string }
  | { id: number; kind: 'text'; at: Pt; text: string; color: string; size: number; style: TextStyle }
  | { id: number; kind: 'step'; at: Pt; n: number; color: string; size: number };
export type LayerKind = Layer['kind'];

export type Background =
  | { kind: 'art'; id: string }
  | { kind: 'gradient'; id: string }
  | { kind: 'solid'; color: string }
  /** The user's own wallpaper. `id` names one held in memory for this visit, so undo returns the right one. */
  | { kind: 'custom'; id: number };

export type Shadow = 'none' | 'soft' | 'lifted' | 'print' | 'custom';
/** One drop shadow, in canvas pixels at 1x. Opacity is a percentage. */
export type ShadowSpec = { x: number; y: number; blur: number; spread: number; opacity: number; color: string };
export type Anchor = -1 | 0 | 1;
export type Doc = {
  crop: Rect;
  canvas: string;       // a CANVAS_PRESETS id; 'custom' reads canvasW and canvasH
  canvasW: number;
  canvasH: number;
  scale: number;        // percent of the size that fills the padded area
  anchorX: Anchor;      // which canvas edge (or the centre) the screenshot is placed from
  anchorY: Anchor;
  offsetX: number;      // canvas pixels from that anchor
  offsetY: number;
  padding: number;      // percent of the canvas's short side (or of the screenshot's long side for Fit)
  radius: number;       // percent of the screenshot's short side
  shadow: Shadow;
  shadowSpec: ShadowSpec; // used when shadow is 'custom'
  border: 'none' | 'paper' | 'ink';
  borderWidth: number;  // thousandths of the screenshot's width
  window: 'none' | 'light' | 'dark';
  windowTitle: string;
  background: Background;
  blur: number;         // background blur, thousandths of the canvas's long side
  layers: Layer[];
};

export const CANVAS_PRESETS: readonly { id: string; name: string; w: number; h: number }[] = [
  { id: 'fit', name: 'Fit image', w: 0, h: 0 },
  { id: 'x-post', name: 'X post', w: 1600, h: 900 },
  { id: 'square', name: 'Square', w: 1080, h: 1080 },
  { id: 'portrait', name: 'Portrait', w: 1080, h: 1350 },
  { id: 'x-header', name: 'X header', w: 1500, h: 500 },
  { id: 'wide', name: 'Wide', w: 1920, h: 1080 },
  { id: 'story', name: 'Story', w: 1080, h: 1920 },
  { id: 'custom', name: 'Custom', w: 0, h: 0 },
];

/** Long edge of a Fit canvas at 1x. Native pixels are kept below it. */
export const FIT_LONG_EDGE = 4096;
/** Export bounds: the long edge and the area a browser canvas can hold without failing on most machines. */
export const EXPORT_LONG_EDGE = 8192;
export const EXPORT_PIXELS = 40_000_000;

/** Smallest and largest side of a custom canvas. The largest is the export bound, so 1x always works. */
export const CANVAS_MIN = 16;
export const SCALE_MIN = 10;
export const SCALE_MAX = 400;

/** Why a custom canvas size cannot be used, or null. */
export function refuseCanvas(w: number, hgt: number): string | null {
  if (![w, hgt].every(v => Number.isInteger(v) && v >= CANVAS_MIN && v <= EXPORT_LONG_EDGE)) return `Use whole pixels from ${CANVAS_MIN} to ${EXPORT_LONG_EDGE} for each side.`;
  if (w * hgt > EXPORT_PIXELS) return `Keep width × height under ${EXPORT_PIXELS / 1e6} megapixels. This is ${Math.round(w * hgt / 1e6)}.`;
  return null;
}

export function newDoc(width: number, height: number, background: Background): Doc {
  return {
    crop: { x: 0, y: 0, w: width, h: height }, canvas: 'x-post', canvasW: 1600, canvasH: 900,
    scale: 100, anchorX: 0, anchorY: 0, offsetX: 0, offsetY: 0, padding: 8, radius: 2.5, shadow: 'soft',
    shadowSpec: { x: 0, y: 14, blur: 36, spread: 0, opacity: 26, color: '#131313' },
    border: 'none', borderWidth: 6, window: 'none', windowTitle: 'x.com', background, blur: 0, layers: [],
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where everything sits on the canvas, in doc pixels. */
export type Layout = { W: number; H: number; card: Rect; image: Rect; bar: number; k: number };

/** Browser window bar height as a share of the screenshot's width. */
const BAR = 0.05;

export function layout(doc: Doc): Layout {
  const c = doc.crop;
  const barSrc = doc.window === 'none' ? 0 : Math.max(c.w * BAR, 18);
  const cw = c.w, ch = c.h + barSrc;
  const preset = CANVAS_PRESETS.find(p => p.id === doc.canvas) ?? CANVAS_PRESETS[0]!;
  const fixed = preset.id === 'custom' ? { w: doc.canvasW, h: doc.canvasH } : preset;
  const p = doc.padding / 100;
  let W: number, H: number, fit: number;
  if (!fixed.w) {
    const pad = p * Math.max(cw, ch);
    fit = Math.min(1, FIT_LONG_EDGE / (Math.max(cw, ch) + 2 * pad));
    W = Math.max(1, Math.round((cw + 2 * pad) * fit));
    H = Math.max(1, Math.round((ch + 2 * pad) * fit));
  } else {
    W = fixed.w; H = fixed.h;
    const pad = p * Math.min(W, H);
    fit = Math.min(Math.max(1, W - 2 * pad) / cw, Math.max(1, H - 2 * pad) / ch);
  }
  const k = fit * doc.scale / 100;
  const w = cw * k, hgt = ch * k;
  const from = (anchor: Anchor, size: number, total: number) => anchor < 0 ? 0 : anchor > 0 ? total - size : (total - size) / 2;
  // However far it is moved, part of the screenshot stays on the canvas and can be dragged back.
  const keep = (v: number, size: number, total: number) => { const m = Math.min(32, size, total); return clamp(v, m - size, total - m); };
  const card = {
    w, h: hgt,
    x: keep(from(doc.anchorX, w, W) + doc.offsetX, w, W),
    y: keep(from(doc.anchorY, hgt, H) + doc.offsetY, hgt, H),
  };
  const bar = barSrc * k;
  return { W, H, card, bar, k, image: { x: card.x, y: card.y + bar, w: c.w * k, h: c.h * k } };
}

/** The same document with the screenshot's top left corner at x, y on the canvas. Alignment stays as it was. */
export function placeAt(doc: Doc, x: number, y: number): Doc {
  const base = layout({ ...doc, offsetX: 0, offsetY: 0 }).card;
  const moved = { ...doc, offsetX: x - base.x, offsetY: y - base.y };
  const real = layout(moved).card;
  return { ...moved, offsetX: real.x - base.x, offsetY: real.y - base.y };
}

/** Every drop shadow the frame casts, in canvas pixels. */
export function shadowPasses(doc: Doc, L: Layout): ShadowSpec[] {
  const m = Math.min(L.W, L.H);
  const pass = (x: number, y: number, blur: number, opacity: number): ShadowSpec => ({ x, y, blur, spread: 0, opacity, color: '#0c1016' });
  switch (doc.shadow) {
    case 'none': return [];
    case 'soft': return [pass(0, m * 0.014, m * 0.035, 26)];
    case 'lifted': return [pass(0, m * 0.045, m * 0.09, 34), pass(0, m * 0.004, m * 0.012, 18)];
    case 'print': { const d = Math.max(2, m * 0.014); return [{ x: d, y: d, blur: 0, spread: 0, opacity: 100, color: '#131313' }]; }
    case 'custom': return [doc.shadowSpec];
  }
}

/** Whole-number settings that start a custom shadow from the preset in use. */
export function seedShadow(doc: Doc, L: Layout): ShadowSpec {
  const first = shadowPasses(doc, L)[0];
  if (!first || doc.shadow === 'custom') return { ...doc.shadowSpec };
  const r = Math.round;
  return { x: r(first.x), y: r(first.y), blur: r(first.blur), spread: 0, opacity: r(first.opacity), color: first.color };
}

export const toDoc = (L: Layout, crop: Rect, p: Pt): Pt => ({ x: L.image.x + (p.x - crop.x) * L.k, y: L.image.y + (p.y - crop.y) * L.k });
export const toSource = (L: Layout, crop: Rect, p: Pt): Pt => ({ x: crop.x + (p.x - L.image.x) / L.k, y: crop.y + (p.y - L.image.y) / L.k });

/** Export scales that fit the limits, for a canvas of W x H. */
export function exportScales(W: number, H: number): { scale: number; ok: boolean }[] {
  return [1, 2, 3].map(scale => ({ scale, ok: Math.max(W, H) * scale <= EXPORT_LONG_EDGE && W * H * scale * scale <= EXPORT_PIXELS }));
}

/** A rectangle from two corners, with positive width and height. */
export function spanRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

/**
 * The area a redaction will cover, kept inside the visible screenshot. Null when it would cover less than
 * `min` source pixels in either direction: a zero-area redaction hides nothing and must not be saved.
 */
export function redactArea(rect: Rect, crop: Rect, min: number): Rect | null {
  const r = intersect(rect, crop);
  return r && r.w >= min && r.h >= min ? r : null;
}

/** Clamp a crop to the source and keep it at least `min` pixels each way. */
export function clampCrop(c: Rect, w: number, h: number, min = 8): Rect {
  const cw = clamp(Math.round(c.w), Math.min(min, w), w);
  const chh = clamp(Math.round(c.h), Math.min(min, h), h);
  return { w: cw, h: chh, x: clamp(Math.round(c.x), 0, w - cw), y: clamp(Math.round(c.y), 0, h - chh) };
}

/** Fit an aspect ratio inside a crop, keeping its centre. */
export function cropToAspect(c: Rect, aspect: number, w: number, h: number): Rect {
  let cw = c.w, chh = c.h;
  if (cw / chh > aspect) cw = chh * aspect; else chh = cw / aspect;
  return clampCrop({ x: c.x + (c.w - cw) / 2, y: c.y + (c.h - chh) / 2, w: cw, h: chh }, w, h);
}

/** Move a layer by a source-pixel offset. */
export function moveLayer(layer: Layer, dx: number, dy: number): Layer {
  const p = (q: Pt) => ({ x: q.x + dx, y: q.y + dy });
  switch (layer.kind) {
    case 'arrow': return { ...layer, from: p(layer.from), to: p(layer.to) };
    case 'box': case 'redact': return { ...layer, rect: { ...layer.rect, x: layer.rect.x + dx, y: layer.rect.y + dy } };
    case 'text': case 'step': return { ...layer, at: p(layer.at) };
  }
}

/** Distance from p to the segment a–b. */
export function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Undo history of whole-document snapshots, each named by the edit that produced it. */
export class History {
  private entries: { doc: Doc; label: string; at: number; run: boolean }[] = [];
  private at = -1;
  reset(doc: Doc) { this.entries = [{ doc: structuredClone(doc), label: 'Open image', at: 0, run: false }]; this.at = 0; }
  /** Record `doc` after an edit. Returns false when nothing changed. */
  push(doc: Doc, label: string, merge = false): boolean {
    const top = this.entries[this.at];
    if (top && JSON.stringify(top.doc) === JSON.stringify(doc)) return false;
    // A run of small edits of one kind (arrow keys on a mark or a slider) becomes one undo step.
    const now = Date.now();
    if (merge && top?.run && top.label === label && this.at === this.entries.length - 1 && now - top.at < 700) { top.doc = structuredClone(doc); top.at = now; return true; }
    this.entries.splice(this.at + 1);
    this.entries.push({ doc: structuredClone(doc), label, at: now, run: merge });
    if (this.entries.length > 200) this.entries.shift();
    this.at = this.entries.length - 1;
    return true;
  }
  get canUndo() { return this.at > 0; }
  get canRedo() { return this.at < this.entries.length - 1; }
  get current() { return this.entries[this.at]?.doc; }
  undo(): { doc: Doc; label: string } | null {
    if (!this.canUndo) return null;
    const label = this.entries[this.at]!.label;
    this.at--;
    return { doc: structuredClone(this.entries[this.at]!.doc), label };
  }
  redo(): { doc: Doc; label: string } | null {
    if (!this.canRedo) return null;
    this.at++;
    const e = this.entries[this.at]!;
    return { doc: structuredClone(e.doc), label: e.label };
  }
  nextLabel() { return this.entries[this.at + 1]?.label; }
  label() { return this.entries[this.at]?.label; }
}
