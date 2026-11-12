// Instruction builders for the QF engine (Solana Kit; browser-safe). Each engine instruction is built from the pinned
// IDL: account order, writable and signer flags and fixed program addresses come from the IDL, and a missing, unknown
// or wrong fixed account throws. Builders return unsigned instructions only; nothing here signs or sends.
import { AccountRole, address, type Instruction } from '@solana/kit';
import { encodeFields, type EngineIdl, type IdlAccountMeta } from './codec.ts';
import { CURVE_IDL, POOL_IDL } from './idl.ts';
import * as A from './addresses.ts';
import { ASSOCIATED_TOKEN, COMPUTE_BUDGET, NATIVE_MINT, POOL_FEE_RECEIVER, SYSTEM, TOKEN, TOKEN_2022, fromIdlAddress } from './programs.ts';
import type { LaunchConfig } from './config.ts';

export type { Instruction };
const role = (a: IdlAccountMeta) => (a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY);

/** Builds `name` from `idl`: `accounts` and `args` are keyed by IDL name (snake_case). Fixed addresses and the program id
 *  are the IDL build's, translated to the active deployment (programs.ts). */
export function buildFromIdl(idl: EngineIdl, name: string, accounts: Record<string, string>, args: Record<string, unknown> = {}): Instruction {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`${name} is not in the pinned ${idl.provenance.idlName} IDL`);
  const unused = new Set(Object.keys(accounts));
  const metas = ix.accounts.map((a) => {
    const given = accounts[a.name];
    unused.delete(a.name);
    const fixed = a.address ? fromIdlAddress(a.address) : null;
    if (fixed && given !== undefined && given !== fixed) throw new Error(`${name}: ${a.name} must be ${fixed}`);
    const v = given ?? fixed;
    if (!v) throw new Error(`${name}: account ${a.name} missing`);
    return { address: address(v), role: role(a) };
  });
  if (unused.size) throw new Error(`${name}: unknown accounts ${[...unused].join(', ')}`);
  const data = encodeFields(args, ix.args, idl.types);
  const out = new Uint8Array(8 + data.length);
  out.set(ix.discriminator); out.set(data, 8);
  return { programAddress: address(fromIdlAddress(idl.provenance.programId)), accounts: metas, data: out };
}

const u64 = (v: bigint) => { if (typeof v !== 'bigint') throw new TypeError('amounts are bigint base units'); return v; };
const settingsArg = (s: GlobalSettings) => ({
  admin: s.admin, fee_recipient: s.feeRecipient, create_paused: s.createPaused, buy_paused: s.buyPaused,
  config: { total_supply: s.config.totalSupply, curve_supply: s.config.curveSupply, virtual_quote: s.config.virtualQuote, virtual_base: s.config.virtualBase,
    trade_fee_bps: Number(s.config.tradeFeeBps), creator_fee_share_bps: Number(s.config.creatorFeeShareBps), graduation_fee: s.config.graduationFee },
});
/** `buyPaused` stops buying on every coin (selling, graduation and claims keep working). In update_global a different
 *  `admin` only proposes it; that key then sends accept_admin. */
export interface GlobalSettings { admin: string; feeRecipient: string; createPaused: boolean; buyPaused: boolean; config: LaunchConfig }

// ---------- qf-curve ----------
/** Settings for one quote mint, once. Only the curve program's upgrade authority can send it. */
export async function initializeIx(p: { authority: string; quoteMint?: string; ammConfig: string; settings: GlobalSettings }) {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  return buildFromIdl(CURVE_IDL, 'initialize', { authority: p.authority, global: await A.globalAddress(quoteMint), program_data: await A.curveProgramDataAddress(), quote_mint: quoteMint, amm_config: p.ammConfig },
    { settings: settingsArg(p.settings) });
}
/** New settings for coins created from now on. Admin only. */
export async function updateGlobalIx(p: { admin: string; quoteMint?: string; ammConfig: string; settings: GlobalSettings }) {
  return buildFromIdl(CURVE_IDL, 'update_global', { admin: p.admin, global: await A.globalAddress(p.quoteMint ?? NATIVE_MINT), amm_config: p.ammConfig }, { settings: settingsArg(p.settings) });
}
/** The proposed admin takes over. Signed by the new admin's key. */
export async function acceptAdminIx(p: { newAdmin: string; quoteMint?: string }) {
  return buildFromIdl(CURVE_IDL, 'accept_admin', { new_admin: p.newAdmin, global: await A.globalAddress(p.quoteMint ?? NATIVE_MINT) });
}
/** The creator and the new mint's key both sign. */
export async function createLaunchIx(p: { creator: string; mint: string; quoteMint?: string; ammConfig: string; name: string; symbol: string; uri: string }) {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  const a = await A.launchAccounts(p.mint, quoteMint);
  return buildFromIdl(CURVE_IDL, 'create_launch', {
    creator: p.creator, quote_mint: quoteMint, global: await A.globalAddress(quoteMint), amm_config: p.ammConfig,
    graduator: await A.graduatorAddress(), permission: await A.permissionAddress(), create_pool_fee: POOL_FEE_RECEIVER, mint: p.mint, launch: a.launch, launch_signer: a.launchSigner, base_vault: a.baseVault, quote_vault: a.quoteVault,
  }, { name: p.name, symbol: p.symbol, uri: p.uri });
}
async function tradeAccounts(trader: string, mint: string, quoteMint: string) {
  const a = await A.launchAccounts(mint, quoteMint);
  return { trader, global: await A.globalAddress(quoteMint), launch: a.launch, launch_signer: a.launchSigner, mint, quote_mint: quoteMint, base_vault: a.baseVault, quote_vault: a.quoteVault,
    trader_base: await A.ata(trader, mint, TOKEN_2022), trader_quote: await A.ata(trader, quoteMint, TOKEN) };
}
/** Buy with up to `quoteIn` (fee included); receive at least `minBaseOut`. */
export async function buyIx(p: { trader: string; mint: string; quoteMint?: string; quoteIn: bigint; minBaseOut: bigint }) {
  return buildFromIdl(CURVE_IDL, 'buy', await tradeAccounts(p.trader, p.mint, p.quoteMint ?? NATIVE_MINT), { quote_in: u64(p.quoteIn), min_base_out: u64(p.minBaseOut) });
}
/** Sell `baseIn` coins; receive at least `minQuoteOut` after the fee. */
export async function sellIx(p: { trader: string; mint: string; quoteMint?: string; baseIn: bigint; minQuoteOut: bigint }) {
  return buildFromIdl(CURVE_IDL, 'sell', await tradeAccounts(p.trader, p.mint, p.quoteMint ?? NATIVE_MINT), { base_in: u64(p.baseIn), min_quote_out: u64(p.minQuoteOut) });
}
/** Move a sold-out coin into its pool. Anyone can send it; `ammConfig` and `creator` come from the launch account.
 *  `createPoolFee` defaults to the deployment's pool-creation-fee account (the only one the pool program accepts). */
export async function graduateIx(p: { payer: string; mint: string; quoteMint?: string; ammConfig: string; creator: string; createPoolFee?: string }) {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  const a = await A.launchAccounts(p.mint, quoteMint);
  const pool = await A.poolAccounts(await A.launchPoolAddress(p.mint), p.mint, quoteMint);
  const graduator = await A.graduatorAddress();
  return buildFromIdl(CURVE_IDL, 'graduate', {
    payer: p.payer, launch: a.launch, launch_signer: a.launchSigner, creator: p.creator, graduator, mint: p.mint, quote_mint: quoteMint,
    base_vault: a.baseVault, quote_vault: a.quoteVault, graduator_base: await A.ata(graduator, p.mint, TOKEN_2022), graduator_quote: await A.ata(graduator, quoteMint, TOKEN),
    amm_config: p.ammConfig, cpmm_authority: pool.authority, pool_state: pool.pool, lp_mint: pool.lpMint, graduator_lp: await A.ata(graduator, pool.lpMint, TOKEN),
    token_0_vault: pool.vault0, token_1_vault: pool.vault1, create_pool_fee: p.createPoolFee ?? POOL_FEE_RECEIVER, observation_state: pool.observation, permission: await A.permissionAddress(graduator),
  });
}
/** The platform's unclaimed share to `to`, a quote token account the treasury owns. Anyone can send it. */
export async function claimPlatformFeesIx(p: { mint: string; quoteMint?: string; to: string }) {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  const a = await A.launchAccounts(p.mint, quoteMint);
  return buildFromIdl(CURVE_IDL, 'claim_platform_fees', { global: await A.globalAddress(quoteMint), launch: a.launch, launch_signer: a.launchSigner, quote_mint: quoteMint, quote_vault: a.quoteVault, to: p.to });
}
/** The creator's unclaimed share to `to`, a quote token account the creator owns. Anyone can send it. */
export async function claimCreatorFeesIx(p: { mint: string; quoteMint?: string; to: string }) {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  const a = await A.launchAccounts(p.mint, quoteMint);
  return buildFromIdl(CURVE_IDL, 'claim_creator_fees', { launch: a.launch, launch_signer: a.launchSigner, quote_mint: quoteMint, quote_vault: a.quoteVault, to: p.to });
}
/** Admin recovery: move a sold-out coin to the settings' current pool config. */
export async function refreshPoolConfigIx(p: { admin: string; mint: string; quoteMint?: string; ammConfig: string }) {
  return buildFromIdl(CURVE_IDL, 'refresh_pool_config', { admin: p.admin, global: await A.globalAddress(p.quoteMint ?? NATIVE_MINT), launch: await A.launchAddress(p.mint), amm_config: p.ammConfig });
}

// ---------- qf-pool ----------
/** Exact-input swap in a pool, between the payer's associated token accounts. */
export async function poolSwapIx(p: { payer: string; pool: string; ammConfig: string; mintIn: string; mintOut: string; programIn: string; programOut: string; amountIn: bigint; minOut: bigint }) {
  const pool = await A.poolAccounts(p.pool, p.mintIn, p.mintOut);
  const inIs0 = pool.token0 === p.mintIn;
  return buildFromIdl(POOL_IDL, 'swap_base_input', {
    payer: p.payer, authority: pool.authority, amm_config: p.ammConfig, pool_state: p.pool,
    input_token_account: await A.ata(p.payer, p.mintIn, p.programIn), output_token_account: await A.ata(p.payer, p.mintOut, p.programOut),
    input_vault: inIs0 ? pool.vault0 : pool.vault1, output_vault: inIs0 ? pool.vault1 : pool.vault0,
    input_token_program: p.programIn, output_token_program: p.programOut, input_token_mint: p.mintIn, output_token_mint: p.mintOut, observation_state: pool.observation,
  }, { amount_in: u64(p.amountIn), minimum_amount_out: u64(p.minOut) });
}
/** A graduated coin's pool swap: 'buy' pays quote for coins, 'sell' pays coins for quote. */
export async function coinPoolSwapIx(p: { payer: string; mint: string; quoteMint?: string; ammConfig: string; side: 'buy' | 'sell'; amountIn: bigint; minOut: bigint }) {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  const coin = { mint: p.mint, program: TOKEN_2022 }, quote = { mint: quoteMint, program: TOKEN };
  const [i, o] = p.side === 'buy' ? [quote, coin] : [coin, quote];
  return poolSwapIx({ payer: p.payer, pool: await A.launchPoolAddress(p.mint), ammConfig: p.ammConfig, mintIn: i.mint, mintOut: o.mint, programIn: i.program, programOut: o.program, amountIn: p.amountIn, minOut: p.minOut });
}
/** Pay a graduated coin's pool creator fee to its creator. Anyone can send it; `payer` funds any missing token account. */
export async function collectPoolCreatorFeeIx(p: { payer: string; creator: string; mint: string; quoteMint?: string; ammConfig: string }) {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  const pool = await A.poolAccounts(await A.launchPoolAddress(p.mint), p.mint, quoteMint);
  const prog = (m: string) => (m === p.mint ? TOKEN_2022 : TOKEN);
  return buildFromIdl(POOL_IDL, 'collect_creator_fee_permissionless', {
    payer: p.payer, creator: p.creator, authority: pool.authority, pool_state: pool.pool, token_0_vault: pool.vault0, token_1_vault: pool.vault1,
    vault_0_mint: pool.token0, vault_1_mint: pool.token1,
    creator_token_0: await A.ata(p.creator, pool.token0, prog(pool.token0)), creator_token_1: await A.ata(p.creator, pool.token1, prog(pool.token1)),
    token_0_program: prog(pool.token0), token_1_program: prog(pool.token1), amm_config: p.ammConfig, creator_fee_share: await A.creatorFeeShareAddress(p.creator, p.ammConfig),
  });
}

// ---------- Solana programs (system, token, associated token, compute budget) ----------
const meta = (a: string, r: AccountRole) => ({ address: address(a), role: r });
const le = (v: bigint, bytes: number) => Array.from({ length: bytes }, (_, k) => Number((v >> BigInt(8 * k)) & 0xffn));
/** Create `owner`'s associated token account for `mint` if it does not exist yet; `payer` pays the rent. */
export async function createAtaIdempotentIx(payer: string, owner: string, mint: string, tokenProgram = TOKEN): Promise<Instruction> {
  return { programAddress: address(ASSOCIATED_TOKEN), data: Uint8Array.of(1), accounts: [
    meta(payer, AccountRole.WRITABLE_SIGNER), meta(await A.ata(owner, mint, tokenProgram), AccountRole.WRITABLE), meta(owner, AccountRole.READONLY),
    meta(mint, AccountRole.READONLY), meta(SYSTEM, AccountRole.READONLY), meta(tokenProgram, AccountRole.READONLY)] };
}
export function transferSolIx(from: string, to: string, lamports: bigint): Instruction {
  return { programAddress: address(SYSTEM), data: Uint8Array.from([...le(2n, 4), ...le(u64(lamports), 8)]), accounts: [meta(from, AccountRole.WRITABLE_SIGNER), meta(to, AccountRole.WRITABLE)] };
}
export const syncNativeIx = (account: string): Instruction => ({ programAddress: address(TOKEN), data: Uint8Array.of(17), accounts: [meta(account, AccountRole.WRITABLE)] });
/** Close an empty (or wrapped-SOL) token account; its lamports go to `destination`. */
export const closeAccountIx = (account: string, destination: string, owner: string, tokenProgram = TOKEN): Instruction =>
  ({ programAddress: address(tokenProgram), data: Uint8Array.of(9), accounts: [meta(account, AccountRole.WRITABLE), meta(destination, AccountRole.WRITABLE), meta(owner, AccountRole.READONLY_SIGNER)] });
export function computeUnitLimitIx(units: number): Instruction {
  if (!Number.isInteger(units) || units <= 0 || units > 1_400_000) throw new RangeError('compute unit limit');
  return { programAddress: address(COMPUTE_BUDGET), data: Uint8Array.from([2, ...le(BigInt(units), 4)]) };
}

/** The trader's coin and quote token accounts, created if missing. */
export const traderAccountIxs = async (payer: string, trader: string, mint: string, quoteMint = NATIVE_MINT) =>
  [await createAtaIdempotentIx(payer, trader, mint, TOKEN_2022), await createAtaIdempotentIx(payer, trader, quoteMint, TOKEN)];
/** Create-if-missing `owner`'s wrapped-SOL account and move `lamports` into it (the owner signs the transfer). */
export async function wrapSolIxs(payer: string, owner: string, lamports: bigint) {
  const account = await A.ata(owner, NATIVE_MINT, TOKEN);
  return [await createAtaIdempotentIx(payer, owner, NATIVE_MINT, TOKEN), transferSolIx(owner, account, lamports), syncNativeIx(account)];
}
