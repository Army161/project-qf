// Which network the launchpad runs on, and what it may do there. Devnet is the working launchpad. Mainnet runs read-only
// (DEPLOYMENT.md "staging": mainnet read-only, no keys): it reads real mainnet accounts, cross-checked against a second
// RPC provider, and refuses every launch, trade, claim, treasury step and faucet request. This build has no mainnet write
// path at all; turning mainnet on is a reviewed code change after the DEPLOYMENT.md §2 gate, not a setting.
import { CAPABILITY_FLAGS, READINESS } from '@project-qf/core';
import { PROGRAM_IDS } from '@project-qf/tx';
import { USDC_MAINNET, crossCheckAccounts, type CrossCheck, type CrossCheckItem } from '@project-qf/adapter-meteora-dbc/launchpad';
import type { DevnetConnection as Connection } from '@project-qf/adapter-meteora-dbc/launchpad';

export type ClusterName = 'devnet' | 'mainnet-beta';
export type LaunchpadMode = 'DEVNET' | 'MAINNET_READ_ONLY';
export interface ClusterProfile {
  cluster: ClusterName;
  mode: LaunchpadMode;
  /** may the server build transactions for people to sign, and send them */
  writes: boolean;
  faucet: boolean;
  /** shown next to every amount */
  label: string;
  /** why writes are off, in words (empty when they are on) */
  writesLockedBecause: string[];
  /** mainnet: the quote token new launches would use; devnet: the platform's own TEST_ONLY token (from the platform record) */
  quote: { mint: string; decimals: number; symbol: string } | null;
  rpc: string;
  rpc2: string | null;
  /** default store file: devnet and mainnet never share a database */
  defaultDb: string;
}

const DEFAULT_RPC: Record<ClusterName, string> = { devnet: 'https://api.devnet.solana.com', 'mainnet-beta': 'https://api.mainnet-beta.solana.com' };

/** The profile for this process, from its environment: QF_CLUSTER (devnet | mainnet-beta, default devnet), QF_RPC_URL
 *  (QF_RPC_DEVNET still works on devnet), QF_RPC_URL_2 (second provider; required for any mainnet decision). */
export function profileFromEnv(env: Record<string, string | undefined>, readiness = READINESS, flags = CAPABILITY_FLAGS): ClusterProfile {
  const cluster = (env.QF_CLUSTER ?? 'devnet') as ClusterName;
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new Error(`QF_CLUSTER must be devnet or mainnet-beta, not ${String(env.QF_CLUSTER)}`);
  const rpc = env.QF_RPC_URL || (cluster === 'devnet' ? env.QF_RPC_DEVNET : undefined) || DEFAULT_RPC[cluster]; // an empty setting counts as unset
  const rpc2 = env.QF_RPC_URL_2 || null;
  if (cluster === 'devnet') {
    const ok = readiness.DEVNET_INTEGRATION.status === 'ACTIVE';
    return { cluster, mode: 'DEVNET', writes: ok, faucet: ok, label: 'TEST_ONLY devnet tokens with no value', quote: null, rpc, rpc2, defaultDb: 'qf-launchpad.sqlite',
      writesLockedBecause: ok ? [] : [`DEVNET_INTEGRATION is ${readiness.DEVNET_INTEGRATION.status}`] };
  }
  const why = [
    'this build has no mainnet write path: its mainnet RPC connections refuse every send',
    ...((flags.MAINNET_WRITES as boolean) !== true ? ['MAINNET_WRITES is false'] : []),
    ...(readiness.MAINNET.status !== 'ACTIVE' ? [`readiness MAINNET is ${readiness.MAINNET.status} with ${readiness.MAINNET.blockers.length} open items (the owner's gate, DEPLOYMENT.md §2)`] : []),
    ...(rpc2 ? [] : ['no second RPC provider (QF_RPC_URL_2): mainnet decisions need two']),
    ...(env.MAINNET_WRITES === 'true' ? ['MAINNET_WRITES=true in the environment is ignored: the switch is a reviewed code change, not a setting'] : []),
  ];
  return { cluster, mode: 'MAINNET_READ_ONLY', writes: false, faucet: false, label: 'Mainnet, read-only: nothing can be launched, traded or claimed here yet',
    quote: { ...USDC_MAINNET }, rpc, rpc2, defaultDb: 'qf-launchpad-mainnet.sqlite', writesLockedBecause: why };
}

/** What a mainnet launchpad stands on, read from chain at startup: the quote mint and the three programs. */
export function mainnetChainItems(quote: { mint: string; decimals: number }): CrossCheckItem[] {
  const program = (address: string, label: string): CrossCheckItem => ({ address, label, pick: (i) => ({ owner: i.owner, executable: i.executable }) });
  return [
    { address: quote.mint, label: `quote mint (${quote.decimals} decimals expected)`, pick: (i) => mintFields(i.owner, i.data) },
    program(PROGRAM_IDS.DBC, 'Meteora Dynamic Bonding Curve program'),
    program(PROGRAM_IDS.DAMM_V2, 'Meteora DAMM v2 program'),
    program(PROGRAM_IDS.SQUADS_V4, 'Squads v4 multisig program (platform treasury)'),
  ];
}

/** SPL mint layout: mint authority option (36), supply (8), decimals (1), initialized (1), freeze authority option (36). Supply
 *  moves every few slots and is left out so two providers can agree. */
export function mintFields(owner: string, d: Buffer) {
  if (d.length < 82) return { owner, error: `not a mint (${d.length} bytes)` };
  const opt = (at: number) => (d.readUInt32LE(at) === 1 ? encodeKey(d.subarray(at + 4, at + 36)) : null);
  return { owner, decimals: d[44]!, initialized: d[45] === 1, mintAuthority: opt(0), freezeAuthority: opt(46) };
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeKey(b: Uint8Array) {
  let x = 0n; for (const v of b) x = x * 256n + BigInt(v);
  let s = ''; while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; }
  for (const v of b) { if (v) break; s = '1' + s; }
  return s;
}

export interface ChainChecks { at: string; crossChecked: boolean; ok: boolean; items: CrossCheck[]; problems: string[] }
/** Startup checks for mainnet: each item read from both providers; anything but MATCH (or SINGLE_PROVIDER with one
 *  provider) is a problem, and so is a quote mint that is not what the profile says. */
export async function mainnetChainChecks(a: Connection, b: Connection | null, quote: { mint: string; decimals: number }, now = () => new Date()): Promise<ChainChecks> {
  const items = await crossCheckAccounts(a, b, mainnetChainItems(quote));
  const problems: string[] = [];
  for (const i of items) if (i.status !== 'MATCH' && i.status !== 'SINGLE_PROVIDER') problems.push(`${i.label}: ${i.status}${i.detail ? ` (${i.detail})` : ''}`);
  const mint = items[0]?.value as { owner?: string; decimals?: number; initialized?: boolean } | null;
  if (mint && (mint.owner !== PROGRAM_IDS.TOKEN || mint.decimals !== quote.decimals || mint.initialized !== true)) problems.push(`quote mint is not a ${quote.decimals}-decimal SPL Token mint`);
  for (const i of items.slice(1)) if (i.value && (i.value as { executable?: boolean }).executable !== true) problems.push(`${i.label} is not executable`);
  return { at: now().toISOString(), crossChecked: !!b, ok: problems.length === 0, items, problems };
}
