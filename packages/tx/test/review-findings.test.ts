// Regression tests for independent-review findings QF-SEC-01a/b (2026-09-27). Run first against the
// original code to reproduce the gap (evidence/repair/red/tx.txt), then kept as secure-outcome tests.
// Decoded objects are synthetic; serialized-message mutation tests live in the adapter package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDecodedAgainstIntent, PROGRAM_IDS, type DecodedTransaction } from '../src/decoder.ts';

const USER = 'A7U7bbWZH4d1gxhLoWq5aku74mSMKsU1BJZjRmhYayB9';
const ATTACKER = 'HGSwtfZGJLihREYFLrh8Rp4DAH2kToktFXpxJo9vWcKM';
const CONFIG = 'Stake11111111111111111111111111111111111111';
const BASE = 'Vote111111111111111111111111111111111111111';
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const decoded = (ixs: DecodedTransaction['instructions']): DecodedTransaction => ({ version: 'legacy', feePayer: USER, signers: [USER],
  writableAccounts: [USER, ATTACKER], instructions: ixs, addressTableLookups: 0, lifetimeToken: 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W' });
// System transfer of 5 SOL: u32 LE 2 + u64 LE amount
const transfer = { programAddress: PROGRAM_IDS.SYSTEM, accounts: [USER, ATTACKER], dataHex: '02000000' + '00f2052a01000000' };
const junkDbc = { programAddress: PROGRAM_IDS.DBC, accounts: [USER], dataHex: 'deadbeefdeadbeef' };
const common = { cluster: 'mock-offline', policyVersion: 'tx-binding-v0.1', feePayer: USER, compute: { maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '100000' } } as const;
const consent = { termsDigest: 'x', cluster: 'mock-offline', policyVersion: 'tx-binding-v0.1', evidenceDigest: '00'.repeat(32), acknowledgementDigest: null, approvedAt: '2026-09-27T12:00:00.000Z' } as const;

test('QF-SEC-01a: CREATE_POOL with arbitrary DBC bytes plus an extra System transfer is rejected', async () => {
  const terms = { ...common, kind: 'CREATE_POOL', config: CONFIG, creator: USER, payer: USER, baseMint: BASE, quoteMint: QUOTE,
    quoteTokenProgram: PROGRAM_IDS.TOKEN, name: 'MOCK', symbol: 'MOCK', uri: 'https://example.invalid/mock.json' } as const;
  const v = await verifyDecodedAgainstIntent(decoded([junkDbc, transfer]), { kind: 'CREATE_POOL', feePayer: USER, signerAddress: USER, terms, consent } as never);
  assert.ok(Array.isArray(v), 'violations list');
  const s = v.join('\n');
  assert.match(s, /DBC_UNKNOWN_INSTRUCTION|DBC_DECODE_FAILED/, s);
  assert.match(s, new RegExp(`UNBOUND_INSTRUCTION ${PROGRAM_IDS.SYSTEM}`), s);
});

test('QF-SEC-01b: SWAP with arbitrary DBC bytes is rejected', async () => {
  const terms = { ...common, kind: 'SWAP', config: CONFIG, pool: CONFIG, user: USER, baseMint: BASE, quoteMint: QUOTE, direction: 'QUOTE_TO_BASE',
    amountIn: '1000000', minimumAmountOut: '1', referralTokenAccount: null, baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN,
    allowSysvarInstructions: false } as const;
  const v = await verifyDecodedAgainstIntent(decoded([junkDbc]), { kind: 'SWAP', feePayer: USER, signerAddress: USER, terms, consent } as never);
  assert.ok(Array.isArray(v), 'violations list');
  assert.match(v.join('\n'), /DBC_UNKNOWN_INSTRUCTION|DBC_DECODE_FAILED/);
});
