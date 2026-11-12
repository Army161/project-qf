// Headless Chromium smoke test of the launchpad's browser app: the built bundle served by the real launchpad server (strict
// CSP) over the in-process engine chain double, at phone width, with a view-only Wallet Standard wallet that cannot sign.
// TEST_ONLY: synthetic chain, no network beyond localhost, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { generateMintKey } from '@project-qf/tx';
import { engineHarness, putPlatform, seedEngineCoin } from '../../launchpad/test/support/engine-fake.ts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const CHROMIUM = process.env.QF_CHROMIUM ?? '/opt/pw-browsers/chromium';

/** Moves the app to a page and waits until that page has rendered. */
async function go(page: Page, hash: string) {
  await page.evaluate((x) => { document.body.dataset.ready = ''; location.hash = x; }, hash);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 15_000 });
}

test('launchpad UI: explore, a coin, create, My coins before and after connecting, old links, SOL quote and the engine economics', { skip: !existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}` }, async () => {
  assert.ok(existsSync(join(dist, 'launchpad.html')), 'run `pnpm build:web` first');
  const serverLog: string[] = [];
  const h = await engineHarness({ staticDir: dist, log: (m) => serverLog.push(m) });
  await putPlatform(h.chain);
  const creator = (await generateMintKey()).address, mint = (await generateMintKey()).address;
  await seedEngineCoin(h, creator, mint, 'ENGN', { realQuote: 100_000_000n, baseSold: 200_000_000_000_000n, platformFees: 700_000n, creatorFees: 300_000n });
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
    const view = async () => (await page.textContent('#view')) ?? '';
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    await page.goto(`${base}/`);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('#view .grid')?.textContent?.includes('$ENGN'), null, { timeout: 15_000 });
    assert.deepEqual(await page.$$eval('nav a', (as) => as.map((a) => a.textContent)), ['Explore', 'Create', 'My coins']);
    assert.match(await view(), /priced in SOL/);
    assert.match(await view(), /graduates to its own pool/);
    assert.ok(await fits(), 'home fits a phone screen');

    await go(page, `#/t/${mint}`);
    assert.match(await view(), /SOL per ENGN/);
    assert.match(await page.textContent('.presets') ?? '', /0\.05 SOL/);
    assert.ok(await fits(), 'the coin page fits a phone screen');

    await go(page, '#/create');
    assert.match(await view(), /every LP token is burned at graduation/);
    assert.match(await view(), /30% of curve fees, then 0\.05% of every pool trade/);
    assert.ok(await page.$('#view input'), 'the create form renders');
    assert.ok(await fits(), 'create fits a phone screen');

    await go(page, '#/me');
    assert.match(await view(), /Connect your wallet/);
    await page.click('#connect');
    await page.click('.wopt');
    await page.waitForFunction(() => document.querySelector('#view')?.textContent?.includes('Bonding curve'), null, { timeout: 15_000 });
    assert.match(await view(), /0\.0003 SOL/, 'the creator\'s unclaimed curve fees, in SOL');
    assert.doesNotMatch(await view(), /Holder rewards/);
    assert.ok(await fits(), 'My coins fits a phone screen');
    for (const old of ['#/earnings', '#/fees', '#/status', `#/rewards/${mint}/2026-10-05`]) {
      await page.evaluate((x) => { location.hash = x; }, old);
      await page.waitForFunction(() => location.hash === '#/me', null, { timeout: 5_000 });
    }
    for (const hash of ['#/', `#/t/${mint}`, '#/create', '#/me']) {
      await go(page, hash);
      assert.doesNotMatch(await page.textContent('body') ?? '', /Meteora|DAMM|qUSD/, `${hash} says nothing about Meteora`);
    }
    assert.deepEqual(requests.filter((u) => !u.startsWith(`${base}/`) && !u.startsWith('data:')), [], 'no requests leave the launchpad server');
    assert.deepEqual(failed, [], `no failed requests; server log: ${serverLog.join(' | ')}`);
    assert.deepEqual(errors, [], 'no console errors (including CSP violations)');
  } finally {
    await browser.close();
  }
});

test('launchpad UI: a page built for one network or engine refuses a server that runs another', { skip: !existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}` }, async () => {
  assert.ok(existsSync(join(dist, 'launchpad.html')), 'run `pnpm build:web` first');
  const h = await engineHarness({ staticDir: dist, log: () => {} });
  await putPlatform(h.chain);
  const base = `http://127.0.0.1:${(h.app.address() as { port: number }).port}`;
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage();
    const real = await (await fetch(`${base}/api/lp/platform`)).json() as { cluster: string; platform: { programs: { curve: string; pool: string }; poolFeeReceiver: string } };
    assert.equal(await page.goto(`${base}/`).then(() => page.getAttribute('body', 'data-cluster')), 'devnet', 'the default build is the devnet build');
    const lies: Array<[string, (p: typeof real) => void, RegExp]> = [
      ['another network', (p) => { p.cluster = 'mainnet-beta'; }, /server runs mainnet-beta, this page is for devnet/],
      ['another curve program', (p) => { p.platform.programs.curve = 'Stake11111111111111111111111111111111111111'; }, /other engine programs/],
      ['another pool fee account', (p) => { p.platform.poolFeeReceiver = 'Stake11111111111111111111111111111111111111'; }, /another pool fee account/],
    ];
    for (const [what, edit, says] of lies) {
      await page.unroute('**/api/lp/platform');
      await page.route('**/api/lp/platform', (r) => { const p = structuredClone(real); edit(p); return r.fulfill({ json: p }); });
      await page.goto(`${base}/`);
      await page.waitForFunction(() => document.querySelector('#view .err'), null, { timeout: 15_000 });
      const text = await page.textContent('#view') ?? '';
      assert.match(text, says, what);
      assert.match(text, /Nothing was sent/, what);
      assert.equal(await page.$('#wallet button'), null, `${what}: no wallet button`);
    }
  } finally {
    await browser.close();
  }
});
