// CLI for the devnet launchpad.
//   node --use-env-proxy src/main.ts operator   prints the operator's PUBLIC address and devnet SOL balance (fund it from a faucet)
//   node --use-env-proxy src/main.ts setup      creates the TEST_ONLY quote token and the DBC config once (needs ~0.1 devnet SOL)
//   node --use-env-proxy src/main.ts serve      starts the launchpad on 127.0.0.1 (indexer + migration crank in the background)
// Configuration (environment): QF_LP_DB (default ./qf-launchpad.sqlite), QF_LP_PORT (default 8788), QF_RPC_DEVNET (default the
// public devnet endpoint), QF_DEVNET_KEY (default ~/.qf-devnet/operator.json; must be outside any git checkout, mode 0600),
// QF_PUBLIC_BASE_URL (default http://127.0.0.1:<port>; written into on-chain metadata URIs), QF_STATIC_DIR (default ../web/dist).
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDevnet, getLamports, loadOrCreateDevnetKeypair, publicKeyOf } from '@project-qf/adapter-meteora-dbc/launchpad';
import { READINESS } from '@project-qf/core';
import { realChain } from './chain.ts';
import { startBackground } from './indexer.ts';
import { ensurePlatform, type PlatformRecord } from './platform.ts';
import { createLaunchpadApp } from './server.ts';
import { LaunchpadStore } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (m: string) => console.log(`[launchpad ${new Date().toISOString()}] ${m}`);
const [cmd] = process.argv.slice(2);

if (READINESS.DEVNET_INTEGRATION.status !== 'ACTIVE' && cmd !== 'operator') {
  console.error(`DEVNET_INTEGRATION is ${READINESS.DEVNET_INTEGRATION.status}: ${READINESS.DEVNET_INTEGRATION.blockers.join('; ')}`);
  process.exit(78);
}
const rpc = env.QF_RPC_DEVNET ?? 'https://api.devnet.solana.com';
const conn = await connectDevnet(rpc);
const operator = loadOrCreateDevnetKeypair(env.QF_DEVNET_KEY ?? join(homedir(), '.qf-devnet', 'operator.json'));

if (cmd === 'operator') {
  console.log(JSON.stringify({ operator: publicKeyOf(operator), devnetLamports: (await getLamports(conn, publicKeyOf(operator))).toString() }));
} else if (cmd === 'setup') {
  const store = new LaunchpadStore(resolve(env.QF_LP_DB ?? 'qf-launchpad.sqlite'));
  const p = await ensurePlatform(conn, operator, store, log);
  console.log(JSON.stringify({ quote: p.quote, config: p.config, threshold: p.threshold.rawQuoteThreshold, launchEconomicsDigest: p.launchEconomicsDigest }, null, 2));
  store.close();
} else if (cmd === 'serve') {
  // A long-running server must not die because a dependency left a promise behind (seen on devnet: a 429 from the public
  // RPC inside a library call nobody awaited). Log it and keep serving; every request path has its own error handling.
  process.on('unhandledRejection', (e) => log(`unhandled rejection (kept running): ${((e as Error)?.stack ?? String(e)).slice(0, 600)}`));
  const store = new LaunchpadStore(resolve(env.QF_LP_DB ?? 'qf-launchpad.sqlite'));
  const port = Number(env.QF_LP_PORT ?? 8788);
  const chain = realChain(conn, operator);
  const app = createLaunchpadApp({ store, chain, platform: () => store.getPlatform<PlatformRecord>('platform'), log,
    staticDir: resolve(env.QF_STATIC_DIR ?? join(here, '..', '..', 'web', 'dist')), publicBaseUrl: env.QF_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}` });
  app.listen(port, '127.0.0.1', () => log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, operator: chain.operatorAddress, ready: !!store.getPlatform('platform') })));
  startBackground({ store, chain, poolCache: app.poolCache, dammCache: app.dammCache, log }, Number(env.QF_LP_INTERVAL_MS ?? 15_000));
} else {
  console.error('usage: main.ts operator | setup | serve');
  process.exitCode = 64;
}
