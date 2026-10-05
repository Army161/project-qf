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

/** Passes in which a signature's transaction details were not available yet (an RPC can list a signature before it
 *  serves the transaction). Bounded so one transaction the RPC never returns cannot stall a coin's history forever. */
const missingSummary = new Map<string, number>();
export const MAX_SUMMARY_RETRIES = 5;

/** Records trades for signatures in order. The cursor only moves past a signature once it has been read (or has
 *  failed on chain), so a transaction whose details are not served yet is retried on the next pass, not skipped. */
async function walk(d: IndexerDeps, launch: LaunchRow, pool: Pick<LivePool, 'baseVault' | 'quoteVault'>,
  sigs: { signature: string; err: boolean }[], setCursor: (sig: string) => void): Promise<number> {
  let trades = 0;
  for (const s of sigs) {
    if (!s.err) {
      const sum = await d.chain.txSummary(s.signature);
      if (!sum) {
        const n = (missingSummary.get(s.signature) ?? 0) + 1;
        if (n < MAX_SUMMARY_RETRIES) { missingSummary.set(s.signature, n); break; }
        missingSummary.delete(s.signature);
        d.log?.(`index ${launch.symbol}: no transaction details for ${s.signature} after ${n} passes; moving on`);
      } else {
        missingSummary.delete(s.signature);
        const t = tradeFromSummary(launch, pool, sum, 'indexer');
        if (t && d.store.insertTrade(t)) trades++;
      }
    }
    setCursor(s.signature);
  }
  return trades;
}

/** Pulls new pool signatures since the last indexed one and records trades; detects completion and migration. */
export async function syncLaunch(d: IndexerDeps, launch: LaunchRow): Promise<{ trades: number }> {
  const pool = await d.poolCache.get(launch.pool, true);
  if (!pool) return { trades: 0 };
  const sigs = await d.chain.newSignatures(launch.pool, launch.lastIndexedSig);
  const trades = await walk(d, launch, pool, sigs, (sig) => d.store.setLastIndexed(launch.mint, sig));
  if (pool.isMigrated && launch.status !== 'MIGRATED') {
    d.store.markLaunchMigrated(launch.mint, null, await d.chain.dammPoolFor(launch.mint, launch.quoteMint), (d.now ?? (() => new Date()))().toISOString());
  }
  return { trades };
}

/** After graduation: pulls new DAMM v2 pool signatures and records trades from that pool's vault deltas. */
export async function syncDamm(d: IndexerDeps, launch: LaunchRow): Promise<{ trades: number }> {
  if (!launch.dammPool || !d.dammCache) return { trades: 0 };
  const pool = await d.dammCache.get(launch, true);
  if (!pool) return { trades: 0 };
  const sigs = await d.chain.newSignatures(launch.dammPool, launch.lastDammIndexedSig);
  const trades = await walk(d, launch, pool, sigs, (sig) => d.store.setLastDammIndexed(launch.mint, sig));
  return { trades };
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
      d.store.markLaunchMigrated(launch.mint, signature, await d.chain.dammPoolFor(launch.mint, launch.quoteMint), (d.now ?? (() => new Date()))().toISOString());
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
        if (l.status === 'MIGRATED' && l.lastIndexedSig) continue;
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
