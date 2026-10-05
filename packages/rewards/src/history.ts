// Holder balance history (REWARDS.md §3): every change to every token account of a mint, from each transaction's own
// before and after balances, turned into a balance timeline per owner. Trades, direct wallet-to-wallet transfers, claims
// and anything else that moves the token are all the same kind of change here.
//
// Within one slot the order of transactions is not needed: an account's balance at the end of the slot is its balance
// before the slot plus the sum of (after - before) over that slot's changes. Every account is replayed from zero (its
// creation); the caller compares the replayed balances with the chain's current balances, which proves no change is missing.
import type { BalancePoint } from './twab.ts';

/** One token account's balance in one transaction (before and after), with its owner after the transaction. */
export interface BalanceChange { sig: string; slot: number; account: string; owner: string; preRaw: bigint; postRaw: bigint }
export interface AccountReplay { account: string; owner: string; balanceRaw: bigint; changes: number; firstSlot: number; lastSlot: number }
export interface OwnerHistories {
  /** per owner, one point per slot in which that owner's total changed, sorted by slot (TWAB input) */
  histories: Map<string, BalancePoint[]>;
  accounts: AccountReplay[];
  /** anything that does not replay cleanly; an epoch with problems is not final */
  problems: string[];
}

export function ownerHistories(changes: readonly BalanceChange[], untilSlot = Infinity): OwnerHistories {
  const bySlot = new Map<number, BalanceChange[]>();
  for (const c of changes) {
    if (c.slot >= untilSlot) continue;
    if (c.preRaw < 0n || c.postRaw < 0n) throw new RangeError(`negative balance in ${c.sig}`);
    const l = bySlot.get(c.slot);
    if (l) l.push(c); else bySlot.set(c.slot, [c]);
  }
  const state = new Map<string, { owner: string; balance: bigint; changes: number; firstSlot: number; lastSlot: number }>();
  const totals = new Map<string, bigint>();
  const histories = new Map<string, BalancePoint[]>();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    const perAccount = new Map<string, BalanceChange[]>();
    for (const c of bySlot.get(slot)!) {
      const key = `${c.sig}:${c.account}`;
      if (seen.has(key)) throw new RangeError(`duplicate change ${key}`);
      seen.add(key);
      const l = perAccount.get(c.account);
      if (l) l.push(c); else perAccount.set(c.account, [c]);
    }
    const touched = new Set<string>();
    for (const account of [...perAccount.keys()].sort()) {
      const cs = perAccount.get(account)!;
      const prev = state.get(account);
      const before = prev?.balance ?? 0n;
      const after = before + cs.reduce((s, c) => s + (c.postRaw - c.preRaw), 0n);
      if (after < 0n || !cs.some((c) => c.postRaw === after)) problems.push(`REPLAY_MISMATCH ${account} at slot ${slot}: replayed ${after}, the slot's transactions end at ${cs.map((c) => c.postRaw).join('/')}`);
      if (!prev && !cs.some((c) => c.preRaw === 0n)) problems.push(`HISTORY_NOT_FROM_CREATION ${account}: its first known change at slot ${slot} starts from a non-zero balance`);
      const owners = [...new Set(cs.map((c) => c.owner))].sort();
      if (owners.length > 1) problems.push(`OWNER_CHANGED_TWICE_IN_SLOT ${account} at slot ${slot}: ${owners.join(', ')}`);
      const owner = owners.at(-1)!;
      if (prev) { totals.set(prev.owner, (totals.get(prev.owner) ?? 0n) - prev.balance); touched.add(prev.owner); }
      totals.set(owner, (totals.get(owner) ?? 0n) + (after < 0n ? 0n : after));
      touched.add(owner);
      state.set(account, { owner, balance: after < 0n ? 0n : after, changes: (prev?.changes ?? 0) + cs.length, firstSlot: prev?.firstSlot ?? slot, lastSlot: slot });
    }
    for (const owner of [...touched].sort()) {
      const h = histories.get(owner) ?? [];
      const v = totals.get(owner)!;
      if (h.length ? h.at(-1)!.balanceRaw === v : v === 0n) continue;
      h.push({ t: slot, balanceRaw: v });
      histories.set(owner, h);
    }
  }
  const accounts = [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([account, s]) => ({ account, owner: s.owner, balanceRaw: s.balance, changes: s.changes, firstSlot: s.firstSlot, lastSlot: s.lastSlot }));
  return { histories, accounts, problems };
}

/** Replayed balances against the chain's current balances (read at one slot). Every account the chain lists must replay
 *  to its balance; an account the history knows but the chain no longer lists (closed) must replay to zero. */
export function reconcileWithChain(accounts: readonly AccountReplay[], chain: readonly { account: string; amountRaw: bigint }[]): { ok: boolean; mismatches: string[] } {
  const replayed = new Map(accounts.map((a) => [a.account, a.balanceRaw]));
  const listed = new Map(chain.map((c) => [c.account, c.amountRaw]));
  const mismatches: string[] = [];
  for (const [account, amount] of [...listed].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const r = replayed.get(account);
    if (r === undefined) { if (amount !== 0n) mismatches.push(`${account}: holds ${amount} on chain, no history`); }
    else if (r !== amount) mismatches.push(`${account}: replayed ${r}, on chain ${amount}`);
  }
  for (const [account, r] of replayed) if (!listed.has(account) && r !== 0n) mismatches.push(`${account}: replayed ${r}, not on chain (closed)`);
  return { ok: mismatches.length === 0, mismatches };
}
