# ADR-008: Private IP boundary

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
The moat is off-chain: Registry, Asset Graph, feature store, scoring versions/weights, validator thresholds, risk models, launch optimization, prompts, agent orchestration, fraud heuristics, outcome dataset, internal APIs, deployment automation. No secret logic on-chain. Intelligence code/data lives in restricted `project-qf-intelligence`. Original QF code is proprietary (PROPRIETARY-NOTICE.md); no open-source license is added; upstream notices are preserved (THIRD_PARTY_NOTICES.md); no GPL/BUSL/non-commercial code is copied into QF source. Data enters the Asset Graph only through `DataLicensePolicy`.

## Rationale
On-chain parameters are public and reverse-engineerable; value is in choosing them and learning from outcomes.

## Consequences
Requires data-license discipline that slows ingestion of new sources.
