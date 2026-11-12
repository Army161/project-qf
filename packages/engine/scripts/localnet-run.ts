// One full coin, built and read only through @project-qf/engine, against the real engine programs on a local
// validator: create, buy, sell, a refused buy (slippage), buy out the curve, graduate, swap both ways in the pool,
// the creator's pool fee, and both fee claims. Every quote the package makes is compared with what the programs did
// (events, account state and token balances, to the raw unit), and the books are reconciled after every step.
//
//   prepare <dir> <treasury>                          write the pool admin's accounts as validator --account files
//   run <evidence.json> <authority.json> <treasury>   the coin's life against http://127.0.0.1:8899
//
// scripts/localnet.sh drives both. Localnet only: the RPC must be 127.0.0.1 and every key is generated for the run.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  address, createKeyPairSignerFromBytes, createSolanaRpc, generateKeyPairSigner, getAddressEncoder, getBase64Decoder, getBase64EncodedWireTransaction,
  getBase64Encoder, getProgramDerivedAddress, getTransactionDecoder, lamports, signTransaction, type Instruction, type KeyPairSigner,
} from '@solana/kit';
import * as E from '../src/index.ts';
import { encodeFields } from '../src/codec.ts';

const POOL_FEE_OWNERS = '66wkzUGeSBNudGdskL7SC1cz4dSvdFqm7KY6hfngTsHX'; // protocol and fund fee owner in the fork
const b64 = getBase64Decoder(), fromB64 = getBase64Encoder(), enc = getAddressEncoder();
const rent = (len: number) => BigInt((128 + len) * 6960);

// ---------- prepare: accounts the pool admin creates once per cluster ----------
async function prepare(dir: string, treasury: string) {
  mkdirSync(dir, { recursive: true });
  const file = (name: string, pubkey: string, owner: string, data: Uint8Array, lam = rent(data.length)) =>
    writeFileSync(`${dir}/${name}.json`, JSON.stringify({ pubkey, account: { lamports: Number(lam), data: [b64.decode(data), 'base64'], owner, executable: false, rentEpoch: 0, space: data.length } }));
  const [ammConfig, bump] = await getProgramDerivedAddress({ programAddress: address(E.QF_POOL), seeds: ['amm_config', Uint8Array.of(0, 0)] });
  const p = E.POOL_PRESET;
  file('amm-config', ammConfig, E.QF_POOL, Uint8Array.from([...E.POOL_IDL.accounts.AmmConfig!, ...encodeFields({
    bump, disable_create_pool: false, index: p.index, trade_fee_rate: p.tradeFeeRate, protocol_fee_rate: p.protocolFeeRate, fund_fee_rate: p.fundFeeRate, create_pool_fee: p.createPoolFee,
    protocol_owner: POOL_FEE_OWNERS, fund_owner: POOL_FEE_OWNERS, creator_fee_rate: p.creatorFeeRate, creator_fee_share_rate: 0n, padding: Array(14).fill(0n),
  }, E.POOL_IDL.types.AmmConfig!.fields!, E.POOL_IDL.types)]));
  // the graduator's launchpad permission (create_permission_pda): authority = graduator, padding zeroed
  const graduator = await E.graduatorAddress();
  const permission = new Uint8Array(8 + 32 + 240);
  permission.set(Uint8Array.from([224, 83, 28, 79, 10, 253, 161, 28]), 0); // Permission discriminator (qf_pool.json)
  permission.set(enc.encode(address(graduator)), 8);
  file('permission', await E.permissionAddress(graduator), E.QF_POOL, permission);
  // the pool-creation-fee account: a wrapped-SOL token account at the fork's fixed address
  const fee = new Uint8Array(165);
  fee.set(enc.encode(address(E.NATIVE_MINT)), 0); fee.set(enc.encode(address(treasury)), 32); fee[108] = 1;
  fee.set([1, 0, 0, 0], 109); new DataView(fee.buffer).setBigUint64(113, rent(165), true);
  file('pool-fee-account', E.POOL_FEE_RECEIVER, E.TOKEN, fee);
  console.log(`prepared ${dir}: amm config ${ammConfig}, permission, pool-fee account`);
}

// ---------- run ----------
const RPC = 'http://127.0.0.1:8899';
const rpc = createSolanaRpc(RPC);
const evidence: Record<string, unknown> & { steps: { step: string; signature: string; computeUnits: number | null }[]; checks: { check: string; expected: string; actual: string; ok: boolean }[] } = { steps: [], checks: [] };
const s = (v: unknown) => (typeof v === 'bigint' ? v.toString() : JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
function check(name: string, expected: unknown, actual: unknown) {
  const ok = s(expected) === s(actual);
  evidence.checks.push({ check: name, expected: s(expected), actual: s(actual), ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  expected ${s(expected)} got ${s(actual)}`}`);
}

const reader: E.AccountReader = async (addrs) => {
  const r = await rpc.getMultipleAccounts(addrs.map((a) => address(a)), { encoding: 'base64', commitment: 'confirmed' }).send();
  return r.value.map((a) => (a ? { owner: a.owner as string, lamports: BigInt(a.lamports), data: fromB64.encode(a.data[0]) as Uint8Array } : null));
};
const tokenBalance = async (account: string) => { const [a] = await reader([account]); return a ? E.decodeTokenAccount(a).amount : 0n; };

async function send(step: string, payer: KeyPairSigner, signers: KeyPairSigner[], instructions: Instruction[], computeUnits = 400_000) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const unsigned = E.compileUnsigned({ feePayer: payer.address, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, instructions, computeUnits });
  const keys = new Map([payer, ...signers].map((k) => [k.address as string, k.keyPair]));
  for (const a of unsigned.signers) if (!keys.has(a)) throw new Error(`${step}: no key for signer ${a}`);
  const tx = await signTransaction(unsigned.signers.map((a) => keys.get(a)!), getTransactionDecoder().decode(unsigned.bytes));
  const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let k = 0; ; k++) {
    const { value: [st] } = await rpc.getSignatureStatuses([signature]).send();
    if (st?.err) throw new Error(`${step} failed: ${s(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
    if (k > 120) throw new Error(`${step}: not confirmed`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const t = await rpc.getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).send();
  const logs = (t?.meta?.logMessages ?? []) as string[];
  const parsed = E.parseEngineEvents(logs);
  if (parsed.truncated) throw new Error(`${step}: log truncated`);
  const computeUnits_ = t?.meta?.computeUnitsConsumed === undefined ? null : Number(t.meta.computeUnitsConsumed);
  evidence.steps.push({ step, signature, computeUnits: computeUnits_ });
  console.log(`      ${step.padEnd(36)} ${signature}  (${computeUnits_} CU)`);
  return parsed.events;
}
async function refused(step: string, payer: KeyPairSigner, instructions: Instruction[], errorCode: number) {
  try { await send(step, payer, [], instructions); check(`${step} is refused`, 'refused', 'accepted'); }
  catch (e) { const m = String((e as Error).message ?? e) + s((e as { context?: unknown }).context ?? ''); check(`${step} is refused with program error ${errorCode}`, true, m.includes(`0x${errorCode.toString(16)}`) || m.includes(`"Custom":${errorCode}`) || m.includes(`custom program error: 0x${errorCode.toString(16)}`)); }
}
async function airdrop(to: string, sol: number) {
  const sig = await rpc.requestAirdrop(address(to), lamports(BigInt(sol) * 1_000_000_000n)).send();
  for (let k = 0; k < 120; k++) { const { value: [st] } = await rpc.getSignatureStatuses([sig]).send(); if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('airdrop not confirmed');
}

async function books(label: string, mint: string) {
  const c = (await E.readCoin(reader, mint))!;
  const l = c.launch;
  check(`${label}: quote vault = real quote + unclaimed fees`, l.realQuote + l.platformFees + l.creatorFees, c.quoteVault);
  check(`${label}: coin vault = supply - sold${l.status === 'Graduated' ? ' - pool supply' : ''}`, l.config.totalSupply - l.baseSold - (l.status === 'Graduated' ? E.poolSupply(l.config) : 0n), c.baseVault);
  return c;
}

async function run(out: string, authorityFile: string, treasury: string) {
  const authority = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(authorityFile, 'utf8'))));
  const [creator, alice, bob, mint] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const cfg = E.LAUNCH_PRESETS.devnetSmall;
  const ammConfig = await E.ammConfigAddress(0);
  for (const [k, sol] of [[authority.address, 20], [creator.address, 2], [alice.address, 5], [bob.address, 5]] as const) await airdrop(k, sol);
  Object.assign(evidence, { rpc: RPC, programs: { curve: E.QF_CURVE, pool: E.QF_POOL }, mint: mint.address, creator: creator.address, treasury, config: 'devnetSmall' });

  // settings (curve upgrade authority), then the coin
  await send('initialize (wSOL settings)', authority, [], [await E.initializeIx({ authority: authority.address, ammConfig, settings: { admin: authority.address, feeRecipient: treasury, createPaused: false, buyPaused: false, config: cfg } })]);
  const [g] = await reader([await E.globalAddress()]);
  check('Global decodes and holds the chosen settings', { feeRecipient: treasury, ammConfig, config: cfg }, (({ feeRecipient, ammConfig, config }) => ({ feeRecipient, ammConfig, config }))(E.decodeGlobal(g!)));

  const created = await send('create_launch', creator, [mint], [await E.createLaunchIx({ creator: creator.address, mint: mint.address, ammConfig, name: 'Localnet Dog', symbol: 'LDOG', uri: 'https://example.invalid/m/ldog.json' })]);
  check('LaunchCreated event', { name: 'LaunchCreated', coinName: 'Localnet Dog', symbol: 'LDOG', config: cfg }, (({ name, coinName, symbol, config }) => ({ name, coinName, symbol, config }))(created[0] as E.LaunchCreatedEvent));
  const [m] = await reader([mint.address]);
  const mintInfo = E.decodeMint(m!);
  check('coin mint: Token-2022, full supply, 6 decimals, no mint or freeze authority', { program: E.TOKEN_2022, mintAuthority: null, supply: cfg.totalSupply, decimals: 6, freezeAuthority: null }, mintInfo);
  let c = await books('after create', mint.address);
  check('launch starts Trading with nothing sold', ['Trading', 0n, 0n], [c.launch.status, c.launch.realQuote, c.launch.baseSold]);

  // a buy, compared to the raw unit
  const trade = async (who: KeyPairSigner, label: string, side: 'buy' | 'sell', amount: bigint) => {
    const before = (await E.readCoin(reader, mint.address))!.launch;
    const q = side === 'buy' ? E.quoteBuy(before.config, before.realQuote, before.baseSold, amount) : E.quoteSell(before.config, before.realQuote, before.baseSold, amount);
    const ixs = side === 'buy'
      ? [...(await E.traderAccountIxs(who.address, who.address, mint.address)), ...(await E.wrapSolIxs(who.address, who.address, amount)), await E.buyIx({ trader: who.address, mint: mint.address, quoteIn: amount, minBaseOut: (q as E.BuyResult).baseOut })]
      : [await E.sellIx({ trader: who.address, mint: mint.address, baseIn: amount, minQuoteOut: (q as E.SellResult).quoteOut })];
    const ev = (await send(label, who, [], ixs)).find((e) => e.name === 'TradeEvent') as E.TradeEvent;
    const split = E.splitFee(before.config, q.fee);
    const after = (await E.readCoin(reader, mint.address))!.launch;
    if (side === 'buy') {
      const b = q as E.BuyResult;
      check(`${label}: event equals the package's quote`, { quoteAmount: b.quoteIn, baseAmount: b.baseOut, platformFee: split.platform, creatorFee: split.creator, complete: b.completes },
        { quoteAmount: ev.quoteAmount, baseAmount: ev.baseAmount, platformFee: ev.platformFee, creatorFee: ev.creatorFee, complete: ev.complete });
      check(`${label}: launch state moved exactly by the quote`, [before.realQuote + b.quoteToCurve, before.baseSold + b.baseOut, before.platformFees + split.platform, before.creatorFees + split.creator],
        [after.realQuote, after.baseSold, after.platformFees, after.creatorFees]);
    } else {
      const r = q as E.SellResult;
      check(`${label}: event equals the package's quote`, { quoteAmount: r.quoteOut, baseAmount: amount, platformFee: split.platform, creatorFee: split.creator }, { quoteAmount: ev.quoteAmount, baseAmount: ev.baseAmount, platformFee: ev.platformFee, creatorFee: ev.creatorFee });
      check(`${label}: launch state moved exactly by the quote`, [before.realQuote - r.quoteFromCurve, before.baseSold - amount], [after.realQuote, after.baseSold]);
    }
    check(`${label}: event carries the state after the trade`, [after.realQuote, after.baseSold], [ev.realQuote, ev.baseSold]);
    await books(`after ${label}`, mint.address);
    return q;
  };
  const aliceBuy = await trade(alice, 'alice buys 0.05 SOL', 'buy', 50_000_000n) as E.BuyResult;
  const aliceCoin = await E.ata(alice.address, mint.address, E.TOKEN_2022);
  check('alice holds exactly the coins quoted', aliceBuy.baseOut, await tokenBalance(aliceCoin));
  await trade(alice, 'alice sells a third', 'sell', aliceBuy.baseOut / 3n);
  c = (await E.readCoin(reader, mint.address))!;
  const tooGreedy = E.quoteBuy(c.launch.config, c.launch.realQuote, c.launch.baseSold, 10_000_000n);
  await refused('a buy asking one coin more than the quote', alice, [await E.buyIx({ trader: alice.address, mint: mint.address, quoteIn: 10_000_000n, minBaseOut: tooGreedy.baseOut + 1n })], 6006);

  // bob buys out the curve: the buy is clipped to what is left
  const bobBuy = await trade(bob, 'bob buys out the curve', 'buy', cfg.virtualQuote * 3n) as E.BuyResult;
  check('the sell-out buy completes and is clipped below the offer', [true, true], [bobBuy.completes, bobBuy.quoteIn < cfg.virtualQuote * 3n]);
  c = await books('sold out', mint.address);
  check('launch is Complete with the whole curve sold', ['Complete', cfg.curveSupply], [c.launch.status, c.launch.baseSold]);
  // trades round in the curve's favour, so after several trades the raise can sit a few units above the one-buy figure
  check('raise is at least the curve\'s final quote (rounding favours the curve)', true, c.launch.realQuote >= E.finalRealQuote(cfg));
  evidence.raise = { raised: c.launch.realQuote.toString(), oneBuyFigure: E.finalRealQuote(cfg).toString() };
  // bob's wrapped SOL left over from the clipped offer
  check('bob\'s unspent offer stays in his wrapped-SOL account', cfg.virtualQuote * 3n - bobBuy.quoteIn, await tokenBalance(await E.ata(bob.address, E.NATIVE_MINT, E.TOKEN)));

  // graduate (anyone; here the authority acts as QF's server)
  const preGrad = c.launch;
  const gradEvents = await send('graduate', authority, [], [await E.graduateIx({ payer: authority.address, mint: mint.address, ammConfig: preGrad.ammConfig, creator: preGrad.creator, createPoolFee: E.POOL_FEE_RECEIVER })]);
  const grad = gradEvents.find((e) => e.name === 'Graduated') as E.GraduatedEvent;
  const poolAddr = await E.launchPoolAddress(mint.address);
  check('Graduated event: pool address, amounts and fee', { pool: poolAddr, quoteToPool: preGrad.realQuote - cfg.graduationFee, baseToPool: E.poolSupply(cfg), graduationFee: cfg.graduationFee },
    { pool: grad.pool, quoteToPool: grad.quoteToPool, baseToPool: grad.baseToPool, graduationFee: grad.graduationFee });
  c = await books('graduated', mint.address);
  check('launch is Graduated; real quote 0; graduation fee added to the platform share', ['Graduated', 0n, preGrad.platformFees + cfg.graduationFee, poolAddr], [c.launch.status, c.launch.realQuote, c.launch.platformFees, c.launch.pool]);
  let p = (await E.readCoinPool(reader, mint.address))!;
  const coinIs0 = p.pool.token0Mint === mint.address;
  check('pool: creator is the coin\'s creator, creator fee on the quote side, swaps on', [creator.address, coinIs0 ? 2 : 1, true, 0], [p.pool.poolCreator, p.pool.creatorFeeOn, p.pool.enableCreatorFee, p.pool.status]);
  // every LP token was burned: the LP mint's supply is 0. PoolState.lp_supply keeps the pool's own count (burns are
  // not subtracted, and 100 units were never minted: the pool program's permanent lock).
  const lpMint = E.decodeMint((await reader([p.pool.lpMint]))[0]!);
  check('LP mint supply is 0 (all LP burned); the pool still records its liquidity', [0n, true], [lpMint.supply, p.pool.lpSupply > 100n]);
  evidence.pool = { address: poolAddr, lpSupplyRecorded: p.pool.lpSupply.toString(), lpMintSupply: lpMint.supply.toString(), openTime: p.pool.openTime.toString() };
  check('pool vaults hold exactly the graduation amounts', coinIs0 ? [grad.baseToPool, grad.quoteToPool] : [grad.quoteToPool, grad.baseToPool], [p.vault0, p.vault1]);
  check('pool config: QF rates', [2_500n, 200_000n, 500n], [p.config.tradeFeeRate, p.config.protocolFeeRate, p.config.creatorFeeRate]);
  check('graduator ends with no lamports', null, (await reader([await E.graduatorAddress()]))[0]);

  // pool swaps both ways, compared to quotePoolSwap
  // the pool opens one second after the block that created it (pool program: open_time = block time + 1)
  const chainNow = async () => { const slot = await rpc.getSlot({ commitment: 'confirmed' }).send(); return BigInt((await rpc.getBlockTime(slot).send()) ?? 0n); };
  for (let k = 0; (await chainNow()) <= p.pool.openTime; k++) { if (k > 40) throw new Error('pool did not open'); await new Promise((r) => setTimeout(r, 250)); }
  const poolSwap = async (who: KeyPairSigner, label: string, side: 'buy' | 'sell', amountIn: bigint) => {
    p = (await E.readCoinPool(reader, mint.address))!;
    const mintIn = side === 'buy' ? E.NATIVE_MINT : mint.address;
    const q = E.quotePoolSwap(p.pool, p.config, mintIn, amountIn, p.vault0, p.vault1, await chainNow());
    const outAcct = side === 'buy' ? aliceCoin : await E.ata(who.address, E.NATIVE_MINT, E.TOKEN);
    const outBefore = await tokenBalance(outAcct);
    const pre = side === 'buy' ? await E.wrapSolIxs(who.address, who.address, amountIn) : [await E.createAtaIdempotentIx(who.address, who.address, E.NATIVE_MINT)];
    const ev = (await send(label, who, [], [...pre, await E.coinPoolSwapIx({ payer: who.address, mint: mint.address, ammConfig: p.pool.ammConfig, side, amountIn, minOut: q.amountOut })])).find((e) => e.name === 'SwapEvent') as E.PoolSwapEvent;
    check(`${label}: SwapEvent equals the package's quote`, { inputAmount: q.amountIn, outputAmount: q.amountOut, tradeFee: q.tradeFee, creatorFee: q.creatorFee, creatorFeeOnInput: q.creatorFeeOnInput, inputVaultBefore: q.inputReserve, outputVaultBefore: q.outputReserve },
      { inputAmount: ev.inputAmount, outputAmount: ev.outputAmount, tradeFee: ev.tradeFee, creatorFee: ev.creatorFee, creatorFeeOnInput: ev.creatorFeeOnInput, inputVaultBefore: ev.inputVaultBefore, outputVaultBefore: ev.outputVaultBefore });
    check(`${label}: trader received exactly the quoted output`, q.amountOut, (await tokenBalance(outAcct)) - outBefore);
    const after = (await E.readCoinPool(reader, mint.address))!;
    const quoteIdx = coinIs0 ? 1 : 0;
    const proto = (x: E.CoinPool): [bigint, bigint, bigint] => (quoteIdx === 1 ? [x.pool.protocolFeesToken0, x.pool.protocolFeesToken1, x.pool.creatorFeesToken1] : [x.pool.protocolFeesToken1, x.pool.protocolFeesToken0, x.pool.creatorFeesToken0]);
    const [pc0, pq0, cr0] = proto(p), [pc1, pq1, cr1] = proto(after);
    check(`${label}: protocol and creator fees accrued as quoted`, side === 'buy' ? [pc0, pq0 + q.protocolFee, cr0 + q.creatorFee] : [pc0 + q.protocolFee, pq0, cr0 + q.creatorFee], [pc1, pq1, cr1]);
    return q;
  };
  await poolSwap(alice, 'alice buys in the pool (0.02 SOL)', 'buy', 20_000_000n);
  await poolSwap(alice, 'alice sells half her coins in the pool', 'sell', (await tokenBalance(aliceCoin)) / 2n);

  // the creator's pool fee, then both curve fee claims
  p = (await E.readCoinPool(reader, mint.address))!;
  const owed = coinIs0 ? p.pool.creatorFeesToken1 : p.pool.creatorFeesToken0;
  const creatorQuote = await E.ata(creator.address, E.NATIVE_MINT, E.TOKEN);
  const cq0 = await tokenBalance(creatorQuote);
  await send('collect pool creator fee (anyone sends; pays the creator)', bob, [], [await E.collectPoolCreatorFeeIx({ payer: bob.address, creator: creator.address, mint: mint.address, ammConfig: p.pool.ammConfig })]);
  check('creator received the pool\'s whole creator fee (share 0%)', owed, (await tokenBalance(creatorQuote)) - cq0);

  c = (await E.readCoin(reader, mint.address))!;
  const treasuryQuote = await E.ata(treasury, E.NATIVE_MINT, E.TOKEN);
  const claims = await send('claim platform + creator fees', bob, [], [
    await E.createAtaIdempotentIx(bob.address, treasury, E.NATIVE_MINT), await E.createAtaIdempotentIx(bob.address, creator.address, E.NATIVE_MINT),
    await E.claimPlatformFeesIx({ mint: mint.address, to: treasuryQuote }), await E.claimCreatorFeesIx({ mint: mint.address, to: creatorQuote }),
  ]);
  check('FeesClaimed events pay exactly the unclaimed shares', [[treasuryQuote, c.launch.platformFees, false], [creatorQuote, c.launch.creatorFees, true]],
    claims.filter((e) => e.name === 'FeesClaimed').map((e) => [(e as E.FeesClaimedEvent).to, (e as E.FeesClaimedEvent).amount, (e as E.FeesClaimedEvent).creator]));
  check('treasury holds the platform share', c.launch.platformFees, await tokenBalance(treasuryQuote));
  const end = await books('after claims', mint.address);
  check('nothing left in the curve\'s quote vault', [0n, 0n, 0n], [end.quoteVault, end.launch.platformFees, end.launch.creatorFees]);

  writeFileSync(out, JSON.stringify({ label: 'LOCALNET (throwaway keys; not devnet, not mainnet)', ranAt: new Date().toISOString(), ...evidence }, null, 1) + '\n');
  const failed = evidence.checks.filter((x) => !x.ok);
  console.log(`\n${evidence.checks.length - failed.length} PASS, ${failed.length} FAIL; ${evidence.steps.length} transactions. Evidence: ${out}`);
  if (failed.length) process.exit(1);
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd === 'prepare' && a1 && a2) await prepare(a1, a2);
else if (cmd === 'run' && a1 && a2 && a3) await run(a1, a2, a3);
else { console.error('usage: localnet-run.ts prepare <dir> <treasury> | run <evidence.json> <authority.json> <treasury>'); process.exit(2); }
