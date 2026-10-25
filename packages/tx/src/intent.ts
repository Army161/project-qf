// Transaction-intent validation: a QF domain object checked BEFORE any transaction bytes exist.
// There is no submit function anywhere in this package.
import { isAddress } from '@solana/kit';
import { CAPABILITY_FLAGS, READINESS, type Cluster } from '@project-qf/core';

// Project QF's own engine (ADR-014): every one is signed and paid for by the person's own wallet.
export type IntentKind = 'QF_CREATE' | 'QF_SWAP' | 'QF_POOL_SWAP' | 'QF_CLAIM_CREATOR_FEES' | 'QF_COLLECT_POOL_CREATOR_FEE';
export type SignerRole = 'USER_WALLET';

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

const KINDS = new Set<string>(['QF_CREATE', 'QF_SWAP', 'QF_POOL_SWAP', 'QF_CLAIM_CREATOR_FEES', 'QF_COLLECT_POOL_CREATOR_FEE']);
const NEEDS_CONSENT = new Set<IntentKind>(['QF_CREATE']);
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

  if (!KINDS.has(i.kind)) v.push(`UNKNOWN_KIND ${String(i.kind)}`);

  switch (i.cluster) {
    case 'mainnet-beta': if ((flags.MAINNET_WRITES as boolean) !== true) v.push('MAINNET_WRITES disabled'); break;
    case 'devnet': if (readiness.DEVNET_INTEGRATION.status !== 'ACTIVE') v.push('stage DEVNET_INTEGRATION is BLOCKED'); break;
    case 'localnet': if (readiness.LOCALNET_INTEGRATION.status !== 'ACTIVE') v.push('stage LOCALNET_INTEGRATION is BLOCKED'); break;
    case 'mock-offline': if (!i.mock) v.push('cluster mock-offline requires mock=true'); break;
    default: v.push(`UNKNOWN_CLUSTER ${String(i.cluster)}`);
  }
  if (i.mock && i.cluster !== 'mock-offline') v.push('MOCK_INTENT_ON_REAL_CLUSTER');

  if (i.signer.role !== 'USER_WALLET') v.push(`ROLE_MISMATCH ${i.kind} requires USER_WALLET`);
  if (i.signer.serverHeld) v.push('SERVER_NEVER_SIGNS_FOR_USER');
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
