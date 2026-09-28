# ADR-003: Base-mint transfer fee is feature-gated

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Capability `DBC_BASE_TRANSFER_FEE` exists with status `EXPERIMENTAL_DISABLED`. V1.0 must not depend on it and must not add a second launch engine to obtain it.

Evidence (FACT, 2026-09-26): PR #212 merged into `release_0.2.2` (`746806e`, 2026-09-23) adding `create_config2` with `TransferFeeParameters`; PR #211 (`release_0.2.2 → main`) open; main still `f552f20` (0.2.1); SDK PR #114 (2.0.0, breaking API) unmerged. 0.2.2 transfer-fee configs require constant supply, no locked vesting, `MigrationFeeOption::Customizable`, `MigratedCollectFeeMode::Compounding`; base fee Token-2022 only, ≤ 10% (SDK PR).

Activation requires ALL: (1) 0.2.2 merged to main; (2) deployed program verified; (3) official SDK with 0.2.2 support released; (4) exact program/SDK versions pinned; (5) security/audit delta evaluated; (6) devnet integration suite passed; (7) mainnet read-only verification passed; (8) explicit feature flag enabled.

## Rationale
Meteora is shipping the primitive; building around it now adds complexity with no durable benefit.

## Consequences
V1.0 reward economics rely on trading fees only. 0.2.2 transfer-fee configs require constant supply, Compounding migrated-fee mode and no `locked_vesting` (creator token vesting); STANDARD_V1 must be re-simulated under those constraints at activation. LP permanent-lock settings are not restricted by that list (INFERENCE from the CHANGELOG wording; verify at activation).

## Amendment 2026-09-27
No change to the gate.
- `DBC_BASE_TRANSFER_FEE` stays `EXPERIMENTAL_DISABLED` in `packages/core/src/flags.ts`.
- `validateIntent` rejects any intent that requires it (`CAPABILITY_DISABLED`) and any transfer-hook path (`NOT_IN_V1_SCOPE`).
- The SDK 1.5.13 IDL has no `create_config2`; a compatibility test asserts this.
- SDK 2.x is not installed.
- The verifier reports a `has_create_config2` IDL indicator only. It never treats it as proof of a deployed release.
