import { describe, expect, it } from 'vitest';
import { reportingDate, suggestDayNumber } from '../src/calc/time';
import { settings } from './helpers';

describe('reporting day and Day N', () => {
  const s = settings({ reportingTimeZone: 'Europe/London', cycleCutoffHour: 4 });
  it('a post-midnight capture before the cutoff belongs to the previous reporting day', () => {
    // 00:30 BST on 2 Oct = 23:30Z on 1 Oct
    expect(reportingDate(new Date('2026-10-01T23:30:00Z'), s)).toBe('2026-10-01');
    expect(reportingDate(new Date('2026-10-02T04:30:00Z'), s)).toBe('2026-10-02');
  });
  it('uses the configured timezone, not UTC', () => {
    const ny = settings({ reportingTimeZone: 'America/New_York', cycleCutoffHour: 0 });
    // 02:00Z on 2 Oct is 22:00 on 1 Oct in New York
    expect(reportingDate(new Date('2026-10-02T02:00:00Z'), ny)).toBe('2026-10-01');
  });
  it('Day N from the anchor: 30 Sep = Day 30, 1 Oct = Day 31 (override), 2 Oct = Day 32', () => {
    expect(suggestDayNumber('2026-09-30', s).day).toBe(30);
    expect(suggestDayNumber('2026-10-01', s)).toEqual({ day: 31, source: 'override' });
    expect(suggestDayNumber('2026-10-02', s)).toEqual({ day: 32, source: 'anchor' });
  });
  it('overrides win over the anchor', () => {
    expect(suggestDayNumber('2026-10-05', settings({ dayOverrides: { '2026-10-05': 34 } })).day).toBe(34);
  });
});

describe('Day 1 picked by the creator', () => {
  it('a new install has no Day 1 yet: today counts as Day 1 and the page asks', async () => {
    const { defaultSettings } = await import('../src/model/types');
    const { suggestDayNumber, dayOneDate } = await import('../src/calc/time');
    const s = defaultSettings();
    expect(dayOneDate(s)).toBeNull();
    expect(suggestDayNumber('2026-10-25', s)).toEqual({ day: 1, source: 'unset' });
  });

  it('picking a date makes it Day 1 and counts UTC days from there, clearing old overrides', async () => {
    const { pickDayOne, suggestDayNumber, dayOneDate } = await import('../src/calc/time');
    const s = { ...settings(), ...pickDayOne('2026-08-03', '2026-10-25') };
    expect(s.dayOverrides).toEqual({});
    expect(dayOneDate(s)).toBe('2026-08-03');
    expect(suggestDayNumber('2026-08-03', s).day).toBe(1);
    expect(suggestDayNumber('2026-10-25', s).day).toBe(84);
  });

  it('reads Day 1 back from an older "date = Day N" setting', async () => {
    const { dayOneDate } = await import('../src/calc/time');
    expect(dayOneDate(settings())).toBe('2026-09-01'); // 30 Sep = Day 30
  });

  it('refuses a Day 1 in the future or an invalid date', async () => {
    const { pickDayOne } = await import('../src/calc/time');
    expect(() => pickDayOne('2026-10-26', '2026-10-25')).toThrow(/after today/);
    expect(() => pickDayOne('', '2026-10-25')).toThrow(/valid date/);
    expect(() => pickDayOne('2026-10-25', '2026-10-25')).not.toThrow();
  });
});
