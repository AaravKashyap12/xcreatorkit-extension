import type { Settings } from '../model/types';

/** YYYY-MM-DD of an instant in a given IANA timezone. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The reporting day an instant belongs to. Captures made shortly after local
 * midnight (before cycleCutoffHour) still belong to the previous day's cycle.
 */
export function reportingDate(at: Date, settings: Pick<Settings, 'reportingTimeZone' | 'cycleCutoffHour'>): string {
  const shifted = new Date(at.getTime() - settings.cycleCutoffHour * 3_600_000);
  return localDate(shifted, settings.reportingTimeZone);
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(toYmd) - toUtc(fromYmd)) / 86_400_000);
}

export interface DaySuggestion {
  day: number;
  /** 'unset': the user has not picked their Day 1 yet, so today counts as Day 1 until they do. */
  source: 'override' | 'anchor' | 'unset';
}

/** Suggested "Day N" for a reporting date. Always shown to the user for confirmation before export. */
export function suggestDayNumber(reportingYmd: string, settings: Pick<Settings, 'dayAnchor' | 'dayOverrides'>): DaySuggestion {
  if (!settings.dayAnchor.date) return { day: 1, source: 'unset' };
  const o = settings.dayOverrides[reportingYmd];
  if (o != null) return { day: o, source: 'override' };
  return { day: settings.dayAnchor.day + daysBetween(settings.dayAnchor.date, reportingYmd), source: 'anchor' };
}

export function formatTimestamp(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);
}

export function formatReportingDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  );
}

export function formatElapsed(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${Math.round(hours / 24)} days`;
}

const addDaysYmd = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The UTC date that counts as Day 1, from the stored anchor (which may say "date X is Day N"). Null until picked. */
export function dayOneDate(settings: Pick<Settings, 'dayAnchor'>): string | null {
  const { date, day } = settings.dayAnchor;
  return date ? addDaysYmd(date, 1 - day) : null;
}

/** Settings for "Day 1 is this UTC date". Earlier per-date overrides belonged to the old count, so they are cleared. */
export function pickDayOne(ymd: string, todayYmd: string): Pick<Settings, 'dayAnchor' | 'dayOverrides'> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || Number.isNaN(Date.parse(`${ymd}T00:00:00Z`))) throw new Error('Pick a valid date.');
  if (ymd > todayYmd) throw new Error("Day 1 can't be after today (UTC).");
  return { dayAnchor: { date: ymd, day: 1 }, dayOverrides: {} };
}
