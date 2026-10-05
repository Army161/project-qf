// SERVER-ONLY launchpad chain client (devnet). Builds unsigned DBC transactions for users, reads pool state, and runs
// the operator-side steps (test quote mint, platform config, migration crank) with a disposable devnet keypair.
//
// Cluster safety (DEV-2): every Connection is proven to be devnet by genesis hash before use, the mainnet genesis is
// refused outright, and MAINNET_WRITES=false is re-checked here. User transactions are never signed by the server;
// only operator-role transactions (config, test quote, faucet, migration crank) are signed with the local devnet key.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import BN from 'bn.js';
import {
  DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDbcTokenVaultAddress, swapQuoteExactIn, type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, derivePositionAddress, derivePositionNftAccount, getCurrentPoint, getUnClaimLpFee, swapQuoteExactInput } from '@meteora-ag/cp-amm-sdk';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  type Commitment,
} from '@solana/web3.js';
import { CAPABILITY_FLAGS } from '@project-qf/core';
import { PROGRAM_IDS, TX_BINDING_POLICY_VERSION, type ApprovedTerms } from '@project-qf/tx';
import { DAMM_V2_CUSTOMIZABLE_CONFIG, createBoundedFetch } from './index.ts';

export const GENESIS = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});
export const LAUNCHPAD_CLUSTER = 'devnet' as const;
const TOKEN = new PublicKey(PROGRAM_IDS.TOKEN);
const ATA_PROGRAM = new PublicKey(PROGRAM_IDS.ASSOCIATED_TOKEN);
const COMMITMENT: Commitment = 'confirmed';

/** Default compute caps written into terms. The SDK adds no ComputeBudget instructions, so these are upper bounds only. */
export const COMPUTE_CAPS = Object.freeze({ maxUnitLimit: 400_000, maxUnitPriceMicroLamports: '0' });

// ------------------------------------------------------------------ cluster safety

export class ClusterSafetyError extends Error {}

/** Opens a bounded Connection and proves by genesis hash that it is devnet. Mainnet is refused (MAINNET_WRITES=false). */
export async function connectDevnet(url: string, fetchImpl?: typeof fetch): Promise<Connection> {
  if ((CAPABILITY_FLAGS.MAINNET_WRITES as boolean) !== false) throw new ClusterSafetyError('MAINNET_WRITES must stay false in this build');
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new ClusterSafetyError('RPC URL must be https');
  if (u.username || u.password) throw new ClusterSafetyError('RPC URL must not carry credentials');
  const conn = new Connection(url, { commitment: COMMITMENT, fetch: createBoundedFetch(fetchImpl ? { fetchImpl } : {}) as never, disableRetryOnRateLimit: true });
  const g = await conn.getGenesisHash();
  if (g === GENESIS['mainnet-beta']) throw new ClusterSafetyError('refusing mainnet-beta: launchpad writes are devnet-only (MAINNET_WRITES=false)');
  if (g !== GENESIS.devnet) throw new ClusterSafetyError(`genesis ${g} is not devnet`);
  return conn;
}

// ------------------------------------------------------------------ disposable operator key (DEV-2)

/**
 * Loads or creates a disposable devnet keypair at `path`. The file must live outside any git checkout, is written with
 * mode 0600 and is never printed. Only its public key is ever returned to callers that log.
 */
export function loadOrCreateDevnetKeypair(path: string): Keypair {
  const p = resolve(path);
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) {
    if (existsSync(resolve(d, '.git'))) throw new ClusterSafetyError(`refusing to keep a key inside a git checkout (${d})`);
  }
  if (existsSync(p)) {
    if ((statSync(p).mode & 0o077) !== 0) throw new ClusterSafetyError(`key file ${p} must be mode 0600`);
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')) as number[]));
  }
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const kp = Keypair.generate();
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

// ------------------------------------------------------------------ SPL helpers (hand-built: no extra dependency)

export function ataAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}
const ixCreateAtaIdempotent = (payer: PublicKey, owner: PublicKey, mint: PublicKey) => new TransactionInstruction({
  programId: ATA_PROGRAM, data: Buffer.from([1]),
  keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ataAddress(owner, mint), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }],
});
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
/** InitializeMint2 (20): decimals, mint authority, no freeze authority. */
const ixInitMint2 = (mint: PublicKey, decimals: number, authority: PublicKey) => new TransactionInstruction({
  programId: TOKEN, keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
  data: Buffer.concat([Buffer.from([20, decimals]), authority.toBuffer(), Buffer.from([0])]),
});
const ixMintTo = (mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: TOKEN, data: Buffer.concat([Buffer.from([7]), u64le(amount)]),
  keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }],
});
/** SetAuthority (6) MintTokens -> None: the supply becomes fixed. */
const ixRevokeMintAuthority = (mint: PublicKey, authority: PublicKey) => new TransactionInstruction({
  programId: TOKEN, data: Buffer.from([6, 0, 0]),
  keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }],
});
const ixTransfer = (src: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: TOKEN, data: Buffer.concat([Buffer.from([3]), u64le(amount)]),
  keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
});

export interface TestQuoteMint { mint: string; decimals: number; supplyRaw: string; signature: string; label: 'TEST_ONLY' }

/**
 * DEVNET.md step 2: creates the TEST_ONLY quote token qUSD (6 dp, no freeze authority), mints the whole supply to the
 * operator's treasury account and revokes the mint authority in the same transaction.
 */
export async function createTestQuoteMint(conn: Connection, operator: Keypair, supplyUi = 1_000_000_000n, decimals = 6): Promise<TestQuoteMint> {
  const mint = Keypair.generate();
  const supplyRaw = supplyUi * 10n ** BigInt(decimals);
  const rent = await conn.getMinimumBalanceForRentExemption(82);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: 82, programId: TOKEN }),
    ixInitMint2(mint.publicKey, decimals, operator.publicKey),
    ixCreateAtaIdempotent(operator.publicKey, operator.publicKey, mint.publicKey),
    ixMintTo(mint.publicKey, ataAddress(operator.publicKey, mint.publicKey), operator.publicKey, supplyRaw),
    ixRevokeMintAuthority(mint.publicKey, operator.publicKey),
  );
  const signature = await operatorSend(conn, tx, [operator, mint]);
  return { mint: mint.publicKey.toBase58(), decimals, supplyRaw: supplyRaw.toString(), signature, label: 'TEST_ONLY' };
}

/** Devnet faucet: transfers TEST_ONLY quote tokens (and optionally devnet SOL) from the operator treasury to `to`. */
export async function sendFromTreasury(conn: Connection, operator: Keypair, quoteMintAddress: string, toAddress: string, quoteRaw: bigint, lamports = 0n): Promise<string> {
  const quoteMint = new PublicKey(quoteMintAddress), to = new PublicKey(toAddress);
  const tx = new Transaction();
  if (lamports > 0n) tx.add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: to, lamports }));
  if (quoteRaw > 0n) tx.add(ixCreateAtaIdempotent(operator.publicKey, to, quoteMint),
    ixTransfer(ataAddress(operator.publicKey, quoteMint), ataAddress(to, quoteMint), operator.publicKey, quoteRaw));
  return operatorSend(conn, tx, [operator]);
}

// ------------------------------------------------------------------ platform config (operator)

export interface PlatformConfig { config: string; quoteMint: string; feeClaimer: string; leftoverReceiver: string; signature: string }

/** Creates the DBC config once per (quote mint, economics, template). The operator is fee claimer and leftover receiver on devnet. */
export async function createPlatformConfig(conn: Connection, operator: Keypair, quoteMintAddress: string, params: ConfigParameters): Promise<PlatformConfig> {
  const quoteMint = new PublicKey(quoteMintAddress);
  const config = Keypair.generate();
  const client = new DynamicBondingCurveClient(conn, COMMITMENT);
  const tx = await client.partner.createConfig({ ...(params as object), config: config.publicKey, feeClaimer: operator.publicKey,
    leftoverReceiver: operator.publicKey, quoteMint, payer: operator.publicKey } as never);
  const signature = await operatorSend(conn, tx, [operator, config]);
  return { config: config.publicKey.toBase58(), quoteMint: quoteMint.toBase58(), feeClaimer: operator.publicKey.toBase58(),
    leftoverReceiver: operator.publicKey.toBase58(), signature };
}

// ------------------------------------------------------------------ user transactions (unsigned)

export interface BuiltTx { bytes: Uint8Array; terms: ApprovedTerms; blockhash: string; lastValidBlockHeight: number }

const common = (feePayer: string) => ({ cluster: LAUNCHPAD_CLUSTER, policyVersion: TX_BINDING_POLICY_VERSION, feePayer, compute: { ...COMPUTE_CAPS } });

async function finish(conn: Connection, tx: Transaction, feePayer: PublicKey): Promise<{ bytes: Uint8Array; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(COMMITMENT);
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  return { bytes: new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), blockhash, lastValidBlockHeight };
}

export interface CreatePoolRequest { config: string; quoteMint: string; creator: string; baseMint: string; name: string; symbol: string; uri: string }
/** Unsigned createPool (initializeVirtualPoolWithSplToken). Signers: creator (fee payer) and the client-generated base mint. */
export async function buildCreatePool(conn: Connection, r: CreatePoolRequest): Promise<BuiltTx & { pool: string }> {
  const client = new DynamicBondingCurveClient(conn, COMMITMENT);
  const creator = new PublicKey(r.creator), baseMint = new PublicKey(r.baseMint), config = new PublicKey(r.config);
  const tx = await client.creator.createPool({ name: r.name, symbol: r.symbol, uri: r.uri, payer: creator, poolCreator: creator, config, baseMint });
  const pool = deriveDbcPoolAddress(new PublicKey(r.quoteMint), baseMint, config).toBase58();
  const terms: ApprovedTerms = { ...common(r.creator), kind: 'CREATE_POOL', config: r.config, creator: r.creator, payer: r.creator,
    baseMint: r.baseMint, quoteMint: r.quoteMint, quoteTokenProgram: PROGRAM_IDS.TOKEN, name: r.name, symbol: r.symbol, uri: r.uri };
  return { ...(await finish(conn, tx, creator)), terms, pool };
}

export type Direction = 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE';
export interface SwapRequest { pool: string; user: string; direction: Direction; amountIn: bigint; slippageBps: number }
export interface SwapQuote { amountIn: string; expectedOut: string; minimumAmountOut: string; tradingFee: string; protocolFee: string; nextSqrtPrice: string; priceImpactBps: string }

/** Pure quote against a live pool + config (SDK swapQuoteExactIn), with the slippage floor QF writes into the terms. */
export function quoteSwap(pool: LivePool, direction: Direction, amountIn: bigint, slippageBps: number, nowSeconds: number): SwapQuote {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new Error('slippageBps must be an integer in 0..5000');
  const sell = direction === 'BASE_TO_QUOTE';
  const q = swapQuoteExactIn(pool.raw.virtualPool as never, pool.raw.config as never, sell, new BN(amountIn.toString()), 0, false, new BN(nowSeconds), false);
  const out = BigInt(q.outputAmount.toString());
  const min = (out * BigInt(10_000 - slippageBps)) / 10_000n;
  // Price impact = how much worse than the current spot price this trade fills, excluding the fee (shown separately).
  // Fees are charged in the quote token: on the input of a buy, on the output of a sell.
  const s = (pool.raw.virtualPool as any).poolState ?? pool.raw.virtualPool;
  const p2 = BigInt(s.sqrtPrice.toString()) ** 2n, fees = BigInt(q.tradingFee.toString()) + BigInt(q.protocolFee.toString());
  const netIn = sell ? amountIn : amountIn - fees, grossOut = sell ? out + fees : out;
  const spotOut = p2 === 0n || netIn <= 0n ? 0n : sell ? (netIn * p2) / Q128 : (netIn * Q128) / p2;
  const impact = spotOut === 0n || grossOut >= spotOut ? 0n : ((spotOut - grossOut) * 10_000n) / spotOut;
  const after = BigInt(q.nextSqrtPrice.toString());
  return { amountIn: amountIn.toString(), expectedOut: out.toString(), minimumAmountOut: min.toString(), tradingFee: q.tradingFee.toString(),
    protocolFee: q.protocolFee.toString(), nextSqrtPrice: after.toString(), priceImpactBps: impact.toString() };
}

/** Unsigned DBC swap (exact in). The minimum out is bound into the terms the browser verifies before signing. */
export async function buildSwap(conn: Connection, pool: LivePool, r: SwapRequest, nowSeconds: number): Promise<BuiltTx & { quote: SwapQuote }> {
  if (pool.isMigrated || pool.curveComplete) throw new Error('POOL_COMPLETE: the bonding curve is complete; trade on the migrated DAMM v2 pool');
  const quote = quoteSwap(pool, r.direction, r.amountIn, r.slippageBps, nowSeconds);
  if (BigInt(quote.expectedOut) === 0n) throw new Error('ZERO_OUTPUT: amount too small for this pool');
  const client = new DynamicBondingCurveClient(conn, COMMITMENT);
  const user = new PublicKey(r.user);
  const tx = await client.pool.swap({ owner: user, pool: new PublicKey(r.pool), amountIn: new BN(r.amountIn.toString()),
    minimumAmountOut: new BN(quote.minimumAmountOut), swapBaseForQuote: r.direction === 'BASE_TO_QUOTE', referralTokenAccount: null });
  const terms: ApprovedTerms = { ...common(r.user), kind: 'SWAP', config: pool.config, pool: r.pool, user: r.user, baseMint: pool.baseMint,
    quoteMint: pool.quoteMint, baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN, direction: r.direction,
    amountIn: r.amountIn.toString(), minimumAmountOut: quote.minimumAmountOut, referralTokenAccount: null, allowSysvarInstructions: false };
  return { ...(await finish(conn, tx, user)), terms, quote };
}

// ------------------------------------------------------------------ pool reads

export interface LivePool {
  pool: string; config: string; creator: string; baseMint: string; quoteMint: string; baseVault: string; quoteVault: string;
  sqrtPrice: string; quoteReserve: string; baseReserve: string; migrationQuoteThreshold: string; totalSupplyRaw: string;
  baseDecimals: number; quoteDecimals: number; migrationProgress: number; isMigrated: boolean; curveComplete: boolean;
  /** quote raw per 1 base UI unit, 18-decimal fixed point string */
  priceQuotePerBase: string; marketCapQuoteRaw: string; progressBps: number; creatorQuoteFee: string; creatorBaseFee: string; partnerQuoteFee: string;
  /** the curve's starting price (config sqrtStartPrice), same fixed point as priceQuotePerBase: a stable "since launch" reference */
  launchPriceQuotePerBase: string;
  raw: { virtualPool: unknown; config: unknown };
}

const Q128 = 1n << 128n;
const big = (x: { toString(): string } | number) => BigInt(x.toString());

export function summarisePool(pool: string, vp: any, cfg: any): LivePool {
  const s = vp.poolState ?? vp;
  const sqrt = big(s.sqrtPrice), quoteReserve = big(s.quoteReserve), threshold = big(cfg.migrationQuoteThreshold);
  const baseDecimals = Number(cfg.tokenDecimal), quoteDecimals = Number(cfg.quoteTokenDecimal ?? 6);
  // total supply after an SPL launch with Immutable authority is fixed: pre-migration supply + post-migration supply
  // (a BN of zero is truthy, so compare the value: the program stores 0 when the config has no fixed supply)
  const fixedSupply = cfg.preMigrationTokenSupply === undefined ? 0n : big(cfg.preMigrationTokenSupply);
  const totalSupplyRaw = fixedSupply > 0n ? fixedSupply : big(cfg.swapBaseAmount ?? 0) + big(cfg.migrationBaseThreshold ?? 0);
  const priceFp = (sqrt * sqrt * 10n ** BigInt(baseDecimals) * 10n ** 18n) / Q128; // quote raw per base UI, x1e18
  const sqrtStart = big(cfg.sqrtStartPrice ?? 0);
  const launchFp = (sqrtStart * sqrtStart * 10n ** BigInt(baseDecimals) * 10n ** 18n) / Q128;
  const mcapRaw = (sqrt * sqrt * totalSupplyRaw) / Q128;                           // quote raw
  const progressBps = threshold === 0n ? 0 : Number(quoteReserve >= threshold ? 10_000n : (quoteReserve * 10_000n) / threshold);
  return {
    pool, config: s.config.toBase58(), creator: s.creator.toBase58(), baseMint: s.baseMint.toBase58(), quoteMint: cfg.quoteMint.toBase58(),
    baseVault: s.baseVault.toBase58(), quoteVault: s.quoteVault.toBase58(), sqrtPrice: sqrt.toString(), quoteReserve: quoteReserve.toString(),
    baseReserve: big(s.baseReserve).toString(), migrationQuoteThreshold: threshold.toString(), totalSupplyRaw: totalSupplyRaw.toString(),
    baseDecimals, quoteDecimals, migrationProgress: Number(s.migrationProgress), isMigrated: Number(s.isMigrated) === 1,
    curveComplete: quoteReserve >= threshold, priceQuotePerBase: priceFp.toString(), marketCapQuoteRaw: mcapRaw.toString(), progressBps,
    creatorQuoteFee: big(s.creatorQuoteFee).toString(), creatorBaseFee: big(s.creatorBaseFee ?? 0).toString(), partnerQuoteFee: big(s.partnerQuoteFee).toString(), launchPriceQuotePerBase: launchFp.toString(), raw: { virtualPool: vp, config: cfg },
  };
}

export async function readPool(conn: Connection, pool: string): Promise<LivePool | null> {
  const client = new DynamicBondingCurveClient(conn, COMMITMENT);
  // Diagnostics for the intermittent "Invalid account discriminator" seen on the public devnet RPC: say what came back.
  const explain = async (what: string, addr: PublicKey | string, e: Error) => {
    if (!/discriminator/i.test(e.message)) return e;
    const a = await conn.getAccountInfo(new PublicKey(addr), COMMITMENT).catch(() => null);
    return new Error(`${e.message} (${what} ${addr.toString()}: re-read owner=${a?.owner.toBase58() ?? 'none'} len=${a?.data.length ?? 0} head=${a ? Buffer.from(a.data.subarray(0, 8)).toString('hex') : '-'})`);
  };
  const vp = await client.state.getPool(pool).catch(async (e: Error) => { throw await explain('pool', pool, e); });
  if (!vp) return null;
  const s = (vp as any).poolState ?? vp;
  const cfg = await client.state.getPoolConfig(s.config).catch(async (e: Error) => { throw await explain('config', s.config, e); });
  if (!cfg) return null;
  return summarisePool(pool, vp, cfg);
}

export const poolAddressFor = (config: string, baseMint: string, quoteMint: string) =>
  deriveDbcPoolAddress(new PublicKey(quoteMint), new PublicKey(baseMint), new PublicKey(config)).toBase58();
export const vaultsFor = (pool: string, baseMint: string, quoteMint: string) => ({
  baseVault: deriveDbcTokenVaultAddress(new PublicKey(pool), new PublicKey(baseMint)).toBase58(),
  quoteVault: deriveDbcTokenVaultAddress(new PublicKey(pool), new PublicKey(quoteMint)).toBase58(),
});

// ------------------------------------------------------------------ migration crank (operator, permissionless on-chain)

/** Builds the DAMM v2 migration for a completed curve; returns it with the two ephemeral position-NFT signers. */
export async function buildMigration(conn: Connection, payer: PublicKey, pool: string) {
  const client = new DynamicBondingCurveClient(conn, COMMITMENT);
  const r = await client.migration.migrateToDammV2({ payer, pool: new PublicKey(pool), dammConfig: DAMM_V2_CUSTOMIZABLE_CONFIG });
  return { tx: r.transaction, signers: [r.firstPositionNftKeypair, r.secondPositionNftKeypair] };
}

export async function runMigration(conn: Connection, operator: Keypair, pool: string): Promise<string> {
  const { tx, signers } = await buildMigration(conn, operator.publicKey, pool);
  return operatorSend(conn, tx, [operator, ...signers]);
}

// ------------------------------------------------------------------ after graduation: the DAMM v2 pool

/** A graduated launch's DAMM v2 pool. Token A is the launched (base) token and token B the quote token; anything else is refused. */
export interface LiveDammPool {
  pool: string; baseMint: string; quoteMint: string; baseVault: string; quoteVault: string; sqrtPrice: string; liquidity: string;
  permanentLockLiquidity: string; activationType: number;
  /** quote raw per 1 base UI unit, 18-decimal fixed point string (same convention as LivePool) */
  priceQuotePerBase: string;
  raw: { poolState: unknown };
}

export async function readDammPool(conn: Connection, pool: string, expected: { baseMint: string; quoteMint: string }, baseDecimals = 6): Promise<LiveDammPool | null> {
  const ps: any = await new CpAmm(conn).fetchPoolState(new PublicKey(pool)).catch((e: Error) => { if (/not found|does not exist|Account does not exist/i.test(e.message)) return null; throw e; });
  if (!ps) return null;
  const a = ps.tokenAMint.toBase58(), b = ps.tokenBMint.toBase58();
  if (a !== expected.baseMint || b !== expected.quoteMint) throw new Error(`DAMM_POOL_MISMATCH pool ${pool} holds ${a}/${b}`);
  const sqrt = big(ps.sqrtPrice);
  return { pool, baseMint: a, quoteMint: b, baseVault: ps.tokenAVault.toBase58(), quoteVault: ps.tokenBVault.toBase58(), sqrtPrice: sqrt.toString(),
    liquidity: big(ps.liquidity).toString(), permanentLockLiquidity: big(ps.permanentLockLiquidity).toString(), activationType: Number(ps.activationType),
    priceQuotePerBase: ((sqrt * sqrt * 10n ** BigInt(baseDecimals) * 10n ** 18n) / Q128).toString(), raw: { poolState: ps } };
}

/** The pool's activation clock: slot or unix time, whichever its activation type uses. */
export async function dammCurrentPoint(conn: Connection, p: LiveDammPool): Promise<bigint> {
  return big(await getCurrentPoint(conn, p.activationType as never));
}

/** Exact-in quote on the DAMM v2 pool. Price impact is measured against spot and excludes the fee, as for the curve. */
export function quoteDammSwap(p: LiveDammPool, direction: Direction, amountIn: bigint, slippageBps: number, currentPoint: bigint): SwapQuote {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new Error('slippageBps must be an integer in 0..5000');
  const sell = direction === 'BASE_TO_QUOTE'; // A to B
  const q: any = swapQuoteExactInput(p.raw.poolState as never, new BN(currentPoint.toString()), new BN(amountIn.toString()), 0, sell, false, 6, 6);
  const out = big(q.outputAmount);
  if (out === 0n) throw new Error('ZERO_OUTPUT: amount too small for this pool');
  const min = (out * BigInt(10_000 - slippageBps)) / 10_000n;
  const tradingFee = big(q.claimingFee) + big(q.compoundingFee), protocolFee = big(q.protocolFee) + big(q.referralFee);
  const feesOnInput = big(q.excludedFeeInputAmount) < amountIn;
  const netIn = big(q.excludedFeeInputAmount), grossOut = feesOnInput ? out : out + tradingFee + protocolFee;
  const p2 = big(p.sqrtPrice) ** 2n;
  const spotOut = p2 === 0n || netIn <= 0n ? 0n : sell ? (netIn * p2) / Q128 : (netIn * Q128) / p2;
  const impact = spotOut === 0n || grossOut >= spotOut ? 0n : ((spotOut - grossOut) * 10_000n) / spotOut;
  return { amountIn: amountIn.toString(), expectedOut: out.toString(), minimumAmountOut: min.toString(), tradingFee: tradingFee.toString(),
    protocolFee: protocolFee.toString(), nextSqrtPrice: big(q.nextSqrtPrice).toString(), priceImpactBps: impact.toString() };
}

/** Unsigned DAMM v2 swap (exact in) for a graduated launch. The minimum out is bound into the terms the browser verifies. */
export async function buildDammSwap(conn: Connection, p: LiveDammPool, r: SwapRequest, currentPoint: bigint): Promise<BuiltTx & { quote: SwapQuote }> {
  const quote = quoteDammSwap(p, r.direction, r.amountIn, r.slippageBps, currentPoint);
  const user = new PublicKey(r.user), base = new PublicKey(p.baseMint), quoteMint = new PublicKey(p.quoteMint);
  const sell = r.direction === 'BASE_TO_QUOTE';
  const tx = await new CpAmm(conn).swap({ payer: user, pool: new PublicKey(p.pool), inputTokenMint: sell ? base : quoteMint, outputTokenMint: sell ? quoteMint : base,
    amountIn: new BN(r.amountIn.toString()), minimumAmountOut: new BN(quote.minimumAmountOut), tokenAVault: new PublicKey(p.baseVault), tokenBVault: new PublicKey(p.quoteVault),
    tokenAMint: base, tokenBMint: quoteMint, tokenAProgram: TOKEN, tokenBProgram: TOKEN, referralTokenAccount: null, poolState: p.raw.poolState } as never);
  const terms: ApprovedTerms = { ...common(r.user), kind: 'DAMM_SWAP', dammConfig: DAMM_V2_CUSTOMIZABLE_CONFIG.toBase58(), pool: p.pool, user: r.user, baseMint: p.baseMint,
    quoteMint: p.quoteMint, baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN, direction: r.direction, amountIn: r.amountIn.toString(),
    minimumAmountOut: quote.minimumAmountOut };
  return { ...(await finish(conn, tx, user)), terms, quote };
}

// ------------------------------------------------------------------ creator fee claims (signed by the creator's own wallet)

/** Unsigned claim of the creator's share of curve trading fees, paid to the creator's own token accounts. */
export async function buildCreatorCurveClaim(conn: Connection, pool: LivePool, creator: string): Promise<BuiltTx & { maxBaseAmount: string; maxQuoteAmount: string }> {
  if (pool.creator !== creator) throw new Error('NOT_CREATOR: only the coin creator can claim its curve fees');
  const maxBaseAmount = pool.creatorBaseFee, maxQuoteAmount = pool.creatorQuoteFee;
  if (BigInt(maxBaseAmount) === 0n && BigInt(maxQuoteAmount) === 0n) throw new Error('NOTHING_TO_CLAIM: no creator fees on the curve yet');
  const client = new DynamicBondingCurveClient(conn, COMMITMENT);
  const c = new PublicKey(creator);
  const tx = await client.creator.claimCreatorTradingFee({ creator: c, payer: c, pool: new PublicKey(pool.pool), receiver: c,
    maxBaseAmount: new BN(maxBaseAmount), maxQuoteAmount: new BN(maxQuoteAmount) } as never);
  const terms: ApprovedTerms = { ...common(creator), kind: 'CLAIM_CREATOR_TRADING_FEE', config: pool.config, pool: pool.pool, creator, receiver: creator,
    baseMint: pool.baseMint, quoteMint: pool.quoteMint, baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN, maxBaseAmount, maxQuoteAmount };
  return { ...(await finish(conn, tx, c)), terms, maxBaseAmount, maxQuoteAmount };
}

export interface DammPosition { position: string; nftMint: string; feeBaseRaw: string; feeQuoteRaw: string; permanentlyLocked: boolean }

/** The DAMM v2 positions in this pool whose NFT the wallet holds, with the fees each has earned and not yet claimed. */
export async function dammPositionsOf(conn: Connection, p: LiveDammPool, owner: string): Promise<DammPosition[]> {
  const rows = await new CpAmm(conn).getUserPositionByPool(new PublicKey(p.pool), new PublicKey(owner));
  return rows.map((r: any) => {
    const fee = getUnClaimLpFee(p.raw.poolState as never, r.positionState);
    return { position: r.position.toBase58(), nftMint: r.positionState.nftMint.toBase58(), feeBaseRaw: big(fee.feeTokenA).toString(), feeQuoteRaw: big(fee.feeTokenB).toString(),
      permanentlyLocked: big(r.positionState.permanentLockedLiquidity) > 0n };
  });
}

/** Unsigned claim of a DAMM v2 position's fees into the owner's own token accounts (the program checks the owner holds the NFT). */
export async function buildDammClaim(conn: Connection, p: LiveDammPool, owner: string, nftMint: string): Promise<BuiltTx> {
  const o = new PublicKey(owner), nft = new PublicKey(nftMint);
  const tx = await new CpAmm(conn).claimPositionFee({ owner: o, feePayer: o, pool: new PublicKey(p.pool), position: derivePositionAddress(nft),
    positionNftAccount: derivePositionNftAccount(nft), tokenAVault: new PublicKey(p.baseVault), tokenBVault: new PublicKey(p.quoteVault),
    tokenAMint: new PublicKey(p.baseMint), tokenBMint: new PublicKey(p.quoteMint), tokenAProgram: TOKEN, tokenBProgram: TOKEN } as never);
  const terms: ApprovedTerms = { ...common(owner), kind: 'DAMM_CLAIM_POSITION_FEE', dammConfig: DAMM_V2_CUSTOMIZABLE_CONFIG.toBase58(), pool: p.pool, owner,
    positionNftMint: nftMint, baseMint: p.baseMint, quoteMint: p.quoteMint, baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN };
  return { ...(await finish(conn, tx, o)), terms };
}

export const dammV2PoolFor = async (baseMint: string, quoteMint: string) => {
  const { deriveDammV2PoolAddress } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  return deriveDammV2PoolAddress(DAMM_V2_CUSTOMIZABLE_CONFIG, new PublicKey(baseMint), new PublicKey(quoteMint)).toBase58();
};

// ------------------------------------------------------------------ thin RPC helpers for the launchpad app (keeps web3.js inside this package)

export type DevnetConnection = Connection;
export type DevnetSigner = Keypair;
export const publicKeyOf = (kp: Keypair) => kp.publicKey.toBase58();
export function isAddress(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return new PublicKey(s).toBase58() === s; } catch { return false; }
}
export const isOnCurveAddress = (s: string) => { try { return PublicKey.isOnCurve(new PublicKey(s).toBytes()); } catch { return false; } };

/** Sends already-signed wire bytes (no preflight skip) and waits for `confirmed` within the blockhash lifetime. */
export async function sendSignedTransaction(conn: Connection, bytes: Uint8Array, _blockhash: string, lastValidBlockHeight: number): Promise<string> {
  const signature = await conn.sendRawTransaction(bytes, { skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 3 });
  await confirmSignature(conn, signature, lastValidBlockHeight);
  return signature;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpcBusy = (e: unknown) => /\b429\b|Too Many Requests|rate limit|fetch failed|ECONNRESET|ETIMEDOUT/i.test((e as Error)?.message ?? '');

/** Waits for `confirmed` by polling signature status until the blockhash expires. web3.js's confirmTransaction races a
 *  websocket against polling and can leave an RPC call behind whose later rejection (e.g. a 429 from the public
 *  endpoint) is unhandled and takes the whole server down. Every call here is awaited, and busy responses back off. */
export async function confirmSignature(conn: Connection, signature: string, lastValidBlockHeight: number): Promise<void> {
  let wait = 800;
  for (let i = 0; ; i++) {
    try {
      const s = (await conn.getSignatureStatuses([signature])).value[0];
      if (s?.err) throw new Error(`TRANSACTION_FAILED ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
      if (i % 3 === 2 && (await conn.getBlockHeight(COMMITMENT)) > lastValidBlockHeight) {
        throw new Error('TRANSACTION_EXPIRED: the blockhash expired before the transaction confirmed; nothing was charged, try again');
      }
      wait = 800;
    } catch (e) {
      if (!rpcBusy(e)) throw e;
      wait = Math.min(wait * 2, 8_000);
    }
    await sleep(wait);
  }
}

/** Operator-signed transaction (faucet, platform setup, migration crank) with a fresh blockhash and the same confirmation. */
async function operatorSend(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(COMMITMENT);
  tx.feePayer = signers[0]!.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 3 });
  await confirmSignature(conn, signature, lastValidBlockHeight);
  return signature;
}

export interface TxSummary { signature: string; slot: number; blockTime: number | null; err: boolean; feePayer: string; accountKeys: string[];
  tokenDeltas: Record<string, bigint>; logMessages: string[] }
/** Parsed transaction reduced to what the indexer needs: fee payer and per-token-account balance deltas. */
export async function getTxSummary(conn: Connection, signature: string): Promise<TxSummary | null> {
  const t = await conn.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!t || !t.meta) return null;
  const keys = t.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const deltas: Record<string, bigint> = {};
  const add = (list: typeof t.meta.preTokenBalances, sign: bigint) => {
    for (const b of list ?? []) { const a = keys[b.accountIndex]!; deltas[a] = (deltas[a] ?? 0n) + sign * BigInt(b.uiTokenAmount.amount); }
  };
  add(t.meta.preTokenBalances, -1n);
  add(t.meta.postTokenBalances, 1n);
  return { signature, slot: t.slot, blockTime: t.blockTime ?? null, err: t.meta.err !== null, feePayer: keys[0]!, accountKeys: keys, tokenDeltas: deltas,
    logMessages: t.meta.logMessages ?? [] };
}

/** Signatures touching `address`, oldest first, stopping at `until` (exclusive). */
export async function getNewSignatures(conn: Connection, address: string, until: string | null, limit = 100): Promise<{ signature: string; slot: number; err: boolean }[]> {
  const list = await conn.getSignaturesForAddress(new PublicKey(address), { limit, ...(until ? { until } : {}) }, 'confirmed');
  return list.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err !== null })).reverse();
}

export async function getWalletBalances(conn: Connection, owner: string, mints: string[]): Promise<{ lamports: string; tokens: Record<string, string> }> {
  const o = new PublicKey(owner);
  const lamports = await conn.getBalance(o, COMMITMENT);
  const tokens: Record<string, string> = {};
  const infos = await conn.getMultipleParsedAccounts(mints.map((m) => ataAddress(o, new PublicKey(m))), { commitment: COMMITMENT });
  mints.forEach((m, k) => {
    const d = infos.value[k]?.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } } | undefined;
    tokens[m] = d?.parsed?.info?.tokenAmount?.amount ?? '0';
  });
  return { lamports: String(lamports), tokens };
}
export const getLamports = async (conn: Connection, owner: string) => BigInt(await conn.getBalance(new PublicKey(owner), COMMITMENT));
