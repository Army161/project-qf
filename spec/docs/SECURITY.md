# SECURITY

## 1. Non-negotiables
1. No AI access to keys, signers, RPC write methods, multisig tooling, or policy writes.
2. No seed phrases / private keys in model context, GitHub, `.env` files committed, logs, CI plaintext variables, Claude or ChatGPT conversations.
3. Server never signs on behalf of users.
4. Decoded transaction preview produced client-side from transaction bytes before wallet signing.
5. Dependency pinning (exact versions for Solana/Meteora), lockfile enforcement (`pnpm install --frozen-lockfile`).
6. SBOM (CycloneDX) generated per build; license scanner against `LICENSE-MANIFEST.json`; OSV scanning + `pnpm audit`.
7. CSP: `default-src 'self'`; no `unsafe-inline`/`unsafe-eval` on signing routes; SRI for static assets; **no third-party scripts on signing pages** (no analytics, chat widgets, tag managers).
8. Two-RPC verification for critical state; finalized commitment.
9. Idempotent indexer keyed by `(signature, instruction_index, inner_index)`; reconciliation against finalized state.
10. AuthorityMonitor: alerts on SetAuthority, FreezeAccount on QF-relevant vaults, program upgrades (programdata slot change) of DBC/DAMM v2/settlement program.
11. Metadata sanitization: no raw HTML, image proxy with type/size checks, link allowlist.

## 2. Authority roles (production: each a separate 2-of-3 hardware-backed multisig unless noted)
| Role | Controls | Hot? |
|---|---|---|
| CONFIG_OWNER | DBC config creation/ownership | No |
| FEE_CLAIMER | Partner fee claims (config `fee_claimer`) | No |
| REWARD_AUTHORITY | Funding/creating reward distributions, revocation (if enabled) | No |
| DEPLOYMENT_ADMIN | Program upgrade authority for any QF-deployed settlement program; infra break-glass | No |
| MIGRATION_CRANK | Fee payer for permissionless migration calls only | Yes — KMS/HSM, minimal SOL balance, no other authority |
| HARVESTER_PAYER | Fee payer for building claim txs that FEE_CLAIMER signs | Yes — KMS/HSM, minimal balance |
Keys never shared across roles or environments. Devnet uses separate keys generated at runtime.

## 3. Secrets
Cloud secret manager + KMS; OIDC from CI (no long-lived cloud credentials); secret scanning (GitHub push protection) on all repos; rotation runbook in DEPLOYMENT.md.

## 4. Repository security
Private org; forking of private repos disabled where plan permits; least-privilege teams; CODEOWNERS on `packages/tx`, `packages/adapter-*`, `packages/policy`, `packages/rewards`, `apps/web` signing routes; protected branches; ≥1 required review (2 for CODEOWNERS paths); signed commits/releases; restricted intelligence and infra repos.

## 5. Vulnerability disclosure
Private security contact + advisory process (to be published before mainnet). Bug bounty OPEN.
