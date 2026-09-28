import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RouteQuote } from '@project-qf/core';
import { VALIDATOR_POLICY_V0_1, EVIDENCE_POLICY_V0_1 } from '../src/policy.ts';
import { checkExitDepth } from '../src/exitDepth.ts';

const NOW = '2026-09-27T12:00:00.000Z';
const FRESH = '2026-09-27T11:59:30.000Z';
// Synthetic quote mint: base58(sha256('QF-MOCK:qUSD-quote-mint')), a well-formed address with no known key or asset.
const Q = 'EtriFwkv36LDftunesYPdxScW2KU5BK55pcm7qwBonXn';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // mainnet USDC mint as an identifier only (policy exit set)
const route = (out: string, over: Partial<RouteQuote> = {}): RouteQuote => ({
  provider: 'indexer-fixture', providerClass: 'PRODUCTION', inputMint: Q, outputMint: out,
  notionalRaw: '100000000000', filledRaw: '100000000000', priceImpactBps: 120, observedAt: FRESH, ...over,
});
const base = { quoteMint: Q, now: NOW, mode: 'LIVE' as const, notionalRaw: 100_000_000_000n, exitMints: [SOL, USDC],
  policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 };

test('S3.1 PASS when both exits fill the full notional within the impact bound', () => {
  const r = checkExitDepth({ ...base, routes: [route(SOL), route(USDC)] });
  assert.equal(r.id, 'S3.1');
  assert.equal(r.decision, 'PASS', r.reason);
});

test('impact above maxRouteImpactBps (300) -> WARN; exactly 300 is within bound', () => {
  assert.equal(checkExitDepth({ ...base, routes: [route(SOL, { priceImpactBps: 300 }), route(USDC)] }).decision, 'PASS');
  assert.equal(checkExitDepth({ ...base, routes: [route(SOL, { priceImpactBps: 301 }), route(USDC)] }).decision, 'WARN');
});

test('a route that cannot fill the notional is not an exit: FAIL', () => {
  const r = checkExitDepth({ ...base, routes: [route(SOL, { filledRaw: '25000000000' }), route(USDC)] });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.reason, /NO_EXECUTABLE_EXIT/);
});

test('route quoted for a smaller notional does not count for a larger one', () => {
  const r = checkExitDepth({ ...base, routes: [route(SOL, { notionalRaw: '1000000', filledRaw: '1000000' }), route(USDC)] });
  assert.equal(r.decision, 'FAIL');
});

test('missing exit to one required asset: FAIL (insufficient evidence is never PASS)', () => {
  assert.equal(checkExitDepth({ ...base, routes: [route(USDC)] }).decision, 'FAIL');
  assert.equal(checkExitDepth({ ...base, routes: [] }).decision, 'FAIL');
});

test('stale route quotes are ignored', () => {
  const r = checkExitDepth({ ...base, routes: [route(SOL, { observedAt: '2026-09-27T11:40:00.000Z' }), route(USDC)] });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.details.excluded ?? '', /STALE_ROUTE/);
});

test('when the quote asset is itself an exit asset that leg is trivially satisfied', () => {
  const r = checkExitDepth({ ...base, quoteMint: USDC, routes: [route(SOL, { inputMint: USDC })] });
  assert.equal(r.decision, 'PASS', r.reason);
});

test('exit depth is independent of TVL: high liquidity does not imply an executable exit', () => {
  // No routes at all even though S3.2 could PASS elsewhere.
  assert.equal(checkExitDepth({ ...base, routes: [] }).decision, 'FAIL');
});

test('TEST_ONLY mode caps S3.1 at WARN', () => {
  const t = (r: RouteQuote) => ({ ...r, providerClass: 'TEST_ONLY' as const });
  const r = checkExitDepth({ ...base, mode: 'TEST_ONLY', routes: [t(route(SOL)), t(route(USDC))] });
  assert.equal(r.decision, 'WARN');
});
