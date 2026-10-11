// Shared by the end-to-end runs of the launchpad on Project QF's own engine (engine-localnet.ts, engine-devnet.ts): the
// app server runs in the calling process, and this module plays the browser and the wallets. Every transaction is built
// by the server, checked by the browser's own check (apps/web txcheck.ts), signed with a key generated for the run, and
// relayed by the server. Each run writes an evidence file: every step's signature and every check, PASS or FAIL.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { KeyPairSigner } from '@solana/kit';
import * as E from '@project-qf/engine';
import { addSignature, fromBase64, toBase64, type ApprovedTerms } from '@project-qf/tx';
import { checkBuiltTransaction, type Expectation } from '../../web/src/launchpad/txcheck.ts';
import { engineBooks, engineBooksText, type EngineBooks } from '../src/engine/books.ts';
import type { EngineChain } from '../src/engine/chain.ts';
import { indexPass } from '../src/engine/indexer.ts';
import { SOL_QUOTE } from '../src/engine/market.ts';
import { createEngineApp } from '../src/engine/server.ts';
import { EngineStore } from '../src/engine/store.ts';

export const s = (v: unknown) => (typeof v === 'bigint' ? v.toString() : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const SOL = (lamports: bigint) => `${Number(lamports) / 1e9} SOL`;
interface Built { intentId: string; transaction: string; terms: ApprovedTerms }

export async function e2e(o: { chain: EngineChain; cluster: 'devnet' | 'localnet'; faucet: boolean }) {
  const evidence: { steps: { step: string; signature: string }[]; checks: { check: string; expected: string; actual: string; ok: boolean }[]; [k: string]: unknown } = { steps: [], checks: [] };
  function check(name: string, expected: unknown, actual: unknown) {
    const ok = s(expected) === s(actual);
    evidence.checks.push({ check: name, expected: s(expected), actual: s(actual), ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  expected ${s(expected)} got ${s(actual)}`}`);
    return ok;
  }

  // ---------------------------------------------------------------- the app, on a fresh store for this run
  const { chain, cluster } = o;
  const store = new EngineStore(join(mkdtempSync(join(tmpdir(), `qf-engine-${cluster}-`)), 'engine.sqlite'));
  store.bind('cluster', cluster); store.bind('genesis', await chain.genesisHash()); store.bind('quote', SOL_QUOTE.mint);
  const app = createEngineApp({ store, chain, quote: SOL_QUOTE, profile: { cluster, writes: true, faucet: o.faucet, label: `TEST_ONLY ${cluster}`, writesLockedBecause: [] },
    staticDir: null, publicBaseUrl: 'http://127.0.0.1:8788', log: (m) => console.log(`      [app] ${m}`) });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const d = { store, chain, log: (m: string) => console.log(`      [indexer] ${m}`) };

  // ---------------------------------------------------------------- the browser: build, check, sign, submit
  async function flow(step: string, who: KeyPairSigner, path: string, body: unknown, expect: (b: Built) => Omit<Expectation, 'wallet' | 'shown' | 'cluster'>, extra: KeyPairSigner[] = []) {
    const b = await call(path, body);
    if (b.status !== 201) throw new Error(`${step}: build refused ${s(b.body)}`);
    const bytes = fromBase64(b.body.transaction);
    const r = await checkBuiltTransaction(bytes, b.body.terms, { ...expect(b.body), wallet: who.address, shown: { step }, cluster });
    check(`${step}: the browser's check passes (${r.checks.length} lines)`, [], r.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail ?? ''}`));
    let signed: Uint8Array = bytes;
    for (const k of [...extra, who]) signed = await addSignature(signed, k.address, k.keyPair.privateKey);
    const sub = await call('/api/lp/submit', { intentId: b.body.intentId, signedTransaction: toBase64(signed) });
    if (sub.status !== 200) throw new Error(`${step}: submit refused ${s(sub.body)}`);
    evidence.steps.push({ step, signature: sub.body.signature });
    console.log(`      ${step.padEnd(48)} ${sub.body.signature}`);
    return { built: b.body, signed, result: sub.body };
  }
  const coinBalance = async (owner: string, mint: string) => BigInt((await chain.balances(owner, [mint])).tokens[mint] ?? '0');
  const wsolLeft = async (owner: string) => (await chain.read([await E.ata(owner, E.NATIVE_MINT, E.TOKEN)]))[0];

  /** One trade through the app: quote, build, check, sign, submit; then what the wallet got must equal the quote. */
  async function trade(mint: string, who: KeyPairSigner, label: string, side: 'buy' | 'sell', amountIn: bigint, venue: 'CURVE' | 'POOL') {
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

  /** Indexes until every listed transaction is read, then the books (`verify`) must be all PASS (`want` checks in total,
   *  when the run knows how many coins the store holds). */
  async function booksNow(label: string, want?: number): Promise<EngineBooks> {
    for (let k = 0; k < 20; k++) {
      await indexPass(d);
      if (store.listCoins(['LIVE', 'GRADUATED']).every((c) => store.unread(c.mint).pending + store.unread(c.mint).unavailable === 0)) break;
      await sleep(cluster === 'devnet' ? 2_000 : 500);
    }
    const b = await engineBooks(store, chain, SOL_QUOTE, cluster);
    console.log(engineBooksText(b).split('\n').map((x) => `      ${x}`).join('\n'));
    check(`verify ${label}: every books check passes`, { pass: want ?? b.checks.length, fail: 0, wait: 0 }, b.summary);
    return b;
  }

  /** The creator's two claims through the app, each paying exactly what was unclaimed (`venues` says which apply). */
  async function creatorClaims(mint: string, creator: KeyPairSigner, other: KeyPairSigner, venues: ('curve' | 'pool')[]) {
    const fees = (await call(`/api/lp/fees/${mint}?wallet=${creator.address}&fresh=1`)).body;
    check('only the creator can claim', 'NOT_CREATOR', (await call('/api/lp/claim', { mint, user: other.address, venue: 'curve' })).body?.error?.code);
    if (venues.includes('curve')) {
      check('the creator has curve fees to claim', true, BigInt(fees.curve.quoteRaw) > 0n);
      const cc = await flow('creator claims curve fees', creator, '/api/lp/claim', { mint, user: creator.address, venue: 'curve' }, () => ({ kind: 'QF_CLAIM_CREATOR_FEES',
        fields: { creator: creator.address, baseMint: mint, quoteMint: E.NATIVE_MINT } }));
      const ccTx = await chain.tx(cc.result.signature);
      check('curve claim: the event pays the creator exactly what was unclaimed', fees.curve.quoteRaw, (ccTx?.events.find((e) => e.name === 'FeesClaimed') as E.FeesClaimedEvent | undefined)?.amount.toString());
    }
    if (venues.includes('pool')) {
      check('the creator has a pool fee to collect', true, BigInt(fees.poolCreatorFee.quoteRaw) > 0n);
      await flow('creator collects the pool creator fee', creator, '/api/lp/claim', { mint, user: creator.address, venue: 'pool' }, () => ({ kind: 'QF_COLLECT_POOL_CREATOR_FEE',
        fields: { creator: creator.address, baseMint: mint, quoteMint: E.NATIVE_MINT } }));
    }
    const left = (await call(`/api/lp/fees/${mint}?wallet=${creator.address}&fresh=1`)).body;
    check('after the claims the creator has nothing left to claim', venues.map(() => '0'), venues.map((v) => (v === 'curve' ? left.curve.quoteRaw : left.poolCreatorFee.quoteRaw)));
    check('creator: no wrapped SOL left behind', null, await wsolLeft(creator.address));
  }

  /** The platform's share: anyone may send the claim; it is paid only to the fee recipient's own SOL account. */
  async function platformClaim(mint: string, feeRecipient: string) {
    evidence.steps.push({ step: 'platform fees claimed to the fee recipient (permissionless)', signature: await chain.sendAsOperator([
      await E.createAtaIdempotentIx(chain.operatorAddress!, feeRecipient, E.NATIVE_MINT), await E.claimPlatformFeesIx({ mint, to: await E.ata(feeRecipient, E.NATIVE_MINT, E.TOKEN) })], 100_000) });
  }

  function finish(out: string, extra: Record<string, unknown>) {
    const summary = { pass: evidence.checks.filter((c) => c.ok).length, fail: evidence.checks.filter((c) => !c.ok).length };
    Object.assign(evidence, extra, { summary });
    writeFileSync(out, s(evidence) + '\n');
    console.log(`\n${summary.pass} PASS, ${summary.fail} FAIL  -> ${out}`);
    app.close(); app.closeAllConnections(); store.close();
    process.exitCode = summary.fail ? 1 : 0;
  }

  return { evidence, check, store, call, d, flow, trade, coinBalance, wsolLeft, booksNow, creatorClaims, platformClaim, finish };
}
