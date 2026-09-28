# AGENTS

Two kinds of agents exist: **runtime agents** (inside the product) and **coding agents** (Claude Code etc. building the product).

## 1. Runtime agents (V1)
| Agent | Reads | Writes | Tools |
|---|---|---|---|
| Launch Architect | validation results, scores, constraints | `LaunchProposal` JSON | none |
| Narrative Analyst | scores, feature summaries | narrative text (sanitized, banned-phrase filtered) | none |
| Registry Research Assistant | issuer pages fetched by a deterministic fetcher | draft registry evidence for **human** review | none |
No runtime agent has network, RPC, database-write, signer, or policy tools. Orchestration lives in `project-qf-intelligence`.

## 2. Coding agents
- Follow `CLAUDE.md`.
- Work only in the monorepo unless explicitly granted access to intelligence/infra repos.
- Never receive secrets; CI provides devnet-only ephemeral keys at runtime.
- Must run the pre-PR checks and the license scanner.
- Must stop on the CLAUDE.md stop conditions.

## 3. Audit trail
Every runtime agent call logs: model id, prompt template version, input bundle hash, output hash, schema result, policy decision. Retained per COMPLIANCE.md retention policy (OPEN).
