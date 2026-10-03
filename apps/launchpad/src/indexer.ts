// Trade indexer and migration crank. Trades are derived from the pool's own vault balance deltas in each confirmed
// transaction (program-agnostic: a trade made outside this app is indexed the same way). The crank migrates a
// completed curve to DAMM v2 with the operator key; on-chain, migration is permissionless and the DBC program itself
// refuses an incomplete curve, so the crank's read is not a safety decision.
import type { LaunchpadChain, LivePool, TxSummary } from './chain.ts';
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

export interface IndexerDeps { store: LaunchpadStore; chain: LaunchpadChain; poolCache: PoolCache; log?: (m: string) => void; now?: () => Date }

/** Pulls new pool signatures since the last indexed one and records trades; detects completion and migration. */
export async function syncLaunch(d: IndexerDeps, launch: LaunchRow): Promise<{ trades: number }> {
  const pool = await d.poolCache.get(launch.pool, true);
  if (!pool) return { trades: 0 };
  let trades = 0;
  const sigs = await d.chain.newSignatures(launch.pool, launch.lastIndexedSig);
  for (const s of sigs) {
    if (!s.err) {
      const sum = await d.chain.txSummary(s.signature);
      const t = sum && tradeFromSummary(launch, pool, sum, 'indexer');
      if (t && d.store.insertTrade(t)) trades++;
    }
    d.store.setLastIndexed(launch.mint, s.signature);
  }
  if (pool.isMigrated && launch.status !== 'MIGRATED') {
    d.store.markLaunchMigrated(launch.mint, null, await d.chain.dammPoolFor(launch.mint, launch.quoteMint), (d.now ?? (() => new Date()))().toISOString());
  }
  return { trades };
}

/** Migrates every LIVE launch whose curve is complete. Returns the migrations it sent. */
export async function crankMigrations(d: IndexerDeps): Promise<{ mint: string; signature: string }[]> {
  if (!d.chain.operatorAddress) return [];
  const out: { mint: string; signature: string }[] = [];
  for (const launch of d.store.listLaunches(['LIVE'])) {
    const pool = await d.poolCache.get(launch.pool, true);
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

/** Background loop: index and crank every `intervalMs`, one pass at a time. */
export function startBackground(d: IndexerDeps, intervalMs = 15_000): () => void {
  let stopped = false, running = false;
  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const l of d.store.listLaunches(['LIVE', 'MIGRATED'])) {
        if (l.status === 'MIGRATED' && l.lastIndexedSig) continue;
        await syncLaunch(d, l).catch((e) => d.log?.(`index ${l.mint}: ${(e as Error).message.slice(0, 200)}`));
      }
      await crankMigrations(d);
    } finally { running = false; }
  };
  const t = setInterval(pass, intervalMs);
  void pass();
  return () => { stopped = true; clearInterval(t); };
}
