// Measured feature components, `features-v0.1` (OPPORTUNITY-ENGINE.md §1 layer 1). Every component is either MEASURED
// from evidence this inspection actually obtained, or UNAVAILABLE with the reason. Nothing is estimated, back-filled or
// defaulted, there is no overall score, and no model is involved.
import { isRawAmount } from '@project-qf/core';
import type { MintFacts } from '@project-qf/validator';

export const FEATURES_VERSION = 'features-v0.1';

export type FeatureValue = string | boolean | null;
export interface FeatureComponent {
  id: string;
  group: 'Mint' | 'Holders' | 'Liquidity' | 'Volume' | 'Saturation' | 'Velocity' | 'Developer' | 'Social' | 'Utility';
  status: 'MEASURED' | 'UNAVAILABLE';
  value: FeatureValue;   // null whenever status is UNAVAILABLE
  unit: string;          // 'raw', 'bps', 'bool', 'count', 'text', 'usd', ...
  source: string | null; // provider id the value came from
  note: string;          // caveat for MEASURED, reason for UNAVAILABLE
}
export interface FeatureSet {
  version: typeof FEATURES_VERSION;
  components: FeatureComponent[];
  coverage: { measured: number; total: number };
  overallScore: null;
  overallScoreReason: string;
}

export interface LargestAccounts {
  provider: string;
  status: 'OK' | 'UNAVAILABLE';
  reason?: string;
  accounts: { address: string; amountRaw: string }[];
}
export interface FeatureInput { facts: MintFacts | null; factsSource: string | null; largest: LargestAccounts | null }

const NOT_CONNECTED: [string, FeatureComponent['group'], string, string][] = [
  ['liq_usd', 'Liquidity', 'usd', 'NO_POOL_INDEXER: own indexer or approved provider not connected'],
  ['depth_2pct_usd', 'Liquidity', 'usd', 'NO_POOL_INDEXER'],
  ['liq_change_7d', 'Liquidity', 'pct', 'NO_HISTORY: requires 7 days of own indexer data'],
  ['vol_24h', 'Volume', 'usd', 'NO_VOLUME_SOURCE'],
  ['vol_7d_trend', 'Volume', 'pct', 'NO_HISTORY'],
  ['wash_adjusted_ratio', 'Volume', 'ratio', 'NO_VOLUME_SOURCE'],
  ['holders', 'Holders', 'count', 'NO_HOLDER_INDEXER: a full holder count needs an indexed snapshot'],
  ['holder_growth_7d', 'Holders', 'pct', 'NO_HISTORY'],
  ['gini', 'Holders', 'ratio', 'NO_HOLDER_INDEXER'],
  ['cluster_adjusted_holders', 'Holders', 'count', 'NO_HOLDER_INDEXER'],
  ['community_tokens_quoted_30d', 'Saturation', 'count', 'NO_DBC_INDEXER'],
  ['graduated_share', 'Saturation', 'pct', 'NO_DBC_INDEXER'],
  ['price_realized_vol_30d', 'Velocity', 'pct', 'NO_PRICE_HISTORY'],
  ['commits_30d', 'Developer', 'count', 'GITHUB_PROVIDER_PENDING_LICENCE_REVIEW'],
  ['mentions_24h', 'Social', 'count', 'NO_APPROVED_SOCIAL_PROVIDER'],
  ['oracle_present', 'Utility', 'bool', 'NO_ORACLE_MAPPING: registry has no Pyth feed ids'],
];

function shareBps(amounts: bigint[], supply: bigint): string { return ((amounts.reduce((a, b) => a + b, 0n) * 10_000n) / supply).toString(); }

export function computeFeatures(i: FeatureInput): FeatureSet {
  const c: FeatureComponent[] = [];
  const m = (id: string, group: FeatureComponent['group'], value: FeatureValue, unit: string, source: string | null, note = '') =>
    c.push({ id, group, status: 'MEASURED', value, unit, source, note });
  const u = (id: string, group: FeatureComponent['group'], unit: string, note: string) => c.push({ id, group, status: 'UNAVAILABLE', value: null, unit, source: null, note });

  const f = i.facts;
  if (f) {
    m('token_program', 'Mint', f.tokenProgram, 'text', i.factsSource);
    m('decimals', 'Mint', String(f.decimals), 'count', i.factsSource);
    m('supply_raw', 'Mint', f.supplyRaw, 'raw', i.factsSource, 'current supply at the read slot');
    m('mint_authority_present', 'Mint', f.mintAuthority !== null, 'bool', i.factsSource);
    m('freeze_authority_present', 'Mint', f.freezeAuthority !== null, 'bool', i.factsSource);
    m('extension_count', 'Mint', String(f.extensions.length), 'count', i.factsSource);
    m('dbc_permissionless', 'Utility', f.extensions.every((x) => x.type === 18 || x.type === 19), 'bool', i.factsSource, 'TOKEN-2022.md §2 rule');
  } else {
    for (const [id, unit] of [['token_program', 'text'], ['decimals', 'count'], ['supply_raw', 'raw'], ['mint_authority_present', 'bool'],
      ['freeze_authority_present', 'bool'], ['extension_count', 'count']] as const) u(id, 'Mint', unit, 'NO_MINT_EVIDENCE');
    u('dbc_permissionless', 'Utility', 'bool', 'NO_MINT_EVIDENCE');
  }

  const caveat = 'token accounts, not owners; program-owned accounts (pool vaults) are NOT excluded';
  const L = i.largest;
  let supply = 0n;
  try { supply = f ? BigInt(f.supplyRaw) : 0n; } catch { supply = 0n; }
  if (!L || L.status !== 'OK') {
    const why = !L ? 'NOT_REQUESTED' : `UNAVAILABLE: ${L.reason ?? 'unknown'}`;
    u('top1_account_share_bps', 'Holders', 'bps', why); u('top10_account_share_bps', 'Holders', 'bps', why);
  } else if (!L.accounts.every((a) => isRawAmount(a.amountRaw))) {
    u('top1_account_share_bps', 'Holders', 'bps', 'BAD_AMOUNT_IN_RESPONSE'); u('top10_account_share_bps', 'Holders', 'bps', 'BAD_AMOUNT_IN_RESPONSE');
  } else if (supply <= 0n) {
    u('top1_account_share_bps', 'Holders', 'bps', 'NO_SUPPLY'); u('top10_account_share_bps', 'Holders', 'bps', 'NO_SUPPLY');
  } else {
    const amounts = L.accounts.map((a) => BigInt(a.amountRaw)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    m('top1_account_share_bps', 'Holders', shareBps(amounts.slice(0, 1), supply), 'bps', L.provider, caveat);
    m('top10_account_share_bps', 'Holders', shareBps(amounts.slice(0, 10), supply), 'bps', L.provider, `${caveat}; ${Math.min(10, amounts.length)} accounts`);
  }

  for (const [id, group, unit, note] of NOT_CONNECTED) u(id, group, unit, note);
  const measured = c.filter((x) => x.status === 'MEASURED').length;
  return { version: FEATURES_VERSION, components: c, coverage: { measured, total: c.length }, overallScore: null,
    overallScoreReason: 'NO_OVERALL_SCORE: the deterministic scores need liquidity, volume, holder and saturation features that are not measured yet' };
}
