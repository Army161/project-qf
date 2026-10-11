// Headless Chromium smoke test of the launchpad's browser app: the built bundle served by the real launchpad server (strict
// CSP) over the in-process chain double, at phone width, with a view-only Wallet Standard wallet that cannot sign.
// TEST_ONLY: synthetic chain, no network beyond localhost, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { generateMintKey } from '@project-qf/tx';
import { harness, seedLaunch } from '../../launchpad/test/support/harness.ts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const CHROMIUM = process.env.QF_CHROMIUM ?? '/opt/pw-browsers/chromium';

/** Moves the app to a page and waits until that page has rendered. */
async function go(page: Page, hash: string) {
  await page.evaluate((x) => { document.body.dataset.ready = ''; location.hash = x; }, hash);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 15_000 });
}

test('launchpad UI: explore, a coin, My coins before and after connecting, create, and old links land on My coins', { skip: !existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}` }, async () => {
  assert.ok(existsSync(join(dist, 'launchpad.html')), 'run `pnpm build:web` first');
  const serverLog: string[] = [];
  const h = await harness({ staticDir: dist, log: (m) => serverLog.push(m) });
  const creator = (await generateMintKey()).address;
  const mint = seedLaunch(h.store, h.platform, { creator, symbol: 'SMOKE' });
  const base = `http://127.0.0.1:${(h.app.address() as { port: number }).port}`;

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-proxy-server'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((address) => {
      const wallet = { name: 'View-only test wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22/%3E', version: '1.0.0',
        chains: ['solana:devnet'], accounts: [],
        features: { 'standard:connect': { connect: async () => ({ accounts: [{ address, publicKey: new Uint8Array(32), chains: ['solana:devnet'], features: [] }] }) },
          'solana:signTransaction': { signTransaction: async () => { throw new Error('view-only'); } } } };
      window.addEventListener('wallet-standard:app-ready', (e) => (e as CustomEvent).detail.register(wallet));
    }, creator);
    const page = await ctx.newPage();
    const requests: string[] = [], errors: string[] = [], failed: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(base.length)}`); });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    await page.goto(`${base}/`);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('#view .grid')?.textContent?.includes('$SMOKE'), null, { timeout: 15_000 });
    assert.deepEqual(await page.$$eval('nav a', (as) => as.map((a) => a.textContent)), ['Explore', 'Create', 'My coins']);
    assert.ok(await fits(), 'home fits a phone screen');

    await go(page, `#/t/${mint}`);
    assert.match(await page.textContent('#view') ?? '', /\$SMOKE/);
    assert.ok(await fits(), 'the coin page fits a phone screen');

    await go(page, '#/me');
    assert.match(await page.textContent('#view') ?? '', /Connect your wallet/);
    await page.click('#connect');
    await page.click('.wopt');
    await page.waitForFunction(() => document.querySelector('#view')?.textContent?.includes('Coins you launched'), null, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('#view .grid')?.textContent?.includes('$SMOKE'), null, { timeout: 15_000 });
    assert.match(await page.textContent('#view') ?? '', /No holder rewards have been paid to this wallet yet/);
    assert.ok(await fits(), 'My coins fits a phone screen');

    await go(page, '#/create');
    assert.ok(await page.$('#view input'), 'the create form renders');
    assert.ok(await fits(), 'create fits a phone screen');

    for (const old of ['#/earnings', '#/fees', '#/status', `#/rewards/${mint}/2026-10-05`]) {
      await page.evaluate((x) => { location.hash = x; }, old);
      await page.waitForFunction(() => location.hash === '#/me', null, { timeout: 5_000 });
    }

    assert.deepEqual(requests.filter((u) => !u.startsWith(`${base}/`) && !u.startsWith('data:')), [], 'no requests leave the launchpad server');
    assert.deepEqual(failed, [], `no failed requests; server log: ${serverLog.join(' | ')}`);
    assert.deepEqual(errors, [], 'no console errors (including CSP violations)');
  } finally {
    await browser.close();
  }
});
