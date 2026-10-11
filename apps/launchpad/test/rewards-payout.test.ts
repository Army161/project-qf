// Holder rewards, devnet test round, over the launchpad API. TEST_ONLY: a synthetic holder ledger and rewards-vault
// history served by the harness (slot = unix second), a Squads double that advances proposals when a member transaction
// is "sent", member keys generated in-process. No network, no real keys, no real funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSignature, bindTransactionToTerms, decodeTransactionBytes, derive, fromBase64, generateMintKey, PROGRAM_IDS, rewardsMemo, squads, toBase64 } from '@project-qf/tx';
import { K } from '../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import { harness, seedLaunch } from './support/harness.ts';
import { syncAllHolders } from '../src/holders.ts';
import { PoolCache } from '../src/indexer.ts';
import { DBC_POOL_AUTHORITY, settlementOf, type RewardEpoch } from '../src/rewards.ts';
import { classifyVaultTx, syncRewardsVault } from '../src/rewards-vault.ts';

type H = Awaited<ReturnType<typeof harness>>;
type Member = Awaited<ReturnType<typeof generateMintKey>>;
const A = 'CBG61DYreVbVXtsHFJ7j63fam81zAEnyc5LKz59SWUsb', B = '8RKJVqkE8EGWLfghbXUAe1JhgEN2Z9eEX4EJ8xXdnAYG';
const DAY = 86_400;

async function setup() {
  const h = await harness();
  const members = [await generateMintKey(), await generateMintKey(), await generateMintKey()];
  const multisig = await squads.squadsMultisig(K.leftover.toBase58());
  const vault = await squads.squadsVault(multisig, 0), rewards = await squads.squadsVault(multisig, 1);
  Object.assign(h.tre, { multisig, vault, members: members.map((m) => m.address) });
  h.platform.treasury = { multisig, vault, createKey: K.leftover.toBase58(), threshold: 2, members: members.map((m) => m.address), signature: 'x', createdAt: new Date().toISOString(), label: 'DEVNET_STAND_IN' };
  const quote = h.platform.quote.mint;
  const rewardsAta = await derive.ata(rewards, quote, PROGRAM_IDS.TOKEN);
  const nowSec = Math.floor(h.now().getTime() / 1000), today = Math.floor(nowSec / DAY) * DAY;
  const mint = seedLaunch(h.store, h.platform, { liveAt: new Date((today + 10) * 1000).toISOString() });
  const tx = (signature: string, slot: number, balances: [string, string, bigint, bigint, string?][], memos: string[] = []) =>
    ({ signature, slot, blockTime: slot, err: false, memos, balances: balances.map(([account, owner, preRaw, postRaw, m]) => ({ account, owner, preRaw, postRaw, mint: m ?? mint })) });
  const add = (t: ReturnType<typeof tx>, accounts: string[]) => {
    h.holders.txs.set(t.signature, t);
    for (const a of accounts) h.holders.sigs.set(a, [...(h.holders.sigs.get(a) ?? []), { signature: t.signature, slot: t.slot, err: false }]);
  };
  add(tx('create', today + 20, [['vault', DBC_POOL_AUTHORITY, 0n, 1000n]]), ['vault']);
  add(tx('buy', today + 30, [['vault', DBC_POOL_AUTHORITY, 1000n, 700n], ['ataA', A, 0n, 300n]]), ['vault', 'ataA']);
  add(tx('send', today + 40, [['ataA', A, 300n, 100n], ['ataB', B, 0n, 200n]]), ['ataA', 'ataB']);
  h.holders.accounts = [{ account: 'ataA', owner: A, amountRaw: 100n }, { account: 'ataB', owner: B, amountRaw: 200n }, { account: 'vault', owner: DBC_POOL_AUTHORITY, amountRaw: 700n }];
  h.holders.slot = nowSec;
  // the buy paid 1000 raw of platform fees today: today's earmark is 500
  h.store.insertTrade({ sig: 'buy', mint, trader: A, side: 'BUY', quoteRaw: '30', baseRaw: '300', slot: today + 30, blockTime: today + 30, source: 'indexer' });
  h.store.setTradeFees('buy', { venue: 'CURVE', status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: '2500', protocolRaw: '500', referralRaw: '0', creatorRaw: '1000', platformRaw: '1000', lpRaw: null, compoundingRaw: null });
  const held = new Map<string, bigint>([[vault, 1_000_000n]]);
  h.chain.balances = async (owner) => ({ lamports: '0', tokens: { [quote]: (held.get(owner) ?? 0n).toString() } });
  const d = { store: h.store, chain: h.chain, poolCache: new PoolCache(h.chain), now: h.now };
  const sync = async () => { h.holders.slot = Math.floor(h.now().getTime() / 1000); await syncAllHolders(d); await syncRewardsVault(d, h.platform); };
  return { h, members, vault, rewards, rewardsAta, quote, mint, today, epoch: new Date(today * 1000).toISOString().slice(0, 10), held, tx, add, sync };
}
async function signSubmit(h: H, built: any, m: Member) {
  const signed = await addSignature(fromBase64(built.transaction), m.address, m.privateKey);
  return h.call('/api/lp/submit', { intentId: built.intentId, signedTransaction: toBase64(signed) });
}
/** propose (signed by m1), approve (m2), execute (m3) through the API; returns the execute signature */
async function run2of3(h: H, built: any, [m1, m2, m3]: Member[]) {
  assert.deepEqual(await bindTransactionToTerms(decodeTransactionBytes(fromBase64(built.transaction)), built.terms), []);
  assert.equal((await signSubmit(h, built, m1!)).status, 200);
  const index = built.transactionIndex;
  assert.equal((await h.call('/api/lp/treasury/execute', { transactionIndex: index, member: m3!.address })).body.error.code, 'NOT_APPROVED');
  const a = await h.call('/api/lp/treasury/approve', { transactionIndex: index, member: m2!.address });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal((await signSubmit(h, a.body, m2!)).status, 200);
  const e = await h.call('/api/lp/treasury/execute', { transactionIndex: index, member: m3!.address });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const ex = await signSubmit(h, e.body, m3!);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(h.store.getTreasuryProposal(h.tre.multisig, index)!.status, 'Executed');
  return ex.body.signature as string;
}

test('[TEST_ONLY] rewards round: deposit up to the earmark, read back from the vault, final epoch, payout of the frozen allocation, settlement PAID', async () => {
  const s = await setup();
  const { h, members, mint, epoch } = s;
  const [m1] = members;
  await s.sync();

  // a deposit is capped by the running epoch's earmark and by what the treasury holds, and only a member may propose
  const dep = (p: Record<string, unknown>) => h.call('/api/lp/rewards/deposit', { member: m1!.address, mint, epochId: epoch, amountRaw: '500', ...p });
  assert.equal((await dep({ amountRaw: '501' })).body.error.code, 'OVER_EARMARK');
  assert.equal((await dep({ epochId: '2026-01-01' })).body.error.code, 'NOT_FOUND');
  assert.equal((await dep({ member: K.attacker.toBase58() })).body.error.code, 'NOT_A_MEMBER');
  s.held.set(s.vault, 100n);
  assert.equal((await dep({})).body.error.code, 'TREASURY_SHORT');
  s.held.set(s.vault, 1_000_000n);
  const p = await dep({});
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.terms.inner.kind, 'REWARDS_DEPOSIT');
  assert.equal(p.body.terms.inner.from, s.vault); assert.equal(p.body.terms.inner.to, s.rewards);
  assert.deepEqual(h.quoteAccountCalls.at(-1), [s.rewards], 'the rewards vault\'s quote account is created if missing');
  const depSig = await run2of3(h, p.body, members);
  assert.equal(h.store.listClaims().length, 0, 'a rewards transfer is not a fee claim');

  // nothing counts until the vault's own transaction is read: the executed proposal alone funds nothing
  let o = await h.call(`/api/lp/rewards/${mint}?fresh=1`);
  assert.equal(o.body.coins[0].epochs.at(-1).funding.fundedRaw, '0');
  s.add(s.tx(depSig, Math.floor(h.now().getTime() / 1000), [[s.rewardsAta, s.rewards, 0n, 500n, s.quote], ['tv', s.vault, 1_000_000n, 999_500n, s.quote]],
    [rewardsMemo({ kind: 'REWARDS_DEPOSIT', launchMint: mint, epochId: epoch })]), [s.rewardsAta]);
  h.tick(5_000);
  await s.sync();
  o = await h.call(`/api/lp/rewards/${mint}?fresh=1`);
  const open = o.body.coins[0].epochs.at(-1);
  assert.equal(open.status, 'OPEN');
  assert.deepEqual([open.funding.fundedRaw, open.funding.deposits[0].sig], ['500', depSig]);
  assert.equal(o.body.rewardsVault.vault, s.rewards);
  // a payout is refused while the epoch is running
  assert.equal((await h.call('/api/lp/rewards/payout', { member: m1!.address, mint, epochId: epoch })).body.error.code, 'EPOCH_NOT_FINAL');

  // the day ends; history and the vault are read past its end: the epoch is final and frozen, allocating the 500
  h.tick((s.today + DAY + 120) * 1000 - h.now().getTime());
  await s.sync();
  o = await h.call(`/api/lp/rewards/${mint}?fresh=1`);
  const fin = o.body.coins[0].epochs.find((e: any) => e.epochId === epoch);
  assert.equal(fin.status, 'FINAL', JSON.stringify(fin.reasons));
  assert.equal(fin.settlement.status, 'NOT_PAID');
  const detail = (await h.call(`/api/lp/rewards/${mint}/${epoch}`)).body;
  const due = detail.epoch.payouts.map((x: any) => ({ owner: x.owner, amountRaw: x.amountRaw }));
  assert.deepEqual(due.map((x: any) => x.owner).sort(), [A, B].sort());
  assert.ok(due.reduce((t: bigint, x: any) => t + BigInt(x.amountRaw), 0n) <= 500n);

  // the owner approved one devnet test round: with another coin's payout already proposed, this one is refused, and a
  // cancelled proposal does not use up the round
  s.held.set(s.rewards, 500n);
  const other = { multisig: h.tre.multisig, txIndex: '99', mint: K.baseMint.toBase58(), venue: 'REWARDS_PAYOUT' as const, proposer: m1!.address, proposeSig: 'earlier',
    innerJson: JSON.stringify({ kind: 'REWARDS_PAYOUT', launchMint: K.baseMint.toBase58(), epochId: '2026-01-01' }), approvals: [], status: 'Active', createdAt: h.now().toISOString() };
  h.store.insertTreasuryProposal(other);
  assert.equal((await h.call('/api/lp/rewards/payout', { member: m1!.address, mint, epochId: epoch })).body.error.code, 'ROUND_LIMIT');
  h.store.updateTreasuryProposal(other.multisig, other.txIndex, { status: 'Cancelled', approvals: [] });

  // the payout pays exactly the frozen allocation, from the rewards vault, tagged with the frozen record's hash
  const pay = await h.call('/api/lp/rewards/payout', { member: m1!.address, mint, epochId: epoch });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  assert.equal(pay.body.terms.vaultIndex, 1);
  assert.equal(pay.body.terms.inner.from, s.rewards);
  assert.equal(pay.body.terms.inner.artifactHash, fin.frozen.hash);
  assert.deepEqual(pay.body.terms.inner.payouts, due);
  assert.deepEqual(h.quoteAccountCalls.at(-1), due.map((x: any) => x.owner));
  const paySig = await run2of3(h, pay.body, members);
  // one round only, and never twice for the same epoch
  assert.equal((await h.call('/api/lp/rewards/payout', { member: m1!.address, mint, epochId: epoch })).body.error.code, 'ALREADY_PROPOSED');

  // read back from the vault: every recipient got exactly the allocation
  s.add(s.tx(paySig, Math.floor(h.now().getTime() / 1000), [[s.rewardsAta, s.rewards, 500n, 500n - due.reduce((t: bigint, x: any) => t + BigInt(x.amountRaw), 0n), s.quote],
    ...due.map((x: any, i: number) => [`q${i}`, x.owner, 0n, BigInt(x.amountRaw), s.quote] as [string, string, bigint, bigint, string])],
    [rewardsMemo({ kind: 'REWARDS_PAYOUT', launchMint: mint, epochId: epoch, artifactHash: fin.frozen.hash })]), [s.rewardsAta]);
  h.tick(5_000);
  await s.sync();
  await h.call(`/api/lp/rewards/${mint}?fresh=1`); // the epoch views are kept for 30 seconds; refresh them
  const paid = (await h.call(`/api/lp/rewards/${mint}/${epoch}`)).body.epoch;
  assert.equal(paid.settlement.status, 'PAID', JSON.stringify(paid.settlement));
  assert.deepEqual(paid.settlement.txs.map((t: any) => t.sig), [paySig]);
  assert.equal(paid.frozen.reproduced, true, 'paying does not change the frozen record');

  // each holder's "My coins" page lists what reached them, read from the payout's own transaction
  for (const x of due) {
    const me = (await h.call(`/api/lp/me?wallet=${x.owner}`)).body;
    assert.deepEqual(me.rewardsPaid.map((r: any) => [r.mint, r.epochId, r.amountRaw, r.sig]), [[mint, epoch, x.amountRaw, paySig]]);
  }
  // the books count the deposit as having left the treasury vault
  assert.equal((await h.books()).treasury.vaultCheck.depositsOutRaw, '500');
});

test('[TEST_ONLY] rewards vault: classification from balances and memo; late and untagged deposits fund nothing', () => {
  const acct = 'vaultAta', q = 'quote', M = K.baseMint.toBase58();
  const b = (account: string, owner: string, pre: bigint, post: bigint) => ({ account, owner, mint: q, preRaw: pre, postRaw: post });
  assert.equal(classifyVaultTx(acct, q, { balances: [b(acct, 'v', 0n, 5n)], memos: [rewardsMemo({ kind: 'REWARDS_DEPOSIT', launchMint: M, epochId: '2026-10-05' })] }).kind, 'DEPOSIT');
  assert.equal(classifyVaultTx(acct, q, { balances: [b(acct, 'v', 0n, 5n)], memos: [] }).kind, 'UNTAGGED');
  assert.equal(classifyVaultTx(acct, q, { balances: [b(acct, 'v', 0n, 5n)], memos: ['qf-rewards-deposit@1 mint=x epoch=y'] }).kind, 'UNTAGGED');
  // a payout memo on an incoming transfer is not a payout, and a deposit memo on an outgoing one is not a deposit
  assert.equal(classifyVaultTx(acct, q, { balances: [b(acct, 'v', 0n, 5n)], memos: [rewardsMemo({ kind: 'REWARDS_PAYOUT', launchMint: M, epochId: '2026-10-05', artifactHash: 'a'.repeat(64) })] }).kind, 'UNTAGGED');
  assert.equal(classifyVaultTx(acct, q, { balances: [b(acct, 'v', 5n, 0n)], memos: [rewardsMemo({ kind: 'REWARDS_DEPOSIT', launchMint: M, epochId: '2026-10-05' })] }).kind, 'UNTAGGED');
  const p = classifyVaultTx(acct, q, { balances: [b(acct, 'v', 9n, 2n), b('r1', A, 0n, 4n), b('r2', B, 1n, 4n)], memos: [rewardsMemo({ kind: 'REWARDS_PAYOUT', launchMint: M, epochId: '2026-10-05', artifactHash: 'a'.repeat(64) })] });
  assert.deepEqual([p.kind, p.deltaRaw, JSON.parse(p.transfersJson!)], ['PAYOUT', '-7', [{ owner: A, amountRaw: '4' }, { owner: B, amountRaw: '3' }]]);
  assert.equal(classifyVaultTx(acct, q, { balances: [b('other', 'x', 0n, 5n)], memos: [] }).kind, 'NONE');
});

test('[TEST_ONLY] settlement: paid exactly is PAID; more, to someone else, or against another record is MISMATCH', () => {
  const e = { status: 'FINAL', result: { payouts: [{ owner: A, amountRaw: 4n }, { owner: B, amountRaw: 3n }] } } as unknown as RewardEpoch;
  const tx = (transfers: { owner: string; amountRaw: string }[], artifactHash = 'h'.repeat(64)) => ({ sig: 'p', slot: 1, blockTime: null, artifactHash, paidRaw: '7', transfers });
  const H = 'h'.repeat(64);
  assert.equal(settlementOf(e, H, []).status, 'NOT_PAID');
  assert.equal(settlementOf(e, H, [tx([{ owner: A, amountRaw: '4' }, { owner: B, amountRaw: '3' }])]).status, 'PAID');
  assert.equal(settlementOf(e, H, [tx([{ owner: A, amountRaw: '4' }])]).status, 'PARTLY_PAID');
  assert.equal(settlementOf(e, H, [tx([{ owner: A, amountRaw: '5' }])]).status, 'MISMATCH');
  assert.equal(settlementOf(e, H, [tx([{ owner: K.attacker.toBase58(), amountRaw: '1' }])]).status, 'MISMATCH');
  assert.equal(settlementOf(e, H, [tx([{ owner: A, amountRaw: '4' }, { owner: B, amountRaw: '3' }], 'x'.repeat(64))]).status, 'MISMATCH');
  assert.equal(settlementOf({ ...e, status: 'OPEN' } as RewardEpoch, null, [tx([{ owner: A, amountRaw: '4' }])]).status, 'MISMATCH');
});
