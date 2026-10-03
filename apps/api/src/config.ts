// Server-side provider configuration (decision D2, 2026-10-03). Reads only these environment variables:
//   QF_RPC_MAINNET / QF_RPC_DEVNET  comma-separated https RPC URLs without userinfo (defaults: Solana's public endpoints)
//   QF_HELIUS_API_KEY               optional; adds Helius standard RPC on mainnet and devnet as an independent provider
// The key is used to build the endpoint URL and nothing else: describeEndpoints() is what may be printed or stored.
import { endpointFromUrl, heliusEndpoint, type LiveCluster, type RpcEndpoint } from './rpc.ts';

export type QfEnv = Partial<Record<'QF_RPC_MAINNET' | 'QF_RPC_DEVNET' | 'QF_HELIUS_API_KEY', string>>;
const DEFAULTS: Readonly<Record<LiveCluster, string>> = Object.freeze({ 'mainnet-beta': 'https://api.mainnet.solana.com', devnet: 'https://api.devnet.solana.com' });

export function endpointsFromEnv(env: QfEnv): Record<LiveCluster, RpcEndpoint[]> {
  const list = (v: string | undefined, c: LiveCluster) => (v ?? DEFAULTS[c]).split(',').map((s) => s.trim()).filter(Boolean).map((u) => endpointFromUrl(u, c));
  const out: Record<LiveCluster, RpcEndpoint[]> = { 'mainnet-beta': list(env.QF_RPC_MAINNET, 'mainnet-beta'), devnet: list(env.QF_RPC_DEVNET, 'devnet') };
  const key = env.QF_HELIUS_API_KEY?.trim();
  if (key) for (const c of ['mainnet-beta', 'devnet'] as const) out[c].push(heliusEndpoint(c, key));
  return out;
}

/** Safe description for logs and evidence: host, operator and routing preference only. */
export function describeEndpoints(eps: Record<LiveCluster, RpcEndpoint[]>) {
  const d = (e: RpcEndpoint) => ({ id: e.id, operator: e.operator, prefer: [...e.prefer], authenticated: e.redact.length > 0 });
  return { 'mainnet-beta': eps['mainnet-beta'].map(d), devnet: eps.devnet.map(d) };
}
