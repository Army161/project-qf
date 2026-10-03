// CLI for the private read-only API.
//   node src/main.ts create-user <name>   prints a new bearer token once (only its SHA-256 is stored)
//   node --use-env-proxy src/main.ts serve  starts the server (127.0.0.1 only)
// Configuration (environment): QF_DB_PATH (default ./qf-api.sqlite), QF_PORT (default 8787), QF_STATIC_DIR (default ../web/dist),
// QF_RPC_MAINNET / QF_RPC_DEVNET: comma-separated https RPC URLs without credentials (defaults: Solana's public endpoints).
// Two independent mainnet providers are needed for S1.12; with one, S1.12 stays SKIP and the LIVE aggregate cannot pass.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointFromUrl, type LiveCluster } from './rpc.ts';
import { createApp } from './server.ts';
import { Store } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const store = new Store(resolve(env.QF_DB_PATH ?? 'qf-api.sqlite'));
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'create-user') {
  const name = (args.join(' ') || 'owner').slice(0, 64);
  const { user, token } = store.createUser(name);
  console.log(JSON.stringify({ user, token, note: 'Shown once. Store it in a password manager; the server keeps only its SHA-256.' }, null, 2));
  store.close();
} else if (cmd === 'serve') {
  const list = (v: string | undefined, d: string, c: LiveCluster) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean).map((u) => endpointFromUrl(u, c));
  const endpoints = { 'mainnet-beta': list(env.QF_RPC_MAINNET, 'https://api.mainnet.solana.com', 'mainnet-beta'), devnet: list(env.QF_RPC_DEVNET, 'https://api.devnet.solana.com', 'devnet') };
  const staticDir = resolve(env.QF_STATIC_DIR ?? join(here, '..', '..', 'web', 'dist'));
  const port = Number(env.QF_PORT ?? 8787);
  createApp({ store, staticDir, inspect: { endpoints, fetchImpl: (u, i) => fetch(u, i), now: () => new Date() } }).listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, schema: store.schemaVersion(),
      providers: { 'mainnet-beta': endpoints['mainnet-beta'].map((e) => e.id), devnet: endpoints.devnet.map((e) => e.id) } }));
  });
} else {
  console.error('usage: main.ts create-user <name> | serve');
  process.exitCode = 64;
}
