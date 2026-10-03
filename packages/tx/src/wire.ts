// Wire-format helpers for signing flows (browser-safe: WebCrypto Ed25519 + Solana Kit codecs; no web3.js).
// Used by the browser to add the client-generated base-mint signature before the wallet signs, and by the server to
// prove that a submitted transaction carries the exact message it built and a valid signature from every signer.
import { getAddressEncoder, address } from '@solana/kit';

const addrEnc = getAddressEncoder();

function readCompactU16(b: Uint8Array, at: number): [value: number, size: number] {
  let value = 0, size = 0;
  for (;;) {
    const byte = b[at + size];
    if (byte === undefined) throw new Error('WIRE_TRUNCATED compact-u16');
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if ((byte & 0x80) === 0) break;
    if (size >= 3) throw new Error('WIRE_BAD_COMPACT_U16');
  }
  return [value, size];
}

export interface WireTx { signatures: Uint8Array[]; message: Uint8Array; signerKeys: string[] }

/** Splits wire bytes into signatures and message, and reads the signer public keys from the message header. */
export function parseWire(bytes: Uint8Array): WireTx {
  const [n, sz] = readCompactU16(bytes, 0);
  if (n < 1 || n > 12) throw new Error(`WIRE_BAD_SIGNATURE_COUNT ${n}`);
  const sigEnd = sz + 64 * n;
  if (bytes.length <= sigEnd) throw new Error('WIRE_TRUNCATED signatures');
  const signatures = Array.from({ length: n }, (_, k) => bytes.slice(sz + 64 * k, sz + 64 * (k + 1)));
  const message = bytes.slice(sigEnd);
  // legacy message: header(3) | compact keys | keys...; v0 message: 0x80 prefix then the same layout
  let at = (message[0]! & 0x80) !== 0 ? 1 : 0;
  const numRequired = message[at]!;
  if (numRequired !== n) throw new Error(`WIRE_SIGNER_COUNT_MISMATCH header ${numRequired} vs ${n}`);
  at += 3;
  const [nKeys, ksz] = readCompactU16(message, at);
  at += ksz;
  if (nKeys < n || message.length < at + 32 * nKeys) throw new Error('WIRE_TRUNCATED keys');
  const signerKeys = Array.from({ length: n }, (_, k) => base58(message.slice(at + 32 * k, at + 32 * (k + 1))));
  return { signatures, message, signerKeys };
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function toBase64(b: Uint8Array): string { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

const isZero = (s: Uint8Array) => s.every((x) => x === 0);
/** WebCrypto wants ArrayBuffer-backed views; every view here is a fresh copy, never a SharedArrayBuffer. */
const bs = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

async function importEd25519Public(addr: string): Promise<CryptoKey> {
  const raw = new Uint8Array(addrEnc.encode(address(addr)));
  return globalThis.crypto.subtle.importKey('raw', bs(raw), { name: 'Ed25519' }, false, ['verify']);
}

/** Verifies every required signature over the message. Returns the signer keys whose signature is missing or invalid. */
export async function verifyWireSignatures(bytes: Uint8Array): Promise<{ ok: boolean; bad: string[]; firstSignature: string }> {
  const w = parseWire(bytes);
  const bad: string[] = [];
  for (const [k, key] of w.signerKeys.entries()) {
    const sig = w.signatures[k]!;
    const ok = !isZero(sig) && await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, await importEd25519Public(key), bs(sig), bs(w.message));
    if (!ok) bad.push(key);
  }
  return { ok: bad.length === 0, bad, firstSignature: base58(w.signatures[0]!) };
}

/** Signs the message with `key` and writes the signature into the slot of `signer`. Fails if `signer` is not a required signer. */
export async function addSignature(bytes: Uint8Array, signer: string, key: CryptoKey): Promise<Uint8Array> {
  const w = parseWire(bytes);
  const idx = w.signerKeys.indexOf(signer);
  if (idx < 0) throw new Error(`SIGNER_NOT_REQUIRED ${signer}`);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, key, bs(w.message)));
  const out = bytes.slice();
  const [, sz] = readCompactU16(bytes, 0);
  out.set(sig, sz + 64 * idx);
  return out;
}

/** True when both wire transactions carry byte-identical messages (signatures may differ). */
export function sameMessage(a: Uint8Array, b: Uint8Array): boolean {
  const x = parseWire(a).message, y = parseWire(b).message;
  return x.length === y.length && x.every((v, k) => v === y[k]);
}

/** Generates a fresh Ed25519 key pair for a new mint; the private key is non-extractable. */
export async function generateMintKey(): Promise<{ address: string; privateKey: CryptoKey }> {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  return { address: base58(raw), privateKey: kp.privateKey };
}
