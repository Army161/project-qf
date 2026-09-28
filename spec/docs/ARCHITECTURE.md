# ARCHITECTURE — V1

## 1. Public vs. private
| Publicly observable on-chain | Private Project QF |
|---|---|
| DBC configs (curve, fees, thresholds, LP split, fee claimer), pools, swaps, completion, migration, DAMM v2 positions, fee claims, reward distributions + Merkle roots, token metadata | Canonical Asset Registry, Asset Graph, feature store, scoring versions & weights, validator thresholds, risk models, launch optimization, prompts, agent orchestration, fraud/Sybil heuristics, outcome dataset, internal APIs, deployment automation |

No QF on-chain program in V1. No secret logic on-chain. Anyone can reverse-engineer chosen parameters from chain data (INFERENCE, high confidence) — the moat is choosing them.

## 2. Components
```
                PROJECT QF — PRIVATE CLOUD
 Sources ─► Ingest ─► DataLicensePolicy gate ─► Normalize ─► Provenance tag ─► Feature Store
                                                                              │
 Canonical Asset Registry ◄──────── Quote Asset Validator (deterministic) ◄───┤
                │                                                             ▼
                └──────────────► Asset Graph ─► Opportunity Engine (deterministic scores)
                                                      │
                                                      ▼
                                        AI Launch Architect (advisory JSON)
                                                      ▼
                                   Policy Engine (EconomicsPolicy, CurveTemplate, engine constraints)
                                                      ▼
                         ConfigRegistry ─► Launch Router ─► LaunchEngineAdapter (meteora-dbc)
                                                      ▼
                                   Tx Builder ─► Simulator ─► unsigned tx + decoded preview
                                                      │
                     Creator Studio (browser) ◄───────┘  user reviews, acknowledges, signs
 ─────────────────────────────── PUBLIC CHAIN ─────────────────────────────────
  DBC config (QF multisig) → DBC pool + base mint → trading → completion → DAMM v2
 ────────────────────────────────────────────────────────────────────────────────
  Indexer (managed Yellowstone + 2nd RPC reconciliation) ─► Postgres/TSDB ─► Analytics, outcome labels
  Workers: MigrationCrank · FeeHarvester · RewardEpochJob · Revalidator · AuthorityMonitor
  RewardEngine: strategy plan → epoch artifact → settlement adapter (Direct/Merkle program; mainnet gated)
```

## 3. Package map (monorepo `project-qf/`)
| Package | Responsibility | May import |
|---|---|---|
| `packages/core` | Domain types, interfaces (`LaunchEngineAdapter`, `RewardStrategy`, `MarketDataProvider`, `SettlementAdapter`) | nothing Solana-SDK specific |
| `packages/validator` | Quote Asset Validator (pure functions over snapshots) | core, Solana Kit / token-2022 parsers |
| `packages/registry` | Canonical Asset Registry access | core, db |
| `packages/policy` | Policy Engine, EconomicsPolicy, CurveTemplate, ValidatorPolicy, versioning | core |
| `packages/tx` | Tx builder orchestration, simulation (server); `tx/decoder` = browser-safe preview decoder (Solana Kit only, no web3.js v1) | core, adapters via interface (server entry only) |
| `packages/providers` | `MarketDataProvider` impls: own-indexer, Pyth, approved commercial; `JupiterProvider` (OPTIONAL_LEGAL_GATED) | core |
| `packages/adapter-meteora-dbc` | Only place importing `@meteora-ag/*` and `@solana/web3.js` v1 | core |
| `packages/rewards` | RewardEngine, TWAB, Merkle builder, settlement adapters | core |
| `packages/sdk-internal` | Typed internal API client | core |
| `apps/web` | Creator Studio | sdk-internal, tx (preview decoder) |
| `apps/api` | API | all packages |
| `apps/indexer` | Ingestion, reconciliation | core, adapter (event decoding) |
| `apps/workers` | Crank, harvester, epoch jobs, revalidator, authority monitor | api-internal, adapters |

Intelligence (features, scoring, models, prompts, orchestration) lives in `project-qf-intelligence` (restricted); infra in `project-qf-infra` (restricted). See ADR-010.

## 4. Capability flags
| Flag | Default | Gate |
|---|---|---|
| `DBC_BASE_TRANSFER_FEE` | EXPERIMENTAL_DISABLED | ADR-003 (8 conditions) |
| `REWARDS_SETTLEMENT_MAINNET` | false | ADR-004 |
| `JUPITER_PROVIDER` | OPTIONAL_LEGAL_GATED (off) | ADR-005 legal clearance |
| `MAINNET_WRITES` | false | DEPLOYMENT.md mainnet gate |

## 5. Trust boundaries
1. Browser ↔ API: API returns unsigned transactions; browser decodes independently.
2. API ↔ LLM: LLM receives structured data only; outputs validated; no tools with side effects.
3. Workers ↔ chain: crank/harvester fee-payer keys in KMS; each key has one job and minimal balance.
4. Multisig ↔ everything: CONFIG_OWNER, FEE_CLAIMER, REWARD_AUTHORITY, DEPLOYMENT_ADMIN are 2-of-3 hardware multisigs in production.
5. Providers ↔ data: every datum passes `DataLicensePolicy` before persistence.

## 6. Data stores
Postgres 16 (+TimescaleDB) for registry, validations, configs, launches, events, ledger, epochs; object storage for epoch artifacts and metadata JSON (content-addressed); Redis for queues/caches.
