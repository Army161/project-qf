# Project QF Launchpad: where the LP fee residuals come from (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.

- Branch `milestone/launchpad-devnet`, commit `eca09a4`, on top of the mainnet mode pass (`8ad6ccf`).
- Devnet only, read-only: this pass reads pool and position accounts. No transaction was sent. No key, fee or authority changed.
- Answers Astra's fee-ledger criterion 3: "LP 1–2 raw differences must stay explicit residuals with evidence of their origin."

## Result

Three graduated coins showed LP fees from trades a few raw units above what their pool positions received. All three are now **proven to be the DAMM v2 program's own rounding**, recomputed from the pool's accounting on devnet:

| Coin | Residual | Accumulator rounding | Settlement rounding | Unowned liquidity | Status |
|---|---|---|---|---|---|
| $VAULT | 2 raw | 0.000000052 | 1.999999947 | 0 | PROVEN_ROUNDING |
| $CASH | 1 raw | 0.000000016 | 0.999999983 | 0 | PROVEN_ROUNDING |
| $MCAT | 1 raw | 0.000000021 | 0.999999978 | 0 | PROVEN_ROUNDING |
| $PAYDAY | 0 | | | | MATCH (no residual) |

The parts are shown to 9 decimals, rounded toward zero; the exact values are fractions over 2^128 and add up exactly. 1 raw unit is 0.000001 qUSD, so the total across all three coins is 0.000004 qUSD.

On every coin the program's own LP fee total equals the ledger exactly: 3,680,619, 9,996,736 and 300,213 raw. The ledger records each trade's fee from that trade's own swap event, so the residual is not missing trades. It is fees the pool counted that no position can ever be paid, because positions are paid in whole raw units.

The Earnings page now shows "N raw residual: the pool's own rounding, proven", with the parts on hover (`evidence/lp-residual/shots/`). A residual that cannot be proven keeps its old label, "origin not proven yet", and says which check failed.

## How it is computed

After graduation, each trade's LP fee goes into the pool's fee-per-liquidity accumulator `F`, scaled by 2^128. A position with liquidity `Lᵢ` and checkpoint `ckᵢ` is paid `floor(Lᵢ × (F − ckᵢ) / 2^128)` when it settles, and its checkpoint moves to `F`. This is the formula in the MIT cp-amm SDK's `getUnClaimLpFee`. No Meteora program code was read, copied or ported.

The pool and all of its positions are read as one snapshot: the pool before and after the positions, repeated if a trade landed in between. The residual then splits exactly into three parts:

- **Accumulator rounding:** `ledger − L × F / 2^128`. Each trade adds `floor(fee × 2^128 / L)` to `F`, so each trade can lose less than `L / 2^128` raw. That is 0.000000024 raw per trade on these pools.
- **Settlement rounding:** `Σ (Lᵢ × F / 2^128 − what position i received)`, where received = claimed + pending + its unsettled share, rounded down. Each settlement drops less than 1 raw.
- **Unowned liquidity:** `(L − Σ Lᵢ) × F / 2^128`. This is liquidity that no position holds. It is 0 on all three pools.

## What has to hold before it says "proven"

| Check | What it rules out |
|---|---|
| FEES_IN_QUOTE_ONLY | fees taken in the coin itself, which the ledger does not count |
| PROGRAM_COUNTER_EQUALS_LEDGER | a trade the ledger missed or double-counted (the program's `total_lp_b_fee` must equal the ledger) |
| ALL_LIQUIDITY_IN_KNOWN_POSITIONS | a position the read did not return (Σ Lᵢ = pool liquidity, and the count equals the program's position count) |
| POSITIONS_ACCRUE_FROM_ZERO | a position that joined after the first trade (every position that has never settled has checkpoint 0) |
| CLAIMS_EQUAL_RECEIPTS | a claim made outside this app (claimed per position = proven claim receipts) |
| ACCUMULATOR_ROUNDING_BOUNDED | an accumulator gap bigger than one step per trade |
| SETTLEMENT_ROUNDING_BOUNDED | a position short by more than 1 raw per settlement |
| SINGLE_CLAIMS_RECOMPUTED | a claim that is not the program's rounding at that moment (for a position claimed once, claim = `floor(Lᵢ × checkpoint / 2^128)`) |
| PARTS_ADD_UP | an arithmetic error (the three parts equal the residual exactly) |

On VAULT and CASH, SINGLE_CLAIMS_RECOMPUTED recomputed the two real LP claims (1,599,999 and 4,998,368 raw) to the unit from each position's stored checkpoint. That is the strongest evidence: the program's past rounding is reproduced, not just bounded.

## Tests (324/324, 7 new)

- `apps/launchpad/test/lp-residual.test.ts`, 5 tests:
  - the three devnet snapshots (TEST_ONLY copies of public chain data) give exactly the parts above;
  - one field changed at a time gives NOT_PROVEN and names the failed check: counter vs ledger, claims vs receipts, a missing position, a late position, base-side fees, one extra raw unit, a claim one unit short, and positions that received more than the trades;
  - the decimal formatting;
  - an Earnings API test: proven only when the accounting proves it, otherwise the residual stays unproven with the reason, and when the accounting cannot be read.
- `packages/adapter-meteora-dbc/test/damm-accounting.test.ts`, 2 tests:
  - the reader decodes the 256-bit little-endian accumulator and checkpoints, and adds unlocked, vested and locked liquidity;
  - its numbers in the formula equal the SDK's own `getUnClaimLpFee` on the same accounts;
  - a pool that moves between reads is read again, and one that keeps moving is refused (`DAMM_ACCOUNTING_MOVING`).
- Full checks: install, typecheck, test, license:check, deps:chain, build:web and boundary all exit 0. `pnpm audit --prod` exits 1 with the same 3 known SEC-A advisories. No dependency was added. The key scan of the changed files found 0 hits.

Test results are not an audit.

## Limits, stated plainly

1. **The settlement bound counts claims per coin, not per position.** `settlementsAtMost` is the coin's number of proven LP claims, which is an upper bound for any one position. These LP positions are permanently locked, so they settle only when claimed. A pool whose positions add or remove liquidity would settle without a claim receipt. Such a pool would need a per-position settlement history, and until then a residual there could fail the bound, which is the safe direction.
2. **Dead liquidity.** The DAMM v2 pool layout has a dead-liquidity fee checkpoint. These pools have none (Σ Lᵢ equals the pool's liquidity exactly). A pool with dead liquidity fails ALL_LIQUIDITY_IN_KNOWN_POSITIONS and stays NOT_PROVEN rather than being explained.
3. **The proof is redone on each Earnings refresh.** It is not stored. If the pool moves between the check and the accounting read, the residual stays unproven for that refresh and says so.
4. **Devnet only.** On mainnet, this read would go through the same two-provider rule as other decision reads. Today the Earnings proof is display evidence, not a decision input.

## Notes for Astra

- Criterion 3 is met for every LP residual on devnet today. The residual stays listed with its amount. The new label says where it came from, and the proof is attached to the API response (`checks.lp.residual.proof`).
- Next, in your order: holder rewards on devnet. The fee ledger decides funding. A separate holder balance-over-time history decides allocation, including direct wallet-to-wallet transfers. Only rewards actually deposited are distributable. `REWARDS_SETTLEMENT_MAINNET` stays false.

## Files

- New: `apps/launchpad/src/lp-residual.ts`, `apps/launchpad/test/lp-residual.test.ts`, `packages/adapter-meteora-dbc/test/damm-accounting.test.ts`.
- Changed:
  - `packages/adapter-meteora-dbc/src/launchpad.ts` (`readDammFeeAccounting`);
  - `apps/launchpad/src/chain.ts` and `server.ts` (the Earnings proof);
  - `apps/launchpad/test/support/harness.ts`;
  - `apps/web/src/launchpad/main.ts` (the label).
- Evidence: `evidence/lp-residual/`:
  - `earnings-with-proofs.json`, the live devnet Earnings response with the three proofs;
  - `shots/`;
  - `checks.txt` and the check logs.
