// Headless Chromium smoke test of the MOCK lifecycle UI (built bundle, CSP on, no network beyond localhost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { computeEpochAllocations, ALLOCATION_POLICY_V0_TEST } from '@project-qf/rewards';
import { holders, exclusions } from '../src/fixtures.ts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const CHROMIUM = process.env.QF_CHROMIUM ?? '/opt/pw-browsers/chromium';
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.txt': 'text/plain' };

test('MOCK lifecycle UI renders, labels every step MOCK, and computes the reward root in a worker', { skip: !existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}` }, async () => {
  assert.ok(existsSync(join(dist, 'index.html')), 'run `pnpm build:web` first');
  const server = createServer((req, res) => {
    const p = join(dist, (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url ?? '').split('?')[0]!);
    if (!p.startsWith(dist) || !existsSync(p)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 15_000 });

    const banner = await page.textContent('#mock-banner');
    assert.match(banner ?? '', /MOCK/);
    assert.match(banner ?? '', /not live/i);
    const cards = await page.$$eval('li.card', (els) => els.map((e) => ({ mock: (e as HTMLElement).dataset.mock, badge: e.querySelector('.badge')?.textContent })));
    assert.equal(cards.length, 9);
    for (const c of cards) { assert.equal(c.mock, 'true'); assert.equal(c.badge, 'MOCK'); }
    const text = await page.textContent('#lifecycle');
    assert.match(text ?? '', /DEVNET_INTEGRATION.*BLOCKED/s);
    assert.match(text ?? '', /TEST_ONLY_SYNTHETIC_NOT_REAL_LIQUIDITY/);

    const root = await page.$eval('li.card:last-child', (e) => (e as HTMLElement).dataset.root);
    const expected = computeEpochAllocations({ epochId: 'MOCK-2026-09-27', window: { start: 1000, end: 2000 }, fundedRaw: 1_000_000n, carryIn: {},
      holders, exclusions, policy: ALLOCATION_POLICY_V0_TEST }).merkle.rootHex;
    assert.equal(root, expected, 'browser worker root equals Node root');

    assert.deepEqual(requests.filter((u) => !u.startsWith(`http://127.0.0.1:${port}/`)), [], 'no requests leave localhost');
    assert.deepEqual(errors, [], 'no console errors (including CSP violations)');
  } finally {
    await browser.close();
    server.close();
  }
});
