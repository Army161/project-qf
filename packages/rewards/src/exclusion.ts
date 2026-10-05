// Exclusion policy (REWARDS.md §3, ExclusionPolicy@1): which token holders are not eligible for holder rewards.
// Each rule has an id and a reason that is written into the epoch artifact next to every excluded owner.
import { address, isOffCurveAddress } from '@solana/kit';

export type ExclusionRule = 'NAMED_ACCOUNT' | 'BURN_ADDRESS' | 'OFF_CURVE_OWNER';
export interface ExclusionPolicy {
  id: 'exclusion'; version: string;
  rules: readonly ExclusionRule[];
  /** addresses whose tokens are gone for good (the incinerator, the system program) */
  burnAddresses: readonly string[];
  /** policy-defined Sybil heuristics; none in this version, recorded so an artifact says so */
  sybilHeuristics: readonly string[];
}
export const EXCLUSION_POLICY_V1_TEST: Readonly<ExclusionPolicy> = Object.freeze({
  id: 'exclusion', version: 'exclusion@1',
  rules: ['NAMED_ACCOUNT', 'BURN_ADDRESS', 'OFF_CURVE_OWNER'] as const,
  burnAddresses: ['1nc1nerator11111111111111111111111111111111', '11111111111111111111111111111111'],
  sybilHeuristics: [],
});

/** An owner the caller names as excluded, with the reason: the operator, the platform fee claimers, the treasury, a
 *  rewards vault, a pool authority. */
export interface NamedExclusion { owner: string; reason: string }

/** Excluded owners among `owners`, sorted. Named accounts come first; then burn addresses; then any owner that is not a
 *  wallet key (off the ed25519 curve: a program-derived address such as a pool authority or a multisig vault, which no
 *  person holds a key for). */
export function exclusionsFor(owners: Iterable<string>, named: readonly NamedExclusion[], policy: ExclusionPolicy = EXCLUSION_POLICY_V1_TEST): NamedExclusion[] {
  const byName = new Map(named.map((n) => [n.owner, n.reason]));
  const out: NamedExclusion[] = [];
  for (const owner of [...new Set(owners)].sort()) {
    if (policy.rules.includes('NAMED_ACCOUNT') && byName.has(owner)) out.push({ owner, reason: byName.get(owner)! });
    else if (policy.rules.includes('BURN_ADDRESS') && policy.burnAddresses.includes(owner)) out.push({ owner, reason: 'BURN_ADDRESS' });
    else if (policy.rules.includes('OFF_CURVE_OWNER') && isOffCurveAddress(address(owner))) out.push({ owner, reason: 'OFF_CURVE_OWNER: program-derived address (pool, vault or program account)' });
  }
  return out;
}
