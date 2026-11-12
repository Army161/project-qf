// An in-process stand-in for the engine launchpad's chain (TEST_ONLY). Accounts are synthetic, encoded with the engine's
// own IDL so the real decoders read them; "sent" transactions go to a recorder; what a transaction did is whatever
// TxRecord a test puts in `txs`. No network, no real keys: every key is generated for the test.
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { address, getAddressDecoder, getAddressEncoder, type Instruction } from '@solana/kit';
import * as E from '@project-qf/engine';
import type { EngineChain, TxRecord } from '../../src/chain.ts';
import type { QuoteAsset } from '../../src/market.ts';
import { createEngineApp, type EngineProfile } from '../../src/server.ts';
import { EngineStore } from '../../src/store.ts';

// The harness runs the devnet deployment, as the default web build does, so the page's own checks agree with the server.
E.useDeployment(E.deploymentFor('devnet'));
export const engineDir = mkdtempSync(join(tmpdir(), 'qf-engine-test-'));
after(() => rmSync(engineDir, { recursive: true, force: true }));
export const SOL: QuoteAsset = { mint: E.NATIVE_MINT, decimals: 9, symbol: 'SOL', label: 'TEST_ONLY SOL' };
export const BLOCKHASH = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W';
/** Synthetic keys for accounts nobody signs for (TEST_ONLY). */
export const ADDR = {
  admin: 'Vote111111111111111111111111111111111111111', treasury: 'Stake11111111111111111111111111111111111111',
  ammConfig: 'SysvarRent111111111111111111111111111111111', operator: 'Config1111111111111111111111111111111111111',
};
export const CFG = E.LAUNCH_PRESETS.devnetSmall;

const enc = getAddressEncoder();
const idlAccount = (idl: E.EngineIdl, name: string, values: Record<string, unknown>) =>
  Uint8Array.from([...idl.accounts[name]!, ...E.encodeFields(values, idl.types[name]!.fields!, idl.types)]);
export function tokenAccountData(mint: string, owner: string, amount: bigint) {
  const b = new Uint8Array(165);
  b.set(enc.encode(address(mint)), 0); b.set(enc.encode(address(owner)), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true); b[108] = 1;
  return b;
}
export function mintData(supply: bigint, decimals: number) {
  const b = new Uint8Array(82);
  new DataView(b.buffer).setBigUint64(36, supply, true); b[44] = decimals; b[45] = 1;
  return b;
}
const cfgFields = (c: E.LaunchConfig) => ({ total_supply: c.totalSupply, curve_supply: c.curveSupply, virtual_quote: c.virtualQuote, virtual_base: c.virtualBase,
  trade_fee_bps: Number(c.tradeFeeBps), creator_fee_share_bps: Number(c.creatorFeeShareBps), graduation_fee: c.graduationFee });

export type FakeChain = EngineChain & {
  accounts: Map<string, E.RawAccount>;
  /** wire bytes relayed by send(), and the instructions the operator signed */
  sent: Uint8Array[]; operatorSent: Instruction[][];
  /** what tx(signature) returns; a signature missing here is "not served yet" */
  txs: Map<string, TxRecord>;
  /** signatures(address) answers from here, oldest first */
  history: Map<string, { signature: string; slot: number; err: boolean }[]>;
  lamportsOf: Map<string, bigint>;
  clock: bigint;
  /** the signature the next send() or sendAsOperator() returns */
  nextSig: string[];
  failSend: string | null;
};

export function fakeChain(operator: string | null = ADDR.operator): FakeChain {
  let n = 0;
  const sig = () => f.nextSig.shift() ?? `${'5'.repeat(20)}${(++n).toString().padStart(4, '1')}${'1'.repeat(64)}`.slice(0, 88);
  const f: FakeChain = {
    accounts: new Map(), sent: [], operatorSent: [], txs: new Map(), history: new Map(), lamportsOf: new Map(), clock: 1_760_000_000n, nextSig: [], failSend: null,
    operatorAddress: operator,
    read: async (addrs) => addrs.map((a) => f.accounts.get(a) ?? null),
    blockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n }),
    now: async () => f.clock,
    send: async (signed) => { if (f.failSend) throw new Error(f.failSend); f.sent.push(signed); return sig(); },
    tx: async (s) => f.txs.get(s) ?? null,
    signatures: async (a, until) => {
      const all = f.history.get(a) ?? [];
      const k = until ? all.findIndex((x) => x.signature === until) : -1;
      return all.slice(k + 1);
    },
    balances: async (owner, mints) => {
      const tokens: Record<string, string> = {};
      for (const m of mints) {
        const acc = f.accounts.get(await E.ata(owner, m, m === E.NATIVE_MINT ? E.TOKEN : E.TOKEN_2022));
        tokens[m] = acc ? E.decodeTokenAccount(acc).amount.toString() : '0';
      }
      return { lamports: (f.lamportsOf.get(owner) ?? 0n).toString(), tokens };
    },
    lamports: async (owner) => f.lamportsOf.get(owner) ?? 0n,
    // the same search the real port makes: curve-owned accounts with the Launch discriminator and this quote mint
    launches: async (quoteMint) => {
      const L = E.LAUNCH_LAYOUT, q = Array.from(getAddressEncoder().encode(address(quoteMint)));
      return [...f.accounts.values()].filter((a) => a.owner === E.QF_CURVE && L.discriminator.every((b, k) => a.data[k] === b)
        && q.every((b, k) => a.data[L.quoteMintOffset + k] === b)).map((a) => getAddressDecoder().decode(a.data.subarray(L.mintOffset, L.mintOffset + 32)) as string);
    },
    genesisHash: async () => 'TEST_ONLY',
    sendAsOperator: async (ixs) => { if (!operator) throw new Error('OPERATOR_KEY_UNAVAILABLE'); f.operatorSent.push(ixs); return sig(); },
  };
  return f;
}

/** The engine's settings on this fake network: Global for SOL, and the pool config coins graduate into. */
export async function putPlatform(f: FakeChain, p: { createPaused?: boolean; buyPaused?: boolean; config?: E.LaunchConfig } = {}) {
  f.accounts.set(await E.globalAddress(E.NATIVE_MINT), { owner: E.QF_CURVE, lamports: 1n, data: idlAccount(E.CURVE_IDL, 'Global', {
    admin: ADDR.admin, fee_recipient: ADDR.treasury, quote_mint: E.NATIVE_MINT, amm_config: ADDR.ammConfig, create_paused: p.createPaused ?? false, config: cfgFields(p.config ?? CFG), bump: 255,
    buy_paused: p.buyPaused ?? false, pending_admin: E.SYSTEM }) });
  const pp = E.POOL_PRESET;
  f.accounts.set(ADDR.ammConfig, { owner: E.QF_POOL, lamports: 1n, data: idlAccount(E.POOL_IDL, 'AmmConfig', {
    bump: 254, disable_create_pool: false, index: pp.index, trade_fee_rate: pp.tradeFeeRate, protocol_fee_rate: pp.protocolFeeRate, fund_fee_rate: pp.fundFeeRate,
    create_pool_fee: pp.createPoolFee, protocol_owner: ADDR.admin, fund_owner: ADDR.admin, creator_fee_rate: pp.creatorFeeRate, creator_fee_share_rate: 0n, padding: Array(14).fill(0n) }) });
}

export interface CurveState { status?: E.LaunchStatus; realQuote?: bigint; baseSold?: bigint; platformFees?: bigint; creatorFees?: bigint; pool?: string; completedAt?: bigint;
  /** vault balances; by default exactly what the curve's numbers say */
  quoteVault?: bigint; baseVault?: bigint }
/** A coin's launch account and its two vaults. */
export async function putCurve(f: FakeChain, mint: string, creator: string, s: CurveState = {}) {
  const a = await E.launchAccounts(mint, E.NATIVE_MINT);
  const st = { status: 'Trading' as E.LaunchStatus, realQuote: 0n, baseSold: 0n, platformFees: 0n, creatorFees: 0n, pool: E.SYSTEM, ...s };
  f.accounts.set(a.launch, { owner: E.QF_CURVE, lamports: 1n, data: idlAccount(E.CURVE_IDL, 'Launch', {
    mint, creator, quote_mint: E.NATIVE_MINT, amm_config: ADDR.ammConfig, config: cfgFields(CFG), status: st.status, real_quote: st.realQuote, base_sold: st.baseSold,
    platform_fees: st.platformFees, creator_fees: st.creatorFees, pool: st.pool, created_at: 1_760_000_000n, bump: 254, signer_bump: 253,
    completed_at: st.completedAt ?? (st.status === 'Trading' ? 0n : 1_760_000_100n) }) });
  const graduated = st.status === 'Graduated';
  f.accounts.set(a.quoteVault, { owner: E.TOKEN, lamports: 1n, data: tokenAccountData(E.NATIVE_MINT, a.launchSigner, s.quoteVault ?? st.realQuote + st.platformFees + st.creatorFees) });
  f.accounts.set(a.baseVault, { owner: E.TOKEN_2022, lamports: 1n, data: tokenAccountData(mint, a.launchSigner,
    s.baseVault ?? CFG.totalSupply - st.baseSold - (graduated ? E.poolSupply(CFG) : 0n)) });
  return a;
}

export interface PoolSetup { quoteReserve: bigint; baseReserve: bigint; creatorFeesQuote?: bigint; lpMintSupply?: bigint; openTime?: bigint }
/** A graduated coin's pool: state, vaults and LP mint at the addresses the engine derives. */
export async function putPool(f: FakeChain, mint: string, creator: string, p: PoolSetup) {
  const pool = await E.launchPoolAddress(mint);
  const d = await E.poolAccounts(pool, mint, E.NATIVE_MINT);
  const quoteIs0 = d.token0 === E.NATIVE_MINT, cf = p.creatorFeesQuote ?? 0n;
  f.accounts.set(pool, { owner: E.QF_POOL, lamports: 1n, data: idlAccount(E.POOL_IDL, 'PoolState', {
    amm_config: ADDR.ammConfig, pool_creator: creator, token_0_vault: d.vault0, token_1_vault: d.vault1, lp_mint: d.lpMint, token_0_mint: d.token0, token_1_mint: d.token1,
    token_0_program: quoteIs0 ? E.TOKEN : E.TOKEN_2022, token_1_program: quoteIs0 ? E.TOKEN_2022 : E.TOKEN, observation_key: d.observation, auth_bump: 255, status: 0,
    lp_mint_decimals: 9, mint_0_decimals: quoteIs0 ? 9 : 6, mint_1_decimals: quoteIs0 ? 6 : 9, lp_supply: 1_000_000n, protocol_fees_token_0: 0n, protocol_fees_token_1: 0n,
    fund_fees_token_0: 0n, fund_fees_token_1: 0n, open_time: p.openTime ?? 0n, recent_epoch: 0n, creator_fee_on: quoteIs0 ? 1 : 2, enable_creator_fee: true, padding1: Array(6).fill(0),
    creator_fees_token_0: quoteIs0 ? cf : 0n, creator_fees_token_1: quoteIs0 ? 0n : cf, padding: Array(28).fill(0n) }) });
  const authority = await E.poolAuthorityAddress();
  f.accounts.set(d.vault0, { owner: quoteIs0 ? E.TOKEN : E.TOKEN_2022, lamports: 1n, data: tokenAccountData(d.token0, authority, quoteIs0 ? p.quoteReserve + cf : p.baseReserve) });
  f.accounts.set(d.vault1, { owner: quoteIs0 ? E.TOKEN_2022 : E.TOKEN, lamports: 1n, data: tokenAccountData(d.token1, authority, quoteIs0 ? p.baseReserve : p.quoteReserve + cf) });
  f.accounts.set(d.lpMint, { owner: E.TOKEN, lamports: 1n, data: mintData(p.lpMintSupply ?? 0n, 9) });
  return { ...d, quoteVault: quoteIs0 ? d.vault0 : d.vault1 };
}

/** A transaction record as the RPC would describe it (only what the indexer reads). */
export function txRecord(signature: string, events: E.EngineEvent[], extra: Partial<TxRecord> = {}): TxRecord {
  return { signature, slot: 100, blockTime: 1_760_000_100, err: false, feePayer: ADDR.admin, instructions: [], events, logsTruncated: false, tokenChanges: [], ...extra };
}

export const DEVNET: EngineProfile = { cluster: 'devnet', writes: true, faucet: true, label: 'TEST_ONLY', writesLockedBecause: [] };
export async function engineHarness(o: { chain?: FakeChain; profile?: EngineProfile; now?: () => Date; staticDir?: string; log?: (m: string) => void } = {}) {
  const chain = o.chain ?? fakeChain();
  const store = new EngineStore(join(engineDir, `e-${Math.random().toString(36).slice(2)}.sqlite`));
  const app = createEngineApp({ store, chain, quote: SOL, profile: o.profile ?? DEVNET, staticDir: o.staticDir ?? null, publicBaseUrl: 'http://127.0.0.1:8788',
    ...(o.now ? { now: o.now } : {}), ...(o.log ? { log: o.log } : {}) });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  after(async () => { app.close(); await store.close(); });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  return { chain, store, app, call };
}

/** A live coin in the store with its curve on the fake chain (TEST_ONLY). */
export async function seedEngineCoin(h: { chain: FakeChain; store: EngineStore }, creator: string, mint: string, symbol: string, s: CurveState = {}) {
  (await h.store.insertPendingCoin({ mint, quoteMint: E.NATIVE_MINT, creator, name: `${symbol} coin`, symbol, description: 'TEST_ONLY', website: null, twitter: null, telegram: null,
    imageType: null, metadataUri: `http://127.0.0.1:8788/m/${mint}.json`, createdAt: '2026-10-11T00:00:00.000Z' }, null));
  (await h.store.markLive(mint, null, '2026-10-11T00:00:01.000Z'));
  await putCurve(h.chain, mint, creator, s);
}
