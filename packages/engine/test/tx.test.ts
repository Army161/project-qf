// Unsigned transactions: legacy wire format, the fee payer signs first, every signer has an empty slot, size-capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import * as E from '../src/index.ts';

const CREATOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', MINT = 'GoLdenM1nt1111111111111111111111111111111111';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

test('a create-coin transaction: creator pays and signs first, the mint key second, signatures empty', async () => {
  const ix = await E.createLaunchIx({ creator: CREATOR, mint: MINT, ammConfig: await E.ammConfigAddress(0), name: 'Dog', symbol: 'DOG', uri: 'https://x/m/1.json' });
  const t = E.compileUnsigned({ feePayer: CREATOR, blockhash: BLOCKHASH, lastValidBlockHeight: 100n, instructions: [ix], computeUnits: 200_000 });
  assert.deepEqual(t.signers, [CREATOR, MINT]);
  const tx = getTransactionDecoder().decode(t.bytes);
  assert.deepEqual(Object.keys(tx.signatures), [CREATOR, MINT]);
  assert.ok(Object.values(tx.signatures).every((s) => s === null), 'no signature is filled in');
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.version, 'legacy');
  assert.equal(msg.lifetimeToken, BLOCKHASH);
  assert.equal(msg.instructions.length, 2, 'compute unit limit, then the launch');
  assert.equal(msg.staticAccounts[msg.instructions[0]!.programAddressIndex], E.COMPUTE_BUDGET);
  assert.equal(msg.staticAccounts[msg.instructions[1]!.programAddressIndex], E.QF_CURVE);
});

test('a buy with wrapping and account creation fits one packet; oversize transactions are refused', async () => {
  const ixs = [...(await E.traderAccountIxs(CREATOR, CREATOR, MINT)), ...(await E.wrapSolIxs(CREATOR, CREATOR, 10_000_000n)), await E.buyIx({ trader: CREATOR, mint: MINT, quoteIn: 10_000_000n, minBaseOut: 1n })];
  const t = E.compileUnsigned({ feePayer: CREATOR, blockhash: BLOCKHASH, lastValidBlockHeight: 1n, instructions: ixs, computeUnits: 200_000 });
  assert.deepEqual(t.signers, [CREATOR]);
  assert.ok(t.bytes.length <= 1232);
  const many = Array.from({ length: 40 }, () => E.transferSolIx(CREATOR, MINT, 1n));
  assert.throws(() => E.compileUnsigned({ feePayer: CREATOR, blockhash: BLOCKHASH, lastValidBlockHeight: 1n, instructions: [...many, ...ixs] }), /limit 1232/);
});

test('fixed accounts in the IDL cannot be swapped, and unknown or missing accounts are refused', () => {
  assert.throws(() => E.buildFromIdl(E.CURVE_IDL, 'claim_creator_fees', { launch: CREATOR, launch_signer: CREATOR, quote_mint: CREATOR, quote_vault: CREATOR, to: CREATOR, token_program: E.TOKEN_2022 }), /token_program must be/);
  assert.throws(() => E.buildFromIdl(E.CURVE_IDL, 'claim_creator_fees', { launch: CREATOR, launch_signer: CREATOR, quote_mint: CREATOR, quote_vault: CREATOR }), /account to missing/);
  assert.throws(() => E.buildFromIdl(E.CURVE_IDL, 'claim_creator_fees', { launch: CREATOR, launch_signer: CREATOR, quote_mint: CREATOR, quote_vault: CREATOR, to: CREATOR, rogue: CREATOR }), /unknown accounts rogue/);
  assert.throws(() => E.buildFromIdl(E.CURVE_IDL, 'withdraw_everything', {}), /not in the pinned/);
  assert.throws(() => E.computeUnitLimitIx(0), RangeError);
});
