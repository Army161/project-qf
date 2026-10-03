// Provider capability probe (decision D2 acceptance evidence): for every configured endpoint, prove the cluster by genesis
// hash and try getAccountInfo and getTokenLargestAccounts on a few known mints, once each, read-only. The output is
// sanitized by construction: endpoint ids are hosts, reasons pass through the client's redaction, and URLs are never included.
import { getAccountInfo, getTokenLargestAccounts, RpcUnavailable, verifyGenesis, type FetchLike, type LiveCluster, type RpcEndpoint } from './rpc.ts';

export const PROBE_MINTS: Readonly<Record<LiveCluster, readonly string[]>> = Object.freeze({
  'mainnet-beta': ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112'],
  devnet: ['4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'So11111111111111111111111111111111111111112'],
});

export interface ProbeRow { cluster: LiveCluster; provider: string; operator: string; authenticated: boolean; method: string; mint: string | null;
  status: 'OK' | 'UNAVAILABLE'; reason: string | null; slot: string | null; ms: number; detail: string | null }

export async function probeProviders(eps: Record<LiveCluster, RpcEndpoint[]>, fetchImpl: FetchLike, clock: () => number = () => Date.now()): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  for (const cluster of ['mainnet-beta', 'devnet'] as const) {
    for (const ep of eps[cluster]) {
      const base = { cluster, provider: ep.id, operator: ep.operator, authenticated: ep.redact.length > 0 };
      const run = async (method: string, mint: string | null, f: () => Promise<{ slot: string | null; detail: string | null }>) => {
        const t = clock();
        try { const r = await f(); rows.push({ ...base, method, mint, status: 'OK', reason: null, slot: r.slot, ms: clock() - t, detail: r.detail }); return true; }
        catch (e) { rows.push({ ...base, method, mint, status: 'UNAVAILABLE', reason: e instanceof RpcUnavailable ? e.message : 'INTERNAL_ERROR', slot: null, ms: clock() - t, detail: null }); return false; }
      };
      if (!(await run('getGenesisHash', null, async () => { await verifyGenesis(ep, fetchImpl); return { slot: null, detail: `genesis matches ${cluster}` }; }))) continue;
      for (const mint of PROBE_MINTS[cluster]) {
        await run('getAccountInfo', mint, async () => { const a = await getAccountInfo(ep, mint, fetchImpl); return { slot: a.slot, detail: a.value ? `owner ${a.value.owner}` : 'not found' }; });
        await run('getTokenLargestAccounts', mint, async () => { const l = await getTokenLargestAccounts(ep, mint, fetchImpl); return { slot: l.slot, detail: `${l.accounts.length} token accounts` }; });
      }
    }
  }
  return rows;
}
