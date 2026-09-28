# DEPLOYMENT

## 1. Environments
| Env | Chain | Writes | Keys |
|---|---|---|---|
| local | solana-test-validator (cloned programs) | yes (test) | runtime-generated, git-ignored |
| devnet | Solana devnet | yes (test) | devnet-only keys in KMS or runtime-generated |
| staging | mainnet **read-only** | no | none with authority |
| production | mainnet | **blocked** (`MAINNET_WRITES=false`) | multisigs per SECURITY.md §2 |

## 2. Mainnet launch gate (all required)
1. Written Meteora or counsel confirmation on commercial interaction with deployed DBC/DAMM v2 (ADR-002).
2. PROGRAM-VERIFICATION run on mainnet with two RPCs; authorities recorded; alerting on upgrades live.
3. V0 exit criteria met on localnet-clone and devnet.
4. Counsel sign-off on COMPLIANCE hooks (jurisdictions, sanctions, disclosures).
5. Multisigs created (2-of-3 hardware) for CONFIG_OWNER, FEE_CLAIMER, REWARD_AUTHORITY, DEPLOYMENT_ADMIN; signer runbook tested.
6. Production `EconomicsPolicy`/`CurveTemplate` versions approved with simulation report.
7. Security review of QF code (external) — scope: tx builder, preview decoder, adapter, policy engine, signing routes.
8. Naming/trademark decision (not "QuoteForge").
Holder-reward settlement has its own gate (REWARDS.md §6). `DBC_BASE_TRANSFER_FEE` has its own gate (ADR-003).

## 3. Config creation runbook
Policy Engine proposes → ConfigRegistry `proposed` → multisig reviews decoded tx → signs → verifier decodes on-chain config and asserts parity → `active`.

## 4. CI/CD
GitHub Actions with OIDC to cloud; frozen lockfile; SBOM + license + OSV gates; signed release tags; infra via `project-qf-infra` (IaC). No secrets in CI plaintext variables.

## 5. Rotation & incident
Key rotation per role quarterly or on suspicion; incident runbook (pause configs in registry, disable Studio launches via flag, alert holders) — detailed runbook OPEN before mainnet.
