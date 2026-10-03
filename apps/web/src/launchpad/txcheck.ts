// Before anything reaches the wallet, the page decodes the server-built bytes itself and proves two things:
//   1. the terms say what the person asked for (amounts, names, their own wallet, the platform config), and
//   2. every instruction, account, signer and writable account in the bytes is bound to those terms (packages/tx).
// The consent record binds the terms digest to the evidence that was on screen. Any violation stops the flow.
import { canonicalJson } from '@project-qf/core';
import { decodeTransactionBytes, sha256Hex, termsDigest, verifyTransactionPreview, PROGRAM_IDS, type ApprovedTerms, type ConsentRecord } from '@project-qf/tx';

export interface Check { label: string; ok: boolean; detail?: string }
export interface Expectation {
  kind: 'CREATE_POOL' | 'SWAP';
  wallet: string;
  fields: Record<string, string | null>;
  /** for SWAP: the minimum out may be higher than shown, never lower */
  minimumAmountOutAtLeast?: string;
  shown: unknown;
}

export async function checkBuiltTransaction(bytes: Uint8Array, terms: ApprovedTerms, e: Expectation): Promise<{ ok: boolean; checks: Check[]; consent: ConsentRecord }> {
  const checks: Check[] = [];
  const t = terms as unknown as Record<string, unknown>;
  checks.push({ label: 'Network is devnet', ok: terms.cluster === 'devnet' });
  checks.push({ label: 'Operation matches', ok: terms.kind === e.kind, detail: terms.kind });
  checks.push({ label: 'Your wallet pays the fee and signs', ok: terms.feePayer === e.wallet });
  for (const [k, want] of Object.entries(e.fields)) checks.push({ label: `${k} is what you entered`, ok: t[k] === want, detail: String(t[k]) });
  if (e.minimumAmountOutAtLeast !== undefined) {
    const got = BigInt(String(t.minimumAmountOut ?? '0'));
    checks.push({ label: 'Minimum received is not below the quote you saw', ok: got >= BigInt(e.minimumAmountOutAtLeast) });
  }
  const consent: ConsentRecord = { termsDigest: await termsDigest(terms), cluster: 'devnet', policyVersion: terms.policyVersion,
    evidenceDigest: await sha256Hex(canonicalJson({ domain: 'QF-UI-EVIDENCE', shown: e.shown as never })), acknowledgementDigest: null, approvedAt: new Date().toISOString() };
  let decodedOk = false, violations: string[] = [];
  try {
    const d = decodeTransactionBytes(bytes);
    const r = await verifyTransactionPreview(d, { kind: e.kind, feePayer: e.wallet, signerAddress: e.wallet, terms, consent });
    violations = r.violations;
    decodedOk = true;
    const programs = [...new Set(d.instructions.map((i) => i.programAddress))];
    const known = new Set<string>([PROGRAM_IDS.DBC, PROGRAM_IDS.TOKEN, PROGRAM_IDS.ASSOCIATED_TOKEN, PROGRAM_IDS.SYSTEM, PROGRAM_IDS.COMPUTE_BUDGET]);
    checks.push({ label: 'Only Meteora DBC and token programs are called', ok: programs.every((p) => known.has(p)), detail: `${d.instructions.length} instructions` });
  } catch (err) {
    violations = [`DECODE_FAILED ${(err as Error).message}`];
  }
  checks.push({ label: 'Decoded independently in this browser', ok: decodedOk });
  checks.push({ label: 'Every account and amount is bound to the terms', ok: violations.length === 0, detail: violations.slice(0, 4).join('; ') || undefined });
  return { ok: checks.every((c) => c.ok), checks, consent };
}
