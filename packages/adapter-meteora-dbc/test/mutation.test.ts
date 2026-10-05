// Serialized-message mutation tests (QF-SEC-01, VERIFICATION-CHECKLIST B). Each test starts from a valid
// SDK-built transaction against MOCK RPC fixtures, mutates it with @solana/web3.js (the builder's own
// library), serializes the wire bytes, decodes them with the independent Kit decoder, and requires the
// binder to reject the result. The unmutated baseline must bind with zero violations. Never signed or sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { decodeTransactionBytes, verifyTransactionPreview, PROGRAM_IDS, type IntentKind, type ApprovedTerms } from '@project-qf/tx';
import { serializeUnsigned } from '../src/index.ts';
import { BLOCKHASH, K, buildFixtureTx, consentFor, termsFor } from './support/fixtures.ts';
import { MOCK_RPC_LABEL, mockKey } from './support/mockRpc.ts';

type Built = Awaited<ReturnType<typeof buildFixtureTx>>;
async function preview(kind: IntentKind, mutate: (b: Built) => void, termsPatch: (t: ApprovedTerms) => ApprovedTerms = (t) => t, termsKind: IntentKind = kind) {
  const b = await buildFixtureTx(kind);
  mutate(b);
  const d = decodeTransactionBytes(serializeUnsigned(b.tx, b.feePayer, BLOCKHASH));
  const approved = await termsFor(termsKind, b.cfgParams);
  const terms = termsPatch(approved);
  return (await verifyTransactionPreview(d, { kind: termsKind, feePayer: b.feePayer.toBase58(), signerAddress: b.signer.toBase58(), terms, consent: await consentFor(approved) })).violations;
}
const dbcIx = (b: Built) => b.tx.instructions.find((i) => i.programId.toBase58() === PROGRAM_IDS.DBC)!;
const expectViolation = (v: string[], re: RegExp) => assert.ok(v.some((x) => re.test(x)), `expected ${re} in ${JSON.stringify(v)}`);
const ATTACKER = mockKey('attacker');
// Hand-built SPL instructions (no extra dependency): ATA address, ATA CreateIdempotent, Token SetAuthority.
const TOKEN = new PublicKey(PROGRAM_IDS.TOKEN), ATA_PROGRAM = new PublicKey(PROGRAM_IDS.ASSOCIATED_TOKEN);
const getAssociatedTokenAddressSync = (mint: PublicKey, owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const createAssociatedTokenAccountIdempotentInstruction = (payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey) => new TransactionInstruction({
  programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] });
const createSetAuthorityInstruction = (account: PublicKey, current: PublicKey, newAuthority: PublicKey) => new TransactionInstruction({
  programId: TOKEN, data: Buffer.concat([Buffer.from([6, 0, 1]), newAuthority.toBuffer()]),
  keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: current, isSigner: true, isWritable: false }] });

test(`[${MOCK_RPC_LABEL}] baseline: every unmutated SDK transaction binds with zero violations`, async () => {
  for (const k of ['CREATE_CONFIG', 'CREATE_POOL', 'SWAP', 'MIGRATE_DAMM_V2', 'CLAIM_PARTNER_TRADING_FEE', 'CLAIM_CREATOR_TRADING_FEE', 'DAMM_SWAP', 'DAMM_CLAIM_POSITION_FEE'] as const) {
    assert.deepEqual(await preview(k, () => {}), [], k);
  }
});

test('added System transfer to an attacker is rejected (CREATE_POOL and SWAP)', async () => {
  for (const k of ['CREATE_POOL', 'SWAP'] as const) {
    const v = await preview(k, (b) => b.tx.add(SystemProgram.transfer({ fromPubkey: b.feePayer, toPubkey: ATTACKER, lamports: 5_000_000_000 })));
    expectViolation(v, new RegExp(`UNBOUND_INSTRUCTION ${PROGRAM_IDS.SYSTEM}`));
    expectViolation(v, /UNEXPECTED_WRITABLE/);
  }
});

test('SPL SetAuthority (authority change) is rejected', async () => {
  const v = await preview('CREATE_POOL', (b) => b.tx.add(createSetAuthorityInstruction(K.baseMint, b.feePayer, ATTACKER)));
  expectViolation(v, new RegExp(`UNBOUND_INSTRUCTION ${PROGRAM_IDS.TOKEN}`));
});

test('substituted swap output account (attacker ATA) is rejected', async () => {
  const v = await preview('SWAP', (b) => { dbcIx(b).keys[4]!.pubkey = getAssociatedTokenAddressSync(K.baseMint, ATTACKER); });
  expectViolation(v, /ACCOUNT_MISMATCH output_token_account/);
});

test('substituted mint in swap is rejected', async () => {
  const v = await preview('SWAP', (b) => { dbcIx(b).keys[7]!.pubkey = mockKey('other-mint'); });
  expectViolation(v, /ACCOUNT_MISMATCH base_mint/);
});

test('substituted fee-claim recipient accounts are rejected', async () => {
  const v = await preview('CLAIM_PARTNER_TRADING_FEE', (b) => { dbcIx(b).keys[4]!.pubkey = getAssociatedTokenAddressSync(K.quoteMint, ATTACKER); });
  expectViolation(v, /ACCOUNT_MISMATCH token_b_account/);
});

test('changed swap amount_in and lowered minimum_amount_out are rejected', async () => {
  const bump = await preview('SWAP', (b) => { const d = dbcIx(b).data; d.writeBigUInt64LE(d.readBigUInt64LE(8) * 1000n, 8); });
  expectViolation(bump, /ARG_MISMATCH amount_in/);
  const approvedHigherMin = await preview('SWAP', () => {}, (t) => ({ ...t, minimumAmountOut: '999' }) as ApprovedTerms);
  // terms changed after consent AND the wire min-out (1) is below the approved 999
  expectViolation(approvedHigherMin, /ARG_BELOW_APPROVED minimum_amount_out/);
  expectViolation(approvedHigherMin, /CONSENT_TERMS_MISMATCH/);
});

test('changed fee-claim max amounts are rejected', async () => {
  const v = await preview('CLAIM_CREATOR_TRADING_FEE', (b) => { dbcIx(b).data.writeBigUInt64LE(5n, 8); });
  expectViolation(v, /ARG_MISMATCH max_base_amount/);
});

test('compute price above the approved cap and a duplicate compute limit are rejected', async () => {
  const p = await preview('SWAP', (b) => b.tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 })));
  expectViolation(p, /COMPUTE_PRICE_EXCEEDS_CAP/);
  const l = await preview('MIGRATE_DAMM_V2', (b) => b.tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })));
  expectViolation(l, /COMPUTE_LIMIT_EXCEEDS_CAP|COMPUTE_BUDGET_DUPLICATE/);
});

test('wrong operation: a claim transaction presented under swap terms is rejected', async () => {
  const b = await buildFixtureTx('CLAIM_CREATOR_TRADING_FEE');
  const d = decodeTransactionBytes(serializeUnsigned(b.tx, b.feePayer, BLOCKHASH));
  const terms = await termsFor('SWAP');
  const v = (await verifyTransactionPreview(d, { kind: 'SWAP', feePayer: b.feePayer.toBase58(), signerAddress: b.signer.toBase58(), terms, consent: await consentFor(terms) })).violations;
  expectViolation(v, /WRONG_OPERATION claim_creator_trading_fee/);
});

test('an extra signer attached to the engine instruction is rejected', async () => {
  const v = await preview('SWAP', (b) => { dbcIx(b).keys.push({ pubkey: ATTACKER, isSigner: true, isWritable: true }); });
  expectViolation(v, new RegExp(`UNEXPECTED_SIGNER ${ATTACKER.toBase58()}`));
  expectViolation(v, /UNEXPECTED_REMAINING_ACCOUNT/);
});

test('migration: substituted DAMM config and a reused known account as ephemeral signer are rejected', async () => {
  const cfg = await preview('MIGRATE_DAMM_V2', (b) => { const ix = dbcIx(b); ix.keys[ix.keys.length - 1]!.pubkey = mockKey('other-damm-config'); });
  expectViolation(cfg, /UNEXPECTED_REMAINING_ACCOUNT|MISSING_REMAINING_ACCOUNT/);
  const eph = await preview('MIGRATE_DAMM_V2', (b) => { dbcIx(b).keys[5]!.pubkey = K.crank; });
  expectViolation(eph, /EPHEMERAL_SIGNER_REUSES_KNOWN_ACCOUNT|ACCOUNT_MISMATCH first_position/);
});

test('ATA creation for an attacker-owned account is rejected', async () => {
  const v = await preview('SWAP', (b) => b.tx.instructions.unshift(createAssociatedTokenAccountIdempotentInstruction(b.feePayer,
    getAssociatedTokenAddressSync(K.quoteMint, ATTACKER), ATTACKER, K.quoteMint)));
  expectViolation(v, /ATA_NOT_BOUND/);
});

test('truncated or extended engine instruction data is rejected', async () => {
  const cut = await preview('SWAP', (b) => { const ix = dbcIx(b); ix.data = ix.data.subarray(0, ix.data.length - 1); });
  expectViolation(cut, /DBC_DECODE_FAILED swap/);
  const ext = await preview('CREATE_POOL', (b) => { const ix = dbcIx(b); ix.data = Buffer.concat([ix.data, Buffer.from([0])]); });
  expectViolation(ext, /DBC_DECODE_FAILED .*trailing/);
});

test('changed CREATE_CONFIG parameters (fee) do not match the approved digest', async () => {
  // cliff_fee_numerator is the first u64 of ConfigParameters (after the 8-byte discriminator)
  const v = await preview('CREATE_CONFIG', (b) => { const d = dbcIx(b).data; d.writeBigUInt64LE(d.readBigUInt64LE(8) * 5n, 8); });
  expectViolation(v, /ARG_MISMATCH config_parameters/);
});

test('an injected instruction to an unknown program is rejected', async () => {
  const v = await preview('CLAIM_PARTNER_TRADING_FEE', (b) => b.tx.add(new TransactionInstruction({ programId: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), keys: [], data: Buffer.from([1]) })));
  expectViolation(v, /UNEXPECTED_PROGRAM BPFLoaderUpgradeab1e/);
});

// ---------- after graduation: swaps on the DAMM v2 pool ----------
const dammIx = (b: Built) => b.tx.instructions.find((i) => i.programId.toBase58() === PROGRAM_IDS.DAMM_V2)!;
test(`[${MOCK_RPC_LABEL}] DAMM v2 swap: a different pool, output account, amount or minimum is rejected`, async () => {
  expectViolation(await preview('DAMM_SWAP', () => {}, (t) => ({ ...t, pool: mockKey('other-damm-pool').toBase58() })), /TERMS_POOL_NOT_DERIVED_FROM_DAMM_CONFIG_AND_MINTS/);
  expectViolation(await preview('DAMM_SWAP', (b) => { dammIx(b).keys[3]!.pubkey = getAssociatedTokenAddressSync(K.baseMint, ATTACKER); }), /ACCOUNT_MISMATCH output_token_account|UNEXPECTED_WRITABLE/);
  expectViolation(await preview('DAMM_SWAP', () => {}, (t) => ({ ...t, amountIn: '2000000' })), /ARG_MISMATCH amount_in/);
  expectViolation(await preview('DAMM_SWAP', () => {}, (t) => ({ ...t, minimumAmountOut: '999999999999' })), /ARG_BELOW_APPROVED minimum_amount_out/);
  expectViolation(await preview('DAMM_SWAP', () => {}, (t) => ({ ...t, direction: 'BASE_TO_QUOTE' })), /ACCOUNT_MISMATCH (input|output)_token_account/);
  expectViolation(await preview('DAMM_SWAP', () => {}, (t) => ({ ...t, dammConfig: mockKey('other-damm-config').toBase58() })), /TERMS_DAMM_CONFIG_NOT_V0_TEMPLATE/);
});

test(`[${MOCK_RPC_LABEL}] DAMM v2 swap: a curve swap, an extra transfer, or a DAMM swap under curve terms is rejected`, async () => {
  expectViolation(await preview('DAMM_SWAP', (b) => b.tx.add(createSetAuthorityInstruction(getAssociatedTokenAddressSync(K.quoteMint, K.creator), K.creator, ATTACKER))), /UNBOUND_INSTRUCTION/);
  const dbcSwap = (await buildFixtureTx('SWAP')).tx.instructions.find((i) => i.programId.toBase58() === PROGRAM_IDS.DBC)!;
  expectViolation(await preview('DAMM_SWAP', (b) => b.tx.add(dbcSwap)), /UNEXPECTED_PROGRAM dbcij/);
  expectViolation(await preview('DAMM_SWAP', () => {}, undefined, 'SWAP'), /UNEXPECTED_PROGRAM cpamd|NO_ENGINE_INSTRUCTION/);
});

// ---------- creator fees after graduation: claiming a DAMM v2 position's fees ----------
test(`[${MOCK_RPC_LABEL}] DAMM v2 position fee claim: a foreign position, attacker payout account, other owner or other pool is rejected`, async () => {
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', () => {}, (t) => ({ ...t, positionNftMint: mockKey('someone-elses-position').toBase58() })), /ACCOUNT_MISMATCH position/);
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', (b) => { dammIx(b).keys[4]!.pubkey = getAssociatedTokenAddressSync(K.quoteMint, ATTACKER); }), /ACCOUNT_MISMATCH token_b_account|UNEXPECTED_WRITABLE/);
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', () => {}, (t) => ({ ...t, owner: ATTACKER.toBase58() })), /ACCOUNT_MISMATCH signer/);
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', () => {}, (t) => ({ ...t, pool: mockKey('other-damm-pool').toBase58() })), /TERMS_POOL_NOT_DERIVED_FROM_DAMM_CONFIG_AND_MINTS/);
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', () => {}, (t) => ({ ...t, dammConfig: mockKey('other-damm-config').toBase58() })), /TERMS_DAMM_CONFIG_NOT_V0_TEMPLATE/);
});

test(`[${MOCK_RPC_LABEL}] DAMM v2 position fee claim: an extra swap, a token transfer or a claim under swap terms is rejected`, async () => {
  const swap = (await buildFixtureTx('DAMM_SWAP')).tx.instructions.find((i) => i.programId.toBase58() === PROGRAM_IDS.DAMM_V2)!;
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', (b) => b.tx.add(swap)), /MULTIPLE_ENGINE_INSTRUCTIONS/);
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', (b) => b.tx.add(createSetAuthorityInstruction(getAssociatedTokenAddressSync(K.quoteMint, K.creator), K.creator, ATTACKER))), /UNBOUND_INSTRUCTION/);
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', () => {}, undefined, 'DAMM_SWAP'), /WRONG_OPERATION claim_position_fee \(approved swap\)/);
  expectViolation(await preview('DAMM_CLAIM_POSITION_FEE', () => {}, undefined, 'CLAIM_CREATOR_TRADING_FEE'), /UNEXPECTED_PROGRAM cpamd|NO_ENGINE_INSTRUCTION/);
});
