// Approved transaction terms: what a person consented to, per operation.
// A preview binds decoded wire bytes to these terms; a program allowlist alone is never sufficient (QF-SEC-01).
// Runtime-validated because terms cross the server/browser boundary as JSON.
import { isAddress } from '@solana/kit';
import { canonicalJson, type Cluster } from '@project-qf/core';
import { NATIVE_MINT } from '@project-qf/engine';

export const TX_BINDING_POLICY_VERSION = 'tx-binding-v0.1';
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;              // Solana per-transaction maximum
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000_000n; // hard ceiling; terms set the real cap

export interface ComputeCaps { maxUnitLimit: number; maxUnitPriceMicroLamports: string }
interface Common { cluster: Cluster; policyVersion: string; feePayer: string; compute: ComputeCaps }

/** Terms on Project QF's own engine (ADR-014): the coin is a Token-2022 mint and the quote may be wrapped SOL. What these
 *  bind to is in qf-engine.ts: exactly the instructions @project-qf/engine builds from the terms, byte for byte. */
export type ApprovedTerms =
  | (Common & QfCoin & { kind: 'QF_CREATE'; creator: string; ammConfig: string; name: string; symbol: string; uri: string })
  | (Common & QfCoin & { kind: 'QF_SWAP'; user: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE'; amountIn: string; minimumAmountOut: string })
  | (Common & QfCoin & { kind: 'QF_POOL_SWAP'; user: string; ammConfig: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE'; amountIn: string; minimumAmountOut: string })
  | (Common & QfCoin & { kind: 'QF_CLAIM_CREATOR_FEES'; creator: string })
  | (Common & QfCoin & { kind: 'QF_COLLECT_POOL_CREATOR_FEE'; creator: string; ammConfig: string });
interface QfCoin { baseMint: string; quoteMint: string }
export type QfTerms = ApprovedTerms;
export const QF_KINDS: readonly QfTerms['kind'][] = ['QF_CREATE', 'QF_SWAP', 'QF_POOL_SWAP', 'QF_CLAIM_CREATOR_FEES', 'QF_COLLECT_POOL_CREATOR_FEE'];
export const isQfTerms = (t: { kind: string }): t is QfTerms => (QF_KINDS as readonly string[]).includes(t.kind);
/** The engine's limits on a coin's name, ticker and metadata link, in UTF-8 bytes (qf-curve state.rs). */
export const QF_TEXT_LIMITS = Object.freeze({ name: 32, symbol: 10, uri: 200 });

/** What was consented to. The blockhash is deliberately absent: a refreshed blockhash is not a change of terms. */
export interface ConsentRecord {
  termsDigest: string;
  cluster: Cluster;
  policyVersion: string;
  evidenceDigest: string;            // digest of the evidence set shown at consent time
  acknowledgementDigest: string | null; // bound WARN acknowledgement (policy package), when any WARN applied
  approvedAt: string;
}

const CLUSTERS = new Set(['mainnet-beta', 'devnet', 'localnet', 'mock-offline']);
const U64_MAX = 2n ** 64n - 1n;
const HEX32 = /^[0-9a-f]{64}$/;
const KIND_FIELDS: Record<ApprovedTerms['kind'], { addrs: string[]; u64: string[]; positive: string[] }> = {
  QF_CREATE: { addrs: ['creator', 'baseMint', 'quoteMint', 'ammConfig'], u64: [], positive: [] },
  QF_SWAP: { addrs: ['user', 'baseMint', 'quoteMint'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  QF_POOL_SWAP: { addrs: ['user', 'baseMint', 'quoteMint', 'ammConfig'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  QF_CLAIM_CREATOR_FEES: { addrs: ['creator', 'baseMint', 'quoteMint'], u64: [], positive: [] },
  QF_COLLECT_POOL_CREATOR_FEE: { addrs: ['creator', 'baseMint', 'quoteMint', 'ammConfig'], u64: [], positive: [] },
};

/** Runtime validation of terms. Returns violations; empty means structurally valid terms. */
export function validateTerms(t: unknown): string[] {
  const v: string[] = [];
  const o = t as Record<string, unknown>;
  if (!o || typeof o !== 'object') return ['TERMS_MISSING'];
  const spec = KIND_FIELDS[o.kind as ApprovedTerms['kind']];
  if (!spec) return [`TERMS_UNSUPPORTED_KIND ${String(o.kind)}`];
  if (!CLAIMS_CLUSTER(o.cluster)) v.push(`TERMS_BAD_CLUSTER ${String(o.cluster)}`);
  if (typeof o.policyVersion !== 'string' || o.policyVersion !== TX_BINDING_POLICY_VERSION) v.push(`TERMS_POLICY_VERSION ${String(o.policyVersion)}`);
  for (const k of ['feePayer', ...spec.addrs]) if (typeof o[k] !== 'string' || !isAddress(o[k] as string)) v.push(`TERMS_BAD_ADDRESS ${k}`);
  for (const k of spec.u64) {
    const s = o[k];
    if (typeof s !== 'string' || !/^(0|[1-9]\d*)$/.test(s) || BigInt(s) > U64_MAX) v.push(`TERMS_BAD_AMOUNT ${k}`);
    else if (spec.positive.includes(k) && BigInt(s) === 0n) v.push(`TERMS_NONPOSITIVE_AMOUNT ${k}`);
  }
  const c = o.compute as ComputeCaps | undefined;
  if (!c || !Number.isInteger(c.maxUnitLimit) || c.maxUnitLimit <= 0 || c.maxUnitLimit > MAX_COMPUTE_UNIT_LIMIT) v.push('TERMS_BAD_COMPUTE_LIMIT');
  if (!c || typeof c.maxUnitPriceMicroLamports !== 'string' || !/^(0|[1-9]\d*)$/.test(c.maxUnitPriceMicroLamports)
    || BigInt(c.maxUnitPriceMicroLamports) > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) v.push('TERMS_BAD_COMPUTE_PRICE');
  return [...v, ...qfViolations(o)];
}

/** Engine terms: the person who signs pays the fee; the coin is not the quote (it is a fresh Token-2022 mint, never wrapped
 *  SOL); texts fit the engine's limits. Wrapped SOL is allowed as the quote: the binding wraps and unwraps it. */
function qfViolations(o: Record<string, unknown>): string[] {
  const v: string[] = [];
  const signer = o.kind === 'QF_SWAP' || o.kind === 'QF_POOL_SWAP' ? o.user : o.creator;
  if (o.feePayer !== signer) v.push('TERMS_QF_FEE_PAYER_IS_NOT_THE_SIGNER');
  if (o.baseMint === o.quoteMint || o.baseMint === NATIVE_MINT) v.push('TERMS_QF_COIN_IS_THE_QUOTE');
  if ((o.kind === 'QF_SWAP' || o.kind === 'QF_POOL_SWAP') && o.direction !== 'QUOTE_TO_BASE' && o.direction !== 'BASE_TO_QUOTE') v.push('TERMS_BAD_DIRECTION');
  if (o.kind === 'QF_CREATE') {
    for (const k of ['name', 'symbol', 'uri'] as const) {
      const x = o[k];
      if (typeof x !== 'string' || x.length === 0 || new TextEncoder().encode(x).length > QF_TEXT_LIMITS[k]) v.push(`TERMS_BAD_STRING ${k}`);
    }
    if (o.creator === o.baseMint) v.push('TERMS_QF_MINT_IS_THE_CREATOR');
  }
  return v;
}

const CLAIMS_CLUSTER = (c: unknown) => typeof c === 'string' && CLUSTERS.has(c);

export async function sha256Hex(s: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
export const termsDigest = (t: ApprovedTerms) => sha256Hex(canonicalJson({ domain: 'QF-TX-TERMS', t }));
export const consentDigest = (c: ConsentRecord) => sha256Hex(canonicalJson({ domain: 'QF-CONSENT', c }));

/** Checks the consent record is for exactly these terms, on this cluster, under this policy, with bound evidence. */
export async function verifyConsentBinding(terms: ApprovedTerms, consent: ConsentRecord | undefined): Promise<string[]> {
  if (!consent) return ['CONSENT_MISSING'];
  const v: string[] = [];
  if (consent.termsDigest !== await termsDigest(terms)) v.push('CONSENT_TERMS_MISMATCH');
  if (consent.cluster !== terms.cluster) v.push('CONSENT_CLUSTER_MISMATCH');
  if (consent.policyVersion !== terms.policyVersion) v.push('CONSENT_POLICY_MISMATCH');
  if (typeof consent.evidenceDigest !== 'string' || !HEX32.test(consent.evidenceDigest)) v.push('CONSENT_EVIDENCE_NOT_BOUND');
  if (consent.acknowledgementDigest !== null && !HEX32.test(String(consent.acknowledgementDigest))) v.push('CONSENT_ACK_MALFORMED');
  if (!Number.isFinite(Date.parse(consent.approvedAt))) v.push('CONSENT_BAD_TIMESTAMP');
  return v;
}
