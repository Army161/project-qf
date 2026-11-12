// The engine package against the engine's own client: every address, every instruction (program, accounts with
// signer/writable flags, data bytes) and the curve math, from reference vectors that client produced (TEST_ONLY).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AccountRole, type Instruction } from '@solana/kit';
import * as E from '../src/index.ts';

const golden = JSON.parse(readFileSync(new URL('./fixtures/engine-client-golden.json', import.meta.url), 'utf8'));
assert.equal(golden.label, 'TEST_ONLY');
const hex = (b: ArrayLike<number> | undefined) => Array.from(b ?? [], (x) => x.toString(16).padStart(2, '0')).join('');
const asClient = (ix: Instruction) => ({
  programId: ix.programAddress as string,
  keys: (ix.accounts ?? []).map((a) => ({ pubkey: a.address as string, isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER, isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER })),
  data: hex(ix.data),
});

test('every derived address equals the engine client\'s', async () => {
  for (const a of golden.addresses) {
    const got = a.name === 'graduator' ? await E.graduatorAddress()
      : a.name === 'permission' ? await E.permissionAddress()
      : a.name === 'ammConfig0' ? await E.ammConfigAddress(0)
      : a.name === 'ammConfig7' ? await E.ammConfigAddress(7)
      : a.name.startsWith('global:') ? await E.globalAddress(a.name.slice(7))
      : a.name === 'launchAccounts' ? { ...(await E.launchAccounts(a.mint, a.quoteMint)) }
      : a.name === 'poolAccounts' ? { ...(await E.poolAccounts(await E.launchPoolAddress(a.mint), a.mint, a.quoteMint)) }
      : a.name === 'defaultPool' ? await E.defaultPoolAddress(await E.ammConfigAddress(0), a.mint, a.quoteMint)
      : assert.fail(`unknown address vector ${a.name}`);
    assert.deepEqual(got, a.value, a.name);
  }
});

const CONFIG_BY_NAME = E.LAUNCH_PRESETS as Record<string, E.LaunchConfig>;
async function build(name: string, p: any): Promise<Instruction[]> {
  switch (name) {
    case 'createLaunch': return [await E.createLaunchIx(p)];
    case 'buy': return [await E.buyIx({ ...p, quoteIn: BigInt(p.quoteIn), minBaseOut: BigInt(p.minBaseOut) })];
    case 'sell': return [await E.sellIx({ ...p, baseIn: BigInt(p.baseIn), minQuoteOut: BigInt(p.minQuoteOut) })];
    case 'graduate': return [await E.graduateIx(p)];
    case 'claimPlatformFees': return [await E.claimPlatformFeesIx(p)];
    case 'claimCreatorFees': return [await E.claimCreatorFeesIx(p)];
    case 'refreshPoolConfig': return [await E.refreshPoolConfigIx(p)];
    case 'poolSwap': return [await E.poolSwapIx({ ...p, amountIn: BigInt(p.amountIn), minOut: BigInt(p.minOut) })];
    case 'collectPoolCreatorFee': return [await E.collectPoolCreatorFeeIx(p)];
    case 'traderAccounts': return E.traderAccountIxs(p.payer, p.trader, p.mint, p.quoteMint);
    case 'wrapSol': return E.wrapSolIxs(p.payer, p.owner, BigInt(p.lamports));
    case 'initialize': return [await E.initializeIx({ authority: p.authority, quoteMint: p.quoteMint, ammConfig: p.ammConfig,
      settings: { admin: p.admin, feeRecipient: p.feeRecipient, createPaused: p.createPaused, buyPaused: p.buyPaused, config: CONFIG_BY_NAME[p.config]! } })];
    case 'updateGlobal': return [await E.updateGlobalIx({ admin: p.admin0, quoteMint: p.quoteMint, ammConfig: p.ammConfig,
      settings: { admin: p.admin, feeRecipient: p.feeRecipient, createPaused: p.createPaused, buyPaused: p.buyPaused, config: CONFIG_BY_NAME[p.config]! } })];
    case 'acceptAdmin': return [await E.acceptAdminIx(p)];
    default: throw new Error(`no builder for ${name}`);
  }
}

test('every instruction is byte-identical to the engine client\'s, accounts and flags included', async () => {
  const seen = new Set<string>();
  for (const v of golden.instructions) {
    const got = (await build(v.name, v.params)).map(asClient);
    assert.deepEqual(got, v.ixs, `${v.name} ${JSON.stringify(v.params)}`);
    seen.add(v.name);
  }
  assert.deepEqual([...seen].sort(), ['acceptAdmin', 'buy', 'claimCreatorFees', 'claimPlatformFees', 'collectPoolCreatorFee', 'createLaunch', 'graduate', 'initialize', 'poolSwap', 'refreshPoolConfig', 'sell', 'traderAccounts', 'updateGlobal', 'wrapSol']);
});

test('coinPoolSwapIx is poolSwapIx with the coin on Token-2022 and the quote on Token', async () => {
  const v = golden.instructions.filter((x: any) => x.name === 'poolSwap');
  for (const x of v) {
    const p = x.params, coinIn = p.programIn === E.TOKEN_2022;
    const mint = coinIn ? p.mintIn : p.mintOut, quoteMint = coinIn ? p.mintOut : p.mintIn;
    const ix = await E.coinPoolSwapIx({ payer: p.payer, mint, quoteMint, ammConfig: p.ammConfig, side: coinIn ? 'sell' : 'buy', amountIn: BigInt(p.amountIn), minOut: BigInt(p.minOut) });
    assert.deepEqual([asClient(ix)], x.ixs);
  }
});

test('curve math equals the engine client\'s on every vector, and refuses exactly where the program does', () => {
  let compared = 0, refused = 0;
  for (const v of golden.math) {
    const c = CONFIG_BY_NAME[v.config]!;
    const s = (k: string) => BigInt(v.result[k]);
    if (v.op === 'split') { assert.deepEqual(E.splitFee(c, BigInt(v.amount)), { platform: s('platform'), creator: s('creator') }); compared++; continue; }
    if (v.op === 'buy') {
      const expected = { quoteIn: s('quoteIn'), quoteToCurve: s('quoteToCurve'), baseOut: s('baseOut'), fee: s('fee'), completes: v.result.completes };
      // the client has no refusal checks; math.rs refuses a buy that would get nothing
      if (!expected.completes && expected.baseOut === 0n) { assert.throws(() => E.quoteBuy(c, BigInt(v.realQuote), BigInt(v.baseSold), BigInt(v.amount)), { code: 'ZeroAmount' }); refused++; continue; }
      assert.deepEqual(E.quoteBuy(c, BigInt(v.realQuote), BigInt(v.baseSold), BigInt(v.amount)), expected); compared++; continue;
    }
    const expected = { quoteFromCurve: s('quoteFromCurve'), quoteOut: s('quoteOut'), fee: s('fee') };
    if (expected.quoteOut === 0n) { assert.throws(() => E.quoteSell(c, BigInt(v.realQuote), BigInt(v.baseSold), BigInt(v.amount)), { code: 'ZeroAmount' }); refused++; continue; }
    assert.deepEqual(E.quoteSell(c, BigInt(v.realQuote), BigInt(v.baseSold), BigInt(v.amount)), expected); compared++;
  }
  assert.ok(compared >= 340, `compared ${compared}`);
  assert.ok(golden.math.some((v: any) => v.op === 'buy' && v.result.completes), 'vectors include a buy that sells the curve out');
  void refused;
});
