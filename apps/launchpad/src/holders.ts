// Holder balance history (rewards, REWARDS.md §3). For each coin: every token account of the mint (listed by the
// chain, and any other account a read transaction shows), every finalized transaction that touched one of them, and
// every token-account balance change in those transactions. A buy, a sell, a direct wallet-to-wallet transfer, a burn:
// all are the same kind of change, read from the transaction's own before and after balances.
//
// Completeness is proven, not assumed: every account is replayed from zero, and the replayed balances must equal the
// chain's balances for every listed account (closed accounts must replay to zero), and the listed accounts must add up
// to the mint's supply. Until that holds, a reward epoch that depends on the history is not final.
import { ownerHistories, reconcileWithChain, type BalanceChange } from '@project-qf/rewards';
import type { IndexerDeps } from './indexer.ts';
import type { HolderChangeRow, LaunchRow, LaunchpadStore } from './store.ts';

/** Transactions read per coin per pass (public RPCs rate-limit), and how many PENDING ones are retried first. */
export const HOLDERS = Object.freeze({ txPerPass: 40, retriesPerPass: 10 });
const nowIso = (d: IndexerDeps) => (d.now ?? (() => new Date()))().toISOString();

async function readTx(d: IndexerDeps, launch: LaunchRow, sig: string, listedSlot: number | null): Promise<'DONE' | 'PENDING' | 'FAILED_TX'> {
  const at = nowIso(d);
  const t = await d.chain.tokenBalanceChanges(sig).catch(() => null);
  if (!t) { d.store.recordHolderTx(launch.mint, sig, { status: 'PENDING', slot: listedSlot, at }); return 'PENDING'; }
  if (t.err) { d.store.recordHolderTx(launch.mint, sig, { status: 'FAILED_TX', slot: t.slot, at }); return 'FAILED_TX'; }
  const mine = t.balances.filter((b) => b.mint === launch.mint);
  for (const b of mine) d.store.addHolderAccount(launch.mint, b.account, at); // an account the listing did not show (closed since)
  d.store.recordHolderTx(launch.mint, sig, { status: 'DONE', slot: t.slot, at, changes: mine.map((b) => ({ sig, slot: t.slot, blockTime: t.blockTime,
    account: b.account, owner: b.owner, preRaw: b.preRaw.toString(), postRaw: b.postRaw.toString() })) });
  return 'DONE';
}

/** One pass for one coin. `caughtUp` is true when every known account's signature list was read to the end within the
 *  budget and no listed transaction is still waiting to be served. */
export async function syncHolders(d: IndexerDeps, launch: LaunchRow, budget: number = HOLDERS.txPerPass): Promise<{ read: number; caughtUp: boolean }> {
  const at = nowIso(d);
  for (const a of (await d.chain.mintTokenAccounts(launch.mint)).accounts) d.store.addHolderAccount(launch.mint, a.account, at);
  let read = 0, exhausted = false;
  for (const p of d.store.pendingHolderTxs(launch.mint, HOLDERS.retriesPerPass)) {
    if (read >= budget) { exhausted = true; break; }
    read++;
    if (await readTx(d, launch, p.sig, p.slot) === 'PENDING' && p.attempts + 1 === 20) d.log?.(`holders ${launch.symbol}: ${p.sig} still not served after 20 attempts; history stays incomplete until it is`);
  }
  // accounts discovered during the pass are read on the next one
  for (const { account, cursor } of d.store.holderAccounts(launch.mint)) {
    if (exhausted) break;
    const sigs = await d.chain.finalizedSignatures(account, cursor);
    for (const s of sigs) {
      if (!d.store.holderTx(launch.mint, s.signature)) {
        if (read >= budget) { exhausted = true; break; }
        read++;
        await readTx(d, launch, s.signature, s.slot);
      }
      d.store.setHolderCursor(launch.mint, account, s.signature);
    }
  }
  return { read, caughtUp: !exhausted && d.store.holderTxCounts(launch.mint).pending === 0 };
}

export const toBalanceChanges = (rows: readonly HolderChangeRow[]): BalanceChange[] =>
  rows.map((r) => ({ sig: r.sig, slot: r.slot, account: r.account, owner: r.owner, preRaw: BigInt(r.preRaw), postRaw: BigInt(r.postRaw) }));

export interface HolderCoverage {
  mint: string;
  /** COMPLETE: the history replays to the chain at `checkedAtSlot`. CATCHING_UP: still reading. MISMATCH: it does not. */
  status: 'COMPLETE' | 'CATCHING_UP' | 'MISMATCH';
  checkedAtSlot: number; checkedAt: string;
  accounts: number; transactions: number; pending: number; failed: number; changes: number;
  checks: { id: string; ok: boolean; detail: string }[];
  /** single provider on devnet: the reads are not cross-checked */
  providers: 'SINGLE_PROVIDER';
}

/** Checks the stored history against the chain now: the listed accounts (one finalized slot) and the supply. */
export async function checkHolderCoverage(d: IndexerDeps, launch: LaunchRow, caughtUp: boolean): Promise<HolderCoverage> {
  const listed = await d.chain.mintTokenAccounts(launch.mint);
  const supply = await d.chain.mintSupply(launch.mint);
  const counts = d.store.holderTxCounts(launch.mint);
  const replay = ownerHistories(toBalanceChanges(d.store.holderChanges(launch.mint)), listed.slot + 1);
  const later = d.store.holderChanges(launch.mint).filter((c) => c.slot > listed.slot).length;
  const rec = reconcileWithChain(replay.accounts, listed.accounts);
  const listedTotal = listed.accounts.reduce((s, a) => s + a.amountRaw, 0n);
  const checks = [
    { id: 'ALL_TRANSACTIONS_READ', ok: caughtUp && counts.pending === 0, detail: caughtUp ? `${counts.done} read, ${counts.failed} failed (no balance change), ${counts.pending} not served yet` : 'still reading signatures' },
    { id: 'REPLAYS_CLEANLY', ok: replay.problems.length === 0, detail: replay.problems.length ? replay.problems.slice(0, 5).join('; ') : `${replay.accounts.length} account(s) replayed from creation` },
    { id: 'REPLAY_EQUALS_CHAIN', ok: rec.ok && later === 0, detail: rec.ok ? (later ? `${later} change(s) after the listing slot; checked again next pass` : `every account's replayed balance equals the chain at slot ${listed.slot}`) : rec.mismatches.slice(0, 5).join('; ') },
    { id: 'ACCOUNTS_ADD_UP_TO_SUPPLY', ok: listedTotal === supply.supplyRaw, detail: `${listed.accounts.length} account(s) hold ${listedTotal}; supply ${supply.supplyRaw} (slot ${supply.slot})` },
  ];
  const status = checks.every((c) => c.ok) ? 'COMPLETE' : !caughtUp || counts.pending > 0 || later > 0 ? 'CATCHING_UP' : 'MISMATCH';
  return { mint: launch.mint, status, checkedAtSlot: listed.slot, checkedAt: nowIso(d), accounts: counts.accounts, transactions: counts.done + counts.failed, pending: counts.pending,
    failed: counts.failed, changes: counts.changes, checks, providers: 'SINGLE_PROVIDER' };
}

export const coverageKey = (mint: string) => `holderCoverage:${mint}`;
export const storedCoverage = (store: LaunchpadStore, mint: string) => store.getPlatform<HolderCoverage>(coverageKey(mint));

/** Background step for all coins: read, then check coverage when caught up (the result is stored for the API). */
export async function syncAllHolders(d: IndexerDeps): Promise<void> {
  for (const l of d.store.listLaunches(['LIVE', 'MIGRATED'])) {
    try {
      const { caughtUp } = await syncHolders(d, l);
      const prev = storedCoverage(d.store, l.mint);
      // a full check costs two reads; while catching up the last result stands, marked as catching up
      if (caughtUp) d.store.setPlatform(coverageKey(l.mint), await checkHolderCoverage(d, l, true));
      else if (prev) d.store.setPlatform(coverageKey(l.mint), { ...prev, status: 'CATCHING_UP' });
    } catch (e) {
      d.log?.(`holders ${l.symbol}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}
