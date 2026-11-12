// The launchpad on Project QF's own engine, against the engine's real programs on devnet: the app server (src/server.ts,
// its indexer and crank) runs in this process, and engine-e2e.ts plays the browser and the wallets. It uses the engine's
// devnet setup as it is (the app never sets the engine up) and costs a few hundredths of a devnet SOL:
//   - the app finds the coin the engine thread launched without it ($QFP, graduated) and its books must add up;
//   - a new coin launched through the app, a buy and a sell on its curve, a buy and a sell in $QFP's pool;
//   - the creator's claim, the platform's claim, the faucet; the books (`verify`) all PASS before and after the claims;
//   - every wallet made for the run gives its leftover test SOL back to the operator at the end.
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
import { e2e, SOL } from './engine-e2e.ts';

/** The engine's devnet setup and its own proof coin (OWN-ENGINE-BUILD-2026-10-11.md §9). */
const ENGINE_TREASURY = '66wkzUGeSBNudGdskL7SC1cz4dSvdFqm7KY6hfngTsHX';
const PROOF_COIN = '9PxVfDqKVijSeZn1Y8qrzMk1TPBRT3wY3W55XuPfqPcu';
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
if (startLamports < 700_000_000n) throw new Error(`the operator holds ${SOL(startLamports)}; the run needs 0.7 (the faucet step pays 0.5 and gets it back)`);
const [creator, alice, mintKey, newcomer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
const t = await e2e({ chain, cluster, faucet: true });
const { check, call, store, d, flow, trade, coinBalance, booksNow, creatorClaims, platformClaim } = t;
check('the app proves it is on devnet (by genesis hash), never mainnet', 'devnet', cluster);
t.evidence.steps.push({ step: 'the operator funds the run\'s creator (0.05 SOL) and alice (0.03 SOL)',
  signature: await chain.sendAsOperator([E.transferSolIx(operator.address, creator.address, 50_000_000n), E.transferSolIx(operator.address, alice.address, 30_000_000n)], 10_000) });

async function run() {
  // ---------------------------------------------------------------- 1. the platform, as the engine's admin set it up
  const pl = (await call('/api/lp/platform?fresh=1')).body;
  check('platform: engine qf on devnet, ready, quoted in SOL', ['qf', 'devnet', true, 'SOL'], [pl.engine, pl.cluster, pl.ready, pl.platform?.quote.symbol]);
  check('platform: the economics digest recomputes in the browser', pl.platform.launchEconomicsDigest, economicsDigest(pl.platform.launchEconomics));
  check('platform: fees go to the engine\'s devnet fee recipient (a throwaway key, not the 2-of-3 vault)', ENGINE_TREASURY, pl.platform.feeRecipient);

  // ---------------------------------------------------------------- 2. a coin this app did not launch
  await indexPass(d);
  const proof = (await store.getCoin(PROOF_COIN));
  check('the app finds the engine\'s proof coin on chain, though it did not launch it', ['QFP', 'GRADUATED'], [proof?.symbol, proof?.status]);

  // ---------------------------------------------------------------- 3. a launch through the app
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

  // ---------------------------------------------------------------- 4. trades: on the new coin's curve, in $QFP's pool
  await trade(mint, alice, 'alice buys 0.01 SOL of $ADOG on the curve', 'buy', 10_000_000n, 'CURVE');
  await trade(mint, alice, 'alice sells half her $ADOG on the curve', 'sell', (await coinBalance(alice.address, mint)) / 2n, 'CURVE');
  await trade(PROOF_COIN, alice, 'alice buys 0.002 SOL of $QFP in its pool', 'buy', 2_000_000n, 'POOL');
  await trade(PROOF_COIN, alice, 'alice sells her $QFP in its pool', 'sell', await coinBalance(alice.address, PROOF_COIN), 'POOL');
  const midBooks = await booksNow('before the claims (both coins)');

  // ---------------------------------------------------------------- 5. claims, the faucet, the books again
  await creatorClaims(mint, creator, alice, ['curve']);
  await platformClaim(mint, ENGINE_TREASURY);
  const fr = await call('/api/lp/faucet', { wallet: newcomer.address });
  check('faucet: a new wallet gets test SOL from the operator', [200, ENGINE_FAUCET.lamports.toString()], [fr.status, (await chain.lamports(newcomer.address)).toString()]);
  const books = await booksNow('after the claims (both coins)');
  const st = (await call(`/api/lp/tokens/${mint}`)).body.token.stats;
  check('stats: two trades on $ADOG from one trader', [2, 1], [st.count, st.traders]);
  return { midBooks, books };
}

/** Every wallet made for the run gives its test SOL back to the operator, whether the run passed, failed or stopped. */
async function giveBack() {
  for (const [who, k] of [['creator', creator], ['alice', alice], ['the faucet\'s newcomer', newcomer]] as const) {
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
console.log(`      the run cost the operator ${SOL(cost)} (rent for the new coin's accounts and alice's token accounts, network fees)`);
t.finish(out, { cluster, rpc: RPC.replace(/api-key=[^&]+/, 'api-key=<redacted>'), operator: operator.address, operatorCostLamports: cost.toString(),
  coins: { launched: mint, found: PROOF_COIN }, ...result });
