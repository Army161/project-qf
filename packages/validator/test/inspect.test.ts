// inspection-v0.1: mint decoding and Stage 1-3 checks over raw observations. Fixture bytes are built with the encoder and
// round-tripped through the decoder; addresses are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58, isSolanaAddress } from '@project-qf/core';
import { decodeMint, encodeMintForFixture, inspectMint, REQUIRED_LIVE_CHECKS, SPL_TOKEN_PROGRAM, TOKEN_2022_NATIVE_MINT, TOKEN_2022_PROGRAM,
  VALIDATOR_POLICY_V0_1, type MintObservation } from '@project-qf/validator';

const addr = (l: string) => encodeBase58(createHash('sha256').update(`QF-TEST:${l}`).digest());
const MINT = addr('mint');
const AUTH = addr('authority');
interface MintFields { initialized: boolean; mintAuthority: string | null; freezeAuthority: string | null; supplyRaw: string; decimals: number }
const base: MintFields = { initialized: true, mintAuthority: null, freezeAuthority: null, supplyRaw: '5000000', decimals: 6 };
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const spl = (over: Partial<MintFields> = {}) =>
  encodeMintForFixture({ ...base, ...over, tokenProgram: 'SPL_TOKEN' }, decodeBase58);
const t22 = (extensions: { type: number; value: Uint8Array }[]) => encodeMintForFixture({ ...base, tokenProgram: 'TOKEN_2022', extensions }, decodeBase58);
function fee(bps: number, authority: string | null) {
  const v = new Uint8Array(108);
  if (authority) v.set(decodeBase58(authority), 0);
  for (const o of [88, 106]) { v[o] = bps & 0xff; v[o + 1] = bps >> 8; }
  return v;
}
const obs = (provider: string, owner: string, data: Uint8Array | null, over: Partial<MintObservation> = {}): MintObservation => ({
  provider, providerClass: 'PRODUCTION', cluster: 'mainnet-beta', observedAt: '2026-10-03T12:00:00.000Z', slot: '100',
  status: data ? 'OK' : 'NOT_FOUND', ...(data ? { owner, dataBase64: b64(data) } : {}), ...over });
const run = (observations: MintObservation[], mode: 'LIVE' | 'TEST_ONLY' = 'LIVE', mint = MINT) =>
  inspectMint({ mint, cluster: mode === 'LIVE' ? 'mainnet-beta' : 'mock-offline', mode, observations, policy: VALIDATOR_POLICY_V0_1 });
const check = (r: ReturnType<typeof run>, id: string) => r.checks.find((c) => c.id === id)!;

test('base58 encode/decode round-trips 32-byte keys, including leading zeros', () => {
  for (const k of [new Uint8Array(32), Uint8Array.from({ length: 32 }, (_, i) => i), decodeBase58(AUTH)]) {
    const s = encodeBase58(k);
    assert.ok(isSolanaAddress(s));
    assert.deepEqual(decodeBase58(s), k);
  }
  assert.equal(encodeBase58(decodeBase58('So11111111111111111111111111111111111111112')), 'So11111111111111111111111111111111111111112');
});

test('decodeMint reads SPL fields and Token-2022 TLV extensions, and rejects malformed data', () => {
  const d = decodeMint(SPL_TOKEN_PROGRAM, spl({ freezeAuthority: AUTH }));
  assert.ok(d.ok);
  assert.equal(d.facts.freezeAuthority, AUTH); assert.equal(d.facts.mintAuthority, null); assert.equal(d.facts.supplyRaw, '5000000'); assert.equal(d.facts.decimals, 6);
  const t = decodeMint(TOKEN_2022_PROGRAM, t22([{ type: 18, value: new Uint8Array(64) }, { type: 1, value: fee(25, null) }]));
  assert.ok(t.ok);
  assert.deepEqual(t.facts.extensions.map((x) => x.name), ['MetadataPointer', 'TransferFeeConfig']);
  assert.equal(t.facts.extensions[1]!.transferFee!.newer.basisPoints, 25);
  assert.equal(decodeMint('11111111111111111111111111111111', spl()).ok, false);          // not token-program owned
  assert.equal(decodeMint(SPL_TOKEN_PROGRAM, spl().subarray(0, 80)).ok, false);          // truncated
  assert.equal(decodeMint(SPL_TOKEN_PROGRAM, new Uint8Array(165)).ok, false);            // a token account, not a mint
  const bad = t22([{ type: 18, value: new Uint8Array(64) }]); bad[165 + 1 + 2] = 0xff;   // TLV length overruns the account
  assert.equal(decodeMint(TOKEN_2022_PROGRAM, bad).ok, false);
  const badTag = spl(); badTag[0] = 7;                                                    // COption tag must be 0 or 1
  assert.equal(decodeMint(SPL_TOKEN_PROGRAM, badTag).ok, false);
});

test('clean SPL mint with two agreeing providers: Stage 1 passes, but the LIVE aggregate still FAILs on missing Stage 2/3 evidence', () => {
  const r = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl()), obs('rpc-b', SPL_TOKEN_PROGRAM, spl())]);
  for (const id of ['IN.1', 'S1.1', 'S1.2', 'S1.4', 'S1.5', 'S1.6', 'S1.8', 'S1.9', 'S1.10', 'S1.12']) assert.equal(check(r, id).decision, 'PASS', id);
  assert.equal(r.aggregate.decision, 'FAIL');
  assert.ok(r.aggregate.reasons.includes('REQUIRED_CHECK_MISSING S3.2'));
  assert.ok(r.aggregate.reasons.some((x) => x.startsWith('S2.1 FAIL: REGISTRY_ABSENT')));
  for (const id of REQUIRED_LIVE_CHECKS) assert.ok(r.checks.some((c) => c.id === id), `inventory includes ${id}`);
});

test('a single provider leaves S1.12 SKIP, and LIVE mode then cannot pass', () => {
  const r = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl())]);
  assert.equal(check(r, 'S1.12').decision, 'SKIP');
  assert.ok(r.aggregate.reasons.includes('REQUIRED_CHECK_MISSING S1.12'));
});

test('providers that disagree on an authority FAIL S1.12', () => {
  const r = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl()), obs('rpc-b', SPL_TOKEN_PROGRAM, spl({ freezeAuthority: AUTH }))]);
  assert.equal(check(r, 'S1.12').decision, 'FAIL');
  const r2 = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl()), obs('rpc-b', SPL_TOKEN_PROGRAM, null)]); // one says not found
  assert.equal(check(r2, 'S1.12').decision, 'FAIL');
});

test('unavailable evidence is explicit: IN.1 FAIL with the reason, every Stage 1 check SKIP, never a fixture fallback', () => {
  const r = run([obs('rpc-a', '', null, { status: 'UNAVAILABLE', reason: 'NETWORK_POLICY_DENIED (HTTP 403 Host not in allowlist)', slot: null })]);
  assert.equal(check(r, 'IN.1').decision, 'FAIL');
  assert.match(check(r, 'IN.1').reason, /NETWORK_POLICY_DENIED/);
  assert.equal(check(r, 'S1.1').decision, 'SKIP');
  assert.equal(r.facts, null);
  assert.equal(r.aggregate.decision, 'FAIL');
  // TEST_ONLY observations are ignored in LIVE mode, so they cannot stand in for a failed live read.
  const r2 = run([obs('fixture', SPL_TOKEN_PROGRAM, spl(), { providerClass: 'TEST_ONLY' })]);
  assert.equal(check(r2, 'IN.1').decision, 'FAIL');
  assert.match(check(r2, 'IN.1').reason, /TEST_ONLY_IN_LIVE/);
  // Wrong-cluster observations are ignored too.
  const r3 = run([obs('rpc-dev', SPL_TOKEN_PROGRAM, spl(), { cluster: 'devnet' })]);
  assert.match(check(r3, 'IN.1').reason, /WRONG_CLUSTER/);
});

test('account not found on the requested network FAILs S1.1 with a network hint', () => {
  const r = run([obs('rpc-a', SPL_TOKEN_PROGRAM, null)]);
  assert.equal(check(r, 'S1.1').decision, 'FAIL');
  assert.match(check(r, 'S1.1').reason, /ACCOUNT_NOT_FOUND on mainnet-beta/);
});

test('authorities without an allowlisted issuer FAIL; zero supply FAILs; Token-2022 native mint FAILs', () => {
  const r = run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl({ freezeAuthority: AUTH, mintAuthority: AUTH, supplyRaw: '0' }))]);
  assert.equal(check(r, 'S1.8').decision, 'FAIL'); assert.equal(check(r, 'S1.8').details.freezeAuthority, AUTH);
  assert.equal(check(r, 'S1.9').decision, 'FAIL');
  assert.equal(check(r, 'S1.10').decision, 'FAIL');
  const n = run([obs('rpc-a', TOKEN_2022_PROGRAM, t22([]))], 'LIVE', TOKEN_2022_NATIVE_MINT);
  assert.equal(check(n, 'S1.2').decision, 'FAIL');
});

test('extension policy: hook and unknown types FAIL, conditional types WARN and need a badge, metadata-only is permissionless', () => {
  const hook = run([obs('a', TOKEN_2022_PROGRAM, t22([{ type: 14, value: new Uint8Array(64) }]))]);
  assert.equal(check(hook, 'S1.4').decision, 'FAIL'); assert.match(check(hook, 'S1.4').reason, /TransferHook/);
  const unknown = run([obs('a', TOKEN_2022_PROGRAM, t22([{ type: 99, value: new Uint8Array(4) }]))]);
  assert.equal(check(unknown, 'S1.4').decision, 'FAIL'); assert.match(check(unknown, 'S1.4').reason, /Unknown\(99\)/);
  const close = run([obs('a', TOKEN_2022_PROGRAM, t22([{ type: 3, value: new Uint8Array(32) }]))]);
  assert.equal(check(close, 'S1.4').decision, 'WARN');
  assert.equal(check(close, 'S1.6').decision, 'WARN');
  assert.equal(check(close, 'S1.7').decision, 'FAIL'); // badge lookup not implemented: never assumed present
  const meta = run([obs('a', TOKEN_2022_PROGRAM, t22([{ type: 18, value: new Uint8Array(64) }, { type: 19, value: new Uint8Array(10) }]))]);
  assert.equal(check(meta, 'S1.4').decision, 'PASS'); assert.equal(check(meta, 'S1.6').decision, 'PASS'); assert.equal(check(meta, 'S1.7').decision, 'SKIP');
});

test('transfer fee: nonzero FAILs, zero with a live authority FAILs, zero without authority passes S1.5 but still needs a badge', () => {
  const nz = run([obs('a', TOKEN_2022_PROGRAM, t22([{ type: 1, value: fee(1, null) }]))]);
  assert.equal(check(nz, 'S1.5').decision, 'FAIL'); assert.equal(check(nz, 'S1.4').decision, 'FAIL');
  const auth = run([obs('a', TOKEN_2022_PROGRAM, t22([{ type: 1, value: fee(0, AUTH) }]))]);
  assert.equal(check(auth, 'S1.5').decision, 'FAIL');
  const zero = run([obs('a', TOKEN_2022_PROGRAM, t22([{ type: 1, value: fee(0, null) }]))]);
  assert.equal(check(zero, 'S1.5').decision, 'PASS'); assert.equal(check(zero, 'S1.4').decision, 'WARN'); assert.equal(check(zero, 'S1.7').decision, 'FAIL');
});

test('TEST_ONLY inspections are never PASS, and an invalid mint or mode FAILs', () => {
  const t = inspectMint({ mint: MINT, cluster: 'mock-offline', mode: 'TEST_ONLY', policy: VALIDATOR_POLICY_V0_1,
    observations: [obs('fx-a', SPL_TOKEN_PROGRAM, spl(), { providerClass: 'TEST_ONLY', cluster: 'mock-offline' }), obs('fx-b', SPL_TOKEN_PROGRAM, spl(), { providerClass: 'TEST_ONLY', cluster: 'mock-offline' })] });
  assert.notEqual(t.aggregate.decision, 'PASS');
  assert.equal(run([], 'LIVE', 'not-a-mint').aggregate.decision, 'FAIL');
  assert.equal(inspectMint({ mint: MINT, cluster: 'mainnet-beta', mode: 'BOGUS' as never, observations: [], policy: VALIDATOR_POLICY_V0_1 }).aggregate.decision, 'FAIL');
});

test('the check inventory is complete on every evidence path: all 26 QUOTE-ASSETS checks are listed, skipped ones with a reason', () => {
  const ids = ['IN.1', ...Array.from({ length: 12 }, (_, k) => `S1.${k + 1}`), ...Array.from({ length: 5 }, (_, k) => `S2.${k + 1}`), ...Array.from({ length: 8 }, (_, k) => `S3.${k + 1}`)].sort();
  const cases = {
    ok: run([obs('rpc-a', SPL_TOKEN_PROGRAM, spl()), obs('rpc-b', SPL_TOKEN_PROGRAM, spl())]),
    unavailable: run([obs('rpc-a', '', null, { status: 'UNAVAILABLE', reason: 'TIMEOUT after 15000 ms', slot: null })]),
    notFound: run([obs('rpc-a', SPL_TOKEN_PROGRAM, null)]),
    notMint: run([obs('rpc-a', '11111111111111111111111111111111', spl())]),
  };
  for (const [name, r] of Object.entries(cases)) {
    assert.deepEqual(r.checks.map((c) => c.id).sort(), ids, name);
    assert.equal(r.coverage.total, 26, name);
    for (const c of r.checks) if (c.decision === 'SKIP') assert.ok(c.reason.length > 0, `${name} ${c.id}`);
  }
});
