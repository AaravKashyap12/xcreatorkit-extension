// Builds the shareable growth report from stored, verified data only.
//
// Reporting days are X's daily buckets, which are UTC calendar days. X exposes no
// hourly data (hourlyEnabled: false), so local-calendar days cannot be derived and
// the report is labelled UTC. "Today" = the current UTC day so far.
//
// Ranges are calendar windows that END TODAY: 1D = today; 7D/30D/90D = today plus
// the preceding 6/29/89 days. Today is partial, so comparisons are computed on a
// complete-day basis only (the window minus today vs. the same number of days
// before it), and only when every one of those days was captured complete.
import type { CaptureAttempt, IntradayObs, Observation, Settings } from '../model/types';
import { dailyCheckpoints, rewardsProgress, rewardsReadings, sourceHealth, windowChange, type HealthState, type RewardsProgress, type WindowChange } from '../calc/rewards';
import { buildPace, type Pace } from '../calc/pace';
import { formatElapsed, suggestDayNumber } from '../calc/time';
import { engagementRate, m, pctChange, shortDate, sumMetric, utcDate, valueOver, type DailyRow } from './series';

export type RangeDays = 1 | 7 | 30 | 90;
/** Where a range ends: today (in progress) or yesterday (the last complete UTC day). */
export type RangeAnchor = 'today' | 'yesterday';
export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | '90d';
export const RANGES: { key: RangeKey; days: RangeDays; anchor: RangeAnchor; label: string; button: string }[] = [
  { key: 'today', days: 1, anchor: 'today', label: 'Today', button: 'Today (1D)' },
  { key: 'yesterday', days: 1, anchor: 'yesterday', label: 'Yesterday', button: 'Yesterday · final' },
  { key: '7d', days: 7, anchor: 'today', label: '7D', button: '7D' },
  { key: '30d', days: 30, anchor: 'today', label: '30D', button: '30D' },
  { key: '90d', days: 90, anchor: 'today', label: '90D', button: '90D' },
];

export const addDays = (ymd: string, n: number) => utcDate(Date.parse(ymd + 'T00:00:00Z') + n * 86_400_000);

export interface DayCell {
  date: string;
  row: DailyRow | null;
  isToday: boolean;
  /** Captured while the day was still in progress (always true for today). */
  partial: boolean;
  missing: boolean;
}

export type Comparison =
  | { available: true; days: number; cur: { start: string; end: string }; prev: { start: string; end: string } }
  | { available: false; reason: string };

export interface Kpi {
  key: 'Impressions' | 'Engagements' | 'EngagementRate' | 'ProfileVisits';
  label: string;
  /** Total over every captured day in the range, including today so far. */
  value: number | null;
  /** Complete-day basis values used for the comparison (null if no comparison). */
  basisCur: number | null;
  basisPrev: number | null;
  change: number | null;
  upIsGood: boolean;
}

export interface Report {
  handle: string;
  generatedAt: string;
  reportingDate: string; // for Day N (local reporting day)
  daySuggested: number;
  range: {
    days: RangeDays;
    anchor: RangeAnchor;
    /** Status of the last day in the range: today in progress, a complete day, a day captured mid-day, or missing. */
    endStatus: 'in_progress' | 'final' | 'partial' | 'unavailable';
    today: string; // UTC date of the range end (yesterday for the Yesterday range)
    start: string;
    end: string;
    cells: DayCell[];
    todayStatus: 'in_progress' | 'unavailable';
    todayAsOf: string | null; // capture time of today's row
    missingDays: string[]; // days before today with no captured row
  };
  analytics: { capturedAt: string | null; stale: boolean; ageText: string | null };
  rewards: {
    history: { date: string; value: number; displayText: string }[];
    reading: Observation;
    target: number;
    progress: RewardsProgress;
    health: HealthState;
    ageText: string;
    change: WindowChange | null;
    verifiedFollowers: Observation | null;
    /** Rate / need / ETA model from the same readings (see calc/pace.ts). */
    pace: Pace;
  } | null;
  comparison: Comparison;
  kpis: Kpi[];
  trend: { date: string; cur: number | null; prev: number | null; partial: boolean; missing: boolean; isToday: boolean }[];
  trendFacts: { avgPerCompleteDay: number | null; completeDays: number; daysOver10k: number } | null;
  peak: { date: string; value: number } | null;
  followers: {
    net: number;
    follows: number;
    unfollows: number;
    includesPartialToday: boolean;
    total: Observation | null;
    verified: Observation | null;
  } | null;
  efficiency: {
    visitsPer1k: { cur: number | null; prev: number | null };
    /** null for Today: net follows are already in the waterfall. */
    netFollows: { cur: number | null; prev: number | null } | null;
    basis: 'complete_days' | 'today_so_far';
  } | null;
  /** Counts of X's own engagement fields for the range (not shares of the Engagements total). Private view. */
  engagementTypes: { likes: number; replies: number; reposts: number; bookmarks: number; shares: number | null } | null;
  /** Public "Conversation activity": likes and replies received, plus replies per 1K impressions (same period). */
  /** replies = replies RECEIVED (X `Replies`); repliesWritten = replies the account posted (X `CreateReply`). */
  conversation: { likes: number; replies: number; repliesWritten: number | null; repliesPer1k: number | null } | null;
  /** Today only: running impressions observed at successive captures (>= 2 points), else null. Private. */
  intraday: { at: string; v: number }[] | null;
  /** Single-day views: X's daily impressions for the 7 UTC days ending on the focus day (missing = null). */
  context: { date: string; v: number | null; focus: boolean }[] | null;
  /** Total followers: the latest exact count (X profile) if captured, else X Analytics' rounded figure. */
  followerCount: Observation | null;
  /** Limitations and data notes for the private controls, never drawn on the artboard. */
  diagnostics: string[];
  momentum:
    | { kind: 'followers' | 'impressions'; points: { date: string | null; v: number }[]; final: number; through: string; endsPartial: boolean; endsToday: boolean }
    | { kind: 'unavailable'; reason: string }
    | null;
  qualifiers: string[];
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dayLabel = (ymd: string) => `${WEEKDAY[new Date(ymd + 'T00:00:00Z').getUTCDay()]} ${shortDate(ymd)}`;

export function compactNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return Math.round(v).toLocaleString('en-US');
}

function latestOf(obs: readonly Observation[], metric: Observation['metric']): Observation | null {
  return obs.filter((o) => o.metric === metric).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1) ?? null;
}

/** Latest exact reading of a metric if any (e.g. X profile "1,030"), else the latest rounded one ("1K"). */
function preferExact(obs: readonly Observation[], metric: Observation['metric']): Observation | null {
  const list = obs.filter((o) => o.metric === metric).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  return list.filter((o) => o.precision === 'exact').at(-1) ?? list.at(-1) ?? null;
}

const hasFollow = (r: DailyRow) => 'Follows' in r.metrics && 'Unfollows' in r.metrics;
const net = (rs: DailyRow[]) => sumMetric(rs, 'Follows') - sumMetric(rs, 'Unfollows');

export function buildReport(input: {
  handle: string;
  settings: Settings;
  observations: readonly Observation[];
  attempts: readonly CaptureAttempt[];
  daily: DailyRow[];
  analyticsCapturedAt: string | null;
  intraday?: Record<string, IntradayObs[]>;
  days: RangeDays;
  anchor?: RangeAnchor;
  now: Date;
}): Report {
  const { handle, settings, now, days } = input;
  const anchor: RangeAnchor = days === 1 && input.anchor === 'yesterday' ? 'yesterday' : 'today';
  const obs = input.observations.filter((o) => o.account === handle);
  const utcToday = utcDate(now);
  // `today` is the end of the selected range: the current UTC day, or yesterday for the Yesterday range.
  const today = anchor === 'yesterday' ? addDays(utcToday, -1) : utcToday;
  const byDate = new Map(input.daily.map((r) => [r.date, r]));

  // ---- Rewards: X's rolling 90-day metric, independent of the selected range.
  const readings = rewardsReadings(obs);
  const latest = readings.at(-1) ?? null;
  let rewards: Report['rewards'] = null;
  if (latest) {
    const health = sourceHealth(readings, input.attempts, settings, now);
    const cps = dailyCheckpoints(readings);
    const prev = cps.length >= 2 ? cps[cps.length - 2]! : null;
    rewards = {
      history: cps.length >= 2 ? cps.map((c) => ({ date: c.reportingDate, value: c.value, displayText: c.displayText })) : [],
      reading: latest,
      target: settings.rewardsTarget,
      progress: rewardsProgress(latest, settings.rewardsTarget),
      health: health.state,
      ageText: formatElapsed(now.getTime() - Date.parse(latest.lastSeenAt)),
      change: prev && prev.id !== latest.id ? windowChange(prev, latest, settings) : null,
      verifiedFollowers: latestOf(obs, 'followers_verified'),
      pace: buildPace(readings, settings.rewardsTarget, utcToday)!,
    };
  }

  // ---- Calendar window ending today (UTC)
  const start = addDays(today, -(days - 1));
  const cells: DayCell[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const row = byDate.get(date) ?? null;
    cells.push({ date, row, isToday: date === utcToday, partial: row ? row.partial || date === utcToday : false, missing: !row });
  }
  const todayCell = cells.at(-1)!;
  const avail = cells.filter((c) => c.row).map((c) => c.row!);
  const missingDays = cells.filter((c) => c.missing && c.date !== today).map((c) => c.date);
  const capturedAt = input.analyticsCapturedAt;

  // ---- Comparison basis: complete days only, same length, fully captured on both sides.
  let comparison: Comparison;
  const basisCells = cells.filter((c) => !c.isToday);
  if (days === 1 && anchor === 'today') {
    comparison = { available: false, reason: 'Today is in progress and X gives daily totals only, so there is no like-for-like comparison.' };
  } else if (basisCells.some((c) => c.missing || c.partial)) {
    comparison = { available: false, reason: 'Some days in this range were not captured complete.' };
  } else {
    const k = basisCells.length;
    const pStart = addDays(start, -k);
    const prevRows = Array.from({ length: k }, (_, i) => byDate.get(addDays(pStart, i)));
    comparison = prevRows.every((r) => r && !r.partial)
      ? { available: true, days: k, cur: { start, end: basisCells.at(-1)!.date }, prev: { start: pStart, end: addDays(start, -1) } }
      : { available: false, reason: `The ${k} days before this range were not fully captured.` };
  }
  const basisCur = comparison.available ? basisCells.map((c) => c.row!) : null;
  const basisPrev = comparison.available ? Array.from({ length: comparison.days }, (_, i) => byDate.get(addDays(comparison.prev.start, i))!) : null;

  // A figure needs its field on every day it covers; a day X did not report is never read as 0.
  const val = (rs: DailyRow[] | null, k: Kpi['key']) => (rs && rs.length ? valueOver(rs, k) : null);
  const kpiDefs: [Kpi['key'], string][] = [
    ['Impressions', 'Impressions'],
    ['Engagements', 'Engagements'],
    ['EngagementRate', 'Engagement rate'],
    ['ProfileVisits', 'Profile visits'],
  ];
  const kpis: Kpi[] = avail.length
    ? kpiDefs.map(([key, label]) => {
        const bc = val(basisCur, key);
        const bp = val(basisPrev, key);
        return { key, label, value: val(avail, key), basisCur: bc, basisPrev: bp, change: pctChange(bc, bp), upIsGood: true };
      })
    : [];

  // ---- Trend (one entry per calendar day; missing stays missing, never zero)
  const trend = cells.map((c, i) => ({
    date: c.date,
    cur: c.row?.metrics.Impressions ?? null,
    prev: basisPrev && !c.isToday ? (basisPrev[i]!.metrics.Impressions ?? null) : null,
    partial: c.partial,
    missing: c.missing,
    isToday: c.isToday,
  }));
  const complete = cells.filter((c) => c.row && !c.partial && c.row.metrics.Impressions != null).map((c) => c.row!);
  let peak: Report['peak'] = null;
  if (complete.length >= 2) {
    const top = complete.reduce((a, r) => (m(r, 'Impressions') > m(a, 'Impressions') ? r : a), complete[0]!);
    if (m(top, 'Impressions') > 0) peak = { date: top.date, value: m(top, 'Impressions') };
  }
  const trendFacts = avail.length
    ? {
        avgPerCompleteDay: complete.length ? sumMetric(complete, 'Impressions') / complete.length : null,
        completeDays: complete.length,
        daysOver10k: complete.filter((r) => m(r, 'Impressions') >= 10_000).length,
      }
    : null;

  // ---- Followers (only from genuine daily follow fields)
  const followData = avail.length > 0 && avail.every(hasFollow);
  const followers: Report['followers'] = followData
    ? {
        net: net(avail),
        follows: sumMetric(avail, 'Follows'),
        unfollows: sumMetric(avail, 'Unfollows'),
        includesPartialToday: !!todayCell.row,
        total: preferExact(obs, 'followers_total'),
        verified: latestOf(obs, 'followers_verified'),
      }
    : null;

  // ---- Reach efficiency
  const per1k = (rs: DailyRow[] | null) => {
    if (!rs) return null;
    const i = valueOver(rs, 'Impressions');
    const v = valueOver(rs, 'ProfileVisits');
    return i != null && v != null && i > 0 ? (v / i) * 1000 : null;
  };
  let efficiency: Report['efficiency'] = null;
  if (days === 1 && todayCell.row && per1k([todayCell.row]) != null) {
    efficiency = { visitsPer1k: { cur: per1k([todayCell.row]), prev: null }, netFollows: null, basis: 'today_so_far' };
  } else if (followData && basisCur && basisPrev && basisPrev.every(hasFollow)) {
    efficiency = { visitsPer1k: { cur: per1k(basisCur), prev: per1k(basisPrev) }, netFollows: { cur: net(basisCur), prev: net(basisPrev) }, basis: 'complete_days' };
  }

  // ---- Momentum: cumulative from 0 across the range; never across gaps, never intraday.
  let momentum: Report['momentum'] = null;
  if (days === 1) {
    momentum = avail.length ? { kind: 'unavailable', reason: 'X provides daily totals only, so there is no intraday curve.' } : null;
  } else if (missingDays.length) {
    momentum = { kind: 'unavailable', reason: `${missingDays.length} day(s) in this range were not captured; a cumulative curve would hide the gap.` };
  } else if (avail.length && (followData || avail.every((r) => r.metrics.Impressions != null))) {
    const kind = followData ? 'followers' : 'impressions';
    let run = 0;
    const pts = cells.filter((c) => c.row).map((c) => ({ date: c.date, v: (run += kind === 'followers' ? m(c.row!, 'Follows') - m(c.row!, 'Unfollows') : m(c.row!, 'Impressions')) }));
    const last = cells.filter((c) => c.row).at(-1)!;
    momentum = { kind, points: [{ date: null, v: 0 }, ...pts], final: run, through: last.date, endsPartial: last.partial, endsToday: last.isToday };
  }

  // ---- Engagement types: only X's own fields, only if every captured day has all four.
  const TYPES = ['Likes', 'Replies', 'Retweets', 'Bookmark'] as const;
  const engagementTypes =
    avail.length && avail.every((r) => TYPES.every((k) => k in r.metrics))
      ? { likes: sumMetric(avail, 'Likes'), replies: sumMetric(avail, 'Replies'), reposts: sumMetric(avail, 'Retweets'), bookmarks: sumMetric(avail, 'Bookmark'), shares: avail.every((r) => 'Share' in r.metrics) ? sumMetric(avail, 'Share') : null }
      : null;
  // Conversation activity: X's Likes and Replies (received) fields only; never derived from Engagements.
  const convoImp = valueOver(avail, 'Impressions');
  const conversation =
    avail.length && avail.every((r) => 'Likes' in r.metrics && 'Replies' in r.metrics)
      ? {
          likes: sumMetric(avail, 'Likes'),
          replies: sumMetric(avail, 'Replies'),
          repliesWritten: avail.every((r) => 'CreateReply' in r.metrics) ? sumMetric(avail, 'CreateReply') : null,
          repliesPer1k: convoImp != null && convoImp > 0 ? (sumMetric(avail, 'Replies') / convoImp) * 1000 : null,
        }
      : null;

  // ---- Observed intraday line (Today only): starts at the first real capture, needs >= 2.
  const obsToday = (input.intraday?.[utcToday] ?? []).filter((o) => typeof o.metrics.Impressions === 'number').sort((a, b) => a.at.localeCompare(b.at));
  const intraday = days === 1 && anchor === 'today' && obsToday.length >= 2 ? obsToday.map((o) => ({ at: o.at, v: o.metrics.Impressions! })) : null;

  // ---- Today in context: the last 7 UTC days of X's own daily totals.
  const context =
    days === 1 && todayCell.row
      ? Array.from({ length: 7 }, (_, i) => {
          const date = addDays(today, i - 6);
          const row = byDate.get(date);
          return { date, v: row?.metrics.Impressions ?? null, focus: date === today };
        })
      : null;

  // ---- Private diagnostics (shown in the controls, not on the artboard)
  const diagnostics: string[] = [];
  if (days === 1) {
    diagnostics.push('X exposes daily totals only (hourlyEnabled: false); there is no genuine hourly data.');
    diagnostics.push(
      intraday
        ? `${obsToday.length} captures of today's running total stored (first ${obsToday[0]!.at.slice(11, 16)} UTC).`
        : `${obsToday.length} capture(s) of today's running total stored.`,
    );
  }
  if (days > 1 && !comparison.available) diagnostics.push(`No comparison: ${comparison.reason}`);
  if (!conversation && avail.length) diagnostics.push('Likes/Replies fields missing from capture; conversation panel hidden.');
  if (momentum?.kind === 'unavailable') diagnostics.push(`Follower momentum hidden: ${momentum.reason}`);
  if (!followData && avail.length) diagnostics.push('Daily follow fields missing; follower waterfall hidden.');

  // ---- Freshness + qualifications
  const stale = !capturedAt || utcDate(Date.parse(capturedAt)) < utcToday;
  const qualifiers: string[] = [];
  if (!todayCell.row) qualifiers.push(anchor === 'today' ? `Today (${shortDate(today)} UTC) not captured.` : `${shortDate(today)} (UTC) not captured.`);
  if (missingDays.length) qualifiers.push(`${missingDays.length} of ${days} days not captured.`);
  if (days > 1 && !comparison.available) qualifiers.push('No period comparison shown.');
  if (rewards?.reading.precision === 'rounded') qualifiers.push('Rewards figure is rounded by X.');
  if (rewards && rewards.health !== 'ready') qualifiers.push(`Rewards reading is ${rewards.ageText} old.`);

  return {
    handle,
    generatedAt: now.toISOString(),
    // Day N follows X's clock: the UTC date (no local cutoff).
    reportingDate: today,
    daySuggested: suggestDayNumber(today, settings).day,
    range: {
      days,
      anchor,
      endStatus: !todayCell.row ? 'unavailable' : todayCell.isToday ? 'in_progress' : todayCell.partial ? 'partial' : 'final',
      today,
      start,
      end: today,
      cells,
      todayStatus: todayCell.row ? 'in_progress' : 'unavailable',
      todayAsOf: todayCell.row?.capturedAt ?? null,
      missingDays,
    },
    followerCount: preferExact(obs, 'followers_total'),
    analytics: { capturedAt, stale, ageText: capturedAt ? formatElapsed(now.getTime() - Date.parse(capturedAt)) : null },
    rewards,
    comparison,
    kpis,
    trend,
    trendFacts,
    peak,
    followers,
    efficiency,
    engagementTypes,
    conversation,
    intraday,
    context,
    diagnostics,
    momentum,
    qualifiers,
  };
}
