import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { twabBalanceUnits } from '../src/twab.ts';
import { computeEpochAllocations, ALLOCATION_POLICY_V0_TEST } from '../src/allocate.ts';
import { buildMerkle, leafHash, verifyProof } from '../src/merkle.ts';

// Synthetic owners (valid base58 32-byte addresses; no keys exist for them).
const A = '11111111111111111111111111111112';
const B = 'Vote111111111111111111111111111111111111111';
const C = 'Stake11111111111111111111111111111111111111';
const VAULT = 'SysvarRent111111111111111111111111111111111';
const W = { start: 1000, end: 2000 };

test('TWAB: balance x time, exact, using the balance in force at window start', () => {
  // 100 held from before the window, 300 from t=1500 -> 100*500 + 300*500
  assert.equal(twabBalanceUnits([{ t: 500, balanceRaw: 100n }, { t: 1500, balanceRaw: 300n }], W), 200_000n);
  // changes after the window are ignored; empty history is zero
  assert.equal(twabBalanceUnits([{ t: 2500, balanceRaw: 999n }], W), 0n);
  assert.equal(twabBalanceUnits([], W), 0n);
  // flash balance for one unit of time is weighted by that unit only
  assert.equal(twabBalanceUnits([{ t: 1999, balanceRaw: 1_000_000n }, { t: 2000, balanceRaw: 0n }], W), 1_000_000n);
});

test('TWAB rejects unsorted, duplicate-time, negative or inverted inputs', () => {
  assert.throws(() => twabBalanceUnits([{ t: 1500, balanceRaw: 1n }, { t: 1200, balanceRaw: 1n }], W), /sorted/);
  assert.throws(() => twabBalanceUnits([{ t: 1500, balanceRaw: 1n }, { t: 1500, balanceRaw: 2n }], W), /sorted/);
  assert.throws(() => twabBalanceUnits([{ t: 1500, balanceRaw: -1n }], W), /negative/);
  assert.throws(() => twabBalanceUnits([], { start: 5, end: 5 }), /window/);
});

const holders = [
  { owner: A, history: [{ t: 0, balanceRaw: 600n }] },
  { owner: B, history: [{ t: 0, balanceRaw: 300n }] },
  { owner: C, history: [{ t: 0, balanceRaw: 100n }] },
  { owner: VAULT, history: [{ t: 0, balanceRaw: 1_000_000n }] },
];

test('allocation: exclusions, proportional floor division, dust roll-forward, conservation', () => {
  const r = computeEpochAllocations({ epochId: '2026-09-27', window: W, fundedRaw: 1_000n, carryIn: {}, holders,
    exclusions: [{ owner: VAULT, reason: 'DBC_VAULT' }], policy: ALLOCATION_POLICY_V0_TEST });
  assert.deepEqual(r.payouts.map((p) => [p.owner, p.amountRaw]), [[A, 600n], [B, 300n], [C, 100n]].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)));
  assert.equal(r.poolRollForwardRaw, 0n);
  assert.equal(r.excluded[0]?.owner, VAULT);
  assert.equal(r.conservation.ok, true);
});

test('allocation: rounding remainder rolls forward, never lost or over-paid', () => {
  const r = computeEpochAllocations({ epochId: 'e', window: W, fundedRaw: 1_001n, carryIn: {}, holders,
    exclusions: [{ owner: VAULT, reason: 'DBC_VAULT' }], policy: ALLOCATION_POLICY_V0_TEST });
  const paid = r.payouts.reduce((s, p) => s + p.amountRaw, 0n);
  assert.equal(paid + r.poolRollForwardRaw + r.holderCarryOutTotalRaw, 1_001n);
  assert.equal(r.poolRollForwardRaw, 1n);
});

test('below-minimum payouts roll forward to the holder, and carry-in is honoured', () => {
  const policy = { ...ALLOCATION_POLICY_V0_TEST, minPayoutRaw: 150n };
  const r = computeEpochAllocations({ epochId: 'e', window: W, fundedRaw: 1_000n, carryIn: { [C]: 60n }, holders,
    exclusions: [{ owner: VAULT, reason: 'DBC_VAULT' }], policy });
  // C: 100 + 60 carry = 160 >= 150 -> paid
  assert.equal(r.payouts.find((p) => p.owner === C)?.amountRaw, 160n);
  const r2 = computeEpochAllocations({ epochId: 'e', window: W, fundedRaw: 1_000n, carryIn: {}, holders,
    exclusions: [{ owner: VAULT, reason: 'DBC_VAULT' }], policy });
  assert.equal(r2.payouts.find((p) => p.owner === C), undefined);
  assert.equal(r2.holderCarryOut[C], 100n);
  assert.equal(r2.conservation.ok, true);
});

test('minimum eligible TWAB excludes dust holders from the weight set', () => {
  const policy = { ...ALLOCATION_POLICY_V0_TEST, minEligibleBalanceUnits: 150_000n }; // C has 100*1000 = 100000
  const r = computeEpochAllocations({ epochId: 'e', window: W, fundedRaw: 900n, carryIn: {}, holders,
    exclusions: [{ owner: VAULT, reason: 'DBC_VAULT' }], policy });
  assert.equal(r.payouts.find((p) => p.owner === C), undefined);
  assert.deepEqual(r.ineligible.map((x) => x.owner), [C]);
  assert.equal(r.payouts.reduce((s, p) => s + p.amountRaw, 0n), 900n);
});

test('no eligible holders: everything rolls forward', () => {
  const r = computeEpochAllocations({ epochId: 'e', window: W, fundedRaw: 500n, carryIn: {}, holders: [holders[3]!],
    exclusions: [{ owner: VAULT, reason: 'DBC_VAULT' }], policy: ALLOCATION_POLICY_V0_TEST });
  assert.equal(r.payouts.length, 0);
  assert.equal(r.poolRollForwardRaw, 500n);
});

test('deterministic epoch artifact: identical inputs (any order) -> identical file hash and Merkle root', () => {
  const run = (hs: typeof holders) => computeEpochAllocations({ epochId: 'e', window: W, fundedRaw: 12_345n, carryIn: {}, holders: hs,
    exclusions: [{ owner: VAULT, reason: 'DBC_VAULT' }], policy: ALLOCATION_POLICY_V0_TEST });
  const a = run(holders), b = run([...holders].reverse());
  assert.equal(a.allocationFileHash, b.allocationFileHash);
  assert.equal(a.merkle.rootHex, b.merkle.rootHex);
  assert.match(a.allocationFileHash, /^[0-9a-f]{64}$/);
});

test('Merkle leaf format matches SF Rewards @ df7517d: keccak(0x00 || keccak(claimant || u64le(amount) || schedule))', () => {
  const claimant = new Uint8Array(32).fill(1);
  const inner = new Uint8Array([...claimant, ...[0xe8, 0x03, 0, 0, 0, 0, 0, 0], 0]); // 1000 LE, Immediate schedule = [0]
  const expected = keccak_256(new Uint8Array([0, ...keccak_256(inner)]));
  assert.deepEqual(leafHash(claimant, 1000n), expected);
});

test('Merkle: sorted-pair hashing, proofs verify, tampering fails', () => {
  const payouts = [{ owner: A, amountRaw: 600n }, { owner: B, amountRaw: 300n }, { owner: C, amountRaw: 100n }];
  const m = buildMerkle(payouts);
  for (const p of payouts) assert.equal(verifyProof(m.leaves.get(p.owner)!, m.proofs.get(p.owner)!, m.root), true, p.owner);
  const forged = buildMerkle([{ owner: A, amountRaw: 601n }, payouts[1]!, payouts[2]!]);
  assert.notEqual(forged.rootHex, m.rootHex);
  assert.equal(verifyProof(forged.leaves.get(A)!, m.proofs.get(A)!, m.root), false);
  // two-leaf root computed by hand
  const two = buildMerkle(payouts.slice(0, 2));
  const [l1, l2] = [two.leaves.get(A)!, two.leaves.get(B)!];
  const [lo, hi] = Buffer.compare(Buffer.from(l1), Buffer.from(l2)) <= 0 ? [l1, l2] : [l2, l1];
  assert.deepEqual(two.root, keccak_256(new Uint8Array([...lo, ...hi])));
});

test('Merkle rejects amounts outside u64 and duplicate claimants', () => {
  assert.throws(() => buildMerkle([{ owner: A, amountRaw: 2n ** 64n }]), /u64/);
  assert.throws(() => buildMerkle([{ owner: A, amountRaw: 1n }, { owner: A, amountRaw: 2n }]), /duplicate/);
  assert.throws(() => buildMerkle([{ owner: 'not-an-address', amountRaw: 1n }]), /address/);
});
