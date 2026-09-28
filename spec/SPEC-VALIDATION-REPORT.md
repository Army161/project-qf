# SPEC-VALIDATION-REPORT — cross-document consistency gate

Date: 2026-09-26. Method: automated scans (program IDs, package versions, risk terms) + manual review of each hit, then repair.

## 1. Checks performed
| Check | Method | Result |
|---|---|---|
| Contradictory fees | grep `20%`, `25 bps`, bps ranges; ECONOMICS vs PROTOCOL vs DEVNET | Consistent (protocol 20%, base fee 25–9900 bps, migrated 10–1000 bps) |
| Contradictory reward modes | grep `continuous`, strategy lists | Consistent: NONE/TRADING_FEE/DIRECT/MERKLE/EPOCH_PROPORTIONAL everywhere; "continuous" appears only as "no continuous contract" or as SF README-stale evidence |
| Token-extension statements | TOKEN-2022 vs QUOTE-ASSETS vs PROTOCOL | One inconsistency repaired (R3) |
| Program IDs | extracted every base58 string (14 unique) | All match sources: DBC, DAMM v2, Rewards candidate, 7 DAMM v2 migration configs, Token, Token-2022, wSOL, upgradeable loader |
| Package versions | extracted versions for 7 pinned packages | One version per package across all files |
| Stale Meteora assumptions | grep `0.2.2`, `2.0.0`, `create_config2` | Always described as unreleased/gated |
| Jupiter as mandatory | grep `Jupiter` (9 files) | Always optional/gated or reference |
| Raydium as V1 | grep (8 files) | Always "not V1"/V2/stub |
| EVM as V1 | grep (6 files) | Always excluded |
| Transfer fees production-enabled | grep (10 files) | Always EXPERIMENTAL_DISABLED or quote-side FAIL rules |
| Continuous SF Rewards | grep | Only as removed/stale |
| Tokenized securities as V1 | grep (8 files) | Always FAIL / later track |
| Open questions treated as facts | grep `OPEN`, `UNVERIFIED`, review of new numbers | Two new numbers flagged (R6) |

## 2. Contradictions found and repaired
| # | Where | Problem | Repair |
|---|---|---|---|
| R1 | PROTOCOL §5 | Listed a DBC "migration event" that does not exist | Replaced with exact event list from `event.rs`; migration detected via `is_migrated` + DAMM v2 pool creation |
| R2 | ECONOMICS §2 | CurveTemplate fields invented (`initialMarketCapQuote`…) | Aligned to SDK 1.5.13 `buildCurveWithMarketCap` params (`initialMarketCap`, `migrationMarketCap`, `FeeSchedulerLinear` start=end for flat fee) |
| R3 | QUOTE-ASSETS S1.4 vs TOKEN-2022 §2 | Validator only mapped REJECTED→FAIL; CONDITIONAL category had no decision | S1.4 now: SUPPORTED→PASS, CONDITIONAL→WARN (+badge), REJECTED/unknown→FAIL |
| R4 | DEVNET step 4 | "REJECTED/clamped" ambiguous | Deterministic: non-clampable → REJECT; clampable → clamp + report |
| R5 | ADR-003 | Implied 0.2.2 forbids LP locking | Clarified: 0.2.2 forbids `locked_vesting` (creator token vesting), not LP permanent lock (INFERENCE, verify at activation) |
| R6 | SPEC §4, QUOTE-ASSETS `liquidityFailUsd` | Spec-author numbers could read as decisions | Labeled "proposed"; listed in RETURN-REPORT for confirmation |
| R7 | LICENSES §1 vs dependency reality | Blanket LGPL deny, but `@solana/web3.js` v1 (required by Meteora SDKs) pulls `rpc-websockets` LGPL-3.0-only | Added proposed server-side-only exception, CI bundle check, notice; flagged for review |
| R8 | DEPENDENCIES / THREAT-MODEL | `@meteora-ag/cp-amm-sdk@1.4.10` declares unrelated runtime dep `chain@^0.4.0` (no license, third-party maintainers) | Added pnpm override + no install scripts + threat entry |
| R9 | ARCHITECTURE | Browser package `tx` could pull web3.js v1 | `tx/decoder` defined as browser-safe (Kit only) |

## 3. Per-document result
| Document | Result | Note |
|---|---|---|
| CLAUDE.md | PASS | |
| README.md | PASS | |
| PROPRIETARY-NOTICE.md | WARN | Legal entity name + wording for counsel |
| THIRD_PARTY_NOTICES.md | PASS | Regenerate from lockfile in CI |
| LICENSE-MANIFEST.json | WARN | LGPL exception status PROPOSED |
| sbom/planned-sbom.cdx.json | WARN | Planned deps only; real SBOM from lockfile |
| VISION.md | PASS | Competitor facts labeled UNVERIFIED |
| PRODUCT.md | PASS | |
| PAIN-POINT.md | PASS | |
| SPEC.md | PASS | NFR targets labeled proposed |
| ARCHITECTURE.md | PASS | |
| PROTOCOL.md | WARN | Live program state UNVERIFIED (RPC blocked) |
| QUOTE-ASSETS.md | WARN | `liquidityFailUsd` $25K is a spec proposal |
| CANONICAL-ASSETS.md | WARN | Initial asset mints (USDC, USDT, JUP) intentionally not asserted; bridge registry endpoints OPEN |
| CONFIG-REGISTRY.md | PASS | |
| POLICY-ENGINE.md | PASS | |
| TOKEN-2022.md | PASS | |
| METEORA.md | PASS | |
| ECONOMICS.md | WARN | Production percentages and `ceilUsd` open by design (V0_TEST values labeled) |
| REWARDS.md | PASS | |
| DATA-PROVIDERS.md | WARN | No approved social/news provider; second RPC/Geyser vendor not selected |
| DATA-LICENSES.md | WARN | Most provider classes UNREVIEWED |
| AI-ENGINE.md | WARN | Model/provider OPEN |
| ASSET-GRAPH.md | PASS | Storage choice OPEN, relational-first stated |
| OPPORTUNITY-ENGINE.md | PASS | Social/dev scores null until providers approved |
| AGENTS.md | PASS | |
| SECURITY.md | PASS | |
| THREAT-MODEL.md | PASS | |
| LICENSES.md | WARN | LGPL exception pending |
| COMPLIANCE.md | WARN | Jurisdictions/sanctions from counsel |
| DEPENDENCIES.md | PASS | |
| TESTING.md | PASS | |
| DEVNET.md | WARN | Clone list depends on Step 0 verification |
| PROGRAM-VERIFICATION.md | WARN | RPC blocked in authoring environment |
| DEPLOYMENT.md | PASS | |
| ROADMAP.md | PASS | |
| ADR-001 … ADR-010 | PASS | |

Totals: **FAIL 0 · WARN 14 · PASS 32** (incl. 10 ADRs). No WARN is an internal contradiction; each is an explicitly open, external or unverified item.
