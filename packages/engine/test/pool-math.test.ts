// qf-pool swap quotes: independently computed vectors for a just-graduated devnetSmall coin, the fee side rules,
// and the refusals. The localnet run (scripts/localnet-run.ts) checks the same function against the real program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/index.ts';

const COIN = 'Ao11111111111111111111111111111111111111112', QUOTE = 'So11111111111111111111111111111111111111112';
const cfg: E.AmmConfig = { bump: 255, disableCreatePool: false, index: 0, tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, fundFeeRate: 0n, creatorFeeRate: 500n, creatorFeeShareRate: 0n,
  createPoolFee: 0n, protocolOwner: QUOTE, fundOwner: QUOTE };
// coin is token 0, so graduation set creator_fee_on = 2 (only token 1, the quote)
const pool = (over: Partial<E.PoolState> = {}): E.PoolState => ({
  ammConfig: QUOTE, poolCreator: QUOTE, token0Vault: QUOTE, token1Vault: QUOTE, lpMint: QUOTE, token0Mint: COIN, token1Mint: QUOTE, token0Program: E.TOKEN_2022, token1Program: E.TOKEN,
  observationKey: QUOTE, authBump: 255, status: 0, lpMintDecimals: 9, mint0Decimals: 6, mint1Decimals: 9, lpSupply: 0n, protocolFeesToken0: 0n, protocolFeesToken1: 0n,
  fundFeesToken0: 0n, fundFeesToken1: 0n, openTime: 0n, recentEpoch: 0n, creatorFeeOn: 2, enableCreatorFee: true, creatorFeesToken0: 0n, creatorFeesToken1: 0n, ...over,
});
const V0 = 206_900_000_000_000n, V1 = 839_000_000n; // the devnetSmall pool supply, and a round quote reserve near its opening one

test('a buy (quote in) pays the trade and creator fees on the quote it puts in', () => {
  const q = E.quotePoolSwap(pool(), cfg, QUOTE, 10_000_000n, V0, V1, 1n);
  assert.deepEqual(q, { zeroForOne: false, amountIn: 10_000_000n, amountOut: 2_429_759_591_033n, tradeFee: 25_000n, protocolFee: 5_000n, fundFee: 0n, creatorFee: 5_000n,
    creatorFeeOnInput: true, inputReserve: V1, outputReserve: V0 });
});

test('a sell (coin in) pays the trade fee in coins and the creator fee from the quote it takes out', () => {
  const q = E.quotePoolSwap(pool(), cfg, COIN, 1_000_000_000_000n, V0, V1, 1n);
  assert.deepEqual(q, { zeroForOne: true, amountIn: 1_000_000_000_000n, amountOut: 4_023_540n, tradeFee: 2_500_000_000n, protocolFee: 500_000_000n, fundFee: 0n, creatorFee: 2_013n,
    creatorFeeOnInput: false, inputReserve: V0, outputReserve: V1 });
});

test('unclaimed fees held in the vaults are not reserves; the pool\'s product never falls', () => {
  const p = pool({ protocolFeesToken1: 100n, creatorFeesToken1: 50n, protocolFeesToken0: 7n });
  const q = E.quotePoolSwap(p, cfg, QUOTE, 10_000_000n, V0 + 7n, V1 + 150n, 1n);
  assert.equal(q.inputReserve, V1); assert.equal(q.outputReserve, V0);
  for (const amount of [1_000n, 10_000_000n, 5_000_000_000n]) for (const mintIn of [COIN, QUOTE]) {
    const s = E.quotePoolSwap(pool(), cfg, mintIn, mintIn === COIN ? amount * 1_000_000n : amount, V0, V1, 1n);
    const fees = s.creatorFeeOnInput ? s.tradeFee + s.creatorFee : s.tradeFee;
    const newIn = s.inputReserve + (s.amountIn - fees), newOut = s.outputReserve - (s.amountOut + (s.creatorFeeOnInput ? 0n : s.creatorFee));
    assert.ok(newIn * newOut >= s.inputReserve * s.outputReserve, 'constant product never falls');
  }
  assert.throws(() => E.quotePoolSwap(p, cfg, QUOTE, 1n, V0, 10n, 1n), { code: 'InsufficientVault' });
});

test('refusals: swaps disabled, before open time, wrong mint, nothing out, no creator fee when disabled', () => {
  assert.throws(() => E.quotePoolSwap(pool({ status: 4 }), cfg, QUOTE, 1_000n, V0, V1, 1n), { code: 'NotApproved' });
  assert.throws(() => E.quotePoolSwap(pool({ openTime: 100n }), cfg, QUOTE, 1_000n, V0, V1, 99n), { code: 'NotApproved' });
  assert.throws(() => E.quotePoolSwap(pool(), cfg, E.TOKEN, 1_000n, V0, V1, 1n), { code: 'InvalidVault' });
  assert.throws(() => E.quotePoolSwap(pool(), cfg, COIN, 1n, V0, V1, 1n), { code: 'ZeroTradingTokens' });
  assert.throws(() => E.quotePoolSwap(pool(), cfg, QUOTE, 0n, V0, V1, 1n), { code: 'ZeroAmount' });
  assert.equal(E.quotePoolSwap(pool({ enableCreatorFee: false }), cfg, QUOTE, 10_000_000n, V0, V1, 1n).creatorFee, 0n);
  assert.equal(E.quotePoolSwap(pool({ status: 3 }), cfg, QUOTE, 1_000n, V0, V1, 1n).amountIn, 1_000n, 'deposit/withdraw bits do not stop swaps');
});

test('curve helpers: final raise, pool supply, slippage floor', () => {
  const c = E.LAUNCH_PRESETS.devnetSmall;
  assert.equal(E.poolSupply(c), V0);
  assert.equal(E.finalRealQuote(c), 850_053_591n); // ceil(300_000_000 * 793.1e12 / (1073e12 - 793.1e12)), computed separately
  assert.ok(E.finalRealQuote(E.LAUNCH_PRESETS.standard) > 84_900_000_000n && E.finalRealQuote(E.LAUNCH_PRESETS.standard) < 85_100_000_000n, 'about 85 SOL');
  assert.equal(E.minWithSlippage(10_000n, 100), 9_900n);
  assert.equal(E.minWithSlippage(10_001n, 100), 9_900n);
  assert.throws(() => E.minWithSlippage(1n, 10_001), RangeError);
});
