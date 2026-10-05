// Platform setup for the devnet launchpad: the TEST_ONLY quote token (qUSD, DEVNET.md step 2), the migration threshold
// record, and the one DBC config every launch uses (DEVNET.md step 5). Economics and the curve template are the
// existing V0_TEST policy objects; nothing here is a production selection.
import {
  ECONOMICS_V0_TEST, MIGRATION_POLICY_V0, STANDARD_V1_FLAT_V0_TEST, economicsDigest, proposeMigrationThreshold, validateCurveTemplate,
  validateEconomics, assertTemplateUsableFor, type MigrationThresholdRecord,
} from '@project-qf/policy';
import { EVIDENCE_POLICY_V0_1 } from '@project-qf/validator';
import { buildCurveConfig } from '@project-qf/adapter-meteora-dbc';
import {
  createPlatformConfig, createTestQuoteMint, getLamports, publicKeyOf, sendFromTreasury, type DevnetConnection, type DevnetSigner, type PlatformConfig, type TestQuoteMint,
} from '@project-qf/adapter-meteora-dbc/launchpad';
import { createTreasuryMultisig, type TreasuryRecord } from '@project-qf/adapter-meteora-dbc/treasury';
import type { LaunchpadStore } from './store.ts';

export const QUOTE_SYMBOL = 'qUSD';
/** Devnet launch threshold: the migration policy floor (1,000 USD-equivalent at the TEST_ONLY par price). */
export const DEVNET_REQUESTED_USD = '1000';

export interface PlatformRecord {
  cluster: 'devnet';
  operator: string;
  quote: TestQuoteMint & { symbol: string };
  threshold: MigrationThresholdRecord;
  /** The config new launches use. With a treasury it pays platform fees to the treasury vault. */
  config: PlatformConfig;
  /** Earlier configs: coins launched on them keep them for life (the DBC program cannot change a config's fee claimer). */
  legacyConfigs?: PlatformConfig[];
  /** Devnet stand-in platform treasury: a 2-of-3 Squads multisig of throwaway member keys (milestone 7). */
  treasury?: TreasuryRecord;
  economicsVersion: string;
  templateVersion: string;
  /** What a creator consents to: canonical digest of the launch economics shown in the UI (recomputed in the browser). */
  launchEconomics: LaunchEconomics;
  launchEconomicsDigest: string;
  createdAt: string;
}
export interface LaunchEconomics {
  domain: 'QF-LAUNCH-ECONOMICS';
  cluster: 'devnet';
  config: string;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  economics: typeof ECONOMICS_V0_TEST;
  templateVersion: string;
  totalSupply: string;
  baseDecimals: number;
  percentageSupplyOnMigration: number;
  migrationQuoteThresholdRaw: string;
}

/** TEST_ONLY par price evidence for the synthetic devnet quote. Clearly labelled; never valid for a real asset. */
export function testOnlyThreshold(quoteMint: string, decimals: number, now: Date): MigrationThresholdRecord {
  const at = now.toISOString();
  const r = proposeMigrationThreshold({
    policy: MIGRATION_POLICY_V0, evidencePolicy: EVIDENCE_POLICY_V0_1, now: at, requestedUsd: DEVNET_REQUESTED_USD,
    quote: { mint: quoteMint, decimals },
    price: { status: 'OK', priceUsd: '1', sources: ['test-only:qusd-par-a', 'test-only:qusd-par-b'], observedAt: at },
    liquidity: { id: 'S3.2', decision: 'PASS', reason: 'TEST_ONLY synthetic devnet quote (operator holds the fixed supply)', evidence: [],
      details: { eligibleUsd: '1000000000' }, policyVersion: 'validator-v0.1' },
    exitDepth: { id: 'S3.1', decision: 'PASS', reason: 'TEST_ONLY synthetic devnet quote', evidence: [], details: { notionalRaw: (10n ** 18n).toString() },
      policyVersion: 'validator-v0.1' },
  } as never);
  if (r.status !== 'OK' || !r.record) throw new Error(`threshold proposal ${r.status}: ${r.reasons.join('; ')}`);
  return r.record;
}

export function launchEconomicsFor(config: string, quote: { mint: string; decimals: number }, threshold: MigrationThresholdRecord): LaunchEconomics {
  return {
    domain: 'QF-LAUNCH-ECONOMICS', cluster: 'devnet', config, quoteMint: quote.mint, quoteSymbol: QUOTE_SYMBOL, quoteDecimals: quote.decimals,
    economics: ECONOMICS_V0_TEST, templateVersion: STANDARD_V1_FLAT_V0_TEST.version, totalSupply: STANDARD_V1_FLAT_V0_TEST.token.totalTokenSupply,
    baseDecimals: STANDARD_V1_FLAT_V0_TEST.token.tokenBaseDecimal, percentageSupplyOnMigration: STANDARD_V1_FLAT_V0_TEST.percentageSupplyOnMigration,
    migrationQuoteThresholdRaw: threshold.rawQuoteThreshold,
  };
}

/** Idempotent: creates whatever part of the platform is missing and returns the stored record. */
export async function ensurePlatform(conn: DevnetConnection, operator: DevnetSigner, store: LaunchpadStore, log: (m: string) => void = () => {}): Promise<PlatformRecord> {
  const existing = store.getPlatform<PlatformRecord>('platform');
  if (existing) return existing;
  const ev = validateEconomics(ECONOMICS_V0_TEST), tv = validateCurveTemplate(STANDARD_V1_FLAT_V0_TEST, ECONOMICS_V0_TEST);
  if (ev.length || tv.length) throw new Error(`policy invalid: ${[...ev, ...tv].join('; ')}`);
  assertTemplateUsableFor(STANDARD_V1_FLAT_V0_TEST, 'TX_INTENT');

  let quote = store.getPlatform<TestQuoteMint>('quote');
  if (!quote) {
    log('creating TEST_ONLY quote token qUSD (fixed supply, mint authority revoked)');
    quote = await createTestQuoteMint(conn, operator);
    store.setPlatform('quote', quote);
  }
  const threshold = testOnlyThreshold(quote.mint, quote.decimals, new Date());
  const params = buildCurveConfig(STANDARD_V1_FLAT_V0_TEST, ECONOMICS_V0_TEST, threshold);
  log(`creating DBC config (threshold ${threshold.rawQuoteThreshold} raw qUSD)`);
  const config = await createPlatformConfig(conn, operator, quote.mint, params);
  const launchEconomics = launchEconomicsFor(config.config, quote, threshold);
  const rec: PlatformRecord = {
    cluster: 'devnet', operator: publicKeyOf(operator), quote: { ...quote, symbol: QUOTE_SYMBOL }, threshold, config,
    economicsVersion: ECONOMICS_V0_TEST.version, templateVersion: STANDARD_V1_FLAT_V0_TEST.version,
    launchEconomics, launchEconomicsDigest: economicsDigest(launchEconomics), createdAt: new Date().toISOString(),
  };
  store.setPlatform('platform', rec);
  return rec;
}

/** The platform fee claimer of the config a coin launched on (its curve fees and, after graduation, its partner LP NFT). */
export function feeClaimerFor(p: PlatformRecord, config: string): string | null {
  return [p.config, ...(p.legacyConfigs ?? [])].find((c) => c.config === config)?.feeClaimer ?? null;
}
export const isTreasuryConfig = (p: PlatformRecord, config: string) => !!p.treasury && feeClaimerFor(p, config) === p.treasury.vault;

export const TREASURY_THRESHOLD = 2;
/** Devnet SOL the vault keeps for rent of the token accounts its claims create (it pays them itself inside a claim). */
export const VAULT_SOL_LAMPORTS = 100_000_000n;
/** Devnet SOL each member keeps for its own transaction fees and proposal rent (members pay for themselves). */
export const MEMBER_SOL_LAMPORTS = 50_000_000n;

/**
 * Idempotent, step by step: creates the 2-of-3 treasury multisig from three member PUBLIC keys (the operator pays and is
 * not a member), gives the vault and the members a little devnet SOL, then creates a new DBC config with the same
 * economics whose fee claimer and leftover receiver are the vault, and makes it the config new launches use. Coins
 * already launched keep their config. Each finished step is stored, so a re-run continues instead of repeating it.
 */
export async function setupTreasury(conn: DevnetConnection, operator: DevnetSigner, store: LaunchpadStore, members: string[], log: (m: string) => void = () => {}): Promise<PlatformRecord> {
  const p = store.getPlatform<PlatformRecord>('platform');
  if (!p) throw new Error('PLATFORM_NOT_READY run setup first');
  if (p.treasury && p.config.feeClaimer === p.treasury.vault) return p;
  let t = store.getPlatform<TreasuryRecord>('treasury');
  if (!t) {
    log(`creating the ${TREASURY_THRESHOLD}-of-${members.length} treasury multisig (devnet stand-in; operator pays, is not a member)`);
    t = await createTreasuryMultisig(conn, operator, members, TREASURY_THRESHOLD);
    store.setPlatform('treasury', t);
  } else if ([...t.members].sort().join() !== [...members].sort().join()) throw new Error('TREASURY_MEMBERS_DIFFER the stored treasury has other members');
  for (const [who, want] of [[t.vault, VAULT_SOL_LAMPORTS], ...t.members.map((m) => [m, MEMBER_SOL_LAMPORTS] as const)] as const) {
    const have = await getLamports(conn, who);
    if (have < want) { log(`funding ${who} with ${want - have} devnet lamports`); await sendFromTreasury(conn, operator, p.quote.mint, who, 0n, want - have); }
  }
  let cfg = store.getPlatform<PlatformConfig>('treasury-config');
  if (!cfg) {
    const params = buildCurveConfig(STANDARD_V1_FLAT_V0_TEST, ECONOMICS_V0_TEST, p.threshold);
    log('creating the treasury DBC config (same economics; fee claimer and leftover receiver = treasury vault)');
    cfg = await createPlatformConfig(conn, operator, p.quote.mint, params, { feeClaimer: t.vault, leftoverReceiver: t.vault });
    store.setPlatform('treasury-config', cfg);
  }
  const launchEconomics = launchEconomicsFor(cfg.config, p.quote, p.threshold);
  const next: PlatformRecord = { ...p, config: cfg, legacyConfigs: [p.config, ...(p.legacyConfigs ?? [])], treasury: t,
    launchEconomics, launchEconomicsDigest: economicsDigest(launchEconomics) };
  store.setPlatform('platform', next);
  return next;
}
