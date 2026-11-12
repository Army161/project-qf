// The web build's network selection (build.ts): one build serves one network, and a mainnet build takes only the owner's
// ids, checked like the server checks them. TEST_ONLY: the "mainnet" ids are synthetic keys generated here, never deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENTS } from '@project-qf/engine';
import { generateMintKey } from '@project-qf/tx';

const script = fileURLToPath(new URL('../build.ts', import.meta.url));
const run = (env: Record<string, string>) => {
  const out = mkdtempSync(join(tmpdir(), 'qf-web-build-'));
  try {
    const log = execFileSync(process.execPath, [script], { env: { ...process.env, ...env, QF_WEB_OUT: out }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { log, html: readFileSync(join(out, 'launchpad.html'), 'utf8'), js: readFileSync(join(out, 'launchpad.js'), 'utf8') };
  } finally { rmSync(out, { recursive: true, force: true }); }
};

test('web build: a mainnet build carries the owner ids and real-money labels; it refuses missing, test-build and repeated ids', async () => {
  const [curve, pool, fee] = await Promise.all([generateMintKey(), generateMintKey(), generateMintKey()]).then((ks) => ks.map((k) => k.address));
  const m = run({ QF_WEB_CLUSTER: 'mainnet-beta', QF_WEB_CURVE: curve!, QF_WEB_POOL: pool!, QF_WEB_POOL_FEE_RECEIVER: fee! });
  assert.match(m.html, /<body data-cluster="mainnet-beta">/);
  assert.match(m.html, /<span class="pill">MAINNET<\/span>/);
  assert.match(m.html, /real money/);
  assert.doesNotMatch(m.html, /devnet|Devnet|no value/);
  for (const id of [curve!, pool!, fee!]) assert.ok(m.js.includes(id), 'the owner ids are compiled in');

  const fails = (env: Record<string, string>, says: RegExp) =>
    assert.throws(() => run({ QF_WEB_CLUSTER: 'mainnet-beta', QF_WEB_CURVE: curve!, QF_WEB_POOL: pool!, QF_WEB_POOL_FEE_RECEIVER: fee!, ...env }), (e: { stderr?: string }) => says.test(String(e.stderr)));
  fails({ QF_WEB_POOL_FEE_RECEIVER: '' }, /needs QF_WEB_POOL_FEE_RECEIVER/);
  fails({ QF_WEB_CURVE: DEPLOYMENTS.devnet.curve }, /belongs to a test build/);
  fails({ QF_WEB_POOL: DEPLOYMENTS.localnet.pool }, /belongs to a test build/);
  fails({ QF_WEB_POOL: curve! }, /must differ/);
  assert.throws(() => run({ QF_WEB_CLUSTER: 'testnet' }), (e: { stderr?: string }) => /must be devnet, localnet or mainnet-beta/.test(String(e.stderr)));
});

test('web build: devnet is the default and names the devnet engine; localnet names the local build', () => {
  const d = run({ QF_WEB_CLUSTER: '' });
  assert.match(d.html, /<body data-cluster="devnet">/);
  assert.match(d.html, /<span class="pill">DEVNET<\/span>/);
  assert.ok(d.js.includes(DEPLOYMENTS.devnet.curve) && d.js.includes(DEPLOYMENTS.devnet.poolFeeReceiver));
  const l = run({ QF_WEB_CLUSTER: 'localnet' });
  assert.match(l.html, /<body data-cluster="localnet">/);
  assert.ok(l.js.includes(DEPLOYMENTS.localnet.curve));
});
