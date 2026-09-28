import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckResult } from '@project-qf/core';
import { aggregate, REQUIRED_LIVE_CHECKS } from '../src/aggregate.ts';
import { assertNotTestOnlyAsset, testOnlyAssetId } from '../src/registry.ts';

const c = (id: string, decision: CheckResult['decision']): CheckResult =>
  ({ id, decision, reason: 'fixture', evidence: [], details: {}, policyVersion: 'validator-v0.1' });

test('aggregate: any FAIL -> FAIL, else any WARN -> WARN, else PASS', () => {
  const all = REQUIRED_LIVE_CHECKS.map((id) => c(id, 'PASS'));
  assert.equal(aggregate(all, 'LIVE').decision, 'PASS');
  assert.equal(aggregate([...all.slice(1), c(all[0]!.id, 'WARN')], 'LIVE').decision, 'WARN');
  assert.equal(aggregate([...all.slice(1), c(all[0]!.id, 'FAIL')], 'LIVE').decision, 'FAIL');
});

test('LIVE: a required check that is missing or SKIP makes the result FAIL', () => {
  const all = REQUIRED_LIVE_CHECKS.map((id) => c(id, 'PASS'));
  const missing = aggregate(all.filter((x) => x.id !== 'S3.2'), 'LIVE');
  assert.equal(missing.decision, 'FAIL');
  assert.match(missing.reasons.join(' '), /REQUIRED_CHECK_MISSING S3.2/);
  const skipped = aggregate([...all.filter((x) => x.id !== 'S3.1'), c('S3.1', 'SKIP')], 'LIVE');
  assert.equal(skipped.decision, 'FAIL');
});

test('TEST_ONLY aggregate is never PASS', () => {
  const all = REQUIRED_LIVE_CHECKS.map((id) => c(id, 'PASS'));
  assert.equal(aggregate(all, 'TEST_ONLY').decision, 'WARN');
});

test('TEST_ONLY guard: synthetic assets are refused; passing the guard admits nothing', () => {
  assert.equal(testOnlyAssetId('qUSD'), 'test-only:qUSD');
  const synthetic = { id: testOnlyAssetId('qUSD'), mint: 'MOCKqUSD', symbol: 'qUSD', issuerClass: 'TEST_ONLY' as const, evidence: [] };
  assert.throws(() => assertNotTestOnlyAsset(synthetic), /TEST_ONLY/);
  // relabelling the id does not launder it
  assert.throws(() => assertNotTestOnlyAsset({ ...synthetic, id: 'qUSD' }), /TEST_ONLY/);
  // nor does TEST_ONLY evidence on an otherwise production-looking asset
  assert.throws(() => assertNotTestOnlyAsset({ id: 'usdx', issuerClass: 'ISSUER_VERIFIED',
    evidence: [{ source: 'x', providerClass: 'TEST_ONLY', observedAt: '2026-09-27T00:00:00Z' }] }), /TEST_ONLY/);
  // QF-VAL-02: the former promoteToProductionRegistry returned a PRODUCTION record for an asserted ISSUER_VERIFIED
  // class with mint 'MOCKx'. That test defined the deficient behaviour as success and was removed with the function.
  assert.equal(assertNotTestOnlyAsset({ id: 'usdx', issuerClass: 'ISSUER_VERIFIED', evidence: [] }), undefined);
});
