// Signature listing (no network): a fake connection plays getSignaturesForAddress, newest first, `limit` per page,
// honouring `before` and `until` like the RPC. More new transactions than one page must all come back, oldest first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from '@solana/web3.js';
import { getNewSignatures } from '../src/launchpad.ts';

function fakeConn(total: number) {
  const all = Array.from({ length: total }, (_, k) => ({ signature: `s${k}`, slot: k, err: null })).reverse(); // newest first
  const calls: { before?: string; until?: string }[] = [];
  const conn = { getSignaturesForAddress: async (_a: unknown, o: { limit: number; before?: string; until?: string }) => {
    calls.push({ ...(o.before ? { before: o.before } : {}), ...(o.until ? { until: o.until } : {}) });
    let from = o.before ? all.findIndex((s) => s.signature === o.before) + 1 : 0;
    const out = [];
    for (; from < all.length && out.length < o.limit; from++) { if (all[from]!.signature === o.until) break; out.push(all[from]!); }
    return out;
  } } as unknown as Connection;
  return { conn, calls };
}
const ADDR = '11111111111111111111111111111111';

test('more new transactions than one page are all returned, oldest first, down to the cursor', async () => {
  const { conn, calls } = fakeConn(250);
  const r = await getNewSignatures(conn, ADDR, 's9', { pageSize: 100 });
  assert.equal(r.length, 240, 's10..s249');
  assert.deepEqual([r[0]!.signature, r.at(-1)!.signature], ['s10', 's249']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { before: 's150', until: 's9' });
});

test('one short page needs one call, and an empty pool returns nothing', async () => {
  const { conn, calls } = fakeConn(30);
  assert.equal((await getNewSignatures(conn, ADDR, null, { pageSize: 100 })).length, 30);
  assert.equal(calls.length, 1);
  assert.deepEqual(await getNewSignatures(fakeConn(0).conn, ADDR, null), []);
});

test('past the page cap the caller is told which part of the window was not read', async () => {
  const { conn } = fakeConn(500);
  const told: string[] = [];
  const r = await getNewSignatures(conn, ADDR, 's0', { pageSize: 100, maxPages: 2, onTruncated: (m) => told.push(m) });
  assert.equal(r.length, 200);
  assert.match(told.join(), /stopped at 200 transactions since s0; transactions older than s300/);
});
