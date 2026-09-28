import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMICS_V0_TEST, validateEconomics, economicsDigest } from '../src/economics.ts';
import { STANDARD_V1_FLAT_V0_TEST, DECAY_EXPERIMENT_V0_SIM, validateCurveTemplate, assertTemplateUsableFor } from '../src/curveTemplate.ts';

test('V0_TEST economics are valid and labelled test-only', () => {
  assert.deepEqual(validateEconomics(ECONOMICS_V0_TEST), []);
  assert.equal(ECONOMICS_V0_TEST.usage, 'V0_TEST');
  assert.equal(ECONOMICS_V0_TEST.lp.creatorClaimablePct, 0);
  assert.equal(ECONOMICS_V0_TEST.lp.partnerClaimablePct, 0);
  assert.equal(ECONOMICS_V0_TEST.tokenAuthorityOption, 'Immutable');
});

test('engine bounds and decisions are enforced', () => {
  const bad = (patch: object) => validateEconomics({ ...ECONOMICS_V0_TEST, ...patch } as typeof ECONOMICS_V0_TEST);
  assert.match(bad({ baseFeeBps: 24 }).join(), /baseFeeBps/);
  assert.match(bad({ baseFeeBps: 9901 }).join(), /baseFeeBps/);
  assert.match(bad({ migratedPoolFeeBps: 9 }).join(), /migratedPoolFeeBps/);
  assert.match(bad({ migratedPoolFeeBps: 1001 }).join(), /migratedPoolFeeBps/);
  assert.match(bad({ partnerRevenueSplitPct: 60 }).join(), /split/);
  assert.match(bad({ migrationExtractionFeePct: 1 }).join(), /migrationExtractionFeePct/);
  assert.match(bad({ dynamicFee: true }).join(), /dynamicFee/);
  assert.match(bad({ tokenAuthorityOption: 'CreatorUpdateAndMintAuthority' }).join(), /tokenAuthorityOption/);
  assert.match(bad({ lp: { ...ECONOMICS_V0_TEST.lp, creatorClaimablePct: 10, creatorPermanentLockedPct: 40 } }).join(), /claimable/);
  assert.match(bad({ lp: { ...ECONOMICS_V0_TEST.lp, partnerPermanentLockedPct: 40 } }).join(), /sum to 100/);
  assert.match(bad({ creatorTradingFeePct: 50.5 }).join(), /creatorTradingFeePct/);
});

test('flat fee is the V0_TEST baseline: FeeSchedulerLinear with start == end and no periods', () => {
  const t = STANDARD_V1_FLAT_V0_TEST;
  assert.equal(t.usage, 'V0_TEST_BASELINE');
  assert.equal(t.builder, 'buildCurve');
  assert.equal(t.fee.baseFeeMode, 'FeeSchedulerLinear');
  assert.equal(t.fee.feeSchedulerParam.startingFeeBps, t.fee.feeSchedulerParam.endingFeeBps);
  assert.equal(t.fee.feeSchedulerParam.numberOfPeriod, 0);
  assert.equal(t.fee.feeSchedulerParam.totalDuration, 0);
  assert.deepEqual(validateCurveTemplate(t, ECONOMICS_V0_TEST), []);
});

test('the decay comparison is one bounded, simulation-only configuration', () => {
  const d = DECAY_EXPERIMENT_V0_SIM;
  assert.equal(d.usage, 'SIMULATION_ONLY');
  assert.ok(d.fee.feeSchedulerParam.startingFeeBps > d.fee.feeSchedulerParam.endingFeeBps);
  assert.ok(d.fee.feeSchedulerParam.startingFeeBps <= 2500, 'bounded start');
  assert.ok(d.fee.feeSchedulerParam.totalDuration <= 120, 'bounded duration');
  assert.equal(d.fee.feeSchedulerParam.endingFeeBps, ECONOMICS_V0_TEST.baseFeeBps, 'decays to the flat baseline fee');
  assert.deepEqual(validateCurveTemplate(d, ECONOMICS_V0_TEST), []);
  // identical except for the fee schedule
  const strip = (x: typeof d | typeof STANDARD_V1_FLAT_V0_TEST) => ({ ...x, version: '', usage: '', fee: { ...x.fee, feeSchedulerParam: null } });
  assert.deepEqual(strip(d), strip(STANDARD_V1_FLAT_V0_TEST));
});

test('simulation-only templates cannot be used for a transaction intent', () => {
  assert.doesNotThrow(() => assertTemplateUsableFor(STANDARD_V1_FLAT_V0_TEST, 'TX_INTENT'));
  assert.throws(() => assertTemplateUsableFor(DECAY_EXPERIMENT_V0_SIM, 'TX_INTENT'), /SIMULATION_ONLY/);
  assert.doesNotThrow(() => assertTemplateUsableFor(DECAY_EXPERIMENT_V0_SIM, 'SIMULATION'));
});

test('invalid templates are caught', () => {
  const t = STANDARD_V1_FLAT_V0_TEST;
  const v = (patch: object) => validateCurveTemplate({ ...t, ...patch } as typeof t, ECONOMICS_V0_TEST).join();
  assert.match(v({ fee: { ...t.fee, feeSchedulerParam: { ...t.fee.feeSchedulerParam, endingFeeBps: 90 } } }), /flat/);
  assert.match(v({ fee: { ...t.fee, dynamicFeeEnabled: true } }), /dynamicFee/);
  assert.match(v({ token: { ...t.token, tokenAuthorityOption: 'PartnerUpdateAndMintAuthority' } }), /tokenAuthorityOption/);
  assert.match(v({ token: { ...t.token, tokenType: 'Token2022' } }), /tokenType/);
  assert.match(v({ percentageSupplyOnMigration: 0 }), /percentageSupplyOnMigration/);
  assert.match(v({ fee: { ...t.fee, feeSchedulerParam: { ...t.fee.feeSchedulerParam, startingFeeBps: 150, endingFeeBps: 150 } } }), /baseFeeBps/);
});

test('economics digest is canonical (key order independent) and changes with any field', () => {
  const a = economicsDigest({ b: 1, a: { y: '2', x: 1n } });
  const b = economicsDigest({ a: { x: 1n, y: '2' }, b: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, economicsDigest({ a: { x: 2n, y: '2' }, b: 1 }));
});
