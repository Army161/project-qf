// Writes traces/*.json, evidence/econ-sim/results.json and the Markdown comparison. SIMULATION ONLY.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '@project-qf/core';
import { TRACE_SPECS, generateTrace, traceHash } from './traces.ts';
import { runComparison } from './compare.ts';

const root = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const outDir = join(root, 'evidence', 'econ-sim');
mkdirSync(outDir, { recursive: true });
mkdirSync(join(root, 'tools', 'econ-sim', 'traces'), { recursive: true });
const index: Record<string, string> = {};
for (const spec of TRACE_SPECS) {
  const t = generateTrace(spec);
  writeFileSync(join(root, 'tools', 'econ-sim', 'traces', `${spec.id}.json`), JSON.stringify(t, null, 1) + '\n');
  index[spec.id] = traceHash(t);
}
writeFileSync(join(root, 'tools', 'econ-sim', 'traces', 'INDEX.json'), JSON.stringify({ label: 'SYNTHETIC_TRACE_SIMULATION_ONLY', hashAlgorithm: 'sha256(canonicalJson(trace))', traces: index }, null, 2) + '\n');
const res = runComparison();
writeFileSync(join(outDir, 'results.json'), JSON.stringify(JSON.parse(canonicalJson(res)), null, 1) + '\n');
console.log(JSON.stringify({ resultsHash: res.resultsHash, summary: res.summary }));
for (const t of res.traces) for (const h of t.hypotheses) console.log(`${t.id.padEnd(16)} ${h.id.padEnd(24)} ${h.outcome.padEnd(14)} flat=${h.flat} | decay=${h.decay}`);
