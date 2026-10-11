// The curve's math, mirroring qf-curve programs/qf-curve/src/math.rs line for line in BigInt, including the checks
// that make the program refuse a trade. The curve is constant product over virtual reserves:
//   quote reserve = virtualQuote + realQuote,  base reserve = virtualBase - baseSold.
// Every division rounds in the curve's favour. test/math.test.ts checks this against the engine's own client.
import type { LaunchConfig } from './config.ts';

export const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

/** A trade the program would refuse; `code` is the program's error name. */
export class CurveMathError extends Error {
  readonly code: 'ZeroAmount' | 'NotTrading' | 'InsufficientCurveTokens' | 'MathOverflow';
  constructor(code: CurveMathError['code']) { super(code); this.name = 'CurveMathError'; this.code = code; }
}
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const toU64 = (v: bigint) => { if (v < 0n || v > U64_MAX) throw new CurveMathError('MathOverflow'); return v; };
function reserves(c: LaunchConfig, realQuote: bigint, baseSold: bigint) {
  const b = c.virtualBase - baseSold;
  if (b < 0n) throw new CurveMathError('MathOverflow');
  return { q: c.virtualQuote + realQuote, b };
}

/** Fee on a quote amount, rounded down. */
export const feeOf = (c: LaunchConfig, quote: bigint) => (quote * c.tradeFeeBps) / BPS;
/** Splits a fee into the platform's and the creator's share; the creator's rounds down. */
export function splitFee(c: LaunchConfig, fee: bigint) {
  const creator = (fee * c.creatorFeeShareBps) / BPS;
  return { platform: fee - creator, creator };
}

export interface BuyResult {
  /** Quote taken from the buyer, fee included; at most the amount offered. */
  quoteIn: bigint;
  /** Quote added to the curve's reserve (quoteIn - fee). */
  quoteToCurve: bigint;
  baseOut: bigint;
  fee: bigint;
  /** True when this buy sold the last curve coin. */
  completes: boolean;
}
/** A buy with up to `quoteOffered` (fee included). A buy that would overshoot the curve is clipped and pays only for what is left. */
export function quoteBuy(c: LaunchConfig, realQuote: bigint, baseSold: bigint, quoteOffered: bigint): BuyResult {
  if (quoteOffered <= 0n) throw new CurveMathError('ZeroAmount');
  const { q, b } = reserves(c, realQuote, baseSold);
  const left = c.curveSupply - baseSold;
  if (left <= 0n) throw new CurveMathError('NotTrading');
  const fee = feeOf(c, quoteOffered);
  const net = quoteOffered - fee;
  const out = (b * net) / (q + net);
  if (out < left) {
    if (out <= 0n) throw new CurveMathError('ZeroAmount');
    return { quoteIn: quoteOffered, quoteToCurve: toU64(net), baseOut: toU64(out), fee, completes: false };
  }
  // The offer buys everything left: charge only what the last coins cost.
  const net2 = toU64(ceilDiv(q * left, b - left));
  const gross = toU64(ceilDiv(net2 * BPS, BPS - c.tradeFeeBps));
  // Rounding can put the recomputed gross one unit above the offer; the offer then pays a slightly smaller fee.
  const quoteIn = gross < quoteOffered ? gross : quoteOffered;
  if (quoteIn < net2) throw new CurveMathError('MathOverflow');
  return { quoteIn, quoteToCurve: net2, baseOut: toU64(left), fee: quoteIn - net2, completes: true };
}

export interface SellResult {
  /** Quote removed from the curve's reserve. */
  quoteFromCurve: bigint;
  /** Quote paid to the seller (quoteFromCurve - fee). */
  quoteOut: bigint;
  fee: bigint;
}
/** A sell of `baseIn` coins back to the curve. */
export function quoteSell(c: LaunchConfig, realQuote: bigint, baseSold: bigint, baseIn: bigint): SellResult {
  if (baseIn <= 0n) throw new CurveMathError('ZeroAmount');
  if (baseIn > baseSold) throw new CurveMathError('InsufficientCurveTokens');
  const { q, b } = reserves(c, realQuote, baseSold);
  const gross = toU64((q * baseIn) / (b + baseIn));
  if (gross > realQuote) throw new CurveMathError('MathOverflow');
  const fee = feeOf(c, gross);
  const quoteOut = gross - fee;
  if (quoteOut <= 0n) throw new CurveMathError('ZeroAmount');
  return { quoteFromCurve: gross, quoteOut, fee };
}

/** Coins that seed the pool at graduation. */
export const poolSupply = (c: LaunchConfig) => c.totalSupply - c.curveSupply;
/** Quote the curve holds once every curve coin is sold (rounded up, as a buy charges). */
export const finalRealQuote = (c: LaunchConfig) => toU64(ceilDiv(c.virtualQuote * c.curveSupply, c.virtualBase - c.curveSupply));

/** The current price as an exact fraction: quote base units per coin base unit. */
export function spotPrice(c: LaunchConfig, realQuote: bigint, baseSold: bigint) {
  const { q, b } = reserves(c, realQuote, baseSold);
  return { quote: q, base: b };
}

/** The least output a trade accepts at `slippageBps` below the expected output (rounded down). */
export function minWithSlippage(expected: bigint, slippageBps: number) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new RangeError('slippage must be 0..10000 bps');
  return (expected * (BPS - BigInt(slippageBps))) / BPS;
}
