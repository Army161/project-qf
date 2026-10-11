// Launchpad persistence on node:sqlite: the platform record (test quote + DBC config), launches with their metadata and
// image, indexed trades with the fees each paid and the queue of transactions still to be read, built-transaction intents (exact message bytes
// the browser must sign), fee-claim receipts and faucet claims.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { FeeEvidence, FeeStatus, TradeFees } from './fees.ts';

export const STORE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE platform (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE launches (mint TEXT PRIMARY KEY, pool TEXT NOT NULL UNIQUE, config TEXT NOT NULL, quote_mint TEXT NOT NULL, creator TEXT NOT NULL,
     name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL, website TEXT, twitter TEXT, telegram TEXT,
     image_type TEXT, image BLOB, metadata_uri TEXT NOT NULL, status TEXT NOT NULL, create_sig TEXT, created_at TEXT NOT NULL, live_at TEXT,
     migration_sig TEXT, damm_pool TEXT, migrated_at TEXT, last_indexed_sig TEXT);
   CREATE INDEX launches_status ON launches(status, created_at);
   CREATE TABLE trades (sig TEXT PRIMARY KEY, mint TEXT NOT NULL REFERENCES launches(mint), trader TEXT NOT NULL, side TEXT NOT NULL,
     quote_raw TEXT NOT NULL, base_raw TEXT NOT NULL, slot INTEGER NOT NULL, block_time INTEGER, source TEXT NOT NULL);
   CREATE INDEX trades_mint ON trades(mint, slot);
   CREATE TABLE intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mint TEXT, user TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
     message_hex TEXT NOT NULL, terms_json TEXT NOT NULL, last_valid_block_height INTEGER NOT NULL, status TEXT NOT NULL, signature TEXT, error TEXT);
   CREATE TABLE faucet_claims (wallet TEXT NOT NULL, at TEXT NOT NULL, signature TEXT NOT NULL);
   CREATE INDEX faucet_wallet ON faucet_claims(wallet, at);`,
  // after graduation the launch trades on its DAMM v2 pool, indexed separately from the curve
  `ALTER TABLE launches ADD COLUMN last_damm_indexed_sig TEXT;`,
  // fee claims made through the app, with the amounts paid out (from the confirmed transaction) as receipts
  `CREATE TABLE claims (sig TEXT PRIMARY KEY, mint TEXT NOT NULL REFERENCES launches(mint), venue TEXT NOT NULL, claimer TEXT NOT NULL,
     quote_raw TEXT, base_raw TEXT, at TEXT NOT NULL);
   CREATE INDEX claims_mint ON claims(mint, at);
   INSERT OR IGNORE INTO claims (sig, mint, venue, claimer, quote_raw, base_raw, at)
     SELECT signature, mint, CASE kind WHEN 'DAMM_CLAIM_POSITION_FEE' THEN 'DAMM_V2' ELSE 'CURVE' END, user, NULL, NULL, created_at
     FROM intents WHERE status = 'CONFIRMED' AND signature IS NOT NULL AND mint IS NOT NULL AND kind IN ('CLAIM_CREATOR_TRADING_FEE', 'DAMM_CLAIM_POSITION_FEE');`,
  // (4) transactions the RPC listed but did not serve yet: kept until read, so history is never silently dropped; and
  // each claim receipt's own pool and vaults, with an evidence status. Earlier amounts were computed against whichever
  // pools happened to be readable, so they are kept for the record and every receipt is re-read from its transaction.
  `CREATE TABLE trade_backfill (sig TEXT NOT NULL, venue TEXT NOT NULL, mint TEXT NOT NULL REFERENCES launches(mint), status TEXT NOT NULL,
     attempts INTEGER NOT NULL, first_seen TEXT NOT NULL, last_tried TEXT NOT NULL, next_try TEXT NOT NULL, outcome TEXT, resolved_at TEXT,
     PRIMARY KEY (sig, venue));
   CREATE INDEX trade_backfill_due ON trade_backfill(status, next_try);
   CREATE INDEX trade_backfill_mint ON trade_backfill(mint, status);
   ALTER TABLE claims ADD COLUMN pool TEXT;
   ALTER TABLE claims ADD COLUMN quote_vault TEXT;
   ALTER TABLE claims ADD COLUMN base_vault TEXT;
   ALTER TABLE claims ADD COLUMN status TEXT NOT NULL DEFAULT 'UNKNOWN';
   ALTER TABLE claims ADD COLUMN evidence TEXT;
   ALTER TABLE claims ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE claims ADD COLUMN legacy_quote_raw TEXT;
   ALTER TABLE claims ADD COLUMN legacy_base_raw TEXT;
   UPDATE claims SET legacy_quote_raw = quote_raw, legacy_base_raw = base_raw, quote_raw = NULL, base_raw = NULL, status = 'UNKNOWN', evidence = 'RECHECK_LEGACY';`,
  // (5) platform treasury (Squads multisig) fee-claim proposals: what was proposed (the vault's claim terms), who has
  // approved it so far, and the transaction that executed it. The chain is the authority; this is the app's record.
  `CREATE TABLE treasury_proposals (multisig TEXT NOT NULL, tx_index TEXT NOT NULL, mint TEXT NOT NULL REFERENCES launches(mint), venue TEXT NOT NULL,
     inner_json TEXT NOT NULL, proposer TEXT NOT NULL, propose_sig TEXT NOT NULL, approvals_json TEXT NOT NULL, status TEXT NOT NULL,
     execute_sig TEXT, executed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (multisig, tx_index));
   CREATE INDEX treasury_proposals_status ON treasury_proposals(status, created_at);`,
  // (6) each trade's fees, from the swap event in its own transaction: who paid what, and where it went. Trades
  // recorded before this have fee_status NULL and are read again by the indexer (a few per pass).
  `ALTER TABLE trades ADD COLUMN venue TEXT;
   ALTER TABLE trades ADD COLUMN fee_status TEXT;
   ALTER TABLE trades ADD COLUMN fee_evidence TEXT;
   ALTER TABLE trades ADD COLUMN fee_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE trades ADD COLUMN fee_total_raw TEXT;
   ALTER TABLE trades ADD COLUMN fee_protocol_raw TEXT;
   ALTER TABLE trades ADD COLUMN fee_referral_raw TEXT;
   ALTER TABLE trades ADD COLUMN fee_creator_raw TEXT;
   ALTER TABLE trades ADD COLUMN fee_platform_raw TEXT;
   ALTER TABLE trades ADD COLUMN fee_lp_raw TEXT;
   ALTER TABLE trades ADD COLUMN fee_compounding_raw TEXT;
   CREATE INDEX trades_trader ON trades(trader, slot);
   CREATE INDEX trades_fee_status ON trades(fee_status);`,
  // (7) holder balance history for rewards: each coin's token accounts (with a signature cursor each), the transactions
  // read for the coin, every token-account balance change they contain (trades, direct transfers, anything), the
  // finalized first slot of each UTC epoch, and the frozen artifact of each final reward epoch.
  `CREATE TABLE holder_accounts (mint TEXT NOT NULL REFERENCES launches(mint), account TEXT NOT NULL, cursor TEXT, discovered_at TEXT NOT NULL,
     PRIMARY KEY (mint, account));
   CREATE TABLE holder_txs (mint TEXT NOT NULL REFERENCES launches(mint), sig TEXT NOT NULL, slot INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL,
     updated_at TEXT NOT NULL, PRIMARY KEY (mint, sig));
   CREATE INDEX holder_txs_status ON holder_txs(mint, status);
   CREATE TABLE holder_changes (mint TEXT NOT NULL REFERENCES launches(mint), sig TEXT NOT NULL, slot INTEGER NOT NULL, block_time INTEGER,
     account TEXT NOT NULL, owner TEXT NOT NULL, pre_raw TEXT NOT NULL, post_raw TEXT NOT NULL, PRIMARY KEY (mint, sig, account));
   CREATE INDEX holder_changes_slot ON holder_changes(mint, slot);
   CREATE TABLE epoch_slots (start_sec INTEGER PRIMARY KEY, slot INTEGER NOT NULL, block_time INTEGER NOT NULL);
   CREATE TABLE reward_epochs (mint TEXT NOT NULL REFERENCES launches(mint), epoch_id TEXT NOT NULL, artifact_json TEXT NOT NULL, artifact_hash TEXT NOT NULL,
     finalized_at TEXT NOT NULL, PRIMARY KEY (mint, epoch_id));`,
  // (8) the rewards vault's own history: every finalized transaction that changed its quote balance, classified from that
  // transaction's balances and memo (a deposit for one coin's epoch, a payout of one epoch, or untagged).
  `CREATE TABLE reward_vault_txs (sig TEXT PRIMARY KEY, account TEXT NOT NULL, slot INTEGER, block_time INTEGER, status TEXT NOT NULL, kind TEXT,
     mint TEXT, epoch_id TEXT, artifact_hash TEXT, delta_raw TEXT, transfers_json TEXT, memo TEXT, attempts INTEGER NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX reward_vault_txs_epoch ON reward_vault_txs(mint, epoch_id);`,
];

export type LaunchStatus = 'PENDING' | 'LIVE' | 'MIGRATED' | 'FAILED';
export interface LaunchRow {
  mint: string; pool: string; config: string; quoteMint: string; creator: string; name: string; symbol: string; description: string;
  website: string | null; twitter: string | null; telegram: string | null; imageType: string | null; metadataUri: string; status: LaunchStatus;
  createSig: string | null; createdAt: string; liveAt: string | null; migrationSig: string | null; dammPool: string | null; migratedAt: string | null;
  lastIndexedSig: string | null; lastDammIndexedSig: string | null;
}
/** A fee claim made through the app. `quoteRaw`/`baseRaw` are set only from complete evidence (status RESOLVED or
 *  FAILED_TX); while status is UNKNOWN they are null and `evidence` says what is missing. */
export type ClaimStatus = 'UNKNOWN' | 'RESOLVED' | 'FAILED_TX';
export interface ClaimRow { sig: string; mint: string; venue: 'CURVE' | 'DAMM_V2'; claimer: string; quoteRaw: string | null; baseRaw: string | null; at: string;
  pool: string | null; quoteVault: string | null; baseVault: string | null; status: ClaimStatus; evidence: string | null; attempts: number;
  legacyQuoteRaw: string | null; legacyBaseRaw: string | null }
/** A new receipt always starts UNKNOWN: amounts come only from its transaction (setClaimEvidence), never from the caller. */
export type NewClaim = Pick<ClaimRow, 'sig' | 'mint' | 'venue' | 'claimer' | 'at'> & Partial<Pick<ClaimRow, 'pool' | 'quoteVault' | 'baseVault'>> & { quoteRaw?: null; baseRaw?: null };
export type BackfillStatus = 'PENDING' | 'UNAVAILABLE' | 'RESOLVED';
export interface BackfillRow { sig: string; venue: 'CURVE' | 'DAMM_V2'; mint: string; status: BackfillStatus; attempts: number; firstSeen: string; lastTried: string;
  nextTry: string; outcome: 'TRADE' | 'NOT_A_TRADE' | 'FAILED_TX' | null; resolvedAt: string | null }
/** ACTIVE: proposed, waiting for approvals. APPROVED: threshold reached. EXECUTED: the vault's claim ran. Mirrors the
 *  on-chain proposal status the app last observed; anything else seen on chain (rejected, cancelled) is recorded as is. */
export interface TreasuryProposalRow { multisig: string; txIndex: string; mint: string; venue: 'CURVE' | 'DAMM_V2' | 'REWARDS_DEPOSIT' | 'REWARDS_PAYOUT'; innerJson: string; proposer: string;
  proposeSig: string; approvals: string[]; status: string; executeSig: string | null; executedBy: string | null; createdAt: string; updatedAt: string }
export interface TradeRow { sig: string; mint: string; trader: string; side: 'BUY' | 'SELL'; quoteRaw: string; baseRaw: string; slot: number; blockTime: number | null; source: string;
  /** what this trade paid in fees; absent or null when not read yet */
  fees?: TradeFees | null }
/** A stored trade: its fee columns flattened (fee_status NULL = not read yet). */
export interface StoredTrade extends Omit<TradeRow, 'fees'> {
  venue: TradeFees['venue']; feeStatus: FeeStatus | null; feeEvidence: FeeEvidence | null; feeAttempts: number; feeTotalRaw: string | null; feeProtocolRaw: string | null;
  feeReferralRaw: string | null; feeCreatorRaw: string | null; feePlatformRaw: string | null; feeLpRaw: string | null; feeCompoundingRaw: string | null }
/** Fee totals of a group of trades (a wallet, a coin, or a wallet on one coin), quote raw. Only RESOLVED fees are added;
 *  `unknownTrades` counts the trades whose fees are not proven yet, which are never added as 0. */
export interface FeeTotals { trades: number; volumeQuoteRaw: string; feesRaw: string; creatorRaw: string; platformRaw: string; lpRaw: string; protocolRaw: string;
  referralRaw: string; compoundingRaw: string; unknownTrades: number }
export interface IntentRow { id: string; kind: string; mint: string | null; user: string; createdAt: string; expiresAt: string; messageHex: string;
  termsJson: string; lastValidBlockHeight: number; status: 'BUILT' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'; signature: string | null; error: string | null }

const treasuryRow = (r: Record<string, unknown>): TreasuryProposalRow => {
  const { approvalsJson, ...rest } = camel(r) as Record<string, unknown>;
  return { ...rest, approvals: JSON.parse(String(approvalsJson)) as string[] } as unknown as TreasuryProposalRow;
};
export function sumFees(ts: StoredTrade[]): FeeTotals {
  const ok = ts.filter((t) => t.feeStatus === 'RESOLVED');
  const add = (f: (t: StoredTrade) => string | null) => ok.reduce((a, t) => a + BigInt(f(t) ?? '0'), 0n).toString();
  return { trades: ts.length, volumeQuoteRaw: ts.reduce((a, t) => a + BigInt(t.quoteRaw), 0n).toString(), feesRaw: add((t) => t.feeTotalRaw),
    creatorRaw: add((t) => t.feeCreatorRaw), platformRaw: add((t) => t.feePlatformRaw), lpRaw: add((t) => t.feeLpRaw), protocolRaw: add((t) => t.feeProtocolRaw),
    referralRaw: add((t) => t.feeReferralRaw), compoundingRaw: add((t) => t.feeCompoundingRaw), unknownTrades: ts.length - ok.length };
}
const camel = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

export class LaunchpadStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
    if (current > STORE_MIGRATIONS.length) throw new Error(`database schema ${current} is newer than this build (${STORE_MIGRATIONS.length})`);
    for (let v = current + 1; v <= STORE_MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(STORE_MIGRATIONS[v - 1]!);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  close() { this.db.close(); }

  /** Ties this database to one network for life. A database that predates the marker but holds devnet data is devnet. Opening
   *  it for another network throws, so devnet records can never be served or acted on as mainnet (or the reverse). */
  bindCluster(cluster: string): string {
    const marked = this.getPlatform<string>('cluster');
    const legacy = !marked && (this.getPlatform('platform') !== null || (this.db.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number }).n > 0) ? 'devnet' : null;
    const bound = marked ?? legacy ?? cluster;
    if (!marked) this.setPlatform('cluster', bound);
    if (bound !== cluster) throw new Error(`STORE_CLUSTER_MISMATCH this database belongs to ${bound}, not ${cluster}`);
    return bound;
  }
  getPlatform<T>(k: string): T | null {
    const r = this.db.prepare('SELECT v FROM platform WHERE k = ?').get(k) as { v: string } | undefined;
    return r ? (JSON.parse(r.v) as T) : null;
  }
  setPlatform(k: string, v: unknown) {
    this.db.prepare('INSERT INTO platform (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
      .run(k, JSON.stringify(v), new Date().toISOString());
  }

  insertPendingLaunch(l: Omit<LaunchRow, 'status' | 'createSig' | 'liveAt' | 'migrationSig' | 'dammPool' | 'migratedAt' | 'lastIndexedSig' | 'lastDammIndexedSig'>, image: Uint8Array | null) {
    this.db.prepare(`INSERT INTO launches (mint, pool, config, quote_mint, creator, name, symbol, description, website, twitter, telegram, image_type, image,
      metadata_uri, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
      .run(l.mint, l.pool, l.config, l.quoteMint, l.creator, l.name, l.symbol, l.description, l.website, l.twitter, l.telegram, l.imageType, image, l.metadataUri, l.createdAt);
  }
  markLaunchLive(mint: string, sig: string, at: string) {
    this.db.prepare("UPDATE launches SET status = 'LIVE', create_sig = ?, live_at = ? WHERE mint = ? AND status = 'PENDING'").run(sig, at, mint);
  }
  markLaunchMigrated(mint: string, sig: string | null, dammPool: string, at: string) {
    this.db.prepare("UPDATE launches SET status = 'MIGRATED', migration_sig = COALESCE(?, migration_sig), damm_pool = ?, migrated_at = ? WHERE mint = ?").run(sig, dammPool, at, mint);
  }
  setLastIndexed(mint: string, sig: string) { this.db.prepare('UPDATE launches SET last_indexed_sig = ? WHERE mint = ?').run(sig, mint); }
  setLastDammIndexed(mint: string, sig: string) { this.db.prepare('UPDATE launches SET last_damm_indexed_sig = ? WHERE mint = ?').run(sig, mint); }
  getLaunch(mint: string): LaunchRow | null {
    const r = this.db.prepare('SELECT * FROM launches WHERE mint = ?').get(mint) as Record<string, unknown> | undefined;
    if (!r) return null;
    delete r.image;
    return camel(r) as unknown as LaunchRow;
  }
  getImage(mint: string): { type: string; bytes: Uint8Array } | null {
    const r = this.db.prepare('SELECT image_type, image FROM launches WHERE mint = ?').get(mint) as { image_type: string | null; image: Uint8Array | null } | undefined;
    return r?.image && r.image_type ? { type: r.image_type, bytes: r.image } : null;
  }
  listLaunches(statuses: LaunchStatus[] = ['LIVE', 'MIGRATED'], limit = 100): LaunchRow[] {
    const q = `SELECT mint, pool, config, quote_mint, creator, name, symbol, description, website, twitter, telegram, image_type, metadata_uri, status, create_sig,
      created_at, live_at, migration_sig, damm_pool, migrated_at, last_indexed_sig, last_damm_indexed_sig FROM launches WHERE status IN (${statuses.map(() => '?').join(',')})
      ORDER BY COALESCE(live_at, created_at) DESC LIMIT ?`;
    return (this.db.prepare(q).all(...statuses, limit) as Record<string, unknown>[]).map((r) => camel(r) as unknown as LaunchRow);
  }

  insertClaim(c: NewClaim) {
    this.db.prepare(`INSERT OR IGNORE INTO claims (sig, mint, venue, claimer, quote_raw, base_raw, at, pool, quote_vault, base_vault, status)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'UNKNOWN')`).run(c.sig, c.mint, c.venue, c.claimer, c.at, c.pool ?? null, c.quoteVault ?? null, c.baseVault ?? null);
  }
  setClaimIdentity(sig: string, id: { pool: string; quoteVault: string; baseVault: string }) {
    this.db.prepare('UPDATE claims SET pool = ?, quote_vault = ?, base_vault = ? WHERE sig = ? AND pool IS NULL').run(id.pool, id.quoteVault, id.baseVault, sig);
  }
  /** Records one evidence check. Amounts are written only for RESOLVED/FAILED_TX; an UNKNOWN result never overwrites them. */
  setClaimEvidence(sig: string, r: { status: ClaimStatus; evidence: string; quoteRaw: string | null; baseRaw: string | null }) {
    if (r.status === 'UNKNOWN') this.db.prepare("UPDATE claims SET evidence = ?, attempts = attempts + 1 WHERE sig = ? AND status = 'UNKNOWN'").run(r.evidence, sig);
    else this.db.prepare('UPDATE claims SET status = ?, evidence = ?, quote_raw = ?, base_raw = ?, attempts = attempts + 1 WHERE sig = ?').run(r.status, r.evidence, r.quoteRaw, r.baseRaw, sig);
  }
  getClaim(sig: string): ClaimRow | null {
    const r = this.db.prepare('SELECT * FROM claims WHERE sig = ?').get(sig) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as ClaimRow) : null;
  }
  listClaims(): ClaimRow[] { return this.db.prepare('SELECT * FROM claims ORDER BY at DESC').all().map((r) => camel(r as Record<string, unknown>) as unknown as ClaimRow); }
  /** Receipts still waiting for evidence, least-tried first. */
  unresolvedClaims(limit: number): ClaimRow[] {
    return this.db.prepare("SELECT * FROM claims WHERE status = 'UNKNOWN' ORDER BY attempts, at DESC LIMIT ?").all(limit).map((r) => camel(r as Record<string, unknown>) as unknown as ClaimRow);
  }
  /** The confirmed intent a receipt came from, which carries the terms its transaction was bound to. */
  confirmedIntentBySignature(sig: string): IntentRow | null {
    const r = this.db.prepare("SELECT * FROM intents WHERE signature = ? AND status = 'CONFIRMED'").get(sig) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as IntentRow) : null;
  }

  // ---- transactions listed by the RPC whose details were not served yet (see indexer.ts)
  queueBackfill(b: { sig: string; venue: BackfillRow['venue']; mint: string; at: string }) {
    this.db.prepare(`INSERT OR IGNORE INTO trade_backfill (sig, venue, mint, status, attempts, first_seen, last_tried, next_try) VALUES (?, ?, ?, 'PENDING', 1, ?, ?, ?)`)
      .run(b.sig, b.venue, b.mint, b.at, b.at, b.at);
  }
  dueBackfill(mint: string, venue: BackfillRow['venue'], nowIso: string, limit: number): BackfillRow[] {
    return (this.db.prepare(`SELECT * FROM trade_backfill WHERE mint = ? AND venue = ? AND status IN ('PENDING', 'UNAVAILABLE') AND next_try <= ?
      ORDER BY next_try, first_seen LIMIT ?`).all(mint, venue, nowIso, limit) as Record<string, unknown>[]).map((r) => camel(r) as unknown as BackfillRow);
  }
  backfillMissed(sig: string, venue: BackfillRow['venue'], r: { status: 'PENDING' | 'UNAVAILABLE'; attempts: number; at: string; nextTry: string }) {
    this.db.prepare('UPDATE trade_backfill SET status = ?, attempts = ?, last_tried = ?, next_try = ? WHERE sig = ? AND venue = ?').run(r.status, r.attempts, r.at, r.nextTry, sig, venue);
  }
  resolveBackfill(sig: string, venue: BackfillRow['venue'], outcome: NonNullable<BackfillRow['outcome']>, at: string) {
    this.db.prepare("UPDATE trade_backfill SET status = 'RESOLVED', outcome = ?, resolved_at = ?, last_tried = ?, attempts = attempts + 1 WHERE sig = ? AND venue = ?")
      .run(outcome, at, at, sig, venue);
  }
  listBackfill(mint?: string): BackfillRow[] {
    const rows = mint ? this.db.prepare('SELECT * FROM trade_backfill WHERE mint = ? ORDER BY first_seen, sig').all(mint) : this.db.prepare('SELECT * FROM trade_backfill ORDER BY first_seen, sig').all();
    return (rows as Record<string, unknown>[]).map((r) => camel(r) as unknown as BackfillRow);
  }
  /** Transactions of this coin that the trade history does not include yet (PENDING) or could not read (UNAVAILABLE). */
  backfillCounts(mint: string): { pending: number; unavailable: number } {
    const r = this.db.prepare(`SELECT SUM(status = 'PENDING') AS p, SUM(status = 'UNAVAILABLE') AS u FROM trade_backfill WHERE mint = ?`).get(mint) as { p: number | null; u: number | null };
    return { pending: r.p ?? 0, unavailable: r.u ?? 0 };
  }
  insertTrade(t: TradeRow): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO trades (sig, mint, trader, side, quote_raw, base_raw, slot, block_time, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.sig, t.mint, t.trader, t.side, t.quoteRaw, t.baseRaw, t.slot, t.blockTime, t.source);
    if (t.fees) this.setTradeFees(t.sig, t.fees);
    return Number(r.changes) > 0;
  }
  /** Records a trade's fees. A RESOLVED record is final; an UNKNOWN one counts an attempt and is read again later. */
  setTradeFees(sig: string, f: TradeFees) {
    this.db.prepare(`UPDATE trades SET venue = COALESCE(?, venue), fee_status = ?, fee_evidence = ?, fee_attempts = fee_attempts + 1, fee_total_raw = ?, fee_protocol_raw = ?,
      fee_referral_raw = ?, fee_creator_raw = ?, fee_platform_raw = ?, fee_lp_raw = ?, fee_compounding_raw = ? WHERE sig = ? AND (fee_status IS NULL OR fee_status <> 'RESOLVED')`)
      .run(f.venue, f.status, f.evidence, f.totalRaw, f.protocolRaw, f.referralRaw, f.creatorRaw, f.platformRaw, f.lpRaw, f.compoundingRaw, sig);
  }
  /** Trades whose fees are not proven yet and are due another read (never read first, then the fewest attempts). */
  tradesNeedingFees(limit: number, maxAttempts: number): StoredTrade[] {
    return (this.db.prepare(`SELECT * FROM trades WHERE (fee_status IS NULL OR fee_status = 'UNKNOWN') AND fee_attempts < ? ORDER BY fee_attempts, slot LIMIT ?`)
      .all(maxAttempts, limit) as Record<string, unknown>[]).map((r) => camel(r) as unknown as StoredTrade);
  }
  listTrades(mint: string, limit = 200): StoredTrade[] {
    return (this.db.prepare('SELECT * FROM trades WHERE mint = ? ORDER BY slot DESC, sig LIMIT ?').all(mint, limit) as Record<string, unknown>[])
      .map((r) => camel(r) as unknown as StoredTrade);
  }
  /** Fee totals grouped by `by` ('trader', 'mint' or both), from every stored trade. bigint sums in JS (SQLite has no u64 text sum). */
  feeTotals(by: ('trader' | 'mint')[], where: { trader?: string; mint?: string } = {}): (FeeTotals & { trader?: string; mint?: string })[] {
    const cond = [where.trader ? 'trader = ?' : null, where.mint ? 'mint = ?' : null].filter(Boolean);
    const rows = this.db.prepare(`SELECT * FROM trades${cond.length ? ` WHERE ${cond.join(' AND ')}` : ''}`)
      .all(...[where.trader, where.mint].filter((x): x is string => !!x)) as Record<string, unknown>[];
    const groups = new Map<string, { key: Record<string, string>; t: StoredTrade[] }>();
    for (const r of rows.map((x) => camel(x) as unknown as StoredTrade)) {
      const key = Object.fromEntries(by.map((k) => [k, r[k]]));
      const id = JSON.stringify(key);
      (groups.get(id) ?? groups.set(id, { key, t: [] }).get(id)!).t.push(r);
    }
    return [...groups.values()].map((g) => ({ ...g.key, ...sumFees(g.t) }));
  }
  /** Latest trades across launches that are LIVE or MIGRATED, newest first, with the coin's symbol (for the trade tape). */
  listRecentTrades(limit = 30): (TradeRow & { symbol: string })[] {
    return (this.db.prepare(`SELECT t.*, l.symbol AS symbol FROM trades t JOIN launches l ON l.mint = t.mint WHERE l.status IN ('LIVE', 'MIGRATED')
      ORDER BY COALESCE(t.block_time, 0) DESC, t.slot DESC, t.sig LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => camel(r) as unknown as TradeRow & { symbol: string });
  }
  tradeStats(mint: string): { count: number; volumeQuoteRaw: string; traders: number } {
    const rows = this.db.prepare('SELECT quote_raw, trader FROM trades WHERE mint = ?').all(mint) as { quote_raw: string; trader: string }[];
    return { count: rows.length, volumeQuoteRaw: rows.reduce((a, r) => a + BigInt(r.quote_raw), 0n).toString(), traders: new Set(rows.map((r) => r.trader)).size };
  }

  insertIntent(i: Omit<IntentRow, 'id' | 'status' | 'signature' | 'error'>): IntentRow {
    const row: IntentRow = { id: `intent_${randomBytes(16).toString('hex')}`, status: 'BUILT', signature: null, error: null, ...i };
    this.db.prepare(`INSERT INTO intents (id, kind, mint, user, created_at, expires_at, message_hex, terms_json, last_valid_block_height, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BUILT')`).run(row.id, row.kind, row.mint, row.user, row.createdAt, row.expiresAt, row.messageHex, row.termsJson, row.lastValidBlockHeight);
    return row;
  }
  getIntent(id: string): IntentRow | null {
    const r = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as IntentRow) : null;
  }
  /** BUILT -> SUBMITTED exactly once (a replayed submit cannot send twice). */
  claimIntent(id: string): boolean {
    return Number(this.db.prepare("UPDATE intents SET status = 'SUBMITTED' WHERE id = ? AND status = 'BUILT'").run(id).changes) === 1;
  }
  finishIntent(id: string, status: 'CONFIRMED' | 'FAILED', signature: string | null, error: string | null) {
    this.db.prepare('UPDATE intents SET status = ?, signature = ?, error = ? WHERE id = ?').run(status, signature, error, id);
  }

  faucetClaimsSince(wallet: string, sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM faucet_claims WHERE wallet = ? AND at >= ?').get(wallet, sinceIso) as { n: number }).n;
  }
  insertTreasuryProposal(r: Omit<TreasuryProposalRow, 'executeSig' | 'executedBy' | 'updatedAt'>) {
    this.db.prepare(`INSERT OR IGNORE INTO treasury_proposals (multisig, tx_index, mint, venue, inner_json, proposer, propose_sig, approvals_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.multisig, r.txIndex, r.mint, r.venue, r.innerJson, r.proposer, r.proposeSig, JSON.stringify(r.approvals), r.status, r.createdAt, r.createdAt);
  }
  getTreasuryProposal(multisig: string, txIndex: string): TreasuryProposalRow | null {
    const r = this.db.prepare('SELECT * FROM treasury_proposals WHERE multisig = ? AND tx_index = ?').get(multisig, txIndex) as Record<string, unknown> | undefined;
    return r ? treasuryRow(r) : null;
  }
  listTreasuryProposals(multisig: string): TreasuryProposalRow[] {
    return this.db.prepare('SELECT * FROM treasury_proposals WHERE multisig = ? ORDER BY CAST(tx_index AS INTEGER) DESC').all(multisig).map((r) => treasuryRow(r as Record<string, unknown>));
  }
  /** Records what the chain says now (status and approvals), and the executing transaction once there is one. */
  updateTreasuryProposal(multisig: string, txIndex: string, u: { status: string; approvals: string[]; executeSig?: string; executedBy?: string }) {
    this.db.prepare(`UPDATE treasury_proposals SET status = ?, approvals_json = ?, execute_sig = COALESCE(?, execute_sig), executed_by = COALESCE(?, executed_by), updated_at = ?
      WHERE multisig = ? AND tx_index = ?`).run(u.status, JSON.stringify(u.approvals), u.executeSig ?? null, u.executedBy ?? null, new Date().toISOString(), multisig, txIndex);
  }
  insertFaucetClaim(wallet: string, at: string, signature: string) {
    this.db.prepare('INSERT INTO faucet_claims (wallet, at, signature) VALUES (?, ?, ?)').run(wallet, at, signature);
  }

  // ---------------------------------------------------------------- holder balance history (rewards)
  holderAccounts(mint: string): { account: string; cursor: string | null }[] {
    return this.db.prepare('SELECT account, cursor FROM holder_accounts WHERE mint = ? ORDER BY account').all(mint) as { account: string; cursor: string | null }[];
  }
  addHolderAccount(mint: string, account: string, at: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO holder_accounts (mint, account, cursor, discovered_at) VALUES (?, ?, NULL, ?)').run(mint, account, at).changes) === 1;
  }
  setHolderCursor(mint: string, account: string, sig: string) { this.db.prepare('UPDATE holder_accounts SET cursor = ? WHERE mint = ? AND account = ?').run(sig, mint, account); }
  holderTx(mint: string, sig: string): HolderTxRow | null {
    const r = this.db.prepare('SELECT * FROM holder_txs WHERE mint = ? AND sig = ?').get(mint, sig) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as HolderTxRow) : null;
  }
  /** A transaction read for the coin: DONE with its balance changes (written together), FAILED_TX, or PENDING (listed by
   *  the RPC but not served yet; kept and retried, so history is never silently short). */
  recordHolderTx(mint: string, sig: string, r: { status: HolderTxRow['status']; slot: number | null; at: string; changes?: HolderChangeRow[] }) {
    this.db.exec('BEGIN');
    try {
      const prev = this.holderTx(mint, sig);
      this.db.prepare(`INSERT INTO holder_txs (mint, sig, slot, status, attempts, updated_at) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT (mint, sig) DO UPDATE SET slot = COALESCE(excluded.slot, slot), status = excluded.status, attempts = attempts + 1, updated_at = excluded.updated_at`)
        .run(mint, sig, r.slot, r.status, r.at);
      if (prev?.status !== 'DONE') for (const c of r.changes ?? []) {
        this.db.prepare(`INSERT OR IGNORE INTO holder_changes (mint, sig, slot, block_time, account, owner, pre_raw, post_raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(mint, sig, c.slot, c.blockTime, c.account, c.owner, c.preRaw, c.postRaw);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  pendingHolderTxs(mint: string, limit: number): HolderTxRow[] {
    return (this.db.prepare("SELECT * FROM holder_txs WHERE mint = ? AND status = 'PENDING' ORDER BY attempts, sig LIMIT ?").all(mint, limit) as Record<string, unknown>[])
      .map((r) => camel(r) as unknown as HolderTxRow);
  }
  holderTxCounts(mint: string): { done: number; pending: number; failed: number; accounts: number; changes: number } {
    const n = (q: string, ...a: string[]) => (this.db.prepare(q).get(mint, ...a) as { n: number }).n;
    return { done: n("SELECT COUNT(*) AS n FROM holder_txs WHERE mint = ? AND status = 'DONE'"), pending: n("SELECT COUNT(*) AS n FROM holder_txs WHERE mint = ? AND status = 'PENDING'"),
      failed: n("SELECT COUNT(*) AS n FROM holder_txs WHERE mint = ? AND status = 'FAILED_TX'"), accounts: n('SELECT COUNT(*) AS n FROM holder_accounts WHERE mint = ?'),
      changes: n('SELECT COUNT(*) AS n FROM holder_changes WHERE mint = ?') };
  }
  holderChanges(mint: string): HolderChangeRow[] {
    return (this.db.prepare('SELECT sig, slot, block_time, account, owner, pre_raw, post_raw FROM holder_changes WHERE mint = ? ORDER BY slot, sig, account').all(mint) as Record<string, unknown>[])
      .map((r) => camel(r) as unknown as HolderChangeRow);
  }
  epochSlot(startSec: number): { slot: number; blockTime: number } | null {
    return (this.db.prepare('SELECT slot, block_time AS blockTime FROM epoch_slots WHERE start_sec = ?').get(startSec) as { slot: number; blockTime: number } | undefined) ?? null;
  }
  setEpochSlot(startSec: number, b: { slot: number; blockTime: number }) {
    this.db.prepare('INSERT OR IGNORE INTO epoch_slots (start_sec, slot, block_time) VALUES (?, ?, ?)').run(startSec, b.slot, b.blockTime);
  }
  getRewardEpoch(mint: string, epochId: string): { artifactJson: string; artifactHash: string; finalizedAt: string } | null {
    const r = this.db.prepare('SELECT artifact_json, artifact_hash, finalized_at FROM reward_epochs WHERE mint = ? AND epoch_id = ?').get(mint, epochId) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as { artifactJson: string; artifactHash: string; finalizedAt: string }) : null;
  }
  rewardVaultTx(sig: string): RewardVaultTxRow | null {
    const r = this.db.prepare('SELECT * FROM reward_vault_txs WHERE sig = ?').get(sig) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as RewardVaultTxRow) : null;
  }
  /** Records one rewards-vault transaction; a DONE row is final (a later read never changes it). */
  recordRewardVaultTx(r: Omit<RewardVaultTxRow, 'attempts'>): void {
    const prev = this.rewardVaultTx(r.sig);
    if (prev?.status === 'DONE') return;
    this.db.prepare(`INSERT INTO reward_vault_txs (sig, account, slot, block_time, status, kind, mint, epoch_id, artifact_hash, delta_raw, transfers_json, memo, attempts, updated_at)
      VALUES (@sig, @account, @slot, @blockTime, @status, @kind, @mint, @epochId, @artifactHash, @deltaRaw, @transfersJson, @memo, 1, @updatedAt)
      ON CONFLICT(sig) DO UPDATE SET slot = excluded.slot, block_time = excluded.block_time, status = excluded.status, kind = excluded.kind, mint = excluded.mint,
        epoch_id = excluded.epoch_id, artifact_hash = excluded.artifact_hash, delta_raw = excluded.delta_raw, transfers_json = excluded.transfers_json, memo = excluded.memo,
        attempts = reward_vault_txs.attempts + 1, updated_at = excluded.updated_at`).run(r);
  }
  listRewardVaultTxs(account: string): RewardVaultTxRow[] {
    return (this.db.prepare('SELECT * FROM reward_vault_txs WHERE account = ? ORDER BY slot, sig').all(account) as Record<string, unknown>[]).map((r) => camel(r) as unknown as RewardVaultTxRow);
  }
  /** Freezes a final epoch's artifact; a second save of the same epoch is ignored (the first one stands). */
  saveRewardEpoch(mint: string, epochId: string, artifactJson: string, artifactHash: string, at: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO reward_epochs (mint, epoch_id, artifact_json, artifact_hash, finalized_at) VALUES (?, ?, ?, ?, ?)')
      .run(mint, epochId, artifactJson, artifactHash, at).changes) === 1;
  }
}

/** A rewards-vault transaction. kind: DEPOSIT (tagged for mint+epoch, balance up), PAYOUT (tagged, balance down, with the
 *  recipients' receipts), UNTAGGED (balance moved without a valid rewards memo), NONE (no balance change). */
export interface RewardVaultTxRow { sig: string; account: string; slot: number | null; blockTime: number | null; status: 'DONE' | 'PENDING' | 'FAILED_TX';
  kind: 'DEPOSIT' | 'PAYOUT' | 'UNTAGGED' | 'NONE' | null; mint: string | null; epochId: string | null; artifactHash: string | null; deltaRaw: string | null;
  transfersJson: string | null; memo: string | null; attempts: number; updatedAt: string }
export interface HolderTxRow { mint: string; sig: string; slot: number | null; status: 'DONE' | 'PENDING' | 'FAILED_TX'; attempts: number; updatedAt: string }
export interface HolderChangeRow { sig: string; slot: number; blockTime: number | null; account: string; owner: string; preRaw: string; postRaw: string }
