// Platform treasury over the launchpad API (milestone 7). TEST_ONLY: synthetic chain reads, a Squads double that
// advances proposals when a member transaction is "sent", member keys generated in-process. No network, no real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addSignature, bindTransactionToTerms, decodeTransactionBytes, fromBase64, generateMintKey, squads, toBase64 } from '@project-qf/tx';
import { K } from '../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import { storedVaultTransaction } from '../../../packages/adapter-meteora-dbc/test/support/treasury.ts';
import { proposeTransaction, partnerCurveClaim } from '@project-qf/adapter-meteora-dbc/treasury';
import { harness, seedLaunch } from './support/harness.ts';
import { syncLaunch } from '../src/indexer.ts';
import { vaultCheck } from '../src/books.ts';

type H = Awaited<ReturnType<typeof harness>>;
type Member = Awaited<ReturnType<typeof generateMintKey>>;

/** Turns the harness platform into a treasury platform: the current config pays the vault, the earlier one the operator. */
async function withTreasury(h: H) {
  const members = [await generateMintKey(), await generateMintKey(), await generateMintKey()];
  const multisig = await squads.squadsMultisig(K.leftover.toBase58()); // any create key: synthetic
  const vault = await squads.squadsVault(multisig, 0);
  Object.assign(h.tre, { multisig, vault, members: members.map((m) => m.address) });
  h.platform.legacyConfigs = [{ ...h.platform.config, config: K.attacker.toBase58(), feeClaimer: K.partner.toBase58() }];
  h.platform.config = { ...h.platform.config, feeClaimer: vault, leftoverReceiver: vault };
  h.platform.treasury = { multisig, vault, createKey: K.leftover.toBase58(), threshold: 2, members: members.map((m) => m.address), signature: 'x', createdAt: new Date().toISOString(), label: 'DEVNET_STAND_IN' };
  return { members, multisig, vault };
}
async function signSubmit(h: H, built: any, m: Member) {
  const signed = await addSignature(fromBase64(built.transaction), m.address, m.privateKey);
  return h.call('/api/lp/submit', { intentId: built.intentId, signedTransaction: toBase64(signed) });
}

test('[TEST_ONLY] a platform fee claim goes propose (with the proposer\'s approval) -> second approval -> execute, and the receipt is the vault\'s', async () => {
  const h = await harness();
  const { members: [m1, m2, m3], vault } = await withTreasury(h);
  const mint = seedLaunch(h.store, h.platform);

  const t0 = await h.call('/api/lp/treasury');
  assert.equal(t0.status, 200);
  assert.equal(t0.body.treasury.threshold, 2);
  assert.equal(t0.body.claimable[0].curve.quoteRaw, '1000000');

  const p = await h.call('/api/lp/treasury/propose', { mint, venue: 'curve', member: m1!.address });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.terms.kind, 'TREASURY_PROPOSE');
  assert.equal(p.body.terms.inner.receiver, vault);
  // what the member would check before signing: the transaction binds to its terms
  assert.deepEqual(await bindTransactionToTerms(decodeTransactionBytes(fromBase64(p.body.transaction)), p.body.terms), []);
  assert.equal((await signSubmit(h, p.body, m1!)).status, 200);
  const index = p.body.transactionIndex;
  let row = h.store.getTreasuryProposal(h.tre.multisig, index)!;
  assert.deepEqual([row.status, row.approvals], ['Active', [m1!.address]]);

  assert.equal((await h.call('/api/lp/treasury/execute', { transactionIndex: index, member: m2!.address })).body.error.code, 'NOT_APPROVED');
  assert.equal((await h.call('/api/lp/treasury/approve', { transactionIndex: index, member: m1!.address })).body.error.code, 'ALREADY_APPROVED');

  const a = await h.call('/api/lp/treasury/approve', { transactionIndex: index, member: m2!.address });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.inner.kind, 'CLAIM_PARTNER_TRADING_FEE');
  assert.equal((await signSubmit(h, a.body, m2!)).status, 200);
  assert.equal(h.store.getTreasuryProposal(h.tre.multisig, index)!.status, 'Approved');

  const e = await h.call('/api/lp/treasury/execute', { transactionIndex: index, member: m3!.address });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const ex = await signSubmit(h, e.body, m3!);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  row = h.store.getTreasuryProposal(h.tre.multisig, index)!;
  assert.equal(row.status, 'Executed'); assert.equal(row.executeSig, ex.body.signature); assert.equal(row.executedBy, m3!.address);

  const c = h.store.getClaim(ex.body.signature)!;
  assert.equal(c.claimer, vault); assert.equal(c.venue, 'CURVE'); assert.equal(c.pool, K.pool.toBase58()); assert.equal(c.quoteVault, K.quoteVault.toBase58());
  assert.equal(c.status, 'UNKNOWN', 'no transaction details in the double: the receipt waits for evidence, never a zero');
  const b = await h.books();
  assert.equal(b.coins[0].platformWallet, vault); assert.equal(b.coins[0].treasury, true);
  assert.equal(b.claims[0].byTreasury, true);
  assert.equal(b.treasury.unresolvedReceipts, 1); assert.equal(b.treasury.paidToTreasuryQuoteRaw, '0');
});

test('[TEST_ONLY] treasury routes refuse non-members, legacy coins and a stored transaction that is not the proposed claim', async () => {
  const h = await harness();
  const { members: [m1, m2, m3], vault, multisig } = await withTreasury(h);
  const mint = seedLaunch(h.store, h.platform);
  const outsider = await generateMintKey();
  assert.equal((await h.call('/api/lp/treasury/propose', { mint, venue: 'curve', member: outsider.address })).body.error.code, 'NOT_A_MEMBER');

  const p = await h.call('/api/lp/treasury/propose', { mint, venue: 'curve', member: m1!.address });
  await signSubmit(h, p.body, m1!);
  const a = await h.call('/api/lp/treasury/approve', { transactionIndex: p.body.transactionIndex, member: m2!.address });
  await signSubmit(h, a.body, m2!);
  // what the multisig stored differs from what this app proposed (here: a claim with other amounts than the approved terms)
  const pool = (await h.chain.readPool(K.pool.toBase58()))!;
  const evil = proposeTransaction({ multisig, member: m1!.address, transactionIndex: BigInt(p.body.transactionIndex),
    claim: await partnerCurveClaim(h.conn, { ...pool, partnerQuoteFee: '999' }, vault) });
  h.tre.proposals.get(p.body.transactionIndex)!.stored = storedVaultTransaction(evil.tx.instructions[0]!, { multisig, creator: m1!.address, index: BigInt(p.body.transactionIndex) });
  const e = await h.call('/api/lp/treasury/execute', { transactionIndex: p.body.transactionIndex, member: m3!.address });
  assert.equal(e.body.error.code, 'STORED_TRANSACTION_MISMATCH');
  assert.ok(e.body.error.details.some((x: string) => x.startsWith('STORED_INNER_')), JSON.stringify(e.body.error.details));

  // a coin on the earlier config: its platform fees belong to the operator wallet, not the treasury
  h.store.db.prepare('UPDATE launches SET config = ? WHERE mint = ?').run(K.attacker.toBase58(), mint);
  assert.equal((await h.call('/api/lp/treasury/propose', { mint, venue: 'curve', member: m1!.address })).body.error.code, 'NOT_TREASURY_COIN');
  const b = await h.books();
  assert.equal(b.coins[0].platformWallet, K.partner.toBase58()); assert.equal(b.coins[0].treasury, false);
  assert.ok(vault);
});

test('[TEST_ONLY] a treasury receipt is counted once: in claimed-through-the-app, in paid-to-treasury, against the vault balance and against the trades\' platform share', async () => {
  const h = await harness();
  const { members: [m1, m2, m3], vault } = await withTreasury(h);
  const mint = seedLaunch(h.store, h.platform);
  const quote = h.platform.quote.mint;
  // fees accrue: one trade whose platform share (1.000000) is everything the pool's partner counter holds
  h.store.insertTrade({ sig: 'trade-1', mint, trader: m1!.address, side: 'BUY', quoteRaw: '100000000', baseRaw: '1', slot: 1, blockTime: 1, source: 'app',
    fees: { venue: 'CURVE', status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: '2500000', protocolRaw: '500000', referralRaw: '0', creatorRaw: '1000000', platformRaw: '1000000', lpRaw: null, compoundingRaw: null } });
  let vaultHolds = 0n;
  h.chain.balances = async (owner, mints) => ({ lamports: '0', tokens: owner === vault ? Object.fromEntries(mints.map((m) => [m, m === quote ? vaultHolds.toString() : '0'])) : {} });
  const before = await h.books();
  assert.deepEqual([before.coins[0].checks.platformCurve.status, before.coins[0].checks.platformCurve.onChainRaw, before.treasury.vaultCheck.status], ['MATCH', '1000000', 'MATCH']);

  // the required approvals: m1 proposes (and approves), m2 approves, m3 executes
  const p = await h.call('/api/lp/treasury/propose', { mint, venue: 'curve', member: m1!.address });
  await signSubmit(h, p.body, m1!);
  const index = p.body.transactionIndex;
  await signSubmit(h, (await h.call('/api/lp/treasury/approve', { transactionIndex: index, member: m2!.address })).body, m2!);
  const e = await h.call('/api/lp/treasury/execute', { transactionIndex: index, member: m3!.address });
  const signed = toBase64(await addSignature(fromBase64(e.body.transaction), m3!.address, m3!.privateKey));
  const ex = await h.call('/api/lp/submit', { intentId: e.body.intentId, signedTransaction: signed });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  const sig = ex.body.signature as string;

  // the chain after the execution: the pool's partner counter is empty, the claim's own transaction moved 1.000000 from
  // the pool's quote vault, and the vault holds exactly that
  const claim = h.store.getClaim(sig)!;
  const readPool = h.chain.readPool;
  h.chain.readPool = async (x) => { const r = await readPool(x); return r && { ...r, partnerQuoteFee: '0' }; };
  h.app.poolCache.invalidate(K.pool.toBase58()); // the double changed under the cache; on chain the app re-reads after execution
  const summary = { signature: sig, slot: 5, blockTime: 5, err: false, feePayer: m3!.address, accountKeys: [claim.quoteVault!, claim.baseVault!, vault],
    tokenDeltas: { [claim.quoteVault!]: -1_000_000n, [claim.baseVault!]: 0n }, logMessages: [] };
  h.chain.txSummary = async (s) => (s === sig ? summary : null);
  vaultHolds = 1_000_000n;

  // the same execution reaching the app again: a second submit of the same signed transaction, and the indexer finding it
  // in the pool's history. Neither adds a receipt or a trade.
  const again = await h.call('/api/lp/submit', { intentId: e.body.intentId, signedTransaction: signed });
  assert.notEqual(again.status, 200);
  h.chain.newSignatures = async () => [{ signature: sig, slot: 5, err: false }];
  assert.equal((await syncLaunch({ store: h.store, chain: h.chain, poolCache: h.app.poolCache }, h.store.getLaunch(mint)!)).trades, 0, 'a fee claim is not a trade');

  const after = await h.books();
  assert.equal(after.claims.length, 1);
  assert.deepEqual([after.claims[0].status, after.claims[0].quoteRaw, after.claims[0].byTreasury], ['RESOLVED', '1000000', true]);
  assert.equal(after.totals.claimedThroughApp, '1000000', 'the receipt is in the app-wide claimed total once');
  assert.equal(after.treasury.paidToTreasuryQuoteRaw, '1000000');
  assert.equal(after.treasury.includedIn, 'claimedThroughApp', 'paid-to-treasury is part of that total, not added to it');
  assert.deepEqual([after.treasury.vaultCheck.status, after.treasury.vaultCheck.vaultQuoteRaw, after.treasury.vaultCheck.receiptsRaw], ['MATCH', '1000000', '1000000']);
  const pc = after.coins[0].checks.platformCurve;
  assert.equal(after.coins[0].curve.platformQuoteRaw, '0', 'nothing left in the pool');
  assert.deepEqual([pc.status, pc.fromTradesRaw, pc.claimedRaw, pc.onChainRaw, pc.differenceRaw], ['MATCH', '1000000', '1000000', '1000000', '0'],
    'from trades = still in the pool (0) + claimed (1.000000), the receipt counted once');
  assert.equal(after.coins[0].fromTrades.trades, 1);
});

test('the vault check: equal is MATCH, any difference says which way, missing evidence is never a match', () => {
  assert.equal(vaultCheck(5n, 5n, 0).status, 'MATCH');
  const more = vaultCheck(7n, 5n, 0), less = vaultCheck(3n, 5n, 0);
  assert.deepEqual([more.status, more.differenceRaw], ['MISMATCH', '2']); assert.match(more.reasons[0]!, /more than/);
  assert.deepEqual([less.status, less.differenceRaw], ['MISMATCH', '2']); assert.match(less.reasons[0]!, /less than/);
  assert.equal(vaultCheck(null, 5n, 0).status, 'INCOMPLETE');
  assert.equal(vaultCheck(5n, 5n, 1).status, 'INCOMPLETE', 'an unproven receipt leaves the check open');
});

test('the vault check: proven rewards deposits left the vault, so the vault holds receipts minus deposits', () => {
  const ok = vaultCheck(3n, 5n, 0, 2n);
  assert.deepEqual([ok.status, ok.differenceRaw, ok.depositsOutRaw], ['MATCH', '0', '2']);
  assert.equal(vaultCheck(5n, 5n, 0, 2n).status, 'MISMATCH', 'a deposit that left must not be counted as still there');
  assert.equal(vaultCheck(3n, 5n, 0, 2n, 1).status, 'INCOMPLETE', 'a deposit whose own transaction is not read leaves the check open');
});

test('[TEST_ONLY] a coin on the earlier config is legacy, and the test treasury says it is not separation of control', async () => {
  const h = await harness();
  await withTreasury(h);
  const mint = seedLaunch(h.store, h.platform);
  const t = (await h.call('/api/lp/treasury')).body.treasury;
  assert.deepEqual([t.separationOfControl, t.signers, t.threshold], [false, 'ONE_OPERATOR_TEST_KEYS', 2]);
  assert.match(t.note, /held by one operator/); assert.match(t.note, /not separation of control/);
  assert.equal((await h.books()).coins[0].configRole, 'CURRENT');
  h.store.db.prepare('UPDATE launches SET config = ? WHERE mint = ?').run(K.attacker.toBase58(), mint);
  const b = await h.books();
  assert.deepEqual([b.coins[0].configRole, b.coins[0].treasury, b.coins[0].platformWallet], ['LEGACY', false, K.partner.toBase58()]);
  assert.equal(b.treasury.separationOfControl, false);
});

test('only the member signer loads member keys: the server process has no path to them', () => {
  for (const f of ['../src/server.ts', '../src/main.ts', '../src/chain.ts', '../src/indexer.ts', '../src/platform.ts', '../src/books.ts', '../src/verify.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/signAsMember|member-\$\{|member-[123]\.json|QF_TREASURY_DIR/.test(src), `${f} must not load or sign with member keys`);
  }
  const member = readFileSync(new URL('../src/member.ts', import.meta.url), 'utf8');
  assert.match(member, /signAsMember/);
  assert.match(member, /bindStoredVaultTransaction/);
});
