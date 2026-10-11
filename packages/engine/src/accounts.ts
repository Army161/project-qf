// Decoders for the engine's on-chain accounts and the token accounts it reads (browser-safe). Each decoder checks the
// owning program, the 8-byte discriminator and the exact length before decoding, and fails closed.
import { decodeFields, sameBytes, CodecError, type EngineIdl, type Value } from './codec.ts';
import { CURVE_IDL, POOL_IDL } from './idl.ts';
import type { LaunchConfig } from './config.ts';
import { getAddressDecoder } from '@solana/kit';
import * as A from './addresses.ts';
import { NATIVE_MINT, QF_CURVE, QF_POOL, TOKEN, TOKEN_2022 } from './programs.ts';

/** A raw account as an RPC returns it. */
export interface RawAccount { owner: string; lamports: bigint; data: Uint8Array }
/** Reads several accounts in one call (getMultipleAccounts); null where an account does not exist. */
export type AccountReader = (addresses: string[]) => Promise<(RawAccount | null)[]>;

// Every engine account has a fixed size, so decodeFields' exact-length rule also checks the account's size.
function decodeAccount(idl: EngineIdl, program: string, name: string, acc: RawAccount): Record<string, Value> {
  if (acc.owner !== program) throw new CodecError(`${name}: owned by ${acc.owner}, not ${program}`);
  if (acc.data.length < 8 || !sameBytes(acc.data.subarray(0, 8), idl.accounts[name]!)) throw new CodecError(`${name}: wrong discriminator`);
  return decodeFields(acc.data.subarray(8), idl.types[name]!.fields!, idl.types);
}
const big = (v: Value) => v as bigint;
const str = (v: Value) => v as string;
function launchConfig(c: Record<string, Value>): LaunchConfig {
  return { totalSupply: big(c.total_supply!), curveSupply: big(c.curve_supply!), virtualQuote: big(c.virtual_quote!), virtualBase: big(c.virtual_base!),
    tradeFeeBps: BigInt(c.trade_fee_bps as number), creatorFeeShareBps: BigInt(c.creator_fee_share_bps as number), graduationFee: big(c.graduation_fee!) };
}

export type LaunchStatus = 'Trading' | 'Complete' | 'Graduated';
export interface Launch {
  mint: string; creator: string; quoteMint: string; ammConfig: string; config: LaunchConfig; status: LaunchStatus;
  /** Quote paid into the curve (net of fees) and not paid back out; 0 after graduation. */
  realQuote: bigint;
  /** Curve coins held by buyers. */
  baseSold: bigint;
  /** Unclaimed fees held in the quote vault (the platform's includes the graduation fee once graduated). */
  platformFees: bigint; creatorFees: bigint;
  /** The pool, once graduated (the all-zero address before). */
  pool: string;
  createdAt: bigint; bump: number; signerBump: number;
}
export function decodeLaunch(acc: RawAccount): Launch {
  const d = decodeAccount(CURVE_IDL, QF_CURVE, 'Launch', acc);
  return { mint: str(d.mint!), creator: str(d.creator!), quoteMint: str(d.quote_mint!), ammConfig: str(d.amm_config!), config: launchConfig(d.config as Record<string, Value>),
    status: d.status as LaunchStatus, realQuote: big(d.real_quote!), baseSold: big(d.base_sold!), platformFees: big(d.platform_fees!), creatorFees: big(d.creator_fees!),
    pool: str(d.pool!), createdAt: big(d.created_at!), bump: d.bump as number, signerBump: d.signer_bump as number };
}

export interface Global { admin: string; feeRecipient: string; quoteMint: string; ammConfig: string; createPaused: boolean; config: LaunchConfig; bump: number }
export function decodeGlobal(acc: RawAccount): Global {
  const d = decodeAccount(CURVE_IDL, QF_CURVE, 'Global', acc);
  return { admin: str(d.admin!), feeRecipient: str(d.fee_recipient!), quoteMint: str(d.quote_mint!), ammConfig: str(d.amm_config!), createPaused: d.create_paused as boolean,
    config: launchConfig(d.config as Record<string, Value>), bump: d.bump as number };
}

export interface AmmConfig {
  bump: number; disableCreatePool: boolean; index: number;
  /** Rates in millionths. */
  tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint; creatorFeeRate: bigint;
  /** The share of the creator fee the protocol keeps, in millionths, unless a CreatorFeeShare account overrides it. */
  creatorFeeShareRate: bigint;
  createPoolFee: bigint; protocolOwner: string; fundOwner: string;
}
export function decodeAmmConfig(acc: RawAccount): AmmConfig {
  const d = decodeAccount(POOL_IDL, QF_POOL, 'AmmConfig', acc);
  return { bump: d.bump as number, disableCreatePool: d.disable_create_pool as boolean, index: d.index as number, tradeFeeRate: big(d.trade_fee_rate!), protocolFeeRate: big(d.protocol_fee_rate!),
    fundFeeRate: big(d.fund_fee_rate!), creatorFeeRate: big(d.creator_fee_rate!), creatorFeeShareRate: big(d.creator_fee_share_rate!), createPoolFee: big(d.create_pool_fee!),
    protocolOwner: str(d.protocol_owner!), fundOwner: str(d.fund_owner!) };
}

export interface PoolState {
  ammConfig: string; poolCreator: string; token0Vault: string; token1Vault: string; lpMint: string; token0Mint: string; token1Mint: string;
  token0Program: string; token1Program: string; observationKey: string;
  authBump: number;
  /** Bit 0 deposits off, bit 1 withdrawals off, bit 2 swaps off. */
  status: number;
  lpMintDecimals: number; mint0Decimals: number; mint1Decimals: number;
  /** The pool program's own LP count. Burning LP tokens does not lower it, so a graduated coin keeps its count here
   *  while the LP mint's supply is 0 (seen on the real programs, localnet 2026-10-11): check the mint, not this. */
  lpSupply: bigint;
  protocolFeesToken0: bigint; protocolFeesToken1: bigint; fundFeesToken0: bigint; fundFeesToken1: bigint;
  openTime: bigint; recentEpoch: bigint;
  /** 0 both tokens, 1 only token 0, 2 only token 1. */
  creatorFeeOn: number; enableCreatorFee: boolean;
  creatorFeesToken0: bigint; creatorFeesToken1: bigint;
}
export function decodePoolState(acc: RawAccount): PoolState {
  const d = decodeAccount(POOL_IDL, QF_POOL, 'PoolState', acc);
  return {
    ammConfig: str(d.amm_config!), poolCreator: str(d.pool_creator!), token0Vault: str(d.token_0_vault!), token1Vault: str(d.token_1_vault!), lpMint: str(d.lp_mint!),
    token0Mint: str(d.token_0_mint!), token1Mint: str(d.token_1_mint!), token0Program: str(d.token_0_program!), token1Program: str(d.token_1_program!), observationKey: str(d.observation_key!),
    authBump: d.auth_bump as number, status: d.status as number, lpMintDecimals: d.lp_mint_decimals as number, mint0Decimals: d.mint_0_decimals as number, mint1Decimals: d.mint_1_decimals as number,
    lpSupply: big(d.lp_supply!), protocolFeesToken0: big(d.protocol_fees_token_0!), protocolFeesToken1: big(d.protocol_fees_token_1!), fundFeesToken0: big(d.fund_fees_token_0!),
    fundFeesToken1: big(d.fund_fees_token_1!), openTime: big(d.open_time!), recentEpoch: big(d.recent_epoch!), creatorFeeOn: d.creator_fee_on as number,
    enableCreatorFee: d.enable_creator_fee as boolean, creatorFeesToken0: big(d.creator_fees_token_0!), creatorFeesToken1: big(d.creator_fees_token_1!),
  };
}
export interface CreatorFeeShare { creator: string; ammConfig: string; shareRate: bigint }
export function decodeCreatorFeeShare(acc: RawAccount): CreatorFeeShare {
  const d = decodeAccount(POOL_IDL, QF_POOL, 'CreatorFeeShare', acc);
  return { creator: str(d.creator!), ammConfig: str(d.amm_config!), shareRate: big(d.share_rate!) };
}

// ---------- SPL Token / Token-2022 base layouts ----------
const addrDec = getAddressDecoder();
const u64At = (b: Uint8Array, o: number) => { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[o + k]!); return v; };
const u32At = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! * 2 ** 24);
function coption(b: Uint8Array, o: number): string | null {
  const tag = u32At(b, o);
  if (tag === 0) return null;
  if (tag !== 1) throw new CodecError(`COption tag ${tag}`);
  return addrDec.decode(b.subarray(o + 4, o + 36)) as string;
}
const tokenProgram = (owner: string) => { if (owner !== TOKEN && owner !== TOKEN_2022) throw new CodecError(`not a token program account (${owner})`); return owner; };

export interface TokenAccount { program: string; mint: string; owner: string; amount: bigint; frozen: boolean }
/** A token account's base fields (both token programs share the first 165 bytes). */
export function decodeTokenAccount(acc: RawAccount): TokenAccount {
  const program = tokenProgram(acc.owner), b = acc.data;
  if (b.length < 165 || (program === TOKEN && b.length !== 165)) throw new CodecError(`token account: ${b.length} bytes`);
  if (program === TOKEN_2022 && b.length > 165 && b[165] !== 2) throw new CodecError('token-2022 account type is not Account');
  const state = b[108];
  if (state !== 1 && state !== 2) throw new CodecError(`token account state ${state}`);
  return { program, mint: addrDec.decode(b.subarray(0, 32)) as string, owner: addrDec.decode(b.subarray(32, 64)) as string, amount: u64At(b, 64), frozen: state === 2 };
}
export interface Mint { program: string; mintAuthority: string | null; supply: bigint; decimals: number; freezeAuthority: string | null }
export function decodeMint(acc: RawAccount): Mint {
  const program = tokenProgram(acc.owner), b = acc.data;
  if (b.length < 82 || (program === TOKEN && b.length !== 82)) throw new CodecError(`mint: ${b.length} bytes`);
  if (program === TOKEN_2022 && b.length > 82 && b[165] !== 1) throw new CodecError('token-2022 account type is not Mint');
  if (b[45] !== 1) throw new CodecError('mint not initialized');
  return { program, mintAuthority: coption(b, 0), supply: u64At(b, 36), decimals: b[44]!, freezeAuthority: coption(b, 46) };
}

// ---------- reads ----------
/** One coin's curve state and the two vault balances its books are checked against, read in one call. */
export interface CoinState { launch: Launch; baseVault: bigint; quoteVault: bigint }
export async function readCoin(read: AccountReader, mint: string, quoteMint = NATIVE_MINT): Promise<CoinState | null> {
  const a = await A.launchAccounts(mint, quoteMint);
  const [l, b, q] = await read([a.launch, a.baseVault, a.quoteVault]);
  if (!l) return null;
  const launch = decodeLaunch(l);
  if (launch.mint !== mint || launch.quoteMint !== quoteMint) throw new CodecError('launch account does not belong to this mint and quote');
  if (!q) throw new CodecError('quote vault missing');
  const quoteVault = decodeTokenAccount(q), baseVault = b ? decodeTokenAccount(b) : null;
  if (quoteVault.mint !== quoteMint || quoteVault.owner !== a.launchSigner) throw new CodecError('quote vault is not the launch signer\'s');
  if (baseVault && (baseVault.mint !== mint || baseVault.owner !== a.launchSigner)) throw new CodecError('base vault is not the launch signer\'s');
  // graduation closes nothing: the base vault stays, empty
  return { launch, baseVault: baseVault?.amount ?? 0n, quoteVault: quoteVault.amount };
}

/** A graduated coin's pool, its config and vault balances, read in one call. */
export interface CoinPool { address: string; pool: PoolState; config: AmmConfig; vault0: bigint; vault1: bigint }
export async function readCoinPool(read: AccountReader, mint: string, quoteMint = NATIVE_MINT): Promise<CoinPool | null> {
  const address = await A.launchPoolAddress(mint);
  const derived = await A.poolAccounts(address, mint, quoteMint);
  const [p] = await read([address]);
  if (!p) return null;
  const pool = decodePoolState(p);
  if (pool.token0Mint !== derived.token0 || pool.token1Mint !== derived.token1 || pool.token0Vault !== derived.vault0 || pool.token1Vault !== derived.vault1 || pool.observationKey !== derived.observation)
    throw new CodecError('pool accounts differ from the derived ones');
  const [c, v0, v1] = await read([pool.ammConfig, pool.token0Vault, pool.token1Vault]);
  if (!c || !v0 || !v1) throw new CodecError('pool config or vault missing');
  return { address, pool, config: decodeAmmConfig(c), vault0: decodeTokenAccount(v0).amount, vault1: decodeTokenAccount(v1).amount };
}
