// The launchpad's records on Postgres, for serverless hosting: the same rows and rules as the SQLite store (store.ts),
// reached through a gateway that runs each request's statements in one transaction (deploy/supabase/qf-db). The gateway
// trusts only this project's production functions, by their Vercel OIDC token, so no database password is stored anywhere.
import type { BindKey } from './store.ts';
import type { CoinRow, CoinStatus, IntentRow, PayoutRow, Store, TradeRow, TxRow, Venue } from './store.ts';

export interface SqlStatement { sql: string; params: unknown[] }
/** Runs statements in one transaction and returns each one's rows. Bytes travel as { $b64 }. */
export type SqlGateway = (q: SqlStatement[]) => Promise<Record<string, unknown>[][]>;

const S = 'qf_launchpad';
type Row = Record<string, unknown>;
const camel = (r: Row) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const b64 = (bytes: Uint8Array) => ({ $b64: Buffer.from(bytes).toString('base64') });
const COIN_COLUMNS = `mint, quote_mint, creator, name, symbol, description, website, twitter, telegram, image_type, metadata_uri, status, created_at, create_sig,
  live_at, pool, graduate_sig, graduated_at, curve_cursor, pool_cursor`;
const coin = (r: Row) => camel(r) as unknown as CoinRow;
const tx = (r: Row) => ({ ...camel(r), slot: Number(r.slot), attempts: Number(r.attempts) }) as unknown as TxRow;
const trade = (r: Row) => ({ ...camel(r), ix: Number(r.ix), slot: Number(r.slot), blockTime: num(r.block_time) }) as unknown as TradeRow;
const payout = (r: Row) => ({ ...camel(r), ix: Number(r.ix), slot: Number(r.slot), blockTime: num(r.block_time) }) as unknown as PayoutRow;

/** The schema the gateway's database holds. Applied once by the owner's migration (deploy/supabase/schema.sql has the same text). */
export const PG_SCHEMA_VERSION = 1;

export class PgStore implements Store {
  private readonly gw: SqlGateway;
  constructor(gw: SqlGateway) { this.gw = gw; }
  private async q(sql: string, ...params: unknown[]): Promise<Row[]> { return (await this.gw([{ sql, params }]))[0]!; }
  async close() { /* nothing held open */ }

  async bind(k: BindKey, value: string): Promise<void> {
    const [, rows] = await this.gw([{ sql: `INSERT INTO ${S}.settings (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING`, params: [k, value] },
      { sql: `SELECT v FROM ${S}.settings WHERE k = $1`, params: [k] }]);
    const v = rows![0]?.v as string;
    if (v !== value) throw new Error(`STORE_${k.toUpperCase()}_MISMATCH this database belongs to ${v}, not ${value}`);
  }
  async bound(k: BindKey): Promise<string | null> {
    return ((await this.q(`SELECT v FROM ${S}.settings WHERE k = $1`, k))[0]?.v as string | undefined) ?? null;
  }

  /** One indexer pass at a time across every function instance: true for the caller that may run one now. */
  async tryTick(nowIso: string, everyMs: number): Promise<boolean> {
    const cutoff = new Date(Date.parse(nowIso) - everyMs).toISOString();
    return (await this.q(`INSERT INTO ${S}.settings (k, v) VALUES ('tick_at', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v WHERE ${S}.settings.v < $2 RETURNING k`,
      nowIso, cutoff)).length === 1;
  }
  /** The operator's devnet key (64 bytes), made by the first instance that needs one. It lives only in the database. */
  async operatorKey(make: () => Uint8Array): Promise<Uint8Array> {
    const [, rows] = await this.gw([{ sql: `INSERT INTO ${S}.secrets (k, v) VALUES ('operator', $1) ON CONFLICT (k) DO NOTHING`, params: [Buffer.from(make()).toString('base64')] },
      { sql: `SELECT v FROM ${S}.secrets WHERE k = 'operator'`, params: [] }]);
    return Uint8Array.from(Buffer.from(rows![0]!.v as string, 'base64'));
  }

  // ---------- coins
  async insertPendingCoin(c: Pick<CoinRow, 'mint' | 'quoteMint' | 'creator' | 'name' | 'symbol' | 'description' | 'website' | 'twitter' | 'telegram' | 'imageType' | 'metadataUri' | 'createdAt'>,
    image: Uint8Array | null) {
    await this.q(`INSERT INTO ${S}.coins (mint, quote_mint, creator, name, symbol, description, website, twitter, telegram, image_type, image, metadata_uri, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING', $13)`,
      c.mint, c.quoteMint, c.creator, c.name, c.symbol, c.description, c.website, c.twitter, c.telegram, c.imageType, image ? b64(image) : null, c.metadataUri, c.createdAt);
  }
  async insertDiscoveredCoin(c: Pick<CoinRow, 'mint' | 'quoteMint' | 'creator' | 'name' | 'symbol' | 'metadataUri' | 'createdAt' | 'createSig'>): Promise<boolean> {
    return (await this.q(`INSERT INTO ${S}.coins (mint, quote_mint, creator, name, symbol, description, metadata_uri, status, created_at, create_sig, live_at)
      VALUES ($1, $2, $3, $4, $5, '', $6, 'LIVE', $7, $8, $7) ON CONFLICT (mint) DO NOTHING RETURNING mint`,
      c.mint, c.quoteMint, c.creator, c.name, c.symbol, c.metadataUri, c.createdAt, c.createSig)).length > 0;
  }
  async markLive(mint: string, sig: string | null, at: string) {
    await this.gw([{ sql: `UPDATE ${S}.coins SET status = 'LIVE', live_at = COALESCE(live_at, $1) WHERE mint = $2 AND status = 'PENDING'`, params: [at, mint] },
      ...(sig ? [{ sql: `UPDATE ${S}.coins SET create_sig = $1 WHERE mint = $2 AND create_sig IS NULL`, params: [sig, mint] }] : [])]);
  }
  async markFailed(mint: string) { await this.q(`UPDATE ${S}.coins SET status = 'FAILED' WHERE mint = $1 AND status = 'PENDING'`, mint); }
  async markGraduated(mint: string, pool: string, sig: string | null, at: string) {
    await this.q(`UPDATE ${S}.coins SET status = 'GRADUATED', pool = $1, graduate_sig = COALESCE($2, graduate_sig), graduated_at = COALESCE(graduated_at, $3)
      WHERE mint = $4 AND status IN ('LIVE', 'GRADUATED')`, pool, sig, at, mint);
  }
  async setCursor(mint: string, venue: Venue, sig: string) {
    await this.q(`UPDATE ${S}.coins SET ${venue === 'CURVE' ? 'curve_cursor' : 'pool_cursor'} = $1 WHERE mint = $2`, sig, mint);
  }
  async getCoin(mint: string): Promise<CoinRow | null> {
    const r = (await this.q(`SELECT ${COIN_COLUMNS} FROM ${S}.coins WHERE mint = $1`, mint))[0];
    return r ? coin(r) : null;
  }
  async getImage(mint: string): Promise<{ type: string; bytes: Uint8Array } | null> {
    const r = (await this.q(`SELECT image_type, image FROM ${S}.coins WHERE mint = $1`, mint))[0] as { image_type: string | null; image: { $b64: string } | null } | undefined;
    return r?.image && r.image_type ? { type: r.image_type, bytes: Uint8Array.from(Buffer.from(r.image.$b64, 'base64')) } : null;
  }
  async listCoins(statuses: CoinStatus[] = ['LIVE', 'GRADUATED'], limit = 200): Promise<CoinRow[]> {
    return (await this.q(`SELECT ${COIN_COLUMNS} FROM ${S}.coins WHERE status = ANY($1::text[]) ORDER BY created_at DESC LIMIT $2`, statuses, limit)).map(coin);
  }

  // ---------- transactions listed for a coin
  async queueTxs(mint: string, venue: Venue, sigs: { signature: string; slot: number }[], at: string) {
    if (!sigs.length) return;
    await this.gw([{ sql: `INSERT INTO ${S}.txs (sig, mint, venue, slot, status, attempts, next_try, first_seen)
        SELECT s, $2, $3, n, 'PENDING', 0, $4, $4 FROM unnest($1::text[], $5::bigint[]) AS u(s, n) ON CONFLICT (sig, mint) DO NOTHING`,
      params: [sigs.map((s) => s.signature), mint, venue, at, sigs.map((s) => s.slot)] },
      { sql: `UPDATE ${S}.coins SET ${venue === 'CURVE' ? 'curve_cursor' : 'pool_cursor'} = $1 WHERE mint = $2`, params: [sigs[sigs.length - 1]!.signature, mint] }]);
  }
  async dueTxs(nowIso: string, limit: number): Promise<TxRow[]> {
    return (await this.q(`SELECT * FROM ${S}.txs WHERE status <> 'READ' AND next_try <= $1 ORDER BY slot, sig LIMIT $2`, nowIso, limit)).map(tx);
  }
  async missedTx(sig: string, mint: string, p: { status: 'PENDING' | 'UNAVAILABLE'; attempts: number; nextTry: string }) {
    await this.q(`UPDATE ${S}.txs SET status = $1, attempts = $2, next_try = $3 WHERE sig = $4 AND mint = $5`, p.status, p.attempts, p.nextTry, sig, mint);
  }
  async recordTx(sig: string, mint: string, outcome: string, trades: TradeRow[], payouts: PayoutRow[]) {
    await this.gw([
      ...trades.map((r) => ({ sql: `INSERT INTO ${S}.trades (sig, ix, mint, venue, trader, side, quote_raw, base_raw, fee_mint, trade_fee_raw, platform_fee_raw, creator_fee_raw, slot, block_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (sig, ix) DO UPDATE SET mint = EXCLUDED.mint, venue = EXCLUDED.venue, trader = EXCLUDED.trader,
        side = EXCLUDED.side, quote_raw = EXCLUDED.quote_raw, base_raw = EXCLUDED.base_raw, fee_mint = EXCLUDED.fee_mint, trade_fee_raw = EXCLUDED.trade_fee_raw,
        platform_fee_raw = EXCLUDED.platform_fee_raw, creator_fee_raw = EXCLUDED.creator_fee_raw, slot = EXCLUDED.slot, block_time = EXCLUDED.block_time`,
        params: [r.sig, r.ix, r.mint, r.venue, r.trader, r.side, r.quoteRaw, r.baseRaw, r.feeMint, r.tradeFeeRaw, r.platformFeeRaw, r.creatorFeeRaw, r.slot, r.blockTime] })),
      ...payouts.map((r) => ({ sql: `INSERT INTO ${S}.payouts (sig, ix, mint, kind, to_account, amount_raw, slot, block_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (sig, ix) DO UPDATE SET mint = EXCLUDED.mint, kind = EXCLUDED.kind, to_account = EXCLUDED.to_account, amount_raw = EXCLUDED.amount_raw,
        slot = EXCLUDED.slot, block_time = EXCLUDED.block_time`,
        params: [r.sig, r.ix, r.mint, r.kind, r.toAccount, r.amountRaw, r.slot, r.blockTime] })),
      { sql: `UPDATE ${S}.txs SET status = 'READ', outcome = $1 WHERE sig = $2 AND mint = $3`, params: [outcome, sig, mint] },
    ]);
  }
  async unread(mint: string): Promise<{ pending: number; unavailable: number }> {
    const r = (await this.q(`SELECT COUNT(*) FILTER (WHERE status = 'PENDING') AS pending, COUNT(*) FILTER (WHERE status = 'UNAVAILABLE') AS unavailable
      FROM ${S}.txs WHERE mint = $1`, mint))[0]!;
    return { pending: Number(r.pending ?? 0), unavailable: Number(r.unavailable ?? 0) };
  }
  async txOutcomes(mint: string): Promise<Record<string, number>> {
    return Object.fromEntries((await this.q(`SELECT outcome, COUNT(*) AS n FROM ${S}.txs WHERE mint = $1 AND status = 'READ' GROUP BY outcome`, mint))
      .map((r) => [r.outcome as string, Number(r.n)]));
  }

  // ---------- trades and payouts
  async listTrades(mint: string, limit = 200): Promise<TradeRow[]> {
    return (await this.q(`SELECT * FROM ${S}.trades WHERE mint = $1 ORDER BY slot DESC, sig DESC, ix DESC LIMIT $2`, mint, limit)).map(trade);
  }
  async allTrades(mint: string): Promise<TradeRow[]> {
    return (await this.q(`SELECT * FROM ${S}.trades WHERE mint = $1 ORDER BY slot, sig, ix`, mint)).map(trade);
  }
  async recentTrades(limit: number): Promise<(TradeRow & { symbol: string })[]> {
    return (await this.q(`SELECT t.*, c.symbol FROM ${S}.trades t JOIN ${S}.coins c ON c.mint = t.mint ORDER BY t.slot DESC, t.sig DESC, t.ix DESC LIMIT $1`, limit))
      .map((r) => ({ ...trade(r), symbol: r.symbol as string }));
  }
  async tradeStats(mint: string): Promise<{ count: number; volumeQuoteRaw: string; traders: number }> {
    const r = (await this.q(`SELECT COUNT(*) AS count, COALESCE(SUM(quote_raw::numeric), 0)::text AS volume, COUNT(DISTINCT trader) AS traders FROM ${S}.trades WHERE mint = $1`, mint))[0]!;
    return { count: Number(r.count), volumeQuoteRaw: String(r.volume), traders: Number(r.traders) };
  }
  async payouts(mint: string): Promise<PayoutRow[]> {
    return (await this.q(`SELECT * FROM ${S}.payouts WHERE mint = $1 ORDER BY slot, sig, ix`, mint)).map(payout);
  }

  // ---------- intents
  async insertIntent(i: Omit<IntentRow, 'id' | 'status' | 'signature' | 'error'>): Promise<IntentRow> {
    const id = `intent_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')}`;
    await this.q(`INSERT INTO ${S}.intents (id, kind, mint, "user", created_at, expires_at, message_hex, terms_json, last_valid_block_height, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'BUILT')`, id, i.kind, i.mint, i.user, i.createdAt, i.expiresAt, i.messageHex, i.termsJson, i.lastValidBlockHeight);
    return { ...i, id, status: 'BUILT', signature: null, error: null };
  }
  async getIntent(id: string): Promise<IntentRow | null> {
    const r = (await this.q(`SELECT * FROM ${S}.intents WHERE id = $1`, id))[0];
    return r ? (camel(r) as unknown as IntentRow) : null;
  }
  async purgeUnsent(beforeIso: string): Promise<{ coins: number; intents: number }> {
    const [coins, intents] = await this.gw([
      { sql: `DELETE FROM ${S}.coins c WHERE c.created_at < $1 AND (c.status = 'FAILED' OR (c.status = 'PENDING'
          AND EXISTS (SELECT 1 FROM ${S}.intents i WHERE i.mint = c.mint AND i.status = 'BUILT' AND i.expires_at < $1)
          AND NOT EXISTS (SELECT 1 FROM ${S}.intents j WHERE j.mint = c.mint AND j.status <> 'BUILT')))
          AND NOT EXISTS (SELECT 1 FROM ${S}.txs x WHERE x.mint = c.mint) AND NOT EXISTS (SELECT 1 FROM ${S}.trades t WHERE t.mint = c.mint)
          AND NOT EXISTS (SELECT 1 FROM ${S}.payouts p WHERE p.mint = c.mint) RETURNING c.mint`, params: [beforeIso] },
      { sql: `DELETE FROM ${S}.intents WHERE status = 'BUILT' AND expires_at < $1 RETURNING id`, params: [beforeIso] },
    ]);
    return { coins: coins!.length, intents: intents!.length };
  }
  async claimIntent(id: string): Promise<boolean> {
    return (await this.q(`UPDATE ${S}.intents SET status = 'SUBMITTED' WHERE id = $1 AND status = 'BUILT' RETURNING id`, id)).length === 1;
  }
  async finishIntent(id: string, status: 'CONFIRMED' | 'FAILED', signature: string | null, error: string | null) {
    await this.q(`UPDATE ${S}.intents SET status = $1, signature = $2, error = $3 WHERE id = $4`, status, signature, error, id);
  }

  // ---------- faucet
  async faucetClaimsSince(wallet: string, sinceIso: string): Promise<number> {
    return Number((await this.q(`SELECT COUNT(*) AS n FROM ${S}.faucet_claims WHERE wallet = $1 AND at >= $2`, wallet, sinceIso))[0]!.n);
  }
  async insertFaucetClaim(wallet: string, at: string, signature: string) {
    await this.q(`INSERT INTO ${S}.faucet_claims (wallet, at, signature) VALUES ($1, $2, $3)`, wallet, at, signature);
  }
}
