import { dec, fmt, isValidationMode, median, minDec, maxDec, ratioBps, type Dec, type PriceObservation, type ValidationMode } from '@project-qf/core';
import type { EvidencePolicy, ValidatorPolicy } from './policy.ts';
import { freshness } from './time.ts';

export interface ResolvedPrice {
  mint: string;
  status: 'OK' | 'DISAGREEMENT' | 'INSUFFICIENT';
  priceUsd?: Dec;        // OK: median; DISAGREEMENT: lowest (conservative)
  sources: string[];
  spreadBps?: bigint;
  reasons: string[];
}

export function resolvePrice(
  mint: string, observations: readonly PriceObservation[],
  ctx: { now: string; mode: ValidationMode; policy: ValidatorPolicy; evidencePolicy: EvidencePolicy },
): ResolvedPrice {
  const reasons: string[] = [];
  if (!isValidationMode(ctx.mode)) return { mint, status: 'INSUFFICIENT', sources: [], reasons: [`INVALID_MODE ${String(ctx.mode)}`] };
  // Independence is by upstream lineage (EV-1): the latest fresh observation per lineage counts once.
  const latestBySource = new Map<string, { at: number; price: Dec }>();
  for (const o of observations) {
    if (o.mint !== mint) continue;
    const tag = `${mint}@${o.source}`;
    if (ctx.mode === 'LIVE' && o.providerClass !== 'PRODUCTION') { reasons.push(`${tag}:TEST_ONLY_IN_LIVE`); continue; }
    if (ctx.mode === 'LIVE' && (typeof o.upstream !== 'string' || o.upstream.length === 0)) { reasons.push(`${tag}:MISSING_LINEAGE`); continue; }
    const lineage = o.upstream ?? o.source;
    let p: Dec;
    try { p = dec(o.priceUsd); } catch { reasons.push(`${tag}:INVALID_PRICE`); continue; }
    if (p <= 0n) { reasons.push(`${tag}:INVALID_PRICE`); continue; }
    const f = freshness(o.observedAt, ctx.now, ctx.evidencePolicy.priceMaxAgeSeconds, ctx.evidencePolicy.maxClockSkewSeconds);
    if (f !== 'FRESH') { reasons.push(`${tag}:${f}`); continue; }
    const at = Date.parse(o.observedAt);
    const prev = latestBySource.get(lineage);
    if (prev) reasons.push(`${tag}:SAME_LINEAGE(${lineage})`);
    if (!prev || at > prev.at) latestBySource.set(lineage, { at, price: p });
  }
  const sources = [...latestBySource.keys()].sort();
  const values = sources.map((s) => latestBySource.get(s)!.price);
  if (values.length < ctx.evidencePolicy.minIndependentPriceSources) {
    reasons.push(`${mint}:INSUFFICIENT_SOURCES(${values.length}<${ctx.evidencePolicy.minIndependentPriceSources})`);
    return { mint, status: 'INSUFFICIENT', sources, reasons };
  }
  const lo = minDec(values);
  const spreadBps = ratioBps(lo, maxDec(values));
  if (spreadBps > BigInt(ctx.policy.priceDisagreementPct * 100)) {
    reasons.push(`${mint}:PRICE_DISAGREEMENT(${spreadBps}bps) using lowest ${fmt(lo)}`);
    return { mint, status: 'DISAGREEMENT', priceUsd: lo, sources, spreadBps, reasons };
  }
  return { mint, status: 'OK', priceUsd: median(values), sources, spreadBps, reasons };
}
