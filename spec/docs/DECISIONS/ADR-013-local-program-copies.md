# ADR-013: No local copies of Meteora programs until permission is written

- Status: **Accepted** (2026-09-27; licensing uncertainty, not a finding of infringement)

## Context
The Meteora program licence's personal research and testing permission excludes anticipated commercial application. The SDKs' MIT licence explicitly does not cover the on-chain programs. Private commercial R&D is therefore not assumed to be permitted.

## Decision
Until Meteora (or counsel) answers in writing, QF does not:
- clone DBC or DAMM v2 program accounts or binaries into `solana-test-validator`;
- build the programs from source (including reproducible-build verification);
- cache program artifacts in CI;
- redistribute them in any form.

The written answer must cover each of these separately:
1. Commercial service interaction with the deployed programs.
2. Local test copies.
3. Source builds.
4. CI caching.
5. Distribution.

## Consequences
- `LOCALNET_INTEGRATION` is BLOCKED on LOCAL-1 (ADR-011).
- The verifier reports SOURCE_BUILD as `NOT_ATTEMPTED`.
- Meanwhile QF works on QF-original mocks and permitted SDK client use: transaction construction against a labelled mock RPC, and SDK quote math in simulation.
- DEVNET.md Step 0 cloning instructions are suspended.
- Public devnet use must also follow the deployed service's terms. It does not replace the commercial-use gate (P0-M1).
