import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_FLAGS, assertCapabilityEnabled } from '../src/flags.ts';
import { READINESS, assertStageActive, STAGES } from '../src/readiness.ts';
import { labelMock, isMock, assertNotMock, MOCK_BANNER } from '../src/mock.ts';

test('capability flags default to the decided V1 values', () => {
  assert.equal(CAPABILITY_FLAGS.DBC_BASE_TRANSFER_FEE, 'EXPERIMENTAL_DISABLED');
  assert.equal(CAPABILITY_FLAGS.REWARDS_SETTLEMENT_MAINNET, false);
  assert.equal(CAPABILITY_FLAGS.JUPITER_PROVIDER, 'OPTIONAL_LEGAL_GATED');
  assert.equal(CAPABILITY_FLAGS.MAINNET_WRITES, false);
  assert.ok(Object.isFrozen(CAPABILITY_FLAGS));
  for (const f of ['DBC_BASE_TRANSFER_FEE', 'REWARDS_SETTLEMENT_MAINNET', 'JUPITER_PROVIDER', 'MAINNET_WRITES'] as const) {
    assert.throws(() => assertCapabilityEnabled(f), /disabled|gated/i, f);
  }
});

test('readiness is tracked as four separate stages', () => {
  assert.deepEqual(STAGES, ['OFFLINE_V0', 'READ_ONLY_VERIFICATION', 'LOCALNET_INTEGRATION', 'DEVNET_INTEGRATION', 'MAINNET']);
  assert.equal(READINESS.OFFLINE_V0.status, 'ACTIVE');
  assert.equal(READINESS.READ_ONLY_VERIFICATION.status, 'BLOCKED');
  assert.equal(READINESS.LOCALNET_INTEGRATION.status, 'BLOCKED');
  // devnet opened by the product owner 2026-10-03T21:06Z (devnet only; DEV-3 carried to MAINNET)
  assert.equal(READINESS.DEVNET_INTEGRATION.status, 'ACTIVE');
  assert.match(READINESS.DEVNET_INTEGRATION.scope, /2026-10-03T21:06:00Z/);
  assert.ok(READINESS.MAINNET.blockers.some((b) => b.startsWith('DEV-3')), 'DEV-3 stays a mainnet blocker');
  assert.equal(READINESS.MAINNET.status, 'BLOCKED');
  assert.doesNotThrow(() => assertStageActive('OFFLINE_V0'));
  assert.doesNotThrow(() => assertStageActive('DEVNET_INTEGRATION'));
  for (const s of ['LOCALNET_INTEGRATION', 'MAINNET'] as const) {
    assert.throws(() => assertStageActive(s), /BLOCKED/);
    assert.ok(READINESS[s].blockers.length > 0, `${s} must list blockers`);
  }
  assert.ok(Object.isFrozen(READINESS) && Object.isFrozen(READINESS.MAINNET));
});

test('mock values are conspicuously labelled and cannot pass as live', () => {
  const v = labelMock({ curveProgressPct: '42' }, 'fixture curve progress');
  assert.equal(isMock(v), true);
  assert.equal(v.__mock.label, 'MOCK');
  assert.equal(v.__mock.live, false);
  assert.throws(() => assertNotMock(v), /MOCK/);
  assert.doesNotThrow(() => assertNotMock({ curveProgressPct: '42' }));
  assert.match(MOCK_BANNER, /MOCK/);
  assert.match(MOCK_BANNER, /not live/i);
});
