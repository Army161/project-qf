// The engine launchpad's indexer and graduation crank. Every transaction that touched a coin's launch account (curve
// phase) or its pool (after graduation) is listed, queued and read; what it did comes from the engine's own events in
// its logs (trades with their exact fees, fee claims, graduation), never from guessing at balance changes. The one
// exception is the pool creator fee, which the pool program pays without an event: it is read from the pool's quote
// vault in a transaction that collects it and does nothing else. A transaction the RPC does not serve yet stays queued
// and counts as missing history until it is read. Nothing is dropped silently.
import * as E from '@project-qf/engine';
import type { EngineChain, TxRecord } from './chain.ts';
import type { CoinRow, EngineStore, PayoutRow, TradeRow, Venue } from './store.ts';

export interface EngineIndexerDeps { store: EngineStore; chain: EngineChain; log?: (m: string) => void; now?: () => Date }
const nowOf = (d: EngineIndexerDeps) => (d.now ?? (() => new Date()))();

/** Retry schedule for listed transactions the RPC did not serve: the first `fastAttempts` on consecutive passes, then a
 *  doubling delay; after `maxAttempts` the transaction is UNAVAILABLE (still missing history, still retried). */
export const TX_RETRY = Object.freeze({ fastAttempts: 5, baseDelayMs: 15_000, maxDelayMs: 3_600_000, maxAttempts: 20, unavailableRetryMs: 6 * 3_600_000, perPass: 25 });
/** Compute units the crank allows a graduation (measured on the real programs: about 196k). */
export const GRADUATE_COMPUTE_UNITS = 300_000;

const COLLECT_CREATOR_FEE = E.POOL_IDL.instructions.find((i) => i.name === 'collect_creator_fee_permissionless')!.discriminator;
const isCollect = (ix: { programAddress: string; dataHex: string }) =>
  ix.programAddress === E.QF_POOL && ix.dataHex.slice(0, 16) === Array.from(COLLECT_CREATOR_FEE, (b: number) => b.toString(16).padStart(2, '0')).join('');

export interface Classified { outcome: string; trades: TradeRow[]; payouts: PayoutRow[]; graduated: { pool: string } | null; created: boolean }
/** What one transaction did to one coin, from its events. `pool` is the coin's pool address (known from its mint). */
export function classifyTx(r: TxRecord, coin: Pick<CoinRow, 'mint' | 'quoteMint'>, pool: string, poolQuoteVault: string): Classified {
  const out: Classified = { outcome: 'OTHER', trades: [], payouts: [], graduated: null, created: false };
  if (r.err) return { ...out, outcome: 'FAILED_TX' };
  if (r.logsTruncated) return { ...out, outcome: 'LOGS_TRUNCATED' };
  const base = { sig: r.signature, mint: coin.mint, slot: r.slot, blockTime: r.blockTime };
  let swaps = 0;
  for (const [ix, e] of r.events.entries()) {
    if (e.program === E.QF_CURVE && 'mint' in e && e.mint !== coin.mint) continue;
    if (e.name === 'LaunchCreated' && e.program === E.QF_CURVE) out.created = true;
    else if (e.name === 'TradeEvent' && e.program === E.QF_CURVE) {
      out.trades.push({ ...base, ix, venue: 'CURVE', trader: e.trader, side: e.isBuy ? 'BUY' : 'SELL', quoteRaw: e.quoteAmount.toString(), baseRaw: e.baseAmount.toString(),
        feeMint: coin.quoteMint, tradeFeeRaw: (e.platformFee + e.creatorFee).toString(), platformFeeRaw: e.platformFee.toString(), creatorFeeRaw: e.creatorFee.toString() });
    } else if (e.name === 'FeesClaimed' && e.program === E.QF_CURVE) {
      out.payouts.push({ ...base, ix, kind: e.creator ? 'CREATOR_CLAIM' : 'PLATFORM_CLAIM', toAccount: e.to, amountRaw: e.amount.toString() });
    } else if (e.name === 'Graduated' && e.program === E.QF_CURVE) {
      out.graduated = { pool: e.pool };
      out.payouts.push({ ...base, ix, kind: 'GRADUATION_FEE', toAccount: null, amountRaw: e.graduationFee.toString() });
    } else if (e.name === 'SwapEvent' && e.program === E.QF_POOL && e.poolId === pool) {
      swaps++;
      const buy = e.inputMint === coin.quoteMint;
      out.trades.push({ ...base, ix, venue: 'POOL', trader: r.feePayer, side: buy ? 'BUY' : 'SELL', quoteRaw: (buy ? e.inputAmount : e.outputAmount).toString(),
        baseRaw: (buy ? e.outputAmount : e.inputAmount).toString(), feeMint: e.inputMint, tradeFeeRaw: e.tradeFee.toString(), platformFeeRaw: null, creatorFeeRaw: e.creatorFee.toString() });
    }
  }
  if (r.instructions.some(isCollect)) {
    const vault = r.tokenChanges.find((c) => c.account === poolQuoteVault);
    if (swaps) return { ...out, outcome: 'MIXED_POOL_TX' }; // a collect next to a swap: the vault change cannot be split
    if (vault && vault.postRaw < vault.preRaw) out.payouts.push({ ...base, ix: r.events.length, kind: 'POOL_CREATOR_COLLECT', toAccount: null, amountRaw: (vault.preRaw - vault.postRaw).toString() });
  }
  out.outcome = out.graduated ? 'GRADUATION' : out.created ? 'CREATE' : out.trades.length ? 'TRADE' : out.payouts.length ? 'PAYOUT' : 'OTHER';
  return out;
}

/** Finds launches on the engine for this store's quote that the store does not know yet (made by another client, or before
 *  this store existed), from each one's creation event, and queues its whole history. The engine's programs are QF's, so
 *  every coin on them belongs on the launchpad. A coin whose creation cannot be read yet is tried again next pass. */
export async function discoverCoins(d: EngineIndexerDeps): Promise<string[]> {
  const quoteMint = d.store.bound('quote');
  if (!quoteMint) return [];
  const added: string[] = [];
  for (const mint of await d.chain.launches(quoteMint)) {
    if (d.store.getCoin(mint)) continue;
    const sigs = await d.chain.signatures(await E.launchAddress(mint), null);
    let created: { r: TxRecord; e: E.LaunchCreatedEvent } | null = null;
    for (const s of sigs.filter((x) => !x.err).slice(0, 5)) {
      const r = await d.chain.tx(s.signature).catch(() => null);
      const e = r?.events.find((x): x is E.LaunchCreatedEvent & { program: string; depth: number } => x.name === 'LaunchCreated' && x.program === E.QF_CURVE && x.mint === mint);
      if (r && e) { created = { r, e }; break; }
    }
    if (!created) { d.log?.(`discover ${mint}: its creation is not readable yet; tried again next pass`); continue; }
    const { r, e } = created, at = nowOf(d).toISOString();
    d.store.insertDiscoveredCoin({ mint, quoteMint, creator: e.creator, name: e.coinName, symbol: e.symbol, metadataUri: e.uri,
      createdAt: r.blockTime === null ? at : new Date(r.blockTime * 1000).toISOString(), createSig: r.signature });
    d.store.queueTxs(mint, 'CURVE', sigs.map((s) => ({ signature: s.signature, slot: s.slot })), at);
    d.log?.(`found $${e.symbol} (${mint}) on the engine; reading its history`);
    added.push(mint);
  }
  return added;
}

/** Lists new transactions on the coin's launch account, and after graduation on its pool, into the read queue. */
export async function listNew(d: EngineIndexerDeps, c: CoinRow): Promise<number> {
  const at = nowOf(d).toISOString();
  const venues: [Venue, string, string | null][] = [['CURVE', await E.launchAddress(c.mint), c.curveCursor]];
  if (c.status === 'GRADUATED' && c.pool) venues.push(['POOL', c.pool, c.poolCursor]);
  let n = 0;
  for (const [venue, addr, cursor] of venues) {
    const sigs = await d.chain.signatures(addr, cursor);
    d.store.queueTxs(c.mint, venue, sigs.map((s) => ({ signature: s.signature, slot: s.slot })), at);
    n += sigs.length;
  }
  return n;
}

/** Reads queued transactions that are due, oldest first. Returns how many were read. */
export async function readDue(d: EngineIndexerDeps): Promise<number> {
  const now = nowOf(d);
  let read = 0;
  for (const t of d.store.dueTxs(now.toISOString(), TX_RETRY.perPass)) {
    const coin = d.store.getCoin(t.mint);
    if (!coin) continue;
    const r = await d.chain.tx(t.sig).catch(() => null);
    if (!r) {
      const attempts = t.attempts + 1, unavailable = attempts >= TX_RETRY.maxAttempts;
      const delay = unavailable ? TX_RETRY.unavailableRetryMs : attempts < TX_RETRY.fastAttempts ? 0 : Math.min(TX_RETRY.baseDelayMs * 2 ** (attempts - TX_RETRY.fastAttempts), TX_RETRY.maxDelayMs);
      d.store.missedTx(t.sig, t.mint, { status: unavailable ? 'UNAVAILABLE' : 'PENDING', attempts, nextTry: new Date(now.getTime() + delay).toISOString() });
      if (unavailable && t.status !== 'UNAVAILABLE') d.log?.(`index ${coin.symbol}: ${t.sig} not served after ${attempts} attempts; counted as missing history, retried every ${TX_RETRY.unavailableRetryMs / 3_600_000} h`);
      continue;
    }
    const pool = await E.launchPoolAddress(coin.mint);
    const vaults = await E.poolAccounts(pool, coin.mint, coin.quoteMint);
    const c = classifyTx(r, coin, pool, vaults.token0 === coin.quoteMint ? vaults.vault0 : vaults.vault1);
    d.store.recordTx(t.sig, t.mint, c.outcome, c.trades, c.payouts);
    if (c.outcome === 'LOGS_TRUNCATED' || c.outcome === 'MIXED_POOL_TX') d.log?.(`index ${coin.symbol}: ${t.sig} is ${c.outcome}; its fees are reported as unknown`);
    if (c.created) d.store.markLive(coin.mint, t.sig, now.toISOString());
    if (c.graduated) {
      if (c.graduated.pool !== pool) d.log?.(`index ${coin.symbol}: graduated into ${c.graduated.pool}, expected ${pool}`);
      d.store.markGraduated(coin.mint, c.graduated.pool, t.sig, now.toISOString());
    }
    read++;
  }
  return read;
}

/** Graduates every live coin whose curve is sold out (anyone may; the operator pays and gets the rent back in the same
 *  transaction), and records coins that someone else graduated. Returns the graduations it sent. */
export async function crankGraduations(d: EngineIndexerDeps): Promise<{ mint: string; signature: string }[]> {
  const out: { mint: string; signature: string }[] = [];
  for (const c of d.store.listCoins(['LIVE'])) {
    const s = await E.readCoin(d.chain.read, c.mint, c.quoteMint).catch((e) => { d.log?.(`crank read ${c.symbol}: ${(e as Error).message.slice(0, 200)}`); return null; });
    if (!s) continue;
    const l = s.launch;
    if (l.status === 'Graduated') { d.store.markGraduated(c.mint, l.pool, null, nowOf(d).toISOString()); continue; }
    if (l.status !== 'Complete' || !d.chain.operatorAddress) continue;
    try {
      d.log?.(`graduating ${c.symbol} (${c.mint})`);
      const ix = await E.graduateIx({ payer: d.chain.operatorAddress, mint: c.mint, quoteMint: c.quoteMint, ammConfig: l.ammConfig, creator: l.creator, createPoolFee: E.POOL_FEE_RECEIVER });
      const signature = await d.chain.sendAsOperator([ix], GRADUATE_COMPUTE_UNITS);
      d.store.markGraduated(c.mint, await E.launchPoolAddress(c.mint), signature, nowOf(d).toISOString());
      out.push({ mint: c.mint, signature });
    } catch (e) {
      d.log?.(`graduation of ${c.symbol} failed: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  return out;
}

/** A launch the app built but never saw confirmed: live if its launch account exists, failed once its intent expired
 *  without one. (A send can fail on our side after the network accepted it.) */
export async function settlePending(d: EngineIndexerDeps, olderThanMs: number): Promise<void> {
  const cutoff = nowOf(d).getTime() - olderThanMs;
  for (const c of d.store.listCoins(['PENDING'])) {
    if (Date.parse(c.createdAt) > cutoff) continue;
    const [acc] = await d.chain.read([await E.launchAddress(c.mint)]);
    if (acc) d.store.markLive(c.mint, null, nowOf(d).toISOString());
    else d.store.markFailed(c.mint);
  }
}

/** Read-only catch-up, for `verify` on any machine and any store, even a new one: finds every coin on the engine and
 *  reads its whole history, curve then pool. Nothing is sent: no crank, no faucet. */
export async function catchUp(d: EngineIndexerDeps, maxReads = 40): Promise<void> {
  await discoverCoins(d);
  for (let round = 0; round < 2; round++) {   // a coin found live may turn out graduated: then its pool's history too
    for (const c of d.store.listCoins(['LIVE', 'GRADUATED'], 10_000)) await listNew(d, c).catch((e) => d.log?.(`list ${c.symbol}: ${(e as Error).message.slice(0, 200)}`));
    for (let k = 0; k < maxReads && (await readDue(d)) > 0; k++);
  }
}

/** One pass: settle, discover, list, read, crank. Each coin's failure is logged and never stops the others. */
export async function indexPass(d: EngineIndexerDeps, pendingAfterMs = 180_000): Promise<void> {
  await settlePending(d, pendingAfterMs).catch((e) => d.log?.(`pending launches: ${(e as Error).message.slice(0, 200)}`));
  await discoverCoins(d).catch((e) => d.log?.(`discover: ${(e as Error).message.slice(0, 200)}`));
  for (const c of d.store.listCoins(['LIVE', 'GRADUATED'])) await listNew(d, c).catch((e) => d.log?.(`list ${c.symbol}: ${(e as Error).message.slice(0, 200)}`));
  await readDue(d).catch((e) => d.log?.(`read: ${(e as Error).message.slice(0, 200)}`));
  await crankGraduations(d);
}

/** Background loop: one pass every `intervalMs`, never two at once. */
export function startEngineBackground(d: EngineIndexerDeps, intervalMs = 15_000): () => void {
  let stopped = false, running = false;
  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try { await indexPass(d); } catch (e) { d.log?.(`background pass failed: ${(e as Error).message.slice(0, 200)}`); } finally { running = false; }
  };
  const t = setInterval(pass, intervalMs);
  void pass();
  return () => { stopped = true; clearInterval(t); };
}
