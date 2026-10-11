// The codec and account decoders fail closed, and round-trip every engine account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressEncoder, address } from '@solana/kit';
import * as E from '../src/index.ts';
import { encodeFields, decodeFields, CodecError } from '../src/codec.ts';

const A = (n: number) => address(['11111111111111111111111111111112', 'So11111111111111111111111111111111111111112', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111'][n]!) as string;
const cfg = { total_supply: 1_000_000_000_000_000n, curve_supply: 793_100_000_000_000n, virtual_quote: 300_000_000n, virtual_base: 1_073_000_000_000_000n, trade_fee_bps: 100, creator_fee_share_bps: 3000, graduation_fee: 10_000_000n };
const T = E.CURVE_IDL.types;
const account = (name: string, idl: E.EngineIdl, values: Record<string, unknown>) => Uint8Array.from([...idl.accounts[name]!, ...encodeFields(values, idl.types[name]!.fields!, idl.types)]);
const launchValues = { mint: A(0), creator: A(1), quote_mint: A(1), amm_config: A(2), config: cfg, status: 'Complete', real_quote: 849_000_000n, base_sold: 793_100_000_000_000n,
  platform_fees: 7n, creator_fees: 3n, pool: A(3), created_at: -5n, bump: 254, signer_bump: 253 };

test('Launch round-trips through the account decoder, enum included', () => {
  const l = E.decodeLaunch({ owner: E.QF_CURVE, lamports: 1n, data: account('Launch', E.CURVE_IDL, launchValues) });
  assert.equal(l.status, 'Complete');
  assert.equal(l.createdAt, -5n);
  assert.deepEqual(l.config, E.LAUNCH_PRESETS.devnetSmall);
  assert.equal(l.realQuote, 849_000_000n);
  assert.equal(l.signerBump, 253);
});

test('LAUNCH_LAYOUT points at the discriminator, mint and quote mint a getProgramAccounts search filters on', () => {
  const data = account('Launch', E.CURVE_IDL, { ...launchValues, mint: A(4), quote_mint: A(5) });
  const at = (offset: number) => Array.from(data.subarray(offset, offset + 32));
  assert.deepEqual(Array.from(data.subarray(0, 8)), [...E.LAUNCH_LAYOUT.discriminator]);
  assert.deepEqual(at(E.LAUNCH_LAYOUT.mintOffset), Array.from(getAddressEncoder().encode(address(A(4)))));
  assert.deepEqual(at(E.LAUNCH_LAYOUT.quoteMintOffset), Array.from(getAddressEncoder().encode(address(A(5)))));
});

test('account decoding refuses a wrong owner, discriminator, size or enum tag', () => {
  const data = account('Launch', E.CURVE_IDL, launchValues);
  assert.throws(() => E.decodeLaunch({ owner: E.QF_POOL, lamports: 1n, data }), CodecError);
  assert.throws(() => E.decodeGlobal({ owner: E.QF_CURVE, lamports: 1n, data }), /discriminator/);
  assert.throws(() => E.decodeLaunch({ owner: E.QF_CURVE, lamports: 1n, data: Uint8Array.from([...data, 0]) }), /trailing/);
  assert.throws(() => E.decodeLaunch({ owner: E.QF_CURVE, lamports: 1n, data: data.subarray(0, data.length - 1) }), /short read/);
  const statusAt = 8 + 32 * 4 + 44; // after mint, creator, quote_mint, amm_config and the config
  for (const tag of [3, 255]) { const bad = Uint8Array.from(data); bad[statusAt] = tag; assert.throws(() => E.decodeLaunch({ owner: E.QF_CURVE, lamports: 1n, data: bad }), /LaunchStatus tag/); }
  const good = Uint8Array.from(data); good[statusAt] = 2; assert.equal(E.decodeLaunch({ owner: E.QF_CURVE, lamports: 1n, data: good }).status, 'Graduated');
});

test('Global, AmmConfig, PoolState and CreatorFeeShare round-trip', () => {
  const g = E.decodeGlobal({ owner: E.QF_CURVE, lamports: 1n, data: account('Global', E.CURVE_IDL, { admin: A(0), fee_recipient: A(1), quote_mint: A(1), amm_config: A(2), create_paused: true, config: cfg, bump: 9 }) });
  assert.deepEqual(g, { admin: A(0), feeRecipient: A(1), quoteMint: A(1), ammConfig: A(2), createPaused: true, config: E.LAUNCH_PRESETS.devnetSmall, bump: 9 });
  const c = E.decodeAmmConfig({ owner: E.QF_POOL, lamports: 1n, data: account('AmmConfig', E.POOL_IDL, { bump: 1, disable_create_pool: false, index: 0, trade_fee_rate: 2500n, protocol_fee_rate: 200_000n,
    fund_fee_rate: 0n, create_pool_fee: 0n, protocol_owner: A(0), fund_owner: A(0), creator_fee_rate: 500n, creator_fee_share_rate: 0n, padding: Array(14).fill(0n) }) });
  assert.equal(c.tradeFeeRate, 2500n); assert.equal(c.creatorFeeRate, 500n);
  const zero = (n: number, v: bigint | number) => Array(n).fill(v);
  const pool = { amm_config: A(0), pool_creator: A(1), token_0_vault: A(2), token_1_vault: A(3), lp_mint: A(4), token_0_mint: A(5), token_1_mint: A(1), token_0_program: A(3), token_1_program: A(2),
    observation_key: A(0), auth_bump: 255, status: 0, lp_mint_decimals: 9, mint_0_decimals: 6, mint_1_decimals: 9, lp_supply: 0n, protocol_fees_token_0: 1n, protocol_fees_token_1: 2n,
    fund_fees_token_0: 3n, fund_fees_token_1: 4n, open_time: 0n, recent_epoch: 7n, creator_fee_on: 2, enable_creator_fee: true, padding1: zero(6, 0), creator_fees_token_0: 5n, creator_fees_token_1: 6n, padding: zero(28, 0n) };
  const pd = account('PoolState', E.POOL_IDL, pool);
  assert.equal(pd.length, 637, 'PoolState::LEN in the pool program (packed)');
  const p = E.decodePoolState({ owner: E.QF_POOL, lamports: 1n, data: pd });
  assert.equal(p.creatorFeeOn, 2); assert.equal(p.creatorFeesToken1, 6n); assert.equal(p.recentEpoch, 7n);
  const s = E.decodeCreatorFeeShare({ owner: E.QF_POOL, lamports: 1n, data: account('CreatorFeeShare', E.POOL_IDL, { bump: 1, creator: A(1), amm_config: A(0), share_rate: 0n, padding: zero(8, 0n) }) });
  assert.equal(s.shareRate, 0n);
});

test('encoding refuses missing, extra and out-of-range values instead of defaulting or truncating', () => {
  const f = E.CURVE_IDL.instructions.find((i) => i.name === 'buy')!.args;
  assert.throws(() => encodeFields({ quote_in: 1n }, f, T), /min_base_out: missing/);
  assert.throws(() => encodeFields({ quote_in: 1n, min_base_out: 0n, extra: 1 }, f, T), /not a field/);
  assert.throws(() => encodeFields({ quote_in: 1n << 64n, min_base_out: 0n }, f, T), /out of range/);
  assert.throws(() => encodeFields({ quote_in: -1n, min_base_out: 0n }, f, T), /out of range/);
  assert.throws(() => encodeFields({ quote_in: 1.5, min_base_out: 0n }, f, T), /bigint or safe integer/);
  assert.deepEqual(decodeFields(encodeFields({ quote_in: (1n << 64n) - 1n, min_base_out: 0n }, f, T), f, T), { quote_in: (1n << 64n) - 1n, min_base_out: 0n });
  const s = E.CURVE_IDL.instructions.find((i) => i.name === 'create_launch')!.args;
  assert.throws(() => encodeFields({ name: 'x'.repeat(257), symbol: 's', uri: 'u' }, s, T), /exceeds 256/);
  assert.throws(() => encodeFields({ name: 'n', symbol: 's', uri: 7 }, s, T), /not a string/);
  // bad bool tag, bad utf-8
  const ev = E.CURVE_IDL.events.FeesClaimed!.fields;
  const bytes = encodeFields({ mint: A(0), to: A(1), amount: 5n, creator: true }, ev, T);
  const bad = Uint8Array.from(bytes); bad[bad.length - 1] = 2;
  assert.throws(() => decodeFields(bad, ev, T), /bool tag 2/);
  const nb = encodeFields({ name: 'ab', symbol: 's', uri: 'u' }, s, T); nb[4] = 0xff;
  assert.throws(() => decodeFields(nb, s, T), /invalid utf-8/);
});

test('token accounts and mints: base layout, both token programs', () => {
  const enc = getAddressEncoder();
  const ta = new Uint8Array(165); ta.set(enc.encode(address(A(1))), 0); ta.set(enc.encode(address(A(0))), 32); ta.set([0x40, 0x42, 0x0f], 64); ta[108] = 1;
  assert.deepEqual(E.decodeTokenAccount({ owner: E.TOKEN, lamports: 1n, data: ta }), { program: E.TOKEN, mint: A(1), owner: A(0), amount: 1_000_000n, frozen: false });
  const ta22 = new Uint8Array(170); ta22.set(ta); ta22[165] = 2;
  assert.equal(E.decodeTokenAccount({ owner: E.TOKEN_2022, lamports: 1n, data: ta22 }).amount, 1_000_000n);
  assert.throws(() => E.decodeTokenAccount({ owner: E.TOKEN, lamports: 1n, data: ta22 }), /bytes/);
  assert.throws(() => E.decodeTokenAccount({ owner: E.QF_CURVE, lamports: 1n, data: ta }), /not a token program/);
  const unin = Uint8Array.from(ta); unin[108] = 0;
  assert.throws(() => E.decodeTokenAccount({ owner: E.TOKEN, lamports: 1n, data: unin }), /state 0/);
  const mint = new Uint8Array(300); mint.set([0x00, 0x80, 0xc6, 0xa4, 0x7e, 0x8d, 0x03], 36); mint[44] = 6; mint[45] = 1; mint[165] = 1;
  assert.deepEqual(E.decodeMint({ owner: E.TOKEN_2022, lamports: 1n, data: mint }), { program: E.TOKEN_2022, mintAuthority: null, supply: 1_000_000_000_000_000n, decimals: 6, freezeAuthority: null });
});

test('readCoin reads the launch and both vaults in one call and checks they belong together', async () => {
  const mint = A(0), launch = account('Launch', E.CURVE_IDL, { ...launchValues, status: 'Trading' });
  const a = await E.launchAccounts(mint, E.NATIVE_MINT);
  const enc = getAddressEncoder();
  const tok = (m: string, owner: string, amount: bigint) => { const b = new Uint8Array(165); b.set(enc.encode(address(m)), 0); b.set(enc.encode(address(owner)), 32); new DataView(b.buffer).setBigUint64(64, amount, true); b[108] = 1; return b; };
  const calls: string[][] = [];
  const reader = (vault: string) => async (xs: string[]) => { calls.push(xs); return [{ owner: E.QF_CURVE, lamports: 1n, data: launch }, { owner: E.TOKEN_2022, lamports: 1n, data: tok(mint, a.launchSigner, 206_900_000_000_000n) }, { owner: E.TOKEN, lamports: 1n, data: tok(E.NATIVE_MINT, vault, 849_000_010n) }]; };
  const s = await E.readCoin(reader(a.launchSigner), mint);
  assert.deepEqual(calls, [[a.launch, a.baseVault, a.quoteVault]]);
  assert.equal(s!.quoteVault, 849_000_010n);
  await assert.rejects(E.readCoin(reader(A(2)), mint), /launch signer/);
  assert.equal(await E.readCoin(async () => [null, null, null], mint), null);
});
