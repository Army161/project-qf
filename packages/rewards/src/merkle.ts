// Merkle distribution compatible with Solana Foundation Rewards @ df7517d (MIT)
// program/src/utils/merkle_utils.rs: leaf = keccak256(0x00 || keccak256(claimant || u64le(amount) || schedule)),
// sorted-pair parent hashing, leaves sorted by hash, odd node promoted. Schedule = Immediate ([0]).
// Independent QF implementation of the documented format; no upstream code copied.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getAddressEncoder, isAddress } from '@solana/kit';

const U64_MAX = 2n ** 64n - 1n;
const IMMEDIATE_SCHEDULE = new Uint8Array([0]);

const cmpBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
};
const concat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };
const u64le = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const hashPair = (a: Uint8Array, b: Uint8Array) => (cmpBytes(a, b) <= 0 ? keccak_256(concat(a, b)) : keccak_256(concat(b, a)));

export function leafHash(claimant: Uint8Array, amount: bigint, schedule: Uint8Array = IMMEDIATE_SCHEDULE): Uint8Array {
  if (claimant.length !== 32) throw new RangeError('claimant must be 32 bytes');
  if (amount < 0n || amount > U64_MAX) throw new RangeError('amount outside u64');
  return keccak_256(concat(new Uint8Array([0]), keccak_256(concat(claimant, u64le(amount), schedule))));
}

export interface MerkleResult { root: Uint8Array; rootHex: string; leaves: Map<string, Uint8Array>; proofs: Map<string, Uint8Array[]> }

export function buildMerkle(payouts: readonly { owner: string; amountRaw: bigint }[]): MerkleResult {
  const enc = getAddressEncoder();
  const leaves = new Map<string, Uint8Array>();
  for (const p of payouts) {
    if (!isAddress(p.owner)) throw new RangeError(`invalid address ${p.owner}`);
    if (leaves.has(p.owner)) throw new RangeError(`duplicate claimant ${p.owner}`);
    if (p.amountRaw < 0n || p.amountRaw > U64_MAX) throw new RangeError(`amount outside u64 for ${p.owner}`);
    leaves.set(p.owner, leafHash(new Uint8Array(enc.encode(p.owner)), p.amountRaw));
  }
  const proofs = new Map<string, Uint8Array[]>([...leaves.keys()].map((o) => [o, []]));
  let level = [...leaves.entries()].map(([o, h]) => ({ hash: h, owners: [o] })).sort((a, b) => cmpBytes(a.hash, b.hash));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!, r = level[i + 1];
      if (!r) { next.push(l); continue; }
      for (const o of l.owners) proofs.get(o)!.push(r.hash);
      for (const o of r.owners) proofs.get(o)!.push(l.hash);
      next.push({ hash: hashPair(l.hash, r.hash), owners: [...l.owners, ...r.owners] });
    }
    level = next;
  }
  const root = level[0]?.hash ?? new Uint8Array(32);
  return { root, rootHex: bytesToHex(root), leaves, proofs };
}

export function verifyProof(leaf: Uint8Array, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  let h = leaf;
  for (const s of proof) h = hashPair(h, s);
  return cmpBytes(h, root) === 0;
}
