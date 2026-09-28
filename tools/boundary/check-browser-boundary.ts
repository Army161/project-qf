// Browser boundary gate (Decision 1). Enforced on the actual dependency graph and on the generated
// artifacts, including the worker bundle and public source maps. A folder name or lint rule alone
// is not relied on. Two canaries prove the scanner and the resolver both catch a violation.
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pnpmList, readPackageLicense, walkGraph } from '../lib/pnpmGraph.ts';
import { classify } from '../license-check/spdx.ts';
import { FORBIDDEN_PACKAGES, scanArtifacts, scanMetafile } from './scan.ts';

const root = process.cwd();
const web = join(root, 'apps', 'web');
const report: Record<string, unknown> = { tool: 'tools/boundary/check-browser-boundary.ts', generatedAt: new Date().toISOString() };
const failures: string[] = [];

// 1. Declared + resolved dependency graph of the browser app (production deps).
const graph = walkGraph(pnpmList(root, ['--prod', '--filter', '@project-qf/web']), { includeDev: false });
const names = [...new Set(graph.map((n) => n.name))].sort();
const forbiddenInGraph = graph.filter((n) => FORBIDDEN_PACKAGES.includes(n.name)).map((n) => n.chain.join(' > '));
const policy = JSON.parse(readFileSync(join(root, 'LICENSE-MANIFEST.json'), 'utf8')).policy;
const nonAllowed = [...new Map(graph.filter((n) => !n.version.startsWith('link:')).map((n) => [`${n.name}@${n.version}`, n])).values()]
  .map((n) => ({ pkg: `${n.name}@${n.version}`, license: readPackageLicense(n.path) }))
  .filter((x) => classify(x.license, policy) !== 'ALLOW');
const walletPkgs = names.filter((n) => /wallet|phantom|solflare|backpack|walletconnect/i.test(n));
report.graph = { packages: names.length, forbidden: forbiddenInGraph, licensesNotPlainAllow: nonAllowed, walletPackages: walletPkgs,
  note: 'Browser graph may use only plain-ALLOW licenses; license exceptions (e.g. QF-LIC-EX-001) never apply to browser code.' };
if (forbiddenInGraph.length) failures.push(`forbidden packages in web graph: ${forbiddenInGraph.join('; ')}`);
if (nonAllowed.length) failures.push(`non-ALLOW licenses in web graph: ${nonAllowed.map((x) => x.pkg).join(', ')}`);

// 2. Bundled inputs (esbuild metafile) and 3. emitted artifacts (JS, worker JS, source maps, HTML, CSS, legal notes).
const meta = JSON.parse(readFileSync(join(web, 'dist', 'meta.json'), 'utf8'));
const m = scanMetafile(meta);
const a = scanArtifacts(join(web, 'dist'));
report.bundle = { bundledPackages: m.packages, metafileViolations: m.violations, artifacts: a.files, artifactViolations: a.violations };
if (m.violations.length) failures.push(`metafile violations: ${m.violations.length}`);
if (a.violations.length) failures.push(`artifact violations: ${a.violations.length}`);
if (!a.files.some((f) => f.includes('worker'))) failures.push('worker bundle missing from artifacts (not audited)');
if (!a.files.some((f) => f.endsWith('.map'))) failures.push('no source maps emitted (not audited)');

// 4. Canary A: a browser build that imports @solana/web3.js must be caught by the scanner.
const tmp = mkdtempSync(join(tmpdir(), 'qf-boundary-canary-'));
try {
  const r = await build({ stdin: { contents: "import { Connection } from '@solana/web3.js'; console.log(Connection);", resolveDir: join(root, 'packages', 'adapter-meteora-dbc'), sourcefile: 'canary.ts', loader: 'ts' },
    outdir: tmp, bundle: true, format: 'esm', platform: 'browser', sourcemap: 'linked', sourcesContent: true, metafile: true, logLevel: 'silent' });
  const cm = scanMetafile(r.metafile);
  const ca = scanArtifacts(tmp);
  const detected = cm.violations.length > 0 && ca.violations.length > 0;
  report.canaryA = { purpose: 'scanner detects web3.js v1 + rpc-websockets in a browser bundle', detected,
    metafileViolations: cm.violations.slice(0, 5), artifactViolations: ca.violations.slice(0, 5), rpcWebsocketsBundled: cm.packages.includes('rpc-websockets') };
  if (!detected) failures.push('canary A not detected: scanner is ineffective');
} finally { rmSync(tmp, { recursive: true, force: true }); }

// 5. Canary B: importing the server-only adapter from the web app must fail at resolution time.
const tmpB = mkdtempSync(join(tmpdir(), 'qf-boundary-canary-'));
try {
  let refused = false; let message = '';
  try {
    await build({ stdin: { contents: "import '@project-qf/adapter-meteora-dbc';", resolveDir: web, sourcefile: 'canaryB.ts', loader: 'ts' },
      outdir: tmpB, bundle: true, format: 'esm', platform: 'browser', conditions: ['browser'], logLevel: 'silent', write: false });
  } catch (e) { refused = true; message = String((e as Error).message).split('\n').slice(0, 3).join(' '); }
  report.canaryB = { purpose: 'browser build cannot resolve the server-only adapter (exports has only a "node" condition and web does not depend on it)', refused, message };
  if (!refused) failures.push('canary B: browser build resolved the server-only adapter');
} finally { rmSync(tmpB, { recursive: true, force: true }); }

report.result = failures.length ? 'FAIL' : 'PASS';
report.failures = failures;
mkdirSync(join(root, 'evidence'), { recursive: true });
writeFileSync(join(root, 'evidence', 'browser-boundary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: report.result, failures, graphPackages: names.length, bundledPackages: m.packages,
  artifacts: a.files, canaryA: (report.canaryA as { detected: boolean }).detected, canaryB: (report.canaryB as { refused: boolean }).refused }, null, 2));
process.exitCode = failures.length ? 1 : 0;
