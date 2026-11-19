import { describe, expect, it } from 'vitest';
import { buildCardModel } from '../src/card/model';
import { obs, settings } from './helpers';

const s = settings({ reportingTimeZone: 'Europe/London', cycleCutoffHour: 4 });
const now = new Date('2026-10-02T20:00:00Z');

describe('share card model', () => {
  it('first capture: no fabricated history, change, sparkline or ETA', () => {
    const r = buildCardModel('byaarav', [obs('109.2K', '2026-10-02T19:30:00Z', { s })], [], s, now, 32);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.model;
    expect(m.handle).toBe('@byaarav');
    expect(m.day).toBe(32);
    expect(m.daySuggested).toBe(32);
    expect(m.reportingDate).toBe('2026-10-02');
    expect(m.heroText).toBe('109.2K');
    expect(m.progressText).toBe('≈21.8% of 500K');
    expect(m.remainingText).toBe('≈390.8K to go');
    expect(m.windowNote).toBe('90-day rolling window · excludes replies');
    expect(m.qualifiers).toContain('Rounded by X');
    expect(m.change).toBeNull();
    expect(m.sparkline).toEqual([]);
    expect(JSON.stringify(m)).not.toMatch(/ETA|ahead|projected|hits 500K/i);
  });
  it('Day is null until confirmed', () => {
    const r = buildCardModel('byaarav', [obs('109.2K', '2026-10-02T19:30:00Z', { s })], [], s, now, null);
    expect(r.ok && r.model.day).toBeNull();
  });
  it('a reading from an earlier day is qualified on the card', () => {
    const r = buildCardModel('byaarav', [obs('109.2K', '2026-09-30T19:30:00Z', { s })], [], s, now, 32);
    expect(r.ok && r.model.qualifiers.some((q) => /Reading from/.test(q))).toBe(true);
  });
  it('never mixes in another account', () => {
    const list = [obs('109.2K', '2026-10-02T19:30:00Z', { s }), obs('399.9K', '2026-10-02T19:45:00Z', { s, account: 'reference' })];
    const r = buildCardModel('byaarav', list, [], s, now, 32);
    expect(r.ok && r.model.heroText).toBe('109.2K');
  });
  it('no rewards reading → refuses (no fallback to account impressions)', () => {
    const r = buildCardModel('byaarav', [obs('3.2K', '2026-10-02T19:30:00Z', { s, metric: 'account_impressions' })], [], s, now, 32);
    expect(r.ok).toBe(false);
  });
  it('net change appears only with a prior reporting-day checkpoint and is labelled as window change', () => {
    const r = buildCardModel('byaarav', [obs('100.0K', '2026-10-01T19:30:00Z', { s }), obs('109.2K', '2026-10-02T19:30:00Z', { s })], [], s, now, 32);
    expect(r.ok && r.model.change?.label).toMatch(/Net change in 90-day window vs previous reporting day/);
  });
  it('manual readings are labelled user-reported', () => {
    const r = buildCardModel('byaarav', [obs('109.2K', '2026-10-02T19:30:00Z', { s, provenance: 'manual' })], [], s, now, 32);
    expect(r.ok && r.model.qualifiers).toContain('User-reported');
    expect(r.ok && r.model.footer).toMatch(/^Entered from X/);
  });
});
