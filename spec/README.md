# Project QF — Specification Package (codename QUOTEFORGE)

Status: **V0 offline implementation in progress** (amended 2026-09-27). Readiness per stage (ADR-011): OFFLINE_V0 ACTIVE · LOCALNET_INTEGRATION BLOCKED · DEVNET_INTEGRATION BLOCKED · MAINNET BLOCKED. No production implementation, no chain writes. Code lives in `../project-qf/`.

Project QF is a proprietary **Launch Intelligence + Execution System**. V1 answers, for Solana + Meteora DBC only: *which quote asset, curve, fees, graduation threshold and reward structure best fit a proposed launch under measurable constraints* — then simulates and executes it non-custodially.

## Layout
```
CLAUDE.md                     agent rules (binding)
README.md                     this file
PROPRIETARY-NOTICE.md         ownership notice for original QF code
THIRD_PARTY_NOTICES.md        upstream notices to preserve
LICENSE-MANIFEST.json         license allow/deny policy + pinned dependency licenses
sbom/                         planned-dependency SBOM (superseded by ../project-qf/sbom/*.cdx.json, generated from the lockfile)
tools/program-verify/         read-only on-chain verification diagnostic (v0.2.0, own lockfile, tests)
docs/                         specification documents (index below)
docs/DECISIONS/               ADR-001 … ADR-013 (ADR-002/003/004/007 amended 2026-09-27)
docs/simulations/             simulation-only reports (fee scheduler comparison)
docs/verification/            dated program verification results
SPEC-VALIDATION-REPORT.md     cross-document consistency gate
RETURN-REPORT.md              section-32 return report for the product owner (2026-09-26)
RETURN-REPORT-V0.md           V0 decisions and offline implementation report (2026-09-27)
```

## Document index
| Area | Documents |
|---|---|
| Product | VISION, PRODUCT, PAIN-POINT, ROADMAP |
| Specification | SPEC, ARCHITECTURE, PROTOCOL |
| Assets | QUOTE-ASSETS, CANONICAL-ASSETS, TOKEN-2022 |
| Execution | METEORA, CONFIG-REGISTRY, POLICY-ENGINE, ECONOMICS |
| Rewards | REWARDS |
| Data & intelligence | DATA-PROVIDERS, DATA-LICENSES, ASSET-GRAPH, OPPORTUNITY-ENGINE, AI-ENGINE, AGENTS |
| Security & legal | SECURITY, THREAT-MODEL, LICENSES, COMPLIANCE, DEPENDENCIES |
| Delivery | TESTING, DEVNET, PROGRAM-VERIFICATION, DEPLOYMENT |

## Evidence labels
FACT (verified in source/license/first-party docs, with citation) · DOCUMENTED LIMITATION · INFERENCE · UNVERIFIED · DECISION (made by the product owner on 2026-09-26).

Predecessor: `../V1-ARCHITECTURE-REVIEW.md`.
