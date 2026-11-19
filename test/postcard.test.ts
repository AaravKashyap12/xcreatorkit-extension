// @ts-expect-error Tests run in Node; this project intentionally loads only Chrome ambient types.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { cropBox, sameProbe, validProbe, type AvatarProbe } from '../src/postcard/avatar';
import { parsePost, validPost, type PostcardPost } from '../src/postcard/parse';
import { BACKGROUNDS, STYLES, renderCard, type CardOptions } from '../src/postcard/render';

const html = readFileSync('test/fixtures/postcard.html', 'utf8');
const doc = new Window().document as unknown as Document;
doc.write(html);
const article = (id: string) => doc.getElementById(id)!;

describe('synthetic post parser', () => {
  it('identifies each article from its own timestamp link', () => {
    const first = parsePost(article('first'));
    const second = parsePost(article('second'));
    expect(first.ok && first.post.id).toBe('111');
    expect(second.ok && second.post.id).toBe('222');
    if (!second.ok) return;
    expect(second.post.text).not.toContain('Quoted text');
    expect(second.post.counts).toEqual({ replies: null, reposts: null, likes: '3', views: null });
    expect(second.post.avatar).toBeNull();
    expect(second.post.utc).toBe('2026-10-21T01:30:00.000Z');
    expect(validPost(second.post)).toBe(true);
  });
  it('keeps compact counts at displayed precision and missing fields unknown', () => {
    const result = parsePost(article('first'));
    expect(result.ok && result.post.counts).toEqual({ replies: '2', reposts: null, likes: '1.2K', views: null });
  });
  it('reads current action labels, selected controls and the post analytics link', () => {
    const el = article('first').cloneNode(true) as Element;
    el.querySelectorAll('[data-testid="reply"], [data-testid="like"]').forEach((n) => n.remove());
    el.insertAdjacentHTML('beforeend', `<button data-testid="reply" aria-label="0 Replies. Reply"></button>
      <button data-testid="unretweet" aria-label="14 reposts. Repost"><span>14</span></button>
      <button data-testid="unlike" aria-label="2345 Likes. Unlike"><span>2.3K</span></button>
      <a href="/firstuser/status/111/analytics" aria-label="45678 views. View post analytics"><span>45K</span></a>`);
    const result = parsePost(el);
    expect(result.ok && result.post.counts).toEqual({ replies: '0', reposts: '14', likes: '2.3K', views: '45K' });
  });
  it('reads action-label counts when the controls have no numeric text', () => {
    const el = article('first').cloneNode(true) as Element;
    el.querySelector('[data-testid="reply"]')!.setAttribute('aria-label', '8 Replies. Reply');
    el.querySelector('[data-testid="like"]')!.setAttribute('aria-label', '29 Likes. Like');
    el.insertAdjacentHTML('beforeend', '<a href="https://x.com/firstuser/status/111/analytics" aria-label="401 views. View post analytics"></a>');
    const result = parsePost(el);
    expect(result.ok && result.post.counts).toEqual({ replies: '8', reposts: null, likes: '29', views: '401' });
  });
  it('does not borrow counts from quotes, other posts or external analytics links', () => {
    const el = article('first').cloneNode(true) as Element;
    el.insertAdjacentHTML('beforeend', `<div data-testid="quote"><button data-testid="retweet">999</button>
      <a href="/firstuser/status/111/analytics">999</a></div>
      <article><a href="/firstuser/status/111/analytics">999</a></article>
      <a href="/other/status/222/analytics">999</a>
      <a href="https://example.com/firstuser/status/111/analytics">999</a>`);
    const result = parsePost(el);
    expect(result.ok && result.post.counts.reposts).toBeNull();
    expect(result.ok && result.post.counts.views).toBeNull();
  });
  it('does not turn action names or unsupported magnitudes into zero', () => {
    const el = article('first').cloneNode(true) as Element;
    el.querySelector('[data-testid="reply"]')!.setAttribute('aria-label', 'Reply');
    el.querySelector('[data-testid="like"]')!.setAttribute('aria-label', '1.2万 Likes. Like');
    const result = parsePost(el);
    expect(result.ok && result.post.counts.replies).toBeNull();
    expect(result.ok && result.post.counts.likes).toBeNull();
  });
  it('keeps inline emoji alternatives and explicit line breaks without nested quote text', () => {
    const result = parsePost(article('rich'));
    if (!result.ok) throw Error(result.reason);
    expect(result.post.author).toBe('Rocket 🚀');
    expect(result.post.text).toBe('Hello 🚀\nFirst\nSecond');
    const markup = renderCard(result.post, { style: 'paper', background: BACKGROUNDS[0]!, showCounts: true, format: 'portrait' });
    expect(markup).toContain('Rocket 🚀');
    expect(markup).toContain('Hello 🚀\nFirst\nSecond');
    expect(markup).not.toContain('Quoted words');
  });
  it('escapes image alternative text before it enters card markup', () => {
    const el = article('rich').cloneNode(true) as Element;
    el.querySelector('[data-testid="tweetText"] img')!.setAttribute('alt', '<img src=x onerror=alert(1)>');
    const result = parsePost(el);
    if (!result.ok) throw Error(result.reason);
    const markup = renderCard(result.post, { style: 'paper', background: BACKGROUNDS[0]!, showCounts: false, format: 'portrait' });
    expect(markup).toContain('Hello &lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('Hello <img src=x');
  });
  it('does not strip an unsupported localized magnitude from a count', () => {
    const el = article('first').cloneNode(true) as Element;
    el.querySelector('[data-testid="like"]')!.setAttribute('aria-label', '1.2万 Likes');
    const result = parsePost(el);
    expect(result.ok && result.post.counts.likes).toBeNull();
  });
  it('rejects an ambiguous status or missing post text', () => {
    const el = article('first').cloneNode(true) as Element;
    el.querySelector('time')?.remove();
    expect(parsePost(el).ok).toBe(false);
    const next = article('first').cloneNode(true) as Element;
    next.querySelector('[data-testid="tweetText"]')?.remove();
    expect(parsePost(next).ok).toBe(false);
    const ambiguous = article('first').cloneNode(true) as Element;
    const extra = doc.createElement('a'); extra.setAttribute('href', '/other/status/999');
    const extraTime = doc.createElement('time'); extraTime.setAttribute('datetime', '2026-10-20T00:00:00Z');
    extra.append(extraTime); ambiguous.append(extra);
    expect(parsePost(ambiguous).ok).toBe(false);
  });
  it('rejects excessive text without silently cutting it and keeps timezone-less dates unknown', () => {
    const el = article('first').cloneNode(true) as Element;
    el.querySelector('time')!.setAttribute('datetime', '2026-10-20T23:45:00');
    const parsed = parsePost(el);
    expect(parsed.ok && parsed.post.utc).toBeNull();
    el.querySelector('[data-testid="tweetText"]')!.textContent = 'x'.repeat(3001);
    expect(parsePost(el).ok).toBe(false);
  });
  it('escapes injected post text and renders unknown counts as dashes', () => {
    const result = parsePost(article('second'));
    if (!result.ok) throw Error(result.reason);
    const markup = renderCard(result.post, { style: 'paper', background: BACKGROUNDS[0]!, showCounts: true, format: 'portrait' });
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img src=x');
    const card = doc.createElement('div'); card.innerHTML = markup;
    expect(card.querySelector('.postcard-meta')!.textContent).toContain('— replies');
    expect(markup).toContain('21 Oct 2026 UTC');
  });
});

const sample: PostcardPost = { id: '9', url: 'https://x.com/maya/status/9', author: 'Maya Okafor', handle: 'maya', text: 'Line one\n\nLine two 🚀', utc: '2026-10-27T23:30:00Z', avatar: null, counts: { replies: '0', reposts: null, likes: '1', views: '8.4K' } };
const card = (post: PostcardPost, options: Partial<CardOptions> = {}) => {
  const holder = doc.createElement('div');
  holder.innerHTML = renderCard(post, { style: 'paper', background: BACKGROUNDS[0]!, showCounts: true, format: 'portrait', ...options });
  return holder.firstElementChild as HTMLElement;
};

describe('post image renderer', () => {
  it('keeps captured zeros, singular counts and unknown dashes distinct', () => {
    expect(card(sample).querySelector('.postcard-meta')!.textContent).toBe('0 replies — reposts 1 like 8.4K views');
    const unknown = card({ ...sample, counts: { replies: null, reposts: null, likes: null, views: null } });
    expect(unknown.querySelector('.postcard-meta')!.textContent).toBe('— replies — reposts — likes — views');
  });
  it('removes the whole counts row when counts are off', () => {
    for (const [style] of STYLES) {
      const off = card(sample, { style, showCounts: false });
      expect(off.querySelector('.postcard-meta')).toBeNull();
      expect(off.textContent).not.toMatch(/replies|reposts|likes|views/);
    }
  });
  it('draws every style from the same post anatomy, with the date in UTC', () => {
    for (const [style] of STYLES) for (const format of ['portrait', 'landscape'] as const) {
      const el = card(sample, { style, format });
      expect(el.classList.contains(style) && el.classList.contains(format)).toBe(true);
      expect(el.querySelector('.postcard-name')!.textContent).toBe('Maya Okafor');
      expect(el.querySelector('.postcard-handle')!.textContent).toBe('@maya');
      expect(el.querySelector('.postcard-text')!.textContent).toBe('Line one\n\nLine two 🚀');
      expect(el.querySelector('.postcard-date')!.textContent).toBe('27 Oct 2026 UTC');
      expect(el.querySelectorAll('.postcard-brand').length).toBe(1);
    }
    // Feed carries the date in the byline, as a timeline does.
    expect(card(sample, { style: 'type' }).querySelector('.postcard-identity .postcard-date')).not.toBeNull();
    expect(card({ ...sample, utc: null }).querySelector('.postcard-date')!.textContent).toBe('—');
  });
  it('keeps the four stored style values and every earlier background valid', () => {
    expect(STYLES.map(([value]) => value)).toEqual(['paper', 'ink', 'frame', 'type']);
    for (const legacy of ['#f3efe6', '#f8f6ef', '#e9e6dc', '#dbe4df', '#e8dfd6']) expect(card(sample, { background: legacy }).getAttribute('style')).toBe(`--card-bg:${legacy}`);
    expect(card(sample, { background: 'red;background:url(x)' }).getAttribute('style')).toBe(`--card-bg:${BACKGROUNDS[0]}`);
    expect(card(sample, { style: 'poster' as CardOptions['style'] }).classList.contains('paper')).toBe(true);
  });
  it('gives dark fields light branding', () => {
    expect(card(sample, { background: '#2f55d4' }).classList.contains('on-dark')).toBe(true);
    expect(card(sample, { background: '#1d1c1a' }).classList.contains('on-dark')).toBe(true);
    expect(card(sample, { background: '#ece6da' }).classList.contains('on-dark')).toBe(false);
  });
  it('draws only a small inline PNG or JPEG photo, otherwise initials', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO44GICAAMwAUmAb/TNAAAAAElFTkSuQmCC';
    expect(card({ ...sample, avatar: png }).querySelector('.postcard-avatar img')!.getAttribute('src')).toBe(png);
    for (const avatar of ['https://pbs.twimg.com/profile_images/a.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(150_000)}`]) {
      const el = card({ ...sample, avatar });
      expect(el.querySelector('.postcard-avatar img')).toBeNull();
      expect(el.querySelector('.postcard-avatar')!.textContent).toBe('MO');
    }
  });
});

const probe: AvatarProbe = { x: 100, y: 200, size: 40, vw: 1280, vh: 800, cw: 1265, ch: 800, dpr: 2, scrollX: 0, scrollY: 640 };
describe('profile photo crop', () => {
  it('crops the photo square from a screenshot of the same viewport, trimming its rim', () => {
    expect(cropBox(probe, 2560, 1600)).toEqual({ sx: 202, sy: 402, size: 76, out: 76 });
    // A capture that leaves out the scrollbar still has the same origin and scale.
    expect(cropBox(probe, 2530, 1600)).toEqual({ sx: 202, sy: 402, size: 76, out: 76 });
    expect(cropBox({ ...probe, dpr: 2.2, vw: 1163.64, cw: 1163.64, vh: 727.27, ch: 727.27 }, 2560, 1600)?.sx).toBeCloseTo(222.2);
  });
  it('takes the scale from the screenshot, which may be in CSS or device pixels', () => {
    expect(cropBox(probe, 1280, 800)).toEqual({ sx: 101, sy: 201, size: 38, out: 38 });
  });
  it('refuses a screenshot whose shape is not the reported viewport', () => {
    expect(cropBox(probe, 2560, 1500)).toBeNull();
    expect(cropBox(probe, 1600, 1600)).toBeNull();
    expect(cropBox(probe, 320, 200)).toBeNull();
  });
  it('refuses a photo box outside the screenshot', () => {
    expect(cropBox({ ...probe, x: 1250 }, 2560, 1600)).toBeNull();
    expect(cropBox({ ...probe, y: -5 }, 2560, 1600)).toBeNull();
  });
  it('accepts only an exact, well-formed photo report', () => {
    expect(validProbe(probe)).toBe(true);
    expect(validProbe({ ...probe, extra: 1 })).toBe(false);
    expect(validProbe({ ...probe, x: Number.NaN })).toBe(false);
    expect(validProbe({ ...probe, size: 400 })).toBe(false);
    expect(validProbe({ ...probe, dpr: 0 })).toBe(false);
    const { scrollY: _, ...missing } = probe;
    expect(validProbe(missing)).toBe(false);
    expect(sameProbe(probe, { ...probe })).toBe(true);
    expect(sameProbe(probe, { ...probe, scrollY: 641 })).toBe(false);
  });
});
