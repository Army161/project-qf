// Holder-rewards binding tests (devnet test round). A deposit (treasury vault -> rewards vault) and a payout (rewards
// vault -> holders) are built by the adapter, wrapped in a Squads proposal by the pinned SDK, and must bind with zero
// violations; every mutation below must be rejected by the independent Kit decoder and binder. Nothing is signed or sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sq from '@sqds/multisig';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  bindStoredVaultTransaction, bindTransactionToTerms, decodeTransactionBytes, decodeTransferChecked, rewardsMemo, validateTerms, PROGRAM_IDS,
  type ApprovedTerms, type RewardsInnerTerms,
} from '@project-qf/tx';
import { serializeUnsigned } from '../src/index.ts';
import { executeTransaction, proposeTransaction, rewardsTransferInner, rewardsVaultOf, type InnerClaim } from '../src/treasury.ts';
import { BLOCKHASH, K, TOKEN } from './support/fixtures.ts';
import { MOCK_RPC_LABEL, mockKey } from './support/mockRpc.ts';
import { storedVaultTransaction } from './support/treasury.ts';

const s = (k: PublicKey) => k.toBase58();
const MS = sq.getMultisigPda({ createKey: mockKey('rewards-create-key') })[0];
const VAULT = sq.getVaultPda({ multisigPda: MS, index: 0 })[0], REWARDS = sq.getVaultPda({ multisigPda: MS, index: 1 })[0];
const M1 = mockKey('member-1'), M2 = mockKey('member-2'), H1 = mockKey('holder-1'), H2 = mockKey('holder-2');
const ATTACKER = K.attacker;
const INDEX = 9n;
const ATA = new PublicKey(PROGRAM_IDS.ASSOCIATED_TOKEN);
const ataOf = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
const expectViolation = (v: string[], re: RegExp) => assert.ok(v.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(v)}`);
const common = (feePayer: string) => ({ cluster: 'devnet' as const, policyVersion: 'tx-binding-v0.1', feePayer, compute: { maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '0' } });
const ref = { quoteMint: s(K.quoteMint), quoteDecimals: 6, quoteTokenProgram: PROGRAM_IDS.TOKEN, launchMint: s(K.baseMint), epochId: '2026-10-05' };
const deposit = (p: Partial<Extract<RewardsInnerTerms, { kind: 'REWARDS_DEPOSIT' }>> = {}): RewardsInnerTerms =>
  ({ ...common(s(VAULT)), ...ref, kind: 'REWARDS_DEPOSIT', from: s(VAULT), to: s(REWARDS), amountRaw: '2020202', ...p });
const payout = (p: Partial<Extract<RewardsInnerTerms, { kind: 'REWARDS_PAYOUT' }>> = {}): RewardsInnerTerms =>
  ({ ...common(s(REWARDS)), ...ref, kind: 'REWARDS_PAYOUT', from: s(REWARDS), artifactHash: 'ab'.repeat(32),
    payouts: [{ owner: s(H1), amountRaw: '1500000' }, { owner: s(H2), amountRaw: '520201' }], ...p });
const decode = (tx: Transaction, payer: PublicKey) => decodeTransactionBytes(serializeUnsigned(tx, payer, BLOCKHASH));

/** Proposes `terms` after letting `mutate` change what the vault would sign, and binds the proposal to the honest terms. */
function proposeWith(terms: RewardsInnerTerms, mutate: (ixs: TransactionInstruction[]) => TransactionInstruction[] = (x) => x) {
  const claim: InnerClaim = rewardsTransferInner(terms);
  const p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim: { ...claim, instructions: mutate(claim.instructions) } });
  return { p, v: bindTransactionToTerms(decode(p.tx, M1), { ...p.terms, inner: terms } as ApprovedTerms) };
}

for (const [label, make, vaultIndex, vault] of [['deposit', deposit, 0, VAULT], ['payout', payout, 1, REWARDS]] as const) {
  test(`[${MOCK_RPC_LABEL}] rewards ${label}: propose, stored transaction and execute bind with zero violations`, async () => {
    const terms = make();
    assert.deepEqual(validateTerms(terms), []);
    const { p, v } = proposeWith(terms);
    assert.deepEqual(await v, []);
    assert.equal((p.terms as { vaultIndex: number }).vaultIndex, vaultIndex);
    const stored = storedVaultTransaction(p.tx.instructions[0]!, { multisig: MS, creator: M1, index: INDEX, vaultIndex });
    assert.deepEqual((await bindStoredVaultTransaction(stored, { multisig: s(MS), transactionIndex: INDEX.toString(), vaultIndex, inner: terms })).violations, []);
    const e = executeTransaction({ multisig: s(MS), member: s(M2), transactionIndex: INDEX.toString(), vault: s(vault), inner: terms, stored });
    assert.deepEqual(await bindTransactionToTerms(decode(e.tx, M2), e.terms, { vaultTransactionAccount: stored }), []);
    // the vault the transaction runs from is derived from the multisig, not taken from the request
    assert.equal(rewardsVaultOf(s(MS)), s(REWARDS));
  });
}

test('rewards: the memo names the coin and epoch (and, for a payout, the frozen record), and transfers are TransferChecked', () => {
  assert.equal(rewardsMemo(deposit()), `qf-rewards-deposit@1 mint=${s(K.baseMint)} epoch=2026-10-05`);
  assert.equal(rewardsMemo(payout()), `qf-rewards-payout@1 mint=${s(K.baseMint)} epoch=2026-10-05 artifact=${'ab'.repeat(32)}`);
  const ix = rewardsTransferInner(deposit()).instructions[0]!;
  assert.deepEqual(decodeTransferChecked(Buffer.from(ix.data).toString('hex')), { amount: 2020202n, decimals: 6 });
});

test('rewards: a deposit to anywhere but this multisig\'s rewards vault is rejected', async () => {
  // terms naming an attacker's account: refused before any instruction is looked at
  const { v } = proposeWith(deposit({ to: s(ATTACKER) }));
  expectViolation(await v, /^TERMS_REWARDS_DEPOSIT_NOT_TO_REWARDS_VAULT/);
  // honest terms, but the vault message pays the attacker
  const bad = proposeWith(deposit(), (ixs) => { ixs[0]!.keys[2]!.pubkey = ataOf(ATTACKER, K.quoteMint); return ixs; });
  expectViolation(await bad.v, /^INNER_TRANSFER_DESTINATION_MISMATCH/);
});

test('rewards: a changed amount, mint, decimals or source is rejected', async () => {
  const amount = proposeWith(deposit(), (ixs) => { ixs[0]!.data.writeBigUInt64LE(9_999_999n, 1); return ixs; });
  expectViolation(await amount.v, /^INNER_TRANSFER_AMOUNT_MISMATCH/);
  const decimals = proposeWith(deposit(), (ixs) => { ixs[0]!.data[9] = 9; return ixs; });
  expectViolation(await decimals.v, /^INNER_TRANSFER_DECIMALS_MISMATCH/);
  const mint = proposeWith(deposit(), (ixs) => { ixs[0]!.keys[1]!.pubkey = K.baseMint; return ixs; });
  expectViolation(await mint.v, /^INNER_TRANSFER_MINT_MISMATCH/);
  const source = proposeWith(payout(), (ixs) => { ixs[0]!.keys[0]!.pubkey = ataOf(VAULT, K.quoteMint); return ixs; });
  expectViolation(await source.v, /^INNER_TRANSFER_SOURCE_NOT_VAULT_ACCOUNT/);
});

test('rewards: a plain Transfer, an extra SOL transfer, a missing or different memo are rejected', async () => {
  const plain = proposeWith(deposit(), (ixs) => { ixs[0]!.data[0] = 3; return ixs; });
  expectViolation(await plain.v, /^INNER_TOKEN_INSTRUCTION_NOT_TRANSFER_CHECKED/);
  const sol = proposeWith(deposit(), (ixs) => [...ixs, SystemProgram.transfer({ fromPubkey: VAULT, toPubkey: ATTACKER, lamports: 1 })]);
  expectViolation(await sol.v, new RegExp(`^INNER_UNEXPECTED_PROGRAM ${PROGRAM_IDS.SYSTEM}`));
  const noMemo = proposeWith(deposit(), (ixs) => ixs.slice(0, -1));
  expectViolation(await noMemo.v, /^INNER_MEMO_COUNT 0/);
  const otherEpoch = proposeWith(deposit(), (ixs) => { ixs[ixs.length - 1] = new TransactionInstruction({ programId: new PublicKey(PROGRAM_IDS.MEMO), keys: [],
    data: Buffer.from(rewardsMemo(deposit({ epochId: '2026-10-04' }))) }); return ixs; });
  expectViolation(await otherEpoch.v, /^INNER_MEMO_MISMATCH/);
});

test('rewards: a payout with recipients reordered, one dropped, or one added is rejected', async () => {
  const swapped = proposeWith(payout(), (ixs) => [ixs[1]!, ixs[0]!, ixs[2]!]);
  expectViolation(await swapped.v, /^INNER_TRANSFER_DESTINATION_MISMATCH/);
  const dropped = proposeWith(payout(), (ixs) => [ixs[0]!, ixs[2]!]);
  expectViolation(await dropped.v, /^INNER_MISSING_TRANSFERS 1/);
  const added = proposeWith(payout(), (ixs) => [ixs[0]!, ixs[1]!, rewardsTransferInner(payout({ payouts: [{ owner: s(ATTACKER), amountRaw: '1' }] })).instructions[0]!, ixs[2]!]);
  expectViolation(await added.v, /^INNER_UNEXPECTED_TRANSFER/);
});

test('rewards terms: a payout runs from the rewards vault only, to distinct wallets, never to itself', () => {
  assert.match(validateTerms({ ...common(s(M1)), kind: 'TREASURY_EXECUTE', multisig: s(MS), transactionIndex: '1', vault: s(VAULT), vaultIndex: 0, member: s(M1), inner: payout() }).join(),
    /TERMS_TREASURY_VAULT_INDEX must be 1/);
  assert.match(validateTerms({ ...common(s(M1)), kind: 'TREASURY_EXECUTE', multisig: s(MS), transactionIndex: '1', vault: s(REWARDS), vaultIndex: 1, member: s(M1), inner: deposit() }).join(),
    /TERMS_TREASURY_VAULT_INDEX must be 0/);
  assert.match(validateTerms(payout({ payouts: [{ owner: s(H1), amountRaw: '1' }, { owner: s(H1), amountRaw: '2' }] })).join(), /TERMS_REWARDS_DUPLICATE_RECIPIENT/);
  assert.match(validateTerms(payout({ payouts: [{ owner: s(REWARDS), amountRaw: '1' }] })).join(), /TERMS_REWARDS_PAYS_ITSELF/);
  assert.match(validateTerms(payout({ payouts: [{ owner: s(H1), amountRaw: '0' }] })).join(), /TERMS_BAD_AMOUNT/);
  assert.match(validateTerms(payout({ payouts: [] })).join(), /TERMS_REWARDS_PAYOUT_COUNT/);
  assert.match(validateTerms(payout({ artifactHash: 'xyz' })).join(), /TERMS_BAD_DIGEST artifactHash/);
  assert.match(validateTerms(deposit({ epochId: '2026-02-30' })).join(), /TERMS_BAD_EPOCH/);
  assert.match(validateTerms(deposit({ feePayer: s(M1) })).join(), /TERMS_REWARDS_FEE_PAYER_NOT_SOURCE_VAULT/);
  assert.match(validateTerms(deposit({ to: s(VAULT) })).join(), /TERMS_REWARDS_DEPOSIT_TO_ITSELF/);
});
