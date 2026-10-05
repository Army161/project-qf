// The rewards vault's own history (holder rewards, devnet). The rewards vault is the treasury multisig's vault index 1.
// Its quote account is read like a holder account: every finalized transaction that touched it, with that transaction's
// own before and after balances and its memo. That is the only source of deposits and payouts:
//   - DEPOSIT: the balance went up and the memo is `qf-rewards-deposit@1 mint=<coin> epoch=<day>`. It funds that coin's
//     epoch only if it landed before the epoch ended; a later one stays in the vault, listed, and funds nothing.
//   - PAYOUT: the balance went down and the memo is `qf-rewards-payout@1 mint=<coin> epoch=<day> artifact=<hash>`. The
//     recipients are the other quote accounts whose balance went up in the same transaction.
//   - UNTAGGED: anything else that moved the balance. Listed, never counted.
// Nothing here trusts the app's own records of proposals: a deposit made outside the app counts the same way.
import { derive, PROGRAM_IDS, squads } from '@project-qf/tx';
import type { IndexerDeps } from './indexer.ts';
import type { PlatformRecord } from './platform.ts';
import type { RewardVaultTxRow } from './store.ts';
import type { RewardDeposit } from './rewards.ts';

const DEPOSIT_MEMO = /^qf-rewards-deposit@1 mint=([1-9A-HJ-NP-Za-km-z]{32,44}) epoch=(\d{4}-\d{2}-\d{2})$/;
const PAYOUT_MEMO = /^qf-rewards-payout@1 mint=([1-9A-HJ-NP-Za-km-z]{32,44}) epoch=(\d{4}-\d{2}-\d{2}) artifact=([0-9a-f]{64})$/;
export const REWARDS_VAULT = Object.freeze({ txPerPass: 30 });
const coverageKey = 'rewardsVaultCoverage';

export interface RewardsVault { multisig: string; vault: string; quoteAccount: string; quoteMint: string }
export async function rewardsVaultOf(p: PlatformRecord): Promise<RewardsVault | null> {
  if (!p.treasury) return null;
  const vault = await squads.squadsVault(p.treasury.multisig, 1);
  return { multisig: p.treasury.multisig, vault, quoteAccount: await derive.ata(vault, p.quote.mint, PROGRAM_IDS.TOKEN), quoteMint: p.quote.mint };
}
/** How far the vault's history is read: every finalized transaction at or before `checkedToSlot` is in the store. */
export interface RewardsVaultCoverage { account: string; checkedToSlot: number; caughtUp: boolean; pending: number; checkedAt: string }
export const storedVaultCoverage = (d: Pick<IndexerDeps, 'store'>) => d.store.getPlatform<RewardsVaultCoverage>(coverageKey);

/** Classifies one transaction from its balances and memo (pure). */
export function classifyVaultTx(account: string, quoteMint: string, t: { balances: { account: string; mint: string; owner: string; preRaw: bigint; postRaw: bigint }[]; memos?: string[] }):
  Pick<RewardVaultTxRow, 'kind' | 'mint' | 'epochId' | 'artifactHash' | 'deltaRaw' | 'transfersJson' | 'memo'> {
  const mine = t.balances.find((b) => b.account === account);
  const delta = mine ? mine.postRaw - mine.preRaw : 0n;
  const memos = (t.memos ?? []).filter((m) => m.startsWith('qf-rewards-'));
  const memo = memos.length === 1 ? memos[0]! : null;
  const base = { deltaRaw: delta.toString(), memo: memos.join(' | ') || null, mint: null, epochId: null, artifactHash: null, transfersJson: null };
  if (delta === 0n) return { ...base, kind: 'NONE' };
  const dep = memo ? DEPOSIT_MEMO.exec(memo) : null;
  if (delta > 0n && dep) return { ...base, kind: 'DEPOSIT', mint: dep[1]!, epochId: dep[2]! };
  const pay = memo ? PAYOUT_MEMO.exec(memo) : null;
  if (delta < 0n && pay) {
    const transfers = t.balances.filter((b) => b.mint === quoteMint && b.account !== account && b.postRaw > b.preRaw)
      .map((b) => ({ owner: b.owner, amountRaw: (b.postRaw - b.preRaw).toString() }));
    return { ...base, kind: 'PAYOUT', mint: pay[1]!, epochId: pay[2]!, artifactHash: pay[3]!, transfersJson: JSON.stringify(transfers) };
  }
  return { ...base, kind: 'UNTAGGED' };
}

/** One pass: read the vault account's new finalized transactions (retrying any not served yet). */
export async function syncRewardsVault(d: IndexerDeps, p: PlatformRecord): Promise<RewardsVaultCoverage | null> {
  const v = await rewardsVaultOf(p);
  if (!v) return null;
  const at = (d.now ?? (() => new Date()))().toISOString();
  // every finalized transaction at or before this slot is in the listing that follows it
  const slot = await d.chain.finalizedSlot();
  const read = async (sig: string, listedSlot: number | null) => {
    const t = await d.chain.tokenBalanceChanges(sig).catch(() => null);
    const empty = { kind: null, mint: null, epochId: null, artifactHash: null, deltaRaw: null, transfersJson: null, memo: null };
    if (!t) return d.store.recordRewardVaultTx({ sig, account: v.quoteAccount, slot: listedSlot, blockTime: null, status: 'PENDING', ...empty, updatedAt: at });
    if (t.err) return d.store.recordRewardVaultTx({ sig, account: v.quoteAccount, slot: t.slot, blockTime: t.blockTime, status: 'FAILED_TX', ...empty, updatedAt: at });
    d.store.recordRewardVaultTx({ sig, account: v.quoteAccount, slot: t.slot, blockTime: t.blockTime, status: 'DONE', ...classifyVaultTx(v.quoteAccount, v.quoteMint, t), updatedAt: at });
  };
  let budget = REWARDS_VAULT.txPerPass, exhausted = false;
  for (const r of d.store.listRewardVaultTxs(v.quoteAccount).filter((x) => x.status === 'PENDING')) {
    if (budget-- <= 0) { exhausted = true; break; }
    await read(r.sig, r.slot);
  }
  const cursorKey = `rewardsVaultCursor:${v.quoteAccount}`;
  let cursor = d.store.getPlatform<string>(cursorKey);
  if (!exhausted) {
    for (const s of await d.chain.finalizedSignatures(v.quoteAccount, cursor)) {
      if (!d.store.rewardVaultTx(s.signature)) {
        if (budget-- <= 0) { exhausted = true; break; }
        await read(s.signature, s.slot);
      }
      cursor = s.signature;
      d.store.setPlatform(cursorKey, cursor);
    }
  }
  const pending = d.store.listRewardVaultTxs(v.quoteAccount).filter((x) => x.status === 'PENDING').length;
  const prev = storedVaultCoverage(d);
  const cov: RewardsVaultCoverage = { account: v.quoteAccount, checkedToSlot: !exhausted && pending === 0 ? slot : (prev?.account === v.quoteAccount ? prev.checkedToSlot : 0),
    caughtUp: !exhausted && pending === 0, pending, checkedAt: at };
  d.store.setPlatform(coverageKey, cov);
  return cov;
}

/** Deposits tagged for this coin (all epochs; the epoch computation keeps those inside its window). */
export function depositsFor(rows: readonly RewardVaultTxRow[], mint: string): (RewardDeposit & { epochId: string })[] {
  return rows.filter((r) => r.status === 'DONE' && r.kind === 'DEPOSIT' && r.mint === mint && r.slot !== null)
    .map((r) => ({ sig: r.sig, amountRaw: BigInt(r.deltaRaw!), slot: r.slot!, epochId: r.epochId! }));
}
export function payoutsFor(rows: readonly RewardVaultTxRow[], mint: string, epochId: string) {
  return rows.filter((r) => r.status === 'DONE' && r.kind === 'PAYOUT' && r.mint === mint && r.epochId === epochId)
    .map((r) => ({ sig: r.sig, slot: r.slot!, blockTime: r.blockTime, artifactHash: r.artifactHash!, paidRaw: (-BigInt(r.deltaRaw!)).toString(),
      transfers: JSON.parse(r.transfersJson ?? '[]') as { owner: string; amountRaw: string }[] }));
}
