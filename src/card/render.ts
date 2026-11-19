import type { CardModel } from './model';

export type CardFormat = 'portrait' | 'landscape';
export const CARD_SIZES: Record<CardFormat, { w: number; h: number }> = {
  portrait: { w: 1080, h: 1350 },
  landscape: { w: 1600, h: 900 },
};

const C = {
  bg: '#F7F8FA',
  panel: '#FFFFFF',
  ink: '#0F1419',
  muted: '#5B6670',
  rule: '#E3E7EB',
  blue: '#1D6FE0',
  track: '#DCE8F9',
  pos: '#14804A',
  neg: '#C2362B',
};
const FONT = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif';

function font(weight: number, size: number) {
  return `${weight} ${size}px ${FONT}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shrink a font until the text fits the width. Prevents clipping of long values. */
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number): number {
  let s = size;
  ctx.font = font(weight, s);
  while (s > 10 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = font(weight, s);
  }
  return s;
}

/** Draws the owned share card. Only text from the model is drawn, nothing from the page. */
export function renderCard(canvas: HTMLCanvasElement, m: CardModel, format: CardFormat = 'portrait'): void {
  const { w, h } = CARD_SIZES[format];
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const k = format === 'portrait' ? 1 : 0.82; // type scale
  const pad = Math.round(80 * k);

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = C.panel;
  roundRect(ctx, pad / 2, pad / 2, w - pad, h - pad, 28);
  ctx.fill();
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 2;
  ctx.stroke();

  const x0 = pad;
  const innerW = w - pad * 2;
  let y = pad + 40 * k;
  ctx.textBaseline = 'alphabetic';

  // Header: handle (left), day/date (right).
  ctx.fillStyle = C.ink;
  ctx.font = font(700, 40 * k);
  ctx.textAlign = 'left';
  ctx.fillText(m.handle, x0, y + 20 * k);
  ctx.textAlign = 'right';
  ctx.font = font(600, 34 * k);
  ctx.fillText(m.day != null ? `Day ${m.day}` : 'Day —', x0 + innerW, y + 16 * k);
  ctx.font = font(400, 26 * k);
  ctx.fillStyle = C.muted;
  ctx.fillText(m.reportingDateText, x0 + innerW, y + 54 * k);
  ctx.textAlign = 'left';

  y += 110 * k;
  ctx.fillStyle = C.rule;
  ctx.fillRect(x0, y, innerW, 2);

  // Label
  y += 70 * k;
  ctx.fillStyle = C.muted;
  ctx.font = font(600, 26 * k);
  ctx.fillText(m.heroLabel.toUpperCase(), x0, y);
  y += 40 * k;
  ctx.font = font(400, 26 * k);
  ctx.fillText(m.windowNote, x0, y);

  // Hero
  y += (format === 'portrait' ? 190 : 150) * k;
  ctx.fillStyle = C.ink;
  const heroSize = fitText(ctx, m.heroText, 700, (format === 'portrait' ? 200 : 170) * k, innerW);
  ctx.font = font(700, heroSize);
  ctx.fillText(m.heroText, x0 - 6, y);

  // Progress
  y += 60 * k;
  const barH = 26 * k;
  ctx.fillStyle = C.track;
  roundRect(ctx, x0, y, innerW, barH, barH / 2);
  ctx.fill();
  if (m.progressFraction > 0) {
    ctx.fillStyle = C.blue;
    roundRect(ctx, x0, y, Math.max(barH, innerW * m.progressFraction), barH, barH / 2);
    ctx.fill();
  }
  y += barH + 48 * k;
  ctx.font = font(500, 30 * k);
  ctx.fillStyle = C.ink;
  ctx.fillText(m.progressText, x0, y);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.fillText(m.remainingText, x0 + innerW, y);
  ctx.textAlign = 'left';

  // Net window change (only when a comparable earlier checkpoint exists)
  if (m.change) {
    y += 80 * k;
    const d = m.change.delta;
    ctx.font = font(700, 44 * k);
    ctx.fillStyle = d > 0 ? C.pos : d < 0 ? C.neg : C.ink;
    ctx.fillText(m.change.deltaText, x0, y);
    const dw = ctx.measureText(m.change.deltaText).width;
    ctx.font = font(400, 26 * k);
    ctx.fillStyle = C.muted;
    fitText(ctx, m.change.label, 400, 26 * k, innerW - dw - 24);
    ctx.fillText(m.change.label, x0 + dw + 24, y - 4);
  }

  // Sparkline of real daily checkpoints
  const footerY = h - pad - 10 * k;
  if (m.sparkline.length >= 3) {
    const top = y + 60 * k;
    const bottom = footerY - 120 * k;
    if (bottom - top > 80) drawSparkline(ctx, m.sparkline, x0, top, innerW, bottom - top);
  }

  // Qualifiers
  if (m.qualifiers.length) {
    ctx.font = font(500, 24 * k);
    let qx = x0;
    const qy = footerY - 70 * k;
    for (const q of m.qualifiers) {
      const tw = ctx.measureText(q).width + 32;
      if (qx + tw > x0 + innerW) break;
      ctx.fillStyle = '#EEF2F6';
      roundRect(ctx, qx, qy - 30 * k, tw, 44 * k, 22 * k);
      ctx.fill();
      ctx.fillStyle = C.muted;
      ctx.fillText(q, qx + 16, qy);
      qx += tw + 12;
    }
  }

  // Footer
  ctx.fillStyle = C.rule;
  ctx.fillRect(x0, footerY - 36 * k, innerW, 2);
  ctx.font = font(400, 24 * k);
  ctx.fillStyle = C.muted;
  ctx.fillText(m.footer, x0, footerY);
}

function drawSparkline(ctx: CanvasRenderingContext2D, pts: { t: number; v: number }[], x: number, y: number, w: number, h: number) {
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const vs = pts.map((p) => p.v);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const sx = (t: number) => x + (t1 === t0 ? w / 2 : ((t - t0) / (t1 - t0)) * w);
  const sy = (v: number) => y + h - (vMax === vMin ? h / 2 : ((v - vMin) / (vMax - vMin)) * h);
  ctx.strokeStyle = C.blue;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p.v)) : ctx.moveTo(sx(p.t), sy(p.v))));
  ctx.stroke();
  ctx.fillStyle = C.blue;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(sx(p.t), sy(p.v), 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = font(400, 20);
  ctx.fillStyle = C.muted;
  ctx.fillText('Measured daily readings', x, y - 14);
}
