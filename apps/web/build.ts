// Builds the devnet launchpad's browser app with esbuild (launchpad.html + launchpad.js), with linked source maps with
// sourcesContent (public maps are part of the boundary check) and a metafile of every input.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const r = await build({
  entryPoints: { launchpad: join(here, 'src/launchpad/main.ts') },
  outdir: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['browser'], mainFields: ['browser', 'module', 'main'],
  sourcemap: 'linked', sourcesContent: true, metafile: true, minify: false, logLevel: 'warning', legalComments: 'linked',
});
writeFileSync(join(out, 'meta.json'), JSON.stringify(r.metafile, null, 2));
for (const f of ['launchpad.html', 'launchpad.css']) copyFileSync(join(here, f), join(out, f));
// Launchpad web fonts (OFL-1.1, exact exceptions QF-LIC-EX-003..005): the unmodified latin variable woff2 files, each with its licence beside it.
mkdirSync(join(out, 'fonts'), { recursive: true });
for (const f of ['bricolage-grotesque', 'geist', 'geist-mono']) {
  const pkg = join(here, 'node_modules/@fontsource-variable', f);
  copyFileSync(join(pkg, 'files', `${f}-latin-wght-normal.woff2`), join(out, 'fonts', `${f}.woff2`));
  copyFileSync(join(pkg, 'LICENSE'), join(out, 'fonts', `${f}.OFL.txt`));
}
console.log(JSON.stringify({ outputs: Object.keys(r.metafile.outputs).map((p) => p.split('/dist/').pop()), inputs: Object.keys(r.metafile.inputs).length }));
