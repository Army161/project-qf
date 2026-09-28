# ADR-005: Jupiter is an optional, legally gated provider

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
`JupiterProvider` implements `MarketDataProvider` with status `OPTIONAL_LEGAL_GATED` (default off). Core runs without it. Jupiter responses are never persisted into the feature store, Asset Graph or registry until the Jupiter SDK & API License Agreement is cleared by counsel or replaced by acceptable commercial terms. Core data: own indexer, raw chain state (two RPCs, Geyser), issuer first-party sources, Pyth, separately approved commercial providers.

## Rationale
Agreement restricts combining API content with scraped content and redistributing API content, allows termination by either party, caps liability at $100; Jupiter also operates a competing DBC launch product (Studio).

## Consequences
Some Stage-3 signals (routes, organic score) must be rebuilt from own indexing; higher engineering cost, lower legal/vendor risk.
