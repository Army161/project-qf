// Quote-asset inspection (milestone 2026-10-03, `inspection-v0.2`): turns raw mint-account observations from one or more
// providers into validator-v0.1 check results. Deterministic and browser-safe. Anything this version cannot measure is
// an explicit SKIP with a reason; in LIVE mode the aggregate then FAILs on the missing required checks, so missing
// evidence can never produce PASS. TEST_ONLY observations are never used in LIVE mode, and LIVE inspections never fall
// back to fixtures (that choice is made by the caller, which passes only the observations it actually obtained).
// v0.2 (2026-10-03 live-acceptance closure): S1.10 NOT_APPLICABLE for the classic native mint (decision D3, exceptions.ts),
// S1.12 counts independent operators rather than endpoints, and a System-owned address carries a wrong-network hint.
import { isSolanaAddress, isValidationMode, type CheckResult, type CheckDecision, type Cluster, type Evidence, type ProviderClass,
  type ValidationMode } from '@project-qf/core';
import { aggregate } from './aggregate.ts';
import { nativeMintSupplyExceptionGaps, S1_10_NATIVE_MINT_EXCEPTION } from './exceptions.ts';
import { decodeMint, TOKEN_2022_NATIVE_MINT, type MintExtension, type MintFacts } from './mint.ts';
import type { ValidatorPolicy } from './policy.ts';

export const INSPECTION_VERSION = 'inspection-v0.2';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export interface MintObservation {
  provider: string;              // provider id (host only, never a URL with credentials)
  operator?: string;             // who runs the provider; endpoints of one operator are not independent (default: the provider id)
  providerClass: ProviderClass;
  cluster: Cluster;
  observedAt: string;            // ISO-8601 UTC
  slot: string | null;           // context slot of the read (finalized)
  status: 'OK' | 'NOT_FOUND' | 'UNAVAILABLE';
  reason?: string;               // UNAVAILABLE: why (e.g. NETWORK_POLICY_DENIED HTTP 403)
  owner?: string;
  dataBase64?: string;
  contentHash?: string;          // sha256 hex of the raw account data
}

export type InspectionCluster = 'mainnet-beta' | 'devnet' | 'mock-offline';
export interface InspectionInput {
  mint: string;
  cluster: InspectionCluster;
  mode: ValidationMode;
  observations: readonly MintObservation[];
  policy: ValidatorPolicy;
}
export interface InspectionResult {
  version: typeof INSPECTION_VERSION;
  mint: string;
  cluster: InspectionCluster;
  mode: ValidationMode;
  facts: MintFacts | null;
  decodeError: string | null;
  checks: CheckResult[];
  aggregate: { decision: 'PASS' | 'WARN' | 'FAIL'; reasons: string[] };
  coverage: { evaluated: number; skipped: number; notApplicable: number; total: number };
}

// TOKEN-2022.md §2 (quote mint, validator S1.4).
const SUPPORTED_EXT = new Set([18, 19]); // MetadataPointer, TokenMetadata
const CONDITIONAL_EXT = new Set([1, 3, 10, 20, 21, 22, 23, 25]); // TransferFeeConfig (0 bps, no authority), MintCloseAuthority,
// InterestBearingConfig, GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember, ScaledUiAmount. Everything else,
// including unknown and account-level types appearing on a mint, is REJECTED.

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function evidenceOf(o: MintObservation): Evidence {
  const e: Evidence = { source: o.provider, providerClass: o.providerClass, observedAt: o.observedAt };
  if (o.slot) e.slot = o.slot;
  if (o.contentHash) e.contentHash = o.contentHash;
  if (o.status !== 'OK') e.note = o.status === 'NOT_FOUND' ? 'account not found' : `unavailable: ${o.reason ?? 'unknown'}`;
  return e;
}

function feeIsNonzero(x: MintExtension) { return !!x.transferFee && (x.transferFee.older.basisPoints > 0 || x.transferFee.newer.basisPoints > 0); }

export function inspectMint(i: InspectionInput): InspectionResult {
  const policyVersion = i.policy?.id ?? 'unknown';
  const checks: CheckResult[] = [];
  const add = (id: string, decision: CheckDecision, reason: string, evidence: Evidence[] = [], details: Record<string, string> = {}) =>
    checks.push({ id, decision, reason, evidence, details, policyVersion });
  let subjectOwner: string | null = null;
  const done = (facts: MintFacts | null, decodeError: string | null): InspectionResult => {
    const mode: ValidationMode = isValidationMode(i.mode) ? i.mode : 'LIVE';
    const skipped = checks.filter((c) => c.decision === 'SKIP').length;
    const notApplicable = checks.filter((c) => c.decision === 'NOT_APPLICABLE').length;
    return { version: INSPECTION_VERSION, mint: i.mint, cluster: i.cluster, mode, facts, decodeError, checks,
      aggregate: aggregate(checks, i.mode, { mint: i.mint, cluster: i.cluster, owner: subjectOwner, facts }),
      coverage: { evaluated: checks.length - skipped, skipped, notApplicable, total: checks.length } };
  };

  if (!isSolanaAddress(i.mint)) { add('IN.1', 'FAIL', 'INVALID_MINT_ADDRESS'); return done(null, null); }
  if (!isValidationMode(i.mode)) { add('IN.1', 'FAIL', `INVALID_MODE ${String(i.mode)}`); return done(null, null); }

  // Only observations that belong to this inspection count: right cluster, and PRODUCTION providers in LIVE mode.
  const ignored: string[] = [];
  const obs = i.observations.filter((o) => {
    if (o.cluster !== i.cluster) { ignored.push(`${o.provider}:WRONG_CLUSTER(${o.cluster})`); return false; }
    if (i.mode === 'LIVE' && o.providerClass !== 'PRODUCTION') { ignored.push(`${o.provider}:TEST_ONLY_IN_LIVE`); return false; }
    return true;
  });
  const answered = obs.filter((o) => o.status === 'OK' || o.status === 'NOT_FOUND');
  const unavailable = obs.filter((o) => o.status === 'UNAVAILABLE');
  const allEvidence = obs.map(evidenceOf);

  // IN.1: is there any usable evidence at all? Without it every Stage 1 check is unknown, and the inspection FAILs.
  if (answered.length === 0) {
    const why = [...unavailable.map((o) => `${o.provider}: ${o.reason ?? 'unavailable'}`), ...ignored];
    add('IN.1', 'FAIL', `NO_USABLE_EVIDENCE${why.length ? ': ' + why.join('; ') : ''}`, allEvidence);
    for (const id of ['S1.1', 'S1.2', 'S1.3', 'S1.4', 'S1.5', 'S1.6', 'S1.7', 'S1.8', 'S1.9', 'S1.10', 'S1.11', 'S1.12']) add(id, 'SKIP', 'EVIDENCE_UNAVAILABLE');
    stage2and3(add, i.cluster);
    return done(null, null);
  }
  add('IN.1', 'PASS', `${answered.length} of ${obs.length} provider(s) answered${unavailable.length ? `; unavailable: ${unavailable.map((o) => `${o.provider} (${o.reason ?? '?'})`).join(', ')}` : ''}`,
    allEvidence, { answered: String(answered.length), unavailable: String(unavailable.length), ignored: ignored.join('; ') });

  // Decode every answer independently; the first answering provider is the primary.
  const decoded = answered.map((o) => ({ o, d: o.status === 'OK' && o.owner && o.dataBase64 !== undefined ? decodeMint(o.owner, b64(o.dataBase64)) : null }));
  const primary = decoded[0]!;
  const ev = [evidenceOf(primary.o)];

  // S1.12 two-provider agreement (authorities, extensions, owner, decimals, existence; supply may move between slots).
  // Independence is by operator: two endpoints or keys of one operator are one source.
  const operators = new Set(decoded.map((x) => x.o.operator ?? x.o.provider));
  if (decoded.length < 2) add('S1.12', 'SKIP', `SINGLE_PROVIDER: needs two independent providers${unavailable.length ? ' (second unavailable)' : ''}`, ev);
  else if (operators.size < 2) add('S1.12', 'SKIP', `NOT_INDEPENDENT: ${decoded.length} answers from 1 operator (${[...operators][0]}); needs two independent providers`, decoded.map((x) => evidenceOf(x.o)));
  else {
    const sig = (x: (typeof decoded)[number]) => {
      if (x.o.status === 'NOT_FOUND') return 'NOT_FOUND';
      if (!x.d || !x.d.ok) return `UNDECODABLE:${x.d ? x.d.error : 'no data'}`;
      const f = x.d.facts;
      return JSON.stringify([x.o.owner, f.decimals, f.initialized, f.mintAuthority, f.freezeAuthority, f.extensions]);
    };
    const sigs = new Set(decoded.map(sig));
    if (sigs.size > 1) add('S1.12', 'FAIL', `PROVIDER_DISAGREEMENT across ${decoded.map((x) => x.o.provider).join(', ')}`, decoded.map((x) => evidenceOf(x.o)));
    else add('S1.12', 'PASS', `${decoded.length} providers agree on owner, decimals, authorities and extensions`, decoded.map((x) => evidenceOf(x.o)));
  }

  // S1.1 existence / owner / initialized.
  if (primary.o.status === 'NOT_FOUND') {
    add('S1.1', 'FAIL', `ACCOUNT_NOT_FOUND on ${i.cluster}: check the network, or the address is not a mint`, ev);
    for (const id of ['S1.2', 'S1.3', 'S1.4', 'S1.5', 'S1.6', 'S1.7', 'S1.8', 'S1.9', 'S1.10', 'S1.11']) add(id, 'SKIP', 'S1.1_FAILED');
    stage2and3(add, i.cluster);
    return done(null, null);
  }
  if (!primary.d || !primary.d.ok) {
    const err = primary.d ? primary.d.error : 'NO_ACCOUNT_DATA';
    // A plain System account at a mint address usually means the mint lives on another network.
    const wrongNet = primary.o.owner === SYSTEM_PROGRAM;
    add('S1.1', 'FAIL', `NOT_A_VALID_MINT: ${err}${wrongNet ? ` (not a mint on this network; check the network)` : ''}`, ev,
      { owner: primary.o.owner ?? '', ...(wrongNet ? { hint: 'WRONG_NETWORK_OR_NOT_A_MINT' } : {}) });
    for (const id of ['S1.2', 'S1.3', 'S1.4', 'S1.5', 'S1.6', 'S1.7', 'S1.8', 'S1.9', 'S1.10', 'S1.11']) add(id, 'SKIP', 'S1.1_FAILED');
    stage2and3(add, i.cluster);
    return done(null, err);
  }
  const f = primary.d.facts;
  subjectOwner = primary.o.owner ?? null;
  if (!f.initialized) {
    add('S1.1', 'FAIL', 'MINT_NOT_INITIALIZED', ev);
    for (const id of ['S1.2', 'S1.3', 'S1.4', 'S1.5', 'S1.6', 'S1.7', 'S1.8', 'S1.9', 'S1.10', 'S1.11']) add(id, 'SKIP', 'S1.1_FAILED');
    stage2and3(add, i.cluster);
    return done(f, null);
  }
  add('S1.1', 'PASS', `initialized mint owned by ${f.tokenProgram === 'SPL_TOKEN' ? 'SPL Token' : 'Token-2022'}`, ev, { owner: primary.o.owner! });
  add('S1.2', i.mint === TOKEN_2022_NATIVE_MINT ? 'FAIL' : 'PASS', i.mint === TOKEN_2022_NATIVE_MINT ? 'TOKEN_2022_NATIVE_MINT' : 'not the Token-2022 native mint', ev);
  add('S1.3', f.decimals === 0 ? 'WARN' : 'PASS', f.decimals === 0 ? 'ZERO_DECIMALS' : `decimals ${f.decimals}`, ev, { decimals: String(f.decimals) });

  // S1.4 extension classification.
  const rejected = f.extensions.filter((x) => !SUPPORTED_EXT.has(x.type) && !CONDITIONAL_EXT.has(x.type));
  const feeRejected = f.extensions.filter((x) => x.type === 1 && (feeIsNonzero(x) || x.transferFee?.configAuthority));
  const conditional = f.extensions.filter((x) => CONDITIONAL_EXT.has(x.type) && !feeRejected.includes(x));
  const extNames = f.extensions.map((x) => x.name).join(', ') || 'none';
  if (rejected.length || feeRejected.length) add('S1.4', 'FAIL', `REJECTED_EXTENSIONS: ${[...rejected, ...feeRejected].map((x) => x.name).join(', ')}`, ev, { extensions: extNames });
  else if (conditional.length) add('S1.4', 'WARN', `CONDITIONALLY_SUPPORTED: ${conditional.map((x) => x.name).join(', ')} (Meteora TokenBadge and QF review required)`, ev, { extensions: extNames });
  else add('S1.4', 'PASS', f.tokenProgram === 'SPL_TOKEN' ? 'classic SPL mint: no extensions' : `supported extensions only: ${extNames}`, ev, { extensions: extNames });

  // S1.5 transfer fee.
  const fee = f.extensions.find((x) => x.type === 1);
  if (!fee) add('S1.5', 'PASS', 'no transfer-fee extension', ev);
  else if (feeIsNonzero(fee)) add('S1.5', 'FAIL', `NONZERO_TRANSFER_FEE older ${fee.transferFee!.older.basisPoints} bps, newer ${fee.transferFee!.newer.basisPoints} bps`, ev);
  else if (fee.transferFee?.configAuthority) add('S1.5', 'FAIL', `ZERO_FEE_WITH_LIVE_CONFIG_AUTHORITY ${fee.transferFee.configAuthority}`, ev);
  else add('S1.5', 'PASS', 'ZERO_FEE_AUTHORITY_NONE: TokenBadge required (S1.6/S1.7)', ev);

  // S1.6 / S1.7: DBC permissionless quote mint per TOKEN-2022.md §2 (classic SPL, or Token-2022 with only metadata extensions).
  const permissionless = f.extensions.every((x) => SUPPORTED_EXT.has(x.type));
  if (permissionless) {
    add('S1.6', 'PASS', 'DBC permissionless quote mint (TOKEN-2022.md §2)', ev);
    add('S1.7', 'SKIP', 'NOT_APPLICABLE: no TokenBadge needed', ev);
  } else {
    add('S1.6', 'WARN', 'NOT_PERMISSIONLESS: Meteora TokenBadge required (S1.7)', ev);
    add('S1.7', 'FAIL', `TOKEN_BADGE_UNVERIFIED: badge lookup is not implemented in ${INSPECTION_VERSION}`, ev);
  }

  // S1.8 / S1.9 authorities. The issuer allowlist (CANONICAL-ASSETS.md §4) is empty until registry admission is enabled.
  add('S1.8', f.freezeAuthority ? 'FAIL' : 'PASS', f.freezeAuthority ? 'FREEZE_AUTHORITY_PRESENT: issuer allowlist is empty in V0, so it cannot be downgraded to WARN' : 'no freeze authority', ev,
    { freezeAuthority: f.freezeAuthority ?? 'none' });
  add('S1.9', f.mintAuthority ? 'FAIL' : 'PASS', f.mintAuthority ? 'MINT_AUTHORITY_PRESENT: issuer allowlist is empty in V0, so it cannot be downgraded to WARN' : 'no mint authority', ev,
    { mintAuthority: f.mintAuthority ?? 'none' });
  // S1.10 supply. The classic native mint's supply field does not count wrapped SOL (decision D3): evaluated NOT_APPLICABLE,
  // raw value kept. Any contradiction (decimals, authorities, owner, cluster) leaves the ordinary rule in force.
  if (f.supplyRaw !== '0') add('S1.10', 'PASS', `supply ${f.supplyRaw} raw`, ev, { supplyRaw: f.supplyRaw });
  else if (i.mint !== S1_10_NATIVE_MINT_EXCEPTION.mint) add('S1.10', 'FAIL', 'ZERO_SUPPLY', ev, { supplyRaw: f.supplyRaw });
  else {
    const gaps = nativeMintSupplyExceptionGaps({ mint: i.mint, cluster: i.cluster, owner: subjectOwner, facts: f });
    if (gaps.length) add('S1.10', 'FAIL', `ZERO_SUPPLY: native-mint exception not applied (${gaps.join(', ')})`, ev, { supplyRaw: f.supplyRaw });
    else add('S1.10', 'NOT_APPLICABLE', S1_10_NATIVE_MINT_EXCEPTION.reason, ev, { supplyRaw: f.supplyRaw, exception: S1_10_NATIVE_MINT_EXCEPTION.id,
      note: 'classic SPL native mint: the supply field is not a total of wrapped SOL; raw value kept for audit; no other check is waived' });
  }
  add('S1.11', 'SKIP', `NOT_READ: metadata is not read in ${INSPECTION_VERSION} (never identity)`);
  stage2and3(add, i.cluster);
  return done(f, null);
}

function stage2and3(add: (id: string, d: CheckDecision, r: string) => void, cluster: InspectionCluster) {
  // Stage 2. Registry admission ships with no authoritative sources in V0 (ADR-007), so no asset is registered.
  if (cluster === 'mainnet-beta') add('S2.1', 'FAIL', 'REGISTRY_ABSENT: production registry admission is not enabled in V0');
  else add('S2.1', 'WARN', `REGISTRY_ABSENT on ${cluster}`);
  add('S2.2', 'SKIP', 'REGISTRY_EMPTY: no registered assets to compare against');
  add('S2.3', 'SKIP', 'PROVENANCE_NOT_ASSESSED: no issuer or bridge registry source configured');
  add('S2.4', 'WARN', 'ASSET_CLASS_UNKNOWN');
  add('S2.5', 'SKIP', 'COMPLIANCE_LISTS_NOT_PROVIDED: counsel has not supplied jurisdiction or sanctions lists');
  // Stage 3 needs market data this milestone does not have; nothing is estimated.
  add('S3.1', 'SKIP', 'NO_ROUTE_SOURCE: own indexer or approved provider not connected');
  add('S3.2', 'SKIP', 'NO_POOL_SOURCE: own indexer or approved provider not connected');
  add('S3.3', 'SKIP', 'NO_VOLUME_SOURCE');
  add('S3.4', 'SKIP', 'PROGRAM_ACCOUNT_EXCLUSION_NOT_IMPLEMENTED: raw largest-account share is reported as a feature only');
  add('S3.5', 'SKIP', 'NO_ORACLE_MAPPING: registry has no Pyth feed ids');
  add('S3.6', 'SKIP', 'SIMULATION_NOT_AUTHORIZED in this milestone');
  add('S3.7', 'SKIP', 'KEEPER_ELIGIBILITY_NOT_ASSESSED: needs the planned migration threshold, which a quote inspection does not have');
  add('S3.8', 'SKIP', 'NO_PRICE_OR_HOLDER_SOURCES: nothing to compare until two price and holder sources are connected');
}
