// Replays one synthetic trace against one CurveTemplate using the pinned DBC SDK 1.5.13 quote math
// (packages/adapter-meteora-dbc createQuoteSimulator). SIMULATION ONLY: no RPC, no transactions.
import { buildCurveConfig, createQuoteSimulator } from '@project-qf/adapter-meteora-dbc';
import { ECONOMICS_V0_TEST, MIGRATION_POLICY_V0, proposeMigrationThreshold, type CurveTemplate, type MigrationThresholdRecord } from '@project-qf/policy';
import { EVIDENCE_POLICY_V0_1 } from '@project-qf/validator';
import { traceHash, type Trace, type TraderClass } from './traces.ts';

const Q128 = 1n << 128n;
const E18 = 10n ** 18n;
/** Spot price in qUSD per token, 18 dp fixed point. Both mints have 6 dp, so raw ratio == UI ratio. */
export const spotPrice18 = (sqrtPrice: bigint) => (sqrtPrice * sqrtPrice * E18) / Q128;

/** Threshold record produced by the real Decision-3 policy path from TEST_ONLY fixture evidence ($5,000 target). */
export function simulationThreshold(): Readonly<MigrationThresholdRecord> {
  const now = '2026-09-27T12:00:00.000Z';
  const r = proposeMigrationThreshold({
    policy: MIGRATION_POLICY_V0, evidencePolicy: EVIDENCE_POLICY_V0_1, now, quote: { mint: 'test-only:qUSD', decimals: 6 },
    price: { status: 'OK', priceUsd: '1', sources: ['fixture-a', 'fixture-b'], observedAt: '2026-09-27T11:59:30.000Z', slot: '1' },
    liquidity: { id: 'S3.2', decision: 'PASS', reason: 'SIMULATION FIXTURE', evidence: [], details: { eligibleUsd: '300000' }, policyVersion: 'validator-v0.1' },
    exitDepth: { id: 'S3.1', decision: 'PASS', reason: 'SIMULATION FIXTURE', evidence: [], details: { notionalRaw: '5000000000' }, policyVersion: 'validator-v0.1' },
  });
  if (r.status !== 'OK' || !r.record) throw new Error(`threshold proposal failed: ${r.reasons.join()}`);
  return r.record;
}

export interface LedgerRow {
  seq: number; t: number; wallet: string; entity: string; cls: TraderClass; side: 'BUY' | 'SELL';
  status: 'FILLED' | 'PARTIAL_FILL' | 'REJECTED'; reason?: string;
  quotePaid: bigint; quoteReceived: bigint; baseIn: bigint; baseOut: bigint;
  tradingFee: bigint; protocolFee: bigint; referralFee: bigint; effectiveFeeBps: number;
  priceBefore18: bigint; priceAfter18: bigint;
}

export interface SimResult {
  template: string; traceId: string; traceHash: string;
  thresholdRaw: bigint; sqrtStartPrice: bigint;
  ledger: LedgerRow[];
  final: { sqrtPrice: bigint; quoteReserve: bigint; price18: bigint };
  holdings: Map<string, { entity: string; cls: TraderClass; base: bigint; firstBuyT: number }>;
  graduation: { completed: boolean; completedAtT: number | null; rejectedAfterCompletion: number };
  fees: { trading: bigint; protocol: bigint; referral: bigint; total: bigint; creator: bigint; partner: bigint; partnerRevenue: bigint; partnerRewards: bigint };
  conservation: { quoteExact: boolean; baseExact: boolean; feeSplitExact: boolean; reserveCoversCurve: boolean; reserveMinusCurveRaw: bigint;
    tradersQuoteIn: bigint; tradersQuoteOut: bigint };
  peakPrice18: bigint;
}

export function simulate(trace: Trace, template: CurveTemplate): SimResult {
  const threshold = simulationThreshold();
  const sim = createQuoteSimulator(buildCurveConfig(template, ECONOMICS_V0_TEST, threshold));
  let sqrt = sim.sqrtStartPrice, reserve = 0n, completedAt: number | null = null, rejectedAfter = 0;
  let peak = spotPrice18(sqrt);
  const holdings = new Map<string, { entity: string; cls: TraderClass; base: bigint; firstBuyT: number }>();
  const fees = { trading: 0n, protocol: 0n, referral: 0n };
  let qIn = 0n, qOut = 0n, baseOutTotal = 0n, baseInTotal = 0n;
  const ledger: LedgerRow[] = [];

  for (const e of trace.events) {
    const before = spotPrice18(sqrt);
    const row: LedgerRow = { seq: e.seq, t: e.t, wallet: e.wallet, entity: e.entity, cls: e.cls, side: e.side, status: 'REJECTED',
      quotePaid: 0n, quoteReceived: 0n, baseIn: 0n, baseOut: 0n, tradingFee: 0n, protocolFee: 0n, referralFee: 0n, effectiveFeeBps: 0,
      priceBefore18: before, priceAfter18: before };
    const h = holdings.get(e.wallet) ?? { entity: e.entity, cls: e.cls, base: 0n, firstBuyT: -1 };
    if (completedAt !== null) { row.reason = 'CURVE_COMPLETE'; rejectedAfter++; ledger.push(row); continue; }
    try {
      if (e.side === 'BUY') {
        const r = sim.buyPartialFill(sqrt, reserve, BigInt(e.quoteInRaw!), e.t);
        const fee = r.tradingFee + r.protocolFee + r.referralFee;
        if (r.includedIn !== r.excludedIn + fee) throw new Error('SDK buy result does not add up');
        Object.assign(row, { status: r.amountLeft > 0n ? 'PARTIAL_FILL' : 'FILLED', quotePaid: r.includedIn, baseOut: r.out,
          tradingFee: r.tradingFee, protocolFee: r.protocolFee, referralFee: r.referralFee,
          effectiveFeeBps: r.includedIn > 0n ? Number((fee * 10_000n) / r.includedIn) : 0 });
        reserve += r.excludedIn; sqrt = r.nextSqrtPrice; qIn += r.includedIn; baseOutTotal += r.out;
        h.base += r.out; if (h.firstBuyT < 0) h.firstBuyT = e.t;
        if (reserve >= sim.migrationQuoteThreshold) completedAt = e.t;
      } else {
        const baseIn = (h.base * BigInt(e.sellBps!)) / 10_000n;
        if (baseIn === 0n) { row.reason = 'NOTHING_TO_SELL'; ledger.push(row); continue; }
        const r = sim.sellExactIn(sqrt, reserve, baseIn, e.t);
        const fee = r.tradingFee + r.protocolFee + r.referralFee, gross = r.out + fee;
        Object.assign(row, { status: 'FILLED', quoteReceived: r.out, baseIn, tradingFee: r.tradingFee, protocolFee: r.protocolFee,
          referralFee: r.referralFee, effectiveFeeBps: gross > 0n ? Number((fee * 10_000n) / gross) : 0 });
        reserve -= gross; sqrt = r.nextSqrtPrice; qOut += r.out; baseInTotal += baseIn; h.base -= baseIn;
      }
      fees.trading += row.tradingFee; fees.protocol += row.protocolFee; fees.referral += row.referralFee;
      holdings.set(e.wallet, h);
    } catch (err) {
      row.reason = `SDK_REJECTED: ${(err as Error).message}`;
    }
    row.priceAfter18 = spotPrice18(sqrt);
    if (row.priceAfter18 > peak) peak = row.priceAfter18;
    ledger.push(row);
  }

  const total = fees.trading + fees.protocol + fees.referral;
  const creator = (fees.trading * BigInt(ECONOMICS_V0_TEST.creatorTradingFeePct)) / 100n;
  const partner = fees.trading - creator;
  const partnerRevenue = (partner * BigInt(ECONOMICS_V0_TEST.partnerRevenueSplitPct)) / 100n;
  const partnerRewards = partner - partnerRevenue;
  const curveQuote = sim.quoteReserveAt(sqrt);
  const held = [...holdings.values()].reduce((s, x) => s + x.base, 0n);
  return {
    template: template.version, traceId: trace.id, traceHash: traceHash(trace),
    thresholdRaw: sim.migrationQuoteThreshold, sqrtStartPrice: sim.sqrtStartPrice, ledger,
    final: { sqrtPrice: sqrt, quoteReserve: reserve, price18: spotPrice18(sqrt) }, holdings,
    graduation: { completed: completedAt !== null, completedAtT: completedAt, rejectedAfterCompletion: rejectedAfter },
    fees: { ...fees, total, creator, partner, partnerRevenue, partnerRewards },
    conservation: {
      quoteExact: qIn - qOut === reserve + total,
      baseExact: held === baseOutTotal - baseInTotal && [...holdings.values()].every((x) => x.base >= 0n),
      feeSplitExact: creator + partnerRevenue + partnerRewards === fees.trading,
      reserveCoversCurve: reserve >= curveQuote, reserveMinusCurveRaw: reserve - curveQuote,
      tradersQuoteIn: qIn, tradersQuoteOut: qOut,
    },
    peakPrice18: peak,
  };
}
