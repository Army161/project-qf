// Strict, IDL-driven Borsh decoder for the pinned instruction formats. Browser-safe (Solana Kit codecs only).
// Fails closed: trailing bytes, short reads, bool/option tags other than 0/1, invalid UTF-8, oversized vecs
// and enum types (none are in the V0 subset) all throw BorshError. Nothing is partially accepted.
import { getAddressDecoder } from '@solana/kit';
import type { IdlField, IdlType, IdlTypeDef } from './idl-types.ts';

export class BorshError extends Error { constructor(m: string) { super(m); this.name = 'BorshError'; } }
const addrDec = getAddressDecoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_VEC = 64;       // DBC curve has at most 20 points; anything larger is not a V0 instruction
const MAX_STRING = 256;   // name/symbol/uri bounds are enforced again by terms equality

export type Decoded = number | bigint | boolean | string | null | Decoded[] | { [k: string]: Decoded };

class Reader {
  o = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  take(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new BorshError(`short read at ${this.o} (+${n} > ${this.b.length})`);
    const s = this.b.subarray(this.o, this.o + n); this.o += n; return s;
  }
  uint(bytes: number): bigint { let v = 0n; const s = this.take(bytes); for (let k = bytes - 1; k >= 0; k--) v = (v << 8n) | BigInt(s[k]!); return v; }
}

function read(r: Reader, t: IdlType, types: Record<string, IdlTypeDef>): Decoded {
  if (typeof t === 'string') {
    const m = /^([ui])(8|16|32|64|128)$/.exec(t);
    if (m) {
      const bits = Number(m[2]); let v = r.uint(bits / 8);
      if (m[1] === 'i' && v >= 1n << BigInt(bits - 1)) v -= 1n << BigInt(bits);
      return bits <= 32 ? Number(v) : v;
    }
    if (t === 'bool') { const x = r.take(1)[0]; if (x !== 0 && x !== 1) throw new BorshError(`bool tag ${x}`); return x === 1; }
    if (t === 'pubkey') return addrDec.decode(r.take(32)) as string;
    if (t === 'string') {
      const n = Number(r.uint(4)); if (n > MAX_STRING) throw new BorshError(`string length ${n} exceeds ${MAX_STRING}`);
      try { return utf8.decode(r.take(n)); } catch (e) { throw e instanceof BorshError ? e : new BorshError('invalid utf-8'); }
    }
    throw new BorshError(`unsupported primitive ${t}`);
  }
  if (t.array) return Array.from({ length: t.array[1] }, () => read(r, t.array![0], types));
  if (t.option !== undefined) { const tag = r.take(1)[0]; if (tag === 0) return null; if (tag !== 1) throw new BorshError(`option tag ${tag}`); return read(r, t.option, types); }
  if (t.vec !== undefined) { const n = Number(r.uint(4)); if (n > MAX_VEC) throw new BorshError(`vec length ${n} exceeds ${MAX_VEC}`); return Array.from({ length: n }, () => read(r, t.vec!, types)); }
  if (t.defined) {
    const def = types[t.defined.name];
    if (!def) throw new BorshError(`type ${t.defined.name} not in pinned subset`);
    if (def.kind !== 'struct') throw new BorshError(`enum ${t.defined.name} not supported in V0 (fail closed)`);
    return readFields(r, def.fields ?? [], types);
  }
  throw new BorshError(`unsupported type ${JSON.stringify(t)}`);
}
function readFields(r: Reader, fields: readonly IdlField[], types: Record<string, IdlTypeDef>) {
  const out: { [k: string]: Decoded } = {};
  for (const f of fields) out[f.name] = read(r, f.type, types);
  return out;
}

/** Decodes `fields` from `bytes` and requires every byte to be consumed. */
export function decodeExact(bytes: Uint8Array, fields: readonly IdlField[], types: Record<string, IdlTypeDef>): { [k: string]: Decoded } {
  const r = new Reader(bytes);
  const v = readFields(r, fields, types);
  if (r.o !== bytes.length) throw new BorshError(`${bytes.length - r.o} trailing bytes`);
  return v;
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/**
 * Maps an SDK-side (camelCase, BN/PublicKey) value onto the same shape `decodeExact` produces, so a server-built
 * parameter object and the decoded wire bytes can be digested identically. Throws on missing fields.
 */
export function normalizeToIdl(v: unknown, t: IdlType, types: Record<string, IdlTypeDef>, path = '$'): Decoded {
  if (typeof t === 'string') {
    if (v === undefined || v === null) throw new BorshError(`${path} missing`);
    const m = /^([ui])(8|16|32|64|128)$/.exec(t);
    if (m) {
      // Exact width check (SEC-A condition on bigint-buffer): never rely on a downstream encoder to truncate or throw.
      const str = String(v);
      if (!/^-?(0|[1-9]\d*)$/.test(str)) throw new BorshError(`${path} not a decimal integer for ${t}`);
      const n = BigInt(str), bits = BigInt(m[2]!);
      const [lo, hi] = m[1] === 'u' ? [0n, (1n << bits) - 1n] : [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
      if (n < lo || n > hi) throw new BorshError(`${path} ${str} out of range for ${t}`);
      return Number(m[2]) <= 32 ? Number(n) : n;
    }
    if (t === 'bool') { if (typeof v !== 'boolean') throw new BorshError(`${path} not bool`); return v; }
    if (t === 'pubkey') return typeof v === 'string' ? v : String((v as { toBase58(): string }).toBase58());
    if (t === 'string') return String(v);
    throw new BorshError(`unsupported primitive ${t}`);
  }
  if (t.array) {
    // Anchor's encoder zero-fills a short padding array (the SDK passes `padding: []`); mirror that for padding only.
    const isPadding = /\._?padding(_\d+)?$/.test(path);
    const src = isPadding && Array.isArray(v) && v.length < t.array[1] ? [...v, ...Array(t.array[1] - v.length).fill(0)] : v;
    if (!Array.isArray(src) || src.length !== t.array[1]) throw new BorshError(`${path} array length`);
    return src.map((x, k) => normalizeToIdl(x, t.array![0], types, `${path}[${k}]`));
  }
  if (t.option !== undefined) return v === null || v === undefined ? null : normalizeToIdl(v, t.option, types, path);
  if (t.vec !== undefined) { if (!Array.isArray(v)) throw new BorshError(`${path} not a vec`); return v.map((x, k) => normalizeToIdl(x, t.vec!, types, `${path}[${k}]`)); }
  if (t.defined) {
    const def = types[t.defined.name];
    if (!def || def.kind !== 'struct') throw new BorshError(`type ${t.defined.name} unsupported`);
    const src = v as Record<string, unknown>;
    return Object.fromEntries((def.fields ?? []).map((f) => [f.name, normalizeToIdl(src?.[camel(f.name)] ?? src?.[f.name], f.type, types, `${path}.${f.name}`)]));
  }
  throw new BorshError(`unsupported type ${JSON.stringify(t)}`);
}
