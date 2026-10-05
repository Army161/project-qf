// Launchpad persistence on node:sqlite: the platform record (test quote + DBC config), launches with their metadata and
// image, indexed trades and the queue of transactions still to be read, built-transaction intents (exact message bytes
// the browser must sign), fee-claim receipts and faucet claims.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

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
export interface TradeRow { sig: string; mint: string; trader: string; side: 'BUY' | 'SELL'; quoteRaw: string; baseRaw: string; slot: number; blockTime: number | null; source: string }
export interface IntentRow { id: string; kind: string; mint: string | null; user: string; createdAt: string; expiresAt: string; messageHex: string;
  termsJson: string; lastValidBlockHeight: number; status: 'BUILT' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'; signature: string | null; error: string | null }

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
    return Number(r.changes) > 0;
  }
  listTrades(mint: string, limit = 200): TradeRow[] {
    return (this.db.prepare('SELECT * FROM trades WHERE mint = ? ORDER BY slot DESC, sig LIMIT ?').all(mint, limit) as Record<string, unknown>[])
      .map((r) => camel(r) as unknown as TradeRow);
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
  insertFaucetClaim(wallet: string, at: string, signature: string) {
    this.db.prepare('INSERT INTO faucet_claims (wallet, at, signature) VALUES (?, ?, ?)').run(wallet, at, signature);
  }
}
