// Read-only Solana JSON-RPC client for the inspector. Only three methods exist here (getGenesisHash, getAccountInfo,
// getTokenLargestAccounts); there is no send/simulate path. Every response is size- and time-bounded while streaming,
// the cluster is proven by genesis hash (never by hostname), and failures become a short sanitized reason string that
// the report shows as UNAVAILABLE. Nothing falls back to fixtures.
// Credentials (decision D2, 2026-10-03): an endpoint may carry an API key in its URL (Helius uses a query parameter). The
// key stays in `url` only: the id is the host, every reason string is scrubbed of the endpoint's secret parts, redirects
// are refused so a key is never replayed to another location, and nothing here logs.
export const GENESIS = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
} as const);
export type LiveCluster = keyof typeof GENESIS;

export const RPC_LIMITS = Object.freeze({ genesisBytes: 4 * 1024, accountBytes: 64 * 1024, largestBytes: 64 * 1024, timeoutMs: 15_000 });

export type RpcMethod = 'getGenesisHash' | 'getAccountInfo' | 'getTokenLargestAccounts';
export interface RpcEndpoint {
  id: string;                        // host only; safe to show and store
  url: string;                       // may hold a credential: never logged, stored or returned
  cluster: LiveCluster;
  operator: string;                  // who runs it; endpoints of one operator are not independent providers
  prefer: readonly RpcMethod[];      // methods this endpoint is asked first for (method-aware routing)
  redact: readonly string[];         // secret substrings of `url`, scrubbed from every message
}
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Declared operators of known hosts. Anything else is its own operator, named by its registrable-looking domain.
const KNOWN_OPERATORS: Readonly<Record<string, string>> = Object.freeze({
  'api.mainnet.solana.com': 'solana-public', 'api.mainnet-beta.solana.com': 'solana-public', 'api.devnet.solana.com': 'solana-public',
  'mainnet.helius-rpc.com': 'helius', 'devnet.helius-rpc.com': 'helius',
});
const operatorOf = (host: string) => KNOWN_OPERATORS[host] ?? host.split(':')[0]!.split('.').slice(-2).join('.');

/**
 * Endpoint from an operator-configured URL: https only (http for localhost), no userinfo, id = host only. Path segments and
 * query values may be keys, so they are registered for redaction (tested with fake keys) and never appear in the id.
 */
export function endpointFromUrl(raw: string, cluster: LiveCluster): RpcEndpoint {
  const u = new URL(raw);
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error(`RPC URL must be https: ${u.host}`);
  if (u.username || u.password) throw new Error(`RPC URL must not carry credentials: ${u.host}`);
  const redact = [...u.pathname.split('/'), ...[...u.searchParams.values()]].map((x) => decodeURIComponent(x)).filter((x) => x.length >= 6);
  return { id: u.host, url: u.toString(), cluster, operator: operatorOf(u.host), prefer: [], redact };
}

const HELIUS_HOSTS: Readonly<Record<LiveCluster, string>> = Object.freeze({ 'mainnet-beta': 'mainnet.helius-rpc.com', devnet: 'devnet.helius-rpc.com' });
/**
 * Helius standard RPC (provider B, decision D2). The key comes from the server environment only. It is preferred for
 * getTokenLargestAccounts; for mint state it is one of two independent observations next to the public endpoint.
 */
export function heliusEndpoint(cluster: LiveCluster, apiKey: string): RpcEndpoint {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(apiKey)) throw new Error('QF_HELIUS_API_KEY is malformed (expected 16-128 letters, digits, - or _)');
  const host = HELIUS_HOSTS[cluster];
  return { id: host, url: `https://${host}/?api-key=${apiKey}`, cluster, operator: 'helius', prefer: ['getTokenLargestAccounts'], redact: [apiKey] };
}

export class RpcUnavailable extends Error {}

async function readBounded(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) { await res.body?.cancel().catch(() => {}); throw new RpcUnavailable(`RESPONSE_TOO_LARGE declared ${declared}`); }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new RpcUnavailable(`RESPONSE_TOO_LARGE over ${maxBytes} bytes`); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', onAbort); }
  return Buffer.concat(chunks, total).toString('utf8');
}

function causeMessages(e: unknown): string[] {
  const out: string[] = [];
  for (let x = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i++) out.push(x instanceof Error ? x.message : String(x));
  return out;
}
const sanitize = (s: string) => s.replace(/[^\x20-\x7e]/g, ' ').replace(/https?:\/\/\S+/g, '<url>').slice(0, 120);
/** Removes the endpoint's secret parts first (before any truncation could split one), then generic URL and key patterns. */
function scrub(ep: RpcEndpoint, s: string): string {
  let out = s;
  for (const k of ep.redact) if (k) out = out.split(k).join('<redacted>');
  return sanitize(out.replace(/(api[-_]?key|token|key)=[^\s&]+/gi, '$1=<redacted>'));
}

export async function rpcCall(ep: RpcEndpoint, method: string, params: unknown[], maxBytes: number, fetchImpl: FetchLike, timeoutMs: number = RPC_LIMITS.timeoutMs): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new RpcUnavailable(`TIMEOUT after ${timeoutMs} ms`)), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(ep.url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    } catch (e) {
      if (ac.signal.aborted) throw ac.signal.reason;
      // Through an egress proxy, a refused host surfaces as a failed CONNECT deep in the cause chain, not as an HTTP status.
      const chain = causeMessages(e);
      const tunnel = chain.map((m) => /Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/.exec(m)).find((m) => m !== null);
      if (tunnel) throw new RpcUnavailable(tunnel[1] === '403' ? 'NETWORK_POLICY_DENIED (egress proxy refused the tunnel: HTTP 403)' : `PROXY_TUNNEL_FAILED (HTTP ${tunnel[1]})`);
      throw new RpcUnavailable(`NETWORK_ERROR ${scrub(ep, chain[chain.length - 1] ?? 'unknown')}`);
    }
    const text = await readBounded(res, maxBytes, ac.signal);
    if (res.status === 403 && /not in allowlist/i.test(text)) throw new RpcUnavailable('NETWORK_POLICY_DENIED (HTTP 403 Host not in allowlist)');
    if (res.status === 429) throw new RpcUnavailable('RATE_LIMITED (HTTP 429)');
    if (!res.ok) throw new RpcUnavailable(`HTTP_${res.status}`);
    let j: { result?: unknown; error?: { code?: unknown } };
    try { j = JSON.parse(text); } catch { throw new RpcUnavailable('BAD_JSON'); }
    if (j && typeof j === 'object' && j.error) throw new RpcUnavailable(`RPC_ERROR ${scrub(ep, String(j.error.code))}`);
    if (!j || typeof j !== 'object' || !('result' in j)) throw new RpcUnavailable('BAD_RPC_ENVELOPE');
    return j.result;
  } catch (e) {
    if (e instanceof RpcUnavailable) throw e;
    if (ac.signal.aborted && ac.signal.reason instanceof RpcUnavailable) throw ac.signal.reason;
    throw new RpcUnavailable(`ERROR ${scrub(ep, String((e as Error)?.message ?? e))}`);
  } finally { clearTimeout(timer); }
}

const verifiedGenesis = new Map<string, string>();
/** Proves the endpoint serves the requested cluster. A successful match is cached per endpoint URL for the process. */
export async function verifyGenesis(ep: RpcEndpoint, fetchImpl: FetchLike): Promise<void> {
  const cacheKey = `${ep.cluster}|${ep.url}`;
  if (verifiedGenesis.get(cacheKey) === GENESIS[ep.cluster]) return;
  const g = await rpcCall(ep, 'getGenesisHash', [], RPC_LIMITS.genesisBytes, fetchImpl);
  if (g !== GENESIS[ep.cluster]) throw new RpcUnavailable(`WRONG_NETWORK: genesis ${String(g).slice(0, 44)} is not ${ep.cluster}`);
  verifiedGenesis.set(cacheKey, GENESIS[ep.cluster]);
}
export function clearGenesisCache() { verifiedGenesis.clear(); }

const isSlot = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

export interface AccountRead { slot: string; value: null | { owner: string; dataBase64: string } }
export async function getAccountInfo(ep: RpcEndpoint, address: string, fetchImpl: FetchLike): Promise<AccountRead> {
  const r = await rpcCall(ep, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }], RPC_LIMITS.accountBytes, fetchImpl) as
    { context?: { slot?: unknown }; value?: unknown };
  if (!r || typeof r !== 'object' || !isSlot(r.context?.slot)) throw new RpcUnavailable('BAD_RESULT getAccountInfo');
  if (r.value === null) return { slot: String(r.context!.slot), value: null };
  const v = r.value as { owner?: unknown; data?: unknown };
  if (!v || typeof v.owner !== 'string' || !Array.isArray(v.data) || v.data[1] !== 'base64' || typeof v.data[0] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data[0])) {
    throw new RpcUnavailable('BAD_RESULT getAccountInfo value');
  }
  return { slot: String(r.context!.slot), value: { owner: v.owner, dataBase64: v.data[0] } };
}

export interface LargestRead { slot: string; accounts: { address: string; amountRaw: string }[] }
export async function getTokenLargestAccounts(ep: RpcEndpoint, mint: string, fetchImpl: FetchLike): Promise<LargestRead> {
  const r = await rpcCall(ep, 'getTokenLargestAccounts', [mint, { commitment: 'finalized' }], RPC_LIMITS.largestBytes, fetchImpl) as
    { context?: { slot?: unknown }; value?: unknown };
  if (!r || typeof r !== 'object' || !isSlot(r.context?.slot) || !Array.isArray(r.value)) throw new RpcUnavailable('BAD_RESULT getTokenLargestAccounts');
  const accounts = r.value.slice(0, 20).map((a: { address?: unknown; amount?: unknown }) => {
    if (typeof a?.address !== 'string' || typeof a.amount !== 'string' || !/^(0|[1-9]\d*)$/.test(a.amount)) throw new RpcUnavailable('BAD_RESULT largest account entry');
    return { address: a.address, amountRaw: a.amount };
  });
  return { slot: String(r.context!.slot), accounts };
}
