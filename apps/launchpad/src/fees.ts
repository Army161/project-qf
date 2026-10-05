// What each trade paid in fees, read from the swap event the program itself emitted in that transaction (DBC and
// DAMM v2 both report the exact fee split of every swap). Nothing here is estimated from a price or a fee rate.
//   Curve (DBC): the trader pays trading fee + protocol fee (+ referral). The trading fee is split between the coin's
//     creator and the platform by the config's creator percentage: creator = floor(fee x pct / 100), platform = the
//     rest. Checked on devnet against every pool's own fee counters (milestone 7 fee ledger evidence).
//   DAMM v2 (after graduation): the trader pays LP fee + protocol fee (+ compounding, + referral). The LP fee goes to
//     the pool's liquidity positions in proportion to their liquidity (the creator's and the platform's locked
//     positions from migration), so it is recorded per trade as one LP amount and split per coin, not per trade.
import { decodeSwapEvent, type SwapEvent } from '@project-qf/tx';
import type { TxSummary } from './chain.ts';

export type FeeStatus = 'RESOLVED' | 'UNKNOWN';
/** Why a trade's fees are UNKNOWN: the transaction was not served with its inner instructions, it has no swap event
 *  for this pool, the event did not decode, the DAMM v2 pool takes fees in both tokens, or the curve's creator share is unknown. */
export type FeeEvidence = 'SWAP_EVENT' | 'NO_TX_DETAILS' | 'NO_SWAP_EVENT' | 'EVENT_DECODE_FAILED' | 'FEE_NOT_IN_QUOTE' | 'NO_CREATOR_SHARE';
export interface TradeFees {
  venue: 'CURVE' | 'DAMM_V2' | null; status: FeeStatus; evidence: FeeEvidence;
  /** everything the trader paid in fees, quote raw */
  totalRaw: string | null; protocolRaw: string | null; referralRaw: string | null;
  /** curve only */
  creatorRaw: string | null; platformRaw: string | null;
  /** DAMM v2 only */
  lpRaw: string | null; compoundingRaw: string | null;
}

export const unknownFees = (evidence: FeeEvidence, venue: TradeFees['venue'] = null): TradeFees =>
  ({ venue, status: 'UNKNOWN', evidence, totalRaw: null, protocolRaw: null, referralRaw: null, creatorRaw: null, platformRaw: null, lpRaw: null, compoundingRaw: null });

/** The fees of the swaps on `pool` in this transaction (summed when one transaction swaps on the pool more than once).
 *  `creatorTradingFeePct` is the curve config's creator share; null for a DAMM v2 pool. */
export function feesFromSummary(s: TxSummary, pool: string, creatorTradingFeePct: number | null): TradeFees {
  if (!s.programEvents) return unknownFees('NO_TX_DETAILS');
  let events: SwapEvent[];
  try { events = s.programEvents.map((e) => decodeSwapEvent(e.programId, e.data)).filter((e): e is SwapEvent => e !== null && e.pool === pool); }
  catch { return unknownFees('EVENT_DECODE_FAILED'); }
  if (!events.length) return unknownFees('NO_SWAP_EVENT');
  const venue = events[0]!.venue;
  if (events.some((e) => e.venue !== venue)) return unknownFees('EVENT_DECODE_FAILED');
  const sum = (f: (e: SwapEvent) => bigint) => events.reduce((a, e) => a + f(e), 0n);
  const total = sum((e) => e.tradingFee + e.lpFee + e.compoundingFee + e.protocolFee + e.referralFee).toString();
  if (venue === 'DAMM_V2') {
    // collect_fee_mode 1: fees only in token B, which a launchpad pool's quote token always is (readDammPool refuses others)
    if (events.some((e) => e.collectFeeMode !== 1)) return unknownFees('FEE_NOT_IN_QUOTE', venue);
    return { venue, status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: total, protocolRaw: sum((e) => e.protocolFee).toString(), referralRaw: sum((e) => e.referralFee).toString(),
      creatorRaw: null, platformRaw: null, lpRaw: sum((e) => e.lpFee).toString(), compoundingRaw: sum((e) => e.compoundingFee).toString() };
  }
  if (creatorTradingFeePct === null || !Number.isInteger(creatorTradingFeePct) || creatorTradingFeePct < 0 || creatorTradingFeePct > 100) return unknownFees('NO_CREATOR_SHARE', venue);
  const pct = BigInt(creatorTradingFeePct);
  const creator = sum((e) => (e.tradingFee * pct) / 100n);
  return { venue, status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: total, protocolRaw: sum((e) => e.protocolFee).toString(), referralRaw: sum((e) => e.referralFee).toString(),
    creatorRaw: creator.toString(), platformRaw: (sum((e) => e.tradingFee) - creator).toString(), lpRaw: null, compoundingRaw: null };
}
