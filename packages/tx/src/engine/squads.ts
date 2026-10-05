// Squads v4 formats the treasury binding needs (Solana Kit only; browser-safe).
//   - PDAs: multisig, vault, transaction, proposal (seeds as in the pinned MIT SDK's pda.ts, @sqds/multisig 2.1.4).
//   - The compact TransactionMessage carried inside vault_transaction_create (u8/u16 length prefixes, SDK types.ts).
//   - The VaultTransaction account the program stores (Borsh, u32 length prefixes), which is what members approve and
//     what execute runs. A member checks the stored account, never only the server's description of it.
// Decoders fail closed: short reads, trailing bytes, out-of-range indices, duplicate keys and bad header counts throw.
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, address } from '@solana/kit';
import { PROGRAM_IDS } from '../programs.ts';
import type { DecodedTransaction } from '../decoder.ts';
import { SQUADS_IDL_SUBSET } from './squads-idl-subset.ts';

const enc = getAddressEncoder();
const dec = getAddressDecoder();
const key = (a: string) => enc.encode(address(a)) as Uint8Array;
const u8 = (n: number) => Uint8Array.of(n);
const u64 = (n: bigint) => { const b = new Uint8Array(8); for (let k = 0; k < 8; k++) b[k] = Number((n >> BigInt(8 * k)) & 0xffn); return b; };
const pda = async (seeds: (string | Uint8Array)[]) => (await getProgramDerivedAddress({ programAddress: address(PROGRAM_IDS.SQUADS_V4), seeds }))[0] as string;

export const squadsProgramConfig = () => pda(['multisig', 'program_config']);
export const squadsMultisig = (createKey: string) => pda(['multisig', 'multisig', key(createKey)]);
export const squadsVault = (multisig: string, index = 0) => pda(['multisig', key(multisig), 'vault', u8(index)]);
export const squadsTransaction = (multisig: string, index: bigint) => pda(['multisig', key(multisig), 'transaction', u64(index)]);
export const squadsProposal = (multisig: string, index: bigint) => pda(['multisig', key(multisig), 'transaction', u64(index), 'proposal']);

export class SquadsFormatError extends Error { constructor(m: string) { super(m); this.name = 'SquadsFormatError'; } }

export interface VaultMessage {
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
  accountKeys: string[];
  instructions: { programIdIndex: number; accountIndexes: number[]; dataHex: string }[];
  addressTableLookups: number;
}
export interface StoredVaultTransaction {
  multisig: string;
  creator: string;
  index: bigint;
  vaultIndex: number;
  ephemeralSignerBumps: number[];
  message: VaultMessage;
}

const MAX_KEYS = 64, MAX_IXS = 16, MAX_DATA = 1232;
class R {
  o = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  take(n: number) { if (this.o + n > this.b.length) throw new SquadsFormatError(`short read at ${this.o}`); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  uint(n: number) { let v = 0; const s = this.take(n); for (let k = n - 1; k >= 0; k--) v = v * 256 + s[k]!; return v; }
  u64() { const s = this.take(8); let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(s[k]!); return v; }
  key() { return dec.decode(this.take(32)) as string; }
  len(prefix: number, max: number, what: string) { const n = this.uint(prefix); if (n > max) throw new SquadsFormatError(`${what} length ${n} exceeds ${max}`); return n; }
  done() { if (this.o !== this.b.length) throw new SquadsFormatError(`${this.b.length - this.o} trailing bytes`); }
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** compact = the argument format (u8 / u16 length prefixes); stored = the account format (u32 prefixes). */
function readMessage(r: R, compact: boolean): VaultMessage {
  const [p8, p16] = compact ? [1, 2] : [4, 4];
  const numSigners = r.uint(1), numWritableSigners = r.uint(1), numWritableNonSigners = r.uint(1);
  const accountKeys = Array.from({ length: r.len(p8, MAX_KEYS, 'account_keys') }, () => r.key());
  const instructions = Array.from({ length: r.len(p8, MAX_IXS, 'instructions') }, () => ({
    programIdIndex: r.uint(1),
    accountIndexes: Array.from(r.take(r.len(p8, MAX_KEYS * 2, 'account_indexes'))),
    dataHex: hex(r.take(r.len(p16, MAX_DATA, 'data'))),
  }));
  const lookups = r.len(p8, MAX_KEYS, 'address_table_lookups');
  for (let k = 0; k < lookups; k++) { r.key(); r.take(r.len(p8, MAX_KEYS, 'writable_indexes')); r.take(r.len(p8, MAX_KEYS, 'readonly_indexes')); }
  const m = { numSigners, numWritableSigners, numWritableNonSigners, accountKeys, instructions, addressTableLookups: lookups };
  checkMessage(m);
  return m;
}
function checkMessage(m: VaultMessage) {
  const n = m.accountKeys.length;
  if (m.numSigners < 1 || m.numSigners > n) throw new SquadsFormatError('num_signers out of range');
  if (m.numWritableSigners > m.numSigners) throw new SquadsFormatError('num_writable_signers > num_signers');
  if (m.numWritableNonSigners > n - m.numSigners) throw new SquadsFormatError('num_writable_non_signers out of range');
  if (new Set(m.accountKeys).size !== n) throw new SquadsFormatError('duplicate account key');
  for (const ix of m.instructions) {
    if (ix.programIdIndex >= n) throw new SquadsFormatError('program index out of range');
    if (ix.accountIndexes.some((k) => k >= n)) throw new SquadsFormatError('account index out of range (lookup tables are not supported)');
  }
}

/** The message bytes inside a vault_transaction_create argument. */
export function decodeCompactMessage(bytes: Uint8Array): VaultMessage {
  const r = new R(bytes); const m = readMessage(r, true); r.done(); return m;
}
export const decodeCompactMessageHex = (h: string) => decodeCompactMessage(fromHex(h));

/** A VaultTransaction account's data, discriminator included. */
export function decodeVaultTransactionAccount(bytes: Uint8Array): StoredVaultTransaction {
  const r = new R(bytes);
  const d = r.take(8);
  if (!SQUADS_IDL_SUBSET.accounts!.VaultTransaction!.every((b, k) => d[k] === b)) throw new SquadsFormatError('not a VaultTransaction account');
  const multisig = r.key(), creator = r.key(), index = r.u64();
  r.uint(1); // bump
  const vaultIndex = r.uint(1);
  r.uint(1); // vault bump
  const ephemeralSignerBumps = Array.from(r.take(r.len(4, 8, 'ephemeral_signer_bumps')));
  const message = readMessage(r, false);
  r.done();
  return { multisig, creator, index, vaultIndex, ephemeralSignerBumps, message };
}

/** A vault message in the shape the instruction binder works on: account 0 pays, signers first, writable by header. */
export function vaultMessageAsTransaction(m: VaultMessage): DecodedTransaction {
  const keys = m.accountKeys, ns = m.numSigners;
  return {
    version: 0,
    feePayer: keys[0]!,
    signers: keys.slice(0, ns),
    writableAccounts: keys.filter((_, k) => (k < ns ? k < m.numWritableSigners : k < ns + m.numWritableNonSigners)),
    instructions: m.instructions.map((ix) => ({ programAddress: keys[ix.programIdIndex]!, accounts: ix.accountIndexes.map((k) => keys[k]!), dataHex: ix.dataHex })),
    addressTableLookups: m.addressTableLookups,
    lifetimeToken: '',
  };
}
/** Whether account `k` of the message is writable (the program requires execute's remaining accounts to match). */
export const isWritableIndex = (m: VaultMessage, k: number) => (k < m.numSigners ? k < m.numWritableSigners : k < m.numSigners + m.numWritableNonSigners);
