// The engine launchpad's chain port: every read and send the server, the indexer and the crank make, over plain JSON-RPC
// with Solana Kit (no web3.js). Tests substitute an in-process double. The operator key signs only what the server
// itself builds (graduating a sold-out coin, the devnet faucet); it is never asked to sign anything a user built.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  address, createKeyPairSignerFromBytes, createSolanaRpc, getBase58Encoder, getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder,
  getTransactionEncoder, signTransaction, type Instruction, type KeyPairSigner,
} from '@solana/kit';
import * as E from '@project-qf/engine';

export interface TxRecord {
  signature: string; slot: number; blockTime: number | null; err: boolean; feePayer: string;
  /** the transaction's own (top-level) instructions */
  instructions: { programAddress: string; dataHex: string }[];
  /** the engine's events, attributed to the program that wrote them */
  events: E.EngineEvent[];
  /** the node cut the log short: events after the cut are missing */
  logsTruncated: boolean;
  /** every token account whose balance the transaction changed */
  tokenChanges: { account: string; mint: string; owner: string | null; preRaw: bigint; postRaw: bigint }[];
}
export interface Balances { lamports: string; tokens: Record<string, string> }

export interface EngineChain {
  operatorAddress: string | null;
  /** Account reads at `confirmed`, for the engine package's decoders. */
  read: E.AccountReader;
  blockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  /** The chain's clock (the Clock sysvar's unix time): a pool opens by this clock, not the server's. */
  now(): Promise<bigint>;
  /** Sends signed wire bytes and waits for `confirmed`; throws if it failed or its blockhash expired. */
  send(signed: Uint8Array, lastValidBlockHeight: bigint): Promise<string>;
  tx(signature: string): Promise<TxRecord | null>;
  /** Signatures that touched `address` after `until`, oldest first. */
  signatures(address: string, until: string | null): Promise<{ signature: string; slot: number; err: boolean }[]>;
  /** Spendable SOL, and each mint's balance in the owner's associated token account (either token program). */
  balances(owner: string, mints: string[]): Promise<Balances>;
  lamports(owner: string): Promise<bigint>;
  genesisHash(): Promise<string>;
  /** Operator only: signs and sends a transaction the server built. Throws OPERATOR_KEY_UNAVAILABLE without a key. */
  sendAsOperator(instructions: Instruction[], computeUnits: number): Promise<string>;
}

/** Genesis hashes the engine launchpad knows. A local validator has a fresh genesis each run, so it is accepted only on a
 *  loopback RPC with QF_CLUSTER=localnet said explicitly. */
export const GENESIS = Object.freeze({ devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Proves which network an RPC serves, before anything else talks to it. Mainnet is refused (MAINNET_WRITES=false). */
export async function proveCluster(rpcUrl: string, wanted: 'devnet' | 'localnet', genesisHash: () => Promise<string>, mainnetWrites: boolean): Promise<'devnet' | 'localnet'> {
  if (mainnetWrites !== false) throw new Error('MAINNET_WRITES must stay false in this build');
  const u = new URL(rpcUrl), loopback = LOOPBACK.has(u.hostname);
  if (u.username || u.password) throw new Error('the RPC URL must not carry credentials');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('the RPC URL must be https (plain http only on this machine)');
  if (wanted === 'localnet' && !loopback) throw new Error('localnet runs only against a validator on this machine (127.0.0.1)');
  const g = await genesisHash();
  if (g === GENESIS['mainnet-beta']) throw new Error('refusing mainnet-beta: the engine launchpad runs on devnet or a local validator only');
  if (wanted === 'devnet' && g !== GENESIS.devnet) throw new Error(`genesis ${g} is not devnet`);
  if (wanted === 'localnet' && g === GENESIS.devnet) throw new Error('QF_CLUSTER=localnet, but this RPC serves devnet');
  return wanted;
}

const hex = (b: ArrayLike<number>) => Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (e: unknown) => /\b429\b|Too Many Requests|rate limit|fetch failed|ECONNRESET|ETIMEDOUT/i.test((e as Error)?.message ?? '');
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const fromB64 = getBase64Encoder(), fromB58 = getBase58Encoder();

/** The operator's devnet key, read from a file outside any git checkout with mode 0600. Missing file: no operator. */
export async function loadOperator(path: string): Promise<KeyPairSigner | null> {
  const p = resolve(path);
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) if (existsSync(resolve(d, '.git'))) throw new Error(`refusing to read a key inside a git checkout (${d})`);
  if (!existsSync(p)) return null;
  if ((statSync(p).mode & 0o077) !== 0) throw new Error(`key file ${p} must be mode 0600`);
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')) as number[]));
}

export function kitChain(rpcUrl: string, operator: KeyPairSigner | null, log: (m: string) => void = () => {}): EngineChain {
  const rpc = createSolanaRpc(rpcUrl);
  const commitment = 'confirmed' as const;
  const read: E.AccountReader = async (addrs) => {
    const out: (E.RawAccount | null)[] = [];
    for (let k = 0; k < addrs.length; k += 100) {
      const r = await rpc.getMultipleAccounts(addrs.slice(k, k + 100).map((a) => address(a)), { encoding: 'base64', commitment }).send();
      out.push(...r.value.map((a) => (a ? { owner: a.owner as string, lamports: BigInt(a.lamports), data: fromB64.encode(a.data[0]) as Uint8Array } : null)));
    }
    return out;
  };
  const blockhash = async () => { const { value } = await rpc.getLatestBlockhash({ commitment }).send(); return { blockhash: value.blockhash as string, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }; };
  async function send(signed: Uint8Array, lastValidBlockHeight: bigint): Promise<string> {
    const wire = getBase64EncodedWireTransaction(getTransactionDecoder().decode(signed));
    const signature = await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: commitment, maxRetries: 3n }).send();
    let wait = 500;
    for (let i = 0; ; i++) {
      try {
        const { value: [s] } = await rpc.getSignatureStatuses([signature]).send();
        if (s?.err) throw new Error(`TRANSACTION_FAILED ${JSON.stringify(s.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return signature;
        if (i % 4 === 3 && (await rpc.getBlockHeight({ commitment }).send()) > lastValidBlockHeight) {
          throw new Error('TRANSACTION_EXPIRED: the blockhash expired before the transaction confirmed; nothing was charged, try again');
        }
        wait = 500;
      } catch (e) {
        if (!busy(e)) throw e;
        wait = Math.min(wait * 2, 8_000);
      }
      await sleep(wait);
    }
  }
  return {
    operatorAddress: operator?.address ?? null,
    read,
    blockhash,
    async now() {
      const [c] = await read([CLOCK]);
      if (!c || c.data.length < 40) throw new Error('CLOCK_UNAVAILABLE');
      return new DataView(c.data.buffer, c.data.byteOffset).getBigInt64(32, true);
    },
    send,
    async tx(signature) {
      const t = await rpc.getTransaction(signature as never, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment }).send();
      if (!t || !t.meta) return null;
      const m = t.transaction.message;
      const loaded = t.meta.loadedAddresses ?? { writable: [], readonly: [] };
      const keys = [...m.accountKeys, ...loaded.writable, ...loaded.readonly].map(String);
      const logs = (t.meta.logMessages ?? []) as string[];
      const parsed = E.parseEngineEvents(logs);
      const bal = new Map<number, { mint: string; owner: string | null; pre: bigint; post: bigint }>();
      for (const b of t.meta.preTokenBalances ?? []) bal.set(b.accountIndex, { mint: b.mint, owner: b.owner ?? null, pre: BigInt(b.uiTokenAmount.amount), post: 0n });
      for (const b of t.meta.postTokenBalances ?? []) {
        const x = bal.get(b.accountIndex) ?? { mint: b.mint, owner: b.owner ?? null, pre: 0n, post: 0n };
        bal.set(b.accountIndex, { ...x, owner: x.owner ?? b.owner ?? null, post: BigInt(b.uiTokenAmount.amount) });
      }
      return {
        signature, slot: Number(t.slot), blockTime: t.blockTime === null ? null : Number(t.blockTime), err: t.meta.err !== null, feePayer: keys[0]!,
        instructions: m.instructions.map((ix) => ({ programAddress: keys[ix.programIdIndex]!, dataHex: hex(fromB58.encode(ix.data)) })),
        events: parsed.events, logsTruncated: parsed.truncated,
        tokenChanges: [...bal.entries()].filter(([, x]) => x.pre !== x.post).map(([k, x]) => ({ account: keys[k]!, mint: x.mint, owner: x.owner, preRaw: x.pre, postRaw: x.post })),
      };
    },
    async signatures(addr, until) {
      const out: { signature: string; slot: number; err: boolean }[] = [];
      const pageSize = 1000, maxPages = 10;
      let before: string | undefined;
      for (let page = 0; ; page++) {
        const list = await rpc.getSignaturesForAddress(address(addr), { limit: pageSize, commitment, ...(until ? { until: until as never } : {}), ...(before ? { before: before as never } : {}) }).send();
        out.push(...list.map((s) => ({ signature: s.signature as string, slot: Number(s.slot), err: s.err !== null })));
        if (list.length < pageSize) break;
        if (page + 1 >= maxPages) { log(`signature list for ${addr} stopped at ${maxPages * pageSize} transactions; older ones in that window are not indexed (IDX-1)`); break; }
        before = list.at(-1)!.signature;
      }
      return out.reverse();
    },
    async balances(owner, mints) {
      const lamports = (await rpc.getBalance(address(owner), { commitment }).send()).value;
      const atas = await Promise.all(mints.flatMap((m) => [E.ata(owner, m, E.TOKEN), E.ata(owner, m, E.TOKEN_2022)]));
      const accounts = await read(atas);
      const tokens: Record<string, string> = {};
      mints.forEach((m, k) => {
        let sum = 0n;
        for (const a of [accounts[2 * k], accounts[2 * k + 1]]) {
          if (!a) continue;
          try { const t = E.decodeTokenAccount(a); if (t.mint === m && t.owner === owner) sum += t.amount; } catch { /* not a token account */ }
        }
        tokens[m] = sum.toString();
      });
      return { lamports: lamports.toString(), tokens };
    },
    lamports: async (owner) => BigInt((await rpc.getBalance(address(owner), { commitment }).send()).value),
    genesisHash: async () => String(await rpc.getGenesisHash().send()),
    async sendAsOperator(instructions, computeUnits) {
      if (!operator) throw new Error('OPERATOR_KEY_UNAVAILABLE');
      const bh = await blockhash();
      const unsigned = E.compileUnsigned({ feePayer: operator.address, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, instructions, computeUnits });
      if (unsigned.signers.length !== 1 || unsigned.signers[0] !== operator.address) throw new Error('OPERATOR_TX_NEEDS_OTHER_SIGNERS');
      const signed = await signTransaction([operator.keyPair], getTransactionDecoder().decode(unsigned.bytes));
      return send(new Uint8Array(getTransactionEncoder().encode(signed)), bh.lastValidBlockHeight);
    },
  };
}
