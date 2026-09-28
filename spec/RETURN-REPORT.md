# Project QF — Section 32 Return Report

Date: 2026-09-26 · Stage: APPROVED WITH CHANGES → SPECIFICATION COMPLETE · No production implementation started.
Package root: `/mnt/project-files/quoteforge/spec/`

## Final recommendation: **NOT READY FOR V0 IMPLEMENTATION** — two blockers, both small

1. **Approve or reject a license exception** (one decision). The Meteora SDKs require `@solana/web3.js` v1. That library pulls in `rpc-websockets@9.3.9`, which is **LGPL-3.0-only**. The license policy this spec adopted denies LGPL, so the only V1 engine adapter cannot be built under that policy as written. Proposed exception: unmodified, server-side only, never bundled into the browser app, and license notice kept.
2. **Run the read-only program verifier from an environment with Solana RPC access.** This sandbox's network policy blocked every Solana RPC host (`403 Host not in allowlist`). Upgrade authorities, devnet presence, whether 0.2.2 is deployed, and the devnet DAMM v2 migration configs are therefore **unverified**. The verifier is V0 Step 0, and the localnet clone list depends on its output.

When both close, the recommendation becomes **READY FOR V0 IMPLEMENTATION** (localnet and devnet only) with no further spec changes.

---

## 1. Specification package manifest
```
spec/
  CLAUDE.md  README.md  PROPRIETARY-NOTICE.md  THIRD_PARTY_NOTICES.md  LICENSE-MANIFEST.json
  SPEC-VALIDATION-REPORT.md  RETURN-REPORT.md
  sbom/planned-sbom.cdx.json
  tools/program-verify/{verify-programs.mjs, package.json}      (read-only; tested: runs, fails cleanly without RPC)
  docs/  VISION PRODUCT PAIN-POINT SPEC ARCHITECTURE PROTOCOL QUOTE-ASSETS CANONICAL-ASSETS
         CONFIG-REGISTRY POLICY-ENGINE TOKEN-2022 METEORA REWARDS DATA-PROVIDERS DATA-LICENSES
         AI-ENGINE ASSET-GRAPH OPPORTUNITY-ENGINE AGENTS SECURITY THREAT-MODEL ECONOMICS LICENSES
         DEPENDENCIES TESTING DEVNET PROGRAM-VERIFICATION DEPLOYMENT COMPLIANCE ROADMAP   (30 docs)
  docs/DECISIONS/ADR-001 … ADR-010
  docs/verification/PROGRAM-VERIFICATION-2026-09-26.md
```
All 32 requested documents (including CLAUDE.md and README.md) and all 10 ADRs exist.

## 2. Changed architecture summary (vs. V1-ARCHITECTURE-REVIEW.md)
- **Product thesis.** Positioned as a Launch Intelligence + Execution System. "Arbitrary quote asset" is no longer the moat. "QuoteForge" is an internal codename only.
- **Engine.** Meteora DBC 0.2.1 plus SDK 1.5.13 is the production assumption. The `DBC_BASE_TRANSFER_FEE` capability is `EXPERIMENTAL_DISABLED` behind an 8‑condition gate (ADR‑003). No second engine.
- **Rewards.** `NONE / TRADING_FEE / DIRECT / MERKLE / EPOCH_PROPORTIONAL`, with 24h UTC epochs, TWAB, exclusions, dust roll‑forward, and a published epoch artifact. Mainnet settlement is gated. SF Rewards is pinned at `df7517d` for devnet only.
- **Jupiter** is `OPTIONAL_LEGAL_GATED` and never persisted. **Raydium** is removed except for an interface stub. **No EVM.**
- **Core data.** Own indexer, two RPCs, managed Geyser, issuer sources, Pyth, and approved providers. A `DataLicensePolicy` gate sits before persistence.
- **New components:**
  - `ConfigRegistry`: reusable DBC configs keyed by quote × template × token type × policy versions × flags.
  - `PolicyEngine`, with the `EconomicsPolicy` and `CurveTemplate` schemas.
  - `MigrationCrank`, `FeeHarvester`, `AuthorityMonitor`, `Revalidator`.
- **Validator `validator-v0.1`:**
  - FAILs non‑allowlisted freeze or mint authority, unofficial wrapped assets, tokenized securities, rejected extensions, no exit liquidity, and a failed round trip.
  - Thresholds are versioned and backtestable.
- **Liquidity.** Zero claimable creator LP. The strongest lock is DBC `*_permanent_locked_liquidity_percentage` → DAMM v2 `permanent_lock_position` (FACT, `migrate_damm_v2_initialize_pool.rs:260‑276`).
- **Base token** defaults to classic SPL. **Hybrid repositories:** `project-qf`, `project-qf-intelligence` (restricted), `project-qf-infra` (restricted).

## 3. Remaining P0 items
**Blocking V0**
| # | Item | Owner | How to close |
|---|---|---|---|
| P0‑V1 | LGPL `rpc-websockets` exception (see recommendation) | Product owner (counsel optional) | Approve the server‑side‑only exception in LICENSE-MANIFEST.json, or choose an alternative |
| P0‑V2 | Live program verification | Engineering | Run `tools/program-verify` with RPC egress (add Solana RPC hosts to the environment's allowed domains, or run locally) |

**Blocking mainnet only** (DEPLOYMENT.md §2)
| # | Item |
|---|---|
| P0‑M1 | Written Meteora or counsel confirmation of commercial interaction with the deployed DBC and DAMM v2 programs |
| P0‑M2 | Counsel‑supplied jurisdiction and sanctions policy |
| P0‑M3 | Production EconomicsPolicy and CurveTemplate from simulations |
| P0‑M4 | External security review of the tx builder, preview decoder, adapter and policy engine |
| P0‑M5 | Multisigs (2‑of‑3 hardware) for four roles |
| P0‑M6 | Final product name |
| P0‑M7 | Settlement program: verified deployment or QF deployment, plus audit (rewards gate) |

## 4. Remaining P1 items
1. `@meteora-ag/cp-amm-sdk@1.4.10` declares a runtime dependency on **`chain@^0.4.0`**. It is an unrelated npm package (a turborepo template, no license, published by non‑Meteora maintainers `b-bot`/`byronpolley`), and the SDK's dist does not import it. Neutralize it with a pnpm override and no install scripts, and report it to Meteora.
2. OtterSec shows DBC, DAMM v2 and the Rewards candidate as **not verified builds**. The DAMM v2 on‑chain hash was not returned at all.
3. `REWArD…oXi` appears to exist on mainnet (OtterSec has an on‑chain hash), but who deployed it and who holds its upgrade authority are unknown.
4. Confirm the two spec‑proposed numbers: `liquidityFailUsd = $25,000` and migration `ceilUsd` (proposed $100,000).
5. A flat fee with no fee scheduler removes DBC's anti‑sniper decay. Quantify it in simulation (ECONOMICS.md §5.2).
6. Plan for SDK 2.0.0's breaking API before ADR‑003 activation.
7. Select the second RPC or Geyser vendor, a social/news provider, and the LLM provider. Review Pyth data terms and GitHub API terms.
8. Get official bridge‑registry endpoints for canonical wrapped assets.
9. Verify each initial registry asset (USDC, USDT, JUP, …) from issuer first‑party pages. The spec asserts no mint address except wSOL.

## 5. Live verification results
- **Solana RPC:** blocked on both mainnet and devnet. No on‑chain field was read.
- **OtterSec `verify.osec.io/status` (fetched via web tool):**
  - DBC: `is_verified=false`, on‑chain hash `b3f7b765…6c44`.
  - DAMM v2: `is_verified=false`, no hash.
  - Rewards candidate: `is_verified=false`, on‑chain hash `96a2835c…d88d`.
- **Source state (git, read‑only):**
  - DBC main = `f552f20` (0.2.1).
  - `release_0.2.2` = `746806e` (PR #212 merged 2026‑09‑23).
  - PR #211 is open.
  - SDK PR #114 = version 2.0.0, changelog dated 2026‑10‑02, unmerged.

  **0.2.2 is not on main and not released.**
- Detail: `docs/verification/PROGRAM-VERIFICATION-2026-09-26.md`.

## 6. Exact dependencies and versions
| Package | Version | License |
|---|---|---|
| @meteora-ag/dynamic-bonding-curve-sdk | 1.5.13 | MIT |
| @meteora-ag/cp-amm-sdk | 1.4.10 | MIT |
| @solana/web3.js | 1.99.0 | MIT |
| @coral-xyz/anchor (transitive) | 0.31.1 | MIT OR Apache-2.0 |
| @solana/spl-token (transitive) | 0.4.15 | Apache-2.0 |
| @solana/kit | 8.3.0 | MIT |
| @solana-program/token-2022 | 0.19.0 | Apache-2.0 |
| @solana-program/token | 0.17.0 | Apache-2.0 |
| @pythnetwork/hermes-client | 3.1.0 | Apache-2.0 |
| @jup-ag/api (gated, not installed) | 6.0.48 | MIT client, API under Jupiter agreement |

Tooling: Node ≥ 22.12, pnpm 10, Agave 3.x, Postgres 16, Redis 7. Programs: DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.

## 7. Exact license findings
- **Transitive tally** (FACT, from an actual `npm install` of the pinned set): MIT 156, Apache‑2.0 17, BSD‑3 3, BSD‑2 1, ISC 1, 0BSD 1, CC0 1, (MIT OR Apache‑2.0) 1, (MIT AND Zlib) 1, **LGPL‑3.0‑only 1 (`rpc-websockets` via web3.js)**, **no license 2**. The two unlicensed packages are `chain` (the stray dependency above) and `text-encoding-utf-8`, which is Unlicense in its LICENSE.md.
- **Upstream code:**
  - Meteora DBC and DAMM v2 programs: Meteora Non‑commercial Licence. Never copy.
  - Raydium SDK V2: GPL‑3.0. Not used.
  - Uniswap v4‑core: BUSL‑1.1, converting to MIT at the earlier of 2027‑06‑15 or the ENS‑specified date.
  - Ondo GM Solana: BUSL‑1.1.
  - PONS: no LICENSE file, and it vendors BUSL and GPL files.
  - SF Rewards: MIT.
  - Token‑2022: Apache‑2.0.
- **Data:** Jupiter is LIVE_ONLY. Every other provider is UNREVIEWED until contract review.

## 8. Contradictions found and repaired
Nine were found and repaired (R1–R9 in SPEC-VALIDATION-REPORT.md). The most material:
- **R1:** a nonexistent DBC migration event.
- **R2:** CurveTemplate fields didn't match the SDK.
- **R3:** the validator had no decision for conditional extensions.
- **R7:** the LGPL policy conflicted with reality.
- **R8:** the stray `chain` dependency.

Gate result: **FAIL 0 · WARN 14 · PASS 32.**

## 9. What still prevents V0 implementation
Only P0‑V1 (the license exception decision) and P0‑V2 (running verification with RPC access). Everything else V0 needs is specified, including labeled V0_TEST economics and a `devnet_test` issuer class. Mainnet items don't block V0.

## 10. Recommendation
**NOT READY FOR V0 IMPLEMENTATION.** Close P0‑V1 and P0‑V2 and it moves to **READY** with no further spec changes. Implementation would then follow DEVNET.md Steps 0–18: localnet with cloned programs first, then public devnet, and no mainnet writes.

## Questions to return to ChatGPT
1. Approve the `rpc-websockets` (LGPL‑3.0) server‑side‑only exception? (Recommended: yes.)
2. Confirm `liquidityFailUsd = $25,000` in validator‑v0.1?
3. Confirm the migration threshold ceiling (`ceilUsd`, proposed $100,000)?
4. Neutralize the `chain` dependency with a local empty stub (recommended) or pin it exactly?
5. Accept a flat fee without anti‑sniper decay for STANDARD_V1 pending simulation, or allow the fee scheduler in V1?
