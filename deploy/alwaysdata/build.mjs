// Builds the devnet test launchpad for a small free host (alwaysdata Free: 256 MB RAM, 1 GB disk, no Docker).
// Output (deploy/alwaysdata/out/app, git-ignored):
//   server.mjs        the launchpad server and its dependencies in one file (esbuild), except rpc-websockets
//   node_modules/     rpc-websockets@9.3.9 and its runtime dependencies, copied unmodified (QF-LIC-EX-001: it stays a
//                     separate, unmodified LGPL package on the server; it never reaches the browser bundle)
//   web/              the browser app (apps/web/dist, built and boundary-checked first by `pnpm build:web && pnpm boundary`)
//   NOTICES/          THIRD_PARTY_NOTICES.md, PROPRIETARY-NOTICE.md and the copied packages' licence files
//   BUILD.json        what was built, from which commit, with each file's sha256
// Usage, from the repository root: pnpm build:web && pnpm boundary && node deploy/alwaysdata/build.mjs
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'deploy', 'alwaysdata', 'out', 'app');
const { build } = createRequire(join(root, 'apps', 'web', 'package.json'))('esbuild');
const EXTERNAL = 'rpc-websockets';
const EXTERNAL_VERSION = '9.3.9';

const webDist = join(root, 'apps', 'web', 'dist');
if (!existsSync(join(webDist, 'launchpad.html'))) throw new Error('apps/web/dist is missing: run `pnpm build:web && pnpm boundary` first');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. the server in one file; `require` is provided for the CommonJS dependencies inside the bundle
const result = await build({
  entryPoints: [join(root, 'apps', 'launchpad', 'src', 'main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: join(out, 'server.mjs'), external: [EXTERNAL], metafile: true, logLevel: 'warning', legalComments: 'eof',
  banner: { js: "import { createRequire as __qfCreateRequire } from 'node:module'; const require = __qfCreateRequire(import.meta.url);" },
});
const inputs = Object.keys(result.metafile.inputs);
if (inputs.some((p) => p.includes(`/${EXTERNAL}/`))) throw new Error(`${EXTERNAL} was bundled; it must stay an external, unmodified package`);

// 2. rpc-websockets and its runtime dependency tree, dereferenced and unmodified, resolved the way the adapter resolves it
const copied = new Map();
const pkgDirFrom = (from, dep) => {
  for (let d = from; ; d = dirname(d)) {
    const c = join(d, 'node_modules', dep);
    if (existsSync(join(c, 'package.json'))) return realpathSync(c);
    if (dirname(d) === d) return null;
  }
};
const parentOf = (dir, name) => dirname(dir.slice(0, dir.length - name.length - 1)); // <x>/node_modules/<name> -> <x>
function copyTree(from, name, optional) {
  if (name.startsWith('@types/')) return; // type declarations: nothing runs from them
  const dir = pkgDirFrom(from, name);
  if (!dir) { if (optional) return; throw new Error(`cannot resolve ${name} from ${from}`); }
  if (copied.has(name)) { if (copied.get(name).dir !== dir) console.warn(`note: ${name} resolves to two versions; keeping ${copied.get(name).version}`); return; }
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  copied.set(name, { dir, version: pj.version, license: pj.license ?? null });
  cpSync(dir, join(out, 'node_modules', name), { recursive: true, dereference: true, filter: (s) => !/\/node_modules(\/|$)/.test(s.slice(dir.length)) });
  const base = join(parentOf(dir, name), 'node_modules', '_'); // siblings of the package (pnpm layout)
  for (const d of Object.keys(pj.dependencies ?? {})) copyTree(base, d, false);
  for (const d of Object.keys(pj.optionalDependencies ?? {})) copyTree(base, d, true);
}
const web3 = realpathSync(dirname(createRequire(join(root, 'packages', 'adapter-meteora-dbc', 'package.json')).resolve('@solana/web3.js/package.json')));
copyTree(web3, EXTERNAL, false);
if (copied.get(EXTERNAL).version !== EXTERNAL_VERSION) throw new Error(`${EXTERNAL} is ${copied.get(EXTERNAL).version}; QF-LIC-EX-001 covers ${EXTERNAL_VERSION} only`);

// 3. the browser app and the notices
// only the launchpad's own files (not the private inspector or the mock lifecycle), and no source maps: they would publish
// the proprietary source
const WEB = /^(launchpad\.(html|css|js|js\.LEGAL\.txt)|fonts(\/.*)?)$/;
cpSync(webDist, join(out, 'web'), { recursive: true, filter: (s) => s === webDist || WEB.test(relative(webDist, s)) });
if (!existsSync(join(out, 'web', 'launchpad.js'))) throw new Error('the launchpad bundle was not copied');
mkdirSync(join(out, 'NOTICES'), { recursive: true });
for (const f of ['THIRD_PARTY_NOTICES.md', 'PROPRIETARY-NOTICE.md']) cpSync(join(root, 'spec', f), join(out, 'NOTICES', f));
for (const [name, { dir }] of copied) {
  for (const f of readdirSync(dir).filter((x) => /^(licen[cs]e|copying|notice)/i.test(x))) cpSync(join(dir, f), join(out, 'NOTICES', `${name.replace('/', '__')}-${f}`));
}

// 4. manifest
const files = [];
const walk = (d) => { for (const x of readdirSync(d)) { const p = join(d, x); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(out);
const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); } catch { return 'unknown'; } })();
const manifest = {
  label: 'Project QF devnet test launchpad build for a small host (deploy/alwaysdata). TEST_ONLY: devnet, valueless test coins.',
  commit, builtAt: new Date().toISOString(), node: '>=22.12 (node:sqlite)', bundledInputs: inputs.length,
  external: [...copied].map(([name, v]) => ({ name, version: v.version, license: v.license })),
  files: files.sort().map((p) => ({ path: relative(out, p), bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') })),
};
writeFileSync(join(out, 'BUILD.json'), JSON.stringify(manifest, null, 1) + '\n');
const total = manifest.files.reduce((s, f) => s + f.bytes, 0);
console.log(JSON.stringify({ out: relative(root, out), commit, files: manifest.files.length, megabytes: +(total / 1e6).toFixed(1),
  serverBytes: statSync(join(out, 'server.mjs')).size, external: manifest.external.map((x) => `${x.name}@${x.version}`) }, null, 1));
