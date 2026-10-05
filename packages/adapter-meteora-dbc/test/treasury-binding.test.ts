// Treasury binding mutation tests (QF-SEC-01 for the Squads v4 platform treasury). Each starts from transactions built
// by the adapter with the pinned Squads SDK around SDK-built Meteora claims (MOCK RPC fixtures), mutates them, and
// requires the independent Kit decoder + binder to reject the result. The stored VaultTransaction account is
// serialized by the Squads SDK's own generated serializer, so the decoder is checked against the program's format
// rather than against itself. Nothing here is signed or sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import * as sq from '@sqds/multisig';
import { CpAmm, derivePositionAddress, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk';
import { createDbcClient } from '../src/index.ts';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  bindStoredVaultTransaction, bindTransactionToTerms, decodeTransactionBytes, squads, validateIntent, validateTerms, PROGRAM_IDS,
  type ApprovedTerms, type TreasuryInnerTerms,
} from '@project-qf/tx';
import { serializeUnsigned } from '../src/index.ts';
import { approveTransaction, executeTransaction, proposeTransaction, type InnerClaim } from '../src/treasury.ts';
import { BLOCKHASH, K, TOKEN, accountsForPool, NOW } from './support/fixtures.ts';
import { MOCK_RPC_LABEL, createMockConnection, mockKey } from './support/mockRpc.ts';
import { storedVaultTransaction } from './support/treasury.ts';

const s = (k: PublicKey) => k.toBase58();
const createKey = mockKey('treasury-create-key');
const MS = sq.getMultisigPda({ createKey })[0];
const VAULT = sq.getVaultPda({ multisigPda: MS, index: 0 })[0];
const M1 = mockKey('member-1'), M2 = mockKey('member-2');
const ATTACKER = K.attacker;
const INDEX = 7n;
const ATA = new PublicKey(PROGRAM_IDS.ASSOCIATED_TOKEN);
const ataOf = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
const expectViolation = (v: string[], re: RegExp) => assert.ok(v.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(v)}`);
const common = (feePayer: string) => ({ cluster: 'devnet' as const, policyVersion: 'tx-binding-v0.1', feePayer, compute: { maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '0' } });
const mints = { baseMint: s(K.baseMint), quoteMint: s(K.quoteMint), baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN };

async function curveClaim(): Promise<InnerClaim> {
  const { accounts } = await accountsForPool(false);
  const tx = await createDbcClient(createMockConnection(accounts).connection).partner.claimPartnerTradingFee({ feeClaimer: VAULT, payer: VAULT, pool: K.pool, receiver: VAULT,
    maxBaseAmount: new BN(0), maxQuoteAmount: new BN(1_000_000) });
  const terms: TreasuryInnerTerms = { ...common(s(VAULT)), ...mints, kind: 'CLAIM_PARTNER_TRADING_FEE', config: s(K.config), pool: s(K.pool), feeClaimer: s(VAULT), receiver: s(VAULT),
    maxBaseAmount: '0', maxQuoteAmount: '1000000' };
  return { instructions: tx.instructions, terms, amounts: { baseRaw: '0', quoteRaw: '1000000' } };
}
async function dammClaim(): Promise<InnerClaim> {
  const { accounts } = await accountsForPool(true);
  const tx = await new CpAmm(createMockConnection(accounts).connection).claimPositionFee({ owner: VAULT, feePayer: VAULT, pool: K.dammPool,
    position: derivePositionAddress(K.positionNft), positionNftAccount: derivePositionNftAccount(K.positionNft), tokenAVault: K.dammBaseVault, tokenBVault: K.dammQuoteVault,
    tokenAMint: K.baseMint, tokenBMint: K.quoteMint, tokenAProgram: TOKEN, tokenBProgram: TOKEN } as never);
  const terms: TreasuryInnerTerms = { ...common(s(VAULT)), ...mints, kind: 'DAMM_CLAIM_POSITION_FEE', dammConfig: 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck',
    pool: s(K.dammPool), owner: s(VAULT), positionNftMint: s(K.positionNft) };
  return { instructions: tx.instructions, terms, amounts: { baseRaw: '0', quoteRaw: '1' } };
}

const decode = (tx: Transaction, payer: PublicKey) => decodeTransactionBytes(serializeUnsigned(tx, payer, BLOCKHASH));
const patch = <T extends ApprovedTerms>(t: T, p: Partial<T>): T => ({ ...t, ...p }) as T;
const proposeIx = (tx: Transaction) => tx.instructions[0]!;

/** The account the program would store for this proposal (SDK serializer; see support/treasury.ts). */
const storedFor = (tx: Transaction, over: Partial<{ multisig: PublicKey; index: bigint; vaultIndex: number; bumps: readonly number[] }> = {}) =>
  storedVaultTransaction(proposeIx(tx), { multisig: over.multisig ?? MS, creator: M1, index: over.index ?? INDEX, ...(over.vaultIndex !== undefined ? { vaultIndex: over.vaultIndex } : {}), ...(over.bumps ? { bumps: over.bumps } : {}) });

for (const [label, make] of [['curve', curveClaim], ['DAMM v2 LP', dammClaim]] as const) {
  test(`[${MOCK_RPC_LABEL}] baseline (${label}): propose, approve and execute bind with zero violations, and the stored account round-trips`, async () => {
    const claim = await make();
    const p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
    assert.deepEqual(await bindTransactionToTerms(decode(p.tx, M1), p.terms), []);
    const a = approveTransaction({ multisig: s(MS), member: s(M2), transactionIndex: INDEX.toString() });
    assert.deepEqual(await bindTransactionToTerms(decode(a.tx, M2), a.terms), []);
    const stored = storedFor(p.tx);
    const back = squads.decodeVaultTransactionAccount(stored);
    assert.equal(back.multisig, s(MS)); assert.equal(back.index, INDEX); assert.equal(back.creator, s(M1));
    assert.deepEqual((await bindStoredVaultTransaction(stored, { multisig: s(MS), transactionIndex: INDEX.toString(), vaultIndex: 0, inner: claim.terms })).violations, []);
    const e = executeTransaction({ multisig: s(MS), member: s(M2), transactionIndex: INDEX.toString(), vault: s(VAULT), inner: claim.terms, stored });
    assert.deepEqual(await bindTransactionToTerms(decode(e.tx, M2), e.terms, { vaultTransactionAccount: stored }), []);
    // the vault is never a signer of the outer transaction; members sign for themselves only
    assert.ok(!decode(e.tx, M2).signers.includes(s(VAULT)));
  });
}

/** Proposes `claim` after letting `mutate` change the vault's instructions. */
async function proposeWith(mutate: (ixs: TransactionInstruction[]) => TransactionInstruction[], base = curveClaim) {
  const claim = await base();
  const p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim: { ...claim, instructions: mutate(claim.instructions) } });
  return { claim, p, v: await bindTransactionToTerms(decode(p.tx, M1), { ...p.terms, inner: claim.terms } as ApprovedTerms) };
}
const claimIx = (ixs: TransactionInstruction[]) => ixs.find((i) => s(i.programId) === PROGRAM_IDS.DBC)!;

test('vault claim paid to an attacker account is rejected inside the proposal', async () => {
  const { v } = await proposeWith((ixs) => { claimIx(ixs).keys[4]!.pubkey = ataOf(ATTACKER, K.baseMint); claimIx(ixs).keys[5]!.pubkey = ataOf(ATTACKER, K.quoteMint); return ixs; });
  expectViolation(v, /^INNER_ACCOUNT_MISMATCH token_[ab]_account/);
});

test('an extra SPL transfer or SOL transfer out of the vault is rejected inside the proposal', async () => {
  const spl = new TransactionInstruction({ programId: TOKEN, data: Buffer.concat([Buffer.from([3]), Buffer.alloc(8, 0xff)]),
    keys: [{ pubkey: ataOf(VAULT, K.quoteMint), isSigner: false, isWritable: true }, { pubkey: ataOf(ATTACKER, K.quoteMint), isSigner: false, isWritable: true }, { pubkey: VAULT, isSigner: true, isWritable: false }] });
  expectViolation((await proposeWith((ixs) => [...ixs, spl])).v, new RegExp(`^INNER_UNBOUND_INSTRUCTION ${PROGRAM_IDS.TOKEN}`));
  const sol = SystemProgram.transfer({ fromPubkey: VAULT, toPubkey: ATTACKER, lamports: 1_000_000_000 });
  expectViolation((await proposeWith((ixs) => [...ixs, sol])).v, new RegExp(`^INNER_UNBOUND_INSTRUCTION ${PROGRAM_IDS.SYSTEM}`));
});

test('a vault message that is not the approved claim (another pool, another kind) is rejected', async () => {
  const other = await dammClaim();
  const { v } = await proposeWith(() => other.instructions);
  expectViolation(v, /^INNER_(NO_ENGINE_INSTRUCTION|UNEXPECTED_PROGRAM)/);
});

test('ComputeBudget inside the vault message is rejected (it cannot run through CPI)', async () => {
  const claim = await curveClaim();
  const p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
  // the builder strips ComputeBudget; re-wrap by hand to prove the binder catches one that gets through
  const msg = new (await import('@solana/web3.js')).TransactionMessage({ payerKey: VAULT, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ...claim.instructions] });
  p.tx.instructions[0] = sq.instructions.vaultTransactionCreate({ multisigPda: MS, transactionIndex: INDEX, creator: M1, rentPayer: M1, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: msg });
  expectViolation(await bindTransactionToTerms(decode(p.tx, M1), p.terms), /^INNER_COMPUTE_BUDGET_NOT_ALLOWED/);
});

test('ephemeral signers, a memo, a draft proposal, or a different index are rejected', async () => {
  const claim = await curveClaim();
  const base = () => proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
  const msg = (await import('@solana/web3.js')).TransactionMessage;
  const m = new msg({ payerKey: VAULT, recentBlockhash: PublicKey.default.toBase58(), instructions: claim.instructions });
  let p = base();
  p.tx.instructions[0] = sq.instructions.vaultTransactionCreate({ multisigPda: MS, transactionIndex: INDEX, creator: M1, rentPayer: M1, vaultIndex: 0, ephemeralSigners: 1, transactionMessage: m });
  expectViolation(await bindTransactionToTerms(decode(p.tx, M1), p.terms), /ARG_POLICY ephemeral_signers/);
  p = base();
  p.tx.instructions[0] = sq.instructions.vaultTransactionCreate({ multisigPda: MS, transactionIndex: INDEX, creator: M1, rentPayer: M1, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: m, memo: 'x' });
  expectViolation(await bindTransactionToTerms(decode(p.tx, M1), p.terms), /ARG_POLICY memo/);
  p = base();
  p.tx.instructions[1] = sq.instructions.proposalCreate({ multisigPda: MS, transactionIndex: INDEX, creator: M1, rentPayer: M1, isDraft: true });
  expectViolation(await bindTransactionToTerms(decode(p.tx, M1), p.terms), /ARG_POLICY draft/);
  p = base();
  p.tx.instructions[1] = sq.instructions.proposalCreate({ multisigPda: MS, transactionIndex: INDEX + 1n, creator: M1, rentPayer: M1 });
  const v = await bindTransactionToTerms(decode(p.tx, M1), p.terms);
  expectViolation(v, /ACCOUNT_MISMATCH proposal/); expectViolation(v, /ARG_MISMATCH transaction_index/);
});

test('any other Squads instruction (adding a member, a config change) or a second approval is rejected', async () => {
  const claim = await curveClaim();
  let p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
  p.tx.add(sq.instructions.configTransactionCreate({ multisigPda: MS, transactionIndex: INDEX + 1n, creator: M1, rentPayer: M1,
    actions: [{ __kind: 'AddMember', newMember: { key: ATTACKER, permissions: sq.types.Permissions.all() } }] }));
  expectViolation(await bindTransactionToTerms(decode(p.tx, M1), p.terms), /SQUADS_UNKNOWN_INSTRUCTION/);
  p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
  p.tx.add(sq.instructions.proposalApprove({ multisigPda: MS, transactionIndex: INDEX, member: M2 }));
  const v = await bindTransactionToTerms(decode(p.tx, M1), p.terms);
  expectViolation(v, /UNEXPECTED_INSTRUCTION proposal_approve/); expectViolation(v, /UNEXPECTED_SIGNER/);
  p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
  expectViolation(await bindTransactionToTerms(decode(p.tx, M1), patch(p.terms, { approve: false } as never)), /UNEXPECTED_INSTRUCTION proposal_approve/);
});

test('approve: another member, another proposal or another multisig is rejected', async () => {
  const a = approveTransaction({ multisig: s(MS), member: s(M2), transactionIndex: INDEX.toString() });
  expectViolation(await bindTransactionToTerms(decode(a.tx, M2), patch(a.terms, { transactionIndex: '8' } as never)), /ACCOUNT_MISMATCH proposal/);
  expectViolation(await bindTransactionToTerms(decode(a.tx, M2), patch(a.terms, { multisig: s(mockKey('other-ms')) } as never)), /ACCOUNT_MISMATCH multisig/);
  const b = approveTransaction({ multisig: s(MS), member: s(ATTACKER), transactionIndex: INDEX.toString() });
  const v = await bindTransactionToTerms(decode(b.tx, ATTACKER), patch(a.terms, { feePayer: s(ATTACKER) } as never));
  expectViolation(v, /ACCOUNT_MISMATCH member/);
});

test('execute needs the stored transaction, runs exactly its accounts, and refuses a stored message that is not the approved claim', async () => {
  const claim = await curveClaim();
  const p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
  const stored = storedFor(p.tx);
  const e = executeTransaction({ multisig: s(MS), member: s(M2), transactionIndex: INDEX.toString(), vault: s(VAULT), inner: claim.terms, stored });
  expectViolation(await bindTransactionToTerms(decode(e.tx, M2), e.terms), /EXECUTE_NEEDS_STORED_TRANSACTION/);
  const swapped = executeTransaction({ multisig: s(MS), member: s(M2), transactionIndex: INDEX.toString(), vault: s(VAULT), inner: claim.terms, stored });
  const exIx = swapped.tx.instructions[1]!;
  exIx.keys[exIx.keys.length - 1]!.pubkey = ATTACKER;
  expectViolation(await bindTransactionToTerms(decode(swapped.tx, M2), e.terms, { vaultTransactionAccount: stored }), /EXECUTE_ACCOUNTS_NOT_STORED_MESSAGE/);
  // a proposal stored with an attacker payout (e.g. created outside the app) cannot be executed under the approved terms
  const bad = await proposeWith((ixs) => { claimIx(ixs).keys[5]!.pubkey = ataOf(ATTACKER, K.quoteMint); return ixs; });
  const badStored = storedFor(bad.p.tx);
  expectViolation((await bindStoredVaultTransaction(badStored, { multisig: s(MS), transactionIndex: INDEX.toString(), vaultIndex: 0, inner: claim.terms })).violations, /^STORED_INNER_ACCOUNT_MISMATCH/);
  for (const [over, re] of [[{ multisig: mockKey('other-ms') }, /STORED_TX_MULTISIG_MISMATCH/], [{ index: 8n }, /STORED_TX_INDEX_MISMATCH/], [{ bumps: [255] }, /STORED_TX_EPHEMERAL_SIGNERS/]] as const) {
    expectViolation((await bindStoredVaultTransaction(storedFor(p.tx, over), { multisig: s(MS), transactionIndex: INDEX.toString(), vaultIndex: 0, inner: claim.terms })).violations, re);
  }
  expectViolation((await bindStoredVaultTransaction(stored.slice(0, 100), { multisig: s(MS), transactionIndex: INDEX.toString(), vaultIndex: 0, inner: claim.terms })).violations, /STORED_TX_DECODE_FAILED/);
});

test('terms: the vault must be the multisig\'s vault, receive everything, and never be the member', async () => {
  const claim = await curveClaim();
  const p = proposeTransaction({ multisig: s(MS), member: s(M1), transactionIndex: INDEX, claim });
  const t = p.terms as Extract<ApprovedTerms, { kind: 'TREASURY_PROPOSE' }>;
  expectViolation(validateTerms({ ...t, inner: { ...claim.terms, receiver: s(ATTACKER) } }), /TERMS_TREASURY_INNER_NOT_VAULT receiver/);
  expectViolation(validateTerms({ ...t, inner: { ...claim.terms, feePayer: s(M1) } }), /TERMS_TREASURY_INNER_NOT_VAULT feePayer/);
  expectViolation(validateTerms({ ...t, creator: s(VAULT) }), /TERMS_TREASURY_MEMBER_IS_VAULT/);
  expectViolation(validateTerms({ ...t, vaultIndex: 1 }), /TERMS_TREASURY_VAULT_INDEX/);
  expectViolation(validateTerms({ ...t, inner: { ...claim.terms, kind: 'CLAIM_CREATOR_TRADING_FEE' } as never }), /TERMS_TREASURY_INNER_KIND/);
  expectViolation(validateTerms({ ...t, transactionIndex: '0' }), /TERMS_NONPOSITIVE_AMOUNT transactionIndex/);
  expectViolation(await bindTransactionToTerms(decode(p.tx, M1), { ...t, vault: s(mockKey('not-the-vault')), inner: { ...claim.terms, feePayer: s(mockKey('not-the-vault')), feeClaimer: s(mockKey('not-the-vault')), receiver: s(mockKey('not-the-vault')) } as never }),
    /TERMS_VAULT_NOT_DERIVED_FROM_MULTISIG/);
});

test('intent: a treasury member is never server-held', () => {
  const base = { intentId: 'i', kind: 'TREASURY_APPROVE' as const, cluster: 'devnet' as const, mock: false, feePayer: s(M2), createdAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' };
  assert.deepEqual(validateIntent({ ...base, signer: { role: 'TREASURY_MEMBER', address: s(M2), serverHeld: false } }, { now: NOW }).violations, []);
  expectViolation(validateIntent({ ...base, signer: { role: 'TREASURY_MEMBER', address: s(M2), serverHeld: true } }, { now: NOW }).violations, /MULTISIG_ROLE_SERVER_HELD TREASURY_MEMBER/);
  expectViolation(validateIntent({ ...base, signer: { role: 'FEE_CLAIMER', address: s(M2), serverHeld: false } }, { now: NOW }).violations, /ROLE_MISMATCH/);
});
