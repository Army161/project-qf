import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PoolObservation, PriceObservation } from '@project-qf/core';
import { VALIDATOR_POLICY_V0_1, EVIDENCE_POLICY_V0_1 } from '../src/policy.ts';
import { checkQuoteMarketLiquidity } from '../src/liquidity.ts';

const fx = JSON.parse(readFileSync(new URL('../fixtures/liquidity-boundaries.json', import.meta.url), 'utf8'));
const base = { quoteMint: fx.quoteMint as string, now: fx.now as string, mode: 'LIVE' as const, excludeMints: [] as string[],
  policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 };
const clone = <T>(x: T): T => structuredClone(x);

test('policy object carries the adopted Decision 2 values as exact decimal strings', () => {
  assert.equal(VALIDATOR_POLICY_V0_1.id, 'validator-v0.1');
  assert.equal(VALIDATOR_POLICY_V0_1.status, 'EXPERIMENTAL');
  assert.equal(VALIDATOR_POLICY_V0_1.liquidityFailUsd, '25000');
  assert.equal(VALIDATOR_POLICY_V0_1.liquidityWarnUsd, '250000');
  assert.equal(VALIDATOR_POLICY_V0_1.appliesTo, 'EXISTING_QUOTE_ASSET_MARKETS');
});

for (const c of fx.cases) {
  test(`S3.2 boundary ${c.name} -> ${c.expected}`, () => {
    const r = checkQuoteMarketLiquidity({ ...base, pools: clone(c.pools), prices: clone(fx.prices) });
    assert.equal(r.id, 'S3.2');
    assert.equal(r.details.eligibleUsd, c.totalUsd);
    assert.equal(r.decision, c.expected, r.reason);
    assert.equal(r.policyVersion, 'validator-v0.1');
  });
}

test('the same pool reported by two providers is corroboration, not additive liquidity', () => {
  const [p] = clone(fx.cases[3].pools) as PoolObservation[];
  const dup = { ...p!, provider: 'second-provider-fixture' };
  const r = checkQuoteMarketLiquidity({ ...base, pools: [p!, dup], prices: clone(fx.prices) });
  assert.equal(r.details.eligibleUsd, '250000');
  assert.equal(r.details.uniquePools, '1');
  assert.equal(r.details.corroboratedPools, '1');
  assert.equal(r.decision, 'PASS');
});

test('duplicate reports that disagree use the lower reserves (conservative)', () => {
  const [p] = clone(fx.cases[3].pools) as PoolObservation[];
  const low = { ...p!, provider: 'second-provider-fixture', sideA: { ...p!.sideA, reserveRaw: '100000000000' } };
  const r = checkQuoteMarketLiquidity({ ...base, pools: [p!, low], prices: clone(fx.prices) });
  assert.equal(r.details.eligibleUsd, '225000');
  assert.equal(r.decision, 'WARN');
});

test('dedupe key is chain + venue + pool address: same address on another venue counts separately', () => {
  const [p] = clone(fx.cases[1].pools) as PoolObservation[];
  const other = { ...p!, venue: 'other-venue-fixture' };
  const r = checkQuoteMarketLiquidity({ ...base, pools: [p!, other], prices: clone(fx.prices) });
  assert.equal(r.details.uniquePools, '2');
  assert.equal(r.details.eligibleUsd, '50000');
});

test('pools that do not contain the quote asset, or that contain a QF-launched base token, are not eligible', () => {
  const [p] = clone(fx.cases[3].pools) as PoolObservation[];
  const unrelated = { ...p!, poolAddress: 'MOCKunrelated', sideA: { ...p!.sideA, mint: 'MOCKotherMint' } };
  const launched = { ...p!, poolAddress: 'MOCKlaunchPool', sideB: { mint: 'MOCKqfBaseToken', decimals: 6, reserveRaw: '999999999999999' } };
  const r = checkQuoteMarketLiquidity({ ...base, excludeMints: ['MOCKqfBaseToken'], pools: [unrelated, launched], prices: clone(fx.prices) });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.reason, /NO_ELIGIBLE_POOLS/);
  assert.match(r.details.excluded ?? '', /QUOTE_MINT_NOT_IN_POOL/);
  assert.match(r.details.excluded ?? '', /LAUNCHED_BASE_TOKEN_POOL/);
});

test('missing quote price is insufficient evidence and never PASS', () => {
  const prices = (clone(fx.prices) as PriceObservation[]).filter((x) => x.mint !== fx.quoteMint);
  const r = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[3].pools), prices });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.reason, /INSUFFICIENT_EVIDENCE/);
});

test('a single price source is insufficient (two independent sources required)', () => {
  const prices = (clone(fx.prices) as PriceObservation[]).filter((x) => !(x.mint === fx.quoteMint && x.source === 'indexer-fixture'));
  const r = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[3].pools), prices });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.reason, /INSUFFICIENT_EVIDENCE/);
});

test('stale prices are excluded -> insufficient evidence -> FAIL', () => {
  const prices = (clone(fx.prices) as PriceObservation[]).map((x) => ({ ...x, observedAt: '2026-09-27T11:50:00.000Z' }));
  const r = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[3].pools), prices });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.details.priceReasons ?? '', /STALE/);
});

test('stale pool observations are excluded', () => {
  const pools = (clone(fx.cases[3].pools) as PoolObservation[]).map((x) => ({ ...x, observedAt: '2026-09-27T11:00:00.000Z' }));
  const r = checkQuoteMarketLiquidity({ ...base, pools, prices: clone(fx.prices) });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.details.excluded ?? '', /STALE_POOL/);
});

test('future-dated observations are rejected as manipulated evidence', () => {
  const prices = (clone(fx.prices) as PriceObservation[]).map((x) =>
    x.mint === fx.quoteMint && x.source === 'pyth-fixture' ? { ...x, observedAt: '2026-09-27T12:05:00.000Z' } : x);
  const r = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[3].pools), prices });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.details.priceReasons ?? '', /FUTURE_TIMESTAMP/);
});

test('manipulated (inflated) price: disagreement values at the lowest price and caps the check at WARN', () => {
  // One source reports 10x. Valued at the lower price the market is still $250,000 -> would PASS, but capped at WARN.
  const prices = (clone(fx.prices) as PriceObservation[]).map((x) =>
    x.mint === fx.quoteMint && x.source === 'pyth-fixture' ? { ...x, priceUsd: '10.00' } : x);
  const r = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[3].pools), prices });
  assert.equal(r.details.eligibleUsd, '250000');
  assert.equal(r.decision, 'WARN');
  assert.match(r.reason, /PRICE_DISAGREEMENT/);
});

test('manipulated price cannot lift a sub-floor market over $25,000', () => {
  const prices = (clone(fx.prices) as PriceObservation[]).map((x) =>
    x.mint === fx.quoteMint && x.source === 'pyth-fixture' ? { ...x, priceUsd: '100.00' } : x);
  const r = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[0].pools), prices });
  assert.equal(r.decision, 'FAIL');
});

test('non-positive or malformed prices are dropped, not coerced', () => {
  const prices = (clone(fx.prices) as PriceObservation[]).map((x) =>
    x.mint === fx.quoteMint && x.source === 'pyth-fixture' ? { ...x, priceUsd: '-1' } : x.mint === fx.quoteMint ? { ...x, priceUsd: '1e0' } : x);
  const r = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[3].pools), prices });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.details.priceReasons ?? '', /INVALID_PRICE/);
});

test('LIVE mode ignores TEST_ONLY providers entirely', () => {
  const pools = (clone(fx.cases[3].pools) as PoolObservation[]).map((x) => ({ ...x, providerClass: 'TEST_ONLY' as const }));
  const r = checkQuoteMarketLiquidity({ ...base, pools, prices: clone(fx.prices) });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.details.excluded ?? '', /TEST_ONLY_IN_LIVE/);
});

test('TEST_ONLY mode (synthetic devnet qUSD) is capped at WARN and never asserts real liquidity', () => {
  const pools = (clone(fx.cases[3].pools) as PoolObservation[]).map((x) => ({ ...x, providerClass: 'TEST_ONLY' as const }));
  const prices = (clone(fx.prices) as PriceObservation[]).map((x) => ({ ...x, providerClass: 'TEST_ONLY' as const }));
  const r = checkQuoteMarketLiquidity({ ...base, mode: 'TEST_ONLY', pools, prices });
  assert.equal(r.decision, 'WARN');
  assert.equal(r.details.testOnly, 'true');
  assert.match(r.reason, /TEST_ONLY/);
});

test('deterministic: same inputs give identical results', () => {
  const a = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[2].pools), prices: clone(fx.prices) });
  const b = checkQuoteMarketLiquidity({ ...base, pools: clone(fx.cases[2].pools), prices: clone(fx.prices) });
  assert.deepEqual(a, b);
});
