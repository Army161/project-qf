# ADR-011: Separate readiness stages

- Status: **Accepted** (2026-09-27, owner decisions relayed in the V0 decision addendum; recorded by Claude)
- Amends: RETURN-REPORT.md (2026-09-26) all-or-nothing "READY FOR V0" gate

## Decision
Readiness is tracked per stage. Approving an exception never marks everything ready.

| Stage | Status 2026-09-27 | Opens when |
|---|---|---|
| `OFFLINE_V0` | **ACTIVE** | Dependency controls pass (done: chain removal proof, licence check, browser boundary) |
| `LOCALNET_INTEGRATION` | **BLOCKED** | LOCAL-1 written permission for local program copies/builds/CI caching (ADR-013); LOCAL-2 artifact provenance (hashes tied to verified deployments); LOCAL-3 compatible tooling and configs |
| `DEVNET_INTEGRATION` | **BLOCKED** | DEV-1 read-only verification with genesis validation passes for devnet (program, loader, ProgramData, configs); DEV-2 cluster-safety checks (genesis-bound endpoint, disposable wallet with no real funds, no mainnet write capability); DEV-3 devnet service terms reviewed |
| `MAINNET` | **BLOCKED** | All existing legal, economic, security, authority and rewards-settlement gates (DEPLOYMENT.md §2, P0-M1…M7) |

The status table is code: `packages/core/src/readiness.ts` (`READINESS`, `assertStageActive`). `validateIntent` refuses LOCALNET/DEVNET intents while those stages are blocked and always refuses mainnet writes.

## Offline scope (what ACTIVE allows)
- Schemas and policies.
- Validator fixtures and boundary tests.
- Policy tests.
- Reward arithmetic.
- Transaction-intent validation and an independent transaction decoder.
- Adapter transaction construction against a **labelled MOCK RPC**.
- The mock lifecycle UI.
- The econ simulation.
- Verifier negative tests with a fake RPC.

Every mock surface carries `MOCK_BANNER`. Nothing in this stage is a blockchain integration result.

## Consequences
Work proceeds without live RPC. Live claims wait for the evidence above.

## Amendment 2026-09-27 (repair pass) — `READ_ONLY_VERIFICATION` is its own stage
| Stage | Status 2026-09-27 | Opens when |
|---|---|---|
| `READ_ONLY_VERIFICATION` | **BLOCKED** | RO-1 the repaired verifier (v0.3.0) runs from an owner-authorized network whose egress allows the chosen RPC hosts and verify.osec.io (this cloud environment returns proxy 403); RO-2 the CONFIG_COMPATIBILITY assumption (DBC pool authority as DAMM `pool_creator_authority`) is confirmed or corrected against live configs; RO-3 a complete, exit-0 JSON+Markdown report (endpoints labelled by provider, not credentials) is committed as evidence for this stage only |

It sits between `OFFLINE_V0` and the integration stages, and it is a precondition for DEV-1. It does not open LOCALNET, DEVNET or MAINNET by itself. No single PASS, exit 0 or test total promotes any stage. Code: `packages/core/src/readiness.ts`.

## Amendment 2026-09-27 (decision review) — owner-network collection authorized
- **Collection is authorized; success is not assumed.** The owner chose their own computer and ordinary network for the read-only run (public `api.mainnet.solana.com`, `api.devnet.solana.com`, and `verify.osec.io`; `registry.npmjs.org` for installation only). No proxy, TLS or geographic workaround. Evidence collection may start while results are expected to be incomplete; incomplete or failed runs stay incomplete and UNKNOWN never becomes PASS.
- **Operation envelope unchanged.** `getGenesisHash`, `getVersion`, `getAccountInfo` and OtterSec status GETs only; no wallet, key generation, airdrop, simulation, signing, transaction or attestation. Script: `spec/tools/program-verify/run-readonly-local.sh` (stops at the first failing step and logs every exit code).
- **Blockers now** (`packages/core/src/readiness.ts`): RO-1 the owner-network run has not been returned; RO-2 live Customizable config values are unverified (the rules are confirmed for the pinned source and the PDA offline); RO-3 exit 0 is evidence for this stage only.
- `READ_ONLY_VERIFICATION` stays **BLOCKED** until a complete report is returned. A passing report does not unlock DEVNET, which keeps DEV-2, DEV-3 (including the Meteora U.S. eligibility question) and SEC-A adoption on the current lockfile.
