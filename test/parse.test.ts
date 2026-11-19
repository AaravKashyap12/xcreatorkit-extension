import { describe, expect, it } from 'vitest';
import { formatCompact, parseCount, parseDisplayNumber } from '../src/model/parse';

describe('parseDisplayNumber', () => {
  it('keeps 109.2K as a rounded reading, not an exact 109,200', () => {
    const p = parseDisplayNumber('109.2K')!;
    expect(p.value).toBe(109_200);
    expect(p.precision).toBe('rounded');
    expect(p.roundingHalfStep).toBe(50);
    expect(p.displayText).toBe('109.2K');
  });
  it('parses K/M suffixes, lower case and spacing', () => {
    expect(parseDisplayNumber('1.2M')!.value).toBe(1_200_000);
    expect(parseDisplayNumber('1M')!.roundingHalfStep).toBe(500_000);
    expect(parseDisplayNumber('3k')!.value).toBe(3_000);
    expect(parseDisplayNumber('12.5 K')!.value).toBe(12_500);
    expect(parseDisplayNumber('1 K')!.value).toBe(1_000); // non-breaking space
  });
  it('parses comma-separated exact counts', () => {
    expect(parseDisplayNumber('3,236')).toMatchObject({ value: 3236, precision: 'exact', roundingHalfStep: 0 });
    expect(parseDisplayNumber('1,234,567')!.value).toBe(1_234_567);
    expect(parseDisplayNumber('12,34')).toBeNull(); // malformed grouping
  });
  it('parses percentages as rounded', () => {
    expect(parseDisplayNumber('2.7%')).toMatchObject({ value: 2.7, isPercent: true, precision: 'rounded' });
  });
  it('treats a displayed 0 as a valid exact zero', () => {
    expect(parseDisplayNumber('0')).toMatchObject({ value: 0, precision: 'exact' });
    expect(parseCount('0')!.value).toBe(0);
  });
  it('returns null (never zero) for missing values', () => {
    for (const m of ['', '—', '-', 'N/A', '  ', 'abc', null, undefined]) expect(parseDisplayNumber(m)).toBeNull();
  });
  it('parseCount rejects percents, negatives and bare decimals', () => {
    expect(parseCount('2.7%')).toBeNull();
    expect(parseCount('-5')).toBeNull();
    expect(parseCount('1.5')).toBeNull();
    expect(parseCount('1.5K')!.value).toBe(1500);
  });
  it('formats remaining at source precision', () => {
    expect(formatCompact(390_800, 1)).toBe('390.8K');
    expect(formatCompact(500_000, 0)).toBe('500K');
  });
});
