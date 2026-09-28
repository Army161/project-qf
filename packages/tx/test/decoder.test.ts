import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, appendTransactionMessageInstruction, compileTransaction, createTransactionMessage, getTransactionEncoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, blockhash, AccountRole } from '@solana/kit';
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
    const d = decodeTransactionBytes(tx([PROGRAM_IDS.COMPUTE_BUDGET, PROGRAM_IDS.DBC], version));
    assert.equal(d.version, version);
    assert.equal(d.feePayer, PAYER);
    assert.deepEqual(d.signers, [PAYER]);
    assert.deepEqual(d.instructions.map((i) => i.programAddress), [PROGRAM_IDS.COMPUTE_BUDGET, PROGRAM_IDS.DBC]);
    assert.equal(d.instructions[1]!.dataHex, '010203');
    assert.equal(d.addressTableLookups, 0);
  }
});

// QF-SEC-01: the original version of this test asserted that ComputeBudget + a DBC instruction with junk data
// [1,2,3] verified as []. That defined the deficient behaviour as success and was replaced by the tests below.
const COMMON = { cluster: 'mock-offline', policyVersion: TX_BINDING_POLICY_VERSION, compute: { maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '100000' } } as const;
const poolTerms = (feePayer: string): ApprovedTerms => ({ ...COMMON, kind: 'CREATE_POOL', feePayer, config: POOL, creator: feePayer, payer: feePayer,
  baseMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', quoteMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', quoteTokenProgram: PROGRAM_IDS.TOKEN,
  name: 'MOCK', symbol: 'MOCK', uri: 'https://example.invalid/m.json' });
async function req(kind: 'CREATE_POOL' | 'SWAP', feePayer: string, signerAddress: string) {
  const terms = kind === 'CREATE_POOL' ? poolTerms(PAYER) : ({ ...COMMON, kind: 'SWAP', feePayer: PAYER, config: POOL, pool: POOL, user: PAYER,
    baseMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', quoteMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', baseTokenProgram: PROGRAM_IDS.TOKEN,
    quoteTokenProgram: PROGRAM_IDS.TOKEN, direction: 'QUOTE_TO_BASE', amountIn: '1', minimumAmountOut: '0', referralTokenAccount: null, allowSysvarInstructions: false } as ApprovedTerms);
  return { kind, feePayer, signerAddress, terms, consent: { termsDigest: await termsDigest(terms), cluster: 'mock-offline', policyVersion: TX_BINDING_POLICY_VERSION,
    evidenceDigest: 'ab'.repeat(32), acknowledgementDigest: null, approvedAt: '2026-09-27T12:00:00.000Z' } } as const;
}

test('preview verification: a DBC instruction that does not decode under the pinned format is rejected', async () => {
  const d = decodeTransactionBytes(tx([PROGRAM_IDS.COMPUTE_BUDGET, PROGRAM_IDS.DBC]));
  const v = await verifyDecodedAgainstIntent(d, await req('CREATE_POOL', PAYER, PAYER));
  assert.ok(v.some((x) => /DBC_DECODE_FAILED|DBC_UNKNOWN_INSTRUCTION/.test(x)), v.join());
  assert.ok(v.some((x) => /COMPUTE_BUDGET_UNSUPPORTED/.test(x)), 'ComputeBudget data 010203 is not a bound opcode');
});

test('preview verification: fee payer and signer must match the intent and terms', async () => {
  const d = decodeTransactionBytes(tx([PROGRAM_IDS.DBC]));
  assert.match((await verifyDecodedAgainstIntent(d, await req('CREATE_POOL', POOL, PAYER))).join(), /INTENT_FEE_PAYER_NOT_IN_TERMS/);
  assert.match((await verifyDecodedAgainstIntent(d, await req('CREATE_POOL', PAYER, POOL))).join(), /REQUIRED_SIGNER_MISSING/);
});

test('an injected instruction to an unexpected program is flagged', async () => {
  const d = decodeTransactionBytes(tx([PROGRAM_IDS.DBC, 'BPFLoaderUpgradeab1e11111111111111111111111']));
  assert.match((await verifyDecodedAgainstIntent(d, await req('CREATE_POOL', PAYER, PAYER))).join(), /UNEXPECTED_PROGRAM BPFLoaderUpgradeab1e/);
});

test('a DBC intent without a DBC instruction is flagged', async () => {
  const d = decodeTransactionBytes(tx([PROGRAM_IDS.COMPUTE_BUDGET]));
  assert.match((await verifyDecodedAgainstIntent(d, await req('SWAP', PAYER, PAYER))).join(), /NO_ENGINE_INSTRUCTION/);
});

test('address lookup tables are not supported in preview and are rejected', async () => {
  const d = { ...decodeTransactionBytes(tx([PROGRAM_IDS.DBC])), addressTableLookups: 1 };
  assert.match((await verifyDecodedAgainstIntent(d, await req('SWAP', PAYER, PAYER))).join(), /ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED/);
});

test('garbage bytes are rejected, not partially decoded', () => {
  assert.throws(() => decodeTransactionBytes(new Uint8Array([1, 2, 3])));
});
