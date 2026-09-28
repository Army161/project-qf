// Regression tests for QF-VAL-01/02/03 (independent review 2026-09-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExitDepth } from '../src/exitDepth.ts';
import { aggregate } from '../src/aggregate.ts';
import * as registry from '../src/registry.ts';
import { VALIDATOR_POLICY_V0_1, EVIDENCE_POLICY_V0_1 } from '../src/policy.ts';

const QUSD = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

test('QF-VAL-01: an empty required-exit list never passes S3.1', () => {
  const r = checkExitDepth({ quoteMint: QUSD, now: '2026-09-27T12:00:00.000Z', mode: 'LIVE', notionalRaw: 5_000_000_000n, exitMints: [], routes: [],
    policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 });
  assert.equal(r.decision, 'FAIL');
});

// The red run targeted promoteToProductionRegistry, which returned a PRODUCTION record here. It was renamed to the
// TEST_ONLY guard assertNotTestOnlyAsset (which produces no record) and admission moved to admitToProductionRegistry.
test('QF-VAL-02: an asserted issuer class with an invalid mint and no evidence is not admitted to production', () => {
  assert.equal('promoteToProductionRegistry' in registry, false, 'no function turns an assertion into a PRODUCTION record');
  const r = registry.admitToProductionRegistry({ id: 'usdc', chain: 'solana', mint: 'not-a-mint', symbol: 'USDC', decimals: 6, evidence: [],
    assertedIssuerClass: 'ISSUER_VERIFIED' } as never);
  assert.equal(r.ok, false);
  if (!r.ok) for (const code of ['INVALID_MINT', 'PROVENANCE_MISSING', 'ONCHAIN_MINT_READ_MISSING', 'APPROVAL_MISSING', 'EVIDENCE_EMPTY']) assert.ok(r.violations.includes(code), code);
});

test('QF-VAL-03: an unknown runtime validation mode cannot bypass the required LIVE checks', () => {
  const pass = { id: 'S3.2', decision: 'PASS' as const, reason: 'x', evidence: [], details: {}, policyVersion: 'validator-v0.1' };
  let decision: string;
  try { decision = aggregate([pass], 'live' as never).decision; } catch { decision = 'REJECTED'; }
  assert.notEqual(decision, 'PASS');
});
