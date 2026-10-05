// Where an LP residual comes from (Astra, fee-ledger review: "explicit residuals with evidence of their origin").
//
// After graduation each trade's LP fee goes into the DAMM v2 pool's fee-per-liquidity accumulator F (scaled by 2^128),
// and a position with liquidity Lᵢ is owed Lᵢ·F / 2^128. The program pays whole raw units: when a position settles
// (claims), it gets floor(Lᵢ·(F − checkpoint) / 2^128) and moves its checkpoint to F; that formula is the MIT cp-amm SDK's
// getUnClaimLpFee. So the trades can add up to slightly more than the positions ever receive. This module takes the
// program's own numbers, read from chain as one snapshot, and splits the residual exactly into:
//   accumulator rounding  Σ trade LP fees − L·F / 2^128    (what the accumulator itself did not carry)
//   settlement rounding   Σᵢ (Lᵢ·F / 2^128 − received by position i)    (the fractions each floor dropped)
//   unowned liquidity     (L − Σ Lᵢ)·F / 2^128    (liquidity no position holds)
// The three add up to the residual by construction. What proves the origin is that the program's own counters agree with
// QF's records and every part stays inside what rounding can produce. If any check fails, the origin stays NOT_PROVEN.
import type { DammFeeAccounting } from '@project-qf/adapter-meteora-dbc/launchpad';

const SCALE = 1n << 128n;
/** A fraction of a raw unit, numerator over 2^128, as a decimal string rounded toward zero to 9 places (the exact
 *  numerators stay in the computation; this is for reading). */
export function rawFraction(num: bigint): string {
  const neg = num < 0n, n = neg ? -num : num;
  const nano = (n * 1_000_000_000n) / SCALE;
  return `${neg ? '-' : ''}${nano / 1_000_000_000n}.${(nano % 1_000_000_000n).toString().padStart(9, '0')}`;
}

export interface LpResidualInput {
  /** LP fees recorded trade by trade (each from its own swap event), and how many DAMM v2 trades that is */
  ledgerLpRaw: bigint; dammTrades: number;
  /** proven claim receipts for this coin's DAMM v2 positions: their total and how many */
  claimsRaw: bigint; claims: number;
  accounting: DammFeeAccounting;
}
export interface LpResidualProof {
  status: 'PROVEN_ROUNDING' | 'NOT_PROVEN';
  residualRaw: string;
  /** exact parts, as raw units with 6 decimals; they add up to the residual */
  parts: { accumulatorRaw: string; settlementRaw: string; unownedRaw: string };
  positions: { position: string; nftMint: string; liquidity: string; owedRaw: string; receivedRaw: string; roundingRaw: string; settlementsAtMost: number;
    /** for a position settled once: its claim equals floor(Lᵢ·checkpoint / 2^128), the program's own rounding at that moment */
    claimRecomputed: boolean | null }[];
  checks: { id: string; ok: boolean; detail: string }[];
  formula: string;
}

export function explainLpResidual(i: LpResidualInput): LpResidualProof {
  const a = i.accounting;
  const L = BigInt(a.liquidity), F = BigInt(a.feePerLiquidityQuote);
  const ps = a.positions.map((p) => ({ ...p, Li: BigInt(p.liquidity), ck: BigInt(p.checkpointQuote) }));
  const sumL = ps.reduce((s, p) => s + p.Li, 0n);
  const received = (p: (typeof ps)[number]) => BigInt(p.claimedQuoteRaw) + BigInt(p.pendingQuoteRaw) + (p.Li * (F - p.ck)) / SCALE;
  const totalReceived = ps.reduce((s, p) => s + received(p), 0n);
  const residual = i.ledgerLpRaw - totalReceived;
  // exact parts as numerators over 2^128
  const accNum = i.ledgerLpRaw * SCALE - L * F;
  const posNum = ps.map((p) => p.Li * F - received(p) * SCALE);
  const setNum = posNum.reduce((s, x) => s + x, 0n);
  const unownedNum = (L - sumL) * F;
  const claimedTotal = ps.reduce((s, p) => s + BigInt(p.claimedQuoteRaw), 0n);
  const settled = (p: (typeof ps)[number]) => BigInt(p.claimedQuoteRaw) > 0n || BigInt(p.pendingQuoteRaw) > 0n;
  const settlementsAtMost = (p: (typeof ps)[number]) => (settled(p) ? Math.max(1, i.claims) : 0);

  const checks: LpResidualProof['checks'] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  check('FEES_IN_QUOTE_ONLY', a.collectFeeMode === 1 && a.totalLpBaseRaw === '0' && ps.every((p) => p.claimedBaseRaw === '0'),
    `the pool collects fees in the quote token only (mode ${a.collectFeeMode}); base-side LP fees ${a.totalLpBaseRaw}`);
  check('PROGRAM_COUNTER_EQUALS_LEDGER', BigInt(a.totalLpQuoteRaw) === i.ledgerLpRaw,
    `the program's own LP fee total ${a.totalLpQuoteRaw} vs ${i.ledgerLpRaw} from ${i.dammTrades} trade event(s)`);
  check('ALL_LIQUIDITY_IN_KNOWN_POSITIONS', sumL === L && String(ps.length) === a.totalPositions,
    `${ps.length} position(s) (program count ${a.totalPositions}) hold ${sumL} of ${L} liquidity`);
  check('POSITIONS_ACCRUE_FROM_ZERO', ps.every((p) => settled(p) || p.ck === 0n),
    'every position never settled still has checkpoint 0, so it has earned from the first trade');
  check('CLAIMS_EQUAL_RECEIPTS', claimedTotal === i.claimsRaw, `positions report ${claimedTotal} claimed; proven receipts in this app ${i.claimsRaw} (${i.claims})`);
  check('ACCUMULATOR_ROUNDING_BOUNDED', accNum >= 0n && accNum < BigInt(Math.max(1, i.dammTrades)) * L,
    `${rawFraction(accNum)} raw, below ${i.dammTrades} trade(s) × ${rawFraction(L)} raw (one accumulator step per trade)`);
  check('SETTLEMENT_ROUNDING_BOUNDED', posNum.every((x, k) => x >= 0n && x < BigInt(settlementsAtMost(ps[k]!) + 1) * SCALE),
    ps.map((p, k) => `${p.position.slice(0, 4)}… ${rawFraction(posNum[k]!)} raw, below ${settlementsAtMost(p) + 1}`).join('; '));
  const once = ps.filter((p) => settlementsAtMost(p) === 1 && BigInt(p.pendingQuoteRaw) === 0n);
  check('SINGLE_CLAIMS_RECOMPUTED', once.every((p) => (p.Li * p.ck) / SCALE === BigInt(p.claimedQuoteRaw)),
    once.length ? `${once.length} position(s) settled once: each claim equals floor(liquidity × checkpoint / 2^128)` : 'no position settled exactly once');
  check('PARTS_ADD_UP', accNum + setNum + unownedNum === residual * SCALE, `${rawFraction(accNum)} + ${rawFraction(setNum)} + ${rawFraction(unownedNum)} = ${residual} raw`);
  const proven = residual > 0n && checks.every((c) => c.ok);
  return {
    status: proven ? 'PROVEN_ROUNDING' : 'NOT_PROVEN',
    residualRaw: residual.toString(),
    parts: { accumulatorRaw: rawFraction(accNum), settlementRaw: rawFraction(setNum), unownedRaw: rawFraction(unownedNum) },
    positions: ps.map((p, k) => ({ position: p.position, nftMint: p.nftMint, liquidity: p.liquidity, owedRaw: rawFraction(p.Li * F), receivedRaw: received(p).toString(),
      roundingRaw: rawFraction(posNum[k]!), settlementsAtMost: settlementsAtMost(p),
      claimRecomputed: settlementsAtMost(p) === 1 && BigInt(p.pendingQuoteRaw) === 0n ? (p.Li * p.ck) / SCALE === BigInt(p.claimedQuoteRaw) : null })),
    checks,
    formula: 'a position settles floor(liquidity × (fee per liquidity − checkpoint) / 2^128) raw units (MIT cp-amm SDK getUnClaimLpFee); the fraction is dropped',
  };
}
