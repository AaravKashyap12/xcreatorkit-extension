// @ts-expect-error Tests run in Node; this project intentionally loads only Chrome ambient types.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bucketCells, calendarRange, type DailyRow, type Granularity } from '../src/analytics/series';
import {
  customRange,
  followersCard,
  interactions,
  interactionsCard,
  metricCard,
  publishingCard,
  seriesFor,
  shareFileName,
  summaries,
  visitRate,
  visitsCard,
  type View,
} from '../src/analytics/view';

// SYNTHETIC daily rows only.
const TODAY = '2026-10-30';
const row = (date: string, metrics: Record<string, number>, partial = false): DailyRow => ({ date, metrics, capturedAt: '2026-10-30T09:00:00.000Z', partial });
const add = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const days = (end: string, n: number) => Array.from({ length: n }, (_, i) => add(end, i - n + 1));
const base = { Impressions: 1000, Engagements: 20, ProfileVisits: 10, Follows: 5, Unfollows: 2, CreateTweet: 3, CreateReply: 6, Likes: 6, Replies: 2, Retweets: 1, Bookmark: 1 };
const make = (dates: string[], m: (d: string, i: number) => Record<string, number> = () => base) => dates.map((d, i) => row(d, m(d, i)));

function view(all: DailyRow[], opts: { days?: number; compare?: boolean; gran?: Granularity; kind?: 'all' | 'verified'; custom?: [string, string] } = {}): View {
  const range = opts.custom ? customRange(all, opts.custom[0], opts.custom[1], TODAY) : calendarRange(all, { days: opts.days ?? 7, includeToday: false, today: TODAY });
  const gran = opts.gran ?? 'daily';
  return { handle: 'synthetic', kind: opts.kind ?? 'all', range, buckets: bucketCells(range.cells, gran), gran, today: TODAY, compare: opts.compare ?? true };
}

describe('customRange', () => {
  it('spans start to end inclusive and compares with the same number of days just before', () => {
    const r = customRange(make(days('2026-10-29', 40)), '2026-10-10', '2026-10-19', TODAY);
    expect([r.start, r.end, r.cells.length]).toEqual(['2026-10-10', '2026-10-19', 10]);
    expect([r.prev![0]!.date, r.prev!.at(-1)!.date, r.prev!.length]).toEqual(['2026-09-30', '2026-10-09', 10]);
  });
  it('stops at today, flags today as in progress, and keeps uncaptured days as gaps', () => {
    const all = make(days('2026-10-29', 5)).filter((r) => r.date !== '2026-10-27');
    const r = customRange([...all, row(TODAY, { Impressions: 5 }, true)], '2026-10-25', '2026-11-03', TODAY);
    expect(r.end).toBe(TODAY);
    expect(r.includesToday).toBe(true);
    expect(r.missing).toEqual(['2026-10-27']);
  });
  it('an end before the start is an empty range, never a reversed one', () => {
    const r = customRange(make(days('2026-10-29', 5)), '2026-10-29', '2026-10-25', TODAY);
    expect(r.cells).toEqual([]);
    expect(r.prev).toBeNull();
  });
});

describe('summaries: denominators and changes', () => {
  it('engagement rate is total engagements ÷ total impressions, and changes in points', () => {
    // Current week: one huge day and six quiet ones. A mean of daily rates would be far higher than the weighted rate.
    const all = make(days('2026-10-29', 14), (d, i) => (i < 7 ? { ...base, Impressions: 1000, Engagements: 10 } : { ...base, Impressions: i === 7 ? 100000 : 100, Engagements: i === 7 ? 1000 : 10 }));
    const s = summaries(view(all)).EngagementRate;
    const eng = 1000 + 6 * 10, imp = 100000 + 6 * 100;
    expect(s.value).toBe(`${((eng / imp) * 100).toFixed(2)}%`);
    expect(s.change?.text).toMatch(new RegExp(`^\\+${((eng / imp - 0.01) * 100).toFixed(2)} pts vs 16 Oct – 22 Oct 2026$`));
    expect(s.parts).toContain(`${eng.toLocaleString('en-US')} engagements ÷ ${imp.toLocaleString('en-US')} impressions`);
  });
  it('a prior period of zero never yields a percent', () => {
    const all = make(days('2026-10-29', 14), (_, i) => ({ ...base, Impressions: i < 7 ? 0 : 500 }));
    const s = summaries(view(all)).Impressions;
    expect(s.change?.text).toBe('Prior period was 0 · 16 Oct – 22 Oct 2026');
    expect(s.subs.join(' ')).not.toMatch(/%/);
  });
  it('no change when either period has a missing, unreported or in-progress day', () => {
    const gap = make(days('2026-10-29', 14)).filter((r) => r.date !== '2026-10-18');
    expect(summaries(view(gap)).Impressions.change).toBeNull();
    const unreported = make(days('2026-10-29', 14), (d) => (d === '2026-10-25' ? { ...base, ProfileVisits: undefined as unknown as number } : base)).map((r) => (r.metrics.ProfileVisits === undefined ? { ...r, metrics: Object.fromEntries(Object.entries(r.metrics).filter(([k]) => k !== 'ProfileVisits')) } : r));
    expect(summaries(view(unreported)).ProfileVisits.change).toBeNull();
    expect(summaries(view(unreported)).Impressions.change).not.toBeNull();
    const stale = make(days('2026-10-29', 14)).map((r) => (r.date === '2026-10-29' ? { ...r, partial: true } : r));
    expect(summaries(view(stale)).Impressions.change).toBeNull();
  });
  it('compare off removes every change; all captured days has nothing to compare', () => {
    const all = make(days('2026-10-29', 14));
    expect(Object.values(summaries(view(all, { compare: false }))).every((s) => s.change === null)).toBe(true);
    const r = calendarRange(all, { days: 'all', includeToday: false, today: TODAY });
    expect(r.prev).toBeNull();
  });
  it('net follows keeps its sign: a loss is −, red, and changes by difference, not percent', () => {
    const all = make(days('2026-10-29', 14), (_, i) => ({ ...base, Follows: 1, Unfollows: i < 7 ? 1 : 3 }));
    const s = summaries(view(all)).NetFollows;
    expect([s.value, s.tone]).toEqual(['−14', 'down']);
    expect(s.change?.text).toBe('−14 vs 16 Oct – 22 Oct 2026');
    expect(s.change?.tone).toBe('down');
  });
  it('net follows is a dash, not a sum, when either field is missing on a captured day', () => {
    const all = make(days('2026-10-29', 7)).map((r, i) => (i === 3 ? { ...r, metrics: { Impressions: 1, Follows: 9 } } : r));
    const s = summaries(view(all)).NetFollows;
    expect([s.ok, s.value]).toEqual([false, '—']);
  });
});

describe('interactions', () => {
  it('shares are each type ÷ all listed types over the days that reported every type, and add up to 100%', () => {
    const all = make(days('2026-10-29', 7)).map((r, i) => (i === 0 ? { ...r, metrics: { ...r.metrics, Likes: 1000, Bookmark: undefined as never } } : r))
      .map((r) => ({ ...r, metrics: Object.fromEntries(Object.entries(r.metrics).filter(([, v]) => v !== undefined)) }));
    const it = interactions(calendarRange(all, { days: 7, includeToday: false, today: TODAY }).cells);
    expect(it.commonDays).toBe(6);
    expect(it.total).toBe(6 * (6 + 2 + 1 + 1));
    expect(it.rows.find((r) => r.key === 'Likes')!.total).toBe(1000 + 6 * 6); // the type's own total keeps its own days
    expect(it.rows.find((r) => r.key === 'Likes')!.share).toBeCloseTo(0.6);
    expect(it.rows.reduce((s, r) => s + (r.share ?? 0), 0)).toBeCloseTo(1);
    const card = interactionsCard(view(all), true);
    expect(card.headline!.value).toBe('60');
    expect(card.bars!.find(r => r.label === 'Likes')!.value).toBe('36');
    expect(card.bars!.reduce((s, r) => s + Number(r.value), 0)).toBe(60);
    expect(card.coverage).toContain('Every type reported on 6 of them');
  });
  it('zero interactions give no shares rather than 0% or NaN', () => {
    const all = make(days('2026-10-29', 7), () => ({ ...base, Likes: 0, Replies: 0, Retweets: 0, Bookmark: 0 }));
    const it = interactions(calendarRange(all, { days: 7, includeToday: false, today: TODAY }).cells);
    expect(it.total).toBe(0);
    expect(it.rows.every((r) => r.share === null)).toBe(true);
  });
  it('types X did not report are not listed', () => {
    const it = interactions(calendarRange(make(days('2026-10-29', 7)), { days: 7, includeToday: false, today: TODAY }).cells);
    expect(it.rows.map((r) => r.key)).not.toContain('QuoteTweets');
  });
});

describe('visit rate', () => {
  it('is visits ÷ impressions × 1,000 on the same days and changes by a difference per 1K', () => {
    const all = make(days('2026-10-29', 14), (_, i) => ({ ...base, ProfileVisits: i < 7 ? 2 : 3 }));
    const r = visitRate(view(all));
    expect(r.value).toBeCloseTo(3);
    expect(r.change?.text).toBe('+1.00 per 1K vs 16 Oct – 22 Oct 2026');
  });
});

describe('share cards follow the filters', () => {
  const all = make(days('2026-10-29', 60), (_, i) => ({ ...base, Impressions: 1000 + i }));
  it('summarizes many in-progress days without hiding their number', () => {
    const v = view(all.map(r => ({ ...r, partial: true })), { days: 28 });
    const c = metricCard(v, 'Impressions', summaries(v).Impressions, true);
    expect(c.coverage).toContain('2 Oct, 3 Oct, 4 Oct and 25 more days read while in progress');
    expect(c.partial).toBe(true);
    expect(c.change).toBeNull();
  });
  it('publishing coverage counts days containing both fields, not the smaller separate count', () => {
    const distinct = days('2026-10-29', 7).map((date, i) => row(date, i === 0 ? { CreateReply: 2 } : i === 1 ? { CreateTweet: 3 } : { CreateTweet: 3, CreateReply: 2 }));
    expect(publishingCard(view(distinct), true).coverage).toContain('Posts and replies reported on 5 of them');
  });
  it('names the range, audience, grouping and account; hiding the handle removes it from picture and file name', () => {
    const v = view(all, { days: 28, kind: 'verified', gran: 'weekly' });
    const c = metricCard(v, 'Impressions', summaries(v).Impressions, true);
    expect([c.title, c.kicker, c.range, c.handle]).toEqual(['Impressions', 'Per week · Verified only', '2 Oct – 29 Oct 2026 · UTC', 'synthetic']);
    expect(shareFileName(c, v)).toBe('synthetic-impressions-2026-10-02_2026-10-29-verified-utc.png');
    const hidden = metricCard(v, 'Impressions', summaries(v).Impressions, false);
    expect(hidden.handle).toBeNull();
    expect(shareFileName(hidden, v)).toBe('analytics-impressions-2026-10-02_2026-10-29-verified-utc.png');
  });
  it('the previous period is drawn day for day only when grouped by day; otherwise the 7-day average', () => {
    const daily = view(all, { days: 28 });
    expect(seriesFor('Impressions', daily).map((s) => s.name)).toEqual(['Impressions', 'Previous 28 days']);
    expect(seriesFor('Impressions', daily)[1]!.values[0]).toBe(1000 + 4); // 4 Sep is the 5th synthetic day
    expect(seriesFor('Impressions', view(all, { days: 28, compare: false })).map((s) => s.name)).toEqual(['Impressions', '7-day average']);
    expect(seriesFor('Impressions', view(all, { days: 28, gran: 'weekly' })).map((s) => s.name)).toEqual(['Impressions']);
  });
  it('coverage says partial when a day is missing, and the card keeps the missing day as a gap', () => {
    const gappy = all.filter((r) => r.date !== '2026-10-20');
    const v = view(gappy, { days: 28 });
    const c = metricCard(v, 'Impressions', summaries(v).Impressions, true);
    expect(c.coverage).toBe('27 of 28 days captured · Previous period: 4 Sep – 1 Oct 2026 · 28 of 28 days complete');
    expect(c.partial).toBe(true);
    expect(c.change).toBeNull();
    const i = c.chart!.categories.findIndex((x) => x.title?.includes('20 Oct'));
    expect(c.chart!.categories[i]!.missing).toBe(true);
    expect(c.chart!.series[0]!.values[i]).toBeNull();
    const complete = view(all, { days: 28 });
    expect(metricCard(complete, 'Impressions', summaries(complete).Impressions, true).partial).toBe(false);
  });
  it('negative and zero values survive into the card unchanged', () => {
    const v = view(make(days('2026-10-29', 14), (_, i) => ({ ...base, Follows: 0, Unfollows: i % 2 ? 2 : 0, CreateTweet: 0 })));
    const f = followersCard(v, summaries(v).NetFollows, true);
    expect(f.headline!.value).toBe('−8'); // days 7, 9, 11 and 13 each lose 2
    expect(f.chart!.series.find((s) => s.name === 'Unfollows')!.values).toContain(-2);
    expect(f.chart!.series.find((s) => s.name === 'Net follows')!.values).toContain(0);
    expect(publishingCard(v, true).headline!.value).toBe('0');
  });
  it('never draws an incomplete prior period as a settled comparison', () => {
    const source = make(days('2026-10-29', 14));
    source[0] = { ...source[0]!, partial: true };
    const v = view(source);
    expect(seriesFor('Impressions', v).some(s => s.name.startsWith('Previous'))).toBe(false);
    const c = metricCard(v, 'Impressions', summaries(v).Impressions, true);
    expect(c.chart!.series.some(s => s.name.startsWith('Previous'))).toBe(false);
    expect(c.change).toBeNull();
    source[0] = { ...source[0]!, partial: false, metrics: { ...base } };
    const complete = view(source);
    expect(metricCard(complete, 'Impressions', summaries(complete).Impressions, true).coverage).toContain('Previous period: 16 Oct – 22 Oct 2026 · 7 of 7 days complete');
  });
  it('every card states a definition and an audience; the rate cards state their denominator', () => {
    const v = view(all, { days: 28 });
    const s = summaries(v);
    const cards = [metricCard(v, 'EngagementRate', s.EngagementRate, true), interactionsCard(v, true), visitsCard(v, true), publishingCard(v, true)];
    expect(cards.every((c) => c.definition && /All viewers/.test(c.kicker))).toBe(true);
    expect(cards[0]!.figures.join()).toMatch(/engagements ÷ [\d,]+ impressions/);
    expect(cards[2]!.figures.join()).toMatch(/visits ÷ [\d,]+ impressions/);
    expect(cards[1]!.definition).toMatch(/each type ÷ all listed interactions/);
  });
});

describe('share image styles', () => {
  // Was: "the card carries the same token values as the extension pages". The pages moved to the reader palette
  // (docs/v1/EXTENSION-READER.md); the exported picture keeps its own, so its values are pinned here instead.
  it('the card states its own palette, pinned, independent of the page tokens', () => {
    const vars = (css: string) => Object.fromEntries([...css.matchAll(/(--xck-[\w-]+):\s*(#[0-9a-f]{3,8})/gi)].map((m) => [m[1], m[2]!.toLowerCase()]));
    const card = vars(readFileSync('src/ui/analyticsShare.css', 'utf8'));
    expect(card).toEqual({ '--xck-canvas': '#f5f7fa', '--xck-surface': '#ffffff', '--xck-sunken': '#eef1f5', '--xck-text': '#101828', '--xck-text-2': '#475467', '--xck-text-3': '#667085', '--xck-border': '#e4e7ec', '--xck-control-border': '#8a93a3', '--xck-grid': '#edf0f4', '--xck-accent': '#2b55e6', '--xck-accent-ink': '#1f43c4', '--xck-accent-soft': '#e8eefe', '--xck-series-2': '#7a8699', '--xck-pos': '#067647', '--xck-neg': '#c01f12', '--xck-warn': '#93590a', '--xck-an-canvas': '#f1f3f7', '--xck-an-line': '#4a6fb5', '--xck-an-fill': '#cfdbf1', '--xck-an-fill-2': '#dde1e8', '--xck-an-axis': '#c9cfd9', '--xck-an-pos-soft': '#e7f4ec', '--xck-an-neg-soft': '#fcebea' });
    // Every colour the card's rules read is one it states itself, so nothing can leak in from static/tokens.css.
    const css = readFileSync('src/ui/analyticsShare.css', 'utf8');
    for (const used of new Set([...css.matchAll(/var\((--xck-[\w-]+)/g)].map((m) => m[1]!))) expect(Object.keys(card)).toContain(used);
  });
  it('every card rule is scoped, so the preview cannot restyle the page', () => {
    const css = readFileSync('src/ui/analyticsShare.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim());
    expect(selectors.every((s) => s.split(',').every((p: string) => p.trim().startsWith('.xck-sc')))).toBe(true);
  });
});
