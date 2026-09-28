// Builds the MOCK UI for the browser with esbuild: main bundle + worker bundle, linked source maps
// with sourcesContent (public maps are part of the boundary check), and a metafile of every input.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const r = await build({
  entryPoints: { main: join(here, 'src/main.ts'), 'merkle.worker': join(here, 'src/merkle.worker.ts') },
  outdir: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['browser'], mainFields: ['browser', 'module', 'main'],
  sourcemap: 'linked', sourcesContent: true, metafile: true, minify: false, logLevel: 'warning', legalComments: 'linked',
});
writeFileSync(join(out, 'meta.json'), JSON.stringify(r.metafile, null, 2));
copyFileSync(join(here, 'index.html'), join(out, 'index.html'));
copyFileSync(join(here, 'styles.css'), join(out, 'styles.css'));
console.log(JSON.stringify({ outputs: Object.keys(r.metafile.outputs).map((p) => p.split('/dist/').pop()), inputs: Object.keys(r.metafile.inputs).length }));
