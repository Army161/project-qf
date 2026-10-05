// 24-hour UTC epochs (REWARDS.md §3). An epoch's slot window comes from the chain: it starts at the first finalized slot
// whose block time is in the epoch and ends where the next epoch starts, so consecutive epochs tile the slots exactly.
export interface UtcEpoch { epochId: string; startSec: number; endSec: number }
const DAY = 86_400;

/** The UTC days from the one containing `fromSec` up to and including the one containing `toSec`. */
export function utcEpochs(fromSec: number, toSec: number): UtcEpoch[] {
  if (!Number.isSafeInteger(fromSec) || !Number.isSafeInteger(toSec) || toSec < fromSec) throw new RangeError('invalid range');
  const out: UtcEpoch[] = [];
  for (let s = Math.floor(fromSec / DAY) * DAY; s <= toSec; s += DAY) out.push({ epochId: new Date(s * 1000).toISOString().slice(0, 10), startSec: s, endSec: s + DAY });
  return out;
}
