/**
 * Paints a document onto a 2D context. The preview and every export use this one function; only the scale
 * differs, so what the user sees is what they save.
 */
import { DOMAIN } from '../receipt/data';
import { ARTWORK, GRADIENTS } from './wallpapers';
import { type Doc, type Layer, type Layout, type Pt, type Rect, intersect, shadowPasses, toDoc } from './model';

export type Assets = {
  source: CanvasImageSource & { width: number; height: number };
  art: Map<string, HTMLImageElement>;
  custom: Map<number, CanvasImageSource & { width: number; height: number }>;
};

export const MARK_FONT = 'XckArchivo, Arial, sans-serif';
const INK = '#131313';

/**
 * Output pixels per unit of the current space. Canvas shadows and filters ignore the transform, so every blur and
 * shadow length is multiplied by this; otherwise a 2x export would cast a different shadow from the preview.
 */
const unit = (ctx: CanvasRenderingContext2D) => ctx.getTransform().a;

/** Ink or white, whichever reads on `hex`. */
export function contrast(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? INK : '#ffffff';
}

function cover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, W: number, H: number, blur: number) {
  const over = blur * 2.5;
  const s = Math.max((W + over * 2) / img.width, (H + over * 2) / img.height);
  const w = img.width * s, h = img.height * s;
  ctx.save();
  if (blur > 0) ctx.filter = `blur(${blur * unit(ctx)}px)`;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  ctx.restore();
}

function paintBackground(ctx: CanvasRenderingContext2D, doc: Doc, L: Layout, a: Assets) {
  const { W, H } = L;
  const bg = doc.background;
  const blur = doc.blur / 1000 * Math.max(W, H);
  if (bg.kind === 'solid') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); return; }
  if (bg.kind === 'gradient') {
    const g = GRADIENTS.find(x => x.id === bg.id) ?? GRADIENTS[0]!;
    const t = (g.angle - 90) * Math.PI / 180;
    const r = Math.abs(W / 2 * Math.cos(t)) + Math.abs(H / 2 * Math.sin(t));
    const grad = ctx.createLinearGradient(W / 2 - Math.cos(t) * r, H / 2 - Math.sin(t) * r, W / 2 + Math.cos(t) * r, H / 2 + Math.sin(t) * r);
    g.stops.forEach((c, i) => grad.addColorStop(i / (g.stops.length - 1), c));
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    return;
  }
  const art = bg.kind === 'art' ? ARTWORK.find(x => x.id === bg.id) : undefined;
  ctx.fillStyle = art?.tone ?? '#dcdcd5';
  ctx.fillRect(0, 0, W, H);
  const img = bg.kind === 'art' ? a.art.get(bg.id) : a.custom.get(bg.id);
  if (img && img.width) cover(ctx, img, W, H, blur);
}

function rounded(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, Math.min(radius, r.w / 2, r.h / 2)));
}

function paintWindowBar(ctx: CanvasRenderingContext2D, doc: Doc, L: Layout) {
  const { card, bar } = L;
  const dark = doc.window === 'dark';
  ctx.fillStyle = dark ? '#2b2c30' : '#efefeb';
  ctx.fillRect(card.x, card.y, card.w, bar);
  ctx.fillStyle = dark ? '#3c3d42' : '#d9d9d3';
  ctx.fillRect(card.x, card.y + bar - Math.max(1, bar * 0.03), card.w, Math.max(1, bar * 0.03));
  const dot = bar * 0.12, cy = card.y + bar / 2;
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.beginPath(); ctx.arc(card.x + bar * 0.5 + i * dot * 3, cy, dot, 0, Math.PI * 2);
    ctx.fillStyle = c; ctx.fill();
  });
  const pill = { w: Math.min(card.w * 0.46, card.w - bar * 4.4), h: bar * 0.56, x: 0, y: cy - bar * 0.28 };
  pill.x = card.x + (card.w - pill.w) / 2;
  if (pill.w > bar) {
    rounded(ctx, pill, pill.h * 0.3);
    ctx.fillStyle = dark ? '#1d1e21' : '#ffffff'; ctx.fill();
    ctx.fillStyle = dark ? '#b9bbc0' : '#55575c';
    ctx.font = `500 ${bar * 0.3}px ${MARK_FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let title = doc.windowTitle.trim();
    while (title.length > 1 && ctx.measureText(title).width > pill.w - bar * 0.6) title = title.slice(0, -2) + '…';
    ctx.fillText(title, pill.x + pill.w / 2, cy + bar * 0.01);
  }
}

/** The card's outline on the canvas, corners included. */
const cardRadius = (doc: Doc, L: Layout) => doc.radius / 100 * Math.min(L.card.w, L.card.h);

/**
 * The screenshot with every redaction already filled in, at source resolution. Scaling a screenshot blends
 * neighbouring pixels, so covering it only afterwards could let a trace of the hidden area show at the edge.
 */
const baked: { source?: unknown; key: string; canvas?: HTMLCanvasElement } = { key: '' };
function redactedSource(doc: Doc, a: Assets): CanvasImageSource {
  const cuts = doc.layers.filter(l => l.kind === 'redact');
  if (!cuts.length) { if (baked.canvas) baked.canvas.width = baked.canvas.height = 0; baked.canvas = baked.source = undefined; return a.source; }
  const key = JSON.stringify(cuts.map(l => [l.rect, l.color]));
  if (baked.canvas && baked.source === a.source && baked.key === key) return baked.canvas;
  const c = baked.canvas ?? document.createElement('canvas');
  c.width = a.source.width; c.height = a.source.height;
  const g = c.getContext('2d');
  if (!g) throw Error('There is not enough memory to apply the redactions. Crop the screenshot first.');
  g.drawImage(a.source, 0, 0);
  for (const l of cuts) {
    const x = Math.floor(l.rect.x), y = Math.floor(l.rect.y);
    g.fillStyle = l.color;
    g.fillRect(x, y, Math.ceil(l.rect.x + l.rect.w) - x, Math.ceil(l.rect.y + l.rect.h) - y);
  }
  Object.assign(baked, { source: a.source, key, canvas: c });
  return c;
}

/** Casts only the shadow of a rounded rectangle: the shape itself is drawn far outside the canvas. */
function castShadow(ctx: CanvasRenderingContext2D, r: Rect, radius: number, s: { x: number; y: number; blur: number; spread: number; opacity: number; color: string }) {
  const u = unit(ctx), away = 30000;
  const n = parseInt(s.color.slice(1), 16);
  ctx.save();
  ctx.shadowColor = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${s.opacity / 100})`;
  ctx.shadowBlur = s.blur * u;
  ctx.shadowOffsetX = s.x * u + away;
  ctx.shadowOffsetY = s.y * u;
  ctx.fillStyle = '#000';
  const w = Math.max(0, r.w + s.spread * 2), hgt = Math.max(0, r.h + s.spread * 2);
  rounded(ctx, { x: r.x - s.spread - away / u, y: r.y - s.spread, w, h: hgt }, radius > 0 ? radius + s.spread : 0);
  ctx.fill();
  ctx.restore();
}

function paintFrame(ctx: CanvasRenderingContext2D, doc: Doc, L: Layout, a: Assets, draft: boolean) {
  const { card, image } = L;
  const radius = cardRadius(doc, L);
  const bw = doc.border === 'none' ? 0 : doc.borderWidth / 1000 * card.w;
  const outer = { x: card.x - bw, y: card.y - bw, w: card.w + 2 * bw, h: card.h + 2 * bw };
  const outerRadius = radius > 0 ? radius + bw : 0;
  for (const s of shadowPasses(doc, L)) castShadow(ctx, outer, outerRadius, s);
  ctx.save();
  if (bw) { rounded(ctx, outer, outerRadius); ctx.fillStyle = doc.border === 'ink' ? INK : '#ffffff'; ctx.fill(); }
  rounded(ctx, card, radius);
  ctx.clip();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(card.x, card.y, card.w, card.h);
  if (L.bar) paintWindowBar(ctx, doc, L);
  ctx.imageSmoothingQuality = 'high';
  const c = doc.crop;
  ctx.drawImage(draft ? a.source : redactedSource(doc, a), c.x, c.y, c.w, c.h, image.x, image.y, image.w, image.h);
  ctx.restore();
}

/** Lines, font and box of a text mark, in source pixels. */
export function textMetrics(ctx: CanvasRenderingContext2D, layer: Extract<Layer, { kind: 'text' }>) {
  ctx.save();
  ctx.font = `700 ${layer.size}px ${MARK_FONT}`;
  const lines = (layer.text || ' ').split('\n');
  const width = Math.max(...lines.map(l => ctx.measureText(l).width), layer.size * 0.3);
  ctx.restore();
  const lh = layer.size * 1.22;
  const pad = layer.style === 'plain' ? layer.size * 0.12 : layer.size * 0.5;
  return { lines, lh, pad, box: { x: layer.at.x, y: layer.at.y, w: width + pad * 2, h: pad * 2 + (lines.length - 1) * lh + layer.size * 1.08 } };
}

/** Bounds of a layer in source pixels, for hit testing and the selection frame. */
export function layerBounds(ctx: CanvasRenderingContext2D, layer: Layer): Rect {
  switch (layer.kind) {
    case 'arrow': {
      const pad = layer.width * 2.5;
      return { x: Math.min(layer.from.x, layer.to.x) - pad, y: Math.min(layer.from.y, layer.to.y) - pad, w: Math.abs(layer.to.x - layer.from.x) + pad * 2, h: Math.abs(layer.to.y - layer.from.y) + pad * 2 };
    }
    case 'box': return { x: layer.rect.x - layer.width / 2, y: layer.rect.y - layer.width / 2, w: layer.rect.w + layer.width, h: layer.rect.h + layer.width };
    case 'redact': return layer.rect;
    case 'text': return textMetrics(ctx, layer).box;
    case 'step': return { x: layer.at.x - layer.size / 2, y: layer.at.y - layer.size / 2, w: layer.size, h: layer.size };
  }
}

function paintArrow(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, pen: number, color: string) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const head = Math.min(length * 0.45, pen * 4.2);
  ctx.save();
  ctx.translate(from.x, from.y);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.beginPath();
  ctx.moveTo(0, -pen / 2);
  ctx.lineTo(length - head, -pen / 2);
  ctx.lineTo(length - head, -head * 0.6);
  ctx.lineTo(length, 0);
  ctx.lineTo(length - head, head * 0.6);
  ctx.lineTo(length - head, pen / 2);
  ctx.lineTo(0, pen / 2);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = contrast(color) === INK ? 'rgba(19,19,19,.55)' : 'rgba(255,255,255,.9)';
  ctx.lineWidth = Math.max(1, pen * 0.3);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** Drawing and hit testing share the outline in source pixels. */
export function outlinePath(layer: Extract<Layer, {kind: 'box'}>) {
  const { x, y, w, h } = layer.rect;
  const path = new Path2D();
  if (layer.oval) path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else path.roundRect(x, y, w, h, layer.width * 1.4);
  return path;
}

/** Paints one mark. The context is already in source-pixel space. `clip` limits the space a redaction may cover. */
function paintLayer(ctx: CanvasRenderingContext2D, layer: Layer, crop: Rect, clip?: (g: CanvasRenderingContext2D) => void) {
  switch (layer.kind) {
    case 'arrow': paintArrow(ctx, layer.from, layer.to, layer.width, layer.color); return;
    case 'box':
      ctx.lineWidth = layer.width; ctx.strokeStyle = layer.color; ctx.stroke(outlinePath(layer));
      return;
    case 'redact': {
      // The screenshot underneath is already filled (redactedSource). This covers any mark below it, rounded out
      // to whole output pixels so no edge is half transparent.
      const r = intersect(layer.rect, crop);
      if (!r) return;
      const t = ctx.getTransform();
      const x0 = Math.floor(t.a * r.x + t.e), y0 = Math.floor(t.d * r.y + t.f);
      const x1 = Math.ceil(t.a * (r.x + r.w) + t.e), y1 = Math.ceil(t.d * (r.y + r.h) + t.f);
      ctx.save();
      clip?.(ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = layer.color;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
      return;
    }
    case 'text': {
      const { lines, lh, pad, box } = textMetrics(ctx, layer);
      if (layer.style !== 'plain') {
        ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, layer.size * 0.36);
        ctx.fillStyle = layer.style === 'ink' ? layer.color : '#ffffff';
        ctx.shadowColor = 'rgba(12,16,22,.22)'; ctx.shadowBlur = layer.size * 0.5 * unit(ctx); ctx.shadowOffsetY = layer.size * 0.12 * unit(ctx);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        if (layer.style === 'label') { ctx.lineWidth = Math.max(1, layer.size * 0.06); ctx.strokeStyle = 'rgba(19,19,19,.14)'; ctx.stroke(); }
      }
      ctx.font = `700 ${layer.size}px ${MARK_FONT}`;
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.fillStyle = layer.style === 'ink' ? contrast(layer.color) : layer.color;
      if (layer.style === 'plain') {
        ctx.lineJoin = 'round';
        ctx.lineWidth = layer.size * 0.16;
        ctx.strokeStyle = contrast(layer.color) === INK ? 'rgba(19,19,19,.6)' : 'rgba(255,255,255,.85)';
        lines.forEach((l, i) => ctx.strokeText(l, box.x + pad, box.y + pad + i * lh));
      }
      lines.forEach((l, i) => ctx.fillText(l, box.x + pad, box.y + pad + i * lh + (layer.style === 'plain' ? 0 : layer.size * 0.06)));
      return;
    }
    case 'step': {
      const r = layer.size / 2;
      ctx.beginPath(); ctx.arc(layer.at.x, layer.at.y, r, 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(12,16,22,.25)'; ctx.shadowBlur = r * 0.5 * unit(ctx); ctx.shadowOffsetY = r * 0.12 * unit(ctx);
      ctx.fillStyle = layer.color; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = Math.max(1, r * 0.14); ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.fillStyle = contrast(layer.color);
      ctx.font = `800 ${r * 1.1}px ${MARK_FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(layer.n), layer.at.x, layer.at.y + r * 0.06);
      return;
    }
  }
}

/** A small receipt-style imprint. All measurements use document pixels, including at Retina export sizes. */
function paintCredit(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const em = Math.min(W / 92, H / 60);
  const inset = em * 0.8;
  ctx.font = `500 ${em}px XckMartian, monospace`;
  const width = ctx.measureText(DOMAIN).width + 1.3 * em;
  const height = em * 1.7;
  const x = W - width - inset, y = H - height - inset;
  rounded(ctx, { x, y, w: width, h: height }, em * 0.32);
  ctx.fillStyle = 'rgba(20, 20, 22, .82)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(DOMAIN, x + width / 2, y + height / 2);
}

/** Switch the context into source-pixel space for marks. */
export function sourceSpace(ctx: CanvasRenderingContext2D, doc: Doc, L: Layout) {
  const o = toDoc(L, doc.crop, { x: 0, y: 0 });
  ctx.translate(o.x, o.y);
  ctx.scale(L.k, L.k);
}

/**
 * Paint the whole document at `scale` output pixels per doc pixel. `draft` skips filling redactions into the
 * screenshot itself while one is being dragged; saved images never use it.
 */
export function render(ctx: CanvasRenderingContext2D, doc: Doc, L: Layout, a: Assets, scale: number, draft = false) {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, L.W, L.H);
  paintBackground(ctx, doc, L, a);
  paintFrame(ctx, doc, L, a, draft);
  ctx.save();
  sourceSpace(ctx, doc, L);
  paintMarks(ctx, doc, g => { g.setTransform(scale, 0, 0, scale, 0, 0); rounded(g, L.card, cardRadius(doc, L)); g.clip(); });
  ctx.restore();
  paintCredit(ctx, L.W, L.H);
  ctx.restore();
}

/** Paint every mark, bottom first. The context must already be in source-pixel space. */
export function paintMarks(ctx: CanvasRenderingContext2D, doc: Doc, clip?: (g: CanvasRenderingContext2D) => void) {
  for (const layer of doc.layers) { ctx.save(); paintLayer(ctx, layer, doc.crop, clip); ctx.restore(); }
}
