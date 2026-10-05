// DAMM v2 fee accounting reader (LP residual proof). MOCK_RPC: the pool is the fixture DAMM v2 pool (devnet layout,
// re-keyed) with synthetic fee fields, and the two positions are synthetic. The decoded numbers and the settlement formula
// are checked against the MIT cp-amm SDK's own getUnClaimLpFee. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk';
import { readDammFeeAccounting, type LiveDammPool } from '../src/launchpad.ts';
import { DAMM, K, dammPoolAccount, fixtures } from './support/fixtures.ts';
import { mockKey, zeroOf } from './support/mockRpc.ts';

type Layouts = { coder: { accounts: { accountLayouts: Map<string, { discriminator: number[]; layout: { encode(v: unknown, b: Buffer): number } }>; decode(n: string, b: Buffer): any } }; idl: never };
const { damm } = fixtures() as unknown as { damm: Layouts };
const encode = (name: string, value: unknown) => {
  const l = damm.coder.accounts.accountLayouts.get(name)!, buf = Buffer.alloc(4096);
  return Buffer.concat([Buffer.from(l.discriminator), buf.subarray(0, l.layout.encode(value, buf))]);
};
const le32 = (v: bigint) => Array.from({ length: 32 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
const S = 1n << 128n;
// a fee-per-liquidity value with bytes set at both ends, so a wrong byte order cannot pass
const F = (1n << 130n) + (1n << 64n) * 12_345n + 5n;
const A = { key: mockKey('position-a'), nft: mockKey('position-a-nft'), unlocked: 3n << 64n, vested: 0n, locked: 0n, ck: 1n << 129n, pending: 11n, claimed: 7n };
const B = { key: mockKey('position-b'), nft: mockKey('position-b-nft'), unlocked: 1n, vested: 2n, locked: 1n << 70n, ck: 0n, pending: 0n, claimed: 0n };
const L = [A, B].reduce((s, p) => s + p.unlocked + p.vested + p.locked, 0n);

function poolBytes(totalLpB: bigint) {
  const p = damm.coder.accounts.decode('pool', dammPoolAccount());
  Object.assign(p, { liquidity: new BN(L.toString()), collectFeeMode: 1, feeBPerLiquidity: le32(F), feeAPerLiquidity: le32(0n) });
  Object.assign(p.metrics, { totalLpBFee: new BN(totalLpB.toString()), totalLpAFee: new BN(0), totalPosition: new BN(2) });
  return encode('pool', p);
}
function positionBytes(x: typeof A) {
  const s = zeroOf(damm.idl, { defined: { name: 'position' } }) as Record<string, any>;
  Object.assign(s, { pool: K.dammPool, nftMint: x.nft, feeBPerTokenCheckpoint: le32(x.ck), feeBPending: new BN(x.pending.toString()),
    unlockedLiquidity: new BN(x.unlocked.toString()), vestedLiquidity: new BN(x.vested.toString()), permanentLockedLiquidity: new BN(x.locked.toString()) });
  s.metrics.totalClaimedBFee = new BN(x.claimed.toString());
  return encode('position', s);
}
/** MOCK_RPC serving the pool (its LP fee total from `lpAt(read number)`) and the two positions. */
function conn(lpAt: (read: number) => bigint) {
  let reads = 0;
  const acct = (data: Buffer) => ({ data: [data.toString('base64'), 'base64'], executable: false, lamports: 10_000_000, owner: DAMM.toBase58(), rentEpoch: 0, space: data.length });
  const fetch = async (_u: unknown, init?: { body?: unknown }) => {
    const r = JSON.parse(String(init?.body));
    const ctx = { slot: 1000 };
    const result = r.method === 'getAccountInfo' && r.params[0] === K.dammPool.toBase58() ? { context: ctx, value: acct(poolBytes(lpAt(reads++))) }
      : r.method === 'getProgramAccounts' ? [B, A].map((x) => ({ pubkey: x.key.toBase58(), account: acct(positionBytes(x)) }))
      : null;
    return new Response(JSON.stringify(result === null ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `MOCK RPC: ${r.method}` } } : { jsonrpc: '2.0', id: r.id, result }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { connection: new Connection('http://mock-rpc.invalid', { commitment: 'confirmed', fetch: fetch as never, disableRetryOnRateLimit: true }), reads: () => reads };
}
const live = { pool: K.dammPool.toBase58(), baseMint: K.baseMint.toBase58(), quoteMint: K.quoteMint.toBase58() } as LiveDammPool;

test('[MOCK_RPC] the DAMM v2 accounting reader decodes the pool and every position, and its settlement math is the SDK\'s', async () => {
  const c = conn(() => 999n);
  const a = await readDammFeeAccounting(c.connection, live);
  assert.deepEqual({ ...a, positions: undefined }, { pool: live.pool, collectFeeMode: 1, liquidity: L.toString(), feePerLiquidityQuote: F.toString(),
    totalLpQuoteRaw: '999', totalLpBaseRaw: '0', totalPositions: '2', positions: undefined });
  const [ra, rb] = [A, B].map((x) => a.positions.find((p) => p.position === x.key.toBase58())!);
  assert.deepEqual(a.positions.map((p) => p.position), [A.key.toBase58(), B.key.toBase58()].sort(), 'sorted by address, whatever order the RPC returns');
  assert.deepEqual([ra!.nftMint, ra!.liquidity, ra!.checkpointQuote, ra!.pendingQuoteRaw, ra!.claimedQuoteRaw, ra!.claimedBaseRaw],
    [A.nft.toBase58(), A.unlocked.toString(), A.ck.toString(), '11', '7', '0']);
  assert.equal(rb!.liquidity, (B.unlocked + B.vested + B.locked).toString(), 'unlocked + vested + permanently locked');
  // the reader's numbers in the settlement formula give exactly what the MIT SDK computes from the raw accounts
  const pool = damm.coder.accounts.decode('pool', poolBytes(999n));
  for (const [x, r] of [[A, ra!], [B, rb!]] as const) {
    const sdk = getUnClaimLpFee(pool, damm.coder.accounts.decode('position', positionBytes(x))).feeTokenB.toString();
    assert.equal((BigInt(r.pendingQuoteRaw) + (BigInt(r.liquidity) * (F - BigInt(r.checkpointQuote))) / S).toString(), sdk);
  }
  assert.equal(c.reads(), 2, 'the pool was read before and after the positions');
});

test('[MOCK_RPC] a pool that changes between the reads is read again, and an always-moving pool is refused', async () => {
  const once = conn((n) => (n === 0 ? 998n : 999n));
  assert.equal((await readDammFeeAccounting(once.connection, live)).totalLpQuoteRaw, '999');
  assert.equal(once.reads(), 4);
  const moving = conn((n) => 1000n + BigInt(n));
  await assert.rejects(readDammFeeAccounting(moving.connection, live), /DAMM_ACCOUNTING_MOVING/);
  assert.equal(moving.reads(), 6);
  await assert.rejects(readDammFeeAccounting(conn(() => 999n).connection, { ...live, quoteMint: new PublicKey(mockKey('other')).toBase58() }), /DAMM_POOL_MISMATCH/);
});
