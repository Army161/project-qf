// CLI for the devnet launchpad on Meteora (QF_ENGINE unset or meteora; main.ts picks the engine).
//   node --use-env-proxy src/main.ts operator   prints the operator's PUBLIC address and devnet SOL balance (fund it from a faucet)
//   node --use-env-proxy src/main.ts setup      creates the TEST_ONLY quote token and the DBC config once (needs ~0.1 devnet SOL)
//   node --use-env-proxy src/main.ts treasury-setup <m1,m2,m3>   creates the 2-of-3 platform treasury multisig from three member PUBLIC keys
//                                               (src/member.ts init makes them) and a new DBC config paying platform fees to its vault
//   node --use-env-proxy src/main.ts serve      starts the launchpad on 127.0.0.1 (indexer + migration crank in the background)
//   node --use-env-proxy src/main.ts verify [--json file]   checks the books against the chain and prints PASS / FAIL / WAIT per check
// Configuration (environment): QF_RPC_URL (QF_RPC_DEVNET still works; default the public devnet endpoint), QF_LP_DB (default
// ./qf-launchpad.sqlite), QF_LP_PORT (default 8788), QF_LP_HOST (default 127.0.0.1), QF_DEVNET_KEY (default
// ~/.qf-devnet/operator.json; outside any git checkout, mode 0600), QF_PUBLIC_BASE_URL (default http://127.0.0.1:<port>;
// written into on-chain metadata URIs), QF_STATIC_DIR (default ../web/dist), QF_CLIENT_IP_HEADER (behind a hosting proxy:
// the header carrying the client address; deploy/RUNBOOK.md).
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDevnet, getLamports, loadOrCreateDevnetKeypair, publicKeyOf } from '@project-qf/adapter-meteora-dbc/launchpad';
import { READINESS } from '@project-qf/core';
import { allCoinRewards, computeBooks } from './books.ts';
import { realChain } from './chain.ts';
import { profileFromEnv } from './cluster.ts';
import { DammCache, PoolCache, startBackground } from './indexer.ts';
import { ensurePlatform, setupTreasury, type PlatformRecord } from './platform.ts';
import { createLaunchpadApp } from './server.ts';
import { LaunchpadStore } from './store.ts';
import { verifyReport } from './verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (m: string) => console.log(`[launchpad ${new Date().toISOString()}] ${m}`);
const [cmd] = process.argv.slice(2);

const profile = profileFromEnv(env);
if (READINESS.DEVNET_INTEGRATION.status !== 'ACTIVE' && cmd !== 'operator') {
  console.error(`DEVNET_INTEGRATION is ${READINESS.DEVNET_INTEGRATION.status}: ${READINESS.DEVNET_INTEGRATION.blockers.join('; ')}`);
  process.exit(78);
}
const conn = await connectDevnet(profile.rpc);
// the operator key is a throwaway outside git
const operator = loadOrCreateDevnetKeypair(env.QF_DEVNET_KEY ?? join(homedir(), '.qf-devnet', 'operator.json'));
const openStore = () => { const st = new LaunchpadStore(resolve(env.QF_LP_DB ?? profile.defaultDb)); st.bindCluster(profile.cluster); return st; };

if (cmd === 'operator') {
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
} else if (cmd === 'verify') {
  const store = openStore();
  const platform = store.getPlatform<PlatformRecord>('platform');
  if (!platform) { console.error('no platform in this store: nothing to verify'); process.exit(66); }
  const chain = realChain(conn, operator, () => {});
  const d = { store, chain, platform, pools: new PoolCache(chain), damms: new DammCache(chain), now: () => new Date(), cluster: profile.cluster };
  const books = await computeBooks(d);
  const rewards = await allCoinRewards(d);
  const r = verifyReport(books, rewards);
  console.log(r.text);
  const k = process.argv.indexOf('--json');
  if (k > 0 && process.argv[k + 1]) {
    writeFileSync(process.argv[k + 1]!, JSON.stringify({ summary: r.summary, checks: r.checks, books, rewards }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
  }
  store.close();
  if (r.summary.fail) process.exitCode = 1;
} else {
  console.error('usage: main.ts operator | setup | treasury-setup <m1,m2,m3> | serve | verify [--json file]');
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
  const app = createLaunchpadApp({ store, chain, platform: () => store.getPlatform<PlatformRecord>('platform'), log, profile,
    ...(env.QF_CLIENT_IP_HEADER ? { clientIpHeader: env.QF_CLIENT_IP_HEADER } : {}),
    staticDir: resolve(env.QF_STATIC_DIR ?? join(here, '..', '..', 'web', 'dist')), publicBaseUrl: env.QF_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}` });
  app.listen(port, host, () => log(JSON.stringify({ listening: `http://${host}:${port}`, cluster: profile.cluster, writes: profile.writes,
    operator: chain.operatorAddress, ready: !!store.getPlatform('platform') })));
  // a container stops the server with SIGTERM, and node running as PID 1 has no default handler: close cleanly here
  const stop = (sig: string) => { log(`${sig}: closing`); app.close(); app.closeAllConnections(); try { store.close(); } catch { /* already closed */ } process.exit(0); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  startBackground({ store, chain, poolCache: app.poolCache, dammCache: app.dammCache, log }, Number(env.QF_LP_INTERVAL_MS ?? 15_000));
}
