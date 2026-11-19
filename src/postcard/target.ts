import { probeAvatar, sameProbe, validProbe } from './avatar';
import { parsePost, type PostcardPost } from './parse';

// Re-grants and worker startups may inject again into an already-open tab.
const root = globalThis as typeof globalThis & { __xckPostcardEnable?: () => void };
if (root.__xckPostcardEnable) root.__xckPostcardEnable();
else install();

function install() {
  let active = true;
  let target: { article: Element; url: string; id: string; at: number } | null = null;
  // The post just collected, kept briefly so the background can confirm its photo did not move during a screenshot.
  let collected: { article: Element; url: string; id: string; handle: string; at: number; token: string } | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => invalidateCapture());
  function invalidateCapture() {
    collected = null;
    observer.disconnect();
    clearTimeout(expiry);
    expiry = undefined;
  }
  // Endpoints alone cannot prove the screenshot interval was stable. Any intervening change invalidates it,
  // even when the user returns to the same scroll position, tab, viewport or post before validation.
  document.addEventListener('scroll', invalidateCapture, true);
  document.addEventListener('visibilitychange', invalidateCapture);
  window.addEventListener('resize', invalidateCapture);
  window.addEventListener('pagehide', invalidateCapture);
  window.visualViewport?.addEventListener('resize', invalidateCapture);
  window.visualViewport?.addEventListener('scroll', invalidateCapture);
  root.__xckPostcardEnable = () => { if (!active) { active = true; target = null; invalidateCapture(); } };
  document.addEventListener('contextmenu', (event) => {
    if (!active) return;
    const node = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const article = node?.closest('article[data-testid="tweet"]');
    // A quote rendered inside the outer article may not have its own article wrapper.
    const ambiguousQuote = !!node?.closest('[data-testid="quote"]') && node.closest('[data-testid="quote"]')?.closest('article') === article;
    const parsed = article && !ambiguousQuote ? parsePost(article) : null;
    target = parsed?.ok ? { article: article!, url: location.href, id: parsed.post.id, at: Date.now() } : null;
  }, true);

  chrome.runtime.onMessage.addListener((message: { type?: string }, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'xck:postcard:disable') { active = false; target = null; invalidateCapture(); reply({ ok: true }); return false; }
    if (message?.type === 'xck:postcard:avatar-check') {
      const token = (message as { token?: unknown }).token;
      // A stale validation must not accept or consume a newer collection at identical coordinates.
      if (!collected || token !== collected.token) { reply({ ok: false }); return false; }
      const was = collected; invalidateCapture();
      const probe = (message as { probe?: unknown }).probe;
      const fresh = was && active && Date.now() - was.at < 10_000 && location.href === was.url && was.article.isConnected;
      const parsed = fresh ? parsePost(was.article) : null;
      const now = parsed?.ok && parsed.post.id === was!.id ? probeAvatar(was!.article, was!.handle) : null;
      reply({ ok: !!now && validProbe(probe) && sameProbe(now, probe) });
      return false;
    }
    if (message?.type !== 'xck:postcard:collect') return false;
    if (!active || !target || Date.now() - target.at > 30_000 || location.href !== target.url || !target.article.isConnected) {
      reply({ ok: false, reason: 'Right-click the post again, then choose Make an image of this post.' });
      return false;
    }
    const parsed = parsePost(target.article);
    if (!parsed.ok || parsed.post.id !== target.id) { reply({ ok: false, reason: 'The selected post changed. Right-click it again.' }); return false; }
    invalidateCapture();
    collected = { article: target.article, url: location.href, id: parsed.post.id, handle: parsed.post.handle, at: Date.now(), token: crypto.randomUUID() };
    observer.observe(target.article, { attributes: true, childList: true, characterData: true, subtree: true });
    expiry = setTimeout(invalidateCapture, 10_000);
    target = null;
    reply({ ok: true, post: parsed.post satisfies PostcardPost, sourceUrl: location.href, avatar: parsed.post.avatar ? null : probeAvatar(collected.article, collected.handle), avatarToken: collected.token });
    return false;
  });

}
