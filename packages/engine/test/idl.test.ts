// The pinned IDLs: the files are the engine build's (sha256), src/idl.ts is exactly what the generator makes of them,
// and every PDA the builders put in an instruction matches the seeds the full IDL records for that account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Instruction } from '@solana/kit';
import { generate } from '../scripts/extract-idl.ts';
import * as E from '../src/index.ts';

const file = (n: string) => readFileSync(new URL(`../idl/${n}`, import.meta.url));
// sha256 of the IDLs the engine thread built on 2026-10-11 (OWN-ENGINE-BUILD report; engine commit 10ae8ea)
const PINS = { 'qf_curve.json': 'e1ed66c8c9bc55c144951df63b436566e28f1de08e8c8e26b1ed117206b969cc', 'qf_pool.json': 'c48a79db97c1eddaacaab9b90e84bd6a7af8905faf209f3b78152213bc72290c' };

test('the IDL files are the engine build\'s, byte for byte', () => {
  for (const [n, sha] of Object.entries(PINS)) assert.equal(createHash('sha256').update(file(n)).digest('hex'), sha, n);
  assert.equal(E.CURVE_IDL.provenance.sha256, PINS['qf_curve.json']);
  assert.equal(E.POOL_IDL.provenance.sha256, PINS['qf_pool.json']);
});

test('src/idl.ts is exactly the generator\'s output (no drift, no hand edits)', () => {
  assert.equal(readFileSync(new URL('../src/idl.ts', import.meta.url), 'utf8'), generate());
});

test('program ids: the IDLs, programs.ts and the engine report agree', () => {
  assert.equal(E.CURVE_IDL.provenance.programId, E.QF_CURVE);
  assert.equal(E.POOL_IDL.provenance.programId, E.QF_POOL);
  assert.equal(E.QF_CURVE, 'CaX3gfwE1y3AustJ5e2JQFmaDtXB5oeX6ayvNzLGsFoX');
  assert.equal(E.QF_POOL, 'FHG8GyPytpydCRFL6yvwu92vyWSk7bSYZknyLn3v6ewU');
});

// ---------- PDA seeds from the full IDL ----------
type Seed = { kind: 'const'; value: number[] } | { kind: 'account'; path: string } | { kind: 'arg'; path: string };
interface FullAccount { name: string; pda?: { seeds: Seed[]; program?: { kind: 'const'; value: number[] } } }
const full = { curve: JSON.parse(file('qf_curve.json').toString()), pool: JSON.parse(file('qf_pool.json').toString()) };
const enc = getAddressEncoder();
const dec = getAddressDecoder();
async function checkPdas(idl: any, ix: Instruction): Promise<number> {
  const def = idl.instructions.find((i: any) => (ix.data ?? []).length >= 8 && i.discriminator.every((x: number, k: number) => x === ix.data![k]));
  assert.ok(def, 'instruction found by discriminator');
  const byName = new Map<string, string>(def.accounts.map((a: FullAccount, k: number) => [a.name, ix.accounts![k]!.address as string]));
  let checked = 0;
  for (const [k, a] of (def.accounts as FullAccount[]).entries()) {
    if (!a.pda) continue;
    const seeds: Uint8Array[] = [];
    let derivable = true;
    for (const s of a.pda.seeds) {
      if (s.kind === 'const') seeds.push(Uint8Array.from(s.value));
      else if (s.kind === 'account' && !s.path.includes('.')) seeds.push(enc.encode(address(byName.get(s.path)!)) as Uint8Array);
      else derivable = false; // a seed read from account data (launch.mint) is checked by the program itself
    }
    if (!derivable) continue;
    const program = a.pda.program ? dec.decode(Uint8Array.from(a.pda.program.value)) : idl.address;
    const [want] = await getProgramDerivedAddress({ programAddress: address(program), seeds });
    assert.equal(ix.accounts![k]!.address, want, `${def.name}.${a.name}`);
    checked++;
  }
  return checked;
}

test('every PDA in every built instruction matches the seeds the IDL records', async () => {
  const m = 'GoLdenM1nt1111111111111111111111111111111111', creator = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const ammConfig = await E.ammConfigAddress(0);
  let checked = 0;
  for (const quoteMint of [E.NATIVE_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']) {
    for (const ix of [
      await E.createLaunchIx({ creator, mint: m, quoteMint, ammConfig, name: 'n', symbol: 's', uri: 'u' }),
      await E.buyIx({ trader: creator, mint: m, quoteMint, quoteIn: 1n, minBaseOut: 0n }),
      await E.sellIx({ trader: creator, mint: m, quoteMint, baseIn: 1n, minQuoteOut: 0n }),
      await E.graduateIx({ payer: creator, mint: m, quoteMint, ammConfig, creator, createPoolFee: creator }),
      await E.claimPlatformFeesIx({ mint: m, quoteMint, to: creator }),
      await E.claimCreatorFeesIx({ mint: m, quoteMint, to: creator }),
      await E.initializeIx({ authority: creator, quoteMint, ammConfig, settings: { admin: creator, feeRecipient: creator, createPaused: false, config: E.LAUNCH_PRESETS.standard } }),
    ]) checked += await checkPdas(full.curve, ix);
    for (const ix of [
      await E.coinPoolSwapIx({ payer: creator, mint: m, quoteMint, ammConfig, side: 'buy', amountIn: 1n, minOut: 0n }),
      await E.collectPoolCreatorFeeIx({ payer: creator, creator, mint: m, quoteMint, ammConfig }),
    ]) checked += await checkPdas(full.pool, ix);
  }
  assert.ok(checked >= 40, `checked ${checked} PDAs`);
});
