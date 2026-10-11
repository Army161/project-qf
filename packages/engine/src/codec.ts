// IDL-driven Borsh codec for the QF engine's pinned formats (Solana Kit codecs only; browser-safe).
// Decoding fails closed: trailing bytes, short reads, bool/option tags other than 0/1, enum tags outside the
// variant list, invalid UTF-8 and oversized strings or vecs all throw CodecError. Encoding is just as strict:
// a missing, extra or out-of-range value throws instead of being defaulted or truncated.
import { getAddressDecoder, getAddressEncoder, address } from '@solana/kit';

export type IdlType = string | { defined?: { name: string }; array?: [IdlType, number]; option?: IdlType; vec?: IdlType };
export interface IdlField { name: string; type: IdlType }
export interface IdlTypeDef { kind: 'struct' | 'enum'; fields?: IdlField[]; variants?: { name: string; fields?: unknown[] }[] }
export interface IdlAccountMeta { name: string; writable: boolean; signer: boolean; address: string | null }
export interface IdlInstruction { name: string; discriminator: number[]; accounts: IdlAccountMeta[]; args: IdlField[] }
/** The part of a program's Anchor IDL the engine uses, generated from the pinned IDL file by scripts/extract-idl.ts. */
export interface EngineIdl {
  provenance: { file: string; sha256: string; idlName: string; idlVersion: string; programId: string; license: string };
  instructions: IdlInstruction[];
  /** Account type name -> 8-byte discriminator. */
  accounts: Record<string, number[]>;
  events: Record<string, { discriminator: number[]; fields: IdlField[] }>;
  types: Record<string, IdlTypeDef>;
}

/** Decoded values: integers up to 32 bits are numbers, wider ones bigints; pubkeys are base58 strings; a unit enum is its variant name. */
export type Value = number | bigint | boolean | string | null | Value[] | { [k: string]: Value };

export class CodecError extends Error { constructor(m: string) { super(m); this.name = 'CodecError'; } }

const addrDec = getAddressDecoder();
const addrEnc = getAddressEncoder();
const utf8Dec = new TextDecoder('utf-8', { fatal: true });
const utf8Enc = new TextEncoder();
const MAX_STRING = 256; // the curve stores at most 32 (name), 10 (symbol) and 200 (uri) bytes
const MAX_VEC = 64;
const INT = /^([ui])(8|16|32|64|128)$/;

const typeDef = (types: Record<string, IdlTypeDef>, name: string) => {
  const d = types[name];
  if (!d) throw new CodecError(`type ${name} is not in the pinned IDL`);
  return d;
};
function unitVariants(name: string, d: IdlTypeDef): string[] {
  const v = d.variants ?? [];
  if (v.some((x) => x.fields && x.fields.length)) throw new CodecError(`enum ${name} has variants with fields (not supported)`);
  return v.map((x) => x.name);
}

// ---------- decode ----------
class Reader {
  o = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  take(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new CodecError(`short read at ${this.o} (+${n} > ${this.b.length})`);
    const s = this.b.subarray(this.o, this.o + n); this.o += n; return s;
  }
  uint(bytes: number): bigint { let v = 0n; const s = this.take(bytes); for (let k = bytes - 1; k >= 0; k--) v = (v << 8n) | BigInt(s[k]!); return v; }
}

function read(r: Reader, t: IdlType, types: Record<string, IdlTypeDef>): Value {
  if (typeof t === 'string') {
    const m = INT.exec(t);
    if (m) {
      const bits = Number(m[2]); let v = r.uint(bits / 8);
      if (m[1] === 'i' && v >= 1n << BigInt(bits - 1)) v -= 1n << BigInt(bits);
      return bits <= 32 ? Number(v) : v;
    }
    if (t === 'bool') { const x = r.take(1)[0]; if (x !== 0 && x !== 1) throw new CodecError(`bool tag ${x}`); return x === 1; }
    if (t === 'pubkey') return addrDec.decode(r.take(32)) as string;
    if (t === 'string') {
      const n = Number(r.uint(4)); if (n > MAX_STRING) throw new CodecError(`string length ${n} exceeds ${MAX_STRING}`);
      const raw = r.take(n);
      try { return utf8Dec.decode(raw); } catch { throw new CodecError('invalid utf-8'); }
    }
    throw new CodecError(`unsupported type ${t}`);
  }
  if (t.array) return Array.from({ length: t.array[1] }, () => read(r, t.array![0], types));
  if (t.option !== undefined) { const tag = r.take(1)[0]; if (tag === 0) return null; if (tag !== 1) throw new CodecError(`option tag ${tag}`); return read(r, t.option, types); }
  if (t.vec !== undefined) { const n = Number(r.uint(4)); if (n > MAX_VEC) throw new CodecError(`vec length ${n} exceeds ${MAX_VEC}`); return Array.from({ length: n }, () => read(r, t.vec!, types)); }
  if (t.defined) {
    const d = typeDef(types, t.defined.name);
    if (d.kind === 'enum') {
      const names = unitVariants(t.defined.name, d), tag = r.take(1)[0]!;
      if (tag >= names.length) throw new CodecError(`enum ${t.defined.name} tag ${tag} out of range`);
      return names[tag]!;
    }
    return readFields(r, d.fields ?? [], types);
  }
  throw new CodecError(`unsupported type ${JSON.stringify(t)}`);
}
function readFields(r: Reader, fields: readonly IdlField[], types: Record<string, IdlTypeDef>) {
  const out: { [k: string]: Value } = {};
  for (const f of fields) out[f.name] = read(r, f.type, types);
  return out;
}

/** Decodes `fields` from `bytes` and requires every byte to be consumed. */
export function decodeFields(bytes: Uint8Array, fields: readonly IdlField[], types: Record<string, IdlTypeDef>): { [k: string]: Value } {
  const r = new Reader(bytes);
  const v = readFields(r, fields, types);
  if (r.o !== bytes.length) throw new CodecError(`${bytes.length - r.o} trailing bytes`);
  return v;
}

// ---------- encode ----------
function write(out: number[], v: unknown, t: IdlType, types: Record<string, IdlTypeDef>, path: string): void {
  if (typeof t === 'string') {
    const m = INT.exec(t);
    if (m) {
      if (typeof v !== 'bigint' && !(typeof v === 'number' && Number.isSafeInteger(v))) throw new CodecError(`${path}: ${t} must be a bigint or safe integer`);
      const bits = Number(m[2]), n = BigInt(v);
      const [lo, hi] = m[1] === 'u' ? [0n, (1n << BigInt(bits)) - 1n] : [-(1n << BigInt(bits - 1)), (1n << BigInt(bits - 1)) - 1n];
      if (n < lo || n > hi) throw new CodecError(`${path}: ${n} out of range for ${t}`);
      let u = n < 0n ? n + (1n << BigInt(bits)) : n;
      for (let k = 0; k < bits / 8; k++) { out.push(Number(u & 0xffn)); u >>= 8n; }
      return;
    }
    if (t === 'bool') { if (typeof v !== 'boolean') throw new CodecError(`${path}: not a bool`); out.push(v ? 1 : 0); return; }
    if (t === 'pubkey') {
      if (typeof v !== 'string') throw new CodecError(`${path}: not an address`);
      let a; try { a = address(v); } catch { throw new CodecError(`${path}: not an address`); }
      out.push(...addrEnc.encode(a)); return;
    }
    if (t === 'string') {
      if (typeof v !== 'string') throw new CodecError(`${path}: not a string`);
      const b = utf8Enc.encode(v);
      if (b.length > MAX_STRING) throw new CodecError(`${path}: string length ${b.length} exceeds ${MAX_STRING}`);
      write(out, b.length, 'u32', types, path); out.push(...b); return;
    }
    throw new CodecError(`unsupported type ${t}`);
  }
  if (t.array) {
    if (!Array.isArray(v) || v.length !== t.array[1]) throw new CodecError(`${path}: expected an array of ${t.array[1]}`);
    v.forEach((x, k) => write(out, x, t.array![0], types, `${path}[${k}]`)); return;
  }
  if (t.option !== undefined) { if (v === null) { out.push(0); return; } out.push(1); write(out, v, t.option, types, path); return; }
  if (t.vec !== undefined) {
    if (!Array.isArray(v) || v.length > MAX_VEC) throw new CodecError(`${path}: expected a vec of at most ${MAX_VEC}`);
    write(out, v.length, 'u32', types, path); v.forEach((x, k) => write(out, x, t.vec!, types, `${path}[${k}]`)); return;
  }
  if (t.defined) {
    const d = typeDef(types, t.defined.name);
    if (d.kind === 'enum') {
      const tag = unitVariants(t.defined.name, d).indexOf(v as string);
      if (tag < 0) throw new CodecError(`${path}: not a ${t.defined.name} variant`);
      out.push(tag); return;
    }
    writeFields(out, v, d.fields ?? [], types, path); return;
  }
  throw new CodecError(`unsupported type ${JSON.stringify(t)}`);
}
function writeFields(out: number[], v: unknown, fields: readonly IdlField[], types: Record<string, IdlTypeDef>, path: string) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CodecError(`${path}: expected an object`);
  const o = v as Record<string, unknown>, names = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(o)) if (!names.has(k)) throw new CodecError(`${path}.${k}: not a field`);
  for (const f of fields) {
    if (!(f.name in o)) throw new CodecError(`${path}.${f.name}: missing`);
    write(out, o[f.name], f.type, types, `${path}.${f.name}`);
  }
}

/** Encodes `values` (keyed by IDL field name) in field order. */
export function encodeFields(values: Record<string, unknown>, fields: readonly IdlField[], types: Record<string, IdlTypeDef>): Uint8Array {
  const out: number[] = [];
  writeFields(out, values, fields, types, '$');
  return Uint8Array.from(out);
}

export const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, k) => x === b[k]);
