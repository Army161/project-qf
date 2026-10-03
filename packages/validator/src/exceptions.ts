// Approved check exceptions (decision D3, 2026-10-03, owner with reviewer). An exception is a policy object, not a flag a
// caller can set: the inspector applies it only when the observed subject meets every condition, and the aggregate
// re-derives it from the same subject before accepting a NOT_APPLICABLE. Today there is exactly one.
import type { MintFacts } from './mint.ts';
import { SPL_TOKEN_PROGRAM } from './mint.ts';

export const CLASSIC_NATIVE_MINT = 'So11111111111111111111111111111111111111112';

/**
 * S1.10 on the classic SPL Token native mint. Its supply field is not a counter of wrapped SOL (wrapping does not mint), so a
 * raw 0 there is not "zero supply". Supply semantics only: not registry admission, not approval, and no other check changes.
 * No symbol rule, no issuer override, and nothing for the Token-2022 native mint.
 */
export const S1_10_NATIVE_MINT_EXCEPTION = Object.freeze({
  id: 'qf-exception-S1.10-classic-native-mint-v1',
  check: 'S1.10',
  reason: 'NATIVE_MINT_SUPPLY_NOT_TRACKED',
  mint: CLASSIC_NATIVE_MINT,
  owner: SPL_TOKEN_PROGRAM,
  decimals: 9,
  clusters: Object.freeze(['mainnet-beta', 'devnet'] as const),
  decidedBy: 'D3 2026-10-03 (owner, reviewer)',
} as const);

/** What the exception is evaluated against: the requested mint and cluster, and the primary provider's decoded account. */
export interface ExceptionSubject { mint: string; cluster: string; owner: string | null; facts: MintFacts | null }

/** Empty when the exception applies; otherwise every condition that is not met (also used to explain a FAIL). */
export function nativeMintSupplyExceptionGaps(s: ExceptionSubject | undefined): string[] {
  const e = S1_10_NATIVE_MINT_EXCEPTION;
  if (!s) return ['NO_SUBJECT'];
  const gaps: string[] = [];
  if (s.mint !== e.mint) gaps.push('NOT_THE_CLASSIC_NATIVE_MINT');
  if (!(e.clusters as readonly string[]).includes(s.cluster)) gaps.push(`CLUSTER ${s.cluster} is not a genesis-verified live cluster`);
  if (s.owner !== e.owner) gaps.push('OWNER is not the SPL Token program');
  const f = s.facts;
  if (!f) { gaps.push('NO_DECODED_MINT'); return gaps; }
  if (f.tokenProgram !== 'SPL_TOKEN') gaps.push('TOKEN_PROGRAM is not SPL Token');
  if (!f.initialized) gaps.push('NOT_INITIALIZED');
  if (f.decimals !== e.decimals) gaps.push(`DECIMALS ${f.decimals} != ${e.decimals}`);
  if (f.mintAuthority !== null) gaps.push('MINT_AUTHORITY present');
  if (f.freezeAuthority !== null) gaps.push('FREEZE_AUTHORITY present');
  if (f.extensions.length) gaps.push('EXTENSIONS present');
  if (f.supplyRaw !== '0') gaps.push('SUPPLY is not 0 (no exception needed)');
  return gaps;
}
