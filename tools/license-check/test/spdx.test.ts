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
  assert.equal(classify('(MIT AND Zlib)', p), 'REVIEW');          // AND: worst component; Zlib is not allowed by policy
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

test('the exceptions the Meteora removal retired stay recorded as REMOVED, so the gate denies them if they come back', () => {
  for (const name of ['rpc-websockets', 'pako', 'chain']) {
    const ex = m.exceptions.find((e: { name: string }) => e.name === name);
    assert.equal(ex.status, 'REMOVED', name);
  }
  assert.equal(classify('LGPL-3.0-only', p), 'DENY', 'no LGPL package has an exception any more');
  assert.ok(!m.pinned.some((x: { name: string }) => /^@meteora-ag\/|^@solana\/web3\.js$|^@sqds\//.test(x.name)), 'the Meteora pins are gone');
});

test('the web fonts are allowed only as exact, unmodified, notice-preserving exceptions (QF-LIC-EX-003..005)', () => {
  const fonts = m.exceptions.filter((e: { exceptionId?: string }) => /^QF-LIC-EX-00[345]$/.test(e.exceptionId ?? ''));
  assert.equal(fonts.length, 3);
  assert.ok(!p.allow.includes('OFL-1.1'), 'no policy-wide OFL allowance');
  const root = new URL('../../../', import.meta.url);
  for (const ex of fonts) {
    assert.equal(ex.status, 'APPROVED_EXACT'); assert.equal(ex.license, 'OFL-1.1'); assert.equal(ex.version, '5.3.0');
    assert.match(ex.resolvedIntegrity, /^sha512-/);
    const notice = readFileSync(new URL(ex.notices[0].preservedAt, root), 'utf8');
    assert.match(notice, /SIL OPEN FONT LICENSE/i, ex.name);
    const good = () => ({ license: 'OFL-1.1', integrity: ex.resolvedIntegrity, patched: false,
      notices: new Map<string, [string | undefined, string | undefined]>([['LICENSE', [notice, notice]]]) });
    assert.deepEqual(checkExactException(ex, good()), [], ex.name);
    assert.match(checkExactException(ex, { ...good(), integrity: 'sha512-other' }).join(), /integrity/);
    assert.match(checkExactException(ex, { ...good(), license: 'OFL-1.1 AND BSD-3-Clause' }).join(), /license/);
    assert.match(checkExactException(ex, { ...good(), patched: true }).join(), /patched/);
    const lost = good(); lost.notices.set('LICENSE', [notice, undefined]);
    assert.match(checkExactException(ex, lost).join(), /not preserved/);
    const altered = good(); altered.notices.set('LICENSE', [notice, notice.replace('SIL', 'SOMEONE')]);
    assert.match(checkExactException(ex, altered).join(), /differs from upstream/);
    assert.match(checkExactException({ ...ex, notices: [] }, good()).join(), /no notices/);
  }
});
