// The launchpad connection is devnet only: proven by genesis, and mainnet, plain http and credentials in the URL are
// refused. TEST_ONLY: fake JSON-RPC answers, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS, connectDevnet } from '../src/launchpad.ts';

const rpc = (genesis: string): typeof fetch => (async (_u: unknown, init?: { body?: unknown }) => {
  const req = JSON.parse(String(init?.body));
  const result = req.method === 'getGenesisHash' ? genesis : null;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

test('a devnet connection is proven by genesis; mainnet, another network, plain http and credentials are refused', async () => {
  assert.equal(await (await connectDevnet('https://devnet.example', rpc(GENESIS.devnet))).getGenesisHash(), GENESIS.devnet);
  await assert.rejects(() => connectDevnet('https://mainnet.example', rpc(GENESIS['mainnet-beta'])), /refusing mainnet-beta/);
  await assert.rejects(() => connectDevnet('https://other.example', rpc('11111111111111111111111111111111')), /is not devnet/);
  await assert.rejects(() => connectDevnet('http://devnet.example', rpc(GENESIS.devnet)), /must be https/);
  await assert.rejects(() => connectDevnet('https://u:p@devnet.example', rpc(GENESIS.devnet)), /credentials/);
});
