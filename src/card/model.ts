import type { CaptureAttempt, Observation, Settings } from '../model/types';
import { dailyCheckpoints, rewardsProgress, rewardsReadings, sourceHealth, windowChange, type WindowChange } from '../calc/rewards';
import { formatReportingDate, formatTimestamp, reportingDate, suggestDayNumber } from '../calc/time';

export interface CardModel {
  handle: string;
  reportingDate: string;
  reportingDateText: string;
  day: number | null; // null until the user confirms it
  daySuggested: number;
  heroText: string;
  heroLabel: string;
  windowNote: string;
  progressFraction: number; // clamped 0..1 for drawing
  progressText: string;
  remainingText: string;
  qualifiers: string[]; // shown on the public card: rounded, stale, manual, ...
  change: WindowChange | null;
  sparkline: { t: number; v: number }[]; // daily checkpoints only; empty when < 3
  footer: string;
  readingId: string;
}

export type CardResult = { ok: true; model: CardModel } | { ok: false; reason: string };

export function buildCardModel(
  handle: string,
  observations: readonly Observation[],
  attempts: readonly CaptureAttempt[],
  settings: Settings,
  now: Date,
  confirmedDay: number | null,
): CardResult {
  // Account isolation: only this handle's records reach the card.
  const mine = observations.filter((o) => o.account === handle);
  const readings = rewardsReadings(mine);
  const latest = readings.at(-1);
  if (!latest) return { ok: false, reason: 'No rewards reading for this account yet. Capture or enter one first.' };

  const health = sourceHealth(readings, attempts, settings, now);
  const prog = rewardsProgress(latest, settings.rewardsTarget);
  const rDate = reportingDate(now, settings);
  const suggestion = suggestDayNumber(rDate, settings);

  const qualifiers: string[] = [];
  if (latest.precision === 'rounded') qualifiers.push('Rounded by X');
  if (latest.provenance === 'manual') qualifiers.push('User-reported');
  if (latest.provenance === 'imported') qualifiers.push('Imported');
  if (health.state === 'stale' || latest.reportingDate !== rDate) {
    qualifiers.push(`Reading from ${formatReportingDate(latest.reportingDate)}`);
  }
  if (latest.windowType !== 'rolling_90d') qualifiers.push('Window not confirmed');

  const daily = dailyCheckpoints(readings);
  const prev = daily.length >= 2 ? daily[daily.length - 2]! : null;
  const change = prev && prev.id !== latest.id ? windowChange(prev, latest, settings) : null;

  return {
    ok: true,
    model: {
      handle: '@' + handle,
      reportingDate: rDate,
      reportingDateText: formatReportingDate(rDate),
      day: confirmedDay,
      daySuggested: suggestion.day,
      heroText: latest.displayText,
      heroLabel: 'Verified Home Timeline impressions',
      windowNote: '90-day rolling window · excludes replies',
      progressFraction: Math.max(0, Math.min(1, prog.percent / 100)),
      progressText: `${prog.percentText} of ${prog.targetText}`,
      remainingText: prog.remainingText,
      qualifiers,
      change,
      sparkline: daily.length >= 3 ? daily.map((d) => ({ t: Date.parse(d.capturedAt), v: d.value })) : [],
      footer: `${latest.provenance === 'manual' ? 'Entered from X' : 'Captured from X'} · ${formatTimestamp(new Date(latest.capturedAt), settings.reportingTimeZone)}`,
      readingId: latest.id,
    },
  };
}
