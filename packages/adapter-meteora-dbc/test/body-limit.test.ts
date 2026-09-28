// BODY-LIMIT (repair-decision review, 2026-09-27): createBoundedFetch must stop an oversized body while it streams,
// cancel it, and keep a deadline through body consumption. Offline: every response is an in-memory stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedFetch } from '../src/index.ts';

function lazyBody({ chunks = 128, chunkBytes = 256, headers = {} as Record<string, string>, delayMs = 0, status = 200 } = {}) {
  const s = { produced: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (s.produced === chunks) { c.close(); return; }
      s.produced++; c.enqueue(new Uint8Array(chunkBytes).fill(32));
    },
    cancel() { s.cancelled = true; },
  }, { highWaterMark: 0 });
  return { s, response: new Response(body, { status, headers }) };
}

test('BODY-LIMIT: the reviewer diagnostic (1,024-byte cap, 32,768-byte body) stops early and cancels', async () => {
  const { s, response } = lazyBody();
  const f = createBoundedFetch({ maxBytes: 1024, fetchImpl: async () => response });
  await assert.rejects(f('https://synthetic.invalid'), /RPC_RESPONSE_TOO_LARGE/);
  assert.ok(s.produced * 256 <= 1024 + 256, `consumed ${s.produced * 256} bytes`);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: absent or false Content-Length cannot bypass the streaming cap', async () => {
  const { s, response } = lazyBody({ headers: { 'content-length': '12' } });
  const f = createBoundedFetch({ maxBytes: 1024, fetchImpl: async () => response });
  await assert.rejects(f('https://synthetic.invalid'), /RPC_RESPONSE_TOO_LARGE/);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: a declared oversize is refused before any body byte is read, and the body is cancelled', async () => {
  const { s, response } = lazyBody({ headers: { 'content-length': '999999' } });
  const f = createBoundedFetch({ maxBytes: 1024, fetchImpl: async () => response });
  await assert.rejects(f('https://synthetic.invalid'), /RPC_RESPONSE_TOO_LARGE declared/);
  assert.equal(s.produced, 0);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: exactly maxBytes is accepted and returned intact; maxBytes + 1 is refused', async () => {
  const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'y'.repeat(500) });
  const ok = createBoundedFetch({ maxBytes: text.length, fetchImpl: async () => new Response(text) });
  assert.equal(await (await ok('https://synthetic.invalid')).text(), text);
  const over = createBoundedFetch({ maxBytes: text.length - 1, fetchImpl: async () => new Response(text) });
  await assert.rejects(over('https://synthetic.invalid'), /RPC_RESPONSE_TOO_LARGE/);
});

test('BODY-LIMIT: a stalled body hits the whole-body deadline and is cancelled', async () => {
  const { s, response } = lazyBody({ chunks: 1000, chunkBytes: 1, delayMs: 20 });
  const f = createBoundedFetch({ maxBytes: 1 << 20, timeoutMs: 100, fetchImpl: async () => response });
  const t0 = Date.now();
  await assert.rejects(f('https://synthetic.invalid'), /RPC_RESPONSE_TIMEOUT/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(s.cancelled, true);
});

test('BODY-LIMIT: the deadline signal reaches the underlying fetch, and a caller abort is honoured', async () => {
  let seen: AbortSignal | undefined;
  const f = createBoundedFetch({ timeoutMs: 50, fetchImpl: (async (_u: unknown, init?: RequestInit) => {
    seen = init?.signal ?? undefined;
    return await new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted by signal'))));
  }) as typeof fetch });
  await assert.rejects(f('https://synthetic.invalid'), /RPC_RESPONSE_TIMEOUT|aborted/);
  assert.ok(seen, 'fetch received a signal');
  const ac = new AbortController();
  const g = createBoundedFetch({ fetchImpl: (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('caller aborted'))))) as typeof fetch });
  const p = g('https://synthetic.invalid', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /aborted/);
});

test('BODY-LIMIT: an oversized error body is bounded as well', async () => {
  const { s, response } = lazyBody({ status: 503 });
  const f = createBoundedFetch({ maxBytes: 1024, fetchImpl: async () => response });
  await assert.rejects(f('https://synthetic.invalid'), /RPC_RESPONSE_TOO_LARGE/);
  assert.equal(s.cancelled, true);
});
