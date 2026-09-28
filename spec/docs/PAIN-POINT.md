# PAIN-POINT

## The problem
Creators now have many possible quote assets, launch engines, curves, fee systems and reward structures, but no systematic way to:
1. identify **underserved** asset ecosystems (demand exists, community-token supply is not saturated);
2. verify the **economic substrate** is safe (canonical mint, no dangerous authorities or extensions, real exit liquidity);
3. choose a **technically coherent** configuration (curve, graduation threshold, fees, LP locking, rewards) that the engine actually supports;
4. see the **risks** before signing.

Today this is done by intuition, copy-paste of popular settings, and trusting token symbols.

## Evidence the problem is real
| Observation | Label |
|---|---|
| DBC accepts any classic SPL quote mint without checking freeze or mint authority (`utils/token.rs::is_supported_quote_mint`, DBC @ `f552f20`) | FACT |
| Symbols are not identity; impersonator mints are trivial to create | FACT (Token program permits any metadata) |
| Engine constraints are non-obvious (min fee 25 bps, ≥10% locked LP at day 1, base decimals 6–9, ≤16 curve points, keeper thresholds) | FACT (DBC `constants.rs`, Meteora docs) |
| Custom-quote launchpads are proliferating | DECISION input from product owner, UNVERIFIED here |

## Who feels it
- **Creators / community launchers** — want a launch that graduates and retains holders.
- **Holders of an underlying asset** — want the quote asset to be real and the community token not to be a rug.
- **Launch partners** (V2) — want a vetted, repeatable configuration pipeline.

## What success looks like (V1 measurable)
- 0 launches on FAIL quote assets.
- 100% of executed launches have a stored validation record, simulation record and decoded-preview record.
- Graduation rate and 30-day retained holders of QF launches measurably above the DBC-cohort baseline (baseline measured by own indexer; target set after first 90 days).
