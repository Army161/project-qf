// S3.1: executable exit depth at a specific notional, separate from pool value (Decision 2).
// QF-VAL-01 (2026-09-27 review): the exit set is runtime-validated and policy-derived. An empty, duplicated or
// malformed exit list, an unknown mode or a nonpositive notional is FAIL, never PASS. An identity exit (the quote
// asset itself) is recorded but never counts as an independent market.
import { isRawAmount, isSolanaAddress, isValidationMode, isProviderClass, type CheckResult, type Evidence, type RouteQuote, type ValidationMode } from '@project-qf/core';
import type { EvidencePolicy, ValidatorPolicy } from './policy.ts';
import { freshness } from './time.ts';

export interface ExitDepthInput {
  quoteMint: string;
  now: string;
  mode: ValidationMode;
  notionalRaw: bigint;          // e.g. planned migration quote threshold, raw quote units
  exitMints: readonly string[]; // SOL and USDC mints; in LIVE mode exactly the policy's required exit set
  routes: readonly RouteQuote[];
  policy: ValidatorPolicy;
  evidencePolicy: EvidencePolicy;
}

/** Input violations; empty means the input is structurally valid for this mode. */
export function validateExitDepthInput(i: ExitDepthInput): string[] {
  const v: string[] = [];
  if (!isValidationMode(i.mode)) v.push(`INVALID_MODE ${String(i.mode)}`);
  if (!isSolanaAddress(i.quoteMint)) v.push('INVALID_QUOTE_MINT');
  if (typeof i.notionalRaw !== 'bigint' || i.notionalRaw <= 0n) v.push('NONPOSITIVE_NOTIONAL');
  if (!Array.isArray(i.exitMints) || i.exitMints.length === 0) v.push('EMPTY_EXIT_SET');
  else {
    if (new Set(i.exitMints).size !== i.exitMints.length) v.push('DUPLICATE_EXIT');
    for (const m of i.exitMints) if (!isSolanaAddress(m)) v.push(`INVALID_EXIT_MINT ${String(m)}`);
    if (i.mode === 'LIVE') {
      const want = [...i.policy.requiredExitMints].sort(), got = [...i.exitMints].sort();
      if (want.length !== got.length || want.some((m, k) => m !== got[k])) v.push(`EXIT_SET_NOT_POLICY (${i.policy.id} requires ${want.join(',')})`);
    }
    const independent = i.exitMints.filter((m) => m !== i.quoteMint).length;
    if (independent < i.policy.minIndependentExits) v.push(`TOO_FEW_INDEPENDENT_EXITS (${independent}<${i.policy.minIndependentExits}; identity exits do not count)`);
  }
  if (!Array.isArray(i.routes)) v.push('ROUTES_NOT_ARRAY');
  return v;
}

const routeProblem = (r: RouteQuote): string | null => {
  if (!r || typeof r.provider !== 'string' || r.provider.length === 0) return 'BAD_PROVIDER';
  if (!isProviderClass(r.providerClass)) return 'BAD_PROVIDER_CLASS';
  if (!isSolanaAddress(r.inputMint) || !isSolanaAddress(r.outputMint)) return 'BAD_MINT';
  if (!isRawAmount(r.notionalRaw) || !isRawAmount(r.filledRaw)) return 'BAD_AMOUNT';
  if (!Number.isInteger(r.priceImpactBps) || r.priceImpactBps < 0) return 'BAD_IMPACT';
  return null;
};

export function checkExitDepth(i: ExitDepthInput): CheckResult {
  const invalid = validateExitDepthInput(i);
  if (invalid.length) {
    return { id: 'S3.1', decision: 'FAIL', reason: `INVALID_INPUT: ${invalid.join('; ')} (insufficient evidence is never PASS)`, evidence: [],
      details: { notionalRaw: typeof i.notionalRaw === 'bigint' ? i.notionalRaw.toString() : 'invalid', excluded: '', testOnly: String(i.mode === 'TEST_ONLY') },
      policyVersion: i.policy?.id ?? 'unknown' };
  }
  const excluded: string[] = [];
  const perExit: string[] = [];
  const evidence: Evidence[] = [];
  const seen = { warn: false, fail: false };
  const bump = (d: 'WARN' | 'FAIL') => { if (d === 'FAIL') seen.fail = true; else seen.warn = true; };

  for (const out of i.exitMints) {
    if (out === i.quoteMint) { perExit.push(`${out}:IDENTITY_NOT_COUNTED`); continue; }
    const fills = i.routes.filter((r) => {
      const tag = `${r?.provider}:${r?.inputMint}->${r?.outputMint}`;
      const bad = routeProblem(r);
      if (bad) { excluded.push(`${tag}:${bad}`); return false; }
      if (r.inputMint !== i.quoteMint || r.outputMint !== out) return false;
      if (i.mode === 'LIVE' && r.providerClass !== 'PRODUCTION') { excluded.push(`${tag}:TEST_ONLY_IN_LIVE`); return false; }
      const f = freshness(r.observedAt, i.now, i.evidencePolicy.routeMaxAgeSeconds, i.evidencePolicy.maxClockSkewSeconds);
      if (f !== 'FRESH') { excluded.push(`${tag}:${f === 'STALE' ? 'STALE_ROUTE' : f}`); return false; }
      if (BigInt(r.notionalRaw) < i.notionalRaw || BigInt(r.filledRaw) < i.notionalRaw) { excluded.push(`${tag}:PARTIAL_OR_SMALLER_NOTIONAL`); return false; }
      return true;
    });
    if (fills.length === 0) { perExit.push(`${out}:NO_EXECUTABLE_EXIT`); bump('FAIL'); continue; }
    const best = fills.reduce((a, b) => (b.priceImpactBps < a.priceImpactBps ? b : a));
    evidence.push({ source: best.provider, providerClass: best.providerClass, observedAt: best.observedAt, note: `${i.quoteMint}->${out}` });
    if (best.priceImpactBps > i.policy.maxRouteImpactBps) { perExit.push(`${out}:IMPACT_${best.priceImpactBps}BPS`); bump('WARN'); }
    else perExit.push(`${out}:OK_${best.priceImpactBps}BPS`);
  }

  const why = [...perExit];
  let decision: CheckResult['decision'] = seen.fail ? 'FAIL' : seen.warn ? 'WARN' : 'PASS';
  if (seen.fail) why.unshift('NO_EXECUTABLE_EXIT at required notional (insufficient evidence is never PASS)');
  if (i.mode === 'TEST_ONLY') { why.push('TEST_ONLY_SYNTHETIC'); if (decision === 'PASS') decision = 'WARN'; }
  return { id: 'S3.1', decision, reason: why.join('; '), evidence,
    details: { notionalRaw: i.notionalRaw.toString(), excluded: excluded.join(' '), testOnly: String(i.mode === 'TEST_ONLY') },
    policyVersion: i.policy.id };
}
