// The whole launchpad on Project QF's own engine, against the real engine programs on a local validator: the app server
// (src/server.ts, its indexer and crank) runs in this process, and engine-e2e.ts plays the browser and the wallets.
// A coin goes through its whole life: launch, a buy and a sell on the curve, a buy that completes it, graduation by the
// crank, a buy and a sell in its pool, both creator claims and the platform's claim. The books (`verify`) must be all
// PASS while every fee is still unclaimed, and again after the claims.
//
//   QF_ENGINE_DIR=<engine source> QF_LOCALNET_THEN=apps/launchpad/scripts/engine-localnet.ts \
//     sh packages/engine/scripts/localnet.sh [evidence.json]
//
// Localnet only: the RPC is 127.0.0.1 and every key is generated for the run (the authority and treasury files that
// localnet.sh made live outside the repo). Nothing here can reach devnet or mainnet.
import { readFileSync } from 'node:fs';
import { address, createKeyPairSignerFromBytes, createSolanaRpc, generateKeyPairSigner, lamports } from '@solana/kit';
import { CAPABILITY_FLAGS } from '@project-qf/core';
import * as E from '@project-qf/engine';
import { economicsDigest } from '@project-qf/policy';
import { toBase64 } from '@project-qf/tx';
import { kitChain, proveCluster } from '../src/chain.ts';
import { indexPass } from '../src/indexer.ts';
import { ENGINE_FAUCET } from '../src/server.ts';
import { e2e, sleep } from './engine-e2e.ts';

const RPC = 'http://127.0.0.1:8899';
const [out, authorityFile, treasury] = process.argv.slice(2) as [string, string, string];
const rpc = createSolanaRpc(RPC);
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
for (const [k, sol] of [[authority.address, 20], [operator.address, 5], [creator.address, 2], [alice.address, 5], [bob.address, 5]] as const) await airdrop(k, sol);
const ammConfig = await E.ammConfigAddress(0);
// the engine's settings are set by its admin (the curve's upgrade authority), not by the app
const initSig = await kitChain(RPC, authority).sendAsOperator([await E.initializeIx({ authority: authority.address, ammConfig,
  settings: { admin: authority.address, feeRecipient: treasury, createPaused: false, config: E.LAUNCH_PRESETS.devnetSmall } })], 100_000);
const t = await e2e({ chain, cluster, faucet: true });
const { check, call, store, flow, trade, coinBalance } = t;
check('the app proves it is on a local validator (not devnet, not mainnet)', 'localnet', cluster);
t.evidence.steps.push({ step: 'initialize (the engine admin sets SOL settings)', signature: initSig });

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
await trade(mint, alice, 'alice buys 0.05 SOL on the curve', 'buy', 50_000_000n, 'CURVE');
await trade(mint, alice, 'alice sells a third on the curve', 'sell', (await coinBalance(alice.address, mint)) / 3n, 'CURVE');
const last = await trade(mint, bob, 'bob buys out the curve (offers 2 SOL)', 'buy', 2_000_000_000n, 'CURVE');
check('the last buy completes the curve and pays only for what was left', true, last.completesCurve && BigInt(last.amountIn) < 2_000_000_000n);
check('a quote on a full curve is refused as input, not a fault', 'CURVE_COMPLETE', (await call('/api/lp/quote', { mint, side: 'buy', amountIn: '1000' })).body?.error?.code);

// ---------------------------------------------------------------- 4. graduation by the crank, then the pool
await indexPass(t.d);
const coin = store.getCoin(mint)!;
check('the crank graduated the coin and the app follows it', 'GRADUATED', coin.status);
if (coin.graduateSig) t.evidence.steps.push({ step: 'graduate (operator crank)', signature: coin.graduateSig });
check('the coin trades in its own pool', await E.launchPoolAddress(mint), coin.pool);
const tv = (await call(`/api/lp/tokens/${mint}?fresh=1`)).body.token;
check('token view: pool venue, 100% of liquidity locked (LP mint supply 0)', ['GRADUATED', 'POOL', 10_000], [tv.status, tv.live.venue, tv.live.lockedBps]);
for (let k = 0; (await call('/api/lp/quote', { mint, side: 'buy', amountIn: '1000' })).body?.error?.code === 'POOL_NOT_OPEN'; k++) { if (k > 40) throw new Error('pool did not open'); await sleep(250); }
await trade(mint, alice, 'alice buys 0.02 SOL in the pool', 'buy', 20_000_000n, 'POOL');
await trade(mint, alice, 'alice sells half her coins in the pool', 'sell', (await coinBalance(alice.address, mint)) / 2n, 'POOL');

// the books mid-life, while every fee is still unclaimed: each one must add up to the raw unit
const midBooks = await t.booksNow('before any claim', 6);

// ---------------------------------------------------------------- 5. claims
await t.creatorClaims(mint, creator, alice, ['curve', 'pool']);
await t.platformClaim(mint, treasury);

// ---------------------------------------------------------------- 6. the faucet, then the books
const fr = await call('/api/lp/faucet', { wallet: newcomer.address });
check('faucet: a new wallet gets test SOL from the operator', [200, ENGINE_FAUCET.lamports.toString()], [fr.status, (await chain.lamports(newcomer.address)).toString()]);
const books = await t.booksNow('after every claim', 6);
const st = (await call(`/api/lp/tokens/${mint}`)).body.token.stats;
check('stats: five trades from two traders', [5, 2], [st.count, st.traders]);
t.finish(out, { booksBeforeClaims: midBooks, booksAfterClaims: books });
