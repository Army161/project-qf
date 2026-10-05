// Drift and provenance checks for the pinned IDL subsets the browser-safe decoder and the verifier use.
// Source: the IDLs bundled in the MIT-licensed SDK packages (not Meteora's separately licensed program source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DAMM_IDL_SUBSET, DBC_IDL_SUBSET } from '@project-qf/tx';
import { dbcSubset, dammConfigSubset, dammUserSubset, renderTsModule } from '../scripts/extract-idl-subsets.ts';

const require = createRequire(import.meta.url);
const pkgJson = (name: string) => { let d = dirname(require.resolve(name)); for (;;) { try { const j = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')); if (j.name === name) return j; } catch {} d = dirname(d); } };

test('SDK packages the subsets are extracted from declare MIT', () => {
  for (const n of ['@meteora-ag/dynamic-bonding-curve-sdk', '@meteora-ag/cp-amm-sdk']) assert.equal(pkgJson(n).license, 'MIT', n);
});

test('committed DBC subset equals a fresh extraction from the pinned SDK (no drift)', () => {
  const fresh = dbcSubset();
  assert.deepEqual(DBC_IDL_SUBSET, fresh);
  assert.equal(readFileSync(new URL('../../tx/src/engine/dbc-idl-subset.ts', import.meta.url), 'utf8'), renderTsModule(fresh));
  assert.equal(fresh.provenance.package, '@meteora-ag/dynamic-bonding-curve-sdk@1.5.13');
  assert.equal(fresh.provenance.idlVersion, '0.2.1');
});

test('committed DAMM v2 Config layout equals a fresh extraction (the verifier embeds the same layout)', () => {
  const fresh = dammConfigSubset();
  const committed = JSON.parse(readFileSync(new URL('./fixtures/damm-v2-config-layout.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, fresh);
  assert.equal(fresh.provenance.package, '@meteora-ag/cp-amm-sdk@1.4.10');
});

test('pinned discriminators match the SDK coder for every bound instruction', async () => {
  const dbc = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  const idl = (dbc as unknown as { DynamicBondingCurveIdl: { instructions: { name: string; discriminator: number[] }[] } }).DynamicBondingCurveIdl;
  for (const ix of DBC_IDL_SUBSET.instructions) assert.deepEqual(ix.discriminator, idl.instructions.find((i) => i.name === ix.name)!.discriminator, ix.name);
});

test('committed DAMM v2 user subset (swap, claim position fee) equals a fresh extraction from the pinned SDK (no drift)', async () => {
  const fresh = dammUserSubset();
  assert.deepEqual(DAMM_IDL_SUBSET, fresh);
  assert.equal(readFileSync(new URL('../../tx/src/engine/damm-idl-subset.ts', import.meta.url), 'utf8'), renderTsModule(fresh, 'DAMM_IDL_SUBSET'));
  assert.equal(fresh.provenance.package, '@meteora-ag/cp-amm-sdk@1.4.10');
  assert.deepEqual(fresh.instructions.map((i) => i.name), ['swap', 'claim_position_fee']);
  const amm = await import('@meteora-ag/cp-amm-sdk');
  const idl = (amm as unknown as { CpAmmIdl: { instructions: { name: string; discriminator: number[] }[] } }).CpAmmIdl;
  for (const ix of fresh.instructions) assert.deepEqual(ix.discriminator, idl.instructions.find((i) => i.name === ix.name)!.discriminator, ix.name);
});
