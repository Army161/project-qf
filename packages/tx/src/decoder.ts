// Browser-safe preview decoder. Uses @solana/kit codecs only (never @solana/web3.js v1).
// Decodes wire bytes independently of whoever built them and checks them against the intent.
import { getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import type { IntentKind } from './intent.ts';
import { PROGRAM_IDS } from './programs.ts';
import { bindTransactionToTerms } from './semantic.ts';
import { verifyConsentBinding, termsDigest, consentDigest, sha256Hex, type ApprovedTerms, type ConsentRecord } from './terms.ts';
export { PROGRAM_IDS };

export interface DecodedInstruction { programAddress: string; accounts: string[]; dataHex: string }
export interface DecodedTransaction {
  version: 0 | 'legacy';
  feePayer: string;
  signers: string[];
  writableAccounts: string[];
  instructions: DecodedInstruction[];
  addressTableLookups: number;
  lifetimeToken: string;
  /** Hex of the compiled message bytes (what a signer signs), when decoded from wire bytes. */
  messageHex?: string;
}

const hex = (b: Uint8Array | undefined) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') : '');

export function decodeTransactionBytes(bytes: Uint8Array): DecodedTransaction {
  const tx = getTransactionDecoder().decode(bytes);
  const reencoded = new Uint8Array(getTransactionEncoder().encode(tx));
  if (reencoded.length !== bytes.length || reencoded.some((b, k) => b !== bytes[k])) throw new Error('transaction bytes do not round-trip');
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    version: 0 | 'legacy' | 1;
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[];
    lifetimeToken: string;
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    addressTableLookups?: unknown[];
  };
  if (msg.version !== 0 && msg.version !== 'legacy') throw new Error(`UNSUPPORTED_MESSAGE_VERSION ${String(msg.version)}`);
  const keys = msg.staticAccounts;
  const { numSignerAccounts: ns, numReadonlySignerAccounts: nrs, numReadonlyNonSignerAccounts: nrn } = msg.header;
  if (ns < 1 || ns > keys.length || Object.keys(tx.signatures).length !== ns) throw new Error('inconsistent signer header');
  const at = (k: number) => { const a = keys[k]; if (a === undefined) throw new Error(`account index ${k} not in static keys (lookup tables unsupported)`); return a; };
  const writable = keys.filter((_, k) => (k < ns ? k < ns - nrs : k < keys.length - nrn));
  return {
    version: msg.version,
    feePayer: keys[0]!,
    signers: keys.slice(0, ns),
    writableAccounts: writable,
    instructions: msg.instructions.map((ix) => ({ programAddress: at(ix.programAddressIndex), accounts: (ix.accountIndices ?? []).map(at), dataHex: hex(ix.data) })),
    addressTableLookups: msg.addressTableLookups?.length ?? 0,
    lifetimeToken: String(msg.lifetimeToken),
    messageHex: hex(new Uint8Array(tx.messageBytes)),
  };
}

const P = PROGRAM_IDS;
const BASE = [P.COMPUTE_BUDGET, P.SYSTEM, P.ASSOCIATED_TOKEN, P.TOKEN, P.TOKEN_2022];
/** Coarse first filter only. QF-SEC-01: an allowlist is never sufficient; bindTransactionToTerms decides. */
export const TOP_LEVEL_ALLOWLIST: Record<IntentKind, readonly string[]> = {
  CREATE_CONFIG: [...BASE, P.DBC], CREATE_POOL: [...BASE, P.DBC], SWAP: [...BASE, P.DBC], DAMM_SWAP: [...BASE, P.DAMM_V2], DAMM_CLAIM_POSITION_FEE: [...BASE, P.DAMM_V2],
  MIGRATE_DAMM_V2: [...BASE, P.DBC], CLAIM_PARTNER_TRADING_FEE: [...BASE, P.DBC], CLAIM_CREATOR_TRADING_FEE: [...BASE, P.DBC],
  CREATE_CONFIG_TRANSFER_FEE: [], CREATE_CONFIG_TRANSFER_HOOK: [],
};

export interface PreviewRequest { kind: IntentKind; feePayer: string; signerAddress: string; terms: ApprovedTerms; consent: ConsentRecord }
export interface PreviewResult {
  violations: string[];
  termsDigest: string | null;
  consentDigest: string | null;
  /** sha256 of the exact message bytes previewed; a later signing step must sign exactly this message. */
  messageDigest: string | null;
  lifetimeToken: string;
}

/**
 * Preview verification: binds the decoded message to the approved terms and to the consent record.
 * Returns violations with the digests a signing step must re-check. There is no signing in this package.
 */
export async function verifyTransactionPreview(d: DecodedTransaction, i: PreviewRequest): Promise<PreviewResult> {
  const v: string[] = [];
  if (!i || !i.terms) v.push('TERMS_MISSING');
  else {
    if (i.terms.kind !== i.kind) v.push(`TERMS_KIND_MISMATCH ${String(i.terms.kind)} vs ${i.kind}`);
    if (i.feePayer !== i.terms.feePayer) v.push('INTENT_FEE_PAYER_NOT_IN_TERMS');
    v.push(...await bindTransactionToTerms(d, i.terms));
    v.push(...await verifyConsentBinding(i.terms, i.consent));
  }
  if (i && !d.signers.includes(i.signerAddress)) v.push('REQUIRED_SIGNER_MISSING');
  const valid = i?.terms && !v.some((x) => x.startsWith('TERMS_'));
  return {
    violations: [...new Set(v)],
    termsDigest: valid ? await termsDigest(i.terms) : null,
    consentDigest: i?.consent ? await consentDigest(i.consent) : null,
    messageDigest: d.messageHex ? await sha256Hex(`QF-MESSAGE:${d.messageHex}`) : null,
    lifetimeToken: d.lifetimeToken,
  };
}

/** Violations only (empty = the message is bound to the approved terms and consent). */
export async function verifyDecodedAgainstIntent(d: DecodedTransaction, i: PreviewRequest): Promise<string[]> {
  return (await verifyTransactionPreview(d, i)).violations;
}
