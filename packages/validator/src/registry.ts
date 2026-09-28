// Quote-asset registry controls (QF-VAL-02, 2026-09-27 review).
// 1. assertNotTestOnlyAsset: a TEST_ONLY guard. It only refuses synthetic assets; passing it admits nothing.
// 2. admitToProductionRegistry: the separate admission function. It never trusts an asserted issuer class: the class
//    is derived from authoritative provenance from an owner-configured source list, an on-chain mainnet mint read
//    and a recorded approval. V0 ships NO configured authoritative sources, so nothing can be admitted in V0.
import { isIsoTimestamp, isSolanaAddress, type Chain, type Evidence } from '@project-qf/core';

export type IssuerClass = 'ISSUER_VERIFIED' | 'BRIDGE_VERIFIED' | 'TEST_ONLY';
export interface RegistryAsset { id: string; mint: string; symbol: string; issuerClass: IssuerClass; evidence: Evidence[] }

const TEST_ONLY_PREFIX = 'test-only:';
export const testOnlyAssetId = (symbol: string) => `${TEST_ONLY_PREFIX}${symbol}`;

/** TEST_ONLY guard (formerly promoteToProductionRegistry). Throws for synthetic assets; it is NOT production admission. */
export function assertNotTestOnlyAsset(a: Pick<RegistryAsset, 'id' | 'issuerClass' | 'evidence'>): void {
  if (a.issuerClass === 'TEST_ONLY' || a.id.startsWith(TEST_ONLY_PREFIX)) throw new Error(`TEST_ONLY asset ${a.id} cannot be promoted`);
  if (a.evidence.some((e) => e.providerClass !== 'PRODUCTION')) throw new Error(`asset ${a.id} has TEST_ONLY evidence`);
}

export const REGISTRY_ADMISSION_POLICY_VERSION = 'registry-admission-v0.1';
export interface AuthoritativeSource { id: string; kind: 'ISSUER_FIRST_PARTY' | 'BRIDGE_REGISTRY'; origin: string }
/** Owner-configured authoritative sources. Empty in V0: admission is structurally implemented but not enabled. */
export const AUTHORITATIVE_SOURCES_V0: readonly AuthoritativeSource[] = Object.freeze([]);

export interface AdmissionRequest {
  id: string;
  chain: Chain;
  mint: string;
  symbol: string;
  decimals: number;
  provenance: { sourceId: string; url: string; retrievedAt: string; contentSha256: string; statedMint: string };
  onChainMint: { cluster: 'mainnet-beta'; slot: string; owner: string; decimals: number; observedAt: string; providerClass: 'PRODUCTION' | 'TEST_ONLY'; mintAuthority: string | null; freezeAuthority: string | null };
  approval: { approver: string; approvedAt: string; reference: string; policyVersion: string };
  evidence: Evidence[];
  /** Ignored by design: an externally asserted class is never accepted. */
  assertedIssuerClass?: unknown;
}
export interface AdmittedAsset {
  id: string; chain: Chain; mint: string; symbol: string; decimals: number;
  issuerClass: 'ISSUER_VERIFIED' | 'BRIDGE_VERIFIED'; registry: 'PRODUCTION'; admissionPolicyVersion: string;
  provenance: AdmissionRequest['provenance']; onChainMint: AdmissionRequest['onChainMint']; approval: AdmissionRequest['approval'];
}

const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

export function admitToProductionRegistry(r: AdmissionRequest, sources: readonly AuthoritativeSource[] = AUTHORITATIVE_SOURCES_V0):
  { ok: true; asset: Readonly<AdmittedAsset> } | { ok: false; violations: string[] } {
  const v: string[] = [];
  if (!r || typeof r !== 'object') return { ok: false, violations: ['REQUEST_MISSING'] };
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.startsWith(TEST_ONLY_PREFIX)) v.push('BAD_OR_TEST_ONLY_ID');
  if (r.chain !== 'solana') v.push('CHAIN_NOT_SOLANA');
  if (!isSolanaAddress(r.mint)) v.push('INVALID_MINT');
  if (typeof r.symbol !== 'string' || !/^[A-Za-z0-9.$_-]{1,16}$/.test(r.symbol)) v.push('INVALID_SYMBOL');
  if (!Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 18) v.push('INVALID_DECIMALS');
  const p = r.provenance;
  const src = p ? sources.find((s) => s.id === p.sourceId) : undefined;
  if (!p) v.push('PROVENANCE_MISSING');
  else {
    if (!src) v.push(`SOURCE_NOT_AUTHORITATIVE ${String(p.sourceId)}`);
    let origin = '';
    try { const u = new URL(p.url); origin = u.origin; if (u.protocol !== 'https:') v.push('PROVENANCE_NOT_HTTPS'); } catch { v.push('PROVENANCE_BAD_URL'); }
    if (src && origin !== src.origin) v.push('PROVENANCE_ORIGIN_MISMATCH');
    if (!isIsoTimestamp(p.retrievedAt)) v.push('PROVENANCE_BAD_TIMESTAMP');
    if (typeof p.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.contentSha256)) v.push('PROVENANCE_NO_CONTENT_HASH');
    if (p.statedMint !== r.mint) v.push('PROVENANCE_MINT_MISMATCH');
  }
  const m = r.onChainMint;
  if (!m) v.push('ONCHAIN_MINT_READ_MISSING');
  else {
    if (m.cluster !== 'mainnet-beta') v.push('ONCHAIN_READ_NOT_MAINNET');
    if (m.providerClass !== 'PRODUCTION') v.push('ONCHAIN_READ_TEST_ONLY');
    if (!TOKEN_PROGRAMS.has(m.owner)) v.push('MINT_NOT_TOKEN_PROGRAM_OWNED');
    if (m.decimals !== r.decimals) v.push('DECIMALS_MISMATCH');
    if (!/^\d+$/.test(String(m.slot))) v.push('ONCHAIN_READ_NO_SLOT');
    if (!isIsoTimestamp(m.observedAt)) v.push('ONCHAIN_READ_BAD_TIMESTAMP');
  }
  const a = r.approval;
  if (!a || typeof a.approver !== 'string' || a.approver.length === 0 || typeof a.reference !== 'string' || a.reference.length === 0 || !isIsoTimestamp(a.approvedAt)) v.push('APPROVAL_MISSING');
  else if (a.policyVersion !== REGISTRY_ADMISSION_POLICY_VERSION) v.push('APPROVAL_POLICY_MISMATCH');
  if (!Array.isArray(r.evidence) || r.evidence.length === 0) v.push('EVIDENCE_EMPTY');
  else if (r.evidence.some((e) => e.providerClass !== 'PRODUCTION')) v.push('EVIDENCE_TEST_ONLY');
  if (v.length) return { ok: false, violations: v };
  return { ok: true, asset: Object.freeze({ id: r.id, chain: r.chain, mint: r.mint, symbol: r.symbol, decimals: r.decimals,
    issuerClass: src!.kind === 'ISSUER_FIRST_PARTY' ? 'ISSUER_VERIFIED' : 'BRIDGE_VERIFIED', registry: 'PRODUCTION', admissionPolicyVersion: REGISTRY_ADMISSION_POLICY_VERSION,
    provenance: p, onChainMint: m, approval: a }) };
}
