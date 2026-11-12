// The programs and fixed accounts the QF engine uses. The two engine programs exist once per network (a deployment);
// everything that names them reads the active deployment below, so one build of the app serves exactly one network.
// The rest are Solana's own program ids.
import { CURVE_IDL, POOL_IDL } from './idl.ts';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
/** Wrapped SOL: the quote mint of SOL-quoted coins. */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
/** Every coin the curve creates is a Token-2022 mint with 6 decimals (qf-curve state.rs BASE_DECIMALS). */
export const BASE_DECIMALS = 6;

export type EngineCluster = 'localnet' | 'devnet' | 'mainnet-beta';
/** One deployment of the engine: its two program ids and the pool program's compile-time pool-creation-fee account. */
export interface EngineDeployment {
  cluster: EngineCluster;
  /** qf-curve: create a coin, trade it on the curve, graduate it, pay fees. */
  curve: string;
  /** qf-pool: Project QF's fork of raydium-cp-swap (Apache-2.0), where graduated coins trade. */
  pool: string;
  /** The pool program's pool-creation-fee account; create_launch and graduate pass it as `create_pool_fee`. */
  poolFeeReceiver: string;
}

const createPoolFeeInIdl = CURVE_IDL.instructions.find((i) => i.name === 'create_launch')?.accounts.find((a) => a.name === 'create_pool_fee')?.address;
if (!createPoolFeeInIdl) throw new Error('the pinned curve IDL has no fixed create_pool_fee account');
/** The ids compiled into the pinned IDLs (the engine's default-feature build). Instruction builders translate these to
 *  the active deployment's ids. */
export const IDL_BUILD: Readonly<EngineDeployment> = Object.freeze({ cluster: 'localnet', curve: CURVE_IDL.provenance.programId, pool: POOL_IDL.provenance.programId, poolFeeReceiver: createPoolFeeInIdl });

/** The deployments this app knows. Mainnet has none built in: its ids come from the owner's keys (mainnetDeployment). */
export const DEPLOYMENTS = Object.freeze({
  /** The default-feature build on a local validator (packages/engine/scripts/localnet.sh). */
  localnet: IDL_BUILD,
  /** Devnet v2 (engine commit 5291cd4 and later), built with throwaway devnet keys: the pool fee receiver is the devnet
   *  treasury D4GdbP8hUKpMhvdHNxYXdM44te57f12DFKwpJ6N2VWNK's wrapped-SOL account. The 2026-10-11 devnet programs
   *  (CaX3…/FHG8…) have the older account layout and are retired. */
  devnet: Object.freeze<EngineDeployment>({ cluster: 'devnet', curve: '6z9p6QT8SQFuqnvJUSyoa7Hdye9wmL8kwYmK9tAPX2Gb', pool: '5hMEQ3sLiYnVMBo1rAEzRhNHgwR6ufNkpNsgYkk13nMD', poolFeeReceiver: 'C9jn6vQrBaf9Xt2bSdC53HPJkThSw1kTfrEqCJHrrr7t' }),
});

/** Ids that must never be taken for a mainnet deployment: the test builds' and Raydium's own (mainnet CPMM and its fee receiver). */
const NOT_MAINNET = new Set([
  ...Object.values(DEPLOYMENTS).flatMap((d) => [d.curve, d.pool, d.poolFeeReceiver]),
  'CaX3gfwE1y3AustJ5e2JQFmaDtXB5oeX6ayvNzLGsFoX', 'FHG8GyPytpydCRFL6yvwu92vyWSk7bSYZknyLn3v6ewU', 'BYSX6JVNMtMEyqbxkgJgnXMrWYVpftU4oxR25CKwmXeA',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8', SYSTEM, TOKEN, TOKEN_2022, ASSOCIATED_TOKEN, NATIVE_MINT,
]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The owner's mainnet deployment (mainnet/keys.json in the engine repo: curve_program_id, pool_program_id and the
 *  treasury's wrapped-SOL account the pool build compiles in). Refuses test-build, Raydium and repeated ids. */
export function mainnetDeployment(p: { curve: string; pool: string; poolFeeReceiver: string }): EngineDeployment {
  const ids = [p.curve, p.pool, p.poolFeeReceiver];
  for (const id of ids) {
    if (typeof id !== 'string' || !BASE58.test(id)) throw new Error(`mainnet deployment: ${String(id)} is not an address`);
    if (NOT_MAINNET.has(id)) throw new Error(`mainnet deployment: ${id} belongs to a test build or another program`);
  }
  if (new Set(ids).size !== 3) throw new Error('mainnet deployment: the three ids must differ');
  return Object.freeze({ cluster: 'mainnet-beta', curve: p.curve, pool: p.pool, poolFeeReceiver: p.poolFeeReceiver });
}

// The active deployment. These are live bindings: every module that imports them sees the current values.
let active: EngineDeployment = IDL_BUILD;
export let QF_CURVE = IDL_BUILD.curve;
export let QF_POOL = IDL_BUILD.pool;
/** The pool program's pool-creation-fee account in the active deployment. */
export let POOL_FEE_RECEIVER = IDL_BUILD.poolFeeReceiver;
/** Picks the deployment for this process (the server after proving its network, the page from its build). Once only:
 *  switching networks in a running process is refused. */
let chosen = false;
export function useDeployment(d: EngineDeployment): void {
  if (chosen) { if (d.curve === active.curve && d.pool === active.pool && d.poolFeeReceiver === active.poolFeeReceiver && d.cluster === active.cluster) return; throw new Error('the engine deployment is already chosen for this process'); }
  if (d.cluster === 'mainnet-beta') mainnetDeployment(d);
  active = Object.freeze({ ...d }); QF_CURVE = d.curve; QF_POOL = d.pool; POOL_FEE_RECEIVER = d.poolFeeReceiver; chosen = true;
}
export const activeDeployment = (): Readonly<EngineDeployment> => active;
/** The built-in deployment for a test network; mainnet needs mainnetDeployment(). */
export function deploymentFor(cluster: 'localnet' | 'devnet'): EngineDeployment { return DEPLOYMENTS[cluster]; }

/** A fixed address recorded in a pinned IDL, translated to the active deployment. */
export const fromIdlAddress = (a: string) => (a === IDL_BUILD.curve ? QF_CURVE : a === IDL_BUILD.pool ? QF_POOL : a === IDL_BUILD.poolFeeReceiver ? POOL_FEE_RECEIVER : a);
