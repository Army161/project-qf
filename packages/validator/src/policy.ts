// validator-v0.1 (QUOTE-ASSETS.md §7). Decision 2 (2026-09-27): liquidityFailUsd=25000 is an
// EXPERIMENTAL eligibility parameter, not a validated safety threshold. Money values are decimal strings.
export const VALIDATOR_POLICY_V0_1 = Object.freeze({
  id: 'validator-v0.1',
  status: 'EXPERIMENTAL',
  appliesTo: 'EXISTING_QUOTE_ASSET_MARKETS', // never the newly launched QF base token
  liquidityWarnUsd: '250000',
  liquidityFailUsd: '25000',
  volume24hWarnUsd: '100000',
  maxRouteImpactBps: 300,
  top10WarnPct: 50,
  top10FailPct: 80,
  priceDisagreementPct: 2,
  holderDisagreementPct: 10,
  revalidateActiveSeconds: 3600,
  allowTokenizedSecurities: false,
  // S3.1 exit set (QF-VAL-01): LIVE validation requires exactly these mainnet mints (wSOL, USDC).
  requiredExitMints: ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  minIndependentExits: 1, // identity exits (the quote asset itself) never count
} as const);
export type ValidatorPolicy = typeof VALIDATOR_POLICY_V0_1;

// Evidence freshness rules used by S3.x. Owner decision EV-1 (2026-09-27 repair pass): accepted as
// V0_TEST analytical/eligibility policy ONLY. These are not execution freshness limits: nothing may be signed
// on the strength of them (see EXECUTION_FRESHNESS_POLICY in @project-qf/policy, which is undefined and blocks
// signing). Independence is counted by upstream lineage; newer adverse evidence supersedes older in-TTL evidence.
export const EVIDENCE_POLICY_V0_1 = Object.freeze({
  id: 'evidence-v0.1',
  status: 'V0_TEST_ANALYTICAL',
  scope: 'ANALYTICAL_ELIGIBILITY_ONLY_NOT_EXECUTION',
  priceMaxAgeSeconds: 120,
  poolMaxAgeSeconds: 300,
  routeMaxAgeSeconds: 120,
  maxClockSkewSeconds: 5,
  minIndependentPriceSources: 2,
} as const);
export type EvidencePolicy = typeof EVIDENCE_POLICY_V0_1;
