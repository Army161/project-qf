# Project QF Launchpad: holder rewards on devnet (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.

- Branch `milestone/launchpad-devnet`, commit `0da37b3`, on top of the LP residual proof (`4f2a421`).
- Devnet only. The first part of this pass (`0da37b3`) computed and showed holder rewards with no payout; the test round below is in progress.
- Chain writes in this pass: one throwaway devnet wallet took the app's test faucet, bought FROG through the app and sent part of it directly to another wallet. That was done to prove that direct transfers count. The wallet's key was held in memory only and never written to disk. No fee, key, authority or multisig setting changed. Mainnet is unchanged and read-only.
- Answers Astra's fee-ledger criteria (relayed 2026-10-05 20:54Z). This is not a request to start payouts.

## Status (in progress, 2026-10-05 22:55Z)

Jeremy chose **Test payout** at 22:28Z: one devnet test round in test qUSD, with 2-of-3 test approvals. Done so far:

- A rewards vault (the test multisig's vault index 1) and the deposit and payout binding, committed in `ebb5c17`.
- VAULT's 2026-10-05 earmark (2.020202 qUSD) deposited from the test treasury into the rewards vault through treasury
  proposal #5 (propose `2tFcAp4V…`, approve `Bcb9ZUB6…`, execute `5dfSB2nd…`), and read back as a deposit.

The payout waits for that day to end at 00:00Z and its record to freeze. This report is rewritten with the payout and
its transactions once it lands. Mainnet settlement stays off.

## Astra's criteria, and where each one is met

| Astra's words | What the build does | Evidence |
|---|---|---|
| "the fee ledger determines the funding" | Each epoch's **earmark** is the holder-reward share (50%, ECONOMICS_V0_TEST) of the platform fee share of every curve trade in the epoch. Each trade's fee is read from that trade's own swap event. A trade whose fee is not read yet keeps the epoch from being final. | `funding.earmarkedRaw`, `earmarkTrades`, `unknownFeeTrades` per epoch |
| "wallet-balance history determines who receives it … including direct transfers" | Each holder's share is their slot-weighted average balance over the epoch. It comes from every token-account balance change in every finalized transaction that touched the coin, read from each transaction's own before and after balances. Trades are not used for this. | Live: wallet `8RKJ…nAYG` never traded FROG. It received FROG by direct transfer (`57SoULGU…`) and is a FROG holder in the 2026-10-05 epoch. |
| "accrued or earmarked fees are not yet funded rewards … must be backed by assets actually deposited into the designated rewards vault" | **Funded** = proven deposits for that epoch + the previous epoch's rounding remainder. Only funded amounts are allocated. The earmark is shown beside it and never allocated. The record says so: `earmarkIsNotFunding: true`. There is no rewards vault yet, so funded = 0 and allocated = 0 on every epoch. | `apps/launchpad/test/rewards.test.ts` test 1 (earmark 500 → allocated 0) and test 3 (deposits allocated in proportion, conserved to the unit) |
| "A difference should not automatically be classified as rounding merely because it is small." | Closed in the previous pass. Each LP residual is proven from the pool's own fee accounting, or it stays unproven and names the failed check. | `handoffs/LP-RESIDUAL-PROOF-2026-10-05.md` |
| "not … authorization to start reward payouts" | No code path builds or sends a payout. The API states `settlement: { mainnet: false, devnet: "NOT_AUTHORIZED" }`, and the Rewards page shows "no payouts". | `evidence/rewards/api/rewards.json` |

## Live devnet run

The server was restarted on this commit. The new tables are empty after the schema 7 migration, so it read every holder history from devnet from scratch. Read at about 22:24Z:

| Coin | Token accounts | Transactions | History vs chain | Final epochs, frozen (sha256) | 2026-10-05 (running) | Earmarked, all epochs |
|---|---|---|---|---|---|---|
| $CASH | 3 | 10 | complete | none (launched 10-05) | 1 holder, 2 excluded | 2.020522 qUSD |
| $FROG | 5 | 6 | complete | 10-03 `089e8186…6e5311`, 10-04 `2c544b3e…d2afba` | 4 holders, 1 excluded | 0.524 qUSD |
| $MCAT | 7 | 12 | complete | 10-03 `643252fd…31fd83`, 10-04 `6fe16a5b…9414b2` | 5 holders, 2 excluded | 2.020786 qUSD |
| $PAYDAY | 3 | 7 | complete | none (launched 10-05) | 1 holder, 2 excluded | 2.020522 qUSD |
| $TIPJAR | 2 | 3 | complete | none (launched 10-05) | 1 holder, 1 excluded | 0.400159 qUSD |
| $TRSY | 5 | 7 | complete | none (launched 10-05) | 3 holders, 1 excluded | 0.210015 qUSD |
| $VAULT | 7 | 10 | complete | none (launched 10-05) | 4 holders, 2 excluded | 2.020202 qUSD |

- Totals: 9.216206 qUSD earmarked, 0 deposited, 0 allocated. Every coin's listed accounts add up to its supply (1,000,000,000 tokens).
- **Determinism across two independent reads.** Earlier today the same epochs were computed on a copy of the database, from a history read separately. FROG 10-03 and MCAT 10-04 gave the same hashes then as now. Each recompute is checked against the frozen record ("frozen, recomputed identically" on the page).
- Epoch windows:
  - 2026-10-03 is slots 506,806,896 to 507,172,682.
  - 2026-10-04 is 507,172,683 to 507,541,151.
  - 2026-10-05 starts at 507,541,152 and is still running.
- The direct-transfer demo, in `evidence/rewards/direct-transfer-flow.json` (signatures and public addresses only):

| Step | Transaction | Detail |
|---|---|---|
| Faucet | `383AY1sH…` | throwaway wallet `CBG61DYr…SWUsb` took the app's test faucet |
| Buy | `3yQADwrh…` | bought 2,010,649.811201 FROG through the app |
| Transfer | `57SoULGU…` | sent 1,005,324.9056 FROG directly to `8RKJ…nAYG` |

  After one sync, FROG showed 5 accounts and 6 transactions, still complete, and `8RKJ…nAYG` is a holder.

## How it works

**Holder history** (`apps/launchpad/src/holders.ts`, `packages/rewards/src/history.ts`):
1. List every token account of the mint at `finalized` (`getProgramAccounts`, classic SPL Token, 165-byte accounts).
2. For each account, read its finalized signatures, newest cursor first, then each transaction's before and after token balances for this mint. An account that appears in a transaction but is no longer listed (closed since) is added and read too.
3. A transaction the RPC does not serve yet is stored as PENDING and retried. A failed transaction is stored with no balance change.
4. Replay every account from zero. An account's balance at the end of a slot is its balance before the slot plus the sum of (after − before) over that slot's transactions, so the order of transactions within a slot never matters. Owners are summed per slot.

**Coverage**: four checks, all at one finalized slot. The epoch cannot be final unless all four hold through its last slot.

| Check | What it rules out |
|---|---|
| ALL_TRANSACTIONS_READ | a transaction listed but not read |
| REPLAYS_CLEANLY | a gap: an account whose history does not start from zero, or a change that does not continue from the replayed balance |
| REPLAY_EQUALS_CHAIN | a missed change: every listed account must replay to its on-chain balance, and every closed account to zero |
| ACCOUNTS_ADD_UP_TO_SUPPLY | a holder account the listing did not return |

**Why this is complete.** The coin's whole supply starts in the bonding-curve pool's vault, and the mint authority is gone, so no new tokens can appear. Every other token account can only be funded by a transaction that also touches an account that already holds the coin, and that transaction is read when that account's signatures are read. So every account is reached. The supply check closes the loop: if one were missed, the listed balances would not add up to the supply.

**Epochs** (`packages/rewards/src/epoch.ts`, `apps/launchpad/src/rewards.ts`):
- An epoch is one UTC day. Its window starts at the first finalized slot whose block time is at or after midnight and ends before the next day's first slot. The boundary is found by binary search over finalized blocks and cached.
- A holder's weight is their balance × slots held, over the window (`twabBalanceUnits`).
- Exclusions (`exclusion@1`), each written into the record with its reason:
  - named accounts: operator, platform fee claimer, treasury multisig and vault, the DBC pool authority and the DAMM v2 pool authority;
  - burn addresses;
  - any owner that is not a wallet key (off the ed25519 curve), such as pools, vaults and program accounts.
- Allocation (`allocation-v0-test`) divides only the funded amount, in proportion to weight, rounded down. Remainders roll into the next epoch. Payouts form a Merkle tree in the SF Rewards leaf format.

**Status:**
- FINAL: the day has ended, history coverage is complete through its last slot, the previous epoch is final, and every trade's fee in it is read.
- OPEN: still running, shown as a preview.
- INCOMPLETE: ended but not proven. It lists why.

A final epoch's record (`qf-reward-epoch@1`) is frozen with its sha256 the first time. If a later recompute differs, the frozen record is kept and the epoch shows "recomputed differently" with both hashes.

**The record** has the REWARDS.md §5 fields:
- `epochId`, `chain`, `launch`, `startSlot`/`endSlot`;
- `inputHash`, the sha256 of every balance change used;
- the exclusion and allocation policy versions;
- `holderAllocationFileHash`, `merkleRoot`, `totalAllocated`, `rolledForward`;
- `settlementTx: null`, `settlementAdapter: null`, `claimStatus`.

It adds the mint, the window, the funding block (earmark, deposits, funded, `earmarkIsNotFunding`) and the excluded owners. With nothing funded, the Merkle tree is empty and its root is all zeros.

**API and page.**

| Route | Returns |
|---|---|
| `GET /api/lp/rewards` | every coin's coverage and epochs |
| `GET /api/lp/rewards/{mint}/{YYYY-MM-DD}` | one epoch: holders and shares, exclusions, payouts with Merkle proofs |
| `…/artifact.json` | the frozen record; 404 while the epoch is open |

The new Rewards page (`#/rewards` and `#/rewards/{mint}/{day}`) shows all of this read-only, with the funding rule and "no payouts" on every view. Screenshots for desktop and phone are in `evidence/rewards/shots/`. The Fees and Earnings notes now say the earmark is not money and link to Rewards.

## Tests (334/334, 10 new)

- `packages/rewards/test/history.test.ts`, 7 tests:
  - trades and direct transfers move balances alike;
  - in-slot order and input order don't change the result;
  - an owner change moves the balance;
  - gaps are reported, never smoothed over (no creation, a missing middle transaction, two owners in one slot, a duplicate, the cut-off);
  - replayed balances against the chain, including closed accounts;
  - `exclusion@1`;
  - UTC epochs.
- `apps/launchpad/test/rewards.test.ts`, 3 tests:
  - a direct transfer is counted, the pool is excluded, earmark 500 against funded 0 allocates 0, and the final record is frozen and recomputed identically;
  - an unread transaction keeps the epoch INCOMPLETE, a replay gap or a supply gap gives MISMATCH, and nothing is frozen;
  - deposits are allocated in proportion and conserved to the unit, the Merkle proofs verify, and the result is deterministic.
- Full checks (`evidence/rewards/checks.txt`): typecheck, test, license:check, deps:chain and boundary all exit 0.
  - `pnpm audit --prod` exits 1 with the same 3 known SEC-A advisories (bigint-buffer, uuid, stream-json), all under the server-side Meteora adapter.
  - No external dependency was added. One workspace link was added (`@project-qf/rewards` in the launchpad app).
  - The key scan of the changed files found 0 hits.

Test results are not an audit or a readiness claim.

## Limits, stated plainly

1. **One RPC provider.** Devnet has no free second provider, so coverage says `SINGLE_PROVIDER`. CLAUDE.md requires reward-settlement reads at finalized and cross-checked against a second provider. Before any mainnet settlement, the history reads and the coverage checks must run on two providers.
2. **Block times are assumed to rise with slots** for the epoch boundary search. Solana block times are validator-voted and can be off by seconds. The boundary is cached once found, so a later re-read cannot move it.
3. **The earmark counts curve fees only.** After graduation, the platform earns LP fees through its locked DAMM v2 position, paid when the position is claimed, not per trade. Whether those claims add to the holder-reward earmark is an economics decision that hasn't been made. Today they don't.
4. **No Sybil rules** (`sybilHeuristics: []`). Under proportional allocation, splitting a balance across wallets does not raise its total share. It only matters for the minimum payout of 1 raw.
5. **Holders using a program wallet are excluded.** The off-curve rule excludes pools and vaults, but it also excludes anyone holding through a multisig vault or a smart wallet. That is safe for now, but it is a policy question before mainnet.
6. **Scale.** Reading each account's signatures is fine for these coins (at most 7 accounts each). A busy mainnet coin with thousands of holders would need an indexing provider. The per-pass budget (40 transactions per coin) keeps public RPCs from rate-limiting us, and coverage shows "catching up" until it is through.
7. **Classic SPL Token only.** Launched coins are classic SPL by rule. A Token-2022 coin would not be listed.

## Notes for Astra

- Your funding/allocation split is implemented as two separate inputs that never mix. The fee ledger only ever produces the earmark. The balance history only ever produces weights. Only deposits produce money to allocate.
- The deposit source is a stub returning none, because there is no rewards vault. If Jeremy picks "Test payout", deposits become proven transfers into a dedicated rewards vault (a second vault of the test multisig, 2-of-3), read back from their own transactions like the treasury receipts.
- Payouts would use the DIRECT strategy (transfers through multisig proposals) from the frozen Merkle list. The SF Rewards program is not on devnet.

## Files

- New:
  - `packages/rewards/src/history.ts`, `exclusion.ts`, `epoch.ts`, and `packages/rewards/test/history.test.ts`;
  - `apps/launchpad/src/holders.ts`, `rewards.ts`, and `apps/launchpad/test/rewards.test.ts`.
- Changed:
  - `packages/adapter-meteora-dbc/src/launchpad.ts` (finalized token-account listing, supply, per-transaction balance changes, epoch boundary search, backoff on 429);
  - `apps/launchpad/src/chain.ts`, `store.ts` (schema 7: holder accounts, transactions, changes, epoch slots, frozen epochs), `indexer.ts` (holder sync every 4th pass) and `server.ts` (the rewards API);
  - `apps/launchpad/test/support/harness.ts`;
  - `apps/web/src/launchpad/main.ts`, `launchpad.html` and `launchpad.css` (the Rewards page and nav).
- Evidence in `evidence/rewards/`:
  - `api/`: the live overview, three epoch details and two frozen records;
  - `direct-transfer-flow.json`;
  - `shots/`;
  - `checks.txt`.
