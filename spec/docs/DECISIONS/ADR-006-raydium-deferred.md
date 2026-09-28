# ADR-006: Raydium deferred; no GPL SDK

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Remove Raydium from V1's executable dependency graph. Do not use `@raydium-io/raydium-sdk-v2` (GPL-3.0, 0.2.73-alpha). Keep only a `RaydiumEngineAdapter` interface stub that throws `NotImplemented`. No Raydium service or repository in V1. V2 may investigate direct instruction/IDL integration against Apache-2.0 Raydium programs (CPMM `raydium-cp-swap`, CLMM `raydium-clmm`); LaunchLab license is UNKNOWN.

## Rationale
Raydium is not needed to prove Project QF; avoiding GPL removes distribution risk.

## Consequences
Single-engine dependency on Meteora in V1 (accepted, see ADR-002).
