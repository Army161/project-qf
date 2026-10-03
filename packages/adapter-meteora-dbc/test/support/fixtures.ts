// Shared MOCK fixtures for adapter tests: synthetic keys (no private keys exist), PDA-consistent pool and
// vault addresses, mock-RPC account data, and the approved terms + consent each built transaction is bound to.
// Nothing here is live chain data; transactions are never signed or sent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import * as dbc from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, cpAmmCoder, deriveTokenVaultAddress } from '@meteora-ag/cp-amm-sdk';
import { readFileSync } from 'node:fs';
import { PublicKey, Transaction } from '@solana/web3.js';
import { ECONOMICS_V0_TEST, STANDARD_V1_FLAT_V0_TEST, MIGRATION_POLICY_V0, proposeMigrationThreshold, type MigrationThresholdRecord } from '@project-qf/policy';
import { EVIDENCE_POLICY_V0_1 } from '@project-qf/validator';
import { PROGRAM_IDS, TX_BINDING_POLICY_VERSION, termsDigest, type ApprovedTerms, type ConsentRecord, type IntentKind } from '@project-qf/tx';
import { DAMM_V2_CUSTOMIZABLE_CONFIG, approvedConfigParametersDigest, buildCurveConfig, createDbcClient } from '../../src/index.ts';
import { createMockConnection, mockKey, zeroOf, type MockAccount } from './mockRpc.ts';

export const NOW = '2026-09-27T12:00:00.000Z';
export const BLOCKHASH = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W'; // synthetic
const QUOTE_DECIMALS = 6;
export const DBC = new PublicKey(PROGRAM_IDS.DBC);
export const DAMM = new PublicKey(PROGRAM_IDS.DAMM_V2);
export const TOKEN = new PublicKey(PROGRAM_IDS.TOKEN);

const base = { payer: mockKey('payer'), partner: mockKey('partner-fee-claimer'), creator: mockKey('creator'), crank: mockKey('crank'),
  config: mockKey('config'), baseMint: mockKey('base-mint'), quoteMint: mockKey('qusd-mint'), leftover: mockKey('leftover'), attacker: mockKey('attacker') };
const pool = dbc.deriveDbcPoolAddress(base.quoteMint, base.baseMint, base.config);
const dammPool = dbc.deriveDammV2PoolAddress(DAMM_V2_CUSTOMIZABLE_CONFIG, base.baseMint, base.quoteMint);
export const K = { ...base, pool, baseVault: dbc.deriveDbcTokenVaultAddress(pool, base.baseMint), quoteVault: dbc.deriveDbcTokenVaultAddress(pool, base.quoteMint),
  dammPool, dammBaseVault: deriveTokenVaultAddress(base.baseMint, dammPool), dammQuoteVault: deriveTokenVaultAddress(base.quoteMint, dammPool) };

/** TEST_ONLY: a graduated launch's DAMM v2 pool. The layout and curve values come from a public devnet pool account
 *  (test/fixtures/damm-v2-pool-devnet.json); its mints and vaults are re-keyed to the synthetic K addresses. */
export function dammPoolAccount(): Buffer {
  const f = JSON.parse(readFileSync(new URL('../fixtures/damm-v2-pool-devnet.json', import.meta.url), 'utf8')) as { dataBase64: string };
  const p = cpAmmCoder.accounts.decode('Pool', Buffer.from(f.dataBase64, 'base64')) as Record<string, any>;
  Object.assign(p, { token_a_mint: K.baseMint, token_b_mint: K.quoteMint, token_a_vault: K.dammBaseVault, token_b_vault: K.dammQuoteVault, activation_point: new BN(0) });
  const l = (cpAmmCoder.accounts as unknown as AnchorLike['coder']['accounts']).accountLayouts.get('Pool')!;
  const buf = Buffer.alloc(4096);
  return Buffer.concat([Buffer.from(l.discriminator), buf.subarray(0, l.layout.encode(p, buf))]);
}

export function thresholdRecord(): MigrationThresholdRecord {
  const r = proposeMigrationThreshold({
    policy: MIGRATION_POLICY_V0, evidencePolicy: EVIDENCE_POLICY_V0_1, now: NOW, quote: { mint: 'MOCKqUSD', decimals: QUOTE_DECIMALS },
    price: { status: 'OK', priceUsd: '1', sources: ['pyth-fixture', 'indexer-fixture'], observedAt: '2026-09-27T11:59:30.000Z', slot: '1' },
    liquidity: { id: 'S3.2', decision: 'PASS', reason: 'fixture', evidence: [], details: { eligibleUsd: '300000' }, policyVersion: 'validator-v0.1' },
    exitDepth: { id: 'S3.1', decision: 'PASS', reason: 'fixture', evidence: [], details: { notionalRaw: '5000000000' }, policyVersion: 'validator-v0.1' },
  });
  assert.equal(r.status, 'OK', r.reasons.join());
  return r.record!;
}

interface AnchorLike { idl: never; coder: { accounts: { accountLayouts: Map<string, { discriminator: number[]; layout: { encode(v: unknown, b: Buffer): number } }> } } }
export function fixtures() {
  const { connection: c0 } = createMockConnection(new Map());
  const program = dbc.createDbcProgram(c0).program as unknown as AnchorLike;
  const damm = (dbc.createDammV2Program(c0) as unknown as { program?: unknown }).program ?? dbc.createDammV2Program(c0);
  const cfgParams = buildCurveConfig(STANDARD_V1_FLAT_V0_TEST, ECONOMICS_V0_TEST, thresholdRecord());
  return { program, damm: damm as AnchorLike, cfgParams };
}
/** Borsh-encode a synthetic account with its Anchor discriminator (anchor's own encode() caps at 1000 bytes). */
function encodeAccount(p: AnchorLike, name: string, value: unknown): Buffer {
  const l = p.coder.accounts.accountLayouts.get(name);
  if (!l) throw new Error(`no layout ${name}`);
  const buf = Buffer.alloc(16_384);
  const n = l.layout.encode(value, buf);
  return Buffer.concat([Buffer.from(l.discriminator), buf.subarray(0, n)]);
}
function splMint(decimals: number): Buffer {
  const b = Buffer.alloc(82); b.writeBigUInt64LE(1_000_000_000_000n, 36); b.writeUInt8(decimals, 44); b.writeUInt8(1, 45); return b;
}

export async function accountsForPool(completed: boolean) {
  const { program, damm, cfgParams } = fixtures();
  const idl = program.idl as never;
  const cfg = zeroOf(idl, { defined: { name: 'poolConfig' } }) as Record<string, any>;
  Object.assign(cfg, { quoteMint: K.quoteMint, feeClaimer: K.partner, leftoverReceiver: K.leftover, collectFeeMode: 0,
    migrationOption: 1, activationType: 1, tokenDecimal: 6, tokenType: 0, quoteTokenFlag: 0, migrationFeeOption: 6,
    creatorTradingFeePercentage: 50, partnerPermanentLockedLiquidityPercentage: 50, creatorPermanentLockedLiquidityPercentage: 50,
    migrationQuoteThreshold: cfgParams.migrationQuoteThreshold, sqrtStartPrice: cfgParams.sqrtStartPrice, migratedPoolFeeBps: 100 });
  cfg.poolFees.baseFee = { ...cfg.poolFees.baseFee, cliffFeeNumerator: cfgParams.poolFees.baseFee.cliffFeeNumerator, baseFeeMode: 0 };
  cfgParams.curve.forEach((p, k) => { cfg.curve[k] = { sqrtPrice: p.sqrtPrice, liquidity: p.liquidity }; });
  const poolState = zeroOf(idl, { defined: { name: 'virtualPool' } }) as Record<string, any>;
  Object.assign(poolState.poolState, { config: K.config, creator: K.creator, baseMint: K.baseMint, baseVault: K.baseVault, quoteVault: K.quoteVault,
    sqrtPrice: cfgParams.sqrtStartPrice, quoteReserve: completed ? cfgParams.migrationQuoteThreshold : new BN(0),
    partnerQuoteFee: new BN(1_000_000), creatorQuoteFee: new BN(1_000_000), migrationProgress: completed ? 3 : 0 });
  const dammCfg = zeroOf(damm.idl as never, { defined: { name: 'config' } }) as Record<string, any>;
  const accounts = new Map<string, MockAccount>([
    [K.config.toBase58(), { owner: DBC, data: encodeAccount(program, 'poolConfig', cfg) }],
    [K.pool.toBase58(), { owner: DBC, data: encodeAccount(program, 'virtualPool', poolState) }],
    [K.quoteMint.toBase58(), { owner: TOKEN, data: splMint(6) }],
    [K.baseMint.toBase58(), { owner: TOKEN, data: splMint(6) }],
    [DAMM_V2_CUSTOMIZABLE_CONFIG.toBase58(), { owner: DAMM, data: encodeAccount(damm, 'config', dammCfg) }],
    [K.dammPool.toBase58(), { owner: DAMM, data: dammPoolAccount() }],
  ]);
  return { accounts, program, cfgParams };
}

// ---------- approved terms + consent for each fixture transaction ----------
const s = (k: PublicKey) => k.toBase58();
const compute = (maxUnitLimit = 400_000) => ({ maxUnitLimit, maxUnitPriceMicroLamports: '100000' });
const common = { cluster: 'mock-offline' as const, policyVersion: TX_BINDING_POLICY_VERSION };
const mints = { baseMint: s(K.baseMint), quoteMint: s(K.quoteMint), baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN };
export const FIXTURE_EVIDENCE_DIGEST = createHash('sha256').update('QF-FIXTURE-EVIDENCE').digest('hex');

export async function termsFor(kind: IntentKind, cfgParams?: dbc.ConfigParameters): Promise<ApprovedTerms> {
  switch (kind) {
    case 'CREATE_CONFIG': return { ...common, kind, feePayer: s(K.partner), compute: compute(), config: s(K.config), payer: s(K.partner), feeClaimer: s(K.partner),
      leftoverReceiver: s(K.leftover), quoteMint: s(K.quoteMint), configParametersDigest: await approvedConfigParametersDigest(cfgParams!) };
    case 'CREATE_POOL': return { ...common, kind, feePayer: s(K.creator), compute: compute(), config: s(K.config), creator: s(K.creator), payer: s(K.creator),
      baseMint: s(K.baseMint), quoteMint: s(K.quoteMint), quoteTokenProgram: PROGRAM_IDS.TOKEN, name: 'MOCK', symbol: 'MOCK', uri: 'https://example.invalid/mock.json' };
    case 'SWAP': return { ...common, ...mints, kind, feePayer: s(K.creator), compute: compute(), config: s(K.config), pool: s(K.pool), user: s(K.creator),
      direction: 'QUOTE_TO_BASE', amountIn: '1000000', minimumAmountOut: '1', referralTokenAccount: null, allowSysvarInstructions: false };
    case 'MIGRATE_DAMM_V2': return { ...common, ...mints, kind, feePayer: s(K.crank), compute: compute(600_000), config: s(K.config), pool: s(K.pool),
      payer: s(K.crank), dammConfig: s(DAMM_V2_CUSTOMIZABLE_CONFIG) };
    case 'DAMM_SWAP': return { ...common, ...mints, kind, feePayer: s(K.creator), compute: compute(), dammConfig: s(DAMM_V2_CUSTOMIZABLE_CONFIG), pool: s(K.dammPool),
      user: s(K.creator), direction: 'QUOTE_TO_BASE', amountIn: '1000000', minimumAmountOut: '1' };
    case 'CLAIM_PARTNER_TRADING_FEE': return { ...common, ...mints, kind, feePayer: s(K.partner), compute: compute(), config: s(K.config), pool: s(K.pool),
      feeClaimer: s(K.partner), receiver: s(K.partner), maxBaseAmount: '0', maxQuoteAmount: '1000000' };
    case 'CLAIM_CREATOR_TRADING_FEE': return { ...common, ...mints, kind, feePayer: s(K.creator), compute: compute(), config: s(K.config), pool: s(K.pool),
      creator: s(K.creator), receiver: s(K.creator), maxBaseAmount: '0', maxQuoteAmount: '1000000' };
    default: throw new Error(`no fixture terms for ${kind}`);
  }
}
export async function consentFor(terms: ApprovedTerms): Promise<ConsentRecord> {
  return { termsDigest: await termsDigest(terms), cluster: terms.cluster, policyVersion: terms.policyVersion, evidenceDigest: FIXTURE_EVIDENCE_DIGEST,
    acknowledgementDigest: null, approvedAt: NOW };
}

/** Builds the SDK transaction for `kind` against MOCK RPC, with the fee payer and signer it is bound to. */
export async function buildFixtureTx(kind: IntentKind): Promise<{ tx: Transaction; feePayer: PublicKey; signer: PublicKey; cfgParams: dbc.ConfigParameters; program: any; unsupported: string[] }> {
  const { accounts, program, cfgParams } = await accountsForPool(kind === 'MIGRATE_DAMM_V2');
  const { connection, unsupported } = createMockConnection(accounts);
  const c = createDbcClient(connection);
  switch (kind) {
    case 'CREATE_CONFIG': return { tx: await c.partner.createConfig({ ...(cfgParams as object), config: K.config, feeClaimer: K.partner, leftoverReceiver: K.leftover,
      quoteMint: K.quoteMint, payer: K.partner } as never), feePayer: K.partner, signer: K.partner, cfgParams, program, unsupported };
    case 'CREATE_POOL': return { tx: await c.creator.createPool({ name: 'MOCK', symbol: 'MOCK', uri: 'https://example.invalid/mock.json', payer: K.creator,
      poolCreator: K.creator, config: K.config, baseMint: K.baseMint }), feePayer: K.creator, signer: K.creator, cfgParams, program, unsupported };
    case 'SWAP': return { tx: await c.pool.swap({ owner: K.creator, pool: K.pool, amountIn: new BN(1_000_000), minimumAmountOut: new BN(1), swapBaseForQuote: false,
      referralTokenAccount: null }), feePayer: K.creator, signer: K.creator, cfgParams, program, unsupported };
    case 'DAMM_SWAP': return { tx: await new CpAmm(connection).swap({ payer: K.creator, pool: K.dammPool, inputTokenMint: K.quoteMint, outputTokenMint: K.baseMint,
      amountIn: new BN(1_000_000), minimumAmountOut: new BN(1), tokenAVault: K.dammBaseVault, tokenBVault: K.dammQuoteVault, tokenAMint: K.baseMint, tokenBMint: K.quoteMint,
      tokenAProgram: TOKEN, tokenBProgram: TOKEN, referralTokenAccount: null } as never), feePayer: K.creator, signer: K.creator, cfgParams, program, unsupported };
    case 'MIGRATE_DAMM_V2': return { tx: (await c.migration.migrateToDammV2({ payer: K.crank, pool: K.pool, dammConfig: DAMM_V2_CUSTOMIZABLE_CONFIG })).transaction,
      feePayer: K.crank, signer: K.crank, cfgParams, program, unsupported };
    case 'CLAIM_PARTNER_TRADING_FEE': return { tx: await c.partner.claimPartnerTradingFee({ feeClaimer: K.partner, payer: K.partner, pool: K.pool,
      maxBaseAmount: new BN(0), maxQuoteAmount: new BN(1_000_000) }), feePayer: K.partner, signer: K.partner, cfgParams, program, unsupported };
    case 'CLAIM_CREATOR_TRADING_FEE': return { tx: await c.creator.claimCreatorTradingFee({ creator: K.creator, payer: K.creator, pool: K.pool,
      maxBaseAmount: new BN(0), maxQuoteAmount: new BN(1_000_000) }), feePayer: K.creator, signer: K.creator, cfgParams, program, unsupported };
    default: throw new Error(`no fixture tx for ${kind}`);
  }
}
