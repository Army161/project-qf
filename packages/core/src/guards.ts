// Runtime guards for values that cross a trust boundary as JSON (browser-safe, no dependencies).
import type { ProviderClass, ValidationMode } from './types.ts';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** True only for a base58 string that decodes to exactly 32 bytes (a Solana address; on-curve is not checked). */
export function isSolanaAddress(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const ch of s) { const d = B58.indexOf(ch); if (d < 0) return false; n = n * 58n + BigInt(d); }
  let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
  let lead = 0; for (const ch of s) { if (ch === '1') lead++; else break; }
  return bytes + lead === 32;
}
export const isValidationMode = (m: unknown): m is ValidationMode => m === 'LIVE' || m === 'TEST_ONLY';
export const isProviderClass = (m: unknown): m is ProviderClass => m === 'PRODUCTION' || m === 'TEST_ONLY';
export const isRawAmount = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9]\d*)$/.test(s);
export const isIsoTimestamp = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(s) && Number.isFinite(Date.parse(s));

/** Base58 (Bitcoin alphabet) encoding of raw bytes, e.g. a 32-byte public key read from account data. */
export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)]! + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** Inverse of encodeBase58; throws on a character outside the alphabet. */
export function decodeBase58(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) { const d = B58.indexOf(ch); if (d < 0) throw new Error('invalid base58'); n = n * 58n + BigInt(d); }
  const body: number[] = [];
  while (n > 0n) { body.unshift(Number(n & 0xffn)); n >>= 8n; }
  let lead = 0; for (const ch of s) { if (ch === '1') lead++; else break; }
  return Uint8Array.from([...new Array<number>(lead).fill(0), ...body]);
}
