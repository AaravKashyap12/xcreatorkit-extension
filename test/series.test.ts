import { describe, expect, it } from 'vitest';
import {
  bucketize,
  emptySeries,
  engagementRate,
  mergeRows,
  missingDates,
  rollingAvg,
  rowsFromCapture,
  selectWindow,
  sortedRows,
  topDays,
  trimLeadingZeros,
  valueOver,
  weekdayAverages,
  type DailyRow,
} from '../src/analytics/series';
import { emptyState, exportBackup, importBackup, saveDailyCapture } from '../src/store/state';

const day = (d: string) => Date.parse(d + 'T00:00:00Z');
const cap = new Date('2026-10-02T16:48:49Z');
// SYNTHETIC values shaped like X's currentMetricData.
const pts = (days: [string, number, number?][]) => days.map(([d, imp, eng = 0]) => ({ t: day(d), m: { Impressions: imp, Engagements: eng, EngagementRate: 0.5 } }));

describe('rowsFromCapture', () => {
  it('uses UTC days, marks today partial, keeps zeros, drops non-numbers', () => {
    const rows = rowsFromCapture([...pts([['2026-10-01', 8380], ['2026-10-02', 5081], ['2026-09-30', 0]]), { t: day('2026-09-29'), m: { Impressions: 1, Bad: NaN } as Record<string, number> }], cap);
    expect(rows.map((r) => r.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(rows.map((r) => r.partial)).toEqual([false, false, false, true]);
    expect(rows[1]!.metrics.Impressions).toBe(0);
    expect(rows[0]!.metrics).not.toHaveProperty('Bad');
  });
});

describe('mergeRows', () => {
  it('newer captures replace older values; partial days finalize', () => {
    const s = emptySeries();
    const r = { from: 'a', to: 'b' };
    mergeRows(s, rowsFromCapture(pts([['2026-10-02', 5081]]), cap), r, cap);
    const later = new Date('2026-10-03T09:00:00Z');
    const rep = mergeRows(s, rowsFromCapture(pts([['2026-10-02', 9100], ['2026-10-03', 400]]), later), r, later);
    expect(rep).toEqual({ added: 1, updated: 1, unchanged: 0 });
    expect(s.rows['2026-10-02']).toMatchObject({ partial: false, metrics: { Impressions: 9100 } });
    expect(s.rows['2026-10-03']!.partial).toBe(true);
  });
  it('an older capture never overwrites a newer one', () => {
    const s = emptySeries();
    const r = { from: 'a', to: 'b' };
    const later = new Date('2026-10-03T09:00:00Z');
    mergeRows(s, rowsFromCapture(pts([['2026-10-01', 8400]]), later), r, later);
    mergeRows(s, rowsFromCapture(pts([['2026-10-01', 8000]]), cap), r, cap);
    expect(s.rows['2026-10-01']!.metrics.Impressions).toBe(8400);
  });
});

function rows(n: number, end = '2026-10-01', f = (i: number) => 100 + i): DailyRow[] {
  const e = day(end);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(e - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const imp = f(i);
    return { date: d, metrics: { Impressions: imp, Engagements: imp ? 10 : 0 }, capturedAt: cap.toISOString(), partial: false };
  });
}

describe('windows', () => {
  it('excludes the partial day by default and compares with a fully covered prior window', () => {
    const all = [...rows(14), { date: '2026-10-02', metrics: { Impressions: 5 }, capturedAt: cap.toISOString(), partial: true }];
    const w = selectWindow(all, { days: 7, includePartial: false });
    expect(w.rows).toHaveLength(7);
    expect(w.end).toBe('2026-10-01');
    expect(w.excludedPartial?.date).toBe('2026-10-02');
    expect(w.prev).toHaveLength(7);
  });
  it('no comparison when the prior window is incomplete', () => {
    expect(selectWindow(rows(10), { days: 7, includePartial: false }).prev).toBeNull();
  });
  it('no comparison across a missing day', () => {
    const r = rows(14);
    r.splice(3, 1);
    expect(missingDates(r)).toHaveLength(1);
    expect(selectWindow(r, { days: 7, includePartial: false }).prev).toBeNull();
  });
  it('"all" trims X’s leading zero padding', () => {
    const r = rows(10, '2026-10-01', (i) => (i < 4 ? 0 : 50));
    expect(selectWindow(r, { days: 'all', includePartial: false }).rows).toHaveLength(6);
    expect(trimLeadingZeros(r)[0]!.metrics.Impressions).toBe(50);
  });
});

describe('derived values', () => {
  it('keeps absent metrics distinct from explicit captured zeros', () => {
    const r = rows(2);
    r[0]!.metrics.Likes = 0;
    expect(valueOver(r.slice(0, 1), 'Likes')).toBe(0);
    expect(valueOver(r, 'Likes')).toBeNull();
    expect(valueOver([], 'Likes')).toBeNull();
    delete r[1]!.metrics.Engagements;
    expect(engagementRate(r)).toBeNull();
    expect(weekdayAverages(r, 'Likes').reduce((n, d) => n + d.n, 0)).toBe(1);
    expect(topDays(r, 'Likes')).toEqual([r[0]]);
  });
  it('does not average across an absent metric', () => {
    expect(rollingAvg([1, null, 3, 0, 6], 3)).toEqual([null, null, null, null, 3]);
  });
  it('engagement rate is recomputed from totals, never summed', () => {
    const r = [
      { date: '2026-10-01', metrics: { Impressions: 1000, Engagements: 10, EngagementRate: 0.01 }, capturedAt: '', partial: false },
      { date: '2026-10-02', metrics: { Impressions: 100, Engagements: 50, EngagementRate: 0.5 }, capturedAt: '', partial: false },
    ];
    expect(engagementRate(r)).toBeCloseTo(60 / 1100);
    expect(valueOver(r, 'EngagementRate')).toBeCloseTo(60 / 1100);
    expect(valueOver(r, 'Impressions')).toBe(1100);
    expect(valueOver(r, 'VideoCompletionRate')).toBeNull();
  });
  it('engagement rate is null (not 0) with no impressions', () => {
    expect(engagementRate([{ date: '2026-10-01', metrics: { Impressions: 0, Engagements: 0 }, capturedAt: '', partial: false }])).toBeNull();
  });
  it('rolling average waits for a full window', () => {
    expect(rollingAvg([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });
  it('weekly buckets start Monday (UTC) and flag incomplete weeks', () => {
    const b = bucketize(rows(10, '2026-10-01'), 'weekly'); // 22 Sep (Tue) .. 1 Oct (Thu)
    expect(b.map((x) => x.key)).toEqual(['2026-09-21', '2026-09-28']);
    expect(b.map((x) => x.partial)).toEqual([true, true]);
    expect(b[0]!.rows).toHaveLength(6);
  });
  it('monthly buckets', () => {
    const b = bucketize(rows(40, '2026-10-01'), 'monthly');
    expect(b.map((x) => x.key)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    expect(b[1]!.partial).toBe(false);
  });
  it('weekday averages and top days skip partial days', () => {
    const r = [...rows(14), { date: '2026-10-02', metrics: { Impressions: 999999 }, capturedAt: '', partial: true }];
    expect(topDays(r, 'Impressions', 1)[0]!.date).not.toBe('2026-10-02');
    expect(weekdayAverages(r, 'Impressions').reduce((s, d) => s + d.n, 0)).toBe(14);
  });
});

describe('store integration', () => {
  it('daily series are account-scoped and survive backup round-trip', () => {
    const s = emptyState();
    saveDailyCapture(s, 'byaarav', 'all', rowsFromCapture(pts([['2026-10-01', 8380]]), cap), { from: 'a', to: 'b' }, cap);
    saveDailyCapture(s, 'other', 'all', rowsFromCapture(pts([['2026-10-01', 1]]), cap), { from: 'a', to: 'b' }, cap);
    expect(sortedRows(s.accounts.byaarav!.daily!.all)[0]!.metrics.Impressions).toBe(8380);
    const b = emptyState();
    const rep = importBackup(b, exportBackup(s, cap));
    expect(rep.dailyRows).toBe(2);
    expect(sortedRows(b.accounts.byaarav!.daily!.all)[0]!.metrics.Impressions).toBe(8380);
    expect(sortedRows(b.accounts.other!.daily!.all)[0]!.metrics.Impressions).toBe(1);
  });
  it('malformed daily rows are rejected on import', () => {
    const bad = { kind: 'xgd-backup', schemaVersion: 1, accounts: { byaarav: { observations: [], daily: { all: { rows: { '2026-10-01': { date: '2026-10-02', metrics: {}, capturedAt: cap.toISOString(), partial: false }, '2026-10-03': { date: '2026-10-03', metrics: { Impressions: 'x' }, capturedAt: cap.toISOString(), partial: false } } } } } } };
    const s = emptyState();
    const rep = importBackup(s, JSON.stringify(bad));
    expect(rep.rejected).toBe(2);
    expect(rep.dailyRows).toBe(0);
  });
});
