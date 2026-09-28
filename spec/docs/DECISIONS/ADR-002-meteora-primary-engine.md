# ADR-002: Meteora DBC as primary engine, consumed via MIT SDKs

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Use Meteora DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) with DAMM v2 (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) migration. Production assumption: program 0.2.1 (main `f552f20`), SDK `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, `@meteora-ag/cp-amm-sdk@1.4.10`.

Never fork, copy, modify or derive from Meteora program source (Meteora Non-commercial Licence). All engine calls are isolated in `packages/adapter-meteora-dbc`; web3.js v1 stays inside it. QF domain types at every boundary.

Written Meteora or counsel confirmation on commercial interaction with deployed programs is a mainnet launch gate.

## Rationale
DBC is audited (Offside Labs through v0.2.1, Zenith, OtterSec, Code4rena), integrated with aggregators, and supports custom quote mints within TokenBadge policy; SDKs are MIT.

## Consequences
Vendor dependency: Meteora controls upgrades and policy (e.g., 0.2.0 invalidated some existing configs). Mitigated by version pinning, daily config dry-runs, upgrade monitoring, and the engine interface.

## Amendment 2026-09-27 (Decisions 1 and 4; ADR-012, ADR-013)
- **Adapter licence boundary.** `rpc-websockets@9.3.9` (LGPL-3.0-only), reached through web3.js v1, is approved only as exception QF-LIC-EX-001: unmodified, for internal server-side adapter use. The adapter's `package.json` exports only a `node` condition, and the adapter throws if `window` exists. `pnpm boundary` proves the web graph and artifacts are clean.
- **cp-amm-sdk.** `@meteora-ag/cp-amm-sdk@1.4.10` installs without its stray `chain` dependency, via a targeted override (QF-DEP-RM-001). The adapter compatibility suite passes without it (`packages/adapter-meteora-dbc/test/compat.test.ts`). It covers:
  - CJS and ESM import;
  - `buildCurve` validation;
  - quote fees;
  - createConfig, createPool, swap, migrateToDammV2, claimTradingFee and claimCreatorTradingFee transaction construction, against a labelled MOCK RPC and decoded by the independent Kit decoder.
- **Program copies.** Consuming the SDKs (MIT) does not license the programs. Local clones or rebuilds of the programs wait for written permission (ADR-013).
