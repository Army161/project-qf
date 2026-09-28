// Decision 4 evidence: prove `chain` is absent from the resolved graph, lockfile, node_modules,
// runtime module cache and generated SBOMs, and that the published cp-amm-sdk artifact never imports it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { lockIntegrity, pnpmList, walkGraph } from '../lib/pnpmGraph.ts';

const root = process.cwd();
const checks: { id: string; status: 'PASS' | 'FAIL'; detail: string }[] = [];
const check = (id: string, ok: boolean, detail: string) => checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });
const OVERRIDE = `"@meteora-ag/cp-amm-sdk@1.4.10>chain": "-"`;

const ws = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
check('override-declared', ws.includes(OVERRIDE), `pnpm-workspace.yaml contains ${OVERRIDE}`);

const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
check('lockfile-override-recorded', lock.includes(`'@meteora-ag/cp-amm-sdk@1.4.10>chain': '-'`), 'pnpm-lock.yaml overrides section records the removal');
const pkgKeys = [...lock.matchAll(/^ {2}'?chain@[^:]+:/gm)].map((m) => m[0].trim());
check('lockfile-no-chain-package', pkgKeys.length === 0, pkgKeys.length ? `found ${pkgKeys.join(', ')}` : 'no chain@* key in packages/snapshots');
const depLines = [...lock.matchAll(/^ {6}chain: .+$/gm)].map((m) => m[0].trim());
check('lockfile-no-chain-edge', depLines.length === 0, depLines.length ? depLines.join('; ') : 'no dependency edge named chain');

const graph = walkGraph(pnpmList(root), { includeDev: true });
const inGraph = graph.filter((n) => n.name === 'chain');
check('resolved-graph', inGraph.length === 0, inGraph.length ? inGraph.map((n) => n.chain.join(' > ')).join('; ') : `0 of ${graph.length} graph occurrences are named chain`);

const store = join(root, 'node_modules', '.pnpm');
const storeHits = readdirSync(store).filter((d) => /^chain@/.test(d));
const linkHits: string[] = [];
for (const d of readdirSync(store)) { const nm = join(store, d, 'node_modules', 'chain'); if (existsSync(nm)) linkHits.push(nm); }
for (const d of ['packages', 'apps', 'tools']) {
  if (!existsSync(join(root, d))) continue;
  for (const p of readdirSync(join(root, d))) if (existsSync(join(root, d, p, 'node_modules', 'chain'))) linkHits.push(join(d, p, 'node_modules', 'chain'));
}
if (existsSync(join(root, 'node_modules', 'chain'))) linkHits.push('node_modules/chain');
check('node_modules', storeHits.length + linkHits.length === 0, storeHits.length + linkHits.length ? [...storeHits, ...linkHits].join(', ') : 'no chain directory in the virtual store or any node_modules');

const adapterDir = join(root, 'packages', 'adapter-meteora-dbc');
const runtime = execFileSync(process.execPath, ['-e', `
  require('@meteora-ag/dynamic-bonding-curve-sdk'); require('@meteora-ag/cp-amm-sdk');
  const hits = Object.keys(require.cache).filter((p) => /[\\\\/]node_modules[\\\\/]chain[\\\\/]/.test(p));
  let resolvable = true; try { require.resolve('chain', { paths: [require.resolve('@meteora-ag/cp-amm-sdk')] }); } catch { resolvable = false; }
  console.log(JSON.stringify({ modulesLoaded: Object.keys(require.cache).length, chainModules: hits, chainResolvable: resolvable }));`],
  { cwd: adapterDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop()!;
const rt = JSON.parse(runtime);
check('runtime-module-cache', rt.chainModules.length === 0 && rt.chainResolvable === false, `CJS load of both SDKs: ${rt.modulesLoaded} modules, chain modules ${rt.chainModules.length}, resolvable=${rt.chainResolvable}`);

const req = createRequire(join(adapterDir, 'x.js'));
const cpDist = dirname(req.resolve('@meteora-ag/cp-amm-sdk'));
const specRe = /require\(\s*['"]chain(\/[^'"]*)?['"]\s*\)|from\s*['"]chain(\/[^'"]*)?['"]|import\(\s*['"]chain(\/[^'"]*)?['"]\s*\)/;
const distHits = readdirSync(cpDist).filter((f) => specRe.test(readFileSync(join(cpDist, f), 'utf8')));
check('published-artifact-imports', distHits.length === 0, distHits.length ? distHits.join(', ') : `no chain import/require/dynamic import in ${readdirSync(cpDist).join(', ')}`);
const pj = JSON.parse(readFileSync(join(cpDist, '..', 'package.json'), 'utf8'));
check('published-artifact-unmodified', pj.dependencies?.chain === '^0.4.0', 'installed cp-amm-sdk package.json still declares chain ^0.4.0 (artifact not patched)');
const integ = lockIntegrity(root).get('@meteora-ag/cp-amm-sdk@1.4.10');
check('published-artifact-integrity', integ === 'sha512-Y3UPjP91VWrj86hOr4kDmU1UXiESspy8YP6Z/4XtWD1eCVwUN0xMEzCvKXM2IRz5ECSj8alO2od1czhMhvcD8g==', `lockfile integrity ${integ} matches the inspected npm pack tarball`);

for (const f of ['sbom/project-qf.cdx.json', 'sbom/apps-web.cdx.json']) {
  if (!existsSync(join(root, f))) { check(`sbom:${f}`, false, 'SBOM not generated'); continue; }
  const bom = JSON.parse(readFileSync(join(root, f), 'utf8'));
  const hit = bom.components.filter((c: { name: string }) => c.name === 'chain');
  check(`sbom:${f}`, hit.length === 0, hit.length ? 'chain component present' : `${bom.components.length} components, none named chain`);
}

const ok = checks.every((c) => c.status === 'PASS');
const report = { tool: 'tools/deps/prove-chain-absent.ts', generatedAt: new Date().toISOString(), result: ok ? 'PASS' : 'FAIL', override: OVERRIDE, checks };
mkdirSync(join(root, 'evidence', 'chain-removal'), { recursive: true });
writeFileSync(join(root, 'evidence', 'chain-removal', 'proof.json'), JSON.stringify(report, null, 2) + '\n');
for (const c of checks) console.log(`${c.status}  ${c.id}: ${c.detail}`);
console.log(`RESULT ${report.result}`);
process.exitCode = ok ? 0 : 1;
