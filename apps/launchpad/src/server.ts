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
  bindStoredVaultTransaction, bindTransactionToTerms, decodeTransactionBytes, fromBase64, parseWire, sameMessage, toBase64, toHex, validateIntent, verifyWireSignatures,
  type ApprovedTerms, type BindingContext, type TreasuryInnerTerms, type TxIntent,
} from '@project-qf/tx';
import type { LaunchpadChain, LiveDammPool, LivePool } from './chain.ts';
import { PoolCache, syncLaunch, tradeFromSummary, DammCache } from './indexer.ts';
import { feeClaimerFor, isTreasuryConfig, type PlatformRecord } from './platform.ts';
import type { ChainChecks, ClusterProfile } from './cluster.ts';
import { claimIdentity, claimReceipt, resolveClaims } from './receipts.ts';
import { explainLpResidual, type LpResidualProof } from './lp-residual.ts';
import { sumFees, type ClaimRow, type FeeTotals, type LaunchRow, type LaunchpadStore, type StoredTrade } from './store.ts';

export const LP_API_VERSION = 'lp-api/1';
export const BODY_LIMIT_BYTES = 16 * 1024;
export const LAUNCH_BODY_LIMIT_BYTES = 400 * 1024;
export const IMAGE_LIMIT_BYTES = 256 * 1024;
export const INTENT_TTL_MS = 120_000;
export const BUILDS_PER_MINUTE = 30;
export const FAUCET = Object.freeze({ quoteUi: 10_000n, lamports: 100_000_000n, minLamportsBeforeTopUp: 50_000_000n, claimsPerDay: 3 });

export interface LaunchpadOptions {
  store: LaunchpadStore;
  chain: LaunchpadChain;
  platform: () => PlatformRecord | null;
  staticDir: string | null;
  publicBaseUrl: string;
  now?: () => Date;
  log?: (m: string) => void;
  /** network and what the server may do there; devnet when omitted */
  profile?: ServerProfile;
  /** latest startup checks of the chain this server reads (mainnet: quote mint and programs, two providers) */
  chainChecks?: () => ChainChecks | null;
  /** Behind a hosting proxy every request comes from the proxy, so per-client rate limits need the header the proxy sets
   *  (Fly.io: fly-client-ip; X-Forwarded-For: the rightmost entry, the one the proxy added). Unset: the socket address. */
  clientIpHeader?: string;
}
/** The client address used for rate limits. Only the named header is trusted, and only because the host's proxy sets it. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, header?: string): string {
  if (header) {
    const raw = req.headers[header.toLowerCase()];
    const v = (Array.isArray(raw) ? raw[raw.length - 1] : raw)?.split(',').map((x) => x.trim()).filter(Boolean).at(-1);
    if (v && v.length <= 64) return v;
  }
  return req.socket.remoteAddress ?? 'local';
}
/** The part of the cluster profile the HTTP layer needs (see cluster.ts). */
export type ServerProfile = Pick<ClusterProfile, 'cluster' | 'mode' | 'writes' | 'faucet' | 'label' | 'writesLockedBecause' | 'quote'>;
export const DEVNET_PROFILE: ServerProfile = Object.freeze({ cluster: 'devnet', mode: 'DEVNET', writes: true, faucet: true, label: 'TEST_ONLY devnet tokens with no value',
  writesLockedBecause: [], quote: null });
/** Requests that build a transaction for someone to sign, send one, or move tokens. All refused while writes are locked. */
const WRITE_ROUTES = new Set(['POST /api/lp/launch', 'POST /api/lp/swap', 'POST /api/lp/submit', 'POST /api/lp/claim', 'POST /api/lp/treasury/propose',
  'POST /api/lp/treasury/approve', 'POST /api/lp/treasury/execute', 'POST /api/lp/faucet']);

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
  live: null | {
    /** null after graduation when the DAMM v2 pool could not be read: never substitute the finished curve's price */
    priceQuotePerBase: string | null; marketCapQuoteRaw: string | null; priceUnavailable: boolean; launchPriceQuotePerBase: string;
    quoteReserve: string; migrationQuoteThreshold: string; progressBps: number;
    curveComplete: boolean; isMigrated: boolean; baseDecimals: number; quoteDecimals: number; totalSupplyRaw: string;
    /** unclaimed creator share of curve fees (the DBC pool counter); LP fees after graduation are per position, see /api/lp/fees */
    creatorQuoteFee: string;
    /** after graduation: share of the DAMM v2 pool's liquidity that is permanently locked, read from the pool account */
    lockedBps: number | null;
    /** where the price comes from and where a trade goes: the bonding curve, or the DAMM v2 pool after graduation */
    venue: 'CURVE' | 'DAMM_V2' };
  stats: { count: number; volumeQuoteRaw: string; traders: number };
  /** whether the trade list holds every transaction the pool's signature list showed: `pending` are still being read,
   *  `unavailable` could not be read after repeated tries (both are retried; neither is counted as complete) */
  history: { complete: boolean; pending: number; unavailable: number };
}
const liveView = (p: LivePool | null, migrated: boolean, damm: LiveDammPool | null): TokenView['live'] => p && {
  priceQuotePerBase: migrated ? damm?.priceQuotePerBase ?? null : p.priceQuotePerBase,
  marketCapQuoteRaw: migrated ? (damm ? ((BigInt(damm.sqrtPrice) ** 2n * BigInt(p.totalSupplyRaw)) / (1n << 128n)).toString() : null) : p.marketCapQuoteRaw,
  priceUnavailable: migrated && !damm, launchPriceQuotePerBase: p.launchPriceQuotePerBase,
  quoteReserve: p.quoteReserve, migrationQuoteThreshold: p.migrationQuoteThreshold,
  progressBps: p.progressBps, curveComplete: p.curveComplete, isMigrated: p.isMigrated, baseDecimals: p.baseDecimals, quoteDecimals: p.quoteDecimals,
  totalSupplyRaw: p.totalSupplyRaw, creatorQuoteFee: p.creatorQuoteFee,
  lockedBps: damm && BigInt(damm.liquidity) > 0n ? Number((BigInt(damm.permanentLockLiquidity) * 10_000n) / BigInt(damm.liquidity)) : null,
  venue: migrated ? 'DAMM_V2' : 'CURVE',
};

/** A trade as the API shows it, with what it paid in fees (from its own swap event; `status` PENDING = not read yet). */
export function tradeView(t: StoredTrade) {
  return { sig: t.sig, mint: t.mint, trader: t.trader, side: t.side, quoteRaw: t.quoteRaw, baseRaw: t.baseRaw, slot: t.slot, blockTime: t.blockTime, source: t.source,
    venue: t.venue, fees: { status: t.feeStatus ?? 'PENDING', evidence: t.feeEvidence, totalRaw: t.feeTotalRaw, creatorRaw: t.feeCreatorRaw, platformRaw: t.feePlatformRaw,
      lpRaw: t.feeLpRaw, protocolRaw: t.feeProtocolRaw, referralRaw: t.feeReferralRaw, compoundingRaw: t.feeCompoundingRaw } };
}

/** Per-coin check that the fees recorded trade by trade add up to what the chain holds and what was claimed:
 *    curve: creator and platform shares from trades = the pool's unclaimed counter + proven claims through the app;
 *    LP (after graduation): LP fees from trades = the positions' unclaimed fees + proven claims.
 *  MATCH only on an exact match. On the LP side the trades may say a few raw units more than the positions hold (the
 *  program rounds down when it shares a fee out to positions): such a difference, up to `residualBound`, is RESIDUAL, kept
 *  explicit with its amount. Its origin is NOT_PROVEN until the pool's own fee accounting explains it (lp-residual.ts);
 *  then it is PROVEN_ROUNDING, with the proof attached. A small difference is never relabelled as a match. Anything else is MISMATCH; missing inputs make it INCOMPLETE with the
 *  reasons. A claim made outside this app is not in the receipts and shows as a MISMATCH. */
export type CheckStatus = 'MATCH' | 'RESIDUAL' | 'MISMATCH' | 'INCOMPLETE';
export interface FeeCheck { fromTradesRaw: string; onChainRaw: string | null; claimedRaw: string; differenceRaw: string | null; status: CheckStatus; reasons: string[];
  residual?: { raw: string; boundRaw: string; origin: 'NOT_PROVEN' | 'PROVEN_ROUNDING'; note: string; proof?: LpResidualProof } }
/** Largest LP residual per DAMM v2 trade that is reported as RESIDUAL rather than MISMATCH. */
export const LP_RESIDUAL_BOUND_PER_TRADE = 2n;
export function feeCheck(fromTrades: bigint, unclaimed: string | null, claimed: bigint, reasons: string[], residualBound = 0n): FeeCheck {
  const onChain = unclaimed === null ? null : BigInt(unclaimed) + claimed;
  const diff = onChain === null ? null : fromTrades - onChain;
  const why = [...reasons, ...(onChain === null ? ['the pool or positions could not be read'] : [])];
  const base = { fromTradesRaw: fromTrades.toString(), onChainRaw: onChain === null ? null : onChain.toString(), claimedRaw: claimed.toString(), differenceRaw: diff === null ? null : diff.toString() };
  if (why.length) return { ...base, status: 'INCOMPLETE', reasons: why };
  if (diff === 0n) return { ...base, status: 'MATCH', reasons: [] };
  if (diff! > 0n && diff! <= residualBound) return { ...base, status: 'RESIDUAL', reasons: [],
    residual: { raw: diff!.toString(), boundRaw: residualBound.toString(), origin: 'NOT_PROVEN',
      note: `${diff} raw unit(s) recorded in trades are in no known position or claim. Kept as an explicit residual; its origin is not yet proven from the pool's fee accumulator.` } };
  return { ...base, status: 'MISMATCH', reasons: [] };
}

const lpOfCoin = (c: EarningsCoin) => (c.lp && c.lp !== 'UNAVAILABLE' ? c.lp : null);
export const EARNINGS_TTL_MS = 30_000;
/** Unresolved claim receipts checked against their transactions per uncached earnings request (the RPC is shared). */
export const RECEIPT_CHECKS_PER_REQUEST = 5;
type Unclaimed = { creatorQuoteRaw: string | null; platformQuoteRaw: string | null };
interface EarningsCoin { mint: string; symbol: string; name: string; status: LaunchRow['status']; creator: string;
  curve: Unclaimed | null; lp: Unclaimed | 'UNAVAILABLE' | null; platformWallet: string; treasury: boolean;
  /** the config the coin launched on: CURRENT, or LEGACY (an earlier config, kept unchanged so its coins' fee entitlements hold) */
  configRole: ConfigRole;
  /** fees recorded trade by trade for this coin, and whether they add up to the chain (see feeCheck) */
  fromTrades?: FeeTotals; checks?: { creatorCurve: FeeCheck; platformCurve: FeeCheck; lp: FeeCheck | null } }
const TX_INDEX = /^[1-9]\d{0,18}$/;
type ConfigRole = 'CURRENT' | 'LEGACY';
const configRole = (p: PlatformRecord, config: string): ConfigRole => (config === p.config.config ? 'CURRENT' : 'LEGACY');
/** What the devnet treasury's signers are. Shown wherever the treasury is, so the test setup is never read as production control. */
export const TREASURY_SIGNERS_NOTE = 'Devnet stand-in. All three member keys are throwaway test keys held by one operator in one container, so this '
  + 'demonstrates the approval flow, not separation of control. The real signers, threshold and time lock are decided before mainnet.';
/** The vault's quote balance on chain against the proven treasury receipts: each receipt is counted once, in both places. */
export interface VaultCheck { status: 'MATCH' | 'MISMATCH' | 'INCOMPLETE'; vaultQuoteRaw: string | null; receiptsRaw: string; differenceRaw: string | null; reasons: string[] }
export function vaultCheck(vaultQuoteRaw: bigint | null, receiptsRaw: bigint, unresolvedReceipts: number): VaultCheck {
  const reasons = [...(vaultQuoteRaw === null ? ['the vault balance could not be read'] : []),
    ...(unresolvedReceipts ? [`${unresolvedReceipts} treasury receipt(s) not proven yet`] : [])];
  const base = { vaultQuoteRaw: vaultQuoteRaw?.toString() ?? null, receiptsRaw: receiptsRaw.toString() };
  if (reasons.length) return { status: 'INCOMPLETE', ...base, differenceRaw: null, reasons };
  const d = vaultQuoteRaw! - receiptsRaw;
  if (d === 0n) return { status: 'MATCH', ...base, differenceRaw: '0', reasons: [] };
  return { status: 'MISMATCH', ...base, differenceRaw: (d < 0n ? -d : d).toString(), reasons: [d > 0n
    ? 'the vault holds more than the proven receipts: tokens reached it outside a claim made in this app'
    : 'the vault holds less than the proven receipts: tokens left it (this app has no route that moves funds out of the vault)'] };
}
const TREASURY_REFRESH_PER_REQUEST = 5;
const FINAL_PROPOSAL = new Set(['Executed', 'Rejected', 'Cancelled']);

export function createLaunchpadApp(o: LaunchpadOptions): Server & { poolCache: PoolCache; dammCache: DammCache } {
  const now = o.now ?? (() => new Date());
  const profile = o.profile ?? DEVNET_PROFILE;
  const network = profile.cluster === 'devnet' ? 'devnet' : 'mainnet';
  const pools = new PoolCache(o.chain);
  const damms = new DammCache(o.chain);
  const rate = new Map<string, number[]>();
  let earnings: { at: number; body: unknown } | null = null;
  const limit = (key: string, max: number) => {
    const t = now().getTime();
    const recent = (rate.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= max) throw new HttpError(429, 'RATE_LIMITED', `at most ${max} requests per minute`);
    rate.set(key, [...recent, t]);
  };
  const platform = () => {
    const p = o.platform();
    if (!p) throw new HttpError(503, 'PLATFORM_NOT_READY', profile.cluster === 'devnet'
      ? 'the devnet platform (test quote + DBC config) has not been set up yet; run `main.ts setup` once the operator wallet holds devnet SOL'
      : 'there is no mainnet platform: mainnet is read-only until the owner approves it');
    return p;
  };
  const imageUrl = (l: LaunchRow) => (l.imageType ? `/m/${l.mint}.img` : null);
  const tokenView = async (l: LaunchRow, fresh = false): Promise<TokenView> => ({
    mint: l.mint, pool: l.pool, name: l.name, symbol: l.symbol, description: l.description, imageUrl: imageUrl(l), creator: l.creator, status: l.status,
    createdAt: l.createdAt, liveAt: l.liveAt, website: l.website, twitter: l.twitter, telegram: l.telegram, metadataUri: l.metadataUri,
    createSig: l.createSig, migrationSig: l.migrationSig, dammPool: l.dammPool,
    live: liveView(await pools.get(l.pool, fresh).catch(() => null), l.status === 'MIGRATED', l.status === 'MIGRATED' ? await damms.get(l, fresh).catch(() => null) : null), stats: o.store.tradeStats(l.mint),
    history: (({ pending, unavailable }) => ({ complete: pending === 0 && unavailable === 0, pending, unavailable }))(o.store.backfillCounts(l.mint)),
  });
  const intentCheck = (i: Omit<TxIntent, 'intentId' | 'createdAt' | 'expiresAt' | 'cluster' | 'mock'>, approvedEconomicsDigest?: string) => {
    const t = now();
    const r = validateIntent({ ...i, intentId: 'pending', cluster: profile.cluster, mock: false, createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + INTENT_TTL_MS).toISOString() },
      { now: t.toISOString(), ...(approvedEconomicsDigest ? { approvedEconomicsDigest } : {}) });
    if (!r.ok) throw new HttpError(409, 'INTENT_REFUSED', 'the transaction intent is refused by policy', r.violations);
  };
  const storeBuilt = async (kind: string, mint: string | null, user: string, built: { bytes: Uint8Array; terms: ApprovedTerms; blockhash: string; lastValidBlockHeight: number },
    ctx: BindingContext = {}) => {
    // Defence in depth: what we built must be for this network and bind to the terms we are about to hand out.
    if (built.terms.cluster !== profile.cluster) throw new HttpError(500, 'CLUSTER_MISMATCH', `built for ${built.terms.cluster}, this server runs on ${profile.cluster}`);
    const v = await bindTransactionToTerms(decodeTransactionBytes(built.bytes), built.terms, ctx);
    if (v.length) { o.log?.(`binding failed for ${kind}: ${v.join('; ')}`); throw new HttpError(500, 'BINDING_FAILED', 'the built transaction does not bind to its terms', v); }
    const t = now();
    return o.store.insertIntent({ kind, mint, user, createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + INTENT_TTL_MS).toISOString(),
      messageHex: toHex(parseWire(built.bytes).message), termsJson: JSON.stringify({ terms: built.terms, blockhash: built.blockhash }), lastValidBlockHeight: built.lastValidBlockHeight });
  };

  // ---------------------------------------------------------------- platform treasury helpers
  const treasuryView = (p: PlatformRecord) => ({ multisig: p.treasury!.multisig, vault: p.treasury!.vault, threshold: p.treasury!.threshold, members: p.treasury!.members,
    label: p.treasury!.label, signers: 'ONE_OPERATOR_TEST_KEYS' as const, separationOfControl: false, note: TREASURY_SIGNERS_NOTE });
  const innerVenue = (inner: TreasuryInnerTerms): 'CURVE' | 'DAMM_V2' => (inner.kind === 'CLAIM_PARTNER_TRADING_FEE' ? 'CURVE' : 'DAMM_V2');
  /** What reached the treasury vault through executed proposals (proven receipts only), what is still waiting, and whether
   *  the vault's own balance equals those receipts. The receipts are part of "claimed through the app"; they are not added again. */
  async function treasuryEarnings(p: PlatformRecord, claims: (ClaimRow & { byTreasury: boolean })[]) {
    const mine = claims.filter((c) => c.byTreasury);
    const paid = mine.filter((c) => c.status === 'RESOLVED').reduce((a, c) => a + BigInt(c.quoteRaw!), 0n);
    const unresolvedReceipts = mine.filter((c) => c.status === 'UNKNOWN').length;
    const held = await o.chain.balances(p.treasury!.vault, [p.quote.mint]).then((b) => BigInt(b.tokens[p.quote.mint] ?? '0')).catch(() => null);
    return { ...treasuryView(p), paidToTreasuryQuoteRaw: paid.toString(), includedIn: 'claimedThroughApp' as const, unresolvedReceipts,
      openProposals: o.store.listTreasuryProposals(p.treasury!.multisig).filter((r) => !FINAL_PROPOSAL.has(r.status)).length,
      vaultCheck: vaultCheck(held, paid, unresolvedReceipts) };
  }
  /** After a member's treasury transaction confirms: the app's record of the proposal, and for an execution the claim receipt. */
  async function recordTreasury(terms: Extract<ApprovedTerms, { kind: `TREASURY_${string}` }>, user: string, mint: string | null, signature: string) {
    const p = platform();
    const chainState = await o.chain.proposal(terms.multisig, terms.transactionIndex).catch(() => null);
    if (terms.kind === 'TREASURY_PROPOSE') {
      o.store.insertTreasuryProposal({ multisig: terms.multisig, txIndex: terms.transactionIndex, mint: mint!, venue: innerVenue(terms.inner), innerJson: JSON.stringify(terms.inner),
        proposer: user, proposeSig: signature, approvals: chainState?.approved ?? (terms.approve ? [user] : []), status: chainState?.status ?? 'Active', createdAt: now().toISOString() });
      return;
    }
    const row = o.store.getTreasuryProposal(terms.multisig, terms.transactionIndex);
    if (!row) return;
    if (terms.kind === 'TREASURY_APPROVE') {
      const approvals = chainState?.approved ?? [...new Set([...row.approvals, user])];
      o.store.updateTreasuryProposal(terms.multisig, terms.transactionIndex, { status: chainState?.status ?? (approvals.length >= (p.treasury?.threshold ?? 2) ? 'Approved' : 'Active'), approvals });
      return;
    }
    o.store.updateTreasuryProposal(terms.multisig, terms.transactionIndex, { status: chainState?.status ?? 'Executed', approvals: chainState?.approved ?? row.approvals, executeSig: signature, executedBy: user });
    const l = o.store.getLaunch(row.mint);
    if (!l) return;
    if (terms.inner.kind === 'CLAIM_PARTNER_TRADING_FEE') pools.invalidate(l.pool); else if (l.dammPool) damms.invalidate(l.dammPool);
    // the receipt is the vault's: what left this claim's own pool vaults in the executing transaction, nothing else
    const id = await claimIdentity(terms.inner, l);
    o.store.insertClaim({ sig: signature, mint: l.mint, venue: innerVenue(terms.inner), claimer: terms.inner.feePayer, at: now().toISOString(), ...(id ?? {}) });
    if (id) o.store.setClaimEvidence(signature, claimReceipt(id, await o.chain.txSummary(signature).catch(() => null)));
    earnings = null;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const method = req.method ?? 'GET';
    const ip = clientIp(req, o.clientIpHeader);
    if (path === '/api/lp/healthz' && method === 'GET') return send(res, 200, { ok: true, apiVersion: LP_API_VERSION, cluster: profile.cluster, mode: profile.mode });
    // one gate for everything that builds, sends or moves tokens: nothing below runs while writes are locked
    if (WRITE_ROUTES.has(`${method} ${path}`)) {
      if (path === '/api/lp/faucet' && !profile.faucet) throw new HttpError(404, 'NO_FAUCET', `there is no faucet on ${network}`);
      if (!profile.writes) throw new HttpError(423, 'WRITES_LOCKED', `${network} is read-only: launching, trading, claiming and treasury steps are locked until the owner approves ${network}`, profile.writesLockedBecause);
    }

    if (path === '/api/lp/platform' && method === 'GET') {
      const p = o.platform();
      return send(res, 200, { apiVersion: LP_API_VERSION, cluster: profile.cluster, mode: profile.mode, writesEnabled: profile.writes, writesLockedBecause: profile.writesLockedBecause,
        label: profile.label, mainnetQuote: profile.cluster === 'mainnet-beta' ? profile.quote : null, chainChecks: o.chainChecks?.() ?? null,
        mainnetBlockers: READINESS.MAINNET.blockers, ready: !!p, readiness: { DEVNET_INTEGRATION: READINESS.DEVNET_INTEGRATION.status, MAINNET: READINESS.MAINNET.status },
        operator: o.chain.operatorAddress, platform: p && { quote: p.quote, config: p.config.config, threshold: p.threshold, launchEconomics: p.launchEconomics,
          launchEconomicsDigest: p.launchEconomicsDigest, economicsVersion: p.economicsVersion, templateVersion: p.templateVersion,
          configs: [p.config, ...(p.legacyConfigs ?? [])].map((c) => ({ config: c.config, feeClaimer: c.feeClaimer, current: c.config === p.config.config,
            role: configRole(p, c.config), treasury: isTreasuryConfig(p, c.config),
            label: configRole(p, c.config) === 'LEGACY' ? 'Legacy config: coins launched on it keep it, and their platform fees still go to its fee claimer, unchanged'
              : isTreasuryConfig(p, c.config) ? 'Current config: platform fees go to the treasury vault' : 'Current config' })),
          treasury: p.treasury ? treasuryView(p) : null },
        faucet: profile.faucet ? { quoteUi: FAUCET.quoteUi.toString(), lamports: FAUCET.lamports.toString(), claimsPerDay: FAUCET.claimsPerDay } : null });
    }

    if (path === '/api/lp/tokens' && method === 'GET') {
      const list = o.store.listLaunches(['LIVE', 'MIGRATED']);
      return send(res, 200, { tokens: await Promise.all(list.map((l) => tokenView(l))) });
    }
    if (path === '/api/lp/trades/recent' && method === 'GET') {
      return send(res, 200, { trades: o.store.listRecentTrades(30).map((t) => ({ sig: t.sig, mint: t.mint, symbol: t.symbol, trader: t.trader, side: t.side, quoteRaw: t.quoteRaw, blockTime: t.blockTime })) });
    }
    // Fees paid by traders, trade by trade, from each trade's own swap event. With ?wallet=: that wallet's trades and
    // totals per coin. Without: totals per coin and per wallet. Read-only; every figure links back to a transaction.
    if (path === '/api/lp/fees' && method === 'GET') {
      limit(`fees:${ip}`, 60);
      const wallet = query.get('wallet');
      const symbols = new Map(o.store.listLaunches(['LIVE', 'MIGRATED']).map((l) => [l.mint, l.symbol]));
      const coinRows = (rows: (FeeTotals & { mint?: string })[]) => rows.filter((r) => symbols.has(r.mint!)).map((r) => ({ ...r, symbol: symbols.get(r.mint!)! }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      const pending = (rows: StoredTrade[]) => rows.filter((t) => t.feeStatus === null).length;
      if (wallet !== null) {
        if (!B58.test(wallet)) throw new HttpError(400, 'INVALID_REQUEST', 'wallet must be an address');
        const trades = o.store.listWalletTrades(wallet).filter((t) => symbols.has(t.mint));
        return send(res, 200, { wallet, totals: sumFees(trades), notYetRead: pending(trades), coins: coinRows(o.store.feeTotals(['mint'], { trader: wallet })),
          trades: trades.map((t) => ({ ...tradeView(t), symbol: t.symbol })) });
      }
      const wallets = o.store.feeTotals(['trader']).sort((a, b) => (BigInt(b.feesRaw) > BigInt(a.feesRaw) ? 1 : BigInt(b.feesRaw) < BigInt(a.feesRaw) ? -1 : a.trader!.localeCompare(b.trader!)));
      const all = o.store.feeTotals([])[0] ?? sumFees([]);
      return send(res, 200, { totals: all, coins: coinRows(o.store.feeTotals(['mint'])), wallets: wallets.slice(0, 200), walletCount: wallets.length });
    }
    const tm = /^\/api\/lp\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (tm && method === 'GET') {
      const l = o.store.getLaunch(tm[1]!);
      if (!l || l.status === 'PENDING' || l.status === 'FAILED') throw new HttpError(404, 'NOT_FOUND', 'token not found');
      return send(res, 200, { token: await tokenView(l, query.get('fresh') === '1'), trades: o.store.listTrades(l.mint).map(tradeView) });
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

    /** Largest input below `limit` the curve can fill (binary search over the local curve math; no RPC). */
    const maxFillable = (pool: LivePool, direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE', limit: bigint, nowS: number): bigint => {
      let lo = 0n, hi = limit;
      while (lo < hi) {
        const mid = (lo + hi + 1n) / 2n;
        try { o.chain.quoteSwap(pool, direction, mid, 0, nowS); lo = mid; } catch { hi = mid - 1n; }
      }
      return lo;
    };
    if ((path === '/api/lp/swap' || path === '/api/lp/quote') && method === 'POST') {
      limit(`build:${ip}`, BUILDS_PER_MINUTE * 2);
      const b = await readJson(req, BODY_LIMIT_BYTES);
      const isBuild = path === '/api/lp/swap';
      onlyKeys(b, isBuild ? ['mint', 'user', 'side', 'amountIn', 'slippageBps'] : ['mint', 'side', 'amountIn', 'slippageBps']);
      const mint = addr(b, 'mint');
      const l = o.store.getLaunch(mint);
      if (!l || (l.status !== 'LIVE' && l.status !== 'MIGRATED')) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      if (b.side !== 'buy' && b.side !== 'sell') throw new HttpError(400, 'INVALID_REQUEST', "side must be 'buy' or 'sell'");
      const amountIn = rawAmount(b, 'amountIn');
      const slippageBps = b.slippageBps === undefined ? 100 : Number(b.slippageBps);
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new HttpError(400, 'INVALID_REQUEST', 'slippageBps must be an integer in 0..5000');
      if (l.status === 'MIGRATED') {
        // After graduation the coin trades on its DAMM v2 pool: same exact-in quote shape, same build/check/sign path.
        if (!l.dammPool) throw new HttpError(409, 'POOL_MIGRATING', 'this coin is graduating; its DAMM v2 pool is not recorded yet');
        const dp = await damms.get(l, isBuild);
        if (!dp) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read the DAMM v2 pool');
        const dir = b.side === 'buy' ? 'QUOTE_TO_BASE' as const : 'BASE_TO_QUOTE' as const;
        const point = await o.chain.dammNow(dp);
        const refuse = (e: unknown) => { const m = (e as Error).message;
          if (/^ZERO_OUTPUT/.test(m)) return new HttpError(409, 'ZERO_OUTPUT', m);
          if (/insufficient liquidity|exceed|overflow|swap.*disabled|price range/i.test(m)) return new HttpError(409, 'AMOUNT_NOT_FILLABLE', 'the pool cannot fill this amount; try a smaller one');
          return e; };
        if (!isBuild) { try { return send(res, 200, { quote: o.chain.quoteDammSwap(dp, dir, amountIn, slippageBps, point), venue: 'DAMM_V2' }); } catch (e) { throw refuse(e); } }
        const user = addr(b, 'user');
        intentCheck({ kind: 'DAMM_SWAP', signer: { role: 'USER_WALLET', address: user, serverHeld: false }, feePayer: user, amounts: { amountIn: amountIn.toString() } });
        let built;
        try { built = await o.chain.buildDammSwap(dp, { pool: l.dammPool, user, direction: dir, amountIn, slippageBps }, point); }
        catch (e) { throw refuse(e); }
        const intent = await storeBuilt('DAMM_SWAP', mint, user, built);
        return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, quote: built.quote, venue: 'DAMM_V2' });
      }
      const pool = await pools.get(l.pool, isBuild);
      if (!pool) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read the pool');
      if (pool.curveComplete || pool.isMigrated) throw new HttpError(409, 'CURVE_COMPLETE', 'the bonding curve is complete; migration to DAMM v2 is pending');
      const direction = b.side === 'buy' ? 'QUOTE_TO_BASE' as const : 'BASE_TO_QUOTE' as const;
      const nowS = Math.floor(now().getTime() / 1000);
      // The curve math refuses amounts it cannot fill (e.g. buying past the end of the curve): that is the user's input, not a server fault.
      const curveRefusal = (e: unknown) => { const m = (e as Error).message; if (/^(POOL_COMPLETE|ZERO_OUTPUT)/.test(m)) return new HttpError(409, m.split(':')[0]!, m);
        if (/insufficient liquidity|exceed|overflow/i.test(m)) {
          // A buy past the end of the curve: tell the buyer the most it can take, so the last buy before graduation is one tap.
          const max = direction === 'QUOTE_TO_BASE' ? maxFillable(pool, direction, amountIn, nowS) : 0n;
          return max > 0n
            ? new HttpError(409, 'AMOUNT_NOT_FILLABLE', 'more than is left on the curve before graduation', [`maxAmountIn:${max}`])
            : new HttpError(409, 'AMOUNT_NOT_FILLABLE', 'the curve cannot fill this amount; try a smaller one');
        }
        return e; };
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
      // execute runs what the multisig stored: re-read it now and bind it again, never trust the copy from build time
      const ctx: BindingContext = {};
      if (terms.kind === 'TREASURY_EXECUTE') {
        const stored = await o.chain.vaultTransaction(terms.multisig, terms.transactionIndex).catch(() => null);
        if (stored) ctx.vaultTransactionAccount = stored;
      }
      const bound = await bindTransactionToTerms(decodeTransactionBytes(bytes), terms, ctx);
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
      if (intent.kind === 'DAMM_SWAP' && l?.dammPool) {
        damms.invalidate(l.dammPool);
        const p = await damms.get(l, true).catch(() => null);
        const sum = p && await o.chain.txSummary(signature).catch(() => null);
        trade = sum && p ? tradeFromSummary(l, p, sum, 'app') : null;
        if (trade) o.store.insertTrade(trade);
      }
      if ((intent.kind === 'CLAIM_CREATOR_TRADING_FEE' || intent.kind === 'DAMM_CLAIM_POSITION_FEE') && l) {
        const curve = intent.kind === 'CLAIM_CREATOR_TRADING_FEE';
        if (curve) pools.invalidate(l.pool); else if (l.dammPool) damms.invalidate(l.dammPool);
        // The receipt keeps the pool and vaults this transaction was bound to; its amount comes only from this
        // transaction's own balance changes on those vaults, now or on a later earnings request.
        const id = await claimIdentity(terms, l);
        o.store.insertClaim({ sig: signature, mint: l.mint, venue: curve ? 'CURVE' : 'DAMM_V2', claimer: intent.user, at: now().toISOString(), ...(id ?? {}) });
        if (id) o.store.setClaimEvidence(signature, claimReceipt(id, await o.chain.txSummary(signature).catch(() => null)));
        else o.log?.(`claim ${signature}: its terms do not match ${l.symbol}'s ${curve ? 'curve' : 'DAMM v2'} pool; receipt left unknown`);
        earnings = null;
      }
      if (terms.kind === 'TREASURY_PROPOSE' || terms.kind === 'TREASURY_APPROVE' || terms.kind === 'TREASURY_EXECUTE') await recordTreasury(terms, intent.user, intent.mint, signature);
      return send(res, 200, { signature, kind: intent.kind, mint: intent.mint, trade });
    }

    // ---------------------------------------------------------------- creator fees
    // Two places a creator earns: the creator share of curve trading fees (held in the DBC pool until claimed), and after
    // graduation the fees of the creator's permanently locked DAMM v2 position (claimable by whoever holds its NFT).
    // Both are claimed by the wallet itself; the server only builds the unsigned transaction.
    const fm = /^\/api\/lp\/fees\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (fm && method === 'GET') {
      const l = o.store.getLaunch(fm[1]!);
      if (!l || (l.status !== 'LIVE' && l.status !== 'MIGRATED')) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      const wallet = query.get('wallet');
      if (!wallet || !B58.test(wallet)) throw new HttpError(400, 'INVALID_REQUEST', 'wallet must be an address');
      limit(`fees:${ip}`, 60);
      const fresh = query.get('fresh') === '1';
      const isCreator = l.creator === wallet;
      const pool = isCreator ? await pools.get(l.pool, fresh) : null;
      const curve = pool ? { quoteRaw: pool.creatorQuoteFee, baseRaw: pool.creatorBaseFee } : null;
      const dp = l.status === 'MIGRATED' && l.dammPool ? await damms.get(l, fresh) : null;
      const positions = dp ? await o.chain.dammPositions(dp, wallet) : [];
      return send(res, 200, { mint: l.mint, wallet, isCreator, curve, positions });
    }
    if (path === '/api/lp/claim' && method === 'POST') {
      limit(`build:${ip}`, BUILDS_PER_MINUTE);
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, ['mint', 'user', 'venue', 'nftMint']);
      const l = o.store.getLaunch(addr(b, 'mint'));
      if (!l || (l.status !== 'LIVE' && l.status !== 'MIGRATED')) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      const user = addr(b, 'user');
      const nothing = (e: unknown) => /^NOTHING_TO_CLAIM/.test((e as Error).message) ? new HttpError(409, 'NOTHING_TO_CLAIM', 'there are no fees to claim yet') : e;
      if (b.venue === 'curve') {
        if (l.creator !== user) throw new HttpError(403, 'NOT_CREATOR', 'only the wallet that launched this coin can claim its curve fees');
        const pool = await pools.get(l.pool, true);
        if (!pool) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read the pool');
        intentCheck({ kind: 'CLAIM_CREATOR_TRADING_FEE', signer: { role: 'USER_WALLET', address: user, serverHeld: false }, feePayer: user });
        let built;
        try { built = await o.chain.buildCreatorCurveClaim(pool, user); } catch (e) { throw nothing(e); }
        const intent = await storeBuilt('CLAIM_CREATOR_TRADING_FEE', l.mint, user, built);
        return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, venue: 'CURVE',
          amounts: { baseRaw: built.maxBaseAmount, quoteRaw: built.maxQuoteAmount } });
      }
      if (b.venue === 'damm') {
        if (l.status !== 'MIGRATED' || !l.dammPool) throw new HttpError(409, 'NOT_GRADUATED', 'this coin has not graduated to DAMM v2 yet');
        const nftMint = addr(b, 'nftMint');
        const dp = await damms.get(l, true);
        if (!dp) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read the DAMM v2 pool');
        const pos = (await o.chain.dammPositions(dp, user)).find((x) => x.nftMint === nftMint);
        if (!pos) throw new HttpError(403, 'NOT_POSITION_OWNER', 'this wallet does not hold that position in this pool');
        if (BigInt(pos.feeBaseRaw) === 0n && BigInt(pos.feeQuoteRaw) === 0n) throw new HttpError(409, 'NOTHING_TO_CLAIM', 'there are no fees to claim yet');
        intentCheck({ kind: 'DAMM_CLAIM_POSITION_FEE', signer: { role: 'USER_WALLET', address: user, serverHeld: false }, feePayer: user });
        const built = await o.chain.buildDammClaim(dp, user, nftMint);
        const intent = await storeBuilt('DAMM_CLAIM_POSITION_FEE', l.mint, user, built);
        return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, venue: 'DAMM_V2',
          amounts: { baseRaw: pos.feeBaseRaw, quoteRaw: pos.feeQuoteRaw } });
      }
      throw new HttpError(400, 'INVALID_REQUEST', "venue must be 'curve' or 'damm'");
    }

    // ---------------------------------------------------------------- platform treasury (Squads multisig, devnet stand-in)
    // Platform fees of coins launched on the treasury config belong to the multisig's vault. Moving them takes a proposal
    // and approvals from two members. The server only builds unsigned transactions for a member to check and sign; it
    // holds no member key, so it cannot approve, execute or spend.
    if (path.startsWith('/api/lp/treasury')) {
      const p = platform();
      if (!p.treasury) throw new HttpError(409, 'NO_TREASURY', 'the platform treasury has not been set up');
      const t = p.treasury;
      const memberOf = (b: Record<string, unknown>) => { const m = addr(b, 'member'); if (!t.members.includes(m)) throw new HttpError(403, 'NOT_A_MEMBER', 'that wallet is not a member of the platform treasury'); return m; };
      const indexOf = (b: Record<string, unknown>) => { const i = b.transactionIndex; if (typeof i !== 'string' || !TX_INDEX.test(i)) throw new HttpError(400, 'INVALID_REQUEST', 'transactionIndex must be a positive integer string'); return i; };
      const memberIntent = (kind: 'TREASURY_PROPOSE' | 'TREASURY_APPROVE' | 'TREASURY_EXECUTE', m: string) =>
        intentCheck({ kind, signer: { role: 'TREASURY_MEMBER', address: m, serverHeld: false }, feePayer: m });

      if (path === '/api/lp/treasury' && method === 'GET') {
        limit(`treasury:${ip}`, 30);
        const rows = o.store.listTreasuryProposals(t.multisig);
        for (const r of rows.filter((x) => !FINAL_PROPOSAL.has(x.status)).slice(0, TREASURY_REFRESH_PER_REQUEST)) {
          const st = await o.chain.proposal(t.multisig, r.txIndex).catch(() => null);
          if (st) o.store.updateTreasuryProposal(t.multisig, r.txIndex, { status: st.status, approvals: st.approved });
        }
        const claimable = [];
        for (const l of o.store.listLaunches(['LIVE', 'MIGRATED']).filter((x) => isTreasuryConfig(p, x.config))) {
          const pool = await pools.get(l.pool).catch(() => null);
          const dp = l.status === 'MIGRATED' ? await damms.get(l).catch(() => null) : null;
          const positions = dp ? await o.chain.dammPositions(dp, t.vault).catch(() => null) : null;
          claimable.push({ mint: l.mint, symbol: l.symbol, status: l.status,
            curve: pool ? { quoteRaw: pool.partnerQuoteFee, baseRaw: pool.partnerBaseFee } : null,
            positions: l.status !== 'MIGRATED' ? [] : positions ?? 'UNAVAILABLE' });
        }
        return send(res, 200, { treasury: treasuryView(p), proposals: o.store.listTreasuryProposals(t.multisig).map(({ innerJson, ...r }) => ({ ...r, inner: JSON.parse(innerJson) })), claimable });
      }
      if (method !== 'POST') throw new HttpError(404, 'NOT_FOUND', 'no such route');
      limit(`build:${ip}`, BUILDS_PER_MINUTE);
      const b = await readJson(req, BODY_LIMIT_BYTES);

      if (path === '/api/lp/treasury/propose') {
        onlyKeys(b, ['mint', 'venue', 'member', 'nftMint']);
        const m = memberOf(b);
        const l = o.store.getLaunch(addr(b, 'mint'));
        if (!l || (l.status !== 'LIVE' && l.status !== 'MIGRATED')) throw new HttpError(404, 'NOT_FOUND', 'token not found');
        if (!isTreasuryConfig(p, l.config)) throw new HttpError(409, 'NOT_TREASURY_COIN', "this coin launched on an earlier config whose platform fees go to the operator wallet, not the treasury");
        let req2: Parameters<typeof o.chain.buildTreasuryPropose>[3];
        if (b.venue === 'curve') {
          const pool = await pools.get(l.pool, true);
          if (!pool) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read the pool');
          if (BigInt(pool.partnerQuoteFee) === 0n && BigInt(pool.partnerBaseFee) === 0n) throw new HttpError(409, 'NOTHING_TO_CLAIM', 'there are no platform fees to claim yet');
          req2 = { venue: 'CURVE', pool };
        } else if (b.venue === 'damm') {
          if (l.status !== 'MIGRATED' || !l.dammPool) throw new HttpError(409, 'NOT_GRADUATED', 'this coin has not graduated to DAMM v2 yet');
          const nftMint = addr(b, 'nftMint');
          const dp = await damms.get(l, true);
          if (!dp) throw new HttpError(502, 'POOL_UNAVAILABLE', 'could not read the DAMM v2 pool');
          const pos = (await o.chain.dammPositions(dp, t.vault)).find((x) => x.nftMint === nftMint);
          if (!pos) throw new HttpError(403, 'NOT_POSITION_OWNER', 'the treasury vault does not hold that position in this pool');
          if (BigInt(pos.feeBaseRaw) === 0n && BigInt(pos.feeQuoteRaw) === 0n) throw new HttpError(409, 'NOTHING_TO_CLAIM', 'there are no fees to claim yet');
          req2 = { venue: 'DAMM_V2', pool: dp, nftMint, amounts: { baseRaw: pos.feeBaseRaw, quoteRaw: pos.feeQuoteRaw } };
        } else throw new HttpError(400, 'INVALID_REQUEST', "venue must be 'curve' or 'damm'");
        memberIntent('TREASURY_PROPOSE', m);
        const built = await o.chain.buildTreasuryPropose(t.multisig, t.vault, m, req2);
        const intent = await storeBuilt('TREASURY_PROPOSE', l.mint, m, built);
        return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, transactionIndex: built.transactionIndex, amounts: built.amounts });
      }
      if (path === '/api/lp/treasury/approve' || path === '/api/lp/treasury/execute') {
        onlyKeys(b, ['transactionIndex', 'member']);
        const m = memberOf(b), index = indexOf(b);
        const row = o.store.getTreasuryProposal(t.multisig, index);
        if (!row) throw new HttpError(404, 'NOT_FOUND', 'no such treasury proposal');
        const inner = JSON.parse(row.innerJson) as TreasuryInnerTerms;
        const st = await o.chain.proposal(t.multisig, index);
        if (!st) throw new HttpError(502, 'PROPOSAL_UNAVAILABLE', 'could not read the proposal');
        o.store.updateTreasuryProposal(t.multisig, index, { status: st.status, approvals: st.approved });
        if (path === '/api/lp/treasury/approve') {
          if (st.status !== 'Active') throw new HttpError(409, 'NOT_ACTIVE', `the proposal is ${st.status}, not open for approval`);
          if (st.approved.includes(m)) throw new HttpError(409, 'ALREADY_APPROVED', 'this member already approved');
          memberIntent('TREASURY_APPROVE', m);
          const built = await o.chain.buildTreasuryApprove(t.multisig, m, index);
          const intent = await storeBuilt('TREASURY_APPROVE', row.mint, m, built);
          return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, inner, proposal: st });
        }
        if (st.status !== 'Approved') throw new HttpError(409, 'NOT_APPROVED', `the proposal is ${st.status}; it needs ${t.threshold} approvals before it can run`);
        const stored = await o.chain.vaultTransaction(t.multisig, index);
        if (!stored) throw new HttpError(502, 'PROPOSAL_UNAVAILABLE', 'could not read the stored vault transaction');
        const chk = await bindStoredVaultTransaction(stored, { multisig: t.multisig, transactionIndex: index, vaultIndex: 0, inner });
        if (chk.violations.length) throw new HttpError(409, 'STORED_TRANSACTION_MISMATCH', 'what the multisig stored is not the claim this app proposed', chk.violations);
        memberIntent('TREASURY_EXECUTE', m);
        const built = await o.chain.buildTreasuryExecute({ multisig: t.multisig, vault: t.vault, member: m, transactionIndex: index, inner, stored });
        const intent = await storeBuilt('TREASURY_EXECUTE', row.mint, m, built, { vaultTransactionAccount: stored });
        return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, inner, proposal: st });
      }
      throw new HttpError(404, 'NOT_FOUND', 'no such route');
    }

    // ---------------------------------------------------------------- earnings (read-only)
    // Per coin: unclaimed curve fees (creator and platform counters in the DBC pool), unclaimed LP fees of the positions the
    // creator and the platform fee claimer hold in the DAMM v2 pool, and the claims made through this app with what they
    // paid out. Accrued is not claimed, and claimed is not retained revenue. Nothing here can move funds.
    if (path === '/api/lp/earnings' && method === 'GET') {
      const p = platform();
      limit(`earnings:${ip}`, 30);
      if (earnings && now().getTime() - earnings.at < EARNINGS_TTL_MS && query.get('fresh') !== '1') return send(res, 200, earnings.body);
      const platformWallet = p.config.feeClaimer;
      const vault = p.treasury?.vault ?? null;
      const launches = o.store.listLaunches(['LIVE', 'MIGRATED']);
      const sumQuote = (ps: { feeQuoteRaw: string }[] | null) => (ps === null ? null : ps.reduce((a, x) => a + BigInt(x.feeQuoteRaw), 0n).toString());
      const coins: EarningsCoin[] = [];
      const dammOf = new Map<string, LiveDammPool>();
      for (const l of launches) {
        const pool = await pools.get(l.pool).catch(() => null);
        const dp = l.status === 'MIGRATED' ? await damms.get(l).catch(() => null) : null;
        if (dp) dammOf.set(l.mint, dp);
        const positions = async (owner: string) => (dp ? await o.chain.dammPositions(dp, owner).catch(() => null) : null);
        // each coin's platform share belongs to the fee claimer of the config it launched on: the operator for earlier
        // coins, the treasury vault for coins launched since the treasury config
        const claimer = feeClaimerFor(p, l.config) ?? platformWallet;
        coins.push({ mint: l.mint, symbol: l.symbol, name: l.name, status: l.status, creator: l.creator, platformWallet: claimer, treasury: claimer === vault, configRole: configRole(p, l.config),
          curve: pool ? { creatorQuoteRaw: pool.creatorQuoteFee, platformQuoteRaw: pool.partnerQuoteFee } : null,
          lp: l.status !== 'MIGRATED' ? null : dp ? { creatorQuoteRaw: sumQuote(await positions(l.creator)), platformQuoteRaw: sumQuote(await positions(claimer)) } : 'UNAVAILABLE' });
      }
      // receipts still waiting for evidence: each is checked against its own transaction and vaults (a few per request)
      await resolveClaims(o, RECEIPT_CHECKS_PER_REQUEST);
      const claims: (ClaimRow & { symbol: string; byCreator: boolean; byTreasury: boolean })[] = o.store.listClaims().map((c) => {
        const l = launches.find((x) => x.mint === c.mint) ?? o.store.getLaunch(c.mint);
        return { ...c, symbol: l?.symbol ?? '?', byCreator: l?.creator === c.claimer, byTreasury: c.claimer === vault };
      });
      const unresolvedClaims = claims.filter((c) => c.status === 'UNKNOWN').length;
      for (const c of coins) {
        const l = launches.find((x) => x.mint === c.mint)!;
        const ft = o.store.feeTotals(['mint'], { mint: c.mint })[0] ?? sumFees([]);
        const mine = claims.filter((x) => x.mint === c.mint);
        const claimed = (venue: string, who: (x: (typeof claims)[number]) => boolean) =>
          mine.filter((x) => x.venue === venue && x.status === 'RESOLVED' && who(x)).reduce((a, x) => a + BigInt(x.quoteRaw!), 0n);
        const h = o.store.backfillCounts(c.mint);
        const reasons = (venue: string) => [
          ...(ft.unknownTrades ? [`${ft.unknownTrades} trade(s) whose fees are not read yet`] : []),
          ...(h.pending || h.unavailable ? [`${h.pending + h.unavailable} transaction(s) still being read`] : []),
          ...(mine.some((x) => x.venue === venue && x.status === 'UNKNOWN') ? ['a claim receipt is not proven yet'] : []),
        ];
        const lp = lpOfCoin(c);
        const dammTrades = BigInt(o.store.listTrades(c.mint, 100_000).filter((t) => t.venue === 'DAMM_V2').length);
        c.fromTrades = ft;
        c.checks = {
          creatorCurve: feeCheck(BigInt(ft.creatorRaw), c.curve?.creatorQuoteRaw ?? null, claimed('CURVE', (x) => x.claimer === l.creator), reasons('CURVE')),
          platformCurve: feeCheck(BigInt(ft.platformRaw), c.curve?.platformQuoteRaw ?? null, claimed('CURVE', (x) => x.claimer === c.platformWallet), reasons('CURVE')),
          lp: l.status !== 'MIGRATED' ? null : feeCheck(BigInt(ft.lpRaw), lp && lp.creatorQuoteRaw !== null && lp.platformQuoteRaw !== null
            ? (BigInt(lp.creatorQuoteRaw) + BigInt(lp.platformQuoteRaw)).toString() : null, claimed('DAMM_V2', () => true), reasons('DAMM_V2'), LP_RESIDUAL_BOUND_PER_TRADE * dammTrades),
        };
        // an LP residual: try to prove where it comes from, from the pool's own fee accounting (one snapshot read)
        const r = c.checks.lp?.residual, dp = dammOf.get(c.mint);
        if (r && dp) {
          const accounting = await o.chain.dammFeeAccounting(dp).catch(() => null);
          const lpClaims = mine.filter((x) => x.venue === 'DAMM_V2' && x.status === 'RESOLVED');
          const proof = accounting && explainLpResidual({ ledgerLpRaw: BigInt(ft.lpRaw), dammTrades: Number(dammTrades), accounting,
            claimsRaw: lpClaims.reduce((a, x) => a + BigInt(x.quoteRaw!), 0n), claims: lpClaims.length });
          if (proof && proof.residualRaw === r.raw) {
            r.proof = proof;
            if (proof.status === 'PROVEN_ROUNDING') {
              r.origin = 'PROVEN_ROUNDING';
              r.note = `${r.raw} raw unit(s) are rounding in the DAMM v2 program's own fee math: positions are paid whole units and each settlement drops the fraction `
                + `(${proof.parts.settlementRaw} raw), and the fee accumulator keeps a little less than the fees (${proof.parts.accumulatorRaw} raw). Recomputed from the pool's accounting; every check passed.`;
            } else r.note += ` Proof attempted: ${proof.checks.filter((x) => !x.ok).map((x) => x.id).join(', ')} did not pass.`;
          } else if (proof) r.note += ` The pool's accounting snapshot gives ${proof.residualRaw} raw instead (it moved between reads); the proof is tried again on the next refresh.`;
        }
      }
      const add = (pick: (c: EarningsCoin) => string | null | undefined) => coins.reduce((a, c) => a + BigInt(pick(c) ?? '0'), 0n).toString();
      const lpOf = lpOfCoin;
      // two separate questions: were all pools and positions read (unclaimed), and is every receipt proven (claims)
      const unclaimedComplete = !coins.some((c) => !c.curve || c.lp === 'UNAVAILABLE' || (lpOf(c) && (lpOf(c)!.creatorQuoteRaw === null || lpOf(c)!.platformQuoteRaw === null)));
      const body = { cluster: profile.cluster, label: profile.label, quote: p.quote, platformWallet, asOf: now().toISOString(),
        totals: {
          unclaimed: { creatorCurve: add((c) => c.curve?.creatorQuoteRaw), platformCurve: add((c) => c.curve?.platformQuoteRaw),
            creatorLp: add((c) => lpOf(c)?.creatorQuoteRaw), platformLp: add((c) => lpOf(c)?.platformQuoteRaw) },
          // only receipts proven from their transaction count; unresolved ones are reported in coverage, not added as 0
          claimedThroughApp: claims.reduce((a, c) => a + (c.status === 'UNKNOWN' ? 0n : BigInt(c.quoteRaw!)), 0n).toString(),
          coverage: { unclaimedComplete, claimsComplete: unresolvedClaims === 0, unresolvedClaims },
          incomplete: !unclaimedComplete || unresolvedClaims > 0 },
        treasury: p.treasury ? await treasuryEarnings(p, claims) : null,
        coins, claims };
      earnings = { at: now().getTime(), body };
      return send(res, 200, body);
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
      // The public devnet RPC rate-limits bursts; that is a retryable outage, not a server fault.
      const rpcBusy = !(e instanceof HttpError) && /\b429\b|Too Many Requests|rate limit/i.test((e as Error)?.message ?? '');
      const err = e instanceof HttpError ? e : rpcBusy ? new HttpError(503, 'RPC_BUSY', `the ${network} RPC is busy; try again in a few seconds`) : new HttpError(500, 'INTERNAL', 'internal error');
      if (!(e instanceof HttpError)) o.log?.(rpcBusy ? `rpc busy on ${path}` : `internal error: ${(e as Error)?.stack?.slice(0, 800)}`);
      send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
  }) as Server & { poolCache: PoolCache; dammCache: DammCache };
  server.poolCache = pools;
  server.dammCache = damms;
  return server;
}
