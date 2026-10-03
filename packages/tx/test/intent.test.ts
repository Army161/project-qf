import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIntent, type TxIntent } from '../src/intent.ts';

const NOW = '2026-09-27T12:00:00.000Z';
const USER = 'Vote111111111111111111111111111111111111111';
const base: TxIntent = {
  intentId: 'mock-1', kind: 'CREATE_POOL', cluster: 'mock-offline', mock: true,
  signer: { role: 'USER_WALLET', address: USER, serverHeld: false }, feePayer: USER,
  templateUsage: 'V0_TEST_BASELINE', economicsDigest: 'ab'.repeat(32), consentDigest: 'ab'.repeat(32),
  createdAt: '2026-09-27T11:59:00.000Z', expiresAt: '2026-09-27T12:05:00.000Z', amounts: {},
};
const ctx = { now: NOW, approvedEconomicsDigest: 'ab'.repeat(32) };
const v = (patch: Partial<TxIntent>) => validateIntent({ ...base, ...patch }, ctx);

test('a well-formed MOCK intent validates only on the mock-offline cluster', () => {
  assert.deepEqual(v({}).violations, []);
  assert.equal(v({}).ok, true);
  assert.equal(v({}).mock, true);
});

test('real clusters are gated by readiness stages and MAINNET_WRITES=false', () => {
  assert.match(v({ cluster: 'mainnet-beta', mock: false }).violations.join(), /MAINNET_WRITES/);
  // DEVNET_INTEGRATION is ACTIVE since 2026-10-03: a devnet intent is no longer refused for its stage
  assert.doesNotMatch(v({ cluster: 'devnet', mock: false }).violations.join(), /DEVNET_INTEGRATION/);
  assert.match(v({ cluster: 'localnet', mock: false }).violations.join(), /LOCALNET_INTEGRATION.*BLOCKED/);
  assert.match(v({ cluster: 'devnet', mock: true }).violations.join(), /MOCK_INTENT_ON_REAL_CLUSTER/);
  assert.match(v({ mock: false }).violations.join(), /mock-offline.*requires mock/);
});

test('transfer-fee and transfer-hook config intents are refused (DBC_BASE_TRANSFER_FEE disabled)', () => {
  assert.match(v({ kind: 'CREATE_CONFIG_TRANSFER_FEE', signer: { role: 'CONFIG_OWNER', address: USER, serverHeld: false } }).violations.join(), /DBC_BASE_TRANSFER_FEE/);
  assert.match(v({ kind: 'CREATE_CONFIG_TRANSFER_HOOK', signer: { role: 'CONFIG_OWNER', address: USER, serverHeld: false } }).violations.join(), /NOT_IN_V1_SCOPE/);
});

test('the server never signs for a user; roles must match the intent kind', () => {
  assert.match(v({ signer: { role: 'USER_WALLET', address: USER, serverHeld: true } }).violations.join(), /SERVER_NEVER_SIGNS_FOR_USER/);
  assert.match(v({ signer: { role: 'MIGRATION_CRANK', address: USER, serverHeld: true } }).violations.join(), /ROLE_MISMATCH/);
  assert.deepEqual(validateIntent({ ...base, kind: 'MIGRATE_DAMM_V2', signer: { role: 'MIGRATION_CRANK', address: USER, serverHeld: true },
    economicsDigest: undefined, consentDigest: undefined }, ctx).violations, []);
  assert.match(v({ kind: 'CREATE_CONFIG', signer: { role: 'CONFIG_OWNER', address: USER, serverHeld: true } }).violations.join(), /MULTISIG_ROLE_SERVER_HELD/);
});

test('simulation-only templates, consent mismatch and stale or expired intents are refused', () => {
  assert.match(v({ templateUsage: 'SIMULATION_ONLY' }).violations.join(), /SIMULATION_ONLY/);
  assert.match(v({ consentDigest: 'cd'.repeat(32) }).violations.join(), /CONSENT_MISMATCH/);
  assert.match(v({ economicsDigest: 'cd'.repeat(32), consentDigest: 'cd'.repeat(32) }).violations.join(), /ECONOMICS_NOT_APPROVED/);
  assert.match(v({ consentDigest: undefined }).violations.join(), /CONSENT_MISSING/);
  assert.match(v({ expiresAt: '2026-09-27T11:59:59.000Z' }).violations.join(), /EXPIRED/);
  assert.match(v({ createdAt: '2026-09-27T12:01:00.000Z' }).violations.join(), /FUTURE/);
});

test('amounts must be positive raw u64 integer strings; addresses must be valid', () => {
  assert.match(v({ amounts: { amountIn: '1.5' } }).violations.join(), /AMOUNT/);
  assert.match(v({ amounts: { amountIn: '0' } }).violations.join(), /AMOUNT/);
  assert.match(v({ amounts: { amountIn: (2n ** 64n).toString() } }).violations.join(), /AMOUNT/);
  assert.deepEqual(v({ amounts: { amountIn: '18446744073709551615' } }).violations, []);
  assert.match(v({ feePayer: 'not-base58-0OIl' }).violations.join(), /FEE_PAYER/);
});
