// Unit tests for terms validation, consent binding and the strict Borsh decoder (QF-SEC-01 support code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTerms, verifyConsentBinding, termsDigest, TX_BINDING_POLICY_VERSION, type ApprovedTerms } from '../src/terms.ts';
import { decodeExact, normalizeToIdl, BorshError } from '../src/engine/borsh.ts';
import { DBC_IDL_SUBSET } from '../src/engine/dbc-idl-subset.ts';
import { PROGRAM_IDS } from '../src/programs.ts';

const A = 'A7U7bbWZH4d1gxhLoWq5aku74mSMKsU1BJZjRmhYayB9', B = 'HGSwtfZGJLihREYFLrh8Rp4DAH2kToktFXpxJo9vWcKM';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const swap = (p: Partial<Record<string, unknown>> = {}) => ({ kind: 'SWAP', cluster: 'mock-offline', policyVersion: TX_BINDING_POLICY_VERSION, feePayer: A,
  compute: { maxUnitLimit: 200_000, maxUnitPriceMicroLamports: '1000' }, config: B, pool: B, user: A, baseMint: MINT, quoteMint: USDC,
  baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN, direction: 'QUOTE_TO_BASE', amountIn: '10', minimumAmountOut: '1',
  referralTokenAccount: null, allowSysvarInstructions: false, ...p }) as unknown as ApprovedTerms;

test('terms: valid V0 swap terms pass runtime validation', () => { assert.deepEqual(validateTerms(swap()), []); });
test('terms: unknown kind, cluster, policy version and bad addresses are rejected', () => {
  assert.match(validateTerms(swap({ kind: 'TRANSFER' })).join(), /TERMS_UNSUPPORTED_KIND/);
  assert.match(validateTerms(swap({ cluster: 'testnet' })).join(), /TERMS_BAD_CLUSTER/);
  assert.match(validateTerms(swap({ policyVersion: 'x' })).join(), /TERMS_POLICY_VERSION/);
  assert.match(validateTerms(swap({ user: 'not-an-address' })).join(), /TERMS_BAD_ADDRESS user/);
  assert.match(validateTerms(swap({ referralTokenAccount: 'zzz' })).join(), /TERMS_BAD_ADDRESS referralTokenAccount/);
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
test('terms: V0 fails closed on native SOL and Token-2022 flows', () => {
  assert.match(validateTerms(swap({ quoteMint: 'So11111111111111111111111111111111111111112' })).join(), /TERMS_UNSUPPORTED_V0 native SOL/);
  assert.match(validateTerms(swap({ baseTokenProgram: PROGRAM_IDS.TOKEN_2022 })).join(), /TERMS_UNSUPPORTED_V0 baseTokenProgram/);
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

const SWAP_ARGS = DBC_IDL_SUBSET.instructions.find((i) => i.name === 'swap')!.args;
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
test('borsh: exact decode of swap parameters; short and trailing bytes fail', () => {
  const ok = new Uint8Array([...u64(5n), ...u64(7n)]);
  assert.deepEqual(decodeExact(ok, SWAP_ARGS, DBC_IDL_SUBSET.types), { params: { amount_in: 5n, minimum_amount_out: 7n } });
  assert.throws(() => decodeExact(ok.subarray(0, 15), SWAP_ARGS, DBC_IDL_SUBSET.types), BorshError);
  assert.throws(() => decodeExact(new Uint8Array([...ok, 0]), SWAP_ARGS, DBC_IDL_SUBSET.types), /trailing/);
});
test('borsh: bool and option tags other than 0/1, invalid UTF-8 and oversized strings fail', () => {
  const types = { S: { kind: 'struct' as const, fields: [{ name: 'b', type: 'bool' }] }, O: { kind: 'struct' as const, fields: [{ name: 'o', type: { option: 'u8' } }] } };
  assert.throws(() => decodeExact(new Uint8Array([2]), [{ name: 'x', type: { defined: { name: 'S' } } }], types), /bool tag 2/);
  assert.throws(() => decodeExact(new Uint8Array([7, 1]), [{ name: 'x', type: { defined: { name: 'O' } } }], types), /option tag 7/);
  assert.throws(() => decodeExact(new Uint8Array([2, 0, 0, 0, 0xc3, 0x28]), [{ name: 's', type: 'string' }], {}), /utf-8/);
  assert.throws(() => decodeExact(new Uint8Array([0xff, 0xff, 0, 0]), [{ name: 's', type: 'string' }], {}), /exceeds/);
});
test('borsh: normalizeToIdl zero-fills padding only; other short arrays fail', () => {
  const types = { P: { kind: 'struct' as const, fields: [{ name: 'padding', type: { array: ['u8', 2] } }, { name: 'data', type: { array: ['u8', 2] } }] } };
  assert.deepEqual(normalizeToIdl({ padding: [], data: [1, 2] }, { defined: { name: 'P' } }, types as never), { padding: [0, 0], data: [1, 2] });
  assert.throws(() => normalizeToIdl({ padding: [], data: [1] }, { defined: { name: 'P' } }, types as never), /array length/);
});

test('SEC-A condition (bigint-buffer): approved integers are range-checked to their exact IDL width, not assumed u64', () => {
  const T = {} as Record<string, never>;
  const ok: [unknown, string][] = [['255', 'u8'], ['65535', 'u16'], [String(2n ** 64n - 1n), 'u64'], [String(2n ** 128n - 1n), 'u128'], ['-128', 'i8'], [String(-(2n ** 63n)), 'i64']];
  for (const [v, t] of ok) assert.doesNotThrow(() => normalizeToIdl(v, t as never, T), `${v} fits ${t}`);
  const bad: [unknown, string][] = [['256', 'u8'], ['65536', 'u16'], ['-1', 'u64'], [String(2n ** 64n), 'u64'], [String(2n ** 128n), 'u128'], ['-129', 'i8'], [String(2n ** 63n), 'i64'], ['1.5', 'u64'], ['0x10', 'u32'], ['', 'u8']];
  for (const [v, t] of bad) assert.throws(() => normalizeToIdl(v, t as never, T), BorshError, `${JSON.stringify(v)} must not fit ${t}`);
});
