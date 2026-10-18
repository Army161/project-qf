// The engine launchpad's records on node:sqlite. A separate database from the Meteora launchpad's, bound to one network
// and to the engine, so the two can never be mixed up. It holds:
//   coins     what a creator typed (name, picture, links) and where the coin is in its life
//   txs       every transaction listed for a coin's curve or pool, and whether it has been read yet
//   trades    one row per trade event (curve or pool), with the fees it paid
//   payouts   fee claims and graduation fees, from the engine's own events
//   intents   the exact message the server built for a wallet to sign
//   faucet    faucet claims, for the daily limit
// The chain is the authority for every amount: rows here are what the engine's events said, never what a caller said.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const ENGINE_STORE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
   CREATE TABLE coins (mint TEXT PRIMARY KEY, quote_mint TEXT NOT NULL, creator TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL,
     description TEXT NOT NULL, website TEXT, twitter TEXT, telegram TEXT, image_type TEXT, image BLOB, metadata_uri TEXT NOT NULL,
     status TEXT NOT NULL, created_at TEXT NOT NULL, create_sig TEXT, live_at TEXT, pool TEXT, graduate_sig TEXT, graduated_at TEXT,
     curve_cursor TEXT, pool_cursor TEXT);
   CREATE INDEX coins_status ON coins(status, created_at);
   CREATE TABLE txs (sig TEXT NOT NULL, mint TEXT NOT NULL REFERENCES coins(mint), venue TEXT NOT NULL, slot INTEGER NOT NULL, status TEXT NOT NULL,
     outcome TEXT, attempts INTEGER NOT NULL, next_try TEXT NOT NULL, first_seen TEXT NOT NULL, PRIMARY KEY (sig, mint));
   CREATE INDEX txs_due ON txs(status, next_try);
   CREATE TABLE trades (sig TEXT NOT NULL, ix INTEGER NOT NULL, mint TEXT NOT NULL REFERENCES coins(mint), venue TEXT NOT NULL, trader TEXT NOT NULL,
     side TEXT NOT NULL, quote_raw TEXT NOT NULL, base_raw TEXT NOT NULL, fee_mint TEXT NOT NULL, trade_fee_raw TEXT NOT NULL,
     platform_fee_raw TEXT, creator_fee_raw TEXT NOT NULL, slot INTEGER NOT NULL, block_time INTEGER, PRIMARY KEY (sig, ix));
   CREATE INDEX trades_mint ON trades(mint, slot);
   CREATE INDEX trades_trader ON trades(trader, slot);
   CREATE TABLE payouts (sig TEXT NOT NULL, ix INTEGER NOT NULL, mint TEXT NOT NULL REFERENCES coins(mint), kind TEXT NOT NULL, to_account TEXT,
     amount_raw TEXT NOT NULL, slot INTEGER NOT NULL, block_time INTEGER, PRIMARY KEY (sig, ix));
   CREATE INDEX payouts_mint ON payouts(mint, kind);
   CREATE TABLE intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mint TEXT, user TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
     message_hex TEXT NOT NULL, terms_json TEXT NOT NULL, last_valid_block_height TEXT NOT NULL, status TEXT NOT NULL, signature TEXT, error TEXT);
   CREATE TABLE faucet_claims (wallet TEXT NOT NULL, at TEXT NOT NULL, signature TEXT NOT NULL);
   CREATE INDEX faucet_wallet ON faucet_claims(wallet, at);`,
];

/** PENDING: built, not confirmed yet. LIVE: on its curve. GRADUATED: trading in its pool. FAILED: its launch never landed. */
export type CoinStatus = 'PENDING' | 'LIVE' | 'GRADUATED' | 'FAILED';
export interface CoinRow {
  mint: string; quoteMint: string; creator: string; name: string; symbol: string; description: string;
  website: string | null; twitter: string | null; telegram: string | null; imageType: string | null; metadataUri: string;
  status: CoinStatus; createdAt: string; createSig: string | null; liveAt: string | null; pool: string | null; graduateSig: string | null; graduatedAt: string | null;
  curveCursor: string | null; poolCursor: string | null;
}
export type Venue = 'CURVE' | 'POOL';
/** A transaction listed for a coin: PENDING until read; UNAVAILABLE after many tries (still retried, still counted as missing). */
export type TxStatus = 'PENDING' | 'UNAVAILABLE' | 'READ';
export interface TxRow { sig: string; mint: string; venue: Venue; slot: number; status: TxStatus; outcome: string | null; attempts: number; nextTry: string; firstSeen: string }
export interface TradeRow {
  sig: string; ix: number; mint: string; venue: Venue; trader: string; side: 'BUY' | 'SELL';
  /** quote paid (a buy, fees included) or received (a sell, after fees) */
  quoteRaw: string; baseRaw: string;
  /** the mint the trade fee is charged in: the quote on the curve, the input token in the pool */
  feeMint: string; tradeFeeRaw: string;
  /** the platform's part of the trade fee: from the curve's event; null in the pool (computed from its config when shown) */
  platformFeeRaw: string | null;
  /** the creator's fee, always in the quote */
  creatorFeeRaw: string;
  slot: number; blockTime: number | null;
}
/** PLATFORM_CLAIM / CREATOR_CLAIM: a curve fee claim (FeesClaimed). GRADUATION_FEE: added to the platform's share at graduation.
 *  POOL_CREATOR_COLLECT: the pool creator fee paid to the creator, read from the pool vault's balance change. */
export type PayoutKind = 'PLATFORM_CLAIM' | 'CREATOR_CLAIM' | 'GRADUATION_FEE' | 'POOL_CREATOR_COLLECT';
export interface PayoutRow { sig: string; ix: number; mint: string; kind: PayoutKind; toAccount: string | null; amountRaw: string; slot: number; blockTime: number | null }
export interface IntentRow { id: string; kind: string; mint: string | null; user: string; createdAt: string; expiresAt: string; messageHex: string;
  termsJson: string; lastValidBlockHeight: string; status: 'BUILT' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'; signature: string | null; error: string | null }

const camel = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
const COIN_COLUMNS = `mint, quote_mint, creator, name, symbol, description, website, twitter, telegram, image_type, metadata_uri, status, created_at, create_sig,
  live_at, pool, graduate_sig, graduated_at, curve_cursor, pool_cursor`;

export class EngineStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
    if (current > ENGINE_STORE_MIGRATIONS.length) throw new Error(`database schema ${current} is newer than this build (${ENGINE_STORE_MIGRATIONS.length})`);
    for (let v = current + 1; v <= ENGINE_STORE_MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(ENGINE_STORE_MIGRATIONS[v - 1]!);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  close() { this.db.close(); }

  /** Ties this database to one network (by name and genesis hash) and one quote for life: opening it for another throws. */
  bind(k: 'cluster' | 'genesis' | 'quote', value: string): void {
    const r = this.db.prepare('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | undefined;
    if (!r) { this.db.prepare('INSERT INTO settings (k, v) VALUES (?, ?)').run(k, value); return; }
    if (r.v !== value) throw new Error(`STORE_${k.toUpperCase()}_MISMATCH this database belongs to ${r.v}, not ${value}`);
  }

  /** What `bind` tied this database to, or null before the first bind. */
  bound(k: 'cluster' | 'genesis' | 'quote'): string | null {
    return (this.db.prepare('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? null;
  }

  // ---------- coins
  insertPendingCoin(c: Pick<CoinRow, 'mint' | 'quoteMint' | 'creator' | 'name' | 'symbol' | 'description' | 'website' | 'twitter' | 'telegram' | 'imageType' | 'metadataUri' | 'createdAt'>,
    image: Uint8Array | null) {
    this.db.prepare(`INSERT INTO coins (mint, quote_mint, creator, name, symbol, description, website, twitter, telegram, image_type, image, metadata_uri, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
      .run(c.mint, c.quoteMint, c.creator, c.name, c.symbol, c.description, c.website, c.twitter, c.telegram, c.imageType, image, c.metadataUri, c.createdAt);
  }
  /** A coin found on the engine that this app did not launch (another client, or a store started after it): LIVE, with what
   *  its creation event said. Its description, links and picture were never given to this app, so they stay empty.
   *  Returns false when the store already has the coin. */
  insertDiscoveredCoin(c: Pick<CoinRow, 'mint' | 'quoteMint' | 'creator' | 'name' | 'symbol' | 'metadataUri' | 'createdAt' | 'createSig'>): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO coins (mint, quote_mint, creator, name, symbol, description, metadata_uri, status, created_at, create_sig, live_at)
      VALUES (?, ?, ?, ?, ?, '', ?, 'LIVE', ?, ?, ?)`).run(c.mint, c.quoteMint, c.creator, c.name, c.symbol, c.metadataUri, c.createdAt, c.createSig, c.createdAt).changes > 0;
  }
  /** The launch landed: LIVE from PENDING, and its creating transaction once known. */
  markLive(mint: string, sig: string | null, at: string) {
    this.db.prepare("UPDATE coins SET status = 'LIVE', live_at = COALESCE(live_at, ?) WHERE mint = ? AND status = 'PENDING'").run(at, mint);
    if (sig) this.db.prepare('UPDATE coins SET create_sig = ? WHERE mint = ? AND create_sig IS NULL').run(sig, mint);
  }
  /** A launch whose intent expired and whose launch account never appeared. */
  markFailed(mint: string) { this.db.prepare("UPDATE coins SET status = 'FAILED' WHERE mint = ? AND status = 'PENDING'").run(mint); }
  markGraduated(mint: string, pool: string, sig: string | null, at: string) {
    this.db.prepare("UPDATE coins SET status = 'GRADUATED', pool = ?, graduate_sig = COALESCE(?, graduate_sig), graduated_at = COALESCE(graduated_at, ?) WHERE mint = ? AND status IN ('LIVE', 'GRADUATED')")
      .run(pool, sig, at, mint);
  }
  setCursor(mint: string, venue: Venue, sig: string) {
    this.db.prepare(`UPDATE coins SET ${venue === 'CURVE' ? 'curve_cursor' : 'pool_cursor'} = ? WHERE mint = ?`).run(sig, mint);
  }
  getCoin(mint: string): CoinRow | null {
    const r = this.db.prepare(`SELECT ${COIN_COLUMNS} FROM coins WHERE mint = ?`).get(mint) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as CoinRow) : null;
  }
  getImage(mint: string): { type: string; bytes: Uint8Array } | null {
    const r = this.db.prepare('SELECT image_type, image FROM coins WHERE mint = ?').get(mint) as { image_type: string | null; image: Uint8Array | null } | undefined;
    return r?.image && r.image_type ? { type: r.image_type, bytes: r.image } : null;
  }
  listCoins(statuses: CoinStatus[] = ['LIVE', 'GRADUATED'], limit = 200): CoinRow[] {
    return (this.db.prepare(`SELECT ${COIN_COLUMNS} FROM coins WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`)
      .all(...statuses, limit) as Record<string, unknown>[]).map((r) => camel(r) as unknown as CoinRow);
  }

  // ---------- transactions listed for a coin
  /** Records newly listed signatures (oldest first) and moves the venue's cursor past them in one step. */
  queueTxs(mint: string, venue: Venue, sigs: { signature: string; slot: number }[], at: string) {
    if (!sigs.length) return;
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare("INSERT OR IGNORE INTO txs (sig, mint, venue, slot, status, attempts, next_try, first_seen) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)");
      for (const s of sigs) ins.run(s.signature, mint, venue, s.slot, at, at);
      this.setCursor(mint, venue, sigs[sigs.length - 1]!.signature);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  dueTxs(nowIso: string, limit: number): TxRow[] {
    return (this.db.prepare("SELECT * FROM txs WHERE status != 'READ' AND next_try <= ? ORDER BY slot, sig LIMIT ?").all(nowIso, limit) as Record<string, unknown>[])
      .map((r) => camel(r) as unknown as TxRow);
  }
  missedTx(sig: string, mint: string, p: { status: 'PENDING' | 'UNAVAILABLE'; attempts: number; nextTry: string }) {
    this.db.prepare('UPDATE txs SET status = ?, attempts = ?, next_try = ? WHERE sig = ? AND mint = ?').run(p.status, p.attempts, p.nextTry, sig, mint);
  }
  /** Stores what one transaction held for one coin (its trades and payouts) and marks it read, atomically. */
  recordTx(sig: string, mint: string, outcome: string, trades: TradeRow[], payouts: PayoutRow[]) {
    this.db.exec('BEGIN');
    try {
      const t = this.db.prepare(`INSERT OR REPLACE INTO trades (sig, ix, mint, venue, trader, side, quote_raw, base_raw, fee_mint, trade_fee_raw, platform_fee_raw,
        creator_fee_raw, slot, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of trades) t.run(r.sig, r.ix, r.mint, r.venue, r.trader, r.side, r.quoteRaw, r.baseRaw, r.feeMint, r.tradeFeeRaw, r.platformFeeRaw, r.creatorFeeRaw, r.slot, r.blockTime);
      const p = this.db.prepare('INSERT OR REPLACE INTO payouts (sig, ix, mint, kind, to_account, amount_raw, slot, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of payouts) p.run(r.sig, r.ix, r.mint, r.kind, r.toAccount, r.amountRaw, r.slot, r.blockTime);
      this.db.prepare("UPDATE txs SET status = 'READ', outcome = ? WHERE sig = ? AND mint = ?").run(outcome, sig, mint);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  /** Transactions listed for the coin but not read yet: its history is complete only when both are 0. */
  unread(mint: string): { pending: number; unavailable: number } {
    const r = this.db.prepare("SELECT SUM(status = 'PENDING') AS pending, SUM(status = 'UNAVAILABLE') AS unavailable FROM txs WHERE mint = ?").get(mint) as { pending: number | null; unavailable: number | null };
    return { pending: r.pending ?? 0, unavailable: r.unavailable ?? 0 };
  }
  txOutcomes(mint: string): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT outcome, COUNT(*) AS n FROM txs WHERE mint = ? AND status = 'READ' GROUP BY outcome").all(mint) as { outcome: string; n: number }[])
      .map((r) => [r.outcome, r.n]));
  }

  // ---------- trades and payouts
  listTrades(mint: string, limit = 200): TradeRow[] {
    return (this.db.prepare('SELECT * FROM trades WHERE mint = ? ORDER BY slot DESC, sig DESC, ix DESC LIMIT ?').all(mint, limit) as Record<string, unknown>[]).map((r) => camel(r) as unknown as TradeRow);
  }
  allTrades(mint: string): TradeRow[] {
    return (this.db.prepare('SELECT * FROM trades WHERE mint = ? ORDER BY slot, sig, ix').all(mint) as Record<string, unknown>[]).map((r) => camel(r) as unknown as TradeRow);
  }
  recentTrades(limit: number): (TradeRow & { symbol: string })[] {
    return (this.db.prepare('SELECT t.*, c.symbol FROM trades t JOIN coins c ON c.mint = t.mint ORDER BY t.slot DESC, t.sig DESC, t.ix DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map((r) => camel(r) as unknown as TradeRow & { symbol: string });
  }
  tradeStats(mint: string): { count: number; volumeQuoteRaw: string; traders: number } {
    const rows = this.db.prepare('SELECT quote_raw, trader FROM trades WHERE mint = ?').all(mint) as { quote_raw: string; trader: string }[];
    return { count: rows.length, volumeQuoteRaw: rows.reduce((s, r) => s + BigInt(r.quote_raw), 0n).toString(), traders: new Set(rows.map((r) => r.trader)).size };
  }
  payouts(mint: string): PayoutRow[] {
    return (this.db.prepare('SELECT * FROM payouts WHERE mint = ? ORDER BY slot, sig, ix').all(mint) as Record<string, unknown>[]).map((r) => camel(r) as unknown as PayoutRow);
  }

  // ---------- intents
  insertIntent(i: Omit<IntentRow, 'id' | 'status' | 'signature' | 'error'>): IntentRow {
    const id = `intent_${randomBytes(16).toString('hex')}`;
    this.db.prepare(`INSERT INTO intents (id, kind, mint, user, created_at, expires_at, message_hex, terms_json, last_valid_block_height, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BUILT')`).run(id, i.kind, i.mint, i.user, i.createdAt, i.expiresAt, i.messageHex, i.termsJson, i.lastValidBlockHeight);
    return { ...i, id, status: 'BUILT', signature: null, error: null };
  }
  getIntent(id: string): IntentRow | null {
    const r = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? (camel(r) as unknown as IntentRow) : null;
  }
  /** Housekeeping, so built-but-never-sent transactions cannot fill the disk: deletes coins that never landed (FAILED, or
   *  PENDING with a launch transaction never submitted) created before `beforeIso`, with their stored image, then every
   *  BUILT intent that expired before `beforeIso`. A coin with any recorded history is kept. */
  purgeUnsent(beforeIso: string): { coins: number; intents: number } {
    const mints = (this.db.prepare(`SELECT c.mint FROM coins c WHERE c.created_at < ? AND (c.status = 'FAILED' OR (c.status = 'PENDING'
        AND EXISTS (SELECT 1 FROM intents i WHERE i.mint = c.mint AND i.status = 'BUILT' AND i.expires_at < ?)
        AND NOT EXISTS (SELECT 1 FROM intents j WHERE j.mint = c.mint AND j.status <> 'BUILT')))`).all(beforeIso, beforeIso) as { mint: string }[]).map((r) => r.mint);
    let coins = 0;
    for (const m of mints) { try { coins += Number(this.db.prepare("DELETE FROM coins WHERE mint = ? AND status IN ('FAILED', 'PENDING')").run(m).changes); } catch { /* referenced: keep */ } }
    const intents = Number(this.db.prepare("DELETE FROM intents WHERE status = 'BUILT' AND expires_at < ?").run(beforeIso).changes);
    return { coins, intents };
  }
  /** One submit per intent: only the first caller moves it from BUILT to SUBMITTED. */
  claimIntent(id: string): boolean {
    return Number(this.db.prepare("UPDATE intents SET status = 'SUBMITTED' WHERE id = ? AND status = 'BUILT'").run(id).changes) === 1;
  }
  finishIntent(id: string, status: 'CONFIRMED' | 'FAILED', signature: string | null, error: string | null) {
    this.db.prepare('UPDATE intents SET status = ?, signature = ?, error = ? WHERE id = ?').run(status, signature, error, id);
  }

  // ---------- faucet
  faucetClaimsSince(wallet: string, sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM faucet_claims WHERE wallet = ? AND at >= ?').get(wallet, sinceIso) as { n: number }).n;
  }
  insertFaucetClaim(wallet: string, at: string, signature: string) {
    this.db.prepare('INSERT INTO faucet_claims (wallet, at, signature) VALUES (?, ?, ?)').run(wallet, at, signature);
  }
}
