// The integrated milestone slice in headless Chromium against the real API server (in-process, temp database, built
// bundle, CSP on): sign in, inspect a TEST_ONLY fixture mint, save a creator draft, reload the page and reopen the draft
// from the backend, edit it, then attempt a live mainnet read whose provider is blocked and see it reported as UNAVAILABLE.
// Live RPC is a fake fetch that answers like the egress allowlist; nothing leaves localhost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { createApp } from '../../api/src/server.ts';
import { Store } from '../../api/src/store.ts';
import { endpointFromUrl, type FetchLike } from '../../api/src/rpc.ts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const CHROMIUM = process.env.QF_CHROMIUM ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env.QF_SCREENSHOT_DIR;
const QUSD = 'EtriFwkv36LDftunesYPdxScW2KU5BK55pcm7qwBonXn';
const blocked: FetchLike = async () => new Response('Host not in allowlist', { status: 403 });

test('inspector: inspect, save a draft, reload it from the backend, edit it, and show a blocked live read', { skip: !existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}` }, async () => {
  assert.ok(existsSync(join(dist, 'index.html')), 'run `pnpm build:web` first');
  const dir = mkdtempSync(join(tmpdir(), 'qf-e2e-'));
  const store = new Store(join(dir, 'e2e.sqlite'));
  const { token, user } = store.createUser('e2e creator');
  const server = createApp({ store, staticDir: dist,
    inspect: { endpoints: { 'mainnet-beta': [endpointFromUrl('https://api.mainnet.solana.com', 'mainnet-beta')], devnet: [] }, fetchImpl: blocked, now: () => new Date() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-proxy-server'] });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const requests: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };

    // Sign in.
    await page.goto(`${base}/`);
    await page.waitForSelector('body[data-ready="true"]');
    assert.match(await page.textContent('#preview-banner') ?? '', /read-only.*No wallet, no signing/);
    await page.fill('#token', token);
    await page.click('#signin-form button[type=submit]');
    await page.waitForSelector('body[data-signed-in="true"]');
    assert.match(await page.textContent('#who') ?? '', /Signed in as e2e creator/);

    // 1. Enter a mint (picked from the TEST_ONLY fixture list) and inspect.
    await page.click('#fixtures-box summary');
    await page.click(`button[data-mint="${QUSD}"]`);
    assert.equal(await page.inputValue('#cluster'), 'test-only');
    await page.click('#inspect-btn');
    await page.waitForSelector('#report[data-id]');
    const report = page.locator('#report');
    assert.equal(await report.getAttribute('data-label'), 'TEST_ONLY_FIXTURE');
    assert.equal(await report.getAttribute('data-decision'), 'WARN');
    const reportText = await report.textContent() ?? '';
    assert.match(reportText, /TEST_ONLY fixture data: synthetic accounts/);
    assert.match(reportText, /fixture-a\.test-only.*getAccountInfo.*OK.*1000/s);
    assert.match(reportText, /Report digest[0-9a-f]{64}/);
    assert.equal(await page.locator('#report .stage').count(), 4);
    assert.match(await page.locator('#report table.features').textContent() ?? '', /top1_account_share_bps.*MEASURED.*4000 bps/s);
    assert.match(await page.locator('#report table.features').textContent() ?? '', /liq_usd.*UNAVAILABLE.*NO_POOL_INDEXER/s);
    assert.match(await page.locator('#report ul.missing').textContent() ?? '', /S3\.2 Quote-market liquidity: NO_POOL_SOURCE/);
    assert.doesNotMatch(await page.locator('#report ul.missing').textContent() ?? '', /S1\.7/, 'a not-applicable skip is not a missing input');
    const inspectionId = await report.getAttribute('data-id');
    await shot('1-test-only-inspection.png');

    // 2. Save a creator draft against it.
    await page.fill('#d-name', 'Creator Coin');
    await page.fill('#d-symbol', 'crtr');
    await page.fill('#d-desc', 'Paired with the inspected quote asset.');
    await page.click('#draft-save');
    await page.waitForSelector('#draft-card[data-version="1"]');
    const draftId = await page.locator('#draft-card').getAttribute('data-draft-id');
    assert.match(draftId ?? '', /^draft_[0-9a-f]{32}$/);
    assert.equal(store.listDrafts(user.id).length, 1, 'draft is in the database');
    assert.equal(store.listDrafts(user.id)[0]!.symbol, 'CRTR');

    // 3. Reload the page: the draft list comes from the backend; opening the draft reloads its linked inspection too.
    await page.reload();
    await page.waitForSelector('body[data-signed-in="true"]');
    assert.equal(await page.locator('#report').isHidden(), true);
    await page.click(`#drafts button[data-draft-id="${draftId}"]`);
    await page.waitForSelector(`#draft-card[data-draft-id="${draftId}"][data-version="1"]`);
    assert.equal(await page.inputValue('#d-name'), 'Creator Coin');
    assert.equal(await page.inputValue('#d-symbol'), 'CRTR');
    assert.equal(await page.locator('#report').getAttribute('data-id'), inspectionId);
    assert.match(await page.textContent('#draft-bind') ?? '', /Policies at saveSTANDARD_V1@0-v0test .*validator-v0\.1/);
    assert.match(await page.textContent('#draft-bind') ?? '', /Policy statuscurrent/);
    await shot('2-draft-reloaded.png');

    // Edit and save: optimistic version 2.
    await page.fill('#d-name', 'Creator Coin Two');
    await page.click('#draft-save');
    await page.waitForSelector('#draft-card[data-version="2"]');
    assert.equal(store.draftHistoryCount(draftId!), 2);

    // 4. A live mainnet read through a blocked provider: UNAVAILABLE with the reason, aggregate FAIL, no fixture fallback.
    await page.fill('#mint', QUSD);
    await page.selectOption('#cluster', 'mainnet-beta');
    await page.click('#inspect-btn');
    await page.waitForSelector('#report[data-label="LIVE_READ"]');
    assert.equal(await page.locator('#report').getAttribute('data-decision'), 'FAIL');
    const live = await page.locator('#report').textContent() ?? '';
    assert.match(live, /api\.mainnet\.solana\.com.*getAccountInfo.*UNAVAILABLE.*NETWORK_POLICY_DENIED \(HTTP 403 Host not in allowlist\)/s);
    assert.doesNotMatch(live, /fixture-a\.test-only/);
    assert.match(live, /IN\.1.*FAIL.*NO_USABLE_EVIDENCE/s);
    assert.match(live, /Checks \(3 evaluated, 23 skipped of 26\)/);
    assert.equal(await page.textContent('#draft-msg'), '', 'no stale save message after a new inspection');
    await shot('3-live-read-blocked.png');

    assert.deepEqual(requests.filter((u) => !u.startsWith(`${base}/`)), [], 'the browser talks only to the same-origin server');
    assert.ok(!requests.some((u) => /solana\.com/.test(u)), 'the browser never calls an RPC itself');
    assert.deepEqual(errors, [], 'no console errors (including CSP violations)');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
