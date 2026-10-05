# Project QF Launchpad, Milestone 6: Astra's milestone 5 review applied (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`. Base `6617acd` (milestone 5). Implementation `b39e5a2`, plus this report and its evidence.
Cluster: devnet only. Mainnet writes: none. New wallets, keys or chain writes: none. Fee settings: unchanged.

Both findings were reproduced before they were fixed:

- `apps/launchpad/test/m5-reliability.test.ts` holds 7 reproduction tests that use only APIs which existed at `6617acd`.
- Run against `6617acd`, all 7 fail with Astra's exact observations:
  - 0 trades where 1 was expected;
  - a stored `'0'` receipt;
  - `incomplete: false` with an unresolved receipt.
- Against `b39e5a2` all 7 pass.
- `evidence/m6-reliability/repro-on-base.sh` reruns this comparison and exits 0 only when both halves behave as described.

The review's diagnostics package did not reach me: the upload had only REVIEW.md and CLAUDE-HANDOFF.md. I rebuilt each scenario from the review text.

## M5-R1: trade history no longer drops a transaction

| Before | After |
|---|---|
| A signature whose details the RPC did not serve held the cursor for 5 passes. Then it was skipped for good. | On the first miss it goes into a durable queue (new table `trade_backfill`, store migration 4). The cursor moves on, so newer trades keep indexing. |
| Retry state was in memory and lost on restart. | The queue is in SQLite and survives a restart. |
| Nothing showed that a trade might be missing. | Every token view has `history: { complete, pending, unavailable }`. The token page shows it in About ("Trade history") and above the trade list. |

Retry schedule (`BACKFILL` in `indexer.ts`):

- **Fast retries.** The first 5 lookups happen on consecutive passes, so an ordinary RPC delay still fills in on the next pass.
- **Backoff.** After that the delay doubles from 15 s up to 1 h.
- **Unavailable.** After 20 tries the entry is marked `UNAVAILABLE` and logged once.
  - It still counts as missing history.
  - It is still retried every 6 h, and if the RPC ever serves it, it is recovered.

Each recovered entry is resolved as one of:

- `TRADE` (de-duplicated by signature against trades the app already recorded);
- `NOT_A_TRADE` (claims, migration);
- `FAILED_TX`.

The curve and DAMM v2 indexers share this path. A graduated coin's curve queue is still retried after graduation.

Tests, offline:

- recovery after the old 5-pass limit, on the curve and on DAMM v2;
- recovery across a store close and reopen;
- newer trades indexed while an older one waits;
- UNAVAILABLE stays visible and is still recovered later;
- no duplicate when the app recorded the trade first;
- failed and non-trade transactions.

## M5-R2: a claim receipt is never an unproven zero

| Before | After |
|---|---|
| The earnings route built one vault list from whichever pools it could read just then. A failed pool read gave an empty list, and the receipt was stored as `0` permanently. | Each receipt keeps its own `pool`, `quote_vault` and `base_vault`. These come from the terms its transaction was bound to (pool and mints, vaults derived as PDAs). A pool read is never needed. |
| A receipt with no transaction details was summed as 0, and `incomplete` stayed false. | A receipt has `status` `UNKNOWN`, `RESOLVED` or `FAILED_TX`, and `evidence` says why. Only RESOLVED and FAILED_TX amounts are counted. |

A receipt resolves only on complete evidence:

- its transaction is served and succeeded;
- both of its vaults are among the transaction's accounts;
- both vaults have a balance observation;
- neither vault received funds.

Then the amount is what left those two vaults. A zero is stored only on that complete evidence, or for a failed transaction, which moves nothing. Otherwise the receipt stays UNKNOWN with one of these reasons:

- `NO_TX_DETAILS`
- `VAULT_NOT_IN_TX`
- `NO_BALANCE_OBSERVATION`
- `VAULT_INFLOW`
- `NO_VAULT_IDENTITY`

The earnings totals now report coverage in two separate parts:

- `coverage.unclaimedComplete`: were all pools and positions read;
- `coverage.claimsComplete` and `coverage.unresolvedClaims`: is every receipt proven.

`incomplete` is kept and is true if either part is incomplete. The page shows a separate warning for each.

Earlier receipts were not trusted:

- Migration 4 moves every stored amount to `legacy_quote_raw` / `legacy_base_raw`.
- It sets each receipt UNKNOWN and re-reads it under the new rules.
- A receipt with no confirmed intent to take its identity from stays UNKNOWN (`NO_VAULT_IDENTITY`).

Tests, offline:

- a pool outage before enrichment, on the curve and on DAMM v2;
- missing transaction details, then recovery;
- a transaction with no balance reading for the vault;
- a valid zero with complete evidence;
- persistence across a store reopen;
- migration 4 on a real schema-3 database holding a zero receipt;
- the full submit path for a curve claim and a DAMM v2 claim: build, wallet signature, submit, receipt bound to the right vaults;
- an outflow from the wrong venue's vault is not accepted as evidence.

## One more gap of the same kind (found by me, fixed)

`getNewSignatures` asked the RPC for one page of 100. If more than 100 transactions hit a pool between two passes, the older ones were never listed and were lost silently.

It now pages back with `before` until it reaches the cursor (`packages/adapter-meteora-dbc/test/signatures.test.ts`). It is capped at 50 pages, 5,000 transactions per pool per pass. Past the cap it logs which part of the window was not read. At devnet volume this cannot happen. A mainnet indexer should be push-based (webhooks or Geyser), not polling.

## Earnings page polish (Astra's optional items)

- **Read time and Refresh.** "Read from the pools at 2:23:52 PM (14s ago). Figures are kept for up to 30 seconds." The Refresh button asks for a fresh read.
- **Phone tables.** On phones, "Swipe the table sideways to see every column." appears above each table.
- **Rewards wording.** "Half of the platform share is earmarked for holder rewards. Earmarked means counted, not moved: nothing is transferred or distributed, because holder rewards are not built."
- **Unknown receipts.** They show "unknown" with the reason in words, and the "Claimed in the app" card says "2 of 3 claims confirmed".

The design is unchanged. So are the creator claim flows, fee settings and devnet restrictions.

## Live devnet check (reads only)

I restarted the server on `b39e5a2` against the existing devnet database. Migration 4 ran (schema 3 to 4). The three real receipts were then re-read from their own transactions and vaults (`evidence/m6-reliability/receipts-recheck-devnet.json`):

| Receipt | Before (milestone 5) | First request | Second request |
|---|---|---|---|
| $PAYDAY curve | 1,400,318 | RESOLVED 1,400,318 | same |
| $CASH curve | 1,400,318 | RESOLVED 1,400,318 | same |
| $CASH LP (DAMM v2) | 4,998,368 | **UNKNOWN, `NO_TX_DETAILS`** (the public RPC did not return it) | RESOLVED 4,998,368 |
| Claimed in the app | 7,799,004 | 2,800,636, `claimsComplete: false`, 1 unresolved | 7,799,004, complete |

The first request is M5-R2 happening for real. Milestone 5 would have left that receipt null and reported the total as complete. Milestone 6 said "1 unresolved" and resolved it on the next read. All three amounts match Astra's reconciliation exactly. Unclaimed totals are unchanged since the milestone 5 snapshot: platform 19.012451, creators 11.213445. No coin has queued trades (`history.complete` true on all 5).

Screenshots (in the ZIP, `evidence/screens/`):

- **Live devnet** (`live-*`): earnings and the $CASH page, on desktop and phone. The Refresh click was verified to change the read time.
- **Offline preview** (`sample-*`): synthetic data, labelled TEST_ONLY on the page. It shows an unknown receipt and a coin with 2 transactions still being read. Its "pools could not be read" note is an artifact of the preview's fake chain, which has no DAMM v2 reader.
- **Errors:** no console or page errors at 1280 px or 390 px.

## Checks on `b39e5a2` (`evidence/m6-reliability/checks.txt`)

All checks ran in the secret-free wrapper (`env -i PATH HOME HTTPS_PROXY HTTP_PROXY NODE_EXTRA_CA_CERTS`). Each log is next to `checks.txt`.

| Command | Exit | Result |
|---|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | 0 | lockfile unchanged, no new dependencies |
| `pnpm -s typecheck` | 0 | |
| `pnpm -s test` | 0 | 272/272 (254 before, plus 15 in `m5-reliability.test.ts` and 3 in `signatures.test.ts`) |
| `pnpm -s license:check` | 0 | |
| `pnpm -s deps:chain` | 0 | |
| `pnpm -s build:web` | 0 | |
| `pnpm -s boundary` | 0 | |
| `pnpm audit --prod` | 1 | the same 3 known SEC-A advisories (bigint-buffer, uuid, stream-json) |
| `bash evidence/m6-reliability/repro-on-base.sh 6617acd` | 0 | base exit 1 (7/7 reproduce), this commit exit 0 (7/7 pass) |

These are test results. They are not a security audit and not a mainnet readiness claim.

## Notes for Astra

1. **The indexer no longer holds its cursor on a miss.** With a durable queue, holding the cursor only delayed newer trades. The queue's first five retries run on consecutive passes, so the ordinary-delay behaviour you confirmed is kept. I rewrote the old milestone 5 retry test for the new behaviour; it no longer asserts that the cursor stays put.
2. **UNAVAILABLE is retried every 6 h with no end.** It costs one RPC call per entry. If you would rather have an explicit "reviewed, give up" state, that is a small follow-up. I did not add it unasked.
3. **Claims made outside the app are still not listed.** Every listed receipt is now proven from chain, but the list is not a complete claim history.
4. **The signature cap** (5,000 per pool per pass) is the only remaining bound on trade history, and it is logged when hit.

## Still open (owner decisions; none blocks devnet work)

- Second RPC provider. The `NO_TX_DETAILS` above and the 429s in the server log all come from the single public endpoint.
- Public URL and metadata hosting.
- Real-wallet test (Phantom or Solflare on devnet).
- Platform fee claimer multisig.
- SOL as a quote token; atomic first buy.
- Whether the Earnings page is public on mainnet.
