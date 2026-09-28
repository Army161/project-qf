# PROTOCOL — On-chain interactions (V1)

All interactions go through `packages/adapter-meteora-dbc` using `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` and `@meteora-ag/cp-amm-sdk@1.4.10`.

## 1. Program IDs
| Program | ID | Cluster | Source | Status |
|---|---|---|---|---|
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | mainnet-beta, devnet | DBC README @ `f552f20`; SDK README | Listed (FACT). Mainnet presence corroborated by OtterSec on-chain hash (PROGRAM-VERIFICATION.md). Upgrade authority UNVERIFIED |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | mainnet-beta, devnet | damm-v2 README @ `a85c926` | Listed (FACT). Live state UNVERIFIED |
| SF Rewards (candidate settlement) | `REWArDioXgQJ2fZKkfu9LCLjQfRwYWVVfsvcsR5hoXi` | ? | rewards README @ `df7517d` (deployment table empty) | OtterSec reports an on-chain hash (INFERENCE: deployed on mainnet); owner/authority UNVERIFIED |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | all | FACT | — |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLZ1ikBpgRfTXnh9EA` | all | FACT | — |

## 2. DAMM v2 migration configs (SDK `DAMM_V2_MIGRATION_FEE_ADDRESS`)
| MigrationFeeOption | Address |
|---|---|
| FixedBps25 (0) | `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` |
| FixedBps30 (1) | `2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k` |
| FixedBps100 (2) | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` |
| FixedBps200 (3) | `2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq` |
| FixedBps400 (4) | `AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD` |
| FixedBps600 (5) | `DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u` |
| Customizable (6) | `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` |
The SDK uses one constant set for all clusters (FACT: `constants.ts:109`). Existence on devnet is UNVERIFIED until the verifier runs.

## 3. Instructions used (SDK 1.5.13 names)
| Phase | SDK call | Signer |
|---|---|---|
| Config (once per ConfigKey) | `createConfig` | CONFIG_OWNER multisig (payer) |
| Launch | `createPool` / `createPoolWithFirstBuy` | Creator wallet (base mint keypair generated client-side) |
| Trade | `swap` / `swap2` (+ `swapQuote`) | Trader |
| Migration | `migrateToDammV2` (+ `createLocker` when `locked_vesting` used) | MIGRATION_CRANK fee payer (permissionless crank) |
| Fees | `claimPartnerTradingFee`, `claimCreatorTradingFee`, `partnerWithdrawSurplus`, `creatorWithdrawSurplus`, `partnerWithdrawMigrationFee`, `creatorWithdrawMigrationFee`, `claimPartnerPoolCreationFee` | FEE_CLAIMER multisig / creator |
| Reads | `getPoolConfig`, `getPool`, `getPoolByBaseMint`, `getPoolQuoteTokenCurveProgress`, `getPoolFeeBreakdown`, `getTokenBadge`, `deriveDbcPoolAddress`, `deriveDammV2PoolAddress`, `deriveTokenBadgeAddress` | — |

`DBC_BASE_TRANSFER_FEE` (disabled) would require `createConfig2` (program 0.2.2, SDK 2.0.0). SDK 2.0.0 is a breaking API change (services constructed via `DynamicBondingCurveClient`; narrowed exports) — FACT from SDK PR #114 changelog.

## 4. Engine facts the adapter must enforce (DBC 0.2.1)
| Fact | Source |
|---|---|
| DBC creates the base mint; existing tokens cannot be launched | `ix_initialize_virtual_pool_*`; Meteora docs |
| Non-hook base mint: mint authority revoked at init | CHANGELOG 0.2.0 |
| Base mint T22 extensions: MetadataPointer/TokenMetadata only (TransferHook only via hook configs) | `ix_initialize_virtual_pool_with_token2022*.rs` |
| Quote mint permissionless: classic SPL, or T22 with only MetadataPointer/TokenMetadata and zero transfer fee; otherwise TokenBadge | `utils/token.rs` |
| TokenBadge creation requires Meteora operator permission `CreateTokenBadge` | CHANGELOG 0.2.1 |
| New configs: DAMM v2 migration only; RateLimiter base-fee mode deprecated | CHANGELOG 0.2.1 |
| Base decimals 6–9; quote decimals any (SDK 1.5.13) | README; SDK CHANGELOG 1.5.13 |
| Base fee ≥ 25 bps, ≤ 9900 bps; migrated pool fee 10–1000 bps; locked LP ≥ 10% at day 1; lock ≤ 2 years; ≤ 16 curve points | `constants.rs` |
| Protocol share = 20% of trading fee | Meteora docs "What is DBC" |
| Meteora keepers: mainnet only; thresholds 10 SOL / 750 USDC / 1500 JUP, or ≥ $750 of quote | Meteora docs |

## 5. Events indexed
DBC Anchor events via `emit_cpi` (FACT, `event.rs` @ `f552f20`): `EvtCreateConfig`, `EvtCreateConfigV2`, `EvtInitializePool`, `EvtSwap`, `EvtSwap2`, `EvtCurveComplete`, `EvtClaimTradingFee`, `EvtClaimCreatorTradingFee`, `EvtClaimProtocolFee2`, `EvtPartnerWithdrawSurplus`, `EvtCreatorWithdrawSurplus`, `EvtWithdrawLeftover`, `EvtWithdrawMigrationFee`, `EvtUpdatePoolCreator`, `EvtClaimPoolCreationFee`, `EvtPartnerClaimPoolCreationFee`, `EvtCreateTokenBadge`, `EvtCloseTokenBadge`, plus `*WithTransferHook` variants. DBC 0.2.1 emits **no dedicated migration event**; migration is detected from the `migrate` instruction + DBC pool state (`is_migrated`) + DAMM v2 pool creation. The adapter's `decodeEvents` maps them to QF `EngineEvent`s; the indexer never parses Meteora types outside the adapter. Note for 0.2.2 readiness: `EvtCreateConfig` is removed and `EvtSwap3` added in 0.2.2 (FACT, PR #211 CHANGELOG) — the decoder MUST tolerate both.
