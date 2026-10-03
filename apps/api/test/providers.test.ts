// Provider B (decision D2, 2026-10-03): Helius as a second, independently operated provider. Covers method-aware routing for
// getTokenLargestAccounts (a public 429 must not hide a valid Helius observation, in either configuration order), bounded
// fallback, preserved disagreement, operator independence, and credential handling with FAKE keys only: the key never
// appears in a provider id, a reason, a report, the evidence or a log line, and redirects are refused.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58 } from '@project-qf/core';
import { encodeMintForFixture } from '@project-qf/validator';
import { describeEndpoints, endpointsFromEnv } from '../src/config.ts';
import { runInspection } from '../src/inspect.ts';
import { clearGenesisCache, endpointFromUrl, GENESIS, heliusEndpoint, rpcCall, RpcUnavailable, type FetchLike, type LiveCluster, type RpcEndpoint } from '../src/rpc.ts';

const FAKE_KEY = 'fake0000-dead-beef-0000-qfredaction1';           // not a real credential
const FAKE_PATH_KEY = 'PATHKEYfake9876543210';
const FAKE_QUERY_KEY = 'QUERYKEYfake0123456789';
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const addr = (l: string) => encodeBase58(createHash('sha256').update(`QF-TEST:${l}`).digest());
const MINT = addr('provider-mint');
const AUTH = addr('provider-authority');
const mint = (freeze: string | null = null) => Buffer.from(encodeMintForFixture({ tokenProgram: 'SPL_TOKEN', initialized: true, mintAuthority: null,
  freezeAuthority: freeze, supplyRaw: '1000000', decimals: 6, extensions: [] }, decodeBase58)).toString('base64');

type Behaviour = { largest?: 'ok' | 429 | 'timeout'; account?: 'ok' | 503; freeze?: string | null };
/** Fake JSON-RPC keyed by host. Records every call as host:method plus the redirect mode it was sent with. */
function fakeNet(by: Record<string, Behaviour>, calls: string[] = []): FetchLike {
  return async (url, init) => {
    const host = new URL(url).host;
    const b = by[host] ?? {};
    const { method } = JSON.parse(String(init.body)) as { method: string };
    calls.push(`${host}:${method}:${init.redirect}`);
    const cluster: LiveCluster = host.startsWith('devnet') || host.startsWith('api.devnet') ? 'devnet' : 'mainnet-beta';
    if (method === 'getGenesisHash') return Response.json({ jsonrpc: '2.0', id: 1, result: GENESIS[cluster] });
    if (method === 'getAccountInfo') {
      if (b.account === 503) return new Response('unavailable', { status: 503 });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 500 }, value: { owner: SPL, data: [mint(b.freeze ?? null), 'base64'] } } });
    }
    if (method === 'getTokenLargestAccounts') {
      if (b.largest === 429) return new Response('{"code":429}', { status: 429 });
      if (b.largest === 'timeout') throw new RpcUnavailable('TIMEOUT after 15000 ms');
      return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 501 }, value: [{ address: addr(`${host}-h0`), amount: '600000', decimals: 6 }] } });
    }
    return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601 } });
  };
}
const PUBLIC = () => endpointFromUrl('https://api.mainnet.solana.com', 'mainnet-beta');
const HELIUS = () => heliusEndpoint('mainnet-beta', FAKE_KEY);
const inspect = (eps: RpcEndpoint[], fetchImpl: FetchLike, cluster: LiveCluster = 'mainnet-beta') =>
  runInspection({ mint: MINT, cluster }, { endpoints: { 'mainnet-beta': cluster === 'mainnet-beta' ? eps : [], devnet: cluster === 'devnet' ? eps : [] }, fetchImpl,
    now: () => new Date('2026-10-03T12:00:00.000Z') });
const largestReads = (r: Awaited<ReturnType<typeof inspect>>) => r.report.reads.filter((x) => x.method === 'getTokenLargestAccounts').map((x) => [x.provider, x.status, x.reason]);

beforeEach(() => clearGenesisCache());

test('Helius endpoints: host-only id, operator helius, preferred for largest accounts; a malformed key is refused without echoing it', () => {
  const m = heliusEndpoint('mainnet-beta', FAKE_KEY);
  const d = heliusEndpoint('devnet', FAKE_KEY);
  assert.deepEqual([m.id, m.operator, m.cluster], ['mainnet.helius-rpc.com', 'helius', 'mainnet-beta']);
  assert.deepEqual([d.id, d.operator, d.cluster], ['devnet.helius-rpc.com', 'helius', 'devnet']);
  assert.deepEqual(m.prefer, ['getTokenLargestAccounts']);
  assert.equal(PUBLIC().operator, 'solana-public');
  assert.deepEqual(PUBLIC().prefer, []);
  for (const bad of ['', 'short', 'has space in it 1234567890', `${FAKE_KEY}&x=1`, 'k'.repeat(200)]) {
    assert.throws(() => heliusEndpoint('mainnet-beta', bad), (e: Error) => /QF_HELIUS_API_KEY is malformed/.test(e.message) && (bad === '' || !e.message.includes(bad)));
  }
});

test('public 429 on largest accounts + Helius success: Helius is used in either configuration order', async () => {
  for (const order of [[PUBLIC(), HELIUS()], [HELIUS(), PUBLIC()]]) {
    clearGenesisCache();
    const r = await inspect(order, fakeNet({ 'api.mainnet.solana.com': { largest: 429 } }));
    assert.deepEqual(largestReads(r), [['mainnet.helius-rpc.com', 'OK', null]], order.map((e) => e.id).join(','));
    assert.equal(r.report.features.components.find((c) => c.id === 'top1_account_share_bps')!.value, '6000');
    assert.equal(r.report.features.components.find((c) => c.id === 'top1_account_share_bps')!.source, 'mainnet.helius-rpc.com');
    assert.equal(r.report.inspection.checks.find((c) => c.id === 'S1.12')!.decision, 'PASS');   // two operators agree
  }
});

test('without a preference the fallback is bounded and keeps every failure: first 429, second answers', async () => {
  const a = endpointFromUrl('https://rpc-a.example.test', 'mainnet-beta');
  const b = endpointFromUrl('https://rpc-b.example.test', 'mainnet-beta');
  const r = await inspect([a, b], fakeNet({ 'rpc-a.example.test': { largest: 429 } }));
  assert.deepEqual(largestReads(r), [['rpc-a.example.test', 'UNAVAILABLE', 'RATE_LIMITED (HTTP 429)'], ['rpc-b.example.test', 'OK', null]]);
});

test('every candidate failing gives UNAVAILABLE naming each failure; providers whose mint read failed are never asked', async () => {
  clearGenesisCache();
  const calls: string[] = [];
  const r = await inspect([PUBLIC(), HELIUS()], fakeNet({ 'api.mainnet.solana.com': { largest: 429 }, 'mainnet.helius-rpc.com': { largest: 429 } }, calls));
  assert.deepEqual(largestReads(r).map((x) => x[1]), ['UNAVAILABLE', 'UNAVAILABLE']);
  assert.equal(calls.filter((c) => c.includes('getTokenLargestAccounts')).length, 2);         // one attempt each, no retry loop
  const share = r.report.features.components.find((c) => c.id === 'top1_account_share_bps')!;
  assert.match(share.note, /^UNAVAILABLE: .*mainnet\.helius-rpc\.com: RATE_LIMITED \(HTTP 429\).*api\.mainnet\.solana\.com: RATE_LIMITED \(HTTP 429\)/);
  clearGenesisCache();
  const calls2: string[] = [];
  const r2 = await inspect([PUBLIC(), HELIUS()], fakeNet({ 'api.mainnet.solana.com': { largest: 429 }, 'mainnet.helius-rpc.com': { account: 503 } }, calls2));
  assert.deepEqual(largestReads(r2), [['api.mainnet.solana.com', 'UNAVAILABLE', 'RATE_LIMITED (HTTP 429)']]);
  assert.ok(!calls2.includes('mainnet.helius-rpc.com:getTokenLargestAccounts:error'));
});

test('genuine disagreement between providers stays visible: S1.12 FAIL with both observations', async () => {
  const r = await inspect([PUBLIC(), HELIUS()], fakeNet({ 'mainnet.helius-rpc.com': { freeze: AUTH } }));
  const s112 = r.report.inspection.checks.find((c) => c.id === 'S1.12')!;
  assert.equal(s112.decision, 'FAIL');
  assert.match(s112.reason, /^PROVIDER_DISAGREEMENT/);
  assert.equal(s112.evidence.length, 2);
  assert.equal(r.report.inspection.aggregate.decision, 'FAIL');
});

test('two endpoints of the same operator do not satisfy S1.12', async () => {
  const second = { ...heliusEndpoint('mainnet-beta', FAKE_KEY.replace('1', '2')), id: 'mainnet.helius-rpc.com' };
  const r = await inspect([HELIUS(), second], fakeNet({}));
  assert.match(r.report.inspection.checks.find((c) => c.id === 'S1.12')!.reason, /^NOT_INDEPENDENT/);
  assert.ok(r.report.reads.every((x) => x.operator === 'helius'));
});

test('credentials never leak: query and path keys are redacted from reasons, and nothing in a report or its evidence holds a key', async () => {
  const ep = endpointFromUrl(`https://rpc.example.test/v2/${FAKE_PATH_KEY}?token=${FAKE_QUERY_KEY}`, 'mainnet-beta');
  assert.equal(ep.id, 'rpc.example.test');
  const throwing = (msg: string): FetchLike => async () => { throw new TypeError('fetch failed', { cause: new Error(msg) }); };
  for (const [e, msg] of [[ep, `connect ECONNREFUSED ${FAKE_PATH_KEY} ${FAKE_QUERY_KEY}`], [ep, `bad url rpc.example.test/v2/${FAKE_PATH_KEY}?token=${FAKE_QUERY_KEY}`],
    [HELIUS(), `getaddrinfo failed for mainnet.helius-rpc.com/?api-key=${FAKE_KEY}`], [HELIUS(), `key ${FAKE_KEY} rejected`]] as const) {
    let reason = '';
    try { await rpcCall(e, 'getGenesisHash', [], 4096, throwing(msg)); } catch (x) { reason = (x as Error).message; }
    assert.match(reason, /^NETWORK_ERROR/);
    for (const k of [FAKE_KEY, FAKE_PATH_KEY, FAKE_QUERY_KEY]) assert.ok(!reason.includes(k), `${reason} leaks ${k.slice(0, 8)}`);
  }
  const calls: string[] = [];
  const r = await inspect([PUBLIC(), HELIUS()], fakeNet({ 'api.mainnet.solana.com': { largest: 429 } }, calls));
  const everything = JSON.stringify(r);
  assert.ok(!everything.includes(FAKE_KEY) && !everything.includes('api-key'), 'report or evidence leaks the key');
  assert.ok(calls.length > 0 && calls.every((c) => c.endsWith(':error')), 'every RPC request refuses redirects');
});

test('server configuration: public endpoints by default; QF_HELIUS_API_KEY adds Helius on both clusters; descriptions hold no key', () => {
  const plain = endpointsFromEnv({});
  assert.deepEqual(plain['mainnet-beta'].map((e) => e.id), ['api.mainnet.solana.com']);
  assert.deepEqual(plain.devnet.map((e) => e.id), ['api.devnet.solana.com']);
  const env = endpointsFromEnv({ QF_HELIUS_API_KEY: FAKE_KEY });
  assert.deepEqual(env['mainnet-beta'].map((e) => [e.id, e.operator]), [['api.mainnet.solana.com', 'solana-public'], ['mainnet.helius-rpc.com', 'helius']]);
  assert.deepEqual(env.devnet.map((e) => [e.id, e.operator]), [['api.devnet.solana.com', 'solana-public'], ['devnet.helius-rpc.com', 'helius']]);
  const described = JSON.stringify(describeEndpoints(env));
  assert.ok(!described.includes(FAKE_KEY));
  assert.match(described, /mainnet\.helius-rpc\.com/);
  assert.throws(() => endpointsFromEnv({ QF_HELIUS_API_KEY: 'x y' }), (e: Error) => !e.message.includes('x y'));
  // Credentials in a configured URL are still refused (userinfo), and a query key is kept out of the id.
  assert.throws(() => endpointsFromEnv({ QF_RPC_MAINNET: 'https://u:p@rpc.example.test' }), /credentials/);
  assert.equal(endpointsFromEnv({ QF_RPC_MAINNET: `https://rpc.example.test/?k=${FAKE_QUERY_KEY}` })['mainnet-beta'][0]!.id, 'rpc.example.test');
});

test('capability probe: genesis first, one attempt per method and mint, sanitized rows with no key', async () => {
  const { probeProviders } = await import('../src/probe.ts');
  const eps = endpointsFromEnv({ QF_HELIUS_API_KEY: FAKE_KEY });
  const rows = await probeProviders(eps, fakeNet({ 'api.mainnet.solana.com': { largest: 429 }, 'api.devnet.solana.com': { largest: 429 } }), () => 0);
  assert.equal(rows.length, 4 * 5);                                             // 4 endpoints x (genesis + 2 mints x 2 methods)
  const helius = rows.filter((r) => r.operator === 'helius' && r.method === 'getTokenLargestAccounts');
  assert.ok(helius.length === 4 && helius.every((r) => r.status === 'OK' && r.authenticated));
  assert.ok(rows.filter((r) => r.operator === 'solana-public' && r.method === 'getTokenLargestAccounts').every((r) => r.reason === 'RATE_LIMITED (HTTP 429)'));
  assert.ok(!JSON.stringify(rows).includes(FAKE_KEY) && !JSON.stringify(rows).includes('api-key'));
});
