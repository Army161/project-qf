// `main.ts verify`: how each books check becomes PASS, FAIL or WAIT. TEST_ONLY: synthetic books and reward epochs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeCheck, vaultCheck, type Books } from '../src/books.ts';
import type { CoinRewards } from '../src/rewards.ts';
import { verifyReport } from '../src/verify.ts';
import { harness, seedLaunch } from './support/harness.ts';

const quote = { mint: 'Q', decimals: 6, symbol: 'qUSD' };
const coin = (symbol: string, checks: Record<string, unknown> | null) => ({ symbol, checks });
const books = (coins: unknown[], over: Record<string, unknown> = {}) =>
  ({ cluster: 'devnet', quote, asOf: '2026-10-11T00:00:00.000Z', coins, claims: [], treasury: null, ...over }) as unknown as Books;
const verdicts = (r: ReturnType<typeof verifyReport>) => r.checks.map((c) => [c.verdict, c.coin, c.check]);

test('fee checks: an exact match passes, a difference fails, an unread pool waits', () => {
  const ok = feeCheck(10n, '4', 6n, []), off = feeCheck(10n, '3', 6n, []), unread = feeCheck(10n, null, 6n, []);
  const r = verifyReport(books([coin('A', { creatorCurve: ok, platformCurve: off, lp: unread })]), []);
  assert.deepEqual(verdicts(r).slice(0, 3), [['PASS', '$A', 'creator curve fees add up'], ['FAIL', '$A', 'platform curve fees add up'], ['WAIT', '$A', 'LP fees add up']]);
  assert.match(r.checks[1]!.detail, /off by 0\.000001 qUSD/);
  assert.deepEqual(r.summary, { pass: 2, fail: 1, wait: 1 }, 'the claims line passes when there are no claims');
  assert.match(r.text, /2 PASS, 1 FAIL, 1 WAIT$/);
});

test('an LP residual passes only with its rounding proven; unproven waits when the accounting was unreadable, fails when it was read', () => {
  const residual = (origin: 'NOT_PROVEN' | 'PROVEN_ROUNDING', proof?: object) => ({ ...feeCheck(12n, '10', 0n, [], 2n), residual: { raw: '2', boundRaw: '2', origin, note: '', ...(proof ? { proof } : {}) } });
  const ok = feeCheck(1n, '1', 0n, []);
  const r = verifyReport(books([
    coin('P', { creatorCurve: ok, platformCurve: ok, lp: residual('PROVEN_ROUNDING', { ok: true }) }),
    coin('U', { creatorCurve: ok, platformCurve: ok, lp: residual('NOT_PROVEN') }),
    coin('X', { creatorCurve: ok, platformCurve: ok, lp: residual('NOT_PROVEN', { ok: false }) }),
  ]), []);
  assert.deepEqual(r.checks.filter((c) => c.check === 'LP fees add up').map((c) => [c.coin, c.verdict]), [['$P', 'PASS'], ['$U', 'WAIT'], ['$X', 'FAIL']]);
});

test('treasury, claims and reward records each become one line', () => {
  const treasury = { vaultCheck: vaultCheck(3n, 5n, 0, 2n) };
  const claims = [{ status: 'RESOLVED' }, { status: 'UNKNOWN' }];
  const epoch = (epochId: string, reproduced: boolean, status: string) => ({ epochId, frozen: { reproduced, hash: 'ab'.repeat(32) }, settlement: { status, paidRaw: '7', reasons: [] } });
  const rewards = [{ symbol: 'R', epochs: [epoch('2026-10-01', true, 'PAID'), epoch('2026-10-02', true, 'NOTHING_TO_PAY'), epoch('2026-10-03', false, 'MISMATCH'), { epochId: '2026-10-04', frozen: null }] }] as unknown as CoinRewards[];
  const r = verifyReport(books([], { treasury, claims }), rewards);
  assert.deepEqual(verdicts(r), [
    ['PASS', 'treasury', 'vault equals what went in and out'],
    ['WAIT', 'claims', 'every claim receipt read from its transaction'],
    ['PASS', '$R', 'rewards 2026-10-01 record recomputes identically'],
    ['PASS', '$R', 'rewards 2026-10-01 payout matches its record'],
    ['PASS', '$R', 'rewards 2026-10-02 record recomputes identically'],
    ['FAIL', '$R', 'rewards 2026-10-03 record recomputes identically'],
    ['FAIL', '$R', 'rewards 2026-10-03 payout matches its record'],
  ], 'nothing to pay adds no payout line; an open epoch adds none');
  assert.match(r.checks[0]!.detail, /rewards deposits out 0\.000002 qUSD/);
  assert.match(r.checks[1]!.detail, /1 of 2 proven/);
});

test('[TEST_ONLY] verify over real books: fees recorded by trades equal the pool\'s counters, so both curve checks pass', async () => {
  const h = await harness();
  const mint = seedLaunch(h.store, h.platform);
  h.store.insertTrade({ sig: 'trade-1', mint, trader: 'T', side: 'BUY', quoteRaw: '100000000', baseRaw: '1', slot: 1, blockTime: 1, source: 'app',
    fees: { venue: 'CURVE', status: 'RESOLVED', evidence: 'SWAP_EVENT', totalRaw: '2500000', protocolRaw: '500000', referralRaw: '0', creatorRaw: '1000000', platformRaw: '1000000', lpRaw: null, compoundingRaw: null } });
  const r = verifyReport(await h.books(), []);
  assert.deepEqual(r.checks.map((c) => [c.verdict, c.check]), [['PASS', 'creator curve fees add up'], ['PASS', 'platform curve fees add up'], ['PASS', 'every claim receipt read from its transaction']], r.text);
});
