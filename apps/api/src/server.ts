// HTTP layer for the private read-only API (qf-api/1) plus same-origin static hosting of the web app. Every /api route
// except /healthz needs a bearer token; records are owner-scoped (another user's record reads as 404). Bodies are JSON
// only and capped; unknown fields are rejected by the shared contract parsers. There is no route that signs, sends or
// simulates anything.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { API_VERSION, DRAFT_ID, INSPECTION_ID, parseDraftInput, parseDraftUpdate, parseInspectionRequest, type ApiError, type Draft, type DraftInput,
  type DraftView, type InspectionReport, type InspectionView, type PolicyRefs } from '@project-qf/contracts';
import { FEATURES_VERSION } from '@project-qf/features';
import { ECONOMICS_V0_TEST, STANDARD_V1_FLAT_V0_TEST, economicsDigest } from '@project-qf/policy';
import { INSPECTION_VERSION, VALIDATOR_POLICY_V0_1 } from '@project-qf/validator';
import { FIXTURE_MINTS } from './fixtures.ts';
import { reportDigestOf, runInspection, type InspectDeps } from './inspect.ts';
import type { Store, User } from './store.ts';

export const BODY_LIMIT_BYTES = 16 * 1024;
export const INSPECTIONS_PER_MINUTE = 30;
export const STALE_AFTER_SECONDS = VALIDATOR_POLICY_V0_1.revalidateActiveSeconds;

export interface AppOptions { store: Store; inspect: InspectDeps; staticDir: string | null; now?: () => Date }

/** The policy versions a draft is saved under. A later change to any of them marks the draft policy-stale on read. */
export function currentPolicyRefs(): PolicyRefs {
  return { economics: { version: ECONOMICS_V0_TEST.version, digest: economicsDigest(ECONOMICS_V0_TEST) }, template: { version: STANDARD_V1_FLAT_V0_TEST.version },
    validator: VALIDATOR_POLICY_V0_1.id, inspection: INSPECTION_VERSION, features: FEATURES_VERSION };
}
function policyChanges(saved: PolicyRefs, now: PolicyRefs): string[] {
  const out: string[] = [];
  if (saved.economics.version !== now.economics.version || saved.economics.digest !== now.economics.digest) out.push('economics');
  if (saved.template.version !== now.template.version) out.push('template');
  for (const k of ['validator', 'inspection', 'features'] as const) if (saved[k] !== now[k]) out.push(k);
  return out;
}

class HttpError extends Error {
  status: number; code: string; details: string[] | undefined;
  constructor(status: number, code: string, message: string, details?: string[]) { super(message); this.status = status; this.code = code; this.details = details; }
}

const API_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const STATIC_CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, API_HEADERS).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const ct = String(req.headers['content-type'] ?? '');
  if (!/^application\/json(;|$)/i.test(ct)) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'body must be application/json');
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > BODY_LIMIT_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', `body over ${BODY_LIMIT_BYTES} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > BODY_LIMIT_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', `body over ${BODY_LIMIT_BYTES} bytes`);
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'body is not valid JSON'); }
}

export function createApp(o: AppOptions): Server {
  const now = o.now ?? (() => new Date());
  const rate = new Map<string, number[]>();

  const auth = (req: IncomingMessage): User => {
    const h = String(req.headers.authorization ?? '');
    const m = /^Bearer (\S+)$/.exec(h);
    const user = m ? o.store.userByToken(m[1]!) : null;
    if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'missing or invalid bearer token');
    return user;
  };
  const viewInspection = (r: InspectionReport): InspectionView => {
    if (reportDigestOf(r) !== r.reportDigest) throw new HttpError(500, 'INTEGRITY_ERROR', 'stored report does not match its digest');
    const ageSeconds = Math.max(0, Math.floor((now().getTime() - Date.parse(r.createdAt)) / 1000));
    return { ...r, ageSeconds, staleAfterSeconds: STALE_AFTER_SECONDS, freshness: ageSeconds > STALE_AFTER_SECONDS ? 'STALE' : 'FRESH' };
  };
  const viewDraft = (d: Draft): DraftView => { const ch = policyChanges(d.policyRefs, currentPolicyRefs()); return { ...d, policyStale: ch.length > 0, policyChanges: ch }; };
  const linkedInspection = (user: User, input: DraftInput): InspectionReport => {
    const insp = o.store.getInspection(user.id, input.inspectionId);
    if (!insp) throw new HttpError(422, 'INSPECTION_NOT_FOUND', 'the referenced inspection does not exist for this user');
    if (insp.mint !== input.quoteMint || insp.cluster !== input.cluster) throw new HttpError(422, 'INSPECTION_MISMATCH', 'the inspection is for a different mint or network');
    return insp;
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';
    if (path === '/api/healthz' && method === 'GET') return send(res, 200, { ok: true, apiVersion: API_VERSION, schema: o.store.schemaVersion() });
    const user = auth(req);
    if (path === '/api/session' && method === 'GET') return send(res, 200, { user, apiVersion: API_VERSION, policies: currentPolicyRefs() });
    if (path === '/api/fixtures' && method === 'GET') {
      return send(res, 200, { label: 'TEST_ONLY', cluster: 'test-only', mints: Object.entries(FIXTURE_MINTS).map(([mint, f]) => ({ mint, label: f.label })) });
    }

    if (path === '/api/inspections') {
      if (method === 'GET') return send(res, 200, { inspections: o.store.listInspections(user.id) });
      if (method === 'POST') {
        const parsed = parseInspectionRequest(await readJson(req));
        if (!parsed.ok) throw new HttpError(400, 'INVALID_REQUEST', 'invalid inspection request', parsed.errors);
        const t = now().getTime();
        const recent = (rate.get(user.id) ?? []).filter((x) => t - x < 60_000);
        if (recent.length >= INSPECTIONS_PER_MINUTE) throw new HttpError(429, 'RATE_LIMITED', `at most ${INSPECTIONS_PER_MINUTE} inspections per minute`);
        rate.set(user.id, [...recent, t]);
        const out = await runInspection(parsed.value, { ...o.inspect, now });
        return send(res, 201, viewInspection(o.store.insertInspection(user.id, out.report, out.evidence)));
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', method);
    }
    const im = /^\/api\/inspections\/([^/]+)$/.exec(path);
    if (im) {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', method);
      if (!INSPECTION_ID.test(im[1]!)) throw new HttpError(404, 'NOT_FOUND', 'inspection not found');
      const r = o.store.getInspection(user.id, im[1]!);
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'inspection not found');
      return send(res, 200, viewInspection(r));
    }

    if (path === '/api/drafts') {
      if (method === 'GET') return send(res, 200, { drafts: o.store.listDrafts(user.id).map(viewDraft) });
      if (method === 'POST') {
        const parsed = parseDraftInput(await readJson(req));
        if (!parsed.ok) throw new HttpError(400, 'INVALID_REQUEST', 'invalid draft', parsed.errors);
        const insp = linkedInspection(user, parsed.value);
        const t = now().toISOString();
        const d = o.store.insertDraft(user.id, { ...parsed.value, version: 1, status: 'DRAFT', createdAt: t, updatedAt: t,
          inspectionDigest: insp.reportDigest, inspectionDecision: insp.inspection.aggregate.decision, policyRefs: currentPolicyRefs() });
        return send(res, 201, viewDraft(d));
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', method);
    }
    const dm = /^\/api\/drafts\/([^/]+)$/.exec(path);
    if (dm) {
      const id = dm[1]!;
      const existing = DRAFT_ID.test(id) ? o.store.getDraft(user.id, id) : null;
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'draft not found');
      if (method === 'GET') return send(res, 200, viewDraft(existing));
      if (method === 'PUT') {
        const parsed = parseDraftUpdate(await readJson(req));
        if (!parsed.ok) throw new HttpError(400, 'INVALID_REQUEST', 'invalid draft update', parsed.errors);
        const { expectedVersion, ...input } = parsed.value;
        const insp = linkedInspection(user, input);
        const next: Draft = { ...existing, ...input, version: expectedVersion + 1, updatedAt: now().toISOString(), status: 'DRAFT',
          inspectionDigest: insp.reportDigest, inspectionDecision: insp.inspection.aggregate.decision, policyRefs: currentPolicyRefs() };
        const r = o.store.updateDraft(user.id, next, expectedVersion);
        if (r === 'VERSION_CONFLICT') throw new HttpError(409, 'VERSION_CONFLICT', 'the draft changed since it was loaded; reload and retry');
        if (r === 'NOT_FOUND') throw new HttpError(404, 'NOT_FOUND', 'draft not found');
        return send(res, 200, viewDraft(next));
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', method);
    }
    throw new HttpError(404, 'NOT_FOUND', 'no such route');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    if (!o.staticDir) { res.writeHead(404).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    const root = realpathSync(o.staticDir);
    let rel: string;
    try { rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1)); } catch { res.writeHead(404).end(); return; }
    const file = join(root, rel);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile() || realpathSync(file) !== file) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': STATIC_CSP,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  }

  return createServer(async (req, res) => {
    let path = '/';
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { /* keep '/' */ }
    try {
      if (path === '/api' || path.startsWith('/api/')) await api(req, res, path);
      else serveStatic(req, res, path);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const err = e instanceof HttpError ? e : new HttpError(500, 'INTERNAL', 'internal error');
      if (!(e instanceof HttpError)) console.error('[api] internal error:', (e as Error)?.message);
      const body: ApiError = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
      send(res, err.status, body);
    }
  });
}
