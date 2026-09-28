// Adapter compatibility tests (Decision 4 gate): the pinned SDKs import (CJS + ESM), build curves,
// quote, and construct createConfig / createPool / swap / migration / fee-claim transactions with
// `chain` removed. Transactions are built against MOCK RPC fixtures and are never signed or sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BN from 'bn.js';
import * as dbc from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey, Transaction } from '@solana/web3.js';
import { ECONOMICS_V0_TEST, STANDARD_V1_FLAT_V0_TEST, DECAY_EXPERIMENT_V0_SIM } from '@project-qf/policy';
import { decodeTransactionBytes, verifyTransactionPreview, PROGRAM_IDS, type IntentKind } from '@project-qf/tx';
import { ADAPTER_PINS, DAMM_V2_CUSTOMIZABLE_CONFIG, buildCurveConfig, createDbcClient, rawToUiString, serializeUnsigned } from '../src/index.ts';
import { MOCK_RPC_LABEL, createMockConnection, mockKey } from './support/mockRpc.ts';
import { BLOCKHASH, buildFixtureTx, consentFor, fixtures, termsFor, thresholdRecord } from './support/fixtures.ts';

const require = createRequire(import.meta.url);
const pkgDir = dirname(new URL(import.meta.url).pathname) + '/..';
const node = (args: string[]) => execFileSync(process.execPath, args, { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('pins: installed SDK versions are exactly the pinned ones', () => {
  const v = (n: string) => JSON.parse(readFileSync(join(dirname(require.resolve(n)), '..', 'package.json'), 'utf8')).version;
  assert.equal(`@meteora-ag/dynamic-bonding-curve-sdk@${v('@meteora-ag/dynamic-bonding-curve-sdk')}`, ADAPTER_PINS.dbcSdk);
  assert.equal(`@meteora-ag/cp-amm-sdk@${v('@meteora-ag/cp-amm-sdk')}`, ADAPTER_PINS.cpAmmSdk);
  const w3 = JSON.parse(readFileSync(join(dirname(require.resolve('@solana/web3.js')), '..', 'package.json'), 'utf8')).version;
  assert.equal(`@solana/web3.js@${w3}`, ADAPTER_PINS.web3js);
});

test('CJS require of both SDKs works and loads no module named chain', () => {
  const out = node(['-e', `
    const d = require('@meteora-ag/dynamic-bonding-curve-sdk'); const c = require('@meteora-ag/cp-amm-sdk');
    const loaded = Object.keys(require.cache).filter((p) => /[\\\\/]node_modules[\\\\/]chain[\\\\/]/.test(p));
    console.log(JSON.stringify({ buildCurve: typeof d.buildCurve, client: typeof d.DynamicBondingCurveClient, cpAmm: typeof c.CpAmm, chainLoaded: loaded.length }));`]);
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()!), { buildCurve: 'function', client: 'function', cpAmm: 'function', chainLoaded: 0 });
});

test('ESM import of both SDKs works', () => {
  const out = node(['--input-type=module', '-e', `
    const d = await import('@meteora-ag/dynamic-bonding-curve-sdk'); const c = await import('@meteora-ag/cp-amm-sdk');
    console.log(JSON.stringify({ buildCurve: typeof d.buildCurve, cpAmm: typeof c.CpAmm }));`]);
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()!), { buildCurve: 'function', cpAmm: 'function' });
});

test('chain is not resolvable from the cp-amm-sdk package and is not needed at runtime', () => {
  const cpDir = dirname(require.resolve('@meteora-ag/cp-amm-sdk'));
  assert.throws(() => createRequire(join(cpDir, 'x.js')).resolve('chain'), /Cannot find module/);
  // the unmodified published manifest still declares it (evidence of what was removed)
  const pj = JSON.parse(readFileSync(join(cpDir, '..', 'package.json'), 'utf8'));
  assert.equal(pj.dependencies.chain, '^0.4.0');
});

test('buildCurve: flat V0_TEST config is valid per SDK and stores the approved raw threshold exactly', () => {
  const rec = thresholdRecord();
  const cfg = buildCurveConfig(STANDARD_V1_FLAT_V0_TEST, ECONOMICS_V0_TEST, rec);
  assert.equal(cfg.migrationQuoteThreshold.toString(), '5000000000');
  assert.equal(cfg.poolFees.baseFee.cliffFeeNumerator.toString(), '10000000'); // 100 bps of 1e9
  assert.equal(cfg.poolFees.dynamicFee, null);
  assert.equal(cfg.tokenUpdateAuthority, dbc.TokenAuthorityOption.Immutable);
  assert.equal(cfg.creatorLiquidityPercentage + cfg.partnerLiquidityPercentage, 0);
  assert.doesNotThrow(() => dbc.validateConfigParameters({ ...cfg, leftoverReceiver: mockKey('leftover') } as never));
});

test('buildCurve: the bounded decay config is valid per SDK (simulation only)', () => {
  const cfg = buildCurveConfig(DECAY_EXPERIMENT_V0_SIM, ECONOMICS_V0_TEST, thresholdRecord());
  assert.equal(cfg.poolFees.baseFee.cliffFeeNumerator.toString(), '250000000'); // 2500 bps
  assert.equal(cfg.poolFees.baseFee.firstFactor, 12);                          // numberOfPeriod
  assert.doesNotThrow(() => dbc.validateConfigParameters({ ...cfg, leftoverReceiver: mockKey('leftover') } as never));
});

test('fail closed: a threshold the SDK cannot store exactly is refused', () => {
  const rec = { ...thresholdRecord(), quoteDecimals: 9, rawQuoteThreshold: '99999999999999999' };
  assert.equal(rawToUiString(BigInt(rec.rawQuoteThreshold), 9), '99999999.999999999'); // a double would round this to 100000000
  assert.throws(() => buildCurveConfig(STANDARD_V1_FLAT_V0_TEST, ECONOMICS_V0_TEST, rec), /FAIL_CLOSED/);
});

test('quote math (pure SDK, no RPC): flat 1% fee, protocol takes 20% of it', () => {
  const cfg = buildCurveConfig(STANDARD_V1_FLAT_V0_TEST, ECONOMICS_V0_TEST, thresholdRecord());
  const client = createDbcClient(createMockConnection(new Map()).connection);
  const q = client.pool.getQuoteFromInputAmount({ config: cfg as never, swapBaseForQuote: false, amountIn: new BN(1_000_000_000) });
  const total = q.tradingFee.add(q.protocolFee);
  assert.equal(total.toString(), '10000000');
  assert.equal(q.protocolFee.toString(), '2000000');
  assert.ok(q.outputAmount.gtn(0));
});

// ---------- transaction construction against MOCK RPC fixtures, bound to approved terms ----------
async function checkTx(kind: IntentKind, expectIx: string) {
  const { tx, feePayer, signer, cfgParams, program, unsupported } = await buildFixtureTx(kind);
  const bytes = serializeUnsigned(tx, feePayer, BLOCKHASH);
  const d = decodeTransactionBytes(bytes);          // independent browser-safe decoder (Solana Kit)
  const terms = await termsFor(kind, cfgParams);
  const r = await verifyTransactionPreview(d, { kind, feePayer: feePayer.toBase58(), signerAddress: signer.toBase58(), terms, consent: await consentFor(terms) });
  assert.deepEqual(r.violations, [], kind);
  assert.match(String(r.messageDigest), /^[0-9a-f]{64}$/);
  const dbcIx = d.instructions.filter((ix) => ix.programAddress === PROGRAM_IDS.DBC);
  const names = dbcIx.map((ix) => program.coder.instruction.decode(Buffer.from(ix.dataHex, 'hex'))?.name);
  assert.ok(names.includes(expectIx), `${kind}: expected ${expectIx}, got ${names}`);
  for (const n of names) assert.doesNotMatch(String(n), /TransferHook|config2/i, 'no 0.2.2 / transfer-hook instruction');
  assert.deepEqual(unsupported, []);
  return d;
}

test(`tx construction [${MOCK_RPC_LABEL}]: createConfig (partner) -> DBC createConfig`, async () => { await checkTx('CREATE_CONFIG', 'createConfig'); });
test(`tx construction [${MOCK_RPC_LABEL}]: createPool (creator) -> initializeVirtualPoolWithSplToken`, async () => { await checkTx('CREATE_POOL', 'initializeVirtualPoolWithSplToken'); });
test(`tx construction [${MOCK_RPC_LABEL}]: swap (user) -> DBC swap`, async () => { await checkTx('SWAP', 'swap'); });
test(`tx construction [${MOCK_RPC_LABEL}]: migrateToDammV2 (crank) -> migrationDammV2 with Customizable config`, async () => {
  const d = await checkTx('MIGRATE_DAMM_V2', 'migrationDammV2');
  const ix = d.instructions.find((x) => x.programAddress === PROGRAM_IDS.DBC)!;
  assert.ok(ix.accounts.includes(DAMM_V2_CUSTOMIZABLE_CONFIG.toBase58()), 'DAMM v2 config passed as remaining account');
  assert.ok(ix.accounts.includes(PROGRAM_IDS.DAMM_V2));
});
test(`tx construction [${MOCK_RPC_LABEL}]: claimPartnerTradingFee -> claimTradingFee`, async () => { await checkTx('CLAIM_PARTNER_TRADING_FEE', 'claimTradingFee'); });
test(`tx construction [${MOCK_RPC_LABEL}]: claimCreatorTradingFee -> claimCreatorTradingFee`, async () => { await checkTx('CLAIM_CREATOR_TRADING_FEE', 'claimCreatorTradingFee'); });

test('the pinned SDK IDL has no DBC 0.2.2 create_config2 instruction (transfer-fee stays disabled)', () => {
  const { program } = fixtures();
  const names = ((program.idl as unknown as { instructions: { name: string }[] }).instructions).map((i) => i.name);
  assert.equal(names.includes('createConfig2'), false);
  assert.ok(names.includes('createConfig'));
});

test('mock RPC refuses anything that could submit', async () => {
  const { connection } = createMockConnection(new Map());
  await assert.rejects(connection.sendRawTransaction(Buffer.from([1, 2, 3])), /not implemented|MOCK/);
});
