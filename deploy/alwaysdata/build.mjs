// Builds the devnet test launchpad for a small free host (alwaysdata Free: 256 MB RAM, 1 GB disk, no Docker).
// Output (deploy/alwaysdata/out/app, git-ignored):
//   server.mjs        the launchpad server and every dependency in one file (esbuild)
//   web/              the browser app (apps/web/dist, built and boundary-checked first by `pnpm build:web && pnpm boundary`)
//   NOTICES/          THIRD_PARTY_NOTICES.md and PROPRIETARY-NOTICE.md
//   BUILD.json        what was built, from which commit, with each file's sha256
// Usage, from the repository root: pnpm build:web && pnpm boundary && node deploy/alwaysdata/build.mjs
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'deploy', 'alwaysdata', 'out', 'app');
const { build } = createRequire(join(root, 'apps', 'web', 'package.json'))('esbuild');

const webDist = join(root, 'apps', 'web', 'dist');
if (!existsSync(join(webDist, 'launchpad.html'))) throw new Error('apps/web/dist is missing: run `pnpm build:web && pnpm boundary` first');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. the server in one file; `require` is provided for any CommonJS dependency inside the bundle
const result = await build({
  entryPoints: [join(root, 'apps', 'launchpad', 'src', 'main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: join(out, 'server.mjs'), metafile: true, logLevel: 'warning', legalComments: 'eof',
  banner: { js: "import { createRequire as __qfCreateRequire } from 'node:module'; const require = __qfCreateRequire(import.meta.url);" },
});
const inputs = Object.keys(result.metafile.inputs);

// 2. the browser app and the notices
// only the launchpad's own files, and no source maps: they would publish the proprietary source
const WEB = /^(launchpad\.(html|css|js|js\.LEGAL\.txt)|fonts(\/.*)?)$/;
cpSync(webDist, join(out, 'web'), { recursive: true, filter: (s) => s === webDist || WEB.test(relative(webDist, s)) });
if (!existsSync(join(out, 'web', 'launchpad.js'))) throw new Error('the launchpad bundle was not copied');
mkdirSync(join(out, 'NOTICES'), { recursive: true });
for (const f of ['THIRD_PARTY_NOTICES.md', 'PROPRIETARY-NOTICE.md']) cpSync(join(root, 'spec', f), join(out, 'NOTICES', f));

// 3. manifest
const files = [];
const walk = (d) => { for (const x of readdirSync(d)) { const p = join(d, x); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(out);
const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); } catch { return 'unknown'; } })();
const manifest = {
  label: 'Project QF devnet test launchpad build for a small host (deploy/alwaysdata). TEST_ONLY: devnet, valueless test coins.',
  commit, builtAt: new Date().toISOString(), node: '>=22.12 (node:sqlite)', bundledInputs: inputs.length,
  files: files.sort().map((p) => ({ path: relative(out, p), bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') })),
};
writeFileSync(join(out, 'BUILD.json'), JSON.stringify(manifest, null, 1) + '\n');
const total = manifest.files.reduce((s, f) => s + f.bytes, 0);
console.log(JSON.stringify({ out: relative(root, out), commit, files: manifest.files.length, megabytes: +(total / 1e6).toFixed(1),
  serverBytes: statSync(join(out, 'server.mjs')).size }, null, 1));
