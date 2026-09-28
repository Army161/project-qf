# ADR-010: Hybrid repository strategy

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Private GitHub organization. Repos:
- `project-qf/` monorepo (pnpm + turbo): apps/web, apps/api, apps/indexer, apps/workers, packages/core, validator, registry, policy, tx, providers, adapter-meteora-dbc, rewards, sdk-internal, docs.
- `project-qf-intelligence/` (restricted): feature definitions, scoring, models, prompts, agent orchestration, private datasets.
- `project-qf-infra/` (restricted): IaC, CI/CD, environment definitions, secret references only.
No Raydium repo; no EVM repos; no on-chain program repo in V1. Controls: forking disabled where plan permits, least privilege, CODEOWNERS, protected branches, required review, secret scanning, signed releases, SBOM/license scanning.

## Rationale
Monorepo maximizes agent usability and velocity; restricted repos compartmentalize IP and infrastructure.

## Consequences
Cross-repo changes between core and intelligence need versioned internal APIs.
