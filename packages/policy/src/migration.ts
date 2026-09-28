// Migration threshold policy (Decision 3, 2026-09-27). Keeps five quantities separate:
//   1. migration quote reserve threshold (raw quote-token units)  <- this module produces only this
//   2. USD-equivalent policy ceiling (ceilUsd)                     <- policy input
//   3. initial / migration market capitalisation                   <- never derived here
//   4. migrated pool liquidity                                     <- never derived here
//   5. creator funding / operating budget                          <- never derived here
import { cmp, dec, div, fmt, fromRaw, isIsoTimestamp, mul, toRaw, type CheckResult } from '@project-qf/core';
import type { EvidencePolicy } from '@project-qf/validator';
import { economicsDigest } from './economics.ts';

/**
 * Execution freshness (EV-1, 2026-09-27 repair): NOT DEFINED. evidence-v0.1 TTLs are analytical/eligibility limits
 * only. Until an execution policy (quote age at signing, slot distance, route re-quote) is defined and approved, no
 * recheck result permits signing; OK statuses mean only that the analytical record still holds.
 */
export const EXECUTION_FRESHNESS_POLICY = Object.freeze({ id: 'execution-freshness', status: 'UNDEFINED', signingPermitted: false } as const);

export const MIGRATION_POLICY_V0 = Object.freeze({
  id: 'migration',
  version: 'migration-v0.2',
  floorUsd: '1000',
  targetUsd: '5000',      // default for standard simulations and proposals
  ceilUsd: '100000',      // Decision 3: configurable V0 experimentation ceiling, NOT a default or optimum
  ceilRole: 'V0_EXPERIMENT_CEILING',
  rounding: 'DOWN',       // raw threshold never exceeds the requested USD at observation
} as const);
export type MigrationPolicy = typeof MIGRATION_POLICY_V0;

export interface PriceEvidence {
  status: 'OK' | 'DISAGREEMENT' | 'INSUFFICIENT';
  priceUsd: string;
  sources: string[];
  observedAt: string;
  slot?: string;
}

export interface MigrationThresholdRecord {
  quantity: 'MIGRATION_QUOTE_RESERVE_THRESHOLD';
  policyVersion: string;
  requestedUsd: string;
  quoteMint: string;
  quoteDecimals: number;
  priceUsd: string;
  priceSources: readonly string[];
  priceObservedAt: string;
  priceSlot: string | null;
  rounding: 'DOWN';
  rawQuoteThreshold: string;
  usdEquivalentAtObservation: string;
}

export interface ProposalInput {
  policy: MigrationPolicy;
  evidencePolicy: EvidencePolicy;
  now: string;
  requestedUsd?: string;
  quote: { mint: string; decimals: number };
  price: PriceEvidence;
  liquidity: CheckResult; // S3.2
  exitDepth: CheckResult; // S3.1 at the threshold notional
}
/** What a person must acknowledge: the exact WARNs, the evidence they were raised on, and the policies applied. */
export interface AcknowledgementRequirement { warnings: string[]; digest: string }
export interface ProposalResult {
  status: 'OK' | 'REQUIRES_ACKNOWLEDGEMENT' | 'REJECTED';
  record?: Readonly<MigrationThresholdRecord>;
  acknowledgement?: AcknowledgementRequirement;
  reasons: string[];
}
const DECISIONS = new Set(['PASS', 'WARN', 'FAIL', 'SKIP']);
const PRICE_STATUSES = new Set(['OK', 'DISAGREEMENT', 'INSUFFICIENT']);
const checkFingerprint = (c: CheckResult) => ({ id: c.id, decision: c.decision, reason: c.reason, details: c.details, policyVersion: c.policyVersion, evidence: c.evidence });
/**
 * Digest a person's acknowledgement must carry (tx ConsentRecord.acknowledgementDigest). It binds the WARN texts,
 * the price/liquidity/exit evidence and the policy versions, so any change in evidence or policy invalidates it.
 */
export function acknowledgementDigest(i: Pick<ProposalInput, 'policy' | 'evidencePolicy' | 'price' | 'liquidity' | 'exitDepth'>, record: MigrationThresholdRecord, warnings: string[]): string {
  return economicsDigest({ domain: 'QF-WARN-ACK', warnings, record, price: i.price, liquidity: checkFingerprint(i.liquidity), exitDepth: checkFingerprint(i.exitDepth),
    policies: { migration: i.policy.version, evidence: i.evidencePolicy.id, evidenceStatus: i.evidencePolicy.status } });
}

const priceFresh = (p: PriceEvidence, now: string, ev: EvidencePolicy) => {
  const t = Date.parse(p.observedAt), n = Date.parse(now);
  return Number.isFinite(t) && t <= n + ev.maxClockSkewSeconds * 1000 && n - t <= ev.priceMaxAgeSeconds * 1000;
};

function toRecord(i: Pick<ProposalInput, 'policy' | 'quote' | 'price'>, requestedUsd: string): Readonly<MigrationThresholdRecord> {
  const p = dec(i.price.priceUsd);
  const raw = toRaw(div(dec(requestedUsd), p, 'DOWN'), i.quote.decimals, 'DOWN');
  return Object.freeze({
    quantity: 'MIGRATION_QUOTE_RESERVE_THRESHOLD',
    policyVersion: i.policy.version,
    requestedUsd: fmt(dec(requestedUsd)),
    quoteMint: i.quote.mint,
    quoteDecimals: i.quote.decimals,
    priceUsd: fmt(p),
    priceSources: Object.freeze([...i.price.sources]),
    priceObservedAt: i.price.observedAt,
    priceSlot: i.price.slot ?? null,
    rounding: 'DOWN',
    rawQuoteThreshold: raw.toString(),
    usdEquivalentAtObservation: fmt(mul(fromRaw(raw, i.quote.decimals), p, 'DOWN')),
  });
}

export function proposeMigrationThreshold(i: ProposalInput): ProposalResult {
  const reasons: string[] = [];
  const reject = (r: string): ProposalResult => ({ status: 'REJECTED', reasons: [...reasons, r] });
  const requested = i.requestedUsd ?? i.policy.targetUsd;
  let usd;
  try { usd = dec(requested); } catch { return reject('INVALID_REQUESTED_USD'); }
  if (cmp(usd, dec(i.policy.floorUsd)) < 0) return reject(`BELOW_FLOOR(${i.policy.floorUsd})`);
  if (cmp(usd, dec(i.policy.ceilUsd)) > 0) return reject(`ABOVE_V0_EXPERIMENT_CEILING(${i.policy.ceilUsd})`);
  if (!PRICE_STATUSES.has(i.price?.status) || !isIsoTimestamp(i.price?.observedAt)) return reject('INVALID_PRICE_EVIDENCE');
  for (const c of [i.liquidity, i.exitDepth]) if (!c || !DECISIONS.has(c.decision) || typeof c.policyVersion !== 'string') return reject(`INVALID_CHECK_RESULT ${String(c?.id)}`);
  if (i.price.status !== 'OK') return reject(`PRICE_NOT_TRUSTWORTHY(${i.price.status})`);
  if (!priceFresh(i.price, i.now, i.evidencePolicy)) return reject('STALE_PRICE_REPRICE_REQUIRED');
  let p;
  try { p = dec(i.price.priceUsd); } catch { return reject('INVALID_PRICE'); }
  if (p <= 0n) return reject('INVALID_PRICE');

  if (i.liquidity.id !== 'S3.2' || i.liquidity.decision === 'FAIL' || i.liquidity.decision === 'SKIP') return reject('QUOTE_MARKET_LIQUIDITY_NOT_ELIGIBLE');
  const eligible = i.liquidity.details.eligibleUsd;
  if (eligible === undefined) return reject('QUOTE_MARKET_LIQUIDITY_UNKNOWN');
  if (cmp(usd, dec(eligible)) > 0) return reject(`THRESHOLD_EXCEEDS_ELIGIBLE_QUOTE_MARKET_LIQUIDITY(${eligible})`);

  const record = toRecord(i, requested);
  if (BigInt(record.rawQuoteThreshold) <= 0n) return reject('ZERO_RAW_THRESHOLD');
  const notional = i.exitDepth.details.notionalRaw;
  if (i.exitDepth.id !== 'S3.1' || notional === undefined || BigInt(notional) < BigInt(record.rawQuoteThreshold)) {
    return reject('EXIT_DEPTH_NOT_EVALUATED_AT_THRESHOLD_NOTIONAL');
  }
  if (i.exitDepth.decision === 'FAIL' || i.exitDepth.decision === 'SKIP') return reject('NO_EXECUTABLE_EXIT_AT_THRESHOLD_NOTIONAL');
  // QF-POL-01: every applicable WARN (liquidity S3.2 and exit depth S3.1) requires an explicit, evidence-bound acknowledgement.
  const warnings: string[] = [];
  if (i.liquidity.decision === 'WARN') warnings.push(`S3.2 WARN: ${i.liquidity.reason}`);
  if (i.exitDepth.decision === 'WARN') warnings.push(`S3.1 WARN at notional ${notional}: ${i.exitDepth.reason}`);
  if (warnings.length) {
    reasons.push(...warnings);
    return { status: 'REQUIRES_ACKNOWLEDGEMENT', record, acknowledgement: { warnings, digest: acknowledgementDigest(i, record, warnings) }, reasons };
  }
  return { status: 'OK', record, reasons };
}

export interface RecheckInput {
  record: Readonly<MigrationThresholdRecord>;
  /** digest: economicsDigest({ threshold: record }). acknowledgement: required vs. given WARN acknowledgement digests. */
  consent: { digest: string; acknowledgement?: { required: string | null; given: string | null } };
  now: string;
  currentPrice: PriceEvidence;
  evidencePolicy: EvidencePolicy;
  /** Newer non-price evidence observed since consent. Any adverse item fails closed. */
  adverse?: { routeChanged?: boolean; exitDepthDecision?: CheckResult['decision']; mintOrFreezeAuthorityChanged?: boolean; assetRevokedOrFrozen?: boolean };
}
export interface RecheckResult {
  status: 'OK' | 'OK_REPRICED_UNCHANGED' | 'REPRICE_REQUIRED' | 'NEW_CONSENT_REQUIRED';
  proposed?: Readonly<MigrationThresholdRecord>;
  reason: string;
  /** Always false in V0: EXECUTION_FRESHNESS_POLICY is undefined, so no recheck result authorises signing. */
  signingPermitted: false;
}

/**
 * Called immediately before a (future) signing step. Never mutates the approved record.
 * QF-POL-02: newer evidence is evaluated FIRST. Adverse newer evidence (contradictory or insufficient price, a changed
 * route, a failed exit, an authority change, a revoked or frozen asset) invalidates the approval even when the
 * recorded observation is still inside its analytical TTL.
 */
export function recheckBeforeSigning(i: RecheckInput): RecheckResult {
  const out = (status: RecheckResult['status'], reason: string, proposed?: Readonly<MigrationThresholdRecord>): RecheckResult =>
    ({ status, reason, signingPermitted: false, ...(proposed ? { proposed } : {}) });
  if (economicsDigest({ threshold: i.record }) !== i.consent.digest) return out('NEW_CONSENT_REQUIRED', 'consent digest does not match the record being signed');
  const ack = i.consent.acknowledgement;
  if (ack && ack.required !== null && ack.given !== ack.required) return out('NEW_CONSENT_REQUIRED', 'WARN acknowledgement missing or bound to different evidence/policy');
  const a = i.adverse ?? {};
  if (a.assetRevokedOrFrozen) return out('NEW_CONSENT_REQUIRED', 'ADVERSE: quote asset revoked or frozen');
  if (a.mintOrFreezeAuthorityChanged) return out('NEW_CONSENT_REQUIRED', 'ADVERSE: mint/freeze authority changed since consent');
  if (a.routeChanged) return out('NEW_CONSENT_REQUIRED', 'ADVERSE: exit route changed since consent');
  if (a.exitDepthDecision !== undefined && a.exitDepthDecision !== 'PASS') return out('NEW_CONSENT_REQUIRED', `ADVERSE: newer exit-depth result ${a.exitDepthDecision}`);

  const recordAt = Date.parse(i.record.priceObservedAt);
  const cur = i.currentPrice;
  const curAt = Date.parse(cur?.observedAt);
  if (cur && !isIsoTimestamp(cur.observedAt)) return out('REPRICE_REQUIRED', 'current price evidence has a malformed timestamp');
  if (cur && curAt > Date.parse(i.now) + i.evidencePolicy.maxClockSkewSeconds * 1000) return out('REPRICE_REQUIRED', 'current price evidence is future-dated beyond allowed skew');
  const newer = cur && curAt >= recordAt;
  if (newer && cur.status !== 'OK') return out('REPRICE_REQUIRED', `ADVERSE: newer price evidence is ${cur.status}; the older in-TTL observation no longer stands`);
  if (newer && priceFresh(cur, i.now, i.evidencePolicy)) {
    const proposed = toRecord({ policy: { ...MIGRATION_POLICY_V0, version: i.record.policyVersion } as MigrationPolicy,
      quote: { mint: i.record.quoteMint, decimals: i.record.quoteDecimals }, price: cur }, i.record.requestedUsd);
    if (proposed.rawQuoteThreshold !== i.record.rawQuoteThreshold) return out('NEW_CONSENT_REQUIRED', 'repriced raw threshold differs: new preview and consent required', proposed);
    return curAt === recordAt && cur.priceUsd === i.record.priceUsd
      ? out('OK', 'newest price evidence is the recorded observation (analytical only; signing not permitted in V0)')
      : out('OK_REPRICED_UNCHANGED', 'repriced on newer evidence; raw threshold unchanged (analytical only)', proposed);
  }
  const probe = { status: 'OK' as const, priceUsd: i.record.priceUsd, sources: [...i.record.priceSources], observedAt: i.record.priceObservedAt };
  if (priceFresh(probe, i.now, i.evidencePolicy)) return out('OK', 'recorded observation is the newest evidence and still inside the analytical TTL (signing not permitted in V0)');
  return out('REPRICE_REQUIRED', 'record is stale and no fresh trustworthy price is available');
}

/** After config creation the stored raw amount governs; the USD figure is informational only. */
export function governingThreshold(i: { storedRawQuoteThreshold: string; quoteDecimals: number; currentPrice: PriceEvidence }) {
  return {
    governingRaw: BigInt(i.storedRawQuoteThreshold).toString(),
    informationalUsdNow: fmt(mul(fromRaw(BigInt(i.storedRawQuoteThreshold), i.quoteDecimals), dec(i.currentPrice.priceUsd), 'DOWN')),
  };
}
