# ROADMAP

| Phase | Content | Gate |
|---|---|---|
| Spec | This package | SPEC-VALIDATION-REPORT PASS (done 2026-09-26) |
| V0 offline (now) | QF-original code and tests, mocks labelled | OFFLINE_V0 ACTIVE (ADR-011) |
| V0 private read-only milestone (2026-10-03) | Quote Asset Inspector + Saved Creator Draft: mint inspection over read-only RPC, stored digest-bound reports, creator drafts with policy references, measured feature components. No wallet, signing, chain writes or public deployment | Built and tested offline and with TEST_ONLY fixtures; **live acceptance blocked** until permitted reads succeed (network allowlist, two independent providers, provider terms). Review: Astra |
| V0 localnet | DEVNET.md on localnet | LOCAL-1..3 (ADR-013 permission, provenance, tooling) |
| V0 devnet | DEVNET.md on public devnet | DEV-1..3 (verification with genesis, cluster safety, terms) |
| V1.0 beta | Mainnet, `STANDARD_V1`, SPL base, TRADING_FEE accrual; settlement gated | DEPLOYMENT.md §2 |
| V1.0 rewards | Mainnet Merkle settlement | REWARDS.md §6 |
| V1.1 | `DBC_BASE_TRANSFER_FEE` | ADR-003 (8 conditions; capability-based: tracks a released SDK with 0.2.2 support, proposed as 1.6.0 in PR #116, not a major version) |
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

## Amendment 2026-10-03 — added open items
11. **bigint-buffer exit path.** Upstream-first removal investigation, then a bounded client-layer proof for one decode or instruction-build path; see DEPENDENCIES.md, amendment 2026-10-03. Not adopted; V0 keeps the patched, isolated adapter.
12. **Inspector live acceptance.** This needs:
    - network access to the chosen RPC hosts;
    - a second independent mainnet provider, so S1.12 can PASS;
    - provider data terms;
    - TokenBadge lookup (S1.7);
    - the program-account exclusion (S3.4);
    - pool, route and volume sources (S3.1–S3.3).
    Until then, a LIVE inspection cannot reach PASS by design.
