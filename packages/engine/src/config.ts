// Launch and pool settings the engine was built and tested with (engine-qf client/qf.mjs CONFIGS and POOL_CONFIG).
// The chain is the source of truth: every coin carries a copy of the settings it was created with, and quotes are
// computed from that copy (accounts.ts), never from these presets.

/** The rules a coin copies at creation (qf-curve LaunchConfig). Amounts in base units. */
export interface LaunchConfig {
  /** Coins minted once, in base units (6 decimals). */
  totalSupply: bigint;
  /** Coins sold on the curve; the rest seed the pool at graduation. */
  curveSupply: bigint;
  /** Starting virtual reserves of the curve. */
  virtualQuote: bigint;
  virtualBase: bigint;
  /** Fee on every curve trade, in bps of the quote side. */
  tradeFeeBps: bigint;
  /** The creator's share of each trade fee, in bps. */
  creatorFeeShareBps: bigint;
  /** Quote the platform keeps when the coin graduates. */
  graduationFee: bigint;
}

export const LAUNCH_PRESETS = Object.freeze({
  /** 1B supply, 793.1M sold on the curve, 30 SOL virtual quote (about 85 SOL raised), 1% fee (30% of it to the creator), 1 SOL graduation fee. */
  standard: Object.freeze<LaunchConfig>({
    totalSupply: 1_000_000_000_000_000n, curveSupply: 793_100_000_000_000n, virtualQuote: 30_000_000_000n, virtualBase: 1_073_000_000_000_000n,
    tradeFeeBps: 100n, creatorFeeShareBps: 3_000n, graduationFee: 1_000_000_000n,
  }),
  /** The same curve at 1/10 of the quote (about 8.5 SOL raised per coin), 0.1 SOL graduation fee: the default for an
   *  early mainnet launch, so no single coin's curve holds more than about 8.5 SOL. */
  beta: Object.freeze<LaunchConfig>({
    totalSupply: 1_000_000_000_000_000n, curveSupply: 793_100_000_000_000n, virtualQuote: 3_000_000_000n, virtualBase: 1_073_000_000_000_000n,
    tradeFeeBps: 100n, creatorFeeShareBps: 3_000n, graduationFee: 100_000_000n,
  }),
  /** The same curve at 1/100 of the quote (about 0.85 SOL raised), for cheap devnet runs. Prices and percentages are identical. */
  devnetSmall: Object.freeze<LaunchConfig>({
    totalSupply: 1_000_000_000_000_000n, curveSupply: 793_100_000_000_000n, virtualQuote: 300_000_000n, virtualBase: 1_073_000_000_000_000n,
    tradeFeeBps: 100n, creatorFeeShareBps: 3_000n, graduationFee: 10_000_000n,
  }),
});

/** QF's pool config (rates in millionths): 0.25% trade fee, 20% of it (0.05%) to QF, 0.05% creator fee, no pool-creation fee. */
export const POOL_PRESET = Object.freeze({ index: 0, tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, fundFeeRate: 0n, createPoolFee: 0n, creatorFeeRate: 500n });
