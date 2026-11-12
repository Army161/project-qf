// One process serves one network: the deployment it picks moves every address, builder and decoder to that network's
// programs, a mainnet deployment refuses test-build and Raydium ids, and the choice cannot change once made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/index.ts';

const MAINNET = { curve: 'QfCurveMa1nnet11111111111111111111111111111', pool: 'QfPoo1Ma1nnet111111111111111111111111111111', poolFeeReceiver: 'QfFeeMa1nnet1111111111111111111111111111111' };

test('a mainnet deployment refuses test-build, Raydium and repeated ids', () => {
  assert.throws(() => E.mainnetDeployment({ ...MAINNET, curve: E.DEPLOYMENTS.devnet.curve }), /test build or another program/);
  assert.throws(() => E.mainnetDeployment({ ...MAINNET, pool: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' }), /test build or another program/);
  assert.throws(() => E.mainnetDeployment({ ...MAINNET, poolFeeReceiver: E.IDL_BUILD.poolFeeReceiver }), /test build or another program/);
  assert.throws(() => E.mainnetDeployment({ ...MAINNET, pool: MAINNET.curve }), /must differ/);
  assert.throws(() => E.mainnetDeployment({ ...MAINNET, curve: 'not-an-address' }), /not an address/);
  assert.equal(E.mainnetDeployment(MAINNET).cluster, 'mainnet-beta');
});

test('picking a deployment moves the builders, the derived addresses and the decoders to its programs, once', async () => {
  const before = await E.globalAddress();
  E.useDeployment(E.deploymentFor('devnet'));
  assert.equal(E.QF_CURVE, E.DEPLOYMENTS.devnet.curve);
  assert.notEqual(await E.globalAddress(), before);
  const creator = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', mint = 'GoLdenM1nt1111111111111111111111111111111111';
  const ix = await E.createLaunchIx({ creator, mint, ammConfig: await E.ammConfigAddress(0), name: 'n', symbol: 's', uri: 'u' });
  assert.equal(ix.programAddress, E.DEPLOYMENTS.devnet.curve);
  const keys = ix.accounts!.map((a) => a.address as string);
  assert.ok(keys.includes(E.DEPLOYMENTS.devnet.poolFeeReceiver), 'create_pool_fee is the deployment\'s');
  assert.ok(keys.includes(await E.permissionAddress()), 'permission derives under the deployment\'s pool program');
  assert.ok(!keys.includes(E.IDL_BUILD.curve) && !keys.includes(E.IDL_BUILD.pool) && !keys.includes(E.IDL_BUILD.poolFeeReceiver), 'no IDL-build id leaks into the instruction');
  const g = await E.graduateIx({ payer: creator, mint, ammConfig: await E.ammConfigAddress(0), creator });
  assert.ok(g.accounts!.some((a) => a.address === E.DEPLOYMENTS.devnet.poolFeeReceiver));
  const init = await E.initializeIx({ authority: creator, ammConfig: await E.ammConfigAddress(0), settings: { admin: creator, feeRecipient: creator, createPaused: true, buyPaused: false, config: E.LAUNCH_PRESETS.beta } });
  assert.ok(init.accounts!.some((a) => a.address === E.DEPLOYMENTS.devnet.curve), 'initialize names the deployment\'s curve program');
  assert.equal(E.fromIdlAddress(E.IDL_BUILD.poolFeeReceiver), E.DEPLOYMENTS.devnet.poolFeeReceiver);
  const named = Object.fromEntries(E.CURVE_IDL.instructions.find((i) => i.name === 'create_launch')!.accounts.map((a, k) => [a.name, keys[k]!]));
  assert.throws(() => E.buildFromIdl(E.CURVE_IDL, 'create_launch', { ...named, create_pool_fee: E.IDL_BUILD.poolFeeReceiver }, { name: 'n', symbol: 's', uri: 'u' }), /must be/);
  assert.throws(() => E.decodeGlobal({ owner: E.IDL_BUILD.curve, lamports: 1n, data: new Uint8Array(8) }), /owned by/);
  E.useDeployment(E.deploymentFor('devnet')); // the same choice again is fine
  assert.throws(() => E.useDeployment(E.deploymentFor('localnet')), /already chosen/);
  assert.throws(() => E.useDeployment(E.mainnetDeployment(MAINNET)), /already chosen/);
});
