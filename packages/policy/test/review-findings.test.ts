// Regression tests for QF-POL-01/02 (independent review 2026-09-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATION_POLICY_V0, proposeMigrationThreshold, recheckBeforeSigning, economicsDigest } from '../src/index.ts';
import { EVIDENCE_POLICY_V0_1 } from '@project-qf/validator';

const NOW = '2026-09-27T12:00:00.000Z';
const base = {
  policy: MIGRATION_POLICY_V0, evidencePolicy: EVIDENCE_POLICY_V0_1, now: NOW, quote: { mint: 'test-only:qUSD', decimals: 6 },
  price: { status: 'OK' as const, priceUsd: '1', sources: ['a', 'b'], observedAt: '2026-09-27T11:59:30.000Z', slot: '1' },
  liquidity: { id: 'S3.2', decision: 'PASS' as const, reason: 'fixture', evidence: [], details: { eligibleUsd: '300000' }, policyVersion: 'validator-v0.1' },
  exitDepth: { id: 'S3.1', decision: 'PASS' as const, reason: 'fixture', evidence: [], details: { notionalRaw: '5000000000' }, policyVersion: 'validator-v0.1' },
};

test('QF-POL-01: a liquidity WARN with exit-depth PASS requires acknowledgement', () => {
  const r = proposeMigrationThreshold({ ...base, liquidity: { ...base.liquidity, decision: 'WARN', details: { eligibleUsd: '100000' } } });
  assert.equal(r.status, 'REQUIRES_ACKNOWLEDGEMENT');
});

test('QF-POL-02: newer adverse price evidence invalidates a record still inside its TTL', () => {
  const r = proposeMigrationThreshold(base);
  const record = r.record!;
  const res = recheckBeforeSigning({ record, consent: { digest: economicsDigest({ threshold: record }) }, now: '2026-09-27T12:00:30.000Z',
    currentPrice: { status: 'DISAGREEMENT', priceUsd: '0.9', sources: ['a', 'b'], observedAt: '2026-09-27T12:00:20.000Z', slot: '2' },
    evidencePolicy: EVIDENCE_POLICY_V0_1 });
  assert.notEqual(res.status, 'OK');
  assert.notEqual(res.status, 'OK_REPRICED_UNCHANGED');
});

// ---------- additional secure-outcome tests for QF-POL-01/02 and EV-1 ----------
import { acknowledgementDigest, EXECUTION_FRESHNESS_POLICY } from '../src/index.ts';

test('QF-POL-01: the acknowledgement lists every WARN and is bound to evidence and policy', () => {
  const both = proposeMigrationThreshold({ ...base, liquidity: { ...base.liquidity, decision: 'WARN', details: { eligibleUsd: '100000' } },
    exitDepth: { ...base.exitDepth, decision: 'WARN' } });
  assert.equal(both.status, 'REQUIRES_ACKNOWLEDGEMENT');
  assert.equal(both.acknowledgement!.warnings.length, 2);
  const again = proposeMigrationThreshold({ ...base, liquidity: { ...base.liquidity, decision: 'WARN', details: { eligibleUsd: '100000' } },
    exitDepth: { ...base.exitDepth, decision: 'WARN' } });
  assert.equal(again.acknowledgement!.digest, both.acknowledgement!.digest, 'deterministic');
  const otherEvidence = acknowledgementDigest({ ...base, liquidity: { ...base.liquidity, decision: 'WARN', details: { eligibleUsd: '99999' } },
    exitDepth: { ...base.exitDepth, decision: 'WARN' } }, both.record!, both.acknowledgement!.warnings);
  assert.notEqual(otherEvidence, both.acknowledgement!.digest, 'different evidence -> different acknowledgement');
  const otherPolicy = acknowledgementDigest({ ...base, evidencePolicy: { ...EVIDENCE_POLICY_V0_1, id: 'evidence-v0.2' } as never,
    liquidity: { ...base.liquidity, decision: 'WARN', details: { eligibleUsd: '100000' } }, exitDepth: { ...base.exitDepth, decision: 'WARN' } }, both.record!, both.acknowledgement!.warnings);
  assert.notEqual(otherPolicy, both.acknowledgement!.digest, 'different policy -> different acknowledgement');
  assert.equal(proposeMigrationThreshold(base).acknowledgement, undefined, 'no WARN, nothing to acknowledge');
});

test('QF-POL-01: recheck refuses a missing or stale acknowledgement', () => {
  const r = proposeMigrationThreshold({ ...base, liquidity: { ...base.liquidity, decision: 'WARN', details: { eligibleUsd: '100000' } } });
  const consent = { digest: economicsDigest({ threshold: r.record! }) };
  const common = { record: r.record!, now: '2026-09-27T12:00:10.000Z', currentPrice: base.price, evidencePolicy: EVIDENCE_POLICY_V0_1 };
  assert.equal(recheckBeforeSigning({ ...common, consent: { ...consent, acknowledgement: { required: r.acknowledgement!.digest, given: null } } }).status, 'NEW_CONSENT_REQUIRED');
  assert.equal(recheckBeforeSigning({ ...common, consent: { ...consent, acknowledgement: { required: r.acknowledgement!.digest, given: 'ff'.repeat(32) } } }).status, 'NEW_CONSENT_REQUIRED');
  const ok = recheckBeforeSigning({ ...common, consent: { ...consent, acknowledgement: { required: r.acknowledgement!.digest, given: r.acknowledgement!.digest } } });
  assert.match(ok.status, /^OK/);
  assert.equal(ok.signingPermitted, false, 'analytical OK never permits signing in V0');
});

test('QF-POL-02: INSUFFICIENT newer price, changed route, failed exit, authority change and freeze all fail closed within TTL', () => {
  const record = proposeMigrationThreshold(base).record!;
  const consent = { digest: economicsDigest({ threshold: record }) };
  const common = { record, consent, now: '2026-09-27T12:00:30.000Z', currentPrice: base.price, evidencePolicy: EVIDENCE_POLICY_V0_1 };
  assert.equal(recheckBeforeSigning({ ...common, currentPrice: { ...base.price, status: 'INSUFFICIENT', observedAt: '2026-09-27T12:00:25.000Z' } }).status, 'REPRICE_REQUIRED');
  for (const adverse of [{ routeChanged: true }, { exitDepthDecision: 'FAIL' as const }, { exitDepthDecision: 'WARN' as const }, { mintOrFreezeAuthorityChanged: true }, { assetRevokedOrFrozen: true }]) {
    assert.equal(recheckBeforeSigning({ ...common, adverse }).status, 'NEW_CONSENT_REQUIRED', JSON.stringify(adverse));
  }
  // an OLDER adverse observation does not override newer good evidence
  assert.match(recheckBeforeSigning({ ...common, currentPrice: { ...base.price, status: 'DISAGREEMENT', observedAt: '2026-09-27T11:58:00.000Z' } }).status, /^OK/);
});

test('EV-1: malformed or future-dated current evidence fails closed', () => {
  const record = proposeMigrationThreshold(base).record!;
  const consent = { digest: economicsDigest({ threshold: record }) };
  const common = { record, consent, now: '2026-09-27T12:00:30.000Z', evidencePolicy: EVIDENCE_POLICY_V0_1 };
  assert.equal(recheckBeforeSigning({ ...common, currentPrice: { ...base.price, observedAt: 'soon' } }).status, 'REPRICE_REQUIRED');
  assert.equal(recheckBeforeSigning({ ...common, currentPrice: { ...base.price, observedAt: '2026-09-27T12:00:40.000Z' } }).status, 'REPRICE_REQUIRED');
  assert.equal(proposeMigrationThreshold({ ...base, price: { ...base.price, observedAt: 'not-a-time' } }).status, 'REJECTED');
  assert.equal(proposeMigrationThreshold({ ...base, liquidity: { ...base.liquidity, decision: 'MAYBE' as never } }).status, 'REJECTED');
});

test('EV-1: execution freshness is undefined, so nothing is signable on analytical TTLs', () => {
  assert.equal(EXECUTION_FRESHNESS_POLICY.status, 'UNDEFINED');
  assert.equal(EXECUTION_FRESHNESS_POLICY.signingPermitted, false);
});
