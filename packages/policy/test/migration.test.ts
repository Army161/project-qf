import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckResult } from '@project-qf/core';
import { EVIDENCE_POLICY_V0_1 } from '@project-qf/validator';
import { MIGRATION_POLICY_V0, proposeMigrationThreshold, recheckBeforeSigning, governingThreshold, type PriceEvidence } from '../src/migration.ts';
import { economicsDigest } from '../src/economics.ts';

const NOW = '2026-09-27T12:00:00.000Z';
const price = (p: string, at = '2026-09-27T11:59:30.000Z', status: PriceEvidence['status'] = 'OK'): PriceEvidence =>
  ({ status, priceUsd: p, sources: ['pyth-fixture', 'indexer-fixture'], observedAt: at, slot: '123456' });
const liq = (usd: string, decision: CheckResult['decision'] = 'PASS'): CheckResult =>
  ({ id: 'S3.2', decision, reason: 'fixture', evidence: [], details: { eligibleUsd: usd }, policyVersion: 'validator-v0.1' });
const exit = (notionalRaw: string, decision: CheckResult['decision'] = 'PASS'): CheckResult =>
  ({ id: 'S3.1', decision, reason: 'fixture', evidence: [], details: { notionalRaw }, policyVersion: 'validator-v0.1' });
const quote = { mint: 'MOCKqUSD', decimals: 6 };
const base = { policy: MIGRATION_POLICY_V0, evidencePolicy: EVIDENCE_POLICY_V0_1, now: NOW, quote };

test('policy: ceiling is $100,000 as a configurable V0 experiment ceiling, not the default target', () => {
  assert.equal(MIGRATION_POLICY_V0.ceilUsd, '100000');
  assert.equal(MIGRATION_POLICY_V0.ceilRole, 'V0_EXPERIMENT_CEILING');
  assert.equal(MIGRATION_POLICY_V0.targetUsd, '5000');
  const r = proposeMigrationThreshold({ ...base, price: price('1'), liquidity: liq('300000'), exitDepth: exit('5000000000') });
  assert.equal(r.status, 'OK', r.reasons.join());
  assert.equal(r.record?.requestedUsd, '5000', 'default is target, never the ceiling');
});

test('USD to raw quote units: exact, rounded DOWN, with price/time/slot/decimals recorded', () => {
  const r = proposeMigrationThreshold({ ...base, requestedUsd: '100000', price: price('0.3'), liquidity: liq('1000000'), exitDepth: exit('999999999999') });
  assert.equal(r.status, 'OK', r.reasons.join());
  const rec = r.record!;
  // 100000 / 0.3 = 333333.333333... tokens -> 333333333333 raw (6 dp), rounded down
  assert.equal(rec.rawQuoteThreshold, '333333333333');
  assert.equal(rec.rounding, 'DOWN');
  assert.equal(rec.quoteDecimals, 6);
  assert.equal(rec.priceUsd, '0.3');
  assert.equal(rec.priceObservedAt, '2026-09-27T11:59:30.000Z');
  assert.equal(rec.priceSlot, '123456');
  assert.deepEqual(rec.priceSources, ['pyth-fixture', 'indexer-fixture']);
  assert.equal(rec.usdEquivalentAtObservation, '99999.9999999'); // never exceeds the ceiling
  assert.ok(Object.isFrozen(rec));
});

test('the threshold record never carries or implies a market capitalisation', () => {
  const r = proposeMigrationThreshold({ ...base, price: price('1'), liquidity: liq('300000'), exitDepth: exit('5000000000') });
  const keys = Object.keys(r.record!).join(' ');
  assert.doesNotMatch(keys, /marketCap|MarketCap/);
  assert.equal(r.record!.quantity, 'MIGRATION_QUOTE_RESERVE_THRESHOLD');
});

test('outside [floor, ceiling] is rejected, never silently clamped', () => {
  const hi = proposeMigrationThreshold({ ...base, requestedUsd: '100000.01', price: price('1'), liquidity: liq('9999999'), exitDepth: exit('999999999999') });
  assert.equal(hi.status, 'REJECTED');
  assert.match(hi.reasons.join(), /ABOVE_V0_EXPERIMENT_CEILING/);
  assert.equal(hi.record, undefined);
  const lo = proposeMigrationThreshold({ ...base, requestedUsd: '999.99', price: price('1'), liquidity: liq('9999999'), exitDepth: exit('999999999999') });
  assert.equal(lo.status, 'REJECTED');
  assert.match(lo.reasons.join(), /BELOW_FLOOR/);
});

test('$100,000 is not appropriate for a market with only $25,000 eligible liquidity', () => {
  const r = proposeMigrationThreshold({ ...base, requestedUsd: '100000', price: price('1'), liquidity: liq('25000', 'WARN'), exitDepth: exit('100000000000', 'WARN') });
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reasons.join(), /THRESHOLD_EXCEEDS_ELIGIBLE_QUOTE_MARKET_LIQUIDITY/);
});

test('exit depth must be evaluated at (at least) the threshold notional', () => {
  const small = proposeMigrationThreshold({ ...base, requestedUsd: '50000', price: price('1'), liquidity: liq('1000000'), exitDepth: exit('1000000') });
  assert.equal(small.status, 'REJECTED');
  assert.match(small.reasons.join(), /EXIT_DEPTH_NOT_EVALUATED_AT_THRESHOLD_NOTIONAL/);
  const fail = proposeMigrationThreshold({ ...base, requestedUsd: '50000', price: price('1'), liquidity: liq('1000000'), exitDepth: exit('50000000000', 'FAIL') });
  assert.equal(fail.status, 'REJECTED');
  const warn = proposeMigrationThreshold({ ...base, requestedUsd: '50000', price: price('1'), liquidity: liq('1000000'), exitDepth: exit('50000000000', 'WARN') });
  assert.equal(warn.status, 'REQUIRES_ACKNOWLEDGEMENT');
});

test('untrustworthy, stale or missing price rejects the proposal', () => {
  for (const p of [price('1', '2026-09-27T11:00:00.000Z'), price('1', undefined, 'DISAGREEMENT'), price('1', undefined, 'INSUFFICIENT')]) {
    const r = proposeMigrationThreshold({ ...base, price: p, liquidity: liq('300000'), exitDepth: exit('5000000000') });
    assert.equal(r.status, 'REJECTED', JSON.stringify(p));
  }
  const failedLiq = proposeMigrationThreshold({ ...base, price: price('1'), liquidity: liq('20000', 'FAIL'), exitDepth: exit('5000000000') });
  assert.equal(failedLiq.status, 'REJECTED');
});

test('stale proposals are repriced before signing and material change needs new consent', () => {
  const r = proposeMigrationThreshold({ ...base, requestedUsd: '5000', price: price('1'), liquidity: liq('300000'), exitDepth: exit('5000000000') });
  const rec = r.record!;
  const consent = { digest: economicsDigest({ threshold: rec }) };
  const later = '2026-09-27T12:10:00.000Z';
  // Fresh price at the same level: same raw threshold -> consent still binds.
  const same = recheckBeforeSigning({ record: rec, consent, now: later, currentPrice: price('1', '2026-09-27T12:09:50.000Z'), evidencePolicy: EVIDENCE_POLICY_V0_1 });
  assert.equal(same.status, 'OK_REPRICED_UNCHANGED');
  // Price moved: raw threshold would change -> new preview + consent, the approved record is not altered.
  const moved = recheckBeforeSigning({ record: rec, consent, now: later, currentPrice: price('1.25', '2026-09-27T12:09:50.000Z'), evidencePolicy: EVIDENCE_POLICY_V0_1 });
  assert.equal(moved.status, 'NEW_CONSENT_REQUIRED');
  assert.equal(moved.proposed?.rawQuoteThreshold, '4000000000');
  assert.equal(rec.rawQuoteThreshold, '5000000000', 'approved record unchanged');
  // No fresh price available: cannot sign.
  const blocked = recheckBeforeSigning({ record: rec, consent, now: later, currentPrice: price('1', '2026-09-27T11:59:30.000Z'), evidencePolicy: EVIDENCE_POLICY_V0_1 });
  assert.equal(blocked.status, 'REPRICE_REQUIRED');
  // Tampered consent digest.
  const tampered = recheckBeforeSigning({ record: rec, consent: { digest: '00'.repeat(32) }, now: NOW, currentPrice: price('1'), evidencePolicy: EVIDENCE_POLICY_V0_1 });
  assert.equal(tampered.status, 'NEW_CONSENT_REQUIRED');
});

test('after config creation the stored raw amount governs; USD is informational', () => {
  const g1 = governingThreshold({ storedRawQuoteThreshold: '5000000000', quoteDecimals: 6, currentPrice: price('1') });
  const g2 = governingThreshold({ storedRawQuoteThreshold: '5000000000', quoteDecimals: 6, currentPrice: price('2') });
  assert.equal(g1.governingRaw, '5000000000');
  assert.equal(g2.governingRaw, '5000000000');
  assert.equal(g1.informationalUsdNow, '5000');
  assert.equal(g2.informationalUsdNow, '10000');
});
