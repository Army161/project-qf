// Confirmation polling (no network): a fake connection scripts the RPC answers. The public devnet RPC answers bursts
// with 429; that must back off and keep waiting, never surface as a failure or an unhandled rejection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from '@solana/web3.js';
import { confirmSignature } from '../src/launchpad.ts';

function fakeConn(statuses: (() => unknown)[], blockHeight = 100) {
  let i = 0;
  return { getSignatureStatuses: async () => { const f = statuses[Math.min(i++, statuses.length - 1)]!; return { value: [f()] }; },
    getBlockHeight: async () => blockHeight } as unknown as Connection;
}
const busy = () => { throw new Error('429 Too Many Requests: {"error":{"code":429}}'); };

test('confirmation rides out RPC 429s and returns once the transaction is confirmed', async () => {
  await confirmSignature(fakeConn([busy, () => null, () => ({ confirmationStatus: 'confirmed', err: null })]), 'sig', 1_000);
});

test('a transaction that landed with an error, or whose blockhash expired, is reported as failed', async () => {
  await assert.rejects(confirmSignature(fakeConn([() => ({ confirmationStatus: 'confirmed', err: { InstructionError: [2, 'x'] } })]), 'sig', 1_000), /TRANSACTION_FAILED/);
  await assert.rejects(confirmSignature(fakeConn([() => null], 2_000), 'sig', 1_000), /TRANSACTION_EXPIRED/);
});

test('an RPC error that is not "busy" is not swallowed', async () => {
  await assert.rejects(confirmSignature(fakeConn([() => { throw new Error('invalid param'); }]), 'sig', 1_000), /invalid param/);
});
