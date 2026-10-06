# Project QF Launchpad: holder rewards on devnet, first test payout (2026-10-05/06)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.

- Branch `milestone/launchpad-devnet`. Commits:
  - `0da37b3`: holder history, epochs and frozen records, with no payouts;
  - `ebb5c17`: the rewards vault, plus deposit and payout binding;
  - `fd3712f`: deposit evidence;
  - this report's commit: the payout evidence and the round-limit test.
- **Devnet only, test qUSD with no value.** Jeremy chose "Test payout" at 2026-10-05 22:28Z: one round, in test qUSD, with 2-of-3 test approvals. That round is now done.
- Chain writes in this round:
  - one deposit and one payout, each a Squads proposal approved by 2 of the 3 test members;
  - nothing else. No fee, key, authority, threshold or multisig setting changed.
- Mainnet is unchanged and read-only. `REWARDS_SETTLEMENT_MAINNET` stays false.

## Needed from Jeremy

Nothing for this round. The app refuses a second payout until you say so. A second round, or making payouts a daily routine, needs your word. Mainnet payouts also need the five owner items from 2026-10-05 20:38Z.

## What happened

| Step | When (UTC) | Transaction | Who signed |
|---|---|---|---|
| Deposit proposed: 2.020202 qUSD from the treasury vault to the rewards vault, tagged VAULT 2026-10-05 (proposal #5) | 10-05 22:41 | `2tFcAp4V2XfF2dZvWMK16zacYqcw1SpMG6jqvMfggsS4GuABF6BmMvCC3XD7WctVA3Korgh5kPesboKLjCxBzp8p` | member 1 |
| Deposit approved (2 of 3) | 10-05 22:41 | `Bcb9ZUB6DUiiZ9A3uKBCznAdmqY9xFXtLm8rUphogm85KYpgSzuukiQEU1o4HwFj7qyRbw6bRtBnyRYkkDPBrZq` | member 2 |
| Deposit executed | 10-05 22:41 | `5dfSB2ndawyzkNhk5RQPFM7m1KNsmxNssR3QUNNNRVwjGV9nVDKzTySa5SsYqWbZHP3BuZoPkhEi8De7EjcYN5Za` | member 2 |
| VAULT's day ended; history and vault read past its last slot; record frozen | 10-06 00:01:04 | record `ec069d2532e624077f601f905cbdbd993485cfbf49049ae61600e4fe1d42c1fc` | nobody (computed) |
| Payout proposed: the frozen allocation, from the rewards vault (proposal #6) | 10-06 00:01 | `3jzzCYoi5hUgdYMmqJj8D2DCobEs2sWQ9XkBaftKX2ToYtJsmVoD5ykER5bYJhyhExJj9m6eKuHAQNmSp7NMeS2Z` | member 1 |
| Payout approved (2 of 3) | 10-06 00:01 | `2aiPhVmGiyuxKSRgzZBfL4pLsi6eM2tsqTwDH87z8eZov7Y1Tdkn9HF3Ka4Nzrh45CovtZxqFaAJQWgkvrRdYeus` | member 2 |
| Payout executed (slot 507,905,565) | 10-06 00:01:43 | `37DjqzrYoRmQUyAU8sGzEWNz5xQ4rMLDTXd1qovBFE9fWTzCdzo6NzN6z78eCcSzBisnrai9mMy2i78dVE6rpTRg` | member 2 |
| Payout read back from the rewards vault's history: settlement **PAID** | 10-06 00:01:52 | | nobody (computed) |

**The coin and day.** $VAULT (`FN2tqDtSnXte3EYKX53ZmDN1vi372y34yEsGPgPrWr9o`), 2026-10-05 UTC, slots 507,541,152 to 507,905,128.
- Earmark: 2.020202 qUSD, from 5 trades.
- Deposited: 2.020202 qUSD, the whole earmark.
- Allocated: 2.020199 qUSD. The other 3 raw round down and roll into 2026-10-06.
- Excluded: the bonding-curve pool and the graduated DAMM v2 pool.

| Holder | Share of the day's average balance | Allocated (frozen record) | Received (on chain) |
|---|---|---|---|
| `8UXp4uJTicUWj55mGFwy4gncRBYxH8ej5DuxEZR2FDk2` | 58.6% | 1.185026 | 1.185026 |
| `DJg6AJPT3jUsx2jSWvrFzAaiYnwDp2F3TTJfsjYSpMYe` | 34.5% | 0.698096 | 0.698096 |
| `4vCyHopHHHNiL2bVH2ve8FzkxgL91BhNFaooUG1wbMyj` | 6.6% | 0.132849 | 0.132849 |
| `8RKJVqkE8EGWLfghbXUAe1JhgEN2Z9eEX4EJ8xXdnAYG` | 0.2% | 0.004228 | 0.004228 |

- **Two independent checks of the payout.**
  - Read straight from devnet (`getTransaction`, finalized): the rewards vault's quote account went down 2,020,199 raw, each holder's account went up by exactly their allocation, and the only memo is `qf-rewards-payout@1 mint=FN2t… epoch=2026-10-05 artifact=ec069d25…42c1fc`.
  - The app's own read of the rewards vault's history gives settlement PAID.
- **The proposer's check.** Before signing, the member tool fetched `artifact.json` and confirmed three things against it: the sha256 of its canonical JSON equals the hash in the proposal, its total equals the sum being paid, and its Merkle root recomputes.
- **Afterwards.**
  - The record still recomputes to the same hash.
  - A second payout request for the same day is refused live with `ALREADY_PAID`.
  - The rewards vault holds 3 raw, the rolled-forward remainder.
- **Why the preview differed.** At 22:41Z the running day showed slightly different shares. Shares are averages over the whole day, so they kept moving until the day ended. Only the frozen record was paid.

Addresses (all test, devnet):
- treasury multisig `6VWeQwhL4nWAWz34LPhZtbC97DfDL1ndNufVdySUcEJd`, threshold 2 of 3;
- treasury vault (index 0) `7ac8CDv8vcb7wAUgrmzamJUUnNgPqiQfg2MhxSGufCoB`;
- rewards vault (index 1) `Y2HuCzcjTnKHTCn7cBcPm2DsGKnuqScsVpXy7ifCon7`, quote account `BeJ86unizDStGtfcEgpFTQquAgsD8CSY2YPDsvS4heGq`;
- members `68awUL2hdmFyJ68dBKTmewJ7MEnJ6ALJCD2QdLWQZLWz` (1) and `AXwufa2En6DLdzNG9eerknWZxA1p8gt3sDpbWKSsrorQ` (2), plus a third.

All three members' keys are held by one operator in one container. This is a demonstration of the flow, not separation of control.

## Astra's criteria, met with real money movement

| Astra's words | Now |
|---|---|
| "the fee ledger determines the funding" | The earmark comes only from the fee ledger: 2.020202 qUSD from VAULT's 5 trades on 2026-10-05. The deposit route refuses more than the earmark minus what is already deposited or proposed (`OVER_EARMARK`). |
| "wallet-balance history determines who receives it … including direct transfers" | The shares come only from the balance history, unchanged from `0da37b3`. `8RKJ…nAYG` was a VAULT holder in it and was paid. |
| "accrued or earmarked fees are not yet funded rewards … must be backed by assets actually deposited into the designated rewards vault" | Funded = deposits read back from the rewards vault's own transactions, and nothing else. An executed proposal alone funds nothing until its transaction is read from the vault's history; the test asserts this. A deposit tagged for a day funds it only if it landed before the day ended. A late or untagged transfer is listed and funds nothing. |
| Payout matches the frozen allocation | The payout terms carry the frozen record's hash. The binding requires exactly one TransferChecked per holder, in the record's order, with exact amounts, plus the one memo. Settlement compares what the vault's history shows was paid with the frozen allocation: `PAID`, `PARTLY_PAID` or `MISMATCH`. |

## How the deposit and payout are built and checked

- **Two new treasury kinds.** `REWARDS_DEPOSIT` runs from the treasury vault (index 0) to the rewards vault. `REWARDS_PAYOUT` runs from the rewards vault (index 1) to holders.
  - Both are Squads vault transactions: proposed by one member, approved by 2 of 3, executed by a member.
  - The server builds them unsigned. Each member signs locally with the member tool (`apps/launchpad/src/member.ts`), which re-checks what it signs.
- **Binding** (`packages/tx/src/rewards.ts`). The vault transaction must contain exactly the following, and nothing else:
  - one `TransferChecked` per transfer, with source = the vault's own quote account, mint, decimals, destination = the recipient's quote account, authority = the vault, and the exact amount;
  - then one SPL Memo with no accounts and the exact text:
    - `qf-rewards-deposit@1 mint=<coin> epoch=<day>`
    - `qf-rewards-payout@1 mint=<coin> epoch=<day> artifact=<record sha256>`
- **Each proposal is checked three times**, against what it was built from, what Squads stored on chain, and the execute transaction. Rejected mutations, each a failing case in `rewards-binding.test.ts`:
  - another destination, amount, mint, decimals or source;
  - a plain `Transfer`;
  - an extra SOL transfer;
  - a missing or changed memo;
  - recipients reordered, dropped or added;
  - a deposit to anything but this multisig's vault index 1;
  - a payout from anything but vault index 1.
- **Limits enforced by the routes:**
  - Deposit: only for the day that is running now; up to the earmark left; up to what the treasury holds.
  - Payout: only for a FINAL day whose frozen record recomputes identically; only when settlement is `NOT_PAID`; at most 8 recipients per proposal; up to what the rewards vault holds.
  - **One test round on devnet**: `DEVNET_TEST_PAYOUT_ROUNDS = 1`, counted over payout proposals that are not cancelled or rejected (`ROUND_LIMIT`).
- **Missing quote accounts.** The operator creates any missing quote account (the rewards vault's or a recipient's) with create-idempotent instructions and pays only the rent. All four holders already had one, so none was created.
- **Read-back** (`apps/launchpad/src/rewards-vault.ts`). The rewards vault's quote account is read like a holder account: every finalized transaction, with its own before and after balances and its memo. Each one is classified:

  | Class | Balance | Memo |
  |---|---|---|
  | DEPOSIT | up | deposit memo |
  | PAYOUT | down | payout memo; recipients = the other quote accounts that went up |
  | UNTAGGED | moved | anything else |
  | NONE | unchanged | |

  The app's own proposal records are never used as evidence of money moving.
- **When a day can go final.** Once a rewards vault exists, the day must also have the vault's history read past its last slot (`depositsProvenToSlot`). Tonight the day turned FINAL on the first read after 00:00Z, about 60 seconds after the day ended.

## How holder history, epochs and records work (unchanged from `0da37b3`)

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
- `settlementTx: null`, `settlementAdapter: null`, `claimStatus`. The record is frozen before any payout, so these stay null in it; the payout is shown beside the record as its settlement (below).

It adds the mint, the window, the funding block (earmark, deposits, funded, `earmarkIsNotFunding`) and the excluded owners. With nothing funded, the Merkle tree is empty and its root is all zeros.

**API and page.**

| Route | Returns |
|---|---|
| `GET /api/lp/rewards` | every coin's coverage and epochs |
| `GET /api/lp/rewards/{mint}/{YYYY-MM-DD}` | one epoch: holders and shares, exclusions, payouts with Merkle proofs |
| `…/artifact.json` | the frozen record; 404 while the epoch is open |
| `POST /api/lp/rewards/deposit` | new: builds an unsigned deposit proposal for a treasury member |
| `POST /api/lp/rewards/payout` | new: builds an unsigned payout proposal for a treasury member |

The Rewards page (`#/rewards`) now also shows:
- the rewards vault: its balance, how far its history is read, and its 2-of-3 test signers;
- a Paid column and a "Paid to holders" total;
- on each day's page, a "Funding and payout" card with deposits, the payout transaction and allocated against received per wallet.

The page itself moves no funds. Screenshots for desktop and phone are in `evidence/rewards/shots/`.

## Tests (345/345; 11 new since `0da37b3`, one extended)

- `packages/adapter-meteora-dbc/test/rewards-binding.test.ts`, 8 tests:
  - deposit and payout propose, stored-transaction and execute all bind with zero violations;
  - the memo format;
  - every mutation listed above is rejected;
  - the terms rules (vault index per kind, distinct recipients, never to itself, positive amounts, a real date, a hex digest, fee payer = source vault).
- `apps/launchpad/test/rewards-payout.test.ts`, 3 tests:
  - the whole round over the API: deposit refusals (`OVER_EARMARK`, `NOT_A_MEMBER`, `TREASURY_SHORT`); deposit 2-of-3; nothing funded until the vault's own transaction is read; `EPOCH_NOT_FINAL` while running; FINAL and frozen after the day; `ROUND_LIMIT` when another payout is already proposed (a cancelled one does not count); payout 2-of-3 with exactly the frozen allocation; `ALREADY_PROPOSED`; read-back PAID with the record unchanged;
  - vault transaction classification, including memos on the wrong direction;
  - settlement: PAID, PARTLY_PAID and MISMATCH (overpaid, unknown recipient, wrong record, open day).
- Full checks (`evidence/rewards/checks.txt`, secret-free environment): typecheck, test, license:check, deps:chain and boundary all exit 0.
  - `pnpm audit --prod` exits 1 with the same 3 known SEC-A advisories (bigint-buffer, uuid, stream-json), all under the server-side Meteora adapter.
  - No dependency was added.
  - The key scans of the changed files, the evidence and the ZIP found 0 hits.

Test results are not an audit or a readiness claim.

## Limits, stated plainly

1. **Test signers, one operator.** All three member keys sit in one container, under one operator. The 2-of-3 flow is real and enforced on chain, but control is not separated. Mainnet needs three real signers on hardware wallets, which is owner item 3.
2. **One RPC provider.** History, deposits and payouts are read from public devnet only (`SINGLE_PROVIDER`). CLAUDE.md requires reward-settlement reads at finalized and cross-checked against a second provider. That must be in place before any mainnet settlement.
3. **A deposit must land before the day ends.** That keeps a day's funding fixed before its record freezes, but the earmark is only final once the day ends. Tonight's deposit (22:41Z) covered the whole earmark because VAULT had no later trades. On a busy coin, trades after the deposit would leave part of the earmark unfunded. **Decision for Astra and Jeremy before routine payouts**, one of:
   - a deposit window for day N that stays open into day N+1, freezing only after it closes; or
   - funding each day from the previous day's earmark.
4. **At most 8 holders per payout proposal.** A day with more holders needs several proposals, each bound to a slice of the frozen record. That is not built yet.
5. **Recipient account rent.** The operator pays rent for any holder without a quote account. On mainnet that is about 0.002 SOL per new holder account, an economics question before mainnet.
6. **The memo convention is the tag.** A transfer into the rewards vault without the exact memo is listed as untagged and funds nothing. A deposit made outside the app with the right memo counts, by design.
7. Unchanged from `0da37b3`:
   - holders using a program wallet (multisig, smart wallet) are excluded;
   - block times are assumed to rise with slots for the day boundary;
   - the earmark counts curve fees only;
   - there are no Sybil rules;
   - classic SPL Token only.

## Notes for Astra

- The funding, allocation and settlement inputs never mix:
  - the fee ledger produces only the earmark (a cap);
  - the vault's history produces only funding and payments;
  - the balance history produces only weights.
- The frozen record is the only thing paid. Its hash is in the payout terms, in the on-chain memo and in the member's pre-signing check.
- Settlement is derived from the vault's history, not from the app's proposal table. So a payout made outside the app would still be checked against the record, and anything unexpected shows as MISMATCH.
- Limit 3 (deposit timing) is the open design point I'd most like your view on before a second round.

## Files

- New:
  - `packages/tx/src/rewards.ts` and `packages/adapter-meteora-dbc/test/rewards-binding.test.ts`;
  - `apps/launchpad/src/rewards-vault.ts` and `apps/launchpad/test/rewards-payout.test.ts`.
- Changed:
  - `packages/tx/src/terms.ts`, `treasury.ts`, `semantic.ts`, `programs.ts` and `index.ts`;
  - `packages/adapter-meteora-dbc/src/treasury.ts` (rewards vault, transfer builder, quote-account creation) and `launchpad.ts` (memos in balance changes);
  - `apps/launchpad/src/chain.ts`, `store.ts` (migration 8: rewards vault transactions), `rewards.ts` (deposits by slot, settlement, the one-round rule), `server.ts` (deposit and payout routes), `indexer.ts`, `member.ts` (`reward-deposit` and `reward-payout`) and the test harness;
  - `apps/web/src/launchpad/main.ts` (vault card, funding and payout card, Paid column).
- Evidence in `evidence/rewards/`:
  - `test-round.json`: every signature, the proposals' approvals, and the payout read back from devnet;
  - `api/`: the live overview, VAULT 2026-10-05 detail and frozen record, the treasury view, and the earlier FROG and MCAT records;
  - `shots/`;
  - `checks.txt`.
