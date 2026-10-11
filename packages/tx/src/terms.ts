// Approved transaction terms: what a person (or, for MIGRATE, the operator) consented to, per operation.
// A preview binds decoded wire bytes to these terms; a program allowlist alone is never sufficient (QF-SEC-01).
// Runtime-validated because terms cross the server/browser boundary as JSON.
import { isAddress } from '@solana/kit';
import { canonicalJson, type Cluster } from '@project-qf/core';
import { PROGRAM_IDS } from './programs.ts';
import { NATIVE_MINT, DAMM_V2_CUSTOMIZABLE_CONFIG } from './engine/pda.ts';

export const TX_BINDING_POLICY_VERSION = 'tx-binding-v0.1';
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;              // Solana per-transaction maximum
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000_000n; // hard ceiling; terms set the real cap

export interface ComputeCaps { maxUnitLimit: number; maxUnitPriceMicroLamports: string }
interface Common { cluster: Cluster; policyVersion: string; feePayer: string; compute: ComputeCaps }
interface Mints { baseMint: string; quoteMint: string; baseTokenProgram: string; quoteTokenProgram: string }

export type ApprovedTerms =
  | (Common & { kind: 'CREATE_CONFIG'; config: string; payer: string; feeClaimer: string; leftoverReceiver: string; quoteMint: string; configParametersDigest: string })
  | (Common & { kind: 'CREATE_POOL'; config: string; creator: string; payer: string; baseMint: string; quoteMint: string; quoteTokenProgram: string; name: string; symbol: string; uri: string })
  | (Common & Mints & { kind: 'SWAP'; config: string; pool: string; user: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE';
      amountIn: string; minimumAmountOut: string; referralTokenAccount: string | null; allowSysvarInstructions: boolean })
  | (Common & Mints & { kind: 'MIGRATE_DAMM_V2'; config: string; pool: string; payer: string; dammConfig: string })
  // A swap on the DAMM v2 pool a DBC launch graduated into (token A = base, token B = quote, V0 migration template config).
  | (Common & Mints & { kind: 'DAMM_SWAP'; dammConfig: string; pool: string; user: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE';
      amountIn: string; minimumAmountOut: string })
  // Claiming the trading fees a graduated launch's DAMM v2 position has earned, into the position owner's own token accounts.
  | (Common & Mints & { kind: 'DAMM_CLAIM_POSITION_FEE'; dammConfig: string; pool: string; owner: string; positionNftMint: string })
  | (Common & Mints & { kind: 'CLAIM_PARTNER_TRADING_FEE'; config: string; pool: string; feeClaimer: string; receiver: string; maxBaseAmount: string; maxQuoteAmount: string })
  | (Common & Mints & { kind: 'CLAIM_CREATOR_TRADING_FEE'; config: string; pool: string; creator: string; receiver: string; maxBaseAmount: string; maxQuoteAmount: string })
  // Platform treasury (Squads v4, devnet stand-in): a fee claim run by the multisig's vault. `inner` is the claim the vault
  // signs; members propose it (vault_transaction_create + proposal_create, optionally the creator's own approval), approve
  // it, and execute it. Members sign for themselves only; nothing here is signed by the server.
  | (Common & TreasuryRef & { kind: 'TREASURY_PROPOSE'; vault: string; vaultIndex: number; creator: string; rentPayer: string; approve: boolean; inner: TreasuryInnerTerms })
  | (Common & TreasuryRef & { kind: 'TREASURY_APPROVE'; member: string })
  | (Common & TreasuryRef & { kind: 'TREASURY_EXECUTE'; vault: string; vaultIndex: number; member: string; inner: TreasuryInnerTerms })
  // Holder rewards (devnet, EPOCH_PROPORTIONAL settled DIRECT): only ever run inside a treasury proposal.
  //   REWARDS_DEPOSIT: the treasury vault (index 0) moves quote tokens into the rewards vault (index 1) for one coin's epoch.
  //   REWARDS_PAYOUT: the rewards vault pays one final epoch's allocation, recipient by recipient, as frozen in its record.
  // Each carries a memo naming the coin and epoch, so the deposit or payout can be read back from its own transaction.
  | (Common & RewardsRef & { kind: 'REWARDS_DEPOSIT'; to: string; amountRaw: string })
  | (Common & RewardsRef & { kind: 'REWARDS_PAYOUT'; artifactHash: string; payouts: { owner: string; amountRaw: string }[] })
  // Project QF's own engine (ADR-014): the coin is a Token-2022 mint and the quote may be wrapped SOL. What these bind to
  // is in qf-engine.ts: exactly the instructions @project-qf/engine builds from the terms, byte for byte.
  | (Common & QfCoin & { kind: 'QF_CREATE'; creator: string; ammConfig: string; name: string; symbol: string; uri: string })
  | (Common & QfCoin & { kind: 'QF_SWAP'; user: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE'; amountIn: string; minimumAmountOut: string })
  | (Common & QfCoin & { kind: 'QF_POOL_SWAP'; user: string; ammConfig: string; direction: 'QUOTE_TO_BASE' | 'BASE_TO_QUOTE'; amountIn: string; minimumAmountOut: string })
  | (Common & QfCoin & { kind: 'QF_CLAIM_CREATOR_FEES'; creator: string })
  | (Common & QfCoin & { kind: 'QF_COLLECT_POOL_CREATOR_FEE'; creator: string; ammConfig: string });
interface QfCoin { baseMint: string; quoteMint: string }
export type QfTerms = Extract<ApprovedTerms, { kind: `QF_${string}` }>;
export const QF_KINDS: readonly QfTerms['kind'][] = ['QF_CREATE', 'QF_SWAP', 'QF_POOL_SWAP', 'QF_CLAIM_CREATOR_FEES', 'QF_COLLECT_POOL_CREATOR_FEE'];
export const isQfTerms = (t: { kind: string }): t is QfTerms => (QF_KINDS as readonly string[]).includes(t.kind);
/** The engine's limits on a coin's name, ticker and metadata link, in UTF-8 bytes (qf-curve state.rs). */
export const QF_TEXT_LIMITS = Object.freeze({ name: 32, symbol: 10, uri: 200 });
interface TreasuryRef { multisig: string; transactionIndex: string }
interface RewardsRef { from: string; quoteMint: string; quoteDecimals: number; quoteTokenProgram: string; launchMint: string; epochId: string }
/** What a treasury vault may be asked to sign: claiming platform fees into its own accounts, a holder-rewards deposit
 *  into the rewards vault, or a holder-rewards payout from the rewards vault. Nothing else. */
export type TreasuryInnerTerms = Extract<ApprovedTerms, { kind: 'CLAIM_PARTNER_TRADING_FEE' | 'DAMM_CLAIM_POSITION_FEE' | 'REWARDS_DEPOSIT' | 'REWARDS_PAYOUT' }>;
export type RewardsInnerTerms = Extract<ApprovedTerms, { kind: 'REWARDS_DEPOSIT' | 'REWARDS_PAYOUT' }>;
export const TREASURY_INNER_KINDS: readonly string[] = ['CLAIM_PARTNER_TRADING_FEE', 'DAMM_CLAIM_POSITION_FEE', 'REWARDS_DEPOSIT', 'REWARDS_PAYOUT'];
/** The vault that signs an inner transaction: the rewards vault (index 1) pays rewards; the treasury vault (index 0) does the rest. */
export const vaultIndexFor = (inner: { kind: string }) => (inner.kind === 'REWARDS_PAYOUT' ? 1 : 0);
/** Most recipients one payout proposal pays (keeps the execute transaction within the size limit). */
export const MAX_REWARD_PAYOUTS_PER_TX = 8;
/** The memo a rewards transfer carries (exact text; the binding and the vault reader both use it). */
export const rewardsMemo = (t: { kind: 'REWARDS_DEPOSIT' | 'REWARDS_PAYOUT'; launchMint: string; epochId: string; artifactHash?: string }) =>
  t.kind === 'REWARDS_DEPOSIT' ? `qf-rewards-deposit@1 mint=${t.launchMint} epoch=${t.epochId}` : `qf-rewards-payout@1 mint=${t.launchMint} epoch=${t.epochId} artifact=${t.artifactHash}`;

/** What was consented to. The blockhash is deliberately absent: a refreshed blockhash is not a change of terms. */
export interface ConsentRecord {
  termsDigest: string;
  cluster: Cluster;
  policyVersion: string;
  evidenceDigest: string;            // digest of the evidence set shown at consent time
  acknowledgementDigest: string | null; // bound WARN acknowledgement (policy package), when any WARN applied
  approvedAt: string;
}

const CLUSTERS = new Set(['mainnet-beta', 'devnet', 'localnet', 'mock-offline']);
const U64_MAX = 2n ** 64n - 1n;
const HEX32 = /^[0-9a-f]{64}$/;
const KIND_FIELDS: Record<ApprovedTerms['kind'], { addrs: string[]; u64: string[]; positive: string[] }> = {
  CREATE_CONFIG: { addrs: ['config', 'payer', 'feeClaimer', 'leftoverReceiver', 'quoteMint'], u64: [], positive: [] },
  CREATE_POOL: { addrs: ['config', 'creator', 'payer', 'baseMint', 'quoteMint', 'quoteTokenProgram'], u64: [], positive: [] },
  SWAP: { addrs: ['config', 'pool', 'user', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  MIGRATE_DAMM_V2: { addrs: ['config', 'pool', 'payer', 'dammConfig', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: [], positive: [] },
  DAMM_CLAIM_POSITION_FEE: { addrs: ['dammConfig', 'pool', 'owner', 'positionNftMint', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: [], positive: [] },
  DAMM_SWAP: { addrs: ['dammConfig', 'pool', 'user', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  CLAIM_PARTNER_TRADING_FEE: { addrs: ['config', 'pool', 'feeClaimer', 'receiver', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['maxBaseAmount', 'maxQuoteAmount'], positive: [] },
  CLAIM_CREATOR_TRADING_FEE: { addrs: ['config', 'pool', 'creator', 'receiver', 'baseMint', 'quoteMint', 'baseTokenProgram', 'quoteTokenProgram'], u64: ['maxBaseAmount', 'maxQuoteAmount'], positive: [] },
  TREASURY_PROPOSE: { addrs: ['multisig', 'vault', 'creator', 'rentPayer'], u64: ['transactionIndex'], positive: ['transactionIndex'] },
  TREASURY_APPROVE: { addrs: ['multisig', 'member'], u64: ['transactionIndex'], positive: ['transactionIndex'] },
  TREASURY_EXECUTE: { addrs: ['multisig', 'vault', 'member'], u64: ['transactionIndex'], positive: ['transactionIndex'] },
  REWARDS_DEPOSIT: { addrs: ['from', 'to', 'quoteMint', 'quoteTokenProgram', 'launchMint'], u64: ['amountRaw'], positive: ['amountRaw'] },
  REWARDS_PAYOUT: { addrs: ['from', 'quoteMint', 'quoteTokenProgram', 'launchMint'], u64: [], positive: [] },
  QF_CREATE: { addrs: ['creator', 'baseMint', 'quoteMint', 'ammConfig'], u64: [], positive: [] },
  QF_SWAP: { addrs: ['user', 'baseMint', 'quoteMint'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  QF_POOL_SWAP: { addrs: ['user', 'baseMint', 'quoteMint', 'ammConfig'], u64: ['amountIn', 'minimumAmountOut'], positive: ['amountIn'] },
  QF_CLAIM_CREATOR_FEES: { addrs: ['creator', 'baseMint', 'quoteMint'], u64: [], positive: [] },
  QF_COLLECT_POOL_CREATOR_FEE: { addrs: ['creator', 'baseMint', 'quoteMint', 'ammConfig'], u64: [], positive: [] },
};

/** Runtime validation of terms. Returns violations; empty means structurally valid V0 terms. */
export function validateTerms(t: unknown): string[] {
  const v: string[] = [];
  const o = t as Record<string, unknown>;
  if (!o || typeof o !== 'object') return ['TERMS_MISSING'];
  const spec = KIND_FIELDS[o.kind as ApprovedTerms['kind']];
  if (!spec) return [`TERMS_UNSUPPORTED_KIND ${String(o.kind)}`];
  if (!CLAIMS_CLUSTER(o.cluster)) v.push(`TERMS_BAD_CLUSTER ${String(o.cluster)}`);
  if (typeof o.policyVersion !== 'string' || o.policyVersion !== TX_BINDING_POLICY_VERSION) v.push(`TERMS_POLICY_VERSION ${String(o.policyVersion)}`);
  for (const k of ['feePayer', ...spec.addrs]) if (typeof o[k] !== 'string' || !isAddress(o[k] as string)) v.push(`TERMS_BAD_ADDRESS ${k}`);
  for (const k of spec.u64) {
    const s = o[k];
    if (typeof s !== 'string' || !/^(0|[1-9]\d*)$/.test(s) || BigInt(s) > U64_MAX) v.push(`TERMS_BAD_AMOUNT ${k}`);
    else if (spec.positive.includes(k) && BigInt(s) === 0n) v.push(`TERMS_NONPOSITIVE_AMOUNT ${k}`);
  }
  const c = o.compute as ComputeCaps | undefined;
  if (!c || !Number.isInteger(c.maxUnitLimit) || c.maxUnitLimit <= 0 || c.maxUnitLimit > MAX_COMPUTE_UNIT_LIMIT) v.push('TERMS_BAD_COMPUTE_LIMIT');
  if (!c || typeof c.maxUnitPriceMicroLamports !== 'string' || !/^(0|[1-9]\d*)$/.test(c.maxUnitPriceMicroLamports)
    || BigInt(c.maxUnitPriceMicroLamports) > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) v.push('TERMS_BAD_COMPUTE_PRICE');
  if (isQfTerms(o as { kind: string })) return [...v, ...qfViolations(o)];
  // V0 scope: SPL Token base and quote only; native-SOL quote flows (wrap/unwrap, temp wSOL) fail closed.
  for (const k of ['baseTokenProgram', 'quoteTokenProgram']) if (k in o && o[k] !== PROGRAM_IDS.TOKEN) v.push(`TERMS_UNSUPPORTED_V0 ${k} must be SPL Token`);
  if (o.quoteMint === NATIVE_MINT || o.baseMint === NATIVE_MINT) v.push('TERMS_UNSUPPORTED_V0 native SOL quote/base');
  if ((o.kind === 'SWAP' || o.kind === 'DAMM_SWAP') && o.direction !== 'QUOTE_TO_BASE' && o.direction !== 'BASE_TO_QUOTE') v.push('TERMS_BAD_DIRECTION');
  if (o.kind === 'SWAP' && o.referralTokenAccount !== null && (typeof o.referralTokenAccount !== 'string' || !isAddress(o.referralTokenAccount))) v.push('TERMS_BAD_ADDRESS referralTokenAccount');
  if (o.kind === 'SWAP' && typeof o.allowSysvarInstructions !== 'boolean') v.push('TERMS_BAD_FLAG allowSysvarInstructions');
  if (o.kind === 'CREATE_CONFIG' && (typeof o.configParametersDigest !== 'string' || !HEX32.test(o.configParametersDigest))) v.push('TERMS_BAD_DIGEST configParametersDigest');
  if (o.kind === 'CREATE_POOL') for (const k of ['name', 'symbol', 'uri']) if (typeof o[k] !== 'string' || (o[k] as string).length === 0 || (o[k] as string).length > 200) v.push(`TERMS_BAD_STRING ${k}`);
  if ((o.kind === 'MIGRATE_DAMM_V2' || o.kind === 'DAMM_SWAP' || o.kind === 'DAMM_CLAIM_POSITION_FEE') && o.dammConfig !== DAMM_V2_CUSTOMIZABLE_CONFIG) v.push('TERMS_DAMM_CONFIG_NOT_V0_TEMPLATE');
  if (o.kind === 'TREASURY_PROPOSE' || o.kind === 'TREASURY_EXECUTE') v.push(...treasuryInnerViolations(o));
  if (o.kind === 'TREASURY_PROPOSE' && typeof o.approve !== 'boolean') v.push('TERMS_BAD_FLAG approve');
  if (o.kind === 'REWARDS_DEPOSIT' || o.kind === 'REWARDS_PAYOUT') v.push(...rewardsViolations(o));
  return v;
}

/** Engine terms: the person who signs pays the fee; the coin is not the quote (it is a fresh Token-2022 mint, never wrapped
 *  SOL); texts fit the engine's limits. Wrapped SOL is allowed as the quote: the binding wraps and unwraps it. */
function qfViolations(o: Record<string, unknown>): string[] {
  const v: string[] = [];
  const signer = o.kind === 'QF_SWAP' || o.kind === 'QF_POOL_SWAP' ? o.user : o.creator;
  if (o.feePayer !== signer) v.push('TERMS_QF_FEE_PAYER_IS_NOT_THE_SIGNER');
  if (o.baseMint === o.quoteMint || o.baseMint === NATIVE_MINT) v.push('TERMS_QF_COIN_IS_THE_QUOTE');
  if ((o.kind === 'QF_SWAP' || o.kind === 'QF_POOL_SWAP') && o.direction !== 'QUOTE_TO_BASE' && o.direction !== 'BASE_TO_QUOTE') v.push('TERMS_BAD_DIRECTION');
  if (o.kind === 'QF_CREATE') {
    for (const k of ['name', 'symbol', 'uri'] as const) {
      const x = o[k];
      if (typeof x !== 'string' || x.length === 0 || new TextEncoder().encode(x).length > QF_TEXT_LIMITS[k]) v.push(`TERMS_BAD_STRING ${k}`);
    }
    if (o.creator === o.baseMint) v.push('TERMS_QF_MINT_IS_THE_CREATOR');
  }
  return v;
}

const EPOCH_ID = /^\d{4}-\d{2}-\d{2}$/;
/** The vault pays its own way and is the only authority; amounts are positive whole units; recipients are distinct wallets. */
function rewardsViolations(o: Record<string, unknown>): string[] {
  const v: string[] = [];
  if (o.feePayer !== o.from) v.push('TERMS_REWARDS_FEE_PAYER_NOT_SOURCE_VAULT');
  if (!Number.isInteger(o.quoteDecimals) || (o.quoteDecimals as number) < 0 || (o.quoteDecimals as number) > 18) v.push('TERMS_BAD_DECIMALS quoteDecimals');
  if (typeof o.epochId !== 'string' || !EPOCH_ID.test(o.epochId) || new Date(`${o.epochId}T00:00:00Z`).toISOString().slice(0, 10) !== o.epochId) v.push('TERMS_BAD_EPOCH epochId');
  if (o.launchMint === o.quoteMint) v.push('TERMS_REWARDS_LAUNCH_IS_QUOTE');
  if (o.kind === 'REWARDS_DEPOSIT' && o.to === o.from) v.push('TERMS_REWARDS_DEPOSIT_TO_ITSELF');
  if (o.kind === 'REWARDS_PAYOUT') {
    if (typeof o.artifactHash !== 'string' || !HEX32.test(o.artifactHash)) v.push('TERMS_BAD_DIGEST artifactHash');
    const ps = o.payouts as { owner: unknown; amountRaw: unknown }[] | undefined;
    if (!Array.isArray(ps) || ps.length === 0 || ps.length > MAX_REWARD_PAYOUTS_PER_TX) return [...v, `TERMS_REWARDS_PAYOUT_COUNT 1..${MAX_REWARD_PAYOUTS_PER_TX}`];
    const seen = new Set<string>();
    for (const [k, p] of ps.entries()) {
      if (typeof p?.owner !== 'string' || !isAddress(p.owner)) v.push(`TERMS_BAD_ADDRESS payouts[${k}].owner`);
      else if (seen.has(p.owner)) v.push(`TERMS_REWARDS_DUPLICATE_RECIPIENT ${p.owner}`);
      else seen.add(p.owner);
      if (p?.owner === o.from) v.push('TERMS_REWARDS_PAYS_ITSELF');
      if (typeof p?.amountRaw !== 'string' || !/^[1-9]\d*$/.test(p.amountRaw) || BigInt(p.amountRaw) > U64_MAX) v.push(`TERMS_BAD_AMOUNT payouts[${k}].amountRaw`);
    }
  }
  return v;
}

/** The vault pays for, signs and receives everything inside a treasury claim; no member or outside account does. */
function treasuryInnerViolations(o: Record<string, unknown>): string[] {
  const v: string[] = [];
  const inner0 = o.inner as Record<string, unknown> | undefined;
  if (o.vaultIndex !== vaultIndexFor({ kind: String(inner0?.kind) })) v.push(`TERMS_TREASURY_VAULT_INDEX must be ${vaultIndexFor({ kind: String(inner0?.kind) })} for ${String(inner0?.kind)}`);
  const signer = o.kind === 'TREASURY_PROPOSE' ? o.creator : o.member;
  if (signer === o.vault) v.push('TERMS_TREASURY_MEMBER_IS_VAULT');
  const inner = o.inner as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== 'object' || !TREASURY_INNER_KINDS.includes(inner.kind as string)) return [...v, `TERMS_TREASURY_INNER_KIND ${String(inner?.kind)}`];
  v.push(...validateTerms(inner).map((x) => `INNER_${x}`));
  if (inner.cluster !== o.cluster) v.push('TERMS_TREASURY_INNER_CLUSTER');
  const vaultFields = inner.kind === 'CLAIM_PARTNER_TRADING_FEE' ? ['feePayer', 'feeClaimer', 'receiver'] : inner.kind === 'REWARDS_DEPOSIT' || inner.kind === 'REWARDS_PAYOUT' ? ['feePayer', 'from'] : ['feePayer', 'owner'];
  for (const k of vaultFields) if (inner[k] !== o.vault) v.push(`TERMS_TREASURY_INNER_NOT_VAULT ${k}`);
  return v;
}
const CLAIMS_CLUSTER = (c: unknown) => typeof c === 'string' && CLUSTERS.has(c);

export async function sha256Hex(s: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
export const termsDigest = (t: ApprovedTerms) => sha256Hex(canonicalJson({ domain: 'QF-TX-TERMS', t }));
export const consentDigest = (c: ConsentRecord) => sha256Hex(canonicalJson({ domain: 'QF-CONSENT', c }));

/** Checks the consent record is for exactly these terms, on this cluster, under this policy, with bound evidence. */
export async function verifyConsentBinding(terms: ApprovedTerms, consent: ConsentRecord | undefined): Promise<string[]> {
  if (!consent) return ['CONSENT_MISSING'];
  const v: string[] = [];
  if (consent.termsDigest !== await termsDigest(terms)) v.push('CONSENT_TERMS_MISMATCH');
  if (consent.cluster !== terms.cluster) v.push('CONSENT_CLUSTER_MISMATCH');
  if (consent.policyVersion !== terms.policyVersion) v.push('CONSENT_POLICY_MISMATCH');
  if (typeof consent.evidenceDigest !== 'string' || !HEX32.test(consent.evidenceDigest)) v.push('CONSENT_EVIDENCE_NOT_BOUND');
  if (consent.acknowledgementDigest !== null && !HEX32.test(String(consent.acknowledgementDigest))) v.push('CONSENT_ACK_MALFORMED');
  if (!Number.isFinite(Date.parse(consent.approvedAt))) v.push('CONSENT_BAD_TIMESTAMP');
  return v;
}
