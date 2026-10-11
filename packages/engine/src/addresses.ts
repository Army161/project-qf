// Every address the engine derives (Solana Kit; browser-safe). Seeds follow qf-curve state.rs and the qf-pool fork;
// test/idl.test.ts checks them against the PDA seeds recorded in the pinned IDLs, and test/golden.test.ts against
// the engine's own client.
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { ASSOCIATED_TOKEN, BPF_UPGRADEABLE_LOADER, NATIVE_MINT, QF_CURVE, QF_POOL, TOKEN, TOKEN_2022 } from './programs.ts';

const enc = getAddressEncoder();
const bytes = (a: string) => enc.encode(address(a)) as Uint8Array;
const pda = async (program: string, seeds: (string | Uint8Array)[]) => (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0] as string;

/** The associated token account of `owner` for `mint` under `tokenProgram` (classic Token or Token-2022). */
export const ata = (owner: string, mint: string, tokenProgram: string) => pda(ASSOCIATED_TOKEN, [bytes(owner), bytes(tokenProgram), bytes(mint)]);

// ---------- qf-curve ----------
/** Settings for coins quoted in one quote mint (one per quote: SOL, a USDC). */
export const globalAddress = (quoteMint = NATIVE_MINT) => pda(QF_CURVE, ['global', bytes(quoteMint)]);
export const launchAddress = (mint: string) => pda(QF_CURVE, ['launch', bytes(mint)]);
/** Owns a coin's two vaults and signs for the curve. Holds no data. */
export const launchSignerAddress = (mint: string) => pda(QF_CURVE, ['signer', bytes(mint)]);
/** Creates every graduated pool; holds tokens only inside a graduation. */
export const graduatorAddress = () => pda(QF_CURVE, ['graduator']);
/** A graduated coin's pool: an address only the curve can sign for, so nobody can take it first. */
export const launchPoolAddress = (mint: string) => pda(QF_CURVE, ['pool', bytes(mint)]);
/** The curve program's upgrade data account; `initialize` checks its upgrade authority. */
export const curveProgramDataAddress = () => pda(BPF_UPGRADEABLE_LOADER, [bytes(QF_CURVE)]);

export interface LaunchAccounts { launch: string; launchSigner: string; baseVault: string; quoteVault: string }
export async function launchAccounts(mint: string, quoteMint = NATIVE_MINT): Promise<LaunchAccounts> {
  const launchSigner = await launchSignerAddress(mint);
  return { launch: await launchAddress(mint), launchSigner, baseVault: await ata(launchSigner, mint, TOKEN_2022), quoteVault: await ata(launchSigner, quoteMint, TOKEN) };
}

// ---------- qf-pool ----------
export function ammConfigAddress(index = 0) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) throw new RangeError('amm config index must be a u16');
  return pda(QF_POOL, ['amm_config', Uint8Array.of(index >> 8, index & 0xff)]);
}
/** The pool program's launchpad permission held by `holder` (the graduator). */
export const permissionAddress = async (holder?: string) => pda(QF_POOL, ['permission', bytes(holder ?? (await graduatorAddress()))]);
export const poolAuthorityAddress = () => pda(QF_POOL, ['vault_and_lp_mint_auth_seed']);
export const creatorFeeShareAddress = (creator: string, ammConfig: string) => pda(QF_POOL, ['creator_fee_share', bytes(creator), bytes(ammConfig)]);

/** The two mints in the pool program's order: byte-wise ascending. */
export function sortMints(a: string, b: string): [string, string] {
  const x = bytes(a), y = bytes(b);
  for (let k = 0; k < 32; k++) if (x[k] !== y[k]) return x[k]! < y[k]! ? [a, b] : [b, a];
  throw new RangeError('a pool needs two different mints');
}
/** The pool program's default address for a pair, which anyone can create. Graduated coins never use it. */
export async function defaultPoolAddress(ammConfig: string, mintA: string, mintB: string) {
  const [t0, t1] = sortMints(mintA, mintB);
  return pda(QF_POOL, ['pool', bytes(ammConfig), bytes(t0), bytes(t1)]);
}

export interface PoolAccounts { token0: string; token1: string; pool: string; authority: string; lpMint: string; vault0: string; vault1: string; observation: string }
/** Every account the pool program derives from a pool address. */
export async function poolAccounts(pool: string, mintA: string, mintB: string): Promise<PoolAccounts> {
  const [token0, token1] = sortMints(mintA, mintB);
  return {
    token0, token1, pool,
    authority: await poolAuthorityAddress(),
    lpMint: await pda(QF_POOL, ['pool_lp_mint', bytes(pool)]),
    vault0: await pda(QF_POOL, ['pool_vault', bytes(pool), bytes(token0)]),
    vault1: await pda(QF_POOL, ['pool_vault', bytes(pool), bytes(token1)]),
    observation: await pda(QF_POOL, ['observation', bytes(pool)]),
  };
}
