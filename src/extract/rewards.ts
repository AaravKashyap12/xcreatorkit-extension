import type { CaptureFailureCode, ParsedNumber, WindowType } from '../model/types';
import { parseCount } from '../model/parse';

// NOTE: The live DOM of the rewards page has not been inspected by the
// extractor author (the browser available during development was signed out).
// This extractor therefore relies only on visible text and ARIA attributes,
// never on hashed CSS classes, and refuses to guess when the page is ambiguous.

export const REWARDS_PATH = '/i/jf/creators/original_content_rewards';
const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

export type RewardsExtract =
  | {
      ok: true;
      parsed: ParsedNumber;
      method: 'aria_progressbar' | 'label_proximity';
      windowType: WindowType;
      excludesReplies: boolean | null;
      account: string | null;
      sourceUrl: string;
    }
  | {
      ok: false;
      code: CaptureFailureCode;
      message: string;
      candidates?: string[];
      account: string | null;
      sourceUrl: string;
    };

export function isX(url: URL): boolean {
  return X_HOSTS.has(url.hostname);
}

export function isRewardsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return isX(u) && u.pathname.replace(/\/+$/, '') === REWARDS_PATH;
  } catch {
    return false;
  }
}

/** Strip query/fragment so stored source URLs never carry session parameters. */
export function cleanSourceUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/** Signed-in account handle, from stable data-testid hooks in X's navigation. */
export function extractAccount(doc: Document): string | null {
  const href = doc.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
  const fromHref = href && /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(href)?.[1];
  if (fromHref) return fromHref.toLowerCase();
  const sw = doc.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent ?? '';
  const fromSwitcher = /@([A-Za-z0-9_]{1,15})/.exec(sw)?.[1];
  return fromSwitcher ? fromSwitcher.toLowerCase() : null;
}

const LABEL_RE = /home\s*timeline\s*impressions/i;
const COUNT_TOKEN = /^\d{1,3}(?:,\d{3})+$|^\d+(?:\.\d+)?\s?[KkMm]?$/;
const PAIR_RE = /(\d[\d,]*(?:\.\d+)?\s?[KkMm]?)\s*(?:\/|of|out of)\s*500\s?[Kk]\b/;

/** Labels of other metrics/requirements that can sit next to the rewards row. */
// No \b: textContent joins adjacent spans without spaces ("followers750").
const OTHER_LABEL_RE = /followers(?![a-z])|subscri|premium|engagements?(?![a-z])|profile\s*visits/i;

function isListContainer(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  return tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'main' || role === 'list' || role === 'table' || role === 'grid';
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function visibleTextNodes(root: Element): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 1) {
      const el = n as Element;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'svg') return;
    } else if (n.nodeType === 3) {
      const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
      return;
    }
    n.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

/** Numbers that are thresholds or windows, not the reading. */
function isThresholdValue(p: ParsedNumber, target: number): boolean {
  return p.value === target || p.value === 500 || p.value === 90;
}

function candidatesIn(container: Element, target: number): string[] {
  const found: string[] = [];
  for (const t of visibleTextNodes(container)) {
    const pair = PAIR_RE.exec(t);
    if (pair) {
      const p = parseCount(pair[1]);
      if (p && !isThresholdValue(p, target)) found.push(p.displayText);
      continue;
    }
    if (COUNT_TOKEN.test(t)) {
      const p = parseCount(t);
      if (p && !isThresholdValue(p, target)) found.push(p.displayText);
    }
  }
  return [...new Set(found)];
}

export function extractRewards(doc: Document, url: string, target = 500_000): RewardsExtract {
  const account = extractAccount(doc);
  const sourceUrl = cleanSourceUrl(url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, code: 'unsupported_page', message: 'Invalid page URL.', account, sourceUrl };
  }
  if (isX(u) && /\/(login|i\/flow\/login|i\/jf\/onboarding)/.test(u.pathname)) {
    return { ok: false, code: 'not_signed_in', message: 'X is showing a sign-in page.', account, sourceUrl };
  }
  if (!isRewardsUrl(url)) {
    return { ok: false, code: 'unsupported_page', message: 'Open the Original Content Rewards page first.', account, sourceUrl };
  }

  const root = doc.querySelector('main') ?? doc.body;
  if (!root) return { ok: false, code: 'value_not_found', message: 'Page has not rendered yet.', account, sourceUrl };
  const pageText = textOf(root);
  const windowType: WindowType = /last\s+90\s+days|90[-\s]day/i.test(pageText) ? 'rolling_90d' : 'unknown';
  const excludesReplies = /(does\s+not|doesn['’]t)\s+include\s+replies|excludes?\s+replies/i.test(pageText) ? true : null;

  // Path A: an accessible progressbar whose max is the target carries an exact value.
  for (const pb of Array.from(root.querySelectorAll('[role="progressbar"]'))) {
    const max = Number(pb.getAttribute('aria-valuemax'));
    const now = pb.getAttribute('aria-valuenow');
    const ctx = textOf(pb.parentElement ?? pb) + ' ' + (pb.getAttribute('aria-label') ?? '');
    if (max === target && now != null && LABEL_RE.test(ctx)) {
      const p = parseCount(now);
      if (p) return { ok: true, parsed: p, method: 'aria_progressbar', windowType, excludesReplies, account, sourceUrl };
    }
  }

  // Path B: the smallest element(s) carrying the label, then nearest ancestor holding a number.
  const labelled = Array.from(root.querySelectorAll('*')).filter(
    (el) => LABEL_RE.test(textOf(el)) && !Array.from(el.children).some((c) => LABEL_RE.test(textOf(c))),
  );
  if (labelled.length === 0) {
    if (/something went wrong|try again/i.test(pageText)) {
      return { ok: false, code: 'source_error', message: 'X shows an error on this page.', account, sourceUrl };
    }
    return { ok: false, code: 'label_not_found', message: 'Could not find the "Home Timeline impressions" label.', account, sourceUrl };
  }

  const all = new Set<string>();
  for (const label of labelled) {
    let el: Element | null = label;
    for (let depth = 0; el && el !== root.parentElement && depth <= 5; depth++, el = el.parentElement) {
      // Never climb into a container that also holds another requirement (e.g. the
      // verified-followers row), or a whole list: its numbers belong to other metrics.
      if (el !== label && (isListContainer(el) || OTHER_LABEL_RE.test(textOf(el)))) break;
      const c = candidatesIn(el, target);
      if (c.length) {
        c.forEach((x) => all.add(x));
        break;
      }
    }
  }
  const candidates = [...all];
  if (candidates.length === 0) {
    return { ok: false, code: 'value_not_found', message: 'Found the label but no current reading near it.', account, sourceUrl };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      message: `Several numbers sit near the label (${candidates.join(', ')}). Not guessing.`,
      candidates,
      account,
      sourceUrl,
    };
  }
  const parsed = parseCount(candidates[0])!;
  return { ok: true, parsed, method: 'label_proximity', windowType, excludesReplies, account, sourceUrl };
}
