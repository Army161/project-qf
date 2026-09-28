// EPOCH_PROPORTIONAL allocation (REWARDS.md §3): exclusions -> TWAB weights -> floor division ->
// per-holder minimum payout with roll-forward -> pool rounding remainder rolls forward.
// Conservation is asserted: payouts + holder carry-out + pool roll-forward == funded + carry-in.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '@project-qf/core';
import { twabBalanceUnits, type BalancePoint, type Window } from './twab.ts';
import { buildMerkle, type MerkleResult } from './merkle.ts';

export interface AllocationPolicy { id: 'allocation'; version: string; exclusionPolicyVersion: string; minEligibleBalanceUnits: bigint; minPayoutRaw: bigint }
export const ALLOCATION_POLICY_V0_TEST: Readonly<AllocationPolicy> = Object.freeze({
  id: 'allocation', version: 'allocation-v0-test', exclusionPolicyVersion: 'exclusion@1', minEligibleBalanceUnits: 0n, minPayoutRaw: 1n,
});

export interface EpochInput {
  epochId: string;
  window: Window;
  fundedRaw: bigint;
  carryIn: Readonly<Record<string, bigint>>;
  holders: readonly { owner: string; history: readonly BalancePoint[] }[];
  exclusions: readonly { owner: string; reason: string }[];
  policy: AllocationPolicy;
}

export interface EpochResult {
  epochId: string;
  payouts: { owner: string; amountRaw: bigint }[];
  holderCarryOut: Record<string, bigint>;
  holderCarryOutTotalRaw: bigint;
  poolRollForwardRaw: bigint;
  excluded: { owner: string; reason: string }[];
  ineligible: { owner: string; balanceUnits: bigint }[];
  conservation: { ok: true; inRaw: bigint; outRaw: bigint };
  allocationFileHash: string;
  merkle: MerkleResult;
}

const byOwner = <T extends { owner: string }>(a: T, b: T) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0);

export function computeEpochAllocations(i: EpochInput): EpochResult {
  if (i.fundedRaw < 0n) throw new RangeError('fundedRaw negative');
  const seen = new Set<string>();
  for (const h of i.holders) { if (seen.has(h.owner)) throw new RangeError(`duplicate holder ${h.owner}`); seen.add(h.owner); }
  for (const [o, v] of Object.entries(i.carryIn)) if (v < 0n) throw new RangeError(`negative carry-in for ${o}`);

  const exclusionReason = new Map(i.exclusions.map((e) => [e.owner, e.reason]));
  const excluded: EpochResult['excluded'] = [];
  const ineligible: EpochResult['ineligible'] = [];
  const weights: { owner: string; w: bigint }[] = [];
  for (const h of [...i.holders].sort(byOwner)) {
    const reason = exclusionReason.get(h.owner);
    if (reason) { excluded.push({ owner: h.owner, reason }); continue; }
    const w = twabBalanceUnits(h.history, i.window);
    if (w === 0n || w < i.policy.minEligibleBalanceUnits) { if (w > 0n) ineligible.push({ owner: h.owner, balanceUnits: w }); continue; }
    weights.push({ owner: h.owner, w });
  }
  const totalW = weights.reduce((s, x) => s + x.w, 0n);
  const alloc = new Map<string, bigint>();
  let allocated = 0n;
  if (totalW > 0n) for (const { owner, w } of weights) { const a = (i.fundedRaw * w) / totalW; alloc.set(owner, a); allocated += a; }
  const poolRollForwardRaw = i.fundedRaw - allocated;

  const payouts: EpochResult['payouts'] = [];
  const holderCarryOut: Record<string, bigint> = {};
  const owners = [...new Set([...alloc.keys(), ...Object.keys(i.carryIn)])].sort();
  for (const owner of owners) {
    const carry = i.carryIn[owner] ?? 0n;
    if (exclusionReason.has(owner)) { if (carry > 0n) holderCarryOut[owner] = carry; continue; }
    const due = (alloc.get(owner) ?? 0n) + carry;
    if (due === 0n) continue;
    if (due >= i.policy.minPayoutRaw) payouts.push({ owner, amountRaw: due });
    else holderCarryOut[owner] = due;
  }
  const carryInTotal = Object.values(i.carryIn).reduce((s, v) => s + v, 0n);
  const holderCarryOutTotalRaw = Object.values(holderCarryOut).reduce((s, v) => s + v, 0n);
  const paid = payouts.reduce((s, p) => s + p.amountRaw, 0n);
  const inRaw = i.fundedRaw + carryInTotal, outRaw = paid + holderCarryOutTotalRaw + poolRollForwardRaw;
  if (inRaw !== outRaw) throw new Error(`conservation violated: in ${inRaw} != out ${outRaw}`);

  const merkle = buildMerkle(payouts);
  const allocationFileHash = bytesToHex(sha256(utf8ToBytes(canonicalJson({
    epochId: i.epochId, window: i.window, fundedRaw: i.fundedRaw, carryIn: i.carryIn, policy: i.policy,
    payouts, holderCarryOut, poolRollForwardRaw, excluded, ineligible, merkleRoot: merkle.rootHex,
  }))));
  return { epochId: i.epochId, payouts, holderCarryOut, holderCarryOutTotalRaw, poolRollForwardRaw, excluded, ineligible,
    conservation: { ok: true, inRaw, outRaw }, allocationFileHash, merkle };
}
