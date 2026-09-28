# Fee scheduler comparison, V0 (Decision 5)

> **SIMULATION ONLY.** Synthetic traces replayed through the DBC SDK 1.5.13 client-side quote math. No RPC, no program, no transactions. Not live results. **Not sniper-proof:** neither configuration prevents sniping, and nothing here shows otherwise. No production fee template is selected (P0-M3 stays open).

Date: 2026-09-27. Source: `project-qf/tools/econ-sim` (tests: `tools/econ-sim/test/sim.test.ts`, 8/8 pass). Raw output: `project-qf/evidence/econ-sim/results.json` (resultsHash `3f8bd4e725db35b500e9c1f61949063f7fd9c94060574ac812f43d25366415a9`).

## What was compared

| | Flat baseline (V0_TEST) | Bounded decay (SIMULATION_ONLY) |
|---|---|---|
| Template version | `STANDARD_V1@0-v0test-flat` | `STANDARD_V1@0-sim-linear-decay-2500-100-12x10s` |
| SDK builder | `buildCurve` | `buildCurve` |
| `baseFeeMode` | `FeeSchedulerLinear` | `FeeSchedulerLinear` |
| `feeSchedulerParam` | start 100, end 100, periods 0, duration 0 | start 2500, end 100, periods 12, duration 120 s |
| Resulting `cliffFeeNumerator` | 10,000,000 (1e9 denominator) | 250,000,000 |
| SDK `validateConfigParameters` | passes | passes |

Everything else is identical: `ECONOMICS_V0_TEST`, `percentageSupplyOnMigration` 20, a TEST_ONLY qUSD quote with 6 decimals, and a migration quote threshold of 5,000,000,000 raw ($5,000 at a $1 fixture price). The threshold comes from the Decision 3 policy path (`proposeMigrationThreshold`), not from `migrationMarketCap`.

The decay template is usable only in simulation. `assertTemplateUsableFor('TX_INTENT')` rejects it, and `validateIntent` returns `TEMPLATE_SIMULATION_ONLY`.

## Method

- **Traces.** Six deterministic traces are generated with mulberry32 from fixed seeds and stored in `tools/econ-sim/traces/*.json`. Hashes are in `INDEX.json`. Both configurations replay byte-identical traces; the code asserts the hashes match.
- **Buys** use `swapQuotePartialFill`. The final buy that crosses the threshold is partly filled and completes the curve. Every later event is recorded as `REJECTED: CURVE_COMPLETE`, never dropped.
- **Sells** use `swapQuoteExactIn` with the base amount equal to `sellBps` of the wallet's current holdings.
- **Fee timing.** The fee scheduler time is seconds since activation (`activationType` Timestamp).
- **Quote bookkeeping.**
  - A buy adds its fee-excluded input to the reserve.
  - A sell subtracts the gross output (output plus fees) from the reserve.
  - Fees split into trading and protocol shares per the SDK (protocol takes 20%).
  - The trading fee then splits 50% to the creator. The partner half splits 50/50 between revenue and rewards, per `ECONOMICS_V0_TEST`.
- **Conservation (H4).**
  - Trader quote in minus quote out must exactly equal reserve plus fees.
  - The sum of holdings must exactly equal base bought minus base sold.
  - The fee split must be exact.
  - The tracked reserve must be at least the curve-implied reserve from `getQuoteReserveFromNextSqrtPrice`. The surplus is rounding dust of 2 to 27 raw units.
  - A failure here fails the test suite.

## Traces

| Trace | Seed | Design |
|---|---|---|
| sniper_burst_t0 | 1001 | 5 sniper wallets buy $300–600 each at 0–2 s. 220 organic events follow. Snipers try to exit fully at 300–600 s. |
| patient_sniper | 1002 | Same snipers, but they buy at 121–123 s, just after the decay window, and exit at 400–700 s. |
| organic_only | 1003 | 240 organic events: $5–100 buys, about 12% are 50% sells. No bots. |
| pump_dump | 1004 | 8 coordinated wallets (one entity) buy $200–400 at 0–20 s and dump everything at 60–75 s, inside the decay window. 90 organic events. |
| low_demand | 1005 | 40 small organic buys ($5–40) over about an hour. |
| sybil_split | 1006 | One entity splits $3,000 across 30 wallets at 0–3 s. 220 organic events follow. It exits at 400–700 s. |

## Results (USD at the $1 fixture price; bps of each class's own volume)

| Trace | Config | Graduated at | Total fees | Organic fee rate | Bot share of buys | Bot net PnL (marked) | Max single-trade move |
|---|---|---|---|---|---|---|---|
| sniper_burst_t0 | flat | 2174 s | $131.95 | 100 bps | 40.1% | +$935.62 | 5397 bps |
| sniper_burst_t0 | decay | 2132 s | $696.15 | 145 bps | 37.0% | +$304.80 | 4260 bps |
| patient_sniper | flat | no | $169.29 | 100 bps | 31.9% | +$438.80 | 6249 bps |
| patient_sniper | decay | no | $208.80 | 134 bps | 32.7% | +$473.51 | 6394 bps |
| organic_only | flat | 2093 s | $83.52 | 100 bps | n/a | n/a | 1537 bps |
| organic_only | decay | 2121 s | $166.35 | 199 bps | n/a | n/a | 1472 bps |
| pump_dump | flat | no | $69.89 | 100 bps | 48.5% | +$18.37 | 3415 bps |
| pump_dump | decay | no | $789.53 | 153 bps | 45.4% | −$702.16 | 2541 bps |
| low_demand | flat | no | $9.13 | 100 bps | n/a | n/a | 430 bps |
| low_demand | decay | no | $12.51 | 137 bps | n/a | n/a | 431 bps |
| sybil_split | flat | 3117 s | $177.58 | 100 bps | 41.5% | +$1,070.87 | 2261 bps |
| sybil_split | decay | 3117 s | $918.32 | 126 bps | 38.9% | +$281.47 | 1703 bps |

`results.json` also holds, per class: quote paid and received, fees, held base, share of curve-sold supply and marked PnL. It also holds early-holder share (first buy at or before 10 s), top-5 entity share, HHI, peak-to-final drawdown, the full fee split and every conservation value.

## Hypotheses (all outcomes retained)

19 PASS, 7 FAIL, 4 NOT_APPLICABLE out of 30.

| Hypothesis | Pass condition | Outcome |
|---|---|---|
| H1_BOT_ACQUISITION | Decay cuts the bot share of base bought by at least 20% relative to flat | **FAIL in all 4 bot traces.** Drops were 7.8%, −2.4%, 6.4% and 6.3%. |
| H5_BOT_PNL | Decay lowers bot net PnL | PASS in sniper_burst_t0, pump_dump and sybil_split. **FAIL in patient_sniper**, where bot PnL rose from $438.80 to $473.51. |
| H2_ORGANIC_COST | Decay raises the organic fee rate by at most 50 bps | PASS in 4 traces. **FAIL in organic_only (+99 bps) and pump_dump (+53 bps).** |
| H3_GRADUATION_UNCHANGED | Graduation outcome is the same | PASS in all 6. Timing moved by up to 42 s. |
| H4_CONSERVATION | Exact bookkeeping and reserve covers curve | PASS in all 6, both configs. |

## Reading

- **Early bursts.** Within the 120 s window, the decay mostly moves value from early bots to fees. Sniper PnL fell by about two thirds in sniper_burst_t0 and sybil_split. In pump_dump the fast round trip lost money. Bots still acquired almost the same share of supply (H1 failed).
- **Waiting defeats it.** A bot that simply waits past the window pays the flat fee. In patient_sniper it did slightly better than under flat, because early organic buyers had paid more and moved the price less.
- **Organic cost.** Organic buyers who arrive early pay for the decay too. In organic_only the organic fee rate roughly doubled (100 → 199 bps).
- **Fee realization.** Total fees rose 1.2× to 11× under decay. Most of the increase comes from the first two minutes, which is exactly the platform-revenue-first reading Decision 5 warns against optimizing for.

## Limitations

- **No demand elasticity.** Traders submit identical intents under both fees. Real traders and bots would wait, resize or skip, and patient_sniper suggests the direction.
- **Small, invented traces.** Six traces are not a distribution. Synthetic volume implies nothing about real demand, graduation odds or revenue.
- **Marked values are not exit values.** They use the final spot price. Organic "PnL" in graduated traces is mostly this mark and is not executable.
- **SDK math, not the program.** This is client-side quote math from SDK 1.5.13, not the on-chain program, which was not exercised. Rate limiter, dynamic fee and first-swap-with-min-fee were all off.
- **No post-migration trading.** DAMM v2 pool trading after migration is not modelled.

## Disposition

- The flat baseline stays the V0_TEST template.
- The decay template stays SIMULATION_ONLY.
- No production scheduler is selected. P0-M3 remains open and needs larger, reviewed trace sets with behavioural response before any choice.
