# Project QF Launchpad, Milestone 5: Astra's milestone 3 review applied (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`, head `a33661b` (plus this report). Cluster: devnet only. Mainnet writes: none. Real keys or funds: none.

Astra reviewed milestone 3 before milestone 4 existed. Creator fee claims (curve and locked LP) shipped in milestone 4 (`handoffs/LAUNCHPAD-MILESTONE-4-2026-10-05.md`). This milestone applies everything else in that review. The architecture is unchanged.

Astra's diagnostic ZIP ("QF-Milestone-3-Review.zip") was a ChatGPT sandbox link and never reached us. I worked from the review text and reproduced each issue here myself.

## Review items

| Review item | What changed | Proof |
|---|---|---|
| **Indexer retry gap.** A `null` transaction lookup still advanced the cursor, so a trade could be skipped for good. | The cursor now stops before a signature whose details the RPC has not served yet, and the next pass retries it. After 5 passes it moves on and logs why, so a transaction the RPC never serves cannot stall a coin. The fix is shared by the curve and DAMM v2 indexers. | New test `the indexer retries a trade whose details the RPC has not served yet…`: first pass 0 trades, cursor unchanged; next pass 2 trades; the retry limit releases a never-served signature. |
| **Graduated-price fallback.** A failed DAMM read showed the old curve price. | A graduated coin keeps venue `DAMM_V2` and returns `priceQuotePerBase: null`, `marketCapQuoteRaw: null`, `priceUnavailable: true`. The page shows "Price unavailable" and a dash for market cap, and the trade panel explains why. | New test: a DAMM read that throws gives `['DAMM_V2', true, null, null, null]` and the status stays MIGRATED. |
| **Chart labels and "since launch".** | The chart now has a price range on the axis, "oldest trade" and "now (spot price)" at the ends, and the caption "Each point is one trade's average fill price, in order, evenly spaced (not to time scale). The last point is the current pool price." The screen-reader label says the same. "Since launch" now compares with the curve's fixed starting price (`sqrtStartPrice` from the config), so it no longer changes as more trades load (the trade list is capped at 200). | Screenshot `cash-desk.png`. Server test asserts that `launchPriceQuotePerBase` is present. |
| **Separate fee counters.** | The About list now says "Creator curve fees, unclaimed". LP fees are per position: the creator sees them in "Your creator earnings" (milestone 4), and everyone sees them on the new Earnings page. | Screenshots. |
| **Evidence-based lock information.** | The observed locked share comes from the DAMM v2 pool account: `permanentLockLiquidity / liquidity`, for example 99.99% on $CASH. It appears in the trade panel, the graduation card and the About list, with the source named. The graduation card adds: "Locked liquidity cannot be withdrawn; it does not fix the price." | Server test asserts `lockedBps` is between 0 and 10,000. Screenshot. |
| **Earnings & Claims view.** | New read-only page `#/earnings` (described below). | New test. Live devnet numbers below. |

## The Earnings page

- **Per coin:** unclaimed creator curve fees, creator LP fees, platform curve fees and platform LP fees. Curve fees come from the DBC pool's counters. LP fees come from the locked DAMM v2 positions held by the creator and by the platform fee claimer.
- **Claims made in the app**, each with the amount it paid out and an Explorer receipt.
  - The amount is read from the confirmed transaction: whatever left the pool's vaults.
  - Store migration 3 adds a `claims` table and backfills earlier claims from confirmed intents. Their amounts are filled in from chain.
- **Totals:** platform unclaimed, creators unclaimed, claimed in the app, and the number of coins.
- **Explanations on the page itself:**
  - Accrued is not claimed, and claimed is not kept revenue.
  - Half of the platform share is earmarked for holder rewards under the test settings, and that is not built.
  - Claims made outside the app are not listed.
  - The platform fee claimer must be a multisig, so there is no platform claim button.
- **Reads only:** the page has no write path and cannot move funds. Results are cached for 30 s, and the page warns when some pools could not be read.

Live on devnet at commit time (TEST_ONLY qUSD, no value):

| Metric | Value |
|---|---|
| Platform, unclaimed | 19.01 qUSD |
| Creators, unclaimed | 11.21 qUSD |
| Claimed in the app | 7.79 qUSD across 3 claims: $CASH LP 4.99, $CASH curve 1.40, $PAYDAY curve 1.40 |
| Coins | 5, of which 3 graduated |

## Checks on `a33661b`

| Check | Result |
|---|---|
| Tests | 254/254 |
| typecheck, license:check, deps:chain, boundary | pass |
| Browser | the Earnings and token pages render on desktop (1280 px) and phone (390 px) with no console or page errors |

These are test results. They are not a security audit and not a mainnet readiness claim.

## Notes for Astra

1. Astra's point stands: developer test trades prove that the code executes. They do not prove demand or real earnings.
2. **Earnings on mainnet.** The page shows public on-chain numbers, so it is safe on devnet. For mainnet, the owner should decide whether platform revenue is shown publicly or behind sign-in.
3. **Holder rewards** are not built. `partnerRewardsSplitPct` is a policy number, not a distribution system, and the page says so.

## Still open (owner decisions)

- Second RPC provider.
- Public URL and metadata hosting.
- Real-wallet test (Phantom or Solflare on devnet).
- Platform fee claimer multisig.
- SOL as a quote token; atomic first buy.
- The paid intelligence workspace, which Astra suggests building alongside the launchpad on the existing inspector.
