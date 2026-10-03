// features-v0.1: every component is MEASURED from evidence or UNAVAILABLE with a reason; nothing is estimated and there is
// no overall score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures, FEATURES_VERSION, type FeatureSet } from '@project-qf/features';
import type { MintFacts } from '@project-qf/validator';

const facts: MintFacts = { tokenProgram: 'SPL_TOKEN', initialized: true, mintAuthority: null, freezeAuthority: 'F'.repeat(32), supplyRaw: '1000', decimals: 6, extensions: [] };
const get = (s: FeatureSet, id: string) => s.components.find((c) => c.id === id)!;
const accounts = (amounts: string[]) => amounts.map((a, i) => ({ address: `acct${i}`, amountRaw: a }));

test('mint facts become MEASURED components with their source; there is never an overall score', () => {
  const s = computeFeatures({ facts, factsSource: 'rpc-a', largest: null });
  assert.equal(s.version, FEATURES_VERSION);
  assert.equal(get(s, 'decimals').value, '6');
  assert.equal(get(s, 'decimals').source, 'rpc-a');
  assert.equal(get(s, 'freeze_authority_present').value, true);
  assert.equal(get(s, 'mint_authority_present').value, false);
  assert.equal(get(s, 'dbc_permissionless').value, true);
  assert.equal(s.overallScore, null);
  assert.match(s.overallScoreReason, /^NO_OVERALL_SCORE/);
  assert.equal(s.coverage.total, s.components.length);
  assert.equal(s.coverage.measured, s.components.filter((c) => c.status === 'MEASURED').length);
});

test('top-holder shares are measured in bps from raw amounts, sorted, with the token-account caveat', () => {
  const s = computeFeatures({ facts, factsSource: 'rpc-a', largest: { provider: 'rpc-a', status: 'OK',
    accounts: accounts(['50', '400', '100', '1', '1', '1', '1', '1', '1', '1', '1', '1']) } });
  assert.equal(get(s, 'top1_account_share_bps').value, '4000');   // 400 / 1000
  assert.equal(get(s, 'top10_account_share_bps').value, '5570');  // 400+100+50+7*1 = 557
  assert.match(get(s, 'top10_account_share_bps').note, /program-owned accounts .* NOT excluded/);
});

test('missing or bad evidence gives UNAVAILABLE with the reason and a null value, never a guess', () => {
  const none = computeFeatures({ facts: null, factsSource: null, largest: null });
  assert.ok(none.components.every((c) => c.status === 'UNAVAILABLE' && c.value === null && c.note.length > 0));
  assert.equal(none.coverage.measured, 0);
  const down = computeFeatures({ facts, factsSource: 'rpc-a', largest: { provider: 'rpc-a', status: 'UNAVAILABLE', reason: 'RATE_LIMITED (HTTP 429)', accounts: [] } });
  assert.match(get(down, 'top1_account_share_bps').note, /RATE_LIMITED/);
  const bad = computeFeatures({ facts, factsSource: 'rpc-a', largest: { provider: 'rpc-a', status: 'OK', accounts: accounts(['1.5']) } });
  assert.equal(get(bad, 'top1_account_share_bps').note, 'BAD_AMOUNT_IN_RESPONSE');
  const zero = computeFeatures({ facts: { ...facts, supplyRaw: '0' }, factsSource: 'rpc-a', largest: { provider: 'rpc-a', status: 'OK', accounts: accounts(['0']) } });
  assert.equal(get(zero, 'top1_account_share_bps').note, 'NO_SUPPLY');
});

test('sources that are not connected are listed as UNAVAILABLE, not omitted', () => {
  const s = computeFeatures({ facts, factsSource: 'rpc-a', largest: null });
  for (const id of ['liq_usd', 'vol_24h', 'holders', 'gini', 'commits_30d', 'mentions_24h', 'oracle_present']) {
    assert.equal(get(s, id).status, 'UNAVAILABLE', id);
    assert.equal(get(s, id).value, null, id);
  }
  const t22 = computeFeatures({ facts: { ...facts, tokenProgram: 'TOKEN_2022', extensions: [{ type: 14, name: 'TransferHook', length: 64 }] }, factsSource: 'rpc-a', largest: null });
  assert.equal(get(t22, 'dbc_permissionless').value, false);
});
