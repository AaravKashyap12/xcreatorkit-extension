import { own, parsePost } from '../postcard/parse';
const root = globalThis as typeof globalThis & { __xckReplyEnable?: () => void };
if (root.__xckReplyEnable) root.__xckReplyEnable();
else {
  let active = true;
  let target: { article: Element; url: string; id: string; permalink: string; text: string; at: number } | null = null;
  root.__xckReplyEnable = () => { active = true; target = null; };
  document.addEventListener('contextmenu', event => {
    target = null;
    if (!active) return;
    const node = event.target instanceof Element ? event.target : null;
    const article = node?.closest('article[data-testid="tweet"]');
    if (!article || !own(node, article) || node?.closest('[data-testid="quote"]')) return;
    // Quotes, multiple bodies, and collapsed text require manual context in this beta.
    if (article.querySelector('[data-testid="quote"], [data-testid="tweet-text-show-more-link"]') || [...article.querySelectorAll('[data-testid="tweetText"]')].filter(n => own(n, article)).length !== 1) return;
    const parsed = parsePost(article, true);
    if (parsed.ok && !/(?:…|\.\.\.)$/.test(parsed.post.text)) target = { article, url: location.href, id: parsed.post.id, permalink: parsed.post.url, text: parsed.post.text, at: Date.now() };
  }, true);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'xck:reply:disable') { active = false; target = null; reply({ ok: true }); return false; }
    if (message?.type !== 'xck:reply:collect') return false;
    const was = target; target = null;
    const ambiguous = was && (was.article.querySelector('[data-testid="quote"], [data-testid="tweet-text-show-more-link"]') || [...was.article.querySelectorAll('[data-testid="tweetText"]')].filter(n => own(n, was.article)).length !== 1);
    const parsed = !ambiguous && active && was && Date.now() - was.at < 30_000 && was.url === location.href && was.article.isConnected ? parsePost(was.article, true) : null;
    if (!parsed?.ok || parsed.post.id !== was?.id || parsed.post.text !== was.text || parsed.post.url !== was.permalink) reply({ ok: false });
    else reply({ ok: true, sourceUrl: location.href, source: { text: parsed.post.text, author: parsed.post.author, url: parsed.post.url } });
    return false;
  });
}
