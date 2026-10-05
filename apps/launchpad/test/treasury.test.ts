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
  const earn = await h.call('/api/lp/earnings?fresh=1');
  assert.equal(earn.body.coins[0].platformWallet, vault); assert.equal(earn.body.coins[0].treasury, true);
  assert.equal(earn.body.claims[0].byTreasury, true);
  assert.equal(earn.body.treasury.unresolvedReceipts, 1); assert.equal(earn.body.treasury.paidToTreasuryQuoteRaw, '0');
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
  const earn = await h.call('/api/lp/earnings?fresh=1');
  assert.equal(earn.body.coins[0].platformWallet, K.partner.toBase58()); assert.equal(earn.body.coins[0].treasury, false);
  assert.ok(vault);
});

test('only the member signer loads member keys: the server process has no path to them', () => {
  for (const f of ['../src/server.ts', '../src/main.ts', '../src/chain.ts', '../src/indexer.ts', '../src/platform.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/signAsMember|member-\$\{|member-[123]\.json|QF_TREASURY_DIR/.test(src), `${f} must not load or sign with member keys`);
  }
  const member = readFileSync(new URL('../src/member.ts', import.meta.url), 'utf8');
  assert.match(member, /signAsMember/);
  assert.match(member, /bindStoredVaultTransaction/);
});
