# ADR-001: V1 boundary

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Project QF V1 = Solana-only launch intelligence + non-custodial execution on Meteora DBC → DAMM v2.

In: Canonical Asset Registry, Quote Asset Validator, ConfigRegistry, Policy Engine, Asset Graph, Opportunity Engine, AI Launch Architect (advisory), Launch Router, Meteora DBC adapter, MigrationCrank, FeeHarvester, RewardEngine (NONE/TRADING_FEE/DIRECT/MERKLE/EPOCH_PROPORTIONAL), indexer/analytics, Creator Studio.

Out: EVM, PONS-derived contracts, Robinhood Chain, BNB, custom AMM/DEX/bridge, synthetic non-canonical assets, Raydium implementation, tokenized securities as quote assets, custom on-chain programs, custom continuous-rewards contract, native DBC base-mint transfer fees (feature-gated, ADR-003).

"QuoteForge" is an internal codename only; public name TBD after naming/trademark screen.

## Rationale
Scope is small enough to prove the loop (discover→learn) on one engine; the moat is intelligence, not arbitrary quote assets (commoditizing).

## Consequences
Any scope addition requires a new ADR.
