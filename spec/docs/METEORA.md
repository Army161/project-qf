# METEORA — DBC + DAMM v2 integration

## 1. Pinned versions (production assumption)
| Item | Version | Evidence |
|---|---|---|
| DBC program source (main) | 0.2.1, commit `f552f20` (2026-09-09) | `git ls-remote` HEAD = `f552f20` on 2026-09-26 |
| DBC release branch | `release_0.2.2` @ `746806e` (PR #212 "Feat/transfer fee support" merged 2026-09-23) | FACT |
| DBC PR #211 (`release_0.2.2 → main`) | open on 2026-09-26 (merge ref present, main unchanged) | FACT |
| DBC TS SDK | `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` (2026-09-24) | npm |
| DBC SDK PR #114 | version 2.0.0, changelog dated 2026-10-02, unmerged | FACT |
| DAMM v2 program source | 0.2.4, commit `a85c926` | repo |
| DAMM v2 TS SDK | `@meteora-ag/cp-amm-sdk@1.4.10` | npm |
| Deployed bytecode ↔ source parity | UNVERIFIED (OtterSec: "On chain program not verified" for DBC and DAMM v2) | PROGRAM-VERIFICATION.md |

## 2. License boundary (ADR-002)
- Programs: Meteora Non-commercial Licence → no fork/copy/modify/derive. Interaction with deployed programs via MIT SDKs only.
- Written Meteora or counsel confirmation of commercial interaction = **mainnet launch gate**.
- SDKs (MIT): preserve notices in THIRD_PARTY_NOTICES.md.

## 3. Engine behaviour QF depends on
See PROTOCOL.md §4. Additional:
- **LP locking (FACT, `migrate_damm_v2_initialize_pool.rs:260-299`, `state/config.rs:510-538`)**: config fields `partner_permanent_locked_liquidity_percentage`, `creator_permanent_locked_liquidity_percentage` lock liquidity via DAMM v2 `permanent_lock_position`; `partner/creator_liquidity_vesting_info` vest liquidity; `partner/creator_liquidity_percentage` are immediately claimable. Locked positions can still claim trading fees.
- **Migration**: keepers run on mainnet only; QF `MigrationCrank` covers devnet and non-eligible pools. Manual Migrator UI (`migrator.meteora.ag`) is documented as mainnet+devnet compatible (SDK README) — not used by QF automation.
- **Fee collection**: `collect_fee_mode=0` collects fees in quote token only.

## 4. 0.2.2 delta (for ADR-003 readiness, FACT from PR #211 CHANGELOG)
- `create_config2` with optional `TransferFeeParameters`; `create_config` deprecated.
- With base transfer fee or a quote with nonzero fee/live fee authority: constant token supply, **no locked vesting**, `MigrationFeeOption::Customizable`, `MigratedCollectFeeMode::Compounding`; base fee Token-2022 only, ≤ 10% (SDK PR).
- Migration deposits fee-excluded amounts; fee shortfall accrues to protocol.
- `EvtCreateConfig` removed; `EvtSwap3` added.
- SDK 2.0.0 breaking API (client construction, exports).
- Audit: Meteora audit page lists DBC reports through v0.2.1 (Offside Labs); none for 0.2.2 as of 2026-09-26 (FACT at retrieval time).

## 5. Change monitoring
Weekly job: `git ls-remote` main/release branches, npm dist-tags for both SDKs, Meteora audits page, program upgrade slot (verifier). Any change → ticket + compatibility suite on mainnet-fork.

## 6. TokenBadge relationship (DECISION)
Pursue a Meteora partnership for TokenBadge issuance; owner: founder/product owner. QF never promises a creator that a badge will be issued.
