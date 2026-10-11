// The programs and fixed accounts the QF engine uses. The two engine ids are checked against the pinned IDLs
// (test/idl.test.ts); the rest are Solana's own program ids.
export const QF_CURVE = 'CaX3gfwE1y3AustJ5e2JQFmaDtXB5oeX6ayvNzLGsFoX';
/** qf-pool: Project QF's fork of raydium-cp-swap (Apache-2.0), where graduated coins trade. */
export const QF_POOL = 'FHG8GyPytpydCRFL6yvwu92vyWSk7bSYZknyLn3v6ewU';
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** qf-pool's pool-creation-fee account, a compile-time key in the fork: graduation passes it as `create_pool_fee`. */
export const POOL_FEE_RECEIVER = 'BYSX6JVNMtMEyqbxkgJgnXMrWYVpftU4oxR25CKwmXeA';
/** Wrapped SOL: the quote mint of SOL-quoted coins. */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
/** Every coin the curve creates is a Token-2022 mint with 6 decimals (qf-curve state.rs BASE_DECIMALS). */
export const BASE_DECIMALS = 6;
