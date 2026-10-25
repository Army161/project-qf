// Before anything reaches the wallet, the page decodes the server-built bytes itself and proves two things:
//   1. the terms say what the person asked for (amounts, names, their own wallet, the platform config), and
//   2. every instruction, account, signer and writable account in the bytes is bound to those terms (packages/tx).
// The consent record binds the terms digest to the evidence that was on screen. Any violation stops the flow.
import { canonicalJson } from '@project-qf/core';
import { decodeTransactionBytes, sha256Hex, termsDigest, verifyTransactionPreview, TOP_LEVEL_ALLOWLIST, type ApprovedTerms, type ConsentRecord } from '@project-qf/tx';

/** The most compute a transaction built for this page may ask for: 400k units, priority fee at most 0.00004 SOL. */
export const PAGE_COMPUTE = Object.freeze({ maxUnitLimit: 400_000, maxUnitPriceMicroLamports: 100_000n });

/** The least a swap may pay out at this slippage, computed in the page from the amount shown, never taken from the server.
 *  Same rounding as the servers' quotes (floor), so an honest quote's minimum equals it. 0 means there is no safe floor. */
export function slippageFloor(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000 || expectedOut <= 0n) return 0n;
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface Check { label: string; ok: boolean; detail?: string }
export interface Expectation {
  kind: ApprovedTerms['kind'];
  /** the network the page is on (from the launchpad's platform answer); devnet when omitted */
  cluster?: 'devnet' | 'localnet';
  wallet: string;
  fields: Record<string, string | null>;
  /** for swaps: the minimum out may be higher than shown, never lower */
  minimumAmountOutAtLeast?: string;
  shown: unknown;
}

/** Plain-language check lines for the fields a person can recognise. */
const FIELD_LABELS: Record<string, string> = {
  user: 'Trades from your own wallet', creator: 'Claims as this coin\'s creator (your wallet)',
  baseMint: 'The coin is this coin', quoteMint: 'Priced in the platform quote token', direction: 'Buy or sell is what you picked',
  amountIn: 'The amount is what you entered', name: 'Name is what you entered', symbol: 'Ticker is what you entered', uri: 'Metadata link is this launch\'s',
  ammConfig: 'Graduates into the platform pool config',
};

export async function checkBuiltTransaction(bytes: Uint8Array, terms: ApprovedTerms, e: Expectation): Promise<{ ok: boolean; checks: Check[]; consent: ConsentRecord }> {
  const checks: Check[] = [];
  const t = terms as unknown as Record<string, unknown>;
  const cluster = e.cluster ?? 'devnet';
  checks.push({ label: `Network is ${cluster}`, ok: terms.cluster === cluster });
  checks.push({ label: 'Operation matches', ok: terms.kind === e.kind, detail: terms.kind });
  checks.push({ label: 'Your wallet pays the fee and signs', ok: terms.feePayer === e.wallet });
  for (const [k, want] of Object.entries(e.fields)) checks.push({ label: FIELD_LABELS[k] ?? `${k} is what you entered`, ok: t[k] === want, detail: String(t[k]) });
  // The terms' own compute caps come from the server, so the page holds its own ceiling: what the server asks for today
  // (400k units, no priority fee) with room to spare, far below what packages/tx allows in general.
  const c = terms.compute;
  checks.push({ label: 'Network fee stays small', ok: !!c && c.maxUnitLimit <= PAGE_COMPUTE.maxUnitLimit && BigInt(c.maxUnitPriceMicroLamports) <= PAGE_COMPUTE.maxUnitPriceMicroLamports,
    detail: c ? `${c.maxUnitLimit} units at most ${c.maxUnitPriceMicroLamports} µlamports each` : 'no compute caps' });
  if (e.minimumAmountOutAtLeast !== undefined) {
    const got = BigInt(String(t.minimumAmountOut ?? '0'));
    checks.push({ label: 'Minimum received is not below the quote you saw', ok: got >= BigInt(e.minimumAmountOutAtLeast) });
  }
  const consent: ConsentRecord = { termsDigest: await termsDigest(terms), cluster, policyVersion: terms.policyVersion,
    evidenceDigest: await sha256Hex(canonicalJson({ domain: 'QF-UI-EVIDENCE', shown: e.shown as never })), acknowledgementDigest: null, approvedAt: new Date().toISOString() };
  let decodedOk = false, violations: string[] = [];
  try {
    const d = decodeTransactionBytes(bytes);
    const r = await verifyTransactionPreview(d, { kind: e.kind, feePayer: e.wallet, signerAddress: e.wallet, terms, consent });
    violations = r.violations;
    decodedOk = true;
    const programs = [...new Set(d.instructions.map((i) => i.programAddress))];
    const known = new Set<string>(TOP_LEVEL_ALLOWLIST[e.kind]);
    checks.push({ label: 'Only the QF engine and token programs are called', ok: programs.every((p) => known.has(p)), detail: `${d.instructions.length} instructions` });
  } catch (err) {
    violations = [`DECODE_FAILED ${(err as Error).message}`];
  }
  checks.push({ label: 'Decoded independently in this browser', ok: decodedOk });
  checks.push({ label: 'Every account and amount is bound to the terms', ok: violations.length === 0, detail: violations.slice(0, 4).join('; ') || undefined });
  return { ok: checks.every((c) => c.ok), checks, consent };
}
