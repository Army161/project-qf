# ADR-004: Vendor-neutral RewardEngine; Direct/Merkle settlement; mainnet gated

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Strategies: NONE, TRADING_FEE, DIRECT, MERKLE, EPOCH_PROPORTIONAL (indexed balances → deterministic TWAB → exclusions → allocations → Merkle tree → Merkle settlement). No custom continuous-rewards contract. 24-hour UTC epochs; dust rolls forward; every epoch publishes a reproducibility artifact (REWARDS.md §5).

Settlement adapters are pluggable. Dev/devnet: Solana Foundation Rewards pinned at `df7517d` (MIT) deployed under a test authority. Mainnet settlement flag `REWARDS_SETTLEMENT_MAINNET=false` until: verified deployment or QF deployment of pinned source; reproducible build; independent security review/audit; verified upgrade authority; passing integration tests. TRADING_FEE accrual may run while settlement is disabled.

## Rationale
SF Rewards current source contains only Direct and Merkle (continuous/points removed in `4f5a8c6`, README stale); audited-through `aa1cfd9` with 75 later commits; deployment unverified.

## Consequences
QF computes allocations off-chain → QF is trusted for allocation correctness; mitigated by determinism and public artifacts.

## Amendment 2026-09-27 (offline implementation)
Implemented in `project-qf/packages/rewards` with exact bigint arithmetic and tests. The package covers:
- TWAB balance-units;
- allocation (`ALLOCATION_POLICY_V0_TEST`) with exclusions, minimum eligible balance, floor allocation, dust roll-forward and per-holder carry below the minimum payout;
- a conservation assertion that throws on any mismatch;
- the allocation file hash;
- a Merkle tree in the SF Rewards `df7517d` leaf/parent format, as an independent implementation;
- proof verification.

The mock UI recomputes the Merkle root in a browser worker and matches the Node root (e2e test). No settlement transaction is built or sent. Mainnet settlement stays gated.
