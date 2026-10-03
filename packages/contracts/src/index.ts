// Shared API contracts, `qf-api/1`: the read-only inspector and creator drafts. Types plus strict runtime parsers for every
// request that crosses the trust boundary; the server parses with these and the browser uses the same rules for forms.
// Unknown fields are rejected, so a client cannot smuggle state (a status, an owner, an approval) into a record.
import { isSolanaAddress } from '@project-qf/core';
import type { FeatureSet } from '@project-qf/features';
import type { InspectionResult } from '@project-qf/validator';

export const API_VERSION = 'qf-api/1';

/** 'test-only' selects the in-process TEST_ONLY fixture provider; it is never a fallback for a live cluster. */
export const REQUEST_CLUSTERS = ['mainnet-beta', 'devnet', 'test-only'] as const;
export type RequestCluster = (typeof REQUEST_CLUSTERS)[number];

export interface InspectionRequest { mint: string; cluster: RequestCluster }

export interface ProviderRead {
  provider: string;                 // host only
  providerClass: 'PRODUCTION' | 'TEST_ONLY';
  method: string;                   // e.g. getAccountInfo
  status: 'OK' | 'NOT_FOUND' | 'UNAVAILABLE';
  reason: string | null;
  slot: string | null;
  observedAt: string;
  genesisVerified: boolean | null;  // null for TEST_ONLY fixtures
}

export interface InspectionReport {
  id: string;
  apiVersion: typeof API_VERSION;
  createdAt: string;
  mint: string;
  cluster: RequestCluster;
  label: 'LIVE_READ' | 'TEST_ONLY_FIXTURE';
  inspection: InspectionResult;
  features: FeatureSet;
  reads: ProviderRead[];
  policies: { validator: string; evidence: string; inspection: string; features: string };
  evidenceDigest: string;           // sha256 of the canonical raw observations
  reportDigest: string;             // sha256 of the canonical report body (everything above except id)
}
/** What the API returns on read: the stored report plus how old its evidence is now. */
export interface InspectionView extends InspectionReport { ageSeconds: number; freshness: 'FRESH' | 'STALE'; staleAfterSeconds: number }
export interface InspectionSummary { id: string; createdAt: string; mint: string; cluster: RequestCluster; label: InspectionReport['label']; decision: string }

export interface DraftInput {
  name: string;
  symbol: string;
  description: string;
  quoteMint: string;
  cluster: RequestCluster;
  inspectionId: string;
}
export interface DraftUpdate extends DraftInput { expectedVersion: number }

export interface PolicyRefs {
  economics: { version: string; digest: string };
  template: { version: string };
  validator: string;
  inspection: string;
  features: string;
}
export interface Draft extends DraftInput {
  id: string;
  version: number;
  status: 'DRAFT';                  // drafts never launch anything in this milestone
  createdAt: string;
  updatedAt: string;
  inspectionDigest: string;         // reportDigest of the referenced inspection when the draft was saved
  inspectionDecision: string;       // aggregate decision at save time, for display only
  policyRefs: PolicyRefs;
}
/** Draft as read back: `policyStale` is true when the current policies differ from the ones the draft was saved under. */
export interface DraftView extends Draft { policyStale: boolean; policyChanges: string[] }

export interface ApiError { error: { code: string; message: string; details?: string[] } }

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const INSPECTION_ID = /^insp_[0-9a-f]{32}$/;
export const DRAFT_ID = /^draft_[0-9a-f]{32}$/;
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]'); // incl. bidi overrides

function strictObject(x: unknown, allowed: readonly string[], errors: string[]): Record<string, unknown> | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) { errors.push('BODY_NOT_OBJECT'); return null; }
  for (const k of Object.keys(x)) if (!allowed.includes(k)) errors.push(`UNKNOWN_FIELD ${k}`);
  return x as Record<string, unknown>;
}

function cluster(v: unknown, errors: string[]): RequestCluster | null {
  if (typeof v === 'string' && (REQUEST_CLUSTERS as readonly string[]).includes(v)) return v as RequestCluster;
  errors.push(`UNSUPPORTED_CLUSTER ${JSON.stringify(v)?.slice(0, 40)}`);
  return null;
}

function mint(v: unknown, field: string, errors: string[]): string | null {
  if (typeof v === 'string' && isSolanaAddress(v.trim())) return v.trim();
  errors.push(`INVALID_${field.toUpperCase()}: not a 32-byte base58 Solana address`);
  return null;
}

export function parseInspectionRequest(x: unknown): Parsed<InspectionRequest> {
  const errors: string[] = [];
  const o = strictObject(x, ['mint', 'cluster'], errors);
  if (!o) return { ok: false, errors };
  const m = mint(o.mint, 'mint', errors);
  const c = cluster(o.cluster, errors);
  return errors.length || !m || !c ? { ok: false, errors } : { ok: true, value: { mint: m, cluster: c } };
}

function text(v: unknown, field: string, min: number, max: number, errors: string[], allowNewline = false): string | null {
  if (typeof v !== 'string') { errors.push(`INVALID_${field}: not a string`); return null; }
  const s = v.trim();
  if (s.length < min || s.length > max) errors.push(`INVALID_${field}: length ${s.length} not in ${min}..${max}`);
  if (CONTROL.test(s) || (!allowNewline && /[\n\r\t]/.test(s))) errors.push(`INVALID_${field}: control or bidi characters`);
  return s;
}

export function parseDraftInput(x: unknown): Parsed<DraftInput> {
  return parseDraftBody(x, false) as Parsed<DraftInput>;
}
export function parseDraftUpdate(x: unknown): Parsed<DraftUpdate> {
  return parseDraftBody(x, true) as Parsed<DraftUpdate>;
}

function parseDraftBody(x: unknown, update: boolean): Parsed<DraftInput | DraftUpdate> {
  const errors: string[] = [];
  const fields = ['name', 'symbol', 'description', 'quoteMint', 'cluster', 'inspectionId', ...(update ? ['expectedVersion'] : [])];
  const o = strictObject(x, fields, errors);
  if (!o) return { ok: false, errors };
  const name = text(o.name, 'NAME', 1, 32, errors);
  const symbol = typeof o.symbol === 'string' ? o.symbol.trim() : '';
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) errors.push('INVALID_SYMBOL: 1-10 characters A-Z or 0-9');
  const description = text(o.description ?? '', 'DESCRIPTION', 0, 500, errors, true);
  const quoteMint = mint(o.quoteMint, 'quoteMint', errors);
  const c = cluster(o.cluster, errors);
  const inspectionId = typeof o.inspectionId === 'string' && INSPECTION_ID.test(o.inspectionId) ? o.inspectionId : null;
  if (!inspectionId) errors.push('INVALID_INSPECTION_ID');
  let expectedVersion = 0;
  if (update) {
    if (typeof o.expectedVersion === 'number' && Number.isInteger(o.expectedVersion) && o.expectedVersion >= 1) expectedVersion = o.expectedVersion;
    else errors.push('INVALID_EXPECTED_VERSION');
  }
  if (errors.length) return { ok: false, errors };
  const value: DraftInput = { name: name!, symbol, description: description!, quoteMint: quoteMint!, cluster: c!, inspectionId: inspectionId! };
  return { ok: true, value: update ? { ...value, expectedVersion } : value };
}
