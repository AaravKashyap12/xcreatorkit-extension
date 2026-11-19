// Daily account-analytics series captured from X's web analytics page.
// X buckets days in UTC; every date here is a UTC calendar day (YYYY-MM-DD).
// These are ACCOUNT metrics (all impressions etc.), never the rewards metric.

export interface DailyRow {
  date: string; // UTC YYYY-MM-DD
  metrics: Record<string, number>;
  capturedAt: string; // ISO time of the capture that produced this row
  partial: boolean; // the UTC day was still in progress at capture time
}

export interface DailySeries {
  rows: Record<string, DailyRow>;
  lastCaptureAt: string | null;
  lastRange: { from: string; to: string } | null;
  source: 'x_web_account_analytics';
}

export type SeriesKind = 'all' | 'verified';

export function emptySeries(): DailySeries {
  return { rows: {}, lastCaptureAt: null, lastRange: null, source: 'x_web_account_analytics' };
}

export const utcDate = (t: number | Date) => new Date(t).toISOString().slice(0, 10);

/** Build rows from X's per-day objects. Today's (or a future) UTC day is marked partial. */
export function rowsFromCapture(points: { t: number; m: Record<string, number> }[], capturedAt: Date): DailyRow[] {
  const today = utcDate(capturedAt);
  return points
    .filter((p) => Number.isFinite(p.t))
    .map((p) => {
      const date = utcDate(p.t);
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(p.m)) if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = v;
      return { date, metrics, capturedAt: capturedAt.toISOString(), partial: date >= today };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface MergeReport {
  added: number;
  updated: number;
  unchanged: number;
}

/** Newer captures win: X revises recent days, and a partial day becomes complete later. */
export function mergeRows(series: DailySeries, rows: DailyRow[], range: { from: string; to: string }, capturedAt: Date): MergeReport {
  const rep: MergeReport = { added: 0, updated: 0, unchanged: 0 };
  for (const r of rows) {
    const prev = series.rows[r.date];
    if (!prev) {
      series.rows[r.date] = r;
      rep.added++;
    } else if (r.capturedAt >= prev.capturedAt) {
      const same = prev.partial === r.partial && JSON.stringify(prev.metrics) === JSON.stringify(r.metrics);
      series.rows[r.date] = r;
      same ? rep.unchanged++ : rep.updated++;
    } else rep.unchanged++;
  }
  series.lastCaptureAt = capturedAt.toISOString();
  series.lastRange = range;
  return rep;
}

export function sortedRows(series: DailySeries | undefined): DailyRow[] {
  return series ? Object.values(series.rows).sort((a, b) => a.date.localeCompare(b.date)) : [];
}

/** Drop leading days before the account's first recorded activity (X pads with zeros). */
export function trimLeadingZeros(rows: DailyRow[]): DailyRow[] {
  const i = rows.findIndex((r) => Object.values(r.metrics).some((v) => v !== 0));
  return i < 0 ? [] : rows.slice(i);
}

/** Calendar gaps between consecutive rows (days with no row at all). */
export function missingDates(rows: DailyRow[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    let t = Date.parse(rows[i - 1]!.date + 'T00:00:00Z') + 86_400_000;
    const end = Date.parse(rows[i]!.date + 'T00:00:00Z');
    while (t < end) {
      out.push(utcDate(t));
      t += 86_400_000;
    }
  }
  return out;
}

export const m = (r: DailyRow, k: string) => r.metrics[k] ?? 0;

// ---------- Derived metrics ----------

/** Metrics that are ratios/averages and must be recomputed, never summed. */
const NON_ADDITIVE = new Set(['EngagementRate', 'VideoCompletionRate', 'AverageWatchTime']);

export function isAdditive(metric: string): boolean {
  return !NON_ADDITIVE.has(metric);
}

export function sumMetric(rows: DailyRow[], metric: string): number {
  return rows.reduce((s, r) => s + m(r, metric), 0);
}

/** Engagement rate over a set of days = total engagements / total impressions. */
export function engagementRate(rows: DailyRow[]): number | null {
  const imp = valueOver(rows, 'Impressions');
  const eng = valueOver(rows, 'Engagements');
  return imp != null && imp > 0 && eng != null ? eng / imp : null;
}

export function valueOver(rows: DailyRow[], metric: string): number | null {
  if (metric === 'EngagementRate') return engagementRate(rows);
  if (!isAdditive(metric) || !rows.length || rows.some(r => r.metrics[metric] == null)) return null;
  return sumMetric(rows, metric);
}

// ---------- Windows ----------

export interface WindowSel {
  days: number | 'all';
  includePartial: boolean;
}

export interface WindowResult {
  rows: DailyRow[];
  prev: DailyRow[] | null; // the equal-length window before, only if fully covered
  start: string | null;
  end: string | null;
  excludedPartial: DailyRow | null;
}

export function selectWindow(all: DailyRow[], sel: WindowSel): WindowResult {
  let rows = all;
  let excludedPartial: DailyRow | null = null;
  if (!sel.includePartial && rows.length && rows[rows.length - 1]!.partial) {
    excludedPartial = rows[rows.length - 1]!;
    rows = rows.slice(0, -1);
  }
  if (sel.days === 'all') {
    const t = trimLeadingZeros(rows);
    return { rows: t, prev: null, start: t[0]?.date ?? null, end: t.at(-1)?.date ?? null, excludedPartial };
  }
  const cur = rows.slice(-sel.days);
  const before = rows.slice(0, rows.length - cur.length);
  const prevCand = before.slice(-sel.days);
  // Only compare against a previous window that has every day present.
  const prev =
    prevCand.length === sel.days && cur.length === sel.days && missingDates([...prevCand, ...cur]).length === 0 ? prevCand : null;
  return { rows: cur, prev, start: cur[0]?.date ?? null, end: cur.at(-1)?.date ?? null, excludedPartial };
}

export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / prev;
}

// ---------- Aggregation ----------

export type Granularity = 'daily' | 'weekly' | 'monthly';

export interface Bucket {
  key: string; // first date in bucket
  label: string;
  rows: DailyRow[];
  partial: boolean; // contains a partial day, or does not cover its full period
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(ymd: string): string {
  const [, mo, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS[mo! - 1]}`;
}

/** Weeks start on Monday (UTC). Weekly/monthly buckets that are cut off by the window are flagged partial. */
export function bucketize(rows: DailyRow[], g: Granularity): Bucket[] {
  if (g === 'daily') return rows.map((r) => ({ key: r.date, label: shortDate(r.date), rows: [r], partial: r.partial }));
  const map = new Map<string, DailyRow[]>();
  for (const r of rows) {
    const d = new Date(r.date + 'T00:00:00Z');
    let key: string;
    if (g === 'weekly') {
      const dow = (d.getUTCDay() + 6) % 7;
      key = utcDate(d.getTime() - dow * 86_400_000);
    } else key = r.date.slice(0, 7) + '-01';
    (map.get(key) ?? map.set(key, []).get(key)!).push(r);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rs]) => {
      const expected = g === 'weekly' ? 7 : daysInMonth(key);
      const label = g === 'weekly' ? `wk ${shortDate(key)}` : `${MONTHS[Number(key.slice(5, 7)) - 1]} '${key.slice(2, 4)}`;
      return { key, label, rows: rs, partial: rs.some((r) => r.partial) || rs.length < expected };
    });
}

function daysInMonth(firstOfMonth: string): number {
  const [y, mo] = firstOfMonth.split('-').map(Number);
  return new Date(Date.UTC(y!, mo!, 0)).getUTCDate();
}

/** Trailing average over the previous n rows (null until n rows exist). */
export function rollingAvg(values: (number | null)[], n: number): (number | null)[] {
  return values.map((_, i) => {
    const window = values.slice(i + 1 - n, i + 1);
    return i + 1 < n || window.some(v => v == null) ? null : window.reduce<number>((s, v) => s + v!, 0) / n;
  });
}

/** Average of a metric per weekday (Mon..Sun), over complete days only. */
export function weekdayAverages(rows: DailyRow[], metric: string): { label: string; avg: number | null; n: number }[] {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const acc = names.map(() => ({ s: 0, n: 0 }));
  for (const r of rows) {
    if (r.partial || r.metrics[metric] == null) continue;
    const dow = (new Date(r.date + 'T00:00:00Z').getUTCDay() + 6) % 7;
    acc[dow]!.s += m(r, metric);
    acc[dow]!.n++;
  }
  return names.map((label, i) => ({ label, avg: acc[i]!.n ? acc[i]!.s / acc[i]!.n : null, n: acc[i]!.n }));
}

export function topDays(rows: DailyRow[], metric: string, n = 10): DailyRow[] {
  return [...rows].filter((r) => !r.partial && r.metrics[metric] != null).sort((a, b) => m(b, metric) - m(a, metric)).slice(0, n);
}

/** Labels for X's metric keys, for the ones we show. */
export const METRIC_NAMES: Record<string, string> = {
  Impressions: 'Impressions',
  Engagements: 'Engagements',
  EngagementRate: 'Engagement rate',
  ProfileVisits: 'Profile visits',
  Likes: 'Likes',
  Replies: 'Replies received',
  Retweets: 'Reposts',
  QuoteTweets: 'Quotes',
  Bookmark: 'Bookmarks',
  Share: 'Shares',
  Follows: 'Follows',
  Unfollows: 'Unfollows',
  CreateTweet: 'Posts published',
  CreateReply: 'Replies published',
  CreateQuote: 'Quotes published',
  LinkClicks: 'Link clicks',
  UrlClicks: 'URL clicks',
  DetailExpands: 'Detail expands',
  MediaViews: 'Media views',
  MediaEngagements: 'Media engagements',
  UserProfileClicks: 'Profile clicks',
  VideoViews: 'Video views',
};

// ---------- Calendar ranges (every UTC day has a position; missing stays missing) ----------

/** One UTC calendar day in a range: the captured row, or null when the day was not captured. */
export interface DayCell {
  date: string;
  row: DailyRow | null;
}

export interface CalendarRange {
  start: string | null;
  end: string | null;
  cells: DayCell[];
  rows: DailyRow[];
  missing: string[];
  /** The range ends on today's UTC day, which is still in progress. */
  includesToday: boolean;
  /** Today's captured row when it was left out of the range. */
  excludedToday: DailyRow | null;
  /**
   * Earlier days in the range whose only capture was taken while the day was still in progress. They stay
   * partial (a later calendar date does not complete them) until a newer capture replaces them.
   */
  incomplete: string[];
  /** The equal-length calendar range just before (any coverage); null for "all captured days". */
  prev: DayCell[] | null;
}

export const addUtcDays = (ymd: string, n: number) => utcDate(Date.parse(ymd + 'T00:00:00Z') + n * 86_400_000);

function cellsBetween(start: string, end: string, byDate: Map<string, DailyRow>): DayCell[] {
  const out: DayCell[] = [];
  for (let d = start; d <= end; d = addUtcDays(d, 1)) out.push({ date: d, row: byDate.get(d) ?? null });
  return out;
}

/**
 * Last N calendar days in UTC, ending yesterday (or today, in progress, when asked for).
 * "all" spans the first to the last captured day, gaps included, captured zero days kept.
 */
export function calendarRange(all: DailyRow[], sel: { days: number | 'all'; includeToday: boolean; today: string }): CalendarRange {
  const byDate = new Map(all.map((r) => [r.date, r]));
  const todayRow = byDate.get(sel.today) ?? null;
  const excludedToday = !sel.includeToday ? todayRow : null;
  if (sel.days === 'all') {
    // First to last captured day. Captured zeros are real readings and stay (no padding trim here).
    const usable = all.filter((r) => r.date < sel.today || (sel.includeToday && r.date === sel.today));
    if (!usable.length) return { start: null, end: null, cells: [], rows: [], missing: [], includesToday: false, excludedToday, incomplete: [], prev: null };
    const cells = cellsBetween(usable[0]!.date, usable.at(-1)!.date, byDate);
    return finish(cells, excludedToday, null, sel.today);
  }
  const end = sel.includeToday ? sel.today : addUtcDays(sel.today, -1);
  const start = addUtcDays(end, -(sel.days - 1));
  const prev = cellsBetween(addUtcDays(start, -sel.days), addUtcDays(start, -1), byDate);
  return finish(cellsBetween(start, end, byDate), excludedToday, prev, sel.today);
}

function finish(cells: DayCell[], excludedToday: DailyRow | null, prev: DayCell[] | null, today: string): CalendarRange {
  return {
    start: cells[0]?.date ?? null,
    end: cells.at(-1)?.date ?? null,
    cells,
    rows: cells.flatMap((c) => (c.row ? [c.row] : [])),
    missing: cells.filter((c) => !c.row).map((c) => c.date),
    includesToday: cells.at(-1)?.date === today,
    excludedToday,
    incomplete: cells.filter((c) => c.row?.partial && c.date !== today).map((c) => c.date),
    prev,
  };
}

/** Figures shown for a range: three of X's daily fields plus two derived from them. */
export type FigureKey = string | 'NetFollows';

const has = (r: DailyRow, k: string) => typeof r.metrics[k] === 'number';

/** Fields a figure needs on a day before that day can count towards it. */
export function fieldsFor(key: FigureKey): string[] {
  if (key === 'EngagementRate') return ['Engagements', 'Impressions'];
  if (key === 'NetFollows') return ['Follows', 'Unfollows'];
  return [key];
}

/** A day's own value for a figure, or null when X did not report what it needs. */
export function dayValue(row: DailyRow | null, key: FigureKey): number | null {
  if (!row || !fieldsFor(key).every((k) => has(row, k))) return null;
  if (key === 'EngagementRate') return row.metrics.Impressions! > 0 ? row.metrics.Engagements! / row.metrics.Impressions! : null;
  if (key === 'NetFollows') return row.metrics.Follows! - row.metrics.Unfollows!;
  return isAdditive(key) ? row.metrics[key]! : null;
}

export interface Coverage {
  /** Total (or weighted rate) over the days that reported every needed field; null when none did. */
  value: number | null;
  /** Days that counted. */
  days: number;
  /** Calendar days in the span. */
  of: number;
}

/**
 * A figure over a span of days. Counts add the days that reported the field; rates divide totals taken
 * over the same days (days missing either field are left out of both sides); a zero denominator is null.
 */
export function figureOver(cells: DayCell[], key: FigureKey): Coverage {
  const fields = fieldsFor(key);
  const used = cells.flatMap((c) => (c.row && fields.every((k) => has(c.row!, k)) ? [c.row] : []));
  const sum = (k: string) => used.reduce((s, r) => s + r.metrics[k]!, 0);
  let value: number | null = null;
  if (used.length) {
    if (key === 'EngagementRate') value = sum('Impressions') > 0 ? sum('Engagements') / sum('Impressions') : null;
    else if (key === 'NetFollows') value = sum('Follows') - sum('Unfollows');
    else if (isAdditive(key)) value = sum(key);
  }
  return { value, days: used.length, of: cells.length };
}

/** Same as figureOver for a ratio of two fields, scaled (e.g. per 1,000). */
export function ratioOver(cells: DayCell[], num: string, den: string, scale = 1): Coverage {
  const used = cells.flatMap((c) => (c.row && has(c.row, num) && has(c.row, den) ? [c.row] : []));
  const d = used.reduce((s, r) => s + r.metrics[den]!, 0);
  return { value: used.length && d > 0 ? (used.reduce((s, r) => s + r.metrics[num]!, 0) / d) * scale : null, days: used.length, of: cells.length };
}

export type Change =
  | { kind: 'relative'; value: number; prevStart: string; prevEnd: string }
  | { kind: 'points'; value: number; prevStart: string; prevEnd: string }
  | { kind: 'difference'; value: number; prevStart: string; prevEnd: string }
  | { kind: 'prior-zero'; prevStart: string; prevEnd: string }
  | { kind: 'none' };

/**
 * Change against the equal range just before. Only when both ranges are complete UTC days with every
 * needed field on every day. Rates change in percentage points, net follows by their difference (it can be
 * negative), other counts by percent unless the prior was 0.
 */
export function changeOver(cur: DayCell[], prev: DayCell[] | null, key: FigureKey): Change {
  if (!prev || !cur.length || prev.length !== cur.length) return { kind: 'none' };
  const complete = (cells: DayCell[]) => cells.every((c) => c.row && !c.row.partial) && figureOver(cells, key).days === cells.length;
  if (!complete(cur) || !complete(prev)) return { kind: 'none' };
  const a = figureOver(cur, key).value;
  const b = figureOver(prev, key).value;
  const span = { prevStart: prev[0]!.date, prevEnd: prev.at(-1)!.date };
  if (a == null || b == null) return { kind: 'none' };
  if (key === 'EngagementRate') return { kind: 'points', value: (a - b) * 100, ...span };
  if (key === 'NetFollows') return { kind: 'difference', value: a - b, ...span };
  if (b === 0) return a === 0 ? { kind: 'relative', value: 0, ...span } : { kind: 'prior-zero', ...span };
  return { kind: 'relative', value: (a - b) / b, ...span };
}

export interface CellBucket {
  key: string;
  label: string;
  cells: DayCell[];
  /** Days the bucket's period has (7, or the month's length; 1 for a day). */
  expected: number;
  /** Contains today in progress, a missing day, or is cut off by the range edge. */
  partial: boolean;
}

/** Group calendar cells by day, Monday-start UTC week, or UTC month. */
export function bucketCells(cells: DayCell[], g: Granularity): CellBucket[] {
  if (g === 'daily') return cells.map((c) => ({ key: c.date, label: shortDate(c.date), cells: [c], expected: 1, partial: !c.row || c.row.partial }));
  const map = new Map<string, DayCell[]>();
  for (const c of cells) {
    const d = new Date(c.date + 'T00:00:00Z');
    const key = g === 'weekly' ? utcDate(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000) : c.date.slice(0, 7) + '-01';
    (map.get(key) ?? map.set(key, []).get(key)!).push(c);
  }
  return [...map.entries()].map(([key, cs]) => {
    const expected = g === 'weekly' ? 7 : daysInMonth(key);
    const label = g === 'weekly' ? `wk ${shortDate(key)}` : `${MONTHS[Number(key.slice(5, 7)) - 1]} '${key.slice(2, 4)}`;
    return { key, label, cells: cs, expected, partial: cs.length < expected || cs.some((c) => !c.row || c.row.partial) };
  });
}

/** Running total of captured days: a missing day is a gap in the line, later days keep adding. */
export function runningTotal(values: (number | null)[]): (number | null)[] {
  let run = 0;
  return values.map((v) => (v == null ? null : (run += v)));
}

/** Highest complete days for a figure (net follows included), never a partial or unreported day. */
export function topDaysBy(rows: DailyRow[], key: FigureKey, n = 10): DailyRow[] {
  return rows.filter((r) => !r.partial && dayValue(r, key) != null).sort((a, b) => dayValue(b, key)! - dayValue(a, key)! || a.date.localeCompare(b.date)).slice(0, n);
}
