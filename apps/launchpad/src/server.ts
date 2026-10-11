// HTTP layer for the devnet launchpad (lp-api/1) plus same-origin hosting of the web app and of token metadata.
//
// Signing model: the server builds UNSIGNED transactions and returns them with the approved terms. The browser decodes
// the bytes independently (packages/tx), checks them against the terms and what the person typed, adds the
// client-generated mint signature (launch only) and has the wallet sign. On submit the server accepts only the exact
// message it built, verifies every signature, re-binds the message to the terms and then relays it. The server never
// signs for a user; only operator-role steps (faucet, migration crank) use the disposable devnet operator key.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { economicsDigest } from '@project-qf/policy';
import {
  bindStoredVaultTransaction, bindTransactionToTerms, decodeTransactionBytes, fromBase64, parseWire, sameMessage, toBase64, toHex, validateIntent, verifyWireSignatures,
  MAX_REWARD_PAYOUTS_PER_TX, PROGRAM_IDS, vaultIndexFor, type ApprovedTerms, type BindingContext, type TreasuryInnerTerms, type TxIntent,
} from '@project-qf/tx';
import type { LaunchpadChain, LiveDammPool, LivePool } from './chain.ts';
import { PoolCache, syncLaunch, tradeFromSummary, DammCache } from './indexer.ts';
import { isTreasuryConfig, type PlatformRecord } from './platform.ts';
import { allCoinRewards, treasuryView } from './books.ts';
import type { ClusterProfile } from './cluster.ts';
import { claimIdentity, claimReceipt } from './receipts.ts';
import { DEVNET_TEST_PAYOUT_ROUNDS, epochDetail, rewardsOverview, type CoinRewards, type RewardsVaultView } from './rewards.ts';
import { rewardsVaultOf, storedVaultCoverage } from './rewards-vault.ts';
import type { LaunchRow, LaunchpadStore, StoredTrade } from './store.ts';
import { addr, B58, BODY_LIMIT_BYTES, clientIp, HttpError, image, LAUNCH_BODY_LIMIT_BYTES, onlyKeys, rawAmount, readJson, send, serveStatic, text, url } from './http.ts';

export { BODY_LIMIT_BYTES, clientIp, IMAGE_LIMIT_BYTES, LAUNCH_BODY_LIMIT_BYTES, onlyKeys, sniffImage } from './http.ts';

export const LP_API_VERSION = 'lp-api/1';
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
  /** what the server may do; devnet with writes on when omitted */
  profile?: ServerProfile;
  /** Behind a hosting proxy every request comes from the proxy, so per-client rate limits need the header the proxy sets
   *  (Fly.io: fly-client-ip; X-Forwarded-For: the rightmost entry, the one the proxy added). Unset: the socket address. */
  clientIpHeader?: string;
}
/** The part of the cluster profile the HTTP layer needs (see cluster.ts). */
export type ServerProfile = Pick<ClusterProfile, 'cluster' | 'mode' | 'writes' | 'faucet' | 'label' | 'writesLockedBecause'>;
export const DEVNET_PROFILE: ServerProfile = Object.freeze({ cluster: 'devnet', mode: 'DEVNET', writes: true, faucet: true, label: 'Test network: coins here have no value',
  writesLockedBecause: [] });
/** Requests that build a transaction for someone to sign, send one, or move tokens. All refused while writes are locked. */
const WRITE_ROUTES = new Set(['POST /api/lp/launch', 'POST /api/lp/swap', 'POST /api/lp/submit', 'POST /api/lp/claim', 'POST /api/lp/treasury/propose',
  'POST /api/lp/treasury/approve', 'POST /api/lp/treasury/execute', 'POST /api/lp/faucet', 'POST /api/lp/rewards/deposit', 'POST /api/lp/rewards/payout']);

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

export const REWARDS_TTL_MS = 30_000;
const TX_INDEX = /^[1-9]\d{0,18}$/;
const TREASURY_REFRESH_PER_REQUEST = 5;
const FINAL_PROPOSAL = new Set(['Executed', 'Rejected', 'Cancelled']);

export function createLaunchpadApp(o: LaunchpadOptions): Server & { poolCache: PoolCache; dammCache: DammCache } {
  const now = o.now ?? (() => new Date());
  const profile = o.profile ?? DEVNET_PROFILE;
  const pools = new PoolCache(o.chain);
  const damms = new DammCache(o.chain);
  const rate = new Map<string, number[]>();
  let rewards: { at: number; coins: CoinRewards[] } | null = null;
  /** Every coin's reward epochs, recomputed from the stored history at most every REWARDS_TTL_MS (or on ?fresh=1). */
  const rewardCoins = async (fresh: boolean): Promise<CoinRewards[]> => {
    if (rewards && !fresh && now().getTime() - rewards.at < REWARDS_TTL_MS) return rewards.coins;
    const coins = await allCoinRewards({ store: o.store, chain: o.chain, platform: platform(), now, cluster: profile.cluster });
    rewards = { at: now().getTime(), coins };
    return coins;
  };
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
    live: liveView(await pools.get(l.pool, fresh).catch(() => null), l.status === 'MIGRATED', l.status === 'MIGRATED' ? await damms.get(l, fresh).catch(() => null) : null), stats: o.store.tradeStats(l.mint),
    history: (({ pending, unavailable }) => ({ complete: pending === 0 && unavailable === 0, pending, unavailable }))(o.store.backfillCounts(l.mint)),
  });
  /** What a wallet can claim on one coin: the creator's share of curve fees, and after graduation the fees of any DAMM v2
   *  position it holds (the creator's locked LP). */
  const claimable = async (l: LaunchRow, wallet: string, fresh: boolean) => {
    const isCreator = l.creator === wallet;
    const pool = isCreator ? await pools.get(l.pool, fresh) : null;
    const dp = l.status === 'MIGRATED' && l.dammPool ? await damms.get(l, fresh) : null;
    return { isCreator, curve: pool ? { quoteRaw: pool.creatorQuoteFee, baseRaw: pool.creatorBaseFee } : null, positions: dp ? await o.chain.dammPositions(dp, wallet) : [] };
  };
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
  const innerVenue = (inner: TreasuryInnerTerms): 'CURVE' | 'DAMM_V2' | 'REWARDS_DEPOSIT' | 'REWARDS_PAYOUT' =>
    (inner.kind === 'CLAIM_PARTNER_TRADING_FEE' ? 'CURVE' : inner.kind === 'DAMM_CLAIM_POSITION_FEE' ? 'DAMM_V2' : inner.kind);
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
    // a rewards deposit or payout is read back from the rewards vault's own history (rewards-vault.ts), not recorded here
    if (terms.inner.kind === 'REWARDS_DEPOSIT' || terms.inner.kind === 'REWARDS_PAYOUT') { rewards = null; return; }
    const l = o.store.getLaunch(row.mint);
    if (!l) return;
    if (terms.inner.kind === 'CLAIM_PARTNER_TRADING_FEE') pools.invalidate(l.pool); else if (l.dammPool) damms.invalidate(l.dammPool);
    // the receipt is the vault's: what left this claim's own pool vaults in the executing transaction, nothing else
    const id = await claimIdentity(terms.inner, l);
    o.store.insertClaim({ sig: signature, mint: l.mint, venue: terms.inner.kind === 'CLAIM_PARTNER_TRADING_FEE' ? 'CURVE' : 'DAMM_V2', claimer: terms.inner.feePayer, at: now().toISOString(), ...(id ?? {}) });
    if (id) o.store.setClaimEvidence(signature, claimReceipt(id, await o.chain.txSummary(signature).catch(() => null)));
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const method = req.method ?? 'GET';
    const ip = clientIp(req, o.clientIpHeader);
    if (path === '/api/lp/healthz' && method === 'GET') return send(res, 200, { ok: true, apiVersion: LP_API_VERSION, cluster: profile.cluster, mode: profile.mode });
    // one gate for everything that builds, sends or moves tokens: nothing below runs while writes are locked
    if (WRITE_ROUTES.has(`${method} ${path}`)) {
      if (path === '/api/lp/faucet' && !profile.faucet) throw new HttpError(404, 'NO_FAUCET', 'the faucet is off');
      if (!profile.writes) throw new HttpError(423, 'WRITES_LOCKED', 'launching, trading, claiming and treasury steps are switched off on this server', profile.writesLockedBecause);
    }

    if (path === '/api/lp/platform' && method === 'GET') {
      const p = o.platform();
      return send(res, 200, { apiVersion: LP_API_VERSION, cluster: profile.cluster, mode: profile.mode, writesEnabled: profile.writes, writesLockedBecause: profile.writesLockedBecause,
        label: profile.label, ready: !!p, operator: o.chain.operatorAddress,
        platform: p && { quote: p.quote, config: p.config.config, threshold: p.threshold, launchEconomics: p.launchEconomics, launchEconomicsDigest: p.launchEconomicsDigest },
        faucet: profile.faucet ? { quoteUi: FAUCET.quoteUi.toString(), lamports: FAUCET.lamports.toString(), claimsPerDay: FAUCET.claimsPerDay } : null });
    }

    if (path === '/api/lp/tokens' && method === 'GET') {
      const list = o.store.listLaunches(['LIVE', 'MIGRATED']);
      return send(res, 200, { tokens: await Promise.all(list.map((l) => tokenView(l))) });
    }
    if (path === '/api/lp/trades/recent' && method === 'GET') {
      return send(res, 200, { trades: o.store.listRecentTrades(30).map((t) => ({ sig: t.sig, mint: t.mint, symbol: t.symbol, trader: t.trader, side: t.side, quoteRaw: t.quoteRaw, blockTime: t.blockTime })) });
    }
    // Holder rewards (devnet), one coin: its holder history coverage and reward epochs (status, earmark from the fee
    // ledger, deposits, allocation, payout). Read-only: nothing here builds or sends a payout.
    const rc = /^\/api\/lp\/rewards\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (rc && method === 'GET') {
      limit(`rewards:${ip}`, 30);
      const coins = await rewardCoins(query.get('fresh') === '1');
      const c = coins.find((x) => x.mint === rc[1]);
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      const p = platform(), rv = await rewardsVaultOf(p), vcov = storedVaultCoverage(o);
      const view: RewardsVaultView | null = rv && p.treasury ? { multisig: rv.multisig, vault: rv.vault, quoteAccount: rv.quoteAccount,
        balanceRaw: await o.chain.balances(rv.vault, [rv.quoteMint]).then((b) => b.tokens[rv.quoteMint] ?? '0').catch(() => null),
        checkedToSlot: vcov?.account === rv.quoteAccount ? vcov.checkedToSlot : null, caughtUp: vcov?.account === rv.quoteAccount && vcov.caughtUp,
        untagged: o.store.listRewardVaultTxs(rv.quoteAccount).filter((r) => r.kind === 'UNTAGGED').map((r) => ({ sig: r.sig, deltaRaw: r.deltaRaw! })),
        threshold: p.treasury.threshold, members: p.treasury.members.length, signers: 'ONE_OPERATOR_TEST_KEYS' } : null;
      return send(res, 200, rewardsOverview(profile.cluster, [c], view));
    }
    const rm = /^\/api\/lp\/rewards\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(\d{4}-\d{2}-\d{2})(\/artifact\.json)?$/.exec(path);
    if (rm && method === 'GET') {
      limit(`rewards:${ip}`, 30);
      const c = (await rewardCoins(false)).find((x) => x.mint === rm[1]);
      const d = c && epochDetail(c, rm[2]!);
      if (!d) throw new HttpError(404, 'NOT_FOUND', 'no such coin or epoch');
      if (rm[3]) {
        if (!d.artifact) throw new HttpError(404, 'NOT_FOUND', 'this epoch has no artifact yet (it is still open)');
        const frozen = o.store.getRewardEpoch(rm[1]!, rm[2]!);
        return send(res, 200, frozen ? JSON.parse(frozen.artifactJson) : d.artifact);
      }
      return send(res, 200, d);
    }
    const tm = /^\/api\/lp\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
    if (tm && method === 'GET') {
      const l = o.store.getLaunch(tm[1]!);
      if (!l || l.status === 'PENDING' || l.status === 'FAILED') throw new HttpError(404, 'NOT_FOUND', 'token not found');
      return send(res, 200, { token: await tokenView(l, query.get('fresh') === '1'), trades: o.store.listTrades(l.mint).map(tradeView) });
    }
    // My coins: the coins a wallet launched with what it can claim on each, and the holder rewards paid to it. Read-only.
    if (path === '/api/lp/me' && method === 'GET') {
      const wallet = query.get('wallet');
      if (!wallet || !B58.test(wallet)) throw new HttpError(400, 'INVALID_REQUEST', 'wallet must be an address');
      limit(`me:${ip}`, 30);
      const fresh = query.get('fresh') === '1';
      const coins = [];
      for (const l of o.store.listLaunches(['LIVE', 'MIGRATED']).filter((x) => x.creator === wallet)) {
        const c = await claimable(l, wallet, fresh);
        coins.push({ token: await tokenView(l), curve: c.curve, positions: c.positions });
      }
      const p = o.platform(), rv = p ? await rewardsVaultOf(p) : null;
      const symbols = new Map(o.store.listLaunches(['LIVE', 'MIGRATED']).map((l) => [l.mint, l.symbol]));
      const rewardsPaid = (rv ? o.store.listRewardVaultTxs(rv.quoteAccount) : []).filter((r) => r.status === 'DONE' && r.kind === 'PAYOUT')
        .flatMap((r) => (JSON.parse(r.transfersJson ?? '[]') as { owner: string; amountRaw: string }[]).filter((x) => x.owner === wallet)
          .map((x) => ({ mint: r.mint!, symbol: symbols.get(r.mint!) ?? '?', epochId: r.epochId!, amountRaw: x.amountRaw, sig: r.sig, blockTime: r.blockTime })));
      return send(res, 200, { wallet, coins, rewardsPaid });
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
      return send(res, 200, { mint: l.mint, wallet, ...(await claimable(l, wallet, query.get('fresh') === '1')) });
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
        const chk = await bindStoredVaultTransaction(stored, { multisig: t.multisig, transactionIndex: index, vaultIndex: vaultIndexFor(inner), inner });
        if (chk.violations.length) throw new HttpError(409, 'STORED_TRANSACTION_MISMATCH', 'what the multisig stored is not the claim this app proposed', chk.violations);
        memberIntent('TREASURY_EXECUTE', m);
        const runVault = inner.kind === 'REWARDS_PAYOUT' ? (await rewardsVaultOf(p))!.vault : t.vault;
        const built = await o.chain.buildTreasuryExecute({ multisig: t.multisig, vault: runVault, member: m, transactionIndex: index, inner, stored });
        const intent = await storeBuilt('TREASURY_EXECUTE', row.mint, m, built, { vaultTransactionAccount: stored });
        return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, inner, proposal: st });
      }
      throw new HttpError(404, 'NOT_FOUND', 'no such route');
    }

    // ---------------------------------------------------------------- holder rewards: deposit and payout (devnet test round)
    // Both are treasury proposals: the server builds them unsigned for a member to check and sign, and two of three
    // members must approve before either runs. A deposit moves quote tokens from the treasury vault into the rewards vault
    // for one coin's running epoch, up to that epoch's earmark. A payout pays one final epoch exactly as its frozen record
    // allocates. What counts is read back from the rewards vault's own transactions, not from these routes.
    if ((path === '/api/lp/rewards/deposit' || path === '/api/lp/rewards/payout') && method === 'POST') {
      const p = platform();
      if (!p.treasury) throw new HttpError(409, 'NO_TREASURY', 'the platform treasury has not been set up');
      const t = p.treasury, rv = (await rewardsVaultOf(p))!;
      limit(`build:${ip}`, BUILDS_PER_MINUTE);
      const b = await readJson(req, BODY_LIMIT_BYTES);
      onlyKeys(b, path.endsWith('deposit') ? ['member', 'mint', 'epochId', 'amountRaw'] : ['member', 'mint', 'epochId']);
      const m = addr(b, 'member');
      if (!t.members.includes(m)) throw new HttpError(403, 'NOT_A_MEMBER', 'that wallet is not a member of the platform treasury');
      const l = o.store.getLaunch(addr(b, 'mint'));
      if (!l || (l.status !== 'LIVE' && l.status !== 'MIGRATED')) throw new HttpError(404, 'NOT_FOUND', 'token not found');
      const epochId = typeof b.epochId === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.epochId) ? b.epochId : (() => { throw new HttpError(400, 'INVALID_REQUEST', 'epochId must be YYYY-MM-DD'); })();
      const c = (await rewardCoins(true)).find((x) => x.mint === l.mint);
      const e = c?.epochs.find((x) => x.epochId === epochId);
      if (!e) throw new HttpError(404, 'NOT_FOUND', 'no such epoch for this coin');
      const open = o.store.listTreasuryProposals(t.multisig).filter((r) => r.status !== 'Rejected' && r.status !== 'Cancelled');
      const tagged = (venue: string) => open.filter((r) => r.venue === venue).map((r) => ({ r, inner: JSON.parse(r.innerJson) as { launchMint: string; epochId: string; amountRaw?: string } }));
      const base = { quoteMint: p.quote.mint, quoteDecimals: p.quote.decimals, quoteTokenProgram: PROGRAM_IDS.TOKEN, launchMint: l.mint, epochId };
      let inner;
      if (path.endsWith('deposit')) {
        const amountRaw = typeof b.amountRaw === 'string' && /^[1-9]\d{0,18}$/.test(b.amountRaw) ? b.amountRaw : (() => { throw new HttpError(400, 'INVALID_REQUEST', 'amountRaw must be a positive integer string'); })();
        if (epochId !== now().toISOString().slice(0, 10) || e.status !== 'OPEN') throw new HttpError(409, 'EPOCH_NOT_RUNNING', 'a deposit can only fund the epoch that is running now (it counts only if it lands before the epoch ends)');
        const deposited = e.funding.deposits.reduce((s, d) => s + BigInt(d.amountRaw), 0n);
        const pending = tagged('REWARDS_DEPOSIT').filter((x) => x.r.status !== 'Executed' && x.inner.launchMint === l.mint && x.inner.epochId === epochId).reduce((s, x) => s + BigInt(x.inner.amountRaw ?? '0'), 0n);
        const room = BigInt(e.funding.earmarkedRaw) - deposited - pending;
        if (BigInt(amountRaw) > room) throw new HttpError(409, 'OVER_EARMARK', `a deposit may not exceed the epoch's earmark: ${room > 0n ? room : 0n} raw left (earmark ${e.funding.earmarkedRaw}, deposited ${deposited}, proposed ${pending})`);
        const held = BigInt((await o.chain.balances(t.vault, [p.quote.mint])).tokens[p.quote.mint] ?? '0');
        if (BigInt(amountRaw) > held) throw new HttpError(409, 'TREASURY_SHORT', `the treasury vault holds ${held} raw`);
        inner = { ...base, kind: 'REWARDS_DEPOSIT' as const, from: t.vault, to: rv.vault, amountRaw };
      } else {
        const payouts = e.result?.payouts ?? [];
        if (e.status !== 'FINAL' || !e.frozen?.reproduced) throw new HttpError(409, 'EPOCH_NOT_FINAL', 'only a final epoch whose frozen record recomputes identically can be paid');
        if (!payouts.length) throw new HttpError(409, 'NOTHING_TO_PAY', 'this epoch allocates nothing (nothing was deposited for it)');
        if (e.settlement.status !== 'NOT_PAID') throw new HttpError(409, 'ALREADY_PAID', `settlement is ${e.settlement.status}`);
        const rounds = new Set([...tagged('REWARDS_PAYOUT').map((x) => `${x.inner.launchMint}:${x.inner.epochId}`)]);
        if (rounds.has(`${l.mint}:${epochId}`)) throw new HttpError(409, 'ALREADY_PROPOSED', 'a payout for this epoch is already proposed');
        if (rounds.size >= DEVNET_TEST_PAYOUT_ROUNDS) throw new HttpError(409, 'ROUND_LIMIT', `the owner approved ${DEVNET_TEST_PAYOUT_ROUNDS} devnet test round; another needs the owner's word`);
        if (payouts.length > MAX_REWARD_PAYOUTS_PER_TX) throw new HttpError(409, 'TOO_MANY_RECIPIENTS', `one payout proposal pays at most ${MAX_REWARD_PAYOUTS_PER_TX} holders`);
        const total = payouts.reduce((s, x) => s + x.amountRaw, 0n);
        const held = BigInt((await o.chain.balances(rv.vault, [p.quote.mint])).tokens[p.quote.mint] ?? '0');
        if (total > held) throw new HttpError(409, 'REWARDS_VAULT_SHORT', `the rewards vault holds ${held} raw, the payout is ${total}`);
        inner = { ...base, kind: 'REWARDS_PAYOUT' as const, from: rv.vault, artifactHash: e.frozen.hash, payouts: payouts.map((x) => ({ owner: x.owner, amountRaw: x.amountRaw.toString() })) };
      }
      // the operator pays rent for any missing quote account (the rewards vault's, or a recipient's); no tokens move
      const accounts = await o.chain.ensureQuoteAccounts(inner.kind === 'REWARDS_DEPOSIT' ? [rv.vault] : inner.payouts.map((x) => x.owner), p.quote.mint);
      intentCheck({ kind: 'TREASURY_PROPOSE', signer: { role: 'TREASURY_MEMBER', address: m, serverHeld: false }, feePayer: m });
      const built = await o.chain.buildTreasuryPropose(t.multisig, inner.from, m, { venue: 'REWARDS', inner });
      const intent = await storeBuilt('TREASURY_PROPOSE', l.mint, m, built);
      return send(res, 201, { intentId: intent.id, expiresAt: intent.expiresAt, transaction: toBase64(built.bytes), terms: built.terms, transactionIndex: built.transactionIndex,
        amounts: built.amounts, rewardsVault: rv.vault, accountsCreated: accounts });
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

  const server = createServer(async (req, res) => {
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
      // The public devnet RPC rate-limits bursts; that is a retryable outage, not a server fault.
      const rpcBusy = !(e instanceof HttpError) && /\b429\b|Too Many Requests|rate limit/i.test((e as Error)?.message ?? '');
      const err = e instanceof HttpError ? e : rpcBusy ? new HttpError(503, 'RPC_BUSY', 'the devnet RPC is busy; try again in a few seconds') : new HttpError(500, 'INTERNAL', 'internal error');
      if (!(e instanceof HttpError)) o.log?.(rpcBusy ? `rpc busy on ${path}` : `internal error: ${(e as Error)?.stack?.slice(0, 800)}`);
      send(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
  }) as Server & { poolCache: PoolCache; dammCache: DammCache };
  server.poolCache = pools;
  server.dammCache = damms;
  return server;
}
