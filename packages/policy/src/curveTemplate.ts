// CurveTemplate (ECONOMICS.md §2, amended 2026-09-27). Field names mirror
// @meteora-ag/dynamic-bonding-curve-sdk@1.5.13 `buildCurve` params; enums are carried by name
// and mapped to SDK values only inside packages/adapter-meteora-dbc.
// `buildCurve` takes the migration quote threshold directly (Decision 3): the USD ceiling is
// never expressed through the SDK's `migrationMarketCap`.
import type { EconomicsPolicy } from './economics.ts';

export interface FeeSchedulerParam { startingFeeBps: number; endingFeeBps: number; numberOfPeriod: number; totalDuration: number }
export interface CurveTemplate {
  id: 'STANDARD_V1';
  version: string;
  usage: 'V0_TEST_BASELINE' | 'SIMULATION_ONLY';
  builder: 'buildCurve';
  token: { tokenType: 'SPLToken' | 'Token2022'; tokenBaseDecimal: 6; tokenAuthorityOption: EconomicsPolicy['tokenAuthorityOption']; totalTokenSupply: string; leftover: string };
  percentageSupplyOnMigration: number;
  /** Fields whose values are explicit test fixtures (ECON-1): never a production selection. */
  fixtureLabels?: Readonly<Record<string, 'V0_TEST_FIXTURE'>>;
  fee: {
    baseFeeMode: 'FeeSchedulerLinear' | 'FeeSchedulerExponential';
    feeSchedulerParam: FeeSchedulerParam;
    dynamicFeeEnabled: boolean;
    collectFeeMode: 'QuoteToken';
    enableFirstSwapWithMinFee: boolean;
  };
  activationType: 'Timestamp';
  maxCurvePoints: 16;
}

export const STANDARD_V1_FLAT_V0_TEST: Readonly<CurveTemplate> = Object.freeze({
  id: 'STANDARD_V1',
  version: 'STANDARD_V1@0-v0test-flat',
  usage: 'V0_TEST_BASELINE',
  builder: 'buildCurve',
  token: Object.freeze({ tokenType: 'SPLToken', tokenBaseDecimal: 6, tokenAuthorityOption: 'Immutable', totalTokenSupply: '1000000000', leftover: '0' }),
  percentageSupplyOnMigration: 20, // ECON-1 (owner decision 2026-09-27): V0_TEST fixture only, not a fee or production selection
  fixtureLabels: Object.freeze({ percentageSupplyOnMigration: 'V0_TEST_FIXTURE' as const }),
  fee: Object.freeze({
    baseFeeMode: 'FeeSchedulerLinear',
    feeSchedulerParam: Object.freeze({ startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 }), // flat
    dynamicFeeEnabled: false,
    collectFeeMode: 'QuoteToken',
    enableFirstSwapWithMinFee: false,
  }),
  activationType: 'Timestamp',
  maxCurvePoints: 16,
}) as Readonly<CurveTemplate>;

// Decision 5: exactly one bounded decay configuration, simulation only. Linear 25% -> 1% in
// 12 steps over 120 s (activationType Timestamp), then identical to the flat baseline.
export const DECAY_EXPERIMENT_V0_SIM: Readonly<CurveTemplate> = Object.freeze({
  ...STANDARD_V1_FLAT_V0_TEST,
  version: 'STANDARD_V1@0-sim-linear-decay-2500-100-12x10s',
  usage: 'SIMULATION_ONLY',
  fee: Object.freeze({
    ...STANDARD_V1_FLAT_V0_TEST.fee,
    feeSchedulerParam: Object.freeze({ startingFeeBps: 2500, endingFeeBps: 100, numberOfPeriod: 12, totalDuration: 120 }),
  }),
}) as Readonly<CurveTemplate>;

export function validateCurveTemplate(t: CurveTemplate, e: EconomicsPolicy): string[] {
  const v: string[] = [];
  const f = t.fee.feeSchedulerParam;
  if (t.builder !== 'buildCurve') v.push('builder must be buildCurve (threshold-driven, Decision 3)');
  if (t.token.tokenType !== 'SPLToken') v.push('tokenType must be SPLToken (default launched token is classic SPL)');
  if (t.token.tokenAuthorityOption !== 'Immutable') v.push('tokenAuthorityOption must be Immutable');
  if (!/^\d+$/.test(t.token.totalTokenSupply) || !/^\d+$/.test(t.token.leftover)) v.push('supply/leftover must be integer strings');
  if (!(Number.isInteger(t.percentageSupplyOnMigration) && t.percentageSupplyOnMigration > 0 && t.percentageSupplyOnMigration < 100)) v.push('percentageSupplyOnMigration must be an integer in 1..99');
  if (t.fee.dynamicFeeEnabled) v.push('dynamicFeeEnabled must be false');
  if (t.fee.collectFeeMode !== 'QuoteToken') v.push('collectFeeMode must be QuoteToken');
  if (![f.startingFeeBps, f.endingFeeBps, f.numberOfPeriod, f.totalDuration].every(Number.isInteger)) v.push('fee scheduler params must be integers');
  if (f.endingFeeBps !== e.baseFeeBps) v.push(`ending fee must equal EconomicsPolicy.baseFeeBps (${e.baseFeeBps})`);
  if (f.startingFeeBps < 25 || f.startingFeeBps > 9900 || f.endingFeeBps < 25) v.push('fee bps outside engine bounds 25..9900');
  if (t.usage === 'V0_TEST_BASELINE') {
    if (t.fee.baseFeeMode !== 'FeeSchedulerLinear' || f.startingFeeBps !== f.endingFeeBps || f.numberOfPeriod !== 0 || f.totalDuration !== 0) {
      v.push('V0_TEST baseline must be flat: FeeSchedulerLinear, start == end, numberOfPeriod 0, totalDuration 0');
    }
  } else {
    if (!(f.startingFeeBps > f.endingFeeBps && f.numberOfPeriod > 0 && f.totalDuration > 0)) v.push('decay template must decay');
    if (f.startingFeeBps > 2500 || f.totalDuration > 120) v.push('decay template exceeds the bounded experiment (<=2500 bps, <=120 s)');
  }
  return v;
}

export function assertTemplateUsableFor(t: CurveTemplate, purpose: 'TX_INTENT' | 'SIMULATION' | 'PRODUCTION_CONFIG'): void {
  if (purpose === 'TX_INTENT' && t.usage !== 'V0_TEST_BASELINE') {
    throw new Error(`template ${t.version} is ${t.usage}; it cannot back a transaction intent`);
  }
  // No test-to-production promotion: V0 has no production template, and fixture-labelled values never qualify.
  if (purpose === 'PRODUCTION_CONFIG') {
    const labelled = Object.keys(t.fixtureLabels ?? {});
    throw new Error(`template ${t.version} (${t.usage}) cannot be a production config${labelled.length ? `; V0_TEST_FIXTURE fields: ${labelled.join(', ')}` : ''}`);
  }
}
