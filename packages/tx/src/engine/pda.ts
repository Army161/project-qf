// Account derivations used to bind DBC/DAMM v2 instruction accounts (Solana Kit; browser-safe).
// Seeds follow the pinned MIT SDK helpers (deriveDbcPoolAddress, deriveDbcTokenVaultAddress, deriveMintMetadata,
// deriveDammV2PoolAddress, derivePositionAddress, derivePositionNftAccount, deriveDammV2MigrationMetadataAddress).
import { getAddressEncoder, getProgramDerivedAddress, address, type Address } from '@solana/kit';
import { PROGRAM_IDS } from '../programs.ts';

const enc = getAddressEncoder();
const bytes = (a: string) => enc.encode(address(a));
const pda = async (program: string, seeds: (string | Uint8Array)[]) =>
  (await getProgramDerivedAddress({ programAddress: address(program), seeds: seeds.map((s) => (typeof s === 'string' ? s : s)) }))[0] as string;
/** The larger pubkey (byte-wise) first, as SDK getFirstKey / deriveDbcPoolAddress do. */
function ordered(a: string, b: string): [Uint8Array, Uint8Array] {
  const x = bytes(a), y = bytes(b);
  for (let k = 0; k < 32; k++) if (x[k] !== y[k]) return x[k]! > y[k]! ? [x as Uint8Array, y as Uint8Array] : [y as Uint8Array, x as Uint8Array];
  return [x as Uint8Array, y as Uint8Array];
}

export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
export const DAMM_V2_CUSTOMIZABLE_CONFIG = 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck';

export const dbcEventAuthority = () => pda(PROGRAM_IDS.DBC, ['__event_authority']);
export const dammEventAuthority = () => pda(PROGRAM_IDS.DAMM_V2, ['__event_authority']);
export const dammPoolAuthority = () => pda(PROGRAM_IDS.DAMM_V2, ['pool_authority']);
export const dbcPool = (config: string, baseMint: string, quoteMint: string) => pda(PROGRAM_IDS.DBC, ['pool', bytes(config) as Uint8Array, ...ordered(quoteMint, baseMint)]);
export const dbcVault = (mint: string, pool: string) => pda(PROGRAM_IDS.DBC, ['token_vault', bytes(mint) as Uint8Array, bytes(pool) as Uint8Array]);
export const mintMetadata = (mint: string) => pda(PROGRAM_IDS.METAPLEX_METADATA, ['metadata', bytes(PROGRAM_IDS.METAPLEX_METADATA) as Uint8Array, bytes(mint) as Uint8Array]);
export const dammMigrationMetadata = (virtualPool: string) => pda(PROGRAM_IDS.DBC, ['damm_v2', bytes(virtualPool) as Uint8Array]);
export const dammPool = (dammConfig: string, baseMint: string, quoteMint: string) => pda(PROGRAM_IDS.DAMM_V2, ['pool', bytes(dammConfig) as Uint8Array, ...ordered(baseMint, quoteMint)]);
export const dammVault = (mint: string, pool: string) => pda(PROGRAM_IDS.DAMM_V2, ['token_vault', bytes(mint) as Uint8Array, bytes(pool) as Uint8Array]);
export const dammPosition = (nftMint: string) => pda(PROGRAM_IDS.DAMM_V2, ['position', bytes(nftMint) as Uint8Array]);
export const dammPositionNftAccount = (nftMint: string) => pda(PROGRAM_IDS.DAMM_V2, ['position_nft_account', bytes(nftMint) as Uint8Array]);
export const ata = (owner: string, mint: string, tokenProgram: string) =>
  pda(PROGRAM_IDS.ASSOCIATED_TOKEN, [bytes(owner) as Uint8Array, bytes(tokenProgram) as Uint8Array, bytes(mint) as Uint8Array]);
export type { Address };
