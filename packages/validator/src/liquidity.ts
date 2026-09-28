// S3.2: eligible liquidity of EXISTING markets for the selected quote asset (Decision 2).
// Pools are deduplicated by chain + venue + pool address; duplicate reports corroborate,
// they never add. Exit depth is a separate check (exitDepth.ts).
import { add, cmp, dec, fmt, fromRaw, isValidationMode, mul, ZERO, type CheckResult, type Dec, type Evidence, type PoolObservation,
  type PoolSide, type PriceObservation, type ValidationMode } from '@project-qf/core';
import type { EvidencePolicy, ValidatorPolicy } from './policy.ts';
import { resolvePrice, type ResolvedPrice } from './price.ts';
import { freshness } from './time.ts';

export interface LiquidityInput {
  quoteMint: string;
  now: string;
  mode: ValidationMode;
  excludeMints: readonly string[]; // QF-launched base tokens: never count their pools
  pools: readonly PoolObservation[];
  prices: readonly PriceObservation[];
  policy: ValidatorPolicy;
  evidencePolicy: EvidencePolicy;
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

export function checkQuoteMarketLiquidity(i: LiquidityInput): CheckResult {
  if (!isValidationMode(i.mode)) {
    return { id: 'S3.2', decision: 'FAIL', reason: `INVALID_INPUT: INVALID_MODE ${String(i.mode)}`, evidence: [], details: {}, policyVersion: i.policy?.id ?? 'unknown' };
  }
  const excluded: string[] = [];
  const unique = new Map<string, { obs: PoolObservation; providers: Set<string>; a: PoolSide; b: PoolSide }>();

  for (const p of i.pools) {
    const key = `${p.chain}:${p.venue}:${p.poolAddress}`;
    if (i.mode === 'LIVE' && p.providerClass !== 'PRODUCTION') { excluded.push(`${key}:TEST_ONLY_IN_LIVE`); continue; }
    if (p.chain !== 'solana') { excluded.push(`${key}:WRONG_CHAIN`); continue; }
    if (p.sideA.mint !== i.quoteMint && p.sideB.mint !== i.quoteMint) { excluded.push(`${key}:QUOTE_MINT_NOT_IN_POOL`); continue; }
    if (i.excludeMints.includes(p.sideA.mint) || i.excludeMints.includes(p.sideB.mint)) { excluded.push(`${key}:LAUNCHED_BASE_TOKEN_POOL`); continue; }
    const f = freshness(p.observedAt, i.now, i.evidencePolicy.poolMaxAgeSeconds, i.evidencePolicy.maxClockSkewSeconds);
    if (f !== 'FRESH') { excluded.push(`${key}:${f === 'STALE' ? 'STALE_POOL' : f}`); continue; }
    let ra: bigint, rb: bigint;
    try { ra = BigInt(p.sideA.reserveRaw); rb = BigInt(p.sideB.reserveRaw); } catch { excluded.push(`${key}:BAD_RESERVE`); continue; }
    if (ra < 0n || rb < 0n) { excluded.push(`${key}:BAD_RESERVE`); continue; }
    const cur = unique.get(key);
    if (!cur) { unique.set(key, { obs: p, providers: new Set([p.provider]), a: p.sideA, b: p.sideB }); continue; }
    // Same pool from another report: corroboration. Keep the lower reserve per side (conservative).
    cur.providers.add(p.provider);
    if (p.sideA.mint !== cur.a.mint || p.sideB.mint !== cur.b.mint) { excluded.push(`${key}:CONFLICTING_PAIR_REPORT`); unique.delete(key); continue; }
    cur.a = { ...cur.a, reserveRaw: minBig(BigInt(cur.a.reserveRaw), ra).toString() };
    cur.b = { ...cur.b, reserveRaw: minBig(BigInt(cur.b.reserveRaw), rb).toString() };
  }

  const priceCache = new Map<string, ResolvedPrice>();
  const price = (mint: string) => {
    let r = priceCache.get(mint);
    if (!r) { r = resolvePrice(mint, i.prices, { now: i.now, mode: i.mode, policy: i.policy, evidencePolicy: i.evidencePolicy }); priceCache.set(mint, r); }
    return r;
  };

  const quotePrice = price(i.quoteMint);
  const details: Record<string, string> = {
    uniquePools: String(unique.size),
    corroboratedPools: String([...unique.values()].filter((u) => u.providers.size > 1).length),
    excluded: excluded.join(' '),
    testOnly: String(i.mode === 'TEST_ONLY'),
  };
  const evidence: Evidence[] = [];
  const result = (decision: CheckResult['decision'], reason: string): CheckResult => {
    details.priceReasons = [...priceCache.values()].flatMap((r) => r.reasons).join(' ');
    return { id: 'S3.2', decision, reason, evidence, details, policyVersion: i.policy.id };
  };

  if (unique.size === 0) return result('FAIL', 'INSUFFICIENT_EVIDENCE: NO_ELIGIBLE_POOLS');
  if (quotePrice.status === 'INSUFFICIENT' || quotePrice.priceUsd === undefined) {
    return result('FAIL', 'INSUFFICIENT_EVIDENCE: no trustworthy quote-asset price');
  }

  let total: Dec = ZERO;
  let disagreement = quotePrice.status === 'DISAGREEMENT';
  for (const [key, u] of [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const side of [u.a, u.b]) {
      const r = price(side.mint);
      if (r.priceUsd === undefined) { excluded.push(`${key}:UNPRICED_SIDE(${side.mint})`); continue; }
      if (r.status === 'DISAGREEMENT') disagreement = true;
      total = add(total, mul(fromRaw(BigInt(side.reserveRaw), side.decimals), r.priceUsd, 'DOWN'));
    }
    evidence.push({ source: [...u.providers].sort().join('+'), providerClass: u.obs.providerClass, observedAt: u.obs.observedAt,
      ...(u.obs.slot ? { slot: u.obs.slot } : {}), note: key });
  }
  details.eligibleUsd = fmt(total);
  details.excluded = excluded.join(' ');

  let decision: CheckResult['decision'];
  const why: string[] = [];
  if (cmp(total, dec(i.policy.liquidityFailUsd)) < 0) { decision = 'FAIL'; why.push(`BELOW_FAIL_FLOOR(<${i.policy.liquidityFailUsd})`); }
  else if (cmp(total, dec(i.policy.liquidityWarnUsd)) < 0) { decision = 'WARN'; why.push(`BELOW_WARN_LINE(<${i.policy.liquidityWarnUsd})`); }
  else { decision = 'PASS'; why.push('AT_OR_ABOVE_WARN_LINE (liquidity check only)'); }
  if (disagreement) { why.push('PRICE_DISAGREEMENT: valued at lowest fresh price'); if (decision === 'PASS') decision = 'WARN'; }
  if (i.mode === 'TEST_ONLY') { why.push('TEST_ONLY_SYNTHETIC_NOT_REAL_LIQUIDITY'); if (decision === 'PASS') decision = 'WARN'; }
  return result(decision, why.join('; '));
}
