// CycloneDX 1.6 SBOM generated from the RESOLVED pnpm graph + lockfile integrity (not a planned list).
// Usage: node tools/deps/sbom.ts [--filter <workspace package>] --out <file>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lockIntegrity, pnpmList, readPackageLicense, walkGraph } from '../lib/pnpmGraph.ts';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const root = process.cwd();
const filter = arg('--filter');
const out = arg('--out') ?? join(root, 'sbom', 'project-qf.cdx.json');
const importers = pnpmList(root, ['--prod', ...(filter ? ['--filter', filter] : [])]).filter((i) => !filter || i.name === filter);
if (filter && importers.length === 0) throw new Error(`no workspace package ${filter}`);
const nodes = walkGraph(importers, { includeDev: false }).filter((n) => !n.version.startsWith('link:'));
const integrity = lockIntegrity(root);
const purl = (n: string, v: string) => `pkg:npm/${n.startsWith('@') ? '%40' + n.slice(1) : n}@${v}`;

const comps = new Map<string, Record<string, unknown>>();
const deps = new Map<string, Set<string>>();
for (const n of nodes) {
  const ref = purl(n.name, n.version);
  if (!comps.has(ref)) {
    const lic = readPackageLicense(n.path);
    const integ = integrity.get(`${n.name}@${n.version}`);
    comps.set(ref, {
      type: 'library', 'bom-ref': ref, name: n.name, version: n.version, purl: ref, scope: 'required',
      licenses: lic === 'NONE' ? [] : [{ expression: lic }],
      ...(integ ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(integ.replace(/^sha512-/, ''), 'base64').toString('hex') }] } : {}),
      properties: [{ name: 'qf:importers', value: '' }, ...(lic === 'NONE' ? [{ name: 'qf:license', value: 'NONE declared in package.json' }] : [])],
    });
  }
  const c = comps.get(ref)!;
  const prop = (c.properties as { name: string; value: string }[])[0]!;
  const set = new Set(prop.value ? prop.value.split(',') : []); set.add(n.importer); prop.value = [...set].sort().join(',');
  const parent = n.chain.length > 2 ? n.chain[n.chain.length - 2]! : n.importer;
  const pref = parent.includes('@') && !parent.startsWith(`${n.importer}`) ? purl(parent.slice(0, parent.lastIndexOf('@')), parent.slice(parent.lastIndexOf('@') + 1)) : `workspace:${n.importer}`;
  if (!deps.has(pref)) deps.set(pref, new Set());
  deps.get(pref)!.add(ref);
}
const sorted = [...comps.values()].sort((a, b) => String(a['bom-ref']).localeCompare(String(b['bom-ref'])));
const lockHash = createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex');
const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'project-qf tools/deps/sbom.ts', version: '0.1.0' }] },
    component: { type: 'application', 'bom-ref': filter ? `workspace:${filter}` : 'workspace:project-qf', name: filter ?? 'project-qf', version: '0.0.0' },
    properties: [
      { name: 'qf:source', value: 'pnpm list -r --prod --depth Infinity --json + pnpm-lock.yaml integrity' },
      { name: 'qf:pnpm-lock.sha256', value: lockHash },
      { name: 'qf:scope', value: 'production dependencies only; dev tooling excluded' },
    ],
  },
  components: sorted,
  dependencies: [...deps.entries()].sort().map(([ref, d]) => ({ ref, dependsOn: [...d].sort() })),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
console.log(JSON.stringify({ out, components: sorted.length, filter: filter ?? null, lockSha256: lockHash }));
