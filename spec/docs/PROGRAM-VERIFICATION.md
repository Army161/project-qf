# PROGRAM-VERIFICATION

## 1. Tool
`tools/program-verify/verify-programs.mjs` + `lib.mjs` (v0.2.0, amended 2026-09-27; v0.3.0 after the repair pass, see §5) — read-only. JSON-RPC reads with a three-method allowlist (`getGenesisHash`, `getVersion`, `getAccountInfo`) + one HTTPS GET to verify.osec.io; no keys, no signing, no sends, no simulation, no attestation, no environment variables. Depends only on `@solana/addresses@8.3.0` (MIT; the previous web3.js dependency and its LGPL transitive are gone). Output: `docs/verification/PROGRAM-VERIFICATION-YYYY-MM-DD.{md,json}`. Flags unchanged: `--mainnet`, `--mainnet2`, `--devnet`, `--out` (see `tools/program-verify/README.md`).

Checks per program (DBC `dbcij3LW…aqN`, DAMM v2 `cpamdpZC…sGG`, Rewards candidate `REWArD…oXi`) per cluster (mainnet-beta, devnet):
exists · executable · owner (upgradeable loader) · program data account · upgrade authority (null ⇒ immutable) · last deploy slot · program data length · executable SHA-256 (trailing zeros trimmed, OtterSec-compatible) · Anchor IDL account presence + instruction list (detects `create_config2` ⇒ 0.2.2 deployed) · OtterSec verified-build status · cross-check of authority and hash against a second mainnet RPC.
Also: existence/owner of the 7 DAMM v2 migration config accounts on each cluster.

## 2. Results log
| Date | Environment | Result | File |
|---|---|---|---|
| 2026-09-27 (decision review, verifier v0.4.0, `run-readonly-local.sh` dry run) | Claude cloud sandbox, public `api.mainnet.solana.com` / `api.devnet.solana.com` | **Blocked**: `HTTP 403 Host not in allowlist` on both; inventory complete (86/0/0/0); CONNECTIVITY FAIL, everything else UNKNOWN; exit 2. Not the owner-network run; nothing verified | `project-qf/evidence/readonly-readiness/cloud-dry-run/` |
| 2026-09-27 (repair pass, verifier v0.3.0) | Claude cloud sandbox via its egress proxy (`node --use-env-proxy`), public default endpoints | **RPC blocked.** Proxy 403 on CONNECT for api.mainnet-beta.solana.com, api.devnet.solana.com and verify.osec.io (curl probe agrees). CONNECTIVITY FAIL on both clusters with the nested cause retained; inventory complete (86 expected, 0 missing/duplicate/unexpected); every other check UNKNOWN; exit 2. Nothing verified; no controls bypassed | `docs/verification/repair-2026-09-27/` |
| 2026-09-27 | Claude cloud sandbox via its egress proxy (`node --use-env-proxy`) | **RPC blocked again.** Proxy answered 403 to CONNECT for api.mainnet-beta.solana.com, api.mainnet.solana.com, api.devnet.solana.com and verify.osec.io. Verifier: CONNECTIVITY FAIL on both clusters, every other check UNKNOWN, exit 2. Nothing verified | `docs/verification/PROGRAM-VERIFICATION-2026-09-27.{md,json}`; probe `project-qf/evidence/rpc-attempt/curl-probe.txt` |
| 2026-09-26 | Spec authoring sandbox | **RPC blocked** (`403 Host not in allowlist` for api.mainnet-beta.solana.com and api.devnet.solana.com). OtterSec status retrieved separately via web fetch. | `docs/verification/PROGRAM-VERIFICATION-2026-09-26.md` |

## 3. What remains UNVERIFIED (must be closed by Step 0 of V0)
- Upgrade authorities of DBC, DAMM v2, Rewards candidate (the product owner reports that an explorer shows a DBC "Upgrade Authority Multisig" label — UNVERIFIED here).
- Devnet presence of all three programs and of DAMM v2 migration configs.
- Whether 0.2.2 is deployed (IDL `create_config2` presence).
- Deployed bytecode ↔ source parity (OtterSec reports "not verified" for all three).
- Rewards candidate owner/authority identity (Solana Foundation or other).

## 4. Amendment 2026-09-27 — checks recorded separately
The v0.2.0 verifier emits one status per check.
- **Checks with a pass condition:**
  - CONNECTIVITY;
  - CLUSTER_IDENTITY (genesis hash against the published value from `solana-sdk` `ClusterType::get_genesis_hash`);
  - PROGRAM_PRESENCE, LOADER_STATE, PROGRAMDATA;
  - CONFIG (owner and the DAMM v2 `Config` discriminator);
  - CROSS_CHECK (second RPC).
- **Checks that are only recorded:** UPGRADE_AUTHORITY, DEPLOY_SLOT, EXECUTABLE_HASH (never a version claim), INTERFACE (`has_create_config2` is only an indicator).
- **Checks never performed:** SOURCE_BUILD is always NOT_ATTEMPTED; OtterSec `is_verified=false` is recorded as "not verified", not as a mismatch. AUDIT_COVERAGE is always NOT_EVALUATED.
- **Failure handling:** after a CONNECTIVITY or CLUSTER_IDENTITY failure, all dependent checks are UNKNOWN.
- **Exit codes:** 0 when all required checks are satisfied, 2 when a cluster is unreachable, 3 when a required check is FAIL or UNKNOWN, 64 for a usage error.
- **Tests:** 16 negative and contract tests with a labelled fake RPC in `tools/program-verify/test/`.

**To close DEV-1:** run the verifier from an owner-authorized environment whose egress allows the chosen RPC hosts and verify.osec.io, then commit the output. Section 3 stays UNVERIFIED until that run produces exit 0.

## 5. Amendment 2026-09-27 — repair pass (QF-SEC-02/03/04): verifier v0.3.0
- **Full config decode.** DAMM v2 migration configs must be exactly 328 bytes and decode field-by-field against a layout pinned from the MIT `@meteora-ag/cp-amm-sdk@1.4.10` IDL (`tools/program-verify/layouts/damm-v2-config-layout.json`, sha256 `cf446496b9991546f515cb6e12f00fef4911e800915858ccbad8e17e1131caf4`). Discriminator-only, truncated or extended accounts fail. New CONFIG_COMPATIBILITY check: `pool_creator_authority` equals the DBC pool authority — an ASSUMPTION, recorded as such (READ_ONLY_VERIFICATION blocker RO-2).
- **Loader layouts.** The program account must be exactly 36 bytes; an authority option tag other than 0/1 is FAIL. Tag 0 means immutable even with leftover bytes (the loader leaves the old key in place).
- **Independent inventory.** The expected checks are computed from the flags; missing, duplicated or unexpected checks are required failures.
- **Unavailable vs disagreement.** CROSS_CHECK is UNAVAILABLE (exit 2) when the second provider cannot answer and DISAGREEMENT (exit 3) when a difference persists after one re-read at `minContextSlot`.
- **Errors and slots.** Per-check ERROR on RPC failure; commitment `finalized` and every `contextSlot` are retained. Report schema `qf-program-verify-report/2`.
- **Redaction.** Endpoints are written as `scheme://host[:port]`; path, userinfo, query and fragment never appear, including inside nested `cause` and `AggregateError` chains.
- **CLI unchanged.** `--mainnet`, `--mainnet2`, `--devnet`, `--out`; unknown flags exit 64. Exit codes: 0 complete and satisfied · 2 unavailable only · 3 failure/disagreement/unknown/missing/duplicate/unexpected · 64 usage.
- **Tests.** 38 offline tests with a labelled fake RPC (17 of them reproduce the review findings and were red against v0.2.0).
- **Live run 2026-09-27 (repair pass).** See §2 and `docs/verification/`; exit 0 would establish on-chain state for READ_ONLY_VERIFICATION only.

## 6. Amendment 2026-09-27 — decision review: verifier v0.4.0
- **CFG-TYPE.** CONFIG_COMPATIBILITY is route-specific. For the selected Customizable route it requires `pool_creator_authority` = DBC pool authority **and** `config_type` = 1 (Dynamic); Static (0) and unknown enum values fail. Evidence levels: authority rule and Dynamic-type rule CONFIRMED_FOR_PINNED_SOURCE (DBC f552f20 `validate_config_key`; DAMM a85c926 `initialize_pool_with_dynamic_config`, per the decision review; the MIT cp-amm-sdk 1.4.10 corroborates 0 = public static config and the dynamic-config instruction); authority PDA CONFIRMED_OFFLINE (seed `pool_authority`, bump 255, re-derived here with `@solana/addresses`); live values UNVERIFIED. Fixed-fee routes report NOT_ASSESSED (outside V0).
- **BODY-LIMIT.** Per-operation streaming limits with cancellation and a whole-body deadline; decoded account bytes and the inflated IDL are bounded separately; ProgramData reads allow the 10 MiB maximum account size (see the tool README).
- **Schema** `qf-program-verify-report/3`. CLI flags unchanged. 55 offline tests.
- **Reproduction first.** The decision review's diagnostic reproduced both gaps against the untouched export (same source hashes as the review); after the repair it no longer reproduces (`project-qf/evidence/readonly-readiness/`).
- **Runs.** A cloud dry run of `run-readonly-local.sh` got `403 Host not in allowlist` (exit 2, nothing verified). The owner-network run has not been performed yet.
