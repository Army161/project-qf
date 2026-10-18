// Launchpad API over HTTP with an in-process chain double (test/support/harness.ts). Transactions are built by the real
// adapter against the MOCK RPC fixtures (synthetic accounts, nothing live), signed in-process with WebCrypto keys, and
// "sent" to a recorder. No network, no real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { economicsDigest } from '@project-qf/policy';
import { READINESS } from '@project-qf/core';
import { addSignature, fromBase64, generateMintKey, parseWire, toBase64, toHex, type ApprovedTerms } from '@project-qf/tx';
import { buildCreatePool, buildSwap, readPool, summarisePool } from '@project-qf/adapter-meteora-dbc/launchpad';
import { createQuoteSimulator } from '@project-qf/adapter-meteora-dbc';
import { fixtures, K } from '../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import { checkBuiltTransaction } from '../../web/src/launchpad/txcheck.ts';
import type { LaunchpadChain } from '../src/chain.ts';
import { BACKFILL, crankMigrations, PoolCache, syncLaunch, tradeFromSummary } from '../src/indexer.ts';
import { FAUCET, sniffImage } from '../src/server.ts';
import { BLOCKHASH, harness, mockConn } from './support/harness.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('the launchpad reports its network, whether it can launch, and the platform', async () => {
  const { call, platform } = await harness();
  const r = await call('/api/lp/platform');
  assert.equal(r.status, 200);
  assert.equal(r.body.cluster, 'devnet');
  assert.equal(r.body.writesEnabled, READINESS.DEVNET_INTEGRATION.status === 'ACTIVE');
  assert.equal(r.body.ready, true);
  assert.equal(r.body.platform.launchEconomicsDigest, platform.launchEconomicsDigest);
  assert.equal(economicsDigest(r.body.platform.launchEconomics), platform.launchEconomicsDigest, 'browser can recompute the consented digest');
});

test('launch input is validated strictly before anything is built', async () => {
  const { call, platform } = await harness();
  const mint = (await generateMintKey()).address, creator = (await generateMintKey()).address;
  const ok = { creator, baseMint: mint, name: 'Moon Cat', symbol: 'MCAT', economicsDigest: platform.launchEconomicsDigest };
  assert.equal((await call('/api/lp/launch', { ...ok, admin: true })).body.error.code, 'UNKNOWN_FIELDS');
  assert.match((await call('/api/lp/launch', { ...ok, symbol: 'M CAT' })).body.error.message, /symbol/);
  assert.match((await call('/api/lp/launch', { ...ok, name: 'x'.repeat(33) })).body.error.message, /32 bytes/);
  assert.match((await call('/api/lp/launch', { ...ok, name: 'evil‮name' })).body.error.message, /control/);
  assert.match((await call('/api/lp/launch', { ...ok, website: 'http://insecure.example' })).body.error.message, /https/);
  assert.equal((await call('/api/lp/launch', { ...ok, baseMint: creator })).status, 400);
  assert.equal((await call('/api/lp/launch', { ...ok, imageDataUrl: `data:image/jpeg;base64,${Buffer.from(PNG).toString('base64')}` })).body.error.code, 'INVALID_IMAGE');
  assert.equal((await call('/api/lp/launch', { ...ok, economicsDigest: 'ab'.repeat(32) })).body.error.code, 'ECONOMICS_NOT_CONSENTED');
  assert.equal(sniffImage(PNG), 'image/png');
});

test('the readiness gate decides whether a devnet launch can be built', async () => {
  const { call, platform, sent } = await harness();
  const mint = await generateMintKey(), creator = await generateMintKey();
  const r = await call('/api/lp/launch', { creator: creator.address, baseMint: mint.address, name: 'Moon Cat', symbol: 'MCAT', economicsDigest: platform.launchEconomicsDigest,
    imageDataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` });
  if (READINESS.DEVNET_INTEGRATION.status !== 'ACTIVE') {
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'INTENT_REFUSED');
    assert.match(r.body.error.details.join(), /DEVNET_INTEGRATION is BLOCKED/);
    return;
  }
  // gate ACTIVE: build -> browser check -> sign (mint + creator) -> submit
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const bytes = fromBase64(r.body.transaction);
  const chk = await checkBuiltTransaction(bytes, r.body.terms, { kind: 'CREATE_POOL', wallet: creator.address, shown: {},
    fields: { name: 'Moon Cat', symbol: 'MCAT', uri: r.body.metadataUri, baseMint: mint.address, config: platform.config.config, quoteMint: platform.quote.mint } });
  assert.ok(chk.ok, JSON.stringify(chk.checks.filter((c) => !c.ok)));
  const one = await addSignature(bytes, mint.address, mint.privateKey);
  assert.equal((await call('/api/lp/submit', { intentId: r.body.intentId, signedTransaction: toBase64(one) })).body.error.code, 'SIGNATURE_INVALID');
  const both = await addSignature(one, creator.address, creator.privateKey);
  const s = await call('/api/lp/submit', { intentId: r.body.intentId, signedTransaction: toBase64(both) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(sent.length, 1);
  assert.equal((await call('/api/lp/submit', { intentId: r.body.intentId, signedTransaction: toBase64(both) })).body.error.code, 'ALREADY_SUBMITTED');
  const meta = await call(`/m/${mint.address}.json`);
  assert.equal(meta.body.name, 'Moon Cat');
  assert.equal(meta.body.image, `http://127.0.0.1:8788/m/${mint.address}.img`);
});

test('submit accepts only the exact built message, fully and validly signed, once, before expiry', async () => {
  const { conn, store, call, sent, tick } = await harness();
  const mint = await generateMintKey(), creator = await generateMintKey();
  const built = await buildCreatePool(conn, { config: K.config.toBase58(), quoteMint: K.quoteMint.toBase58(), creator: creator.address, baseMint: mint.address,
    name: 'Moon Cat', symbol: 'MCAT', uri: 'http://127.0.0.1:8788/m/x.json' });
  const now = new Date();
  const intent = store.insertIntent({ kind: 'CREATE_POOL', mint: null, user: creator.address, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    messageHex: toHex(parseWire(built.bytes).message), termsJson: JSON.stringify({ terms: built.terms, blockhash: BLOCKHASH }), lastValidBlockHeight: 1000 });
  const signed = await addSignature(await addSignature(built.bytes, mint.address, mint.privateKey), creator.address, creator.privateKey);

  const tampered = signed.slice(); tampered[tampered.length - 1]! ^= 1;
  assert.equal((await call('/api/lp/submit', { intentId: intent.id, signedTransaction: toBase64(tampered) })).body.error.code, 'MESSAGE_CHANGED');
  const badSig = signed.slice(); badSig[5]! ^= 1;
  const r1 = await call('/api/lp/submit', { intentId: intent.id, signedTransaction: toBase64(badSig) });
  assert.equal(r1.body.error.code, 'SIGNATURE_INVALID');
  assert.equal((await call('/api/lp/submit', { intentId: 'intent_' + '0'.repeat(32), signedTransaction: toBase64(signed) })).status, 404);
  assert.equal(sent.length, 0, 'nothing is relayed until every check passes');

  tick(121_000);
  assert.equal((await call('/api/lp/submit', { intentId: intent.id, signedTransaction: toBase64(signed) })).body.error.code, 'INTENT_EXPIRED');
  assert.equal(sent.length, 0);
});

test('the built create-pool and swap transactions bind to their terms (server and browser use the same checker)', async () => {
  const { conn } = await harness();
  const mint = await generateMintKey(), creator = await generateMintKey();
  const b = await buildCreatePool(conn, { config: K.config.toBase58(), quoteMint: K.quoteMint.toBase58(), creator: creator.address, baseMint: mint.address,
    name: 'Moon Cat', symbol: 'MCAT', uri: 'http://127.0.0.1:8788/m/x.json' });
  const c = await checkBuiltTransaction(b.bytes, b.terms, { kind: 'CREATE_POOL', wallet: creator.address, shown: {}, fields: { name: 'Moon Cat' } });
  assert.ok(c.ok, JSON.stringify(c.checks));
  const lying = await checkBuiltTransaction(b.bytes, { ...b.terms, name: 'Other' } as ApprovedTerms, { kind: 'CREATE_POOL', wallet: creator.address, shown: {}, fields: { name: 'Moon Cat' } });
  assert.equal(lying.ok, false, 'terms that differ from the bytes or from the input are caught');

  const pool = (await readPool(conn, K.pool.toBase58()))!;
  assert.equal(pool.baseMint, K.baseMint.toBase58());
  // the synthetic fixture config omits the stored migration sqrt price that a real on-chain config carries
  const { cfgParams } = fixtures();
  const BNc = (cfgParams.migrationQuoteThreshold as unknown as { constructor: new (s: string) => unknown }).constructor;
  (pool.raw.config as Record<string, unknown>).migrationSqrtPrice = new BNc(createQuoteSimulator(cfgParams).migrationSqrtPrice.toString());
  const user = creator.address;
  const s = await buildSwap(conn, pool, { pool: K.pool.toBase58(), user, direction: 'QUOTE_TO_BASE', amountIn: 1_000_000n, slippageBps: 100 }, 1_790_000_000);
  assert.ok(BigInt(s.quote.expectedOut) > 0n);
  assert.equal(BigInt(s.quote.minimumAmountOut), (BigInt(s.quote.expectedOut) * 9_900n) / 10_000n);
  const sc = await checkBuiltTransaction(s.bytes, s.terms, { kind: 'SWAP', wallet: user, shown: {}, fields: { amountIn: '1000000', direction: 'QUOTE_TO_BASE' },
    minimumAmountOutAtLeast: s.quote.minimumAmountOut });
  assert.ok(sc.ok, JSON.stringify(sc.checks.filter((x) => !x.ok)));
  const lowered = await checkBuiltTransaction(s.bytes, { ...s.terms, minimumAmountOut: '1' } as ApprovedTerms, { kind: 'SWAP', wallet: user, shown: {}, fields: {},
    minimumAmountOutAtLeast: s.quote.minimumAmountOut });
  assert.equal(lowered.ok, false, 'a lowered slippage floor is refused');
});

test('trades are classified from the pool vault deltas only', () => {
  const pool = { baseVault: 'BV', quoteVault: 'QV' };
  const s = (d: Record<string, bigint>, err = false) => ({ signature: 's', slot: 1, blockTime: 2, err, feePayer: 'T', accountKeys: [], tokenDeltas: d, logMessages: [] });
  assert.equal(tradeFromSummary({ mint: 'M' }, pool, s({ QV: 100n, BV: -5n }), 'x')?.side, 'BUY');
  assert.equal(tradeFromSummary({ mint: 'M' }, pool, s({ QV: -90n, BV: 5n }), 'x')?.side, 'SELL');
  assert.equal(tradeFromSummary({ mint: 'M' }, pool, s({ BV: 1000n }), 'x'), null, 'pool creation is not a trade');
  assert.equal(tradeFromSummary({ mint: 'M' }, pool, s({ QV: -100n, BV: -100n }), 'x'), null, 'migration is not a trade');
  assert.equal(tradeFromSummary({ mint: 'M' }, pool, s({ QV: 100n, BV: -5n }, true), 'x'), null, 'failed transactions are ignored');
});

test('the faucet is rate limited per wallet and sends SOL only to empty wallets', async () => {
  const { call, faucetCalls } = await harness();
  const w = (await generateMintKey()).address;
  for (let k = 0; k < FAUCET.claimsPerDay; k++) assert.equal((await call('/api/lp/faucet', { wallet: w })).status, 200);
  assert.equal((await call('/api/lp/faucet', { wallet: w })).body.error.code, 'FAUCET_LIMIT');
  assert.equal(faucetCalls.length, FAUCET.claimsPerDay);
  assert.equal((faucetCalls[0] as unknown[])[3], FAUCET.lamports);
});

test('the faucet keeps the operator\'s SOL above its floor, and parallel claims cannot pass the per-wallet limit', async () => {
  const { call, faucetCalls, operatorLamports, store, now } = await harness();
  operatorLamports.value = FAUCET.lamports + FAUCET.operatorFloorLamports - 1n;
  const w = (await generateMintKey()).address;
  assert.equal((await call('/api/lp/faucet', { wallet: w })).status, 200);
  assert.equal((faucetCalls[0] as unknown[])[3], 0n, 'test token only: the operator\'s SOL stays for graduations');
  operatorLamports.value = 100_000_000_000n;
  const v = (await generateMintKey()).address;
  const all = await Promise.all(Array.from({ length: 6 }, () => call('/api/lp/faucet', { wallet: v })));
  assert.equal(all.filter((r) => r.status === 200).length, FAUCET.claimsPerDay, JSON.stringify(all.map((r) => r.status)));
  assert.equal(store.faucetClaimsSince(v, new Date(now().getTime() - 86_400_000).toISOString()), FAUCET.claimsPerDay);
});

test('launches built but never sent are purged once expired, with their image; sent ones stay', async () => {
  const { store, platform } = await harness();
  const old = '2026-01-01T00:00:00.000Z', later = '2026-01-01T00:02:00.000Z';
  const pending = (mint: string) => store.insertPendingLaunch({ mint, pool: `${mint}P`, config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(),
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: 'image/png', metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: old }, new Uint8Array(1000));
  const intent = (mint: string) => store.insertIntent({ kind: 'CREATE_POOL', mint, user: K.creator.toBase58(), createdAt: old, expiresAt: later, messageHex: '00', termsJson: '{}', lastValidBlockHeight: 1 });
  pending('UNSENT'); intent('UNSENT');
  pending('SENT'); store.claimIntent(intent('SENT').id);
  assert.deepEqual(store.purgeUnsent('2026-01-01T00:01:00.000Z'), { launches: 0, intents: 0 }, 'not expired yet');
  assert.deepEqual(store.purgeUnsent('2026-01-01T03:00:00.000Z'), { launches: 1, intents: 1 });
  assert.equal(store.getLaunch('UNSENT'), null);
  assert.ok(store.getLaunch('SENT'));
});

test('quotes come from the curve, and amounts the curve cannot fill are refused as input errors, not server faults', async () => {
  const { call, store, platform } = await harness();
  const t = new Date().toISOString();
  store.insertPendingLaunch({ mint: K.baseMint.toBase58(), pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(),
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  store.markLaunchLive(K.baseMint.toBase58(), 'sig', t);
  const ok = await call('/api/lp/quote', { mint: K.baseMint.toBase58(), side: 'buy', amountIn: '1000000', slippageBps: 100 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(BigInt(ok.body.quote.expectedOut) > 0n && BigInt(ok.body.quote.minimumAmountOut) <= BigInt(ok.body.quote.expectedOut));
  const big = await call('/api/lp/quote', { mint: K.baseMint.toBase58(), side: 'buy', amountIn: '1000000000', slippageBps: 100 });
  const [small, large] = [Number(ok.body.quote.priceImpactBps), Number(big.body.quote.priceImpactBps)];
  assert.ok(small < 100 && large > small, `impact small=${small} large=${large}`);
  const huge = await call('/api/lp/quote', { mint: K.baseMint.toBase58(), side: 'sell', amountIn: (10n ** 18n).toString(), slippageBps: 100 });
  assert.notEqual(huge.status, 500, JSON.stringify(huge.body));
  assert.equal(huge.status, 409);
  const past = await call('/api/lp/quote', { mint: K.baseMint.toBase58(), side: 'buy', amountIn: (10n ** 15n).toString(), slippageBps: 100 });
  assert.equal(past.status, 409, JSON.stringify(past.body));
  const max = String(past.body.error.details?.find((d: string) => d.startsWith('maxAmountIn:'))).slice(12);
  assert.ok(BigInt(max) > 0n, JSON.stringify(past.body));
  const rest = await call('/api/lp/quote', { mint: K.baseMint.toBase58(), side: 'buy', amountIn: max, slippageBps: 100 });
  assert.equal(rest.status, 200, `the advertised maximum must itself be fillable: ${JSON.stringify(rest.body)}`);
  assert.equal((await call('/api/lp/quote', { mint: K.baseMint.toBase58(), side: 'buy', amountIn: (BigInt(max) + 1n).toString(), slippageBps: 100 })).status, 409);
});

test('pool summaries ignore a zero fixed-supply field (a zero BN is truthy) and fall back to the curve amounts', async () => {
  const conn = await mockConn();
  const p = (await readPool(conn, K.pool.toBase58()))!;
  const cfg = p.raw.config as Record<string, unknown>;
  const BNc = (cfg.migrationQuoteThreshold as object).constructor as new (v: string) => unknown;
  const zero = summarisePool(p.pool, p.raw.virtualPool, { ...cfg, preMigrationTokenSupply: new BNc('0'), swapBaseAmount: new BNc('800'), migrationBaseThreshold: new BNc('200') });
  assert.equal(zero.totalSupplyRaw, '1000');
  const fixed = summarisePool(p.pool, p.raw.virtualPool, { ...cfg, preMigrationTokenSupply: new BNc('1000000000000000') });
  assert.equal(fixed.totalSupplyRaw, '1000000000000000');
  assert.ok(BigInt(fixed.marketCapQuoteRaw) > 0n);
});

test('the trade tape lists recent trades of live coins only, newest first', async () => {
  const { call, store, platform } = await harness();
  const t = new Date().toISOString();
  const base = { config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(), description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t };
  store.insertPendingLaunch({ ...base, mint: K.baseMint.toBase58(), pool: K.pool.toBase58(), name: 'Live', symbol: 'LIVE' }, null);
  store.markLaunchLive(K.baseMint.toBase58(), 'sig-live', t);
  store.insertPendingLaunch({ ...base, mint: K.quoteMint.toBase58(), pool: K.config.toBase58(), name: 'Pending', symbol: 'PEND' }, null);
  const trade = (sig: string, mint: string, blockTime: number) => store.insertTrade({ sig, mint, trader: K.creator.toBase58(), side: 'BUY', quoteRaw: '1', baseRaw: '1', slot: blockTime, blockTime, source: 'test' });
  trade('old', K.baseMint.toBase58(), 100); trade('new', K.baseMint.toBase58(), 200); trade('hidden', K.quoteMint.toBase58(), 300);
  const r = await call('/api/lp/trades/recent');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.trades.map((x: { sig: string; symbol: string }) => `${x.sig}:${x.symbol}`), ['new:LIVE', 'old:LIVE']);
});

test('a pool read that throws during the migration crank is logged and skipped, not fatal', async () => {
  const { store, platform, chain } = await harness();
  const t = new Date().toISOString();
  store.insertPendingLaunch({ config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(), description: '', website: null, twitter: null,
    telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t, mint: K.baseMint.toBase58(), pool: K.pool.toBase58(), name: 'Live', symbol: 'LIVE' }, null);
  store.markLaunchLive(K.baseMint.toBase58(), 'sig-live', t);
  const flaky: LaunchpadChain = { ...chain, readPool: async () => { throw new Error('Invalid account discriminator'); } };
  const logs: string[] = [];
  assert.deepEqual(await crankMigrations({ store, chain: flaky, poolCache: new PoolCache(flaky), log: (m) => logs.push(m) }), []);
  assert.match(logs.join('\n'), /crank read .*Invalid account discriminator/);
});

test('after graduation the coin is quoted, built and checked on its DAMM v2 pool, never the finished curve', async () => {
  const { call, store, platform } = await harness();
  const t = new Date().toISOString();
  store.insertPendingLaunch({ mint: K.baseMint.toBase58(), pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(),
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  store.markLaunchLive(K.baseMint.toBase58(), 'sig', t);
  store.markLaunchMigrated(K.baseMint.toBase58(), 'mig', K.dammPool.toBase58(), t);
  const q = await call('/api/lp/quote', { mint: K.baseMint.toBase58(), side: 'buy', amountIn: '1000000', slippageBps: 100 });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.venue, 'DAMM_V2');
  assert.ok(BigInt(q.body.quote.expectedOut) > 0n);
  const user = K.creator.toBase58();
  for (const side of ['buy', 'sell'] as const) {
    const amountIn = side === 'buy' ? '1000000' : '1000000000';
    const b = await call('/api/lp/swap', { mint: K.baseMint.toBase58(), user, side, amountIn, slippageBps: 100 });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.terms.kind, 'DAMM_SWAP');
    assert.equal(b.body.terms.pool, K.dammPool.toBase58());
    const r = await checkBuiltTransaction(fromBase64(b.body.transaction), b.body.terms, { kind: 'DAMM_SWAP', wallet: user, shown: b.body.quote, minimumAmountOutAtLeast: b.body.quote.minimumAmountOut,
      fields: { user, pool: K.dammPool.toBase58(), baseMint: K.baseMint.toBase58(), direction: side === 'buy' ? 'QUOTE_TO_BASE' : 'BASE_TO_QUOTE', amountIn } });
    assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.ok(r.checks.some((c) => c.label === 'Only Meteora DAMM v2 and token programs are called' && c.ok));
  }
  const v = await call(`/api/lp/tokens/${K.baseMint.toBase58()}`);
  assert.equal(v.body.token.live.venue, 'DAMM_V2');
});

test('creators claim their curve fees and, after graduation, their locked position fees; nobody else can', async () => {
  const { call, store, platform } = await harness();
  const t = new Date().toISOString(), mint = K.baseMint.toBase58(), creator = K.creator.toBase58(), stranger = K.attacker.toBase58();
  store.insertPendingLaunch({ mint, pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator,
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  store.markLaunchLive(mint, 'sig', t);

  const mine = await call(`/api/lp/fees/${mint}?wallet=${creator}`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual([mine.body.isCreator, mine.body.curve.quoteRaw, mine.body.positions.length], [true, '1000000', 0]);
  const theirs = await call(`/api/lp/fees/${mint}?wallet=${stranger}`);
  assert.deepEqual([theirs.body.isCreator, theirs.body.curve, theirs.body.positions], [false, null, []]);

  assert.equal((await call('/api/lp/claim', { mint, user: stranger, venue: 'curve' })).body.error.code, 'NOT_CREATOR');
  assert.equal((await call('/api/lp/claim', { mint, user: creator, venue: 'damm', nftMint: K.positionNft.toBase58() })).body.error.code, 'NOT_GRADUATED');
  assert.equal((await call('/api/lp/claim', { mint, user: creator, venue: 'elsewhere' })).status, 400);
  const c = await call('/api/lp/claim', { mint, user: creator, venue: 'curve' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.terms.kind, c.body.terms.receiver, c.body.terms.maxQuoteAmount, c.body.amounts.quoteRaw], ['CLAIM_CREATOR_TRADING_FEE', creator, '1000000', '1000000']);
  const cr = await checkBuiltTransaction(fromBase64(c.body.transaction), c.body.terms, { kind: 'CLAIM_CREATOR_TRADING_FEE', wallet: creator, shown: {},
    fields: { creator, receiver: creator, pool: K.pool.toBase58(), baseMint: mint, quoteMint: platform.quote.mint } });
  assert.ok(cr.ok, JSON.stringify(cr.checks.filter((x) => !x.ok)));

  store.markLaunchMigrated(mint, 'mig', K.dammPool.toBase58(), t);
  const after = await call(`/api/lp/fees/${mint}?wallet=${creator}`);
  assert.deepEqual(after.body.positions.map((p: any) => [p.nftMint, p.feeQuoteRaw, p.permanentlyLocked]), [[K.positionNft.toBase58(), '500000', true]]);
  assert.equal((await call('/api/lp/claim', { mint, user: stranger, venue: 'damm', nftMint: K.positionNft.toBase58() })).body.error.code, 'NOT_POSITION_OWNER');
  assert.equal((await call('/api/lp/claim', { mint, user: creator, venue: 'damm', nftMint: stranger })).body.error.code, 'NOT_POSITION_OWNER');
  const d = await call('/api/lp/claim', { mint, user: creator, venue: 'damm', nftMint: K.positionNft.toBase58() });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.deepEqual([d.body.terms.kind, d.body.terms.owner, d.body.terms.pool, d.body.amounts.quoteRaw], ['DAMM_CLAIM_POSITION_FEE', creator, K.dammPool.toBase58(), '500000']);
  const dr = await checkBuiltTransaction(fromBase64(d.body.transaction), d.body.terms, { kind: 'DAMM_CLAIM_POSITION_FEE', wallet: creator, shown: {},
    fields: { owner: creator, pool: K.dammPool.toBase58(), positionNftMint: K.positionNft.toBase58(), baseMint: mint, quoteMint: platform.quote.mint } });
  assert.ok(dr.ok, JSON.stringify(dr.checks.filter((x) => !x.ok)));
  assert.ok(dr.checks.some((x) => x.label === 'Only Meteora DAMM v2 and token programs are called' && x.ok));
  // A browser that expected a curve claim refuses the DAMM bytes.
  assert.equal((await checkBuiltTransaction(fromBase64(d.body.transaction), d.body.terms, { kind: 'CLAIM_CREATOR_TRADING_FEE', wallet: creator, shown: {}, fields: {} })).ok, false);
});

test('My coins lists the coins a wallet launched with what it can claim, and nothing for anyone else', async () => {
  const { call, store, platform } = await harness();
  const t = new Date().toISOString(), mint = K.baseMint.toBase58(), creator = K.creator.toBase58(), stranger = K.attacker.toBase58();
  store.insertPendingLaunch({ mint, pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator,
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  assert.deepEqual((await call(`/api/lp/me?wallet=${creator}`)).body.coins, [], 'a launch that is not live yet is not listed');
  store.markLaunchLive(mint, 'sig', t);
  const me = (await call(`/api/lp/me?wallet=${creator}`)).body;
  assert.deepEqual(me.coins.map((c: any) => [c.token.mint, c.curve.quoteRaw, c.positions.length]), [[mint, '1000000', 0]]);
  assert.deepEqual(me.rewardsPaid, []);
  const theirs = (await call(`/api/lp/me?wallet=${stranger}`)).body;
  assert.deepEqual([theirs.coins, theirs.rewardsPaid], [[], []]);
  assert.equal((await call('/api/lp/me?wallet=not-an-address')).status, 400);
  assert.equal((await call('/api/lp/me')).status, 400);
  assert.equal((await call(`/api/lp/rewards/${stranger}`)).status, 404, 'rewards are per coin; an unknown coin has none');
});

test('the indexer queues a trade whose details the RPC has not served yet, keeps indexing newer ones, and picks it up next pass', async () => {
  const { store, platform, chain, now, tick } = await harness();
  const t = new Date().toISOString(), mint = K.baseMint.toBase58();
  store.insertPendingLaunch({ mint, pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(),
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  store.markLaunchLive(mint, 'sig', t);
  const qv = K.quoteVault.toBase58(), bv = K.baseVault.toBase58();
  const order = ['a', 'b', 'never'];
  const served = new Set(['b']);
  const sum = (signature: string) => ({ signature, slot: 1, blockTime: 1, err: false, feePayer: 'T', accountKeys: [], logMessages: [], tokenDeltas: { [qv]: 100n, [bv]: -5n } });
  const c = { ...chain,
    newSignatures: async (_a: string, until: string | null) => order.slice(until ? order.indexOf(until) + 1 : 0).map((signature) => ({ signature, slot: 1, err: false })),
    txSummary: async (sig: string) => (served.has(sig) ? sum(sig) : null) };
  const deps = { store, chain: c, poolCache: new PoolCache(c), now };
  const pass = () => { tick(BACKFILL.maxDelayMs); return syncLaunch(deps, store.getLaunch(mint)!); };
  assert.deepEqual(await pass(), { trades: 1 }, '"a" is not served yet: it is queued and "b" is still indexed');
  assert.equal(store.getLaunch(mint)!.lastIndexedSig, 'never');
  assert.deepEqual(store.backfillCounts(mint), { pending: 2, unavailable: 0 });
  served.add('a');
  assert.deepEqual(await pass(), { trades: 1 }, 'next pass picks up "a" from the queue');
  for (let k = 2; k < BACKFILL.maxAttempts; k++) await pass();
  assert.deepEqual(store.backfillCounts(mint), { pending: 0, unavailable: 1 }, 'a transaction that is never served is marked unavailable, not dropped');
  assert.equal(store.listTrades(mint).length, 2);
});

test('after graduation an unreadable DAMM v2 pool shows the price as unavailable, never the finished curve price', async () => {
  const { call, store, platform, chain } = await harness();
  const t = new Date().toISOString(), mint = K.baseMint.toBase58();
  store.insertPendingLaunch({ mint, pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(),
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  store.markLaunchLive(mint, 'sig', t);
  const curve = (await call(`/api/lp/tokens/${mint}?fresh=1`)).body.token.live;
  assert.equal(curve.venue, 'CURVE');
  assert.ok(BigInt(curve.launchPriceQuotePerBase) > 0n, 'a fixed launch price for "since launch"');
  store.markLaunchMigrated(mint, 'mig', K.dammPool.toBase58(), t);
  const ok = (await call(`/api/lp/tokens/${mint}?fresh=1`)).body.token.live;
  assert.deepEqual([ok.venue, ok.priceUnavailable], ['DAMM_V2', false]);
  assert.ok(ok.lockedBps >= 0 && ok.lockedBps <= 10_000, 'observed lock share from the pool account');
  chain.readDammPool = async () => { throw new Error('429 Too Many Requests'); };
  const down = (await call(`/api/lp/tokens/${mint}?fresh=1`)).body.token.live;
  assert.deepEqual([down.venue, down.priceUnavailable, down.priceQuotePerBase, down.marketCapQuoteRaw, down.lockedBps], ['DAMM_V2', true, null, null, null]);
  assert.equal((await call(`/api/lp/tokens/${mint}?fresh=1`)).body.token.status, 'MIGRATED');
});

test('the books separate creator and platform, curve and LP, and claim receipts count what left the vaults', async () => {
  const { books, store, platform, chain } = await harness();
  const t = new Date().toISOString(), mint = K.baseMint.toBase58();
  store.insertPendingLaunch({ mint, pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator: K.creator.toBase58(),
    name: 'MOCK', symbol: 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  store.markLaunchLive(mint, 'sig', t);
  let e = await books();
  assert.deepEqual(e.coins[0].curve, { creatorQuoteRaw: '1000000', platformQuoteRaw: '1000000' });
  assert.equal(e.coins[0].lp, null, 'not graduated: no LP positions yet');
  store.markLaunchMigrated(mint, 'mig', K.dammPool.toBase58(), t);
  store.insertClaim({ sig: 'claim-1', mint, venue: 'DAMM_V2', claimer: K.creator.toBase58(), at: t, pool: K.dammPool.toBase58(),
    quoteVault: K.dammQuoteVault.toBase58(), baseVault: K.dammBaseVault.toBase58() });
  chain.txSummary = async (signature) => ({ signature, slot: 1, blockTime: 1, err: false, feePayer: 'x', logMessages: [],
    accountKeys: [K.dammQuoteVault.toBase58(), K.dammBaseVault.toBase58()], tokenDeltas: { [K.dammQuoteVault.toBase58()]: -250_000n, [K.dammBaseVault.toBase58()]: 0n } });
  e = await books();
  assert.deepEqual(e.coins[0].lp, { creatorQuoteRaw: '500000', platformQuoteRaw: '0' });
  assert.deepEqual(e.totals.unclaimed, { creatorCurve: '1000000', platformCurve: '1000000', creatorLp: '500000', platformLp: '0' });
  assert.equal(e.totals.claimedThroughApp, '250000');
  assert.deepEqual(e.claims.map((c: any) => [c.sig, c.byCreator, c.venue]), [['claim-1', true, 'DAMM_V2']]);
  assert.deepEqual(e.totals.coverage, { unclaimedComplete: true, claimsComplete: true, unresolvedClaims: 0 });
  assert.equal(e.platformWallet, platform.config.feeClaimer);
});
