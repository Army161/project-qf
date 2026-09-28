// Decision 5 — SIMULATION ONLY. Flat V0_TEST baseline vs one bounded linear decay, identical traces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/prng.ts';
import { TRACE_SPECS, generateTrace, traceHash } from '../src/traces.ts';
import { simulationThreshold, simulate } from '../src/engine.ts';
import { runComparison, SIM_LABEL } from '../src/compare.ts';
import { STANDARD_V1_FLAT_V0_TEST, DECAY_EXPERIMENT_V0_SIM } from '@project-qf/policy';

test('prng is deterministic and seed-sensitive', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, [c(), c(), c()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('six documented traces; each is deterministic and labelled synthetic', () => {
  assert.deepEqual(TRACE_SPECS.map((s) => s.id),
    ['sniper_burst_t0', 'patient_sniper', 'organic_only', 'pump_dump', 'low_demand', 'sybil_split']);
  for (const s of TRACE_SPECS) {
    const t1 = generateTrace(s), t2 = generateTrace(s);
    assert.equal(traceHash(t1), traceHash(t2), s.id);
    assert.equal(t1.label, 'SYNTHETIC_TRACE_SIMULATION_ONLY');
    assert.ok(t1.events.length > 0);
    for (let i = 1; i < t1.events.length; i++) assert.ok(t1.events[i]!.t >= t1.events[i - 1]!.t, 'events sorted by time');
    for (const e of t1.events) assert.ok(e.side === 'BUY' ? /^\d+$/.test(e.quoteInRaw!) : Number.isInteger(e.sellBps));
  }
});

test('the threshold used by the simulation comes from the Decision-3 policy path', () => {
  const rec = simulationThreshold();
  assert.equal(rec.quantity, 'MIGRATION_QUOTE_RESERVE_THRESHOLD');
  assert.equal(rec.rawQuoteThreshold, '5000000000');
  assert.ok(!('migrationMarketCap' in rec));
});

test('both configurations run on byte-identical traces and conserve quote exactly', () => {
  const trace = generateTrace(TRACE_SPECS[0]!);
  const flat = simulate(trace, STANDARD_V1_FLAT_V0_TEST), decay = simulate(trace, DECAY_EXPERIMENT_V0_SIM);
  assert.equal(flat.traceHash, decay.traceHash);
  for (const r of [flat, decay]) {
    assert.equal(r.conservation.quoteExact, true, JSON.stringify(r.conservation, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(r.conservation.feeSplitExact, true);
    assert.equal(r.conservation.reserveCoversCurve, true, JSON.stringify(r.conservation, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(r.conservation.baseExact, true);
  }
});

test('decay charges more than flat inside the window and the same after it', () => {
  const trace = generateTrace(TRACE_SPECS[0]!);
  const flat = simulate(trace, STANDARD_V1_FLAT_V0_TEST), decay = simulate(trace, DECAY_EXPERIMENT_V0_SIM);
  const firstBuy = (r: typeof flat) => r.ledger.find((l) => l.status === 'FILLED' && l.side === 'BUY')!;
  assert.ok(firstBuy(decay).effectiveFeeBps > firstBuy(flat).effectiveFeeBps);
  assert.ok(firstBuy(decay).effectiveFeeBps >= 2400, `t=0 decay fee ${firstBuy(decay).effectiveFeeBps} bps`);
  const late = (r: typeof flat) => r.ledger.find((l) => l.status === 'FILLED' && l.side === 'BUY' && l.t >= 120)!;
  assert.equal(late(flat).effectiveFeeBps, late(decay).effectiveFeeBps);
});

test('trades after graduation are rejected and recorded, never dropped', () => {
  const trace = generateTrace(TRACE_SPECS.find((s) => s.id === 'organic_only')!);
  const r = simulate(trace, STANDARD_V1_FLAT_V0_TEST);
  assert.equal(r.ledger.length, trace.events.length);
  if (r.graduation.completed) assert.ok(r.ledger.some((l) => l.status === 'REJECTED' && l.reason === 'CURVE_COMPLETE'));
});

test('low_demand never graduates under either configuration', () => {
  const trace = generateTrace(TRACE_SPECS.find((s) => s.id === 'low_demand')!);
  assert.equal(simulate(trace, STANDARD_V1_FLAT_V0_TEST).graduation.completed, false);
  assert.equal(simulate(trace, DECAY_EXPERIMENT_V0_SIM).graduation.completed, false);
});

test('comparison is deterministic, labelled, and retains failed hypotheses', () => {
  const a = runComparison(), b = runComparison();
  assert.equal(a.resultsHash, b.resultsHash);
  assert.equal(a.label, SIM_LABEL);
  assert.match(a.label, /SIMULATION ONLY/);
  assert.match(a.disclaimers.join(' '), /not sniper-proof/i);
  assert.match(a.disclaimers.join(' '), /demand elasticity/i);
  assert.equal(a.traces.length, 6);
  const hyp = a.traces.flatMap((t) => t.hypotheses);
  assert.ok(hyp.every((h) => h.outcome === 'PASS' || h.outcome === 'FAIL' || h.outcome === 'NOT_APPLICABLE'));
  assert.ok(hyp.every((h) => h.id !== 'H4_CONSERVATION' || h.outcome === 'PASS'));
  // failures are part of the result, not filtered
  assert.equal(a.summary.failed, hyp.filter((h) => h.outcome === 'FAIL').length);
  assert.equal(a.productionTemplateSelected, false);
});
