// CLI for the devnet launchpad.
//   node --use-env-proxy src/main.ts operator   prints the operator's PUBLIC address and devnet SOL balance (fund it from a faucet)
//   node --use-env-proxy src/main.ts setup      creates the TEST_ONLY quote token and the DBC config once (needs ~0.1 devnet SOL)
//   node --use-env-proxy src/main.ts treasury-setup <m1,m2,m3>   creates the 2-of-3 platform treasury multisig from three member PUBLIC keys
//                                               (src/member.ts init makes them) and a new DBC config paying platform fees to its vault
//   node --use-env-proxy src/main.ts serve      starts the launchpad on 127.0.0.1 (indexer + migration crank in the background)
//   node --use-env-proxy src/main.ts chain-check   reads the quote mint and programs from both RPC providers and prints the result
//   QF_CLUSTER=mainnet-beta node --use-env-proxy src/main.ts plan [--members a,b,c] [--threshold 2] [--time-lock 0] [--graduation-usd 5000] [--out dir]
//                                               builds the mainnet setup plan (treasury multisig + USDC config) for review:
//                                               placeholder signers, never signable, reads only (mainnet-plan.ts)
// Mainnet: QF_CLUSTER=mainnet-beta runs the same app read-only (DEPLOYMENT.md staging): no operator key is loaded, the RPC
// connections cannot send, and every launch, trade, claim, treasury and faucet request is refused (cluster.ts).
// Configuration (environment): QF_CLUSTER (devnet | mainnet-beta, default devnet), QF_RPC_URL (QF_RPC_DEVNET still works on
// devnet; default the public endpoint), QF_RPC_URL_2 (second provider for cross-checked reads), QF_LP_DB (default
// ./qf-launchpad.sqlite, mainnet ./qf-launchpad-mainnet.sqlite; a database is bound to one network), QF_LP_PORT (default
// 8788), QF_LP_HOST (default 127.0.0.1), QF_DEVNET_KEY (default ~/.qf-devnet/operator.json; outside any git checkout, mode
// 0600), QF_PUBLIC_BASE_URL (default http://127.0.0.1:<port>; written into on-chain metadata URIs), QF_STATIC_DIR (default ../web/dist),
// QF_CLIENT_IP_HEADER (behind a hosting proxy: the header carrying the client address, e.g. fly-client-ip; deploy/RUNBOOK.md).
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDevnet, connectMainnetReadOnly, getLamports, loadOrCreateDevnetKeypair, publicKeyOf } from '@project-qf/adapter-meteora-dbc/launchpad';
import { READINESS } from '@project-qf/core';
import { realChain } from './chain.ts';
import { startBackground } from './indexer.ts';
import { ensurePlatform, setupTreasury, type PlatformRecord } from './platform.ts';
import { createLaunchpadApp } from './server.ts';
import { mainnetChainChecks, profileFromEnv, type ChainChecks } from './cluster.ts';
import { buildMainnetSetupPlan, renderPlanMarkdown } from './mainnet-plan.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LaunchpadStore } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (m: string) => console.log(`[launchpad ${new Date().toISOString()}] ${m}`);
const [cmd] = process.argv.slice(2);

const profile = profileFromEnv(env);
const mainnet = profile.cluster === 'mainnet-beta';
if (mainnet && cmd !== 'serve' && cmd !== 'chain-check' && cmd !== 'plan') {
  console.error(`${cmd ?? '(none)'} is not available on mainnet: mainnet is read-only (${profile.writesLockedBecause.join('; ')})`);
  process.exit(78);
}
if (!mainnet && READINESS.DEVNET_INTEGRATION.status !== 'ACTIVE' && cmd !== 'operator') {
  console.error(`DEVNET_INTEGRATION is ${READINESS.DEVNET_INTEGRATION.status}: ${READINESS.DEVNET_INTEGRATION.blockers.join('; ')}`);
  process.exit(78);
}
const conn = mainnet ? await connectMainnetReadOnly(profile.rpc) : await connectDevnet(profile.rpc);
const conn2 = profile.rpc2 ? (mainnet ? await connectMainnetReadOnly(profile.rpc2) : await connectDevnet(profile.rpc2)) : null;
// mainnet loads no key at all; devnet's operator key is a throwaway outside git
const operator = mainnet ? null : loadOrCreateDevnetKeypair(env.QF_DEVNET_KEY ?? join(homedir(), '.qf-devnet', 'operator.json'));
const openStore = () => { const st = new LaunchpadStore(resolve(env.QF_LP_DB ?? profile.defaultDb)); st.bindCluster(profile.cluster); return st; };

if (cmd === 'chain-check') {
  const r = mainnet ? await mainnetChainChecks(conn, conn2, profile.quote!) : { cluster: 'devnet', note: 'chain-check reads the mainnet quote mint and programs; run it with QF_CLUSTER=mainnet-beta' };
  console.log(JSON.stringify({ cluster: profile.cluster, mode: profile.mode, writes: profile.writes, writesLockedBecause: profile.writesLockedBecause, ...r }, null, 2));
  if ('ok' in r && !r.ok) process.exitCode = 1;
} else if (cmd === 'plan') {
  if (!mainnet) { console.error('plan is the mainnet setup plan: run it with QF_CLUSTER=mainnet-beta'); process.exit(64); }
  const arg = (name: string) => { const k = process.argv.indexOf(`--${name}`); return k > 0 ? process.argv[k + 1] : undefined; };
  const members = arg('members')?.split(',').filter(Boolean) ?? null;
  const plan = await buildMainnetSetupPlan(conn, conn2, { members, threshold: Number(arg('threshold') ?? 2), timeLockSeconds: Number(arg('time-lock') ?? 0),
    graduationUsd: arg('graduation-usd') ?? '5000' });
  const out = resolve(arg('out') ?? '.');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'mainnet-setup-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(join(out, 'MAINNET-SETUP-PLAN.md'), renderPlanMarkdown(plan));
  console.log(JSON.stringify({ status: plan.status, signable: plan.signable, ok: plan.ok, checks: plan.transactions.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.id}`),
    totalLamports: plan.totalLamports, wrote: [join(out, 'mainnet-setup-plan.json'), join(out, 'MAINNET-SETUP-PLAN.md')] }, null, 2));
  if (!plan.ok) process.exitCode = 1;
} else if (!operator) {
  // only `serve` reaches here without a key (mainnet, read-only)
  await serve();
} else if (cmd === 'operator') {
  console.log(JSON.stringify({ operator: publicKeyOf(operator), devnetLamports: (await getLamports(conn, publicKeyOf(operator))).toString() }));
} else if (cmd === 'setup') {
  const store = openStore();
  const p = await ensurePlatform(conn, operator, store, log);
  console.log(JSON.stringify({ quote: p.quote, config: p.config, threshold: p.threshold.rawQuoteThreshold, launchEconomicsDigest: p.launchEconomicsDigest }, null, 2));
  store.close();
} else if (cmd === 'treasury-setup') {
  const members = (process.argv[3] ?? '').split(',').filter(Boolean);
  if (members.length !== 3) { console.error('usage: main.ts treasury-setup <member1,member2,member3> (public keys)'); process.exit(64); }
  const store = openStore();
  const p = await setupTreasury(conn, operator, store, members, log);
  console.log(JSON.stringify({ treasury: p.treasury, config: p.config, legacyConfigs: p.legacyConfigs, launchEconomicsDigest: p.launchEconomicsDigest }, null, 2));
  store.close();
} else if (cmd === 'serve') {
  await serve();
} else {
  console.error('usage: main.ts operator | setup | treasury-setup <m1,m2,m3> | serve | chain-check | plan (mainnet)');
  process.exitCode = 64;
}

async function serve() {
  // A long-running server must not die because a dependency left a promise behind (seen on devnet: a 429 from the public
  // RPC inside a library call nobody awaited). Log it and keep serving; every request path has its own error handling.
  process.on('unhandledRejection', (e) => log(`unhandled rejection (kept running): ${((e as Error)?.stack ?? String(e)).slice(0, 600)}`));
  const store = openStore();
  const port = Number(env.QF_LP_PORT ?? 8788);
  const host = env.QF_LP_HOST ?? '127.0.0.1';
  const chain = realChain(conn, operator, log);
  // mainnet: re-read the quote mint and programs from both providers every 10 minutes and show the result
  let checks: ChainChecks | null = null;
  const refreshChecks = async () => { try { checks = await mainnetChainChecks(conn, conn2, profile.quote!); if (!checks.ok) log(`chain checks: ${checks.problems.join('; ')}`); } catch (e) { log(`chain checks failed: ${(e as Error).message}`); } };
  if (mainnet) { await refreshChecks(); setInterval(refreshChecks, 600_000).unref(); }
  const app = createLaunchpadApp({ store, chain, platform: () => store.getPlatform<PlatformRecord>('platform'), log, profile, chainChecks: () => checks,
    ...(env.QF_CLIENT_IP_HEADER ? { clientIpHeader: env.QF_CLIENT_IP_HEADER } : {}),
    staticDir: resolve(env.QF_STATIC_DIR ?? join(here, '..', '..', 'web', 'dist')), publicBaseUrl: env.QF_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}` });
  app.listen(port, host, () => log(JSON.stringify({ listening: `http://${host}:${port}`, cluster: profile.cluster, mode: profile.mode, writes: profile.writes,
    operator: chain.operatorAddress, ready: !!store.getPlatform('platform'), crossChecked: !!conn2 })));
  // a container stops the server with SIGTERM, and node running as PID 1 has no default handler: close cleanly here
  const stop = (sig: string) => { log(`${sig}: closing`); app.close(); app.closeAllConnections(); try { store.close(); } catch { /* already closed */ } process.exit(0); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  // mainnet read-only has no launches to index and nothing to crank
  if (!mainnet) startBackground({ store, chain, poolCache: app.poolCache, dammCache: app.dammCache, log }, Number(env.QF_LP_INTERVAL_MS ?? 15_000));
}
