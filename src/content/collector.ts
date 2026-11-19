// Injected on demand via chrome.scripting (activeTab) after the user clicks
// "Capture this page". Defines a single function in the extension's isolated
// world; it reads the DOM only. No network, cookies, storage or page mutation.
import { extractRewards, type RewardsExtract } from '../extract/rewards';

const POLL_MS = 600;
const MAX_MS = 15_000;

async function collect(): Promise<RewardsExtract> {
  const started = Date.now();
  let prev: RewardsExtract | null = null;
  let last: RewardsExtract = extractRewards(document, location.href);
  while (Date.now() - started < MAX_MS) {
    last = extractRewards(document, location.href);
    // Terminal states: no amount of waiting fixes these.
    if (!last.ok && (last.code === 'unsupported_page' || last.code === 'not_signed_in')) return last;
    // Stable criterion: two consecutive identical successful reads.
    if (last.ok && prev?.ok && prev.parsed.displayText === last.parsed.displayText) return last;
    prev = last;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (last.ok) {
    return { ok: false, code: 'unstable', message: 'Value kept changing while the page loaded.', account: last.account, sourceUrl: last.sourceUrl };
  }
  return last;
}

(globalThis as unknown as { __xgdCollect: typeof collect }).__xgdCollect = collect;
