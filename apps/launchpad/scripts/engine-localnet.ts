// The whole launchpad on Project QF's own engine, against the real engine programs on a local validator: the app server
// (engine/server.ts, its indexer and crank) runs in this process, and this script plays the browser and the wallets.
// Every transaction is built by the server, checked by the browser's own check (apps/web txcheck.ts), signed with a
// key generated for the run, and relayed by the server. A coin goes through its whole life: launch, buys and a sell on
// the curve, a buy that completes it, graduation by the crank, a buy and a sell in its pool, both creator claims and
// the platform's claim. Then the books (`verify`) must be all PASS.
//
//   QF_ENGINE_DIR=<engine source> QF_LOCALNET_THEN=apps/launchpad/scripts/engine-localnet.ts \
//     sh packages/engine/scripts/localnet.sh [evidence.json]
//
// Localnet only: the RPC is 127.0.0.1 and every key is generated for the run (the authority and treasury files that
// localnet.sh made live outside the repo). Nothing here can reach devnet or mainnet.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { address, createKeyPairSignerFromBytes, createSolanaRpc, generateKeyPairSigner, lamports, type KeyPairSigner } from '@solana/kit';
import { CAPABILITY_FLAGS } from '@project-qf/core';
import * as E from '@project-qf/engine';
import { economicsDigest } from '@project-qf/policy';
import { addSignature, fromBase64, toBase64, type ApprovedTerms } from '@project-qf/tx';
import { checkBuiltTransaction, type Expectation } from '../../web/src/launchpad/txcheck.ts';
import { engineBooks, engineBooksText } from '../src/engine/books.ts';
import { kitChain, proveCluster } from '../src/engine/chain.ts';
import { indexPass } from '../src/engine/indexer.ts';
import { SOL_QUOTE } from '../src/engine/market.ts';
import { createEngineApp, ENGINE_FAUCET } from '../src/engine/server.ts';
import { EngineStore } from '../src/engine/store.ts';

const RPC = 'http://127.0.0.1:8899';
const [out, authorityFile, treasury] = process.argv.slice(2) as [string, string, string];
const rpc = createSolanaRpc(RPC);
const evidence: { steps: { step: string; signature: string }[]; checks: { check: string; expected: string; actual: string; ok: boolean }[]; [k: string]: unknown } = { steps: [], checks: [] };
const s = (v: unknown) => (typeof v === 'bigint' ? v.toString() : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
function check(name: string, expected: unknown, actual: unknown) {
  const ok = s(expected) === s(actual);
  evidence.checks.push({ check: name, expected: s(expected), actual: s(actual), ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  expected ${s(expected)} got ${s(actual)}`}`);
  return ok;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function airdrop(to: string, sol: number) {
  const sig = await rpc.requestAirdrop(address(to), lamports(BigInt(sol) * 1_000_000_000n)).send();
  for (let k = 0; k < 120; k++) { const { value: [st] } = await rpc.getSignatureStatuses([sig]).send(); if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return; await sleep(250); }
  throw new Error('airdrop not confirmed');
}

// ---------------------------------------------------------------- the network, the engine's settings, the app
const authority = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(authorityFile, 'utf8'))));
const [operator, creator, alice, bob, mintKey, newcomer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(),
  generateKeyPairSigner(), generateKeyPairSigner()]);
const chain = kitChain(RPC, operator, (m) => console.log(`      [app] ${m}`));
const cluster = await proveCluster(RPC, 'localnet', chain.genesisHash, CAPABILITY_FLAGS.MAINNET_WRITES as boolean);
check('the app proves it is on a local validator (not devnet, not mainnet)', 'localnet', cluster);
for (const [k, sol] of [[authority.address, 20], [operator.address, 5], [creator.address, 2], [alice.address, 5], [bob.address, 5]] as const) await airdrop(k, sol);
const ammConfig = await E.ammConfigAddress(0);
// the engine's settings are set by its admin (the curve's upgrade authority), not by the app
evidence.steps.push({ step: 'initialize (the engine admin sets SOL settings)', signature: await kitChain(RPC, authority).sendAsOperator([await E.initializeIx({ authority: authority.address, ammConfig,
  settings: { admin: authority.address, feeRecipient: treasury, createPaused: false, config: E.LAUNCH_PRESETS.devnetSmall } })], 100_000) });
const store = new EngineStore(join(mkdtempSync(join(tmpdir(), 'qf-engine-localnet-')), 'engine.sqlite'));
store.bind('cluster', 'localnet'); store.bind('genesis', await chain.genesisHash()); store.bind('quote', SOL_QUOTE.mint);
const app = createEngineApp({ store, chain, quote: SOL_QUOTE, profile: { cluster: 'localnet', writes: true, faucet: true, label: 'TEST_ONLY localnet', writesLockedBecause: [] },
  staticDir: null, publicBaseUrl: 'http://127.0.0.1:8788', log: (m) => console.log(`      [app] ${m}`) });
await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
const call = async (path: string, body?: unknown) => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const d = { store, chain, log: (m: string) => console.log(`      [indexer] ${m}`) };

// ---------------------------------------------------------------- the browser: build, check, sign, submit
interface Built { intentId: string; transaction: string; terms: ApprovedTerms }
async function flow(step: string, who: KeyPairSigner, path: string, body: unknown, expect: (b: Built) => Omit<Expectation, 'wallet' | 'shown' | 'cluster'>, extra: KeyPairSigner[] = []) {
  const b = await call(path, body);
  if (b.status !== 201) throw new Error(`${step}: build refused ${s(b.body)}`);
  const bytes = fromBase64(b.body.transaction);
  const r = await checkBuiltTransaction(bytes, b.body.terms, { ...expect(b.body), wallet: who.address, shown: { step }, cluster: 'localnet' });
  check(`${step}: the browser's check passes (${r.checks.length} lines)`, [], r.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail ?? ''}`));
  let signed: Uint8Array = bytes;
  for (const k of [...extra, who]) signed = await addSignature(signed, k.address, k.keyPair.privateKey);
  const sub = await call('/api/lp/submit', { intentId: b.body.intentId, signedTransaction: toBase64(signed) });
  if (sub.status !== 200) throw new Error(`${step}: submit refused ${s(sub.body)}`);
  evidence.steps.push({ step, signature: sub.body.signature });
  console.log(`      ${step.padEnd(44)} ${sub.body.signature}`);
  return { built: b.body, signed, result: sub.body };
}
const coinBalance = async (owner: string, mint: string) => BigInt((await chain.balances(owner, [mint])).tokens[mint] ?? '0');
const wsolLeft = async (owner: string) => (await chain.read([await E.ata(owner, E.NATIVE_MINT, E.TOKEN)]))[0];

// ---------------------------------------------------------------- 1. the platform
const pl = (await call('/api/lp/platform?fresh=1')).body;
check('platform: engine qf on localnet, ready, quoted in SOL', ['qf', 'localnet', true, 'SOL'], [pl.engine, pl.cluster, pl.ready, pl.platform?.quote.symbol]);
check('platform: the economics digest recomputes in the browser', pl.platform.launchEconomicsDigest, economicsDigest(pl.platform.launchEconomics));
check('platform: fees go to the engine\'s fee recipient', treasury, pl.platform.feeRecipient);

// ---------------------------------------------------------------- 2. launch
const mint = mintKey.address;
const launchBody = { creator: creator.address, baseMint: mint, name: 'App Localnet Dog', symbol: 'ALDOG', description: 'TEST_ONLY localnet coin', economicsDigest: pl.platform.launchEconomicsDigest };
const launch = await flow('launch $ALDOG', creator, '/api/lp/launch', launchBody, (b) => ({ kind: 'QF_CREATE',
  fields: { name: launchBody.name, symbol: launchBody.symbol, uri: (b.terms as { uri: string }).uri, creator: creator.address, baseMint: mint, quoteMint: E.NATIVE_MINT, ammConfig: pl.platform.ammConfig } }), [mintKey]);
check('launch: the coin is live in the app', 'LIVE', store.getCoin(mint)?.status);
const again = await call('/api/lp/submit', { intentId: launch.built.intentId, signedTransaction: toBase64(launch.signed) });
check('launch: the same signed transaction is not relayed twice', 'ALREADY_SUBMITTED', again.body?.error?.code);
const [mintAcc] = await chain.read([mint]);
check('launch: Token-2022 coin, full supply, no mint or freeze authority', [E.TOKEN_2022, E.LAUNCH_PRESETS.devnetSmall.totalSupply, null, null],
  (({ program, supply, mintAuthority, freezeAuthority }) => [program, supply, mintAuthority, freezeAuthority])(E.decodeMint(mintAcc!)));

// ---------------------------------------------------------------- 3. curve trades
async function trade(who: KeyPairSigner, label: string, side: 'buy' | 'sell', amountIn: bigint, venue: 'CURVE' | 'POOL') {
  const q = await call('/api/lp/quote', { mint, side, amountIn: amountIn.toString(), slippageBps: 100 });
  if (q.status !== 200) throw new Error(`${label}: quote refused ${s(q.body)}`);
  check(`${label}: quoted on the ${venue === 'CURVE' ? 'curve' : 'pool'}`, venue, q.body.venue);
  const before = await coinBalance(who.address, mint);
  const r = await flow(label, who, '/api/lp/swap', { mint, user: who.address, side, amountIn: amountIn.toString(), slippageBps: 100 }, () => ({
    kind: venue === 'POOL' ? 'QF_POOL_SWAP' : 'QF_SWAP', minimumAmountOutAtLeast: q.body.quote.minimumAmountOut,
    fields: { user: who.address, baseMint: mint, quoteMint: E.NATIVE_MINT, direction: side === 'buy' ? 'QUOTE_TO_BASE' : 'BASE_TO_QUOTE', amountIn: amountIn.toString() } }));
  const after = await coinBalance(who.address, mint);
  if (side === 'buy') check(`${label}: received exactly the quoted coins`, q.body.quote.expectedOut, (after - before).toString());
  else check(`${label}: received exactly the quoted SOL (trade event)`, q.body.quote.expectedOut, r.result.trade?.quoteRaw);
  check(`${label}: the app recorded the trade from its event`, [side.toUpperCase(), venue], [r.result.trade?.side, r.result.trade?.venue]);
  check(`${label}: no wrapped SOL left behind (paid and paid back in plain SOL)`, null, await wsolLeft(who.address));
  return q.body.quote;
}
await trade(alice, 'alice buys 0.05 SOL on the curve', 'buy', 50_000_000n, 'CURVE');
await trade(alice, 'alice sells a third on the curve', 'sell', (await coinBalance(alice.address, mint)) / 3n, 'CURVE');
const last = await trade(bob, 'bob buys out the curve (offers 2 SOL)', 'buy', 2_000_000_000n, 'CURVE');
check('the last buy completes the curve and pays only for what was left', true, last.completesCurve && BigInt(last.amountIn) < 2_000_000_000n);
check('a quote on a full curve is refused as input, not a fault', 'CURVE_COMPLETE', (await call('/api/lp/quote', { mint, side: 'buy', amountIn: '1000' })).body?.error?.code);

// ---------------------------------------------------------------- 4. graduation by the crank, then the pool
await indexPass(d);
const coin = store.getCoin(mint)!;
check('the crank graduated the coin and the app follows it', 'GRADUATED', coin.status);
if (coin.graduateSig) evidence.steps.push({ step: 'graduate (operator crank)', signature: coin.graduateSig });
const pool = await E.launchPoolAddress(mint);
check('the coin trades in its own pool', pool, coin.pool);
const tv = (await call(`/api/lp/tokens/${mint}?fresh=1`)).body.token;
check('token view: pool venue, 100% of liquidity locked (LP mint supply 0)', ['GRADUATED', 'POOL', 10_000], [tv.status, tv.live.venue, tv.live.lockedBps]);
for (let k = 0; (await call('/api/lp/quote', { mint, side: 'buy', amountIn: '1000' })).body?.error?.code === 'POOL_NOT_OPEN'; k++) { if (k > 40) throw new Error('pool did not open'); await sleep(250); }
await trade(alice, 'alice buys 0.02 SOL in the pool', 'buy', 20_000_000n, 'POOL');
await trade(alice, 'alice sells half her coins in the pool', 'sell', (await coinBalance(alice.address, mint)) / 2n, 'POOL');

// the books mid-life, while every fee is still unclaimed: each one must add up to the raw unit
async function booksNow(label: string) {
  for (let k = 0; k < 6; k++) { await indexPass(d); if (store.unread(mint).pending === 0) break; await sleep(500); }
  const b = await engineBooks(store, chain, SOL_QUOTE, 'localnet');
  console.log(engineBooksText(b).split('\n').map((x) => `      ${x}`).join('\n'));
  check(`verify ${label}: every books check passes`, { pass: 6, fail: 0, wait: 0 }, b.summary);
  return b;
}
const midBooks = await booksNow('before any claim');

// ---------------------------------------------------------------- 5. claims
const fees = (await call(`/api/lp/fees/${mint}?wallet=${creator.address}&fresh=1`)).body;
check('the creator has curve fees and a pool fee to claim', [true, true], [BigInt(fees.curve.quoteRaw) > 0n, BigInt(fees.poolCreatorFee.quoteRaw) > 0n]);
check('only the creator can claim', 'NOT_CREATOR', (await call('/api/lp/claim', { mint, user: alice.address, venue: 'curve' })).body?.error?.code);
const cc = await flow('creator claims curve fees', creator, '/api/lp/claim', { mint, user: creator.address, venue: 'curve' }, () => ({ kind: 'QF_CLAIM_CREATOR_FEES',
  fields: { creator: creator.address, baseMint: mint, quoteMint: E.NATIVE_MINT } }));
const ccTx = await chain.tx(cc.result.signature);
check('curve claim: the event pays the creator exactly what was unclaimed', fees.curve.quoteRaw, (ccTx?.events.find((e) => e.name === 'FeesClaimed') as E.FeesClaimedEvent | undefined)?.amount.toString());
await flow('creator collects the pool creator fee', creator, '/api/lp/claim', { mint, user: creator.address, venue: 'pool' }, () => ({ kind: 'QF_COLLECT_POOL_CREATOR_FEE',
  fields: { creator: creator.address, baseMint: mint, quoteMint: E.NATIVE_MINT } }));
check('after both claims the creator has nothing left to claim', ['0', '0'], await call(`/api/lp/fees/${mint}?wallet=${creator.address}&fresh=1`).then((r) => [r.body.curve.quoteRaw, r.body.poolCreatorFee.quoteRaw]));
check('creator: no wrapped SOL left behind', null, await wsolLeft(creator.address));
// the platform's share is claimable by anyone, paid only to the fee recipient's own account
const treasuryQuote = await E.ata(treasury, E.NATIVE_MINT, E.TOKEN);
evidence.steps.push({ step: 'platform fees claimed to the fee recipient (permissionless)', signature: await chain.sendAsOperator([
  await E.createAtaIdempotentIx(operator.address, treasury, E.NATIVE_MINT), await E.claimPlatformFeesIx({ mint, to: treasuryQuote })], 100_000) });

// ---------------------------------------------------------------- 6. the faucet, then the books
const fr = await call('/api/lp/faucet', { wallet: newcomer.address });
check('faucet: a new wallet gets test SOL from the operator', [200, ENGINE_FAUCET.lamports.toString()], [fr.status, (await chain.lamports(newcomer.address)).toString()]);
const books = await booksNow('after every claim');
const st = (await call(`/api/lp/tokens/${mint}`)).body.token.stats;
check('stats: five trades from two traders', [5, 2], [st.count, st.traders]);

const summary = { pass: evidence.checks.filter((c) => c.ok).length, fail: evidence.checks.filter((c) => !c.ok).length };
Object.assign(evidence, { booksBeforeClaims: midBooks, booksAfterClaims: books, summary });
writeFileSync(out, s(evidence) + '\n');
console.log(`\n${summary.pass} PASS, ${summary.fail} FAIL  -> ${out}`);
app.close(); app.closeAllConnections(); store.close();
process.exitCode = summary.fail ? 1 : 0;
