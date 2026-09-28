# ROADMAP

| Phase | Content | Gate |
|---|---|---|
| Spec | This package | SPEC-VALIDATION-REPORT PASS (done 2026-09-26) |
| V0 offline (now) | QF-original code and tests, mocks labelled | OFFLINE_V0 ACTIVE (ADR-011) |
| V0 localnet | DEVNET.md on localnet | LOCAL-1..3 (ADR-013 permission, provenance, tooling) |
| V0 devnet | DEVNET.md on public devnet | DEV-1..3 (verification with genesis, cluster safety, terms) |
| V1.0 beta | Mainnet, `STANDARD_V1`, SPL base, TRADING_FEE accrual; settlement gated | DEPLOYMENT.md §2 |
| V1.0 rewards | Mainnet Merkle settlement | REWARDS.md §6 |
| V1.1 | `DBC_BASE_TRANSFER_FEE` | ADR-003 (8 conditions) |
| V2 | Raydium adapter via Apache-2.0 program IDLs (no GPL SDK); BYO partner configs; more templates; Jupiter if legally cleared | ADR-005/006 |
| Later | EVM (PONS-style research only until licensing/audit clear); tokenized-asset compliance track | Separate ADRs |

## Open items carried (not decided in this package)
1. ~~Migration threshold ceiling (`ceilUsd`)~~ — decided 2026-09-27: $100,000 V0 experimentation ceiling only.
2. ~~`liquidityFailUsd`~~ — decided 2026-09-27: $25,000, experimental validator-v0.1.
2a. ~~`evidence-v0.1` freshness values (proposed V0_TEST), `pako` Zlib licence review,~~ (both decided 2026-09-27: EV-1 V0_TEST analytical only; LIC-R1 exact exception QF-LIC-EX-002) written Meteora permission for local program copies (ADR-013).
3. Social/news and GitHub data providers + licenses.
4. Official bridge registry endpoints per bridge.
5. LLM provider/model selection.
6. Graph storage technology.
7. Record retention periods; bug bounty; incident runbook.
8. Jurisdiction list and sanctions-screening requirement (counsel).
9. Final product name.
10. Production economic percentages (simulation-controlled).
