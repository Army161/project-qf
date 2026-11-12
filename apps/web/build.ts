// Builds the launchpad's browser app with esbuild (launchpad.html + launchpad.js), with linked source maps with
// sourcesContent (public maps are part of the boundary check) and a metafile of every input.
// One build serves one network: QF_WEB_CLUSTER = devnet (default) | localnet | mainnet-beta. The engine's program ids are
// compiled in, and the page refuses a server that names other ones. Mainnet takes the owner's ids
// (QF_WEB_CURVE, QF_WEB_POOL, QF_WEB_POOL_FEE_RECEIVER), checked like the server checks them.
import { deploymentFor, mainnetDeployment, type EngineDeployment } from '@project-qf/engine';
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cluster = process.env.QF_WEB_CLUSTER || 'devnet';
let deployment: EngineDeployment;
if (cluster === 'devnet' || cluster === 'localnet') deployment = deploymentFor(cluster);
else if (cluster === 'mainnet-beta') {
  const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`a mainnet build needs ${k}`); return v; };
  deployment = mainnetDeployment({ curve: need('QF_WEB_CURVE'), pool: need('QF_WEB_POOL'), poolFeeReceiver: need('QF_WEB_POOL_FEE_RECEIVER') });
} else throw new Error(`QF_WEB_CLUSTER must be devnet, localnet or mainnet-beta, not ${cluster}`);

/** Output folder; dist unless QF_WEB_OUT names another (tests build other networks beside the real dist). */
const out = process.env.QF_WEB_OUT || join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const r = await build({
  entryPoints: { launchpad: join(here, 'src/launchpad/main.ts') },
  outdir: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['browser'], mainFields: ['browser', 'module', 'main'],
  sourcemap: 'linked', sourcesContent: true, metafile: true, minify: false, logLevel: 'warning', legalComments: 'linked',
  define: { __QF_DEPLOYMENT__: JSON.stringify(deployment) },
});
writeFileSync(join(out, 'meta.json'), JSON.stringify(r.metafile, null, 2));
copyFileSync(join(here, 'launchpad.css'), join(out, 'launchpad.css'));
// The page's network words are in the HTML, so they are right before any script runs.
const TEXT = {
  devnet: { title: 'QF Launchpad (devnet)', pill: 'DEVNET', note: 'Test network. Nothing here has value.', foot: 'Devnet test build.' },
  localnet: { title: 'QF Launchpad (local)', pill: 'LOCAL', note: 'Local test network. Nothing here has value.', foot: 'Local test build.' },
  'mainnet-beta': { title: 'QF Launchpad', pill: 'MAINNET', note: 'Real network. SOL and coins here are real money.', foot: 'Solana mainnet.' },
}[cluster]!;
let html = readFileSync(join(here, 'launchpad.html'), 'utf8');
for (const [from, to] of [['<title>QF Launchpad (devnet)</title>', `<title>${TEXT.title}</title>`], ['<span class="pill">DEVNET</span>', `<span class="pill">${TEXT.pill}</span>`],
  ['<span id="netnote">Test network. Nothing here has value.</span>', `<span id="netnote">${TEXT.note}</span>`], ['>Devnet test build. ', `>${TEXT.foot} `],
  ['<body>', `<body data-cluster="${cluster}">`]] as const) {
  if (!html.includes(from)) throw new Error(`launchpad.html no longer has ${from}`);
  html = html.replace(from, to);
}
writeFileSync(join(out, 'launchpad.html'), html);
// Launchpad web fonts (OFL-1.1, exact exceptions QF-LIC-EX-003..005): the unmodified latin variable woff2 files, each with its licence beside it.
mkdirSync(join(out, 'fonts'), { recursive: true });
for (const f of ['bricolage-grotesque', 'geist', 'geist-mono']) {
  const pkg = join(here, 'node_modules/@fontsource-variable', f);
  copyFileSync(join(pkg, 'files', `${f}-latin-wght-normal.woff2`), join(out, 'fonts', `${f}.woff2`));
  copyFileSync(join(pkg, 'LICENSE'), join(out, 'fonts', `${f}.OFL.txt`));
}
console.log(JSON.stringify({ cluster, curve: deployment.curve, pool: deployment.pool, outputs: Object.keys(r.metafile.outputs).map((p) => p.split('/dist/').pop()), inputs: Object.keys(r.metafile.inputs).length }));
