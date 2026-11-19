import { own } from './parse';

/** Where the selected post's author photo sits in the visible page, in CSS pixels. */
export type AvatarProbe = { x: number; y: number; size: number; vw: number; vh: number; cw: number; ch: number; dpr: number; scrollX: number; scrollY: number };
const FIELDS = ['x', 'y', 'size', 'vw', 'vh', 'cw', 'ch', 'dpr', 'scrollX', 'scrollY'] as const;
const round = (n: number) => Math.round(n * 100) / 100;

/** Content side. Returns the author photo's box only when it is the post author's own photo, loaded, fully on
 *  screen and not covered by anything else; otherwise null, and the card keeps its initials. */
export function probeAvatar(article: Element, handle: string): AvatarProbe | null {
  const doc = article.ownerDocument; const view = doc.defaultView;
  if (!view || doc.visibilityState !== 'visible') return null;
  const slots = [...article.querySelectorAll('[data-testid="Tweet-User-Avatar"]')].filter((n) => own(n, article));
  const body = [...article.querySelectorAll('[data-testid="tweetText"]')].find((n) => own(n, article));
  // The author's photo precedes the post text; a quoted post's photo follows it.
  const slot = slots[0];
  if (!slot || (body && !(slot.compareDocumentPosition(body) & 4))) return null;
  const frames = [...slot.querySelectorAll('[data-testid^="UserAvatar-Container-"]')];
  const frame = frames.length === 1 ? frames[0]! : null;
  if (!frame || frame.getAttribute('data-testid')!.slice('UserAvatar-Container-'.length).toLowerCase() !== handle.toLowerCase()) return null;
  const imgs = [...frame.querySelectorAll('img')];
  const img = imgs.length === 1 ? imgs[0]! : null;
  if (!img || !img.complete || !img.naturalWidth) return null;
  const box = img.getBoundingClientRect();
  const cw = doc.documentElement.clientWidth, ch = doc.documentElement.clientHeight;
  if (box.width < 16 || box.width > 256 || Math.abs(box.width - box.height) > 1) return null;
  if (box.left < 0 || box.top < 0 || box.right > cw || box.bottom > ch) return null;
  // Menus, hover cards and sticky headers sit on top of the page; the photo must be what is visible.
  const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  // Check the retained circular perimeter too: a thin sticky header can miss every interior point.
  // Stay inside the circle (the square's corners are deliberately clipped by X's avatar container).
  const radius = 0.5 - 1.5 / box.width;
  for (let i = 0; i < 32; i++) {
    const angle = i * Math.PI / 16;
    points.push([0.5 + radius * Math.cos(angle), 0.5 + radius * Math.sin(angle)]);
  }
  for (const [fx, fy] of points) {
    const hit = doc.elementFromPoint(box.left + box.width * fx!, box.top + box.height * fy!);
    if (!hit || !frame.contains(hit)) return null;
  }
  return { x: round(box.left), y: round(box.top), size: round(box.width), vw: view.innerWidth, vh: view.innerHeight, cw, ch, dpr: view.devicePixelRatio, scrollX: round(view.scrollX), scrollY: round(view.scrollY) };
}

export function validProbe(value: unknown): value is AvatarProbe {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return Object.keys(p).length === FIELDS.length && FIELDS.every((k) => typeof p[k] === 'number' && Number.isFinite(p[k])) &&
    (p.dpr as number) > 0 && (p.dpr as number) <= 8 && (p.size as number) >= 16 && (p.size as number) <= 256 && (p.vw as number) > 0 && (p.vh as number) > 0;
}

export const sameProbe = (a: AvatarProbe, b: AvatarProbe) => FIELDS.every((k) => a[k] === b[k]);

/** The photo's square in a screenshot of the visible page, or null when the screenshot is not that page.
 *  The scale comes from the screenshot itself (Chrome may capture at device or CSS pixels) and must agree on both
 *  axes. One CSS pixel is trimmed from each edge to drop the page's anti-aliased rim. */
export function cropBox(p: AvatarProbe, width: number, height: number) {
  // Try the viewport with its scrollbar first, then without: captures differ in whether they include it.
  for (const css of [p.vw, p.cw]) {
    const k = width / css;
    if (!(k >= 0.5 && k <= 8) || ![p.vh, p.ch].some((h) => Math.abs(h * k - height) <= Math.max(2, k))) continue;
    const sx = (p.x + 1) * k, sy = (p.y + 1) * k, size = (p.size - 2) * k;
    if (sx < 0 || sy < 0 || sx + size > width || sy + size > height) return null;
    return { sx, sy, size, out: Math.min(192, Math.round(size)) };
  }
  return null;
}

const PNG = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
function base64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Crop the photo out of a screenshot, locally, into a small PNG. The screenshot itself is never kept. */
export async function cropAvatar(shot: string, probe: AvatarProbe): Promise<string | null> {
  const match = PNG.exec(shot);
  if (!match) return null;
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  try {
    const box = cropBox(probe, bitmap.width, bitmap.height);
    if (!box) return null;
    const canvas = new OffscreenCanvas(box.out, box.out);
    const g = canvas.getContext('2d')!; g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, box.sx, box.sy, box.size, box.size, 0, 0, box.out, box.out);
    const data = 'data:image/png;base64,' + base64(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    return data.length < 150_000 ? data : null;
  } finally { bitmap.close(); }
}

/** Background side. Screenshots only the tab the user right-clicked, only while it is still the visible tab
 *  showing the same page, and keeps the photo only if the page reports the same post, photo box and scroll
 *  position after the screenshot as before it. Any doubt returns null and the card shows initials. */
export async function captureAvatar(tab: chrome.tabs.Tab, probe: unknown, token: unknown): Promise<string | null> {
  if (!validProbe(probe) || tab.id === undefined || typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) return null;
  const showing = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    return !!active && active.id === tab.id && active.url === tab.url;
  };
  try {
    if (!(await showing())) return null;
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const check = await chrome.tabs.sendMessage(tab.id, { type: 'xck:postcard:avatar-check', probe, token }, { frameId: 0 }) as { ok?: boolean } | undefined;
    if (check?.ok !== true || !(await showing())) return null;
    return await cropAvatar(shot, probe);
  } catch { return null; }
}
