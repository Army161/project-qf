// Regression tests for Astra's milestone 5 review (M5-R1 trade history, M5-R2 claim receipts). Synthetic chain reads
// only (TEST_ONLY): no network, no wallet, no chain writes.
//
// The first block ("reproduces …") uses only APIs that existed at 6617acd, so the same file can be run against that
// commit to show each finding, and against this one to show it fixed. The second block covers the new behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { addSignature, fromBase64, generateMintKey, toBase64 } from '@project-qf/tx';
import { K, termsFor } from '../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import type { LaunchpadChain, TxSummary } from '../src/chain.ts';
import { DammCache, PoolCache, syncDamm, syncLaunch } from '../src/indexer.ts';
import { LaunchpadStore } from '../src/store.ts';
import { BLOCKHASH, dir, harness, seedLaunch } from './support/harness.ts';

type H = Awaited<ReturnType<typeof harness>>;
const PAID = 1_400_318n; // the $CASH curve receipt Astra reconciled, reused as a synthetic outflow

/** A transaction summary as the RPC returns it: the accounts it touched and their token balance changes. */
const summary = (signature: string, deltas: Record<string, bigint>, o: { err?: boolean; keys?: string[] } = {}): TxSummary => ({
  signature, slot: 7, blockTime: 1_790_000_000, err: o.err ?? false, feePayer: K.creator.toBase58(), accountKeys: o.keys ?? Object.keys(deltas), tokenDeltas: deltas, logMessages: [] });
const curveVaults = { quote: K.quoteVault.toBase58(), base: K.baseVault.toBase58() };
const dammVaults = { quote: K.dammQuoteVault.toBase58(), base: K.dammBaseVault.toBase58() };
const buy = (sig: string, v: { quote: string; base: string }) => summary(sig, { [v.quote]: 100n, [v.base]: -5n });
const claimTx = (sig: string, v: { quote: string; base: string }, paid = PAID) => summary(sig, { [v.quote]: -paid, [v.base]: 0n, CREATOR_ATA: paid });

/** The indexer against one pool whose only transaction ("late") the RPC lists at once but serves only from pass `servedFrom`. */
function lateTrade(h: H, venue: 'CURVE' | 'DAMM_V2', servedFrom: number) {
  const addr = venue === 'CURVE' ? K.pool.toBase58() : K.dammPool.toBase58();
  const v = venue === 'CURVE' ? curveVaults : dammVaults;
  let n = 0;
  const chain: LaunchpadChain = { ...h.chain,
    newSignatures: async (a, until) => (a === addr && until !== 'late' ? [{ signature: 'late', slot: 7, err: false }] : []),
    txSummary: async (sig) => (sig === 'late' && n >= servedFrom ? buy(sig, v) : null) };
  const deps = (store: LaunchpadStore) => ({ store, chain, poolCache: new PoolCache(chain), dammCache: new DammCache(chain), now: h.now });
  const pass = async (store: LaunchpadStore, d = deps(store)) => {
    n++;
    h.tick(60_000);
    const l = store.getLaunch(K.baseMint.toBase58())!;
    return venue === 'CURVE' ? syncLaunch(d, l) : syncDamm(d, l);
  };
  return { pass, deps };
}

/** A claim recorded the way milestone 3/4 recorded it: a confirmed intent with its bound terms, and a receipt with no amount yet. */
async function legacyClaim(h: H, venue: 'CURVE' | 'DAMM_V2', sig = 'claim-1') {
  const terms = await termsFor(venue === 'CURVE' ? 'CLAIM_CREATOR_TRADING_FEE' : 'DAMM_CLAIM_POSITION_FEE');
  const t = h.now().toISOString();
  const i = h.store.insertIntent({ kind: terms.kind, mint: K.baseMint.toBase58(), user: K.creator.toBase58(), createdAt: t, expiresAt: t, messageHex: '00',
    termsJson: JSON.stringify({ terms, blockhash: BLOCKHASH }), lastValidBlockHeight: 1 });
  h.store.finishIntent(i.id, 'CONFIRMED', sig, null);
  h.store.insertClaim({ sig, mint: K.baseMint.toBase58(), venue, claimer: K.creator.toBase58(), quoteRaw: null, baseRaw: null, at: t });
  return sig;
}
const earnings = async (h: H) => (await h.call('/api/lp/earnings?fresh=1')).body;

// ------------------------------------------------------------------ reproductions (APIs present at 6617acd)

for (const venue of ['CURVE', 'DAMM_V2'] as const) {
  test(`M5-R1 reproduces: a ${venue} trade whose details arrive only after the retry limit is still indexed`, async () => {
    const h = await harness();
    seedLaunch(h.store, h.platform, { migrated: venue === 'DAMM_V2' });
    const { pass } = lateTrade(h, venue, 7);
    for (let k = 0; k < 14; k++) await pass(h.store);
    assert.equal(h.store.listTrades(K.baseMint.toBase58()).length, 1, 'served on the 7th pass, after the 5-pass limit: must not be lost');
  });
}

test('M5-R1 reproduces: a trade still missing at a restart is recovered after the restart', async () => {
  const h = await harness();
  seedLaunch(h.store, h.platform);
  const { pass } = lateTrade(h, 'CURVE', 8);
  for (let k = 0; k < 6; k++) await pass(h.store);
  h.store.close(); // process restart: only what is in the database survives
  const reopened = new LaunchpadStore(h.dbPath);
  try {
    for (let k = 0; k < 6; k++) await pass(reopened);
    assert.equal(reopened.listTrades(K.baseMint.toBase58()).length, 1);
  } finally { reopened.close(); }
});

for (const venue of ['CURVE', 'DAMM_V2'] as const) {
  test(`M5-R2 reproduces: a ${venue} pool that cannot be read before enrichment never turns a receipt into 0`, async () => {
    const h = await harness();
    seedLaunch(h.store, h.platform, { migrated: venue === 'DAMM_V2' });
    const sig = await legacyClaim(h, venue);
    h.chain.txSummary = async (s) => claimTx(s, venue === 'CURVE' ? curveVaults : dammVaults);
    const [readPool, readDammPool] = [h.chain.readPool, h.chain.readDammPool];
    h.chain.readPool = async () => { throw new Error('429 Too Many Requests'); };
    h.chain.readDammPool = async () => { throw new Error('429 Too Many Requests'); };
    const during = (await earnings(h)).claims.find((c: { sig: string }) => c.sig === sig);
    assert.notEqual(during.quoteRaw, '0', 'missing pool evidence must stay unknown, not become a stored zero');
    Object.assign(h.chain, { readPool, readDammPool });
    const e = await earnings(h);
    assert.equal(e.claims.find((c: { sig: string }) => c.sig === sig).quoteRaw, PAID.toString(), 'after recovery the receipt shows what left its own vault');
    assert.equal(e.totals.claimedThroughApp, PAID.toString());
  });
}

test('M5-R2 reproduces: a receipt whose transaction details are missing marks the claims total incomplete', async () => {
  const h = await harness();
  seedLaunch(h.store, h.platform);
  const sig = await legacyClaim(h, 'CURVE');
  const e = await earnings(h);
  assert.equal(e.claims[0].quoteRaw, null);
  assert.equal(e.totals.incomplete, true, 'an unresolved receipt is counted as 0, so the total must say it is incomplete');
  h.chain.txSummary = async (s) => (s === sig ? claimTx(s, curveVaults) : null);
  const later = await earnings(h);
  assert.deepEqual([later.claims[0].quoteRaw, later.totals.claimedThroughApp, later.totals.incomplete], [PAID.toString(), PAID.toString(), false]);
});

test('M5-R2 reproduces: a transaction without a balance observation for the claim vault is not a zero receipt', async () => {
  const h = await harness();
  seedLaunch(h.store, h.platform);
  await legacyClaim(h, 'CURVE');
  h.chain.txSummary = async (s) => summary(s, { CREATOR_ATA: PAID }); // details served, but nothing about the pool's vaults
  const e = await earnings(h);
  assert.equal(e.claims[0].quoteRaw, null);
  assert.equal(e.totals.incomplete, true);
});

// ------------------------------------------------------------------ new behaviour

test('trade backfill: newer trades keep indexing while a missing one waits in the durable queue', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform);
  const order = ['a', 'b', 'c'];
  const served = new Set(['b', 'c']);
  const chain: LaunchpadChain = { ...h.chain,
    newSignatures: async (_a, until) => order.slice(until ? order.indexOf(until) + 1 : 0).map((signature) => ({ signature, slot: 1, err: false })),
    txSummary: async (sig) => (served.has(sig) ? buy(sig, curveVaults) : null) };
  const d = { store: h.store, chain, poolCache: new PoolCache(chain), now: h.now };
  assert.deepEqual(await syncLaunch(d, h.store.getLaunch(mint)!), { trades: 2 }, 'b and c are indexed; a does not hold them back');
  assert.equal(h.store.getLaunch(mint)!.lastIndexedSig, 'c');
  assert.deepEqual(h.store.listBackfill(mint).map((b) => [b.sig, b.venue, b.status, b.attempts]), [['a', 'CURVE', 'PENDING', 1]]);
  const v = (await h.call(`/api/lp/tokens/${mint}`)).body.token;
  assert.deepEqual(v.history, { complete: false, pending: 1, unavailable: 0 });
  served.add('a');
  h.tick(60_000);
  assert.deepEqual(await syncLaunch(d, h.store.getLaunch(mint)!), { trades: 1 }, 'a is recovered from the queue');
  assert.deepEqual(h.store.listBackfill(mint).map((b) => [b.sig, b.status, b.outcome]), [['a', 'RESOLVED', 'TRADE']]);
  assert.deepEqual((await h.call(`/api/lp/tokens/${mint}`)).body.token.history, { complete: true, pending: 0, unavailable: 0 });
  assert.equal(h.store.listTrades(mint).length, 3);
});

test('trade backfill: a transaction never served is marked UNAVAILABLE, stays visible, and is still recovered if it appears', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform);
  const { BACKFILL } = await import('../src/indexer.ts');
  let served = false;
  const chain: LaunchpadChain = { ...h.chain,
    newSignatures: async (_a, until) => (until ? [] : [{ signature: 'gone', slot: 1, err: false }]),
    txSummary: async (sig) => (served ? buy(sig, curveVaults) : null) };
  const logs: string[] = [];
  const d = { store: h.store, chain, poolCache: new PoolCache(chain), now: h.now, log: (m: string) => logs.push(m) };
  for (let k = 0; k < 40 && h.store.listBackfill(mint)[0]?.status !== 'UNAVAILABLE'; k++) { await syncLaunch(d, h.store.getLaunch(mint)!); h.tick(BACKFILL.maxDelayMs); }
  const [b] = h.store.listBackfill(mint);
  assert.deepEqual([b!.status, b!.attempts], ['UNAVAILABLE', BACKFILL.maxAttempts]);
  assert.match(logs.join('\n'), /gone .*unavailable/i);
  assert.deepEqual((await h.call(`/api/lp/tokens/${mint}`)).body.token.history, { complete: false, pending: 0, unavailable: 1 }, 'never silently complete');
  // still retried, at the slow cadence
  served = true;
  await syncLaunch(d, h.store.getLaunch(mint)!);
  assert.equal(h.store.listTrades(mint).length, 0, 'not due yet');
  h.tick(BACKFILL.unavailableRetryMs);
  await syncLaunch(d, h.store.getLaunch(mint)!);
  assert.equal(h.store.listTrades(mint).length, 1);
  assert.equal(h.store.listBackfill(mint)[0]!.outcome, 'TRADE');
});

test('trade backfill: no duplicate when the app already recorded the trade, and failed or non-trade transactions resolve as such', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform);
  const sums: Record<string, TxSummary> = { dup: buy('dup', curveVaults), failed: summary('failed', { [curveVaults.quote]: 100n, [curveVaults.base]: -5n }, { err: true }),
    claim: claimTx('claim', curveVaults) };
  let up = false;
  const chain: LaunchpadChain = { ...h.chain,
    newSignatures: async (_a, until) => (until ? [] : ['dup', 'failed', 'claim'].map((signature) => ({ signature, slot: 1, err: false }))),
    txSummary: async (sig) => (up ? sums[sig]! : null) };
  const d = { store: h.store, chain, poolCache: new PoolCache(chain), now: h.now };
  await syncLaunch(d, h.store.getLaunch(mint)!);
  h.store.insertTrade({ sig: 'dup', mint, trader: 'T', side: 'BUY', quoteRaw: '100', baseRaw: '5', slot: 7, blockTime: 1, source: 'app' }); // the submit path got it first
  up = true;
  h.tick(60_000);
  assert.deepEqual(await syncLaunch(d, h.store.getLaunch(mint)!), { trades: 0 });
  assert.equal(h.store.listTrades(mint).length, 1);
  assert.deepEqual(h.store.listBackfill(mint).map((b) => [b.sig, b.status, b.outcome]).sort(),
    [['claim', 'RESOLVED', 'NOT_A_TRADE'], ['dup', 'RESOLVED', 'TRADE'], ['failed', 'RESOLVED', 'FAILED_TX']]);
});

test('claim receipts: a claim submitted through the app keeps its own pool and vaults and is resolved from its transaction', async () => {
  const h = await harness();
  const creator = await generateMintKey();
  const mint = seedLaunch(h.store, h.platform, { creator: creator.address });
  const readPool = h.chain.readPool;
  h.chain.readPool = async (p) => { const v = await readPool(p); return v && { ...v, creator: creator.address }; };
  h.chain.txSummary = async (s) => claimTx(s, curveVaults);
  const b = await h.call('/api/lp/claim', { mint, user: creator.address, venue: 'curve' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  h.chain.readPool = async () => { throw new Error('429 Too Many Requests'); }; // the pool is unreadable from here on: the receipt must not need it
  const signed = await addSignature(fromBase64(b.body.transaction), creator.address, creator.privateKey);
  const s = await h.call('/api/lp/submit', { intentId: b.body.intentId, signedTransaction: toBase64(signed) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const c = h.store.getClaim(s.body.signature)!;
  assert.deepEqual([c.venue, c.pool, c.quoteVault, c.baseVault, c.status, c.quoteRaw, c.baseRaw],
    ['CURVE', K.pool.toBase58(), curveVaults.quote, curveVaults.base, 'RESOLVED', PAID.toString(), '0']);
});

test('claim receipts: a DAMM v2 position claim is bound to the DAMM vaults, not the finished curve', async () => {
  const h = await harness();
  const owner = await generateMintKey();
  const mint = seedLaunch(h.store, h.platform, { creator: owner.address, migrated: true });
  h.chain.dammPositions = async (_p, o) => (o === owner.address ? [{ position: 'pos', nftMint: K.positionNft.toBase58(), feeBaseRaw: '0', feeQuoteRaw: '500000', permanentlyLocked: true }] : []);
  h.chain.txSummary = async () => null; // details not served yet at submit time
  const b = await h.call('/api/lp/claim', { mint, user: owner.address, venue: 'damm', nftMint: K.positionNft.toBase58() });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const signed = await addSignature(fromBase64(b.body.transaction), owner.address, owner.privateKey);
  const s = await h.call('/api/lp/submit', { intentId: b.body.intentId, signedTransaction: toBase64(signed) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  let c = h.store.getClaim(s.body.signature)!;
  assert.deepEqual([c.venue, c.pool, c.quoteVault, c.baseVault, c.status, c.evidence, c.quoteRaw],
    ['DAMM_V2', K.dammPool.toBase58(), dammVaults.quote, dammVaults.base, 'UNKNOWN', 'NO_TX_DETAILS', null]);
  let e = await earnings(h);
  assert.deepEqual([e.totals.coverage.claimsComplete, e.totals.coverage.unresolvedClaims, e.totals.claimedThroughApp], [false, 1, '0']);
  // a curve outflow in the same transaction is not this claim's evidence
  h.chain.txSummary = async (sig) => summary(sig, { [curveVaults.quote]: -PAID, [curveVaults.base]: 0n });
  e = await earnings(h);
  assert.equal(h.store.getClaim(s.body.signature)!.status, 'UNKNOWN');
  h.chain.txSummary = async (sig) => claimTx(sig, dammVaults, 500_000n);
  e = await earnings(h);
  c = h.store.getClaim(s.body.signature)!;
  assert.deepEqual([c.status, c.quoteRaw, e.totals.coverage.claimsComplete, e.totals.claimedThroughApp], ['RESOLVED', '500000', true, '500000']);
});

test('claim receipts: a zero is stored only with complete evidence, and resolution survives a restart', async () => {
  const h = await harness();
  seedLaunch(h.store, h.platform);
  const zero = await legacyClaim(h, 'CURVE', 'claim-zero');
  const later = await legacyClaim(h, 'CURVE', 'claim-later');
  h.chain.txSummary = async (s) => (s === zero ? claimTx(s, curveVaults, 0n) : null);
  const e = await earnings(h);
  assert.deepEqual([h.store.getClaim(zero)!.status, h.store.getClaim(zero)!.quoteRaw], ['RESOLVED', '0'], 'both vaults observed, nothing left them: a real zero');
  assert.deepEqual([h.store.getClaim(later)!.status, h.store.getClaim(later)!.quoteRaw], ['UNKNOWN', null]);
  assert.deepEqual([e.totals.coverage.unclaimedComplete, e.totals.coverage.claimsComplete, e.totals.coverage.unresolvedClaims, e.totals.incomplete], [true, false, 1, true]);
  h.store.close();
  const reopened = new LaunchpadStore(h.dbPath);
  try {
    assert.deepEqual([reopened.getClaim(zero)!.status, reopened.getClaim(zero)!.quoteRaw], ['RESOLVED', '0']);
    assert.deepEqual([reopened.getClaim(later)!.status, reopened.getClaim(later)!.pool], ['UNKNOWN', K.pool.toBase58()], 'the identity was persisted');
    const { resolveClaims } = await import('../src/receipts.ts');
    await resolveClaims({ store: reopened, chain: { ...h.chain, txSummary: async (s: string) => claimTx(s, curveVaults) } }, 5);
    assert.deepEqual([reopened.getClaim(later)!.status, reopened.getClaim(later)!.quoteRaw], ['RESOLVED', PAID.toString()]);
  } finally { reopened.close(); }
});

test('claim receipts: evidence rules (failed transaction, vault not in the transaction, money flowing into a vault)', async () => {
  const { claimReceipt } = await import('../src/receipts.ts');
  const id = { quoteVault: 'QV', baseVault: 'BV' };
  assert.deepEqual(claimReceipt(id, null), { status: 'UNKNOWN', evidence: 'NO_TX_DETAILS', quoteRaw: null, baseRaw: null });
  assert.deepEqual(claimReceipt(id, summary('s', { QV: -5n, BV: 0n })), { status: 'RESOLVED', evidence: 'TX_VAULT_DELTAS', quoteRaw: '5', baseRaw: '0' });
  assert.deepEqual(claimReceipt(id, summary('s', { QV: -5n, BV: 0n }, { err: true })), { status: 'FAILED_TX', evidence: 'TX_FAILED', quoteRaw: '0', baseRaw: '0' });
  assert.equal(claimReceipt(id, summary('s', { QV: -5n })).evidence, 'VAULT_NOT_IN_TX');
  assert.equal(claimReceipt(id, summary('s', { QV: -5n }, { keys: ['QV', 'BV'] })).evidence, 'NO_BALANCE_OBSERVATION');
  assert.equal(claimReceipt(id, summary('s', { QV: 5n, BV: 0n })).evidence, 'VAULT_INFLOW');
  assert.equal(claimReceipt({ quoteVault: null, baseVault: null }, summary('s', { QV: -5n, BV: 0n })).evidence, 'NO_VAULT_IDENTITY');
});

test('claim receipts: store migration 4 re-checks every earlier receipt against its own vaults instead of trusting it', async () => {
  const { STORE_MIGRATIONS } = await import('../src/store.ts');
  const path = join(dir, 'v3.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (let v = 1; v <= 3; v++) { db.exec(STORE_MIGRATIONS[v - 1]!); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(v, 'then'); }
  db.prepare(`INSERT INTO launches (mint, pool, config, quote_mint, creator, name, symbol, description, metadata_uri, status, created_at)
    VALUES (?, ?, 'cfg', ?, ?, 'MOCK', 'MOCK', '', 'u', 'LIVE', 'then')`).run(K.baseMint.toBase58(), K.pool.toBase58(), K.quoteMint.toBase58(), K.creator.toBase58());
  db.prepare("INSERT INTO claims (sig, mint, venue, claimer, quote_raw, base_raw, at) VALUES ('old-zero', ?, 'CURVE', ?, '0', '0', 'then')").run(K.baseMint.toBase58(), K.creator.toBase58());
  db.close();
  const s = new LaunchpadStore(path);
  try {
    const c = s.getClaim('old-zero')!;
    assert.deepEqual([c.status, c.quoteRaw, c.legacyQuoteRaw, c.pool], ['UNKNOWN', null, '0', null], 'the old zero is kept for the record but no longer counted');
    const { resolveClaims } = await import('../src/receipts.ts');
    await resolveClaims({ store: s, chain: { txSummary: async (sig: string) => claimTx(sig, curveVaults) } }, 5);
    assert.deepEqual([s.getClaim('old-zero')!.status, s.getClaim('old-zero')!.evidence], ['UNKNOWN', 'NO_VAULT_IDENTITY'], 'no confirmed intent: no identity, so still unknown');
  } finally { s.close(); }
});
