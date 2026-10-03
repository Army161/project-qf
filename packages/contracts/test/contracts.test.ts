// qf-api/1 request parsers: strict shapes, no unknown fields, bounded text, no control or bidi characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDraftInput, parseDraftUpdate, parseInspectionRequest } from '@project-qf/contracts';

const MINT = 'EtriFwkv36LDftunesYPdxScW2KU5BK55pcm7qwBonXn';
const INSP = `insp_${'a'.repeat(32)}`;
const draft = { name: 'Creator Coin', symbol: 'CRTR', description: 'Line one\nLine two', quoteMint: MINT, cluster: 'test-only', inspectionId: INSP };
const errs = (r: { ok: boolean; errors?: string[] }) => (r.ok ? [] : r.errors!);

test('inspection request: a valid mint and supported cluster parse; whitespace is trimmed', () => {
  const r = parseInspectionRequest({ mint: ` ${MINT} `, cluster: 'mainnet-beta' });
  assert.deepEqual(r, { ok: true, value: { mint: MINT, cluster: 'mainnet-beta' } });
});

test('inspection request: malformed mint, unsupported cluster, unknown fields and non-objects are rejected', () => {
  assert.ok(errs(parseInspectionRequest({ mint: 'not-a-mint', cluster: 'devnet' })).some((e) => e.startsWith('INVALID_MINT')));
  assert.ok(errs(parseInspectionRequest({ mint: '1'.repeat(31), cluster: 'devnet' })).some((e) => e.startsWith('INVALID_MINT')));
  assert.ok(errs(parseInspectionRequest({ mint: MINT, cluster: 'testnet' })).some((e) => e.startsWith('UNSUPPORTED_CLUSTER')));
  assert.ok(errs(parseInspectionRequest({ mint: MINT, cluster: 'devnet', mode: 'LIVE' })).includes('UNKNOWN_FIELD mode'));
  assert.deepEqual(errs(parseInspectionRequest([MINT])), ['BODY_NOT_OBJECT']);
  assert.deepEqual(errs(parseInspectionRequest(null)), ['BODY_NOT_OBJECT']);
});

test('draft input: valid drafts parse; description may hold newlines and may be omitted', () => {
  const r = parseDraftInput(draft);
  assert.ok(r.ok);
  assert.equal(r.value.description, 'Line one\nLine two');
  const { description: _d, ...noDesc } = draft;
  const r2 = parseDraftInput(noDesc);
  assert.ok(r2.ok);
  assert.equal(r2.value.description, '');
});

test('draft input: name, symbol, length, control and bidi characters are enforced', () => {
  assert.ok(errs(parseDraftInput({ ...draft, name: '' })).some((e) => e.startsWith('INVALID_NAME: length')));
  assert.ok(errs(parseDraftInput({ ...draft, name: 'x'.repeat(33) })).some((e) => e.startsWith('INVALID_NAME: length')));
  assert.ok(errs(parseDraftInput({ ...draft, name: 'two\nlines' })).some((e) => e.startsWith('INVALID_NAME: control')));
  assert.ok(errs(parseDraftInput({ ...draft, name: 'abc‮gpj' })).some((e) => e.startsWith('INVALID_NAME: control')));       // right-to-left override
  assert.ok(errs(parseDraftInput({ ...draft, description: 'x\u0000y' })).some((e) => e.startsWith('INVALID_DESCRIPTION: control')));
  assert.ok(errs(parseDraftInput({ ...draft, description: 'x y' })).some((e) => e.startsWith('INVALID_DESCRIPTION: control')));
  assert.ok(errs(parseDraftInput({ ...draft, description: 'x'.repeat(501) })).some((e) => e.startsWith('INVALID_DESCRIPTION: length')));
  for (const symbol of ['crtr', 'TOO_LONG_SYMBOL', '', 'A B', 42]) assert.ok(errs(parseDraftInput({ ...draft, symbol })).includes('INVALID_SYMBOL: 1-10 characters A-Z or 0-9'), String(symbol));
});

test('draft input: inspection id, quote mint and cluster are validated, and server-owned fields cannot be supplied', () => {
  assert.ok(errs(parseDraftInput({ ...draft, inspectionId: 'insp_123' })).includes('INVALID_INSPECTION_ID'));
  assert.ok(errs(parseDraftInput({ ...draft, quoteMint: 'abc' })).some((e) => e.startsWith('INVALID_QUOTEMINT')));
  assert.ok(errs(parseDraftInput({ ...draft, cluster: 'localnet' })).some((e) => e.startsWith('UNSUPPORTED_CLUSTER')));
  for (const k of ['status', 'id', 'version', 'policyRefs', 'ownerId', 'expectedVersion']) {
    assert.ok(errs(parseDraftInput({ ...draft, [k]: 'x' })).includes(`UNKNOWN_FIELD ${k}`), k);
  }
});

test('draft update: expectedVersion must be a positive integer', () => {
  assert.ok(parseDraftUpdate({ ...draft, expectedVersion: 3 }).ok);
  for (const v of [0, -1, 1.5, '2', null, undefined]) assert.ok(errs(parseDraftUpdate({ ...draft, expectedVersion: v })).includes('INVALID_EXPECTED_VERSION'), String(v));
});
