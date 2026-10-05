// Fee ledger: what each trade paid, from the swap event in its own transaction. TEST_ONLY: real devnet event bytes
// (public chain data, valueless tokens) for the split arithmetic, synthetic summaries on the MOCK pools for the
// indexer, store and API. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { K } from '../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import { swapEvent } from '../../../packages/adapter-meteora-dbc/test/support/swap-events.ts';
import type { TxSummary } from '../src/chain.ts';
import { feesFromSummary } from '../src/fees.ts';
import { FEES, fillTradeFees, PoolCache, syncLaunch } from '../src/indexer.ts';
import { harness, seedLaunch } from './support/harness.ts';

const fx = JSON.parse(readFileSync(new URL('../../../packages/adapter-meteora-dbc/test/fixtures/swap-events-devnet.json', import.meta.url), 'utf8')) as {
  transactions: { signature: string; feePayer: string; innerInstructions: { programId: string; dataHex: string }[] }[] };
const real = (sig: string): TxSummary => {
  const t = fx.transactions.find((x) => x.signature.startsWith(sig))!;
  return { signature: t.signature, slot: 1, blockTime: 1, err: false, feePayer: t.feePayer, accountKeys: [], tokenDeltas: {}, logMessages: [],
    programEvents: t.innerInstructions.map((i) => ({ programId: i.programId, data: Uint8Array.from(Buffer.from(i.dataHex, 'hex')) })) };
};
const VAULT_CURVE = '6Nq2JLyXf2bZHEVweuorkbyzmjP9CAjXGP6TjqnuSgek', VAULT_DAMM = 'HDnxLVQzPBVFhnGszBA5d1tQJ4iwAC5n54rxuENk2u2U';

test('[TEST_ONLY devnet bytes] curve fees split creator = floor(fee x pct / 100), platform = the rest; DAMM v2 fees go to LPs', () => {
  const c = feesFromSummary(real('5mPX3Y'), VAULT_CURVE, 50);
  assert.deepEqual(c, { venue: 'CURVE', status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: '7101011', protocolRaw: '1420202', referralRaw: '0',
    creatorRaw: '2840404', platformRaw: '2840405', lpRaw: null, compoundingRaw: null });
  // these are the amounts the $VAULT pool's own counters and the treasury's claims showed on devnet (milestone 7 evidence)
  const d = feesFromSummary(real('65BNQx'), VAULT_DAMM, null);
  assert.deepEqual([d.venue, d.status, d.totalRaw, d.lpRaw, d.protocolRaw, d.creatorRaw, d.platformRaw], ['DAMM_V2', 'RESOLVED', '4000000', '3200000', '800000', null, null]);
});

test('fees are UNKNOWN (never 0) when they cannot be proven from the transaction', () => {
  const s = real('5mPX3Y');
  assert.equal(feesFromSummary(s, K.pool.toBase58(), 50).evidence, 'NO_SWAP_EVENT', 'an event for another pool is not this trade\'s');
  assert.equal(feesFromSummary({ ...s, programEvents: undefined }, VAULT_CURVE, 50).evidence, 'NO_TX_DETAILS');
  assert.equal(feesFromSummary(s, VAULT_CURVE, null).evidence, 'NO_CREATOR_SHARE');
  const d = real('65BNQx');
  const bothTokens = { ...d, programEvents: d.programEvents!.map((e) => { const b = Uint8Array.from(e.data); b[16 + 32 + 1] = 0; return { ...e, data: b }; }) };
  assert.equal(feesFromSummary(bothTokens, VAULT_DAMM, null).evidence, 'FEE_NOT_IN_QUOTE');
  const broken = { ...d, programEvents: d.programEvents!.map((e) => ({ ...e, data: e.data.subarray(0, e.data.length - 3) })) };
  assert.equal(feesFromSummary(broken, VAULT_DAMM, null).evidence, 'EVENT_DECODE_FAILED');
  for (const f of [feesFromSummary(s, VAULT_CURVE, null), feesFromSummary(bothTokens, VAULT_DAMM, null)]) assert.equal(f.totalRaw, null);
  // two swaps on the same pool in one transaction: both counted
  const pool = K.pool.toBase58();
  const two: TxSummary = { ...s, programEvents: [swapEvent('CURVE', { pool, tradingFee: 101n, protocolFee: 25n }), swapEvent('CURVE', { pool, tradingFee: 99n, protocolFee: 25n })] };
  assert.deepEqual([feesFromSummary(two, pool, 50).creatorRaw, feesFromSummary(two, pool, 50).platformRaw, feesFromSummary(two, pool, 50).totalRaw], ['99', '101', '250']);
});

/** A synthetic swap on the MOCK pool: vault deltas make it a trade, the event carries its fees. */
function swap(sig: string, trader: string, slot: number, fee: { tradingFee?: bigint; protocolFee?: bigint }, withEvent = true): TxSummary {
  return { signature: sig, slot, blockTime: slot, err: false, feePayer: trader, accountKeys: [], logMessages: [],
    tokenDeltas: { [K.quoteVault.toBase58()]: 1_000_000n, [K.baseVault.toBase58()]: -5_000n },
    ...(withEvent ? { programEvents: [swapEvent('CURVE', { pool: K.pool.toBase58(), ...fee })] } : {}) };
}

test('[TEST_ONLY] the indexer records each trade\'s fees, fills in older trades, and never overwrites a proven record', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform);
  const pct = (await h.chain.readPool(K.pool.toBase58()))!.creatorTradingFeePct;
  const a = 'A'.repeat(43), b = 'B'.repeat(43);
  const txs = new Map<string, TxSummary>([['s1', swap('s1', a, 10, { tradingFee: 1_000n, protocolFee: 250n })], ['s2', swap('s2', b, 11, { tradingFee: 3_001n, protocolFee: 750n })]]);
  h.chain.txSummary = async (sig) => txs.get(sig) ?? null;
  h.chain.newSignatures = async () => [{ signature: 's1', slot: 10, err: false }, { signature: 's2', slot: 11, err: false }];
  const d = { store: h.store, chain: h.chain, poolCache: new PoolCache(h.chain) };
  assert.deepEqual(await syncLaunch(d, h.store.getLaunch(mint)!), { trades: 2 });
  const byS = (s: string) => h.store.listTrades(mint).find((t) => t.sig === s)!;
  const creator2 = (3_001n * BigInt(pct)) / 100n;
  assert.deepEqual([byS('s2').feeStatus, byS('s2').feeTotalRaw, byS('s2').feeCreatorRaw, byS('s2').feePlatformRaw, byS('s2').venue],
    ['RESOLVED', '3751', creator2.toString(), (3_001n - creator2).toString(), 'CURVE']);

  // a trade recorded before the fee ledger (or by the app before its transaction was served): fee_status NULL
  h.store.insertTrade({ sig: 's3', mint, trader: a, side: 'BUY', quoteRaw: '5', baseRaw: '1', slot: 12, blockTime: 12, source: 'app' });
  h.store.insertTrade({ sig: 's4', mint, trader: a, side: 'BUY', quoteRaw: '5', baseRaw: '1', slot: 13, blockTime: 13, source: 'app' });
  txs.set('s3', swap('s3', a, 12, { tradingFee: 40n, protocolFee: 10n }));
  assert.equal(byS('s3').feeStatus, null);
  assert.deepEqual(await fillTradeFees(d), { resolved: 1 });
  assert.equal(byS('s3').feeTotalRaw, '50');
  assert.deepEqual([byS('s4').feeStatus, byS('s4').feeEvidence, byS('s4').feeTotalRaw], ['UNKNOWN', 'NO_TX_DETAILS', null], 's4 is not served yet');
  txs.set('s4', swap('s4', a, 13, { tradingFee: 4n, protocolFee: 1n }));
  await fillTradeFees(d);
  assert.equal(byS('s4').feeStatus, 'RESOLVED');
  h.store.setTradeFees('s1', { venue: 'CURVE', status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: '999999', protocolRaw: '0', referralRaw: '0', creatorRaw: '0', platformRaw: '0', lpRaw: null, compoundingRaw: null });
  assert.equal(byS('s1').feeTotalRaw, '1250', 'a proven record is final');

  // a trade whose transaction never comes back stays UNKNOWN after the attempt limit and is never counted as 0
  h.store.insertTrade({ sig: 's5', mint, trader: b, side: 'SELL', quoteRaw: '7', baseRaw: '1', slot: 14, blockTime: 14, source: 'indexer' });
  for (let k = 0; k < FEES.maxAttempts + 2; k++) await fillTradeFees(d);
  assert.deepEqual([byS('s5').feeStatus, byS('s5').feeAttempts], ['UNKNOWN', FEES.maxAttempts]);
  const totals = h.store.feeTotals(['trader'], { trader: b })[0]!;
  assert.deepEqual([totals.trades, totals.feesRaw, totals.unknownTrades], [2, '3751', 1]);
});

test('[TEST_ONLY] /api/lp/fees: one wallet\'s trades and totals per coin, and every wallet\'s totals', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform);
  const a = 'A'.repeat(43), b = 'B'.repeat(43);
  const txs = [swap('s1', a, 10, { tradingFee: 1_000n, protocolFee: 250n }), swap('s2', b, 11, { tradingFee: 8_000n, protocolFee: 2_000n }), swap('s3', a, 12, { tradingFee: 2_000n, protocolFee: 500n })];
  h.chain.txSummary = async (sig) => txs.find((t) => t.signature === sig) ?? null;
  h.chain.newSignatures = async () => txs.map((t) => ({ signature: t.signature, slot: t.slot, err: false }));
  await syncLaunch({ store: h.store, chain: h.chain, poolCache: new PoolCache(h.chain) }, h.store.getLaunch(mint)!);

  const w = await h.call(`/api/lp/fees?wallet=${a}`);
  assert.equal(w.status, 200);
  assert.deepEqual([w.body.totals.trades, w.body.totals.feesRaw, w.body.totals.unknownTrades, w.body.notYetRead], [2, '3750', 0, 0]);
  assert.deepEqual(w.body.coins.map((c: any) => [c.symbol, c.feesRaw]), [['MOCK', '3750']]);
  assert.deepEqual(w.body.trades.map((t: any) => [t.sig, t.fees.status, t.fees.totalRaw]), [['s3', 'RESOLVED', '2500'], ['s1', 'RESOLVED', '1250']]);
  assert.equal(BigInt(w.body.totals.creatorRaw) + BigInt(w.body.totals.platformRaw) + BigInt(w.body.totals.protocolRaw), 3750n);

  const all = await h.call('/api/lp/fees');
  assert.deepEqual(all.body.wallets.map((x: any) => [x.trader, x.feesRaw]), [[b, '10000'], [a, '3750']], 'largest fee payer first');
  assert.equal(all.body.totals.feesRaw, '13750');
  assert.equal((await h.call('/api/lp/fees?wallet=not-an-address')).body.error.code, 'INVALID_REQUEST');
  const tok = await h.call(`/api/lp/tokens/${mint}`);
  assert.equal(tok.body.trades[0].fees.totalRaw, '2500');
});

test('[TEST_ONLY] earnings check: fees from trades must add up to the pool\'s unclaimed counters plus proven claims', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform);
  const pool = (await h.chain.readPool(K.pool.toBase58()))!;
  const record = (sig: string, creatorRaw: string, platformRaw: string, status: 'RESOLVED' | 'UNKNOWN' = 'RESOLVED') => {
    h.store.insertTrade({ sig, mint, trader: 'A'.repeat(43), side: 'BUY', quoteRaw: '1', baseRaw: '1', slot: 1, blockTime: 1, source: 'indexer' });
    h.store.setTradeFees(sig, status === 'RESOLVED'
      ? { venue: 'CURVE', status, evidence: 'SWAP_EVENT', totalRaw: (BigInt(creatorRaw) + BigInt(platformRaw)).toString(), protocolRaw: '0', referralRaw: '0', creatorRaw, platformRaw, lpRaw: null, compoundingRaw: null }
      : { venue: null, status, evidence: 'NO_TX_DETAILS', totalRaw: null, protocolRaw: null, referralRaw: null, creatorRaw: null, platformRaw: null, lpRaw: null, compoundingRaw: null });
  };
  record('t1', pool.creatorQuoteFee, pool.partnerQuoteFee);
  let e = (await h.call('/api/lp/earnings?fresh=1')).body.coins[0];
  assert.deepEqual([e.checks.creatorCurve.status, e.checks.platformCurve.status, e.checks.lp], ['MATCH', 'MATCH', null]);
  assert.equal(e.fromTrades.platformRaw, pool.partnerQuoteFee);

  record('t2', '0', '5');
  e = (await h.call('/api/lp/earnings?fresh=1')).body.coins[0];
  assert.deepEqual([e.checks.platformCurve.status, e.checks.platformCurve.differenceRaw], ['MISMATCH', '5'], 'the trades say 5 more was earned than the chain holds plus claims');
  assert.equal(e.checks.creatorCurve.status, 'MATCH');

  record('t3', '0', '0', 'UNKNOWN');
  e = (await h.call('/api/lp/earnings?fresh=1')).body.coins[0];
  assert.equal(e.checks.platformCurve.status, 'INCOMPLETE');
  assert.match(e.checks.platformCurve.reasons[0], /1 trade\(s\) whose fees are not read yet/);
});
