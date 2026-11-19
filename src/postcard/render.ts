import geist from '../../static/fonts/geist.woff2';
import mono from '../../static/fonts/geist-mono-latin.woff2';
import type { PostcardPost } from './parse';
import cardCss from './card.css';

/** Style values are stable identifiers: paper = Light, ink = Dark, frame = Framed, type = Feed. */
export type CardOptions = { style: 'paper' | 'ink' | 'frame' | 'type'; background: string; showCounts: boolean; format: 'portrait' | 'landscape' };
export const STYLES = [['paper', 'Light'], ['ink', 'Dark'], ['frame', 'Framed'], ['type', 'Feed']] as const;
/** Solid fields offered in the editor, in display order. */
export const BACKGROUNDS = ['#ece6da', '#c9d6c3', '#e7bfa5', '#bcd0ea', '#2f55d4', '#1d1c1a'];
export const BACKGROUND_NAMES: Record<string, string> = { '#ece6da': 'Paper', '#c9d6c3': 'Sage', '#e7bfa5': 'Clay', '#bcd0ea': 'Sky', '#2f55d4': 'Cobalt', '#1d1c1a': 'Ink' };
// Earlier fields stay valid for site markup and saved options, drawn as they always were.
const LEGACY_BACKGROUNDS = ['#f3efe6', '#f8f6ef', '#e9e6dc', '#dbe4df', '#e8dfd6'];
export const DIMENSIONS = { portrait: [1080, 1350], landscape: [1200, 675] } as const;
const AVATAR = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (s: string | null) => s ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(s)) + ' UTC' : '—';
export const CARD_CSS = `@font-face{font-family:PostGeist;src:url(${geist}) format('woff2');font-weight:100 900}@font-face{font-family:PostMono;src:url(${mono}) format('woff2');font-weight:100 900}` + cardCss;

/** Relative luminance below this reads as a dark field and takes light branding. */
function darkField(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.2;
}

export function renderCard(post: PostcardPost, options: CardOptions): string {
  const bg = BACKGROUNDS.includes(options.background) || LEGACY_BACKGROUNDS.includes(options.background) ? options.background : BACKGROUNDS[0]!;
  const style = STYLES.some(([value]) => value === options.style) ? options.style : 'paper';
  // Initials from the first two named words (Maya Okafor → MO), or the first two letters of a single word.
  const names = post.author.split(/\s+/).map((w) => [...w].filter((c) => /\p{L}/u.test(c))).filter((w) => w.length);
  const initials = (names.length > 1 ? names[0]![0]! + names[1]![0]! : (names[0] ?? []).slice(0, 2).join('')).toUpperCase() || 'X';
  const avatar = post.avatar && AVATAR.test(post.avatar) && post.avatar.length < 150_000 ? `<img alt="" src="${escape(post.avatar)}">` : `<span>${escape(initials)}</span>`;
  const when = `<span class="postcard-date">${escape(date(post.utc))}</span>`;
  const counts = ([['reply', 'replies', post.counts.replies], ['repost', 'reposts', post.counts.reposts], ['like', 'likes', post.counts.likes], ['view', 'views', post.counts.views]] as const)
    .map(([one, many, value]) => `<span><b>${escape(value ?? '—')}</b> <i>${value === '1' ? one : many}</i></span>`).join(' ');
  // Feed puts the date in the byline, as a timeline does; the others give it its own quiet line.
  const feed = style === 'type';
  const identity = `<div class="postcard-identity"><span class="postcard-name">${escape(post.author)}</span> <span class="postcard-handle">@${escape(post.handle)}</span>${feed ? ` <span class="postcard-dot">·</span> ${when}` : ''}</div>`;
  const meta = options.showCounts ? `<div class="postcard-meta">${counts}</div>` : '';
  const words = `<div class="postcard-text">${escape(post.text)}</div>` + (feed ? meta : `<div class="postcard-bottom">${when}${meta}</div>`);
  return `<div class="postcard ${style} ${options.format}${darkField(bg) ? ' on-dark' : ''}" style="--card-bg:${bg}"><div class="postcard-safe"><div class="postcard-post">`
    + (feed ? `<div class="postcard-avatar">${avatar}</div><div class="postcard-main"><div class="postcard-top">${identity}</div>${words}</div>`
      : `<div class="postcard-top"><div class="postcard-avatar">${avatar}</div>${identity}</div>${words}`)
    + `</div><div class="postcard-brand">made with xcreatorkit.com</div></div></div>`;
}

/** Fit the whole post at a reading size: widen the post first, then shrink only its body text. Returns false,
 *  refusing export, when anything would still be clipped. The fit is measured on an untransformed copy, so a
 *  scaled or tilted preview and the full-size export always reach the same answer. */
export function fitCard(card: HTMLElement): boolean {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0';
  const copy = card.cloneNode(true) as HTMLElement;
  holder.append(copy); document.body.append(holder);
  let fit: { wide: boolean; size: number } | null;
  try { fit = measure(copy); } finally { holder.remove(); }
  const body = card.querySelector<HTMLElement>('.postcard-text')!;
  card.classList.toggle('wide', !!fit?.wide);
  body.style.fontSize = fit ? `${fit.size}px` : '';
  if (fit) card.dataset.body = String(fit.size); else delete card.dataset.body;
  return !!fit;
}

function measure(card: HTMLElement): { wide: boolean; size: number } | null {
  const body = card.querySelector<HTMLElement>('.postcard-text')!;
  // Each style sets its own reading size in card.css; that is the size the post keeps whenever it fits.
  card.classList.remove('wide'); body.style.fontSize = '';
  const start = Math.round(parseFloat(getComputedStyle(body).fontSize));
  const min = 20;
  const scale = card.getBoundingClientRect().width / card.offsetWidth || 1;
  const contained = (el: HTMLElement): boolean => {
    const parent = el.parentElement!;
    const box = el.getBoundingClientRect();
    const bounds = parent.getBoundingClientRect();
    return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1 &&
      box.left >= bounds.left - scale && box.right <= bounds.right + scale && box.top >= bounds.top - scale && box.bottom <= bounds.bottom + scale;
  };
  for (const wide of [false, true]) {
    card.classList.toggle('wide', wide);
    // At its natural width the post keeps the starting size; only the widened post may shrink.
    for (let size = start; size >= (wide ? min : start); size -= 1) {
      body.style.fontSize = `${size}px`;
      if ([...card.querySelectorAll<HTMLElement>('*')].every(contained)) return { wide, size };
    }
  }
  return null;
}

export async function cardPng(post: PostcardPost, options: CardOptions): Promise<Blob> {
  const [width, height] = DIMENSIONS[options.format];
  await document.fonts.ready;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0';
  holder.innerHTML = renderCard(post, options); document.body.append(holder);
  let xhtml: string;
  try {
    const card = holder.firstElementChild as HTMLElement;
    if (!fitCard(card)) throw new Error('This post is too long for this image size. Try Portrait.');
    xhtml = new XMLSerializer().serializeToString(card);
  } finally { holder.remove(); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${CARD_CSS.replace(/</g, '\\3c ')}</style>${xhtml}</div></foreignObject></svg>`;
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
}
