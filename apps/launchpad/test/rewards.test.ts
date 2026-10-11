// Holder rewards (devnet): balance history -> epochs -> exclusions -> allocation of deposits only -> artifact.
// TEST_ONLY: a synthetic holder ledger served by the harness (slot = unix second); no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyProof } from '@project-qf/rewards';
import { PoolCache } from '../src/indexer.ts';
import { syncAllHolders, toBalanceChanges } from '../src/holders.ts';
import { DBC_POOL_AUTHORITY, computeRewardEpoch, namedExclusions } from '../src/rewards.ts';
import { harness, seedLaunch } from './support/harness.ts';

const A = 'CBG61DYreVbVXtsHFJ7j63fam81zAEnyc5LKz59SWUsb', B = '8RKJVqkE8EGWLfghbXUAe1JhgEN2Z9eEX4EJ8xXdnAYG'; // wallets (on the curve)
const DAY = 86_400;

async function setup(o: { serveSend?: boolean; chainB?: bigint } = {}) {
  const h = await harness();
  const nowSec = Math.floor(h.now().getTime() / 1000), d0 = Math.floor(nowSec / DAY) * DAY - 2 * DAY;
  const mint = seedLaunch(h.store, h.platform, { liveAt: new Date((d0 + 60) * 1000).toISOString() });
  const tx = (signature: string, slot: number, balances: [string, string, bigint, bigint, string?][]) =>
    ({ signature, slot, blockTime: slot, err: false, balances: balances.map(([account, owner, preRaw, postRaw, m]) => ({ account, owner, preRaw, postRaw, mint: m ?? mint })) });
  const txs = [
    tx('create', d0 + 100, [['vault', DBC_POOL_AUTHORITY, 0n, 1000n]]),
    tx('buy', d0 + 200, [['vault', DBC_POOL_AUTHORITY, 1000n, 700n], ['ataA', A, 0n, 300n], ['quoteA', A, 50n, 20n, h.platform.quote.mint]]),
    tx('send', d0 + 300, [['ataA', A, 300n, 100n], ['ataB', B, 0n, 200n]]), // a direct transfer: B never trades
  ];
  for (const t of txs) if (t.signature !== 'send' || o.serveSend !== false) h.holders.txs.set(t.signature, t);
  const sig = (s: string) => ({ signature: s, slot: txs.find((t) => t.signature === s)!.slot, err: false });
  h.holders.sigs.set('vault', [sig('create'), sig('buy')]);
  h.holders.sigs.set('ataA', [sig('buy'), sig('send')]);
  h.holders.sigs.set('ataB', [sig('send')]);
  h.holders.slot = nowSec;
  h.holders.accounts = [{ account: 'ataA', owner: A, amountRaw: 100n }, { account: 'ataB', owner: B, amountRaw: o.chainB ?? 200n }, { account: 'vault', owner: DBC_POOL_AUTHORITY, amountRaw: 700n }];
  // the buy paid a platform fee of 1000 raw: the earmark is the holder-reward share of it (50% under V0_TEST economics)
  h.store.insertTrade({ sig: 'buy', mint, trader: A, side: 'BUY', quoteRaw: '30', baseRaw: '300', slot: d0 + 200, blockTime: d0 + 200, source: 'indexer' });
  h.store.setTradeFees('buy', { venue: 'CURVE', status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: '2500', protocolRaw: '500', referralRaw: '0', creatorRaw: '1000', platformRaw: '1000', lpRaw: null, compoundingRaw: null });
  const d = { store: h.store, chain: h.chain, poolCache: new PoolCache(h.chain), now: h.now };
  return { h, mint, d0, nowSec, d, epochId: (k: number) => new Date((d0 + k * DAY) * 1000).toISOString().slice(0, 10) };
}

test('[TEST_ONLY] rewards: a direct transfer counts, the pool is excluded, and an earmark is shown but never allocated', async () => {
  const { h, mint, d0, d, epochId } = await setup();
  await syncAllHolders(d);
  const r = await h.call(`/api/lp/rewards/${mint}?fresh=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rules.settlement.devnet, 'ONE_TEST_ROUND');
  assert.equal(r.body.rules.settlement.mainnet, false);
  const c = r.body.coins[0];
  assert.equal(c.coverage.status, 'COMPLETE', JSON.stringify(c.coverage.checks));
  assert.deepEqual(c.epochs.map((e: any) => [e.epochId, e.status]), [[epochId(0), 'FINAL'], [epochId(1), 'FINAL'], [epochId(2), 'OPEN']]);
  const e0 = c.epochs[0];
  assert.deepEqual([e0.window.startSlot, e0.window.endSlot, c.epochs[1].window.startSlot], [d0, d0 + DAY - 1, d0 + DAY], 'consecutive epochs tile the slots');
  assert.deepEqual([e0.funding.earmarkedRaw, e0.funding.fundedRaw, e0.totalAllocatedRaw], ['500', '0', '0'], 'the fee ledger earmarks 500; nothing is deposited, so nothing is allocated');
  assert.deepEqual([c.totals.earmarkedRaw, c.totals.depositedRaw, c.totals.allocatedRaw], ['500', '0', '0']);

  const det = (await h.call(`/api/lp/rewards/${mint}/${epochId(0)}`)).body;
  // A: 300 for 100 slots, then 100 for the rest of the day; B (transfer only): 200 from slot +300
  const unitsA = 300n * 100n + 100n * BigInt(DAY - 300), unitsB = 200n * BigInt(DAY - 300);
  assert.deepEqual(det.epoch.holders.map((x: any) => [x.owner, x.balanceUnits]), [[B, unitsB.toString()], [A, unitsA.toString()]]);
  assert.equal(det.epoch.holders[0].shareBps, Number((unitsB * 10_000n) / (unitsA + unitsB)));
  assert.deepEqual(det.epoch.excluded.map((x: any) => [x.owner, x.reason]), [[DBC_POOL_AUTHORITY, 'DBC_POOL_AUTHORITY']]);
  assert.deepEqual(det.epoch.payouts, []);
  assert.equal(det.artifact.funding.earmarkIsNotFunding, true);
  assert.deepEqual([det.artifact.exclusionPolicyVersion, det.artifact.allocationPolicyVersion, det.artifact.settlementTx], ['exclusion@1', 'allocation-v0-test', null]);
  assert.equal(det.artifact.inputChanges, 5, 'the qUSD balance in the same transaction is not this coin\'s');

  // frozen on first sight, reproduced exactly on every later run
  assert.equal(e0.frozen.reproduced, true);
  const again = (await h.call(`/api/lp/rewards/${mint}?fresh=1`)).body.coins[0].epochs[0];
  assert.deepEqual([again.artifactHash, again.frozen.hash, again.frozen.reproduced], [e0.artifactHash, e0.artifactHash, true]);
  const art = (await h.call(`/api/lp/rewards/${mint}/${epochId(0)}/artifact.json`)).body;
  assert.deepEqual(art, det.artifact);
  assert.equal((await h.call(`/api/lp/rewards/${mint}/${epochId(2)}/artifact.json`)).status, 404, 'an open epoch has no artifact');
  assert.equal((await h.call(`/api/lp/rewards/${mint}/1999-01-01`)).status, 404);
});

test('[TEST_ONLY] rewards: an epoch is not final while a transaction is unread or the history does not replay to the chain', async () => {
  const s = await setup({ serveSend: false });
  await syncAllHolders(s.d);
  let c = (await s.h.call(`/api/lp/rewards/${s.mint}?fresh=1`)).body.coins[0];
  assert.equal(c.coverage, null, 'still reading: not checked against the chain yet');
  assert.deepEqual(c.epochs.map((e: any) => e.status), ['INCOMPLETE', 'INCOMPLETE', 'OPEN']);
  assert.match(c.epochs[0].reasons.join(' '), /not checked against the chain/);
  assert.equal(s.h.store.holderTxCounts(s.mint).pending, 1);
  // once the RPC serves it, the history completes and the epochs become final
  s.h.holders.txs.set('send', { signature: 'send', slot: s.d0 + 300, blockTime: s.d0 + 300, err: false,
    balances: [{ account: 'ataA', owner: A, mint: s.mint, preRaw: 300n, postRaw: 100n }, { account: 'ataB', owner: B, mint: s.mint, preRaw: 0n, postRaw: 200n }] });
  await syncAllHolders(s.d);
  c = (await s.h.call(`/api/lp/rewards/${s.mint}?fresh=1`)).body.coins[0];
  assert.deepEqual([c.coverage.status, ...c.epochs.map((e: any) => e.status)], ['COMPLETE', 'FINAL', 'FINAL', 'OPEN']);

  // the chain disagrees with the replayed history: MISMATCH, and nothing becomes final
  const m = await setup({ chainB: 150n });
  await syncAllHolders(m.d);
  c = (await m.h.call(`/api/lp/rewards/${m.mint}?fresh=1`)).body.coins[0];
  assert.equal(c.coverage.status, 'MISMATCH');
  assert.deepEqual(c.coverage.checks.filter((x: any) => !x.ok).map((x: any) => x.id), ['REPLAY_EQUALS_CHAIN']);
  assert.deepEqual(c.epochs.map((e: any) => e.status), ['INCOMPLETE', 'INCOMPLETE', 'OPEN']);
  assert.equal(m.h.store.getRewardEpoch(m.mint, m.epochId(0)), null, 'nothing frozen');

  // the listing misses an account (the supply is larger than what the listed accounts hold): not complete either
  const u = await setup();
  u.h.holders.supplyExtraRaw = 50n;
  await syncAllHolders(u.d);
  c = (await u.h.call(`/api/lp/rewards/${u.mint}?fresh=1`)).body.coins[0];
  assert.deepEqual([c.coverage.status, c.coverage.checks.filter((x: any) => !x.ok).map((x: any) => x.id)], ['MISMATCH', ['ACCOUNTS_ADD_UP_TO_SUPPLY']]);
});

test('[TEST_ONLY] rewards: deposits are allocated by time-weighted balance, conserved, with verifiable Merkle proofs', async () => {
  const s = await setup();
  await syncAllHolders(s.d);
  const coverage = s.h.store.getPlatform<any>(`holderCoverage:${s.mint}`);
  const base = { launch: s.h.store.getLaunch(s.mint)!, cluster: 'devnet', changes: toBalanceChanges(s.h.store.holderChanges(s.mint)), trades: s.h.store.listTrades(s.mint),
    named: namedExclusions(s.h.platform), coverage, carryIn: {}, poolCarryInRaw: 0n, previousFinal: true,
    window: { epochId: s.epochId(0), startSec: s.d0, endSec: s.d0 + DAY, startSlot: s.d0, nextStartSlot: s.d0 + DAY } };
  const e = computeRewardEpoch({ ...base, deposits: [{ sig: 'deposit-1', amountRaw: 1_000_000n, slot: s.d0 + 5 }] });
  assert.equal(e.status, 'FINAL');
  const paid = e.result!.payouts.reduce((t, p) => t + p.amountRaw, 0n);
  assert.equal(paid + e.result!.poolRollForwardRaw + e.result!.holderCarryOutTotalRaw, 1_000_000n);
  const unitsA = 300n * 100n + 100n * BigInt(DAY - 300), unitsB = 200n * BigInt(DAY - 300);
  assert.deepEqual(e.result!.payouts.map((p) => [p.owner, p.amountRaw]).sort(), [[A, (1_000_000n * unitsA) / (unitsA + unitsB)], [B, (1_000_000n * unitsB) / (unitsA + unitsB)]].sort());
  for (const p of e.result!.payouts) assert.ok(verifyProof(e.result!.merkle.leaves.get(p.owner)!, e.result!.merkle.proofs.get(p.owner)!, e.result!.merkle.root));
  assert.equal(e.funding.fundedRaw, '1000000');
  // the same inputs give the same artifact; a different deposit gives a different one
  assert.equal(computeRewardEpoch({ ...base, deposits: [{ sig: 'deposit-1', amountRaw: 1_000_000n, slot: s.d0 + 5 }] }).artifactHash, e.artifactHash);
  assert.notEqual(computeRewardEpoch({ ...base, deposits: [{ sig: 'deposit-1', amountRaw: 999_999n, slot: s.d0 + 5 }] }).artifactHash, e.artifactHash);
  // the platform's own accounts are excluded by name
  assert.deepEqual(namedExclusions(s.h.platform).map((n) => n.reason).slice(0, 1), ['QF_OPERATOR']);
});

test('[TEST_ONLY] rewards: a coin whose launch time is a moment ahead of the server clock has one open epoch, not an error', async () => {
  const h = await harness();
  // chain block times can run a few seconds ahead of the server's clock
  const mint = seedLaunch(h.store, h.platform, { liveAt: new Date(h.now().getTime() + 5_000).toISOString() });
  const r = await h.call(`/api/lp/rewards/${mint}?fresh=1`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.coins[0].epochs.map((e: any) => e.status), ['OPEN']);
});
