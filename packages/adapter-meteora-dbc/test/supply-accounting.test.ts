// ECON-1: percentageSupplyOnMigration=20 is a V0_TEST fixture only. These tests check that the value flows through
// the pinned SDK with consistent units (raw base units = tokens * 10^decimals; raw quote units = quote * 10^6), and
// that a fixture-labelled template can never be promoted to a production config. Pure SDK math, no RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import * as dbc from '@meteora-ag/dynamic-bonding-curve-sdk';
import { ECONOMICS_V0_TEST, STANDARD_V1_FLAT_V0_TEST, assertTemplateUsableFor, type CurveTemplate } from '@project-qf/policy';
import { buildCurveConfig, createQuoteSimulator } from '../src/index.ts';
import { thresholdRecord } from './support/fixtures.ts';

const T = 1_000_000_000n * 10n ** 6n; // 1e9 tokens at 6 decimals = 1e15 raw base units
const split = (tpl: CurveTemplate) => {
  const cfg = buildCurveConfig(tpl, ECONOMICS_V0_TEST, thresholdRecord());
  const sim = createQuoteSimulator(cfg);
  const swapBase = BigInt((dbc as unknown as { getBaseTokenForSwap(a: BN, b: BN, c: unknown): BN }).getBaseTokenForSwap(cfg.sqrtStartPrice, new BN(sim.migrationSqrtPrice.toString()), cfg.curve).toString());
  return { cfg, sim, swapBase };
};

test('ECON-1: the 20% migration supply is labelled a V0_TEST fixture', () => {
  assert.equal(STANDARD_V1_FLAT_V0_TEST.percentageSupplyOnMigration, 20);
  assert.equal(STANDARD_V1_FLAT_V0_TEST.fixtureLabels?.percentageSupplyOnMigration, 'V0_TEST_FIXTURE');
});

test('ECON-1 accounting: total supply is 1e15 raw; curve swap supply is 80% of it and 20% remains for migration', () => {
  const { cfg, swapBase } = split(STANDARD_V1_FLAT_V0_TEST);
  assert.equal(BigInt(cfg.tokenSupply!.preMigrationTokenSupply.toString()), T);
  assert.equal(BigInt(cfg.tokenSupply!.postMigrationTokenSupply.toString()), T);
  const eighty = (T * 80n) / 100n;
  assert.ok(swapBase <= eighty, `swap supply ${swapBase} must not exceed 80% (${eighty})`);
  assert.ok(eighty - swapBase < T / 1_000_000n, `shortfall ${eighty - swapBase} raw must be < 1 ppm of supply (SDK sqrt-price rounding)`);
  assert.ok(swapBase + (T * 20n) / 100n <= T, 'swap + migration never exceeds total supply (leftover 0, no vesting)');
});

test('ECON-1 units: the curve reaches exactly the approved raw quote threshold at the migration price', () => {
  const { cfg, sim } = split(STANDARD_V1_FLAT_V0_TEST);
  assert.equal(cfg.migrationQuoteThreshold.toString(), thresholdRecord().rawQuoteThreshold);
  assert.equal(sim.quoteReserveAt(sim.migrationSqrtPrice).toString(), cfg.migrationQuoteThreshold.toString());
});

test('ECON-1: the field is live in the math (30% moves the split), so the fixture label matters', () => {
  const { swapBase } = split({ ...STANDARD_V1_FLAT_V0_TEST, percentageSupplyOnMigration: 30 });
  const seventy = (T * 70n) / 100n;
  assert.ok(swapBase <= seventy && seventy - swapBase < T / 1_000_000n, String(swapBase));
});

test('ECON-1: no test-to-production promotion of a fixture-labelled template', () => {
  assert.throws(() => assertTemplateUsableFor(STANDARD_V1_FLAT_V0_TEST, 'PRODUCTION_CONFIG'), /V0_TEST_FIXTURE fields: percentageSupplyOnMigration/);
  assert.doesNotThrow(() => assertTemplateUsableFor(STANDARD_V1_FLAT_V0_TEST, 'TX_INTENT'));
});
