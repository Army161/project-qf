// The engine launchpad's chain port: every read and send the server, the indexer and the crank make, over plain JSON-RPC
// with Solana Kit (no web3.js). Tests substitute an in-process double. The operator key signs only what the server
// itself builds (graduating a sold-out coin, the devnet faucet); it is never asked to sign anything a user built.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  address, createKeyPairSignerFromBytes, createSolanaRpc, getAddressDecoder, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder,
  getTransactionEncoder, signTransaction, type Instruction, type KeyPairSigner,
} from '@solana/kit';
import * as E from '@project-qf/engine';
import { CAPABILITY_FLAGS, READINESS } from '@project-qf/core';

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
  /** Reads a decision rests on (the engine's settings, whether a coin is ready to graduate): at `finalized`, and with a
   *  second provider configured, both providers must return the same bytes. Falls back to `read` where absent (tests). */
  decisionRead?: E.AccountReader;
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
  /** The mint of every launch on the engine for one quote (a getProgramAccounts search on the curve program). */
  launches(quoteMint: string): Promise<string[]>;
  genesisHash(): Promise<string>;
  /** Operator only: signs and sends a transaction the server built. Throws OPERATOR_KEY_UNAVAILABLE without a key. */
  sendAsOperator(instructions: Instruction[], computeUnits: number): Promise<string>;
}

/** Genesis hashes the engine launchpad knows. A local validator has a fresh genesis each run, so it is accepted only on a
 *  loopback RPC with QF_CLUSTER=localnet said explicitly. */
export const GENESIS = Object.freeze({ devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export type LaunchCluster = 'devnet' | 'localnet' | 'mainnet-beta';

/** Everything that must hold before a server talks to mainnet. The first two live in code (packages/core readiness.ts
 *  and flags.ts) and change only in a reviewed commit with the owner's written go-ahead; the third is the operator
 *  typing QF_CONFIRM_MAINNET=mainnet-beta for this one process. */
export interface MainnetGate { stage: 'ACTIVE' | 'BLOCKED'; mainnetWrites: boolean; confirm: string | undefined; blockers: readonly string[] }
export const mainnetGate = (confirm: string | undefined): MainnetGate =>
  ({ stage: READINESS.MAINNET.status, mainnetWrites: CAPABILITY_FLAGS.MAINNET_WRITES as boolean, confirm, blockers: READINESS.MAINNET.blockers });

function checkRpcUrl(rpcUrl: string) {
  const u = new URL(rpcUrl), loopback = LOOPBACK.has(u.hostname);
  if (u.username || u.password) throw new Error('the RPC URL must not carry credentials');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('the RPC URL must be https (plain http only on this machine)');
  return { host: u.hostname, loopback };
}
/** Proves which network an RPC serves, before anything else talks to it. Mainnet only through an open gate. */
export async function proveCluster(rpcUrl: string, wanted: LaunchCluster, genesisHash: () => Promise<string>, gate: MainnetGate): Promise<LaunchCluster> {
  const { loopback } = checkRpcUrl(rpcUrl);
  if (wanted === 'mainnet-beta') {
    if (gate.stage !== 'ACTIVE') throw new Error(`mainnet is BLOCKED: ${gate.blockers.join('; ')}`);
    if (gate.mainnetWrites !== true) throw new Error('mainnet is BLOCKED: MAINNET_WRITES is false in this build');
    if (gate.confirm !== 'mainnet-beta') throw new Error('mainnet needs QF_CONFIRM_MAINNET=mainnet-beta for this process');
    if (loopback) throw new Error('mainnet needs a real RPC provider, not this machine');
  }
  if (wanted === 'localnet' && !loopback) throw new Error('localnet runs only against a validator on this machine (127.0.0.1)');
  const g = await genesisHash();
  if (wanted === 'mainnet-beta') {
    if (g !== GENESIS['mainnet-beta']) throw new Error(`genesis ${g} is not mainnet-beta`);
    return wanted;
  }
  if (g === GENESIS['mainnet-beta']) throw new Error(`refusing mainnet-beta: QF_CLUSTER=${wanted}`);
  if (wanted === 'devnet' && g !== GENESIS.devnet) throw new Error(`genesis ${g} is not devnet`);
  if (wanted === 'localnet' && g === GENESIS.devnet) throw new Error('QF_CLUSTER=localnet, but this RPC serves devnet');
  return wanted;
}
/** A second, independent provider for decision reads: another host, the same network. */
export async function proveSecondProvider(rpcUrl: string, secondUrl: string, genesis: string, secondGenesis: () => Promise<string>): Promise<void> {
  const a = checkRpcUrl(rpcUrl), b = checkRpcUrl(secondUrl);
  if (a.host === b.host) throw new Error('the second RPC provider must be a different host');
  const g = await secondGenesis();
  if (g !== genesis) throw new Error(`the second RPC provider serves genesis ${g}, not ${genesis}`);
}

const hex = (b: ArrayLike<number>) => Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (e: unknown) => /\b429\b|Too Many Requests|rate limit|fetch failed|ECONNRESET|ETIMEDOUT/i.test((e as Error)?.message ?? '');
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const fromB64 = getBase64Encoder(), fromB58 = getBase58Encoder();

function outsideGit(p: string) {
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) if (existsSync(resolve(d, '.git'))) throw new Error(`refusing a key file inside a git checkout (${d})`);
}
/** The operator's devnet key, read from a file outside any git checkout with mode 0600. Missing file: no operator. */
export async function loadOperator(path: string): Promise<KeyPairSigner | null> {
  const p = resolve(path);
  outsideGit(p);
  if (!existsSync(p)) return null;
  if ((statSync(p).mode & 0o077) !== 0) throw new Error(`key file ${p} must be mode 0600`);
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')) as number[]));
}

/** A fresh machine's throwaway devnet operator key, made when there is none: mode 0600 in a 0700 folder, outside any git
 *  checkout. Only its public address is ever printed. Returns false when a key was already there (it is never replaced). */
export function createOperatorKey(path: string): boolean {
  const p = resolve(path);
  outsideGit(p);
  if (existsSync(p)) return false;
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  writeFileSync(p, JSON.stringify([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')]), { mode: 0o600, flag: 'wx' });
  return true;
}

/** Every call through this RPC retries a busy node (HTTP 429, a dropped connection) with a doubling wait, about 15 seconds
 *  in all, before the error reaches the caller. Free and public endpoints answer 429 under ordinary load. */
export function calmRpc<T extends object>(rpc: T): T {
  return new Proxy(rpc, { get: (target, method) => (...args: unknown[]) => {
    const pending = (target as Record<PropertyKey, (...a: unknown[]) => { send(o?: unknown): Promise<unknown> }>)[method]!(...args);
    return { send: async (o?: unknown) => {
      for (let wait = 500, k = 0; ; k++, wait *= 2) {
        try { return await pending.send(o); } catch (e) { if (!busy(e) || k >= 5) throw e; await sleep(wait); }
      }
    } };
  } });
}

/** The deployment's two programs exist on this network as upgradeable programs. A missing program is a wrong network or
 *  an engine not deployed yet; the server stops instead of building transactions nobody can run. */
export async function checkDeployment(read: E.AccountReader, d: E.EngineDeployment): Promise<void> {
  const accounts = await read([d.curve, d.pool]);
  for (const [k, a] of accounts.entries()) {
    const id = k === 0 ? d.curve : d.pool;
    if (!a) throw new Error(`ENGINE_NOT_DEPLOYED the ${k === 0 ? 'curve' : 'pool'} program ${id} does not exist on ${d.cluster}`);
    if (a.owner !== E.BPF_UPGRADEABLE_LOADER || a.data.length !== 36 || a.data[0] !== 2) throw new Error(`ENGINE_NOT_DEPLOYED ${id} is not an upgradeable program`);
  }
}

/** Reads `addrs` at `commitment` from one provider. */
function reader(rpc: ReturnType<typeof createSolanaRpc>, commitment: 'confirmed' | 'finalized'): E.AccountReader {
  return async (addrs) => {
    const out: (E.RawAccount | null)[] = [];
    for (let k = 0; k < addrs.length; k += 100) {
      const r = await rpc.getMultipleAccounts(addrs.slice(k, k + 100).map((a) => address(a)), { encoding: 'base64', commitment }).send();
      out.push(...r.value.map((a) => (a ? { owner: a.owner as string, lamports: BigInt(a.lamports), data: fromB64.encode(a.data[0]) as Uint8Array } : null)));
    }
    return out;
  };
}
const sameAccount = (a: E.RawAccount | null, b: E.RawAccount | null) =>
  a === null || b === null ? a === b : a.owner === b.owner && a.data.length === b.data.length && a.data.every((x, k) => x === b.data[k]);
/** Finalized reads from two providers that must agree byte for byte (owner and data). Two providers can sit a slot or
 *  two apart, so a disagreement is read again a few times before it counts. */
export function crossCheckedReader(first: E.AccountReader, second: E.AccountReader, wait = (ms: number) => sleep(ms)): E.AccountReader {
  return async (addrs) => {
    for (let k = 0; ; k++) {
      const [a, b] = await Promise.all([first(addrs), second(addrs)]);
      const differ = addrs.filter((_, i) => !sameAccount(a[i]!, b[i]!));
      if (!differ.length) return a;
      if (k >= 3) throw new Error(`RPC_PROVIDERS_DISAGREE on ${differ.join(', ')}`);
      await wait(1_500);
    }
  };
}

export function kitChain(rpcUrl: string, operator: KeyPairSigner | null, log: (m: string) => void = () => {}, opts: { secondRpcUrl?: string; computeUnitPrice?: bigint } = {}): EngineChain {
  const rpc = calmRpc(createSolanaRpc(rpcUrl));
  const commitment = 'confirmed' as const;
  const read = reader(rpc, commitment);
  const decisionRead = opts.secondRpcUrl ? crossCheckedReader(reader(rpc, 'finalized'), reader(calmRpc(createSolanaRpc(opts.secondRpcUrl)), 'finalized')) : reader(rpc, 'finalized');
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
    decisionRead,
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
    async launches(quoteMint) {
      const L = E.LAUNCH_LAYOUT, b58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes) as never;
      const found = await rpc.getProgramAccounts(address(E.QF_CURVE), { encoding: 'base64', commitment, dataSlice: { offset: L.mintOffset, length: 32 },
        filters: [{ memcmp: { offset: 0n, bytes: b58(Uint8Array.from(L.discriminator)), encoding: 'base58' } },
          { memcmp: { offset: BigInt(L.quoteMintOffset), bytes: quoteMint as never, encoding: 'base58' } }] }).send();
      return found.map((a) => getAddressDecoder().decode(fromB64.encode(a.account.data[0])) as string);
    },
    genesisHash: async () => String(await rpc.getGenesisHash().send()),
    async sendAsOperator(instructions, computeUnits) {
      if (!operator) throw new Error('OPERATOR_KEY_UNAVAILABLE');
      const bh = await blockhash();
      const unsigned = E.compileUnsigned({ feePayer: operator.address, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, instructions, computeUnits, computeUnitPrice: opts.computeUnitPrice });
      if (unsigned.signers.length !== 1 || unsigned.signers[0] !== operator.address) throw new Error('OPERATOR_TX_NEEDS_OTHER_SIGNERS');
      const signed = await signTransaction([operator.keyPair], getTransactionDecoder().decode(unsigned.bytes));
      return send(new Uint8Array(getTransactionEncoder().encode(signed)), bh.lastValidBlockHeight);
    },
  };
}
