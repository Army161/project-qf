// CLI for the launchpad on Project QF's own engine (ADR-014). No web3.js: Solana Kit only.
//   node --use-env-proxy src/main.ts operator              prints the operator's PUBLIC address and SOL balance (on devnet it
//                                                          first makes a throwaway key if there is none)
//   node --use-env-proxy src/main.ts serve                 starts the launchpad (indexer + graduation crank in the background)
//   node --use-env-proxy src/main.ts verify [--json file]  reads every coin on the engine and its history (sends nothing), then checks
//                                                          each coin's books against the chain (PASS / FAIL / WAIT); a new store works
// The engine's settings (its Global account and pool config) are set up by the engine's admin, not by this app.
// Configuration (environment): QF_CLUSTER (devnet, the default; localnet: a validator on 127.0.0.1 only; mainnet-beta:
// refused unless packages/core marks MAINNET active and MAINNET_WRITES true, and QF_CONFIRM_MAINNET=mainnet-beta),
// QF_RPC_URL (default the public devnet endpoint, or http://127.0.0.1:8899 on localnet; required on mainnet),
// QF_RPC2_URL (a second provider on another host for decision reads; required on mainnet), QF_ENGINE_CURVE,
// QF_ENGINE_POOL and QF_ENGINE_POOL_FEE_RECEIVER (mainnet only: the owner's program ids and the treasury's wrapped-SOL
// account, from the engine repo's mainnet/keys.json), QF_LP_DB (default ./qf-launchpad-engine[-localnet|-mainnet].sqlite),
// QF_LP_PORT (8788), QF_LP_HOST (127.0.0.1), QF_OPERATOR_KEY or QF_DEVNET_KEY (the crank's key file: default
// ~/.qf-devnet/operator.json, or ~/.qf-mainnet/operator.json, outside any git checkout, mode 0600; without it the
// crank is off and so is the devnet faucet; on mainnet it is a hot key holding only the graduation float, never made
// here), QF_PRIORITY_MICROLAMPORTS (priority fee per compute unit: default 0, or 20000 on mainnet; at most 100000),
// QF_PUBLIC_BASE_URL, QF_STATIC_DIR (../web/dist), QF_CLIENT_IP_HEADER, QF_LP_INTERVAL_MS (15000).
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSolanaRpc } from '@solana/kit';
import * as E from '@project-qf/engine';
import { READINESS } from '@project-qf/core';
import { engineBooks, engineBooksText } from './books.ts';
import { calmRpc, checkDeployment, createOperatorKey, kitChain, loadOperator, mainnetGate, proveCluster, proveSecondProvider, type LaunchCluster } from './chain.ts';
import { catchUp, startEngineBackground } from './indexer.ts';
import { SOL_QUOTE } from './market.ts';
import { createEngineApp, MAX_PRIORITY_MICROLAMPORTS, type EngineProfile } from './server.ts';
import { bindDeployment, EngineStore } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (m: string) => console.log(`[launchpad qf ${new Date().toISOString()}] ${m}`);
const [cmd] = process.argv.slice(2);
const fail = (code: number, m: string): never => { console.error(m); process.exit(code); };

const wanted: LaunchCluster = !env.QF_CLUSTER || env.QF_CLUSTER === 'devnet' ? 'devnet' : env.QF_CLUSTER === 'localnet' || env.QF_CLUSTER === 'mainnet-beta' ? env.QF_CLUSTER
  : fail(64, `QF_CLUSTER must be devnet, localnet or mainnet-beta (got ${env.QF_CLUSTER})`);
const mainnet = wanted === 'mainnet-beta';
const stage = READINESS[wanted === 'devnet' ? 'DEVNET_INTEGRATION' : wanted === 'localnet' ? 'LOCALNET_INTEGRATION' : 'MAINNET'];
if (stage.status !== 'ACTIVE' && (cmd !== 'operator' || mainnet)) fail(78, `${wanted} is BLOCKED: ${stage.blockers.join('; ')}`);
const rpcUrl = env.QF_RPC_URL || (wanted === 'localnet' ? 'http://127.0.0.1:8899' : mainnet ? '' : env.QF_RPC_DEVNET || 'https://api.devnet.solana.com');
if (mainnet && (!rpcUrl || !env.QF_RPC2_URL)) fail(64, 'mainnet needs QF_RPC_URL and QF_RPC2_URL: two RPC providers on different hosts');
const rpc = calmRpc(createSolanaRpc(rpcUrl));
const genesis = async () => String(await rpc.getGenesisHash().send());
const cluster = await proveCluster(rpcUrl, wanted, genesis, mainnetGate(env.QF_CONFIRM_MAINNET));
const rpc2 = env.QF_RPC2_URL || undefined;
if (rpc2) await proveSecondProvider(rpcUrl, rpc2, await genesis(), async () => String(await calmRpc(createSolanaRpc(rpc2)).getGenesisHash().send()));
const deployment = cluster === 'mainnet-beta'
  ? E.mainnetDeployment({ curve: env.QF_ENGINE_CURVE ?? '', pool: env.QF_ENGINE_POOL ?? '', poolFeeReceiver: env.QF_ENGINE_POOL_FEE_RECEIVER ?? '' })
  : E.deploymentFor(cluster);
E.useDeployment(deployment);
const priority = /^\d{1,6}$/.test(env.QF_PRIORITY_MICROLAMPORTS ?? (mainnet ? '20000' : '0')) ? BigInt(env.QF_PRIORITY_MICROLAMPORTS ?? (mainnet ? '20000' : '0'))
  : fail(64, 'QF_PRIORITY_MICROLAMPORTS must be a whole number');
if (priority > MAX_PRIORITY_MICROLAMPORTS) fail(64, `QF_PRIORITY_MICROLAMPORTS is at most ${MAX_PRIORITY_MICROLAMPORTS}`);
const keyFile = env.QF_OPERATOR_KEY ?? env.QF_DEVNET_KEY ?? join(homedir(), mainnet ? '.qf-mainnet' : '.qf-devnet', 'operator.json');
if (cmd === 'operator' && cluster === 'devnet' && createOperatorKey(keyFile)) log(`made a throwaway devnet operator key in ${keyFile} (mode 0600)`);
const operator = await loadOperator(keyFile);
const chain = kitChain(rpcUrl, operator, log, { ...(rpc2 ? { secondRpcUrl: rpc2 } : {}), ...(priority > 0n ? { computeUnitPrice: priority } : {}) });
await checkDeployment(chain.decisionRead ?? chain.read, deployment);
const profile: EngineProfile = { cluster, writes: true, faucet: !!operator && !mainnet, writesLockedBecause: [], priorityMicroLamports: priority,
  label: mainnet ? 'Real network: SOL and coins here are real money' : cluster === 'devnet' ? 'Test network: coins here have no value' : 'Local test validator: coins here have no value' };
const openStore = async () => {
  const st = new EngineStore(resolve(env.QF_LP_DB ?? `qf-launchpad-engine${cluster === 'devnet' ? '' : cluster === 'localnet' ? '-localnet' : '-mainnet'}.sqlite`));
  await st.bind('cluster', cluster); await st.bind('genesis', await genesis()); await st.bind('quote', SOL_QUOTE.mint);
  await bindDeployment(st, deployment.curve);
  return st;
};

if (cmd === 'operator') {
  console.log(JSON.stringify({ cluster, programs: deployment, operator: operator?.address ?? null, lamports: operator ? (await chain.lamports(operator.address)).toString() : null }));
} else if (cmd === 'serve') {
  process.on('unhandledRejection', (e) => log(`unhandled rejection (kept running): ${((e as Error)?.stack ?? String(e)).slice(0, 600)}`));
  const store = await openStore();
  const port = Number(env.QF_LP_PORT ?? 8788), host = env.QF_LP_HOST ?? '127.0.0.1';
  const app = createEngineApp({ store, chain, quote: SOL_QUOTE, profile, log, ...(env.QF_CLIENT_IP_HEADER ? { clientIpHeader: env.QF_CLIENT_IP_HEADER } : {}),
    staticDir: resolve(env.QF_STATIC_DIR ?? join(here, '..', '..', 'web', 'dist')), publicBaseUrl: env.QF_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}` });
  app.listen(port, host, () => log(JSON.stringify({ listening: `http://${host}:${port}`, engine: 'qf', cluster, programs: deployment, operator: chain.operatorAddress })));
  const stopIndexer = startEngineBackground({ store, chain, log }, Number(env.QF_LP_INTERVAL_MS ?? 15_000));
  const stop = (sig: string) => { log(`${sig}: closing`); stopIndexer(); app.close(); app.closeAllConnections(); try { void store.close(); } catch { /* already closed */ } process.exit(0); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
} else if (cmd === 'verify') {
  const store = await openStore();
  await catchUp({ store, chain, log });
  const books = await engineBooks(store, chain, SOL_QUOTE, cluster);
  console.log(engineBooksText(books));
  const k = process.argv.indexOf('--json');
  if (k > 0 && process.argv[k + 1]) writeFileSync(process.argv[k + 1]!, JSON.stringify(books, null, 1) + '\n');
  await store.close();
  if (books.summary.fail) process.exitCode = 1;
} else {
  console.error('usage: main.ts operator | serve | verify [--json file]');
  process.exitCode = 64;
}
