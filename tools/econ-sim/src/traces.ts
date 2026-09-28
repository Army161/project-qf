// Synthetic order-flow traces for Decision 5. SYNTHETIC: amounts and timings are invented,
// deterministic from the seed, and say nothing about real demand. Quote asset: TEST_ONLY qUSD (6 dp).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '@project-qf/core';
import { mulberry32 } from './prng.ts';

export type TraderClass = 'organic' | 'sniper' | 'sybil' | 'dumper';
export interface TraceEvent {
  seq: number; t: number; wallet: string; entity: string; cls: TraderClass;
  side: 'BUY' | 'SELL';
  quoteInRaw?: string;  // BUY: qUSD raw units offered (partial fill may use less)
  sellBps?: number;     // SELL: share of the wallet's current holdings, in bps
}
export interface Trace {
  id: string; description: string; seed: number; label: 'SYNTHETIC_TRACE_SIMULATION_ONLY';
  quote: { symbol: 'qUSD'; namespace: 'test-only'; decimals: 6 };
  events: TraceEvent[];
}
export interface TraceSpec { id: string; seed: number; description: string }

export const TRACE_SPECS: readonly TraceSpec[] = Object.freeze([
  { id: 'sniper_burst_t0', seed: 1001, description: '5 sniper wallets buy $300-600 each in the first 2 s, 220 organic events follow, snipers try to exit fully at 300-600 s.' },
  { id: 'patient_sniper', seed: 1002, description: 'Same sniper size, but snipers buy at 121-123 s, just after the decay window ends, and try to exit at 400-700 s.' },
  { id: 'organic_only', seed: 1003, description: '240 organic events ($5-100 buys, about 12% are 50% sells), no bots.' },
  { id: 'pump_dump', seed: 1004, description: 'A coordinated group of 8 wallets buys $200-400 each in 0-20 s and dumps everything at 60-75 s (inside the decay window); 90 organic events.' },
  { id: 'low_demand', seed: 1005, description: '40 small organic buys ($5-40) spread over about an hour; should not graduate.' },
  { id: 'sybil_split', seed: 1006, description: 'One entity splits $3,000 across 30 wallets at 0-3 s, 220 organic events follow, it tries to exit at 400-700 s.' },
]);

const usd = (x: number) => BigInt(Math.round(x * 100)) * 10_000n; // cents -> 6 dp raw, exact

function organicFlow(r: () => number, n: number, startT: number, meanGap: number, maxBuy: number, sellP: number, out: Omit<TraceEvent, 'seq'>[]) {
  let t = startT;
  const bought: string[] = [];
  for (let i = 0; i < n; i++) {
    t += Math.max(1, Math.round(-Math.log(1 - r()) * meanGap));
    if (bought.length > 3 && r() < sellP) {
      const w = bought[Math.floor(r() * bought.length)]!;
      out.push({ t, wallet: w, entity: w, cls: 'organic', side: 'SELL', sellBps: 5000 });
    } else {
      const w = `org-${String(Math.floor(r() * 60)).padStart(2, '0')}`;
      bought.push(w);
      out.push({ t, wallet: w, entity: w, cls: 'organic', side: 'BUY', quoteInRaw: usd(5 + r() * (maxBuy - 5)).toString() });
    }
  }
}

function group(r: () => number, prefix: string, entityOf: (i: number) => string, cls: TraderClass, n: number,
  buyT: [number, number], buyUsd: [number, number], exitT: [number, number] | null, out: Omit<TraceEvent, 'seq'>[]) {
  for (let i = 0; i < n; i++) {
    const w = `${prefix}-${String(i).padStart(2, '0')}`;
    out.push({ t: buyT[0] + Math.floor(r() * (buyT[1] - buyT[0] + 1)), wallet: w, entity: entityOf(i), cls, side: 'BUY',
      quoteInRaw: usd(buyUsd[0] + r() * (buyUsd[1] - buyUsd[0])).toString() });
    if (exitT) out.push({ t: exitT[0] + Math.floor(r() * (exitT[1] - exitT[0] + 1)), wallet: w, entity: entityOf(i), cls, side: 'SELL', sellBps: 10_000 });
  }
}

export function generateTrace(spec: TraceSpec): Trace {
  const r = mulberry32(spec.seed);
  const ev: Omit<TraceEvent, 'seq'>[] = [];
  switch (spec.id) {
    case 'sniper_burst_t0':
      group(r, 'snp', (i) => `snp-${i}`, 'sniper', 5, [0, 2], [300, 600], [300, 600], ev);
      organicFlow(r, 220, 5, 15, 90, 0.12, ev); break;
    case 'patient_sniper':
      group(r, 'snp', (i) => `snp-${i}`, 'sniper', 5, [121, 123], [300, 600], [400, 700], ev);
      organicFlow(r, 220, 5, 15, 90, 0.12, ev); break;
    case 'organic_only':
      organicFlow(r, 240, 1, 15, 100, 0.12, ev); break;
    case 'pump_dump':
      group(r, 'pd', () => 'pd-group', 'dumper', 8, [0, 20], [200, 400], [60, 75], ev);
      organicFlow(r, 90, 10, 20, 60, 0.1, ev); break;
    case 'low_demand':
      organicFlow(r, 40, 1, 90, 40, 0.1, ev); break;
    case 'sybil_split':
      group(r, 'syb', () => 'sybil-1', 'sybil', 30, [0, 3], [100, 100], [400, 700], ev);
      organicFlow(r, 220, 5, 15, 90, 0.12, ev); break;
    default: throw new Error(`unknown trace ${spec.id}`);
  }
  const sorted = ev.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map(({ e }, seq) => ({ seq, ...e }));
  return { id: spec.id, description: spec.description, seed: spec.seed, label: 'SYNTHETIC_TRACE_SIMULATION_ONLY',
    quote: { symbol: 'qUSD', namespace: 'test-only', decimals: 6 }, events: sorted };
}

export const traceHash = (t: Trace) => bytesToHex(sha256(utf8ToBytes(canonicalJson(t))));
