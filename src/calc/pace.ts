// Pace model for the rewards metric: where the rolling 90-day window stands,
// how fast it has been moving, and what that pace implies.
//
// Everything here is derived from measured readings only. The projection is a
// straight line at the measured net rate: it is labelled as such everywhere and
// is not a forecast of X's behaviour. The "need" figure is arithmetic on the
// programme's own rule (target ÷ 90 days), not a measurement.
import type { Observation } from '../model/types';
import { dailyCheckpoints } from './rewards';
import { daysBetween } from './time';

/** Length of X's rolling window for the rewards metric. */
export const WINDOW_DAYS = 90;
/** Readings within this many days of the latest one define the current rate. */
export const RATE_LOOKBACK_DAYS = 10;
/** Projection never extends further than this, so a slow pace cannot draw a year-long line. */
export const PROJECTION_MAX_DAYS = 120;

export interface PaceCheckpoint {
  date: string;
  value: number;
  displayText: string;
  approximate: boolean;
}

export interface PaceGain {
  date: string;
  /** Net change of the window vs the previous reporting day's reading; null when either day has no reading. */
  delta: number | null;
  /** The reading for this day was taken while the day was still in progress. */
  partial: boolean;
  approximate: boolean;
}

export interface PaceRate {
  /** Average net change of the window per day across the span. */
  perDay: number;
  spanDays: number;
  from: string;
  to: string;
  approximate: boolean;
  /** ± on perDay implied by X's rounding of the two endpoint readings. */
  uncertainty: number;
}

export type PaceStatus = 'reached' | 'ahead' | 'behind' | 'falling' | 'insufficient';

export interface Pace {
  reading: Observation;
  target: number;
  toGo: number;
  percent: number;
  approximate: boolean;
  /** Pace that keeps a full rolling window at the target: target ÷ 90 per day. */
  need: { perDay: number };
  rate: PaceRate | null;
  /** rate × 90: what a full window settles at if the measured pace holds. */
  fullWindowAtRate: number | null;
  status: PaceStatus;
  /** Days counted from the latest reading's reporting day. */
  eta: { date: string; days: number; beyondProjection: boolean } | null;
  /** Straight line from the latest reading at the measured rate (first point is the reading itself). */
  projection: { date: string; value: number }[];
  /** One entry per reporting day from the first checkpoint to the latest. */
  gains: PaceGain[];
  checkpoints: PaceCheckpoint[];
  /** Plain-language reasons when rate or ETA are unavailable. */
  reasons: string[];
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Signed per-day figure: +6.0K, −950, +12.3K. */
export function formatRate(perDay: number, approximate = false): string {
  const sign = perDay > 0 ? '+' : perDay < 0 ? '−' : '±';
  const a = Math.abs(perDay);
  const mag = a >= 1000 ? `${(a / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(Math.round(a));
  return `${approximate ? '≈' : ''}${sign}${mag}`;
}

export function formatDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/**
 * Build the pace model from rewards readings. Returns null without a reading.
 * `today` is the current UTC reporting day; it only marks today's gain as partial.
 */
export function buildPace(readings: readonly Observation[], target: number, today: string, opts: { lookbackDays?: number } = {}): Pace | null {
  const cps = dailyCheckpoints(readings);
  const latest = cps.at(-1);
  if (!latest) return null;
  const lookback = opts.lookbackDays ?? RATE_LOOKBACK_DAYS;
  const reasons: string[] = [];

  const checkpoints: PaceCheckpoint[] = cps.map((c) => ({ date: c.reportingDate, value: c.value, displayText: c.displayText, approximate: c.precision === 'rounded' }));
  const byDate = new Map(cps.map((c) => [c.reportingDate, c]));
  const toGo = Math.max(0, target - latest.value);
  const percent = (latest.value / target) * 100;
  const need = { perDay: target / WINDOW_DAYS };

  // Rate: earliest checkpoint inside the lookback window vs the latest one.
  const windowStart = addDaysYmd(latest.reportingDate, -lookback);
  const first = cps.find((c) => c.reportingDate >= windowStart)!;
  const spanDays = daysBetween(first.reportingDate, latest.reportingDate);
  let rate: PaceRate | null = null;
  if (spanDays >= 2) {
    rate = {
      perDay: (latest.value - first.value) / spanDays,
      spanDays,
      from: first.reportingDate,
      to: latest.reportingDate,
      approximate: first.precision === 'rounded' || latest.precision === 'rounded',
      uncertainty: (first.roundingHalfStep + latest.roundingHalfStep) / spanDays,
    };
  } else {
    reasons.push(
      cps.length === 1
        ? 'Pace appears once there are readings at least two days apart.'
        : `Pace needs readings at least two days apart (the ${cps.length} readings so far span ${spanDays} day${spanDays === 1 ? '' : 's'}).`,
    );
  }

  // Status + ETA.
  let status: PaceStatus;
  let eta: Pace['eta'] = null;
  let projection: Pace['projection'] = [];
  if (toGo === 0) status = 'reached';
  else if (!rate) status = 'insufficient';
  else if (rate.perDay <= 0) {
    status = 'falling';
    reasons.push(rate.perDay === 0 ? 'The window did not move over the rate span, so there is no date to project.' : 'The window is shrinking: older impressions are expiring faster than new ones arrive.');
  } else {
    status = rate.perDay >= need.perDay ? 'ahead' : 'behind';
    const days = Math.ceil(toGo / rate.perDay);
    const beyond = days > PROJECTION_MAX_DAYS;
    eta = { date: addDaysYmd(latest.reportingDate, days), days, beyondProjection: beyond };
    const n = Math.min(days, PROJECTION_MAX_DAYS);
    for (let i = 0; i <= n; i++) projection.push({ date: addDaysYmd(latest.reportingDate, i), value: Math.round(latest.value + rate.perDay * i) });
  }
  if (status === 'reached') projection = [];

  // Daily net change: one slot per reporting day from the first checkpoint to the latest.
  const gains: PaceGain[] = [];
  const firstDate = cps[0]!.reportingDate;
  const total = daysBetween(firstDate, latest.reportingDate);
  for (let i = 0; i <= total; i++) {
    const date = addDaysYmd(firstDate, i);
    const cur = byDate.get(date);
    const prev = byDate.get(addDaysYmd(date, -1));
    gains.push({
      date,
      delta: cur && prev ? cur.value - prev.value : null,
      partial: date === today,
      approximate: !!(cur && prev && (cur.precision === 'rounded' || prev.precision === 'rounded')),
    });
  }

  return {
    reading: latest,
    target,
    toGo,
    percent,
    approximate: latest.precision === 'rounded',
    need,
    rate,
    // Only meaningful for a growing window; a shrinking one has no steady state to quote.
    fullWindowAtRate: rate && rate.perDay > 0 ? Math.round(rate.perDay * WINDOW_DAYS) : null,
    status,
    eta,
    projection,
    gains,
    checkpoints,
    reasons,
  };
}

/** One-paragraph reading of the model for the dashboard callout. */
export function paceSummary(p: Pace, fmtDate: (ymd: string) => string): { title: string; body: string } {
  const compact = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(Math.round(v)));
  const tgt = compact(p.target);
  const need = formatRate(p.need.perDay);
  if (p.status === 'reached') return { title: 'Target reached', body: `The window is at or above ${tgt}. Holding it needs about ${need} a day on average.` };
  if (!p.rate) return { title: 'Pace not available yet', body: p.reasons.join(' ') };
  const rate = formatRate(p.rate.perDay, p.rate.approximate);
  const span = `over ${p.rate.spanDays} days`;
  if (p.status === 'falling') return { title: 'Window shrinking', body: `${rate} a day ${span}. ${p.reasons.at(-1) ?? ''}`.trim() };
  const full = compact(p.fullWindowAtRate!);
  const etaText = p.eta ? `${tgt} on ${fmtDate(p.eta.date)} (${p.eta.days <= 1 ? 'about a day' : `in ~${p.eta.days} days`})` : '';
  if (p.status === 'ahead') {
    const over = compact(p.rate.perDay - p.need.perDay);
    return { title: "You're ahead", body: `At ${rate} a day a full 90-day window holds ≈${full}, ${over} a day above the ${need} that keeps it at ${tgt}. At this pace: ${etaText}.` };
  }
  const short = compact(p.need.perDay - p.rate.perDay);
  return {
    title: 'Behind the holding pace',
    body: `At ${rate} a day a full 90-day window settles near ≈${full}, ${short} a day short of the ${need} that keeps it at ${tgt}. At this pace you would touch ${etaText} only if nothing expires first.`,
  };
}
