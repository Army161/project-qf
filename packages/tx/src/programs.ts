// Program ids QF transactions may reference at top level (FACT: SDK constants / Solana native ids).
export const PROGRAM_IDS = Object.freeze({
  DBC: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  DAMM_V2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  // Squads v4 multisig: the platform treasury's vault PDA is the fee claimer of treasury configs (devnet stand-in, milestone 7).
  SQUADS_V4: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
  SYSTEM: '11111111111111111111111111111111',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ASSOCIATED_TOKEN: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
  // referenced as instruction accounts only (never top-level programs in a QF transaction)
  METAPLEX_METADATA: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
} as const);
