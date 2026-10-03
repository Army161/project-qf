// features-v0.2 (decision D3): for the classic native mint the supply field is kept raw but labelled "not tracked", and no
// supply-normalized share is computed from it. Raw largest token-account balances are a labelled sample, not holders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures, FEATURES_VERSION, type FeatureSet } from '@project-qf/features';
import type { MintFacts } from '@project-qf/validator';

const nativeFacts: MintFacts = { tokenProgram: 'SPL_TOKEN', initialized: true, mintAuthority: null, freezeAuthority: null, supplyRaw: '0', decimals: 9, extensions: [] };
const get = (s: FeatureSet, id: string) => s.components.find((c) => c.id === id)!;
const largest = { provider: 'mainnet.helius-rpc.com', status: 'OK' as const, accounts: [{ address: 'a0', amountRaw: '900' }, { address: 'a1', amountRaw: '100' }] };

test('features-v0.2 is the current version', () => assert.equal(FEATURES_VERSION, 'features-v0.2'));

test('native mint: raw supply 0 is kept but labelled not tracked; shares stay UNAVAILABLE with the precise reason', () => {
  const s = computeFeatures({ facts: nativeFacts, factsSource: 'api.mainnet.solana.com', largest, supplySemantics: 'NATIVE_MINT_NOT_TRACKED' });
  const sup = get(s, 'supply_raw');
  assert.equal(sup.status, 'MEASURED');
  assert.equal(sup.value, '0');
  assert.match(sup.note, /^NATIVE_MINT_SUPPLY_NOT_TRACKED: .*not a total of wrapped SOL/);
  for (const id of ['top1_account_share_bps', 'top10_account_share_bps']) {
    assert.equal(get(s, id).status, 'UNAVAILABLE', id);
    assert.match(get(s, id).note, /^NATIVE_MINT_SUPPLY_NOT_TRACKED: no supply denominator/, id);
  }
  // The raw sample is still observable, and labelled as token accounts, not owners.
  assert.equal(get(s, 'largest_accounts_sample_size').value, '2');
  assert.equal(get(s, 'top1_account_raw').value, '900');
  assert.equal(get(s, 'top1_account_raw').source, 'mainnet.helius-rpc.com');
  assert.match(get(s, 'top1_account_raw').note, /raw token-account sample.*not owners.*not owner-adjusted/);
});

test('ordinary mints: shares are computed as before and the raw sample is reported alongside', () => {
  const facts: MintFacts = { ...nativeFacts, supplyRaw: '10000', decimals: 6 };
  const s = computeFeatures({ facts, factsSource: 'rpc-a', largest, supplySemantics: 'TRACKED' });
  assert.equal(get(s, 'top1_account_share_bps').value, '900');
  assert.equal(get(s, 'supply_raw').note, 'current supply at the read slot');
  assert.equal(get(s, 'largest_accounts_sample_size').value, '2');
  // An ordinary zero supply is still NO_SUPPLY, not the native label.
  const z = computeFeatures({ facts: { ...facts, supplyRaw: '0' }, factsSource: 'rpc-a', largest });
  assert.equal(get(z, 'top1_account_share_bps').note, 'NO_SUPPLY');
  // No sample when largest accounts are unavailable.
  const down = computeFeatures({ facts, factsSource: 'rpc-a', largest: { provider: 'rpc-a', status: 'UNAVAILABLE', reason: 'RATE_LIMITED (HTTP 429)', accounts: [] } });
  assert.equal(get(down, 'top1_account_raw').status, 'UNAVAILABLE');
  assert.match(get(down, 'largest_accounts_sample_size').note, /RATE_LIMITED/);
});
