// TEST_ONLY: builds the emit_cpi inner-instruction bytes of a DBC or DAMM v2 swap event (EvtSwap2) from the pinned IDL
// subset, so tests can feed the indexer swaps on the synthetic fixture pools. Real devnet bytes are in
// fixtures/swap-events-devnet.json and decoded by an independent coder in swap-events.test.ts.
import { decodeBase58 } from '@project-qf/core';
import { DAMM_IDL_SUBSET, DBC_IDL_SUBSET, EVENT_IX_TAG, type SwapEvent } from '@project-qf/tx';

type Subset = typeof DBC_IDL_SUBSET;
type IdlType = Subset['instructions'][number]['args'][number]['type'];

function write(out: number[], t: IdlType, v: unknown, s: Subset) {
  if (typeof t === 'string') {
    const m = /^u(8|16|32|64|128)$/.exec(t);
    if (m) { let x = BigInt(v as bigint | number); for (let k = 0; k < Number(m[1]) / 8; k++) { out.push(Number(x & 0xffn)); x >>= 8n; } return; }
    if (t === 'bool') { out.push(v ? 1 : 0); return; }
    if (t === 'pubkey') { const b = decodeBase58(v as string); if (b.length !== 32) throw new Error('encoder: not a 32-byte address'); out.push(...b); return; }
    throw new Error(`encoder: unsupported ${t}`);
  }
  if (t.defined) { for (const f of s.types[t.defined.name]!.fields!) write(out, f.type, (v as Record<string, unknown>)[f.name] ?? 0n, s); return; }
  throw new Error(`encoder: unsupported ${JSON.stringify(t)}`);
}

/** Inner-instruction data of an EvtSwap2 on `pool`. Unset numbers are 0; `collectFeeMode` defaults to 1 (quote only). */
export function swapEventData(venue: SwapEvent['venue'], e: { pool: string; tradeDirection?: number; collectFeeMode?: number; tradingFee?: bigint; lpFee?: bigint;
  compoundingFee?: bigint; protocolFee?: bigint; referralFee?: bigint; config?: string }): Uint8Array {
  const s = (venue === 'CURVE' ? DBC_IDL_SUBSET : DAMM_IDL_SUBSET) as Subset;
  const ev = s.events!.EvtSwap2!;
  const result = venue === 'CURVE'
    ? { trading_fee: e.tradingFee ?? 0n, protocol_fee: e.protocolFee ?? 0n, referral_fee: e.referralFee ?? 0n }
    : { claiming_fee: e.lpFee ?? 0n, compounding_fee: e.compoundingFee ?? 0n, protocol_fee: e.protocolFee ?? 0n, referral_fee: e.referralFee ?? 0n };
  const values: Record<string, unknown> = { pool: e.pool, config: e.config ?? e.pool, trade_direction: e.tradeDirection ?? 1, collect_fee_mode: e.collectFeeMode ?? 1,
    has_referral: (e.referralFee ?? 0n) > 0n, swap_result: result };
  const out: number[] = [...EVENT_IX_TAG, ...ev.discriminator];
  for (const f of ev.fields) write(out, f.type, values[f.name] ?? 0n, s);
  return Uint8Array.from(out);
}
export const swapEvent = (venue: SwapEvent['venue'], e: Parameters<typeof swapEventData>[1]) =>
  ({ programId: venue === 'CURVE' ? DBC_IDL_SUBSET.provenance.programId : DAMM_IDL_SUBSET.provenance.programId, data: swapEventData(venue, e) });
