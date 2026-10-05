// Separate readiness stages (ADR-011). A stage is ACTIVE only when its own gates
// have evidence; an approved exception for one stage never makes another READY.
// READ_ONLY_VERIFICATION added 2026-09-27 (repair pass, ADR-011 amendment): read-only program/config evidence is its
// own stage, distinct from OFFLINE tests and from any LOCALNET/DEVNET/MAINNET integration.
export const STAGES = ['OFFLINE_V0', 'READ_ONLY_VERIFICATION', 'LOCALNET_INTEGRATION', 'DEVNET_INTEGRATION', 'MAINNET'] as const;
export type Stage = (typeof STAGES)[number];
export type StageStatus = 'ACTIVE' | 'BLOCKED';

interface StageRecord { readonly status: StageStatus; readonly scope: string; readonly blockers: readonly string[] }

const f = <T extends object>(o: T): Readonly<T> => Object.freeze(o);

export const READINESS: Readonly<Record<Stage, Readonly<StageRecord>>> = f({
  OFFLINE_V0: f({
    status: 'ACTIVE',
    scope: 'QF-original code and tests with fixtures, fake providers and MOCK UI; no blockchain integration claims',
    blockers: f([]),
  }),
  READ_ONLY_VERIFICATION: f({
    status: 'BLOCKED',
    scope: 'read-only verifier (tools/program-verify 0.4.0) against genesis-validated mainnet and devnet public RPC plus verify.osec.io; evidence COLLECTION is authorized on the owner\'s own computer and network (decision 2026-09-27); no wallet, key, airdrop, simulation, transaction or attestation',
    blockers: f([
      'RO-1 owner-network run not yet returned: the cloud sandbox denies Solana RPC hosts (403), so no live evidence exists; collection is authorized, success is not assumed',
      'RO-2 live Customizable config values unverified: the authority and Dynamic-type rules are CONFIRMED_FOR_PINNED_SOURCE and the authority PDA is CONFIRMED_OFFLINE, but the deployed account must still be read',
      'RO-3 a complete, exit-0 report is evidence for this stage only; it is not LOCALNET, DEVNET or MAINNET readiness',
    ]),
  }),
  LOCALNET_INTEGRATION: f({
    status: 'BLOCKED',
    scope: 'solana-test-validator with Meteora DBC / DAMM v2 program copies',
    blockers: f([
      'LOCAL-1 written Meteora permission covering local program copies, source builds, CI caching (Meteora licence personal-testing clause excludes anticipated commercial application)',
      'LOCAL-2 artifact provenance for any program binary / account snapshot',
      'LOCAL-3 compatible tooling (Agave 3.x) and cloned configs identified by read-only verification',
    ]),
  }),
  DEVNET_INTEGRATION: f({
    status: 'ACTIVE',
    scope: 'public devnet with disposable test wallets and valueless TEST_ONLY assets. Opened 2026-10-03T21:06:00Z by the product owner (Jeremy Gephart, "unblock devnet" in the launchpad thread), standing in for DEV-3 on devnet only. DEV-1: devnet read-only verification ran 2026-10-03 (single provider; F7 devnet program bytes differ from mainnet, so devnet results are not mainnet evidence). DEV-2: the launchpad adapter pins the devnet genesis hash, refuses mainnet and requires MAINNET_WRITES=false; operator key is a throwaway generated outside git',
    blockers: f([]),
  }),
  MAINNET: f({
    status: 'BLOCKED',
    scope: 'production',
    blockers: f(['P0-M1..P0-M7 (DEPLOYMENT.md §2)', 'MAINNET_WRITES=false', 'REWARDS_SETTLEMENT_MAINNET=false',
      'DEV-3 review of deployed-service terms for commercial use (owner waived it for devnet only on 2026-10-03; still required before mainnet)',
      'IDX-1 trade history at production volume: signature listing stops at 5,000 per pool per pass (logged when hit); before relying on it, unread ranges must stay recoverable and history coverage must report the truncation (Astra, milestone 6 review, 2026-10-05)']),
  }),
});

export function assertStageActive(stage: Stage): void {
  const r = READINESS[stage];
  if (r.status !== 'ACTIVE') throw new Error(`stage ${stage} is BLOCKED: ${r.blockers.join('; ')}`);
}
