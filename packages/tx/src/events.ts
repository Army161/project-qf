// Swap events. DBC and DAMM v2 report each swap's exact fee split in an Anchor self-CPI event (emit_cpi): an inner
// instruction to the program itself whose data is EVENT_IX_TAG, the event discriminator, then the Borsh event. The
// layouts come from the pinned IDL subsets (checked for drift against the MIT SDK packages). Browser-safe.
import { decodeExact } from './engine/borsh.ts';
import { DBC_IDL_SUBSET } from './engine/dbc-idl-subset.ts';
import { DAMM_IDL_SUBSET } from './engine/damm-idl-subset.ts';
import type { IdlSubset } from './engine/idl-types.ts';

/** The first 8 bytes of sha256("anchor:event") in reverse order (Anchor's EVENT_IX_TAG_LE), the prefix of every emit_cpi instruction. */
export const EVENT_IX_TAG = Object.freeze([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export interface SwapEvent {
  venue: 'CURVE' | 'DAMM_V2';
  pool: string;
  /** 0 = base to quote (sell), 1 = quote to base (buy), as the programs number it */
  tradeDirection: number;
  /** DAMM v2 only: 0 both tokens, 1 token B (quote) only; the DBC event does not carry it (the config does) */
  collectFeeMode: number | null;
  hasReferral: boolean;
  /** DBC: the LP-side fee shared by partner and creator by the config's creator percentage. DAMM v2: 0 (see lpFee). */
  tradingFee: bigint;
  /** DAMM v2: the fee paid to liquidity positions, by liquidity. DBC: 0. */
  lpFee: bigint;
  /** DAMM v2: the fee added to the pool's reserves (compounding mode). DBC: 0. */
  compoundingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
}

const SUBSETS: Record<string, [SwapEvent['venue'], IdlSubset]> = {
  [DBC_IDL_SUBSET.provenance.programId]: ['CURVE', DBC_IDL_SUBSET],
  [DAMM_IDL_SUBSET.provenance.programId]: ['DAMM_V2', DAMM_IDL_SUBSET],
};
const startsWith = (b: Uint8Array, p: readonly number[], at = 0) => b.length >= at + p.length && p.every((x, k) => b[at + k] === x);

/** The swap event in one inner instruction of DBC or DAMM v2, or null when the instruction is anything else.
 *  A recognised event that does not decode exactly throws (BorshError): it is never half-read. */
export function decodeSwapEvent(programId: string, data: Uint8Array): SwapEvent | null {
  const s = SUBSETS[programId];
  const ev = s?.[1].events?.EvtSwap2;
  if (!s || !ev || !startsWith(data, EVENT_IX_TAG) || !startsWith(data, ev.discriminator, 8)) return null;
  const v = decodeExact(data.subarray(16), ev.fields, s[1].types) as Record<string, any>;
  const r = v.swap_result as Record<string, bigint>;
  const curve = s[0] === 'CURVE';
  return {
    venue: s[0], pool: v.pool as string, tradeDirection: v.trade_direction as number, collectFeeMode: curve ? null : (v.collect_fee_mode as number),
    hasReferral: v.has_referral as boolean,
    tradingFee: curve ? r.trading_fee! : 0n, lpFee: curve ? 0n : r.claiming_fee!, compoundingFee: curve ? 0n : r.compounding_fee!,
    protocolFee: r.protocol_fee!, referralFee: r.referral_fee!,
  };
}
