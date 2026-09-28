# DATA-PROVIDERS

Core must run with zero third-party market-data APIs except RPC/Geyser and Pyth. Every provider sits behind `MarketDataProvider` and passes `DataLicensePolicy` (DATA-LICENSES.md) before any persistence.

## 1. Provider roles
| Need | Primary (core) | Secondary | Optional / gated |
|---|---|---|---|
| Chain state, balances, authorities | RPC provider A (finalized) | RPC provider B cross-check | — |
| Real-time events | Managed Yellowstone/Geyser gRPC (provider A) | RPC B polling backfill | — |
| Pool liquidity/volume for DBC & DAMM v2 | Own indexer + pool math | — | Approved commercial DEX data provider |
| Other-venue liquidity (quote asset exit routes) | Own indexer of major Solana AMMs' pool accounts (reads only) | Approved commercial provider | `JupiterProvider` (OPTIONAL_LEGAL_GATED) |
| USD prices | Pyth (Hermes / on-chain receiver) | Approved commercial provider | JupiterProvider (not persisted) |
| Holders/concentration | Own indexer (token accounts) | RPC `getTokenLargestAccounts` spot check | Helius DAS (if approved) |
| Developer activity | GitHub REST API (terms review in DATA-LICENSES) | — | — |
| Social/news | OPEN — no provider approved yet | — | — |

## 2. JupiterProvider (ADR-005)
- Status `OPTIONAL_LEGAL_GATED`, default off.
- When enabled: live, per-request use only (e.g., a creator-visible route preview). Responses are **never** written to the feature store, Asset Graph, registry, or logs beyond request metadata.
- Terms facts (Jupiter SDK & API License Agreement, retrieved 2026-09-26): fee-bearing licence for internal development; prohibits combining API content with scraped content and redistributing API content; requires "Powered by Jupiter"-type attribution; either party may terminate; liability cap $100; Panama law. Rate limits: keyless 0.5 RPS; Free 1 RPS; Developer $25/10 RPS; Launch $100/50 RPS; Pro $500/150 RPS.

## 3. Failure handling
- Critical reads require agreement of two RPC providers; disagreement → validator WARN/FAIL per QUOTE-ASSETS.md S1.12/S3.8.
- Provider outage never silently changes a decision: stale data beyond policy age → WARN "data stale", execution blocked for Stage 1 checks.
- Circuit breaker per provider; health exported to observability.

## 4. Selection checklist for any new provider
Commercial terms allow storage + derived metrics? Redistribution? Attribution? Termination terms? SLA? Rate limits? Data lineage? → recorded in DATA-LICENSES.md before integration.
