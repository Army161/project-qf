// inspection-v0.2 (decision D3, 2026-10-03): the classic SPL native mint's supply field does not count wrapped SOL, so S1.10
// is an evaluated NOT_APPLICABLE for exactly that mint on a genesis-verified cluster, with evidence and a policy reference.
// Everything else that looks like an exception is still a failure, and the aggregate accepts NOT_APPLICABLE only where it
// can re-derive the exception from the subject itself (a caller cannot assert one). Also covers operator independence for
// S1.12 and the wrong-network hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58, type CheckResult } from '@project-qf/core';
import { aggregate, CLASSIC_NATIVE_MINT, encodeMintForFixture, INSPECTION_VERSION, inspectMint, S1_10_NATIVE_MINT_EXCEPTION, SPL_TOKEN_PROGRAM,
  TOKEN_2022_NATIVE_MINT, TOKEN_2022_PROGRAM, VALIDATOR_POLICY_V0_1, type InspectionCluster, type MintObservation } from '@project-qf/validator';

const addr = (l: string) => encodeBase58(createHash('sha256').update(`QF-TEST:${l}`).digest());
const AUTH = addr('authority');
const SYSTEM = '11111111111111111111111111111111';
interface F { initialized: boolean; mintAuthority: string | null; freezeAuthority: string | null; supplyRaw: string; decimals: number }
const native: F = { initialized: true, mintAuthority: null, freezeAuthority: null, supplyRaw: '0', decimals: 9 };
const spl = (over: Partial<F> = {}) => encodeMintForFixture({ ...native, ...over, tokenProgram: 'SPL_TOKEN' }, decodeBase58);
const t22 = (over: Partial<F> = {}) => encodeMintForFixture({ ...native, ...over, tokenProgram: 'TOKEN_2022' }, decodeBase58);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const obs = (provider: string, owner: string, data: Uint8Array | null, over: Partial<MintObservation> = {}): MintObservation => ({
  provider, providerClass: 'PRODUCTION', cluster: 'mainnet-beta', observedAt: '2026-10-03T12:00:00.000Z', slot: '100',
  status: data ? 'OK' : 'NOT_FOUND', ...(data ? { owner, dataBase64: b64(data) } : {}), ...over });
const run = (observations: MintObservation[], mint = CLASSIC_NATIVE_MINT, cluster: InspectionCluster = 'mainnet-beta', mode: 'LIVE' | 'TEST_ONLY' = 'LIVE') =>
  inspectMint({ mint, cluster, mode, observations: observations.map((o) => ({ ...o, cluster: cluster === 'mock-offline' ? 'mock-offline' : o.cluster === 'mainnet-beta' ? cluster : o.cluster })), policy: VALIDATOR_POLICY_V0_1 });
const check = (r: ReturnType<typeof run>, id: string) => r.checks.find((c) => c.id === id)!;

test('the exception is a versioned, narrow policy object', () => {
  assert.equal(INSPECTION_VERSION, 'inspection-v0.2');
  assert.equal(CLASSIC_NATIVE_MINT, 'So11111111111111111111111111111111111111112');
  assert.equal(S1_10_NATIVE_MINT_EXCEPTION.check, 'S1.10');
  assert.equal(S1_10_NATIVE_MINT_EXCEPTION.reason, 'NATIVE_MINT_SUPPLY_NOT_TRACKED');
  assert.equal(S1_10_NATIVE_MINT_EXCEPTION.mint, CLASSIC_NATIVE_MINT);
  assert.equal(S1_10_NATIVE_MINT_EXCEPTION.owner, SPL_TOKEN_PROGRAM);
  assert.equal(S1_10_NATIVE_MINT_EXCEPTION.decimals, 9);
  assert.ok(Object.isFrozen(S1_10_NATIVE_MINT_EXCEPTION));
});

test('classic native mint on mainnet and devnet: S1.10 is NOT_APPLICABLE with the raw supply kept, and nothing else is waived', () => {
  for (const cluster of ['mainnet-beta', 'devnet'] as const) {
    const r = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl())], CLASSIC_NATIVE_MINT, cluster);
    const c = check(r, 'S1.10');
    assert.equal(c.decision, 'NOT_APPLICABLE', cluster);
    assert.match(c.reason, /^NATIVE_MINT_SUPPLY_NOT_TRACKED/);
    assert.equal(c.details.supplyRaw, '0');
    assert.equal(c.details.exception, S1_10_NATIVE_MINT_EXCEPTION.id);
    assert.equal(c.evidence.length, 1);
    assert.equal(r.facts!.supplyRaw, '0');                                    // raw observation preserved, nothing invented
    assert.ok(!r.aggregate.reasons.includes('REQUIRED_CHECK_MISSING S1.10'));
    assert.ok(!r.aggregate.reasons.some((x) => x.startsWith('S1.10 FAIL')));
    assert.ok(r.aggregate.reasons.includes('S1.10 NOT_APPLICABLE: NATIVE_MINT_SUPPLY_NOT_TRACKED'));
    // Not registry admission, not approval: the other gates still decide.
    assert.equal(r.aggregate.decision, 'FAIL');
    assert.ok(r.aggregate.reasons.includes('REQUIRED_CHECK_MISSING S1.12'));
    assert.ok(r.aggregate.reasons.some((x) => x.startsWith('REQUIRED_CHECK_MISSING S3.')));
    assert.equal(r.coverage.notApplicable, 1);
    assert.equal(r.coverage.evaluated + r.coverage.skipped, r.coverage.total);
  }
  const m = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl())]);
  assert.ok(m.aggregate.reasons.some((x) => x.startsWith('S2.1 FAIL: REGISTRY_ABSENT')));
});

test('the exception does not apply to anything else: ordinary zero supply, contradictions, Token-2022 and fixtures still FAIL', () => {
  const zero = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl())], addr('ordinary-mint'));
  assert.equal(check(zero, 'S1.10').decision, 'FAIL');
  assert.equal(check(zero, 'S1.10').reason, 'ZERO_SUPPLY');
  const contradictions: [string, Partial<F>][] = [['decimals', { decimals: 6 }], ['mint authority', { mintAuthority: AUTH }], ['freeze authority', { freezeAuthority: AUTH }]];
  for (const [what, over] of contradictions) {
    const c = check(run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl(over))]), 'S1.10');
    assert.equal(c.decision, 'FAIL', what);
    assert.match(c.reason, /^ZERO_SUPPLY: native-mint exception not applied/, what);
  }
  // The native-mint address owned by Token-2022 is not the classic native mint.
  const owned22 = check(run([obs('rpc-a', TOKEN_2022_PROGRAM, t22())]), 'S1.10');
  assert.equal(owned22.decision, 'FAIL');
  // The Token-2022 native mint gets no exemption.
  const t22native = run([obs('rpc-a', TOKEN_2022_PROGRAM, t22())], TOKEN_2022_NATIVE_MINT);
  assert.equal(check(t22native, 'S1.10').decision, 'FAIL');
  assert.equal(check(t22native, 'S1.2').decision, 'FAIL');
  // TEST_ONLY fixtures are not a genesis-verified cluster.
  const fixture = run([obs('fixture', SPL_TOKEN_PROGRAM, spl(), { providerClass: 'TEST_ONLY' })], CLASSIC_NATIVE_MINT, 'mock-offline', 'TEST_ONLY');
  assert.equal(check(fixture, 'S1.10').decision, 'FAIL');
  // Uninitialized or malformed accounts never reach S1.10.
  assert.equal(check(run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl({ initialized: false }))]), 'S1.10').decision, 'SKIP');
  assert.equal(check(run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl().subarray(0, 70))]), 'S1.10').decision, 'SKIP');
  // A nonzero native supply needs no exception.
  assert.equal(check(run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl({ supplyRaw: '5' }))]), 'S1.10').decision, 'PASS');
});

const n = (id: string, details: Record<string, string> = { exception: S1_10_NATIVE_MINT_EXCEPTION.id, supplyRaw: '0' }): CheckResult =>
  ({ id, decision: 'NOT_APPLICABLE', reason: 'NATIVE_MINT_SUPPLY_NOT_TRACKED', evidence: [], details, policyVersion: 'validator-v0.1' });
const nativeFacts = { tokenProgram: 'SPL_TOKEN' as const, initialized: true, mintAuthority: null, freezeAuthority: null, supplyRaw: '0', decimals: 9, extensions: [] };
const subject = { mint: CLASSIC_NATIVE_MINT, cluster: 'mainnet-beta' as const, owner: SPL_TOKEN_PROGRAM, facts: nativeFacts };

test('the aggregate re-derives the exception from the subject: a caller-asserted NOT_APPLICABLE is never accepted', () => {
  const ok = aggregate([n('S1.10')], 'TEST_ONLY', subject);
  assert.ok(!ok.reasons.some((x) => x.startsWith('INVALID_NOT_APPLICABLE')), ok.reasons.join('|'));
  const cases: [string, ReturnType<typeof aggregate>][] = [
    ['no subject', aggregate([n('S1.10')], 'TEST_ONLY')],
    ['other mint', aggregate([n('S1.10')], 'TEST_ONLY', { ...subject, mint: addr('other') })],
    ['fixture cluster', aggregate([n('S1.10')], 'TEST_ONLY', { ...subject, cluster: 'mock-offline' })],
    ['wrong owner', aggregate([n('S1.10')], 'TEST_ONLY', { ...subject, owner: TOKEN_2022_PROGRAM })],
    ['authority present', aggregate([n('S1.10')], 'TEST_ONLY', { ...subject, facts: { ...nativeFacts, freezeAuthority: AUTH } })],
    ['nonzero supply', aggregate([n('S1.10')], 'TEST_ONLY', { ...subject, facts: { ...nativeFacts, supplyRaw: '7' } })],
    ['missing exception ref', aggregate([n('S1.10', { supplyRaw: '0' })], 'TEST_ONLY', subject)],
    ['another required check', aggregate([n('S1.12')], 'TEST_ONLY', subject)],
    ['a non-required check', aggregate([n('S3.3')], 'TEST_ONLY', subject)],
  ];
  for (const [what, r] of cases) {
    assert.equal(r.decision, 'FAIL', what);
    assert.ok(r.reasons.some((x) => x.startsWith('INVALID_NOT_APPLICABLE')), `${what}: ${r.reasons.join('|')}`);
  }
  // Required SKIP is still missing; NOT_APPLICABLE does not make SKIP acceptable anywhere else.
  const live = aggregate([{ ...n('S1.10'), decision: 'SKIP' }], 'LIVE', subject);
  assert.ok(live.reasons.includes('REQUIRED_CHECK_MISSING S1.10'));
});

test('two providers: agreement on the native mint passes S1.12, disagreement still FAILs it', () => {
  const agree = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl(), { operator: 'op-a' }), obs('rpc-b', SPL_TOKEN_PROGRAM, spl(), { operator: 'op-b' })]);
  assert.equal(check(agree, 'S1.12').decision, 'PASS');
  assert.equal(check(agree, 'S1.10').decision, 'NOT_APPLICABLE');
  const disagree = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl(), { operator: 'op-a' }), obs('rpc-b', SPL_TOKEN_PROGRAM, spl({ freezeAuthority: AUTH }), { operator: 'op-b' })]);
  assert.equal(check(disagree, 'S1.12').decision, 'FAIL');
});

test('two endpoints of one operator are not independent: S1.12 stays SKIP', () => {
  const r = run([obs('mainnet.helius-rpc.com', SPL_TOKEN_PROGRAM, spl(), { operator: 'helius' }), obs('mainnet.helius-rpc.com#2', SPL_TOKEN_PROGRAM, spl(), { operator: 'helius' })]);
  const c = check(r, 'S1.12');
  assert.equal(c.decision, 'SKIP');
  assert.match(c.reason, /^NOT_INDEPENDENT: 2 answers from 1 operator \(helius\)/);
  // Without an operator label each provider id is its own operator (unchanged behaviour).
  const legacy = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl()), obs('rpc-b', SPL_TOKEN_PROGRAM, spl())]);
  assert.equal(check(legacy, 'S1.12').decision, 'PASS');
});

test('wrong network: a System-owned address says it is not a mint on this network, keeping the machine-readable reason', () => {
  const r = run([obs('rpc-a', SYSTEM, new Uint8Array(0))], addr('mint-on-other-network'), 'devnet');
  const c = check(r, 'S1.1');
  assert.equal(c.decision, 'FAIL');
  assert.match(c.reason, /^NOT_A_VALID_MINT: NOT_TOKEN_PROGRAM_OWNED 1{32}/);
  assert.match(c.reason, /not a mint on this network; check the network/);
  assert.equal(c.details.hint, 'WRONG_NETWORK_OR_NOT_A_MINT');
  // Other owners keep the plain reason.
  const prog = check(run([obs('rpc-a', 'BPFLoaderUpgradeab1e11111111111111111111111', new Uint8Array(36))], addr('program')), 'S1.1');
  assert.doesNotMatch(prog.reason, /check the network/);
});
