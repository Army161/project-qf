// Unit tests for terms validation and consent binding (QF-SEC-01 support code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTerms, verifyConsentBinding, termsDigest, TX_BINDING_POLICY_VERSION, type ApprovedTerms } from '../src/terms.ts';

const A = 'A7U7bbWZH4d1gxhLoWq5aku74mSMKsU1BJZjRmhYayB9';
const WSOL = 'So11111111111111111111111111111111111111112', MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const swap = (p: Partial<Record<string, unknown>> = {}) => ({ kind: 'QF_SWAP', cluster: 'mock-offline', policyVersion: TX_BINDING_POLICY_VERSION, feePayer: A,
  compute: { maxUnitLimit: 200_000, maxUnitPriceMicroLamports: '1000' }, user: A, baseMint: MINT, quoteMint: WSOL,
  direction: 'QUOTE_TO_BASE', amountIn: '10', minimumAmountOut: '1', ...p }) as unknown as ApprovedTerms;

test('terms: valid swap terms pass runtime validation', () => { assert.deepEqual(validateTerms(swap()), []); });
test('terms: unknown kind, cluster, policy version and bad addresses are rejected', () => {
  assert.match(validateTerms(swap({ kind: 'TRANSFER' })).join(), /TERMS_UNSUPPORTED_KIND/);
  assert.match(validateTerms(swap({ kind: 'SWAP' })).join(), /TERMS_UNSUPPORTED_KIND SWAP/, 'the old Meteora kinds are gone');
  assert.match(validateTerms(swap({ cluster: 'testnet' })).join(), /TERMS_BAD_CLUSTER/);
  assert.match(validateTerms(swap({ policyVersion: 'x' })).join(), /TERMS_POLICY_VERSION/);
  assert.match(validateTerms(swap({ user: 'not-an-address' })).join(), /TERMS_BAD_ADDRESS user/);
  assert.match(validateTerms(swap({ direction: 'SIDEWAYS' })).join(), /TERMS_BAD_DIRECTION/);
  assert.deepEqual(validateTerms(null), ['TERMS_MISSING']);
});
test('terms: nonpositive, non-integer and out-of-range amounts are rejected', () => {
  assert.match(validateTerms(swap({ amountIn: '0' })).join(), /TERMS_NONPOSITIVE_AMOUNT amountIn/);
  assert.match(validateTerms(swap({ amountIn: '1.5' })).join(), /TERMS_BAD_AMOUNT amountIn/);
  assert.match(validateTerms(swap({ amountIn: '-1' })).join(), /TERMS_BAD_AMOUNT amountIn/);
  assert.match(validateTerms(swap({ amountIn: (2n ** 64n).toString() })).join(), /TERMS_BAD_AMOUNT amountIn/);
  assert.match(validateTerms(swap({ amountIn: '007' })).join(), /TERMS_BAD_AMOUNT amountIn/);
});
test('terms: compute caps are bounded', () => {
  assert.match(validateTerms(swap({ compute: { maxUnitLimit: 2_000_000, maxUnitPriceMicroLamports: '1' } })).join(), /TERMS_BAD_COMPUTE_LIMIT/);
  assert.match(validateTerms(swap({ compute: { maxUnitLimit: 1, maxUnitPriceMicroLamports: '99999999999' } })).join(), /TERMS_BAD_COMPUTE_PRICE/);
});

test('consent: bound to exact terms, cluster, policy and evidence; blockhash is not part of terms', async () => {
  const t = swap();
  const c = { termsDigest: await termsDigest(t), cluster: 'mock-offline' as const, policyVersion: TX_BINDING_POLICY_VERSION, evidenceDigest: 'cd'.repeat(32), acknowledgementDigest: null, approvedAt: '2026-09-27T12:00:00.000Z' };
  assert.deepEqual(await verifyConsentBinding(t, c), []);
  assert.match((await verifyConsentBinding(swap({ minimumAmountOut: '0' }), c)).join(), /CONSENT_TERMS_MISMATCH/);
  assert.match((await verifyConsentBinding(t, { ...c, cluster: 'devnet' })).join(), /CONSENT_CLUSTER_MISMATCH/);
  assert.match((await verifyConsentBinding(t, { ...c, policyVersion: 'old' })).join(), /CONSENT_POLICY_MISMATCH/);
  assert.match((await verifyConsentBinding(t, { ...c, evidenceDigest: '' })).join(), /CONSENT_EVIDENCE_NOT_BOUND/);
  assert.deepEqual(await verifyConsentBinding(t, undefined), ['CONSENT_MISSING']);
  assert.ok(!JSON.stringify(t).includes('blockhash'), 'terms carry no blockhash, so a refreshed blockhash keeps consent valid');
});
