// HTTP pieces both launchpad servers share (the Meteora one in server.ts and the QF engine one in engine/server.ts):
// errors, JSON bodies, the input rules the browser form follows too, client addresses for rate limits, and same-origin
// hosting of the web app under the signing-page CSP.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

export const BODY_LIMIT_BYTES = 16 * 1024;
export const LAUNCH_BODY_LIMIT_BYTES = 400 * 1024;
export const IMAGE_LIMIT_BYTES = 256 * 1024;

/** The client address used for rate limits. Only the named header is trusted, and only because the host's proxy sets it. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, header?: string): string {
  if (header) {
    const raw = req.headers[header.toLowerCase()];
    const v = (Array.isArray(raw) ? raw[raw.length - 1] : raw)?.split(',').map((x) => x.trim()).filter(Boolean).at(-1);
    if (v && v.length <= 64) return v;
  }
  return req.socket.remoteAddress ?? 'local';
}
export class HttpError extends Error {
  status: number; code: string; details: string[] | undefined;
  constructor(status: number, code: string, message: string, details?: string[]) { super(message); this.status = status; this.code = code; this.details = details; }
}

export const API_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
// Signing page CSP: no third-party script, no inline script, no remote connections; images only from self and data:.
export const STATIC_CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

export const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, API_HEADERS).end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

export async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'body must be application/json');
  if (Number(req.headers['content-length'] ?? '0') > limit) throw new HttpError(413, 'BODY_TOO_LARGE', `body over ${limit} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > limit) throw new HttpError(413, 'BODY_TOO_LARGE', `body over ${limit} bytes`);
    chunks.push(c as Buffer);
  }
  let v: unknown;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'body is not valid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'BAD_JSON', 'body must be a JSON object');
  return v as Record<string, unknown>;
}

// ------------------------------------------------------------------ input rules (shared with the browser form)

export const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const utf8Len = (s: string) => new TextEncoder().encode(s).length;
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;
export function onlyKeys(o: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, 'UNKNOWN_FIELDS', `unknown fields: ${extra.join(', ')}`);
}
export function addr(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !B58.test(v)) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be a base58 address`);
  return v;
}
export function text(o: Record<string, unknown>, k: string, max: number, opt = false): string | null {
  const v = o[k];
  if (v === undefined || v === null || v === '') { if (opt) return null; throw new HttpError(400, 'INVALID_REQUEST', `${k} is required`); }
  if (typeof v !== 'string' || CONTROL.test(v) || v.trim() !== v) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be plain text without control characters or surrounding spaces`);
  if (utf8Len(v) > max) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be at most ${max} bytes`);
  return v;
}
export function url(o: Record<string, unknown>, k: string): string | null {
  const v = text(o, k, 160, true);
  if (v === null) return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new HttpError(400, 'INVALID_REQUEST', `${k} must be an https URL`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be an https URL without credentials`);
  return u.toString();
}
export function rawAmount(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v !== 'string' || !/^[1-9]\d{0,19}$/.test(v) || BigInt(v) > 2n ** 64n - 1n) throw new HttpError(400, 'INVALID_REQUEST', `${k} must be a positive raw integer string`);
  return BigInt(v);
}
export function sniffImage(b: Uint8Array): string | null {
  const s = (i: number, ...x: number[]) => x.every((v, k) => b[i + k] === v);
  if (s(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (s(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (s(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (s(0, 0x52, 0x49, 0x46, 0x46) && s(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
export function image(o: Record<string, unknown>): { type: string; bytes: Uint8Array } | null {
  const v = o.imageDataUrl;
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v) : null;
  if (!m) throw new HttpError(400, 'INVALID_IMAGE', 'image must be a base64 PNG, JPEG, GIF or WebP data URL');
  const bytes = Uint8Array.from(Buffer.from(m[2]!, 'base64'));
  if (bytes.length > IMAGE_LIMIT_BYTES) throw new HttpError(413, 'IMAGE_TOO_LARGE', `image over ${IMAGE_LIMIT_BYTES} bytes`);
  const type = sniffImage(bytes);
  if (!type || type !== m[1]) throw new HttpError(400, 'INVALID_IMAGE', 'image bytes do not match the declared type');
  return { type, bytes };
}

/** The web app, same-origin, under the signing-page CSP. Paths resolve inside `staticDir` only (no symlinks out). */
export function serveStatic(staticDir: string | null, req: IncomingMessage, res: ServerResponse, path: string) {
  if (!staticDir) { res.writeHead(404).end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
  const root = realpathSync(staticDir);
  let rel: string;
  try { rel = path === '/' ? 'launchpad.html' : decodeURIComponent(path.slice(1)); } catch { res.writeHead(404).end(); return; }
  const file = join(root, rel);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile() || realpathSync(file) !== file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': STATIC_CSP,
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
}

