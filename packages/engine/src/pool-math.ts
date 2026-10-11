// qf-pool's exact-input swap arithmetic. Derived from raydium-cp-swap (Apache-2.0; see
// third_party/raydium-cp-swap/NOTICE): curve/{calculator,fees,constant_product}.rs and the swap parameter selection
// in states/pool.rs, ported to BigInt by Project QF. Rates are in millionths. A graduated coin is a Token-2022 mint
// without a transfer-fee extension and the quote is classic SPL Token, so no transfer fee applies on either side.
import type { AmmConfig, PoolState } from './accounts.ts';

const RATE = 1_000_000n;
const ceilMul = (amount: bigint, num: bigint, den: bigint) => (amount * num + den - 1n) / den;
const floorMul = (amount: bigint, num: bigint, den: bigint) => (amount * num) / den;

export class PoolMathError extends Error {
  readonly code: 'NotApproved' | 'InvalidVault' | 'InsufficientVault' | 'ZeroTradingTokens' | 'ZeroAmount';
  constructor(code: PoolMathError['code']) { super(code); this.name = 'PoolMathError'; this.code = code; }
}

export interface PoolSwapQuote {
  /** True when the input is token 0 (the pool's first mint). */
  zeroForOne: boolean;
  amountIn: bigint;
  /** What the trader receives. */
  amountOut: bigint;
  /** The pool's trade fee (stays in the pool, less the protocol and fund shares). */
  tradeFee: bigint;
  protocolFee: bigint;
  fundFee: bigint;
  /** The coin creator's fee; on the input side when `creatorFeeOnInput`, else taken from the output. */
  creatorFee: bigint;
  creatorFeeOnInput: boolean;
  /** Reserves the swap priced against (vault balances less unclaimed fees). */
  inputReserve: bigint;
  outputReserve: bigint;
}

/** Vault balances less the fees the pool holds for others (PoolState::vault_amount_without_fee). */
export function poolReserves(p: PoolState, vault0Amount: bigint, vault1Amount: bigint) {
  const f0 = p.protocolFeesToken0 + p.fundFeesToken0 + p.creatorFeesToken0, f1 = p.protocolFeesToken1 + p.fundFeesToken1 + p.creatorFeesToken1;
  if (vault0Amount < f0 || vault1Amount < f1) throw new PoolMathError('InsufficientVault');
  return { reserve0: vault0Amount - f0, reserve1: vault1Amount - f1 };
}

/**
 * Quote an exact-input swap of `amountIn` of `mintIn`, as swap_base_input computes it. `vault0Amount`/`vault1Amount`
 * are the pool vaults' token balances; `nowSec` is the chain's clock, checked against the pool's open time (a pool
 * opens one second after the block that created it, so a swap in the graduation's own second is refused).
 */
export function quotePoolSwap(p: PoolState, cfg: AmmConfig, mintIn: string, amountIn: bigint, vault0Amount: bigint, vault1Amount: bigint, nowSec: bigint): PoolSwapQuote {
  if ((p.status & 4) !== 0 || nowSec < p.openTime) throw new PoolMathError('NotApproved');
  if (amountIn <= 0n) throw new PoolMathError('ZeroAmount');
  let zeroForOne: boolean;
  if (mintIn === p.token0Mint) zeroForOne = true;
  else if (mintIn === p.token1Mint) zeroForOne = false;
  else throw new PoolMathError('InvalidVault');
  const { reserve0, reserve1 } = poolReserves(p, vault0Amount, vault1Amount);
  const [inputReserve, outputReserve] = zeroForOne ? [reserve0, reserve1] : [reserve1, reserve0];
  // creator_fee_on: 0 both tokens, 1 only token 0, 2 only token 1 (any other value is refused by the program)
  if (p.creatorFeeOn > 2) throw new PoolMathError('NotApproved');
  const creatorFeeOnInput = p.creatorFeeOn === 0 || (p.creatorFeeOn === 1 && zeroForOne) || (p.creatorFeeOn === 2 && !zeroForOne);
  const creatorRate = p.enableCreatorFee ? cfg.creatorFeeRate : 0n;

  let creatorFee = 0n, tradeFee: bigint, inLessFees: bigint;
  if (creatorFeeOnInput) {
    // the program splits the fee by (trade + creator) rate and fails on a zero divisor
    if (cfg.tradeFeeRate + creatorRate === 0n) throw new PoolMathError('ZeroTradingTokens');
    const total = ceilMul(amountIn, cfg.tradeFeeRate + creatorRate, RATE);
    creatorFee = floorMul(total, creatorRate, cfg.tradeFeeRate + creatorRate);
    tradeFee = total - creatorFee;
    inLessFees = amountIn - total;
  } else {
    tradeFee = ceilMul(amountIn, cfg.tradeFeeRate, RATE);
    inLessFees = amountIn - tradeFee;
  }
  if (inLessFees < 0n) throw new PoolMathError('ZeroTradingTokens');
  const protocolFee = floorMul(tradeFee, cfg.protocolFeeRate, RATE);
  const fundFee = floorMul(tradeFee, cfg.fundFeeRate, RATE);
  const swapped = (inLessFees * outputReserve) / (inputReserve + inLessFees);
  let amountOut = swapped;
  if (!creatorFeeOnInput) { creatorFee = ceilMul(swapped, creatorRate, RATE); amountOut = swapped - creatorFee; }
  if (amountOut <= 0n) throw new PoolMathError('ZeroTradingTokens');
  if (swapped > outputReserve) throw new PoolMathError('InsufficientVault');
  return { zeroForOne, amountIn, amountOut, tradeFee, protocolFee, fundFee, creatorFee, creatorFeeOnInput, inputReserve, outputReserve };
}
