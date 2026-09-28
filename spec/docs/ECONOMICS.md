# ECONOMICS

DECISION: one template, `STANDARD_V1`. **No percentage in this document is a production constant.** Production values are set by simulation + adversarial testing and recorded as a new policy version. Values marked `V0_TEST` exist only so V0 can run on localnet/devnet.

## 1. Fee flows (FACT unless labeled)
```
trader pays trading fee (quote token, collect_fee_mode=0)
  ├─ 20% → Meteora protocol (Meteora docs)
  └─ 80% → split by config: creator_trading_fee_percentage → creator; remainder → partner (QF FEE_CLAIMER)
QF partner share (off-chain policy, DECISION): → QF revenue  +  → holder reward pool (TRADING_FEE accrual)
Post-migration: DAMM v2 position fees → position owners (partner/creator; permanently locked positions still earn fees)
```

## 2. Schemas
```ts
interface EconomicsPolicy {
  id: 'economics'; version: string;               // e.g. 'STANDARD_V1@0-v0test'
  baseFeeBps: number;                             // flat; 25..9900 (engine)
  dynamicFee: false;                              // DECISION v1
  collectFeeMode: 'QUOTE_ONLY';
  creatorTradingFeePct: number;                   // share of post-protocol fee to creator
  partnerRevenueSplitPct: number;                 // of partner share → QF revenue
  partnerRewardsSplitPct: number;                 // of partner share → holder rewards (sum = 100)
  migrationExtractionFeePct: 0;                   // DECISION: no extraction migration fee
  migrationFeeOption: 'CUSTOMIZABLE';             // DAMM v2 config A8gM…tck
  migratedPoolFeeBps: number;                     // 10..1000 (engine)
  lp: { partnerPermanentLockedPct: number; creatorPermanentLockedPct: number;
        partnerClaimablePct: 0; creatorClaimablePct: 0; vesting: null };   // sums to 100
  poolCreationFeeLamports: number;                // 0 in V0
  clampable: string[];                            // fields Policy Engine may clamp
}
interface CurveTemplate {
  id: 'STANDARD_V1'; version: string;
  builder: 'buildCurve';                               // amended 2026-09-27 (Decision 3): threshold-driven SDK 1.5.13 builder
  token: { tokenType: 'SPL'; tokenBaseDecimal: 6; tokenAuthorityOption: 'Immutable'; totalTokenSupply: number; leftover: 0 };
  fee: { baseFeeMode: 'FeeSchedulerLinear'; startingFeeBps: number; endingFeeBps: number;  // equal ⇒ flat fee
         numberOfPeriod: 0; totalDuration: 0; dynamicFeeEnabled: false; collectFeeMode: 'QuoteToken';
         enableFirstSwapWithMinFee: boolean };
  percentageSupplyOnMigration: number;                 // V0_TEST 20; migrationQuoteThreshold comes from the Decision-3 record (raw units)
  // initialMarketCap / migrationMarketCap removed: the USD ceiling is never mapped into migrationMarketCap
  maxCurvePoints: 16;
  activationType: 'Timestamp';
}
```

## 3. V0_TEST values (localnet/devnet only)
| Field | V0_TEST | Why |
|---|---|---|
| baseFeeBps | 100 | Above 25 bps minimum; easy fee assertions |
| creatorTradingFeePct | 50 | Exercises both claim paths |
| partnerRevenueSplitPct / partnerRewardsSplitPct | 50 / 50 | Exercises reward funding |
| migratedPoolFeeBps | 100 | Inside 10–1000 |
| lp | partnerPermanentLocked 50, creatorPermanentLocked 50, claimable 0 | DECISION: max lock, no claimable creator LP |
| totalSupply | 1,000,000,000 × 10^6 | Common convention; test only |

## 4. Migration threshold policy (`migration@1`)
Asset-relative: `raw_threshold = floor(requestedUsd / priceUsd(quote) × 10^decimals)` using trusted price evidence at proposal time, fixed in the config thereafter. Amended 2026-09-27: requests outside [floorUsd, ceilUsd] are **rejected, never clamped** (§6).
| Parameter | V0 experimentation value |
|---|---|
| floorUsd (hard lower bound) | ≈ $1,000 |
| targetUsd (standard simulation) | ≈ $5,000 |
| ceilUsd | $100,000 — **configurable V0 experimentation ceiling** (Decision 3, 2026-09-27). Not a default, not a target, not a market cap, not a production optimum |
Keeper eligibility is reported, not required (QF crank). The AI may recommend within [floor, ceil]; Policy Engine decides.

## 5. Simulations required before production values
1. Fee-revenue vs. graduation-probability sweep over baseFeeBps.
2. Sniper/first-buy impact under flat fee (no fee scheduler) — flat fee removes DBC's anti-sniper decay; quantify. **First pass done 2026-09-27 (simulation only): `docs/simulations/FEE-SCHEDULER-COMPARISON-V0.md`.**
3. Reward attractiveness vs. partner revenue split.
4. Migrated pool fee vs. post-migration volume retention.
5. Adversarial: wash trading to farm rewards, Sybil splitting, threshold griefing.

## 6. Amendment 2026-09-27 — Decisions 3 and 5 (implemented in `project-qf/packages/policy`, `packages/adapter-meteora-dbc`, `tools/econ-sim`)

### 6.1 Five separate quantities (Decision 3)
| Quantity | Where it lives | Notes |
|---|---|---|
| Migration quote reserve threshold | `MigrationThresholdRecord.rawQuoteThreshold` (raw quote units, string) | The only quantity `migration-v0.2` produces. After config creation the stored raw amount governs, not a repriced USD figure |
| USD-equivalent policy ceiling | `MIGRATION_POLICY_V0.ceilUsd = '100000'` (`ceilRole: V0_EXPERIMENT_CEILING`) | Checked at proposal; requests above it are REJECTED |
| Initial / migration market cap | not derived | `migrationMarketCap` is never set; `buildCurve` is used instead of `buildCurveWithMarketCap` |
| Migrated pool liquidity | not derived | Outcome of migration, reported separately |
| Creator funding / operating budget | not derived | Outside the curve |

The record keeps quote mint, decimals, price, sources, observation time, slot, rounding (DOWN), the raw integer and its USD equivalent at observation.

A proposal is rejected when:
- the request is below the floor or above the ceiling;
- the price is not trustworthy or is stale (reprice required);
- the quote market fails S3.2, or the request exceeds the eligible quote-market liquidity (so $100,000 is refused for a $25,000 market);
- exit depth was not evaluated at the threshold notional, or there is no executable exit.

An S3.1 WARN requires acknowledgement.

**Before signing.** `recheckBeforeSigning` compares the consent digest and returns one of:
- `OK`;
- `OK_REPRICED_UNCHANGED`;
- `REPRICE_REQUIRED` (stale price);
- `NEW_CONSENT_REQUIRED` (the raw amount or economics changed materially).

Approved economics are never altered silently.

**In the adapter.** It refuses thresholds a double cannot carry exactly (`FAIL_CLOSED`), and fails closed if the SDK-stored `migrationQuoteThreshold` differs from the approved raw amount.

### 6.2 V0_TEST curve values
- `percentageSupplyOnMigration = 20` is a new V0_TEST value required by `buildCurve`, chosen for test ergonomics. It is not a production choice.
- Flat fee: `FeeSchedulerLinear`, start 100 = end 100 bps, 0 periods, 0 duration → `cliffFeeNumerator` 10,000,000 (denominator 1e9).
- `validateConfigParameters` accepts the config (adapter compatibility tests).

### 6.3 Decision 5 — flat baseline, one bounded decay in simulation only
- **Flat** (`STANDARD_V1@0-v0test-flat`) stays the V0_TEST baseline.
- **Decay** (`STANDARD_V1@0-sim-linear-decay-2500-100-12x10s`):
  - Linear from 2,500 to 100 bps in 12 periods over 120 s. The SDK accepts it.
  - Its usage is `SIMULATION_ONLY`.
  - `validateCurveTemplate` bounds it at 2,500 bps and 120 s or less.
  - Transaction intents that reference it are rejected (`TEMPLATE_SIMULATION_ONLY`).
- **Comparison.** Six identical synthetic traces, with failures retained, are in `docs/simulations/FEE-SCHEDULER-COMPARISON-V0.md`. Neither configuration is sniper-proof.
- No production fee template is selected. P0-M3 stays open.

## 7. Amendment 2026-09-27 — repair pass (ECON-1, Decision 5 retained)
- **ECON-1.** `percentageSupplyOnMigration = 20` is an explicit V0_TEST **fixture** (`STANDARD_V1.fixtureLabels.percentageSupplyOnMigration = 'V0_TEST_FIXTURE'`). It is not a fee and not a production selection; `assertTemplateUsableFor(..., 'PRODUCTION_CONFIG')` always refuses.
- **Accounting tests** (`packages/adapter-meteora-dbc/test/supply-accounting.test.ts`): total supply 1e15 raw; curve swap supply ≤ 80% with a shortfall below 1 ppm (SDK sqrt-price rounding); swap + migration never exceeds supply; the curve reaches exactly the approved raw quote threshold; 30% moves the split, so the label matters.
- **Decision 5 unchanged.** Flat fee stays the baseline; decay stays SIMULATION_ONLY with all failed hypotheses retained.
