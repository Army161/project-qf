import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerHistories, reconcileWithChain, type BalanceChange } from '../src/history.ts';
import { exclusionsFor, EXCLUSION_POLICY_V1_TEST } from '../src/exclusion.ts';
import { utcEpochs } from '../src/epoch.ts';
import { twabBalanceUnits } from '../src/twab.ts';

// Synthetic accounts and owners (valid addresses; no keys exist for them).
const POOL = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'; // DBC pool authority: a program-derived address
const A = '4eup3PdJfMjbPXA9g6Qy43HPmiC7EMD4PvC74DGVPArX', B = '8RKJVqkE8EGWLfghbXUAe1JhgEN2Z9eEX4EJ8xXdnAYG';
const ch = (sig: string, slot: number, account: string, owner: string, pre: bigint, post: bigint): BalanceChange => ({ sig, slot, account, owner, preRaw: pre, postRaw: post });
const life: BalanceChange[] = [
  ch('create', 10, 'vault', POOL, 0n, 1000n),
  ch('buy', 20, 'vault', POOL, 1000n, 700n), ch('buy', 20, 'ataA', A, 0n, 300n),
  ch('send', 30, 'ataA', A, 300n, 100n), ch('send', 30, 'ataB', B, 0n, 200n), // a direct transfer: B never trades
];

test('history: trades and direct transfers both move balances; one point per owner per slot', () => {
  const h = ownerHistories(life);
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.histories.get(A), [{ t: 20, balanceRaw: 300n }, { t: 30, balanceRaw: 100n }]);
  assert.deepEqual(h.histories.get(B), [{ t: 30, balanceRaw: 200n }]);
  assert.deepEqual(h.accounts.map((a) => [a.account, a.owner, a.balanceRaw]), [['ataA', A, 100n], ['ataB', B, 200n], ['vault', POOL, 700n]]);
  // slot-weighted: B holds 200 for the last 10 slots of [0, 40)
  assert.equal(twabBalanceUnits(h.histories.get(B)!, { start: 0, end: 40 }), 2000n);
  assert.equal(twabBalanceUnits(h.histories.get(A)!, { start: 0, end: 40 }), 300n * 10n + 100n * 10n);
});

test('history: the order of transactions inside a slot does not matter, and input order does not change the result', () => {
  // A sends to B and B sends back part of it in the same slot: only the net per account counts
  const same = [...life, ch('x1', 40, 'ataA', A, 100n, 50n), ch('x1', 40, 'ataB', B, 200n, 250n), ch('x2', 40, 'ataB', B, 250n, 230n), ch('x2', 40, 'ataA', A, 50n, 70n)];
  const a = ownerHistories(same), b = ownerHistories([...same].reverse());
  assert.deepEqual(a.problems, []);
  assert.deepEqual([...a.histories], [...b.histories]);
  assert.deepEqual(a.histories.get(A)!.at(-1), { t: 40, balanceRaw: 70n });
  assert.deepEqual(a.histories.get(B)!.at(-1), { t: 40, balanceRaw: 230n });
});

test('history: an account changing owner moves its balance to the new owner', () => {
  const h = ownerHistories([...life, ch('setauth', 50, 'ataA', B, 100n, 100n)]);
  assert.deepEqual(h.histories.get(A)!.at(-1), { t: 50, balanceRaw: 0n });
  assert.deepEqual(h.histories.get(B)!.at(-1), { t: 50, balanceRaw: 300n });
});

test('history: gaps are reported, never smoothed over', () => {
  const noCreation = ownerHistories(life.filter((c) => c.sig !== 'create' && c.sig !== 'buy'));
  // ataA's first known change starts from 300, not from its creation, and replaying it from zero goes negative
  assert.deepEqual(noCreation.problems.map((p) => p.split(' ').slice(0, 2).join(' ')), ['REPLAY_MISMATCH ataA', 'HISTORY_NOT_FROM_CREATION ataA:']);
  // a missing transaction in the middle: the next one does not continue from the replayed balance
  const gap = ownerHistories([...life, ch('later', 60, 'ataA', A, 400n, 350n)]);
  assert.match(gap.problems[0]!, /^REPLAY_MISMATCH ataA at slot 60/);
  const twoOwners = ownerHistories([...life, ch('o1', 70, 'ataA', B, 100n, 100n), ch('o2', 70, 'ataA', POOL, 100n, 100n)]);
  assert.match(twoOwners.problems[0]!, /^OWNER_CHANGED_TWICE_IN_SLOT ataA/);
  assert.throws(() => ownerHistories([...life, life[0]!]), /duplicate change/);
  // changes at or after the cut-off slot are not used
  assert.equal(ownerHistories(life, 30).histories.get(B), undefined);
});

test('history replays must equal the chain: listed balances, and zero for closed accounts', () => {
  const { accounts } = ownerHistories(life);
  assert.deepEqual(reconcileWithChain(accounts, [{ account: 'vault', amountRaw: 700n }, { account: 'ataA', amountRaw: 100n }, { account: 'ataB', amountRaw: 200n }]), { ok: true, mismatches: [] });
  const r = reconcileWithChain(accounts, [{ account: 'vault', amountRaw: 700n }, { account: 'ataA', amountRaw: 90n }, { account: 'ataC', amountRaw: 5n }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, ['ataA: replayed 100, on chain 90', 'ataC: holds 5 on chain, no history', 'ataB: replayed 200, not on chain (closed)']);
});

test('exclusion@1: named accounts, burn addresses and program-derived owners; wallets stay eligible', () => {
  const ex = exclusionsFor([A, B, POOL, '1nc1nerator11111111111111111111111111111111', B], [{ owner: A, reason: 'QF_OPERATOR' }]);
  assert.deepEqual(ex, [
    { owner: '1nc1nerator11111111111111111111111111111111', reason: 'BURN_ADDRESS' },
    { owner: A, reason: 'QF_OPERATOR' },
    { owner: POOL, reason: 'OFF_CURVE_OWNER: program-derived address (pool, vault or program account)' },
  ]);
  assert.equal(EXCLUSION_POLICY_V1_TEST.version, 'exclusion@1');
  assert.deepEqual(exclusionsFor([B], []), []);
});

test('UTC epochs: whole days, ids are the date', () => {
  const d = Date.UTC(2026, 9, 3) / 1000;
  assert.deepEqual(utcEpochs(d + 5, d + 86_400 + 1), [{ epochId: '2026-10-03', startSec: d, endSec: d + 86_400 }, { epochId: '2026-10-04', startSec: d + 86_400, endSec: d + 172_800 }]);
  assert.throws(() => utcEpochs(10, 5), /invalid range/);
});
