// License gate over the RESOLVED graph (pnpm list), per importer. No broad suppression: exceptions
// are exact name@version records in LICENSE-MANIFEST.json, and QF-LIC-EX-001 additionally requires
// the lockfile integrity and that every path to it passes through the Meteora adapter.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockIntegrity, pnpmList, readPackageLicense, walkGraph } from '../lib/pnpmGraph.ts';
import { classify } from './spdx.ts';
import { checkExactException, type ExactException } from './exact.ts';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'LICENSE-MANIFEST.json'), 'utf8'));
const policy = manifest.policy;
const exceptions: Record<string, any>[] = manifest.exceptions;
const integrity = lockIntegrity(root);
const patchedNames = new Set([...readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').matchAll(/^  ((?:@[^/\s]+\/)?[^@\s]+)@[^:\s]+: patches\//gm)].map((m) => m[1]));
const readOpt = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
const ADAPTER = '@project-qf/adapter-meteora-dbc';
const BROWSER_IMPORTERS = new Set(['@project-qf/web', '@project-qf/core', '@project-qf/validator', '@project-qf/policy', '@project-qf/rewards', '@project-qf/tx']);

const nodes = walkGraph(pnpmList(root), { includeDev: true }).filter((n) => !n.version.startsWith('link:'));
const byPkg = new Map<string, typeof nodes>();
for (const n of nodes) { const k = `${n.name}@${n.version}`; byPkg.set(k, [...(byPkg.get(k) ?? []), n]); }

const results: Record<string, unknown>[] = [];
const failures: string[] = [];
const review: string[] = [];
for (const [key, occ] of [...byPkg.entries()].sort()) {
  const { name, version, path } = occ[0]!;
  if (!existsSync(join(path, 'package.json'))) {
    // optional platform-specific binary for another OS/CPU: resolved in the graph but not installed here
    results.push({ package: key, license: 'n/a', class: 'NOT_INSTALLED', devOnly: occ.every((o) => o.dev), importers: [...new Set(occ.map((o) => o.importer))], note: 'optional dependency not installed on this platform' });
    continue;
  }
  const license = readPackageLicense(path);
  const importers = [...new Set(occ.map((o) => o.importer))].sort();
  const devOnly = occ.every((o) => o.dev);
  let cls: string = classify(license, policy);
  let note = '';
  const ex = exceptions.find((e) => e.name === name && String(e.version).split(' ')[0] === version);
  if (policy.denyPackages.includes(name)) { cls = 'DENY'; note = 'denyPackages'; }
  else if (exceptions.some((e) => e.name === name && e.status === 'REMOVED')) { cls = 'DENY'; note = 'package recorded as REMOVED is present'; }
  else if (ex?.status === 'ALLOWED') { cls = 'ALLOW'; note = `exception ${ex.name} ALLOWED`; }
  else if (ex?.status === 'APPROVED_EXACT') {
    const e = ex as ExactException;
    const problems = checkExactException(e, { license, integrity: integrity.get(key), patched: patchedNames.has(name),
      notices: new Map(e.notices.map((n) => [n.upstreamPath, [readOpt(join(path, n.upstreamPath)), readOpt(join(root, n.preservedAt))]])) });
    cls = problems.length ? 'DENY' : 'ALLOW_EXCEPTION';
    note = problems.length ? problems.join('; ') : `${e.exceptionId} conditions hold (exact version, integrity, licence expression, unmodified, notices preserved verbatim)`;
  }
  else if (ex?.status === 'APPROVED_NARROW') {
    const problems: string[] = [];
    if (integrity.get(key) !== ex.resolvedIntegrity) problems.push(`integrity ${integrity.get(key)} != ${ex.resolvedIntegrity}`);
    for (const o of occ) {
      if (!o.chain.some((c) => c.startsWith(`${ADAPTER}@`)) && o.importer !== ADAPTER) problems.push(`path not via adapter: ${o.chain.join(' > ')}`);
      if (BROWSER_IMPORTERS.has(o.importer)) problems.push(`reachable from browser package ${o.importer}`);
    }
    cls = problems.length ? 'DENY' : 'ALLOW_EXCEPTION';
    note = problems.length ? problems.join('; ') : `${ex.exceptionId} conditions hold (integrity, adapter-only paths, no browser importer)`;
  }
  const entry = { package: key, license, class: cls, devOnly, importers, note, sampleChain: occ[0]!.chain.join(' > ') };
  results.push(entry);
  if (cls === 'DENY' || cls === 'UNKNOWN') failures.push(`${key} ${license} ${cls} ${note}`);
  if (cls === 'REVIEW') review.push(`${key} ${license}`);
}

const tally: Record<string, number> = {};
for (const r of results) tally[String(r.class)] = (tally[String(r.class)] ?? 0) + 1;
const report = { tool: 'tools/license-check/check-licenses.ts', generatedAt: new Date().toISOString(), manifestVersion: manifest.manifestVersion,
  packages: results.length, tally, failures, reviewRequired: review, results };
mkdirSync(join(root, 'evidence'), { recursive: true });
writeFileSync(join(root, 'evidence', 'license-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ packages: results.length, tally, failures, reviewRequired: review }, null, 2));
process.exitCode = failures.length ? 1 : 0;
