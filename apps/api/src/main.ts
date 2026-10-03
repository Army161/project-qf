// CLI for the private read-only API.
//   node src/main.ts create-user <name>   prints a new bearer token once (only its SHA-256 is stored)
//   node --use-env-proxy src/main.ts serve  starts the server (127.0.0.1 only)
//   node --use-env-proxy src/main.ts probe  read-only provider capability probe; prints sanitized JSON rows
// Configuration (environment): QF_DB_PATH (default ./qf-api.sqlite), QF_PORT (default 8787), QF_STATIC_DIR (default ../web/dist),
// QF_RPC_MAINNET / QF_RPC_DEVNET / QF_HELIUS_API_KEY: providers, see config.ts. The Helius key stays server-side and is never printed.
// Two independent providers per cluster are needed for S1.12; with one, S1.12 stays SKIP and the LIVE aggregate cannot pass.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEndpoints, endpointsFromEnv } from './config.ts';
import { probeProviders } from './probe.ts';
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
  const endpoints = endpointsFromEnv(env);
  const staticDir = resolve(env.QF_STATIC_DIR ?? join(here, '..', '..', 'web', 'dist'));
  const port = Number(env.QF_PORT ?? 8787);
  createApp({ store, staticDir, inspect: { endpoints, fetchImpl: (u, i) => fetch(u, i), now: () => new Date() } }).listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, schema: store.schemaVersion(),
      providers: describeEndpoints(endpoints) }));
  });
} else if (cmd === 'probe') {
  const endpoints = endpointsFromEnv(env);
  store.close();
  const rows = await probeProviders(endpoints, (u, i) => fetch(u, i));
  console.log(JSON.stringify({ at: new Date().toISOString(), providers: describeEndpoints(endpoints), rows }, null, 2));
} else {
  console.error('usage: main.ts create-user <name> | serve | probe');
  process.exitCode = 64;
}
