// Mint account decoding for Stage 1 (QUOTE-ASSETS.md §2). Pure and browser-safe: decodes the raw account bytes an RPC
// returned, so authorities and extensions come from our own reading of the data, not from a provider's parsed view.
// Layouts: SPL Token mint (82 bytes) and Token-2022 mint (same base, padded to 165 bytes, account-type byte 1, then
// TLV entries of u16 type + u16 length). Extension numbering is the token-2022 ExtensionType enum (TOKEN-2022.md).
import { encodeBase58 } from '@project-qf/core';

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_2022_NATIVE_MINT = '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';

const MINT_SIZE = 82;
const ACCOUNT_SIZE = 165; // Token-2022 pads mints to the token-account size so the account-type byte cannot collide
const ACCOUNT_TYPE_MINT = 1;

/** token-2022 ExtensionType values (interface/src/extension/mod.rs; cross-checked against @solana/spl-token 0.4.15). */
export const EXTENSION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'TransferFeeConfig', 2: 'TransferFeeAmount', 3: 'MintCloseAuthority', 4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount', 6: 'DefaultAccountState', 7: 'ImmutableOwner', 8: 'MemoTransfer', 9: 'NonTransferable',
  10: 'InterestBearingConfig', 11: 'CpiGuard', 12: 'PermanentDelegate', 13: 'NonTransferableAccount', 14: 'TransferHook',
  15: 'TransferHookAccount', 16: 'ConfidentialTransferFeeConfig', 17: 'ConfidentialTransferFeeAmount', 18: 'MetadataPointer',
  19: 'TokenMetadata', 20: 'GroupPointer', 21: 'TokenGroup', 22: 'GroupMemberPointer', 23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn', 25: 'ScaledUiAmount', 26: 'Pausable', 27: 'PausableAccount', 28: 'PermissionedBurn',
});

export interface TransferFeeTerms { epoch: string; maximumFeeRaw: string; basisPoints: number }
export interface MintExtension {
  type: number;
  name: string; // 'Unknown(<n>)' when the type is not in EXTENSION_NAMES
  length: number;
  transferFee?: { configAuthority: string | null; withdrawAuthority: string | null; older: TransferFeeTerms; newer: TransferFeeTerms };
}
export interface MintFacts {
  tokenProgram: 'SPL_TOKEN' | 'TOKEN_2022';
  initialized: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: string;
  decimals: number;
  extensions: MintExtension[];
}
export type MintDecode = { ok: true; facts: MintFacts } | { ok: false; error: string };

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000;
function u64(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!);
  return v;
}
const key = (b: Uint8Array, o: number) => encodeBase58(b.subarray(o, o + 32));
const optionalNonZeroKey = (b: Uint8Array, o: number) => (b.subarray(o, o + 32).every((x) => x === 0) ? null : key(b, o));

function cOptionKey(b: Uint8Array, o: number, label: string): string | null {
  const tag = u32(b, o);
  if (tag === 0) return null;
  if (tag !== 1) throw new Error(`BAD_${label}_OPTION_TAG ${tag}`);
  return key(b, o + 4);
}

function transferFee(v: Uint8Array): MintExtension['transferFee'] {
  if (v.length < 108) throw new Error(`TRANSFER_FEE_CONFIG_TRUNCATED ${v.length}`);
  const terms = (o: number): TransferFeeTerms => ({ epoch: u64(v, o).toString(), maximumFeeRaw: u64(v, o + 8).toString(), basisPoints: u16(v, o + 16) });
  return { configAuthority: optionalNonZeroKey(v, 0), withdrawAuthority: optionalNonZeroKey(v, 32), older: terms(72), newer: terms(90) };
}

/** Decodes a mint account owned by `owner`. Any structural inconsistency is an error, never a best guess. */
export function decodeMint(owner: string, data: Uint8Array): MintDecode {
  try {
    let tokenProgram: MintFacts['tokenProgram'];
    if (owner === SPL_TOKEN_PROGRAM) tokenProgram = 'SPL_TOKEN';
    else if (owner === TOKEN_2022_PROGRAM) tokenProgram = 'TOKEN_2022';
    else return { ok: false, error: `NOT_TOKEN_PROGRAM_OWNED ${owner}` };
    if (data.length < MINT_SIZE) return { ok: false, error: `ACCOUNT_TOO_SHORT ${data.length}` };
    if (tokenProgram === 'SPL_TOKEN' && data.length !== MINT_SIZE) return { ok: false, error: `NOT_A_MINT_LENGTH ${data.length}` };
    const facts: MintFacts = {
      tokenProgram,
      mintAuthority: cOptionKey(data, 0, 'MINT_AUTHORITY'),
      supplyRaw: u64(data, 36).toString(),
      decimals: data[44]!,
      initialized: data[45] === 1,
      freezeAuthority: cOptionKey(data, 46, 'FREEZE_AUTHORITY'),
      extensions: [],
    };
    if (data[45]! > 1) return { ok: false, error: `BAD_INITIALIZED_FLAG ${data[45]}` };
    if (tokenProgram === 'TOKEN_2022' && data.length > MINT_SIZE) {
      if (data.length <= ACCOUNT_SIZE) return { ok: false, error: `T22_EXTENDED_LENGTH_INVALID ${data.length}` };
      if (data.subarray(MINT_SIZE, ACCOUNT_SIZE).some((x) => x !== 0)) return { ok: false, error: 'T22_PADDING_NOT_ZERO' };
      if (data[ACCOUNT_SIZE] !== ACCOUNT_TYPE_MINT) return { ok: false, error: `T22_ACCOUNT_TYPE_NOT_MINT ${data[ACCOUNT_SIZE]}` };
      let o = ACCOUNT_SIZE + 1;
      const seen = new Set<number>();
      while (o + 4 <= data.length) {
        const type = u16(data, o);
        const length = u16(data, o + 2);
        if (type === 0) break; // Uninitialized: remaining bytes are unused space
        if (o + 4 + length > data.length) return { ok: false, error: `T22_TLV_OVERRUN type ${type}` };
        if (seen.has(type)) return { ok: false, error: `T22_DUPLICATE_EXTENSION ${type}` };
        seen.add(type);
        const value = data.subarray(o + 4, o + 4 + length);
        const ext: MintExtension = { type, name: EXTENSION_NAMES[type] ?? `Unknown(${type})`, length };
        if (type === 1) ext.transferFee = transferFee(value);
        facts.extensions.push(ext);
        o += 4 + length;
      }
    }
    return { ok: true, facts };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Test helper and fixture builder: encodes MintFacts back into account bytes (round-trip of decodeMint). */
export function encodeMintForFixture(f: Omit<MintFacts, 'extensions'> & { extensions?: { type: number; value: Uint8Array }[] }, decodeKey: (s: string) => Uint8Array): Uint8Array {
  const exts = f.tokenProgram === 'TOKEN_2022' ? (f.extensions ?? []) : [];
  const tlvLen = exts.reduce((n, e) => n + 4 + e.value.length, 0);
  const out = new Uint8Array(exts.length ? ACCOUNT_SIZE + 1 + tlvLen : MINT_SIZE);
  const putKey = (o: number, k: string | null) => {
    out[o] = k ? 1 : 0;
    if (k) out.set(decodeKey(k), o + 4);
  };
  putKey(0, f.mintAuthority);
  let s = BigInt(f.supplyRaw);
  for (let i = 0; i < 8; i++) { out[36 + i] = Number(s & 0xffn); s >>= 8n; }
  out[44] = f.decimals;
  out[45] = f.initialized ? 1 : 0;
  putKey(46, f.freezeAuthority);
  if (exts.length) {
    out[ACCOUNT_SIZE] = ACCOUNT_TYPE_MINT;
    let o = ACCOUNT_SIZE + 1;
    for (const e of exts) {
      out[o] = e.type & 0xff; out[o + 1] = e.type >> 8; out[o + 2] = e.value.length & 0xff; out[o + 3] = e.value.length >> 8;
      out.set(e.value, o + 4); o += 4 + e.value.length;
    }
  }
  return out;
}
