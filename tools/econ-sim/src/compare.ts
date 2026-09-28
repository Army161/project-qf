// Decision 5 comparison: flat V0_TEST baseline vs DECAY_EXPERIMENT_V0_SIM on identical traces.
// Retains every hypothesis outcome, including failures. Chooses no production template.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '@project-qf/core';
import { STANDARD_V1_FLAT_V0_TEST, DECAY_EXPERIMENT_V0_SIM } from '@project-qf/policy';
import { TRACE_SPECS, generateTrace, traceHash, type TraderClass } from './traces.ts';
import { simulate, type SimResult } from './engine.ts';

export const SIM_LABEL = 'SIMULATION ONLY: synthetic traces, SDK quote math, no RPC, no transactions. Not live results.';
export const DISCLAIMERS = [
  'Not sniper-proof: neither configuration prevents sniping, and this simulation does not show otherwise.',
  'No demand elasticity: every trace replays the same order intents under both fees, so traders do not react to a 25% fee by waiting, shrinking or skipping. Real bots would adapt (see patient_sniper).',
  'Synthetic volume says nothing about real demand, graduation likelihood or revenue.',
  'Marked values use the final spot price and are not executable exit values.',
  'Results come from @meteora-ag/dynamic-bonding-curve-sdk@1.5.13 client-side quote math, not the on-chain program; on-chain behaviour was not exercised.',
  'Production fee templates remain gated (P0-M3); nothing here selects one.',
];

const BOT: readonly TraderClass[] = ['sniper', 'sybil', 'dumper'];
const bps = (num: bigint, den: bigint) => (den === 0n ? 0 : Number((num * 10_000n) / den));
const s = (x: bigint) => x.toString();

export function metrics(r: SimResult) {
  const classes: TraderClass[] = ['organic', 'sniper', 'sybil', 'dumper'];
  const byClass: Record<string, unknown> = {};
  const soldBase = [...r.holdings.values()].reduce((a, h) => a + h.base, 0n);
  for (const c of classes) {
    const rows = r.ledger.filter((l) => l.cls === c && l.status !== 'REJECTED');
    if (!r.ledger.some((l) => l.cls === c)) continue;
    const paid = rows.reduce((a, l) => a + l.quotePaid, 0n), recv = rows.reduce((a, l) => a + l.quoteReceived, 0n);
    const fee = rows.reduce((a, l) => a + l.tradingFee + l.protocolFee + l.referralFee, 0n);
    const volume = paid + recv + rows.filter((l) => l.side === 'SELL').reduce((a, l) => a + l.tradingFee + l.protocolFee + l.referralFee, 0n);
    const base = [...r.holdings.values()].filter((h) => h.cls === c).reduce((a, h) => a + h.base, 0n);
    const marked = (base * r.final.price18) / 10n ** 18n;
    byClass[c] = { quotePaid: s(paid), quoteReceived: s(recv), feesPaid: s(fee), volume: s(volume), feeBpsOfVolume: bps(fee, volume),
      baseHeld: s(base), shareOfCurveSoldBps: bps(base, soldBase), markedValueAtSpot: s(marked), netMarkedPnl: s(recv + marked - paid),
      rejected: r.ledger.filter((l) => l.cls === c && l.status === 'REJECTED').length };
  }
  const entities = new Map<string, bigint>();
  for (const h of r.holdings.values()) entities.set(h.entity, (entities.get(h.entity) ?? 0n) + h.base);
  const shares = [...entities.values()].map((b) => bps(b, soldBase)).sort((a, b) => b - a);
  const botBase = [...r.holdings.values()].filter((h) => BOT.includes(h.cls)).reduce((a, h) => a + h.base, 0n);
  const bought = (pred: (c: TraderClass) => boolean) => r.ledger.filter((l) => l.side === 'BUY' && l.status !== 'REJECTED' && pred(l.cls)).reduce((a, l) => a + l.baseOut, 0n);
  const botRows = r.ledger.filter((l) => BOT.includes(l.cls) && l.status !== 'REJECTED');
  const botBaseHeld = botBase;
  const botPnl = botRows.reduce((a, l) => a + l.quoteReceived - l.quotePaid, 0n) + (botBaseHeld * r.final.price18) / 10n ** 18n;
  const earlyBase = [...r.holdings.values()].filter((h) => h.firstBuyT >= 0 && h.firstBuyT <= 10).reduce((a, h) => a + h.base, 0n);
  let maxMove = 0;
  for (const l of r.ledger) if (l.status !== 'REJECTED' && l.priceBefore18 > 0n) {
    const d = l.priceAfter18 > l.priceBefore18 ? l.priceAfter18 - l.priceBefore18 : l.priceBefore18 - l.priceAfter18;
    maxMove = Math.max(maxMove, bps(d, l.priceBefore18));
  }
  return {
    template: r.template, traceHash: r.traceHash,
    graduation: r.graduation,
    byClass,
    bots: { present: r.ledger.some((l) => BOT.includes(l.cls)), acquiredShareOfAllBuysBps: bps(bought((c) => BOT.includes(c)), bought(() => true)),
      netMarkedPnl: s(botPnl), heldAtEndBps: bps(botBase, soldBase) },
    concentration: { curveSoldBase: s(soldBase), botShareBps: bps(botBase, soldBase), earlyHolderShareBps: bps(earlyBase, soldBase),
      top5EntityShareBps: shares.slice(0, 5).reduce((a, x) => a + x, 0), hhiBps: Math.round(shares.reduce((a, x) => a + x * x, 0) / 10_000), entities: entities.size },
    priceDislocation: { startPrice18: s(r.ledger[0]?.priceBefore18 ?? 0n), peakPrice18: s(r.peakPrice18), finalPrice18: s(r.final.price18),
      peakToFinalDrawdownBps: bps(r.peakPrice18 - r.final.price18, r.peakPrice18), maxSingleTradeMoveBps: maxMove },
    fees: Object.fromEntries(Object.entries(r.fees).map(([k, v]) => [k, s(v)])),
    feeRealization: { totalFeeBpsOfVolume: bps(r.fees.total, r.conservation.tradersQuoteIn + r.conservation.tradersQuoteOut + r.ledger.filter((l) => l.side === 'SELL').reduce((a, l) => a + l.tradingFee + l.protocolFee + l.referralFee, 0n)) },
    conservation: { ...r.conservation, reserveMinusCurveRaw: s(r.conservation.reserveMinusCurveRaw), tradersQuoteIn: s(r.conservation.tradersQuoteIn),
      tradersQuoteOut: s(r.conservation.tradersQuoteOut), finalQuoteReserve: s(r.final.quoteReserve), thresholdRaw: s(r.thresholdRaw) },
  };
}

type M = ReturnType<typeof metrics>;
export interface Hypothesis { id: string; statement: string; outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; flat: string; decay: string }

function hypotheses(flat: M, decay: M): Hypothesis[] {
  const hasBots = flat.bots.present;
  const org = (m: M) => (m.byClass.organic as { feeBpsOfVolume: number } | undefined)?.feeBpsOfVolume ?? 0;
  const fa = flat.bots.acquiredShareOfAllBuysBps, da = decay.bots.acquiredShareOfAllBuysBps;
  const relDrop = fa === 0 ? 0 : (fa - da) / fa;
  const fp = BigInt(flat.bots.netMarkedPnl), dp = BigInt(decay.bots.netMarkedPnl);
  const cons = (m: M) => m.conservation.quoteExact && m.conservation.baseExact && m.conservation.feeSplitExact && m.conservation.reserveCoversCurve;
  return [
    { id: 'H1_BOT_ACQUISITION', statement: 'Decay cuts the bot share of all base bought on the curve by at least 20% relative to flat.',
      outcome: !hasBots ? 'NOT_APPLICABLE' : relDrop >= 0.2 ? 'PASS' : 'FAIL',
      flat: `${fa} bps`, decay: `${da} bps (${(relDrop * 100).toFixed(1)}% relative drop)` },
    { id: 'H5_BOT_PNL', statement: 'Decay lowers bot net PnL (realized plus marked at final spot) versus flat.',
      outcome: !hasBots ? 'NOT_APPLICABLE' : dp < fp ? 'PASS' : 'FAIL',
      flat: `${flat.bots.netMarkedPnl} raw qUSD`, decay: `${decay.bots.netMarkedPnl} raw qUSD` },
    { id: 'H2_ORGANIC_COST', statement: 'Decay raises the organic fee rate by no more than 50 bps of organic volume.',
      outcome: flat.byClass.organic === undefined ? 'NOT_APPLICABLE' : org(decay) - org(flat) <= 50 ? 'PASS' : 'FAIL',
      flat: `${org(flat)} bps`, decay: `${org(decay)} bps` },
    { id: 'H3_GRADUATION_UNCHANGED', statement: 'Graduation outcome is the same under both fees.',
      outcome: flat.graduation.completed === decay.graduation.completed ? 'PASS' : 'FAIL',
      flat: `${flat.graduation.completed} @ ${flat.graduation.completedAtT}`, decay: `${decay.graduation.completed} @ ${decay.graduation.completedAtT}` },
    { id: 'H4_CONSERVATION', statement: 'Quote, base and fee-split bookkeeping is exact and the tracked reserve covers the curve-implied reserve.',
      outcome: cons(flat) && cons(decay) ? 'PASS' : 'FAIL',
      flat: `reserve-curve=${flat.conservation.reserveMinusCurveRaw}`, decay: `reserve-curve=${decay.conservation.reserveMinusCurveRaw}` },
  ];
}

export function runComparison() {
  const traces = TRACE_SPECS.map((spec) => {
    const trace = generateTrace(spec);
    const flat = metrics(simulate(trace, STANDARD_V1_FLAT_V0_TEST)), decay = metrics(simulate(trace, DECAY_EXPERIMENT_V0_SIM));
    if (flat.traceHash !== decay.traceHash || flat.traceHash !== traceHash(trace)) throw new Error('trace mismatch between configurations');
    return { id: spec.id, seed: spec.seed, description: spec.description, traceHash: traceHash(trace), events: trace.events.length,
      flat, decay, hypotheses: hypotheses(flat, decay) };
  });
  const hyp = traces.flatMap((t) => t.hypotheses);
  const body = {
    label: SIM_LABEL, decision: 'Decision 5', disclaimers: DISCLAIMERS, productionTemplateSelected: false as const,
    configurations: {
      flat: { version: STANDARD_V1_FLAT_V0_TEST.version, usage: STANDARD_V1_FLAT_V0_TEST.usage, feeSchedulerParam: STANDARD_V1_FLAT_V0_TEST.fee.feeSchedulerParam },
      decay: { version: DECAY_EXPERIMENT_V0_SIM.version, usage: DECAY_EXPERIMENT_V0_SIM.usage, feeSchedulerParam: DECAY_EXPERIMENT_V0_SIM.fee.feeSchedulerParam },
    },
    sdk: '@meteora-ag/dynamic-bonding-curve-sdk@1.5.13 (swapQuotePartialFill, swapQuoteExactIn, getQuoteReserveFromNextSqrtPrice)',
    traces,
    summary: { hypotheses: hyp.length, passed: hyp.filter((h) => h.outcome === 'PASS').length, failed: hyp.filter((h) => h.outcome === 'FAIL').length,
      notApplicable: hyp.filter((h) => h.outcome === 'NOT_APPLICABLE').length },
  };
  return { ...body, resultsHash: bytesToHex(sha256(utf8ToBytes(canonicalJson(body)))) };
}
