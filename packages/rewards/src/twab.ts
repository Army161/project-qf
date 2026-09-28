// Time-weighted average balance support: exact balance x time-unit sums (slots or seconds,
// whatever unit the indexer history uses). Dividing by window length is unnecessary for
// proportional allocation and would lose precision, so the raw sum is returned.
export interface BalancePoint { t: number; balanceRaw: bigint }
export interface Window { start: number; end: number }

export function twabBalanceUnits(history: readonly BalancePoint[], w: Window): bigint {
  if (!Number.isSafeInteger(w.start) || !Number.isSafeInteger(w.end) || w.end <= w.start) throw new RangeError('invalid window');
  let prevT = -Infinity;
  for (const p of history) {
    if (!Number.isSafeInteger(p.t) || p.t <= prevT) throw new RangeError('history must be strictly sorted by t');
    if (p.balanceRaw < 0n) throw new RangeError('negative balance');
    prevT = p.t;
  }
  let bal = 0n;
  for (const p of history) if (p.t <= w.start) bal = p.balanceRaw;
  let cursor = w.start;
  let sum = 0n;
  for (const p of history) {
    if (p.t <= w.start || p.t >= w.end) continue;
    sum += bal * BigInt(p.t - cursor);
    bal = p.balanceRaw;
    cursor = p.t;
  }
  return sum + bal * BigInt(w.end - cursor);
}
