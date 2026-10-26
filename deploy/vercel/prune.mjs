// Copies only publishable web assets from apps/web/dist to apps/web/dist-public.
// Excluded: launchpad.js.map (sourcesContent:true — would publish proprietary source), meta.json.
// Run as the second step of Vercel's buildCommand after `pnpm build:web`.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'apps', 'web', 'dist');
const dst = join(here, '..', '..', 'apps', 'web', 'dist-public');

const ALLOW = new Set(['launchpad.html', 'launchpad.css', 'launchpad.js', 'launchpad.js.LEGAL.txt']);
const DENY  = new Set(['launchpad.js.map', 'meta.json']);

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

for (const name of readdirSync(src)) {
  const s = join(src, name);
  if (statSync(s).isDirectory()) {
    // copy whole subdirectories (e.g. fonts/)
    cpSync(s, join(dst, name), { recursive: true });
    console.log(`  copied  ${name}/`);
    continue;
  }
  if (DENY.has(name)) { console.log(`  skipped ${name}`); continue; }
  cpSync(s, join(dst, name));
  console.log(`  copied  ${name}`);
  if (name === 'launchpad.html') {
    cpSync(s, join(dst, 'index.html'));
    console.log(`  copied  launchpad.html → index.html`);
  }
}
console.log(`prune: dist-public ready (${readdirSync(dst).length} entries)`);
