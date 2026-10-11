// CLI for the launchpad on Project QF's own engine (QF_ENGINE=qf; ADR-014). No web3.js: Solana Kit only.
//   node --use-env-proxy src/main.ts operator              prints the operator's PUBLIC address and SOL balance
//   node --use-env-proxy src/main.ts serve                 starts the launchpad (indexer + graduation crank in the background)
//   node --use-env-proxy src/main.ts verify [--json file]  checks every engine coin's books against the chain (PASS / FAIL / WAIT)
// The engine's settings (its Global account and pool config) are set up by the engine's admin, not by this app.
// Configuration (environment): QF_CLUSTER (devnet, the default, or localnet: a validator on 127.0.0.1 only), QF_RPC_URL
// (default the public devnet endpoint, or http://127.0.0.1:8899 on localnet), QF_LP_DB (default
// ./qf-launchpad-engine.sqlite, or ./qf-launchpad-engine-localnet.sqlite), QF_LP_PORT (8788), QF_LP_HOST (127.0.0.1),
// QF_DEVNET_KEY (the operator key: default ~/.qf-devnet/operator.json, outside any git checkout, mode 0600; without it
// the faucet and the crank are off), QF_PUBLIC_BASE_URL, QF_STATIC_DIR (../web/dist), QF_CLIENT_IP_HEADER,
// QF_LP_INTERVAL_MS (15000).
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSolanaRpc } from '@solana/kit';
import { CAPABILITY_FLAGS, READINESS } from '@project-qf/core';
import * as E from '@project-qf/engine';
import { engineBooks, engineBooksText } from './books.ts';
import { kitChain, loadOperator, proveCluster } from './chain.ts';
import { startEngineBackground } from './indexer.ts';
import type { QuoteAsset } from './market.ts';
import { createEngineApp, type EngineProfile } from './server.ts';
import { EngineStore } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (m: string) => console.log(`[launchpad qf ${new Date().toISOString()}] ${m}`);
const [cmd] = process.argv.slice(2);

/** Every engine coin is quoted in SOL (wrapped for the programs, plain SOL in the wallet). */
export const SOL_QUOTE: QuoteAsset = Object.freeze({ mint: E.NATIVE_MINT, decimals: 9, symbol: 'SOL', label: 'test SOL' });

const wanted = env.QF_CLUSTER === 'localnet' ? 'localnet' : env.QF_CLUSTER && env.QF_CLUSTER !== 'devnet' ? null : 'devnet';
if (!wanted) { console.error(`QF_CLUSTER must be devnet or localnet (got ${env.QF_CLUSTER})`); process.exit(64); }
const rpcUrl = env.QF_RPC_URL || (wanted === 'localnet' ? 'http://127.0.0.1:8899' : env.QF_RPC_DEVNET || 'https://api.devnet.solana.com');
const stage = READINESS[wanted === 'devnet' ? 'DEVNET_INTEGRATION' : 'LOCALNET_INTEGRATION'];
if (stage.status !== 'ACTIVE' && cmd !== 'operator') { console.error(`${wanted} is BLOCKED: ${stage.blockers.join('; ')}`); process.exit(78); }
const rpc = createSolanaRpc(rpcUrl);
const genesis = async () => String(await rpc.getGenesisHash().send());
const cluster = await proveCluster(rpcUrl, wanted, genesis, CAPABILITY_FLAGS.MAINNET_WRITES as boolean);
const operator = await loadOperator(env.QF_DEVNET_KEY ?? join(homedir(), '.qf-devnet', 'operator.json'));
const chain = kitChain(rpcUrl, operator, log);
const profile: EngineProfile = { cluster, writes: true, faucet: !!operator, writesLockedBecause: [],
  label: cluster === 'devnet' ? 'Test network: coins here have no value' : 'Local test validator: coins here have no value' };
const openStore = async () => {
  const st = new EngineStore(resolve(env.QF_LP_DB ?? (cluster === 'devnet' ? 'qf-launchpad-engine.sqlite' : 'qf-launchpad-engine-localnet.sqlite')));
  st.bind('cluster', cluster); st.bind('genesis', await genesis()); st.bind('quote', SOL_QUOTE.mint);
  return st;
};

if (cmd === 'operator') {
  console.log(JSON.stringify({ cluster, operator: operator?.address ?? null, lamports: operator ? (await chain.lamports(operator.address)).toString() : null }));
} else if (cmd === 'serve') {
  process.on('unhandledRejection', (e) => log(`unhandled rejection (kept running): ${((e as Error)?.stack ?? String(e)).slice(0, 600)}`));
  const store = await openStore();
  const port = Number(env.QF_LP_PORT ?? 8788), host = env.QF_LP_HOST ?? '127.0.0.1';
  const app = createEngineApp({ store, chain, quote: SOL_QUOTE, profile, log, ...(env.QF_CLIENT_IP_HEADER ? { clientIpHeader: env.QF_CLIENT_IP_HEADER } : {}),
    staticDir: resolve(env.QF_STATIC_DIR ?? join(here, '..', '..', '..', 'web', 'dist')), publicBaseUrl: env.QF_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}` });
  app.listen(port, host, () => log(JSON.stringify({ listening: `http://${host}:${port}`, engine: 'qf', cluster, operator: chain.operatorAddress })));
  const stopIndexer = startEngineBackground({ store, chain, log }, Number(env.QF_LP_INTERVAL_MS ?? 15_000));
  const stop = (sig: string) => { log(`${sig}: closing`); stopIndexer(); app.close(); app.closeAllConnections(); try { store.close(); } catch { /* already closed */ } process.exit(0); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
} else if (cmd === 'verify') {
  const store = await openStore();
  const books = await engineBooks(store, chain, SOL_QUOTE, cluster);
  console.log(engineBooksText(books));
  const k = process.argv.indexOf('--json');
  if (k > 0 && process.argv[k + 1]) writeFileSync(process.argv[k + 1]!, JSON.stringify(books, null, 1) + '\n');
  store.close();
  if (books.summary.fail) process.exitCode = 1;
} else {
  console.error('usage (QF_ENGINE=qf): main.ts operator | serve | verify [--json file]');
  process.exitCode = 64;
}
