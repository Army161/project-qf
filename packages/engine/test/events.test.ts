// Engine events from log messages: attributed to the program that wrote them, unknown formats refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBase64Decoder } from '@solana/kit';
import * as E from '../src/index.ts';
import { encodeFields } from '../src/codec.ts';

const b64 = getBase64Decoder();
const MINT = 'So11111111111111111111111111111111111111112', TRADER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', OTHER = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const data = (idl: E.EngineIdl, name: string, v: Record<string, unknown>) => `Program data: ${b64.decode(Uint8Array.from([...idl.events[name]!.discriminator, ...encodeFields(v, idl.events[name]!.fields, idl.types)]))}`;
const trade = { mint: MINT, trader: TRADER, is_buy: true, quote_amount: 10_000_000n, base_amount: 35_000_000_000n, platform_fee: 70_000n, creator_fee: 30_000n, real_quote: 9_900_000n, base_sold: 35_000_000_000n, complete: false };

test('a buy\'s TradeEvent is decoded with its fields; other programs\' data lines are ignored', () => {
  const logs = [
    `Program ${E.COMPUTE_BUDGET} invoke [1]`, `Program ${E.COMPUTE_BUDGET} success`,
    `Program ${OTHER} invoke [1]`, 'Program data: AAAA', `Program ${OTHER} success`,
    `Program ${E.QF_CURVE} invoke [1]`, 'Program log: Instruction: Buy',
    `Program ${E.TOKEN} invoke [2]`, 'Program log: Instruction: TransferChecked', `Program ${E.TOKEN} consumed 6200 of 380000 compute units`, `Program ${E.TOKEN} success`,
    data(E.CURVE_IDL, 'TradeEvent', trade),
    `Program ${E.QF_CURVE} consumed 41000 of 400000 compute units`, `Program ${E.QF_CURVE} success`,
  ];
  const { events, truncated } = E.parseEngineEvents(logs);
  assert.equal(truncated, false);
  assert.deepEqual(events, [{ name: 'TradeEvent', program: E.QF_CURVE, depth: 1, mint: MINT, trader: TRADER, isBuy: true, quoteAmount: 10_000_000n, baseAmount: 35_000_000_000n,
    platformFee: 70_000n, creatorFee: 30_000n, realQuote: 9_900_000n, baseSold: 35_000_000_000n, complete: false }]);
});

test('inside a graduation the pool\'s event is the pool\'s and the curve\'s is the curve\'s', () => {
  const lp = { pool_id: MINT, lp_amount_before: 0n, token_0_vault_before: 1n, token_1_vault_before: 2n, token_0_amount: 3n, token_1_amount: 4n, token_0_transfer_fee: 0n, token_1_transfer_fee: 0n, change_type: 0 };
  const logs = [
    `Program ${E.QF_CURVE} invoke [1]`,
    `Program ${E.QF_POOL} invoke [2]`, data(E.POOL_IDL, 'LpChangeEvent', lp), `Program ${E.QF_POOL} success`,
    data(E.CURVE_IDL, 'Graduated', { mint: MINT, pool: TRADER, quote_to_pool: 839_000_000n, base_to_pool: 206_900_000_000_000n, graduation_fee: 10_000_000n, lp_burned: 1n }),
    `Program ${E.QF_CURVE} success`,
  ];
  const ev = E.parseEngineEvents(logs).events;
  assert.deepEqual(ev.map((e) => [e.name, e.program, e.depth]), [['LpChangeEvent', E.QF_POOL, 2], ['Graduated', E.QF_CURVE, 1]]);
  assert.equal((ev[1] as E.GraduatedEvent).quoteToPool, 839_000_000n);
});

test('LaunchCreated carries the coin\'s name, symbol, link and settings', () => {
  const cfg = { total_supply: 1n, curve_supply: 1n, virtual_quote: 1n, virtual_base: 2n, trade_fee_bps: 100, creator_fee_share_bps: 3000, graduation_fee: 0n };
  const [e] = E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [1]`, data(E.CURVE_IDL, 'LaunchCreated', { mint: MINT, creator: TRADER, name: 'Dog ✓', symbol: 'DOG', uri: 'https://x/m.json', config: cfg }), `Program ${E.QF_CURVE} success`]).events;
  assert.equal(e!.name, 'LaunchCreated');
  const lc = e as E.LaunchCreatedEvent;
  assert.equal(lc.coinName, 'Dog ✓'); assert.equal(lc.config.tradeFeeBps, 100n); assert.equal(lc.config.virtualBase, 2n);
});

test('an unknown event from an engine program, a malformed log or a broken call stack is refused; truncation is reported', () => {
  assert.throws(() => E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [1]`, 'Program data: AAAAAAAAAAAAAA==', `Program ${E.QF_CURVE} success`]), /unknown qf_curve event/);
  const long = b64.decode(Uint8Array.from([...E.CURVE_IDL.events.TradeEvent!.discriminator, ...encodeFields(trade, E.CURVE_IDL.events.TradeEvent!.fields, E.CURVE_IDL.types), 0]));
  assert.throws(() => E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [1]`, `Program data: ${long}`]), /trailing/);
  assert.throws(() => E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [1]`, 'Program data: AAAA BBBB']), /one data slice/);
  for (const junk of ['AAAAA', 'AAAA=AA', 'AB==', 'AAA!']) assert.throws(() => E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [1]`, `Program data: ${data(E.CURVE_IDL, 'TradeEvent', trade).slice(14)}${junk}`]), /base64/, junk);
  assert.throws(() => E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [2]`]), /depth/);
  assert.throws(() => E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [1]`, `Program ${E.QF_POOL} success`]), /out of order/);
  const r = E.parseEngineEvents([`Program ${E.QF_CURVE} invoke [1]`, data(E.CURVE_IDL, 'TradeEvent', trade), 'Log truncated']);
  assert.equal(r.truncated, true); assert.equal(r.events.length, 1);
});
