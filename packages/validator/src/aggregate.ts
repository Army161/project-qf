import { isValidationMode, type CheckResult, type Decision, type ValidationMode } from '@project-qf/core';

// Every check that can FAIL must be present in a LIVE validation (QUOTE-ASSETS.md §2-4).
export const REQUIRED_LIVE_CHECKS = Object.freeze([
  'S1.1', 'S1.2', 'S1.4', 'S1.5', 'S1.6', 'S1.8', 'S1.9', 'S1.10', 'S1.12',
  'S2.1', 'S2.2', 'S2.3', 'S2.4', 'S2.5',
  'S3.1', 'S3.2', 'S3.4', 'S3.6',
] as const);
const DECISIONS = new Set(['PASS', 'WARN', 'FAIL', 'SKIP']);

/**
 * QF-VAL-03: the mode is runtime-validated (an unknown mode is FAIL, never a bypass of the LIVE inventory),
 * checks are schema-checked, duplicates fail, and an empty check set is never PASS.
 */
export function aggregate(checks: readonly CheckResult[], mode: ValidationMode): { decision: Decision; reasons: string[] } {
  const reasons: string[] = [];
  if (!isValidationMode(mode)) return { decision: 'FAIL', reasons: [`INVALID_MODE ${String(mode)}`] };
  if (!Array.isArray(checks) || checks.length === 0) return { decision: 'FAIL', reasons: ['NO_CHECKS'] };
  let decision: Decision = 'PASS';
  const byId = new Map<string, CheckResult>();
  for (const c of checks) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0 || !DECISIONS.has(c.decision) || typeof c.policyVersion !== 'string' || c.policyVersion.length === 0) {
      reasons.push(`MALFORMED_CHECK ${JSON.stringify(c?.id ?? null)}`); decision = 'FAIL'; continue;
    }
    if (byId.has(c.id)) { reasons.push(`DUPLICATE_CHECK ${c.id}`); decision = 'FAIL'; continue; }
    byId.set(c.id, c);
  }
  if (mode === 'LIVE') {
    for (const id of REQUIRED_LIVE_CHECKS) {
      const c = byId.get(id);
      if (!c || c.decision === 'SKIP') { reasons.push(`REQUIRED_CHECK_MISSING ${id}`); decision = 'FAIL'; }
    }
  }
  for (const c of byId.values()) {
    if (c.decision === 'FAIL') { decision = 'FAIL'; reasons.push(`${c.id} FAIL: ${c.reason}`); }
    else if (c.decision === 'WARN') { if (decision === 'PASS') decision = 'WARN'; reasons.push(`${c.id} WARN: ${c.reason}`); }
  }
  if (mode === 'TEST_ONLY' && decision === 'PASS') { decision = 'WARN'; reasons.push('TEST_ONLY validation is never PASS'); }
  return { decision, reasons };
}
