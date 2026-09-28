// MOCK lifecycle UI (offline V0). Uses the real browser-safe QF packages over synthetic fixtures.
// It never imports the Meteora adapter or @solana/web3.js v1, never opens a wallet and never calls an RPC.
import { MOCK_BANNER, READINESS, STAGES, labelMock } from '@project-qf/core';
import { checkQuoteMarketLiquidity, checkExitDepth, aggregate, VALIDATOR_POLICY_V0_1, EVIDENCE_POLICY_V0_1, resolvePrice } from '@project-qf/validator';
import { ECONOMICS_V0_TEST, STANDARD_V1_FLAT_V0_TEST, MIGRATION_POLICY_V0, proposeMigrationThreshold, economicsDigest } from '@project-qf/policy';
import { validateIntent } from '@project-qf/tx';
import { NOW, QUSD, prices, pools, routes, exitMints } from './fixtures.ts';

type Row = [string, string];
const list = document.getElementById('lifecycle')!;
document.getElementById('mock-banner')!.textContent = MOCK_BANNER;

function card(title: string, decision: string, rows: Row[]) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.mock = 'true';
  const h = document.createElement('h2');
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'MOCK';
  const d = document.createElement('span'); d.className = `d-${decision}`; d.textContent = decision;
  h.append(title, badge, d);
  const dl = document.createElement('dl');
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
  li.append(h, dl);
  list.append(li);
  return li;
}

const ctx = { quoteMint: QUSD.mint, now: NOW, mode: 'TEST_ONLY' as const, policy: VALIDATOR_POLICY_V0_1, evidencePolicy: EVIDENCE_POLICY_V0_1 };
const s32 = checkQuoteMarketLiquidity({ ...ctx, excludeMints: [], pools, prices });
card('1. Quote asset market liquidity (S3.2)', s32.decision, [['asset', QUSD.symbol], ['eligible USD', s32.details.eligibleUsd ?? ''],
  ['unique pools', s32.details.uniquePools ?? ''], ['corroborated', s32.details.corroboratedPools ?? ''], ['reason', s32.reason]]);

const s31 = checkExitDepth({ ...ctx, notionalRaw: 5_000_000_000n, exitMints, routes });
card('2. Exit depth at threshold notional (S3.1)', s31.decision, [['notional (raw)', s31.details.notionalRaw ?? ''], ['reason', s31.reason]]);
card('3. Validator aggregate', aggregate([s32, s31], 'TEST_ONLY').decision, [['note', 'TEST_ONLY validation is never PASS']]);

const price = resolvePrice(QUSD.mint, prices, ctx);
const proposal = proposeMigrationThreshold({ policy: MIGRATION_POLICY_V0, evidencePolicy: EVIDENCE_POLICY_V0_1, now: NOW,
  quote: { mint: QUSD.mint, decimals: QUSD.decimals },
  price: { status: price.status === 'INSUFFICIENT' ? 'INSUFFICIENT' : 'OK', priceUsd: '1.00', sources: price.sources, observedAt: '2026-09-27T11:59:30.000Z', slot: 'MOCK' },
  liquidity: s32, exitDepth: s31 });
const rec = proposal.record;
card('4. Migration quote threshold (Decision 3)', proposal.status === 'REJECTED' ? 'FAIL' : proposal.status === 'OK' ? 'PASS' : 'WARN', [
  ['requested USD', rec?.requestedUsd ?? '-'], ['V0 ceiling (not default)', MIGRATION_POLICY_V0.ceilUsd],
  ['raw threshold', rec?.rawQuoteThreshold ?? '-'], ['decimals / rounding', rec ? `${rec.quoteDecimals} / ${rec.rounding}` : '-'],
  ['price, time, slot', rec ? `${rec.priceUsd} @ ${rec.priceObservedAt}, slot ${rec.priceSlot}` : '-'], ['status', `${proposal.status} ${proposal.reasons.join('; ')}`]]);

const digest = economicsDigest({ economics: ECONOMICS_V0_TEST, template: STANDARD_V1_FLAT_V0_TEST, threshold: rec ?? null });
card('5. Economics preview and consent', 'PASS', [['economics', ECONOMICS_V0_TEST.version], ['template', `${STANDARD_V1_FLAT_V0_TEST.version} (flat fee)`],
  ['consent digest', digest]]);

const intent = { intentId: 'MOCK-create-pool', kind: 'CREATE_POOL' as const, mock: true, signer: { role: 'USER_WALLET' as const,
  address: 'Vote111111111111111111111111111111111111111', serverHeld: false }, feePayer: 'Vote111111111111111111111111111111111111111',
  templateUsage: 'V0_TEST_BASELINE' as const, economicsDigest: digest, consentDigest: digest, createdAt: '2026-09-27T11:59:50.000Z', expiresAt: '2026-09-27T12:05:00.000Z' };
const mockRun = validateIntent({ ...intent, cluster: 'mock-offline' }, { now: NOW, approvedEconomicsDigest: digest });
const devnetRun = validateIntent({ ...intent, cluster: 'devnet', mock: false }, { now: NOW, approvedEconomicsDigest: digest });
card('6. Transaction intent (no bytes built, nothing submitted)', mockRun.ok ? 'PASS' : 'FAIL', [
  ['mock-offline', mockRun.ok ? 'valid MOCK intent' : mockRun.violations.join('; ')], ['devnet', devnetRun.violations.join('; ')]]);

const progress = labelMock({ quoteReserveRaw: '3100000000', thresholdRaw: rec?.rawQuoteThreshold ?? '0' }, 'synthetic curve progress');
card('7. Curve progress', 'WARN', [['quote reserve (raw)', progress.quoteReserveRaw], ['threshold (raw)', progress.thresholdRaw], ['label', progress.__mock.note]]);
card('8. Migration to DAMM v2 and fee claims', 'BLOCKED', [['status', 'not executed: LOCALNET and DEVNET stages are BLOCKED'],
  ...STAGES.map((s): Row => [s, `${READINESS[s].status}${READINESS[s].blockers.length ? ': ' + READINESS[s].blockers[0] : ''}`])]);

const rewards = card('9. Reward epoch (computed in a Web Worker)', 'WARN', [['status', 'computing']]);
const worker = new Worker(new URL('./merkle.worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent<{ rootHex: string; fileHash: string; payouts: [string, string][]; poolRollForwardRaw: string }>) => {
  const dl = rewards.querySelector('dl')!;
  dl.replaceChildren();
  const rows: Row[] = [['merkle root', e.data.rootHex], ['allocation file hash', e.data.fileHash], ['pool roll-forward (raw)', e.data.poolRollForwardRaw],
    ...e.data.payouts.map(([o, a]): Row => [o.slice(0, 8) + '...', a])];
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
  rewards.dataset.root = e.data.rootHex;
  document.body.dataset.ready = 'true';
};
worker.postMessage({ fundedRaw: '1000000' });
