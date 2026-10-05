// Mainnet read-only (staging): a mainnet connection is proven by genesis and cannot send; reads used for decisions are
// compared across two providers. TEST_ONLY: fake JSON-RPC answers, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterSafetyError, GENESIS, WRITE_METHODS, connectDevnet, connectMainnetReadOnly, crossCheckAccounts, readOnlyConnection } from '../src/launchpad.ts';

const rpc = (genesis: string): typeof fetch => (async (_u: unknown, init?: { body?: unknown }) => {
  const req = JSON.parse(String(init?.body));
  const result = req.method === 'getGenesisHash' ? genesis : null;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

test('a mainnet connection is proven by genesis, reads work, and every send, airdrop, simulation and confirmation is refused', async () => {
  const conn = await connectMainnetReadOnly('https://mainnet.example', rpc(GENESIS['mainnet-beta']));
  assert.equal(await conn.getGenesisHash(), GENESIS['mainnet-beta']);
  for (const m of WRITE_METHODS) {
    await assert.rejects(() => (conn as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!(new Uint8Array(1)), (e: Error) => e instanceof ClusterSafetyError && /WRITES_LOCKED/.test(e.message), m);
  }
  assert.equal(conn.commitment, 'finalized');
});

test('the wrong network, plain http and credentials in the URL are refused; devnet still refuses mainnet', async () => {
  await assert.rejects(() => connectMainnetReadOnly('https://devnet.example', rpc(GENESIS.devnet)), /is not mainnet-beta/);
  await assert.rejects(() => connectMainnetReadOnly('http://mainnet.example', rpc(GENESIS['mainnet-beta'])), /must be https/);
  await assert.rejects(() => connectMainnetReadOnly('https://u:p@mainnet.example', rpc(GENESIS['mainnet-beta'])), /credentials/);
  await assert.rejects(() => connectDevnet('https://mainnet.example', rpc(GENESIS['mainnet-beta'])), /refusing mainnet-beta/);
});

test('a read-only wrapper cannot be patched to send', async () => {
  const fake = { sendRawTransaction: async () => 'sent', getSlot: async () => 7 };
  const ro = readOnlyConnection(fake as never) as unknown as typeof fake;
  assert.equal(await ro.getSlot(), 7);
  await assert.rejects(() => ro.sendRawTransaction(), /WRITES_LOCKED/);
  assert.throws(() => { (ro as Record<string, unknown>).sendRawTransaction = async () => 'patched'; }, TypeError);
  await assert.rejects(() => ro.sendRawTransaction(), /WRITES_LOCKED/);
});

// a provider double: answers getMultipleAccountsInfoAndContext from a map, at a slot
const KEY = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', PROG = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const provider = (slot: number, accounts: Record<string, { owner: string; executable?: boolean; data: number[] } | null>, onRead?: (min?: number) => void) => ({
  getMultipleAccountsInfoAndContext: async (keys: { toBase58(): string }[], cfg?: { minContextSlot?: number }) => {
    onRead?.(cfg?.minContextSlot);
    if (accounts === null) throw new Error('down');
    return { context: { slot }, value: keys.map((k) => { const a = accounts[k.toBase58()]; return a ? { owner: { toBase58: () => a.owner }, executable: !!a.executable, data: Buffer.from(a.data), lamports: 1 } : null; }) };
  },
});
const items = [{ address: KEY, label: 'mint' }, { address: PROG, label: 'program' }];
const acct = { [KEY]: { owner: 'Tok', data: [1, 2, 3] }, [PROG]: { owner: 'Loader', executable: true, data: [9] } };

test('two providers: equal is MATCH, one provider is SINGLE_PROVIDER (never MATCH), absent is MISSING', async () => {
  const both = await crossCheckAccounts(provider(10, acct) as never, provider(11, acct) as never, items);
  assert.deepEqual(both.map((c) => c.status), ['MATCH', 'MATCH']);
  const one = await crossCheckAccounts(provider(10, acct) as never, null, items);
  assert.deepEqual(one.map((c) => c.status), ['SINGLE_PROVIDER', 'SINGLE_PROVIDER']);
  const gone = await crossCheckAccounts(provider(10, {}) as never, provider(10, {}) as never, items);
  assert.deepEqual(gone.map((c) => c.status), ['MISSING', 'MISSING']);
});

test('a disagreement is re-read from the later slot once; if it persists it is a MISMATCH; an unreachable provider is UNAVAILABLE', async () => {
  const mins: (number | undefined)[] = [];
  const other = { ...acct, [KEY]: { owner: 'Tok', data: [1, 2, 4] } };
  const r = await crossCheckAccounts(provider(10, acct, (m) => mins.push(m)) as never, provider(12, other, (m) => mins.push(m)) as never, items);
  assert.deepEqual(r.map((c) => c.status), ['MISMATCH', 'MATCH']);
  assert.deepEqual(mins, [undefined, undefined, 12, 12], 'both re-read from slot 12');
  const down = await crossCheckAccounts(provider(10, acct) as never, provider(10, null as never) as never, items);
  assert.deepEqual(down.map((c) => c.status), ['UNAVAILABLE', 'UNAVAILABLE']);
});
