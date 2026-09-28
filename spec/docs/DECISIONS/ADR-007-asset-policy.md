# ADR-007: Asset and token policy

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Quote assets: validator `validator-v0.1` (QUOTE-ASSETS.md), deterministic, no AI. FAIL: non-allowlisted freeze authority; non-allowlisted live mint authority; identity by symbol; unofficial wrapped assets; tokenized securities (production V1); rejected Token-2022 extensions or combinations; no valid exit liquidity; no successful simulated round trip. Allow: verified native Solana assets; assets whose exact mint is published by the issuer; canonical representations verified from issuer/official bridge records. Thresholds ($250K liquidity, $100K volume, 3% impact, top-10 50% WARN / 80% FAIL) are versioned, backtestable policy.

Base token: classic SPL by default; Token-2022 only when a supported capability requires it. Liquidity: no immediately claimable creator LP; strongest verified lock (DBC `*_permanent_locked_liquidity_percentage` → DAMM v2 `permanent_lock_position`); never claim "permanently locked" without on-chain proof.

## Rationale
QF must be stricter than DBC, which accepts any classic SPL mint regardless of freeze/mint authority (`utils/token.rs`).

## Consequences
Excludes commercially interesting assets (e.g., tokenized stocks) in V1; accepted.

## Amendment 2026-09-27 (Decision 2)
`liquidityFailUsd = 25000` is adopted as an **EXPERIMENTAL** validator-v0.1 eligibility parameter, not a validated safety threshold. The bands are:

| Eligible liquidity | S3.2 decision |
|---|---|
| < $25,000 | FAIL |
| $25,000 to < $250,000 | WARN |
| ≥ $250,000 | PASS for S3.2 only |

- S3.2 applies to existing markets for the selected quote asset, never the new base token.
- Pools are deduplicated by chain + venue + address; provider duplicates are corroboration.
- Executable exit depth is the separate check S3.1.
- Monetary comparisons use exact decimals.
- Missing, stale or manipulated prices never yield PASS in live validation.
- Synthetic devnet assets live in a TEST_ONLY namespace and provider class and cannot be promoted to the production registry.

See QUOTE-ASSETS.md §8.

## Amendment 2026-09-27 (repair pass, QF-VAL-01/02/03)
- **Runtime schemas.** Validator inputs are checked at runtime, not only by TypeScript: Solana addresses decode to 32 bytes, modes/provider classes are enums, raw amounts are unsigned integer strings, notionals are positive, timestamps are ISO-8601 (`packages/core/src/guards.ts`). Invalid input is FAIL with an `INVALID_INPUT` reason, never PASS.
- **Required sets are policy-derived and nonempty.** S3.1 exit depth requires the policy's `requiredExitMints` (wSOL, USDC) and `minIndependentExits: 1`; an identity exit (quote asset to itself) is recorded as `IDENTITY_NOT_COUNTED`. The aggregate rejects an empty, malformed or duplicated check list (`NO_CHECKS`, `MALFORMED_CHECK`, `DUPLICATE_CHECK`).
- **Lineage.** LIVE price observations must carry `upstream` lineage; two sources with the same lineage count as one (`SAME_LINEAGE`).
- **Admission is separate from the TEST_ONLY guard.** `assertNotTestOnlyAsset` only refuses TEST_ONLY assets; it is not admission. `admitToProductionRegistry(request, sources)` (policy `registry-admission-v0.1`) requires verified provenance from an authoritative source. `AUTHORITATIVE_SOURCES_V0` is empty, so in V0 every production admission is refused: empty evidence, or an externally asserted issuer status, cannot promote an asset. The former `promoteToProductionRegistry` was removed.
