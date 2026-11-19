// What the Analytics page and its share images say about a range: one model for both, so a picture never
// says more than the page. Pure (no DOM): figures, changes, coverage wording and the chart data for each section.
// Every date is a UTC calendar day. Percentages always have a stated denominator taken over the same days.
import {
  METRIC_NAMES,
  addUtcDays,
  changeOver,
  dayValue,
  figureOver,
  ratioOver,
  rollingAvg,
  shortDate,
  type CalendarRange,
  type CellBucket,
  type Change,
  type DailyRow,
  type DayCell,
  type Granularity,
  type SeriesKind,
} from './series';
import type { Category, Series } from '../chart/xy';
import { formatReportingDate } from '../calc/time';

// One muted blue for the measured series, slate for references and the second part of a pair. Bars are pale bodies
// outlined in their series colour; daily lines carry pale shading (src/chart/xy.ts `fill` and `area`).
export const C = { main: 'var(--xck-an-line)', fill: 'var(--xck-an-fill)', ref: 'var(--xck-series-2)', refFill: 'var(--xck-an-fill-2)', text: 'var(--xck-text)', soft: 'color-mix(in srgb, var(--xck-an-line) 45%, var(--xck-surface))' };

export type Metric = 'Impressions' | 'EngagementRate' | 'ProfileVisits' | 'NetFollows';
export type Tone = 'up' | 'down' | 'flat';

// ---------- Formatting ----------
export const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
export const num = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
export const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const year = (ymd: string) => ymd.slice(0, 4);
export const span = (a: string, b: string) => (year(a) === year(b) ? `${shortDate(a)} – ${shortDate(b)} ${year(b)}` : `${shortDate(a)} ${year(a)} – ${shortDate(b)} ${year(b)}`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
export const audienceName = (k: SeriesKind) => (k === 'verified' ? 'Verified only' : 'All viewers');
export const perName = (g: Granularity) => (g === 'daily' ? 'day' : g === 'weekly' ? 'week' : 'month');

export const METRICS: { key: Metric; label: string; chart: string; format: (v: number) => string; caption: string }[] = [
  { key: 'Impressions', label: 'Impressions', chart: 'Impressions', format: num,
    caption: 'Account impressions are views from every surface on X, replies included, so one person can count more than once. This is not the Verified Home Timeline Rewards metric; Rewards pace tracks that.' },
  { key: 'EngagementRate', label: 'Engagement rate', chart: 'Engagement rate', format: pct,
    caption: 'Engagements divided by impressions, over the days that reported both. X counts clicks and expands as engagements as well as replies, likes and reposts.' },
  { key: 'ProfileVisits', label: 'Profile visits', chart: 'Profile visits', format: num,
    caption: 'Visits to your profile that X reported for each day.' },
  { key: 'NetFollows', label: 'Net follows', chart: 'Follows and unfollows', format: (v) => signed(v),
    caption: 'Follow and unfollow events X reported for each day, unfollows drawn below zero. These are events, not a follower-count snapshot.' },
];

// ---------- Ranges ----------

/**
 * A chosen span of UTC days, start to end inclusive, shaped like `calendarRange` so every figure works the same.
 * The previous period is the same number of days just before `start`. Days after `today` are not part of the range.
 */
export function customRange(all: DailyRow[], start: string, end: string, today: string): CalendarRange {
  const last = end > today ? today : end;
  const byDate = new Map(all.map((r) => [r.date, r]));
  const between = (a: string, b: string) => { const out: DayCell[] = []; for (let d = a; d <= b; d = addUtcDays(d, 1)) out.push({ date: d, row: byDate.get(d) ?? null }); return out; };
  const cells = start <= last ? between(start, last) : [];
  const n = cells.length;
  const prev = n ? between(addUtcDays(start, -n), addUtcDays(start, -1)) : null;
  return {
    start: cells[0]?.date ?? null, end: cells.at(-1)?.date ?? null, cells,
    rows: cells.flatMap((c) => (c.row ? [c.row] : [])),
    missing: cells.filter((c) => !c.row).map((c) => c.date),
    includesToday: cells.at(-1)?.date === today,
    excludedToday: null,
    incomplete: cells.filter((c) => c.row?.partial && c.date !== today).map((c) => c.date),
    prev,
  };
}

/** Grouping a range of `days` can use: weeks from 28 days, months from 90 (shorter ranges would be all edges). */
export const groupsFor = (days: number): Granularity[] => ['daily', ...(days >= 28 ? ['weekly' as const] : []), ...(days >= 90 ? ['monthly' as const] : [])];

// ---------- Categories (one per calendar bucket; missing stays missing) ----------

/**
 * Chart categories for calendar buckets: every period keeps its place. A day counts towards a chart only when it
 * reported every field that chart uses, so a week with one unreported day is partial and says so.
 */
export function categories(buckets: CellBucket[], g: Granularity, today: string, fields: string[], independent = false): Category[] {
  const reports = (c: DayCell) => fields.every((k) => dayValue(c.row, k) != null);
  return buckets.map((b) => {
    const captured = b.cells.filter((c) => c.row).length;
    const reported = b.cells.filter(reports).length;
    // Independent series (for example posts/replies) retain their own observations even when
    // another field is absent. Ratios and net follows still require compatible fields per day.
    const available = independent ? b.cells.filter((c) => fields.some((k) => dayValue(c.row, k) != null)).length : reported;
    const first = b.cells[0]!.date;
    const last = b.cells.at(-1)!.date;
    const inProgress = b.cells.some((c) => c.row?.partial);
    const title = g === 'daily' ? formatReportingDate(first) : g === 'weekly' ? `Week of ${shortDate(b.key)} ${year(b.key)}` : `${b.label.replace(/ '(\d\d)$/, ' 20$1')}`;
    let note: string | undefined;
    if (g === 'daily') note = inProgress ? (first === today ? 'in progress' : 'read while in progress') : undefined;
    else if (reported < b.expected || inProgress) note = `${reported} of ${b.expected} days ${reported < captured ? 'reported this' : 'captured'}${b.cells.length < b.expected ? `, ${span(first, last)} in range` : ''}${inProgress ? ', one in progress' : ''}`;
    if (independent && available > reported) {
      const coverage = g === 'daily' ? 'some fields not reported' : fields.map((k) => `${METRIC_NAMES[k] ?? k}: ${b.cells.filter((c) => dayValue(c.row, k) != null).length} of ${b.expected} days`).join('; ');
      note = g === 'daily' ? [note, coverage].filter(Boolean).join(', ') : `${coverage}${inProgress ? ', one in progress' : ''}`;
    }
    const missingText = captured && !available ? 'not reported in this capture' : undefined;
    return { label: b.label, title, partial: available > 0 && (reported < b.expected || inProgress), missing: available === 0, ...(note ? { note } : {}), ...(missingText ? { missingText } : {}) };
  });
}

/** Days that reported both engagement fields: the same days the engagement rate uses. */
export const rateCells = (cells: DayCell[]) => cells.filter((c) => c.row && typeof c.row.metrics.Engagements === 'number' && typeof c.row.metrics.Impressions === 'number');
/** Days in a bucket that reported both follow fields, so follows, unfollows and net agree. */
export const followCells = (cells: DayCell[]) => cells.filter((c) => dayValue(c.row, 'NetFollows') != null);

// ---------- Context shared by every section ----------

export interface View {
  handle: string;
  kind: SeriesKind;
  range: CalendarRange;
  buckets: CellBucket[];
  gran: Granularity;
  today: string;
  /** The person chose to compare with the previous period of equal length. */
  compare: boolean;
}

/** Compare settled observations only; partial prior data must not look like a complete reference line. */
export const overlayPrev = (v: View, m: Metric = 'Impressions') => m !== 'NetFollows' && v.compare && v.gran === 'daily' && !!v.range.prev?.length && v.range.prev.length === v.range.cells.length && v.range.prev.every(c => c.row && !c.row.partial && dayValue(c.row, m) != null);
export const prevName = (v: View) => `Previous ${plural(v.range.cells.length, 'day')}`;

/** Main-chart series for one of the four figures. The previous period replaces the 7-day average when compared. */
export function seriesFor(m: Metric, v: View): Series[] {
  const { buckets, gran } = v;
  if (m === 'NetFollows') return [
    { name: 'Follows', color: C.main, fill: C.fill, type: 'bar', stack: 'f', values: buckets.map((b) => figureOver(followCells(b.cells), 'Follows').value) },
    { name: 'Unfollows', color: C.ref, fill: C.refFill, type: 'bar', stack: 'f', values: buckets.map((b) => { const x = figureOver(followCells(b.cells), 'Unfollows').value; return x == null ? null : -x; }), format: (x) => num(-x) },
    { name: 'Net follows', color: C.text, type: 'line', values: buckets.map((b) => figureOver(b.cells, 'NetFollows').value), format: signed },
  ];
  const prev = overlayPrev(v, m) ? [{ name: prevName(v), color: C.ref, type: 'line' as const, markers: false, values: v.range.prev!.map((c) => dayValue(c.row, m)), ...(m === 'EngagementRate' ? { format: pct } : {}) }] : [];
  if (m === 'EngagementRate') return [{ name: 'Engagement rate', color: C.main, type: 'line', area: true, values: buckets.map((b) => figureOver(b.cells, m).value), format: pct }, ...prev];
  const values = buckets.map((b) => figureOver(b.cells, m).value);
  // Days read as a shaded line; weeks and months stay bars, each a total of its own period.
  const own: Series = gran === 'daily' ? { name: METRIC_NAMES[m]!, color: C.main, type: 'line', area: true, values } : { name: METRIC_NAMES[m]!, color: C.main, fill: C.fill, type: 'bar', values };
  const out: Series[] = [own, ...prev];
  if (!prev.length && m === 'Impressions' && gran === 'daily' && buckets.length >= 7) out.push({ name: '7-day average', color: C.ref, type: 'line', dashed: true, values: rollingAvg(values, 7).map((x) => (x == null ? null : Math.round(x))) });
  return out;
}

// ---------- Changes ----------

export interface ChangeLine { text: string; tone: Tone }

/** Words for a change; null when there is nothing honest to say. */
export function changeText(ch: Change): ChangeLine | null {
  if (ch.kind === 'none') return null;
  const vs = `vs ${span(ch.prevStart, ch.prevEnd)}`;
  if (ch.kind === 'prior-zero') return { text: `Prior period was 0 · ${span(ch.prevStart, ch.prevEnd)}`, tone: 'flat' };
  const tone: Tone = ch.value > 0 ? 'up' : ch.value < 0 ? 'down' : 'flat';
  if (ch.kind === 'points') return { text: `${ch.value >= 0 ? '+' : '−'}${Math.abs(ch.value).toFixed(2)} pts ${vs}`, tone };
  if (ch.kind === 'difference') return { text: `${signed(ch.value)} ${vs}`, tone };
  return { text: `${ch.value > 0 ? '+' : ch.value < 0 ? '−' : '±'}${Math.abs(ch.value * 100).toFixed(1)}% ${vs}`, tone };
}

/** Both periods are complete UTC days that reported every field in `fields`. */
const comparable = (cur: DayCell[], prev: DayCell[] | null, fields: string[]): prev is DayCell[] =>
  !!prev && !!cur.length && prev.length === cur.length && [cur, prev].every((cells) => cells.every((c) => c.row && !c.row.partial && fields.every((k) => typeof c.row!.metrics[k] === 'number')));

/** Relative change of a total that is not one of X's own fields (for example a sum of interaction types). */
export function totalChange(cur: DayCell[], prev: DayCell[] | null, fields: string[], total: (cells: DayCell[]) => number): Change {
  if (!comparable(cur, prev, fields)) return { kind: 'none' };
  const a = total(cur);
  const b = total(prev);
  const s = { prevStart: prev[0]!.date, prevEnd: prev.at(-1)!.date };
  if (b === 0) return a === 0 ? { kind: 'relative', value: 0, ...s } : { kind: 'prior-zero', ...s };
  return { kind: 'relative', value: (a - b) / b, ...s };
}

// ---------- Figures for the four headline questions ----------

export interface Summary {
  key: Metric;
  label: string;
  /** Allowed to drive the chart and to be shared. */
  ok: boolean;
  value: string;
  tone: Tone | null;
  change: ChangeLine | null;
  /** Lines under the figure: coverage first, then the change, then what it is made of. */
  subs: string[];
  /** What the figure is made of, without the change (share images put the change beside the figure). */
  parts: string[];
  days: number;
}

export function summaries(v: View): Record<Metric, Summary> {
  const { range } = v;
  const cells = range.cells;
  const rows = range.rows;
  const covers = Object.fromEntries(METRICS.map((d) => [d.key, figureOver(cells, d.key)])) as Record<Metric, ReturnType<typeof figureOver>>;
  // Net follows only when both fields were reported on every captured day; otherwise a sum would look complete.
  const followGap = rows.length - covers.NetFollows.days;
  const usable = (m: Metric) => covers[m].days > 0 && (m !== 'NetFollows' || followGap === 0);
  const out = {} as Record<Metric, Summary>;
  for (const d of METRICS) {
    const cov = covers[d.key];
    const ok = usable(d.key);
    const subs: string[] = [];
    const parts: string[] = [];
    let change: ChangeLine | null = null;
    if (!ok) subs.push(cov.days === 0 ? (rows.length ? 'Not in this capture' : 'No days captured') : `Follows or unfollows missing on ${plural(followGap, 'captured day')}`);
    else {
      change = v.compare ? changeText(changeOver(cells, range.prev, d.key)) : null;
      if (cov.days < cov.of) parts.push(`${d.key === 'EngagementRate' ? 'Over' : 'Captured subtotal ·'} ${cov.days} of ${plural(cov.of, 'day')}`);
      if (d.key === 'Impressions') parts.push(`≈ ${num(cov.value! / cov.days)} per captured day`);
      if (d.key === 'ProfileVisits') parts.push(`≈ ${num(cov.value! / cov.days)} per captured day`);
      if (d.key === 'EngagementRate') {
        const rc = rateCells(cells);
        parts.push(`${num(figureOver(rc, 'Engagements').value)} engagements ÷ ${num(figureOver(rc, 'Impressions').value)} impressions`);
      }
      if (d.key === 'NetFollows') parts.push(`${num(figureOver(followCells(cells), 'Follows').value)} follows · ${num(figureOver(followCells(cells), 'Unfollows').value)} unfollows`);
      subs.push(...parts.slice(0, cov.days < cov.of ? 1 : 0), ...(change ? [change.text] : []), ...parts.slice(cov.days < cov.of ? 1 : 0));
    }
    const value = ok && cov.value != null ? d.format(cov.value) : '—';
    const tone: Tone | null = d.key === 'NetFollows' && ok && cov.value != null ? (cov.value > 0 ? 'up' : cov.value < 0 ? 'down' : 'flat') : null;
    out[d.key] = { key: d.key, label: d.label, ok, value, tone, change, subs, parts, days: cov.days };
  }
  return out;
}

// ---------- Breakdowns ----------

export const INTERACTION_TYPES = [['Likes', 'Likes'], ['Replies', 'Replies received'], ['Retweets', 'Reposts'], ['Bookmark', 'Bookmarks'], ['Share', 'Shares'], ['QuoteTweets', 'Quotes']] as const;

export interface InteractionRow { key: string; label: string; total: number | null; days: number; commonTotal: number | null; share: number | null }
export interface Interactions {
  rows: InteractionRow[];
  /** Sum of every listed type, over the days that reported all of them; the denominator of each share. */
  total: number | null;
  /** Days that reported every listed type. */
  commonDays: number;
}

/**
 * Totals for each interaction type X reported in the range, and each type's share of all listed interactions.
 * Shares use only days that reported every listed type, so they add up to 100% and compare like with like.
 */
export function interactions(cells: DayCell[]): Interactions {
  const present = INTERACTION_TYPES.map(([key, label]) => ({ key, label, cov: figureOver(cells, key) })).filter((t) => t.cov.days > 0);
  const keys = present.map((t) => t.key as string);
  const common = cells.filter((c) => c.row && keys.every((k) => typeof c.row!.metrics[k] === 'number'));
  const sumOf = (k: string) => common.reduce((s, c) => s + c.row!.metrics[k]!, 0);
  const total = common.length ? keys.reduce((s, k) => s + sumOf(k), 0) : null;
  return {
    rows: present.map((t) => ({ key: t.key, label: t.label, total: t.cov.value, days: t.cov.days, commonTotal: common.length ? sumOf(t.key) : null, share: total ? sumOf(t.key) / total : null })),
    total,
    commonDays: common.length,
  };
}

export const interactionsTotal = (keys: string[]) => (cells: DayCell[]) => cells.reduce((s, c) => s + keys.reduce((t, k) => t + (c.row?.metrics[k] ?? 0), 0), 0);

/** Profile visits per 1,000 impressions and its change in visits per 1K (a difference, never a percent of a ratio). */
export function visitRate(v: View): { value: number | null; days: number; change: ChangeLine | null } {
  const cur = ratioOver(v.range.cells, 'ProfileVisits', 'Impressions', 1000);
  let change: ChangeLine | null = null;
  if (v.compare && cur.value != null && comparable(v.range.cells, v.range.prev, ['ProfileVisits', 'Impressions'])) {
    const before = ratioOver(v.range.prev!, 'ProfileVisits', 'Impressions', 1000).value;
    if (before != null) {
      const d = cur.value - before;
      change = { text: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} per 1K vs ${span(v.range.prev![0]!.date, v.range.prev!.at(-1)!.date)}`, tone: d > 0 ? 'up' : d < 0 ? 'down' : 'flat' };
    }
  }
  return { value: cur.value, days: cur.days, change };
}

// ---------- Coverage wording ----------

/** One short line about what the range holds: captured days, gaps, and days read while still in progress. */
export function coverageLine(v: View, fieldDays?: { days: number; what: string }): { text: string; partial: boolean } {
  const { range } = v;
  const parts = [`${range.rows.length} of ${plural(range.cells.length, 'day')} captured`];
  const fieldGap = !!fieldDays && fieldDays.days < range.rows.length;
  if (fieldGap) parts.push(`${fieldDays!.what} reported on ${fieldDays!.days} of them`);
  if (range.incomplete.length) parts.push(`${range.incomplete.slice(0, 3).map(shortDate).join(', ')}${range.incomplete.length > 3 ? ` and ${range.incomplete.length - 3} more days` : ''} read while in progress`);
  if (range.includesToday) parts.push(`today (${shortDate(range.end!)}) in progress`);
  return { text: parts.join(' · '), partial: fieldGap || range.rows.length < range.cells.length || !!range.incomplete.length || range.includesToday };
}

// ---------- Share images ----------

export interface ShareChart { categories: Category[]; series: Series[]; percent?: boolean; decimals?: boolean }
export interface ShareBar { label: string; value: string; share: string | null; frac: number }

/** Everything one share image shows. Built from the same figures as the page; nothing here is typed in. */
export interface ShareCard {
  /** Section key: file names and test hooks. */
  id: string;
  title: string;
  /** "Per day · All viewers" */
  kicker: string;
  /** "4 Sep – 1 Oct 2026 · UTC" */
  range: string;
  handle: string | null;
  headline: { value: string; label: string; tone: Tone | null } | null;
  change: ChangeLine | null;
  figures: string[];
  chart: ShareChart | null;
  bars: ShareBar[] | null;
  /** Coverage, partial and in-progress wording. */
  coverage: string;
  /** Some day is missing, unreported for this figure, or still in progress. */
  partial: boolean;
  /** How the figure is defined, in one sentence. */
  definition: string;
}

const cover = (c: { text: string; partial: boolean }) => ({ coverage: c.text, partial: c.partial });
const rangeText = (v: View) => (v.range.start && v.range.end ? `${span(v.range.start, v.range.end)} · UTC` : 'No days · UTC');
const kicker = (v: View, perPeriod = true) => [perPeriod ? `Per ${perName(v.gran)}` : null, audienceName(v.kind)].filter(Boolean).join(' · ');

const DEFINITIONS: Record<Metric, string> = {
  Impressions: 'Account impressions from X Analytics: views on every surface, replies included. Not the Rewards metric.',
  EngagementRate: 'Engagements ÷ impressions, totalled over the days that reported both.',
  ProfileVisits: 'Profile visits X Analytics reported for each UTC day.',
  NetFollows: 'Follows minus unfollows X Analytics reported. Events, not a follower count.',
};

export function metricCard(v: View, m: Metric, s: Summary, showHandle: boolean): ShareCard {
  const d = METRICS.find((x) => x.key === m)!;
  const fields = m === 'EngagementRate' ? ['Engagements', 'Impressions'] : m === 'NetFollows' ? ['Follows', 'Unfollows'] : [m];
  const coverage = coverageLine(v, { days: s.days, what: m === 'EngagementRate' ? 'Engagements and impressions' : m === 'NetFollows' ? 'Follows and unfollows' : METRIC_NAMES[m]! });
  if (overlayPrev(v, m)) {
    const prev = v.range.prev!;
    coverage.text += ` · Previous period: ${span(prev[0]!.date, prev.at(-1)!.date)} · ${prev.length} of ${prev.length} days complete`;
  }
  return {
    id: m === 'NetFollows' ? 'net-follows' : m === 'EngagementRate' ? 'engagement-rate' : m === 'ProfileVisits' ? 'profile-visits' : 'impressions',
    title: d.label,
    kicker: kicker(v),
    range: rangeText(v),
    handle: showHandle && v.handle ? v.handle : null,
    headline: { value: s.value, label: m === 'EngagementRate' ? 'engagement rate' : m === 'NetFollows' ? 'net follows' : m === 'ProfileVisits' ? 'profile visits' : 'impressions', tone: s.tone },
    change: s.change,
    figures: s.parts.filter((p) => !/^(Captured subtotal|Over) /.test(p)),
    chart: { categories: categories(v.buckets, v.gran, v.today, fields), series: seriesFor(m, v), percent: m === 'EngagementRate' },
    bars: null,
    ...cover(coverage),
    definition: DEFINITIONS[m],
  };
}

export function interactionsCard(v: View, showHandle: boolean): ShareCard {
  const it = interactions(v.range.cells);
  const keys = it.rows.map((r) => r.key);
  const max = Math.max(1, ...it.rows.map((r) => r.commonTotal ?? 0));
  const change = v.compare && keys.length ? changeText(totalChange(v.range.cells, v.range.prev, keys, interactionsTotal(keys))) : null;
  return {
    id: 'interactions', title: 'Interactions', kicker: audienceName(v.kind), range: rangeText(v), handle: showHandle && v.handle ? v.handle : null,
    headline: { value: num(it.total), label: 'likes, replies, reposts and more', tone: null },
    change,
    figures: [],
    chart: null,
    bars: it.rows.map((r) => ({ label: r.label, value: num(r.commonTotal), share: r.share == null ? null : `${(r.share * 100).toFixed(1)}%`, frac: (r.commonTotal ?? 0) / max })),
    ...cover(coverageLine(v, { days: it.commonDays, what: 'Every type' })),
    definition: 'Share = each type ÷ all listed interactions, over the days that reported every type. Clicks and expands are not listed.',
  };
}

export function followersCard(v: View, s: Summary, showHandle: boolean): ShareCard {
  const c = metricCard(v, 'NetFollows', s, showHandle);
  return { ...c, id: 'followers', title: 'Followers', headline: { ...c.headline!, label: 'net follows' } };
}

export function publishingCard(v: View, showHandle: boolean): ShareCard {
  const posts = figureOver(v.range.cells, 'CreateTweet');
  const replies = figureOver(v.range.cells, 'CreateReply');
  const change = v.compare ? changeText(changeOver(v.range.cells, v.range.prev, 'CreateTweet')) : null;
  return {
    id: 'publishing', title: 'Publishing', kicker: kicker(v), range: rangeText(v), handle: showHandle && v.handle ? v.handle : null,
    headline: { value: num(posts.value), label: 'posts published', tone: null },
    change,
    figures: [`${num(replies.value)} replies published`],
    chart: { categories: categories(v.buckets, v.gran, v.today, ['CreateTweet', 'CreateReply'], true), series: publishingSeries(v) },
    bars: null,
    ...cover(coverageLine(v, { days: v.range.cells.filter(c => dayValue(c.row, 'CreateTweet') != null && dayValue(c.row, 'CreateReply') != null).length, what: 'Posts and replies' })),
    definition: 'Posts and replies you published, as X Analytics counted them for each UTC day.',
  };
}

export function publishingSeries(v: View): Series[] {
  return [
    { name: 'Posts published', color: C.main, fill: C.fill, type: 'bar', stack: 'p', values: v.buckets.map((b) => figureOver(b.cells, 'CreateTweet').value) },
    { name: 'Replies published', color: C.ref, fill: C.refFill, type: 'bar', stack: 'p', values: v.buckets.map((b) => figureOver(b.cells, 'CreateReply').value) },
  ];
}

export function visitRateSeries(v: View): Series[] {
  return [{ name: 'Visits per 1K impressions', color: C.main, type: 'line', area: true, values: v.buckets.map((b) => ratioOver(b.cells, 'ProfileVisits', 'Impressions', 1000).value), format: (x) => x.toFixed(2) }];
}

export function visitsCard(v: View, showHandle: boolean): ShareCard {
  const r = visitRate(v);
  const rc = v.range.cells.filter((c) => c.row && typeof c.row.metrics.ProfileVisits === 'number' && typeof c.row.metrics.Impressions === 'number');
  return {
    id: 'visits-per-1k', title: 'Profile visits per 1K impressions', kicker: kicker(v), range: rangeText(v), handle: showHandle && v.handle ? v.handle : null,
    headline: { value: r.value == null ? '—' : r.value.toFixed(2), label: 'profile visits per 1,000 impressions', tone: null },
    change: r.change,
    figures: [`${num(figureOver(rc, 'ProfileVisits').value)} visits ÷ ${num(figureOver(rc, 'Impressions').value)} impressions`],
    chart: { categories: categories(v.buckets, v.gran, v.today, ['ProfileVisits', 'Impressions']), series: visitRateSeries(v), decimals: true },
    bars: null,
    ...cover(coverageLine(v, { days: r.days, what: 'Visits and impressions' })),
    definition: 'Visits ÷ impressions × 1,000 on the same days. It does not show which impressions led to a visit.',
  };
}

/** A file name that says what is in the picture: account (unless hidden), section, UTC range and audience. */
export function shareFileName(card: ShareCard, v: View): string {
  const who = card.handle ? card.handle.replace(/[^\w-]/g, '') : 'analytics';
  return `${who}-${card.id}-${v.range.start ?? 'none'}_${v.range.end ?? 'none'}-${v.kind}-utc.png`;
}
