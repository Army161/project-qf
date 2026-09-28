# PRODUCT — V1

## Positioning
Project QF V1 is a **Solana launch intelligence + non-custodial execution studio**. Its value is discovery, validation, scoring, simulation and coherent configuration — not merely the ability to pick a custom quote asset.

## Definition of "permissionless quote asset" (DECISION)
A quote asset is usable in V1 when it is **compatible with the execution engine** (Meteora DBC permissionless rules, or a Meteora-issued TokenBadge) **and** it passes QF's stricter deterministic validator (`QUOTE-ASSETS.md`). QF is intentionally stricter than Meteora.

## Personas
| Persona | V1 support |
|---|---|
| Creator (launches a community token) | Full |
| Holder (trades, receives rewards) | Trade via any venue; claim rewards in QF UI |
| QF operator (policy, registry, multisig) | Internal console |
| Launch partner with own DBC config (BYO) | Not in V1 (V2 enterprise) |

## V1 capabilities
| # | Capability | Status |
|---|---|---|
| 1 | Search quote assets by mint (symbol search returns registry-verified assets first, never resolves identity by symbol) | V1 |
| 2 | Validator report (PASS/WARN/FAIL per check, evidence, policy version) | V1 |
| 3 | Opportunity/risk scores with provenance; AI narrative (advisory) | V1 |
| 4 | Configure token (name, symbol, image, description) — classic SPL by default | V1 |
| 5 | AI Launch Architect proposal → Policy Engine → simulation | V1 |
| 6 | Decoded transaction preview + risk acknowledgement + wallet signature | V1 |
| 7 | DBC pool + token creation (optionally with first buy) on a QF partner config | V1 |
| 8 | Lifecycle timeline: trading, curve progress, graduation, migration, DAMM v2 pool | V1 |
| 9 | Migration crank when Meteora keepers do not cover the pool | V1 |
| 10 | Fee harvesting (partner/creator/locked-LP) with transparent accounting | V1 |
| 11 | Rewards: NONE / TRADING_FEE accrual / DIRECT / MERKLE / EPOCH_PROPORTIONAL | V1 (mainnet settlement feature-gated) |
| 12 | Native base-mint transfer-fee launches | `EXPERIMENTAL_DISABLED` (V1.1 candidate) |
| 13 | Tokenized securities as quote assets | Not V1 (FAIL) |
| 14 | Raydium / EVM | Not V1 |

## Non-goals (V1)
Custom AMM/DEX/bridge; synthetic representations of non-canonical assets; profit projections; custody of user trading funds; public brand "QuoteForge".

## Language rules (DECISION, see COMPLIANCE.md)
Product copy and AI output must never say "guaranteed", "safe investment", "expected return", "risk free", or project prices/profits. QF describes configuration, measured data and risk.

## Economic defaults
One template, `STANDARD_V1` (`ECONOMICS.md`). Numeric values are simulation-controlled policy, not constants.
