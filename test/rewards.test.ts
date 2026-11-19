import { describe, expect, it } from 'vitest';
import { dailyCheckpoints, rewardsProgress, rewardsReadings, sourceHealth, windowChange } from '../src/calc/rewards';
import { obs, settings } from './helpers';

describe('rewards progress', () => {
  it('109.2K → ≈21.8% and ≈390.8K to go, flagged approximate', () => {
    const p = rewardsProgress(obs('109.2K', '2026-10-02T19:00:00Z'), 500_000);
    expect(p.approximate).toBe(true);
    expect(p.percentText).toBe('≈21.8%');
    expect(p.remainingText).toBe('≈390.8K to go');
  });
  it('exact readings show exact remaining', () => {
    const p = rewardsProgress(obs('109,214', '2026-10-02T19:00:00Z'), 500_000);
    expect(p.remainingText).toBe('390,786 to go');
    expect(p.percentText).toBe('21.8%');
  });
});

describe('metric isolation', () => {
  it('rewards readings never fall back to total or verified-only account impressions', () => {
    const list = [
      obs('3.2K', '2026-10-02T10:00:00Z', { metric: 'account_impressions' }),
      obs('2.1K', '2026-10-02T10:00:00Z', { metric: 'account_impressions_verified_only' }),
      obs('900', '2026-10-02T10:00:00Z', { metric: 'post_impressions' }),
    ];
    expect(rewardsReadings(list)).toEqual([]);
    expect(sourceHealth(rewardsReadings(list), [], settings(), new Date('2026-10-02T12:00:00Z')).state).toBe('no_data');
  });
  it('scenario values are never treated as readings', () => {
    expect(rewardsReadings([obs('200K', '2026-10-02T10:00:00Z', { provenance: 'scenario' })])).toEqual([]);
  });
  it('windowChange refuses non-rewards metrics', () => {
    const a = obs('3.2K', '2026-10-01T10:00:00Z', { metric: 'account_impressions' });
    const b = obs('109.2K', '2026-10-02T10:00:00Z');
    expect(() => windowChange(a, b, settings())).toThrow();
  });
});

describe('rolling-window change', () => {
  const s = settings();
  it('is labelled net window change, never daily earned impressions', () => {
    const c = windowChange(obs('100.0K', '2026-10-01T19:00:00Z'), obs('109.2K', '2026-10-02T19:00:00Z'), s);
    expect(c.kind).toBe('net_rolling_window_change');
    expect(c.label).toMatch(/net change in 90-day window/i);
    expect(c.label).not.toMatch(/earned|gained today|daily/i);
    expect(c.alignedDaily).toBe(true);
    expect(c.deltaText).toBe('≈+9.2K');
  });
  it('keeps negative changes visible', () => {
    const c = windowChange(obs('110.0K', '2026-10-01T19:00:00Z'), obs('108.5K', '2026-10-02T19:00:00Z'), s);
    expect(c.delta).toBeLessThan(0);
    expect(c.deltaText).toBe('≈−1.5K');
  });
  it('non-adjacent readings say "since last capture" with elapsed time', () => {
    const c = windowChange(obs('100.0K', '2026-09-28T19:00:00Z'), obs('109.2K', '2026-10-02T19:00:00Z'), s);
    expect(c.alignedDaily).toBe(false);
    expect(c.label).toMatch(/since last capture \(4 days earlier\)/);
  });
  it('refuses cross-account comparisons', () => {
    expect(() => windowChange(obs('1K', '2026-10-01T10:00:00Z', { account: 'other' }), obs('2K', '2026-10-02T10:00:00Z'), s)).toThrow();
  });
});

describe('daily checkpoints', () => {
  it('collapses multiple captures in one reporting day into one point', () => {
    const d = dailyCheckpoints([
      obs('108.9K', '2026-10-02T09:00:00Z'),
      obs('109.2K', '2026-10-02T19:00:00Z'),
      obs('100.0K', '2026-10-01T19:00:00Z'),
    ]);
    expect(d.map((x) => x.displayText)).toEqual(['100.0K', '109.2K']);
  });
  it('uses captured UTC dates for legacy local-day readings without changing stored observations', () => {
    const legacy = obs('100.0K', '2026-10-08T23:30:00Z', { reportingTimeZone: 'Asia/Kolkata', reportingDate: '2026-10-09' });
    const current = obs('101.0K', '2026-10-09T12:00:00Z', { reportingTimeZone: 'UTC', reportingDate: '2026-10-09' });
    const readings = rewardsReadings([legacy, current]);
    expect(dailyCheckpoints(readings).map((r) => r.reportingDate)).toEqual(['2026-10-08', '2026-10-09']);
    expect(legacy).toMatchObject({ reportingTimeZone: 'Asia/Kolkata', reportingDate: '2026-10-09' });
  });
});

describe('source health', () => {
  const s = settings({ staleAfterHours: 24 });
  it('marks old readings stale', () => {
    expect(sourceHealth([obs('109.2K', '2026-10-01T08:00:00Z')], [], s, new Date('2026-10-02T12:00:00Z')).state).toBe('stale');
  });
  it('a failed capture after the last reading is a source error that keeps the previous reading', () => {
    const h = sourceHealth(
      [obs('109.2K', '2026-10-02T08:00:00Z')],
      [{ at: '2026-10-02T10:00:00Z', account: 'byaarav', metric: 'rewards_vht_90d', ok: false, code: 'source_error', message: 'X shows an error', sourceUrl: null }],
      s,
      new Date('2026-10-02T11:00:00Z'),
    );
    expect(h.state).toBe('source_error');
    expect(h.latest?.displayText).toBe('109.2K');
  });
  it('flags rounded and unconfirmed window', () => {
    const h = sourceHealth([obs('109.2K', '2026-10-02T08:00:00Z', { windowType: 'unknown' })], [], s, new Date('2026-10-02T09:00:00Z'));
    expect(h.flags).toContain('Rounded by X');
    expect(h.flags).toContain('90-day window not confirmed on source');
  });
});
