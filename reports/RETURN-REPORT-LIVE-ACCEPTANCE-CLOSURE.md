# Return report: live acceptance closure (Quote Asset Inspector)

Date: 2026-10-03, 21:30–22:00 UTC. Author: Claude (implementer). Reviewer: Astra. Owner: Jeremy Gephart.
Inputs: Jeremy's "close the live acceptance milestone" message, plus the package `CLAUDE-NEXT-PASS.md` and `DECISIONS.md` (D1–D6).
Branch `milestone/inspector-draft`: this pass starts from `87cb8db`, not `6c63da5`, which the package names. `87cb8db` already holds the real frozen install and the first live verifier run, both from the morning of 2026-10-03.
This file can be pasted as is. The ZIP that carries it also holds the logs, sanitized provider evidence, the git bundle, `MANIFEST.json` and `SHA256SUMS`.

**Status: INTERIM.** Every code change is done and tested, and the public-only live runs are done. **The two-provider live run with Helius has NOT run yet**, because no Helius key exists in the environment. Until it runs, acceptance item 8 stays **PARTIALLY MET**. When the key is set, a fresh session runs `§9` and turns this report final.

## 1. What I need from Jeremy
1. Create a free Helius account and copy the API key. Do not upgrade the plan.
2. In Project settings, open Cloud environment and click the gear beside "Quote Forge LaunchPad".
3. Add one environment variable: `QF_HELIUS_API_KEY`, with the key alone as its value, not the URL.
4. Never paste the key into chat. Only new sessions see the variable, so the live part runs in a fresh thread.

## 2. Per-criterion readiness (not a test total)
| Criterion | State | Evidence |
|---|---|---|
| Clean frozen install, no shim, no SDK change | **MET** | `full-run/01-install.txt`: 136 packages, lockfile `f5c8d2e9…c42b` unchanged, `--ignore-scripts`. The real `@noble/hashes@1.8.0` is in use. |
| Canonical checks on the changed code | **MET** | 252/252 tests, verifier tests 55/55, typecheck, boundary PASS, licence 0 failures, `chain` absent, SBOM 133 |
| Raw audit, SEC-A kept separate | **MET (raw stays red)** | The same 3 advisories as before: bigint-buffer high; uuid and stream-json moderate. The `evidence/sec-a/` dispositions are untouched. Owner carryover to lockfile `f5c8d2e9` is still **not recorded**. |
| S1.10 classic native-mint exception (D3) | **MET** | Test-first (§4). Live: wSOL is S1.10 NOT_APPLICABLE on mainnet and devnet, and its aggregate is still FAIL. |
| Method-aware largest-accounts routing (D2) | **MET in code, NOT YET LIVE** | Fake-provider tests cover both endpoint orders, bounded fallback, disagreement, and the same operator twice. The live proof needs Helius. |
| Authenticated Helius genesis and getTokenLargestAccounts capability | **NOT MET** | Key not configured. The probe tool is ready (§9). |
| Two independent providers for mint state (S1.12) | **NOT MET** | Public RPC only: S1.12 is SKIP on every live report. |
| Credential handling with fake keys | **MET** | Path and query keys are redacted from every reason, absent from reports, evidence and logs, and redirects are refused (§5). |
| Wrong-network message | **MET** | Live: mainnet USDC on devnet reads "not a mint on this network; check the network". |
| Stale or failed planning drafts (D6) | **MET** | Original references kept, prominent labels, edits don't re-consent (§6). |
| Draft restart and cross-user access, live | **MET** | `live-public-only/drafts/05-checks.txt` |
| Program verifier, dependency-backed, per cluster | **MET (single provider)** | Exit 0, 86/86 on both clusters. Hashes and deploy slots unchanged since 10:05Z (§8). |
| Program source/build provenance | **UNKNOWN** | Not a pass and not a mismatch (§8). |
| Program state cross-check by a second provider | **NOT MET** | RO-4 (§8) |
| **Acceptance item 8** | **PARTIALLY MET** | Waits on the Helius run, S1.12 with two operators, and largest-accounts data. |
| READ_ONLY_VERIFICATION stage | **BLOCKED (unchanged)** | Blocker text updated to the facts: RO-1/RO-2 now have evidence; new RO-4 and RO-5 added. The status itself is the owner's decision. |

## 3. Decisions D1–D6: what I did
- **D1 (registry access).** npm works and the frozen `--ignore-scripts` install is restored. Note for Astra: the environment is on **Full** network access, not Custom. Jeremy chose that at 10:07Z on 2026-10-03 and said to keep it because it works. I did not change it. The package controls (`--frozen-lockfile`, `--ignore-scripts`, patchedDependencies, `chain` removal, integrity, licence gate) all held. The earlier "new sessions only" line was about environment *variables*; the product docs I read today say a saved variable reaches new sessions.
- **D2 (Helius).** Implemented server-side: `QF_HELIUS_API_KEY` builds `mainnet.helius-rpc.com` and `devnet.helius-rpc.com` endpoints. Their ids are hosts only, their operator is `helius`, and they are preferred for `getTokenLargestAccounts`. Mint-state cross-checks use public RPC plus Helius on the same cluster. Independence is counted by operator. `DATA-LICENSES.md` now records the Helius scope. The agreement version and date are **not verified by me**; no account was created or used.
- **D3 (native mint).** Implemented exactly as written (§4).
- **D4 (shim run).** The 09:20Z shim run stays in `evidence/live-acceptance/` as **partial diagnostic evidence**, with its hashes and timestamps untouched. Acceptance rests on the frozen-install runs in `evidence/full-rerun/` (10:04Z) and `evidence/live-closure/` (this pass).
- **D5 (provenance).** Recorded separately per cluster. OtterSec `is_verified=false` is not treated as a mismatch. No QF local build was attempted (LOCAL-1). No attestation was uploaded, and nothing was signed, simulated or sent.
- **D6 (scope).** The local HTTP/SQLite/bearer design is unchanged. The conservative S1.6 rule is unchanged. Planning drafts and the wrong-network hint are done. No new engine, chain, purchase or outbound message.

## 4. Native-mint S1.10, test-first
- **Red then green.** `evidence/live-closure/red/new-tests-before-implementation.txt` has 7 failures, then `green/new-tests-after-implementation.txt` passes 35/35.
- **Schema.** `CheckDecision` gains `NOT_APPLICABLE`. It means "evaluated" and is distinct from SKIP, which means "not performed".
- **Policy object.** `qf-exception-S1.10-classic-native-mint-v1` in `packages/validator/src/exceptions.ts`. Its conditions: mint exactly `So11…112`; cluster mainnet-beta or devnet (genesis-verified); owner SPL Token; initialized; 9 decimals; no mint or freeze authority; no extensions; raw supply 0.
- **Aggregate.** It accepts NOT_APPLICABLE only for S1.10, only with the exception reference, and only after re-deriving every condition from the subject. A caller-asserted N/A, an N/A on any other required or optional check, or any contradiction becomes `INVALID_NOT_APPLICABLE` and FAILs. A required SKIP is still missing.
- **Still FAIL.** Ordinary zero supply; the native-mint address owned by Token-2022; the Token-2022 native mint; TEST_ONLY fixtures; wrong decimals or authorities. An uninitialized or malformed account never reaches S1.10.
- **Features.** `supply_raw` stays 0 with the label `NATIVE_MINT_SUPPLY_NOT_TRACKED`. Supply-normalized shares are UNAVAILABLE with that reason. Nothing is divided by it and nothing is substituted.
- **Versions.** `inspection-v0.2` and `features-v0.2`; `validator-v0.1` thresholds are unchanged. Old reports keep their stored version and digest, and drafts saved under v0.1 read back as policy-changed.

## 5. Provider routing and credentials
- **Largest accounts.** Only providers that proved genesis and returned the mint are asked. Preferred providers go first, then the rest. Each gets one attempt, capped at 3 attempts, with no retry loop. Every failure stays in `reads`. If all fail, the feature is UNAVAILABLE and names each failure.
- **Samples are not holders.** New features `largest_accounts_sample_size` and `top1_account_raw` are labelled "raw token-account sample, not owners, not owner-adjusted, program accounts not excluded". They never feed S3.4.
- **Redaction.** `endpointFromUrl` registers path segments and query values as secrets. Every reason string is scrubbed of them, and of `key=`/`token=` patterns, before truncation.
- **Fake-key tests.** The keys never appear in a reason, a report, the evidence, the startup log (`describeEndpoints`) or the probe output. Userinfo is still refused. Every RPC request is sent with `redirect: 'error'`.
- **Same operator.** Two endpoints of one operator give S1.12 SKIP `NOT_INDEPENDENT`.
- **Live outage case.** A second, unreachable mainnet endpoint gave IN.1 PASS "1 of 2 answered", and S1.12 SKIP "(second unavailable)".
- **Public-only probe** (`provider-probe/public-only-probe.json`): genesis and getAccountInfo OK on both clusters; `getTokenLargestAccounts` is **429 on every mint, on both clusters**.

## 6. Planning drafts (D6)
- **What a draft records.** Each draft stores a `basis`: the report digest, its observation time, decision, label, freshness at save, age at save, and its policies.
- **Labels on read.** `PLANNING_DRAFT`, then whichever apply: `EVIDENCE_STALE_AT_SAVE`, `EVIDENCE_STALE_NOW`, `TEST_ONLY_EVIDENCE`, `INSPECTION_FAIL` (or the WARN equivalent), `POLICY_CHANGED`, and `BASIS_NOT_RECORDED` for drafts saved before today.
- **Notice.** Every draft carries: "Saving does not refresh evidence and is not consent".
- **Saving a stale report** succeeds and never creates or substitutes an inspection.
- **Editing** keeps the original basis and policies. Only an explicit re-link to another inspection brings a new basis and today's policies.
- **Web app.** It shows the labels, the evidence basis and the notice. The browser tests now cover the native-mint N/A and the wrong-network hint too.

## 7. Live inspections, public RPC only (`evidence/live-closure/live-public-only/`)
| Case | Aggregate | PASS/WARN/FAIL/SKIP/N/A | Note |
|---|---|---|---|
| USDC mainnet | FAIL | 8/1/3/14/0 | authorities and registry gates, as before |
| USDT mainnet | FAIL | 8/1/3/14/0 | |
| **wSOL mainnet** | FAIL | 9/1/1/14/**1** | **S1.10 NOT_APPLICABLE**; the remaining FAIL is S2.1 registry absent; S1.12 SKIP |
| **wSOL devnet** | FAIL | 9/2/0/14/**1** | the FAIL comes only from missing required checks |
| PYUSD (Token-2022) mainnet | FAIL | 5/2/6/13/0 | |
| USDC devnet | FAIL | 8/2/2/14/0 | |
| Mainnet USDC address on devnet | FAIL | 1/2/1/22/0 | "not a mint on this network; check the network" |
| Token program id as a mint | FAIL | 1/1/2/22/0 | plain reason (not System-owned) |
| `not-a-mint` / `testnet` | 400 / 400 | | |
| Second endpoint down | FAIL | | §5 |

- **Drafts:** creation 201; the draft is byte-identical across restart; the stored inspection is identical apart from the computed age fields; the digest matches.
- **Access:** no token → 401; bad token → 401; another user → 404/404; edit → 200 (v2); stale edit → 409.
- Network state at different times is not expected to match byte for byte. These are fresh observations, compared by behaviour.

## 8. Program verifier, per cluster (`evidence/live-closure/program-verify/`, see `PER-CLUSTER-SUMMARY.md`)
- **Command.** Dependency-backed: `node --use-env-proxy verify-programs.mjs --mainnet https://api.mainnet.solana.com --devnet https://api.devnet.solana.com`.
- **Result.** Exit 0, 86/86 inventory, 28 required checks all satisfied.
- **Runtime.** On both clusters, DBC, DAMM v2 and SF Rewards are present, BPFLoaderUpgradeable, executable, and their ProgramData decoded.
- **Authorities.** Mainnet DBC and DAMM v2 share upgrade authority `JADaUV8k…`. Devnet uses `DHLXnJdA…`.
- **Hashes and deploy slots** are unchanged since the 10:05Z run: mainnet DBC `b3f7b765…`, DAMM v2 `7c479dd7…`; devnet DBC `e9599c7d…`, DAMM v2 `f838b2ae…`.
- **Configs.** The Customizable route is CONFIG PASS and CONFIG_COMPATIBILITY PASS on both clusters. The fixed-fee routes are CONFIG PASS and NOT_ASSESSED, as designed.
- **Source/build: UNKNOWN on both clusters.** SOURCE_BUILD is NOT_ATTEMPTED and AUDIT_COVERAGE is NOT_EVALUATED. OtterSec reports false; for mainnet DBC, OtterSec's on-chain hash equals ours. I did not obtain any upstream or independent reproducible, source-linked artifact. Meteora's GitHub repositories are outside this session's repository scope, and ADR-013/LOCAL-1 forbid copying or building the programs. Mainnet evidence says nothing about devnet bytes, and devnet evidence says nothing about mainnet.
- **RO-4.** No second-provider CROSS_CHECK. The verifier deliberately has no protected way to take a secret-bearing URL (its README says one must be designed first). Passing the Helius URL on the command line would put the key in the process list. I recommend a small, reviewed secret-input design (an env var read only by the verifier, redacted like the API) before running `--mainnet2`.

## 9. Runbook for the fresh session (once `QF_HELIUS_API_KEY` exists)
1. Restore `git/project-qf.bundle` and check out `milestone/inspector-draft` @ `fcd5dc7` or later. Run the frozen install through the secret-free wrapper, passing only `QF_HELIUS_API_KEY` explicitly.
2. Run `node --use-env-proxy apps/api/src/main.ts probe`. It does authenticated genesis plus getAccountInfo and getTokenLargestAccounts on USDC and wSOL per cluster, and the output is sanitized by construction. Save the output, then grep it to confirm the key is absent.
3. Repeat `evidence/live-closure/live-public-only/` with Helius configured. Expect S1.12 PASS where both operators agree, largest accounts from Helius, and the raw sample measured.
4. Grep every new evidence file and the ZIP for the key; there must be no match.
5. Turn this report final. Mark item 8 met only if every row in §2 that depends on the second provider is met.

## 10. Notes for Astra
1. **Environment:** Full access, not Custom, is Jeremy's standing choice (10:07Z). Please treat D1's "do not switch to Full" as superseded by the owner, not as an open defect.
2. **RO-4:** do you want a verifier secret-input design (an env var read only by the verifier, redacted), or is mint-state cross-checking in the inspector enough for this milestone?
3. **Operator independence:** `operatorOf` uses a small table of known hosts. Any other host counts as its own operator, named by its last two domain labels. Please confirm that is conservative enough, or name the operator registry you want.
4. **D2 terms:** please give the exact Helius agreement version and date to record. I could not verify it.
5. **S1.7:** its reason still says "NOT_APPLICABLE: no TokenBadge needed" while its decision is SKIP. I left it alone: it is not required, and changing it would widen the exception. Flagging it so nobody mistakes it for the new N/A.
6. **SEC-A:** carryover to lockfile `f5c8d2e9` is technically supported (packages and snapshots unchanged), but the owner's adoption is still not recorded.

## 11. Git
- Commit `fcd5dc7` on `milestone/inspector-draft`: code, tests, spec amendments (QUOTE-ASSETS inspection-v0.2, DATA-LICENSES Helius scope, readiness blocker text) and `evidence/live-closure/`.
- This report is committed on top of it.
- The bundle keeps every branch it held, including `milestone/launchpad-devnet`, owned by the "Build the launchpad" thread and unchanged by me.
