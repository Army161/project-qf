// MOCK fixtures for the offline lifecycle UI. Synthetic values only; TEST_ONLY provider class.
import type { PoolObservation, PriceObservation, RouteQuote } from '@project-qf/core';

export const NOW = '2026-09-27T12:00:00.000Z';
const AT = '2026-09-27T11:59:30.000Z';
// Synthetic mints: base58(sha256('QF-MOCK:<label>')); well-formed addresses with no known key or asset.
export const QUSD = { mint: 'EtriFwkv36LDftunesYPdxScW2KU5BK55pcm7qwBonXn', symbol: 'qUSD (TEST_ONLY)', decimals: 6 };
const USDC = 'FdWUgxyww9mEQhcaQ1VDgVgmtgQWn6pBHPkZoZWyK2Gi'; // 'usdc-devnet-mock-mint'
export const SOL = 'So11111111111111111111111111111111111111112';

export const prices: PriceObservation[] = [QUSD.mint, USDC].flatMap((mint) =>
  ['pyth-fixture', 'indexer-fixture'].map((source) => ({ mint, source, providerClass: 'TEST_ONLY' as const, priceUsd: '1.00', observedAt: AT })));
export const pools: PoolObservation[] = [
  { chain: 'solana', venue: 'fixture-amm', poolAddress: 'MOCKpoolA', provider: 'indexer-fixture', providerClass: 'TEST_ONLY',
    sideA: { mint: QUSD.mint, decimals: 6, reserveRaw: '60000000000' }, sideB: { mint: USDC, decimals: 6, reserveRaw: '60000000000' }, observedAt: AT },
  { chain: 'solana', venue: 'fixture-amm', poolAddress: 'MOCKpoolA', provider: 'second-fixture', providerClass: 'TEST_ONLY',
    sideA: { mint: QUSD.mint, decimals: 6, reserveRaw: '60000000000' }, sideB: { mint: USDC, decimals: 6, reserveRaw: '60000000000' }, observedAt: AT },
];
export const routes: RouteQuote[] = [SOL, USDC].map((outputMint) => ({ provider: 'indexer-fixture', providerClass: 'TEST_ONLY' as const,
  inputMint: QUSD.mint, outputMint, notionalRaw: '5000000000', filledRaw: '5000000000', priceImpactBps: 90, observedAt: AT }));
export const exitMints = [SOL, USDC];

export const holders = [
  { owner: 'Vote111111111111111111111111111111111111111', history: [{ t: 0, balanceRaw: 600_000_000n }] },
  { owner: 'Stake11111111111111111111111111111111111111', history: [{ t: 0, balanceRaw: 300_000_000n }, { t: 1500, balanceRaw: 0n }] },
  { owner: 'Config1111111111111111111111111111111111111', history: [{ t: 1200, balanceRaw: 100_000_000n }] },
  { owner: 'SysvarRent111111111111111111111111111111111', history: [{ t: 0, balanceRaw: 900_000_000_000n }] },
];
export const exclusions = [{ owner: 'SysvarRent111111111111111111111111111111111', reason: 'DBC_VAULT (fixture)' }];
