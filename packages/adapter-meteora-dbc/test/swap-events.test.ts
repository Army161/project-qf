// Swap events (fee ledger). Real devnet bytes (TEST_ONLY fixture, valueless test tokens) decoded by packages/tx and,
// independently, by the Anchor event coder the Meteora SDKs themselves depend on, with the SDKs' full bundled IDLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { BorshError, decodeSwapEvent, DAMM_IDL_SUBSET, DBC_IDL_SUBSET, PROGRAM_IDS } from '@project-qf/tx';
import { swapEventData } from './support/swap-events.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/swap-events-devnet.json', import.meta.url), 'utf8')) as {
  transactions: { signature: string; innerInstructions: { programId: string; dataHex: string }[] }[] };
const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const eventsOf = (sig: string) => fx.transactions.find((t) => t.signature.startsWith(sig))!.innerInstructions
  .map((i) => decodeSwapEvent(i.programId, hex(i.dataHex))).filter((e) => e !== null);

test('[TEST_ONLY devnet bytes] each swap transaction has exactly one EvtSwap2; its fees are the ones the programs reported', () => {
  const [buy] = eventsOf('5mPX3Y'), [sell] = eventsOf('TPRc4L'), [dbuy] = eventsOf('65BNQx'), [dsell] = eventsOf('34YEPY');
  for (const s of ['5mPX3Y', 'TPRc4L', '65BNQx', '34YEPY']) assert.equal(eventsOf(s).length, 1, `${s}: the other events in the transaction (EvtSwap, curve complete) are not counted again`);
  assert.deepEqual([buy!.venue, buy!.pool, buy!.tradeDirection, buy!.tradingFee, buy!.protocolFee, buy!.referralFee],
    ['CURVE', '6Nq2JLyXf2bZHEVweuorkbyzmjP9CAjXGP6TjqnuSgek', 1, 5_680_809n, 1_420_202n, 0n]);
  assert.deepEqual([sell!.tradeDirection, sell!.tradingFee, sell!.protocolFee], [0, 636n, 158n]);
  assert.deepEqual([dbuy!.venue, dbuy!.pool, dbuy!.collectFeeMode, dbuy!.lpFee, dbuy!.protocolFee, dbuy!.compoundingFee],
    ['DAMM_V2', 'HDnxLVQzPBVFhnGszBA5d1tQJ4iwAC5n54rxuENk2u2U', 1, 3_200_000n, 800_000n, 0n]);
  assert.deepEqual([dsell!.tradeDirection, dsell!.lpFee, dsell!.protocolFee], [0, 7_596_736n, 1_899_184n]);
  // the trader paid 7.101011 qUSD in fees on a 710.101012 qUSD buy: 1% (the program rounds the fee up)
  assert.equal(buy!.tradingFee + buy!.protocolFee, 7_101_011n);
});

test('[TEST_ONLY devnet bytes] the Anchor event coder the SDKs use, with their full IDLs, decodes the same fees', async () => {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@meteora-ag/dynamic-bonding-curve-sdk'));
  const { BorshCoder } = sdkRequire('@coral-xyz/anchor') as { BorshCoder: new (idl: unknown) => { events: { decode(b64: string): { name: string; data: any } | null } } };
  const dbc = new BorshCoder(sdkRequire('@meteora-ag/dynamic-bonding-curve-sdk').DynamicBondingCurveIdl);
  const damm = new BorshCoder((await import('@meteora-ag/cp-amm-sdk') as any).CpAmmIdl);
  let checked = 0;
  for (const t of fx.transactions) for (const i of t.innerInstructions) {
    const ours = decodeSwapEvent(i.programId, hex(i.dataHex));
    if (!ours) continue;
    const theirs = (i.programId === PROGRAM_IDS.DBC ? dbc : damm).events.decode(Buffer.from(hex(i.dataHex).subarray(8)).toString('base64'))!;
    assert.equal(theirs.name, 'EvtSwap2');
    const r = theirs.data.swap_result ?? theirs.data.swapResult;
    const n = (x: { toString(): string }) => BigInt(x.toString());
    assert.equal((theirs.data.pool).toBase58(), ours.pool);
    if (ours.venue === 'CURVE') assert.deepEqual([n(r.trading_fee ?? r.tradingFee), n(r.protocol_fee ?? r.protocolFee), n(r.referral_fee ?? r.referralFee)], [ours.tradingFee, ours.protocolFee, ours.referralFee]);
    else assert.deepEqual([n(r.claiming_fee ?? r.claimingFee), n(r.compounding_fee ?? r.compoundingFee), n(r.protocol_fee ?? r.protocolFee)], [ours.lpFee, ours.compoundingFee, ours.protocolFee]);
    checked++;
  }
  assert.equal(checked, 4);
});

test('a swap event is read exactly or not at all: other programs and other events are ignored, a malformed one throws', () => {
  const pool = '6Nq2JLyXf2bZHEVweuorkbyzmjP9CAjXGP6TjqnuSgek';
  const good = swapEventData('CURVE', { pool, tradingFee: 10n, protocolFee: 2n });
  assert.equal(decodeSwapEvent(DBC_IDL_SUBSET.provenance.programId, good)!.tradingFee, 10n);
  assert.equal(decodeSwapEvent(PROGRAM_IDS.SQUADS_V4, good), null, 'same bytes from another program are not a Meteora swap');
  assert.equal(decodeSwapEvent(DAMM_IDL_SUBSET.provenance.programId, swapEventData('DAMM_V2', { pool, lpFee: 7n }))!.lpFee, 7n);
  const otherEvent = Uint8Array.from(good); otherEvent[8] = otherEvent[8]! ^ 0xff;
  assert.equal(decodeSwapEvent(DBC_IDL_SUBSET.provenance.programId, otherEvent), null);
  const notEvent = Uint8Array.from(good); notEvent[0] = notEvent[0]! ^ 0xff;
  assert.equal(decodeSwapEvent(DBC_IDL_SUBSET.provenance.programId, notEvent), null, 'an instruction (no emit_cpi tag) is not an event');
  assert.throws(() => decodeSwapEvent(DBC_IDL_SUBSET.provenance.programId, Uint8Array.from([...good, 0])), BorshError);
  assert.throws(() => decodeSwapEvent(DBC_IDL_SUBSET.provenance.programId, good.subarray(0, good.length - 1)), BorshError);
});
