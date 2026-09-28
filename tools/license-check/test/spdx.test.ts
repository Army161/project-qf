import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from '../spdx.ts';
import { checkExactException } from '../exact.ts';

const m = JSON.parse(readFileSync(new URL('../../../LICENSE-MANIFEST.json', import.meta.url), 'utf8'));
const p = m.policy;

test('SPDX classification against LICENSE-MANIFEST policy', () => {
  assert.equal(classify('MIT', p), 'ALLOW');
  assert.equal(classify('(MIT OR Apache-2.0)', p), 'ALLOW');
  assert.equal(classify('MIT OR GPL-3.0', p), 'ALLOW');          // OR: best alternative
  assert.equal(classify('(MIT AND Zlib)', p), 'REVIEW');          // AND: worst component; Zlib stays review (pako is an exact exception, not a policy change)
  assert.equal(classify('LGPL-3.0-only', p), 'DENY');             // blanket deny stays in force
  assert.equal(classify('GPL-3.0-or-later', p), 'DENY');
  assert.equal(classify('BUSL-1.1', p), 'DENY');
  assert.equal(classify('NONE', p), 'DENY');
  assert.equal(classify('WTFPL', p), 'UNKNOWN');
});

test('the code-repo manifest copy is identical to the spec manifest when both are present', () => {
  let spec: string | undefined;
  try { spec = readFileSync(new URL('../../../../spec/LICENSE-MANIFEST.json', import.meta.url), 'utf8'); } catch { /* spec not alongside */ }
  if (spec === undefined) return;
  assert.equal(readFileSync(new URL('../../../LICENSE-MANIFEST.json', import.meta.url), 'utf8'), spec);
});

test('LGPL exception is exact and narrow; chain is recorded as removed', () => {
  const ex = m.exceptions.find((e: { name: string }) => e.name === 'rpc-websockets');
  assert.equal(ex.exceptionId, 'QF-LIC-EX-001');
  assert.equal(ex.version, '9.3.9');
  assert.match(ex.resolvedIntegrity, /^sha512-/);
  assert.equal(ex.status, 'APPROVED_NARROW');
  assert.ok(ex.prohibitedTargets.some((t: string) => /browser/.test(t)));
  const ch = m.exceptions.find((e: { name: string }) => e.name === 'chain');
  assert.equal(ch.status, 'REMOVED');
  assert.match(ch.mechanism, /"@meteora-ag\/cp-amm-sdk@1\.4\.10>chain": "-"/);
});

test('LIC-R1: pako@2.2.0 (MIT AND Zlib) is allowed only as the exact, unmodified, notice-preserving exception', () => {
  const ex = m.exceptions.find((e: { exceptionId?: string }) => e.exceptionId === 'QF-LIC-EX-002');
  assert.equal(ex.name, 'pako'); assert.equal(ex.version, '2.2.0'); assert.equal(ex.status, 'APPROVED_EXACT'); assert.equal(ex.license, '(MIT AND Zlib)');
  assert.ok(!p.allow.includes('Zlib'), 'no policy-wide Zlib allowance');
  const root = new URL('../../../', import.meta.url);
  const text = (f: string) => readFileSync(new URL(f, root), 'utf8');
  const mit = text('licenses/pako@2.2.0/LICENSE'); const zlib = text('licenses/pako@2.2.0/lib-zlib-README');
  assert.match(mit, /Copyright \(C\) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn/);
  assert.match(zlib, /Jean-loup Gailly and Mark Adler/); assert.match(zlib, /This notice may not be removed or altered from any source distribution/);
  const good = () => ({ license: '(MIT AND Zlib)', integrity: ex.resolvedIntegrity, patched: false,
    notices: new Map<string, [string | undefined, string | undefined]>([['LICENSE', [mit, mit]], ['lib/zlib/README', [zlib, zlib]]]) });
  assert.deepEqual(checkExactException(ex, good()), []);
  assert.match(checkExactException(ex, { ...good(), integrity: 'sha512-other' }).join(), /integrity/);
  assert.match(checkExactException(ex, { ...good(), license: 'MIT AND Zlib AND BSD-3-Clause' }).join(), /license/);
  assert.match(checkExactException(ex, { ...good(), patched: true }).join(), /patched/);
  const lost = good(); lost.notices.set('lib/zlib/README', [zlib, undefined]);
  assert.match(checkExactException(ex, lost).join(), /not preserved/);
  const altered = good(); altered.notices.set('LICENSE', [mit, mit.replace('Vitaly Puzrin', 'Someone Else')]);
  assert.match(checkExactException(ex, altered).join(), /differs from upstream/);
  assert.match(checkExactException({ ...ex, notices: [] }, good()).join(), /no notices/);
});
