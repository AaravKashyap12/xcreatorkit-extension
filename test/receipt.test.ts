import { describe, expect, it } from 'vitest';
import { addDays, buildReport } from '../src/analytics/report';
import type { DailyRow } from '../src/analytics/series';
import { parseFigure } from '../src/receipt/figure';
import { receiptFromReport } from '../src/receipt/fromReport';
import { recapFromReport } from '../src/receipt/recap';
import { DEFAULT_METRICS, MAX_ROWS, METRICS, sampleFor } from '../src/receipt/data';
import { obs, settings } from './helpers';

// SYNTHETIC data only.
const s = settings({ reportingTimeZone: 'UTC' });
const CAP = '2026-10-02T16:48:00.000Z';
const NOW = new Date('2026-10-02T18:00:00Z');

function series(n: number, today: Record<string, number>, earlierFollows = 3): DailyRow[] {
  return Array.from({ length: n }, (_, i) => {
    const date = addDays('2026-10-02', -(n - 1 - i));
    const isToday = i === n - 1;
    const metrics: Record<string, number> = isToday ? today : { Impressions: 1000, Engagements: 20, Follows: earlierFollows, CreateTweet: 2, CreateReply: 10 };
    return { date, metrics, capturedAt: CAP, partial: isToday };
  });
}
const report = (daily: DailyRow[], observations = [] as ReturnType<typeof obs>[]) =>
  buildReport({ handle: 'byaarav', settings: s, observations, attempts: [], daily, analyticsCapturedAt: CAP, days: 1, anchor: 'today', now: NOW });
const TODAY = { Impressions: 38420, Engagements: 1614, Follows: 24, CreateTweet: 6, CreateReply: 87, Likes: 1212, ProfileVisits: 310 };
const ALL = METRICS.map((m) => m.key);

describe('parseFigure', () => {
  it.each([
    ['+29,100', { prefix: '+', value: 29100, suffix: '', decimals: 0, grouping: true }],
    ['≈−1,200', { prefix: '≈−', value: 1200, suffix: '', decimals: 0, grouping: true }],
    ['4.2%', { prefix: '', value: 4.2, suffix: '%', decimals: 1, grouping: false }],
    ['87', { prefix: '', value: 87, suffix: '', decimals: 0, grouping: false }],
  ])('%s', (text, want) => expect(parseFigure(text)).toEqual(want));

  it('leaves non-numbers alone', () => {
    expect(parseFigure('—')).toBeNull();
    expect(parseFigure('109.2K')).toMatchObject({ value: 109.2, suffix: 'K' });
  });
});

describe('receiptFromReport', () => {
  it('keeps legacy and current UTC rewards readings as separate receipt checkpoints', () => {
    const legacy = obs('100.0K', '2026-10-08T23:30:00Z', { reportingTimeZone: 'Asia/Kolkata', reportingDate: '2026-10-09' });
    const current = obs('101.0K', '2026-10-09T12:00:00Z', { reportingTimeZone: 'UTC', reportingDate: '2026-10-09' });
    const readings = [legacy, current];
    const r = buildReport({ handle: 'byaarav', settings: s, observations: readings, attempts: [], daily: [], analyticsCapturedAt: null, days: 1, anchor: 'today', now: new Date('2026-10-09T13:00:00Z') });
    const d = receiptFromReport(r, { day: 39, metrics: ['impressionsDelta'], history: [], observations: readings });
    expect(r.rewards?.history.map((point) => point.date)).toEqual(['2026-10-08', '2026-10-09']);
    expect(d.rows[0]?.value).toBe('≈+1,000');
    expect(legacy.reportingDate).toBe('2026-10-09');
  });
  it("maps today's UTC row onto the chosen lines, in the chosen order", () => {
    const d = receiptFromReport(report(series(10, TODAY)), { day: 32, metrics: ['replies', 'followers', 'likes', 'engagementRate'], history: series(10, TODAY) });
    expect(d.rows).toEqual([
      { key: 'replies', label: 'REPLIES', value: '87' },
      { key: 'followers', label: 'NEW FOLLOWERS', value: '+24' },
      { key: 'likes', label: 'LIKES', value: '1,212' },
      { key: 'engagementRate', label: 'ENGAGEMENT RATE', value: '4.2%' },
    ]);
    expect(d).toMatchObject({ handle: 'byaarav', day: 32, no: '0032', date: '2 OCT 2026', stampDate: '02.10.26' });
  });

  it('shows "—" for anything X did not report, never zero', () => {
    const d = receiptFromReport(report(series(10, { Impressions: 500 })), { day: 32, metrics: ALL.slice(0, 4), history: [] });
    expect(d.rows.map((r) => r.value)).toEqual(['—', '—', '—', '—']);
  });

  it('negative follows print with a real minus sign', () => {
    const d = receiptFromReport(report(series(10, { ...TODAY, Follows: -4 })), { day: 32, metrics: ['followers'], history: [] });
    expect(d.rows[0]!.value).toBe('−4');
  });

  it('without a rewards reading: analytics remains captured, no total or rewards change', () => {
    const d = receiptFromReport(report(series(10, TODAY)), { day: 32, metrics: ['impressionsDelta'], history: [] });
    expect(d.total).toBeNull();
    expect(d.captured).toBe(false);
    expect(d.rows[0]!.value).toBe('—');
    expect(receiptFromReport(report(series(10, TODAY)), { day: 32, metrics: ['followers'], history: [] }).captured).toBe(true);
  });

  it('with captured rewards readings: total, progress below 100%, change vs yesterday, captured stamp', () => {
    const readings = [obs('100K', '2026-09-30T18:00:00Z'), obs('101.2K', '2026-10-01T18:00:00Z'), obs('104.5K', '2026-10-02T16:00:00Z')];
    const d = receiptFromReport(report(series(10, TODAY), readings), { day: 32, metrics: ['impressionsDelta'], history: [], observations: readings });
    expect(d.captured).toBe(true);
    expect(d.total).toMatchObject({ value: 104500, text: '104.5K', target: '500K', pct: 20 });
    expect(d.rows[0]!.value).toMatch(/^≈?\+3,300$/);
    expect(d.time).toBe('16:00 UTC');
  });

  it('uses the analytics UTC date even when a rewards reading is stale', () => {
    const readings = [obs('100K', '2026-09-30T18:00:00Z')];
    const d = receiptFromReport(report(series(10, TODAY), readings), { day: 32, metrics: ['followers'], history: [], observations: readings });
    expect(d.date).toBe('2 OCT 2026');
    expect(d.stampDate).toBe('02.10.26');
    expect(d.time).toBe('16:48 UTC');
    const onlyRewards = receiptFromReport(report([], readings), { day: 32, metrics: ['followers'], history: [], observations: readings });
    expect(onlyRewards.date).toBe('2 OCT 2026');
    expect(onlyRewards.stampDate).toBe('30.09.26');
  });

  it('withholds the stamp for manual latest rewards, mixed reward delta history and manual follower totals', () => {
    const captured = obs('100K', '2026-10-01T18:00:00Z');
    const manual = obs('104K', '2026-10-02T16:00:00Z', { provenance: 'manual' });
    const mixed = receiptFromReport(report(series(10, TODAY), [captured, manual]), { day: 32, metrics: ['impressionsDelta'], history: [], observations: [captured, manual] });
    expect(mixed.rows[0]!.value).not.toBe('—');
    expect(mixed.captured).toBe(false);
    const olderManual = obs('100K', '2026-10-01T18:00:00Z', { provenance: 'manual' });
    const latest = obs('104K', '2026-10-02T16:00:00Z');
    expect(receiptFromReport(report(series(10, TODAY), [olderManual, latest]), { day: 32, metrics: ['impressionsDelta'], history: [], observations: [olderManual, latest] }).captured).toBe(false);
    expect(receiptFromReport(report(series(10, TODAY), [olderManual, latest]), { day: 32, metrics: ['followers'], history: [], observations: [olderManual, latest] }).captured).toBe(true);
    const follower = obs('1,096', '2026-10-02T16:00:00Z', { metric: 'followers_total', provenance: 'manual' });
    expect(receiptFromReport(report(series(10, TODAY), [follower]), { day: 32, metrics: ['followers'], history: [], observations: [follower] }).captured).toBe(false);
  });

  it('does not stamp missing-only lines or a sample', () => {
    expect(receiptFromReport(report([]), { day: 32, metrics: ['followers'], history: [] }).captured).toBe(false);
    expect(sampleFor(['followers']).captured).toBe(false);
  });

  it('NEW RECORD needs a week of history and must beat every earlier day', () => {
    const days = series(10, TODAY);
    expect(receiptFromReport(report(days), { day: 32, metrics: ['followers'], history: days }).record).toBe(true);
    const short = series(5, TODAY);
    expect(receiptFromReport(report(short), { day: 32, metrics: ['followers'], history: short }).record).toBe(false);
    const beaten = series(10, TODAY, 40);
    expect(receiptFromReport(report(beaten), { day: 32, metrics: ['followers'], history: beaten }).record).toBe(false);
  });
});

describe('recapFromReport', () => {
  const recap = (kind: 'week' | 'month', rows: DailyRow[], metrics: typeof ALL, dayOne: string | null = '2026-09-25') =>
    recapFromReport(report(rows), { kind, metrics, history: rows, dayOne });

  it('sums seven complete UTC days, derives total engagement rate and labels its rolling window', () => {
    const rows = series(10, TODAY);
    const d = recap('week', rows, ['followers', 'posts', 'impressions', 'engagementRate', 'bestDay', 'daysPosted', 'streak']);
    expect(d.period).toMatchObject({ kind: 'week', title: 'LAST 7 DAYS', dayRange: 'DAYS 1–7' });
    expect(d.period?.dates).toBe('25 SEP–1 OCT 2026 UTC');
    expect(d.period?.coverage).toBe('7 of 7 complete UTC days captured · today excluded');
    expect(d.rows.map((row) => row.value)).toEqual(['+21', '14', '7,000', '2.0%', '25 SEP · 1,000', '7', '7 DAYS']);
    expect(d.rows[2]!.label).toBe('IMPRESSIONS');
    expect(d.captured).toBe(true);
  });

  it('month to date excludes today and shows a partial calendar month honestly', () => {
    const d = recap('month', series(10, TODAY), ['posts', 'engagementRate'], '2026-10-01');
    expect(d.period).toMatchObject({ title: 'OCTOBER 2026', dates: '1 OCT–1 OCT 2026 UTC', dayRange: 'DAYS 1–1' });
    expect(d.period?.coverage).toBe('1 of 1 complete UTC days captured · month to date · today excluded');
    expect(d.rows.map((row) => row.value)).toEqual(['2', '2.0%']);
  });

  it('has no complete month-to-date day on the first UTC date of a month', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const r = buildReport({ handle: 'byaarav', settings: s, observations: [], attempts: [], daily: [], analyticsCapturedAt: null, days: 1, anchor: 'today', now });
    const d = recapFromReport(r, { kind: 'month', metrics: ['posts', 'engagementRate'], history: [], dayOne: '2026-10-01' });
    expect(d.period?.coverage).toBe('0 of 0 complete UTC days captured · month to date · today excluded');
    expect(d.period?.dates).toBe('NOVEMBER 2026 · starts tomorrow UTC');
    expect(d.rows.map((row) => row.value)).toEqual(['—', '—']);
    expect(d.captured).toBe(false);
  });

  it('keeps a Day 1 inside the window meaningful and refuses partial or missing days', () => {
    const rows = series(10, TODAY);
    const inside = recap('week', rows, ['posts'], '2026-09-29');
    expect(inside.period?.dayRange).toBe('DAY 1 STARTED 29 SEP · THROUGH DAY 3');
    const missing = recap('week', rows.filter((row) => row.date !== '2026-09-27'), ['posts', 'bestDay', 'daysPosted', 'streak']);
    expect(missing.period?.coverage).toContain('6 of 7');
    expect(missing.rows.every((row) => row.value === '—')).toBe(true);
    expect(missing.captured).toBe(false);
    const partial = rows.map((row) => row.date === '2026-10-01' ? { ...row, partial: true } : row);
    expect(recap('week', partial, ['posts']).rows[0]!.value).toBe('—');
  });

  it('requires every metric field; a missing key is never a zero', () => {
    const rows = series(10, TODAY).map((row) => row.date === '2026-09-27' ? { ...row, metrics: { Impressions: 1000 } } : row);
    const d = recap('week', rows, ['posts', 'impressions', 'engagementRate', 'daysPosted', 'streak']);
    expect(d.rows.map((row) => row.value)).toEqual(['—', '7,000', '—', '—', '—']);
  });

  it('labels a rolling week across a UTC year boundary without an ISO week number', () => {
    const now = new Date('2027-01-03T18:00:00Z');
    const rows = Array.from({ length: 7 }, (_, i) => ({ date: addDays('2026-12-27', i), metrics: { Impressions: 100 }, capturedAt: now.toISOString(), partial: false }));
    const r = buildReport({ handle: 'byaarav', settings: s, observations: [], attempts: [], daily: rows, analyticsCapturedAt: now.toISOString(), days: 1, anchor: 'today', now });
    const d = recapFromReport(r, { kind: 'week', metrics: ['impressions'], history: rows, dayOne: '2026-12-27' });
    expect(d.period?.dates).toBe('27 DEC 2026–2 JAN 2027 UTC');
    expect(d.period?.coverage).toContain('7 of 7');
    expect(d.rows[0]!.value).toBe('700');
  });

  it('passes period title, coverage and rows through the one renderer for every scene', async () => {
    const { renderScene } = await import('../src/receipt/scenes');
    const d = recap('week', series(10, TODAY), ['impressions', 'bestDay']);
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const html = renderScene(id, 0, d);
      expect(html).toContain('LAST 7 DAYS');
      expect(html).toContain('7 of 7 complete UTC days captured');
      expect(html).toMatch(/best day · impressions/i);
      expect(html).toContain('data-scene=');
    }
  });
});

describe('sample receipt', () => {
  it('has a value for every metric so any combination previews', () => {
    expect(sampleFor(ALL).rows.every((r) => r.value && r.value !== '—')).toBe(true);
    expect(sampleFor(DEFAULT_METRICS).rows).toHaveLength(MAX_ROWS);
  });
});

describe('reached target wording', () => {
  it('prints "REACHED ✓" rather than "IN REACHED" once the target is hit', async () => {
    const { renderScene } = await import('../src/receipt/scenes');
    const d = { ...sampleFor(DEFAULT_METRICS), total: { value: 512_400, text: '512.4K', target: '500K', pct: 100, eta: 'REACHED' } };
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const html = renderScene(id, 0, d);
      expect(html).not.toMatch(/IN REACHED|in reached/);
      expect(html).toMatch(/REACHED ✓|reached ✓/);
    }
  });
});
