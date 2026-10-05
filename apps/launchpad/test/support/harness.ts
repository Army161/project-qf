// Shared test harness: the launchpad API over HTTP with an in-process chain double. Transactions are built by the real
// adapter against the MOCK RPC fixtures (synthetic accounts, nothing live) and "sent" to a recorder. No network, no
// real keys. Every value here is TEST_ONLY.
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { economicsDigest } from '@project-qf/policy';
import { decodeTransactionBytes, squads, verifyWireSignatures, PROGRAM_IDS, SQUADS_IDL_SUBSET } from '@project-qf/tx';
import { buildTreasuryApprove, buildTreasuryExecute, buildTreasuryProposeAt, partnerCurveClaim, vaultDammClaim, type ProposalState } from '@project-qf/adapter-meteora-dbc/treasury';
import { storedVaultTransaction } from '../../../../packages/adapter-meteora-dbc/test/support/treasury.ts';
import { buildCreatePool, buildCreatorCurveClaim, buildDammClaim, buildDammSwap, buildSwap, quoteDammSwap, quoteSwap, readDammPool, readPool } from '@project-qf/adapter-meteora-dbc/launchpad';
import { createQuoteSimulator } from '@project-qf/adapter-meteora-dbc';
import { accountsForPool, fixtures, K, thresholdRecord } from '../../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import { createMockConnection } from '../../../../packages/adapter-meteora-dbc/test/support/mockRpc.ts';
import type { LaunchpadChain } from '../../src/chain.ts';
import { launchEconomicsFor, type PlatformRecord } from '../../src/platform.ts';
import { createLaunchpadApp } from '../../src/server.ts';
import { LaunchpadStore } from '../../src/store.ts';

export const dir = mkdtempSync(join(tmpdir(), 'qf-lp-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
export const BLOCKHASH = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W';

export async function mockConn() {
  const { accounts } = await accountsForPool(false);
  const { connection } = createMockConnection(accounts);
  Object.assign(connection, { getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }) });
  return connection;
}

export function platformRecord(): PlatformRecord {
  const threshold = thresholdRecord();
  const quote = { mint: K.quoteMint.toBase58(), decimals: 6 };
  const launchEconomics = launchEconomicsFor(K.config.toBase58(), quote, threshold);
  return { cluster: 'devnet', operator: K.partner.toBase58(), quote: { ...quote, supplyRaw: '1', signature: 'x', label: 'TEST_ONLY', symbol: 'qUSD' }, threshold,
    config: { config: K.config.toBase58(), quoteMint: quote.mint, feeClaimer: K.partner.toBase58(), leftoverReceiver: K.leftover.toBase58(), signature: 'x' },
    economicsVersion: 'e', templateVersion: 't', launchEconomics, launchEconomicsDigest: economicsDigest(launchEconomics), createdAt: new Date().toISOString() };
}

// The adapter fixture config predates migrationSqrtPrice; fill it from the same curve simulator the adapter tests use.
export function withMigrationPrice<T extends { raw: { config: unknown } } | null>(pool: T): T {
  if (!pool) return pool;
  const { cfgParams } = fixtures();
  const BNc = (cfgParams.migrationQuoteThreshold as unknown as { constructor: new (s: string) => unknown }).constructor;
  (pool.raw.config as Record<string, unknown>).migrationSqrtPrice = new BNc(createQuoteSimulator(cfgParams).migrationSqrtPrice.toString());
  return pool;
}

/** A fresh store, chain double and running app. `dbPath` lets a test reopen the same database to simulate a restart. */
export async function harness() {
  const conn = await mockConn();
  const sent: Uint8Array[] = [];
  const faucetCalls: unknown[] = [];
  // TEST_ONLY Squads double: proposals advance when the recorder "sends" a member transaction, as the program would.
  const tre = { multisig: '', vault: '', members: [] as string[], threshold: 2, nextIndex: 1n, proposals: new Map<string, NonNullable<ProposalState> & { stored: Uint8Array }>() };
  const squadsOp = (dataHex: string) => SQUADS_IDL_SUBSET.instructions.find((i) => i.discriminator.every((b, k) => parseInt(dataHex.slice(2 * k, 2 * k + 2), 16) === b))?.name;
  const applySquads = async (b: Uint8Array) => {
    for (const ix of decodeTransactionBytes(b).instructions.filter((x) => x.programAddress === PROGRAM_IDS.SQUADS_V4)) {
      const op = squadsOp(ix.dataHex);
      const indexOfProposal = async (proposal: string) => { for (const k of tre.proposals.keys()) if (await squads.squadsProposal(tre.multisig, BigInt(k)) === proposal) return k; return null; };
      if (op === 'vault_transaction_create') {
        const index = tre.nextIndex++;
        const stored = storedVaultTransaction({ data: Buffer.from(ix.dataHex, 'hex') }, { multisig: tre.multisig, creator: ix.accounts[2]!, index });
        tre.proposals.set(index.toString(), { status: 'Active', approved: [], rejected: [], cancelled: [], stored });
      } else if (op === 'proposal_approve') {
        const k = await indexOfProposal(ix.accounts[2]!);
        const p = k ? tre.proposals.get(k) : null;
        if (p) { p.approved.push(ix.accounts[1]!); if (p.approved.length >= tre.threshold) p.status = 'Approved'; }
      } else if (op === 'vault_transaction_execute') {
        const k = await indexOfProposal(ix.accounts[1]!);
        const p = k ? tre.proposals.get(k) : null;
        if (p) p.status = 'Executed';
      }
    }
  };
  const chain: LaunchpadChain = {
    operatorAddress: K.partner.toBase58(),
    readPool: async (p) => withMigrationPrice(await readPool(conn, p)),
    buildCreatePool: (r) => buildCreatePool(conn, r),
    buildSwap: (pool, r, now) => buildSwap(conn, pool, r, now),
    quoteSwap,
    readDammPool: (p, e) => readDammPool(conn, p, e),
    dammNow: async () => 1_790_000_000n,
    quoteDammSwap,
    buildDammSwap: (p, r, now) => buildDammSwap(conn, p, r, now),
    buildCreatorCurveClaim: (p, c) => buildCreatorCurveClaim(conn, p, c),
    // The MOCK RPC has no getProgramAccounts: the creator holds one locked position (TEST_ONLY numbers), nobody else holds any.
    dammPositions: async (_p, owner) => owner === K.creator.toBase58()
      ? [{ position: 'pos', nftMint: K.positionNft.toBase58(), feeBaseRaw: '0', feeQuoteRaw: '500000', permanentlyLocked: true }] : [],
    buildDammClaim: (p, owner, nft) => buildDammClaim(conn, p, owner, nft),
    send: async (b) => { sent.push(b); await applySquads(b); return (await verifyWireSignatures(b)).firstSignature; },
    txSummary: async () => null,
    newSignatures: async () => [],
    balances: async () => ({ lamports: '0', tokens: {} }),
    lamports: async () => 0n,
    faucet: async (...a) => { faucetCalls.push(a); return 'faucet-sig'; },
    migrate: async () => 'migrate-sig',
    dammPoolFor: async () => K.pool.toBase58(),
    readTreasury: async (m) => ({ multisig: m, vault: tre.vault, threshold: tre.threshold, timeLock: 0, configAuthority: null, members: tre.members.map((key) => ({ key, mask: 7 })),
      transactionIndex: tre.nextIndex - 1n, staleTransactionIndex: 0n }),
    buildTreasuryPropose: async (multisig, vault, member, c) => {
      const claim = c.venue === 'CURVE' ? await partnerCurveClaim(conn, c.pool, vault) : await vaultDammClaim(conn, c.pool, vault, c.nftMint, c.amounts);
      return { ...(await buildTreasuryProposeAt(conn, { multisig, member, transactionIndex: tre.nextIndex, claim })), amounts: claim.amounts };
    },
    buildTreasuryApprove: (multisig, member, transactionIndex) => buildTreasuryApprove(conn, { multisig, member, transactionIndex }),
    buildTreasuryExecute: (r) => buildTreasuryExecute(conn, r),
    vaultTransaction: async (_m, i) => tre.proposals.get(i)?.stored ?? null,
    proposal: async (_m, i) => { const p = tre.proposals.get(i); return p ? { status: p.status, approved: [...p.approved], rejected: [], cancelled: [] } : null; },
  };
  const dbPath = join(dir, `lp-${Math.random().toString(36).slice(2)}.sqlite`);
  const store = new LaunchpadStore(dbPath);
  const platform = platformRecord();
  let clock = Date.now();
  const app = createLaunchpadApp({ store, chain, platform: () => platform, staticDir: null, publicBaseUrl: 'http://127.0.0.1:8788', now: () => new Date(clock) });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  after(() => { app.close(); try { store.close(); } catch { /* a test may have closed it to simulate a restart */ } });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers };
  };
  return { conn, store, dbPath, platform, call, sent, faucetCalls, chain, app, tre, tick: (ms: number) => { clock += ms; }, now: () => new Date(clock) };
}

/** Records the fixture coin (mint K.baseMint on pool K.pool) as LIVE, and optionally graduated to the fixture DAMM v2 pool. */
export function seedLaunch(store: LaunchpadStore, platform: PlatformRecord, o: { creator?: string; migrated?: boolean; symbol?: string } = {}) {
  const t = new Date().toISOString(), mint = K.baseMint.toBase58();
  store.insertPendingLaunch({ mint, pool: K.pool.toBase58(), config: platform.config.config, quoteMint: platform.quote.mint, creator: o.creator ?? K.creator.toBase58(),
    name: 'MOCK', symbol: o.symbol ?? 'MOCK', description: '', website: null, twitter: null, telegram: null, imageType: null, metadataUri: 'http://127.0.0.1:8788/m/x.json', createdAt: t }, null);
  store.markLaunchLive(mint, 'sig', t);
  if (o.migrated) store.markLaunchMigrated(mint, 'mig', K.dammPool.toBase58(), t);
  return mint;
}
