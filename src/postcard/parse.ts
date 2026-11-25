export type PostcardPost = {
  id: string; url: string; author: string; handle: string; text: string; utc: string | null;
  counts: { replies: string | null; reposts: string | null; likes: string | null; views: string | null };
  avatar: string | null;
};
export type ParseResult = { ok: true; post: PostcardPost } | { ok: false; reason: string };

export const own = (node: Element | null, article: Element): boolean => {
  if (!node || node.closest('article') !== article) return false;
  const quote = node.closest('[data-testid="quote"]');
  return !quote || quote.closest('article') !== article;
};
const text = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const visibleText = (root: Element): string => {
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    if (el !== root && (el.matches('article') || el.matches('[data-testid="quote"]'))) return '';
    if (el.localName === 'img') return el.getAttribute('alt') ?? '';
    if (el.localName === 'br') return '\n';
    return [...el.childNodes].map(read).join('');
  };
  return read(root);
};
const status = (href: string | null) => /^\/?([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:[/?#]|$)/.exec(href ?? '');
const countValue = (el: Element | undefined): string | null => {
  if (!el) return null;
  // Retain the displayed precision. Localised or abbreviated values are never expanded into guessed integers.
  const displayed = text(el.textContent, 80);
  if (/^[\p{N}][\p{N}.,\s]*[KMBkmb]?$/u.test(displayed)) return text(displayed, 40);
  // X appends the action to accessible counts, including controls with an undisplayed zero.
  const label = text(el.getAttribute('aria-label') ?? el.textContent, 160)
    .replace(/\.\s*(?:Reply|Like|Unlike|Repost|Undo repost|View post analytics)$/i, '');
  const match = /^(?:[\p{L}\s]*?)([\p{N}][\p{N}.,\s\u00a0\u202f]*[KMBkmb]?)(?:\s+[\p{L}\s]*)?$/u.exec(label);
  return match ? text(match[1], 40) : null;
};
const count = (article: Element, selector: string): string | null =>
  countValue([...article.querySelectorAll(selector)].find((n) => own(n, article)));
const views = (article: Element, handle: string, id: string): string | null => {
  const el = [...article.querySelectorAll('[data-testid="viewCount"], a[href]')].find((n) => {
    if (!own(n, article)) return false;
    if (n.getAttribute('data-testid') === 'viewCount') return true;
    try {
      const url = new URL(n.getAttribute('href')!, 'https://x.com');
      return url.origin === 'https://x.com' && url.pathname.toLowerCase() === `/${handle.toLowerCase()}/status/${id}/analytics`;
    } catch { return false; }
  });
  return countValue(el);
};

export function parsePost(article: Element): ParseResult {
  if (!article.matches('article[data-testid="tweet"]')) return { ok: false, reason: 'Post article unavailable.' };
  const candidates = [...article.querySelectorAll('time[datetime]')].filter((n) => own(n, article)).map((time) => ({ time, link: time.closest('a[href]') }))
    .filter(({ link }) => own(link, article) && status(link!.getAttribute('href')));
  const identities = new Set(candidates.map(({ link }) => link!.getAttribute('href')));
  const time = candidates[0]?.time;
  const match = identities.size === 1 ? status(candidates[0]!.link!.getAttribute('href')) : null;
  if (!match) return { ok: false, reason: 'Post identity unavailable.' };
  const handle = match[1]!;
  const id = match[2]!;
  const names = [...article.querySelectorAll('[data-testid="User-Name"]')].find((n) => own(n, article));
  const authorLink = names && [...names.querySelectorAll('a[href]')].find((a) => new RegExp(`^/${handle}/?$`, 'i').test(a.getAttribute('href') ?? ''));
  const author = text(authorLink && visibleText(authorLink), 120);
  if (!author || !authorLink) return { ok: false, reason: 'Post author unavailable or ambiguous.' };
  const body = [...article.querySelectorAll('[data-testid="tweetText"]')].find((n) => own(n, article));
  if (!body) return { ok: false, reason: 'Post text unavailable.' };
  const postText = visibleText(body).trim();
  if (postText.length > 3000) return { ok: false, reason: 'Post text is too long for this card.' };
  if (!postText) return { ok: false, reason: 'Post text unavailable.' };
  const rawDate = time?.getAttribute('datetime') ?? '';
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/i.test(rawDate) && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
  const img = [...article.querySelectorAll('[data-testid="Tweet-User-Avatar"] img')].find((n) => own(n, article)) as HTMLImageElement | undefined;
  // Remote avatar URLs never enter the export. Inline fixture images are allowed only as PNG/JPEG data URLs.
  const avatar = img?.src && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img.src) && img.src.length < 150_000 ? img.src : null;
  return { ok: true, post: {
    id, url: `https://x.com/${handle}/status/${id}`, author, handle, text: postText, utc,
    counts: {
      replies: count(article, '[data-testid="reply"]'),
      reposts: count(article, '[data-testid="retweet"], [data-testid="unretweet"]'),
      likes: count(article, '[data-testid="like"], [data-testid="unlike"]'),
      views: views(article, handle, id),
    }, avatar,
  } };
}

export function validPost(value: unknown): value is PostcardPost {
  if (!value || typeof value !== 'object') return false;
  const p = value as PostcardPost;
  return !!p.id && /^\d{1,25}$/.test(p.id) && /^[A-Za-z0-9_]{1,15}$/.test(p.handle) &&
    p.url === `https://x.com/${p.handle}/status/${p.id}` && typeof p.author === 'string' && p.author.length > 0 && p.author.length <= 120 &&
    typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 3000 && (p.utc === null || typeof p.utc === 'string' && !Number.isNaN(Date.parse(p.utc))) &&
    (!p.avatar || /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(p.avatar) && p.avatar.length < 150_000) &&
    !!p.counts && ['replies', 'reposts', 'likes', 'views'].every((k) => p.counts[k as keyof typeof p.counts] === null || typeof p.counts[k as keyof typeof p.counts] === 'string' && (p.counts[k as keyof typeof p.counts]?.length ?? 0) <= 40);
}
