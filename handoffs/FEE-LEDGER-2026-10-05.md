# Project QF Launchpad: per-trader fee ledger (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`, on top of milestone 7 (`592982f`). Cluster: devnet only. Mainnet writes: none. New keys: none beyond throwaway in-memory test wallets (already authorized for devnet).

Jeremy asked, 18:30Z: "even tho its a treasury i want to make sure every traders fees are personally tracked for easy verification and secure payouts without confusion or bottlenecks". This is the follow-up to milestone 7. It comes before holder rewards, which will pay from this record.

## Before and after

| | Before | After |
|---|---|---|
| Per trade | wallet, side, amounts, signature | the same, plus the exact fee paid. On the curve it is split into creator, platform and Meteora protocol shares. After graduation it is split into LP share and protocol share. |
| Where the fee comes from | nowhere (not recorded) | the `EvtSwap2` event the DBC / DAMM v2 program itself wrote in that trade's transaction |
| Per wallet | nothing | `GET /api/lp/fees?wallet=` returns totals, totals per coin and every trade with its fee and a transaction link |
| All traders | nothing | `GET /api/lp/fees` returns totals per coin and per wallet (largest fee payer first) |
| Verification | none | Earnings checks per coin that the per-trade shares add up to what the pool still holds plus proven claims |
| UI | none | a new **Fees** page (any wallet can be looked up), a "Fee paid" column on every coin's trade list, and "Do the trade fees add up?" on Earnings |

## How a fee is read

1. Both Meteora programs log each swap as an Anchor self-CPI event: an inner instruction carrying `EVENT_IX_TAG`, then the `EvtSwap2` discriminator, then Borsh data.
   - The layouts are extracted from the MIT SDKs' bundled IDLs into the pinned subsets (`packages/tx/src/engine/*-idl-subset.ts`, `events`), with the same drift test as the instruction formats.
   - `decodeSwapEvent` (`packages/tx/src/events.ts`) is strict: any trailing byte or short read throws.
2. **Curve.** The trader pays `trading_fee + protocol_fee + referral_fee`.
   - Creator share = `floor(trading_fee × creator_pct / 100)`, using the config's `creator_trading_fee_percentage`.
   - Platform share = the rest.
3. **DAMM v2.** The trader pays `claiming_fee + protocol_fee + compounding_fee + referral_fee`.
   - The LP fee goes to positions by liquidity, so per trade it is one LP amount; per coin it is compared with the positions.
   - A pool that takes fees in both tokens (`collect_fee_mode` ≠ 1) is UNKNOWN (`FEE_NOT_IN_QUOTE`).
4. **Unproven fees are never counted as 0.** A fee that cannot be proven is UNKNOWN with one of these reasons:
   - `NO_TX_DETAILS`, `NO_SWAP_EVENT`, `EVENT_DECODE_FAILED`, `FEE_NOT_IN_QUOTE` or `NO_CREATOR_SHARE`.
   - UNKNOWN trades are counted as unconfirmed and left out of totals.
5. **Older trades.** Trades recorded before this (store migration 6, `fee_status` NULL) are read again by the indexer, 10 per pass, up to 20 tries each. A RESOLVED record is final.

## Proof on devnet

- **Before writing any app code, I checked the formula against the chain.** I decoded all 27 trades on the 6 coins and compared them with each pool's own fee counters plus proven claims (`evidence/fee-ledger/pool-counter-check-before-ledger.log`).
  - Creator and platform curve shares matched to the raw unit on every coin.
  - LP fees matched to within 1 raw unit per coin. The DAMM v2 program rounds each position's share down, and the remainder stays in the pool.
- **After restarting on the new code:**
  - Migration 6 ran and the indexer filled in all 27 older trades.
  - The total was 61.632132 qUSD of fees, exactly the sum from the check above.
  - Every coin's check reads MATCH (`earnings-checks-backfilled.json`).
- **New trades were recorded with their fees immediately**, through the app's submit path:
  - a curve buy on $FROG: fee 0.25, creator 0.10, platform 0.10, protocol 0.05;
  - a DAMM v2 buy and sell on $VAULT: fees 0.40 and 0.200773.
  - Every coin still reads MATCH afterwards (`earnings-checks-after-new-trades.json`, `wallet-*.json`).
- **Independent decoder check.** The same 4 real event payloads are decoded by the Anchor event coder that the Meteora SDKs depend on, using their full IDLs. It gives the same numbers (`packages/adapter-meteora-dbc/test/swap-events.test.ts`).
- **Screenshots** are in `evidence/fee-ledger/shots/` (desktop and phone). There were no console errors and no horizontal overflow.

## Checks (`evidence/fee-ledger/checks.txt`, secret-free wrapper)

All exits are 0 except the audit:

- install, typecheck, test (296/296, which is 288 plus 8 new), license:check, deps:chain, build:web and boundary all exit 0.
- `pnpm audit --prod` exits 1 with the same 3 known SEC-A advisories as before.
- No dependency was added.

These are test results, not an audit or a readiness claim.

## Notes for Astra

1. **Fees paid are recorded, not owed.** Paying anything back to traders or holders is the holder-rewards milestone. It can take its inputs from `/api/lp/fees` (per wallet, every figure tied to a signature) and stays behind `REWARDS_SETTLEMENT_MAINNET=false`.
2. **The trade's wallet is the transaction fee payer**, the same as before. A trade relayed by a third party would be attributed to the relayer. Rewards would need a stricter definition, for example the owner of the token account that received the tokens.
3. **The LP split per trade is not stored.** It depends on position liquidity at that moment. The per-coin check compares the LP total with all known positions plus claims, allowing 2 raw units per DAMM trade for rounding.
4. **Claims made outside the app are not in the receipts.** They would show as a MISMATCH on the check, which is intended: the page says so.
5. **Referral fees.** None of our pools have a referral account, so `referral_fee` was 0 in every event. The curve total assumes trading + protocol + referral, which has only been observed with referral = 0.
