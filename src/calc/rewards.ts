import type { CaptureAttempt, Observation, Settings } from '../model/types';
import { formatCompact, formatExact } from '../model/parse';
import { formatElapsed } from './time';

/**
 * Select rewards readings. This is the ONLY entry point the hero, chart and
 * card use. It filters strictly on metric === 'rewards_vht_90d'; there is no
 * fallback to account impressions of any kind.
 */
export function rewardsReadings(observations: readonly Observation[]): Observation[] {
  return observations
    .filter((o) => o.metric === 'rewards_vht_90d' && o.provenance !== 'scenario')
    .map(utcReading)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

/** Legacy stores used a local reporting day; calculations use the capture's UTC day without changing storage. */
function utcReading(reading: Observation): Observation {
  const date = reading.capturedAt.slice(0, 10);
  return reading.reportingDate === date && reading.reportingTimeZone === 'UTC'
    ? reading : { ...reading, reportingDate: date, reportingTimeZone: 'UTC' };
}

export interface RewardsProgress {
  reading: Observation;
  approximate: boolean;
  percent: number; // 0..100+
  percentText: string; // "≈21.8%" or "21.84%"
  remaining: number;
  remainingText: string; // "≈390.8K to go" | "390,800 to go" | "Target reached"
  targetText: string;
}

export function rewardsProgress(reading: Observation, target: number): RewardsProgress {
  const approximate = reading.precision === 'rounded';
  const percent = (reading.value / target) * 100;
  const remaining = Math.max(0, target - reading.value);
  const approx = approximate ? '≈' : '';
  // Keep the displayed precision no finer than the source's.
  const decimals = decimalsOf(reading.displayText);
  const remainingText =
    remaining === 0
      ? approximate && reading.value - reading.roundingHalfStep < target
        ? 'At target (rounded display)'
        : 'Target reached'
      : `${approx}${approximate ? formatCompact(remaining, decimals) : formatExact(remaining)} to go`;
  return {
    reading,
    approximate,
    percent,
    percentText: `${approx}${percent.toFixed(1)}%`,
    remaining,
    remainingText,
    targetText: formatCompact(target, 0),
  };
}

function decimalsOf(displayText: string): number {
  const m = /\.(\d+)/.exec(displayText);
  return m ? m[1]!.length : 0;
}

/**
 * Change between two rolling-window readings. This is a NET change in the
 * 90-day window (new impressions minus expired ones, subject to rounding and
 * revision). It is never "impressions earned today".
 */
export interface WindowChange {
  kind: 'net_rolling_window_change';
  label: string;
  delta: number;
  deltaText: string;
  approximate: boolean;
  elapsedMs: number;
  /** True only when both readings sit on consecutive reporting dates. */
  alignedDaily: boolean;
  from: Observation;
  to: Observation;
}

export function windowChange(from: Observation, to: Observation, _settings: Pick<Settings, 'reportingTimeZone'>): WindowChange {
  if (from.metric !== 'rewards_vht_90d' || to.metric !== 'rewards_vht_90d') {
    throw new Error('windowChange only compares rewards_vht_90d readings');
  }
  if (from.account !== to.account) throw new Error('Cannot compare readings across accounts');
  const delta = to.value - from.value;
  const approximate = from.precision === 'rounded' || to.precision === 'rounded';
  const elapsedMs = Date.parse(to.capturedAt) - Date.parse(from.capturedAt);
  const alignedDaily =
    from.reportingTimeZone === to.reportingTimeZone &&
    dayDiff(from.reportingDate, to.reportingDate) === 1;
  const span = alignedDaily ? 'vs previous reporting day' : `since last capture (${formatElapsed(elapsedMs)} earlier)`;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const mag = approximate ? formatCompact(Math.abs(delta), Math.max(decimalsOf(from.displayText), decimalsOf(to.displayText))) : formatExact(Math.abs(delta));
  return {
    kind: 'net_rolling_window_change',
    label: `Net change in 90-day window ${span}`,
    delta,
    deltaText: `${approximate ? '≈' : ''}${sign}${mag}`,
    approximate,
    elapsedMs,
    alignedDaily,
    from,
    to,
  };
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

/** One reading per reporting day (the latest of that day). Multiple captures in one day are not separate history. */
export function dailyCheckpoints(readings: readonly Observation[]): Observation[] {
  const byDay = new Map<string, Observation>();
  for (const reading of readings) {
    const r = utcReading(reading);
    const prev = byDay.get(r.reportingDate);
    if (!prev || prev.capturedAt < r.capturedAt) byDay.set(r.reportingDate, r);
  }
  return [...byDay.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export type HealthState = 'ready' | 'stale' | 'source_error' | 'no_data';

export interface SourceHealth {
  state: HealthState;
  flags: string[]; // e.g. "Rounded by X", "Window not confirmed"
  message: string;
  latest: Observation | null;
  lastAttempt: CaptureAttempt | null;
  ageMs: number | null;
}

export function sourceHealth(
  readings: readonly Observation[],
  attempts: readonly CaptureAttempt[],
  settings: Pick<Settings, 'staleAfterHours'>,
  now: Date,
): SourceHealth {
  const latest = readings.length ? readings[readings.length - 1]! : null;
  const lastAttempt = attempts.filter((a) => a.metric === 'rewards_vht_90d').at(-1) ?? null;
  const flags: string[] = [];
  if (latest) {
    if (latest.precision === 'rounded') flags.push('Rounded by X');
    if (latest.windowType !== 'rolling_90d') flags.push('90-day window not confirmed on source');
    if (latest.excludesReplies !== true) flags.push('Reply exclusion not confirmed on source');
    if (latest.provenance === 'manual') flags.push('User-reported');
    if (latest.provenance === 'imported') flags.push('Imported');
  }
  if (!latest) {
    const msg = lastAttempt && !lastAttempt.ok ? `No reading yet. Last capture failed: ${lastAttempt.message ?? lastAttempt.code}` : 'No reading yet.';
    return { state: lastAttempt && !lastAttempt.ok ? 'source_error' : 'no_data', flags, message: msg, latest, lastAttempt, ageMs: null };
  }
  const seen = Date.parse(latest.lastSeenAt);
  const ageMs = now.getTime() - seen;
  const failedSince = lastAttempt && !lastAttempt.ok && Date.parse(lastAttempt.at) > seen;
  if (failedSince) {
    return {
      state: 'source_error',
      flags,
      message: `Latest capture failed (${lastAttempt!.message ?? lastAttempt!.code}). Showing previous reading from ${formatElapsed(ageMs)} ago.`,
      latest,
      lastAttempt,
      ageMs,
    };
  }
  if (ageMs > settings.staleAfterHours * 3_600_000) {
    return { state: 'stale', flags, message: `Stale: last confirmed ${formatElapsed(ageMs)} ago.`, latest, lastAttempt, ageMs };
  }
  return { state: 'ready', flags, message: `Last confirmed ${formatElapsed(ageMs)} ago.`, latest, lastAttempt, ageMs };
}
