import { describe, expect, it } from 'vitest';
import { addDaysYmd, buildPace, formatRate, paceSummary } from '../src/calc/pace';
import { obs } from './helpers';

const T = 500_000;
const fmt = (d: string) => d;

/** Readings every day from `from`, one value per entry (null = day not captured). */
function series(from: string, values: (string | null)[], hour = '18:00') {
  return values.flatMap((v, i) => (v == null ? [] : [obs(v, `${addDaysYmd(from, i)}T${hour}:00Z`)]));
}

describe('pace model', () => {
  it('returns null without a reading', () => {
    expect(buildPace([], T, '2026-10-09')).toBeNull();
  });

  it('one reading: to-go and need, no rate, no projection, plain reason', () => {
    const p = buildPace([obs('109.2K', '2026-10-02T19:00:00Z')], T, '2026-10-02')!;
    expect(p.toGo).toBe(390_800);
    expect(p.need.perDay).toBeCloseTo(5555.56, 1);
    expect(p.rate).toBeNull();
    expect(p.eta).toBeNull();
    expect(p.projection).toEqual([]);
    expect(p.status).toBe('insufficient');
    expect(p.reasons[0]).toMatch(/two days apart/);
    expect(paceSummary(p, fmt).title).toMatch(/not available/i);
  });

  it('two consecutive days is still not enough for a rate', () => {
    const p = buildPace(series('2026-10-01', ['100.0K', '106.0K']), T, '2026-10-02')!;
    expect(p.rate).toBeNull();
    expect(p.reasons[0]).toMatch(/span 1 day\)/);
    // but the daily change is already visible
    expect(p.gains.map((g) => g.delta)).toEqual([null, 6000]);
  });

  it('ahead: rate ≥ need gives ETA, full-window figure and a straight projection', () => {
    // +6,000/day for 8 days: 400.0K → 448.0K
    const vals = Array.from({ length: 9 }, (_, i) => `${(400 + i * 6).toFixed(1)}K`);
    const p = buildPace(series('2026-10-01', vals), T, '2026-10-09')!;
    expect(p.rate!.perDay).toBeCloseTo(6000, 6);
    expect(p.rate!.spanDays).toBe(8);
    expect(p.rate!.approximate).toBe(true);
    expect(p.status).toBe('ahead');
    expect(p.fullWindowAtRate).toBe(540_000);
    // 52,000 to go at 6,000/day → 9 days
    expect(p.eta).toEqual({ date: '2026-10-18', days: 9, beyondProjection: false });
    expect(p.projection[0]).toEqual({ date: '2026-10-09', value: 448_000 });
    expect(p.projection.at(-1)).toEqual({ date: '2026-10-18', value: 502_000 });
    const s = paceSummary(p, fmt);
    expect(s.title).toBe("You're ahead");
    expect(s.body).toMatch(/≈\+6K a day/);
    expect(s.body).toMatch(/500K on 2026-10-18 \(in ~9 days\)/);
  });

  it('behind: positive rate below need still has a date but says the window may not hold', () => {
    const vals = Array.from({ length: 6 }, (_, i) => `${(100 + i * 2).toFixed(1)}K`); // +2,000/day
    const p = buildPace(series('2026-10-01', vals), T, '2026-10-06')!;
    expect(p.status).toBe('behind');
    expect(p.fullWindowAtRate).toBe(180_000);
    expect(p.eta!.days).toBe(195);
    expect(p.eta!.beyondProjection).toBe(true);
    expect(p.projection.length).toBe(121); // capped at PROJECTION_MAX_DAYS + the reading itself
    expect(paceSummary(p, fmt).title).toMatch(/behind/i);
  });

  it('falling: negative rate has no ETA and explains expiry', () => {
    const p = buildPace(series('2026-10-01', ['120.0K', '118.0K', '116.0K', '113.0K']), T, '2026-10-04')!;
    expect(p.status).toBe('falling');
    expect(p.eta).toBeNull();
    expect(p.fullWindowAtRate).toBeNull();
    expect(p.projection).toEqual([]);
    expect(p.reasons.at(-1)).toMatch(/expiring/);
    expect(formatRate(p.rate!.perDay, true)).toBe('≈−2.3K');
  });

  it('rate uses only the lookback window, not all history', () => {
    // 20 days: first 10 at +10K/day, last 10 at +2K/day
    const vals: string[] = [];
    let v = 100_000;
    for (let i = 0; i < 21; i++) {
      vals.push(`${(v / 1000).toFixed(1)}K`);
      v += i < 10 ? 10_000 : 2_000;
    }
    const p = buildPace(series('2026-09-15', vals), T, '2026-10-05')!;
    expect(p.rate!.spanDays).toBe(10);
    expect(p.rate!.perDay).toBeCloseTo(2000, 6);
    expect(p.rate!.from).toBe('2026-09-25');
  });

  it('gaps are null bars, never zero, and today is marked partial', () => {
    const p = buildPace(series('2026-10-01', ['100.0K', '104.0K', null, '112.0K', '115.0K']), T, '2026-10-05')!;
    expect(p.gains.map((g) => [g.date.slice(-2), g.delta])).toEqual([
      ['01', null],
      ['02', 4000],
      ['03', null],
      ['04', null], // previous day missing, so the change is not attributable to one day
      ['05', 3000],
    ]);
    expect(p.gains.at(-1)!.partial).toBe(true);
    expect(p.gains[1]!.partial).toBe(false);
  });

  it('reached: no projection, summary says holding pace', () => {
    const p = buildPace(series('2026-10-01', ['495.0K', '499.0K', '503.0K']), T, '2026-10-03')!;
    expect(p.status).toBe('reached');
    expect(p.toGo).toBe(0);
    expect(p.projection).toEqual([]);
    expect(paceSummary(p, fmt).title).toBe('Target reached');
  });

  it('rounding uncertainty is carried on the rate', () => {
    const p = buildPace(series('2026-10-01', ['100.0K', '103.0K', '106.0K']), T, '2026-10-03')!;
    expect(p.rate!.uncertainty).toBeCloseTo(50, 6); // (50 + 50) / 2 days
  });

  it('multiple captures in one day count once (latest wins)', () => {
    const r = [obs('100.0K', '2026-10-01T09:00:00Z'), obs('100.9K', '2026-10-01T22:00:00Z'), obs('104.0K', '2026-10-02T20:00:00Z'), obs('107.0K', '2026-10-03T20:00:00Z')];
    const p = buildPace(r, T, '2026-10-03')!;
    expect(p.checkpoints.length).toBe(3);
    expect(p.gains[1]!.delta).toBe(3100);
  });
});

describe('formatRate', () => {
  it('formats signed compact values', () => {
    expect(formatRate(5555.56)).toBe('+5.6K');
    expect(formatRate(-950)).toBe('−950');
    expect(formatRate(0)).toBe('±0');
    expect(formatRate(12_340, true)).toBe('≈+12.3K');
  });
});
