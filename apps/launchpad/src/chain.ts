// The launchpad's chain port. The server and indexer talk to Solana only through this interface; the real
// implementation delegates to the server-only Meteora adapter (the only package allowed to use web3.js), and tests
// substitute an in-process fake.
import {
  buildCreatePool, buildCreatorCurveClaim, buildDammClaim, buildDammSwap, dammPositionsOf, buildSwap, dammCurrentPoint, dammV2PoolFor, quoteDammSwap, readDammPool, getNewSignatures, getTxSummary, getWalletBalances, getLamports, quoteSwap, readPool,
  runMigration, sendFromTreasury, sendSignedTransaction, publicKeyOf,
  type BuiltTx, type CreatePoolRequest, type DammPosition, type DevnetConnection, type DevnetSigner, type Direction, type LiveDammPool, type LivePool, type SwapQuote, type SwapRequest,
  type TxSummary,
} from '@project-qf/adapter-meteora-dbc/launchpad';
import {
  buildTreasuryApprove, buildTreasuryExecute, buildTreasuryPropose, partnerCurveClaim, readProposal, readTreasury, readVaultTransactionAccount, vaultDammClaim,
  type ProposalState, type TreasuryState,
} from '@project-qf/adapter-meteora-dbc/treasury';
import type { TreasuryInnerTerms } from '@project-qf/tx';

export type { ProposalState, TreasuryState };
/** What a treasury proposal asks the vault to claim: the partner share of a curve's fees, or a vault-held DAMM v2 position's fees. */
export type TreasuryClaimRequest = { venue: 'CURVE'; pool: LivePool } | { venue: 'DAMM_V2'; pool: LiveDammPool; nftMint: string; amounts: { baseRaw: string; quoteRaw: string } };
export type { BuiltTx, CreatePoolRequest, DammPosition, Direction, LiveDammPool, LivePool, SwapQuote, SwapRequest, TxSummary };

export interface LaunchpadChain {
  operatorAddress: string | null;
  readPool(pool: string): Promise<LivePool | null>;
  buildCreatePool(r: CreatePoolRequest): Promise<BuiltTx & { pool: string }>;
  buildSwap(pool: LivePool, r: SwapRequest, nowSeconds: number): Promise<BuiltTx & { quote: SwapQuote }>;
  quoteSwap(pool: LivePool, direction: Direction, amountIn: bigint, slippageBps: number, nowSeconds: number): SwapQuote;
  /** After graduation: the launch's DAMM v2 pool (refused unless it holds exactly base/quote as token A/B). */
  readDammPool(pool: string, expected: { baseMint: string; quoteMint: string }): Promise<LiveDammPool | null>;
  dammNow(pool: LiveDammPool): Promise<bigint>;
  quoteDammSwap(pool: LiveDammPool, direction: Direction, amountIn: bigint, slippageBps: number, currentPoint: bigint): SwapQuote;
  buildDammSwap(pool: LiveDammPool, r: SwapRequest, currentPoint: bigint): Promise<BuiltTx & { quote: SwapQuote }>;
  /** Creator fees: the curve's creator share (DBC), and after graduation the fees of DAMM v2 positions whose NFT the wallet holds. */
  buildCreatorCurveClaim(pool: LivePool, creator: string): Promise<BuiltTx & { maxBaseAmount: string; maxQuoteAmount: string }>;
  dammPositions(pool: LiveDammPool, owner: string): Promise<DammPosition[]>;
  buildDammClaim(pool: LiveDammPool, owner: string, nftMint: string): Promise<BuiltTx>;
  send(bytes: Uint8Array, blockhash: string, lastValidBlockHeight: number): Promise<string>;
  txSummary(signature: string): Promise<TxSummary | null>;
  newSignatures(address: string, until: string | null): Promise<{ signature: string; slot: number; err: boolean }[]>;
  balances(owner: string, mints: string[]): Promise<{ lamports: string; tokens: Record<string, string> }>;
  lamports(owner: string): Promise<bigint>;
  /** Platform treasury (Squads multisig): reads, and UNSIGNED transactions for a member to check and sign. The server holds
   *  no member key, so none of these can approve or execute anything by themselves. */
  readTreasury(multisig: string): Promise<TreasuryState>;
  buildTreasuryPropose(multisig: string, vault: string, member: string, claim: TreasuryClaimRequest): Promise<BuiltTx & { transactionIndex: string; amounts: { baseRaw: string; quoteRaw: string } }>;
  buildTreasuryApprove(multisig: string, member: string, transactionIndex: string): Promise<BuiltTx>;
  buildTreasuryExecute(r: { multisig: string; vault: string; member: string; transactionIndex: string; inner: TreasuryInnerTerms; stored: Uint8Array }): Promise<BuiltTx>;
  vaultTransaction(multisig: string, transactionIndex: string): Promise<Uint8Array | null>;
  proposal(multisig: string, transactionIndex: string): Promise<ProposalState>;
  /** operator-only */
  faucet(quoteMint: string, to: string, quoteRaw: bigint, lamports: bigint): Promise<string>;
  migrate(pool: string): Promise<string>;
  dammPoolFor(baseMint: string, quoteMint: string): Promise<string>;
}

export function realChain(conn: DevnetConnection, operator: DevnetSigner | null, log?: (m: string) => void): LaunchpadChain {
  const needOperator = () => { if (!operator) throw new Error('OPERATOR_KEY_UNAVAILABLE'); return operator; };
  return {
    operatorAddress: operator ? publicKeyOf(operator) : null,
    readPool: (p) => readPool(conn, p),
    buildCreatePool: (r) => buildCreatePool(conn, r),
    buildSwap: (pool, r, now) => buildSwap(conn, pool, r, now),
    quoteSwap,
    readDammPool: (p, e) => readDammPool(conn, p, e),
    dammNow: (p) => dammCurrentPoint(conn, p),
    quoteDammSwap,
    buildDammSwap: (p, r, now) => buildDammSwap(conn, p, r, now),
    buildCreatorCurveClaim: (p, c) => buildCreatorCurveClaim(conn, p, c),
    dammPositions: (p, owner) => dammPositionsOf(conn, p, owner),
    buildDammClaim: (p, owner, nft) => buildDammClaim(conn, p, owner, nft),
    send: (b, bh, h) => sendSignedTransaction(conn, b, bh, h),
    txSummary: (s) => getTxSummary(conn, s),
    newSignatures: (a, u) => getNewSignatures(conn, a, u, { ...(log ? { onTruncated: log } : {}) }),
    balances: (o, m) => getWalletBalances(conn, o, m),
    lamports: (o) => getLamports(conn, o),
    readTreasury: (m) => readTreasury(conn, m),
    buildTreasuryPropose: async (multisig, vault, member, c) => {
      const claim = c.venue === 'CURVE' ? await partnerCurveClaim(conn, c.pool, vault) : await vaultDammClaim(conn, c.pool, vault, c.nftMint, c.amounts);
      return { ...(await buildTreasuryPropose(conn, { multisig, member, claim })), amounts: claim.amounts };
    },
    buildTreasuryApprove: (multisig, member, transactionIndex) => buildTreasuryApprove(conn, { multisig, member, transactionIndex }),
    buildTreasuryExecute: (r) => buildTreasuryExecute(conn, r),
    vaultTransaction: (m, i) => readVaultTransactionAccount(conn, m, i),
    proposal: (m, i) => readProposal(conn, m, i),
    faucet: (q, to, raw, lamports) => sendFromTreasury(conn, needOperator(), q, to, raw, lamports),
    migrate: (pool) => runMigration(conn, needOperator(), pool),
    dammPoolFor: (b, q) => dammV2PoolFor(b, q),
  };
}
