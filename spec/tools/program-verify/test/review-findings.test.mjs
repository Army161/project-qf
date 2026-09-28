// Regression tests for the independent review findings QF-SEC-02/03/04 (2026-09-27).
// Each test expects the secure result. All RPC is FAKE_RPC; nothing touches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS, verifyCluster, exitCodeFor, summarize, redactUrl, sanitizeError } from '../lib.mjs';
import { fakeCluster, noOsec, check, DBC, CUSTOMIZABLE, CONFIG_DISC, configBytes } from './support/fake-cluster.mjs';

const run = async (opts = {}, extra = {}) => verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(opts), osec: noOsec, ...extra });

test('QF-SEC-02: an owner plus 8-byte discriminator only is not a valid Config', async () => {
  const r = await run({ mutate: (s) => { s.accounts.get(CUSTOMIZABLE).data = Buffer.from(CONFIG_DISC); } });
  assert.notEqual(check(r, 'CONFIG', 'Customizable').status, 'PASS');
  assert.notEqual(exitCodeFor([r]), 0);
});

test('QF-SEC-02: a truncated Config (disc + 100 bytes) fails', async () => {
  const r = await run({ mutate: (s) => { s.accounts.get(CUSTOMIZABLE).data = Buffer.concat([CONFIG_DISC, Buffer.alloc(100)]); } });
  assert.equal(check(r, 'CONFIG', 'Customizable').status, 'FAIL');
});

test('QF-SEC-02: an over-long Config with trailing bytes fails', async () => {
  const r = await run({ mutate: (s) => { s.accounts.get(CUSTOMIZABLE).data = Buffer.concat([configBytes(), Buffer.alloc(8)]); } });
  assert.equal(check(r, 'CONFIG', 'Customizable').status, 'FAIL');
});

test('QF-SEC-02: a full-length Config that is incompatible with DBC migration fails', async () => {
  const r = await run({ mutate: (s) => { s.accounts.get(CUSTOMIZABLE).data = configBytes({ poolCreatorAuthority: '11111111111111111111111111111111' }); } });
  assert.equal(check(r, 'CONFIG_COMPATIBILITY', 'Customizable')?.status, 'FAIL');
  assert.notEqual(exitCodeFor([r]), 0);
});

test('QF-SEC-03: credentials in the URL path, userinfo, query and fragment are redacted', () => {
  const out = redactUrl('https://user:FAKE_PASS@rpc.example/v2/FAKE_PATH_TOKEN?api-key=FAKE_QUERY_TOKEN#FAKE_FRAGMENT');
  for (const canary of ['FAKE_PATH_TOKEN', 'FAKE_QUERY_TOKEN', 'FAKE_PASS', 'FAKE_FRAGMENT', 'user']) assert.ok(!out.includes(canary), `${canary} leaked: ${out}`);
});

test('QF-SEC-03: nested causes and AggregateError members are redacted', () => {
  const inner = new Error('connect ECONNREFUSED https://rpc.example/FAKE_NESTED_TOKEN');
  const agg = new AggregateError([new Error('tls https://rpc2.example/FAKE_AGG_TOKEN')], 'all failed');
  const e = new Error('fetch failed', { cause: new Error('outer', { cause: inner }) });
  const s = sanitizeError(e) + sanitizeError(agg) + sanitizeError(new Error('wrap', { cause: agg }));
  for (const canary of ['FAKE_NESTED_TOKEN', 'FAKE_AGG_TOKEN']) assert.ok(!s.includes(canary), `${canary} leaked: ${s}`);
  // nested diagnostics are kept (redacted), not silently dropped
  assert.match(s, /ECONNREFUSED/);
  assert.match(s, /tls https:\/\/rpc2\.example/);
});

test('QF-SEC-03: the report endpoint never carries the path token', async () => {
  const r = await run({}, { endpoint: 'https://rpc.example/v2/FAKE_PATH_TOKEN' });
  assert.ok(!JSON.stringify(r).includes('FAKE_PATH_TOKEN'));
});

test('QF-SEC-04a: a report with only CONNECTIVITY and CLUSTER_IDENTITY PASS does not exit 0', () => {
  const r = { cluster: 'mainnet-beta', checks: [
    { id: 'CONNECTIVITY', subject: 'mainnet-beta', status: 'PASS', required: true },
    { id: 'CLUSTER_IDENTITY', subject: 'mainnet-beta', status: 'PASS', required: true } ] };
  assert.notEqual(exitCodeFor([r]), 0);
});

test('QF-SEC-04a: dropping one required check from a satisfied report does not exit 0', async () => {
  const r = await run();
  r.checks = r.checks.filter((c) => !(c.id === 'PROGRAMDATA' && c.subject === DBC));
  assert.notEqual(exitCodeFor([r]), 0);
});

test('QF-SEC-04a: a duplicated required check does not exit 0', async () => {
  const r = await run();
  r.checks.push({ ...check(r, 'CLUSTER_IDENTITY') });
  assert.notEqual(exitCodeFor([r]), 0);
});

test('QF-SEC-04b: an explicit second-provider disagreement does not exit 0', async () => {
  const rpc2 = await fakeCluster({ mutate: (s) => { const d = s.accounts.get(s.programDataAddr[DBC]).data; d[45] ^= 0xff; } });
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(), rpc2, osec: noOsec });
  assert.equal(exitCodeFor([r]), 3);
});

test('QF-SEC-04b: an unreachable second provider is UNAVAILABLE (exit 2), not agreement or disagreement', async () => {
  const rpc2 = await fakeCluster({ mutate: (s) => { s.failWith = new Error('503'); } });
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(), rpc2, osec: noOsec });
  const cc = r.checks.filter((c) => c.id === 'CROSS_CHECK');
  assert.ok(cc.length > 0 && cc.every((c) => c.status === 'UNAVAILABLE'));
  assert.equal(exitCodeFor([r]), 2);
});

test('QF-SEC-04: an invalid upgrade-authority option tag is FAIL, never immutable', async () => {
  const r = await run({ mutate: (s) => { s.accounts.get(s.programDataAddr[DBC]).data[12] = 7; } });
  assert.equal(check(r, 'UPGRADE_AUTHORITY', DBC).status, 'FAIL');
  assert.notEqual(exitCodeFor([r]), 0);
});

test('QF-SEC-04: a Program account with trailing bytes is not accepted', async () => {
  const r = await run({ mutate: (s) => { s.accounts.get(DBC).data = Buffer.concat([s.accounts.get(DBC).data, Buffer.alloc(4)]); } });
  assert.notEqual(check(r, 'PROGRAMDATA', DBC).status, 'PASS');
});

test('QF-SEC-04: a recoverable RPC error on one account is a per-check ERROR, not a thrown run', async () => {
  const r = await run({ mutate: (s) => { s.failAccount.set(DBC, new Error('429 Too Many Requests')); } });
  assert.equal(check(r, 'PROGRAM_PRESENCE', DBC).status, 'ERROR');
  assert.equal(check(r, 'CONFIG', 'Customizable').status, 'PASS');
  assert.notEqual(exitCodeFor([r]), 0);
});

test('QF-SEC-04: RPC context slots and commitment are retained on account-derived checks', async () => {
  const r = await run({ slot: 412_345_678 });
  for (const [id, s] of [['PROGRAM_PRESENCE', DBC], ['PROGRAMDATA', DBC], ['CONFIG', 'Customizable']]) {
    const c = check(r, id, s);
    assert.equal(c.contextSlot, 412_345_678, `${id} contextSlot`);
    assert.equal(c.commitment, 'finalized', `${id} commitment`);
  }
});

test('QF-SEC-04: the report carries a schema version', async () => {
  const r = await run();
  assert.equal(typeof r.schemaVersion, 'string');
  assert.ok(summarize([r]).inventory, 'summary exposes the expected-inventory comparison');
  void GENESIS;
});
