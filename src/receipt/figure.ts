// Splits a printed figure ("+29,100", "≈−1,200", "4.2%") into prefix, number and suffix so the digits
// can roll while the signs and units stay put. Pure: no DOM, so tests and the website can share it.
export interface Parsed { prefix: string; value: number; suffix: string; decimals: number; grouping: boolean }

export function parseFigure(text: string): Parsed | null {
  const m = /^([^\d]*?)([\d,]*\.?\d+)([^\d]*)$/.exec(text.trim());
  if (!m) return null;
  const digits = m[2]!;
  const dec = digits.includes('.') ? digits.split('.')[1]!.length : 0;
  return { prefix: m[1]!, value: Number(digits.replace(/,/g, '')), suffix: m[3]!, decimals: dec, grouping: digits.includes(',') };
}
