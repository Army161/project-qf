// Regression tests for the repair-decision review (2026-09-27): CFG-TYPE and BODY-LIMIT.
// Each test expects the secure result. All RPC is FAKE_RPC or an in-memory stream; nothing touches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import * as lib from '../lib.mjs';
// Namespace import so each test fails on its own against a verifier that lacks the new exports (red run).
const { verifyCluster, exitCodeFor, createJsonRpc, fetchOsecStatus } = lib;
import { fakeCluster, noOsec, check, CUSTOMIZABLE, configBytes } from './support/fake-cluster.mjs';

const run = async (opts = {}) => verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(opts), osec: noOsec });
const withConfig = (bytes, label = CUSTOMIZABLE) => ({ mutate: (s) => { s.accounts.get(label).data = bytes; } });

test('CFG-TYPE: the Customizable route with a Dynamic (1) config and the DBC pool authority passes compatibility', async () => {
  const r = await run();
  const c = check(r, 'CONFIG_COMPATIBILITY', 'Customizable');
  assert.equal(c.status, 'PASS');
  assert.equal(c.value.route, 'Customizable');
  assert.equal(c.value.config_type, 1);
  assert.equal(c.value.evidence.authorityRule, 'CONFIRMED_FOR_PINNED_SOURCE');
  assert.equal(c.value.evidence.pdaDerivation, 'CONFIRMED_OFFLINE');
  assert.doesNotMatch(c.note, /ASSUMPTION/);
});

for (const [configType, why] of [[0, 'Static on a dynamic route'], [255, 'unknown enum']]) {
  test(`CFG-TYPE: a full 328-byte Customizable config with config_type ${configType} (${why}) fails`, async () => {
    const r = await run(withConfig(configBytes({ configType })));
    assert.equal(check(r, 'CONFIG', 'Customizable').status, 'PASS', 'the layout itself still decodes');
    const c = check(r, 'CONFIG_COMPATIBILITY', 'Customizable');
    assert.equal(c.status, 'FAIL');
    assert.match(c.note, /config_type/);
    assert.equal(exitCodeFor([r]), 3);
  });
}

test('CFG-TYPE: the right type with the wrong creator authority still fails', async () => {
  const r = await run(withConfig(configBytes({ poolCreatorAuthority: '11111111111111111111111111111111' })));
  assert.equal(check(r, 'CONFIG_COMPATIBILITY', 'Customizable').status, 'FAIL');
});

test('CFG-TYPE: correct bytes under the wrong owner fail CONFIG and never reach compatibility PASS', async () => {
  const r = await run({ mutate: (s) => { s.accounts.get(CUSTOMIZABLE).owner = '11111111111111111111111111111111'; } });
  assert.equal(check(r, 'CONFIG', 'Customizable').status, 'FAIL');
  assert.notEqual(check(r, 'CONFIG_COMPATIBILITY', 'Customizable').status, 'PASS');
});

test('CFG-TYPE: fixed-fee routes are explicitly NOT_ASSESSED in V0, not silently accepted', async () => {
  const r = await run();
  for (const label of ['FixedBps25', 'FixedBps30', 'FixedBps100', 'FixedBps200', 'FixedBps400', 'FixedBps600']) {
    const c = check(r, 'CONFIG_COMPATIBILITY', label);
    assert.equal(c.status, 'NOT_ASSESSED', label);
    assert.equal(c.required, false);
  }
  assert.equal(exitCodeFor([r]), 0, 'a complete, correct offline fixture still exits 0');
});

// --- BODY-LIMIT ---------------------------------------------------------------------------------------------
/** A response whose body is produced lazily; records how many chunks were pulled and whether it was cancelled. */
function lazyBody({ chunks = 128, chunkBytes = 256, fill = 32, headers = {}, delayMs = 0, status = 200 } = {}) {
  const s = { produced: 0, cancelled: false };
  const body = new ReadableStream({
    async pull(c) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (s.produced === chunks) { c.close(); return; }
      s.produced++; c.enqueue(new Uint8Array(chunkBytes).fill(fill));
    },
    cancel() { s.cancelled = true; },
  }, { highWaterMark: 0 });
  return { s, response: new Response(body, { status, headers }) };
}

test('BODY-LIMIT: an oversized RPC body is refused while streaming, cancelled, and never fully read', async () => {
  const { s, response } = lazyBody();
  const rpc = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => response, limits: { getGenesisHash: 1024 } });
  await assert.rejects(rpc.getGenesisHash(), /RPC_RESPONSE_TOO_LARGE/);
  assert.ok(s.produced * 256 <= 1024 + 256, `read ${s.produced * 256} bytes against a 1024-byte cap`);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: a false small Content-Length header cannot bypass the cap', async () => {
  const { s, response } = lazyBody({ headers: { 'content-length': '10' } });
  const rpc = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => response, limits: { getGenesisHash: 1024 } });
  await assert.rejects(rpc.getGenesisHash(), /RPC_RESPONSE_TOO_LARGE/);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: a declared oversize Content-Length is refused before reading and the body is cancelled', async () => {
  const { s, response } = lazyBody({ headers: { 'content-length': String(10 * 1024 * 1024) } });
  const rpc = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => response, limits: { getGenesisHash: 1024 } });
  await assert.rejects(rpc.getGenesisHash(), /RPC_RESPONSE_TOO_LARGE declared/);
  assert.equal(s.produced, 0);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: exactly at the cap is accepted; one byte over is refused (chunk boundaries)', async () => {
  const exact = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(100) });
  const ok = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => new Response(exact), limits: { getGenesisHash: exact.length } });
  assert.equal(await ok.getGenesisHash(), 'x'.repeat(100));
  const over = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => new Response(exact), limits: { getGenesisHash: exact.length - 1 } });
  await assert.rejects(over.getGenesisHash(), /RPC_RESPONSE_TOO_LARGE/);
});

test('BODY-LIMIT: the deadline covers body consumption, not just headers; the stalled body is cancelled', async () => {
  const { s, response } = lazyBody({ chunks: 1000, chunkBytes: 1, delayMs: 20 });
  const rpc = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => response, timeoutMs: 100, limits: { getGenesisHash: 1 << 20 } });
  const t0 = Date.now();
  await assert.rejects(rpc.getGenesisHash(), /RPC_RESPONSE_TIMEOUT|aborted|timeout/i);
  assert.ok(Date.now() - t0 < 2000, 'rejected promptly');
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: an oversized error body is bounded too', async () => {
  const { s, response } = lazyBody({ status: 500 });
  const rpc = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => response, limits: { getGenesisHash: 1024 } });
  await assert.rejects(rpc.getGenesisHash(), /RPC_RESPONSE_TOO_LARGE/);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: per-operation limits let a legitimate large ProgramData read through while small reads stay small', () => {
  assert.ok(lib.RESPONSE_LIMITS.getAccountInfoLarge >= Math.ceil(10 * 1024 * 1024 * 4 / 3), 'a maximum-size (10 MiB) account in base64 fits');
  assert.ok(lib.RESPONSE_LIMITS.getAccountInfoSmall <= 64 * 1024);
  assert.ok(lib.RESPONSE_LIMITS.getGenesisHash <= 64 * 1024);
  assert.ok(lib.RESPONSE_LIMITS.osecStatus <= 256 * 1024);
});

test('BODY-LIMIT: account reads declare which size class they need; a small read of a large account is refused', async () => {
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 9 }, value: { owner: '11111111111111111111111111111111', executable: false, data: [Buffer.alloc(200_000).toString('base64'), 'base64'] } } });
  const rpc = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => new Response(big) });
  await assert.rejects(rpc.getAccountInfoWithContext('11111111111111111111111111111111'), /RPC_RESPONSE_TOO_LARGE/);
  const r = await rpc.getAccountInfoWithContext('11111111111111111111111111111111', { size: 'large' });
  assert.equal(r.value.data.length, 200_000);
});

test('BODY-LIMIT: decoded account bytes are bounded separately from the encoded body', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 9 }, value: { owner: '11111111111111111111111111111111', executable: false, data: [Buffer.alloc(3000).toString('base64'), 'base64'] } } });
  const rpc = createJsonRpc('https://rpc.invalid', { fetchImpl: async () => new Response(body), limits: { accountBytesSmall: 1024 } });
  await assert.rejects(rpc.getAccountInfoWithContext('11111111111111111111111111111111'), /ACCOUNT_DATA_TOO_LARGE/);
});

test('BODY-LIMIT: the compressed IDL is inflated with a separate decompressed-output cap', () => {
  const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024, 32));
  assert.ok(bomb.length < 100_000, 'small compressed input');
  assert.throws(() => lib.inflateIdlBounded(bomb, { maxOutputBytes: 1024 * 1024 }), /IDL_TOO_LARGE|RangeError|maxOutputLength|buffer/i);
  assert.equal(lib.inflateIdlBounded(deflateSync(Buffer.from('{"a":1}')), { maxOutputBytes: 1024 }).toString(), '{"a":1}');
});

test('BODY-LIMIT: the OtterSec status body is bounded and an oversize body becomes an error value, not a throw', async () => {
  const { s, response } = lazyBody({ chunks: 4096, chunkBytes: 256 });
  const r = await fetchOsecStatus('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', { fetchImpl: async () => response });
  assert.match(r.error, /RESPONSE_TOO_LARGE/);
  assert.equal(s.cancelled, true);
});
