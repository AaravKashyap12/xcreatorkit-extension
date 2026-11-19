import { describe, expect, it } from 'vitest';
import { bucketCells, calendarRange, changeOver, dayValue, figureOver, ratioOver, rollingAvg, runningTotal, topDaysBy, type DailyRow } from '../src/analytics/series';

// SYNTHETIC daily rows only.
const TODAY = '2026-10-30';
const row = (date: string, metrics: Record<string, number>, partial = false): DailyRow => ({ date, metrics, capturedAt: '2026-10-30T09:00:00.000Z', partial });
const full = (date: string, imp = 1000) => row(date, { Impressions: imp, Engagements: imp / 50, ProfileVisits: 10, Follows: 5, Unfollows: 2 });
const span = (end: string, n: number, f = full) => Array.from({ length: n }, (_, i) => f(new Date(Date.parse(end + 'T00:00:00Z') - (n - 1 - i) * 864e5).toISOString().slice(0, 10)));

describe('calendarRange', () => {
  it('ends yesterday (UTC) by default and lists every calendar day, captured or not', () => {
    const all = [...span('2026-10-29', 10), row(TODAY, { Impressions: 5 }, true)];
    all.splice(7, 1); // 27 Oct not captured
    const r = calendarRange(all, { days: 7, includeToday: false, today: TODAY });
    expect([r.start, r.end]).toEqual(['2026-10-23', '2026-10-29']);
    expect(r.cells).toHaveLength(7);
    expect(r.missing).toEqual(['2026-10-27']);
    expect(r.rows).toHaveLength(6);
    expect(r.excludedToday?.date).toBe(TODAY);
    expect(r.includesToday).toBe(false);
  });
  it('a gap never widens the range: 28 days means 28 calendar days', () => {
    const all = span('2026-10-29', 60).filter((_, i) => i % 3);
    const r = calendarRange(all, { days: 28, includeToday: false, today: TODAY });
    expect(r.cells).toHaveLength(28);
    expect(r.start).toBe('2026-10-02');
    expect(r.rows.length + r.missing.length).toBe(28);
  });
  it('today is opt-in and stays partial', () => {
    const all = [...span('2026-10-29', 7), row(TODAY, { Impressions: 5 }, true)];
    const r = calendarRange(all, { days: 7, includeToday: true, today: TODAY });
    expect(r.end).toBe(TODAY);
    expect(r.includesToday).toBe(true);
    expect(r.excludedToday).toBeNull();
    expect(bucketCells(r.cells, 'daily').at(-1)!.partial).toBe(true);
  });
  it('a stale partial capture from an earlier day stays incomplete after the calendar moves on', () => {
    // Read on 29 Oct while 29 Oct was in progress; it is now 30 Oct and nothing newer was read.
    const all = [...span('2026-10-28', 13), row('2026-10-29', { Impressions: 300, Engagements: 3 }, true)];
    const r = calendarRange(all, { days: 7, includeToday: false, today: TODAY });
    expect(r.end).toBe('2026-10-29');
    expect(r.incomplete).toEqual(['2026-10-29']);
    expect(r.excludedToday).toBeNull();
    expect(bucketCells(r.cells, 'daily').at(-1)!.partial).toBe(true);
    expect(changeOver(r.cells, r.prev, 'Impressions')).toEqual({ kind: 'none' });
    expect(topDaysBy(r.rows, 'Impressions').map((x) => x.date)).not.toContain('2026-10-29');
  });
  it('"all" spans first to last captured day with gaps, keeping captured zero days', () => {
    const all = [row('2026-10-01', { Impressions: 0 }), row('2026-10-02', { Impressions: 0 }), full('2026-10-03'), full('2026-10-06')];
    const r = calendarRange(all, { days: 'all', includeToday: false, today: TODAY });
    expect([r.start, r.end, r.cells.length, r.missing, r.prev]).toEqual(['2026-10-01', '2026-10-06', 6, ['2026-10-04', '2026-10-05'], null]);
    expect(calendarRange([], { days: 'all', includeToday: false, today: TODAY }).cells).toEqual([]);
  });
  it('an all-zero capture is real coverage, not an absent one', () => {
    const zeros = span('2026-10-29', 5, (d) => row(d, { Impressions: 0, Engagements: 0, Follows: 0, Unfollows: 0 }));
    const r = calendarRange(zeros, { days: 'all', includeToday: false, today: TODAY });
    expect([r.cells.length, r.missing.length]).toEqual([5, 0]);
    expect(figureOver(r.cells, 'Impressions')).toEqual({ value: 0, days: 5, of: 5 });
    expect(figureOver(r.cells, 'NetFollows')).toEqual({ value: 0, days: 5, of: 5 });
    expect(figureOver(r.cells, 'EngagementRate')).toEqual({ value: null, days: 5, of: 5 });
    const w = calendarRange(zeros, { days: 7, includeToday: false, today: TODAY });
    expect([w.rows.length, w.missing.length, figureOver(w.cells, 'Impressions').value]).toEqual([5, 2, 0]);
  });
});

describe('figures over a range', () => {
  it('counts add only days that reported the field; coverage says how many', () => {
    const cells = [{ date: 'a', row: full('2026-10-01') }, { date: 'b', row: null }, { date: 'c', row: row('2026-10-03', { Impressions: 7 }) }];
    expect(figureOver(cells, 'Impressions')).toEqual({ value: 1007, days: 2, of: 3 });
    expect(figureOver(cells, 'ProfileVisits')).toEqual({ value: 10, days: 1, of: 3 });
    expect(figureOver(cells, 'Likes')).toEqual({ value: null, days: 0, of: 3 });
  });
  it('net follows needs both fields on the same day', () => {
    const cells = [{ date: 'a', row: row('2026-10-01', { Follows: 9 }) }, { date: 'b', row: row('2026-10-02', { Follows: 4, Unfollows: 1 }) }];
    expect(figureOver(cells, 'NetFollows')).toEqual({ value: 3, days: 1, of: 2 });
    expect(figureOver(cells.slice(0, 1), 'NetFollows').value).toBeNull();
    expect(dayValue(cells[0]!.row, 'NetFollows')).toBeNull();
  });
  it('engagement rate is weighted over days with both fields, and null for a zero denominator', () => {
    const cells = [
      { date: 'a', row: row('2026-10-01', { Impressions: 1000, Engagements: 10 }) },
      { date: 'b', row: row('2026-10-02', { Impressions: 100, Engagements: 50 }) },
      { date: 'c', row: row('2026-10-03', { Impressions: 5000 }) }, // no engagements: left out of both sides
    ];
    expect(figureOver(cells, 'EngagementRate').value).toBeCloseTo(60 / 1100);
    expect(figureOver(cells, 'EngagementRate').days).toBe(2);
    expect(figureOver([{ date: 'z', row: row('2026-10-04', { Impressions: 0, Engagements: 0 }) }], 'EngagementRate').value).toBeNull();
    expect(ratioOver(cells, 'Engagements', 'Impressions', 1000).value).toBeCloseTo(60_000 / 1100);
    expect(ratioOver([{ date: 'z', row: row('2026-10-04', { Impressions: 0, ProfileVisits: 3 }) }], 'ProfileVisits', 'Impressions').value).toBeNull();
  });
});

describe('changeOver', () => {
  const all = span('2026-10-29', 14);
  const r = calendarRange(all, { days: 7, includeToday: false, today: TODAY });
  it('compares complete equal ranges and names the prior dates', () => {
    expect(changeOver(r.cells, r.prev, 'Impressions')).toEqual({ kind: 'relative', value: 0, prevStart: '2026-10-16', prevEnd: '2026-10-22' });
  });
  it('rates change in percentage points; net follows by difference', () => {
    const lifted = all.map((x, i) => (i >= 7 ? { ...x, metrics: { ...x.metrics, Engagements: x.metrics.Engagements! * 2, Follows: 1 } } : x));
    const s = calendarRange(lifted, { days: 7, includeToday: false, today: TODAY });
    const pts = changeOver(s.cells, s.prev, 'EngagementRate');
    expect(pts.kind).toBe('points');
    expect(pts.kind === 'points' && pts.value).toBeCloseTo(2);
    expect(changeOver(s.cells, s.prev, 'NetFollows')).toMatchObject({ kind: 'difference', value: -28 });
  });
  it('no comparison with a missing day, a missing field, a partial day or no prior range', () => {
    const gap = all.filter((x) => x.date !== '2026-10-18');
    const g = calendarRange(gap, { days: 7, includeToday: false, today: TODAY });
    expect(changeOver(g.cells, g.prev, 'Impressions').kind).toBe('none');
    const noField = all.map((x) => (x.date === '2026-10-20' ? row(x.date, { Impressions: 1 }) : x));
    const f = calendarRange(noField, { days: 7, includeToday: false, today: TODAY });
    expect(changeOver(f.cells, f.prev, 'Impressions').kind).toBe('relative');
    expect(changeOver(f.cells, f.prev, 'ProfileVisits').kind).toBe('none');
    const withToday = calendarRange([...all, row(TODAY, { Impressions: 1 }, true)], { days: 7, includeToday: true, today: TODAY });
    expect(changeOver(withToday.cells, withToday.prev, 'Impressions').kind).toBe('none');
    const a = calendarRange(all, { days: 'all', includeToday: false, today: TODAY });
    expect(changeOver(a.cells, a.prev, 'Impressions').kind).toBe('none');
  });
  it('a zero prior gives no percentage', () => {
    const z = all.map((x, i) => (i < 7 ? row(x.date, { ...x.metrics, ProfileVisits: 0 }) : x));
    const s = calendarRange(z, { days: 7, includeToday: false, today: TODAY });
    expect(changeOver(s.cells, s.prev, 'ProfileVisits')).toMatchObject({ kind: 'prior-zero' });
  });
});

describe('buckets, averages and totals over calendar cells', () => {
  it('weekly buckets start Monday and are partial when cut, gapped or in progress', () => {
    const all = span('2026-10-29', 21).filter((x) => x.date !== '2026-10-21');
    const r = calendarRange(all, { days: 21, includeToday: false, today: TODAY });
    const b = bucketCells(r.cells, 'weekly');
    expect(b.map((x) => x.key)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(b.map((x) => x.partial)).toEqual([true, false, true, true]);
    expect(figureOver(b[2]!.cells, 'Impressions')).toEqual({ value: 6000, days: 6, of: 7 });
  });
  it('monthly buckets know the month length', () => {
    const r = calendarRange(span('2026-10-29', 45), { days: 'all', includeToday: false, today: TODAY });
    const b = bucketCells(r.cells, 'monthly');
    expect(b.map((x) => [x.key, x.cells.length, x.expected, x.partial])).toEqual([['2026-09-01', 16, 30, true], ['2026-10-01', 29, 31, true]]);
  });
  it('the 7-day average needs seven consecutive captured days', () => {
    const all = span('2026-10-29', 14).filter((x) => x.date !== '2026-10-23');
    const r = calendarRange(all, { days: 14, includeToday: false, today: TODAY });
    const avg = rollingAvg(r.cells.map((c) => dayValue(c.row, 'Impressions')), 7);
    expect(avg.slice(0, 6).every((v) => v == null)).toBe(true);
    expect(avg[6]).toBe(1000);
    expect(avg.slice(7, 14).every((v) => v == null)).toBe(true); // 23 Oct sits in every later window
  });
  it('running totals skip missing days without restarting', () => {
    expect(runningTotal([5, null, 3, 0])).toEqual([5, null, 8, 8]);
  });
  it('top days rank by any figure, never partial or unreported days', () => {
    const rows = [full('2026-10-01', 10), row('2026-10-02', { Follows: 9, Unfollows: 0 }), row('2026-10-03', { Follows: 99, Unfollows: 0 }, true), full('2026-10-04', 20)];
    expect(topDaysBy(rows, 'NetFollows').map((r) => r.date)).toEqual(['2026-10-02', '2026-10-01', '2026-10-04']);
    expect(topDaysBy(rows, 'Impressions').map((r) => r.date)).toEqual(['2026-10-04', '2026-10-01']);
  });
});
