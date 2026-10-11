// The engine launchpad's books: per coin, the chain's own numbers against each other and against every event the
// indexer read. Each check is PASS (exact), FAIL (they disagree) or WAIT (something is not read yet). No tolerance:
// the engine's events carry exact amounts, so a single raw unit off is a FAIL.
//
//   curve vaults        quote vault = real quote + unclaimed platform fees + unclaimed creator fees
//                       coin vault  = supply - coins sold (- the pool's coins once graduated)
//   curve state         the last trade event's real quote and coins sold = the launch account's (before graduation)
//   platform fees       every trade's platform fee + the graduation fee - platform claims = unclaimed platform fees
//   creator fees        every trade's creator fee - creator claims = unclaimed creator fees
//   pool liquidity      after graduation, the LP mint's supply is 0: no one can withdraw the pool
//   pool creator fees   every pool swap's creator fee - collected = the pool's uncollected creator fee
import * as E from '@project-qf/engine';
import type { EngineChain } from './chain.ts';
import { poolSides, readCoinSnapshot, type QuoteAsset } from './market.ts';
import type { CoinRow, EngineStore } from './store.ts';

export type Verdict = 'PASS' | 'FAIL' | 'WAIT';
export interface BookCheck { verdict: Verdict; coin: string; check: string; detail: string }
export interface EngineBooks { asOf: string; cluster: string; quote: QuoteAsset; checks: BookCheck[]; summary: { pass: number; fail: number; wait: number } }

const units = (raw: bigint, decimals: number) => {
  const neg = raw < 0n, a = neg ? -raw : raw, s = a.toString().padStart(decimals + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -decimals) || '0'}.${s.slice(-decimals)}`;
};
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export async function coinChecks(store: EngineStore, chain: EngineChain, c: CoinRow, quote: QuoteAsset): Promise<BookCheck[]> {
  const coin = `$${c.symbol}`, q = (raw: bigint) => `${units(raw, quote.decimals)} ${quote.symbol}`, b = (raw: bigint) => `${units(raw, E.BASE_DECIMALS)} ${coin}`;
  const out: BookCheck[] = [];
  const add = (verdict: Verdict, check: string, detail: string) => out.push({ verdict, coin, check, detail });
  const exact = (check: string, want: bigint, got: bigint, fmt: (x: bigint) => string, what: string) =>
    add(want === got ? 'PASS' : 'FAIL', check, want === got ? `${what} ${fmt(got)}` : `${what}: expected ${fmt(want)}, chain holds ${fmt(got)} (off by ${fmt(got - want)})`);

  const s = await readCoinSnapshot(chain.read, c.mint, c.quoteMint).catch(() => null);
  if (!s) { add('WAIT', 'coin is readable', 'its launch account could not be read'); return out; }
  const l = s.coin.launch, graduated = l.status === 'Graduated';
  exact('curve quote vault matches the curve', l.realQuote + l.platformFees + l.creatorFees, s.coin.quoteVault, q, 'vault holds');
  exact('curve coin vault matches the curve', l.config.totalSupply - l.baseSold - (graduated ? E.poolSupply(l.config) : 0n), s.coin.baseVault, b, 'vault holds');

  // the event ledger: complete only when every listed transaction was read and none had its log cut or mixed
  const unread = store.unread(c.mint), outcomes = store.txOutcomes(c.mint);
  const unknown = (outcomes.LOGS_TRUNCATED ?? 0) + (outcomes.MIXED_POOL_TX ?? 0);
  const gap = unread.pending + unread.unavailable ? `${unread.pending} transaction(s) not read yet, ${unread.unavailable} not served after many tries` : unknown ? `${unknown} transaction(s) whose events cannot be fully read` : null;
  const trades = store.allTrades(c.mint), payouts = store.payouts(c.mint);
  const curve = trades.filter((t) => t.venue === 'CURVE'), pool = trades.filter((t) => t.venue === 'POOL');
  const paid = (kind: string) => sum(payouts.filter((p) => p.kind === kind).map((p) => BigInt(p.amountRaw)));
  const ledger = (check: string, want: bigint, got: bigint, how: string) => {
    if (gap) add('WAIT', check, gap);
    else add(want === got ? 'PASS' : 'FAIL', check, want === got ? `${how} = ${q(got)} unclaimed` : `${how} = ${q(want)}, chain holds ${q(got)} unclaimed (off by ${q(got - want)})`);
  };
  if (!graduated) {
    const last = curve.at(-1);
    if (gap) add('WAIT', 'curve state follows its last trade', gap);
    else if (!last) add(l.realQuote === 0n && l.baseSold === 0n ? 'PASS' : 'FAIL', 'curve state follows its last trade', `no trades; real quote ${q(l.realQuote)}, coins sold ${b(l.baseSold)}`);
    else {
      // the trade event carries the curve's state after the trade; the newest one must equal the account now
      const after = await lastTradeState(chain, last.sig, c.mint);
      if (!after) add('WAIT', 'curve state follows its last trade', `its last trade ${last.sig} could not be re-read`);
      else add(after.realQuote === l.realQuote && after.baseSold === l.baseSold ? 'PASS' : 'FAIL', 'curve state follows its last trade',
        `last trade left real quote ${q(after.realQuote)} and ${b(after.baseSold)} sold; the account holds ${q(l.realQuote)} and ${b(l.baseSold)}`);
    }
  }
  const platformEarned = sum(curve.map((t) => BigInt(t.platformFeeRaw ?? '0'))) + paid('GRADUATION_FEE');
  ledger('platform curve fees add up', platformEarned - paid('PLATFORM_CLAIM'), l.platformFees,
    `${curve.length} trade(s)${graduated ? ' + graduation fee' : ''} - claims`);
  ledger('creator curve fees add up', sum(curve.map((t) => BigInt(t.creatorFeeRaw))) - paid('CREATOR_CLAIM'), l.creatorFees, `${curve.length} trade(s) - claims`);

  if (graduated) {
    if (s.lpMintSupply === null) add('WAIT', 'pool liquidity is locked for good', 'the pool or its LP mint could not be read');
    else add(s.lpMintSupply === 0n ? 'PASS' : 'FAIL', 'pool liquidity is locked for good', `LP mint supply ${s.lpMintSupply} (every LP token burned at graduation)`);
    if (!s.pool) add('WAIT', 'pool creator fees add up', 'the pool could not be read');
    else ledger('pool creator fees add up', sum(pool.map((t) => BigInt(t.creatorFeeRaw))) - paid('POOL_CREATOR_COLLECT'), poolSides(s.pool, c.quoteMint).creatorFeesQuote,
      `${pool.length} pool swap(s) - collected`);
  }
  return out;
}

async function lastTradeState(chain: EngineChain, sig: string, mint: string) {
  const r = await chain.tx(sig).catch(() => null);
  const e = r?.events.filter((x): x is E.TradeEvent & { program: string; depth: number } => x.name === 'TradeEvent' && x.mint === mint).at(-1);
  return e ? { realQuote: e.realQuote, baseSold: e.baseSold } : null;
}

export async function engineBooks(store: EngineStore, chain: EngineChain, quote: QuoteAsset, cluster: string, now = new Date()): Promise<EngineBooks> {
  const checks: BookCheck[] = [];
  for (const c of store.listCoins(['LIVE', 'GRADUATED'], 10_000).reverse()) checks.push(...await coinChecks(store, chain, c, quote));
  const summary = { pass: checks.filter((x) => x.verdict === 'PASS').length, fail: checks.filter((x) => x.verdict === 'FAIL').length, wait: checks.filter((x) => x.verdict === 'WAIT').length };
  return { asOf: now.toISOString(), cluster, quote, checks, summary };
}

export function engineBooksText(b: EngineBooks): string {
  const w = Math.max(...b.checks.map((x) => x.coin.length), 4);
  return [`Books checked ${b.asOf} (${b.cluster}, QF engine)`, '', ...b.checks.map((x) => `${x.verdict.padEnd(4)}  ${x.coin.padEnd(w)}  ${x.check}: ${x.detail}`), '',
    `${b.summary.pass} PASS, ${b.summary.fail} FAIL, ${b.summary.wait} WAIT`].join('\n');
}
