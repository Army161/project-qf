# ADR-014: Project QF runs its own launch engine

- Status: **Accepted by the owner** (2026-10-11; direction and engine choice). The engineering details below are recorded by the build threads.

## Context
Meteora never received QF's permission request: it bounced (see the 2026-10-10 correction). Without written permission, ADR-013 blocks local testing, and commercial use of the deployed Meteora programs stays uncertain. Raydium's LaunchLab is closed source, and Raydium itself signs every graduation.

## Decision
On 2026-10-11 Jeremy said "im not waiting on metora anymore im taking over and making this mine" and "from here on out we run this like its ours". He chose **"Own curve + CPMM"**. QF therefore runs two programs:

- **qf-curve** (QF original). It creates the coin and trades it on the bonding curve. It graduates the coin into its pool, burns the LP and pays the fees.
- **qf-pool**. Raydium's raydium-cp-swap at `b3187ae` (Apache-2.0, audited upstream), forked with QF's keys and pool fees capped at 1%.

The source is in `quoteforge/engine-qf/`. The app uses it only through `packages/engine` (Kit-only, browser-safe).

## Consequences
- The CLAUDE.md product boundary is amended. Superseded: "Meteora DBC → DAMM v2 only", "No custom on-chain programs in V1", and classic SPL Token for engine coins. The licensing rules are unchanged: no Meteora source, and the Apache notices are kept.
- The Meteora engine remains the devnet default until the app switches behind one setting. The switch waits for the engine's own devnet proof run to pass. The Meteora adapter is removed afterwards.
- ADR-013 still governs Meteora binaries. It does not apply to QF's own programs or the Apache-2.0 fork, which run on a local validator (`packages/engine/scripts/localnet.sh`).
- Mainnet stays BLOCKED. It needs all of:
  - an outside security review of qf-curve and of the qf-pool diff;
  - a lawyer;
  - the treasury multisig holding every admin and upgrade key;
  - Jeremy's explicit words.
