// Trade indexer and migration crank. Trades are derived from the pool's own vault balance deltas in each confirmed
// transaction (program-agnostic: a trade made outside this app is indexed the same way). The crank migrates a
// completed curve to DAMM v2 with the operator key; on-chain, migration is permissionless and the DBC program itself
// refuses an incomplete curve, so the crank's read is not a safety decision.
import type { LaunchpadChain, LiveDammPool, LivePool, TxSummary } from './chain.ts';
import type { LaunchRow, LaunchpadStore, TradeRow } from './store.ts';

export function tradeFromSummary(launch: Pick<LaunchRow, 'mint'>, pool: Pick<LivePool, 'baseVault' | 'quoteVault'>, s: TxSummary, source: string): TradeRow | null {
  if (s.err) return null;
  const dq = s.tokenDeltas[pool.quoteVault] ?? 0n, db = s.tokenDeltas[pool.baseVault] ?? 0n;
  let side: TradeRow['side'];
  if (dq > 0n && db < 0n) side = 'BUY';
  else if (dq < 0n && db > 0n) side = 'SELL';
  else return null; // pool creation, migration, fee claims: not trades
  const abs = (x: bigint) => (x < 0n ? -x : x);
  return { sig: s.signature, mint: launch.mint, trader: s.feePayer, side, quoteRaw: abs(dq).toString(), baseRaw: abs(db).toString(), slot: s.slot,
    blockTime: s.blockTime, source };
}

export interface IndexerDeps { store: LaunchpadStore; chain: LaunchpadChain; poolCache: PoolCache; dammCache?: DammCache; log?: (m: string) => void; now?: () => Date }

/** Retry schedule for transactions the RPC listed but did not serve. The first `fastAttempts` lookups happen on
 *  consecutive passes (an RPC usually serves a new transaction within seconds); after that the delay doubles up to
 *  `maxDelayMs`. After `maxAttempts` the transaction is marked UNAVAILABLE: still counted as missing history and still
 *  retried, every `unavailableRetryMs`. Nothing is ever dropped silently. */
export const BACKFILL = Object.freeze({ fastAttempts: 5, baseDelayMs: 15_000, maxDelayMs: 3_600_000, maxAttempts: 20, unavailableRetryMs: 6 * 3_600_000, perPass: 10 });
type Venue = 'CURVE' | 'DAMM_V2';
const nowOf = (d: IndexerDeps) => (d.now ?? (() => new Date()))();

function recordTrade(d: IndexerDeps, launch: LaunchRow, pool: Pick<LivePool, 'baseVault' | 'quoteVault'>, sum: TxSummary): { outcome: 'TRADE' | 'NOT_A_TRADE' | 'FAILED_TX'; inserted: boolean } {
  if (sum.err) return { outcome: 'FAILED_TX', inserted: false };
  const t = tradeFromSummary(launch, pool, sum, 'indexer');
  return t ? { outcome: 'TRADE', inserted: d.store.insertTrade(t) } : { outcome: 'NOT_A_TRADE', inserted: false };
}

/** Records trades for new signatures in order and moves the cursor past each one. A signature whose details the RPC
 *  does not serve yet goes into the durable backfill queue, so newer trades keep indexing and nothing is lost. */
async function walk(d: IndexerDeps, launch: LaunchRow, venue: Venue, pool: Pick<LivePool, 'baseVault' | 'quoteVault'>,
  sigs: { signature: string; err: boolean }[], setCursor: (sig: string) => void): Promise<number> {
  let trades = 0;
  for (const s of sigs) {
    if (!s.err) {
      const sum = await d.chain.txSummary(s.signature);
      if (!sum) d.store.queueBackfill({ sig: s.signature, venue, mint: launch.mint, at: nowOf(d).toISOString() });
      else if (recordTrade(d, launch, pool, sum).inserted) trades++;
    }
    setCursor(s.signature);
  }
  return trades;
}

/** Retries this coin's queued transactions that are due. Returns the trades recovered. */
async function retryBackfill(d: IndexerDeps, launch: LaunchRow, venue: Venue): Promise<number> {
  const now = nowOf(d);
  const due = d.store.dueBackfill(launch.mint, venue, now.toISOString(), BACKFILL.perPass);
  if (!due.length) return 0;
  const pool = venue === 'CURVE' ? await d.poolCache.get(launch.pool) : d.dammCache ? await d.dammCache.get(launch) : null;
  if (!pool) return 0; // without the pool's vaults a transaction cannot be classified; try again next pass
  let trades = 0;
  for (const b of due) {
    const sum = await d.chain.txSummary(b.sig);
    if (sum) {
      const r = recordTrade(d, launch, pool, sum);
      d.store.resolveBackfill(b.sig, venue, r.outcome, now.toISOString());
      if (r.inserted) trades++;
      if (b.attempts >= BACKFILL.fastAttempts) d.log?.(`index ${launch.symbol}: recovered ${b.sig} after ${b.attempts} attempts (${r.outcome})`);
      continue;
    }
    const attempts = b.attempts + 1;
    const unavailable = attempts >= BACKFILL.maxAttempts;
    const delay = unavailable ? BACKFILL.unavailableRetryMs
      : attempts < BACKFILL.fastAttempts ? 0 : Math.min(BACKFILL.baseDelayMs * 2 ** (attempts - BACKFILL.fastAttempts), BACKFILL.maxDelayMs);
    d.store.backfillMissed(b.sig, venue, { status: unavailable ? 'UNAVAILABLE' : 'PENDING', attempts, at: now.toISOString(), nextTry: new Date(now.getTime() + delay).toISOString() });
    if (unavailable && b.status !== 'UNAVAILABLE') {
      d.log?.(`index ${launch.symbol}: transaction ${b.sig} still not served after ${attempts} attempts; marked unavailable (trade history shows it as missing; retried every ${BACKFILL.unavailableRetryMs / 3_600_000} h)`);
    }
  }
  return trades;
}

/** Pulls new pool signatures since the last indexed one and records trades; detects completion and migration. */
export async function syncLaunch(d: IndexerDeps, launch: LaunchRow): Promise<{ trades: number }> {
  const pool = await d.poolCache.get(launch.pool, true);
  if (!pool) return { trades: 0 };
  // queued transactions first, so one queued in this pass waits for the next
  const recovered = await retryBackfill(d, launch, 'CURVE');
  const sigs = await d.chain.newSignatures(launch.pool, launch.lastIndexedSig);
  const trades = await walk(d, launch, 'CURVE', pool, sigs, (sig) => d.store.setLastIndexed(launch.mint, sig));
  if (pool.isMigrated && launch.status !== 'MIGRATED') {
    d.store.markLaunchMigrated(launch.mint, null, await d.chain.dammPoolFor(launch.mint, launch.quoteMint), nowOf(d).toISOString());
  }
  return { trades: recovered + trades };
}

/** After graduation: pulls new DAMM v2 pool signatures and records trades from that pool's vault deltas. */
export async function syncDamm(d: IndexerDeps, launch: LaunchRow): Promise<{ trades: number }> {
  if (!launch.dammPool || !d.dammCache) return { trades: 0 };
  const pool = await d.dammCache.get(launch, true);
  if (!pool) return { trades: 0 };
  const recovered = await retryBackfill(d, launch, 'DAMM_V2');
  const sigs = await d.chain.newSignatures(launch.dammPool, launch.lastDammIndexedSig);
  const trades = await walk(d, launch, 'DAMM_V2', pool, sigs, (sig) => d.store.setLastDammIndexed(launch.mint, sig));
  return { trades: recovered + trades };
}

/** A graduated coin's finished curve gets no new trades, but transactions queued before graduation are still retried. */
export async function backfillCurve(d: IndexerDeps, launch: LaunchRow): Promise<{ trades: number }> {
  return { trades: await retryBackfill(d, launch, 'CURVE') };
}

/** Migrates every LIVE launch whose curve is complete. Returns the migrations it sent. */
export async function crankMigrations(d: IndexerDeps): Promise<{ mint: string; signature: string }[]> {
  if (!d.chain.operatorAddress) return [];
  const out: { mint: string; signature: string }[] = [];
  for (const launch of d.store.listLaunches(['LIVE'])) {
    // A failed read of one pool (public RPCs occasionally return a bad account) must not stop the loop or the server.
    const pool = await d.poolCache.get(launch.pool, true).catch((e) => { d.log?.(`crank read ${launch.mint}: ${(e as Error).message.slice(0, 200)}`); return null; });
    if (!pool || pool.isMigrated || !pool.curveComplete) continue;
    try {
      d.log?.(`migrating ${launch.symbol} (${launch.mint}) to DAMM v2`);
      const signature = await d.chain.migrate(launch.pool);
      d.store.markLaunchMigrated(launch.mint, signature, await d.chain.dammPoolFor(launch.mint, launch.quoteMint), nowOf(d).toISOString());
      d.poolCache.invalidate(launch.pool);
      out.push({ mint: launch.mint, signature });
    } catch (e) {
      d.log?.(`migration of ${launch.mint} failed: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  return out;
}

/** Short-lived cache of live pool reads so list views do not hammer the RPC. */
export class PoolCache {
  private m = new Map<string, { at: number; v: LivePool | null }>();
  private chain: LaunchpadChain; private ttlMs: number; private now: () => number;
  constructor(chain: LaunchpadChain, ttlMs = 4_000, now: () => number = Date.now) { this.chain = chain; this.ttlMs = ttlMs; this.now = now; }
  async get(pool: string, fresh = false): Promise<LivePool | null> {
    const hit = this.m.get(pool);
    if (!fresh && hit && this.now() - hit.at < this.ttlMs) return hit.v;
    const v = await this.chain.readPool(pool);
    this.m.set(pool, { at: this.now(), v });
    return v;
  }
  invalidate(pool: string) { this.m.delete(pool); }
}

/** The same short-lived cache for graduated launches' DAMM v2 pools. */
export class DammCache {
  private m = new Map<string, { at: number; v: LiveDammPool | null }>();
  private chain: LaunchpadChain; private ttlMs: number; private now: () => number;
  constructor(chain: LaunchpadChain, ttlMs = 4_000, now: () => number = Date.now) { this.chain = chain; this.ttlMs = ttlMs; this.now = now; }
  async get(l: Pick<LaunchRow, 'dammPool' | 'mint' | 'quoteMint'>, fresh = false): Promise<LiveDammPool | null> {
    if (!l.dammPool) return null;
    const hit = this.m.get(l.dammPool);
    if (!fresh && hit && this.now() - hit.at < this.ttlMs) return hit.v;
    const v = await this.chain.readDammPool(l.dammPool, { baseMint: l.mint, quoteMint: l.quoteMint });
    this.m.set(l.dammPool, { at: this.now(), v });
    return v;
  }
  invalidate(pool: string) { this.m.delete(pool); }
}

/** Background loop: index and crank every `intervalMs`, one pass at a time. */
export function startBackground(d: IndexerDeps, intervalMs = 15_000): () => void {
  let stopped = false, running = false;
  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const l of d.store.listLaunches(['LIVE', 'MIGRATED'])) {
        if (l.status === 'MIGRATED' && l.dammPool) await syncDamm(d, l).catch((e) => d.log?.(`index damm ${l.mint}: ${(e as Error).message.slice(0, 200)}`));
        if (l.status === 'MIGRATED' && l.lastIndexedSig) { await backfillCurve(d, l).catch((e) => d.log?.(`backfill ${l.mint}: ${(e as Error).message.slice(0, 200)}`)); continue; }
        await syncLaunch(d, l).catch((e) => d.log?.(`index ${l.mint}: ${(e as Error).message.slice(0, 200)}`));
      }
      await crankMigrations(d);
    } catch (e) {
      d.log?.(`background pass failed: ${(e as Error).message.slice(0, 200)}`);
    } finally { running = false; }
  };
  const t = setInterval(pass, intervalMs);
  void pass();
  return () => { stopped = true; clearInterval(t); };
}
