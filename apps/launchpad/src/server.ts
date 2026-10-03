// HTTP layer for the devnet launchpad (lp-api/1) plus same-origin hosting of the web app and of token metadata.
//
// Signing model: the server builds UNSIGNED transactions and returns them with the approved terms. The browser decodes
// the bytes independently (packages/tx), checks them against the terms and what the person typed, adds the
// client-generated mint signature (launch only) and has the wallet sign. On submit the server accepts only the exact
// message it built, verifies every signature, re-binds the message to the terms and then relays it. The server never
// signs for a user; only operator-role steps (faucet, migration crank) use the disposable devnet operator key.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { economicsDigest } from '@project-qf/policy';
import { READINESS } from '@project-qf/core';
import {
  bindTransactionToTerms, decodeTransactionBytes, fromBase64, parseWire, sameMessage, toBase64, toHex, validateIntent, verifyWireSignatures,
  type ApprovedTerms, type TxIntent,
} from '@project-qf/tx';
import type { LaunchpadChain, LivePool } from './chain.ts';
import { PoolCache, syncLaunch, tradeFromSummary } from './indexer.ts';
import type { PlatformRecord } from './platform.ts';
import type { LaunchRow, LaunchpadStore } from './store.ts';

export const LP_API_VERSION = 'lp-api/1';
export const BODY_LIMIT_BYTES = 16 * 1024;
export const LAUNCH_BODY_LIMIT_BYTES = 400 * 1024;
export const IMAGE_LIMIT_BYTES = 256 * 1024;
export const INTENT_TTL_MS = 120_000;
export const BUILDS_PER_MINUTE = 30;
export const FAUCET = Object.freeze({ quoteUi: 10_000n, lamports: 20_000_000n, minLamportsBeforeTopUp: 10_000_000n, claimsPerDay: 3 });

export interface LaunchpadOptions {
  store: LaunchpadStore;
  chain: LaunchpadChain;
  platform: () => PlatformRecord | null;
  staticDir: string | null;
  publicBaseUrl: string;
  now?: () => Date;
  log?: (m: string) => void;
}

class HttpError extends Error {
  status: number; code: string; details: string[] | undefined;
  constructor(status: number, code: string, message: string, details?: string[]) { super(message); this.status = status; this.code = code; this.details = details; }
}

const API_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
// Signing page CSP: no third-party script, no inline script, no remote connections; images only from self and data:.
const STATIC_CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, API_HEADERS).end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'body must be application/json');
  if (Number(req.headers['content-length'] ?? '0') > limit) throw new HttpError(413, 'BODY_TOO_LARGE', `body over ${limit} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > limit) throw new HttpError(413, 'BODY_TOO_LARGE', `body over ${limit} bytes`);
    chunks.push(c as Buffer);
  }
  let v: unknown;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'body is not valid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'BAD_JSON', 'body must be a JSON object');
  return v as Record<string, unknown>;
}

// ------------------------------------------------------------------ input rules (shared with the browser form)

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const utf8Len = (s: string) => new TextEncoder().encode(s).length;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;
export function onlyKeys(o: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, 'UNKNOWN_FIELDS', `unknown fields: ${extra.join(', ')}`);
}
function addr(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !B58.test(v)) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be a base58 address`);
  return v;
}
function text(o: Record<string, unknown>, k: string, max: number, opt = false): string | null {
  const v = o[k];
  if (v === undefined || v === null || v === '') { if (opt) return null; throw new HttpError(400, 'INVALID_REQUEST', `${k} is required`); }
  if (typeof v !== 'string' || CONTROL.test(v) || v.trim() !== v) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be plain text without control characters or surrounding spaces`);
  if (utf8Len(v) > max) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be at most ${max} bytes`);
  return v;
}
function url(o: Record<string, unknown>, k: string): string | null {
  const v = text(o, k, 160, true);
  if (v === null) return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new HttpError(400, 'INVALID_REQUEST', `${k} must be an https URL`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be an https URL without credentials`);
  return u.toString();
}
function rawAmount(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v !== 'string' || !/^[1-9]\d{0,19}$/.test(v) || BigInt(v) > 2n ** 64n - 1n) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be a positive raw integer string`);
  return BigInt(v);
}
export function sniffImage(b: Uint8Array): string | null {
  const s = (i: number, ...x: number[]) => x.every((v, k) => b[i + k] === v);
  if (s(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (s(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (s(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (s(0, 0x52, 0x49, 0x46, 0x46) && s(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
function image(o: Record<string, unknown>): { type: string; bytes: Uint8Array } | null {
  const v = o.imageDataUrl;
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v) : null;
  if (!m) throw new HttpError(400, 'INVALID_IMAGE', 'image must be a base64 PNG, JPEG, GIF or WebP data URL');
  const bytes = Uint8Array.from(Buffer.from(m[2]!, 'base64'));
  if (bytes.length > IMAGE_LIMIT_BYTES) throw new HttpError(413, 'IMAGE_TOO_LARGE', `image over ${IMAGE_LIMIT_BYTES} bytes`);
  const type = sniffImage(bytes);
  if (!type || type !== m[1]) throw new HttpError(400, 'INVALID_IMAGE', 'image bytes do not match the declared type');
  return { type, bytes };
}

// ------------------------------------------------------------------ views

export interface TokenView {
  mint: string; pool: string; name: string; symbol: string; description: string; imageUrl: string | null; creator: string; status: LaunchRow['status'];
  createdAt: string; liveAt: string | null; website: string | null; twitter: string | null; telegram: string | null; metadataUri: string;
  createSig: string | null; migrationSig: string | null; dammPool: string | null;
  live: null | { priceQuotePerBase: string; marketCapQuoteRaw: string; quoteReserve: string; migrationQuoteThreshold: string; progressBps: number;
    curveComplete: boolean; isMigrated: boolean; baseDecimals: number; quoteDecimals: number; totalSupplyRaw: string; creatorQuoteFee: string };
  stats: { count: number; volumeQuoteRaw: string; traders: number };
}
const liveView = (p: LivePool | null): TokenView['live'] => p && {
  priceQuotePerBase: p.priceQuotePerBase, marketCapQuoteRaw: p.marketCapQuoteRaw, quoteReserve: p.quoteReserve, migrationQuoteThreshold: p.migrationQuoteThreshold,
  progressBps: p.progressBps, curveComplete: p.curveComplete, isMigrated: p.isMigrated, baseDecimals: p.baseDecimals, quoteDecimals: p.quoteDecimals,
  totalSupplyRaw: p.totalSupplyRaw, creatorQuoteFee: p.creatorQuoteFee,
};

export function createLaunchpadApp(o: LaunchpadOptions): Server & { poolCache: PoolCache } {
  const now = o.now ?? (() => new Date());
  const pools = new PoolCache(o.chain);
  const rate = new Map<string, number[]>();
  const limit = (key: string, max: number) => {
    const t = now().getTime();
    const recent = (rate.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= max) throw new HttpError(429, 'RATE_LIMITED', `at most ${max} requests per minute`);
    rate.set(key, [...recent, t]);
  };
  const platform = () => {
    const p = o.platform();
    if (!p) throw new HttpError(503, 'PLATFORM_NOT_READY', 'the devnet platform (test quote + DBC config) has not been set up yet; run `main.ts setup` once the operator wallet holds devnet SOL');
    return p;
  };
  const imageUrl = (l: LaunchRow) => (l.imageType ? `/m/${l.mint}.img` : null);
  const tokenView = async (l: LaunchRow, fresh = false): Promise<TokenView> => ({
    mint: l.mint, pool: l.pool, name: l.name, symbol: l.symbol, description: l.description, imageUrl: imageUrl(l), creator: l.creator, status: l.status,
    createdAt: l.createdAt, liveAt: l.liveAt, website: l.website, twitter: l.twitter, telegram: l.telegram, metadataUri: l.metadataUri,
    createSig: l.createSig, migrationSig: l.migrationSig, dammPool: l.dammPool,
    live: liveView(await pools.get(l.pool, fresh).catch(() => null)), stats: o.store.tradeStats(l.mint),
  });
  const intentCheck = (i: Omit<TxIntent, 'intentId' | 'createdAt' | 'expiresAt' | 'cluster' | 'mock'>, approvedEconomicsDigest?: string) => {
    const t = now();
    const r = validateIntent({ ...i, intentId: 'pending', cluster: 'devnet', mock: false, createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + INTENT_TTL_MS).toISOString() },
      { now: t.toISOString(), ...(approvedEconomicsDigest ? { approvedEconomicsDigest } : {}) });
    if (!r.ok) throw new HttpError(409, 'INTENT_REFUSED', 'the transaction intent is refused by policy', r.violations);
  };
  const storeBuilt = async (kind: string, mint: string | null, user: string, built: { bytes: Uint8Array; terms: ApprovedTerms; blockhash: string; lastValidBlockHeight: number }) => {
    // Defence in depth: what we built must bind to the terms we are about to hand out.
    const v = await bindTransactionToTerms(decodeTransactionBytes(built.bytes), built.terms);
    if (v.length) { o.log?.(`binding failed for ${kind}: ${v.join('; ')}`); throw new HttpError(500, 'BINDING_FAILED', 'the built transaction does not bind to its terms', v); }
    const t = now();
    return o.store.insertIntent({ kind, mint, user, createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + INTENT_TTL_MS).toISOString(),
      messageHex: toHex(parseWire(built.bytes).message), termsJson: JSON.stringify({ terms: built.terms, blockhash: built.blockhash }), lastValidBlockHeight: built.lastValidBlockHeight });
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const method = req.method ?? 'GET';
    const ip = req.socket.remoteAddress ?? 'local';
    if (path === '/api/lp/healthz' && method === 'GET') return send(res, 200, { ok: true, apiVersion: LP_API_VERSION });

    if (path === '/api/lp/platform' && method === 'GET') {
      const p = o.platform();
      return send(res, 200, { apiVersion: LP_API_VERSION, cluster: 'devnet', ready: !!p, readiness: { DEVNET_INTEGRATION: READINESS.DEVNET_INTEGRATION.status, MAINNET: READINESS.MAINNET.status },
        operator: o.chain.operatorAddress, platform: p && { quote: p.quote, config: p.config.config, threshold: p.threshold, launchEconomics: p.launchEconomics,
          launchEconomicsDigest: p.launchEconomicsDigest, economicsVersion: p.economicsVersion, templateVersion: p.templateVersion },
        faucet: { quoteUi: FAUCET.quoteUi.toString(), lamports: FAUCET.lamports.toString(), claimsPerDay: FAUCET.claimsPerDay } });
    }

    if (path === '/api/lp/tokens' && method === 'GET') {
      const list = o.store.listLaunches(['LIVE', 'MIGRATED']);
      return send(res, 200, { tokens: await Promise.all(list.map((l) => tokenView(l))) });
    }
    if (path === '/api/lp/trades/recent' && method === 'GET') {
      return send(res, 200, { trades: o.store.listRecentTrades(30).map((t) => ({ sig: t.sig, mint: t.mint, symbol: t.symbol, trader: t.trader, side: t.side, quoteRaw: t.quoteRaw, blockTime: t.blockTime })) });
    }
    const tm = /^\/api\/lp\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (tm && method === 'GET') {
      const l = o.store.getLaunch(tm[1]!);
      if (!l || l.status === 'PENDING' || l.status === 'FAILED') throw new HttpError(404, 'NOT_FOUND', 'token not found');
      return send(res, 200, { token: await tokenView(l, query.get('fresh') === '1'), trades: o.store.listTrades(l.mint) });
    }
    const wm = /^\/api\/lp\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (wm && method === 'GET') {
      const p = platform();
      const mints = [p.quote.mint];
      const extra = query.get('mint');
      if (extra) { if (!B58.test(extra)) throw new HttpError(400, 'INVALID_REQUEST', 'mint must be an address'); mints.push(extra); }
      return send(res, 200, await o.chain.balances(wm[1]!, mints));
    }

    if (path === '/api/lp/launch' && method === 'POST') {
      limit(`build:${ip}`, BUILDS_PER_MINUTE);
      const p = platform();
      const b = await readJson(req, LAUNCH_BODY_LIMIT_BYTES);
      onlyKeys(b, ['creator', 'baseMint', 'name', 'symbol', 'description', 'imageDataUrl', 'website', 'twitter', 'telegram', 'economicsDigest']);
      const creator = addr(b, 'creator'), baseMint = addr(b, 'baseMint');
      if (creator === baseMint) throw new HttpError(400, 'INVALID_REQUEST', 'baseMint must be a fresh key, not the creator');
      const name = text(b, 'name', 32)!, symbol = text(b, 'symbol', 10)!;
      if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) throw new HttpError(400, 'INVALID_REQUEST', 'symbol must be 1-10 letters or digits');
      const description = text(b, 'description', 500, true) ?? '';
      const website = url(b, 'website'), twitter = url(b, 'twitter'), telegram = url(b, 'telegram');
      const img = image(b);
      if (b.economicsDigest !== p.launchEconomicsDigest || economicsDigest(p.launchEconomics) !== p.launchEconomicsDigest) {
        throw new HttpError(409, 'ECONOMICS_NOT_CONSENTED', 'the economics digest you consented to does not match the current launch economics; reload and review');
      }
      if (o.store.getLaunch(baseMint)) throw new HttpError(409, 'MINT_IN_USE', 'that mint key was already used; generate a new one');
      intentCheck({ kind: 'CREATE_POOL', signer: { role: 'USER_WALLET', address: creator, serverHeld: false }, feePayer: creator, templateUsage: 'V0_TEST_BASELINE',
        economicsDigest: p.launchEconomicsDigest, consentDigest: b.economicsDigest as string }, p.launchEconomicsDigest);
      const metadataUri = `${o.publicBaseUrl}/m/${baseMint}.json`;
      if (metadataUri.length > 200) throw new HttpError(500, 'METADATA_URI_TOO_LONG', 'QF_PUBLIC_BASE_URL is too long for on-chain metadata');
      const built = await o.chain.buildCreatePool({ config: p.config.config, quoteMint: p.quote.mint, creator, baseMint, name, symbol, uri: metadataUri });
      const intent = await storeBuilt('CREATE_POOL', baseMint, creator, built);
      o.store.insertPendingLaunch({ mint: baseMint, pool: built.pool, config: p.config.config, quoteMint: p.quote.mint, creator, name, symbol, description,
        website, twitter, telegram, imageType: img?.type ?? null, metadataUri, createdAt: now().toISOString() }, img?.bytes ?? null);
      return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, pool: built.pool, metadataUri });
    }

    if ((path === '/api/lp/swap' || path === '/api/lp/quote') && method === 'POST') {
      limit(`build:${ip}`, BUILDS_PER_MINUTE * 2);
      const b = await readJson(req, BODY_LIMIT_BYTES);
      const isBuild = path === '/api/lp/swap';
      onlyKeys(b, isBuild ? ['mint', 'user', 'side', 'amountIn', 'slippageBps'] : ['mint', 'side', 'amountIn', 'slippageBps']);
      const mint = addr(b, 'mint');
      const l = o.store.getLaunch(mint);
      if (!l || l.status !== 'LIVE') throw new HttpError(l?.status === 'MIGRATED' ? 409 : 404, l?.status === 'MIGRATED' ? 'POOL_MIGRATED' : 'NOT_FOUND',
        l?.status === 'MIGRATED' ? 'this token graduated; it now trades on its Meteora DAMM v2 pool' : 'token not found');
      if (b.side !== 'buy' && b.side !== 'sell') throw new HttpError(400, 'INVALID_REQUEST', "side must be 'buy' or 'sell'");
      const amountIn = rawAmount(b, 'amountIn');
      const slippageBps = b.slippageBps === undefined ? 100 : Number(b.slippageBps);
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new HttpError(400, 'INVALID_REQUEST', 'slippageBps must be an integer in 0..5000');
      const pool = await pools.get(l.pool, isBuild);
      if (!pool) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read the pool');
      if (pool.curveComplete || pool.isMigrated) throw new HttpError(409, 'CURVE_COMPLETE', 'the bonding curve is complete; migration to DAMM v2 is pending');
      const direction = b.side === 'buy' ? 'QUOTE_TO_BASE' as const : 'BASE_TO_QUOTE' as const;
      const nowS = Math.floor(now().getTime() / 1000);
      // The curve math refuses amounts it cannot fill (e.g. buying past the end of the curve): that is the user's input, not a server fault.
      const curveRefusal = (e: unknown) => { const m = (e as Error).message; if (/^(POOL_COMPLETE|ZERO_OUTPUT)/.test(m)) return new HttpError(409, m.split(':')[0]!, m);
        if (/insufficient liquidity|exceed|overflow/i.test(m)) return new HttpError(409, 'AMOUNT_NOT_FILLABLE', 'the curve cannot fill this amount; try a smaller one'); return e; };
      if (!isBuild) { try { return send(res, 200, { quote: o.chain.quoteSwap(pool, direction, amountIn, slippageBps, nowS) }); } catch (e) { throw curveRefusal(e); } }
      const user = addr(b, 'user');
      intentCheck({ kind: 'SWAP', signer: { role: 'USER_WALLET', address: user, serverHeld: false }, feePayer: user, amounts: { amountIn: amountIn.toString() } });
      let built;
      try { built = await o.chain.buildSwap(pool, { pool: l.pool, user, direction, amountIn, slippageBps }, nowS); }
      catch (e) { throw curveRefusal(e); }
      const intent = await storeBuilt('SWAP', mint, user, built);
      return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, quote: built.quote });
    }

    if (path === '/api/lp/submit' && method === 'POST') {
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, ['intentId', 'signedTransaction']);
      const id = typeof b.intentId === 'string' && /^intent_[0-9a-f]{32}$/.test(b.intentId) ? b.intentId : null;
      const intent = id ? o.store.getIntent(id) : null;
      if (!intent) throw new HttpError(404, 'NOT_FOUND', 'intent not found');
      if (now().getTime() > Date.parse(intent.expiresAt)) throw new HttpError(410, 'INTENT_EXPIRED', 'this transaction expired; build a new one');
      if (typeof b.signedTransaction !== 'string' || b.signedTransaction.length > 4096) throw new HttpError(400, 'INVALID_REQUEST', 'signedTransaction must be base64');
      let bytes: Uint8Array;
      try { bytes = fromBase64(b.signedTransaction); } catch { throw new HttpError(400, 'INVALID_REQUEST', 'signedTransaction must be base64'); }
      let wire;
      try { wire = parseWire(bytes); } catch (e) { throw new HttpError(400, 'BAD_TRANSACTION', (e as Error).message); }
      if (toHex(wire.message) !== intent.messageHex) throw new HttpError(409, 'MESSAGE_CHANGED', 'the signed transaction is not the one that was built and previewed (a wallet or extension changed it)');
      const sigs = await verifyWireSignatures(bytes);
      if (!sigs.ok) throw new HttpError(400, 'SIGNATURE_INVALID', 'a required signature is missing or invalid', sigs.bad);
      const { terms, blockhash } = JSON.parse(intent.termsJson) as { terms: ApprovedTerms; blockhash: string };
      const bound = await bindTransactionToTerms(decodeTransactionBytes(bytes), terms);
      if (bound.length) throw new HttpError(409, 'BINDING_FAILED', 'the transaction does not bind to its terms', bound);
      if (!o.store.claimIntent(intent.id)) throw new HttpError(409, 'ALREADY_SUBMITTED', 'this transaction was already submitted');
      let signature: string;
      try { signature = await o.chain.send(bytes, blockhash, intent.lastValidBlockHeight); }
      catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        o.store.finishIntent(intent.id, 'FAILED', sigs.firstSignature, msg);
        throw new HttpError(502, 'SEND_FAILED', msg);
      }
      o.store.finishIntent(intent.id, 'CONFIRMED', signature, null);
      const l = intent.mint ? o.store.getLaunch(intent.mint) : null;
      let trade = null;
      if (intent.kind === 'CREATE_POOL' && l) { o.store.markLaunchLive(l.mint, signature, now().toISOString()); pools.invalidate(l.pool); }
      if (intent.kind === 'SWAP' && l) {
        pools.invalidate(l.pool);
        const p = await pools.get(l.pool, true).catch(() => null);
        const sum = p && await o.chain.txSummary(signature).catch(() => null);
        trade = sum && p ? tradeFromSummary(l, p, sum, 'app') : null;
        if (trade) o.store.insertTrade(trade);
      }
      return send(res, 200, { signature, kind: intent.kind, mint: intent.mint, trade });
    }

    if (path === '/api/lp/faucet' && method === 'POST') {
      limit(`faucet:${ip}`, 6);
      const p = platform();
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, ['wallet']);
      const wallet = addr(b, 'wallet');
      const since = new Date(now().getTime() - 86_400_000).toISOString();
      if (o.store.faucetClaimsSince(wallet, since) >= FAUCET.claimsPerDay) throw new HttpError(429, 'FAUCET_LIMIT', `at most ${FAUCET.claimsPerDay} faucet claims per wallet per day`);
      const lamports = (await o.chain.lamports(wallet)) < FAUCET.minLamportsBeforeTopUp ? FAUCET.lamports : 0n;
      const quoteRaw = FAUCET.quoteUi * 10n ** BigInt(p.quote.decimals);
      const signature = await o.chain.faucet(p.quote.mint, wallet, quoteRaw, lamports);
      o.store.insertFaucetClaim(wallet, now().toISOString(), signature);
      return send(res, 200, { signature, quoteRaw: quoteRaw.toString(), lamports: lamports.toString(), label: 'TEST_ONLY devnet tokens' });
    }

    if (path === '/api/lp/refresh' && method === 'POST') {
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, ['mint']);
      const l = o.store.getLaunch(addr(b, 'mint'));
      if (!l) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      limit(`refresh:${ip}`, 20);
      return send(res, 200, await syncLaunch({ store: o.store, chain: o.chain, poolCache: pools, now }, l));
    }
    throw new HttpError(404, 'NOT_FOUND', 'no such route');
  }

  function metadata(res: ServerResponse, mint: string, kind: 'json' | 'img') {
    const l = o.store.getLaunch(mint);
    if (!l || l.status === 'FAILED') { res.writeHead(404).end(); return; }
    const headers = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' };
    if (kind === 'img') {
      const img = o.store.getImage(mint);
      if (!img) { res.writeHead(404).end(); return; }
      res.writeHead(200, { ...headers, 'content-type': img.type }).end(Buffer.from(img.bytes));
      return;
    }
    const body = { name: l.name, symbol: l.symbol, description: l.description, ...(l.imageType ? { image: `${o.publicBaseUrl}/m/${mint}.img` } : {}),
      ...(l.website ? { external_url: l.website } : {}), extensions: { website: l.website, twitter: l.twitter, telegram: l.telegram },
      attributes: [{ trait_type: 'network', value: 'devnet (TEST_ONLY)' }] };
    res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    if (!o.staticDir) { res.writeHead(404).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    const root = realpathSync(o.staticDir);
    let rel: string;
    try { rel = path === '/' ? 'launchpad.html' : decodeURIComponent(path.slice(1)); } catch { res.writeHead(404).end(); return; }
    const file = join(root, rel);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile() || realpathSync(file) !== file) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': STATIC_CSP,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  }

  const server = createServer(async (req, res) => {
    let u: URL;
    try { u = new URL(req.url ?? '/', 'http://localhost'); } catch { u = new URL('http://localhost/'); }
    const path = u.pathname;
    try {
      const mm = /^\/m\/([1-9A-HJ-NP-Za-km-z]{32,44})\.(json|img)$/.exec(path);
      if (mm && (req.method === 'GET' || req.method === 'HEAD')) return metadata(res, mm[1]!, mm[2] as 'json' | 'img');
      if (path.startsWith('/api/lp/')) await api(req, res, path, u.searchParams);
      else serveStatic(req, res, path);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const err = e instanceof HttpError ? e : new HttpError(500, 'INTERNAL', 'internal error');
      if (!(e instanceof HttpError)) o.log?.(`internal error: ${(e as Error)?.stack?.slice(0, 800)}`);
      send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
  }) as Server & { poolCache: PoolCache };
  server.poolCache = pools;
  return server;
}
