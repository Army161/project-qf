// Launchpad API over HTTP with an in-process chain double. Transactions are built by the real adapter against the
// MOCK RPC fixtures (synthetic accounts, nothing live), signed in-process with WebCrypto keys, and "sent" to a
// recorder. No network, no real keys.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { economicsDigest } from '@project-qf/policy';
import { READINESS } from '@project-qf/core';
import { addSignature, fromBase64, generateMintKey, parseWire, toBase64, toHex, verifyWireSignatures, type ApprovedTerms } from '@project-qf/tx';
import { buildCreatePool, buildSwap, quoteSwap, readPool, summarisePool } from '@project-qf/adapter-meteora-dbc/launchpad';
import { createQuoteSimulator } from '@project-qf/adapter-meteora-dbc';
import { accountsForPool, fixtures, K, thresholdRecord } from '../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import { createMockConnection } from '../../../packages/adapter-meteora-dbc/test/support/mockRpc.ts';
import { checkBuiltTransaction } from '../../web/src/launchpad/txcheck.ts';
import type { LaunchpadChain } from '../src/chain.ts';
import { crankMigrations, PoolCache, tradeFromSummary } from '../src/indexer.ts';
import { launchEconomicsFor, type PlatformRecord } from '../src/platform.ts';
import { createLaunchpadApp, FAUCET, sniffImage } from '../src/server.ts';
import { LaunchpadStore } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'qf-lp-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const BLOCKHASH = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function mockConn() {
  const { accounts } = await accountsForPool(false);
  const { connection } = createMockConnection(accounts);
  Object.assign(connection, { getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }) });
  return connection;
}

function platformRecord(): PlatformRecord {
  const threshold = thresholdRecord();
  const quote = { mint: K.quoteMint.toBase58(), decimals: 6 };
  const launchEconomics = launchEconomicsFor(K.config.toBase58(), quote, threshold);
  return { cluster: 'devnet', operator: K.partner.toBase58(), quote: { ...quote, supplyRaw: '1', signature: 'x', label: 'TEST_ONLY', symbol: 'qUSD' }, threshold,
    config: { config: K.config.toBase58(), quoteMint: quote.mint, feeClaimer: K.partner.toBase58(), leftoverReceiver: K.leftover.toBase58(), signature: 'x' },
    economicsVersion: 'e', templateVersion: 't', launchEconomics, launchEconomicsDigest: economicsDigest(launchEconomics), createdAt: new Date().toISOString() };
}

// The adapter fixture config predates migrationSqrtPrice; fill it from the same curve simulator the adapter tests use.
function withMigrationPrice<T extends { raw: { config: unknown } } | null>(pool: T): T {
  if (!pool) return pool;
  const { cfgParams } = fixtures();
  const BNc = (cfgParams.migrationQuoteThreshold as unknown as { constructor: new (s: string) => unknown }).constructor;
  (pool.raw.config as Record<string, unknown>).migrationSqrtPrice = new BNc(createQuoteSimulator(cfgParams).migrationSqrtPrice.toString());
  return pool;
}

async function harness() {
  const conn = await mockConn();
  const sent: Uint8Array[] = [];
  const faucetCalls: unknown[] = [];
  const chain: LaunchpadChain = {
    operatorAddress: K.partner.toBase58(),
    readPool: async (p) => withMigrationPrice(await readPool(conn, p)),
    buildCreatePool: (r) => buildCreatePool(conn, r),
    buildSwap: (pool, r, now) => buildSwap(conn, pool, r, now),
    quoteSwap,
    send: async (b) => { sent.push(b); return (await verifyWireSignatures(b)).firstSignature; },
    txSummary: async () => null,
    newSignatures: async () => [],
    balances: async () => ({ lamports: '0', tokens: {} }),
    lamports: async () => 0n,
    faucet: async (...a) => { faucetCalls.push(a); return 'faucet-sig'; },
    migrate: async () => 'migrate-sig',
    dammPoolFor: async () => K.pool.toBase58(),
  };
  const store = new LaunchpadStore(join(dir, `lp-${Math.random().toString(36).slice(2)}.sqlite`));
  const platform = platformRecord();
  let clock = Date.now();
  const app = createLaunchpadApp({ store, chain, platform: () => platform, staticDir: null, publicBaseUrl: 'http://127.0.0.1:8788', now: () => new Date(clock) });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  after(() => { app.close(); store.close(); });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers };
  };
  return { conn, store, platform, call, sent, faucetCalls, chain, tick: (ms: number) => { clock += ms; } };
}

test('the launchpad reports the current readiness gate and platform', async () => {
  const { call, platform } = await harness();
  const r = await call('/api/lp/platform');
  assert.equal(r.status, 200);
  assert.equal(r.body.cluster, 'devnet');
  assert.equal(r.body.readiness.DEVNET_INTEGRATION, READINESS.DEVNET_INTEGRATION.status);
  assert.equal(r.body.readiness.MAINNET, 'BLOCKED');
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
