// Engine transactions (ADR-014): every kind binds when built from its own terms, with wrapped SOL and with an SPL quote,
// and any change to an instruction, an amount, an account, a signer or a writable flag is a violation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRole, type Instruction } from '@solana/kit';
import * as E from '@project-qf/engine';
import { decodeTransactionBytes, verifyTransactionPreview } from '../src/decoder.ts';
import { bindTransactionToTerms } from '../src/semantic.ts';
import { qfInstructions } from '../src/qf-engine.ts';
import { TX_BINDING_POLICY_VERSION, validateTerms, type QfTerms } from '../src/terms.ts';

const USER = 'A7U7bbWZH4d1gxhLoWq5aku74mSMKsU1BJZjRmhYayB9', COIN = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', EVIL = 'HGSwtfZGJLihREYFLrh8Rp4DAH2kToktFXpxJo9vWcKM';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const common = { cluster: 'devnet', policyVersion: TX_BINDING_POLICY_VERSION, feePayer: USER, compute: { maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '1000' } } as const;
const ammConfig = await E.ammConfigAddress(0);

const kinds = (quoteMint: string): QfTerms[] => [
  { ...common, kind: 'QF_CREATE', creator: USER, baseMint: COIN, quoteMint, ammConfig, name: 'Moon Cat', symbol: 'MCAT', uri: 'https://lp.example/m/x.json' },
  { ...common, kind: 'QF_SWAP', user: USER, baseMint: COIN, quoteMint, direction: 'QUOTE_TO_BASE', amountIn: '50000000', minimumAmountOut: '1000' },
  { ...common, kind: 'QF_SWAP', user: USER, baseMint: COIN, quoteMint, direction: 'BASE_TO_QUOTE', amountIn: '1000000000', minimumAmountOut: '1' },
  { ...common, kind: 'QF_POOL_SWAP', user: USER, baseMint: COIN, quoteMint, ammConfig, direction: 'QUOTE_TO_BASE', amountIn: '50000000', minimumAmountOut: '1000' },
  { ...common, kind: 'QF_POOL_SWAP', user: USER, baseMint: COIN, quoteMint, ammConfig, direction: 'BASE_TO_QUOTE', amountIn: '1000000000', minimumAmountOut: '1' },
  { ...common, kind: 'QF_CLAIM_CREATOR_FEES', creator: USER, baseMint: COIN, quoteMint },
  { ...common, kind: 'QF_COLLECT_POOL_CREATOR_FEE', creator: USER, baseMint: COIN, quoteMint, ammConfig },
];
const compile = (instructions: Instruction[], computeUnits?: number) =>
  decodeTransactionBytes(E.compileUnsigned({ feePayer: USER, blockhash: BLOCKHASH, lastValidBlockHeight: 100n, instructions, ...(computeUnits ? { computeUnits } : {}) }).bytes);
const built = async (t: QfTerms) => compile(await qfInstructions(t), 300_000);
const name = (t: QfTerms) => `${t.kind}${'direction' in t ? ` ${t.direction}` : ''} quote ${t.quoteMint === E.NATIVE_MINT ? 'SOL' : 'SPL'}`;

for (const quote of [E.NATIVE_MINT, USDC]) {
  for (const t of kinds(quote)) {
    test(`engine binding: ${name(t)} binds when built from its own terms`, async () => {
      assert.deepEqual(validateTerms(t), []);
      assert.deepEqual(await bindTransactionToTerms(await built(t), t), []);
    });
  }
}

test('engine binding: with wrapped SOL a buy wraps exactly the amount in and every trade unwraps at the end', async () => {
  const [, buy, sell] = kinds(E.NATIVE_MINT);
  const wsol = await E.ata(USER, E.NATIVE_MINT, E.TOKEN);
  const b = await qfInstructions(buy!);
  assert.deepEqual(b.map((i) => i.programAddress), [E.ASSOCIATED_TOKEN, E.ASSOCIATED_TOKEN, E.SYSTEM, E.TOKEN, E.QF_CURVE, E.TOKEN]);
  assert.deepEqual(b[2]!.data, E.transferSolIx(USER, wsol, 50_000_000n).data);
  assert.deepEqual(b[5]!.accounts!.map((a) => a.address), [wsol, USER, USER]);
  const s = await qfInstructions(sell!);
  assert.deepEqual(s.map((i) => i.programAddress), [E.ASSOCIATED_TOKEN, E.QF_CURVE, E.TOKEN]);
  // with an SPL quote nothing is wrapped or closed
  const spl = await qfInstructions(kinds(USDC)[1]!);
  assert.deepEqual(spl.map((i) => i.programAddress), [E.ASSOCIATED_TOKEN, E.ASSOCIATED_TOKEN, E.QF_CURVE]);
});

test('engine binding: a different amount, minimum or wrap is a data mismatch', async () => {
  const t = kinds(E.NATIVE_MINT)[1] as Extract<QfTerms, { kind: 'QF_SWAP' }>;
  const lowerMin = await built({ ...t, minimumAmountOut: '999' });
  assert.match((await bindTransactionToTerms(lowerMin, t)).join(), /DATA_MISMATCH buy/);
  const ixs = await qfInstructions(t);
  ixs[2] = E.transferSolIx(USER, await E.ata(USER, E.NATIVE_MINT, E.TOKEN), 50_000_001n);
  assert.match((await bindTransactionToTerms(compile(ixs), t)).join(), /DATA_MISMATCH SOL transfer #2/);
});

test('engine binding: an added instruction, a changed destination or the wrong program is refused', async () => {
  const t = kinds(E.NATIVE_MINT)[1] as Extract<QfTerms, { kind: 'QF_SWAP' }>;
  const extra = [...await qfInstructions(t), E.transferSolIx(USER, EVIL, 1n)];
  const v1 = (await bindTransactionToTerms(compile(extra), t)).join();
  assert.match(v1, /INSTRUCTION_COUNT 7 \(expected 6/);
  assert.match(v1, new RegExp(`UNEXPECTED_WRITABLE ${EVIL}`));
  const steal = await qfInstructions(t);
  steal[5] = E.closeAccountIx(await E.ata(USER, E.NATIVE_MINT, E.TOKEN), EVIL, USER);
  const v2 = (await bindTransactionToTerms(compile(steal), t)).join();
  assert.match(v2, /ACCOUNTS_MISMATCH close token account #5/);
  assert.match(v2, new RegExp(`UNEXPECTED_WRITABLE ${EVIL}`));
  const pool = kinds(E.NATIVE_MINT)[3]!;
  assert.match((await bindTransactionToTerms(await built(pool), t)).join(), /WRONG_PROGRAM .* \(expected buy\)/);
});

test('engine binding: an extra signer or writable flag on a bound account is refused', async () => {
  const t = kinds(E.NATIVE_MINT)[1] as Extract<QfTerms, { kind: 'QF_SWAP' }>;
  const launch = await E.launchAddress(COIN);
  const withRole = async (addr: string, role: AccountRole) => (await qfInstructions(t)).map((ix) => ({ ...ix, accounts: ix.accounts?.map((a) => (a.address === addr ? { ...a, role } : a)) }));
  assert.match((await bindTransactionToTerms(compile(await withRole(launch, AccountRole.WRITABLE_SIGNER)), t)).join(), new RegExp(`UNEXPECTED_SIGNER ${launch}`));
  const quoteMintWritable = await withRole(E.NATIVE_MINT, AccountRole.WRITABLE);
  assert.match((await bindTransactionToTerms(compile(quoteMintWritable), t)).join(), new RegExp(`UNEXPECTED_WRITABLE ${E.NATIVE_MINT}`));
});

test('engine binding: compute budget must come first and stay within the caps', async () => {
  const t = kinds(E.NATIVE_MINT)[2]!;
  const ixs = await qfInstructions(t);
  assert.match((await bindTransactionToTerms(compile(ixs, 500_000), t)).join(), /COMPUTE_LIMIT_EXCEEDS_CAP 500000 > 400000/);
  assert.match((await bindTransactionToTerms(compile([...ixs, E.computeUnitLimitIx(1000)]), t)).join(), /COMPUTE_BUDGET_NOT_FIRST/);
  assert.deepEqual(await bindTransactionToTerms(compile(ixs), t), [], 'no compute budget instruction at all is fine');
});

test('engine binding: a launch needs the creator and the fresh mint to sign, and the texts must match', async () => {
  const t = kinds(E.NATIVE_MINT)[0] as Extract<QfTerms, { kind: 'QF_CREATE' }>;
  const d = await built(t);
  assert.deepEqual(new Set(d.signers), new Set([USER, COIN]));
  assert.match((await bindTransactionToTerms(await built({ ...t, symbol: 'MCAT2' }), t)).join(), /DATA_MISMATCH create_launch/);
});

test('engine terms: wrapped SOL is allowed for engine kinds only; the signer pays; texts fit the engine', () => {
  const [create, buy] = kinds(E.NATIVE_MINT) as [Extract<QfTerms, { kind: 'QF_CREATE' }>, Extract<QfTerms, { kind: 'QF_SWAP' }>];
  assert.deepEqual(validateTerms(buy), []);
  assert.match(validateTerms({ ...buy, feePayer: EVIL }).join(), /TERMS_QF_FEE_PAYER_IS_NOT_THE_SIGNER/);
  assert.match(validateTerms({ ...buy, baseMint: E.NATIVE_MINT }).join(), /TERMS_QF_COIN_IS_THE_QUOTE/);
  assert.match(validateTerms({ ...buy, direction: 'UP' as never }).join(), /TERMS_BAD_DIRECTION/);
  assert.match(validateTerms({ ...buy, amountIn: '0' }).join(), /TERMS_NONPOSITIVE_AMOUNT amountIn/);
  assert.match(validateTerms({ ...create, name: 'é'.repeat(17) }).join(), /TERMS_BAD_STRING name/, '34 UTF-8 bytes is over the 32-byte limit');
  assert.deepEqual(validateTerms({ ...create, name: 'é'.repeat(16) }), []);
  assert.match(validateTerms({ ...create, symbol: '' }).join(), /TERMS_BAD_STRING symbol/);
  assert.match(validateTerms({ ...create, baseMint: USER }).join(), /TERMS_QF_MINT_IS_THE_CREATOR/);
});

test('engine preview: the browser path binds the same way and checks the consent', async () => {
  const t = kinds(E.NATIVE_MINT)[3]!;
  const r = await verifyTransactionPreview(await built(t), { kind: 'QF_POOL_SWAP', feePayer: USER, signerAddress: USER, terms: t,
    consent: { termsDigest: '00'.repeat(32), cluster: 'devnet', policyVersion: TX_BINDING_POLICY_VERSION, evidenceDigest: 'ab'.repeat(32), acknowledgementDigest: null, approvedAt: '2026-10-11T00:00:00Z' } });
  assert.deepEqual(r.violations, ['CONSENT_TERMS_MISMATCH']);
});
