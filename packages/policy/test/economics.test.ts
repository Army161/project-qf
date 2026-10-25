import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMICS_V0_TEST, validateEconomics, economicsDigest } from '../src/economics.ts';

test('V0_TEST economics are valid and labelled test-only', () => {
  assert.deepEqual(validateEconomics(ECONOMICS_V0_TEST), []);
  assert.equal(ECONOMICS_V0_TEST.usage, 'V0_TEST');
  assert.equal(ECONOMICS_V0_TEST.lp.creatorClaimablePct, 0);
  assert.equal(ECONOMICS_V0_TEST.lp.partnerClaimablePct, 0);
  assert.equal(ECONOMICS_V0_TEST.tokenAuthorityOption, 'Immutable');
});

test('engine bounds and decisions are enforced', () => {
  const bad = (patch: object) => validateEconomics({ ...ECONOMICS_V0_TEST, ...patch } as typeof ECONOMICS_V0_TEST);
  assert.match(bad({ baseFeeBps: 24 }).join(), /baseFeeBps/);
  assert.match(bad({ baseFeeBps: 9901 }).join(), /baseFeeBps/);
  assert.match(bad({ migratedPoolFeeBps: 9 }).join(), /migratedPoolFeeBps/);
  assert.match(bad({ migratedPoolFeeBps: 1001 }).join(), /migratedPoolFeeBps/);
  assert.match(bad({ partnerRevenueSplitPct: 60 }).join(), /split/);
  assert.match(bad({ migrationExtractionFeePct: 1 }).join(), /migrationExtractionFeePct/);
  assert.match(bad({ dynamicFee: true }).join(), /dynamicFee/);
  assert.match(bad({ tokenAuthorityOption: 'CreatorUpdateAndMintAuthority' }).join(), /tokenAuthorityOption/);
  assert.match(bad({ lp: { ...ECONOMICS_V0_TEST.lp, creatorClaimablePct: 10, creatorPermanentLockedPct: 40 } }).join(), /claimable/);
  assert.match(bad({ lp: { ...ECONOMICS_V0_TEST.lp, partnerPermanentLockedPct: 40 } }).join(), /sum to 100/);
  assert.match(bad({ creatorTradingFeePct: 50.5 }).join(), /creatorTradingFeePct/);
});

test('economics digest is canonical (key order independent) and changes with any field', () => {
  const a = economicsDigest({ b: 1, a: { y: '2', x: 1n } });
  const b = economicsDigest({ a: { x: 1n, y: '2' }, b: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, economicsDigest({ a: { x: 2n, y: '2' }, b: 1 }));
});
