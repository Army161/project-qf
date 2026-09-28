// EconomicsPolicy (ECONOMICS.md §2). V0_TEST values exist only so offline/localnet/devnet work
// can run; none is a production constant (P0-M3).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '@project-qf/core';

export type TokenAuthorityOption = 'Immutable' | 'CreatorUpdateAuthority' | 'PartnerUpdateAuthority'
  | 'CreatorUpdateAndMintAuthority' | 'PartnerUpdateAndMintAuthority';

export interface EconomicsPolicy {
  id: 'economics';
  version: string;
  usage: 'V0_TEST' | 'PRODUCTION';
  baseFeeBps: number;
  dynamicFee: boolean;
  collectFeeMode: 'QUOTE_ONLY';
  creatorTradingFeePct: number;
  partnerRevenueSplitPct: number;
  partnerRewardsSplitPct: number;
  migrationExtractionFeePct: number;
  migrationFeeOption: 'CUSTOMIZABLE';
  migratedPoolFeeBps: number;
  lp: { partnerPermanentLockedPct: number; creatorPermanentLockedPct: number; partnerClaimablePct: number; creatorClaimablePct: number; vesting: null };
  poolCreationFeeLamports: string;
  tokenAuthorityOption: TokenAuthorityOption;
}

export const ECONOMICS_V0_TEST: Readonly<EconomicsPolicy> = Object.freeze({
  id: 'economics',
  version: 'STANDARD_V1@0-v0test',
  usage: 'V0_TEST',
  baseFeeBps: 100,
  dynamicFee: false,
  collectFeeMode: 'QUOTE_ONLY',
  creatorTradingFeePct: 50,
  partnerRevenueSplitPct: 50,
  partnerRewardsSplitPct: 50,
  migrationExtractionFeePct: 0,
  migrationFeeOption: 'CUSTOMIZABLE',
  migratedPoolFeeBps: 100,
  lp: Object.freeze({ partnerPermanentLockedPct: 50, creatorPermanentLockedPct: 50, partnerClaimablePct: 0, creatorClaimablePct: 0, vesting: null }),
  poolCreationFeeLamports: '0',
  tokenAuthorityOption: 'Immutable',
});

// Engine bounds (DBC 0.2.1 constants; METEORA.md): MIN_FEE_BPS 25, MAX_FEE_BPS 9900,
// migrated pool fee 10..1000 bps, MIN_LOCKED_LIQUIDITY_BPS 1000 (10%).
const isInt = (n: number) => Number.isInteger(n);
const inRange = (n: number, lo: number, hi: number) => isInt(n) && n >= lo && n <= hi;

export function validateEconomics(e: EconomicsPolicy): string[] {
  const v: string[] = [];
  if (!inRange(e.baseFeeBps, 25, 9900)) v.push('baseFeeBps must be an integer in 25..9900');
  if (e.dynamicFee !== false) v.push('dynamicFee must be false (DECISION v1)');
  if (!inRange(e.creatorTradingFeePct, 0, 100)) v.push('creatorTradingFeePct must be an integer in 0..100');
  if (!inRange(e.partnerRevenueSplitPct, 0, 100) || !inRange(e.partnerRewardsSplitPct, 0, 100)
    || e.partnerRevenueSplitPct + e.partnerRewardsSplitPct !== 100) v.push('partner revenue/rewards split must be integers summing to 100');
  if (e.migrationExtractionFeePct !== 0) v.push('migrationExtractionFeePct must be 0 (DECISION)');
  if (!inRange(e.migratedPoolFeeBps, 10, 1000)) v.push('migratedPoolFeeBps must be an integer in 10..1000');
  const { partnerPermanentLockedPct: pp, creatorPermanentLockedPct: cp, partnerClaimablePct: pc, creatorClaimablePct: cc } = e.lp;
  if (pc !== 0 || cc !== 0) v.push('claimable LP must be 0 for partner and creator (DECISION: no claimable creator LP)');
  if (![pp, cp, pc, cc].every((x) => inRange(x, 0, 100)) || pp + cp + pc + cc !== 100) v.push('LP percentages must be integers that sum to 100');
  if (pp + cp < 10) v.push('permanently locked LP must be >= 10% (MIN_LOCKED_LIQUIDITY_BPS)');
  if (e.lp.vesting !== null) v.push('LP vesting must be null in V1');
  if (e.tokenAuthorityOption !== 'Immutable') v.push('tokenAuthorityOption must be Immutable (no retained mint/update authority)');
  if (!/^\d+$/.test(e.poolCreationFeeLamports)) v.push('poolCreationFeeLamports must be a raw integer string');
  return v;
}

/** sha256 hex of canonical JSON. Consent binds to this digest. */
export const economicsDigest = (x: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(x))));
