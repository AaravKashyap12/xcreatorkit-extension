// Reads the already-loaded Analytics range. Never invokes X handlers, changes filters,
// navigates or requests additional data. React internals are still an unsupported
// source: this restriction reduces interference, not an assertion of X authorization.
// Serialized by chrome.scripting: keep self-contained.

export interface XAnalyticsOk {
  ok: true;
  account: string | null;
  verifiedOnly: boolean | null;
  range: { from: string; to: string };
  points: { t: number; m: Record<string, number> }[];
  /** Display strings from X's follower card, e.g. { verified: "749", total: "1K" }. */
  followers: { verified: string | null; total: string | null };
  capturedAt: string;
  appliedRange: boolean;
}
export interface XAnalyticsErr {
  ok: false;
  code: 'unsupported_page' | 'not_ready' | 'x_internals_changed' | 'timeout' | 'not_signed_in';
  message: string;
}
export type XAnalyticsResult = XAnalyticsOk | XAnalyticsErr;

export async function xAnalyticsInPage(): Promise<XAnalyticsResult> {
  type Props = Record<string, unknown>;
  type Fiber = { memoizedProps?: Props; return?: Fiber | null; child?: Fiber | null; sibling?: Fiber | null };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (/\/(login|i\/flow\/login|i\/jf\/onboarding)/.test(location.pathname)) {
    return { ok: false, code: 'not_signed_in', message: 'X is showing a sign-in page.' };
  }
  if (!/^\/i\/account_analytics\/?$/.test(location.pathname)) {
    return { ok: false, code: 'unsupported_page', message: 'Not the Analytics → Overview page.' };
  }
  const fiberOf = (el: Element): Fiber | null => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? ((el as unknown as Record<string, Fiber>)[k] ?? null) : null;
  };
  const main = () => document.querySelector('[data-testid="primaryColumn"]');

  // Prefer the range owner so audience state above the data component stays in scope.
  // Its handler is only an identity marker: never invoke it.
  const findHost = (): { props: Props; fiber: Fiber } | null => {
    const m = main();
    if (!m) return null;
    let fallback: { props: Props; fiber: Fiber } | null = null;
    for (const el of Array.from(m.querySelectorAll('button'))) {
      let f = fiberOf(el);
      for (let i = 0; f && i < 60; i++, f = f.return ?? null) {
        const p = f.memoizedProps;
        if (p && typeof p.onTimeRangeChange === 'function') return { props: p, fiber: f };
        if (p && isDataHost(p)) fallback ??= { props: p, fiber: f };
      }
    }
    return fallback;
  };
  // The daily data lives in a descendant component; search down (works even if charts did not lay out).
  const findDown = (root: Fiber, pred: (p: Props) => boolean): Props | null => {
    const stack: Fiber[] = [root];
    let n = 0;
    while (stack.length && n++ < 20000) {
      const f = stack.pop()!;
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && pred(p)) return p;
      if (f.sibling && f !== root) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  };
  const isDataHost = (p: Props) => !!p.currentMetricData && typeof p.currentMetricData === 'object' && 'timeRange' in p;

  let host: { props: Props; fiber: Fiber } | null = null;
  for (let i = 0; i < 20 && !host; i++) {
    host = findHost();
    if (!host) await sleep(250);
  }
  if (!host) {
    return main()
      ? { ok: false, code: 'x_internals_changed', message: 'X changed its analytics page; the loaded data was not found.' }
      : { ok: false, code: 'not_ready', message: 'The analytics page did not finish loading.' };
  }

  const data = findDown(host.fiber, isDataHost);
  if (!data) return { ok: false, code: 'not_ready', message: 'The selected Analytics data is unavailable.' };
  if (data.isPending) return { ok: false, code: 'not_ready', message: 'Wait for X Analytics to finish loading, then read this tab again.' };
  const selected = data.timeRange as { from?: unknown; to?: unknown };
  const date = (v: unknown): Date | null => {
    if (!(v instanceof Date) && typeof v !== 'number' && !(typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(v))) return null;
    const d = new Date(v as string | number);
    return Number.isFinite(d.getTime()) ? d : null;
  };
  const from = date(selected?.from), to = date(selected?.to);
  if (!from || !to || from > to) return { ok: false, code: 'not_ready', message: 'The selected Analytics range could not be read. Select a range on X and try again.' };
  const range = { from: from.toISOString(), to: to.toISOString() };
  const appliedRange = false;

  const raw = data.currentMetricData as Record<string, Record<string, unknown>>;
  const points: { t: number; m: Record<string, number> }[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const t = Number(k);
    if (!Number.isFinite(t) || !v || typeof v !== 'object') continue;
    const mm: Record<string, number> = {};
    for (const [mk, mv] of Object.entries(v)) if (typeof mv === 'number' && Number.isFinite(mv)) mm[mk] = mv;
    points.push({ t, m: mm });
  }
  if (!points.length) return { ok: false, code: 'x_internals_changed', message: 'Daily data had an unexpected shape.' };

  // Follower card: "Verified followers  749 / 1K". Values live in <number-flow-react>
  // elements whose accessible label is kept in ElementInternals.
  const followers: { verified: string | null; total: string | null } = { verified: null, total: null };
  const m = main();
  const label = m && Array.from(m.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent?.trim() === 'Verified followers');
  if (label) {
    let box: Element | null = label;
    for (let i = 0; box && i < 6; i++, box = box.parentElement) {
      const nfs = Array.from(box.querySelectorAll('number-flow-react'));
      if (nfs.length >= 2) {
        const read = (n: Element) => {
          const internals = (n as unknown as { _internals?: { ariaLabel?: string | null } })._internals;
          return internals?.ariaLabel ?? null;
        };
        followers.verified = read(nfs[0]!);
        followers.total = read(nfs[1]!);
        break;
      }
    }
  }

  let verifiedOnly: boolean | null = null;
  const vHost = findDown(host.fiber, (p) => typeof p.verifiedOnly === 'boolean');
  if (vHost) verifiedOnly = vHost.verifiedOnly as boolean;
  const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') ?? '';
  const account = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(href)?.[1]?.toLowerCase() ?? null;
  return { ok: true, account, verifiedOnly, range, points, followers, capturedAt: new Date().toISOString(), appliedRange };
}
