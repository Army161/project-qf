// The launchpad's chain port. The server and indexer talk to Solana only through this interface; the real
// implementation delegates to the server-only Meteora adapter (the only package allowed to use web3.js), and tests
// substitute an in-process fake.
import {
  buildCreatePool, buildSwap, dammV2PoolFor, getNewSignatures, getTxSummary, getWalletBalances, getLamports, quoteSwap, readPool,
  runMigration, sendFromTreasury, sendSignedTransaction, publicKeyOf,
  type BuiltTx, type CreatePoolRequest, type DevnetConnection, type DevnetSigner, type Direction, type LivePool, type SwapQuote, type SwapRequest,
  type TxSummary,
} from '@project-qf/adapter-meteora-dbc/launchpad';

export type { BuiltTx, CreatePoolRequest, Direction, LivePool, SwapQuote, SwapRequest, TxSummary };

export interface LaunchpadChain {
  operatorAddress: string | null;
  readPool(pool: string): Promise<LivePool | null>;
  buildCreatePool(r: CreatePoolRequest): Promise<BuiltTx & { pool: string }>;
  buildSwap(pool: LivePool, r: SwapRequest, nowSeconds: number): Promise<BuiltTx & { quote: SwapQuote }>;
  quoteSwap(pool: LivePool, direction: Direction, amountIn: bigint, slippageBps: number, nowSeconds: number): SwapQuote;
  send(bytes: Uint8Array, blockhash: string, lastValidBlockHeight: number): Promise<string>;
  txSummary(signature: string): Promise<TxSummary | null>;
  newSignatures(address: string, until: string | null): Promise<{ signature: string; slot: number; err: boolean }[]>;
  balances(owner: string, mints: string[]): Promise<{ lamports: string; tokens: Record<string, string> }>;
  lamports(owner: string): Promise<bigint>;
  /** operator-only */
  faucet(quoteMint: string, to: string, quoteRaw: bigint, lamports: bigint): Promise<string>;
  migrate(pool: string): Promise<string>;
  dammPoolFor(baseMint: string, quoteMint: string): Promise<string>;
}

export function realChain(conn: DevnetConnection, operator: DevnetSigner | null): LaunchpadChain {
  const needOperator = () => { if (!operator) throw new Error('OPERATOR_KEY_UNAVAILABLE'); return operator; };
  return {
    operatorAddress: operator ? publicKeyOf(operator) : null,
    readPool: (p) => readPool(conn, p),
    buildCreatePool: (r) => buildCreatePool(conn, r),
    buildSwap: (pool, r, now) => buildSwap(conn, pool, r, now),
    quoteSwap,
    send: (b, bh, h) => sendSignedTransaction(conn, b, bh, h),
    txSummary: (s) => getTxSummary(conn, s),
    newSignatures: (a, u) => getNewSignatures(conn, a, u),
    balances: (o, m) => getWalletBalances(conn, o, m),
    lamports: (o) => getLamports(conn, o),
    faucet: (q, to, raw, lamports) => sendFromTreasury(conn, needOperator(), q, to, raw, lamports),
    migrate: (pool) => runMigration(conn, needOperator(), pool),
    dammPoolFor: (b, q) => dammV2PoolFor(b, q),
  };
}
