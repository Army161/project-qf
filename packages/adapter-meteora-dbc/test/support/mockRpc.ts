// MOCK RPC: a fixture-backed JSON-RPC responder for @solana/web3.js Connection (via its `fetch` option).
// It serves ONLY synthetic accounts built in this test file. Nothing here is live chain data, no
// network request is made, and no transaction can be sent (sendTransaction is not implemented).
import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export const MOCK_RPC_LABEL = 'MOCK_RPC_FIXTURE: synthetic accounts, not live results';
export interface MockAccount { owner: PublicKey; data: Buffer; lamports?: number; executable?: boolean }

/** Deterministic synthetic public key from a label (no private key exists for it). */
export const mockKey = (label: string) => new PublicKey(createHash('sha256').update(`QF-MOCK:${label}`).digest());

export function createMockConnection(accounts: Map<string, MockAccount>, opts: { unixTimestamp?: number; slot?: number } = {}) {
  const calls: string[] = [];
  const unsupported: string[] = [];
  const info = (pk: string) => {
    const a = accounts.get(pk);
    return a ? { data: [a.data.toString('base64'), 'base64'], executable: a.executable ?? false, lamports: a.lamports ?? 10_000_000,
      owner: a.owner.toBase58(), rentEpoch: 0, space: a.data.length } : null;
  };
  const ctx = { slot: opts.slot ?? 1000 };
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((r: { id: unknown; method: string; params: unknown[] }) => {
      calls.push(r.method);
      switch (r.method) {
        case 'getAccountInfo': return { jsonrpc: '2.0', id: r.id, result: { context: ctx, value: info(String(r.params[0])) } };
        case 'getMultipleAccounts': return { jsonrpc: '2.0', id: r.id, result: { context: ctx, value: (r.params[0] as string[]).map(info) } };
        case 'getSlot': return { jsonrpc: '2.0', id: r.id, result: ctx.slot };
        case 'getBlockTime': return { jsonrpc: '2.0', id: r.id, result: opts.unixTimestamp ?? 1_790_000_000 };
        case 'getMinimumBalanceForRentExemption': return { jsonrpc: '2.0', id: r.id, result: 2_039_280 };
        default:
          unsupported.push(r.method);
          return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `MOCK RPC: method ${r.method} not implemented` } };
      }
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const connection = new Connection('http://mock-rpc.invalid', { commitment: 'confirmed', fetch: fetch as never, disableRetryOnRateLimit: true });
  return { connection, calls, unsupported };
}

type IdlType = string | { defined?: { name: string }; array?: [IdlType, number]; option?: IdlType; vec?: IdlType };
interface Idl { types: { name: string; type: { kind: 'struct' | 'enum'; fields?: { name: string; type: IdlType }[]; variants?: { name: string }[] } }[] }

/** Zero value for an Anchor IDL type (BN for >=64-bit ints, PublicKey.default for pubkeys). */
export function zeroOf(idl: Idl, t: IdlType): unknown {
  if (typeof t === 'string') {
    if (t === 'pubkey') return PublicKey.default;
    if (t === 'bool') return false;
    if (/^[ui](8|16|32)$/.test(t)) return 0;
    if (/^[ui](64|128|256)$/.test(t)) return new BN(0);
    throw new Error(`zeroOf: unsupported primitive ${t}`);
  }
  if (t.array) return Array.from({ length: t.array[1] }, () => zeroOf(idl, t.array![0]));
  if (t.option !== undefined) return null;
  if (t.vec !== undefined) return [];
  if (t.defined) {
    const def = idl.types.find((x) => x.name === t.defined!.name);
    if (!def) throw new Error(`zeroOf: unknown type ${t.defined.name}`);
    if (def.type.kind === 'struct') return Object.fromEntries((def.type.fields ?? []).map((f) => [f.name, zeroOf(idl, f.type)]));
    return { [def.type.variants![0]!.name]: {} };
  }
  throw new Error(`zeroOf: unsupported type ${JSON.stringify(t)}`);
}
