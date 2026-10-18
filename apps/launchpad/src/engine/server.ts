// HTTP layer for the launchpad on Project QF's own engine (lp-api/1, ADR-014), plus same-origin hosting of the web app
// and of coin metadata. Same routes and signing model as the Meteora server (../server.ts):
//
//   The server builds UNSIGNED transactions with qfInstructions(terms), the one definition of each transaction the
//   browser's check also uses. The browser decodes the bytes itself, binds them to the terms and to what the person
//   typed, adds the fresh mint's signature (launch only) and has the wallet sign. On submit the server accepts only the
//   exact message it built, verifies every signature, binds the message to its terms again and relays it.
//
// The server never signs for a user. The operator key signs only what the server itself builds: graduating a sold-out
// coin (the indexer's crank) and the devnet SOL faucet. Every amount shown comes from the chain or the engine's events.
// Not on this engine yet: the platform treasury and holder rewards (their routes answer 404).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as E from '@project-qf/engine';
import { economicsDigest } from '@project-qf/policy';
import {
  bindTransactionToTerms, decodeTransactionBytes, fromBase64, parseWire, qfInstructions, toBase64, toHex, validateIntent, verifyWireSignatures, TX_BINDING_POLICY_VERSION,
  type ApprovedTerms, type TxIntent,
} from '@project-qf/tx';
import { addr, B58, BODY_LIMIT_BYTES, clientIp, HttpError, image, LAUNCH_BODY_LIMIT_BYTES, onlyKeys, rateLimiter, rawAmount, readJson, send, serial, serveStatic, text, url } from '../http.ts';
import type { EngineChain } from './chain.ts';
import { classifyTx, listNew, readDue } from './indexer.ts';
import { liveView, quoteCurve, quotePool, readCoinSnapshots, readPlatform, poolSides, type CoinSnapshot, type EnginePlatform, type LiveView, type QuoteAsset } from './market.ts';
import type { CoinRow, EngineStore, TradeRow } from './store.ts';

export const LP_API_VERSION = 'lp-api/1';
export const INTENT_TTL_MS = 120_000;
export const BUILDS_PER_MINUTE = 30;
/** SOL for test wallets: given only to a wallet below `belowLamports`, never taking the operator under `operatorFloor`
 *  (it pays for graduations). */
export const ENGINE_FAUCET = Object.freeze({ lamports: 500_000_000n, belowLamports: 250_000_000n, claimsPerDay: 2, operatorFloorLamports: 500_000_000n });
/** The compute caps every engine transaction's terms carry, and the limit each kind asks for (measured on the real
 *  programs: create 91k, a curve trade with wrapping 66k, a pool trade 29k, a claim 46k, a pool fee collect 64k). */
export const ENGINE_COMPUTE = Object.freeze({ maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '0' });
const UNITS: Record<QfTerms['kind'], number> = { QF_CREATE: 200_000, QF_SWAP: 200_000, QF_POOL_SWAP: 150_000, QF_CLAIM_CREATOR_FEES: 150_000, QF_COLLECT_POOL_CREATOR_FEE: 150_000 };
const SNAPSHOT_TTL_MS = 5_000, PLATFORM_TTL_MS = 30_000;
type QfTerms = Extract<ApprovedTerms, { kind: `QF_${string}` }>;

export interface EngineProfile {
  cluster: 'devnet' | 'localnet';
  writes: boolean; faucet: boolean;
  /** shown next to every amount */
  label: string;
  writesLockedBecause: string[];
}
export interface EngineAppOptions {
  store: EngineStore;
  chain: EngineChain;
  quote: QuoteAsset;
  profile: EngineProfile;
  staticDir: string | null;
  publicBaseUrl: string;
  now?: () => Date;
  log?: (m: string) => void;
  clientIpHeader?: string;
}
const WRITE_ROUTES = new Set(['POST /api/lp/launch', 'POST /api/lp/swap', 'POST /api/lp/submit', 'POST /api/lp/claim', 'POST /api/lp/faucet']);

/** A coin as the API shows it. `pool` is the coin's curve account (lp-api/1 name); `graduatedPool` the pool it trades in after graduation. */
export interface EngineTokenView {
  mint: string; pool: string; graduatedPool: string | null; name: string; symbol: string; description: string; imageUrl: string | null; creator: string;
  status: 'LIVE' | 'GRADUATED'; createdAt: string; liveAt: string | null; website: string | null; twitter: string | null; telegram: string | null; metadataUri: string;
  createSig: string | null; migrationSig: string | null;
  live: LiveView | null;
  stats: { count: number; volumeQuoteRaw: string; traders: number };
  history: { complete: boolean; pending: number; unavailable: number };
}
/** A trade with the fees its own event recorded: on the curve in the quote; in the pool the trade fee is in the input token. */
export const engineTradeView = (t: TradeRow) => ({
  sig: t.sig, mint: t.mint, trader: t.trader, side: t.side, quoteRaw: t.quoteRaw, baseRaw: t.baseRaw, slot: t.slot, blockTime: t.blockTime, venue: t.venue,
  fees: { mint: t.feeMint, tradeRaw: t.tradeFeeRaw, platformRaw: t.platformFeeRaw, creatorRaw: t.creatorFeeRaw },
});

const curveRefusal = (e: unknown) => {
  if (!(e instanceof E.CurveMathError)) return e;
  if (e.code === 'NotTrading') return new HttpError(409, 'CURVE_COMPLETE', 'the bonding curve is complete; the coin is graduating to its pool');
  if (e.code === 'ZeroAmount') return new HttpError(409, 'ZERO_OUTPUT', 'this amount is too small to trade');
  return new HttpError(409, 'AMOUNT_NOT_FILLABLE', 'the curve cannot fill this amount; try a smaller one');
};
const poolRefusal = (e: unknown) => {
  if (!(e instanceof E.PoolMathError)) return e;
  if (e.code === 'NotApproved') return new HttpError(409, 'POOL_NOT_OPEN', 'the pool opens a moment after graduation; try again in a few seconds');
  if (e.code === 'ZeroAmount' || e.code === 'ZeroTradingTokens') return new HttpError(409, 'ZERO_OUTPUT', 'this amount is too small to trade');
  return new HttpError(409, 'AMOUNT_NOT_FILLABLE', 'the pool cannot fill this amount; try a smaller one');
};

/** Reads that skip the cache (?fresh=1), per visitor per minute. */
export const FRESH_READS_PER_MINUTE = 30;
/** All faucet claims together, per minute, whoever asks: the operator's SOL also pays for graduations. */
export const FAUCET_GLOBAL_PER_MINUTE = 10;

export function createEngineApp(o: EngineAppOptions): Server {
  const now = o.now ?? (() => new Date());
  const { profile, quote } = o;
  const limit = rateLimiter(now);
  const faucetQueue = serial();

  // ---------------------------------------------------------------- chain reads, briefly cached
  let platformCache: { at: number; p: EnginePlatform | null } | null = null;
  const platformOf = async (fresh = false) => {
    if (!platformCache || fresh || now().getTime() - platformCache.at > PLATFORM_TTL_MS) platformCache = { at: now().getTime(), p: await readPlatform(o.chain, quote) };
    return platformCache.p;
  };
  const platform = async (fresh = false) => {
    const p = await platformOf(fresh);
    if (!p) throw new HttpError(503, 'PLATFORM_NOT_READY', 'the engine is not set up on this network yet (its settings account does not exist)');
    return p;
  };
  const snaps = new Map<string, { at: number; s: CoinSnapshot | null }>();
  /** Snapshots for many coins: cached ones younger than SNAPSHOT_TTL_MS, the rest in one batched read. */
  async function snapshots(coins: CoinRow[], fresh = false): Promise<(CoinSnapshot | null)[]> {
    const t = now().getTime();
    const stale = coins.filter((c) => fresh || !snaps.has(c.mint) || t - snaps.get(c.mint)!.at > SNAPSHOT_TTL_MS);
    if (stale.length) (await readCoinSnapshots(o.chain.read, stale)).forEach((s, k) => snaps.set(stale[k]!.mint, { at: t, s }));
    return coins.map((c) => snaps.get(c.mint)!.s);
  }
  const snapshot = async (c: CoinRow, fresh = false) => (await snapshots([c], fresh))[0]!;
  /** A coin's status follows the chain: once its launch account says Graduated, the record does too. */
  const follow = (c: CoinRow, s: CoinSnapshot | null): CoinRow => {
    if (s?.coin.launch.status !== 'Graduated' || c.status === 'GRADUATED') return c;
    o.store.markGraduated(c.mint, s.coin.launch.pool, null, now().toISOString());
    return o.store.getCoin(c.mint) ?? c;
  };

  const imageUrl = (c: CoinRow) => (c.imageType ? `/m/${c.mint}.img` : null);
  async function tokenViews(coins: CoinRow[], fresh = false): Promise<EngineTokenView[]> {
    const [p, ss] = await Promise.all([platformOf(), snapshots(coins, fresh)]);
    return Promise.all(coins.map(async (c0, k) => {
      const s = ss[k]!, c = follow(c0, s);
      const unread = o.store.unread(c.mint);
      return { mint: c.mint, pool: await E.launchAddress(c.mint), graduatedPool: c.pool, name: c.name, symbol: c.symbol, description: c.description, imageUrl: imageUrl(c),
        creator: c.creator, status: c.status as 'LIVE' | 'GRADUATED', createdAt: c.createdAt, liveAt: c.liveAt, website: c.website, twitter: c.twitter, telegram: c.telegram,
        metadataUri: c.metadataUri, createSig: c.createSig, migrationSig: c.graduateSig, live: p ? liveView(p, s, c.status === 'GRADUATED') : null, stats: o.store.tradeStats(c.mint),
        history: { complete: unread.pending === 0 && unread.unavailable === 0, ...unread } };
    }));
  }
  const coinOr404 = (mint: string) => {
    const c = o.store.getCoin(mint);
    if (!c || (c.status !== 'LIVE' && c.status !== 'GRADUATED')) throw new HttpError(404, 'NOT_FOUND', 'token not found');
    return c;
  };
  /** What a wallet can claim on one coin: as its creator, the curve fees, and after graduation the pool's creator fee. */
  async function claimable(c: CoinRow, wallet: string, fresh: boolean) {
    const isCreator = c.creator === wallet;
    const s = isCreator ? await snapshot(c, fresh) : null;
    return { isCreator, curve: s ? { quoteRaw: s.coin.launch.creatorFees.toString(), baseRaw: '0' } : null, positions: [] as never[],
      poolCreatorFee: s?.pool ? { quoteRaw: poolSides(s.pool, c.quoteMint).creatorFeesQuote.toString() } : null };
  }

  // ---------------------------------------------------------------- building
  const intentCheck = (kind: TxIntent['kind'], user: string, extra: Partial<TxIntent> = {}, approvedEconomicsDigest?: string) => {
    const t = now();
    const r = validateIntent({ intentId: 'pending', kind, cluster: profile.cluster, mock: false, signer: { role: 'USER_WALLET', address: user, serverHeld: false }, feePayer: user,
      createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + INTENT_TTL_MS).toISOString(), ...extra }, { now: t.toISOString(), ...(approvedEconomicsDigest ? { approvedEconomicsDigest } : {}) });
    if (!r.ok) throw new HttpError(409, 'INTENT_REFUSED', 'the transaction intent is refused by policy', r.violations);
  };
  const termsOf = <K extends QfTerms['kind']>(kind: K, feePayer: string, fields: Omit<Extract<QfTerms, { kind: K }>, 'kind' | 'cluster' | 'policyVersion' | 'feePayer' | 'compute'>) =>
    ({ kind, cluster: profile.cluster, policyVersion: TX_BINDING_POLICY_VERSION, feePayer, compute: { ...ENGINE_COMPUTE }, ...fields }) as unknown as Extract<QfTerms, { kind: K }>;
  /** Compiles the terms' own instructions, proves the bytes bind to the terms, and records the exact message. */
  async function build(terms: QfTerms, mint: string, user: string) {
    const bh = await o.chain.blockhash();
    const tx = E.compileUnsigned({ feePayer: terms.feePayer, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, instructions: await qfInstructions(terms), computeUnits: UNITS[terms.kind] });
    const v = await bindTransactionToTerms(decodeTransactionBytes(tx.bytes), terms);
    if (v.length) { o.log?.(`binding failed for ${terms.kind}: ${v.join('; ')}`); throw new HttpError(500, 'BINDING_FAILED', 'the built transaction does not bind to its terms', v); }
    const t = now();
    const intent = o.store.insertIntent({ kind: terms.kind, mint, user, createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + INTENT_TTL_MS).toISOString(),
      messageHex: toHex(parseWire(tx.bytes).message), termsJson: JSON.stringify(terms), lastValidBlockHeight: bh.lastValidBlockHeight.toString() });
    return { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(tx.bytes), terms };
  }

  /** After a confirmed trade or claim: read its events now, so the page shows it without waiting for the indexer (which
   *  reads it again later; rows are keyed by signature and event, so nothing is counted twice). */
  async function readBack(c: CoinRow, signature: string) {
    const r = await o.chain.tx(signature).catch(() => null);
    if (!r) return null;
    const pool = await E.launchPoolAddress(c.mint), v = await E.poolAccounts(pool, c.mint, c.quoteMint);
    const k = classifyTx(r, c, pool, v.token0 === c.quoteMint ? v.vault0 : v.vault1);
    o.store.recordTx(signature, c.mint, k.outcome, k.trades, k.payouts);
    return k;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const method = req.method ?? 'GET';
    const ip = clientIp(req, o.clientIpHeader);
    const fresh = query.get('fresh') === '1';
    if (path === '/api/lp/healthz' && method === 'GET') return send(res, 200, { ok: true, apiVersion: LP_API_VERSION, engine: 'qf', cluster: profile.cluster });
    // ?fresh=1 skips the read caches and goes straight to the chain: its own budget, so it cannot burn the RPC quota
    if (query.get('fresh') === '1') limit(`fresh:${ip}`, FRESH_READS_PER_MINUTE);
    if (WRITE_ROUTES.has(`${method} ${path}`)) {
      if (path === '/api/lp/faucet' && !profile.faucet) throw new HttpError(404, 'NO_FAUCET', 'the faucet is off');
      if (!profile.writes) throw new HttpError(423, 'WRITES_LOCKED', 'launching, trading and claiming are switched off on this server', profile.writesLockedBecause);
    }

    if (path === '/api/lp/platform' && method === 'GET') {
      const p = await platformOf(fresh).catch(() => null);
      return send(res, 200, { apiVersion: LP_API_VERSION, engine: 'qf', cluster: profile.cluster, mode: profile.cluster === 'devnet' ? 'DEVNET' : 'LOCALNET', writesEnabled: profile.writes,
        writesLockedBecause: profile.writesLockedBecause, label: profile.label, ready: !!p && !p.settings.createPaused, operator: o.chain.operatorAddress,
        platform: p && { quote, programs: p.economics.programs, global: p.global, ammConfig: p.settings.ammConfig, feeRecipient: p.settings.feeRecipient, createPaused: p.settings.createPaused,
          threshold: { rawQuoteThreshold: p.graduationQuoteRaw.toString() }, launchEconomics: p.economics, launchEconomicsDigest: p.economicsDigest },
        faucet: profile.faucet ? { quoteUi: '0', lamports: ENGINE_FAUCET.lamports.toString(), claimsPerDay: ENGINE_FAUCET.claimsPerDay } : null });
    }
    if (path === '/api/lp/tokens' && method === 'GET') return send(res, 200, { tokens: await tokenViews(o.store.listCoins(['LIVE', 'GRADUATED'])) });
    if (path === '/api/lp/trades/recent' && method === 'GET') {
      return send(res, 200, { trades: o.store.recentTrades(30).map((t) => ({ sig: t.sig, mint: t.mint, symbol: t.symbol, trader: t.trader, side: t.side, quoteRaw: t.quoteRaw, blockTime: t.blockTime })) });
    }
    if (/^\/api\/lp\/(rewards|treasury)(\/|$)/.test(path)) throw new HttpError(404, 'NOT_ON_THIS_ENGINE', 'holder rewards and the platform treasury are not on the QF engine yet');
    const tm = /^\/api\/lp\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (tm && method === 'GET') {
      const c = coinOr404(tm[1]!);
      return send(res, 200, { token: (await tokenViews([c], fresh))[0], trades: o.store.listTrades(c.mint).map(engineTradeView) });
    }
    if (path === '/api/lp/me' && method === 'GET') {
      const wallet = query.get('wallet');
      if (!wallet || !B58.test(wallet)) throw new HttpError(400, 'INVALID_REQUEST', 'wallet must be an address');
      limit(`me:${ip}`, 30);
      const mine = o.store.listCoins(['LIVE', 'GRADUATED']).filter((c) => c.creator === wallet);
      const views = await tokenViews(mine, fresh);
      const coins = [];
      for (const [k, c] of mine.entries()) { const f = await claimable(c, wallet, false); coins.push({ token: views[k], curve: f.curve, positions: f.positions, poolCreatorFee: f.poolCreatorFee }); }
      return send(res, 200, { wallet, coins, rewardsPaid: [] });
    }
    const wm = /^\/api\/lp\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (wm && method === 'GET') {
      const mints = [quote.mint];
      const extra = query.get('mint');
      if (extra) { if (!B58.test(extra)) throw new HttpError(400, 'INVALID_REQUEST', 'mint must be an address'); mints.push(extra); }
      const b = await o.chain.balances(wm[1]!, mints);
      // with a wrapped-SOL quote a trade spends and returns plain SOL, so the quote balance is the wallet's SOL (plus any
      // wrapped SOL it still holds, which the next trade unwraps)
      if (quote.mint === E.NATIVE_MINT) b.tokens[quote.mint] = (BigInt(b.lamports) + BigInt(b.tokens[quote.mint] ?? '0')).toString();
      return send(res, 200, b);
    }

    if (path === '/api/lp/launch' && method === 'POST') {
      limit(`build:${ip}`, BUILDS_PER_MINUTE);
      const p = await platform(true);
      if (p.settings.createPaused) throw new HttpError(423, 'LAUNCHES_PAUSED', 'launching new coins is paused on this engine');
      const b = await readJson(req, LAUNCH_BODY_LIMIT_BYTES);
      onlyKeys(b, ['creator', 'baseMint', 'name', 'symbol', 'description', 'imageDataUrl', 'website', 'twitter', 'telegram', 'economicsDigest']);
      const creator = addr(b, 'creator'), baseMint = addr(b, 'baseMint');
      if (creator === baseMint) throw new HttpError(400, 'INVALID_REQUEST', 'baseMint must be a fresh key, not the creator');
      const name = text(b, 'name', 32)!, symbol = text(b, 'symbol', 10)!;
      if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) throw new HttpError(400, 'INVALID_REQUEST', 'symbol must be 1-10 letters or digits');
      const description = text(b, 'description', 500, true) ?? '';
      const website = url(b, 'website'), twitter = url(b, 'twitter'), telegram = url(b, 'telegram');
      const img = image(b);
      if (b.economicsDigest !== p.economicsDigest || economicsDigest(p.economics) !== p.economicsDigest) {
        throw new HttpError(409, 'ECONOMICS_NOT_CONSENTED', 'the economics digest you consented to does not match the engine\'s current settings; reload and review');
      }
      if (o.store.getCoin(baseMint)) throw new HttpError(409, 'MINT_IN_USE', 'that mint key was already used; generate a new one');
      intentCheck('QF_CREATE', creator, { templateUsage: 'V0_TEST_BASELINE', economicsDigest: p.economicsDigest, consentDigest: b.economicsDigest as string }, p.economicsDigest);
      const metadataUri = `${o.publicBaseUrl}/m/${baseMint}.json`;
      if (new TextEncoder().encode(metadataUri).length > 200) throw new HttpError(500, 'METADATA_URI_TOO_LONG', 'QF_PUBLIC_BASE_URL is too long for on-chain metadata');
      const built = await build(termsOf('QF_CREATE', creator, { baseMint, quoteMint: quote.mint, creator, ammConfig: p.settings.ammConfig, name, symbol, uri: metadataUri }), baseMint, creator);
      o.store.insertPendingCoin({ mint: baseMint, quoteMint: quote.mint, creator, name, symbol, description, website, twitter, telegram, imageType: img?.type ?? null, metadataUri,
        createdAt: now().toISOString() }, img?.bytes ?? null);
      return send(res, 201, { ...built, pool: await E.launchAddress(baseMint), metadataUri });
    }

    if ((path === '/api/lp/swap' || path === '/api/lp/quote') && method === 'POST') {
      limit(`build:${ip}`, BUILDS_PER_MINUTE * 2);
      const b = await readJson(req, BODY_LIMIT_BYTES);
      const isBuild = path === '/api/lp/swap';
      onlyKeys(b, isBuild ? ['mint', 'user', 'side', 'amountIn', 'slippageBps'] : ['mint', 'side', 'amountIn', 'slippageBps']);
      const c0 = coinOr404(addr(b, 'mint'));
      if (b.side !== 'buy' && b.side !== 'sell') throw new HttpError(400, 'INVALID_REQUEST', "side must be 'buy' or 'sell'");
      const side = b.side as 'buy' | 'sell', amountIn = rawAmount(b, 'amountIn');
      const slippageBps = b.slippageBps === undefined ? 100 : Number(b.slippageBps);
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new HttpError(400, 'INVALID_REQUEST', 'slippageBps must be an integer in 0..5000');
      const s = await snapshot(c0, isBuild);
      if (!s) throw new HttpError(502, 'COIN_UNAVAILABLE', 'could not read this coin from the chain');
      const c = follow(c0, s);
      const direction = side === 'buy' ? 'QUOTE_TO_BASE' as const : 'BASE_TO_QUOTE' as const;
      let q;
      if (c.status === 'GRADUATED') {
        if (!s.pool) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read this coin\'s pool');
        try { q = quotePool(s.pool, c.mint, c.quoteMint, side, amountIn, slippageBps, await o.chain.now()); } catch (e) { throw poolRefusal(e); }
      } else {
        if (s.coin.launch.status !== 'Trading') throw new HttpError(409, 'CURVE_COMPLETE', 'the bonding curve is complete; the coin is graduating to its pool');
        try { q = quoteCurve(s.coin.launch, side, amountIn, slippageBps); } catch (e) { throw curveRefusal(e); }
      }
      if (!isBuild) return send(res, 200, { quote: q, venue: q.venue });
      const user = addr(b, 'user');
      intentCheck(q.venue === 'POOL' ? 'QF_POOL_SWAP' : 'QF_SWAP', user, { amounts: { amountIn: amountIn.toString() } });
      const common = { baseMint: c.mint, quoteMint: c.quoteMint, user, direction, amountIn: amountIn.toString(), minimumAmountOut: q.minimumAmountOut };
      const terms = q.venue === 'POOL' ? termsOf('QF_POOL_SWAP', user, { ...common, ammConfig: s.pool!.pool.ammConfig }) : termsOf('QF_SWAP', user, common);
      return send(res, 201, { ...(await build(terms, c.mint, user)), quote: q, venue: q.venue });
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
      const terms = JSON.parse(intent.termsJson) as QfTerms;
      const bound = await bindTransactionToTerms(decodeTransactionBytes(bytes), terms);
      if (bound.length) throw new HttpError(409, 'BINDING_FAILED', 'the transaction does not bind to its terms', bound);
      if (!o.store.claimIntent(intent.id)) throw new HttpError(409, 'ALREADY_SUBMITTED', 'this transaction was already submitted');
      let signature: string;
      try { signature = await o.chain.send(bytes, BigInt(intent.lastValidBlockHeight)); }
      catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        o.store.finishIntent(intent.id, 'FAILED', sigs.firstSignature, msg);
        throw new HttpError(502, 'SEND_FAILED', msg);
      }
      o.store.finishIntent(intent.id, 'CONFIRMED', signature, null);
      const c = intent.mint ? o.store.getCoin(intent.mint) : null;
      if (c) snaps.delete(c.mint);
      let trade = null;
      if (c && terms.kind === 'QF_CREATE') o.store.markLive(c.mint, signature, now().toISOString());
      else if (c) {
        const k = await readBack(c, signature);
        trade = k?.trades[0] ? engineTradeView(k.trades[0]) : null;
      }
      return send(res, 200, { signature, kind: intent.kind, mint: intent.mint, trade });
    }

    // ---------------------------------------------------------------- creator fees
    // A creator earns the creator share of every curve trade (held in the curve's quote vault until claimed), and after
    // graduation the pool's creator fee on every swap (held in the pool until collected). Both pay only the creator's
    // own wallet; the wallet signs; the server only builds.
    const fm = /^\/api\/lp\/fees\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (fm && method === 'GET') {
      const c = coinOr404(fm[1]!);
      const wallet = query.get('wallet');
      if (!wallet || !B58.test(wallet)) throw new HttpError(400, 'INVALID_REQUEST', 'wallet must be an address');
      limit(`fees:${ip}`, 60);
      return send(res, 200, { mint: c.mint, wallet, ...(await claimable(c, wallet, fresh)) });
    }
    if (path === '/api/lp/claim' && method === 'POST') {
      limit(`build:${ip}`, BUILDS_PER_MINUTE);
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, ['mint', 'user', 'venue']);
      const c0 = coinOr404(addr(b, 'mint')), user = addr(b, 'user');
      if (c0.creator !== user) throw new HttpError(403, 'NOT_CREATOR', 'only the wallet that launched this coin can claim its creator fees');
      if (b.venue !== 'curve' && b.venue !== 'pool') throw new HttpError(400, 'INVALID_REQUEST', "venue must be 'curve' or 'pool'");
      const s = await snapshot(c0, true);
      if (!s) throw new HttpError(502, 'COIN_UNAVAILABLE', 'could not read this coin from the chain');
      const c = follow(c0, s);
      const coin = { baseMint: c.mint, quoteMint: c.quoteMint, creator: user };
      if (b.venue === 'curve') {
        const amount = s.coin.launch.creatorFees;
        if (amount === 0n) throw new HttpError(409, 'NOTHING_TO_CLAIM', 'there are no fees to claim yet');
        intentCheck('QF_CLAIM_CREATOR_FEES', user);
        return send(res, 201, { ...(await build(termsOf('QF_CLAIM_CREATOR_FEES', user, coin), c.mint, user)), venue: 'CURVE', amounts: { quoteRaw: amount.toString(), baseRaw: '0' } });
      }
      if (c.status !== 'GRADUATED') throw new HttpError(409, 'NOT_GRADUATED', 'this coin has not graduated to its pool yet');
      if (!s.pool) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read this coin\'s pool');
      const amount = poolSides(s.pool, c.quoteMint).creatorFeesQuote;
      if (amount === 0n) throw new HttpError(409, 'NOTHING_TO_CLAIM', 'there are no fees to claim yet');
      intentCheck('QF_COLLECT_POOL_CREATOR_FEE', user);
      return send(res, 201, { ...(await build(termsOf('QF_COLLECT_POOL_CREATOR_FEE', user, { ...coin, ammConfig: s.pool.pool.ammConfig }), c.mint, user)), venue: 'POOL',
        amounts: { quoteRaw: amount.toString(), baseRaw: '0' } });
    }

    if (path === '/api/lp/faucet' && method === 'POST') {
      limit(`faucet:${ip}`, 6);
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, ['wallet']);
      const wallet = addr(b, 'wallet');
      if (!o.chain.operatorAddress) throw new HttpError(503, 'FAUCET_EMPTY', 'the faucet has no operator key on this server');
      limit('faucet:all', FAUCET_GLOBAL_PER_MINUTE);
      // one claim at a time: the checks below and the send cannot interleave with another claim's
      const signature = await faucetQueue(async () => {
        const since = new Date(now().getTime() - 86_400_000).toISOString();
        if (o.store.faucetClaimsSince(wallet, since) >= ENGINE_FAUCET.claimsPerDay) throw new HttpError(429, 'FAUCET_LIMIT', `at most ${ENGINE_FAUCET.claimsPerDay} faucet claims per wallet per day`);
        if ((await o.chain.lamports(wallet)) >= ENGINE_FAUCET.belowLamports) throw new HttpError(409, 'FAUCET_NOT_NEEDED', 'this wallet already has enough test SOL');
        if ((await o.chain.lamports(o.chain.operatorAddress!)) < ENGINE_FAUCET.lamports + ENGINE_FAUCET.operatorFloorLamports) {
          throw new HttpError(503, 'FAUCET_EMPTY', 'the faucet is out of test SOL for now; try again later');
        }
        const sig = await o.chain.sendAsOperator([E.transferSolIx(o.chain.operatorAddress!, wallet, ENGINE_FAUCET.lamports)], 10_000);
        o.store.insertFaucetClaim(wallet, now().toISOString(), sig);
        return sig;
      });
      return send(res, 200, { signature, quoteRaw: '0', lamports: ENGINE_FAUCET.lamports.toString(), label: 'TEST_ONLY devnet SOL' });
    }

    if (path === '/api/lp/refresh' && method === 'POST') {
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, ['mint']);
      const c = o.store.getCoin(addr(b, 'mint'));
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      limit(`refresh:${ip}`, 20);
      const d = { store: o.store, chain: o.chain, now, ...(o.log ? { log: o.log } : {}) };
      const listed = c.status === 'LIVE' || c.status === 'GRADUATED' ? await listNew(d, c) : 0;
      const read = await readDue(d);
      snaps.delete(c.mint);
      return send(res, 200, { listed, read, unread: o.store.unread(c.mint) });
    }
    throw new HttpError(404, 'NOT_FOUND', 'no such route');
  }

  function metadata(res: ServerResponse, mint: string, kind: 'json' | 'img') {
    const c = o.store.getCoin(mint);
    if (!c || c.status === 'FAILED') { res.writeHead(404).end(); return; }
    const headers = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' };
    if (kind === 'img') {
      const img = o.store.getImage(mint);
      if (!img) { res.writeHead(404).end(); return; }
      res.writeHead(200, { ...headers, 'content-type': img.type }).end(Buffer.from(img.bytes));
      return;
    }
    const body = { name: c.name, symbol: c.symbol, description: c.description, ...(c.imageType ? { image: `${o.publicBaseUrl}/m/${mint}.img` } : {}),
      ...(c.website ? { external_url: c.website } : {}), extensions: { website: c.website, twitter: c.twitter, telegram: c.telegram },
      attributes: [{ trait_type: 'network', value: `${profile.cluster} (TEST_ONLY)` }] };
    res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  }

  return createServer(async (req, res) => {
    let u: URL;
    try { u = new URL(req.url ?? '/', 'http://localhost'); } catch { u = new URL('http://localhost/'); }
    const path = u.pathname;
    try {
      const mm = /^\/m\/([1-9A-HJ-NP-Za-km-z]{32,44})\.(json|img)$/.exec(path);
      if (mm && (req.method === 'GET' || req.method === 'HEAD')) return metadata(res, mm[1]!, mm[2] as 'json' | 'img');
      if (path.startsWith('/api/lp/')) await api(req, res, path, u.searchParams);
      else serveStatic(o.staticDir, req, res, path);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const rpcBusy = !(e instanceof HttpError) && /\b429\b|Too Many Requests|rate limit/i.test((e as Error)?.message ?? '');
      const err = e instanceof HttpError ? e : rpcBusy ? new HttpError(503, 'RPC_BUSY', 'the RPC is busy; try again in a few seconds') : new HttpError(500, 'INTERNAL', 'internal error');
      if (!(e instanceof HttpError)) o.log?.(rpcBusy ? `rpc busy on ${path}` : `internal error: ${(e as Error)?.stack?.slice(0, 800)}`);
      send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
  });
}
