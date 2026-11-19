import type { ParsedNumber } from './types';

const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/** Strings X uses for "no value". These are missing, never zero. */
const MISSING = new Set(['', '-', '—', '–', 'n/a', 'na', '--']);

/**
 * Parse a number as X displays it ("109.2K", "3,236", "2.7%", "0", "1.2M").
 * Returns null for missing/unparseable text. Never invents a zero.
 */
export function parseDisplayNumber(raw: string | null | undefined): ParsedNumber | null {
  if (raw == null) return null;
  const displayText = raw.replace(/[   ]/g, ' ').trim();
  if (MISSING.has(displayText.toLowerCase())) return null;

  const m = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?([kKmMbB%])?$/.exec(displayText);
  if (!m) return null;
  const [, sign, intPart, fracPart, suffixRaw] = m;
  const isPercent = suffixRaw === '%';
  const suffix = suffixRaw && !isPercent ? suffixRaw.toLowerCase() : null;
  const decimals = fracPart?.length ?? 0;
  const base = Number(`${intPart!.replace(/,/g, '')}${fracPart ? '.' + fracPart : ''}`);
  if (!Number.isFinite(base)) return null;

  const mult = suffix ? SUFFIX[suffix]! : 1;
  const signMul = sign === '-' ? -1 : 1;
  // Round to avoid float noise (109.2 * 1000 = 109200.00000000001).
  const value = signMul * Math.round(base * mult * 1e6) / 1e6;

  let precision: ParsedNumber['precision'] = 'exact';
  let roundingHalfStep = 0;
  if (suffix) {
    precision = 'rounded';
    roundingHalfStep = (mult / 10 ** decimals) / 2;
  } else if (isPercent) {
    // Percentages are always a rounded display of an underlying ratio.
    precision = 'rounded';
    roundingHalfStep = 1 / 10 ** decimals / 2;
  } else if (decimals > 0) {
    // A plain decimal is precise to its displayed digits but not a count.
    precision = 'rounded';
    roundingHalfStep = 1 / 10 ** decimals / 2;
  }
  return { displayText, value, precision, roundingHalfStep, isPercent };
}

/** Parse a count (impressions, followers). Rejects percents and fractional exact values. */
export function parseCount(raw: string | null | undefined): ParsedNumber | null {
  const p = parseDisplayNumber(raw);
  if (!p || p.isPercent || p.value < 0) return null;
  if (p.roundingHalfStep === 0 && !Number.isInteger(p.value)) return null;
  // "1.5" without a suffix is not a count.
  if (!/[kKmMbB]$/.test(p.displayText) && /\./.test(p.displayText)) return null;
  return p;
}

/** Format a value at the same precision X used, e.g. 390800 at K/1dp -> "390.8K". */
export function formatCompact(value: number, decimals = 1): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(decimals)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(decimals)}K`;
  return `${sign}${Math.round(abs)}`;
}

export function formatExact(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
