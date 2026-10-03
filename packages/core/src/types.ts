// Domain types shared by validator, policy, rewards and tx. Amounts are strings
// (decimal or raw integer) on the wire and bigint / Dec in computation.
export type Chain = 'solana';
export type Cluster = 'mainnet-beta' | 'devnet' | 'localnet' | 'mock-offline';
export type Decision = 'PASS' | 'WARN' | 'FAIL';
/**
 * NOT_APPLICABLE (inspection-v0.2, decision D3 2026-10-03) is an evaluated result, not a missing one. The validator aggregate
 * accepts it only for a check and subject it can re-derive from an approved exception (today: S1.10 on the classic SPL native
 * mint); anywhere else it is malformed and FAILs. SKIP still means "not performed".
 */
export type CheckDecision = Decision | 'SKIP' | 'NOT_APPLICABLE';

/** PRODUCTION providers may feed live validation. TEST_ONLY providers/issuers are synthetic (devnet qUSD etc.). */
export type ProviderClass = 'PRODUCTION' | 'TEST_ONLY';
export type ValidationMode = 'LIVE' | 'TEST_ONLY';

export interface Evidence {
  source: string;
  providerClass: ProviderClass;
  observedAt: string; // ISO-8601 UTC
  slot?: string;
  contentHash?: string;
  note?: string;
}

export interface CheckResult {
  id: string;
  decision: CheckDecision;
  reason: string;
  evidence: Evidence[];
  details: Record<string, string>;
  policyVersion: string;
}

export interface PriceObservation {
  mint: string;
  source: string;
  providerClass: ProviderClass;
  priceUsd: string; // decimal string
  observedAt: string;
  slot?: string;
  /**
   * Upstream lineage (EV-1): the origin of the number, e.g. 'pyth:Crypto.USDC/USD' or 'dex:orca-whirlpool:<pool>'.
   * Independence is counted by lineage, not by the reporting label: two APIs relaying the same oracle are one source.
   * Required in LIVE validation; TEST_ONLY falls back to `source`.
   */
  upstream?: string;
}

export interface PoolSide { mint: string; decimals: number; reserveRaw: string }

export interface PoolObservation {
  chain: Chain;
  venue: string;        // e.g. 'meteora-damm-v2', 'orca-whirlpool'
  poolAddress: string;
  provider: string;     // who reported it
  providerClass: ProviderClass;
  sideA: PoolSide;
  sideB: PoolSide;
  observedAt: string;
  slot?: string;
}

export interface RouteQuote {
  provider: string;
  providerClass: ProviderClass;
  inputMint: string;
  outputMint: string;      // SOL or USDC for S3.1
  notionalRaw: string;     // requested input, raw units
  filledRaw: string;       // input actually fillable along the route
  priceImpactBps: number;  // integer bps reported by route math
  observedAt: string;
}
