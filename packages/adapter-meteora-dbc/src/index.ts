// SERVER-ONLY adapter. The only QF module that imports @meteora-ag/* and @solana/web3.js v1.
// Browser code must never import this file (enforced by tools/boundary). LGPL exception
// QF-LIC-EX-001 covers the transitive rpc-websockets@9.3.9 for this use only.
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DammV2DynamicFeeMode, DynamicBondingCurveClient, MigratedCollectFeeMode,
  MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType, buildCurve, swapQuoteExactIn,
  swapQuotePartialFill, getQuoteReserveFromNextSqrtPrice, type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import type { CurveTemplate, EconomicsPolicy, MigrationThresholdRecord } from '@project-qf/policy';
import { DBC_IDL_SUBSET, normalizeToIdl, configParametersDigest } from '@project-qf/tx';

if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  throw new Error('@project-qf/adapter-meteora-dbc is server-only and must not run in a browser');
}

export const ADAPTER_PINS = Object.freeze({
  dbcSdk: '@meteora-ag/dynamic-bonding-curve-sdk@1.5.13',
  cpAmmSdk: '@meteora-ag/cp-amm-sdk@1.4.10',
  web3js: '@solana/web3.js@1.99.0',
  dbcProgram: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  dammV2Program: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
});
/** Customizable-fee DAMM v2 migration config (SDK constant; same for all clusters per SDK source). */
export const DAMM_V2_CUSTOMIZABLE_CONFIG = new PublicKey('A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck');

const enumOf = <T extends Record<string, unknown>>(e: T, name: string): T[keyof T] => {
  if (!(name in e)) throw new Error(`unknown SDK enum member ${name}`);
  return e[name as keyof T];
};

/** Raw integer -> exact decimal string in UI units (no float formatting). */
export function rawToUiString(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/**
 * Maps QF policy objects to SDK `buildCurve` params. The migration quote threshold comes from the
 * Decision-3 record (raw units); `migrationMarketCap` is never used.
 */
export function toBuildCurveParams(t: CurveTemplate, e: EconomicsPolicy, threshold: MigrationThresholdRecord) {
  const f = t.fee.feeSchedulerParam;
  const ui = rawToUiString(BigInt(threshold.rawQuoteThreshold), threshold.quoteDecimals);
  // The SDK takes a JS number here; refuse any value a double cannot carry exactly.
  if (String(Number(ui)) !== ui) throw new Error(`FAIL_CLOSED: threshold ${ui} is not exactly representable for the SDK`);
  return {
    token: {
      tokenType: enumOf(TokenType, t.token.tokenType === 'SPLToken' ? 'SPLToken' : 'Token2022'),
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: threshold.quoteDecimals,
      tokenAuthorityOption: enumOf(TokenAuthorityOption, t.token.tokenAuthorityOption),
      totalTokenSupply: Number(t.token.totalTokenSupply),
      leftover: Number(t.token.leftover),
    },
    fee: {
      baseFeeParams: { baseFeeMode: enumOf(BaseFeeMode, t.fee.baseFeeMode) as BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: f.startingFeeBps, endingFeeBps: f.endingFeeBps, numberOfPeriod: f.numberOfPeriod, totalDuration: f.totalDuration } },
      dynamicFeeEnabled: t.fee.dynamicFeeEnabled,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: e.creatorTradingFeePct,
      poolCreationFee: Number(e.poolCreationFeeLamports),
      enableFirstSwapWithMinFee: t.fee.enableFirstSwapWithMinFee,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: e.migrationExtractionFeePct, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: e.migratedPoolFeeBps },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: e.lp.partnerPermanentLockedPct, partnerLiquidityPercentage: e.lp.partnerClaimablePct,
      creatorPermanentLockedLiquidityPercentage: e.lp.creatorPermanentLockedPct, creatorLiquidityPercentage: e.lp.creatorClaimablePct,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: t.percentageSupplyOnMigration,
    migrationQuoteThreshold: Number(ui),
  };
}

/** Builds DBC ConfigParameters and fails closed unless the stored threshold equals the approved raw amount. */
export function buildCurveConfig(t: CurveTemplate, e: EconomicsPolicy, threshold: MigrationThresholdRecord): ConfigParameters {
  const cfg = buildCurve(toBuildCurveParams(t, e, threshold) as never);
  const stored = cfg.migrationQuoteThreshold.toString();
  if (stored !== threshold.rawQuoteThreshold) {
    throw new Error(`FAIL_CLOSED: SDK migrationQuoteThreshold ${stored} != approved raw ${threshold.rawQuoteThreshold}`);
  }
  return cfg;
}

/**
 * Digest of the exact ConfigParameters the server will send, in the same decoded form the browser-safe
 * preview decoder produces from wire bytes. Goes into CREATE_CONFIG terms (QF-SEC-01 binding).
 */
export async function approvedConfigParametersDigest(cfg: ConfigParameters): Promise<string> {
  return configParametersDigest(normalizeToIdl(cfg, { defined: { name: 'ConfigParameters' } }, DBC_IDL_SUBSET.types));
}

export const createDbcClient = (connection: Connection) => new DynamicBondingCurveClient(connection, 'confirmed');

/**
 * SEC-A input bounds: a fetch wrapper for any live @solana/web3.js Connection built by QF. Response bodies larger
 * than `maxBytes` or JSON nested deeper than `maxDepth` are refused before any parser (web3.js JSON.parse, jayson,
 * stream-json) sees them. Not used by the MOCK fixtures, which never touch a network.
 */
export const RPC_RESPONSE_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxDepth: 64, timeoutMs: 30_000 });
export function jsonNestingDepth(text: string): number {
  let depth = 0, max = 0, inStr = false, esc = false;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 91 || c === 123) { if (++depth > max) max = depth; }
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}
export interface BoundedFetchOptions { maxBytes?: number; maxDepth?: number; timeoutMs?: number; fetchImpl?: typeof fetch }
/**
 * BODY-LIMIT (2026-09-27 decision review): bytes are counted while the body streams, so an oversized body is cancelled
 * before it is accumulated; a declared oversize is refused before reading; the deadline covers headers AND body.
 */
export function createBoundedFetch({ maxBytes = RPC_RESPONSE_LIMITS.maxBytes, maxDepth = RPC_RESPONSE_LIMITS.maxDepth,
  timeoutMs = RPC_RESPONSE_LIMITS.timeoutMs, fetchImpl = fetch }: BoundedFetchOptions = {}) {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(new Error('RPC_RESPONSE_TIMEOUT')); }, timeoutMs);
    const onCallerAbort = () => ac.abort(init?.signal?.reason ?? new Error('aborted by caller'));
    if (init?.signal?.aborted) onCallerAbort(); else init?.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const fail = (e: unknown): never => { throw timedOut ? new Error(`RPC_RESPONSE_TIMEOUT after ${timeoutMs} ms`) : e; };
    try {
      const res = await fetchImpl(input, { ...init, signal: ac.signal }).catch(fail);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > maxBytes) { await res.body?.cancel().catch(() => {}); throw new Error(`RPC_RESPONSE_TOO_LARGE declared ${declared} > ${maxBytes}`); }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        const onAbort = () => { reader.cancel().catch(() => {}); };
        ac.signal.addEventListener('abort', onAbort, { once: true });
        try {
          for (;;) {
            const { done, value } = await reader.read().catch(fail);
            if (ac.signal.aborted) fail(ac.signal.reason);
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error(`RPC_RESPONSE_TOO_LARGE ${total}+ > ${maxBytes} (stopped while streaming)`); }
            chunks.push(value);
          }
        } finally { ac.signal.removeEventListener('abort', onAbort); }
      }
      const buf = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
      const text = new TextDecoder().decode(buf);
      const depth = jsonNestingDepth(text);
      if (depth > maxDepth) throw new Error(`RPC_RESPONSE_TOO_DEEP ${depth} > ${maxDepth}`);
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', onCallerAbort);
    }
  };
}
/** The only way QF code should construct a live Connection: bounded responses, no automatic rate-limit retries. */
export const createBoundedConnection = (url: string, limits: { maxBytes?: number; maxDepth?: number; timeoutMs?: number } = {}) =>
  new Connection(url, { commitment: 'confirmed', fetch: createBoundedFetch(limits) as never, disableRetryOnRateLimit: true });

/**
 * Pure SDK quote math for offline simulation (Decision 5). Normalises a buildCurve output with the SDK's
 * own PoolService normaliser (the path getQuoteFromInputAmount uses), then exposes exact-in and
 * partial-fill quotes over an explicit pool state. No RPC, no transactions.
 */
export function createQuoteSimulator(cfg: ConfigParameters) {
  const pool = createDbcClient(new Connection('http://offline.invalid')).pool as unknown as { normalizeQuoteConfig(c: unknown): unknown };
  const norm = pool.normalizeQuoteConfig(cfg) as ConfigParameters & { migrationSqrtPrice: BN };
  const zeroVol = { lastUpdateTimestamp: new BN(0), sqrtPriceReference: new BN(0), volatilityAccumulator: new BN(0), volatilityReference: new BN(0), padding: [] };
  const state = (sqrtPrice: bigint, quoteReserve: bigint) => ({ poolState: { sqrtPrice: new BN(sqrtPrice.toString()), quoteReserve: new BN(quoteReserve.toString()),
    baseReserve: new BN(0), activationPoint: new BN(0), volatilityTracker: zeroVol } });
  const big = (b: BN) => BigInt(b.toString());
  const run = (fn: typeof swapQuoteExactIn, sqrtPrice: bigint, quoteReserve: bigint, sell: boolean, amountIn: bigint, t: number) => {
    const r = fn(state(sqrtPrice, quoteReserve) as never, norm as never, sell, new BN(amountIn.toString()), 0, false, new BN(t), false);
    return { includedIn: big(r.includedFeeInputAmount), excludedIn: big(r.excludedFeeInputAmount), out: big(r.outputAmount), nextSqrtPrice: big(r.nextSqrtPrice),
      tradingFee: big(r.tradingFee), protocolFee: big(r.protocolFee), referralFee: big(r.referralFee), amountLeft: big(r.amountLeft) };
  };
  return {
    sqrtStartPrice: big(norm.sqrtStartPrice),
    migrationSqrtPrice: big(norm.migrationSqrtPrice),
    migrationQuoteThreshold: big(norm.migrationQuoteThreshold),
    buyPartialFill: (sqrtPrice: bigint, quoteReserve: bigint, quoteIn: bigint, t: number) => run(swapQuotePartialFill, sqrtPrice, quoteReserve, false, quoteIn, t),
    sellExactIn: (sqrtPrice: bigint, quoteReserve: bigint, baseIn: bigint, t: number) => run(swapQuoteExactIn, sqrtPrice, quoteReserve, true, baseIn, t),
    quoteReserveAt: (sqrtPrice: bigint) => big(getQuoteReserveFromNextSqrtPrice(new BN(sqrtPrice.toString()), norm as never)),
  };
}

/** Serialize an unsigned SDK transaction for independent preview decoding (no signatures added). */
export function serializeUnsigned(tx: Transaction, feePayer: PublicKey, recentBlockhash: string): Uint8Array {
  tx.feePayer = feePayer;
  tx.recentBlockhash = recentBlockhash;
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
