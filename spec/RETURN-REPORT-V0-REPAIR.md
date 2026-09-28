# Project QF — Return report: V0 safety-control repair pass

Date: 2026-09-27. Scope: the bounded offline remediation pass requested 2026-09-27T11:28Z, reading the QF-V0-Independent-Review package (CLAUDE-NEXT-PASS.md, REVIEW-DECISIONS.md, VERIFICATION-CHECKLIST.md).

**What this report is not.** It is not an independent audit and must not be read as one. The review that prompted it was not an external audit either. Test totals and exit codes below are not readiness for any stage. Nothing here authorizes signing, transactions, devnet writes or mainnet writes.

## 0. Read first

| Item | Status |
|---|---|
| Review harness and `evidence/targeted-probes.json` | **Not attached** to the package I received. I reproduced each finding from its written description with my own synthetic tests, run against the original code (red logs below). I could not diff my reproductions against the review's own probes. |
| Transaction semantics (QF-SEC-01a/b) | Repaired. The original accepted 13/13 serialized mutations; the repaired code rejects all 16 mutation classes. |
| Verifier (QF-SEC-02/03/04) | Repaired as v0.3.0: 17 of 17 reproductions were red before the fix and are green after it. The CLI flags are unchanged. |
| Validator, registry and consent (QF-VAL-01/02/03, QF-POL-01/02) | Repaired: 5 of 5 reproductions were red and are now green, plus added coverage. |
| SEC-A | All five advisories have version-bound dispositions. The raw audit remains red and visible. Owner approval is pending. |
| Live verifier | Attempted with the repaired verifier. The proxy returned 403 for every Solana RPC host and verify.osec.io, so the run exited 2 and **nothing was verified**. |
| Full clean-environment run | Everything passes: 175 of 175 project tests and 38 of 38 verifier tests. One typecheck error was found on the first run and then fixed. |
| Readiness | `OFFLINE_V0` is ACTIVE. `READ_ONLY_VERIFICATION`, `LOCALNET_INTEGRATION`, `DEVNET_INTEGRATION` and `MAINNET` are all BLOCKED. |

**Correction.** My interim thread note said "26 red". The red logs I kept show **24 red tests** (tx 2, validator 3, policy 2, verifier 17), plus a separate probe in which **13 of 13** serialized mutations were accepted. The figure 24 is the one backed by evidence.

## 1. Owner decisions applied

| Decision | Where it is enforced |
|---|---|
| **LIC-R1**: allow exact `pako@2.2.0` `(MIT AND Zlib)` | Added `LICENSE-MANIFEST.json` exception QF-LIC-EX-002 with `status: APPROVED_EXACT` (the spec and project copies are identical, and a test checks this). `tools/license-check/exact.ts` checks five things: the licence expression, the lockfile integrity, that the package is not patched, and that both upstream notices are preserved byte-identical in `project-qf/licenses/pako@2.2.0/` (`LICENSE` for MIT, `lib-zlib-README` for Zlib). Both texts are reproduced in `THIRD_PARTY_NOTICES.md`. Zlib stays at REVIEW for every other package, so there is no broad exemption. Licence check result: ALLOW_EXCEPTION 2, REVIEW 0, failures 0. |
| **EV-1**: price 120 s, pool 300 s, route 120 s, skew 5 s, ≥ 2 independent sources | `EVIDENCE_POLICY_V0_1.status = 'V0_TEST_ANALYTICAL'` with `scope = 'ANALYTICAL_ELIGIBILITY_ONLY_NOT_EXECUTION'`. `EXECUTION_FRESHNESS_POLICY` is UNDEFINED and `signingPermitted: false`. |
| **ECON-1**: `percentageSupplyOnMigration = 20` is a test fixture only | Recorded as `STANDARD_V1.fixtureLabels.percentageSupplyOnMigration = 'V0_TEST_FIXTURE'`, and `assertTemplateUsableFor(..., 'PRODUCTION_CONFIG')` always throws. Supply and units accounting tests were added (see §3). |
| Flat fee baseline; decay `SIMULATION_ONLY` | Unchanged. The simulation was rerun with all hypotheses retained, including the failed H1 result. |

The following earlier decisions are unchanged:
- architecture, privacy and browser boundary;
- the narrow LGPL exception QF-LIC-EX-001;
- removal of `chain` (proof: 12 of 12 PASS);
- transfer-fee and Jupiter gates;
- LOCAL-1.

## 2. Red → green per finding

Logs are in `project-qf/evidence/repair/red/` and `project-qf/evidence/repair/green/`. Every red run used the original code with synthetic inputs.

| Finding | Red (original) | Green (repaired) | Repair |
|---|---|---|---|
| QF-SEC-01a: CREATE_POOL with arbitrary DBC bytes plus an extra System transfer | fail | pass | Strict IDL Borsh decode, and binding of the decoded operation to approved terms |
| QF-SEC-01b: SWAP with arbitrary DBC bytes | fail | pass | Same as 01a |
| QF-SEC-01, serialized mutations of valid SDK transactions | **13 of 13 ACCEPTED** (`red/tx-serialized-mutations-original.txt`) | 16 of 16 tests pass (`green/tx-serialized-mutations.txt`) | Mutations covered: extra transfer, SetAuthority, substituted output ATA, mint, fee recipients, amount_in, min_out, claim maxima, compute price or duplicate limit, wrong operation, extra signer, substituted DAMM config or reused ephemeral signer, attacker ATA creation, truncated or extended data, CREATE_CONFIG fee change, unknown program |
| QF-SEC-02: Config decoded from discriminator only, truncated, over-long or incompatible | 4 fail | 4 pass | Full 328-byte decode against the pinned layout, plus the CONFIG_COMPATIBILITY check |
| QF-SEC-03: credentials in path, userinfo, query or fragment; nested errors; report endpoint | 3 fail | 3 pass | Output is `scheme://host[:port]` only, and `sanitizeError` walks `cause` and `AggregateError` recursively |
| QF-SEC-04a: incomplete, dropped or duplicated inventory | 3 fail | 3 pass | `expectedInventory(plan)` is computed independently of the results |
| QF-SEC-04b: second-provider disagreement versus unavailability | 2 fail | 2 pass | DISAGREEMENT gives exit 3 and UNAVAILABLE gives exit 2, with one re-read at `minContextSlot` |
| QF-SEC-04: option tag, trailing bytes, per-check RPC error, context slots, schema version | 5 fail | 5 pass | A program account must be exactly 36 bytes; a tag other than 0 or 1 is FAIL; per-check ERROR; `finalized` and `contextSlot` retained; schema `qf-program-verify-report/2` |
| QF-VAL-01: an empty required-exit list passes S3.1 | fail | pass | Required exits come from policy (wSOL, USDC) with `minIndependentExits: 1`; identity exits are not counted |
| QF-VAL-02: an asserted issuer class with an invalid mint and no evidence is admitted | fail | pass | `admitToProductionRegistry` requires verified provenance. `AUTHORITATIVE_SOURCES_V0 = []`, so every production admission is refused in V0. The TEST_ONLY guard was renamed `assertNotTestOnlyAsset`. |
| QF-VAL-03: an unknown mode bypasses the LIVE checks | fail | pass | Runtime enum, address, amount, notional and timestamp guards (`packages/core/src/guards.ts`); the aggregate rejects `NO_CHECKS`, `MALFORMED_CHECK` and `DUPLICATE_CHECK` |
| QF-POL-01: a liquidity WARN does not require acknowledgement | fail | pass (plus 2 added tests) | Any WARN produces `REQUIRES_ACKNOWLEDGEMENT`; the digest binds the warnings, evidence and policies; a stale or missing acknowledgement is refused |
| QF-POL-02: an older in-TTL record wins over newer adverse evidence | fail | pass (plus 3 added tests) | Newer evidence is evaluated first. Adverse price, route, exit, authority or freeze evidence fails closed. |

The following tests defined the deficient behaviour as success, and each was removed or rewritten:
- in `packages/tx/test/decoder.test.ts`, the test that expected `[]` violations for arbitrary DBC bytes;
- in `packages/validator/test/aggregate-registry.test.ts`, the promotion test;
- in the verifier's `verify.test.mjs`, the old `redactUrl` expectation that kept the path.

### Transaction binding, in brief (ADR-009 amendment)

- **Decoding.** The single DBC instruction is decoded strictly from an IDL subset. The subset is extracted from the MIT SDK package (`@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`), with a drift and licence test. No Meteora program source was used.
- **Binding.** Every named account is re-derived as a PDA, and the args are compared with `ApprovedTerms`.
- **Supporting instructions.**
  - ComputeBudget allows only the limit and price instructions, capped at 1,400,000 CU and 10,000,000 µ-lamports.
  - ATA CreateIdempotent is allowed only for the expected owner, mint and token program, and the fee payer must pay.
  - Any other System, Token or Token-2022 instruction is `UNBOUND_INSTRUCTION`.
  - Any other program is `UNEXPECTED_PROGRAM`.
- **Signers and writable accounts.** The signer set must match exactly. MIGRATE gets two ephemeral NFT-mint signers, tied to their derived positions. The writable accounts must be a subset of the expected set.
- **Consent.** The consent digest binds the terms digest, cluster, `tx-binding-v0.1`, the evidence digest and the acknowledgement digest.
- **Fail closed in V0.** The following are rejected, so the preview will refuse flows that V1 may need, until each has its own binding:
  - native SOL wrap and unwrap (`TERMS_UNSUPPORTED_V0`);
  - Token-2022;
  - address lookup tables.

## 3. Existing suites and checks (clean-environment run)

**Environment.** Node v22.22.2 and pnpm 10.33.0, in a secret-free `env -i` wrapper with lifecycle scripts disabled. Lockfile sha256 `307d35bee826b2f7d455967160795d3b77e4635c814b87be9a09f784ae6e7f7d`. All `node_modules` were deleted first. Logs are in `project-qf/evidence/repair/full-run/`.

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | exit 0 |
| `pnpm sbom` | exit 0; 136 components |
| `pnpm deps:chain` | exit 0; 12 of 12 PASS (lockfile, graph, node_modules, runtime, both SBOMs, published artifact) |
| `pnpm license:check` | exit 0; 164 packages: ALLOW 137, ALLOW_EXCEPTION 2, NOT_INSTALLED 25, REVIEW 0, failures 0 |
| `pnpm build:web` | exit 0 (rebuilt because the web fixtures changed) |
| `pnpm boundary` | exit 0; browser graph of 58 packages, no forbidden packages, no non-plain-ALLOW licences, no wallet packages, both canaries detected |
| `pnpm typecheck` | **First run: exit 2** (one TS2345 in `createBoundedFetch` options). Fixed with an explicit options type. **Rerun: exit 0** (`07b-typecheck-rerun.txt`). |
| `pnpm test` | 175 of 175 pass, before and after the typecheck fix. Includes the Chromium MOCK UI end-to-end test. |
| `pnpm sim` | exit 0; hypotheses unchanged, including the retained H1 FAIL |
| `pnpm audit --prod --json` | exit 1 (expected; see §4) |
| Verifier: frozen install, then `pnpm test` | exit 0; 38 of 38 pass |

**Runtime versions** (pinned test, installed tree):

| Package | Version |
|---|---|
| dynamic-bonding-curve-sdk | 1.5.13 |
| cp-amm-sdk | 1.4.10 |
| @solana/web3.js | 1.99.0 (adapter only) |
| @coral-xyz/anchor | 0.31.1 |
| @solana/kit | 8.3.0 |
| toml | 4.2.0 (override) |
| bigint-buffer | 1.1.5 (patched) |
| uuid | 8.3.2 |
| stream-json | 1.9.1 |
| jayson | 4.3.0 |

## 4. SEC-A: raw audit and dispositions

Raw output is preserved:

| File | Counts | Exit |
|---|---|---|
| `evidence/sec-a/audit-prod-raw-pre-mitigation.json` | high 3, moderate 2 | 1 |
| `evidence/sec-a/audit-prod-raw-post-mitigation.json` | high 1, moderate 2 | 1 |

After mitigation the audit still lists bigint-buffer, uuid and stream-json, because it matches on version only. No blanket waiver was applied and `audit fix --force` was not run.

The records are in `evidence/sec-a/dispositions.json`. Each one gives the advisory, version, integrity, target, call path, input reachability, mitigation, tests, approval, expiry and recheck triggers. `packages/adapter-meteora-dbc/test/sec-a.test.ts` asserts all of them against the **installed** artifacts, and a runtime probe records which modules are actually loaded.

**Target** for every record: the server-side Meteora adapter under Node only. This is excluded from browser and customer builds by `tools/boundary`.

| Advisory | Package@version (integrity) | Call path / reachability | Disposition | Mitigation / proof |
|---|---|---|---|---|
| GHSA-3gc7-fjrx-p6mg (high) | bigint-buffer@1.1.5 (`sha512-trfYco6A…JgxVvA==`) | buffer-layout-utils u64/u128 layouts. Inputs are QF-validated u64 values and bounded RPC data. | **MITIGATED_PATCHED** | A pnpm `patchedDependencies` patch (sha256 `a36b175b…81b1`) removes `require('bindings')`. The test shows that no `.node` file is installed, the patched module is the one loaded, and `bindings` is never loaded. Disabled install scripts are not relied on. Residual: pure-JS `toBufferLE` silently truncates values that are too wide, so QF validates every amount as u64 first. `bindings@1.5.0` is still installed but is never required. |
| GHSA-82x6-q7mm-w9cf (high) | toml 3.0.0 → **4.2.0** (`sha512-TvAJjbHZ…0XgClg==`) | anchor `workspace.js` → `toml.parse(Anchor.toml)`. The module is loaded eagerly, and parsing happens only if `anchor.workspace` is accessed. QF never accesses it and ingests no TOML (checked by a source scan). | **FIXED_BY_SCOPED_OVERRIDE** | `"@coral-xyz/anchor@0.31.1>toml": "4.2.0"`. The test covers Buffer input parity, a depth error (not a RangeError) on deep nesting, and that 3.x is never loaded. Residual: 4.2.0 is outside anchor's declared `^3.0.0` range; parity is tested only for anchor's one call. |
| GHSA-v5mp-jgw5-2x6j (high) | toml (same) | Same as above | **FIXED_BY_SCOPED_OVERRIDE** | A `__proto__` key-path payload does not pollute `Object.prototype`. |
| GHSA-w5hq-g745-h8pq (moderate) | uuid@8.3.2 (`sha512-+NYs2QeM…R7eg==`) | Only jayson@4.3.0 depends on it (lockfile check). Every call site is `require('uuid').v4` called as `uuid()` with no buffer. The advisory concerns v3, v5 and v6 with a caller-supplied buffer, and 8.3.2 has no v6. | **NOT_AFFECTED_PATH_SPECIFIC** | Test pins the call sites and dependants. uuid@14.0.2 (via rpc-websockets) is outside the affected range. |
| GHSA-528h-pc64-c93x (moderate) | stream-json@1.9.1 (`sha512-uWkjJ+2N…gPShyw==`) | jayson requires only `StreamValues` and `Verifier`, not the affected pick, ignore, filter or replace filters. web3.js uses jayson's browser client, so stream-json is **not loaded** at runtime. | **NOT_AFFECTED_PATH_SPECIFIC** | In addition, every live RPC response is bounded before parsing (`createBoundedFetch`: 8 MiB, depth 64, tested). |

**Record metadata.**
- Approval: `PENDING_OWNER` on every record.
- Expiry: 2026-12-27.
- Recheck triggers include a lockfile hash change, SDK or anchor bumps, new GHSAs, a change of deployment target, and triggers specific to each path.

**Observation, not one of the five advisories.** `ws` loads prebuilt native `bufferutil@4.1.0` and `utf-8-validate@6.0.6` binaries on the server side. I recorded this rather than hiding it. You can block them (the `WS_NO_BUFFER_UTIL` / `WS_NO_UTF_8_VALIDATE` environment variables, or an override that removes the optional packages) if you want no native code at all.

## 5. Verifier evidence

**Offline.** v0.3.0 passes 38 of 38 tests against a labelled fake RPC. The layout is pinned from the MIT `@meteora-ag/cp-amm-sdk@1.4.10` IDL (layout sha256 `cf446496…caf4`). Its provenance and licence are recorded inside the layout file, and the adapter's copy is identical to it.

**Live attempt, 2026-09-27T12:14Z.**
- Command: `node --use-env-proxy verify-programs.mjs` with the public default endpoints, inside the secret-free wrapper.
- A curl probe got 403 on CONNECT for api.mainnet-beta.solana.com, api.devnet.solana.com and verify.osec.io.
- The verifier recorded CONNECTIVITY FAIL on both clusters, with the nested cause retained ("Proxy response (403) !== 200 when HTTP Tunneling").
- The inventory was complete: 86 expected, 0 missing, 0 duplicate, 0 unexpected. Every other check was UNKNOWN, and the exit code was 2.
- No controls were bypassed and TLS was not relaxed.
- Evidence is in `spec/docs/verification/repair-2026-09-27/`.
- **Nothing on-chain has been verified.**

**CONFIG_COMPATIBILITY is an assumption.** The check assumes that a DAMM v2 config usable by DBC migration has `pool_creator_authority` equal to the DBC pool authority `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`. It must be confirmed or corrected against live configs (RO-2).

## 6. Readiness (separate statuses; `packages/core/src/readiness.ts`, ADR-011)

| Stage | Status | Blocking items |
|---|---|---|
| `OFFLINE_V0` | **ACTIVE** | none (this pass) |
| `READ_ONLY_VERIFICATION` (new) | **BLOCKED** | **RO-1**: run from an owner-authorized network (this environment returns proxy 403). **RO-2**: confirm the CONFIG_COMPATIBILITY assumption. **RO-3**: an exit-0 report counts for this stage only. |
| `LOCALNET_INTEGRATION` | **BLOCKED** | LOCAL-1 (written Meteora permission), LOCAL-2, LOCAL-3 |
| `DEVNET_INTEGRATION` | **BLOCKED** | DEV-1 (needs READ_ONLY_VERIFICATION), DEV-2, DEV-3, SEC-A owner approval |
| `MAINNET` | **BLOCKED** | all existing gates; execution freshness is undefined; no audit |

## 7. Tests run versus not run

**Run** (all logged):
- the full project suite (175) and the verifier suite (38);
- the per-finding red runs against the original code (24 tests plus the 13-mutation probe) and the green runs (tx 2, validator 3, policy 7, verifier 17, mutations 16, SEC-A 7);
- typecheck, licence check, boundary, chain proof, SBOM, web build, simulation and raw audit.

**Not run:**
- the review's own harness and targeted probes (not attached);
- any live RPC read (blocked);
- localnet, devnet and mainnet integration;
- a mainnet-fork test;
- any wallet or signing path (none exists);
- fuzzing or property-based tests beyond the mutation classes listed;
- browsers other than the preinstalled Chromium;
- a reproducible build of the Meteora programs (LOCAL-1);
- an independent security audit.

The tx binding is tested against SDK-built MOCK transactions only, not against transactions produced by a real wallet or a live cluster.

## 8. Owner actions

- **Approve or reject the five SEC-A dispositions** (currently `PENDING_OWNER`, expiring 2026-12-27). Decide whether to block the native `ws` accelerators.
- **Choose an authorized network** for the read-only verifier. If the endpoints carry secrets, design a protected secret-input mechanism first; v0.3.0 intentionally has none.
- **Confirm or correct** the CONFIG_COMPATIBILITY assumption once live data is available.
- **Decide on the draft Meteora inquiry.** It was **not sent**. No external messages were sent in this pass.

## 9. Constraints honoured

- No wallets, keys or signing.
- No transactions or simulations against a live cluster.
- No mainnet writes and no on-chain attestation.
- No new engines, chains, bridges or Jupiter persistence.
- No Meteora program source or binaries were copied. The IDL subset and layout come from MIT SDK packages, with licences checked by tests.
- Installs ran only in the secret-free wrapper with `--ignore-scripts`.
- No secrets appear in logs; the secret scan is recorded in the ZIP manifest.
- ADRs and docs were amended, not regenerated: ADR-007, 009, 011 and 012; QUOTE-ASSETS §9, ECONOMICS §7, LICENSES §7, PROGRAM-VERIFICATION §2 and §5, TESTING §6, ROADMAP, THIRD_PARTY_NOTICES, and the verifier README.

## Appendix A — changed files versus `quoteforge-v0-2026-09-27.zip`

66 files added, 51 modified, 0 removed. The generated full list is `project-qf/evidence/repair/CHANGED-FILES.txt`.

**Code added:**
- `packages/tx/src/{terms,semantic}.ts`
- `packages/tx/src/engine/{borsh,idl-types,pda,dbc-idl-subset}.ts`
- `packages/core/src/guards.ts`
- `tools/license-check/exact.ts`
- `packages/adapter-meteora-dbc/scripts/extract-idl-subsets.ts`
- `patches/bigint-buffer@1.1.5.patch`
- `licenses/pako@2.2.0/*`
- verifier `layouts/`, `test/support/`, `test/review-findings.test.mjs`

**Code modified:**
- tx: `decoder`, `index`, `programs`
- adapter: `index`, `package.json`
- core: `index`, `readiness`, `types`
- policy: `curveTemplate`, `migration`
- validator: `aggregate`, `exitDepth`, `liquidity`, `policy`, `price`, `registry`
- web: `fixtures`
- licence check
- workspace, lockfile, manifest
- verifier: `lib.mjs`, `verify-programs.mjs`, `package.json`, `README`

**Tests added:**
- tx: `binding`, `review-findings`
- adapter: `mutation`, `idl-subset`, `supply-accounting`, `sec-a`, `support/fixtures`
- validator: `review-findings`, `schema-admission`
- policy: `review-findings`

**Tests modified:**
- `decoder`, `compat`, `gates`, `aggregate-registry`, `exit-depth`, `spdx`, `verify.test.mjs`
