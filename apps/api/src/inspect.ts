// Runs one inspection: reads the mint from every configured provider for the requested cluster (or from the TEST_ONLY
// fixtures when, and only when, 'test-only' was requested), applies the current inspection and features versions, and
// returns a report bound to digests of its evidence and of itself. Largest accounts are routed by method (decision D2):
// endpoints that prefer getTokenLargestAccounts are asked first, then the others, one attempt each, only among
// providers that proved the cluster and returned the mint; every failed attempt stays in the report.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@project-qf/core';
import { API_VERSION, type InspectionReport, type InspectionRequest, type ProviderRead } from '@project-qf/contracts';
import { computeFeatures, FEATURES_VERSION, type LargestAccounts } from '@project-qf/features';
import { EVIDENCE_POLICY_V0_1, INSPECTION_VERSION, VALIDATOR_POLICY_V0_1, inspectMint, type MintObservation } from '@project-qf/validator';
import { FIXTURE_PROVIDERS, FIXTURE_SLOT, fixtureAccount, fixtureLargest } from './fixtures.ts';
import { getAccountInfo, getTokenLargestAccounts, RpcUnavailable, verifyGenesis, type FetchLike, type LiveCluster, type RpcEndpoint } from './rpc.ts';

export interface InspectDeps {
  endpoints: Record<LiveCluster, RpcEndpoint[]>;
  fetchImpl: FetchLike;
  now: () => Date;
}
export interface InspectionOutcome { report: Omit<InspectionReport, 'id'>; evidence: unknown }

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const reason = (e: unknown) => (e instanceof RpcUnavailable ? e.message : 'INTERNAL_READ_ERROR');
/** Upper bound on getTokenLargestAccounts attempts per inspection (no retries of the same provider). */
export const MAX_LARGEST_ATTEMPTS = 3;
const FIXTURE_OPERATOR = 'qf-test-fixture';

export async function runInspection(req: InspectionRequest, deps: InspectDeps): Promise<InspectionOutcome> {
  const observedAt = () => deps.now().toISOString();
  const observations: MintObservation[] = [];
  const reads: ProviderRead[] = [];
  let largest: LargestAccounts | null = null;
  const live = req.cluster !== 'test-only';

  if (!live) {
    for (const provider of FIXTURE_PROVIDERS) {
      const acct = fixtureAccount(provider, req.mint);
      const at = observedAt();
      observations.push({ provider, operator: FIXTURE_OPERATOR, providerClass: 'TEST_ONLY', cluster: 'mock-offline', observedAt: at, slot: FIXTURE_SLOT,
        status: acct ? 'OK' : 'NOT_FOUND', ...(acct ? { owner: acct.owner, dataBase64: acct.dataBase64, contentHash: sha256Hex(acct.dataBase64) } : {}) });
      reads.push({ provider, operator: FIXTURE_OPERATOR, providerClass: 'TEST_ONLY', method: 'getAccountInfo', status: acct ? 'OK' : 'NOT_FOUND', reason: null, slot: FIXTURE_SLOT, observedAt: at, genesisVerified: null });
    }
    if (observations[0]!.status === 'OK') largest = { provider: FIXTURE_PROVIDERS[0], status: 'OK', accounts: fixtureLargest(req.mint) };
  } else {
    const cluster = req.cluster as LiveCluster;
    const eps = deps.endpoints[cluster];
    const results = await Promise.all(eps.map(async (ep) => {
      let genesisVerified: boolean | null = false;
      try {
        await verifyGenesis(ep, deps.fetchImpl);
        genesisVerified = true;
        const a = await getAccountInfo(ep, req.mint, deps.fetchImpl);
        return { ep, genesisVerified, at: observedAt(), slot: a.slot, value: a.value, error: null as string | null };
      } catch (e) {
        return { ep, genesisVerified, at: observedAt(), slot: null, value: null, error: reason(e) };
      }
    }));
    for (const r of results) {
      const status = r.error ? 'UNAVAILABLE' : r.value ? 'OK' : 'NOT_FOUND';
      observations.push({ provider: r.ep.id, operator: r.ep.operator, providerClass: 'PRODUCTION', cluster, observedAt: r.at, slot: r.slot, status,
        ...(r.error ? { reason: r.error } : {}),
        ...(r.value ? { owner: r.value.owner, dataBase64: r.value.dataBase64, contentHash: sha256Hex(r.value.dataBase64) } : {}) });
      reads.push({ provider: r.ep.id, operator: r.ep.operator, providerClass: 'PRODUCTION', method: 'getAccountInfo', status, reason: r.error, slot: r.slot, observedAt: r.at, genesisVerified: r.genesisVerified });
    }
    if (eps.length === 0) reads.push({ provider: 'none', operator: 'none', providerClass: 'PRODUCTION', method: 'getAccountInfo', status: 'UNAVAILABLE', reason: `NO_PROVIDER_CONFIGURED for ${cluster}`, slot: null, observedAt: observedAt(), genesisVerified: null });
    // Largest accounts only from providers that proved the cluster and returned the mint: preferred ones first (stable
    // order otherwise), one bounded attempt each, stopping at the first valid answer. Failures are kept, not hidden.
    const candidates = results.filter((r) => !r.error && r.value);
    const ordered = [...candidates.filter((r) => r.ep.prefer.includes('getTokenLargestAccounts')), ...candidates.filter((r) => !r.ep.prefer.includes('getTokenLargestAccounts'))]
      .slice(0, MAX_LARGEST_ATTEMPTS);
    const failures: string[] = [];
    for (const src of ordered) {
      try {
        const l = await getTokenLargestAccounts(src.ep, req.mint, deps.fetchImpl);
        largest = { provider: src.ep.id, status: 'OK', accounts: l.accounts };
        reads.push({ provider: src.ep.id, operator: src.ep.operator, providerClass: 'PRODUCTION', method: 'getTokenLargestAccounts', status: 'OK', reason: null, slot: l.slot, observedAt: observedAt(), genesisVerified: true });
        break;
      } catch (e) {
        failures.push(`${src.ep.id}: ${reason(e)}`);
        reads.push({ provider: src.ep.id, operator: src.ep.operator, providerClass: 'PRODUCTION', method: 'getTokenLargestAccounts', status: 'UNAVAILABLE', reason: reason(e), slot: null, observedAt: observedAt(), genesisVerified: true });
      }
    }
    if (!largest && ordered.length) largest = { provider: ordered.map((r) => r.ep.id).join(', '), status: 'UNAVAILABLE', reason: failures.join('; '), accounts: [] };
  }

  const inspection = inspectMint({ mint: req.mint, cluster: live ? (req.cluster as LiveCluster) : 'mock-offline', mode: live ? 'LIVE' : 'TEST_ONLY',
    observations, policy: VALIDATOR_POLICY_V0_1 });
  const firstOk = observations.find((o) => o.status === 'OK');
  const nativeUntracked = inspection.checks.some((c) => c.id === 'S1.10' && c.decision === 'NOT_APPLICABLE');
  const features = computeFeatures({ facts: inspection.facts, factsSource: firstOk?.provider ?? null, largest,
    supplySemantics: nativeUntracked ? 'NATIVE_MINT_NOT_TRACKED' : 'TRACKED' });
  const evidence = { observations, largest };
  const body: Omit<InspectionReport, 'id' | 'reportDigest'> = {
    apiVersion: API_VERSION, createdAt: observedAt(), mint: req.mint, cluster: req.cluster,
    label: live ? 'LIVE_READ' : 'TEST_ONLY_FIXTURE', inspection, features, reads,
    policies: { validator: VALIDATOR_POLICY_V0_1.id, evidence: EVIDENCE_POLICY_V0_1.id, inspection: INSPECTION_VERSION, features: FEATURES_VERSION },
    evidenceDigest: sha256Hex(canonicalJson(evidence)),
  };
  return { report: { ...body, reportDigest: sha256Hex(canonicalJson(body)) }, evidence };
}

/** Recomputes a stored report's digest; a mismatch means the stored record was altered. */
export function reportDigestOf(r: Omit<InspectionReport, 'id' | 'reportDigest'> & Partial<Pick<InspectionReport, 'id' | 'reportDigest'>>): string {
  const { id: _id, reportDigest: _d, ...body } = r;
  return sha256Hex(canonicalJson(body));
}
