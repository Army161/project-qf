// What the engine launchpad shows and quotes, from chain state only: the platform's settings (the curve program's Global
// and the pool config it graduates into), one coin's live numbers, and exact quotes made with the engine package's own
// math (the same integer arithmetic the programs run). Prices are fixed point: quote base units per whole coin, x1e18.
import { economicsDigest } from '@project-qf/policy';
import * as E from '@project-qf/engine';
import type { EngineChain } from './chain.ts';

export interface QuoteAsset { mint: string; decimals: number; symbol: string; label: string }
/** Every engine coin is quoted in SOL (wrapped for the programs, plain SOL in the wallet). */
export const SOL_QUOTE: QuoteAsset = Object.freeze({ mint: E.NATIVE_MINT, decimals: 9, symbol: 'SOL', label: 'test SOL' });
/** What a creator consents to before launching: every number that decides how their coin trades, as the chain holds it. */
export interface EngineEconomics {
  engine: 'qf'; programs: { curve: string; pool: string }; quoteMint: string; baseDecimals: number;
  totalSupply: string; curveSupply: string; poolSupply: string; virtualQuote: string; virtualBase: string;
  tradeFeeBps: number; creatorFeeShareBps: number; graduationFee: string; graduationQuote: string;
  pool: { ammConfig: string; tradeFeeRate: string; protocolFeeRate: string; fundFeeRate: string; creatorFeeRate: string };
}
export interface EnginePlatform {
  quote: QuoteAsset; global: string; settings: E.Global; poolConfig: E.AmmConfig;
  /** quote raised when the last curve coin is sold: the graduation point */
  graduationQuoteRaw: bigint;
  economics: EngineEconomics; economicsDigest: string;
}

/** The curve program's settings for this quote and the pool config they graduate into; null while the engine is not set
 *  up on this network. */
export async function readPlatform(chain: EngineChain, quote: QuoteAsset): Promise<EnginePlatform | null> {
  const global = await E.globalAddress(quote.mint);
  const [g] = await chain.read([global]);
  if (!g) return null;
  const settings = E.decodeGlobal(g);
  if (settings.quoteMint !== quote.mint) throw new Error('GLOBAL_QUOTE_MISMATCH');
  const [c] = await chain.read([settings.ammConfig]);
  if (!c) throw new Error('POOL_CONFIG_MISSING');
  const poolConfig = E.decodeAmmConfig(c);
  const cfg = settings.config;
  const economics: EngineEconomics = {
    engine: 'qf', programs: { curve: E.QF_CURVE, pool: E.QF_POOL }, quoteMint: quote.mint, baseDecimals: E.BASE_DECIMALS,
    totalSupply: cfg.totalSupply.toString(), curveSupply: cfg.curveSupply.toString(), poolSupply: E.poolSupply(cfg).toString(),
    virtualQuote: cfg.virtualQuote.toString(), virtualBase: cfg.virtualBase.toString(), tradeFeeBps: Number(cfg.tradeFeeBps), creatorFeeShareBps: Number(cfg.creatorFeeShareBps),
    graduationFee: cfg.graduationFee.toString(), graduationQuote: E.finalRealQuote(cfg).toString(),
    pool: { ammConfig: settings.ammConfig, tradeFeeRate: poolConfig.tradeFeeRate.toString(), protocolFeeRate: poolConfig.protocolFeeRate.toString(),
      fundFeeRate: poolConfig.fundFeeRate.toString(), creatorFeeRate: poolConfig.creatorFeeRate.toString() },
  };
  return { quote, global, settings, poolConfig, graduationQuoteRaw: E.finalRealQuote(cfg), economics, economicsDigest: economicsDigest(economics) };
}

/** A coin as it stands: its curve, and after graduation its pool and the LP mint's supply (0 = every LP token burned). */
export interface CoinSnapshot { coin: E.CoinState; pool: E.CoinPool | null; lpMintSupply: bigint | null }
export async function readCoinSnapshot(read: E.AccountReader, mint: string, quoteMint: string): Promise<CoinSnapshot | null> {
  const coin = await E.readCoin(read, mint, quoteMint);
  if (!coin) return null;
  if (coin.launch.status !== 'Graduated') return { coin, pool: null, lpMintSupply: null };
  const pool = await E.readCoinPool(read, mint, quoteMint).catch(() => null);
  const [lp] = pool ? await read([pool.pool.lpMint]) : [null];
  return { coin, pool, lpMintSupply: lp ? E.decodeMint(lp).supply : null };
}

/** A reader that remembers what it read, so a page of coins costs two batched RPC calls instead of a few per coin. */
function memoReader(base: E.AccountReader): E.AccountReader {
  const seen = new Map<string, E.RawAccount | null>();
  return async (addrs) => {
    const miss = [...new Set(addrs.filter((a) => !seen.has(a)))];
    if (miss.length) (await base(miss)).forEach((acc, k) => seen.set(miss[k]!, acc));
    return addrs.map((a) => seen.get(a) ?? null);
  };
}
/** Many coins at once: every curve and vault in one batched read, then every graduated pool's config, vaults and LP mint
 *  in a second. A coin that cannot be read is null, never a default. */
export async function readCoinSnapshots(read: E.AccountReader, coins: { mint: string; quoteMint: string }[]): Promise<(CoinSnapshot | null)[]> {
  const memo = memoReader(read);
  const first = await Promise.all(coins.map(async (c) => {
    const a = await E.launchAccounts(c.mint, c.quoteMint);
    return [a.launch, a.baseVault, a.quoteVault, await E.launchPoolAddress(c.mint)];
  }));
  const pools = await memo(first.map((x) => x[3]!));
  await memo(first.flatMap((x) => x.slice(0, 3)));
  const second: string[] = [];
  for (const acc of pools) {
    if (!acc) continue;
    try { const p = E.decodePoolState(acc); second.push(p.ammConfig, p.token0Vault, p.token1Vault, p.lpMint); } catch { /* read again, and refused, per coin below */ }
  }
  if (second.length) await memo(second);
  return Promise.all(coins.map((c) => readCoinSnapshot(memo, c.mint, c.quoteMint).catch(() => null)));
}

const FP = 10n ** 18n, COIN_UNIT = 10n ** BigInt(E.BASE_DECIMALS);
const priceFp = (quote: bigint, base: bigint) => (base === 0n ? 0n : (quote * COIN_UNIT * FP) / base);
/** The pool's quote and coin reserves (vault balances less the fees it holds for others). */
export function poolSides(p: E.CoinPool, quoteMint: string) {
  const { reserve0, reserve1 } = E.poolReserves(p.pool, p.vault0, p.vault1);
  const quoteIs0 = p.pool.token0Mint === quoteMint;
  return { quote: quoteIs0 ? reserve0 : reserve1, base: quoteIs0 ? reserve1 : reserve0, quoteIs0,
    creatorFeesQuote: quoteIs0 ? p.pool.creatorFeesToken0 : p.pool.creatorFeesToken1 };
}

export interface LiveView {
  /** null after graduation while the pool cannot be read: never the finished curve's price */
  priceQuotePerBase: string | null; marketCapQuoteRaw: string | null; priceUnavailable: boolean; launchPriceQuotePerBase: string;
  quoteReserve: string; migrationQuoteThreshold: string; progressBps: number; curveComplete: boolean; isMigrated: boolean;
  baseDecimals: number; quoteDecimals: number; totalSupplyRaw: string;
  /** the creator's unclaimed curve fees */
  creatorQuoteFee: string;
  /** the creator's uncollected pool fees (after graduation) */
  creatorPoolFee: string | null;
  /** share of the pool's liquidity that can never be withdrawn: 100% once every LP token is burned */
  lockedBps: number | null;
  venue: 'CURVE' | 'POOL';
}
export function liveView(p: EnginePlatform, s: CoinSnapshot | null, graduated: boolean): LiveView | null {
  if (!s) return null;
  const l = s.coin.launch, cfg = l.config;
  const start = E.spotPrice(cfg, 0n, 0n), final = E.finalRealQuote(cfg);
  const migrated = l.status === 'Graduated' || graduated;
  let price: bigint | null, mcap: bigint | null;
  if (!migrated) {
    const sp = E.spotPrice(cfg, l.realQuote, l.baseSold);
    price = priceFp(sp.quote, sp.base); mcap = (sp.quote * cfg.totalSupply) / sp.base;
  } else if (s.pool) {
    const r = poolSides(s.pool, l.quoteMint);
    price = priceFp(r.quote, r.base); mcap = r.base === 0n ? null : (r.quote * cfg.totalSupply) / r.base;
  } else { price = null; mcap = null; }
  return {
    priceQuotePerBase: price?.toString() ?? null, marketCapQuoteRaw: mcap?.toString() ?? null, priceUnavailable: migrated && !s.pool,
    launchPriceQuotePerBase: priceFp(start.quote, start.base).toString(),
    quoteReserve: (migrated ? final : l.realQuote).toString(), migrationQuoteThreshold: final.toString(),
    progressBps: migrated || final === 0n ? 10_000 : Number(l.realQuote >= final ? 10_000n : (l.realQuote * 10_000n) / final),
    curveComplete: l.status !== 'Trading', isMigrated: migrated, baseDecimals: E.BASE_DECIMALS, quoteDecimals: p.quote.decimals, totalSupplyRaw: cfg.totalSupply.toString(),
    creatorQuoteFee: l.creatorFees.toString(), creatorPoolFee: s.pool ? poolSides(s.pool, l.quoteMint).creatorFeesQuote.toString() : null,
    lockedBps: s.lpMintSupply === null ? null : s.lpMintSupply === 0n ? 10_000 : null,
    venue: migrated ? 'POOL' : 'CURVE',
  };
}

export interface EngineQuote {
  venue: 'CURVE' | 'POOL'; side: 'buy' | 'sell'; amountIn: string; expectedOut: string; minimumAmountOut: string;
  /** every fee this trade pays, by unit: on the curve all in the quote; in the pool a sell's trade fee is in the coin */
  feeQuoteRaw: string; feeBaseRaw: string;
  /** the same fee for older screens: tradingFee + protocolFee is the quote-side fee */
  tradingFee: string; protocolFee: string;
  priceImpactBps: number;
  /** a buy that sells the last curve coin; it pays only for what is left, and the coin graduates */
  completesCurve: boolean;
}
const impact = (atSpot: bigint, actual: bigint) => (atSpot <= 0n || actual >= atSpot ? 0 : Number(((atSpot - actual) * 10_000n) / atSpot));
/** Curve quote with the engine's math. Throws CurveMathError for what the program would refuse. */
export function quoteCurve(l: E.Launch, side: 'buy' | 'sell', amountIn: bigint, slippageBps: number): EngineQuote {
  const sp = E.spotPrice(l.config, l.realQuote, l.baseSold);
  if (side === 'buy') {
    const r = E.quoteBuy(l.config, l.realQuote, l.baseSold, amountIn);
    return { venue: 'CURVE', side, amountIn: r.quoteIn.toString(), expectedOut: r.baseOut.toString(), minimumAmountOut: E.minWithSlippage(r.baseOut, slippageBps).toString(),
      feeQuoteRaw: r.fee.toString(), feeBaseRaw: '0', tradingFee: r.fee.toString(), protocolFee: '0',
      priceImpactBps: r.completes ? 0 : impact((r.quoteToCurve * sp.base) / sp.quote, r.baseOut), completesCurve: r.completes };
  }
  const r = E.quoteSell(l.config, l.realQuote, l.baseSold, amountIn);
  return { venue: 'CURVE', side, amountIn: amountIn.toString(), expectedOut: r.quoteOut.toString(), minimumAmountOut: E.minWithSlippage(r.quoteOut, slippageBps).toString(),
    feeQuoteRaw: r.fee.toString(), feeBaseRaw: '0', tradingFee: r.fee.toString(), protocolFee: '0',
    priceImpactBps: impact((amountIn * sp.quote) / sp.base, r.quoteFromCurve), completesCurve: false };
}
/** Pool quote with the pool program's math, against the chain's clock. Throws PoolMathError for what it would refuse. */
export function quotePool(p: E.CoinPool, mint: string, quoteMint: string, side: 'buy' | 'sell', amountIn: bigint, slippageBps: number, nowSec: bigint): EngineQuote {
  const r = E.quotePoolSwap(p.pool, p.config, side === 'buy' ? quoteMint : mint, amountIn, p.vault0, p.vault1, nowSec);
  const inLessFees = r.amountIn - r.tradeFee - (r.creatorFeeOnInput ? r.creatorFee : 0n);
  const swapped = r.amountOut + (r.creatorFeeOnInput ? 0n : r.creatorFee);
  const feeQuote = side === 'buy' ? r.tradeFee + r.creatorFee : r.creatorFee, feeBase = side === 'buy' ? 0n : r.tradeFee;
  return { venue: 'POOL', side, amountIn: amountIn.toString(), expectedOut: r.amountOut.toString(), minimumAmountOut: E.minWithSlippage(r.amountOut, slippageBps).toString(),
    feeQuoteRaw: feeQuote.toString(), feeBaseRaw: feeBase.toString(), tradingFee: feeQuote.toString(), protocolFee: '0',
    priceImpactBps: impact((inLessFees * r.outputReserve) / r.inputReserve, swapped), completesCurve: false };
}
