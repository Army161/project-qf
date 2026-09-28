// SEC-A: version-bound assertions for the five advisories against the INSTALLED artifacts (not repository HEAD).
// Each test pins what evidence/sec-a/dispositions.json claims; if an install drifts, these fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createBoundedFetch, jsonNestingDepth } from '../src/index.ts';

const require = createRequire(import.meta.url);
const pkgDir = dirname(new URL(import.meta.url).pathname) + '/..';
/** Directory of `name` as resolved FROM the package that depends on it (the real call path). */
const dirFrom = (fromPkgDir: string, name: string) => {
  let d = dirname(createRequire(join(fromPkgDir, 'x.js')).resolve(name));
  for (;;) { try { if (JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name === name) return d; } catch {} d = dirname(d); }
};
const pj = (d: string) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : [p]; });

const cpAmm = dirFrom(pkgDir, '@meteora-ag/cp-amm-sdk');
const splToken = dirFrom(cpAmm, '@solana/spl-token');
const layoutUtils = dirFrom(splToken, '@solana/buffer-layout-utils');
const bigintBuffer = dirFrom(layoutUtils, 'bigint-buffer');
const anchor = dirFrom(cpAmm, '@coral-xyz/anchor');
const toml = dirFrom(anchor, 'toml');
const web3 = dirFrom(pkgDir, '@solana/web3.js');
const jayson = dirFrom(web3, 'jayson');
const uuid = dirFrom(jayson, 'uuid');
const streamJson = dirFrom(jayson, 'stream-json');
const ws7 = dirFrom(jayson, 'ws');
const ws8 = dirFrom(dirFrom(web3, 'rpc-websockets'), 'ws');

/** Loads the adapter, builds every MOCK fixture transaction through web3.js/SDK code paths, and reports loaded modules. */
function runtimeProbe() {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { createRequire } = await import('node:module');
    const { buildFixtureTx } = await import('./test/support/fixtures.ts');
    const { serializeUnsigned, createQuoteSimulator } = await import('./src/index.ts');
    for (const k of ['CREATE_CONFIG','CREATE_POOL','SWAP','MIGRATE_DAMM_V2','CLAIM_PARTNER_TRADING_FEE','CLAIM_CREATOR_TRADING_FEE']) {
      const b = await buildFixtureTx(k); serializeUnsigned(b.tx, b.feePayer, 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W');
      if (k === 'SWAP') createQuoteSimulator(b.cfgParams);
    }
    const c = Object.keys(createRequire(import.meta.url).cache);
    console.log('QF_PROBE' + JSON.stringify(c.filter((p) => /node_modules\\/(bigint-buffer|bindings|toml|uuid|stream-json|jayson)\\//.test(p) || p.endsWith('.node'))));`],
    { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.split('QF_PROBE')[1]!.trim()) as string[];
}
const probe = runtimeProbe();

test('GHSA-3gc7-fjrx-p6mg bigint-buffer: installed 1.1.5 is the QF-patched build with no native load and no addon', () => {
  assert.equal(pj(bigintBuffer).version, '1.1.5');
  assert.match(bigintBuffer, /bigint-buffer@1\.1\.5_patch_hash=/, 'resolved through the patched store entry');
  const src = readFileSync(join(bigintBuffer, 'dist/node.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]bindings['"]\)/);
  assert.match(src, /Project QF patch \(SEC-A, GHSA-3gc7-fjrx-p6mg\)/);
  assert.deepEqual(walk(bigintBuffer).filter((f) => f.endsWith('.node')), [], 'no compiled addon in the installed package');
  // runtime: the pure-JS module is loaded, the bindings loader never is, and no bigint_buffer addon is loaded
  assert.ok(probe.some((p) => /bigint-buffer@1\.1\.5_patch_hash=.*\/dist\/node\.js$/.test(p)), 'patched module is the one loaded');
  assert.ok(!probe.some((p) => /\/bindings\//.test(p) || /bigint_buffer.*\.node$/.test(p)), JSON.stringify(probe.filter((p) => /bindings|bigint/.test(p))));
});

test('bigint-buffer pure-JS bounds: reads never exceed the buffer; widths are fixed by QF u64 validation', async () => {
  const bb = await import(join(bigintBuffer, 'dist/node.js'));
  assert.equal(bb.toBigIntLE(Buffer.alloc(0)), 0n);
  for (let n = 1; n <= 32; n++) { const b = Buffer.alloc(n, 0xff); assert.equal(bb.toBigIntLE(b), (1n << BigInt(8 * n)) - 1n); }
  const view = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).subarray(0, 2);
  assert.equal(bb.toBigIntLE(view), 0x0201n, 'a subarray is read only within its own bounds');
  assert.deepEqual([...bb.toBufferLE(2n ** 64n - 1n, 8)], Array(8).fill(0xff));
  // Documented pure-JS behaviour: an over-wide value is silently truncated (not a crash). QF therefore validates every
  // amount as a u64 before it reaches SDK code (tx validateTerms/validateIntent: AMOUNT_OUT_OF_RANGE / TERMS_BAD_AMOUNT).
  assert.notEqual(bb.toBigIntLE(bb.toBufferLE(2n ** 64n, 8)), 2n ** 64n);
});

test('GHSA-82x6-q7mm-w9cf / GHSA-v5mp-jgw5-2x6j toml: anchor resolves the scoped 4.2.0 override; API parity and fixes hold', async () => {
  assert.equal(pj(anchor).version, '0.31.1');
  assert.equal(pj(toml).version, '4.2.0');
  assert.equal(pj(toml).license, 'MIT');
  const t = createRequire(join(anchor, 'x.js'))('toml');
  // toml 4.x builds null-prototype tables, so compare plain JSON
  assert.deepEqual(JSON.parse(JSON.stringify(t.parse(Buffer.from('[provider]\ncluster = "localnet"\n')))), { provider: { cluster: 'localnet' } }, 'anchor passes a Buffer (workspace.js)');
  assert.throws(() => t.parse('a = ' + '['.repeat(20000) + ']'.repeat(20000)), (e: Error) => !(e instanceof RangeError) && /depth/i.test(e.message));
  try { t.parse('a.b.y = 1\n[a.b.y.__proto__.__proto__]\npolluted = 1'); } catch { /* rejected is fine */ }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  // anchor only parses a local Anchor.toml when `workspace` is accessed; QF never touches it and ingests no TOML.
  const ws = readFileSync(join(anchor, 'dist/cjs/workspace.js'), 'utf8');
  assert.match(ws, /toml\.parse\(fs\.readFileSync\("Anchor\.toml"\)\)/);
  for (const f of walk(join(pkgDir, 'src'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /\.workspace\b|from ['"]toml['"]|require\(['"]toml['"]\)/, f);
  assert.ok(!probe.some((p) => /toml@3\./.test(p)), 'toml 3.x is never loaded');
});

test('GHSA-w5hq-g745-h8pq uuid 8.3.2: only jayson depends on it and every call site is v4() without a buffer', () => {
  assert.equal(pj(uuid).version, '8.3.2');
  assert.equal(pj(jayson).version, '4.3.0');
  const sites = walk(join(jayson, 'lib')).filter((f) => f.endsWith('.js')).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l) => ({ f, l })))
    .filter(({ l }) => /uuid/.test(l));
  const requires = sites.filter(({ l }) => /require\(['"]uuid['"]\)/.test(l));
  assert.ok(requires.length >= 2);
  for (const { f, l } of requires) assert.match(l, /require\('uuid'\)\.v4;\s*$/, `${f}: ${l}`);
  for (const { f, l } of sites.filter(({ l }) => /uuid\(/.test(l))) assert.match(l, /uuid\(\)/, `${f}: v4 called with no buf/offset: ${l}`);
  assert.ok(!sites.some(({ l }) => /\bv3\b|\bv5\b|\bv6\b/.test(l)), 'no v3/v5/v6 use');
  // uuid 8.3.2 exports no v6 at all; v3/v5 are loaded by its index but never called on this path
  assert.equal(require(join(uuid, 'dist/index.js')).v6, undefined);
  // the lockfile has no other dependant of uuid@8.3.2
  const lock = readFileSync(join(pkgDir, '../../pnpm-lock.yaml'), 'utf8');
  const dependants = [...lock.matchAll(/\n  (\S+):\n(?:    .*\n)*?      uuid: 8\.3\.2\n/g)].map((m) => m[1]);
  assert.deepEqual(dependants.map((d) => d!.replace(/\(.*$/, '')), ['jayson@4.3.0']);
});

test('GHSA-528h-pc64-c93x stream-json 1.9.1: jayson uses StreamValues/Verifier only, not the affected filters, and QF never loads it', () => {
  assert.equal(pj(streamJson).version, '1.9.1');
  const uses = walk(join(jayson, 'lib')).filter((f) => f.endsWith('.js')).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/require\('(stream-json[^']*)'\)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(uses)].sort(), ['stream-json/streamers/StreamValues', 'stream-json/utils/Verifier']);
  assert.ok(!probe.some((p) => /stream-json/.test(p)), 'web3.js uses the jayson browser client, which does not load stream-json');
});

test('input bounds regardless of disposition: live RPC responses are size- and depth-limited before parsing', async () => {
  const ok = createBoundedFetch({ fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: null } })) });
  assert.equal((await (await ok('https://rpc.invalid')).json()).result.context.slot, 1);
  const deep = createBoundedFetch({ maxDepth: 64, fetchImpl: async () => new Response('['.repeat(65) + ']'.repeat(65)) });
  await assert.rejects(deep('https://rpc.invalid'), /RPC_RESPONSE_TOO_DEEP 65 > 64/);
  const big = createBoundedFetch({ maxBytes: 1024, fetchImpl: async () => new Response('x'.repeat(2048)) });
  await assert.rejects(big('https://rpc.invalid'), /RPC_RESPONSE_TOO_LARGE/);
  assert.equal(jsonNestingDepth('{"a":"[[[[[","b":[1,{"c":2}]}'), 3, 'brackets inside strings do not count');
});

test('natives decision (2026-09-27): bufferutil and utf-8-validate are absent from the install and never loaded', () => {
  const lock = readFileSync(join(pkgDir, '../../pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(lock.slice(lock.indexOf('\npackages:\n')), /\n  '?(bufferutil|utf-8-validate|node-gyp-build)@/, 'no lockfile package entry');
  assert.match(readFileSync(join(pkgDir, '../../pnpm-workspace.yaml'), 'utf8'), /ignoredOptionalDependencies:\n  - bufferutil\n  - utf-8-validate\n/);
  for (const ws of [ws7, ws8]) for (const name of ['bufferutil', 'utf-8-validate']) {
    assert.throws(() => createRequire(join(ws, 'x.js')).resolve(name), /Cannot find module/, `${name} must not resolve from ws ${pj(ws).version}`);
  }
  assert.deepEqual(probe.filter((p) => p.endsWith('.node')), [], 'no native addon is loaded by the adapter runtime');
});

// ws 7.5.13 ignores WS_NO_BUFFER_UTIL / WS_NO_UTF_8_VALIDATE, so absence of the packages (not env flags) is the control.
// Both installed ws versions must still work on their pure-JS fallbacks. Localhost only.
for (const [label, dirOf] of [['7.5.13 (jayson)', () => ws7], ['8.22.0 (rpc-websockets)', () => ws8]] as const) {
  test(`ws ${label}: pure-JS mask/unmask and UTF-8 validation fallbacks work, and a localhost echo round-trips`, async () => {
    const dir = dirOf();
    const r = createRequire(join(dir, 'x.js'));
    const WS = r(dir);
    const bu = r(join(dir, 'lib/buffer-util.js'));
    const val = r(join(dir, 'lib/validation.js'));
    const mask = Buffer.from([1, 2, 3, 4]);
    const src = Buffer.from('project-qf-ws-fallback-\u00e9\u4e2d');
    const out = Buffer.alloc(src.length);
    bu.mask(src, mask, out, 0, src.length);
    assert.deepEqual([...out], [...src].map((b, i) => b ^ mask[i % 4]!));
    bu.unmask(out, mask);
    assert.deepEqual(out, src);
    assert.equal(val.isValidUTF8(Buffer.from('ok \u00e9')), true);
    assert.equal(val.isValidUTF8(Buffer.from([0xc3, 0x28])), false);
    assert.equal(val.isValidUTF8(Buffer.from([0xff])), false);
    const Server = WS.Server ?? WS.WebSocketServer;
    const server = new Server({ host: '127.0.0.1', port: 0 });
    await new Promise((res) => server.on('listening', res));
    server.on('connection', (c: any) => c.on('message', (m: any, isBinary?: boolean) => c.send(m, { binary: isBinary ?? typeof m !== 'string' })));
    const client = new WS(`ws://127.0.0.1:${server.address().port}`);
    await new Promise((res, rej) => { client.on('open', res); client.on('error', rej); });
    const got = new Promise<Buffer>((res) => client.once('message', (m: any) => res(Buffer.from(m))));
    const payload = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251));
    client.send(payload);
    assert.deepEqual(await got, payload, 'a masked 70 KB binary frame round-trips');
    const gotText = new Promise<string>((res) => client.once('message', (m: any) => res(m.toString())));
    client.send('texte \u00e9 \u4e2d');
    assert.equal(await gotText, 'texte \u00e9 \u4e2d');
    client.close();
    await new Promise((res) => server.close(res));
  });
}
