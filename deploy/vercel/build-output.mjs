// Builds the Vercel deployment (Build Output API v3) after `pnpm build:web`:
//   static/            the web app, only the publishable files (no source map: it carries the proprietary source)
//   functions/api/lp   the launchpad server (apps/launchpad/src/vercel.ts) as one bundled Node 22 function
//   config.json        /api/* and /m/* go to the function; everything else is the static app under the signing-page CSP
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'apps', 'web', 'dist');
const out = join(root, '.vercel', 'output');
const DENY = new Set(['launchpad.js.map', 'meta.json']);
const STATIC_CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

if (!existsSync(join(dist, 'launchpad.html'))) throw new Error('apps/web/dist is missing: run `pnpm build:web` first');
rmSync(out, { recursive: true, force: true });
const staticDir = join(out, 'static');
mkdirSync(staticDir, { recursive: true });
for (const name of readdirSync(dist)) {
  const s = join(dist, name);
  if (DENY.has(name) || name.endsWith('.map')) { console.log(`  skipped ${name}`); continue; }
  cpSync(s, join(staticDir, name), { recursive: statSync(s).isDirectory() });
  console.log(`  static  ${name}`);
}
cpSync(join(dist, 'launchpad.html'), join(staticDir, 'index.html'));

const fn = join(out, 'functions', 'api', 'lp.func');
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: [join(root, 'apps', 'launchpad', 'src', 'vercel.ts')], outfile: join(fn, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  sourcemap: false, minify: false, legalComments: 'eof', logLevel: 'warning',
  banner: { js: "import { createRequire as __qfCreateRequire } from 'node:module'; const require = __qfCreateRequire(import.meta.url);" },
});
writeFileSync(join(fn, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false,
  supportsResponseStreaming: false, maxDuration: 60 }, null, 1));
console.log('  function api/lp');

const headers = { 'content-security-policy': STATIC_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=63072000; includeSubDomains' };
writeFileSync(join(out, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api/(.*)$', dest: '/api/lp?qfpath=/api/$1' },
    { src: '^/m/(.*)$', dest: '/api/lp?qfpath=/m/$1' },
    { src: '^/(.*)$', headers, continue: true },
    { handle: 'filesystem' },
  ],
}, null, 1));
console.log('build-output: .vercel/output ready');
