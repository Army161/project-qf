// The launchpad on Project QF's own engine (QF_ENGINE=qf), over HTTP with an in-process chain double
// (test/support/engine-fake.ts): synthetic accounts encoded with the engine's IDL, a send recorder, keys generated per
// test. No network. The real programs are exercised by scripts/engine-localnet.ts on a local validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { address, getAddressDecoder, getAddressEncoder } from '@solana/kit';
import * as E from '@project-qf/engine';
import { economicsDigest } from '@project-qf/policy';
import { addSignature, bindTransactionToTerms, decodeTransactionBytes, fromBase64, generateMintKey, parseWire, toBase64 } from '@project-qf/tx';
import { engineBooks, engineBooksText } from '../src/engine/books.ts';
import { calmRpc, createOperatorKey, GENESIS, loadOperator, proveCluster } from '../src/engine/chain.ts';
import { catchUp, classifyTx, crankGraduations, discoverCoins, indexPass, readDue, settlePending, TX_RETRY } from '../src/engine/indexer.ts';
import { ENGINE_FAUCET } from '../src/engine/server.ts';
import { EngineStore } from '../src/engine/store.ts';
import { ADDR, CFG, DEVNET, engineDir, engineHarness, fakeChain, putCurve, putPlatform, putPool, SOL, tokenAccountData, txRecord, type FakeChain } from './support/engine-fake.ts';

const ev = <T extends E.EngineEvent['name']>(name: T, program: string, f: Record<string, unknown>) => ({ name, program, depth: 1, ...f }) as unknown as E.EngineEvent;
const tradeEvent = (mint: string, trader: string, f: { isBuy: boolean; quote: bigint; base: bigint; platform: bigint; creator: bigint; realQuote: bigint; baseSold: bigint }) =>
  ev('TradeEvent', E.QF_CURVE, { mint, trader, isBuy: f.isBuy, quoteAmount: f.quote, baseAmount: f.base, platformFee: f.platform, creatorFee: f.creator, realQuote: f.realQuote, baseSold: f.baseSold, complete: false });

/** A coin the store knows as live, with its curve on the fake chain. */
async function liveCoin(h: { chain: FakeChain; store: EngineStore }, s: Parameters<typeof putCurve>[3] = {}) {
  const creator = await generateMintKey(), mint = (await generateMintKey()).address;
  h.store.insertPendingCoin({ mint, quoteMint: E.NATIVE_MINT, creator: creator.address, name: 'Moon Cat', symbol: 'MCAT', description: '', website: null, twitter: null, telegram: null,
    imageType: null, metadataUri: `http://127.0.0.1:8788/m/${mint}.json`, createdAt: '2026-10-11T00:00:00.000Z' }, null);
  h.store.markLive(mint, null, '2026-10-11T00:00:01.000Z');
  await putCurve(h.chain, mint, creator.address, s);
  return { mint, creator };
}
const signed = async (b64: string, ...keys: { address: string; privateKey: CryptoKey }[]) => {
  let bytes: Uint8Array = fromBase64(b64);
  for (const k of keys) bytes = await addSignature(bytes, k.address, k.privateKey);
  return toBase64(bytes);
};

test('the engine launchpad reports its engine, network and the economics a creator consents to, read from the chain', async () => {
  const { chain, call } = await engineHarness();
  let r = await call('/api/lp/platform');
  assert.equal(r.body.engine, 'qf');
  assert.equal(r.body.ready, false, 'no Global account yet: not ready');
  assert.equal(r.body.platform, null);
  await putPlatform(chain);
  r = await call('/api/lp/platform?fresh=1');
  assert.equal(r.body.ready, true);
  assert.equal(r.body.cluster, 'devnet');
  assert.equal(r.body.platform.quote.symbol, 'SOL');
  assert.equal(r.body.platform.feeRecipient, ADDR.treasury);
  assert.equal(r.body.platform.threshold.rawQuoteThreshold, E.finalRealQuote(CFG).toString());
  assert.equal(r.body.platform.launchEconomics.graduationFee, CFG.graduationFee.toString());
  assert.equal(economicsDigest(r.body.platform.launchEconomics), r.body.platform.launchEconomicsDigest, 'the browser can recompute the consented digest');
  assert.equal(r.body.faucet.lamports, ENGINE_FAUCET.lamports.toString());
  for (const p of ['/api/lp/rewards/x', '/api/lp/treasury']) assert.equal((await call(p)).body.error.code, 'NOT_ON_THIS_ENGINE');
});

test('a launch is validated, built from its terms, bound, signed by the creator and the fresh mint, and relayed once', async () => {
  const h = await engineHarness();
  await putPlatform(h.chain);
  const p = (await h.call('/api/lp/platform')).body.platform;
  const creator = await generateMintKey(), mint = await generateMintKey();
  const body = { creator: creator.address, baseMint: mint.address, name: 'Moon Cat', symbol: 'MCAT', economicsDigest: p.launchEconomicsDigest };
  assert.equal((await h.call('/api/lp/launch', { ...body, admin: true })).body.error.code, 'UNKNOWN_FIELDS');
  assert.equal((await h.call('/api/lp/launch', { ...body, economicsDigest: 'ab'.repeat(32) })).body.error.code, 'ECONOMICS_NOT_CONSENTED');
  assert.equal((await h.call('/api/lp/launch', { ...body, baseMint: creator.address })).status, 400);
  assert.match((await h.call('/api/lp/launch', { ...body, symbol: 'M CAT' })).body.error.message, /symbol/);
  const r = await h.call('/api/lp/launch', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = r.body.terms;
  assert.deepEqual([t.kind, t.cluster, t.feePayer, t.creator, t.baseMint, t.quoteMint, t.ammConfig, t.name, t.symbol],
    ['QF_CREATE', 'devnet', creator.address, creator.address, mint.address, E.NATIVE_MINT, ADDR.ammConfig, 'Moon Cat', 'MCAT']);
  assert.equal(t.uri, `http://127.0.0.1:8788/m/${mint.address}.json`);
  assert.equal(r.body.pool, await E.launchAddress(mint.address));
  const bytes = fromBase64(r.body.transaction);
  assert.deepEqual(await bindTransactionToTerms(decodeTransactionBytes(bytes), t), [], 'the bytes are exactly what the terms build');
  assert.deepEqual(parseWire(bytes).signerKeys, [creator.address, mint.address], 'the creator pays and signs; the fresh mint key co-signs');
  assert.equal((await h.call('/api/lp/launch', body)).body.error.code, 'MINT_IN_USE');
  assert.equal(h.store.getCoin(mint.address)?.status, 'PENDING');

  // submit: only the exact message, fully signed, once
  assert.equal((await h.call('/api/lp/submit', { intentId: r.body.intentId, signedTransaction: await signed(r.body.transaction, mint) })).body.error.code, 'SIGNATURE_INVALID');
  const good = await signed(r.body.transaction, mint, creator);
  const tampered = fromBase64(good); tampered[tampered.length - 1]! ^= 1;
  assert.equal((await h.call('/api/lp/submit', { intentId: r.body.intentId, signedTransaction: toBase64(tampered) })).body.error.code, 'MESSAGE_CHANGED');
  const s = await h.call('/api/lp/submit', { intentId: r.body.intentId, signedTransaction: good });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.kind, 'QF_CREATE');
  assert.equal(h.chain.sent.length, 1);
  assert.equal(h.store.getCoin(mint.address)?.status, 'LIVE');
  assert.equal(h.store.getCoin(mint.address)?.createSig, s.body.signature);
  assert.equal((await h.call('/api/lp/submit', { intentId: r.body.intentId, signedTransaction: good })).body.error.code, 'ALREADY_SUBMITTED');

  await putCurve(h.chain, mint.address, creator.address);
  const list = (await h.call('/api/lp/tokens')).body.tokens;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].status, list[0].live.venue, list[0].live.progressBps, list[0].pool, list[0].graduatedPool], ['LIVE', 'CURVE', 0, await E.launchAddress(mint.address), null]);
  assert.equal(list[0].live.quoteDecimals, 9);
  const meta = await fetch(`http://127.0.0.1:${(h.app.address() as { port: number }).port}/m/${mint.address}.json`).then((x) => x.json());
  assert.equal(meta.name, 'Moon Cat');
});

test('launching is refused while the engine pauses it, and while writes are locked', async () => {
  const h = await engineHarness();
  await putPlatform(h.chain, { createPaused: true });
  const creator = await generateMintKey(), mint = await generateMintKey();
  const r = await h.call('/api/lp/launch', { creator: creator.address, baseMint: mint.address, name: 'A', symbol: 'A', economicsDigest: 'x' });
  assert.equal(r.body.error.code, 'LAUNCHES_PAUSED');
  const locked = await engineHarness({ profile: { ...DEVNET, writes: false, writesLockedBecause: ['TEST_ONLY lock'] } });
  for (const path of ['/api/lp/launch', '/api/lp/swap', '/api/lp/submit', '/api/lp/claim', '/api/lp/faucet']) {
    assert.equal((await locked.call(path, {})).status, 423, path);
  }
});

test('curve quotes and trades use the engine math, build exactly their terms, and a confirmed trade shows at once', async () => {
  const h = await engineHarness();
  await putPlatform(h.chain);
  const state = { realQuote: 100_000_000n, baseSold: 200_000_000_000_000n, platformFees: 700_000n, creatorFees: 300_000n };
  const { mint } = await liveCoin(h, state);
  const amountIn = 50_000_000n, want = E.quoteBuy(CFG, state.realQuote, state.baseSold, amountIn);
  const q = await h.call('/api/lp/quote', { mint, side: 'buy', amountIn: amountIn.toString(), slippageBps: 100 });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.deepEqual([q.body.venue, q.body.quote.expectedOut, q.body.quote.feeQuoteRaw, q.body.quote.minimumAmountOut],
    ['CURVE', want.baseOut.toString(), want.fee.toString(), E.minWithSlippage(want.baseOut, 100).toString()]);
  const sell = await h.call('/api/lp/quote', { mint, side: 'sell', amountIn: '1000000000', slippageBps: 0 });
  assert.equal(sell.body.quote.expectedOut, E.quoteSell(CFG, state.realQuote, state.baseSold, 1_000_000_000n).quoteOut.toString());
  assert.equal((await h.call('/api/lp/quote', { mint, side: 'sell', amountIn: (state.baseSold + 1n).toString() })).status, 409, 'more coins than were sold');

  const user = await generateMintKey();
  const b = await h.call('/api/lp/swap', { mint, user: user.address, side: 'buy', amountIn: amountIn.toString(), slippageBps: 100 });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.deepEqual([b.body.terms.kind, b.body.terms.user, b.body.terms.direction, b.body.terms.amountIn, b.body.terms.minimumAmountOut],
    ['QF_SWAP', user.address, 'QUOTE_TO_BASE', amountIn.toString(), E.minWithSlippage(want.baseOut, 100).toString()]);
  assert.deepEqual(await bindTransactionToTerms(decodeTransactionBytes(fromBase64(b.body.transaction)), b.body.terms), []);
  const sig = '4'.repeat(88);
  h.chain.nextSig.push(sig);
  const fee = E.splitFee(CFG, want.fee);
  h.chain.txs.set(sig, txRecord(sig, [tradeEvent(mint, user.address, { isBuy: true, quote: want.quoteIn, base: want.baseOut, platform: fee.platform, creator: fee.creator,
    realQuote: state.realQuote + want.quoteToCurve, baseSold: state.baseSold + want.baseOut })], { feePayer: user.address }));
  const s = await h.call('/api/lp/submit', { intentId: b.body.intentId, signedTransaction: await signed(b.body.transaction, user) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.trade.side, s.body.trade.venue, s.body.trade.quoteRaw, s.body.trade.fees.creatorRaw], ['BUY', 'CURVE', want.quoteIn.toString(), fee.creator.toString()]);
  // the indexer reads the same transaction later: keyed by signature and event, it is not counted twice
  h.chain.history.set(await E.launchAddress(mint), [{ signature: sig, slot: 100, err: false }]);
  await indexPass({ store: h.store, chain: h.chain });
  assert.equal(h.store.allTrades(mint).length, 1);
  assert.deepEqual(h.store.unread(mint), { pending: 0, unavailable: 0 });

  await putCurve(h.chain, mint, (h.store.getCoin(mint))!.creator, { ...state, status: 'Complete' });
  assert.equal((await h.call('/api/lp/swap', { mint, user: user.address, side: 'buy', amountIn: '1000' })).body.error.code, 'CURVE_COMPLETE');
});

test('a graduated coin follows the chain, trades in its pool and shows its locked liquidity and creator pool fee', async () => {
  const h = await engineHarness();
  await putPlatform(h.chain);
  const { mint, creator } = await liveCoin(h);
  const pool = await E.launchPoolAddress(mint);
  await putCurve(h.chain, mint, creator.address, { status: 'Graduated', pool, platformFees: CFG.graduationFee });
  await putPool(h.chain, mint, creator.address, { quoteReserve: 800_000_000n, baseReserve: 206_900_000_000_000n, creatorFeesQuote: 1_234n, lpMintSupply: 0n });
  const t = (await h.call(`/api/lp/tokens/${mint}`)).body.token;
  assert.deepEqual([t.status, t.graduatedPool, t.live.venue, t.live.lockedBps, t.live.creatorPoolFee], ['GRADUATED', pool, 'POOL', 10_000, '1234']);
  assert.equal(h.store.getCoin(mint)?.status, 'GRADUATED', 'the record followed the chain');
  const q = await h.call('/api/lp/quote', { mint, side: 'buy', amountIn: '20000000' });
  assert.equal(q.body.venue, 'POOL');
  const user = await generateMintKey();
  const b = await h.call('/api/lp/swap', { mint, user: user.address, side: 'sell', amountIn: '1000000000', slippageBps: 50 });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.deepEqual([b.body.terms.kind, b.body.terms.ammConfig, b.body.terms.direction], ['QF_POOL_SWAP', ADDR.ammConfig, 'BASE_TO_QUOTE']);
  assert.deepEqual(await bindTransactionToTerms(decodeTransactionBytes(fromBase64(b.body.transaction)), b.body.terms), []);
  await putPool(h.chain, mint, creator.address, { quoteReserve: 800_000_000n, baseReserve: 206_900_000_000_000n, openTime: h.chain.clock + 1n });
  assert.equal((await h.call('/api/lp/swap', { mint, user: user.address, side: 'buy', amountIn: '1000' })).body.error.code, 'POOL_NOT_OPEN', 'the pool opens by the chain clock');
});

test('only the creator claims, only what is there, to their own wallet: curve fees, then the pool creator fee', async () => {
  const h = await engineHarness();
  await putPlatform(h.chain);
  const { mint, creator } = await liveCoin(h);
  const other = await generateMintKey();
  assert.equal((await h.call('/api/lp/claim', { mint, user: other.address, venue: 'curve' })).body.error.code, 'NOT_CREATOR');
  assert.equal((await h.call('/api/lp/claim', { mint, user: creator.address, venue: 'curve' })).body.error.code, 'NOTHING_TO_CLAIM');
  assert.equal((await h.call('/api/lp/claim', { mint, user: creator.address, venue: 'pool' })).body.error.code, 'NOT_GRADUATED');
  await putCurve(h.chain, mint, creator.address, { realQuote: 10n, baseSold: 10n, creatorFees: 300_000n, platformFees: 700_000n });
  const c = await h.call('/api/lp/claim', { mint, user: creator.address, venue: 'curve' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.terms.kind, c.body.terms.creator, c.body.amounts.quoteRaw], ['QF_CLAIM_CREATOR_FEES', creator.address, '300000']);
  assert.deepEqual(await bindTransactionToTerms(decodeTransactionBytes(fromBase64(c.body.transaction)), c.body.terms), []);
  const f = (await h.call(`/api/lp/fees/${mint}?wallet=${creator.address}`)).body;
  assert.deepEqual([f.isCreator, f.curve.quoteRaw, f.poolCreatorFee], [true, '300000', null]);
  assert.equal((await h.call(`/api/lp/fees/${mint}?wallet=${other.address}`)).body.curve, null);

  const pool = await E.launchPoolAddress(mint);
  await putCurve(h.chain, mint, creator.address, { status: 'Graduated', pool });
  await putPool(h.chain, mint, creator.address, { quoteReserve: 800_000_000n, baseReserve: 206_900_000_000_000n, creatorFeesQuote: 5_000n });
  const pc = await h.call('/api/lp/claim', { mint, user: creator.address, venue: 'pool' });
  assert.equal(pc.status, 201, JSON.stringify(pc.body));
  assert.deepEqual([pc.body.terms.kind, pc.body.terms.ammConfig, pc.body.amounts.quoteRaw], ['QF_COLLECT_POOL_CREATOR_FEE', ADDR.ammConfig, '5000']);
  const me = (await h.call(`/api/lp/me?wallet=${creator.address}&fresh=1`)).body;
  assert.deepEqual([me.coins.length, me.coins[0].poolCreatorFee.quoteRaw, me.rewardsPaid.length], [1, '5000', 0]);
});

test('the faucet gives test SOL only to a low wallet, a limited number of times, and never drains the operator', async () => {
  const h = await engineHarness();
  const w = (await generateMintKey()).address;
  h.chain.lamportsOf.set(ADDR.operator, ENGINE_FAUCET.lamports + ENGINE_FAUCET.operatorFloorLamports - 1n);
  assert.equal((await h.call('/api/lp/faucet', { wallet: w })).body.error.code, 'FAUCET_EMPTY');
  h.chain.lamportsOf.set(ADDR.operator, 100_000_000_000n);
  h.chain.lamportsOf.set(w, ENGINE_FAUCET.belowLamports);
  assert.equal((await h.call('/api/lp/faucet', { wallet: w })).body.error.code, 'FAUCET_NOT_NEEDED');
  h.chain.lamportsOf.set(w, 0n);
  for (let k = 0; k < ENGINE_FAUCET.claimsPerDay; k++) assert.equal((await h.call('/api/lp/faucet', { wallet: w })).status, 200);
  assert.equal((await h.call('/api/lp/faucet', { wallet: w })).body.error.code, 'FAUCET_LIMIT');
  const ix = h.chain.operatorSent[0]![0]!;
  assert.equal(ix.programAddress, E.SYSTEM);
  assert.deepEqual(ix.accounts?.map((a) => a.address), [ADDR.operator, w]);
  const noOperator = await engineHarness({ chain: fakeChain(null) });
  assert.equal((await noOperator.call('/api/lp/faucet', { wallet: w })).body.error.code, 'FAUCET_EMPTY');
});

test('the SOL balance a trader can spend is their SOL plus any wrapped SOL the next trade unwraps', async () => {
  const h = await engineHarness();
  const w = (await generateMintKey()).address;
  h.chain.lamportsOf.set(w, 1_000n);
  h.chain.accounts.set(await E.ata(w, E.NATIVE_MINT, E.TOKEN), { owner: E.TOKEN, lamports: 1n, data: tokenAccountData(E.NATIVE_MINT, w, 25n) });
  assert.equal((await h.call(`/api/lp/wallet/${w}`)).body.tokens[E.NATIVE_MINT], '1025');
});

test('the indexer reads fees from the engine events, retries what the RPC does not serve, and the crank graduates sold-out coins', async () => {
  const chain = fakeChain();
  const store = new EngineStore(`${engineDir}/idx.sqlite`);
  const h = { chain, store };
  const { mint, creator } = await liveCoin(h);
  const pool = await E.launchPoolAddress(mint), v = await E.poolAccounts(pool, mint, E.NATIVE_MINT);
  const quoteVault = v.token0 === E.NATIVE_MINT ? v.vault0 : v.vault1;
  const coin = store.getCoin(mint)!;
  // classification
  const claim = classifyTx(txRecord('a', [ev('FeesClaimed', E.QF_CURVE, { mint, to: creator.address, amount: 5n, creator: true }), ev('FeesClaimed', E.QF_CURVE, { mint: ADDR.admin, to: 'x', amount: 9n, creator: false })]), coin, pool, quoteVault);
  assert.deepEqual([claim.outcome, claim.payouts.length, claim.payouts[0]!.kind], ['PAYOUT', 1, 'CREATOR_CLAIM'], 'another coin\'s event is not this coin\'s');
  const grad = classifyTx(txRecord('b', [ev('Graduated', E.QF_CURVE, { mint, pool, quoteToPool: 1n, baseToPool: 1n, graduationFee: 10n, lpBurned: 1n })]), coin, pool, quoteVault);
  assert.deepEqual([grad.outcome, grad.graduated?.pool, grad.payouts[0]!.kind, grad.payouts[0]!.amountRaw], ['GRADUATION', pool, 'GRADUATION_FEE', '10']);
  const swap = ev('SwapEvent', E.QF_POOL, { poolId: pool, inputAmount: 100n, outputAmount: 7n, inputMint: E.NATIVE_MINT, outputMint: mint, tradeFee: 1n, creatorFee: 2n });
  const ps = classifyTx(txRecord('c', [swap], { feePayer: creator.address }), coin, pool, quoteVault);
  assert.deepEqual([ps.outcome, ps.trades[0]!.venue, ps.trades[0]!.side, ps.trades[0]!.trader, ps.trades[0]!.platformFeeRaw], ['TRADE', 'POOL', 'BUY', creator.address, null]);
  const collectData = Array.from(E.POOL_IDL.instructions.find((i) => i.name === 'collect_creator_fee_permissionless')!.discriminator, (b) => b.toString(16).padStart(2, '0')).join('');
  const collect = { programAddress: E.QF_POOL, dataHex: collectData };
  const col = classifyTx(txRecord('d', [], { instructions: [collect], tokenChanges: [{ account: quoteVault, mint: E.NATIVE_MINT, owner: null, preRaw: 50n, postRaw: 20n }] }), coin, pool, quoteVault);
  assert.deepEqual([col.outcome, col.payouts[0]!.kind, col.payouts[0]!.amountRaw], ['PAYOUT', 'POOL_CREATOR_COLLECT', '30']);
  assert.equal(classifyTx(txRecord('e', [swap], { instructions: [collect] }), coin, pool, quoteVault).outcome, 'MIXED_POOL_TX', 'a collect next to a swap cannot be split');
  assert.equal(classifyTx(txRecord('f', [], { logsTruncated: true }), coin, pool, quoteVault).outcome, 'LOGS_TRUNCATED');
  assert.equal(classifyTx(txRecord('g', [], { err: true }), coin, pool, quoteVault).outcome, 'FAILED_TX');

  // a listed transaction the RPC does not serve stays missing history, retried, then UNAVAILABLE
  let t = new Date('2026-10-11T00:00:00Z');
  const d = { store, chain, now: () => t };
  store.queueTxs(mint, 'CURVE', [{ signature: 'missing', slot: 1 }], t.toISOString());
  for (let k = 0; k < TX_RETRY.maxAttempts; k++) { await readDue(d); t = new Date(t.getTime() + TX_RETRY.maxDelayMs); }
  assert.deepEqual(store.unread(mint), { pending: 0, unavailable: 1 });

  // the crank graduates a Complete curve with the operator key, and records one someone else graduated
  await putCurve(chain, mint, creator.address, { status: 'Complete', realQuote: E.finalRealQuote(CFG), baseSold: CFG.curveSupply });
  const sent = await crankGraduations(d);
  assert.equal(sent.length, 1);
  const g = chain.operatorSent[0]![0]!;
  assert.equal(g.programAddress, E.QF_CURVE);
  assert.ok(g.accounts?.some((a) => a.address === E.POOL_FEE_RECEIVER), 'the pool creation fee goes to the engine\'s fee receiver');
  assert.equal(store.getCoin(mint)?.status, 'GRADUATED');

  // a launch that never landed fails once its intent is long expired; one whose launch account exists goes live
  const lost = (await generateMintKey()).address;
  store.insertPendingCoin({ mint: lost, quoteMint: E.NATIVE_MINT, creator: creator.address, name: 'L', symbol: 'L', description: '', website: null, twitter: null, telegram: null,
    imageType: null, metadataUri: 'x', createdAt: '2026-10-10T00:00:00.000Z' }, null);
  await settlePending(d, 180_000);
  assert.equal(store.getCoin(lost)?.status, 'FAILED');
  store.close();
});

test('the indexer finds coins it did not launch from their creation event, for its own quote only, and reads their history', async () => {
  const chain = fakeChain();
  const store = new EngineStore(`${engineDir}/discover.sqlite`);
  const d = { store, chain };
  const creator = (await generateMintKey()).address, trader = (await generateMintKey()).address;
  const [found, late, other] = await Promise.all([generateMintKey(), generateMintKey(), generateMintKey()]).then((ks) => ks.map((k) => k.address) as [string, string, string]);
  for (const m of [found, late, other]) await putCurve(chain, m, creator);
  // a launch quoted in another mint is not this launchpad's
  const o = chain.accounts.get(await E.launchAddress(other))!;
  o.data.set(getAddressEncoder().encode(address(trader)), E.LAUNCH_LAYOUT.quoteMintOffset);
  assert.deepEqual(await discoverCoins(d), [], 'nothing before the store is bound to its quote');
  store.bind('quote', E.NATIVE_MINT);
  const created = (mint: string) => ev('LaunchCreated', E.QF_CURVE, { mint, creator, coinName: 'Found Dog', symbol: 'FDOG', uri: 'https://example.invalid/fdog.json', config: CFG });
  chain.history.set(await E.launchAddress(found), [{ signature: 'tip', slot: 1, err: false }, { signature: 'mk', slot: 2, err: false }, { signature: 'buy', slot: 3, err: false }]);
  chain.txs.set('tip', txRecord('tip', []));
  chain.txs.set('mk', txRecord('mk', [ev('LaunchCreated', E.QF_CURVE, { mint: late, creator, coinName: 'X', symbol: 'X', uri: '', config: CFG }), created(found)], { blockTime: 1_760_000_050 }));
  chain.txs.set('buy', txRecord('buy', [tradeEvent(found, trader, { isBuy: true, quote: 101n, base: 7n, platform: 0n, creator: 1n, realQuote: 100n, baseSold: 7n })]));
  chain.history.set(await E.launchAddress(late), [{ signature: 'unserved', slot: 4, err: false }]);
  await indexPass(d);
  const c = store.getCoin(found)!;
  assert.deepEqual([c.status, c.name, c.symbol, c.creator, c.description, c.metadataUri, c.createSig, c.createdAt],
    ['LIVE', 'Found Dog', 'FDOG', creator, '', 'https://example.invalid/fdog.json', 'mk', '2025-10-09T08:54:10.000Z']);
  assert.deepEqual(store.allTrades(found).map((t) => [t.sig, t.trader, t.quoteRaw]), [['buy', trader, '101']], 'its whole history is read like any other coin\'s');
  assert.equal(store.getCoin(late), null, 'a coin whose creation is not served yet waits for the next pass');
  assert.equal(store.getCoin(other), null);
  chain.txs.set('unserved', txRecord('unserved', [created(late)]));
  assert.deepEqual(await discoverCoins(d), [late]);
  assert.deepEqual(await discoverCoins(d), [], 'a coin is found once');
  store.close();
});

test('verify\'s catch-up rebuilds a new store from the chain alone, pool history included, and sends nothing', async () => {
  const chain = fakeChain();
  const store = new EngineStore(`${engineDir}/catchup.sqlite`);
  store.bind('quote', E.NATIVE_MINT);
  const creator = (await generateMintKey()).address, mint = (await generateMintKey()).address, pool = await E.launchPoolAddress(mint);
  await putCurve(chain, mint, creator, { status: 'Graduated', pool });
  await putPool(chain, mint, creator, { quoteReserve: 1_000n, baseReserve: 1_000n });
  chain.history.set(await E.launchAddress(mint), [{ signature: 'mk', slot: 1, err: false }, { signature: 'grad', slot: 2, err: false }]);
  chain.history.set(pool, [{ signature: 'swap', slot: 3, err: false }]);
  chain.txs.set('mk', txRecord('mk', [ev('LaunchCreated', E.QF_CURVE, { mint, creator, coinName: 'Old Dog', symbol: 'ODOG', uri: '', config: CFG })]));
  chain.txs.set('grad', txRecord('grad', [ev('Graduated', E.QF_CURVE, { mint, pool, quoteToPool: 1n, baseToPool: 1n, graduationFee: 10n, lpBurned: 1n })]));
  chain.txs.set('swap', txRecord('swap', [ev('SwapEvent', E.QF_POOL, { poolId: pool, inputAmount: 100n, outputAmount: 7n, inputMint: E.NATIVE_MINT, outputMint: mint, tradeFee: 1n, creatorFee: 2n })]));
  await catchUp({ store, chain });
  assert.deepEqual([store.getCoin(mint)?.status, store.getCoin(mint)?.graduateSig, store.allTrades(mint).map((t) => [t.sig, t.venue])], ['GRADUATED', 'grad', [['swap', 'POOL']]]);
  assert.deepEqual([chain.operatorSent.length, chain.sent.length], [0, 0]);
  store.close();
});

test('the books reconcile every vault and fee with the events, fail on one raw unit, and wait for unread history', async () => {
  const chain = fakeChain();
  const store = new EngineStore(`${engineDir}/books.sqlite`);
  const h = { chain, store };
  const buy = E.quoteBuy(CFG, 0n, 0n, 50_000_000n), fee = E.splitFee(CFG, buy.fee);
  const state = { realQuote: buy.quoteToCurve, baseSold: buy.baseOut, platformFees: fee.platform - 1_000n, creatorFees: fee.creator - 2_000n };
  const { mint, creator } = await liveCoin(h, state);
  const trader = (await generateMintKey()).address;
  chain.txs.set('buy', txRecord('buy', [tradeEvent(mint, trader, { isBuy: true, quote: buy.quoteIn, base: buy.baseOut, platform: fee.platform, creator: fee.creator,
    realQuote: state.realQuote, baseSold: state.baseSold })]));
  chain.txs.set('claims', txRecord('claims', [ev('FeesClaimed', E.QF_CURVE, { mint, to: ADDR.treasury, amount: 1_000n, creator: false }),
    ev('FeesClaimed', E.QF_CURVE, { mint, to: creator.address, amount: 2_000n, creator: true })]));
  chain.history.set(await E.launchAddress(mint), [{ signature: 'buy', slot: 1, err: false }, { signature: 'claims', slot: 2, err: false }, { signature: 'late', slot: 3, err: false }]);
  const d = { store, chain };
  await indexPass(d);
  let b = await engineBooks(store, chain, SOL, 'devnet');
  assert.deepEqual(b.checks.filter((c) => c.verdict === 'WAIT').map((c) => c.check).sort(), ['creator curve fees add up', 'curve state follows its last trade', 'platform curve fees add up']);
  chain.txs.set('late', txRecord('late', []));
  await indexPass(d);
  b = await engineBooks(store, chain, SOL, 'devnet');
  assert.deepEqual(b.summary, { pass: 5, fail: 0, wait: 0 }, JSON.stringify(b.checks));
  await putCurve(chain, mint, creator.address, { ...state, quoteVault: state.realQuote + state.platformFees + state.creatorFees - 1n });
  b = await engineBooks(store, chain, SOL, 'devnet');
  assert.deepEqual([b.summary.fail, b.checks.find((c) => c.verdict === 'FAIL')?.check], [1, 'curve quote vault matches the curve']);
  const twin = { ...b.checks[0]!, mint: 'Twin1111111111111111111111111111111111111111' };
  assert.match(engineBooksText({ ...b, checks: [b.checks[0]!, twin] }), new RegExp(`\\$MCAT ${mint.slice(0, 4)}…[\\s\\S]*\\$MCAT Twin…`), 'two coins with one symbol are told apart');
  assert.doesNotMatch(engineBooksText(b), /\$MCAT \S+…/);
  store.close();
});

test('a busy RPC (429, dropped connection) is retried with a doubling wait; any other error reaches the caller at once', async () => {
  let calls = 0;
  const fail = (m: string, n: number) => ({ getBalance: () => ({ send: async () => { if (++calls <= n) throw new Error(m); return { value: 7n }; } }) });
  assert.deepEqual(await calmRpc(fail('HTTP error (429): Too Many Requests', 1)).getBalance().send(), { value: 7n });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(calmRpc(fail('Invalid param: WrongSize', 1)).getBalance().send(), /WrongSize/);
  assert.equal(calls, 1);
});

test('a fresh machine gets a throwaway operator key once: mode 0600, outside any git checkout, never replaced', async () => {
  const p = join(engineDir, 'keys', 'operator.json');
  assert.equal(createOperatorKey(p), true);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const bytes = JSON.parse(readFileSync(p, 'utf8')) as number[];
  assert.equal(bytes.length, 64);
  assert.equal((await loadOperator(p))!.address, getAddressDecoder().decode(Uint8Array.from(bytes.slice(32))), 'the file is the 64-byte form wallets and the CLI use');
  assert.equal(createOperatorKey(p), false);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), bytes);
  assert.throws(() => createOperatorKey(fileURLToPath(new URL('never/operator.json', import.meta.url))), /inside a git checkout/);
});

test('the engine server proves its network first: devnet by genesis hash, localnet only on this machine, never mainnet', async () => {
  const g = (h: string) => async () => h;
  assert.equal(await proveCluster('https://api.devnet.solana.com', 'devnet', g(GENESIS.devnet), false), 'devnet');
  await assert.rejects(proveCluster('https://x.example', 'devnet', g(GENESIS['mainnet-beta']), false), /refusing mainnet/);
  await assert.rejects(proveCluster('https://x.example', 'devnet', g('other'), false), /not devnet/);
  await assert.rejects(proveCluster('https://api.devnet.solana.com', 'devnet', g(GENESIS.devnet), true), /MAINNET_WRITES/);
  await assert.rejects(proveCluster('http://rpc.example', 'devnet', g(GENESIS.devnet), false), /https/);
  await assert.rejects(proveCluster('https://u:p@rpc.example', 'devnet', g(GENESIS.devnet), false), /credentials/);
  assert.equal(await proveCluster('http://127.0.0.1:8899', 'localnet', g('LocalGenesis1111111111111111111111111111111'), false), 'localnet');
  await assert.rejects(proveCluster('https://rpc.example', 'localnet', g('x'), false), /this machine/);
  await assert.rejects(proveCluster('http://127.0.0.1:8899', 'localnet', g(GENESIS.devnet), false), /serves devnet/);
  const s = new EngineStore(`${engineDir}/bind.sqlite`);
  s.bind('genesis', 'one');
  assert.throws(() => s.bind('genesis', 'two'), /STORE_GENESIS_MISMATCH/);
  s.close();
});
