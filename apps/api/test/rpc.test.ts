// Read-only RPC client: failure mapping, size and time bounds, and genesis-based network proof. No network is used; every
// response comes from an in-process fake fetch.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearGenesisCache, endpointFromUrl, GENESIS, getAccountInfo, getTokenLargestAccounts, rpcCall, RpcUnavailable, verifyGenesis,
  type FetchLike } from '../src/rpc.ts';

const EP = endpointFromUrl('https://rpc.example.test/', 'mainnet-beta');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
const fixed = (r: () => Response): FetchLike => async () => r();
const reason = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { assert.ok(e instanceof RpcUnavailable, String(e)); return e.message; } };

beforeEach(() => clearGenesisCache());

test('endpoint URLs must be https without credentials (http only for localhost); the id is the host only', () => {
  assert.equal(EP.id, 'rpc.example.test');
  assert.throws(() => endpointFromUrl('http://rpc.example.test', 'devnet'), /must be https/);
  assert.throws(() => endpointFromUrl('https://user:pw@rpc.example.test', 'devnet'), /credentials/);
  assert.equal(endpointFromUrl('http://127.0.0.1:8899', 'devnet').id, '127.0.0.1:8899');
});

test('the egress allowlist 403 is reported as NETWORK_POLICY_DENIED; 429 and other statuses are mapped too', async () => {
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, fixed(() => new Response('Host not in allowlist', { status: 403 })))),
    'NETWORK_POLICY_DENIED (HTTP 403 Host not in allowlist)');
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, fixed(() => new Response('forbidden', { status: 403 })))), 'HTTP_403');
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, fixed(() => new Response('slow down', { status: 429 })))), 'RATE_LIMITED (HTTP 429)');
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, fixed(() => new Response('<html>', { status: 200 })))), 'BAD_JSON');
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, fixed(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32601 } })))), 'RPC_ERROR -32601');
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, fixed(() => json({ jsonrpc: '2.0', id: 1 })))), 'BAD_RPC_ENVELOPE');
  assert.match(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, async () => { throw new TypeError('fetch failed https://secret.example/key?x=1'); })),
    /^NETWORK_ERROR (?!.*secret)/);
});

test('an egress proxy refusing the CONNECT tunnel is reported as a network-policy denial, read from the cause chain', async () => {
  // Shape observed from Node 22 fetch with --use-env-proxy against this environment's proxy (evidence/milestone-inspector/demo).
  const tunnel = (status: number): FetchLike => async () => {
    throw new TypeError('fetch failed', { cause: new Error('Request was cancelled.', { cause: new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`) }) });
  };
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, tunnel(403))), 'NETWORK_POLICY_DENIED (egress proxy refused the tunnel: HTTP 403)');
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, tunnel(407))), 'PROXY_TUNNEL_FAILED (HTTP 407)');
  const dns: FetchLike = async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND rpc.example.test') }); };
  assert.equal(await reason(rpcCall(EP, 'getGenesisHash', [], 4096, dns)), 'NETWORK_ERROR getaddrinfo ENOTFOUND rpc.example.test');
});

test('responses are size-bounded while streaming, not only by Content-Length', async () => {
  assert.match(await reason(rpcCall(EP, 'm', [], 100, fixed(() => new Response('x'.repeat(200), { headers: { 'content-length': '200' } })))), /RESPONSE_TOO_LARGE declared 200/);
  let pulls = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(64)); } });
  assert.match(await reason(rpcCall(EP, 'm', [], 1000, fixed(() => new Response(endless)))), /RESPONSE_TOO_LARGE over 1000 bytes/);
  assert.ok(pulls < 40, `stream cancelled early (pulled ${pulls} chunks)`);
});

test('a stalled response times out', async () => {
  const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
  assert.match(await reason(rpcCall(EP, 'm', [], 1000, fixed(() => new Response(stalled)), 50)), /^TIMEOUT after 50 ms/);
  const hang: FetchLike = (_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)));
  assert.match(await reason(rpcCall(EP, 'm', [], 1000, hang, 50)), /^TIMEOUT after 50 ms/);
});

test('the network is proven by genesis hash: a wrong genesis is rejected and a match is cached per endpoint', async () => {
  assert.match(await reason(verifyGenesis(EP, fixed(() => ok(GENESIS.devnet)))), /^WRONG_NETWORK: genesis EtWTRABZ.* is not mainnet-beta/);
  let calls = 0;
  const f: FetchLike = async () => { calls++; return ok(GENESIS['mainnet-beta']); };
  await verifyGenesis(EP, f);
  await verifyGenesis(EP, f);
  assert.equal(calls, 1);
});

test('result shapes are validated before use', async () => {
  const acct = await getAccountInfo(EP, 'M', fixed(() => ok({ context: { slot: 5 }, value: { owner: 'O', data: ['AAEC', 'base64'] } })));
  assert.deepEqual(acct, { slot: '5', value: { owner: 'O', dataBase64: 'AAEC' } });
  assert.deepEqual(await getAccountInfo(EP, 'M', fixed(() => ok({ context: { slot: 5 }, value: null }))), { slot: '5', value: null });
  assert.equal(await reason(getAccountInfo(EP, 'M', fixed(() => ok({ context: { slot: -1 }, value: null })))), 'BAD_RESULT getAccountInfo');
  assert.equal(await reason(getAccountInfo(EP, 'M', fixed(() => ok({ context: { slot: 5 }, value: { owner: 'O', data: ['AAEC', 'jsonParsed'] } })))), 'BAD_RESULT getAccountInfo value');
  assert.equal(await reason(getAccountInfo(EP, 'M', fixed(() => ok({ context: { slot: 5 }, value: { owner: 'O', data: ['<script>', 'base64'] } })))), 'BAD_RESULT getAccountInfo value');
  const big = Array.from({ length: 25 }, (_, i) => ({ address: `a${i}`, amount: String(i), uiAmount: i }));
  const l = await getTokenLargestAccounts(EP, 'M', fixed(() => ok({ context: { slot: 7 }, value: big })));
  assert.equal(l.accounts.length, 20);
  assert.deepEqual(l.accounts[3], { address: 'a3', amountRaw: '3' });
  assert.equal(await reason(getTokenLargestAccounts(EP, 'M', fixed(() => ok({ context: { slot: 7 }, value: [{ address: 'a', amount: '1.5' }] })))), 'BAD_RESULT largest account entry');
});
