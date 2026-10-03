// Transaction-intent validation: a QF domain object checked BEFORE any transaction bytes exist.
// There is no submit function anywhere in this package.
import { isAddress } from '@solana/kit';
import { CAPABILITY_FLAGS, READINESS, type Cluster } from '@project-qf/core';

export type IntentKind = 'CREATE_CONFIG' | 'CREATE_POOL' | 'SWAP' | 'MIGRATE_DAMM_V2' | 'DAMM_SWAP'
  | 'CLAIM_PARTNER_TRADING_FEE' | 'CLAIM_CREATOR_TRADING_FEE'
  | 'CREATE_CONFIG_TRANSFER_FEE' | 'CREATE_CONFIG_TRANSFER_HOOK';
export type SignerRole = 'USER_WALLET' | 'CONFIG_OWNER' | 'FEE_CLAIMER' | 'MIGRATION_CRANK';

export interface TxIntent {
  intentId: string;
  kind: IntentKind;
  cluster: Cluster;
  mock: boolean;
  signer: { role: SignerRole; address: string; serverHeld: boolean };
  feePayer: string;
  templateUsage?: 'V0_TEST_BASELINE' | 'SIMULATION_ONLY';
  economicsDigest?: string;
  consentDigest?: string;
  createdAt: string;
  expiresAt: string;
  amounts?: Record<string, string>;
}

const ROLE_FOR: Record<IntentKind, SignerRole> = {
  CREATE_CONFIG: 'CONFIG_OWNER', CREATE_POOL: 'USER_WALLET', SWAP: 'USER_WALLET', MIGRATE_DAMM_V2: 'MIGRATION_CRANK', DAMM_SWAP: 'USER_WALLET',
  CLAIM_PARTNER_TRADING_FEE: 'FEE_CLAIMER', CLAIM_CREATOR_TRADING_FEE: 'USER_WALLET',
  CREATE_CONFIG_TRANSFER_FEE: 'CONFIG_OWNER', CREATE_CONFIG_TRANSFER_HOOK: 'CONFIG_OWNER',
};
const NEEDS_CONSENT = new Set<IntentKind>(['CREATE_CONFIG', 'CREATE_POOL']);
const MULTISIG_ROLES = new Set<SignerRole>(['CONFIG_OWNER', 'FEE_CLAIMER']);
const U64_MAX = 2n ** 64n - 1n;
const SKEW_MS = 5_000;

export interface IntentContext {
  now: string;
  approvedEconomicsDigest?: string;
  flags?: typeof CAPABILITY_FLAGS;
  readiness?: typeof READINESS;
}

export function validateIntent(i: TxIntent, ctx: IntentContext): { ok: boolean; mock: boolean; violations: string[] } {
  const flags = ctx.flags ?? CAPABILITY_FLAGS;
  const readiness = ctx.readiness ?? READINESS;
  const v: string[] = [];

  if (i.kind === 'CREATE_CONFIG_TRANSFER_FEE' && flags.DBC_BASE_TRANSFER_FEE !== ('ENABLED' as string)) v.push('CAPABILITY_DISABLED DBC_BASE_TRANSFER_FEE');
  if (i.kind === 'CREATE_CONFIG_TRANSFER_HOOK') v.push('NOT_IN_V1_SCOPE transfer-hook configs');

  switch (i.cluster) {
    case 'mainnet-beta': if ((flags.MAINNET_WRITES as boolean) !== true) v.push('MAINNET_WRITES disabled'); break;
    case 'devnet': if (readiness.DEVNET_INTEGRATION.status !== 'ACTIVE') v.push('stage DEVNET_INTEGRATION is BLOCKED'); break;
    case 'localnet': if (readiness.LOCALNET_INTEGRATION.status !== 'ACTIVE') v.push('stage LOCALNET_INTEGRATION is BLOCKED'); break;
    case 'mock-offline': if (!i.mock) v.push('cluster mock-offline requires mock=true'); break;
    default: v.push(`UNKNOWN_CLUSTER ${String(i.cluster)}`);
  }
  if (i.mock && i.cluster !== 'mock-offline') v.push('MOCK_INTENT_ON_REAL_CLUSTER');

  if (i.signer.role !== ROLE_FOR[i.kind]) v.push(`ROLE_MISMATCH ${i.kind} requires ${ROLE_FOR[i.kind]}`);
  if (i.signer.role === 'USER_WALLET' && i.signer.serverHeld) v.push('SERVER_NEVER_SIGNS_FOR_USER');
  if (MULTISIG_ROLES.has(i.signer.role) && i.signer.serverHeld) v.push(`MULTISIG_ROLE_SERVER_HELD ${i.signer.role}`);
  if (!isAddress(i.signer.address)) v.push('SIGNER_ADDRESS_INVALID');
  if (!isAddress(i.feePayer)) v.push('FEE_PAYER_INVALID');

  if (i.templateUsage === 'SIMULATION_ONLY') v.push('TEMPLATE_SIMULATION_ONLY');
  if (NEEDS_CONSENT.has(i.kind)) {
    if (!i.economicsDigest || !i.consentDigest) v.push('CONSENT_MISSING');
    else {
      if (i.economicsDigest !== ctx.approvedEconomicsDigest) v.push('ECONOMICS_NOT_APPROVED');
      if (i.consentDigest !== i.economicsDigest) v.push('CONSENT_MISMATCH');
    }
  }

  const now = Date.parse(ctx.now), created = Date.parse(i.createdAt), expires = Date.parse(i.expiresAt);
  if (![now, created, expires].every(Number.isFinite)) v.push('BAD_TIMESTAMP');
  else {
    if (created > now + SKEW_MS) v.push('CREATED_IN_FUTURE');
    if (now >= expires) v.push('EXPIRED');
  }

  for (const [k, s] of Object.entries(i.amounts ?? {})) {
    if (!/^\d+$/.test(s)) { v.push(`AMOUNT_NOT_RAW_INTEGER ${k}`); continue; }
    const n = BigInt(s);
    if (n <= 0n || n > U64_MAX) v.push(`AMOUNT_OUT_OF_RANGE ${k}`);
  }
  return { ok: v.length === 0, mock: i.mock, violations: v };
}
