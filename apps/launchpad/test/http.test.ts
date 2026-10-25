// The HTTP helpers shared by the launchpad server: per-key rate limits and a one-at-a-time queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimiter, serial } from '../src/http.ts';

test('rate limits: per key per minute, idle keys are swept, and new keys beyond the cap share one bucket', async () => {
  let t = 0;
  const limit = rateLimiter(() => new Date(t), 3);
  for (let k = 0; k < 2; k++) limit('faucet:a', 2);
  assert.throws(() => limit('faucet:a', 2), /at most 2 requests per minute/);
  limit('faucet:b', 2); limit('faucet:c', 2);
  limit('faucet:d', 1);                                          // a 4th key: over the cap, goes to the shared bucket
  assert.throws(() => limit('faucet:e', 1), /RATE_LIMITED|at most 1/);
  t += 61_000;
  limit('faucet:a', 2); limit('faucet:a', 2);                    // a minute later: swept, fresh again
  const run = serial(), order: number[] = [];
  await Promise.all([3, 1, 2].map((ms, k) => run(async () => { await new Promise((r) => setTimeout(r, ms)); order.push(k); })));
  assert.deepEqual(order, [0, 1, 2], 'one at a time, in arrival order');
  await assert.rejects(run(async () => { throw new Error('x'); }));
  assert.equal(await run(async () => 7), 7, 'a failed job does not block the next');
});
