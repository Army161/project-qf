// Launchpad persistence on node:sqlite: the platform record (test quote + DBC config), launches with their metadata and
// image, indexed trades, built-transaction intents (exact message bytes the browser must sign) and faucet claims.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: readonly string[] = [
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
];

export type LaunchStatus = 'PENDING' | 'LIVE' | 'MIGRATED' | 'FAILED';
export interface LaunchRow {
  mint: string; pool: string; config: string; quoteMint: string; creator: string; name: string; symbol: string; description: string;
  website: string | null; twitter: string | null; telegram: string | null; imageType: string | null; metadataUri: string; status: LaunchStatus;
  createSig: string | null; createdAt: string; liveAt: string | null; migrationSig: string | null; dammPool: string | null; migratedAt: string | null;
  lastIndexedSig: string | null; lastDammIndexedSig: string | null;
}
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
    if (current > MIGRATIONS.length) throw new Error(`database schema ${current} is newer than this build (${MIGRATIONS.length})`);
    for (let v = current + 1; v <= MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v - 1]!);
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
