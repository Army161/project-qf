// Extracts the pinned instruction/account formats QF needs from the MIT-licensed SDK packages'
// bundled IDLs (not from Meteora's restricted program source). Output is data, checked for drift
// by test/idl-subset.test.ts. Run: node scripts/extract-idl-subsets.ts
// Licence: both SDK packages declare MIT in their published package.json (checked by the drift test).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '@project-qf/core';

const require = createRequire(import.meta.url);
const versionOf = (pkg: string) => { let d = dirname(require.resolve(pkg)); while (true) { try { const j = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')); if (j.name === pkg) return j.version as string; } catch {} d = dirname(d); } };
type IdlType = string | { defined?: { name: string }; array?: [IdlType, number]; option?: IdlType; vec?: IdlType };
interface Idl { address: string; metadata: { name: string; version: string }; instructions: any[]; accounts?: any[]; types: { name: string; type: any }[] }

function closure(idl: Idl, roots: IdlType[]) {
  const seen = new Map<string, unknown>();
  const visit = (t: IdlType) => {
    if (typeof t === 'string') return;
    if (t.array) return visit(t.array[0]);
    if (t.option !== undefined) return visit(t.option);
    if (t.vec !== undefined) return visit(t.vec);
    if (t.defined) {
      const n = t.defined.name;
      if (seen.has(n)) return;
      const def = idl.types.find((x) => x.name === n);
      if (!def) throw new Error(`missing type ${n}`);
      seen.set(n, def.type);
      for (const f of def.type.fields ?? []) visit(f.type);
      for (const v of def.type.variants ?? []) for (const f of v.fields ?? []) visit(typeof f === 'object' && 'type' in f ? f.type : f);
    }
  };
  roots.forEach(visit);
  return Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function dbcSubset() {
  const pkg = '@meteora-ag/dynamic-bonding-curve-sdk';
  const idl = require(pkg).DynamicBondingCurveIdl as Idl;
  const version = versionOf(pkg);
  const names = ['create_config', 'initialize_virtual_pool_with_spl_token', 'swap', 'migration_damm_v2', 'claim_trading_fee', 'claim_creator_trading_fee'];
  const instructions = names.map((n) => {
    const ix = idl.instructions.find((i) => i.name === n);
    return { name: n, discriminator: ix.discriminator, accounts: ix.accounts.map((a: any) => ({ name: a.name, writable: !!a.writable, signer: !!a.signer, optional: !!a.optional, address: a.address ?? null })), args: ix.args };
  });
  return { provenance: { package: `${pkg}@${version}`, license: 'MIT (SDK package; the on-chain program is separately licensed and was not used)', idlName: idl.metadata.name, idlVersion: idl.metadata.version, programId: idl.address, fullIdlSha256: createHash('sha256').update(canonicalJson(idl)).digest('hex') },
    instructions, types: closure(idl, instructions.flatMap((i) => i.args.map((a: any) => a.type))) };
}

/** The DAMM v2 instructions a launchpad user signs after graduation: swaps, and claiming a position's fees. */
export function dammUserSubset() {
  const pkg = '@meteora-ag/cp-amm-sdk';
  const mod = require(pkg);
  const idl = (mod.CpAmmIdl ?? mod.idl ?? mod.IDL) as Idl;
  const version = versionOf(pkg);
  const instructions = ['swap', 'claim_position_fee'].map((n) => {
    const ix = idl.instructions.find((i) => i.name === n);
    return { name: n, discriminator: ix.discriminator, accounts: ix.accounts.map((a: any) => ({ name: a.name, writable: !!a.writable, signer: !!a.signer, optional: !!a.optional, address: a.address ?? null })), args: ix.args };
  });
  return { provenance: { package: `${pkg}@${version}`, license: 'MIT (SDK package; the on-chain program is separately licensed and was not used)', idlName: idl.metadata.name, idlVersion: idl.metadata.version, programId: idl.address, fullIdlSha256: createHash('sha256').update(canonicalJson(idl)).digest('hex') },
    instructions, types: closure(idl, instructions.flatMap((i) => i.args.map((a: any) => a.type))) };
}

export function dammConfigSubset() {
  const pkg = '@meteora-ag/cp-amm-sdk';
  const mod = require(pkg);
  const idl = (mod.CpAmmIdl ?? mod.idl ?? mod.IDL) as Idl;
  if (!idl?.types) throw new Error('cp-amm IDL not exported');
  const version = versionOf(pkg);
  const acc = idl.accounts!.find((a) => a.name === 'Config');
  return { provenance: { package: `${pkg}@${version}`, license: 'MIT (SDK package; the on-chain program is separately licensed and was not used)', idlName: idl.metadata.name, idlVersion: idl.metadata.version, programId: idl.address, fullIdlSha256: createHash('sha256').update(canonicalJson(idl)).digest('hex') },
    account: { name: 'Config', discriminator: acc.discriminator }, types: closure(idl, [{ defined: { name: 'Config' } }]) };
}

/** Squads v4 (devnet treasury, milestone 7): the four instructions a treasury fee claim goes through, and the
 *  VaultTransaction account a member checks before approving. The SDK bundles an Anchor 0.29 IDL (camelCase, no
 *  discriminators), so it is converted here to the same shape as the Meteora subsets: snake_case names, Anchor
 *  discriminators (sha256 of "global:<name>" / "account:<Name>", first 8 bytes). */
export function squadsSubset() {
  const pkg = '@sqds/multisig';
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  const raw = readFileSync(join(dir, 'idl', 'squads_multisig_program.json'), 'utf8');
  const idl = JSON.parse(raw) as { version: string; name: string; metadata: { address: string }; instructions: any[]; accounts: any[]; types: { name: string; type: any }[] };
  const snake = (n: string) => n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const disc = (s: string) => [...createHash('sha256').update(s).digest().subarray(0, 8)];
  const ty = (t: any): any => (typeof t === 'string' ? (t === 'publicKey' ? 'pubkey' : t)
    : t.defined ? { defined: { name: t.defined } } : t.option !== undefined ? { option: ty(t.option) } : t.vec !== undefined ? { vec: ty(t.vec) }
      : t.array ? { array: [ty(t.array[0]), t.array[1]] } : t);
  const field = (f: any) => ({ name: snake(f.name), type: ty(f.type) });
  const conv = { ...idl, types: idl.types.map((x) => ({ name: x.name, type: { ...x.type, fields: x.type.fields?.map(field) } })) } as unknown as Idl;
  const names = ['vaultTransactionCreate', 'proposalCreate', 'proposalApprove', 'vaultTransactionExecute'];
  const instructions = names.map((n) => {
    const ix = idl.instructions.find((i) => i.name === n);
    return { name: snake(n), discriminator: disc(`global:${snake(n)}`),
      accounts: ix.accounts.map((a: any) => ({ name: snake(a.name), writable: !!a.isMut, signer: !!a.isSigner, optional: !!a.isOptional, address: null })),
      args: ix.args.map(field) };
  });
  return { provenance: { package: `${pkg}@${versionOf(pkg)}`, license: 'MIT (SDK package and its bundled IDL)', idlName: idl.name, idlVersion: idl.version,
    programId: idl.metadata.address, fullIdlSha256: createHash('sha256').update(canonicalJson(idl)).digest('hex') },
    instructions, types: closure(conv, instructions.flatMap((i) => i.args.map((a: any) => a.type))),
    accounts: { VaultTransaction: disc('account:VaultTransaction'), Proposal: disc('account:Proposal') } };
}

/** The tx package is browser-safe and imported by the web bundle, so the subset ships as a TS module, not JSON. */
export function renderTsModule(subset: unknown, constName = 'DBC_IDL_SUBSET'): string {
  return ['// GENERATED by packages/adapter-meteora-dbc/scripts/extract-idl-subsets.ts from the MIT-licensed SDK package IDL.',
    '// Do not edit by hand; test/idl-subset.test.ts (adapter) fails on drift.',
    "import type { IdlSubset } from './idl-types.ts';", '',
    `export const ${constName}: IdlSubset = ${JSON.stringify(subset, null, 1)};`, ''].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = (p: string, v: unknown) => writeFileSync(new URL(p, import.meta.url), JSON.stringify(v, null, 1) + '\n');
  writeFileSync(new URL('../../tx/src/engine/dbc-idl-subset.ts', import.meta.url), renderTsModule(dbcSubset()));
  writeFileSync(new URL('../../tx/src/engine/damm-idl-subset.ts', import.meta.url), renderTsModule(dammUserSubset(), 'DAMM_IDL_SUBSET'));
  writeFileSync(new URL('../../tx/src/engine/squads-idl-subset.ts', import.meta.url), renderTsModule(squadsSubset(), 'SQUADS_IDL_SUBSET'));
  out('../test/fixtures/damm-v2-config-layout.json', dammConfigSubset());
  console.log('wrote subsets');
}
