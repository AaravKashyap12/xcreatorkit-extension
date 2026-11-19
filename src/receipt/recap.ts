// Complete UTC windows for the shared receipt renderer. Missing rows or metric keys never become zero.
import { addDays, type Report } from '../analytics/report';
import type { DailyRow } from '../analytics/series';
import { daysBetween } from '../calc/time';
import { METRICS, type MetricKey, type ReceiptData } from './data';
import { receiptFromReport } from './fromReport';

export type RecapKind = 'week' | 'month';
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const short = (ymd: string) => `${Number(ymd.slice(8))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]!.slice(0, 3)}`;
const fmt = (n: number) => n.toLocaleString('en-US');
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n))}`;

export function recapFromReport(r: Report, opts: { kind: RecapKind; metrics: MetricKey[]; history: DailyRow[]; dayOne: string | null }): ReceiptData {
  const today = r.reportingDate;
  const end = addDays(today, -1);
  const start = opts.kind === 'week' ? addDays(today, -7) : `${today.slice(0, 7)}-01`;
  const expected = Math.max(0, daysBetween(start, end) + 1);
  const byDate = new Map(opts.history.map((row) => [row.date, row]));
  const dates = Array.from({ length: expected }, (_, i) => addDays(start, i));
  const complete = dates.map((date) => byDate.get(date)).filter((row): row is DailyRow => !!row && !row.partial);
  const completeWindow = complete.length === expected && expected > 0;
  const field = (key: string) => completeWindow && complete.every((row) => Number.isFinite(row.metrics[key]))
    ? complete.reduce((sum, row) => sum + row.metrics[key]!, 0) : null;
  const value = (key: MetricKey): string => {
    if (key === 'impressionsDelta') return '—';
    if (key === 'bestDay') {
      if (!completeWindow || !complete.every((row) => Number.isFinite(row.metrics.Impressions))) return '—';
      const best = complete.reduce((a, b) => b.metrics.Impressions! > a.metrics.Impressions! ? b : a);
      return `${short(best.date)} · ${fmt(best.metrics.Impressions!)}`;
    }
    if (key === 'daysPosted' || key === 'streak') {
      if (!completeWindow || !complete.every((row) => Number.isFinite(row.metrics.CreateTweet))) return '—';
      if (key === 'daysPosted') return fmt(complete.filter((row) => row.metrics.CreateTweet! > 0).length);
      let run = 0, longest = 0;
      for (const row of complete) {
        run = row.metrics.CreateTweet! > 0 ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
      return `${longest} ${longest === 1 ? 'DAY' : 'DAYS'}`;
    }
    if (key === 'engagementRate') {
      const engagements = field('Engagements'), impressions = field('Impressions');
      return engagements == null || impressions == null || impressions <= 0 ? '—' : `${(engagements / impressions * 100).toFixed(1)}%`;
    }
    const source: Record<string, string> = { followers: 'Follows', posts: 'CreateTweet', replies: 'CreateReply', impressions: 'Impressions', likes: 'Likes', profileVisits: 'ProfileVisits' };
    const n = field(source[key]!);
    return n == null ? '—' : key === 'followers' ? signed(n) : fmt(n);
  };
  const base = receiptFromReport(r, { day: r.daySuggested, metrics: [], history: opts.history });
  const rows = opts.metrics.map((key) => ({ key, label: key === 'impressions' ? 'IMPRESSIONS' : METRICS.find((m) => m.key === key)!.label, value: value(key) }));
  const dayRange = !opts.dayOne ? null : opts.dayOne > end ? 'BEFORE DAY 1'
    : opts.dayOne > start ? `DAY 1 STARTED ${short(opts.dayOne)} · THROUGH DAY ${daysBetween(opts.dayOne, end) + 1}`
      : `DAYS ${daysBetween(opts.dayOne, start) + 1}–${daysBetween(opts.dayOne, end) + 1}`;
  const month = MONTHS[Number(today.slice(5, 7)) - 1]!;
  const title = opts.kind === 'week' ? 'LAST 7 DAYS' : month;
  const coverage = `${complete.length} of ${expected} complete UTC days captured${opts.kind === 'month' ? ' · month to date' : ''} · today excluded`;
  const datesText = expected ? `${short(start)}${start.slice(0, 4) === end.slice(0, 4) ? '' : ` ${start.slice(0, 4)}`}–${short(end)} ${end.slice(0, 4)} UTC` : `${month} ${today.slice(0, 4)} · starts tomorrow UTC`;
  const hasNumber = rows.some((row) => row.value !== '—');
  const lastCapture = complete.at(-1)?.capturedAt;
  return {
    ...base,
    no: opts.kind === 'week' ? `W${end.replaceAll('-', '')}` : `M${today.slice(0, 7).replace('-', '')}`,
    rows,
    total: null,
    followersTotal: null,
    time: lastCapture ? `${lastCapture.slice(11, 16)} UTC` : '—',
    stampDate: lastCapture ? `${lastCapture.slice(8, 10)}.${lastCapture.slice(5, 7)}.${lastCapture.slice(2, 4)}` : base.stampDate,
    record: false,
    captured: hasNumber && completeWindow,
    period: { kind: opts.kind, title: opts.kind === 'month' ? `${month} ${today.slice(0, 4)}` : title, dates: datesText, dayRange, coverage },
  };
}
