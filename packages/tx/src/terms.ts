// Approved transaction terms: what a person (or, for MIGRATE, the operator) consented to, per operation.
// A preview binds decoded wire bytes to these terms; a program allowlist alone is never sufficient (QF-SEC-01).
// Runtime-validated because terms cross the server/browser boundary as JSON.
import { isAddress } from '@solana/kit';
import { canonicalJson, type Cluster } from '@project-qf/core';
import { PROGRAM_IDS } from './programs.ts';
import { NATIVE_MINT, DAMM_V2_CUSTOMIZABLE_CONFIG } from './engine/pda.ts';

export const TX_BINDING_POLICY_VERSION = 'tx-binding-v0.1';
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;              // Solana per-transaction maximum
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000_000n; // hard ceiling; terms set the real cap

export interface ComputeCaps { maxUnitLimit: number; maxUnitPriceMicroLamports: string }
interface Common { cluster: Cluster; policyVersion: string; feePayer: string; compute: ComputeCaps }
interface Mints { baseMint: string; quoteMint: string; baseTokenProgram: string; quoteTokenProgram: string }

export type ApprovedTerms =
  | (Common & { kind: 'CREATE_CONFIG'; config: string; payer: string; feeClaimer: string; leftoverReceiver: string; quoteMint: string; configParametersDigest: string })
  | (Common & { kind: 'CREATE_POOL'; config: string; creator: string; payer: string; baseMint: string; quoteMint: string; quoteTokenProgram: string; name: string; symbol: string; uri: string })
  | (Common & Mints & { kind: 'SWAP'; config: string; pool: string; user: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE';
      amountIn: string; minimumAmountOut: string; referralTokenAccount: string | null; allowSysvarInstructions: boolean })
  | (Common & Mints & { kind: 'MIGRATE_DAMM_V2'; config: string; pool: string; payer: string; dammConfig: string })
  // A swap on the DAMM v2 pool a DBC launch graduated into (token A = base, token B = quote, V0 migration template config).
  | (Common & Mints & { kind: 'DAMM_SWAP'; dammConfig: string; pool: string; user: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE';
      amountIn: string; minimumAmountOut: string })
  // Claiming the trading fees a graduated launch's DAMM v2 position has earned, into the position owner's own token accounts.
  | (Common & Mints & { kind: 'DAMM_CLAIM_POSITION_FEE'; dammConfig: string; pool: string; owner: string; positionNftMint: string })
  | (Common & Mints & { kind: 'CLAIM_PARTNER_TRADING_FEE'; config: string; pool: string; feeClaimer: string; receiver: string; maxBaseAmount: string; maxQuoteAmount: string })
  | (Common & Mints & { kind: 'CLAIM_CREATOR_TRADING_FEE'; config: string; pool: string; creator: string; receiver: string; maxBaseAmount: string; maxQuoteAmount: string });

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
  CREATE_CONFIG: { addrs: ['config', 'payer', 'feeClaimer', 'leftoverReceiver', 'quoteMint'], u64: [], positive: [] },
  CREATE_POOL: { addrs: ['config', 'creator', 'payer', 'baseMint', 'quoteMint', 'quoteTokenProgram'], u64: [], positive: [] },
  SWAP: { addrs: ['config', 'pool', 'user', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  MIGRATE_DAMM_V2: { addrs: ['config', 'pool', 'payer', 'dammConfig', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: [], positive: [] },
  DAMM_CLAIM_POSITION_FEE: { addrs: ['dammConfig', 'pool', 'owner', 'positionNftMint', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: [], positive: [] },
  DAMM_SWAP: { addrs: ['dammConfig', 'pool', 'user', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  CLAIM_PARTNER_TRADING_FEE: { addrs: ['config', 'pool', 'feeClaimer', 'receiver', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['maxBaseAmount', 'maxQuoteAmount'], positive: [] },
  CLAIM_CREATOR_TRADING_FEE: { addrs: ['config', 'pool', 'creator', 'receiver', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['maxBaseAmount', 'maxQuoteAmount'], positive: [] },
};

/** Runtime validation of terms. Returns violations; empty means structurally valid V0 terms. */
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
  // V0 scope: SPL Token base and quote only; native-SOL quote flows (wrap/unwrap, temp wSOL) fail closed.
  for (const k of ['baseTokenProgram', 'quoteTokenProgram']) if (k in o && o[k] !== PROGRAM_IDS.TOKEN) v.push(`TERMS_UNSUPPORTED_V0 ${k} must be SPL Token`);
  if (o.quoteMint === NATIVE_MINT || o.baseMint === NATIVE_MINT) v.push('TERMS_UNSUPPORTED_V0 native SOL quote/base');
  if ((o.kind === 'SWAP' || o.kind === 'DAMM_SWAP') && o.direction !== 'QUOTE_TO_BASE' && o.direction !== 'BASE_TO_QUOTE') v.push('TERMS_BAD_DIRECTION');
  if (o.kind === 'SWAP' && o.referralTokenAccount !== null && (typeof o.referralTokenAccount !== 'string' || !isAddress(o.referralTokenAccount))) v.push('TERMS_BAD_ADDRESS referralTokenAccount');
  if (o.kind === 'SWAP' && typeof o.allowSysvarInstructions !== 'boolean') v.push('TERMS_BAD_FLAG allowSysvarInstructions');
  if (o.kind === 'CREATE_CONFIG' && (typeof o.configParametersDigest !== 'string' || !HEX32.test(o.configParametersDigest))) v.push('TERMS_BAD_DIGEST configParametersDigest');
  if (o.kind === 'CREATE_POOL') for (const k of ['name', 'symbol', 'uri']) if (typeof o[k] !== 'string' || (o[k] as string).length === 0 || (o[k] as string).length > 200) v.push(`TERMS_BAD_STRING ${k}`);
  if ((o.kind === 'MIGRATE_DAMM_V2' || o.kind === 'DAMM_SWAP' || o.kind === 'DAMM_CLAIM_POSITION_FEE') && o.dammConfig !== DAMM_V2_CUSTOMIZABLE_CONFIG) v.push('TERMS_DAMM_CONFIG_NOT_V0_TEMPLATE');
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
