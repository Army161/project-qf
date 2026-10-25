import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, appendTransactionMessageInstruction, compileTransaction, createTransactionMessage, getTransactionEncoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, blockhash, AccountRole } from '@solana/kit';
import { QF_CURVE } from '@project-qf/engine';
import { decodeTransactionBytes, verifyDecodedAgainstIntent, PROGRAM_IDS } from '../src/decoder.ts';
import { TX_BINDING_POLICY_VERSION, termsDigest, type ApprovedTerms } from '../src/terms.ts';

const PAYER = address('Vote111111111111111111111111111111111111111');
const POOL = address('Stake11111111111111111111111111111111111111');
const BH = blockhash('GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W'); // synthetic

function tx(programs: string[], version: 0 | 'legacy' = 0) {
  let m: any = pipe(createTransactionMessage({ version }), (m) => setTransactionMessageFeePayer(PAYER, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BH, lastValidBlockHeight: 1n }, m));
  for (const p of programs) {
    m = appendTransactionMessageInstruction({ programAddress: address(p), accounts: [{ address: POOL, role: AccountRole.WRITABLE }], data: new Uint8Array([1, 2, 3]) }, m);
  }
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(m)));
}

test('decodes v0 and legacy transactions offline into programs, signers and fee payer', () => {
  for (const version of [0, 'legacy'] as const) {
    const d = decodeTransactionBytes(tx([PROGRAM_IDS.COMPUTE_BUDGET, QF_CURVE], version));
    assert.equal(d.version, version);
    assert.equal(d.feePayer, PAYER);
    assert.deepEqual(d.signers, [PAYER]);
    assert.deepEqual(d.instructions.map((i) => i.programAddress), [PROGRAM_IDS.COMPUTE_BUDGET, QF_CURVE]);
    assert.equal(d.instructions[1]!.dataHex, '010203');
    assert.equal(d.addressTableLookups, 0);
  }
});

// QF-SEC-01: a transaction that merely calls the right programs is never enough; every instruction must be exactly the
// one the terms build (packages/tx/test/qf-engine.test.ts covers the byte-for-byte binding of real engine transactions).
const COMMON = { cluster: 'mock-offline', policyVersion: TX_BINDING_POLICY_VERSION, compute: { maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '100000' } } as const;
const swapTerms = (): ApprovedTerms => ({ ...COMMON, kind: 'QF_SWAP', feePayer: PAYER, user: PAYER, baseMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  quoteMint: 'So11111111111111111111111111111111111111112', direction: 'QUOTE_TO_BASE', amountIn: '1', minimumAmountOut: '0' });
async function req(feePayer: string, signerAddress: string) {
  const terms = swapTerms();
  return { kind: 'QF_SWAP', feePayer, signerAddress, terms, consent: { termsDigest: await termsDigest(terms), cluster: 'mock-offline', policyVersion: TX_BINDING_POLICY_VERSION,
    evidenceDigest: 'ab'.repeat(32), acknowledgementDigest: null, approvedAt: '2026-09-27T12:00:00.000Z' } } as const;
}

test('preview verification: an engine instruction that is not exactly the one the terms build is rejected', async () => {
  const d = decodeTransactionBytes(tx([PROGRAM_IDS.COMPUTE_BUDGET, QF_CURVE]));
  const v = await verifyDecodedAgainstIntent(d, await req(PAYER, PAYER));
  assert.ok(v.some((x) => /INSTRUCTION_COUNT|WRONG_PROGRAM|DATA_MISMATCH/.test(x)), v.join());
  assert.ok(v.some((x) => /COMPUTE_BUDGET_UNSUPPORTED/.test(x)), 'ComputeBudget data 010203 is not a bound opcode');
});

test('preview verification: fee payer and signer must match the intent and terms', async () => {
  const d = decodeTransactionBytes(tx([QF_CURVE]));
  assert.match((await verifyDecodedAgainstIntent(d, await req(POOL, PAYER))).join(), /INTENT_FEE_PAYER_NOT_IN_TERMS/);
  assert.match((await verifyDecodedAgainstIntent(d, await req(PAYER, POOL))).join(), /REQUIRED_SIGNER_MISSING/);
});

test('an injected instruction to an unexpected program is flagged', async () => {
  const d = decodeTransactionBytes(tx([QF_CURVE, 'BPFLoaderUpgradeab1e11111111111111111111111']));
  assert.match((await verifyDecodedAgainstIntent(d, await req(PAYER, PAYER))).join(), /WRONG_PROGRAM BPFLoaderUpgradeab1e|INSTRUCTION_COUNT/);
});

test('address lookup tables are not supported in preview and are rejected', async () => {
  const d = { ...decodeTransactionBytes(tx([QF_CURVE])), addressTableLookups: 1 };
  assert.match((await verifyDecodedAgainstIntent(d, await req(PAYER, PAYER))).join(), /ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED/);
});

test('garbage bytes are rejected, not partially decoded', () => {
  assert.throws(() => decodeTransactionBytes(new Uint8Array([1, 2, 3])));
});
