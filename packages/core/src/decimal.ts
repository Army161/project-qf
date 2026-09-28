// Exact fixed-point decimal arithmetic for money (18 fractional digits, bigint).
// JS `number` is never accepted for monetary values. Every lossy step takes an
// explicit rounding direction so the direction can be recorded as evidence.

export type Dec = bigint & { readonly __dec18: unique symbol };
export type Rounding = 'DOWN' | 'UP';

export const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);
const DEC_RE = /^-?\d+(\.\d+)?$/;

const asDec = (v: bigint) => v as Dec;

export function dec(s: string): Dec {
  if (typeof s !== 'string') throw new TypeError('dec() requires a string; JS numbers are not accepted for money');
  if (!DEC_RE.test(s)) throw new RangeError(`invalid decimal: ${JSON.stringify(s)}`);
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.') as [string, string?];
  const trimmed = frac.replace(/0+$/, '');
  if (trimmed.length > SCALE) throw new RangeError(`precision exceeds ${SCALE} fractional digits: ${s}`);
  const v = BigInt(int) * ONE + BigInt(trimmed.padEnd(SCALE, '0') || '0');
  return asDec(neg ? -v : v);
}

export function fmt(d: Dec): string {
  const neg = d < 0n;
  const a = neg ? -d : d;
  const int = a / ONE;
  const frac = (a % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export const ZERO = asDec(0n);
export const cmp = (a: Dec, b: Dec): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);
export const add = (a: Dec, b: Dec) => asDec(a + b);
export const sub = (a: Dec, b: Dec) => asDec(a - b);
export const isPositive = (a: Dec) => a > 0n;

function divRound(n: bigint, d: bigint, r: Rounding): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const q = n / d;
  const rem = n % d;
  if (rem === 0n) return q;
  const positive = (n < 0n) === (d < 0n);
  if (r === 'UP') return positive ? q + 1n : q;
  return positive ? q : q - 1n;
}

export const mul = (a: Dec, b: Dec, r: Rounding = 'DOWN') => asDec(divRound(a * b, ONE, r));
export const div = (a: Dec, b: Dec, r: Rounding) => asDec(divRound(a * ONE, b, r));

export function fromRaw(raw: bigint, decimals: number): Dec {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > SCALE) throw new RangeError(`bad decimals ${decimals}`);
  return asDec(raw * 10n ** BigInt(SCALE - decimals));
}

export function toRaw(d: Dec, decimals: number, r: Rounding): bigint {
  if (d < 0n) throw new RangeError('negative amount cannot be converted to raw token units');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > SCALE) throw new RangeError(`bad decimals ${decimals}`);
  return divRound(d, 10n ** BigInt(SCALE - decimals), r);
}

export function minDec(xs: readonly Dec[]): Dec {
  if (xs.length === 0) throw new RangeError('minDec of empty list');
  return xs.reduce((m, x) => (x < m ? x : m));
}
export function maxDec(xs: readonly Dec[]): Dec {
  if (xs.length === 0) throw new RangeError('maxDec of empty list');
  return xs.reduce((m, x) => (x > m ? x : m));
}
/** Median; for an even count the mean of the two middle values, rounded DOWN. */
export function median(xs: readonly Dec[]): Dec {
  if (xs.length === 0) throw new RangeError('median of empty list');
  const s = [...xs].sort((a, b) => cmp(a, b));
  const m = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[m]!;
  return asDec(divRound(s[m - 1]! + s[m]!, 2n, 'DOWN'));
}
/** Spread (hi - lo) / lo in basis points, rounded UP so disagreement is never understated. */
export function ratioBps(lo: Dec, hi: Dec): bigint {
  if (lo <= 0n) throw new RangeError('ratioBps requires a positive lower value');
  return divRound((hi - lo) * 10_000n, lo, 'UP');
}
