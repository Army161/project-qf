// The launchpad on Project QF's own engine, against the engine's real v2 programs on devnet (DEPLOYMENTS.devnet, set up
// by the engine repo's runbook rehearsal on 2026-11-12): the app server (src/server.ts, its indexer and crank) runs in this
// process, and engine-e2e.ts plays the browser and the wallets. A coin goes through its whole life on devnet: launch, a
// buy and a sell on the curve, a buy that completes it, graduation by the crank, a buy and a sell in its pool, both creator
// claims and the platform's claim, the faucet; the books (`verify`) all PASS before and after the claims. Every wallet
// made for the run gives its leftover test SOL back to the operator at the end. It costs the operator about 0.05 devnet
// SOL (rent for the coin's accounts and the pool, network fees); bob's buy-out needs about 1 SOL for the run's length.
//
//   node --no-warnings --use-env-proxy apps/launchpad/scripts/engine-devnet.ts <evidence.json>
// Settings: QF_DEVNET_KEY (the throwaway operator key, default ~/.qf-devnet/operator.json; it pays for the run), QF_RPC_URL
// (default the public devnet endpoint). Devnet only: the RPC must prove devnet's genesis hash, mainnet is refused.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import * as E from '@project-qf/engine';
import { economicsDigest } from '@project-qf/policy';
import { toBase64 } from '@project-qf/tx';
import { checkDeployment, kitChain, loadOperator, mainnetGate, proveCluster } from '../src/chain.ts';
import { indexPass } from '../src/indexer.ts';
import { ENGINE_FAUCET } from '../src/server.ts';
import { e2e, SOL, sleep } from './engine-e2e.ts';

/** The devnet v2 treasury (a throwaway key standing in for the treasury multisig vault; engine repo devnet/keys.json). */
const ENGINE_TREASURY = 'D4GdbP8hUKpMhvdHNxYXdM44te57f12DFKwpJ6N2VWNK';
const RPC = process.env.QF_RPC_URL || 'https://api.devnet.solana.com';
const [out] = process.argv.slice(2) as [string];
const log = (m: string) => console.log(`      [app] ${m}`);

const operator = await loadOperator(process.env.QF_DEVNET_KEY ?? join(homedir(), '.qf-devnet', 'operator.json'));
if (!operator) throw new Error('no devnet operator key: run `main.ts operator` first and fund it');
const chain = kitChain(RPC, operator, log);
const cluster = await proveCluster(RPC, 'devnet', chain.genesisHash, mainnetGate(undefined)) as 'devnet';
E.useDeployment(E.deploymentFor('devnet'));
await checkDeployment(chain.decisionRead ?? chain.read, E.activeDeployment());
const startLamports = await chain.lamports(operator.address);
if (startLamports < 2_200_000_000n) throw new Error(`the operator holds ${SOL(startLamports)}; the run needs 2.2 (bob's buy-out, the faucet and the graduation float, all paid back)`);
const [creator, alice, bob, mintKey, newcomer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
const t = await e2e({ chain, cluster, faucet: true });
const { check, call, store, flow, trade, coinBalance } = t;
check('the app proves it is on devnet (by genesis hash), never mainnet', 'devnet', cluster);
t.evidence.steps.push({ step: 'the operator funds the run\'s creator (0.05 SOL), alice (0.12 SOL) and bob (1.2 SOL)',
  signature: await chain.sendAsOperator([E.transferSolIx(operator.address, creator.address, 50_000_000n), E.transferSolIx(operator.address, alice.address, 120_000_000n),
    E.transferSolIx(operator.address, bob.address, 1_200_000_000n)], 10_000) });

async function run() {
  // ---------------------------------------------------------------- 1. the platform, as the engine's admin set it up
  const pl = (await call('/api/lp/platform?fresh=1')).body;
  check('platform: engine qf on devnet, ready, quoted in SOL', ['qf', 'devnet', true, 'SOL'], [pl.engine, pl.cluster, pl.ready, pl.platform?.quote.symbol]);
  check('platform: the devnet v2 programs and pool fee account', [E.DEPLOYMENTS.devnet.curve, E.DEPLOYMENTS.devnet.pool, E.DEPLOYMENTS.devnet.poolFeeReceiver],
    [pl.platform.programs.curve, pl.platform.programs.pool, pl.platform.poolFeeReceiver]);
  check('platform: the economics digest recomputes in the browser', pl.platform.launchEconomicsDigest, economicsDigest(pl.platform.launchEconomics));
  check('platform: fees go to the devnet treasury (a throwaway key standing in for the treasury vault)', ENGINE_TREASURY, pl.platform.feeRecipient);
  check('platform: coin creation and buying are open', [false, false], [pl.platform.createPaused, pl.platform.buyPaused]);

  // ---------------------------------------------------------------- 2. a launch through the app
  const launchBody = { creator: creator.address, baseMint: mint, name: 'App Devnet Dog', symbol: 'ADOG', description: 'TEST_ONLY devnet coin launched by the app\'s end-to-end run', economicsDigest: pl.platform.launchEconomicsDigest };
  const launch = await flow('launch $ADOG', creator, '/api/lp/launch', launchBody, (b) => ({ kind: 'QF_CREATE',
    fields: { name: launchBody.name, symbol: launchBody.symbol, uri: (b.terms as { uri: string }).uri, creator: creator.address, baseMint: mint, quoteMint: E.NATIVE_MINT, ammConfig: pl.platform.ammConfig } }), [mintKey]);
  check('launch: the coin is live in the app', 'LIVE', (await store.getCoin(mint))?.status);
  const again = await call('/api/lp/submit', { intentId: launch.built.intentId, signedTransaction: toBase64(launch.signed) });
  check('launch: the same signed transaction is not relayed twice', 'ALREADY_SUBMITTED', again.body?.error?.code);
  const [mintAcc] = await chain.read([mint]);
  const launched = (await E.readCoin(chain.read, mint, E.NATIVE_MINT))!.launch;
  check('launch: Token-2022 coin, its launch\'s full supply, no mint or freeze authority', [E.TOKEN_2022, launched.config.totalSupply, null, null],
    (({ program, supply, mintAuthority, freezeAuthority }) => [program, supply, mintAuthority, freezeAuthority])(E.decodeMint(mintAcc!)));

  // ---------------------------------------------------------------- 3. curve trades, then a buy that completes the curve
  await trade(mint, alice, 'alice buys 0.05 SOL on the curve', 'buy', 50_000_000n, 'CURVE');
  await trade(mint, alice, 'alice sells a third on the curve', 'sell', (await coinBalance(alice.address, mint)) / 3n, 'CURVE');
  const last = await trade(mint, bob, 'bob buys out the curve (offers 1.1 SOL)', 'buy', 1_100_000_000n, 'CURVE');
  check('the last buy completes the curve and pays only for what was left', true, last.completesCurve && BigInt(last.amountIn) < 1_100_000_000n);
  check('a quote on a full curve is refused as input, not a fault', 'CURVE_COMPLETE', (await call('/api/lp/quote', { mint, side: 'buy', amountIn: '1000' })).body?.error?.code);

  // ---------------------------------------------------------------- 4. graduation by the crank, then the pool
  let coin = (await store.getCoin(mint))!;
  for (let k = 0; coin.status !== 'GRADUATED' && k < 20; k++) { await indexPass(t.d); coin = (await store.getCoin(mint))!; if (coin.status !== 'GRADUATED') await sleep(3_000); }
  check('the crank graduated the coin and the app follows it', 'GRADUATED', coin.status);
  if (coin.graduateSig) t.evidence.steps.push({ step: 'graduate (operator crank)', signature: coin.graduateSig });
  check('the coin trades in its own pool', await E.launchPoolAddress(mint), coin.pool);
  const tv = (await call(`/api/lp/tokens/${mint}?fresh=1`)).body.token;
  check('token view: pool venue, 100% of liquidity locked (LP mint supply 0)', ['GRADUATED', 'POOL', 10_000], [tv.status, tv.live.venue, tv.live.lockedBps]);
  for (let k = 0; (await call('/api/lp/quote', { mint, side: 'buy', amountIn: '1000' })).body?.error?.code === 'POOL_NOT_OPEN'; k++) { if (k > 60) throw new Error('pool did not open'); await sleep(1_000); }
  await trade(mint, alice, 'alice buys 0.02 SOL in the pool', 'buy', 20_000_000n, 'POOL');
  await trade(mint, alice, 'alice sells half her coins in the pool', 'sell', (await coinBalance(alice.address, mint)) / 2n, 'POOL');
  const midBooks = await t.booksNow('before any claim', 6);

  // ---------------------------------------------------------------- 5. claims, the faucet, the books again
  await t.creatorClaims(mint, creator, alice, ['curve', 'pool']);
  await t.platformClaim(mint, ENGINE_TREASURY);
  const fr = await call('/api/lp/faucet', { wallet: newcomer.address });
  check('faucet: a new wallet gets test SOL from the operator', [200, ENGINE_FAUCET.lamports.toString()], [fr.status, (await chain.lamports(newcomer.address)).toString()]);
  const books = await t.booksNow('after every claim', 6);
  const st = (await call(`/api/lp/tokens/${mint}`)).body.token.stats;
  check('stats: five trades from two traders', [5, 2], [st.count, st.traders]);
  return { midBooks, books };
}

/** Every wallet made for the run gives its test SOL back to the operator, whether the run passed, failed or stopped. */
async function giveBack() {
  for (const [who, k] of [['creator', creator], ['alice', alice], ['bob', bob], ['the faucet\'s newcomer', newcomer]] as const) {
    const bal = await chain.lamports(k.address).catch(() => 0n);
    if (bal <= 5_000n) continue;
    const signature = await kitChain(RPC, k, log).sendAsOperator([E.transferSolIx(k.address, operator!.address, bal - 5_000n)], 1_000)
      .catch((e) => `NOT RETURNED: ${(e as Error).message.slice(0, 120)}`);
    t.evidence.steps.push({ step: `${who} returns ${SOL(bal - 5_000n)} to the operator`, signature });
    console.log(`      ${who} returns ${SOL(bal - 5_000n)} to the operator: ${signature}`);
  }
}

const mint = mintKey.address;
let result: Awaited<ReturnType<typeof run>> | { error: string };
try { result = await run(); } catch (e) { result = { error: (e as Error).stack ?? String(e) }; console.error(result.error); check('the run finished', 'finished', 'stopped'); }
await giveBack();
const cost = startLamports - await chain.lamports(operator.address);
console.log(`      the run cost the operator ${SOL(cost)} (rent for the coin's accounts, its pool and the run's token accounts, network fees)`);
t.finish(out, { cluster, rpc: RPC.replace(/api-key=[^&]+/, 'api-key=<redacted>'), operator: operator.address, operatorCostLamports: cost.toString(),
  coin: mint, ...result });
