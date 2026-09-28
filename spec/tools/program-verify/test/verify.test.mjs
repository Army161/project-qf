// Negative and contract tests for the read-only verifier. All RPC here is an in-memory fake
// labelled FAKE_RPC; nothing touches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseArgs, GENESIS, DAMM_V2_MIGRATION_CONFIGS, UPGRADEABLE_LOADER, verifyCluster, summarize, sanitizeError,
  redactUrl, createJsonRpc, ALLOWED_RPC_METHODS, exitCodeFor, renderMarkdown,
} from '../lib.mjs';

import { fakeCluster, noOsec, check, DBC } from './support/fake-cluster.mjs';

test('CLI contract: only the original flags are accepted', () => {
  assert.deepEqual(parseArgs(['--mainnet', 'https://a.example', '--devnet', 'https://b.example', '--mainnet2', 'https://c.example', '--out', '/tmp/x']),
    { mainnet: 'https://a.example', devnet: 'https://b.example', mainnet2: 'https://c.example', out: '/tmp/x' });
  assert.throws(() => parseArgs(['--rpc', 'https://x']), /unknown flag --rpc/);
  assert.throws(() => parseArgs(['--mainnet']), /requires a value/);
  assert.throws(() => parseArgs(['--mainnet', '--devnet', 'https://x']), /requires a value/);
  assert.throws(() => parseArgs(['--mainnet', 'http://rpc.example']), /https/);
  assert.doesNotThrow(() => parseArgs(['--devnet', 'http://127.0.0.1:8899']));
  assert.throws(() => parseArgs(['stray']), /unexpected argument/);
});

test('happy path on a consistent fake cluster: required checks pass, status fields are separate', async () => {
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(), osec: noOsec });
  for (const id of ['CONNECTIVITY', 'CLUSTER_IDENTITY']) assert.equal(check(r, id).status, 'PASS', id);
  for (const id of ['PROGRAM_PRESENCE', 'LOADER_STATE', 'PROGRAMDATA']) assert.equal(check(r, id, DBC).status, 'PASS', id);
  assert.equal(check(r, 'UPGRADE_AUTHORITY', DBC).status, 'RECORDED');
  assert.equal(check(r, 'UPGRADE_AUTHORITY', DBC).value, DBC);
  assert.equal(check(r, 'DEPLOY_SLOT', DBC).value, '123456');
  assert.equal(check(r, 'EXECUTABLE_HASH', DBC).status, 'RECORDED');
  assert.match(check(r, 'EXECUTABLE_HASH', DBC).note, /does not identify a release/);
  assert.equal(check(r, 'INTERFACE', DBC).status, 'RECORDED');
  assert.equal(check(r, 'CONFIG', 'Customizable').status, 'PASS');
  assert.equal(check(r, 'SOURCE_BUILD', DBC).status, 'NOT_ATTEMPTED');
  assert.equal(check(r, 'AUDIT_COVERAGE', DBC).status, 'NOT_EVALUATED');
  assert.equal(summarize([r]).requiredFailures.length, 0);
});

test('executable hash trims trailing zero bytes after the 45-byte header (OtterSec convention)', async () => {
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(), osec: noOsec });
  assert.equal(check(r, 'EXECUTABLE_HASH', DBC).value, createHash('sha256').update(`ELF-${DBC}`).digest('hex'));
});

test('wrong genesis: CLUSTER_IDENTITY FAIL and no program data is trusted', async () => {
  const r = await verifyCluster({ cluster: 'devnet', rpc: await fakeCluster({ genesis: GENESIS['mainnet-beta'] }), osec: noOsec });
  assert.equal(check(r, 'CLUSTER_IDENTITY').status, 'FAIL');
  assert.equal(check(r, 'PROGRAM_PRESENCE', DBC).status, 'UNKNOWN');
  assert.ok(summarize([r]).requiredFailures.some((f) => f.id === 'CLUSTER_IDENTITY'));
  assert.equal(exitCodeFor([r]), 3);
});

test('localnet genesis cannot be validated and is reported, not passed', async () => {
  const r = await verifyCluster({ cluster: 'localnet', rpc: await fakeCluster({ genesis: 'AnyLocalGenesis111111111111111111111111111' }), osec: noOsec });
  assert.equal(check(r, 'CLUSTER_IDENTITY').status, 'UNKNOWN');
});

test('missing program: PROGRAM_PRESENCE FAIL, dependent checks UNKNOWN', async () => {
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => s.accounts.delete(DBC) }), osec: noOsec });
  assert.equal(check(r, 'PROGRAM_PRESENCE', DBC).status, 'FAIL');
  for (const id of ['LOADER_STATE', 'PROGRAMDATA', 'UPGRADE_AUTHORITY', 'EXECUTABLE_HASH']) assert.equal(check(r, id, DBC).status, 'UNKNOWN', id);
  assert.equal(exitCodeFor([r]), 3);
});

test('not executable / wrong owner: LOADER_STATE FAIL', async () => {
  const r1 = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => { s.accounts.get(DBC).executable = false; } }), osec: noOsec });
  assert.equal(check(r1, 'LOADER_STATE', DBC).status, 'FAIL');
  const r2 = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => { s.accounts.get(DBC).owner = 'BPFLoader2111111111111111111111111111111111'; } }), osec: noOsec });
  assert.equal(check(r2, 'LOADER_STATE', DBC).status, 'FAIL');
});

test('missing or malformed ProgramData: PROGRAMDATA FAIL, authority UNKNOWN', async () => {
  const r1 = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => s.accounts.delete(s.programDataAddr[DBC]) }), osec: noOsec });
  assert.equal(check(r1, 'PROGRAMDATA', DBC).status, 'FAIL');
  assert.equal(check(r1, 'UPGRADE_AUTHORITY', DBC).status, 'UNKNOWN');
  const r2 = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => { s.accounts.get(s.programDataAddr[DBC]).data = Buffer.from([1, 0, 0, 0]); } }), osec: noOsec });
  assert.equal(check(r2, 'PROGRAMDATA', DBC).status, 'FAIL');
});

test('immutable program (no authority) is recorded as null, not a failure', async () => {
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => { const d = s.accounts.get(s.programDataAddr[DBC]).data; d[12] = 0; } }), osec: noOsec });
  assert.equal(check(r, 'UPGRADE_AUTHORITY', DBC).status, 'RECORDED');
  assert.equal(check(r, 'UPGRADE_AUTHORITY', DBC).value, null);
});

test('config with wrong owner or discriminator: CONFIG FAIL', async () => {
  const addr = DAMM_V2_MIGRATION_CONFIGS.find(([l]) => l === 'Customizable')[1];
  const r1 = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => { s.accounts.get(addr).owner = UPGRADEABLE_LOADER; } }), osec: noOsec });
  assert.equal(check(r1, 'CONFIG', 'Customizable').status, 'FAIL');
  const r2 = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => { s.accounts.get(addr).data[0] = 0; } }), osec: noOsec });
  assert.equal(check(r2, 'CONFIG', 'Customizable').status, 'FAIL');
});

test('OtterSec is_verified=false is recorded as not verified, never as a mismatch', async () => {
  const osec = async () => ({ is_verified: false, on_chain_hash: 'abc', repo_url: '' });
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(), osec });
  const sb = check(r, 'SOURCE_BUILD', DBC);
  assert.equal(sb.status, 'NOT_ATTEMPTED');
  assert.match(sb.osec, /not verified by OtterSec; this is not a demonstrated mismatch/);
});

test('RPC failure: CONNECTIVITY FAIL with a sanitized error, exit code 2', async () => {
  const err = new Error('request to https://user:secret@rpc.example/?api-key=SECRET123 failed, reason: 403 Forbidden');
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster({ mutate: (s) => { s.failWith = err; } }), osec: noOsec });
  const c = check(r, 'CONNECTIVITY');
  assert.equal(c.status, 'FAIL');
  assert.doesNotMatch(c.error, /secret|SECRET123/);
  assert.equal(exitCodeFor([r]), 2);
});

// 0.3.0: the path is redacted too (QF-SEC-03). The 0.2.0 expectation 'https://rpc.example/path?<redacted>' kept the
// path and so defined the deficient behaviour as success; it was replaced.
test('sanitizers remove credentials from URLs and errors', () => {
  assert.equal(redactUrl('https://u:p@rpc.example/path?api-key=abc&x=1'), 'https://rpc.example/<redacted-path>?<redacted>');
  assert.equal(redactUrl('https://rpc.example'), 'https://rpc.example');
  assert.equal(redactUrl('http://127.0.0.1:8899/'), 'http://127.0.0.1:8899');
  assert.doesNotMatch(sanitizeError(new Error('GET https://h/?token=abc Bearer eyJhbGciOi.x.y')), /abc|eyJ/);
});

test('JSON-RPC client refuses every method outside the read-only allowlist', async () => {
  const calls = [];
  const rpc = createJsonRpc('https://rpc.example', { fetchImpl: async (_u, init) => { calls.push(JSON.parse(init.body).method); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'G' }), { status: 200 }); } });
  assert.equal(rpc.endpoint, 'https://rpc.example');
  assert.deepEqual([...ALLOWED_RPC_METHODS].sort(), ['getAccountInfo', 'getGenesisHash', 'getVersion']);
  await rpc.getGenesisHash();
  await assert.rejects(() => rpc.call('sendTransaction', []), /not in the read-only allowlist/);
  await assert.rejects(() => rpc.call('requestAirdrop', []), /not in the read-only allowlist/);
  assert.deepEqual(calls, ['getGenesisHash']);
});

test('static scan: verifier source contains no signing, sending or airdrop capability', () => {
  for (const f of ['lib.mjs', 'verify-programs.mjs']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/ALLOWED_RPC_METHODS[^;]*;/, '');
    for (const bad of [/sendTransaction/, /sendRawTransaction/, /requestAirdrop/, /Keypair/, /signTransaction/, /generateKeyPair/, /createKeyPairSigner/, /secretKey/, /simulateTransaction/, /process\.env/]) {
      assert.doesNotMatch(src, bad, `${f} contains ${bad}`);
    }
  }
});

test('markdown output labels the diagnostic and never claims live PASS when RPC failed', async () => {
  const r = await verifyCluster({ cluster: 'devnet', rpc: await fakeCluster({ mutate: (s) => { s.failWith = new Error('403'); } }), osec: noOsec });
  const md = renderMarkdown({ generatedAt: '2026-09-27T00:00:00.000Z', clusters: [r], summary: summarize([r]), exitCode: exitCodeFor([r]) });
  assert.match(md, /READ-ONLY/);
  assert.match(md, /\| CONNECTIVITY \| devnet \| FAIL \|/);
  assert.doesNotMatch(md, /overall: PASS/i);
});

test('JSON-RPC client keeps the context slot and pins minContextSlot on a consistent re-read', async () => {
  const bodies = [];
  const rpc = createJsonRpc('https://rpc.example/FAKE_PATH_TOKEN', { fetchImpl: async (_u, init) => { bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 42 }, value: { owner: UPGRADEABLE_LOADER, executable: true, data: ['AAAA', 'base64'] } } }), { status: 200 }); } });
  const r = await rpc.getAccountInfoWithContext('11111111111111111111111111111111', { minContextSlot: 40 });
  assert.equal(r.contextSlot, 42);
  assert.equal(bodies[0].params[1].commitment, 'finalized');
  assert.equal(bodies[0].params[1].minContextSlot, 40);
  assert.ok(!rpc.endpoint.includes('FAKE_PATH_TOKEN'));
});

test('pinned DAMM v2 Config layout: provenance, file hash and 320-byte body', async () => {
  const { DAMM_V2_CONFIG_LAYOUT, DAMM_V2_CONFIG_LAYOUT_SHA256, decodeDammV2Config } = await import('../lib.mjs');
  const raw = readFileSync(new URL('../layouts/damm-v2-config-layout.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), DAMM_V2_CONFIG_LAYOUT_SHA256);
  assert.equal(DAMM_V2_CONFIG_LAYOUT.provenance.package, '@meteora-ag/cp-amm-sdk@1.4.10');
  assert.match(DAMM_V2_CONFIG_LAYOUT.provenance.license, /^MIT/);
  const { configBytes } = await import('./support/fake-cluster.mjs');
  const v = decodeDammV2Config(configBytes({ index: 9n }));
  assert.equal(v.index, '9');
  assert.equal(v.pool_creator_authority, 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
});

test('explicit plan: a missing cluster report or a missing cross-check is not success', async () => {
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(), osec: noOsec });
  assert.equal(exitCodeFor([r], [{ cluster: 'mainnet-beta', crossCheck: false }]), 0);
  assert.equal(exitCodeFor([r], [{ cluster: 'mainnet-beta', crossCheck: false }, { cluster: 'devnet', crossCheck: false }]), 3);
  assert.equal(exitCodeFor([r], [{ cluster: 'mainnet-beta', crossCheck: true }]), 3);
});

test('cross-check: an initial difference that resolves on a consistent re-read passes, with the slot recorded', async () => {
  const rpc2 = await fakeCluster();
  let first = true;
  const orig = rpc2.getAccountInfoWithContext.bind(rpc2);
  rpc2.getAccountInfoWithContext = async (a, o) => {
    const x = await orig(a, o);
    if (first && a === rpc2.state.programDataAddr[DBC] && x.value) { first = false; x.value.data[45] ^= 0xff; }
    return x;
  };
  const r = await verifyCluster({ cluster: 'mainnet-beta', rpc: await fakeCluster(), rpc2, osec: noOsec });
  const cc = check(r, 'CROSS_CHECK', DBC);
  assert.equal(cc.status, 'PASS');
  assert.match(cc.note, /re-read at a consistent context slot/);
  assert.equal(exitCodeFor([r]), 0);
});

test('CLI end to end (offline, localhost only): unreachable endpoints exit 2 and never print path tokens', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const out = mkdtempSync(`${tmpdir()}/qf-verify-`);
  const cli = new URL('../verify-programs.mjs', import.meta.url).pathname;
  const res = spawnSync(process.execPath, [cli, '--mainnet', 'http://127.0.0.1:9/FAKE_PATH_TOKEN?api-key=FAKE_Q', '--devnet', 'http://127.0.0.1:9/FAKE_DEV_TOKEN', '--out', out], { encoding: 'utf8' });
  assert.equal(res.status, 2, res.stderr);
  const files = readdirSync(out);
  assert.equal(files.length, 2);
  const all = res.stdout + res.stderr + files.map((f) => readFileSync(`${out}/${f}`, 'utf8')).join('');
  for (const canary of ['FAKE_PATH_TOKEN', 'FAKE_Q', 'FAKE_DEV_TOKEN']) assert.ok(!all.includes(canary), canary);
  const json = JSON.parse(readFileSync(`${out}/${files.find((f) => f.endsWith('.json'))}`, 'utf8'));
  assert.equal(json.schemaVersion, 'qf-program-verify-report/3');
  assert.deepEqual(json.plan, [{ cluster: 'mainnet-beta', crossCheck: false }, { cluster: 'devnet', crossCheck: false }]);
  const bad = spawnSync(process.execPath, [cli, '--rpc-secret-file', 'x'], { encoding: 'utf8' });
  assert.equal(bad.status, 64);
});
