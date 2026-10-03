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
  createPlatformConfig, createTestQuoteMint, publicKeyOf, type DevnetConnection, type DevnetSigner, type PlatformConfig, type TestQuoteMint,
} from '@project-qf/adapter-meteora-dbc/launchpad';
import type { LaunchpadStore } from './store.ts';

export const QUOTE_SYMBOL = 'qUSD';
/** Devnet launch threshold: the migration policy floor (1,000 USD-equivalent at the TEST_ONLY par price). */
export const DEVNET_REQUESTED_USD = '1000';

export interface PlatformRecord {
  cluster: 'devnet';
  operator: string;
  quote: TestQuoteMint & { symbol: string };
  threshold: MigrationThresholdRecord;
  config: PlatformConfig;
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
