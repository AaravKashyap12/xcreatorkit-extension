import { describe, expect, it } from 'vitest';
import { addDays, buildReport, type RangeDays } from '../src/analytics/report';
import type { DailyRow } from '../src/analytics/series';
import { obs, settings } from './helpers';

// SYNTHETIC daily rows, keyed by UTC day like X's buckets.
const s = settings({ reportingTimeZone: 'Asia/Calcutta' });

/** n rows ending at `end` (inclusive). The `end` row is partial if `endPartial`. */
function series(end: string, n: number, f: (i: number, date: string) => Partial<Record<string, number>>, capturedAt: string, endPartial = true): DailyRow[] {
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(end, -(n - 1 - i));
    const metrics = { Impressions: 0, Engagements: 0, ProfileVisits: 0, Follows: 0, Unfollows: 0, ...f(i, date) } as Record<string, number>;
    return { date, metrics, capturedAt, partial: endPartial && i === n - 1 };
  });
}
const CAP = '2026-10-02T16:48:00.000Z';
const NOW = new Date('2026-10-02T18:00:00Z');
const rep = (daily: DailyRow[], days: RangeDays, now = NOW, capturedAt: string | null = CAP, observations = [] as ReturnType<typeof obs>[]) =>
  buildReport({ handle: 'byaarav', settings: s, observations, attempts: [], daily, analyticsCapturedAt: capturedAt, days, now });

// 120 days ending today (2 Oct, partial): 1,000/day, today 600 so far.
const base = series('2026-10-02', 120, (_i, d) => ({ Impressions: d === '2026-10-02' ? 600 : 1000, Engagements: 20, ProfileVisits: 2, Follows: 3, Unfollows: 1 }), CAP);

describe('calendar ranges ending today (UTC)', () => {
  it.each([
    [1, '2026-10-02'],
    [7, '2026-09-26'],
    [30, '2026-09-03'],
    [90, '2026-07-05'],
  ] as const)('%iD = today plus the preceding days, starting %s', (days, start) => {
    const r = rep(base, days);
    expect(r.range.start).toBe(start);
    expect(r.range.end).toBe('2026-10-02');
    expect(r.range.cells).toHaveLength(days);
    expect(r.range.cells.at(-1)).toMatchObject({ date: '2026-10-02', isToday: true, partial: true });
    expect(r.range.todayStatus).toBe('in_progress');
    expect(r.range.todayAsOf).toBe(CAP);
  });

  it('values include today so far; changes use complete days only (6 vs prior 6 for 7D)', () => {
    const r = rep(base, 7);
    const imp = r.kpis.find((k) => k.key === 'Impressions')!;
    expect(imp.value).toBe(6 * 1000 + 600);
    expect(r.comparison).toEqual({ available: true, days: 6, cur: { start: '2026-09-26', end: '2026-10-01' }, prev: { start: '2026-09-20', end: '2026-09-25' } });
    expect(imp.basisCur).toBe(6000);
    expect(imp.basisPrev).toBe(6000);
    expect(imp.change).toBe(0);
    // The partial day never gets a previous-period value to be compared against.
    expect(r.trend.at(-1)!.prev).toBeNull();
  });

  it('Today (1D): today so far, no comparison, no intraday curve', () => {
    const r = rep(base, 1);
    expect(r.kpis.find((k) => k.key === 'Impressions')!.value).toBe(600);
    expect(r.comparison.available).toBe(false);
    expect(r.kpis.every((k) => k.change == null)).toBe(true);
    expect(r.momentum).toMatchObject({ kind: 'unavailable' });
    // Today: visits per 1K only; net follows are already in the waterfall.
    expect(r.efficiency).toMatchObject({ basis: 'today_so_far', visitsPer1k: { prev: null }, netFollows: null });
    expect(r.diagnostics.some((d) => /hourly/.test(d))).toBe(true);
    expect(r.trend).toEqual([{ date: '2026-10-02', cur: 600, prev: null, partial: true, missing: false, isToday: true }]);
    expect(r.peak).toBeNull();
  });
});

describe('missing current-day data', () => {
  const yesterdayCapture = '2026-10-01T22:00:00.000Z';
  const old = series('2026-10-01', 60, () => ({ Impressions: 1000, Follows: 2, Unfollows: 1 }), yesterdayCapture);
  it('shows today unavailable (null, not zero), keeps the previous capture and marks it stale', () => {
    const r = rep(old, 7, NOW, yesterdayCapture);
    expect(r.range.todayStatus).toBe('unavailable');
    expect(r.range.todayAsOf).toBeNull();
    expect(r.trend.at(-1)).toMatchObject({ date: '2026-10-02', cur: null, missing: true });
    expect(r.analytics.stale).toBe(true);
    expect(r.qualifiers).toContain('Today (2 Oct UTC) not captured.');
    // 1 Oct was captured before its day ended, so it is partial and blocks a like-for-like comparison.
    expect(r.comparison.available).toBe(false);
    // The curve ends on 1 Oct (captured mid-day), not "today".
    expect(r.momentum).toMatchObject({ through: '2026-10-01', endsPartial: true, endsToday: false });
  });
  it('Today view with no row for today: nothing invented', () => {
    const r = rep(old, 1, NOW, yesterdayCapture);
    expect(r.kpis).toEqual([]);
    expect(r.followers).toBeNull();
    expect(r.momentum).toBeNull();
    expect(r.trend[0]).toMatchObject({ cur: null, missing: true });
  });
});

describe('UTC midnight boundaries', () => {
  const lateCap = '2026-10-02T23:59:00.000Z';
  const daily = series('2026-10-02', 40, () => ({ Impressions: 1000 }), lateCap);
  it('just before UTC midnight, 2 Oct is today and in progress', () => {
    const r = rep(daily, 1, new Date('2026-10-02T23:59:30Z'), lateCap);
    expect(r.range.today).toBe('2026-10-02');
    expect(r.range.todayStatus).toBe('in_progress');
  });
  it('just after UTC midnight, today is 3 Oct (unavailable) and 2 Oct stays flagged partial', () => {
    const r = rep(daily, 7, new Date('2026-10-03T00:05:00Z'), lateCap);
    expect(r.range.today).toBe('2026-10-03');
    expect(r.range.todayStatus).toBe('unavailable');
    expect(r.trend.find((t) => t.date === '2026-10-02')).toMatchObject({ partial: true, cur: 1000 });
    expect(r.comparison.available).toBe(false);
  });
  it('local (IST) midnight does not move the UTC day: 00:30 IST on 3 Oct is still UTC 2 Oct', () => {
    const r = rep(daily, 1, new Date('2026-10-02T19:00:00Z'), lateCap);
    expect(r.range.today).toBe('2026-10-02');
  });
  it('Day N follows the UTC date, like X: 00:30 IST on 2 Oct is still UTC 1 Oct = Day 31', () => {
    const utcSettings = settings({ reportingTimeZone: 'UTC', cycleCutoffHour: 0 });
    const at = (iso: string) => buildReport({ handle: 'byaarav', settings: utcSettings, observations: [], attempts: [], daily: [], analyticsCapturedAt: null, days: 1, now: new Date(iso) });
    expect(at('2026-10-01T19:00:00Z')).toMatchObject({ reportingDate: '2026-10-01', daySuggested: 31 });
    expect(at('2026-10-02T19:00:00Z')).toMatchObject({ reportingDate: '2026-10-02', daySuggested: 32 });
    expect(at('2026-10-03T00:00:00Z')).toMatchObject({ reportingDate: '2026-10-03', daySuggested: 33 });
  });
});

describe('gaps and comparisons', () => {
  it('a missing day stays missing: no zero bar, no comparison, no cumulative curve', () => {
    const gappy = base.filter((r) => r.date !== '2026-09-29');
    const r = rep(gappy, 7);
    expect(r.trend.find((t) => t.date === '2026-09-29')).toMatchObject({ cur: null, missing: true });
    expect(r.range.missingDays).toEqual(['2026-09-29']);
    expect(r.comparison.available).toBe(false);
    expect(r.momentum).toMatchObject({ kind: 'unavailable' });
    expect(r.kpis.find((k) => k.key === 'Impressions')!.value).toBe(5 * 1000 + 600);
  });
  it('previous period not fully captured → no comparison', () => {
    const short = base.slice(-10); // 23 Sep .. 2 Oct
    const r = rep(short, 7);
    expect(r.comparison).toMatchObject({ available: false });
    expect(r.kpis.every((k) => k.change == null)).toBe(true);
  });
});

describe('followers and momentum', () => {
  it('cumulative net from 0, negatives preserved, ends with today so far', () => {
    const daily = series('2026-10-02', 20, (i) => ({ Impressions: 100, Follows: i === 16 ? 0 : 4, Unfollows: i === 16 ? 9 : 1 }), CAP);
    const r = rep(daily, 7);
    const mo = r.momentum as Extract<NonNullable<typeof r.momentum>, { points: unknown }>;
    expect(mo.kind).toBe('followers');
    expect(mo.points[0]).toEqual({ date: null, v: 0 });
    expect(mo.points.map((p) => p.v)).toEqual([0, 3, 6, 9, 0, 3, 6, 9]); // 26 Sep .. 2 Oct; 29 Sep is −9
    expect(mo.final).toBe(r.followers!.net);
    expect(mo.endsPartial).toBe(true);
    expect(mo.endsToday).toBe(true);
    expect(r.followers!.includesPartialToday).toBe(true);
  });
  it('no daily follow fields: no waterfall/efficiency; momentum falls back to cumulative account impressions', () => {
    const daily = series('2026-10-02', 20, () => ({ Impressions: 100 }), CAP).map((r) => {
      const { Follows: _f, Unfollows: _u, ...rest } = r.metrics;
      return { ...r, metrics: rest };
    });
    const r = rep(daily, 7);
    expect(r.followers).toBeNull();
    expect(r.efficiency).toBeNull();
    expect(r.momentum).toMatchObject({ kind: 'impressions', final: 700 });
  });
});

describe('rewards stay separate', () => {
  it('the same rolling 90-day reading regardless of range, and never another account', () => {
    const o = [obs('109.2K', '2026-10-02T16:00:00Z', { s }), obs('399.9K', '2026-10-02T16:30:00Z', { s, account: 'reference' })];
    for (const d of [1, 7, 30, 90] as const) expect(rep(base, d, NOW, CAP, o).rewards?.reading.displayText).toBe('109.2K');
    expect(rep(base, 7, NOW, CAP, o).qualifiers).toContain('Rewards figure is rounded by X.');
  });
  it('rewards history markers only with real readings on 2+ reporting days', () => {
    expect(rep(base, 7, NOW, CAP, [obs('109.2K', '2026-10-02T16:00:00Z', { s })]).rewards!.history).toEqual([]);
    const two = rep(base, 7, NOW, CAP, [obs('100.0K', '2026-10-01T10:00:00Z', { s }), obs('109.2K', '2026-10-02T16:00:00Z', { s })]);
    expect(two.rewards!.history.map((h) => h.displayText)).toEqual(['100.0K', '109.2K']);
  });
});

describe('Today adapts to available data', () => {
  it('conversation activity: likes + replies received and replies per 1K, same period; full types kept privately', () => {
    const daily = series('2026-10-02', 3, () => ({ Impressions: 6046, Engagements: 131, Likes: 69, Replies: 39, CreateReply: 66, Retweets: 1, Bookmark: 1, Share: 1 }), CAP);
    const r = rep(daily, 1);
    // Replies received (X `Replies`) and replies written (X `CreateReply`) are separate counts.
    expect(r.conversation).toEqual({ likes: 69, replies: 39, repliesWritten: 66, repliesPer1k: (39 / 6046) * 1000 });
    expect(r.engagementTypes).toEqual({ likes: 69, replies: 39, reposts: 1, bookmarks: 1, shares: 1 });
    // The Engagements KPI keeps X's full total; likes + replies is not presented as a total.
    expect(r.kpis.find((k) => k.key === 'Engagements')!.value).toBe(131);
  });
  it('conversation uses the selected range (7D sums), and small reposts/bookmarks do not change the layout', () => {
    const daily = series('2026-10-02', 20, () => ({ Impressions: 1000, Likes: 10, Replies: 4, Retweets: 0, Bookmark: 0 }), CAP);
    const r = rep(daily, 7);
    expect(r.conversation).toEqual({ likes: 70, replies: 28, repliesWritten: null, repliesPer1k: 4 });
  });
  it('no Likes/Replies fields captured: no conversation panel (never derived from total engagements)', () => {
    const r = rep(base, 1); // base rows carry Engagements but not the type fields
    expect(r.conversation).toBeNull();
    expect(r.engagementTypes).toBeNull();
    expect(r.diagnostics.some((d) => /Likes\/Replies fields missing/.test(d))).toBe(true);
  });
  it('intraday line: needs 2+ real captures today, starts at the first, no midnight zero', () => {
    const one = { '2026-10-02': [{ at: '2026-10-02T16:48:49.000Z', metrics: { Impressions: 5169 } }] };
    expect(buildReport({ handle: 'byaarav', settings: s, observations: [], attempts: [], daily: base, analyticsCapturedAt: CAP, intraday: one, days: 1, now: NOW }).intraday).toBeNull();
    const three = {
      '2026-10-02': [
        { at: '2026-10-02T18:08:39.000Z', metrics: { Impressions: 6046 } },
        { at: '2026-10-02T16:48:49.000Z', metrics: { Impressions: 5169 } },
        { at: '2026-10-02T18:00:29.000Z', metrics: { Impressions: 6009 } },
      ],
      '2026-10-01': [{ at: '2026-10-01T10:00:00.000Z', metrics: { Impressions: 1 } }, { at: '2026-10-01T11:00:00.000Z', metrics: { Impressions: 2 } }],
    };
    const r = buildReport({ handle: 'byaarav', settings: s, observations: [], attempts: [], daily: base, analyticsCapturedAt: CAP, intraday: three, days: 1, now: NOW });
    expect(r.intraday).toEqual([
      { at: '2026-10-02T16:48:49.000Z', v: 5169 },
      { at: '2026-10-02T18:00:29.000Z', v: 6009 },
      { at: '2026-10-02T18:08:39.000Z', v: 6046 },
    ]);
    // Multi-day ranges never get an intraday line.
    expect(buildReport({ handle: 'byaarav', settings: s, observations: [], attempts: [], daily: base, analyticsCapturedAt: CAP, intraday: three, days: 7, now: NOW }).intraday).toBeNull();
  });
});

describe('Today in context', () => {
  it('7 UTC days ending today from X daily totals; missing days stay null; only Today gets it', () => {
    const gappy = base.filter((r) => r.date !== '2026-09-29');
    const r = rep(gappy, 1);
    expect(r.context).toHaveLength(7);
    expect(r.context![0]!.date).toBe('2026-09-26');
    expect(r.context!.at(-1)).toEqual({ date: '2026-10-02', v: 600, focus: true });
    expect(r.context!.find((c) => c.date === '2026-09-29')!.v).toBeNull();
    expect(rep(gappy, 7).context).toBeNull();
  });
});

describe('Yesterday · final', () => {
  it('ends on the last complete UTC day, compares day-over-day, and Day N follows that day', () => {
    const s2 = settings({ reportingTimeZone: 'UTC', cycleCutoffHour: 0 });
    const r = buildReport({ handle: 'byaarav', settings: s2, observations: [], attempts: [], daily: base, analyticsCapturedAt: CAP, days: 1, anchor: 'yesterday', now: NOW });
    expect(r.range).toMatchObject({ anchor: 'yesterday', today: '2026-10-01', start: '2026-10-01', endStatus: 'final' });
    expect(r.kpis.find((k) => k.key === 'Impressions')!.value).toBe(1000);
    expect(r.comparison).toEqual({ available: true, days: 1, cur: { start: '2026-10-01', end: '2026-10-01' }, prev: { start: '2026-09-30', end: '2026-09-30' } });
    expect(r.reportingDate).toBe('2026-10-01');
    expect(r.daySuggested).toBe(31);
    expect(r.context!.at(-1)).toEqual({ date: '2026-10-01', v: 1000, focus: true });
    expect(r.intraday).toBeNull();
  });
  it('a yesterday captured mid-day is marked partial, not final', () => {
    const mid = base.map((x) => (x.date === '2026-10-01' ? { ...x, partial: true } : x));
    const r = buildReport({ handle: 'byaarav', settings: s, observations: [], attempts: [], daily: mid, analyticsCapturedAt: CAP, days: 1, anchor: 'yesterday', now: NOW });
    expect(r.range.endStatus).toBe('partial');
    expect(r.comparison.available).toBe(false);
  });
});

describe('follower count', () => {
  it('prefers the exact profile count over X Analytics\' rounded figure, whichever is newer', () => {
    const exact = { ...obs('1,030', '2026-10-02T10:00:00Z', { s }), metric: 'followers_total' as const };
    const rounded = { ...obs('1K', '2026-10-02T12:00:00Z', { s }), metric: 'followers_total' as const };
    expect(rep(base, 1, NOW, CAP, [exact, rounded]).followerCount?.displayText).toBe('1,030');
    expect(rep(base, 1, NOW, CAP, [rounded]).followerCount?.displayText).toBe('1K');
  });
});

describe('fields X did not report stay missing on the Ledger', () => {
  it('a captured day without Impressions draws no bar and blanks the range figure', () => {
    const gappy = base.map((r) => (r.date === '2026-09-30' ? { ...r, metrics: { Engagements: 20, ProfileVisits: 2, Follows: 3, Unfollows: 1 } } : r));
    const r = rep(gappy, 7);
    expect(r.trend.find((d) => d.date === '2026-09-30')).toMatchObject({ cur: null, missing: false });
    expect(r.kpis.find((k) => k.key === 'Impressions')!.value).toBeNull();
    expect(r.kpis.find((k) => k.key === 'EngagementRate')!.value).toBeNull();
    expect(r.kpis.find((k) => k.key === 'ProfileVisits')!.value).toBe(14);
    expect(r.trendFacts!.completeDays).toBe(5);
    expect(r.momentum).toMatchObject({ kind: 'followers' });
  });
});
