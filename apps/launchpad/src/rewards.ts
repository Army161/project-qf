// Holder rewards, devnet (REWARDS.md, ADR-004; Astra's criteria of 2026-10-05). Strategy EPOCH_PROPORTIONAL:
//   balance history (holders.ts) -> 24-hour UTC epochs with finalized slot windows -> slot-weighted TWAB per owner ->
//   exclusions (exclusion@1) -> allocation of the FUNDED amount (allocation-v0-test) -> Merkle root -> epoch artifact.
// Two records stay separate (Astra): the fee ledger decides funding (the earmark: the holder-reward share of the platform
// fees the epoch's trades paid), and the balance history decides who receives it. Only rewards actually deposited for an
// epoch are distributable: an earmark is shown, never allocated. No payout is built or sent here.
import { createHash } from 'node:crypto';
import { CAPABILITY_FLAGS, canonicalJson } from '@project-qf/core';
import { ECONOMICS_V0_TEST } from '@project-qf/policy';
import {
  ALLOCATION_POLICY_V0_TEST, EXCLUSION_POLICY_V1_TEST, computeEpochAllocations, exclusionsFor, ownerHistories, twabBalanceUnits, utcEpochs,
  type BalanceChange, type EpochResult, type NamedExclusion,
} from '@project-qf/rewards';
import type { LaunchpadChain } from './chain.ts';
import type { HolderCoverage } from './holders.ts';
import type { PlatformRecord } from './platform.ts';
import type { LaunchRow, LaunchpadStore, StoredTrade } from './store.ts';

export const REWARDS_LABEL = 'TEST_ONLY devnet holder rewards on valueless test coins';
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const DAMM_V2_POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';
export const ARTIFACT_VERSION = 'qf-reward-epoch@1';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface EpochWindow { epochId: string; startSec: number; endSec: number; startSlot: number | null; nextStartSlot: number | null }

/** The first finalized slot at or after each UTC midnight, from the chain once and then from the store (a finalized
 *  boundary never changes). Null when the chain has not reached that time yet. */
export async function epochBoundary(store: LaunchpadStore, chain: Pick<LaunchpadChain, 'firstSlotAtOrAfter'>, sec: number): Promise<number | null> {
  const known = store.epochSlot(sec);
  if (known) return known.slot;
  const b = await chain.firstSlotAtOrAfter(sec);
  if (b) store.setEpochSlot(sec, b);
  return b?.slot ?? null;
}
export async function epochWindows(store: LaunchpadStore, chain: Pick<LaunchpadChain, 'firstSlotAtOrAfter'>, fromSec: number, nowSec: number): Promise<EpochWindow[]> {
  const out: EpochWindow[] = [];
  for (const e of utcEpochs(fromSec, nowSec)) {
    out.push({ ...e, startSlot: await epochBoundary(store, chain, e.startSec), nextStartSlot: e.endSec <= nowSec ? await epochBoundary(store, chain, e.endSec) : null });
  }
  return out;
}

/** Owners that never receive holder rewards by name: the platform's own accounts and the Meteora pool authorities. The
 *  policy also excludes every other program-derived owner and the burn addresses (exclusion@1). */
export function namedExclusions(p: PlatformRecord): NamedExclusion[] {
  const out: NamedExclusion[] = [{ owner: p.operator, reason: 'QF_OPERATOR' }];
  for (const c of [p.config, ...(p.legacyConfigs ?? [])]) if (c.feeClaimer !== p.operator && c.feeClaimer !== p.treasury?.vault) out.push({ owner: c.feeClaimer, reason: 'QF_PLATFORM_FEE_CLAIMER' });
  if (p.treasury) out.push({ owner: p.treasury.multisig, reason: 'QF_TREASURY_MULTISIG' }, { owner: p.treasury.vault, reason: 'QF_TREASURY_VAULT' });
  out.push({ owner: DBC_POOL_AUTHORITY, reason: 'DBC_POOL_AUTHORITY' }, { owner: DAMM_V2_POOL_AUTHORITY, reason: 'DAMM_V2_POOL_AUTHORITY' });
  return out;
}

export interface RewardDeposit { sig: string; amountRaw: bigint }
export interface EpochCompute {
  launch: Pick<LaunchRow, 'mint' | 'pool' | 'symbol'>;
  cluster: string;
  window: EpochWindow;
  /** every balance change of the coin (the epoch uses those before its window ends) */
  changes: readonly BalanceChange[];
  trades: readonly StoredTrade[];
  named: readonly NamedExclusion[];
  coverage: HolderCoverage | null;
  /** from the previous epoch: holders' amounts below the minimum payout, and the pool's rounding remainder */
  carryIn: Readonly<Record<string, bigint>>; poolCarryInRaw: bigint; previousFinal: boolean;
  /** proven deposits into the rewards vault for this coin and epoch: the only source of distributable rewards */
  deposits: readonly RewardDeposit[];
  rewardsSplitPct?: number;
  /** last finalized slot the history is checked to (for an open epoch's preview) */
  nowSlot?: number;
}
export interface RewardEpoch {
  epochId: string;
  /** FINAL: over, history proven complete through its end, artifact frozen. OPEN: still running (a preview).
   *  INCOMPLETE: over, but something below is not proven yet. */
  status: 'FINAL' | 'OPEN' | 'INCOMPLETE';
  reasons: string[];
  window: { startSec: number; endSec: number; startSlot: number | null; endSlot: number | null; nextStartSlot: number | null; slots: number };
  holders: { owner: string; balanceUnits: string; averageRaw: string; shareBps: number; allocationRaw: string; carryOutRaw: string }[];
  excluded: { owner: string; reason: string; balanceUnits: string }[];
  funding: { earmarkedRaw: string; earmarkTrades: number; unknownFeeTrades: number; fundedRaw: string; poolCarryInRaw: string; deposits: { sig: string; amountRaw: string }[] };
  result: EpochResult | null;
  artifact: Record<string, unknown> | null;
  artifactHash: string | null;
}

/** One epoch for one coin. Deterministic: the same inputs give the same artifact and hash. */
export function computeRewardEpoch(i: EpochCompute): RewardEpoch {
  const w = i.window, reasons: string[] = [];
  const end = w.nextStartSlot ?? (i.nowSlot !== undefined ? i.nowSlot + 1 : null);
  const status0 = w.nextStartSlot === null ? 'OPEN' : 'FINAL';
  if (w.startSlot === null || end === null || end <= w.startSlot) {
    return { epochId: w.epochId, status: 'OPEN', reasons: ['the chain has not reached this epoch yet'], window: { startSec: w.startSec, endSec: w.endSec, startSlot: w.startSlot, endSlot: null, nextStartSlot: w.nextStartSlot, slots: 0 },
      holders: [], excluded: [], funding: { earmarkedRaw: '0', earmarkTrades: 0, unknownFeeTrades: 0, fundedRaw: '0', poolCarryInRaw: i.poolCarryInRaw.toString(), deposits: [] }, result: null, artifact: null, artifactHash: null };
  }
  const window = { start: w.startSlot, end };
  // history: every change before the window ends, replayed per owner
  const used = i.changes.filter((c) => c.slot < end).sort((a, b) => a.slot - b.slot || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : a.account < b.account ? -1 : 1));
  const h = ownerHistories(used, end);
  if (h.problems.length) reasons.push(...h.problems.slice(0, 5).map((p) => `history: ${p}`));
  const cov = i.coverage;
  if (!cov) reasons.push('holder history not checked against the chain yet');
  else if (cov.status !== 'COMPLETE') reasons.push(`holder history ${cov.status.toLowerCase().replace('_', ' ')}: ${cov.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'reading'}`);
  else if (cov.checkedAtSlot < end - 1) reasons.push(`holder history proven to slot ${cov.checkedAtSlot}, before this epoch ends (slot ${end - 1})`);
  if (!i.previousFinal) reasons.push('the previous epoch is not final (its carry-over is not known)');

  // funding: the earmark from the fee ledger (shown), and deposits (distributable)
  const pct = BigInt(i.rewardsSplitPct ?? ECONOMICS_V0_TEST.partnerRewardsSplitPct);
  const inWindow = i.trades.filter((t) => t.slot >= w.startSlot! && t.slot < end);
  const unknown = inWindow.filter((t) => t.venue !== 'DAMM_V2' && t.feeStatus !== 'RESOLVED').length;
  const platformRaw = inWindow.reduce((s, t) => s + (t.feeStatus === 'RESOLVED' && t.feePlatformRaw ? BigInt(t.feePlatformRaw) : 0n), 0n);
  const earmarkedRaw = (platformRaw * pct) / 100n;
  if (unknown) reasons.push(`${unknown} trade(s) in this epoch whose fees are not read yet (the earmark is incomplete)`);
  const depositedRaw = i.deposits.reduce((s, d) => s + d.amountRaw, 0n);
  const fundedRaw = depositedRaw + i.poolCarryInRaw;

  const owners = [...h.histories.keys()];
  const excludedList = exclusionsFor(owners, i.named, EXCLUSION_POLICY_V1_TEST);
  const holders = owners.map((owner) => ({ owner, history: h.histories.get(owner)! }));
  const result = computeEpochAllocations({ epochId: w.epochId, window, fundedRaw, carryIn: i.carryIn, holders, exclusions: excludedList, policy: ALLOCATION_POLICY_V0_TEST });
  const units = new Map(holders.map((x) => [x.owner, twabBalanceUnits(x.history, window)]));
  const excludedSet = new Set(excludedList.map((e) => e.owner));
  const eligible = holders.filter((x) => !excludedSet.has(x.owner) && units.get(x.owner)! > 0n);
  const totalUnits = eligible.reduce((s, x) => s + units.get(x.owner)!, 0n);
  const slots = BigInt(end - w.startSlot);
  const paid = new Map(result.payouts.map((p) => [p.owner, p.amountRaw]));
  const holderRows = eligible.map((x) => {
    const u = units.get(x.owner)!;
    return { owner: x.owner, balanceUnits: u.toString(), averageRaw: (u / slots).toString(), shareBps: totalUnits ? Number((u * 10_000n) / totalUnits) : 0,
      allocationRaw: (paid.get(x.owner) ?? 0n).toString(), carryOutRaw: (result.holderCarryOut[x.owner] ?? 0n).toString() };
  }).sort((a, b) => (BigInt(b.balanceUnits) > BigInt(a.balanceUnits) ? 1 : BigInt(b.balanceUnits) < BigInt(a.balanceUnits) ? -1 : a.owner < b.owner ? -1 : 1));
  const excluded = excludedList.map((e) => ({ ...e, balanceUnits: (units.get(e.owner) ?? 0n).toString() }));

  const status: RewardEpoch['status'] = status0 === 'OPEN' ? 'OPEN' : reasons.length ? 'INCOMPLETE' : 'FINAL';
  const inputHash = sha256(canonicalJson(used.map((c) => [c.slot, c.sig, c.account, c.owner, c.preRaw, c.postRaw])));
  // REWARDS.md §5, plus what this build adds: the coin, the window, the funding and the exclusions. Settlement fields
  // stay null here: the artifact is frozen when the epoch is final, and settlement is reported beside it.
  const artifact = status === 'OPEN' ? null : {
    artifactVersion: ARTIFACT_VERSION, label: REWARDS_LABEL, epochId: w.epochId, chain: `solana-${i.cluster}`, launch: i.launch.pool, mint: i.launch.mint,
    startSlot: w.startSlot, endSlot: end - 1, windowSlots: [w.startSlot, end], weighting: 'slot-weighted TWAB over [startSlot, next epoch startSlot)',
    inputHash, inputChanges: used.length,
    exclusionPolicyVersion: EXCLUSION_POLICY_V1_TEST.version, allocationPolicyVersion: ALLOCATION_POLICY_V0_TEST.version,
    holderAllocationFileHash: result.allocationFileHash, merkleRoot: result.merkle.rootHex,
    totalAllocated: result.payouts.reduce((s, p) => s + p.amountRaw, 0n), rolledForward: result.poolRollForwardRaw + result.holderCarryOutTotalRaw,
    funding: { earmarkedRaw, earmarkPolicy: `${pct}% of the platform fee share (ECONOMICS ${ECONOMICS_V0_TEST.version}, partnerRewardsSplitPct)`, earmarkIsNotFunding: true,
      depositedRaw, poolCarryInRaw: i.poolCarryInRaw, fundedRaw, deposits: i.deposits.map((d) => ({ sig: d.sig, amountRaw: d.amountRaw })) },
    holders: holders.length, eligible: eligible.length, excluded: excludedList,
    settlementTx: null, settlementAdapter: null, claimStatus: { claimed: 0, total: result.payouts.length },
  };
  return { epochId: w.epochId, status, reasons, window: { startSec: w.startSec, endSec: w.endSec, startSlot: w.startSlot, endSlot: end - 1, nextStartSlot: w.nextStartSlot, slots: Number(slots) },
    holders: holderRows, excluded, funding: { earmarkedRaw: earmarkedRaw.toString(), earmarkTrades: inWindow.length, unknownFeeTrades: unknown, fundedRaw: fundedRaw.toString(),
      poolCarryInRaw: i.poolCarryInRaw.toString(), deposits: i.deposits.map((d) => ({ sig: d.sig, amountRaw: d.amountRaw.toString() })) },
    result, artifact, artifactHash: artifact ? sha256(canonicalJson(artifact)) : null };
}

export interface CoinRewards {
  mint: string; symbol: string; status: string;
  coverage: HolderCoverage | null;
  epochs: (RewardEpoch & { frozen: { hash: string; finalizedAt: string; reproduced: boolean } | null })[];
  /** earmarked (fee ledger, not money), deposited (in the rewards vault: distributable), allocated to holders */
  totals: { earmarkedRaw: string; depositedRaw: string; allocatedRaw: string };
}

/** Every epoch of one coin, in order, carrying each final epoch's roll-forward into the next. Final epochs are frozen
 *  in the store the first time; later runs must reproduce the same hash (determinism, REWARDS.md §5). */
export async function coinRewards(o: { store: LaunchpadStore; chain: Pick<LaunchpadChain, 'firstSlotAtOrAfter'>; platform: PlatformRecord; cluster: string; nowSec: number;
  coverage: HolderCoverage | null; changes: readonly BalanceChange[]; deposits?: (epochId: string) => RewardDeposit[] }, launch: LaunchRow): Promise<CoinRewards> {
  const from = Math.floor(new Date(launch.liveAt ?? launch.createdAt).getTime() / 1000);
  const windows = await epochWindows(o.store, o.chain, from, o.nowSec);
  const trades = o.store.listTrades(launch.mint, 100_000);
  const named = namedExclusions(o.platform);
  const epochs: CoinRewards['epochs'] = [];
  let carryIn: Record<string, bigint> = {}, poolCarryInRaw = 0n, previousFinal = true;
  for (const w of windows) {
    const e = computeRewardEpoch({ launch, cluster: o.cluster, window: w, changes: o.changes, trades, named, coverage: o.coverage, carryIn, poolCarryInRaw, previousFinal,
      deposits: o.deposits?.(w.epochId) ?? [], ...(o.coverage ? { nowSlot: o.coverage.checkedAtSlot } : {}) });
    let frozen: CoinRewards['epochs'][number]['frozen'] = null;
    if (e.status === 'FINAL' && e.artifact && e.artifactHash) {
      o.store.saveRewardEpoch(launch.mint, e.epochId, canonicalJson(e.artifact), e.artifactHash, new Date(o.nowSec * 1000).toISOString());
      const f = o.store.getRewardEpoch(launch.mint, e.epochId)!;
      frozen = { hash: f.artifactHash, finalizedAt: f.finalizedAt, reproduced: f.artifactHash === e.artifactHash };
      if (!frozen.reproduced) e.reasons.push(`recomputed artifact ${e.artifactHash.slice(0, 12)}… differs from the frozen ${f.artifactHash.slice(0, 12)}…`);
    }
    epochs.push({ ...e, frozen });
    previousFinal = e.status === 'FINAL';
    carryIn = e.result?.holderCarryOut ?? {};
    poolCarryInRaw = e.result?.poolRollForwardRaw ?? 0n;
  }
  const sum = (f: (e: RewardEpoch) => string) => epochs.reduce((s, e) => s + BigInt(f(e)), 0n).toString();
  return { mint: launch.mint, symbol: launch.symbol, status: launch.status, coverage: o.coverage, epochs,
    totals: { earmarkedRaw: sum((e) => e.funding.earmarkedRaw), depositedRaw: sum((e) => e.funding.deposits.reduce((s, d) => s + BigInt(d.amountRaw), 0n).toString()), allocatedRaw: sum((e) => e.holders.reduce((s, x) => s + BigInt(x.allocationRaw), 0n).toString()) } };
}

// ---------------------------------------------------------------- API views
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** What the page states about money: where rewards come from, what may be paid, and what is switched off. */
export const REWARDS_RULES = Object.freeze({
  strategy: 'EPOCH_PROPORTIONAL',
  funding: 'The fee ledger sets the earmark: the holder-reward share of the platform fees each epoch\'s trades paid. An earmark is not money. Only rewards deposited into the rewards vault for an epoch are distributable.',
  allocation: 'The holder balance history (every transfer, not only trades) sets each holder\'s share: slot-weighted average balance over the epoch, after exclusions.',
  settlement: { mainnet: CAPABILITY_FLAGS.REWARDS_SETTLEMENT_MAINNET, devnet: 'NOT_AUTHORIZED' as const,
    note: 'No payout is built or sent. There is no rewards vault yet, so nothing is deposited and nothing is allocated; devnet test payouts wait for the owner\'s decision.' },
});

export function rewardsOverview(cluster: string, coins: readonly CoinRewards[]) {
  return { cluster, label: REWARDS_LABEL, rules: REWARDS_RULES,
    policies: { exclusion: EXCLUSION_POLICY_V1_TEST, allocation: { ...ALLOCATION_POLICY_V0_TEST, minEligibleBalanceUnits: ALLOCATION_POLICY_V0_TEST.minEligibleBalanceUnits.toString(), minPayoutRaw: ALLOCATION_POLICY_V0_TEST.minPayoutRaw.toString() },
      earmark: { economicsVersion: ECONOMICS_V0_TEST.version, partnerRewardsSplitPct: ECONOMICS_V0_TEST.partnerRewardsSplitPct, label: 'V0_TEST: not approved for production' } },
    rewardsVault: null,
    coins: coins.map((c) => ({ mint: c.mint, symbol: c.symbol, status: c.status, coverage: c.coverage, totals: c.totals,
      epochs: c.epochs.map((e) => ({ epochId: e.epochId, status: e.status, reasons: e.reasons, window: e.window, holders: e.holders.length, excluded: e.excluded.length,
        topHolders: e.holders.slice(0, 3).map((h) => ({ owner: h.owner, shareBps: h.shareBps })), funding: e.funding,
        totalAllocatedRaw: e.holders.reduce((s, h) => s + BigInt(h.allocationRaw), 0n).toString(), merkleRoot: e.result?.merkle.rootHex ?? null, artifactHash: e.artifactHash, frozen: e.frozen })) })) };
}

export function epochDetail(c: CoinRewards, epochId: string) {
  const e = c.epochs.find((x) => x.epochId === epochId);
  if (!e) return null;
  const proofs = e.result ? e.result.payouts.map((p) => ({ owner: p.owner, amountRaw: p.amountRaw.toString(), leaf: hex(e.result!.merkle.leaves.get(p.owner)!),
    proof: e.result!.merkle.proofs.get(p.owner)!.map(hex) })) : [];
  return { mint: c.mint, symbol: c.symbol, label: REWARDS_LABEL, rules: REWARDS_RULES, coverage: c.coverage,
    epoch: { epochId: e.epochId, status: e.status, reasons: e.reasons, window: e.window, holders: e.holders, excluded: e.excluded, funding: e.funding,
      poolRollForwardRaw: e.result?.poolRollForwardRaw.toString() ?? '0', merkleRoot: e.result?.merkle.rootHex ?? null, payouts: proofs,
      artifactHash: e.artifactHash, frozen: e.frozen },
    artifact: e.artifact ? JSON.parse(canonicalJson(e.artifact)) as unknown : null };
}
