// The page's own limits in txcheck.ts: a compute ceiling the server cannot raise, and a slippage floor the server cannot lower.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../../packages/engine/src/index.ts';
import { TX_BINDING_POLICY_VERSION } from '../../../packages/tx/src/terms.ts';
import { qfInstructions } from '../../../packages/tx/src/qf-engine.ts';
import { checkBuiltTransaction, slippageFloor } from '../src/launchpad/txcheck.ts';

const USER = 'A7U7bbWZH4d1gxhLoWq5aku74mSMKsU1BJZjRmhYayB9', COIN = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const BH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const u64le = (n: bigint) => Uint8Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));

async function build(units: number, microLamports: bigint) {
  const terms = { cluster: 'devnet', policyVersion: TX_BINDING_POLICY_VERSION, feePayer: USER, compute: { maxUnitLimit: units, maxUnitPriceMicroLamports: microLamports.toString() },
    kind: 'QF_SWAP', user: USER, baseMint: COIN, quoteMint: E.NATIVE_MINT, direction: 'QUOTE_TO_BASE', amountIn: '100000000', minimumAmountOut: '5000' } as const;
  const ixs = await qfInstructions(terms as never);
  const price = microLamports > 0n ? [{ programAddress: E.COMPUTE_BUDGET, data: Uint8Array.from([3, ...u64le(microLamports)]) }] : [];
  const { bytes } = E.compileUnsigned({ feePayer: USER, blockhash: BH, lastValidBlockHeight: 1n, instructions: [...price, ...ixs] as never, computeUnits: units });
  return checkBuiltTransaction(bytes, terms as never, { kind: 'QF_SWAP', wallet: USER, cluster: 'devnet',
    fields: { user: USER, baseMint: COIN, quoteMint: E.NATIVE_MINT, direction: 'QUOTE_TO_BASE', amountIn: '100000000' }, minimumAmountOutAtLeast: '5000', shown: {} });
}

test('a swap built the way the server builds it today passes', async () => {
  const r = await build(400_000, 0n);
  assert.deepEqual(r.checks.filter((c) => !c.ok), []);
});

test('a server asking for the largest compute budget packages/tx allows is refused by the page', async () => {
  const r = await build(1_400_000, 10_000_000n);
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.label), ['Network fee stays small']);
});

test('slippage floor: computed from what was shown, same rounding as the servers, never zero by accident', () => {
  assert.equal(slippageFloor(1_000_000n, 100), 990_000n);
  assert.equal(slippageFloor(999n, 100), 989n);                 // floor, like E.minWithSlippage
  assert.equal(slippageFloor(999n, 100), E.minWithSlippage(999n, 100));
  assert.equal(slippageFloor(0n, 100), 0n);                     // nothing expected: no safe floor, the page refuses
  assert.equal(slippageFloor(1_000n, 10_000), 0n);
  assert.equal(slippageFloor(1_000n, 1.5), 0n);
});
