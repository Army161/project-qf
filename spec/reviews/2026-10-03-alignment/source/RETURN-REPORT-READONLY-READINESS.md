# Project QF — Return report: adopt decisions, finish read-only readiness

Date: 2026-09-27. Input: owner decisions (thread message 2026-09-27T15:59:36Z) and `QF-Repair-Decision-Package` (SHA256SUMS verified; kept verbatim in `spec/reviews/2026-09-27-repair-decision/`). Bounded pass: no new architecture, engine, chain or spec cycle. **Not an audit. Nothing on-chain has been verified.**

## 1. What needs you

| Item | State |
|---|---|
| **Owner-network read-only run** | Ready for you to run. Kit: `spec/tools/program-verify/run-readonly-local.sh` (§5). I cannot reach your computer: none of your connected devices holds this workspace. |
| **Meteora inquiry** | Prepared, **not sent**. It is your draft from the package, unchanged. It goes out only when you say so in words; it will carry no attachments. |
| **SEC-A carry-over** | Your adoption covers lockfile `307d35be…`. The natives removal (also your decision) produced lockfile `c2bb276a…`. I refreshed the evidence and nothing changed for the five records. I have recorded that confirming the adoption for the new lockfile is yours to do, rather than assuming it. |

## 2. Red → green

Evidence is in `project-qf/evidence/readonly-readiness/{red,green}/`.

| Finding | Before (actual run) | After |
|---|---|---|
| **Reviewer diagnostic, unmodified**, against the untouched `quoteforge-v0-repair-2026-09-27.zip` (source hashes `c2fb9956…`, `513b96b2…`, the same as the review) | Exit 0: both deficiencies reproduced. Body limit: 128 of 128 chunks read, no cancel. Config type 0, 1 and 255 all PASS. | Against the repaired code it now fails at its own assertion (5 of 128 chunks read), because the deficiency no longer reproduces. A recording variant (diff kept) shows the body limit cancelled after 5 of 128 chunks, and config type 0 FAIL, 1 PASS, 255 FAIL. |
| **CFG-TYPE** (verifier) | 4 red of 6 tests. The authority-mismatch and wrong-owner controls already passed. | 6 of 6 pass |
| **BODY-LIMIT** (verifier) | 11 of 11 red | 11 of 11 pass |
| **BODY-LIMIT** (adapter `createBoundedFetch`) | 6 of 7 red. Exact-cap acceptance already passed. | 7 of 7 pass |
| **Integer width** (SEC-A bigint condition) | 1 of 1 red: `"256"` was accepted as a u8 | 1 of 1 pass: u8…u128 and i8…i128 are range-checked, and non-decimal input is rejected |
| **Natives absent, and both ws fallbacks** | No red run was captured before the lockfile change | 3 of 3 pass |

## 3. What changed

**Config (CFG-TYPE)**
- The Customizable route now requires two things:
  - `pool_creator_authority` = `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`;
  - `config_type` = 1 (Dynamic).
- Static (0) and unknown enum values fail. Fixed-fee routes report `NOT_ASSESSED`, since they are outside V0.
- Evidence levels:
  - The authority rule and the Dynamic-type rule are `CONFIRMED_FOR_PINNED_SOURCE`, per your review. I did not re-read the pinned program source.
  - The MIT `cp-amm-sdk@1.4.10` corroborates that 0 means a public static config and that the dynamic-config instruction exists.
  - The authority PDA is `CONFIRMED_OFFLINE`. I re-derived it here: seed `pool_authority`, bump 255.
  - Live values are **UNVERIFIED**.
- Owner, layout and cluster checks are unchanged. The verifier is now 0.4.0 with report schema `/3`. The CLI flags are unchanged.

**Response bounds (BODY-LIMIT)**
- Bytes are counted while the body streams:
  - a declared oversize is refused before any byte is read;
  - overflow cancels the stream;
  - one deadline covers the headers and the whole body;
  - caller aborts are honoured.
- The verifier applies per-operation caps:
  - genesis and version: 64 KiB;
  - small account reads: 64 KiB of JSON and 16 KiB of decoded data;
  - ProgramData and IDL: 15 MiB of JSON and 10 MiB of decoded data, which fits the maximum Solana account size;
  - inflated IDL output: 8 MiB;
  - OtterSec status: 64 KiB.
- This is separate from the stream-json disposition, which is unchanged.

**Optional natives**
- The workspace now sets `ignoredOptionalDependencies: [bufferutil, utf-8-validate]`. These were declared optional by `rpc-websockets@9.3.9`; `ws` lists them only as optional peers.
- Setting that option on the existing lockfile did not remove them, so I re-resolved with pnpm. The only packages removed are `bufferutil@4.1.0`, `utf-8-validate@6.0.6` and `node-gyp-build@4.8.4`. All other 161 packages keep identical versions and integrities (`natives/lockfile.diff`).
- I confirmed that `ws@7.5.13` ignores the `WS_NO_*` flags.
- Both ws versions pass the pure-JS mask/unmask and UTF-8 validation tests and a localhost echo of 70 KB.
- The adapter runtime loads no `.node` file.

**SEC-A adoption**
- `evidence/sec-a/dispositions.json` (schema `/2`) now records:
  - `ADOPTED_BY_OWNER`: Jeremy Gephart, at the time of your message, with `signature: null`;
  - the technical basis;
  - your per-advisory conditions;
  - review-by 2026-12-27 as a latest date only;
  - the earlier recheck triggers.
- The raw audit is kept red: `audit-prod-raw-natives-removed.json` shows high 1 and moderate 2, the same three advisories as before.

## 4. Suites and checks (clean environment)

Environment: Node v22.22.2 and pnpm 10.33.0, secret-free wrapper, scripts off, all `node_modules` deleted first. Logs are in `evidence/readonly-readiness/full-run/`.

| Step | Result |
|---|---|
| Frozen install | exit 0 |
| SBOM | exit 0; 133 components |
| `chain` proof | exit 0; all checks PASS |
| Licence check | exit 0; 161 packages: ALLOW 134, ALLOW_EXCEPTION 2, REVIEW 0, NOT_INSTALLED 25, failures 0 |
| Web build and browser boundary | exit 0 |
| Typecheck | **The first run failed** with one TS2345 in the new width check. After the fix, both reruns exited 0. |
| Project tests | 185 of 185 (previously 175) |
| Verifier tests | 55 of 55 (previously 38) |
| Simulation | exit 0 |
| Raw audit | exit 1, as expected |
| Final rerun after the last code and doc edits | build, boundary, typecheck, tests, licence, SBOM, `chain` proof and verifier tests: all exit 0 |

## 5. Read-only verification

- **Cloud:** a dry run of the kit got `HTTP 403 Host not in allowlist` for both RPC hosts. The inventory was complete (86 expected, 0 missing, 0 duplicate, 0 unexpected), CONNECTIVITY failed, everything else was UNKNOWN, and the run exited 2. Nothing was verified and nothing was bypassed.
- **Your computer:** extract the ZIP, then run:

  ```sh
  cd spec/tools/program-verify && sh run-readonly-local.sh
  ```

  - The script checks Node ≥ 22.22 (tested on 22.22.2), then runs the frozen install, the offline tests and the existing CLI.
  - It uses `--mainnet https://api.mainnet.solana.com --devnet https://api.devnet.solana.com`, stops at the first failure, and writes `verification-results/` with `RUN-LOG.txt`.
  - Runtime hosts: the two RPC endpoints and `verify.osec.io` only. Installation needs `registry.npmjs.org`.
  - Send the folder back. Do not add paid or secret RPC URLs.

## 6. Readiness (`packages/core/src/readiness.ts`)

| Stage | Status | Open |
|---|---|---|
| OFFLINE_V0 | **ACTIVE** | — |
| READ_ONLY_VERIFICATION | **BLOCKED** (collection authorized) | **RO-1:** your run has not been returned. **RO-2:** live Customizable config values are unverified. **RO-3:** exit 0 counts for this stage only. |
| LOCALNET_INTEGRATION | **BLOCKED** | LOCAL-1 (Meteora written permission), LOCAL-2, LOCAL-3 |
| DEVNET_INTEGRATION | **BLOCKED** | DEV-1 (needs the stage above), DEV-2, DEV-3 (including the U.S. eligibility answer), SEC-A confirmation on the current lockfile |
| MAINNET | **BLOCKED** | all existing gates |

## 7. Ran, inspected, unverified

- **Ran:**
  - everything in §2 and §4;
  - the reviewer's diagnostic, both unmodified and as a recording variant;
  - the PDA derivation;
  - the kit dry run.
- **Inspected only:**
  - the ws 7 and ws 8 loader code;
  - the SDK's config-type usage;
  - the decision package.
- **Not verified:**
  - any live chain state (programs, authorities, configs, deploy slots, hashes);
  - deployed-versus-source parity;
  - the pinned-source line citations in the review, since I did not open Meteora program source;
  - Meteora service eligibility.
- **Not run:**
  - the owner-network run;
  - localnet, devnet and mainnet;
  - wallet or signing paths (none exist);
  - a red run of the natives test before the lockfile change.

No wallet, key, airdrop, simulation, signature, transaction, attestation or external message. The appendix list is at `project-qf/evidence/readonly-readiness/CHANGED-FILES.txt`: 74 files added (71 of them evidence or the review package), 23 modified, 0 removed.
