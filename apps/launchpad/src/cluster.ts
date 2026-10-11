// The network the launchpad runs on, and what it may do there. This build runs on devnet only: valueless test coins, a
// throwaway operator key. Mainnet is not a setting; it comes with the QF engine after the owner's gate.
import { READINESS } from '@project-qf/core';

export interface ClusterProfile {
  cluster: 'devnet';
  mode: 'DEVNET';
  /** may the server build transactions for people to sign, and send them */
  writes: boolean;
  faucet: boolean;
  /** shown next to every amount */
  label: string;
  /** why writes are off, in words (empty when they are on) */
  writesLockedBecause: string[];
  rpc: string;
  defaultDb: string;
}

/** The profile for this process, from its environment: QF_RPC_URL (QF_RPC_DEVNET still works; default the public devnet
 *  endpoint). QF_CLUSTER, if set, must say devnet. */
export function profileFromEnv(env: Record<string, string | undefined>, readiness = READINESS): ClusterProfile {
  if (env.QF_CLUSTER && env.QF_CLUSTER !== 'devnet') throw new Error(`this build runs on devnet only (QF_CLUSTER=${env.QF_CLUSTER})`);
  const ok = readiness.DEVNET_INTEGRATION.status === 'ACTIVE';
  return { cluster: 'devnet', mode: 'DEVNET', writes: ok, faucet: ok, label: 'Test network: coins here have no value',
    rpc: env.QF_RPC_URL || env.QF_RPC_DEVNET || 'https://api.devnet.solana.com', // an empty setting counts as unset
    defaultDb: 'qf-launchpad.sqlite', writesLockedBecause: ok ? [] : [`DEVNET_INTEGRATION is ${readiness.DEVNET_INTEGRATION.status}`] };
}
