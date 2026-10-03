// Runs one inspection: reads the mint from every configured provider for the requested cluster (or from the TEST_ONLY
// fixtures when, and only when, 'test-only' was requested), applies inspection-v0.1 and features-v0.1, and returns a
// report bound to digests of its evidence and of itself.
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
      observations.push({ provider, providerClass: 'TEST_ONLY', cluster: 'mock-offline', observedAt: at, slot: FIXTURE_SLOT,
        status: acct ? 'OK' : 'NOT_FOUND', ...(acct ? { owner: acct.owner, dataBase64: acct.dataBase64, contentHash: sha256Hex(acct.dataBase64) } : {}) });
      reads.push({ provider, providerClass: 'TEST_ONLY', method: 'getAccountInfo', status: acct ? 'OK' : 'NOT_FOUND', reason: null, slot: FIXTURE_SLOT, observedAt: at, genesisVerified: null });
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
      observations.push({ provider: r.ep.id, providerClass: 'PRODUCTION', cluster, observedAt: r.at, slot: r.slot, status,
        ...(r.error ? { reason: r.error } : {}),
        ...(r.value ? { owner: r.value.owner, dataBase64: r.value.dataBase64, contentHash: sha256Hex(r.value.dataBase64) } : {}) });
      reads.push({ provider: r.ep.id, providerClass: 'PRODUCTION', method: 'getAccountInfo', status, reason: r.error, slot: r.slot, observedAt: r.at, genesisVerified: r.genesisVerified });
    }
    if (eps.length === 0) reads.push({ provider: 'none', providerClass: 'PRODUCTION', method: 'getAccountInfo', status: 'UNAVAILABLE', reason: `NO_PROVIDER_CONFIGURED for ${cluster}`, slot: null, observedAt: observedAt(), genesisVerified: null });
    // Largest accounts only from a provider that proved the cluster and returned the mint.
    const src = results.find((r) => !r.error && r.value);
    if (src) {
      try {
        const l = await getTokenLargestAccounts(src.ep, req.mint, deps.fetchImpl);
        largest = { provider: src.ep.id, status: 'OK', accounts: l.accounts };
        reads.push({ provider: src.ep.id, providerClass: 'PRODUCTION', method: 'getTokenLargestAccounts', status: 'OK', reason: null, slot: l.slot, observedAt: observedAt(), genesisVerified: true });
      } catch (e) {
        largest = { provider: src.ep.id, status: 'UNAVAILABLE', reason: reason(e), accounts: [] };
        reads.push({ provider: src.ep.id, providerClass: 'PRODUCTION', method: 'getTokenLargestAccounts', status: 'UNAVAILABLE', reason: reason(e), slot: null, observedAt: observedAt(), genesisVerified: true });
      }
    }
  }

  const inspection = inspectMint({ mint: req.mint, cluster: live ? (req.cluster as LiveCluster) : 'mock-offline', mode: live ? 'LIVE' : 'TEST_ONLY',
    observations, policy: VALIDATOR_POLICY_V0_1 });
  const firstOk = observations.find((o) => o.status === 'OK');
  const features = computeFeatures({ facts: inspection.facts, factsSource: firstOk?.provider ?? null, largest });
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
