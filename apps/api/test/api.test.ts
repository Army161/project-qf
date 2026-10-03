// The integrated read-only slice over HTTP: inspect a mint, persist the report, save a creator draft against it, reload
// both from a reopened database. Live reads use an in-process fake fetch; no network, no wallet, no signing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { decodeBase58 } from '@project-qf/core';
import { encodeMintForFixture } from '@project-qf/validator';
import type { DraftInput, DraftView, InspectionView } from '@project-qf/contracts';
import { FIXTURE_MINTS, mockAddress } from '../src/fixtures.ts';
import { clearGenesisCache, endpointFromUrl, GENESIS, type FetchLike, type LiveCluster, type RpcEndpoint } from '../src/rpc.ts';
import { createApp, currentPolicyRefs, INSPECTIONS_PER_MINUTE, STALE_AFTER_SECONDS } from '../src/server.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'qf-api-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const QUSD = 'EtriFwkv36LDftunesYPdxScW2KU5BK55pcm7qwBonXn';
const LIVE_MINT = mockAddress('live-read-mint');
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const mintBytes = encodeMintForFixture({ tokenProgram: 'SPL_TOKEN', initialized: true, mintAuthority: null, freezeAuthority: null, supplyRaw: '1000000', decimals: 6, extensions: [] }, decodeBase58);

/** Fake JSON-RPC: answers by method. `genesis` lets a test serve the wrong network. */
function fakeRpc(o: { genesis?: string; deny?: boolean; calls?: string[] } = {}): FetchLike {
  return async (_url, init) => {
    if (o.deny) return new Response('Host not in allowlist', { status: 403 });
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    o.calls?.push(method);
    const result = method === 'getGenesisHash' ? (o.genesis ?? GENESIS['mainnet-beta'])
      : method === 'getAccountInfo' ? { context: { slot: 321 }, value: params[0] === LIVE_MINT ? { owner: SPL, data: [Buffer.from(mintBytes).toString('base64'), 'base64'] } : null }
      : method === 'getTokenLargestAccounts' ? { context: { slot: 321 }, value: [{ address: mockAddress('h0'), amount: '250000' }, { address: mockAddress('h1'), amount: '50000' }] }
      : undefined;
    return new Response(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id: 1, error: { code: -32601 } } : { jsonrpc: '2.0', id: 1, result }));
  };
}
const endpoints = (...hosts: string[]): Record<LiveCluster, RpcEndpoint[]> =>
  ({ 'mainnet-beta': hosts.map((h) => endpointFromUrl(`https://${h}/`, 'mainnet-beta')), devnet: [] });

interface Running { url: string; store: Store; server: Server; clock: { t: number } }
async function start(o: { dbName?: string; fetchImpl?: FetchLike; eps?: Record<LiveCluster, RpcEndpoint[]>; staticDir?: string | null } = {}): Promise<Running> {
  clearGenesisCache();
  const store = new Store(join(dir, o.dbName ?? `db-${Math.random().toString(16).slice(2)}.sqlite`));
  const clock = { t: Date.parse('2026-10-03T12:00:00.000Z') };
  const server = createApp({ store, staticDir: o.staticDir ?? null, now: () => new Date(clock.t),
    inspect: { endpoints: o.eps ?? endpoints('rpc-a.example.test'), fetchImpl: o.fetchImpl ?? fakeRpc(), now: () => new Date(clock.t) } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, server, clock };
}
async function stop(r: Running) { await new Promise((ok) => r.server.close(ok)); r.store.close(); }
async function call(r: Running, token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(r.url + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
}
const draftFor = (insp: InspectionView, over: Record<string, unknown> = {}) =>
  ({ name: 'Creator Coin', symbol: 'CRTR', description: 'Paired with the inspected quote asset.', quoteMint: insp.mint, cluster: insp.cluster, inspectionId: insp.id, ...over });

test('authentication: healthz is open, everything else needs a valid bearer token', async () => {
  const r = await start();
  try {
    assert.equal((await call(r, null, 'GET', '/api/healthz')).json.ok, true);
    assert.equal((await call(r, null, 'GET', '/api/session')).status, 401);
    assert.equal((await call(r, `qf_${'0'.repeat(64)}`, 'GET', '/api/drafts')).status, 401);
    assert.equal((await call(r, 'garbage token', 'GET', '/api/drafts')).status, 401);
    const { token, user } = r.store.createUser('alice');
    const s = await call(r, token, 'GET', '/api/session');
    assert.equal(s.json.user.id, user.id);
    assert.deepEqual(s.json.policies, currentPolicyRefs());
    assert.equal(s.headers.get('cache-control'), 'no-store');
    const fx = await call(r, token, 'GET', '/api/fixtures');
    assert.equal(fx.json.label, 'TEST_ONLY');
    assert.ok(fx.json.mints.some((m: { mint: string }) => m.mint === QUSD));
    assert.equal((await call(r, null, 'GET', '/api/fixtures')).status, 401);
  } finally { await stop(r); }
});

test('the integrated slice: inspect (TEST_ONLY), save a draft, reload both after the server and database are reopened', async () => {
  const dbName = 'slice.sqlite';
  let r = await start({ dbName });
  const { token } = r.store.createUser('creator');
  let insp: InspectionView, draft: DraftView;
  try {
    const res = await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' });
    assert.equal(res.status, 201);
    insp = res.json;
    assert.equal(insp.label, 'TEST_ONLY_FIXTURE');
    assert.equal(insp.inspection.mode, 'TEST_ONLY');
    assert.notEqual(insp.inspection.aggregate.decision, 'PASS');
    assert.ok(insp.reads.every((x) => x.providerClass === 'TEST_ONLY' && x.status === 'OK' && x.slot === '1000'));
    assert.equal(insp.freshness, 'FRESH');
    assert.equal(insp.features.components.find((c) => c.id === 'top1_account_share_bps')!.value, '4000');
    assert.equal(insp.features.overallScore, null);
    assert.match(insp.evidenceDigest, /^[0-9a-f]{64}$/);

    const d = await call(r, token, 'POST', '/api/drafts', draftFor(insp));
    assert.equal(d.status, 201);
    draft = d.json;
    assert.equal(draft.version, 1);
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.inspectionDigest, insp.reportDigest);
    assert.equal(draft.inspectionDecision, insp.inspection.aggregate.decision);
    assert.deepEqual(draft.policyRefs, currentPolicyRefs());
    assert.equal(draft.policyStale, false);
  } finally { await stop(r); }

  r = await start({ dbName });
  try {
    assert.equal(r.store.schemaVersion(), 1);
    const back = await call(r, token, 'GET', `/api/drafts/${draft.id}`);
    assert.equal(back.status, 200);
    assert.deepEqual(back.json, draft);
    const i2 = await call(r, token, 'GET', `/api/inspections/${insp.id}`);
    assert.equal(i2.json.reportDigest, insp.reportDigest);
    assert.deepEqual(i2.json.inspection, insp.inspection);
    assert.deepEqual((await call(r, token, 'GET', '/api/drafts')).json.drafts.map((x: DraftView) => x.id), [draft.id]);
    assert.deepEqual((await call(r, token, 'GET', '/api/inspections')).json.inspections.map((x: { id: string }) => x.id), [insp.id]);
  } finally { await stop(r); }
});

test('a blocked live read is shown as UNAVAILABLE and FAILs; it never falls back to fixtures, even for a fixture mint', async () => {
  const r = await start({ fetchImpl: fakeRpc({ deny: true }) });
  const { token } = r.store.createUser('u');
  try {
    const res = await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'mainnet-beta' });
    assert.equal(res.status, 201);
    const v: InspectionView = res.json;
    assert.equal(v.label, 'LIVE_READ');
    assert.deepEqual(v.reads.map((x) => [x.provider, x.status, x.reason, x.genesisVerified]),
      [['rpc-a.example.test', 'UNAVAILABLE', 'NETWORK_POLICY_DENIED (HTTP 403 Host not in allowlist)', false]]);
    assert.equal(v.inspection.facts, null);
    assert.equal(v.inspection.checks.find((c) => c.id === 'IN.1')!.decision, 'FAIL');
    assert.equal(v.inspection.aggregate.decision, 'FAIL');
    assert.ok(!JSON.stringify(v).includes('test-only'), 'no fixture provider appears in a live report');
    assert.equal(v.features.coverage.measured, 0);
  } finally { await stop(r); }
});

test('an endpoint serving the wrong network is rejected by genesis hash before any account read', async () => {
  const calls: string[] = [];
  const r = await start({ fetchImpl: fakeRpc({ genesis: GENESIS.devnet, calls }) });
  const { token } = r.store.createUser('u');
  try {
    const v: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: LIVE_MINT, cluster: 'mainnet-beta' })).json;
    assert.match(v.reads[0]!.reason!, /^WRONG_NETWORK/);
    assert.equal(v.reads[0]!.genesisVerified, false);
    assert.deepEqual(calls, ['getGenesisHash']);
    assert.equal(v.inspection.aggregate.decision, 'FAIL');
  } finally { await stop(r); }
});

test('a successful live read from two providers passes Stage 1 but stays FAIL while Stage 2/3 evidence is missing', async () => {
  // Independence is counted by operator (inspection-v0.2), so the two fakes use different domains.
  const r = await start({ eps: endpoints('rpc.provider-a.test', 'rpc.provider-b.test') });
  const { token } = r.store.createUser('u');
  try {
    const v: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: LIVE_MINT, cluster: 'mainnet-beta' })).json;
    assert.deepEqual(v.reads.map((x) => [x.provider, x.method, x.status, x.slot, x.genesisVerified]), [
      ['rpc.provider-a.test', 'getAccountInfo', 'OK', '321', true], ['rpc.provider-b.test', 'getAccountInfo', 'OK', '321', true],
      ['rpc.provider-a.test', 'getTokenLargestAccounts', 'OK', '321', true]]);
    for (const id of ['IN.1', 'S1.1', 'S1.12', 'S1.8', 'S1.9']) assert.equal(v.inspection.checks.find((c) => c.id === id)!.decision, 'PASS', id);
    assert.equal(v.inspection.aggregate.decision, 'FAIL');
    assert.ok(v.inspection.aggregate.reasons.some((x) => x.startsWith('REQUIRED_CHECK_MISSING S3')));
    assert.equal(v.features.components.find((c) => c.id === 'top1_account_share_bps')!.value, '2500');
    // Not found on mainnet: S1.1 FAIL with a network hint.
    const nf: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'mainnet-beta' })).json;
    assert.match(nf.inspection.checks.find((c) => c.id === 'S1.1')!.reason, /ACCOUNT_NOT_FOUND on mainnet-beta/);
    // No configured devnet provider is explicit.
    const dv: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: LIVE_MINT, cluster: 'devnet' })).json;
    assert.equal(dv.reads[0]!.reason, 'NO_PROVIDER_CONFIGURED for devnet');
    assert.equal(dv.inspection.aggregate.decision, 'FAIL');
  } finally { await stop(r); }
});

test('records are owner-scoped: another user gets 404 for inspections and drafts, and cannot link them', async () => {
  const r = await start();
  const a = r.store.createUser('a').token, b = r.store.createUser('b').token;
  try {
    const insp: InspectionView = (await call(r, a, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).json;
    const draft: DraftView = (await call(r, a, 'POST', '/api/drafts', draftFor(insp))).json;
    assert.equal((await call(r, b, 'GET', `/api/inspections/${insp.id}`)).status, 404);
    assert.equal((await call(r, b, 'GET', `/api/drafts/${draft.id}`)).status, 404);
    assert.equal((await call(r, b, 'PUT', `/api/drafts/${draft.id}`, { ...draftFor(insp), expectedVersion: 1 })).status, 404);
    assert.equal((await call(r, b, 'POST', '/api/drafts', draftFor(insp))).json.error.code, 'INSPECTION_NOT_FOUND');
    assert.deepEqual((await call(r, b, 'GET', '/api/drafts')).json.drafts, []);
    assert.deepEqual((await call(r, b, 'GET', '/api/inspections')).json.inspections, []);
  } finally { await stop(r); }
});

test('draft updates use optimistic versions with append-only history; a stale version gets 409', async () => {
  const r = await start();
  const { token } = r.store.createUser('u');
  try {
    const insp: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).json;
    const d: DraftView = (await call(r, token, 'POST', '/api/drafts', draftFor(insp))).json;
    r.clock.t += 5000;
    const u1 = await call(r, token, 'PUT', `/api/drafts/${d.id}`, { ...draftFor(insp, { name: 'Renamed' }), expectedVersion: 1 });
    assert.equal(u1.status, 200);
    assert.equal(u1.json.version, 2);
    assert.equal(u1.json.createdAt, d.createdAt);
    assert.notEqual(u1.json.updatedAt, d.updatedAt);
    const stale = await call(r, token, 'PUT', `/api/drafts/${d.id}`, { ...draftFor(insp, { name: 'Lost update' }), expectedVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT');
    assert.equal((await call(r, token, 'GET', `/api/drafts/${d.id}`)).json.name, 'Renamed');
    assert.equal(r.store.draftHistoryCount(d.id), 2);
  } finally { await stop(r); }
});

test('a draft must reference an inspection of the same mint and network', async () => {
  const r = await start();
  const { token } = r.store.createUser('u');
  try {
    const insp: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).json;
    const other = mockAddress('t22-metadata-only');
    assert.equal((await call(r, token, 'POST', '/api/drafts', draftFor(insp, { quoteMint: other }))).json.error.code, 'INSPECTION_MISMATCH');
    assert.equal((await call(r, token, 'POST', '/api/drafts', draftFor(insp, { cluster: 'devnet' }))).json.error.code, 'INSPECTION_MISMATCH');
    const missing = await call(r, token, 'POST', '/api/drafts', draftFor(insp, { inspectionId: `insp_${'0'.repeat(32)}` }));
    assert.equal(missing.status, 422);
    assert.equal(missing.json.error.code, 'INSPECTION_NOT_FOUND');
    const bad = await call(r, token, 'POST', '/api/drafts', draftFor(insp, { status: 'LAUNCHED' }));
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.error.details, ['UNKNOWN_FIELD status']);
  } finally { await stop(r); }
});

test('request hygiene: JSON only, bounded bodies, bad JSON, unknown routes and methods', async () => {
  const r = await start();
  const { token } = r.store.createUser('u');
  try {
    assert.equal((await call(r, token, 'POST', '/api/inspections', `mint=${QUSD}`, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await call(r, token, 'POST', '/api/inspections', JSON.stringify({ mint: QUSD, cluster: 'test-only', pad: 'x'.repeat(20_000) }))).status, 413);
    assert.equal((await call(r, token, 'POST', '/api/inspections', '{not json')).json.error.code, 'BAD_JSON');
    assert.equal((await call(r, token, 'GET', '/api/nope')).status, 404);
    assert.equal((await call(r, token, 'DELETE', '/api/drafts')).status, 405);
    assert.equal((await call(r, token, 'GET', '/api/inspections/insp_not-an-id')).status, 404);
  } finally { await stop(r); }
});

test(`inspections are rate limited to ${INSPECTIONS_PER_MINUTE} per minute per user`, async () => {
  const r = await start();
  const a = r.store.createUser('a').token, b = r.store.createUser('b').token;
  try {
    for (let i = 0; i < INSPECTIONS_PER_MINUTE; i++) assert.equal((await call(r, a, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).status, 201);
    assert.equal((await call(r, a, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).status, 429);
    assert.equal((await call(r, b, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).status, 201);
    r.clock.t += 61_000;
    assert.equal((await call(r, a, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).status, 201);
  } finally { await stop(r); }
});

test('stored reports show their age, turn STALE after the revalidation window, and a tampered report is refused', async () => {
  const r = await start();
  const { token } = r.store.createUser('u');
  try {
    const insp: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).json;
    r.clock.t += (STALE_AFTER_SECONDS + 1) * 1000;
    const later = (await call(r, token, 'GET', `/api/inspections/${insp.id}`)).json;
    assert.equal(later.freshness, 'STALE');
    assert.equal(later.ageSeconds, STALE_AFTER_SECONDS + 1);
    const row = r.store.db.prepare('SELECT report_json FROM inspections WHERE id = ?').get(insp.id) as { report_json: string };
    const tampered = JSON.parse(row.report_json);
    tampered.inspection.aggregate.decision = 'PASS';
    r.store.db.prepare('UPDATE inspections SET report_json = ? WHERE id = ?').run(JSON.stringify(tampered), insp.id);
    const t = await call(r, token, 'GET', `/api/inspections/${insp.id}`);
    assert.equal(t.status, 500);
    assert.equal(t.json.error.code, 'INTEGRITY_ERROR');
  } finally { await stop(r); }
});

test('a draft saved under older policies reads back as policy-stale with the changed policies named', async () => {
  const r = await start();
  const { token, user } = r.store.createUser('u');
  try {
    const insp: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).json;
    const old = { ...currentPolicyRefs(), validator: 'validator-v0.0', economics: { version: 'economics-old', digest: '0'.repeat(64) } };
    const t = new Date(r.clock.t).toISOString();
    const input = draftFor(insp) as unknown as DraftInput;
    const d = r.store.insertDraft(user.id, { ...input, version: 1, status: 'DRAFT', createdAt: t, updatedAt: t,
      inspectionDigest: insp.reportDigest, inspectionDecision: 'WARN', policyRefs: old });
    const v: DraftView = (await call(r, token, 'GET', `/api/drafts/${d.id}`)).json;
    assert.equal(v.policyStale, true);
    assert.deepEqual(v.policyChanges, ['economics', 'validator']);
  } finally { await stop(r); }
});

test('the database refuses a schema newer than the build', () => {
  const p = join(dir, 'future.sqlite');
  const s = new Store(p);
  s.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)').run('2030-01-01T00:00:00Z');
  s.close();
  assert.throws(() => new Store(p), /schema 99 is newer than this build/);
});

test('static hosting: CSP headers on the app, no path traversal, no symlink escape', async () => {
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>QF</title>');
  writeFileSync(join(dir, 'secret.txt'), 'outside');
  symlinkSync(join(dir, 'secret.txt'), join(web, 'link.txt'));
  const r = await start({ staticDir: web });
  try {
    const res = await fetch(`${r.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy')!, /connect-src 'self'/);
    assert.match(res.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/link.txt', '/%E0%A4%A', '/missing.js']) assert.equal((await fetch(r.url + p)).status, 404, p);
    assert.equal((await fetch(`${r.url}/`, { method: 'POST' })).status, 405);
  } finally { await stop(r); }
});

test('fixture mints are labelled synthetic and the fixture set covers the extension policy cases', () => {
  assert.ok(Object.keys(FIXTURE_MINTS).includes(QUSD));
  assert.ok(Object.values(FIXTURE_MINTS).some((f) => f.extensions?.some((x) => x.type === 14)));
  assert.ok(Object.values(FIXTURE_MINTS).some((f) => f.disagreeOnB));
});

test('planning drafts: a stale or failed report can be saved, with its original references and prominent labels, and nothing is refreshed', async () => {
  const r = await start();
  const { token } = r.store.createUser('u');
  try {
    const insp: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).json;
    r.clock.t += (STALE_AFTER_SECONDS + 60) * 1000;
    const res = await call(r, token, 'POST', '/api/drafts', draftFor(insp));
    assert.equal(res.status, 201);
    const d: DraftView = res.json;
    assert.deepEqual(d.basis, { reportDigest: insp.reportDigest, observedAt: insp.createdAt, decision: insp.inspection.aggregate.decision,
      label: 'TEST_ONLY_FIXTURE', freshnessAtSave: 'STALE', ageSecondsAtSave: STALE_AFTER_SECONDS + 60, policies: insp.policies });
    for (const l of ['PLANNING_DRAFT', 'EVIDENCE_STALE_AT_SAVE', 'EVIDENCE_STALE_NOW', `INSPECTION_${insp.inspection.aggregate.decision}`, 'TEST_ONLY_EVIDENCE']) {
      assert.ok(d.labels.includes(l), `label ${l} in ${d.labels.join(',')}`);
    }
    assert.match(d.notice, /does not refresh evidence/);
    assert.match(d.notice, /not consent/);
    // Saving never ran or substituted a new inspection.
    assert.deepEqual((await call(r, token, 'GET', '/api/inspections')).json.inspections.map((x: { id: string }) => x.id), [insp.id]);
    assert.equal(d.inspectionId, insp.id);
  } finally { await stop(r); }
});

test('editing a planning draft keeps the policies and evidence basis it was saved under; it does not re-consent', async () => {
  const r = await start();
  const { token, user } = r.store.createUser('u');
  try {
    const insp: InspectionView = (await call(r, token, 'POST', '/api/inspections', { mint: QUSD, cluster: 'test-only' })).json;
    const old = { ...currentPolicyRefs(), features: 'features-v0.1', inspection: 'inspection-v0.1' };
    const t = new Date(r.clock.t).toISOString();
    const basis = { reportDigest: insp.reportDigest, observedAt: insp.createdAt, decision: insp.inspection.aggregate.decision, label: insp.label,
      freshnessAtSave: 'FRESH' as const, ageSecondsAtSave: 0, policies: insp.policies };
    const d = r.store.insertDraft(user.id, { ...(draftFor(insp) as unknown as DraftInput), version: 1, status: 'DRAFT', createdAt: t, updatedAt: t,
      inspectionDigest: insp.reportDigest, inspectionDecision: insp.inspection.aggregate.decision, policyRefs: old, basis });
    r.clock.t += 5000;
    const u = await call(r, token, 'PUT', `/api/drafts/${d.id}`, { ...draftFor(insp, { name: 'Renamed plan' }), expectedVersion: 1 });
    assert.equal(u.status, 200);
    assert.deepEqual(u.json.policyRefs, old);
    assert.deepEqual(u.json.basis, basis);
    assert.equal(u.json.policyStale, true);
    assert.deepEqual(u.json.policyChanges, ['inspection', 'features']);
    assert.ok(u.json.labels.includes('POLICY_CHANGED'));
    // A draft stored before the basis existed reads back with an explicit label instead of a guess.
    const legacy = r.store.insertDraft(user.id, { ...(draftFor(insp) as unknown as DraftInput), version: 1, status: 'DRAFT', createdAt: t, updatedAt: t,
      inspectionDigest: insp.reportDigest, inspectionDecision: 'FAIL', policyRefs: old });
    assert.ok((await call(r, token, 'GET', `/api/drafts/${legacy.id}`)).json.labels.includes('BASIS_NOT_RECORDED'));
  } finally { await stop(r); }
});
