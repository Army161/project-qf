# REWARDS — Reward Engine (V1)

## 1. Strategies (DECISION)
| Strategy | Meaning | Settlement |
|---|---|---|
| `NONE` | No holder rewards | — |
| `TRADING_FEE` | Accrue the reward share of QF partner fees (ECONOMICS.md) into the reward ledger/vault | Settled later via DIRECT or MERKLE |
| `DIRECT` | Per-recipient on-chain allocations (small lists) | Direct distribution |
| `MERKLE` | Fixed recipient set per distribution | Merkle distribution |
| `EPOCH_PROPORTIONAL` | Indexed balance history → TWAB → exclusions → allocations → Merkle | One Merkle distribution per epoch |
No continuous-rewards contract. Transfer-fee (Token-2022) rewards are not V1.0 (ADR-003).

## 2. Interfaces
```ts
interface RewardStrategy { kind: RewardStrategyKind;
  plan(epoch: EpochWindow, policy: {exclusion: ExclusionPolicy; allocation: AllocationPolicy}): Promise<RewardPlan>; }
interface SettlementAdapter { id: string;               // e.g. 'sf-rewards@df7517d'
  fund(plan: RewardPlan): Promise<UnsignedTx[]>;         // REWARD_AUTHORITY multisig signs
  settle(plan: RewardPlan): Promise<UnsignedTx[]>;
  claim(claimant: string, proof: MerkleProof): Promise<UnsignedTx>;   // holder signs
  verify(plan: RewardPlan): Promise<ReconciliationReport>; }
```

## 3. Epoch policy (DECISION)
- 24-hour UTC epochs; `start_slot` / `end_slot` = first/last finalized slot with block time in the window.
- TWAB per holder over the epoch from indexer balance history (slot-weighted).
- Exclusions (`ExclusionPolicy@1`): DBC/DAMM vaults and pool authorities, other DEX vaults, QF protocol accounts, reward vaults, burn/dead addresses, program-owned/PDA token accounts identified by policy, flagged Sybil clusters (policy-defined heuristics, versioned).
- Minimum eligible TWAB and minimum payout; amounts below minimum payout **roll forward** to the holder's next epoch.
- Reward asset: the quote token (fees are collected in quote).

## 4. Settlement program selection
Candidate: Solana Foundation Rewards (`solana-foundation/rewards`, MIT).
| Fact | Evidence |
|---|---|
| Only Direct + Merkle instructions exist in current program source | `program/src/instructions/` = definition, direct, emit_event, impl_instructions, merkle @ `df7517d`; continuous/points removed in `4f5a8c6` (2026-05-18) |
| README still advertises Continuous/Points → stale | README @ `df7517d` |
| TransferHook mints rejected | `utils/token_utils.rs:14` |
| Transfer-fee mints: Merkle creation rejects underfunded vault after fees | commit `4f5a8c6` message |
| Merkle root fixed per distribution | `state/merkle_distribution.rs` |
| Audit: OtterSec, audited-through `aa1cfd9`; 75 commits after | `audits/AUDIT_STATUS.md` |
| Deployment table empty; OtterSec index has an on-chain hash for `REWArD…oXi`, not verified | README; verify.osec.io 2026-09-26 |

## 5. Epoch artifact (required, content-addressed, published)
```json
{ "epochId": "2026-10-01", "chain": "...", "launch": "<pool>", "startSlot": 0, "endSlot": 0,
  "inputHash": "sha256(balance-history export)", "exclusionPolicyVersion": "exclusion@1",
  "allocationPolicyVersion": "allocation@1", "holderAllocationFileHash": "sha256",
  "merkleRoot": "base58/hex", "totalAllocated": "u64", "rolledForward": "u64",
  "settlementTx": "signature|null", "settlementAdapter": "sf-rewards@<commit>", "claimStatus": { "claimed": 0, "total": 0 } }
```
Determinism test: two independent runs over the same inputs produce identical `holderAllocationFileHash` and `merkleRoot`.

## 6. Gates
| Environment | Allowed |
|---|---|
| localnet/devnet | Pinned Direct/Merkle implementation (SF Rewards @ `df7517d` deployed under a test authority) |
| mainnet | `REWARDS_SETTLEMENT_MAINNET=false` until: verified deployment **or** QF deployment of pinned source; reproducible build; independent security review/audit; verified upgrade authority; passing integration tests. Fee accrual (TRADING_FEE) MAY run while settlement is disabled. |
