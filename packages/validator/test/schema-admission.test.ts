// Runtime-schema, lineage and registry-admission tests (QF-VAL-01/02/03, EV-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RouteQuote } from '@project-qf/core';
import { checkExitDepth } from '../src/exitDepth.ts';
import { aggregate, REQUIRED_LIVE_CHECKS } from '../src/aggregate.ts';
import { resolvePrice } from '../src/price.ts';
import { checkQuoteMarketLiquidity } from '../src/liquidity.ts';
import { admitToProductionRegistry, AUTHORITATIVE_SOURCES_V0, REGISTRY_ADMISSION_POLICY_VERSION, type AdmissionRequest } from '../src/registry.ts';
import { VALIDATOR_POLICY_V0_1, EVIDENCE_POLICY_V0_1 } from '../src/policy.ts';

const NOW = '2026-09-27T12:00:00.000Z', AT = '2026-09-27T11:59:30.000Z';
const Q = 'EtriFwkv36LDftunesYPdxScW2KU5BK55pcm7qwBonXn';
const [SOL, USDC] = VALIDATOR_POLICY_V0_1.requiredExitMints;
const route = (out: string, o: Partial<RouteQuote> = {}): RouteQuote => ({ provider: 'p', providerClass: 'PRODUCTION', inputMint: Q, outputMint: out,
  notionalRaw: '100', filledRaw: '100', priceImpactBps: 10, observedAt: AT, ...o });
const base = { quoteMint: Q, now: NOW, mode: 'LIVE' as const, notionalRaw: 100n, exitMints: [SOL!, USDC!], routes: [route(SOL!), route(USDC!)],
  policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 };

test('S3.1 schema: duplicate, malformed, non-policy exits, nonpositive notional and unknown mode FAIL', () => {
  assert.equal(checkExitDepth(base).decision, 'PASS');
  for (const [name, over] of [['dup', { exitMints: [SOL!, SOL!] }], ['malformed', { exitMints: [SOL!, 'MOCKusdc'] }], ['non-policy', { exitMints: [SOL!] }],
    ['zero', { notionalRaw: 0n }], ['negative', { notionalRaw: -1n }], ['mode', { mode: 'live' }], ['quote', { quoteMint: 'x' }]] as const) {
    const r = checkExitDepth({ ...base, ...(over as object) } as never);
    assert.equal(r.decision, 'FAIL', name);
    assert.match(r.reason, /INVALID_INPUT/, name);
  }
});
test('S3.1: an identity exit is recorded but not counted as an independent market', () => {
  const r = checkExitDepth({ ...base, quoteMint: USDC!, routes: [route(SOL!, { inputMint: USDC! })] });
  assert.equal(r.decision, 'PASS');
  assert.match(r.reason, /IDENTITY_NOT_COUNTED/);
  const onlyIdentity = checkExitDepth({ ...base, mode: 'TEST_ONLY', quoteMint: USDC!, exitMints: [USDC!], routes: [] });
  assert.equal(onlyIdentity.decision, 'FAIL');
  assert.match(onlyIdentity.reason, /TOO_FEW_INDEPENDENT_EXITS/);
});
test('S3.1: malformed routes are excluded, never counted', () => {
  const r = checkExitDepth({ ...base, routes: [route(SOL!, { providerClass: 'SOMETIMES' as never }), route(USDC!)] });
  assert.equal(r.decision, 'FAIL');
  assert.match(r.details.excluded!, /BAD_PROVIDER_CLASS/);
});

test('aggregate: duplicate or malformed checks and an empty set FAIL', () => {
  const c = (id: string, decision = 'PASS') => ({ id, decision, reason: 'x', evidence: [], details: {}, policyVersion: 'validator-v0.1' }) as never;
  const all = REQUIRED_LIVE_CHECKS.map((id) => c(id));
  assert.equal(aggregate(all, 'LIVE').decision, 'PASS');
  assert.match(aggregate([...all, c('S3.1', 'PASS')], 'LIVE').reasons.join(), /DUPLICATE_CHECK S3.1/);
  assert.equal(aggregate([...all, c('S9.9', 'MAYBE')], 'LIVE').decision, 'FAIL');
  assert.equal(aggregate([], 'TEST_ONLY').decision, 'FAIL');
  assert.equal(aggregate(all, 'PRODUCTION' as never).decision, 'FAIL');
});

test('EV-1 lineage: two labels relaying one upstream are one source (INSUFFICIENT at minimum 2)', () => {
  const o = (source: string, upstream: string | undefined, priceUsd = '1.00') => ({ mint: Q, source, providerClass: 'PRODUCTION' as const, priceUsd, observedAt: AT, upstream });
  const ctx = { now: NOW, mode: 'LIVE' as const, policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 };
  const same = resolvePrice(Q, [o('api-a', 'pyth:USDC/USD'), o('api-b', 'pyth:USDC/USD')], ctx);
  assert.equal(same.status, 'INSUFFICIENT');
  assert.match(same.reasons.join(), /SAME_LINEAGE/);
  assert.equal(resolvePrice(Q, [o('api-a', 'pyth:USDC/USD'), o('api-b', 'dex:orca:pool1')], ctx).status, 'OK');
  const noLineage = resolvePrice(Q, [o('api-a', undefined), o('api-b', undefined)], ctx);
  assert.equal(noLineage.status, 'INSUFFICIENT');
  assert.match(noLineage.reasons.join(), /MISSING_LINEAGE/);
  assert.match(resolvePrice(Q, [], { ...ctx, mode: 'live' as never }).reasons.join(), /INVALID_MODE/);
});
test('EV-1 timestamps: malformed and future-beyond-skew evidence is excluded', () => {
  const ctx = { now: NOW, mode: 'TEST_ONLY' as const, policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 };
  const o = (source: string, observedAt: string) => ({ mint: Q, source, providerClass: 'TEST_ONLY' as const, priceUsd: '1', observedAt });
  const r = resolvePrice(Q, [o('a', 'yesterday'), o('b', '2026-09-27T12:00:06.000Z'), o('c', '2026-09-27T12:00:04.000Z')], ctx);
  assert.equal(r.status, 'INSUFFICIENT');
  assert.match(r.reasons.join(), /BAD_TIMESTAMP/);
  assert.match(r.reasons.join(), /FUTURE_TIMESTAMP/);
});
test('S3.2: an unknown mode FAILs', () => {
  const r = checkQuoteMarketLiquidity({ quoteMint: Q, now: NOW, mode: 'Live' as never, excludeMints: [], pools: [], prices: [], policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 });
  assert.equal(r.decision, 'FAIL');
});
test('evidence-v0.1 is labelled V0_TEST analytical only (owner decision EV-1)', () => {
  assert.equal(EVIDENCE_POLICY_V0_1.status, 'V0_TEST_ANALYTICAL');
  assert.equal(EVIDENCE_POLICY_V0_1.scope, 'ANALYTICAL_ELIGIBILITY_ONLY_NOT_EXECUTION');
  assert.deepEqual([EVIDENCE_POLICY_V0_1.priceMaxAgeSeconds, EVIDENCE_POLICY_V0_1.poolMaxAgeSeconds, EVIDENCE_POLICY_V0_1.routeMaxAgeSeconds,
    EVIDENCE_POLICY_V0_1.maxClockSkewSeconds, EVIDENCE_POLICY_V0_1.minIndependentPriceSources], [120, 300, 120, 5, 2]);
});

// ---------- production admission ----------
const SRC = [{ id: 'test-issuer-page', kind: 'ISSUER_FIRST_PARTY' as const, origin: 'https://issuer.example' }];
const good = (): AdmissionRequest => ({ id: 'usdx', chain: 'solana', mint: USDC!, symbol: 'USDX', decimals: 6,
  provenance: { sourceId: 'test-issuer-page', url: 'https://issuer.example/mints', retrievedAt: NOW, contentSha256: 'ab'.repeat(32), statedMint: USDC! },
  onChainMint: { cluster: 'mainnet-beta', slot: '400000000', owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: 6, observedAt: NOW, providerClass: 'PRODUCTION', mintAuthority: null, freezeAuthority: null },
  approval: { approver: 'owner', approvedAt: NOW, reference: 'TEST-FIXTURE-1', policyVersion: REGISTRY_ADMISSION_POLICY_VERSION },
  evidence: [{ source: 'issuer-page', providerClass: 'PRODUCTION', observedAt: NOW }] });

test('admission: V0 has no configured authoritative sources, so even a complete request is refused', () => {
  assert.equal(AUTHORITATIVE_SOURCES_V0.length, 0);
  const r = admitToProductionRegistry(good());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.violations.join(), /SOURCE_NOT_AUTHORITATIVE/);
});
test('admission: class is derived from provenance; an asserted class is ignored', () => {
  const r = admitToProductionRegistry({ ...good(), assertedIssuerClass: 'BRIDGE_VERIFIED' }, SRC);
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.asset.issuerClass, 'ISSUER_VERIFIED'); assert.equal(r.asset.registry, 'PRODUCTION'); }
});
test('admission: each missing or contradictory element is refused', () => {
  const g = good();
  const cases: [string, AdmissionRequest][] = [
    ['PROVENANCE_ORIGIN_MISMATCH', { ...g, provenance: { ...g.provenance, url: 'https://evil.example/mints' } }],
    ['PROVENANCE_MINT_MISMATCH', { ...g, provenance: { ...g.provenance, statedMint: SOL! } }],
    ['PROVENANCE_NO_CONTENT_HASH', { ...g, provenance: { ...g.provenance, contentSha256: '' } }],
    ['ONCHAIN_READ_NOT_MAINNET', { ...g, onChainMint: { ...g.onChainMint, cluster: 'devnet' as never } }],
    ['ONCHAIN_READ_TEST_ONLY', { ...g, onChainMint: { ...g.onChainMint, providerClass: 'TEST_ONLY' } }],
    ['DECIMALS_MISMATCH', { ...g, onChainMint: { ...g.onChainMint, decimals: 9 } }],
    ['MINT_NOT_TOKEN_PROGRAM_OWNED', { ...g, onChainMint: { ...g.onChainMint, owner: '11111111111111111111111111111111' } }],
    ['APPROVAL_MISSING', { ...g, approval: { ...g.approval, approver: '' } }],
    ['EVIDENCE_EMPTY', { ...g, evidence: [] }],
    ['EVIDENCE_TEST_ONLY', { ...g, evidence: [{ source: 'x', providerClass: 'TEST_ONLY', observedAt: NOW }] }],
    ['BAD_OR_TEST_ONLY_ID', { ...g, id: 'test-only:usdx' }],
    ['CHAIN_NOT_SOLANA', { ...g, chain: 'ethereum' as never }],
  ];
  for (const [code, req] of cases) { const r = admitToProductionRegistry(req, SRC); assert.equal(r.ok, false, code); if (!r.ok) assert.ok(r.violations.includes(code), `${code}: ${r.violations}`); }
});
