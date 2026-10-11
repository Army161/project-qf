// LP residual origin: the few raw units by which a graduated pool's trade LP fees exceed what its positions received are
// recomputed from the DAMM v2 pool's own fee accounting. TEST_ONLY: the three accounting snapshots below were read from
// devnet on 2026-10-05 (public chain data, valueless test tokens); the negative cases change one field each. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DammFeeAccounting } from '@project-qf/adapter-meteora-dbc/launchpad';
import { K } from '../../../packages/adapter-meteora-dbc/test/support/fixtures.ts';
import { explainLpResidual, rawFraction, type LpResidualInput } from '../src/lp-residual.ts';
import { harness, seedLaunch } from './support/harness.ts';

const L = '8233136322028285114808361262932', L1 = '4116568165138960358144621872092', L2 = '4116568156889324756663739390840';
const pos = (position: string, nftMint: string, liquidity: string, checkpointQuote = '0', claimedQuoteRaw = '0') =>
  ({ position, nftMint, liquidity, checkpointQuote, pendingQuoteRaw: '0', claimedQuoteRaw, claimedBaseRaw: '0' });
const accounting = (pool: string, F: string, totalLp: string, positions: DammFeeAccounting['positions']): DammFeeAccounting =>
  ({ pool, collectFeeMode: 1, liquidity: L, feePerLiquidityQuote: F, totalLpQuoteRaw: totalLp, totalLpBaseRaw: '0', totalPositions: String(positions.length), positions });

const DEVNET: Record<'VAULT' | 'CASH' | 'MCAT', LpResidualInput> = {
  VAULT: { ledgerLpRaw: 3680619n, dammTrades: 3, claimsRaw: 1599999n, claims: 1, accounting: accounting('HDnxLVQzPBVFhnGszBA5d1tQJ4iwAC5n54rxuENk2u2U', '152123042309302', '3680619', [
    pos('3nNrypsmxugRLXWHB3bUtxnDUxMvrZM2swZ5oxso3wx3', 'FKY2NbwQUfdS22TZUbagZZsxCs7Ykc85uyLApGVtyFdR', L1),
    pos('57uwTdgpbbTs9cDY9SuWyfR68zEMFfsNzSgNPVCTahfb', '8gEEEei7E1krQYR8GzgpoLUG2k1en3fFNu5udawR1Ri6', L2, '132258659586817', '1599999')]) },
  CASH: { ledgerLpRaw: 9996736n, dammTrades: 2, claimsRaw: 4998368n, claims: 1, accounting: accounting('cash-damm-pool', '413173407376026', '9996736', [
    pos('AVuxaae6kWtVgiXYnWHBLCoc1gAXGJaTnfZEKeHVsCb2', '8behaAu8X5fX8pE7Kt2UjsQeCQhwhC2CA4kiq8WxtT8V', L1, '413173407376026', '4998368'),
    pos('E58QJAvoVKJV6kAbNbKqq6CJ7FL69Atx9MgyoU88TA35', '6f1dcbHYofMSBix35wAcABxhWp1MZkV9NDgyqtp5pK3H', L2)]) },
  MCAT: { ledgerLpRaw: 300213n, dammTrades: 2, claimsRaw: 0n, claims: 0, accounting: accounting('mcat-damm-pool', '12408052803292', '300213', [
    pos('EYPVceDtXoAx6vWoKe6gVCioSAyu5e1SvziZcJVo3y1U', '78DW2ogc1q5aY17jQHwe6RXZSVp5hSAySVf779fjBPQB', L1),
    pos('HXsNS4qKosG2mx9aZpnMWioQrkEfHT3ZNZUCDy5939uM', 'GtrDhJJ58E7fJWVCuuT1v4Yr7zNGpWoDMwwzShCV8rDs', L2)]) },
};
const failed = (i: LpResidualInput) => explainLpResidual(i).checks.filter((c) => !c.ok).map((c) => c.id);
/** a copy of one devnet input with some fields changed */
const vary = (base: LpResidualInput, f: (i: LpResidualInput) => void): LpResidualInput => {
  const i = structuredClone(base);
  f(i);
  return i;
};

test('[TEST_ONLY devnet accounting] each graduated coin\'s LP residual is the DAMM v2 program\'s own rounding, split exactly', () => {
  const want = {
    VAULT: { residual: '2', parts: { accumulatorRaw: '0.000000052', settlementRaw: '1.999999947', unownedRaw: '0.000000000' },
      positions: [['1840309', '0.501843971', 0, null], ['1840308', '1.498155976', 1, true]] },
    CASH: { residual: '1', parts: { accumulatorRaw: '0.000000016', settlementRaw: '0.999999983', unownedRaw: '0.000000000' },
      positions: [['4998368', '0.005008376', 1, true], ['4998367', '0.994991606', 0, null]] },
    MCAT: { residual: '1', parts: { accumulatorRaw: '0.000000021', settlementRaw: '0.999999978', unownedRaw: '0.000000000' },
      positions: [['150106', '0.500150396', 0, null], ['150106', '0.499849581', 0, null]] },
  };
  for (const [coin, i] of Object.entries(DEVNET) as [keyof typeof DEVNET, LpResidualInput][]) {
    const p = explainLpResidual(i);
    assert.equal(p.status, 'PROVEN_ROUNDING', `${coin}: ${failed(i).join(', ')}`);
    assert.deepEqual(p.checks.map((c) => c.id), ['FEES_IN_QUOTE_ONLY', 'PROGRAM_COUNTER_EQUALS_LEDGER', 'ALL_LIQUIDITY_IN_KNOWN_POSITIONS', 'POSITIONS_ACCRUE_FROM_ZERO',
      'CLAIMS_EQUAL_RECEIPTS', 'ACCUMULATOR_ROUNDING_BOUNDED', 'SETTLEMENT_ROUNDING_BOUNDED', 'SINGLE_CLAIMS_RECOMPUTED', 'PARTS_ADD_UP']);
    assert.equal(p.residualRaw, want[coin].residual, coin);
    assert.deepEqual(p.parts, want[coin].parts, coin);
    assert.deepEqual(p.positions.map((x) => [x.receivedRaw, x.roundingRaw, x.settlementsAtMost, x.claimRecomputed]), want[coin].positions, coin);
    // what the positions received plus the residual is exactly what the trades recorded
    assert.equal(p.positions.reduce((a, x) => a + BigInt(x.receivedRaw), 0n) + BigInt(p.residualRaw), i.ledgerLpRaw, coin);
  }
});

test('a residual is NOT_PROVEN when any of the program\'s own numbers disagree with what QF recorded', () => {
  const V = DEVNET.VAULT;
  assert.deepEqual(failed(vary(V, (i) => { i.accounting.totalLpQuoteRaw = '3680620'; })), ['PROGRAM_COUNTER_EQUALS_LEDGER'], 'the program counted a different LP fee total');
  assert.deepEqual(failed(vary(V, (i) => { i.claimsRaw = 1599998n; })), ['CLAIMS_EQUAL_RECEIPTS'], 'a claim the app has no proven receipt for');
  assert.deepEqual(failed(vary(V, (i) => { i.accounting.totalPositions = '3'; })), ['ALL_LIQUIDITY_IN_KNOWN_POSITIONS'], 'a position the read did not return');
  assert.deepEqual(failed(vary(V, (i) => { i.accounting.positions[0]!.checkpointQuote = '1'; })), ['POSITIONS_ACCRUE_FROM_ZERO'], 'a position that started earning late');
  assert.ok(failed(vary(V, (i) => { i.accounting.totalLpBaseRaw = '5'; })).includes('FEES_IN_QUOTE_ONLY'), 'fees in the base token too');
  assert.ok(failed(vary(V, (i) => { i.accounting.collectFeeMode = 0; })).includes('FEES_IN_QUOTE_ONLY'));
  for (const i of [vary(V, (i) => { i.accounting.totalLpQuoteRaw = '3680620'; }), vary(V, (i) => { i.claimsRaw = 1599998n; })])
    assert.equal(explainLpResidual(i).status, 'NOT_PROVEN');
});

test('a residual is NOT_PROVEN when it is larger than rounding can make, even if the counters agree', () => {
  const V = DEVNET.VAULT;
  // one more raw unit in the trades and in the program's counter: the accumulator would have had to drop a whole unit
  const more = vary(V, (i) => { i.ledgerLpRaw += 1n; i.accounting.totalLpQuoteRaw = '3680620'; });
  assert.deepEqual([explainLpResidual(more).residualRaw, failed(more)], ['3', ['ACCUMULATOR_ROUNDING_BOUNDED']]);
  // a position missing from the read: its share is unowned liquidity, not rounding
  const missing = vary(V, (i) => { i.accounting.positions.pop(); i.accounting.totalPositions = '1'; });
  const pm = explainLpResidual(missing);
  assert.equal(pm.status, 'NOT_PROVEN');
  assert.ok(failed(missing).includes('ALL_LIQUIDITY_IN_KNOWN_POSITIONS'));
  assert.ok(pm.parts.unownedRaw.startsWith('1840309.'), `unowned ${pm.parts.unownedRaw}`);
  // a claim one unit short of floor(liquidity x checkpoint / 2^128): not the program's rounding at that moment
  const short = vary(V, (i) => { i.claimsRaw = 1599998n; i.accounting.positions[1]!.claimedQuoteRaw = '1599998'; });
  assert.deepEqual(failed(short), ['SETTLEMENT_ROUNDING_BOUNDED', 'SINGLE_CLAIMS_RECOMPUTED']);
  // positions that received more than the trades recorded: never rounding
  const over = vary(DEVNET.MCAT, (i) => { i.ledgerLpRaw = 300211n; i.accounting.totalLpQuoteRaw = '300211'; });
  assert.deepEqual([explainLpResidual(over).status, explainLpResidual(over).residualRaw], ['NOT_PROVEN', '-1']);
});

test('rawFraction prints a numerator over 2^128 to 9 places, rounded toward zero', () => {
  const S = 1n << 128n;
  assert.equal(rawFraction(S), '1.000000000');
  assert.equal(rawFraction(S / 2n), '0.500000000');
  assert.equal(rawFraction(3n * S - 1n), '2.999999999');
  assert.equal(rawFraction(1n), '0.000000000');
  assert.equal(rawFraction(-S / 4n), '-0.250000000');
  assert.equal(rawFraction(0n), '0.000000000');
});

test('[TEST_ONLY] Earnings: an LP residual is labelled the pool\'s rounding only when the pool\'s accounting proves it', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform, { migrated: true });
  // two DAMM v2 trades recorded 250000 + 250001 LP fee; the creator's position (harness double) shows 500000 unclaimed
  for (const [sig, lpRaw] of [['d1', '250000'], ['d2', '250001']] as const) {
    h.store.insertTrade({ sig, mint, trader: 'A'.repeat(43), side: 'BUY', quoteRaw: '1', baseRaw: '1', slot: 1, blockTime: 1, source: 'indexer' });
    h.store.setTradeFees(sig, { venue: 'DAMM_V2', status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: lpRaw, protocolRaw: '0', referralRaw: '0',
      creatorRaw: null, platformRaw: null, lpRaw, compoundingRaw: null });
  }
  const lp = async () => (await h.books()).coins[0].checks.lp;

  // the harness accounting (no fees accrued) does not describe this pool: the residual stays unproven and says so
  let c = await lp();
  assert.deepEqual([c.status, c.differenceRaw, c.residual.raw, c.residual.origin, c.residual.proof], ['RESIDUAL', '1', '1', 'NOT_PROVEN', undefined]);
  assert.match(c.residual.note, /gives 500001 raw instead/);

  // liquidity 2^64 and fee per liquidity just under 500001 x 2^64: the position is owed 500000.99… and paid 500000
  const L64 = 1n << 64n;
  const good: DammFeeAccounting = { pool: K.dammPool.toBase58(), collectFeeMode: 1, liquidity: L64.toString(), feePerLiquidityQuote: (500001n * L64 - 1n).toString(),
    totalLpQuoteRaw: '500001', totalLpBaseRaw: '0', totalPositions: '1',
    positions: [{ position: 'pos', nftMint: K.positionNft.toBase58(), liquidity: L64.toString(), checkpointQuote: '0', pendingQuoteRaw: '0', claimedQuoteRaw: '0', claimedBaseRaw: '0' }] };
  h.chain.dammFeeAccounting = async () => good;
  c = await lp();
  assert.deepEqual([c.status, c.residual.origin, c.residual.proof.status, c.residual.proof.parts.settlementRaw], ['RESIDUAL', 'PROVEN_ROUNDING', 'PROVEN_ROUNDING', '0.999999999']);
  assert.match(c.residual.note, /rounding in the DAMM v2 program's own fee math/);

  // the program's counter disagrees with the trades: the proof is attached, the label is not
  h.chain.dammFeeAccounting = async () => ({ ...good, totalLpQuoteRaw: '500002' });
  c = await lp();
  assert.deepEqual([c.residual.origin, c.residual.proof.status], ['NOT_PROVEN', 'NOT_PROVEN']);
  assert.match(c.residual.note, /PROGRAM_COUNTER_EQUALS_LEDGER did not pass/);

  // the accounting cannot be read: the residual stays an explicit, unproven residual
  h.chain.dammFeeAccounting = async () => { throw new Error('DAMM_ACCOUNTING_MOVING'); };
  c = await lp();
  assert.deepEqual([c.status, c.residual.origin, c.residual.proof], ['RESIDUAL', 'NOT_PROVEN', undefined]);
});
