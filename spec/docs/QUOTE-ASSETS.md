# QUOTE-ASSETS — Quote Asset Validator

Policy version: **`validator-v0.1`**. Deterministic. **No AI in any decision path.** Every result stores: policy version, per-check result, evidence (source, slot or retrieval time, content hash), aggregate decision.

## 1. Interface
```ts
validate(ref: MintRef, ctx: { purpose: 'quote'; policy: ValidatorPolicy; at: 'finalized' }): ValidationResult
type ValidationResult = {
  mint: MintRef; decision: 'PASS'|'WARN'|'FAIL'; policyVersion: string; slot: bigint;
  checks: { id: string; decision: 'PASS'|'WARN'|'FAIL'|'SKIP'; reason: string; evidence: Evidence[] }[];
  validatedAt: string;
};
```
Aggregate: any FAIL → FAIL; else any WARN → WARN (creator acknowledges each); else PASS.

## 2. Stage 1 — on-chain facts (two RPCs, finalized)
| ID | Check | Rule |
|---|---|---|
| S1.1 | Existence/owner | Owned by SPL Token or Token-2022 and initialized; else FAIL |
| S1.2 | T22 native mint | FAIL |
| S1.3 | Decimals | Record; 0 decimals → WARN |
| S1.4 | Extensions | Classify with TOKEN-2022.md: SUPPORTED → PASS; CONDITIONALLY SUPPORTED → WARN (and S1.7 badge required); REJECTED or unknown extension type → FAIL |
| S1.5 | Transfer fee | Nonzero current/scheduled bps → FAIL. Zero bps with live `transfer_fee_config_authority` → FAIL. Zero bps, authority None → treat per S1.6/S1.7 (DBC 0.2.1 still requires a badge) |
| S1.6 | DBC permissionless | Replicates `is_supported_quote_mint` (DBC 0.2.1) exactly; if false → S1.7 |
| S1.7 | TokenBadge | Badge PDA (`deriveTokenBadgeAddress`) exists for mint; absent → FAIL (`reason: requires Meteora TokenBadge`) |
| S1.8 | Freeze authority | None → PASS. Present: issuer allowlisted (`CANONICAL-ASSETS.md` §4) → WARN with disclosure; **not allowlisted → FAIL** |
| S1.9 | Mint authority | None → PASS. Present: allowlisted issuer → WARN; **not allowlisted → FAIL** |
| S1.10 | Supply | 0 → FAIL |
| S1.11 | Metadata | Recorded, sanitized, never identity; mismatch with registry → WARN |
| S1.12 | Two-RPC agreement | Authorities/extensions differ between providers → FAIL (retry once) |

## 3. Stage 2 — canonicality & asset policy
| ID | Check | Rule |
|---|---|---|
| S2.1 | Registry status | `verified` → PASS; `pending` → WARN (production: FAIL for execution, see §6); absent → FAIL for execution in production, WARN in devnet |
| S2.2 | Impersonation | Another registry asset shares symbol/name with a different mint → FAIL |
| S2.3 | Wrapped/bridged | Provenance verified from issuer or official bridge registry → PASS; otherwise FAIL |
| S2.4 | Legal asset class | `tokenized_security` → FAIL (production V1); `unknown` → WARN |
| S2.5 | Compliance hooks | Sanctioned issuer/asset (COMPLIANCE.md hook) → FAIL |

## 4. Stage 3 — market viability (thresholds are `validator-v0.1`, backtestable)
| ID | Check | WARN | FAIL |
|---|---|---|---|
| S3.1 | Exit liquidity: executable route asset→SOL and asset→USDC at notional = planned `migration_quote_threshold`, from own indexer pool math or approved provider | impact > 3% | no route / no valid exit liquidity |
| S3.2 | Eligible liquidity of **existing markets for the selected quote asset** (never the new base token), pools deduplicated by chain + venue + address (amended 2026-09-27, Decision 2) | $25,000 ≤ x < $250,000 | < $25,000, or insufficient price evidence, or no eligible pool |
| S3.3 | 24h volume (wash-adjusted, own indexer) | < $100,000 | — |
| S3.4 | Top-10 non-program holder share | > 50% | > 80% |
| S3.5 | Oracle (Pyth feed id) | missing | — |
| S3.6 | Round-trip simulation buy→sell via `simulateTransaction` | received < expected − slippage bound | sell fails / no successful round trip |
| S3.7 | Keeper eligibility (10 SOL / 750 USDC / 1500 JUP or ≥ $750) | not eligible (QF crank required) | — |
| S3.8 | Source disagreement (price > 2%, holders > 10%) | disagreement | — |

`$` values use median of Pyth and approved providers; Jupiter price MAY be used only when `JUPITER_PROVIDER` is enabled and never persisted (ADR-005).

## 5. Revalidation
At config creation, at launch (Stage 1 re-read at finalized immediately before building the tx), hourly for quotes with active launches, and immediately on AuthorityMonitor events (`SetAuthority`, `FreezeAccount` on pool vaults, extension changes).

## 6. Environment differences
| Env | Registry-absent asset | Stage 3 |
|---|---|---|
| localnet/devnet | WARN (test issuer class `devnet_test`; synthetic assets use the `test-only:` namespace and provider class `TEST_ONLY`) | Deterministic TEST_ONLY provider; results labelled `TEST_ONLY`/MOCK and capped at WARN, never PASS |
| mainnet | FAIL for execution | Live |

## 7. Policy object
```json
{ "id": "validator-v0.1", "liquidityWarnUsd": 250000, "liquidityFailUsd": 25000,
  "volume24hWarnUsd": 100000, "maxRouteImpactBps": 300, "top10WarnPct": 50, "top10FailPct": 80,
  "priceDisagreementPct": 2, "holderDisagreementPct": 10, "revalidateActiveSeconds": 3600,
  "allowTokenizedSecurities": false }
```
Changes require a new version id, two-person approval, and a backtest report (OPPORTUNITY-ENGINE.md §6). `liquidityFailUsd = 25000` was **adopted 2026-09-27 (Decision 2) as an EXPERIMENTAL validator-v0.1 eligibility parameter, not a validated safety threshold**.

## 8. Amendment 2026-09-27 — Decision 2 (implemented in `project-qf/packages/validator`)

**Scope.** S3.2 evaluates existing markets whose pools contain the selected quote mint. Pools for the newly launched QF base token are excluded (`LAUNCHED_BASE_TOKEN_POOL`).

**Bands.** All comparisons use exact 18-decimal fixed-point arithmetic (`@project-qf/core` `Dec`), with no floats.

| Eligible USD | S3.2 decision |
|---|---|
| < 25,000 | FAIL |
| 25,000 ≤ x < 250,000 | WARN |
| ≥ 250,000 | PASS for S3.2 only. No other check is implied. |

Boundary tests at 24,999.99 / 25,000 / 249,999.99 / 250,000 are in `packages/validator/test/liquidity.test.ts`, with fixtures in `packages/validator/fixtures/liquidity-boundaries.json` (MOCK).

**Deduplication.**
- Pools are keyed by `chain:venue:poolAddress`.
- Several provider reports of one pool are corroboration, not additive liquidity. The minimum reported reserves per side are kept, and `corroboratedPools` is recorded.
- Pools are excluded as `WRONG_CHAIN`, `QUOTE_MINT_NOT_IN_POOL`, `STALE_POOL`, `BAD_RESERVE` or `TEST_ONLY_IN_LIVE`.

**Price evidence (`evidence-v0.1`, status `V0_TEST_ANALYTICAL`; accepted by the owner 2026-09-27, EV-1, as analytical/eligibility policy only, not production execution freshness).**

| Parameter | Value |
|---|---|
| price max age | 120 s |
| pool max age | 300 s |
| route max age | 120 s |
| clock skew | 5 s |
| independent price sources | at least 2 |

- Missing, stale, future-dated or single-source price evidence → FAIL `INSUFFICIENT_EVIDENCE`.
- Disagreement above `priceDisagreementPct` uses the lowest price and caps the result at WARN. Manipulated-price tests cover this.
- Live validation with insufficient evidence never becomes PASS. A required check that is missing or SKIP in LIVE mode fails the aggregate.

**Exit depth (S3.1).** This is a separate check. Per exit mint, a fresh route must fill the full notional (the planned migration quote threshold). A missing or partial route → FAIL; impact above 300 bps → WARN. High TVL is never a substitute.

**TEST_ONLY.**
- Synthetic assets use ids with the `test-only:` prefix and provider class `TEST_ONLY`.
- In TEST_ONLY mode no check or aggregate can be PASS.
- `promoteToProductionRegistry` throws on the TEST_ONLY class, prefix or evidence.

## 9. Amendment 2026-09-27 — repair pass (EV-1, QF-VAL-01/02/03, QF-POL-01/02)
- **EV-1.** The `evidence-v0.1` values above (price 120 s, pool 300 s, route 120 s, skew 5 s, ≥ 2 independent sources) are V0_TEST analytical/eligibility policy (`scope: ANALYTICAL_ELIGIBILITY_ONLY_NOT_EXECUTION`). They are not a production execution TTL. `EXECUTION_FRESHNESS_POLICY` is UNDEFINED and signing stays disabled (`signingPermitted: false`).
- **Lineage.** LIVE price observations must name their `upstream`; two sources with the same upstream count once (`SAME_LINEAGE`); missing lineage is FAIL `MISSING_LINEAGE`.
- **Newer adverse evidence first.** A recheck evaluates newer price, route and authority evidence before accepting an older observation that is still inside its TTL; adverse newer evidence invalidates the earlier approval immediately.
- **Acknowledgement.** Every applicable WARN (S3.1, S3.2 and any other) makes the proposal `REQUIRES_ACKNOWLEDGEMENT`. The acknowledgement digest binds the exact warnings, evidence digest and policy versions; changed evidence makes a prior acknowledgement stale.
- **Runtime schemas and required sets.** S3.1 requires the policy's `requiredExitMints` (wSOL, USDC) and `minIndependentExits: 1`; identity exits are not counted. Invalid modes, addresses, notionals or amounts fail. See ADR-007 amendment (repair pass) for registry admission.
