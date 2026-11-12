// The launchpad as one Vercel Function (devnet only: mainnet runs `main.ts serve` on a long-running host, where the
// crank's key is a file and decision reads have two providers). The same handler as `main.ts serve`, with three changes for
// serverless hosting: records live in Postgres behind the qf-db gateway (store-pg.ts), the operator's throwaway devnet
// key lives only in that database, and the indexer runs as a short pass after requests (at most one pass every
// TICK_EVERY_MS across all instances) instead of a background loop.
// Settings (Vercel project environment, all optional): QF_DB_GATEWAY_URL (default below), QF_PUBLIC_BASE_URL (default the
// project's production address), QF_RPC_URL (default the public devnet endpoint). No secret is needed: the gateway trusts
// this project's Vercel OIDC token.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { address, createKeyPairSignerFromBytes, createSolanaRpc, lamports } from '@solana/kit';
import * as E from '@project-qf/engine';
import { READINESS } from '@project-qf/core';
import { calmRpc, checkDeployment, kitChain, mainnetGate, proveCluster } from './chain.ts';
import { indexPass } from './indexer.ts';
import { SOL_QUOTE } from './market.ts';
import { createEngineHandler, type EngineProfile } from './server.ts';
import { PgStore, type SqlGateway } from './store-pg.ts';
import { bindDeployment } from './store.ts';

export const TICK_EVERY_MS = 20_000;
export const DEFAULT_DB_GATEWAY_URL = 'https://lrqokjyfmkjvqpregyzy.supabase.co/functions/v1/qf-db';
const AIRDROP_EVERY_MS = 600_000, OPERATOR_LOW_LAMPORTS = 500_000_000n;
const env = process.env;
const log = (m: string) => console.log(`[launchpad vercel ${new Date().toISOString()}] ${m}`);

let oidcToken = env.VERCEL_OIDC_TOKEN ?? '';
export function gateway(url: string, token: () => string): SqlGateway {
  return async (q) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-oidc-token': token() },
      body: JSON.stringify({ q }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
    const body = await r.json().catch(() => null) as { results?: Record<string, unknown>[][]; error?: unknown } | null;
    if (!r.ok || !body?.results) throw new Error(`DB_GATEWAY ${r.status} ${JSON.stringify(body?.error ?? null).slice(0, 300)}`);
    return body.results;
  };
}

const operatorBytes = () => {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  return Uint8Array.from([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')]);
};

interface App { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; tick: () => Promise<void> }
async function start(): Promise<App> {
  if (READINESS.DEVNET_INTEGRATION.status !== 'ACTIVE') throw new Error(`devnet is BLOCKED: ${READINESS.DEVNET_INTEGRATION.blockers.join('; ')}`);
  const gwUrl = env.QF_DB_GATEWAY_URL || DEFAULT_DB_GATEWAY_URL;
  const base = env.QF_PUBLIC_BASE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  if (!base) throw new Error('QF_PUBLIC_BASE_URL is not set and Vercel gave no production address');
  const rpcUrl = env.QF_RPC_URL || 'https://api.devnet.solana.com';
  const rpc = calmRpc(createSolanaRpc(rpcUrl));
  const genesis = String(await rpc.getGenesisHash().send());
  const cluster = await proveCluster(rpcUrl, 'devnet', async () => genesis, mainnetGate(undefined));
  const deployment = E.deploymentFor('devnet');
  E.useDeployment(deployment);
  const store = new PgStore(gateway(gwUrl, () => oidcToken));
  await store.bind('cluster', cluster); await store.bind('genesis', genesis); await store.bind('quote', SOL_QUOTE.mint);
  await bindDeployment(store, deployment.curve);
  const operator = await createKeyPairSignerFromBytes(await store.operatorKey(operatorBytes));
  const chain = kitChain(rpcUrl, operator, log);
  await checkDeployment(chain.decisionRead ?? chain.read, deployment);
  const profile: EngineProfile = { cluster, writes: true, faucet: true, writesLockedBecause: [], label: 'Test network: coins here have no value' };
  const handle = createEngineHandler({ store, chain, quote: SOL_QUOTE, profile, log, clientIpHeader: 'x-real-ip', staticDir: null, publicBaseUrl: base.replace(/\/$/, '') });
  log(JSON.stringify({ started: true, cluster, operator: operator.address }));
  let lastAirdrop = 0;
  const tick = async () => {
    if (!(await store.tryTick(new Date().toISOString(), TICK_EVERY_MS))) return;
    await indexPass({ store, chain, log });
    if (Date.now() - lastAirdrop > AIRDROP_EVERY_MS && (await chain.lamports(operator.address)) < OPERATOR_LOW_LAMPORTS) {
      lastAirdrop = Date.now();
      await rpc.requestAirdrop(address(operator.address), lamports(1_000_000_000n)).send()
        .then(() => log('asked the devnet faucet for 1 SOL for the operator'), (e) => log(`devnet faucet refused the operator: ${(e as Error).message.slice(0, 200)}`));
    }
  };
  return { handle, tick };
}

let app: Promise<App> | null = null;
const ready = () => (app ??= start().catch((e) => { app = null; throw e; }));

/** Vercel's hook for work after the response (Fluid compute); without it the pass runs before the function returns. */
function afterResponse(p: Promise<unknown>): Promise<unknown> | void {
  const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined>)[Symbol.for('@vercel/request-context')]?.get?.();
  if (ctx?.waitUntil) { ctx.waitUntil(p); return; }
  return p;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t = req.headers['x-vercel-oidc-token'];
  if (typeof t === 'string' && t) oidcToken = t;
  const u = new URL(req.url ?? '/', 'http://localhost');
  const original = u.searchParams.get('qfpath');
  if (original) { u.searchParams.delete('qfpath'); req.url = `${original}${u.search}`; }
  let a: App;
  try { a = await ready(); } catch (e) {
    log(`start failed: ${(e as Error).message.slice(0, 400)}`);
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      .end(JSON.stringify({ error: { code: 'STARTING', message: 'the launchpad is starting; try again in a few seconds' } }));
    return;
  }
  await a.handle(req, res);
  const pass = a.tick().catch((e) => log(`tick failed: ${(e as Error).message.slice(0, 300)}`));
  await afterResponse(pass);
}
