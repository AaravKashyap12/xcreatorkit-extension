/**
 * Reusable style presets. A preset holds styling only: canvas size, placement, frame, shadow and background. It is
 * built field by field from the list below, so the screenshot, its file name, marks, address text and the user's own
 * wallpaper cannot end up in one. Presets stay in this browser.
 */
import { ARTWORK, GRADIENTS } from './wallpapers';
import {
  type Anchor, type Background, type Doc, type Shadow, type ShadowSpec, CANVAS_PRESETS, SCALE_MAX, SCALE_MIN,
  clamp, newDoc, refuseCanvas,
} from './model';

export type Style = Pick<Doc, 'canvas' | 'canvasW' | 'canvasH' | 'scale' | 'anchorX' | 'anchorY' | 'offsetX' | 'offsetY'
  | 'padding' | 'radius' | 'shadow' | 'shadowSpec' | 'border' | 'borderWidth' | 'window' | 'blur'> & {
  /** Left out when the style was saved over the user's own wallpaper: applying it keeps the current background. */
  background?: Exclude<Background, { kind: 'custom' }>;
};
export type SavedStyle = { name: string; style: Style };

export const STYLES_KEY = 'xck-screenshot-styles';
export const MAX_STYLES = 24;
export const MAX_NAME = 40;

export function toStyle(d: Doc): Style {
  const bg = d.background;
  return {
    canvas: d.canvas, canvasW: d.canvasW, canvasH: d.canvasH, scale: d.scale,
    anchorX: d.anchorX, anchorY: d.anchorY, offsetX: d.offsetX, offsetY: d.offsetY,
    padding: d.padding, radius: d.radius, shadow: d.shadow, shadowSpec: { ...d.shadowSpec },
    border: d.border, borderWidth: d.borderWidth, window: d.window, blur: d.blur,
    ...(bg.kind === 'custom' ? {} : { background: { ...bg } }),
  };
}

export function applyStyle(d: Doc, s: Style): Doc {
  const { background, ...rest } = structuredClone(s);
  return { ...d, ...rest, background: background ?? d.background };
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const hex = (v: unknown, fallback: string) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;

/** Rebuild a style from stored data, keeping each field only when it is one the editor could have written. */
export function readStyle(raw: unknown): Style | null {
  if (!isObject(raw)) return null;
  const d = newDoc(1, 1, { kind: 'solid', color: '#ffffff' });
  const num = (k: keyof Doc, lo: number, hi: number) => { const v = raw[k]; return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d[k] as number; };
  const one = <T extends string | number>(k: keyof Doc, list: readonly T[]) => list.includes(raw[k] as T) ? raw[k] as T : d[k] as T;
  const w = num('canvasW', 1, 1e5), hgt = num('canvasH', 1, 1e5);
  const sizeOk = !refuseCanvas(w, hgt);
  const ss = isObject(raw.shadowSpec) ? raw.shadowSpec : {};
  const sn = (k: keyof ShadowSpec, lo: number, hi: number) => { const v = ss[k]; return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d.shadowSpec[k] as number; };
  const bg = raw.background;
  let background: Style['background'];
  if (isObject(bg)) {
    if (bg.kind === 'art' && ARTWORK.some(x => x.id === bg.id)) background = { kind: 'art', id: bg.id as string };
    else if (bg.kind === 'gradient' && GRADIENTS.some(x => x.id === bg.id)) background = { kind: 'gradient', id: bg.id as string };
    else if (bg.kind === 'solid') background = { kind: 'solid', color: hex(bg.color, '#f4f4f1') };
  }
  return {
    canvas: one('canvas', CANVAS_PRESETS.map(p => p.id)), canvasW: sizeOk ? w : d.canvasW, canvasH: sizeOk ? hgt : d.canvasH,
    scale: num('scale', SCALE_MIN, SCALE_MAX),
    anchorX: one<Anchor>('anchorX', [-1, 0, 1]), anchorY: one<Anchor>('anchorY', [-1, 0, 1]),
    offsetX: num('offsetX', -20000, 20000), offsetY: num('offsetY', -20000, 20000),
    padding: num('padding', 0, 30), radius: num('radius', 0, 12),
    shadow: one<Shadow>('shadow', ['none', 'soft', 'lifted', 'print', 'custom']),
    shadowSpec: { x: sn('x', -200, 200), y: sn('y', -200, 200), blur: sn('blur', 0, 200), spread: sn('spread', 0, 100), opacity: sn('opacity', 0, 100), color: hex(ss.color, d.shadowSpec.color) },
    border: one('border', ['none', 'paper', 'ink'] as const), borderWidth: num('borderWidth', 1, 30),
    window: one('window', ['none', 'light', 'dark'] as const), blur: num('blur', 0, 40),
    ...(background ? { background } : {}),
  };
}

export function loadStyles(): SavedStyle[] {
  let raw: unknown;
  try { raw = JSON.parse(localStorage.getItem(STYLES_KEY) ?? '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STYLES).flatMap((x): SavedStyle[] => {
    const style = isObject(x) ? readStyle(x.style) : null;
    return style && isObject(x) && typeof x.name === 'string' && x.name.trim() ? [{ name: x.name.trim().slice(0, MAX_NAME), style }] : [];
  });
}

/** False when the browser refuses to store them (a full or blocked store). */
export function storeStyles(list: SavedStyle[]): boolean {
  try { localStorage.setItem(STYLES_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
