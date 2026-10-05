// Mainnet mode: the same server on mainnet is read-only. TEST_ONLY: synthetic chain double, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READINESS } from '@project-qf/core';
import { PROGRAM_IDS } from '@project-qf/tx';
import { USDC_MAINNET } from '@project-qf/adapter-meteora-dbc/launchpad';
import { mainnetChainChecks, mintFields, profileFromEnv } from '../src/cluster.ts';
import { LaunchpadStore } from '../src/store.ts';
import { harness, seedLaunch } from './support/harness.ts';

test('devnet stays the default; mainnet is read-only, with USDC, no faucet, its own database and every reason stated', () => {
  const d = profileFromEnv({});
  assert.deepEqual([d.cluster, d.mode, d.writes, d.faucet, d.defaultDb], ['devnet', 'DEVNET', true, true, 'qf-launchpad.sqlite']);
  assert.equal(profileFromEnv({ QF_RPC_DEVNET: 'https://dev.example' }).rpc, 'https://dev.example');
  const m = profileFromEnv({ QF_CLUSTER: 'mainnet-beta', MAINNET_WRITES: 'true' });
  assert.deepEqual([m.mode, m.writes, m.faucet, m.defaultDb, m.rpc2], ['MAINNET_READ_ONLY', false, false, 'qf-launchpad-mainnet.sqlite', null]);
  assert.deepEqual(m.quote, { ...USDC_MAINNET });
  const why = m.writesLockedBecause.join('\n');
  for (const r of [/no mainnet write path/, /MAINNET_WRITES is false/, /readiness MAINNET is BLOCKED/, /no second RPC provider/, /MAINNET_WRITES=true in the environment is ignored/]) assert.match(why, r);
  assert.throws(() => profileFromEnv({ QF_CLUSTER: 'testnet' }), /devnet or mainnet-beta/);
});

test('even with every gate open, this build cannot write on mainnet', () => {
  const open = { ...READINESS, MAINNET: { ...READINESS.MAINNET, status: 'ACTIVE' as const, blockers: [] } };
  const m = profileFromEnv({ QF_CLUSTER: 'mainnet-beta', QF_RPC_URL_2: 'https://b.example' }, open as never, { MAINNET_WRITES: true } as never);
  assert.equal(m.writes, false);
  assert.deepEqual(m.writesLockedBecause, ['this build has no mainnet write path: its mainnet RPC connections refuse every send']);
});

test('[TEST_ONLY] a mainnet server refuses every launch, trade, submit, claim, treasury step and faucet request, and still reads', async () => {
  const profile = profileFromEnv({ QF_CLUSTER: 'mainnet-beta' });
  const h = await harness({ profile });
  const mint = seedLaunch(h.store, h.platform);
  const w = 'F77mcrJorEvnpAWd2g25mKqQW6RA6zpPSQFBjw4ENpaQ';
  const writes: [string, unknown][] = [
    ['/api/lp/launch', { creator: w }], ['/api/lp/swap', { mint, user: w, side: 'buy', amountIn: '1' }], ['/api/lp/submit', { intentId: 'x', signedTransaction: 'x' }],
    ['/api/lp/claim', { mint, user: w, venue: 'curve' }], ['/api/lp/treasury/propose', { mint, venue: 'curve', member: w }],
    ['/api/lp/treasury/approve', { transactionIndex: '1', member: w }], ['/api/lp/treasury/execute', { transactionIndex: '1', member: w }],
  ];
  for (const [path, body] of writes) {
    const r = await h.call(path, body);
    assert.equal(r.status, 423, path); assert.equal(r.body.error.code, 'WRITES_LOCKED', path);
    assert.match(r.body.error.message, /mainnet is read-only/);
    assert.ok(r.body.error.details.some((d: string) => /no mainnet write path/.test(d)), path);
  }
  const f = await h.call('/api/lp/faucet', { wallet: w });
  assert.deepEqual([f.status, f.body.error.code], [404, 'NO_FAUCET']);
  assert.equal(h.sent.length, 0, 'nothing was sent'); assert.equal(h.faucetCalls.length, 0);

  const pl = (await h.call('/api/lp/platform')).body;
  assert.deepEqual([pl.cluster, pl.mode, pl.writesEnabled, pl.faucet, pl.mainnetQuote.symbol], ['mainnet-beta', 'MAINNET_READ_ONLY', false, null, 'USDC']);
  assert.ok(pl.mainnetBlockers.length > 0);
  assert.equal((await h.call('/api/lp/healthz')).body.mode, 'MAINNET_READ_ONLY');
  assert.equal((await h.call('/api/lp/tokens')).status, 200, 'reading still works');
  const q = await h.call('/api/lp/quote', { mint, side: 'buy', amountIn: '1000000' });
  assert.equal(q.status, 200, 'a quote builds nothing and stays available');
});

test('[TEST_ONLY] the devnet server is unchanged: writes on, faucet on', async () => {
  const h = await harness();
  const pl = (await h.call('/api/lp/platform')).body;
  assert.deepEqual([pl.cluster, pl.mode, pl.writesEnabled, pl.faucet !== null], ['devnet', 'DEVNET', true, true]);
});

test('a database belongs to one network for life', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-bind-'));
  const fresh = new LaunchpadStore(join(dir, 'a.sqlite'));
  assert.equal(fresh.bindCluster('mainnet-beta'), 'mainnet-beta');
  assert.throws(() => fresh.bindCluster('devnet'), /STORE_CLUSTER_MISMATCH/);
  fresh.close();
  const old = new LaunchpadStore(join(dir, 'b.sqlite'));
  old.setPlatform('platform', { cluster: 'devnet' }); // a store from before the marker, holding devnet data
  assert.throws(() => old.bindCluster('mainnet-beta'), /belongs to devnet/);
  assert.equal(old.bindCluster('devnet'), 'devnet');
  old.close();
});

// SPL mint bytes: mint authority option + key, supply, decimals, initialized, freeze authority option + key
function mintBytes(decimals: number, initialized = true) {
  const d = Buffer.alloc(82);
  d.writeUInt32LE(1, 0); d.fill(7, 4, 36); d.writeBigUInt64LE(123n, 36); d[44] = decimals; d[45] = initialized ? 1 : 0; d.writeUInt32LE(1, 46); d.fill(9, 50, 82);
  return d;
}
const providerOf = (slot: number, map: Record<string, { owner: string; executable?: boolean; data: Buffer }>) => ({
  getMultipleAccountsInfoAndContext: async (keys: { toBase58(): string }[]) => ({ context: { slot },
    value: keys.map((k) => { const a = map[k.toBase58()]; return a ? { owner: { toBase58: () => a.owner }, executable: !!a.executable, data: a.data } : null; }) }) });
const chainOf = (mint: Buffer, executable = true) => ({ [USDC_MAINNET.mint]: { owner: PROGRAM_IDS.TOKEN, data: mint },
  [PROGRAM_IDS.DBC]: { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable, data: Buffer.from([2]) },
  [PROGRAM_IDS.DAMM_V2]: { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: Buffer.from([2]) },
  [PROGRAM_IDS.SQUADS_V4]: { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: Buffer.from([2]) } });

test('[TEST_ONLY] mainnet startup checks: the quote mint and the three programs, from both providers', async () => {
  const ok = await mainnetChainChecks(providerOf(5, chainOf(mintBytes(6))) as never, providerOf(6, chainOf(mintBytes(6))) as never, USDC_MAINNET);
  assert.deepEqual([ok.ok, ok.crossChecked, ok.items.map((i) => i.status).join()], [true, true, 'MATCH,MATCH,MATCH,MATCH']);
  const single = await mainnetChainChecks(providerOf(5, chainOf(mintBytes(6))) as never, null, USDC_MAINNET);
  assert.deepEqual([single.ok, single.crossChecked, single.items[0]!.status], [true, false, 'SINGLE_PROVIDER']);
  const wrongDecimals = await mainnetChainChecks(providerOf(5, chainOf(mintBytes(9))) as never, null, USDC_MAINNET);
  assert.match(wrongDecimals.problems.join(), /not a 6-decimal SPL Token mint/);
  const notExec = await mainnetChainChecks(providerOf(5, chainOf(mintBytes(6), false)) as never, null, USDC_MAINNET);
  assert.match(notExec.problems.join(), /Dynamic Bonding Curve program is not executable/);
  const disagree = await mainnetChainChecks(providerOf(5, chainOf(mintBytes(6))) as never, providerOf(5, chainOf(mintBytes(9))) as never, USDC_MAINNET);
  assert.match(disagree.problems.join(), /quote mint .*MISMATCH/);
  const m = mintFields(PROGRAM_IDS.TOKEN, mintBytes(6));
  assert.deepEqual([m.decimals, m.initialized, typeof m.mintAuthority, typeof m.freezeAuthority], [6, true, 'string', 'string']);
});
