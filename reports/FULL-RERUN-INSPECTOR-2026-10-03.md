# Full re-run with real installs: Quote Asset Inspector + program verifier

Date: 2026-10-03 (run 10:03–10:08 UTC). Author: Claude (implementer). Reviewer: Astra. Owner: Jeremy Gephart.
Builds on: `reports/LIVE-ACCEPTANCE-INSPECTOR-2026-10-03.md` (branch `milestone/inspector-draft` @ `6c63da5`). This file can be pasted as is. The ZIP that carries it also holds the raw evidence, `MANIFEST.json` and `SHA256SUMS`.

## 1. Result in one paragraph
Jeremy's network change worked. The npm registry, both Solana RPC hosts and `verify.osec.io` all answered 200, so this run used **real frozen installs** and no hand-made links or shims. **All 230 tests pass, the verifier's 55 tests pass**, and typecheck, boundary, licence, `chain`-removal and SBOM checks are green. `pnpm audit --prod` shows the same 3 known SEC-A advisories as before. The live inspector re-run on the real server matched the earlier partial run exactly, and a draft on a live report survived a restart byte for byte. **The program verifier ran successfully against the live chain for the first time:** it exited 0, with 86 of 86 expected checks present and every required check satisfied, on mainnet and on devnet. Nothing was signed, sent, simulated or written to any chain. No keys were used.

## 2. What I need from Jeremy (short)
1. **Decide the wSOL rule (F1, unchanged).** It still fails S1.10 on live data. Astra's view first is welcome.
2. **Pick a second mainnet RPC provider (unchanged).** It must serve `getTokenLargestAccounts`. Public RPC still returns 429 for that method on every call.
3. **Decide whether READ_ONLY_VERIFICATION can move.** Its blockers RO-1 and RO-2 now have live evidence (§6). I have not changed `readiness.ts`, because that is your and Astra's call. Read F6 first: the exit 0 is from one provider only.

## 3. Reachability (first step)
| Host | Result |
|---|---|
| registry.npmjs.org | 200 (was 403 in the earlier run) |
| api.mainnet.solana.com | 200, getSlot 452900733 |
| api.devnet.solana.com | 200, getSlot 506958303 |
| verify.osec.io | 200 |

## 4. Full suite with real installs (`evidence/full-rerun/`)
Everything ran through a secret-free `env -i` wrapper (only HOME, PATH, LANG, TZ and the proxy CA path; the wrapper is in the evidence as `cleanenv.sh.txt`), with `--frozen-lockfile --ignore-scripts`, pnpm 10.33.0 via corepack, and Node v22.22.0.

| Step | Exit | Result |
|---|---|---|
| 01 install | 0 | 136 packages from the lockfile, lockfile sha256 `f5c8d2e9…c42b` (unchanged) |
| 02 sbom | 0 | 133 components |
| 03 deps:chain | 0 | 12/12 PASS, `chain` absent everywhere |
| 04 license:check | 0 | ALLOW 134, ALLOW_EXCEPTION 2, failures 0 |
| 05 build:web | 0 | |
| 06 boundary | 0 | PASS |
| 07 typecheck | 0 | |
| 08 test | 0 | **230/230 pass** |
| 09 sim | 0 | same table as before |
| 10 audit --prod | 1 | bigint-buffer (high), uuid (moderate), stream-json (moderate): the same 3 as SEC-A, nothing new |
| 11 verifier install | 0 | `@solana/addresses` 8.3.0 (verifier lockfile `2f6e28dd…8a18`) |
| 12 verifier test | 0 | **55/55 pass** |

Disclosure: my first try at steps 11–12 ran inside the workspace folder. pnpm treated it as part of the root workspace, installed nothing for the verifier, and the tests failed with `ERR_MODULE_NOT_FOUND`. I re-ran both in a copy of the folder, which is how the 07:02Z run did it. The logs in the ZIP are from the copy.

The real `@noble/hashes@1.8.0` gives economics digest `ac2d675e…bbb5`. That is the same value the shim gave in the earlier run, so the shim question in that report's §11.3 is now moot.

## 5. Live inspector re-run (`evidence/full-rerun/live-inspector/`)
I ran the real server (`node --use-env-proxy src/main.ts serve`) on a fresh SQLite file, with one provider per cluster. Every read had `genesisVerified: true`, at finalized commitment.

| Case | HTTP | Aggregate | PASS/WARN/FAIL/SKIP | Same as earlier run? |
|---|---|---|---|---|
| USDC mainnet | 201 | FAIL | 8/1/3/14 | yes |
| USDT mainnet | 201 | FAIL | 8/1/3/14 | yes |
| wSOL mainnet | 201 | FAIL | 9/1/2/14 | yes. S1.10 FAIL `ZERO_SUPPLY` (F1) |
| PYUSD (Token-2022) mainnet | 201 | FAIL | 5/2/6/13 | yes, 8 extensions decoded |
| USDC devnet | 201 | FAIL | 8/2/2/14 | yes |
| Mainnet USDC address on devnet | 201 | FAIL | 1/2/1/22 | yes. System-owned (F4) |
| Token program id as a mint | 201 | FAIL | 1/1/2/22 | yes |
| `not-a-mint` | 400 | — | — | yes, `INVALID_MINT` |
| cluster `testnet` | 400 | — | — | yes, `UNSUPPORTED_CLUSTER` |

- S1.12 is SKIP `SINGLE_PROVIDER` on all 7 live reports, as designed.
- `getTokenLargestAccounts` is UNAVAILABLE `RATE_LIMITED (HTTP 429)` on every mint, on both clusters.
- 7 of 25 features are measured on real mints and 0 on non-mints; `overallScore` stays null.

**Drafts** (`drafts/05-checks.txt`):
- A draft bound to the live USDC report was created (201, v1).
- Across a server restart, the draft and the inspection were both **byte-identical**, and the report digest still matched the draft.
- No token → 401. Wrong token → 401. A second user reading the owner's draft or inspection → 404 / 404.
- New in this run: an edit with `expectedVersion` 1 → 200 (v2); the same stale edit again → **409** `VERSION_CONFLICT`.

The tokens stayed in memory only. No token or SQLite file is in the evidence, and the driver script is included as `driver-live.mjs.txt`.

## 6. Program verifier, live (`evidence/full-rerun/program-verify/`)
Command (in a copy of `spec/tools/program-verify`, inside the secret-free wrapper with only the local proxy added):
`node --use-env-proxy verify-programs.mjs --mainnet https://api.mainnet.solana.com --devnet https://api.devnet.solana.com --out <dir>`

**Exit 0, `REQUIRED_CHECKS_SATISFIED`. Inventory: 86 expected, 0 missing, 0 duplicate, 0 unexpected.** Schema `qf-program-verify-report/3`, commitment finalized.

| | Mainnet | Devnet |
|---|---|---|
| Cluster identity (genesis) | PASS `5eykt4…N9d` | PASS `EtWTRA…ZBG` |
| DBC presence / loader / ProgramData | PASS / PASS / PASS `HUfnSS…YCh` | PASS / PASS / PASS (same address) |
| DBC upgrade authority | `JADaUV8k…uCVLd` (upgradeable) | `DHLXnJdA…L76ViX` |
| DBC deploy slot | 445503633 | 503167099 |
| DBC executable sha256 | `b3f7b765…6c44` | `e9599c7d…1551` (different) |
| DBC on-chain IDL | 0.1.10, 28 ix, `has_create_config2` false | same |
| DAMM v2 presence / loader / ProgramData | PASS / PASS / PASS `AUh8bm…nyPH` | PASS / PASS / PASS |
| DAMM v2 upgrade authority | `JADaUV8k…uCVLd` (same key as DBC) | `DHLXnJdA…L76ViX` |
| DAMM v2 executable sha256 | `7c479dd7…94e0` | `f838b2ae…9a9c` (different) |
| SF Rewards (candidate) | present, upgradeable, no IDL (INTERFACE UNKNOWN) | same |
| Migration configs (7) | all CONFIG PASS, 328 bytes, decoded | all PASS |
| **Customizable CONFIG_COMPATIBILITY** | **PASS**: pool_creator_authority `FhVo3mqL…HLuM`, config_type 1 | **PASS** |
| Fixed-fee routes | NOT_ASSESSED (outside V0) | NOT_ASSESSED |
| SOURCE_BUILD / AUDIT_COVERAGE | NOT_ATTEMPTED / NOT_EVALUATED (LOCAL-1) | same |

What this closes:
- **RO-1:** an owner-authorized live run now exists. It ran in Jeremy's cloud environment with his allowlist, not on his own computer.
- **RO-2:** the live Customizable config was read on both clusters and matches the pinned-source rules.

An exit 0 here establishes on-chain state only. It is not a source match, not an audit, and not readiness for LOCALNET, DEVNET or MAINNET (RO-3).

## 7. Findings
- **F1 (open, unchanged): wSOL fails S1.10** with ZERO_SUPPLY on live data. The proposed rule is still a native-mint-only NOT_APPLICABLE. I have not changed it.
- **F2 (open, unchanged):** public RPC answers `getTokenLargestAccounts` with 429, always.
- **F3 (refined):** OtterSec's `on_chain_hash` for mainnet DBC **equals** the hash we computed, so OtterSec is looking at the same bytes; it just has no verified source. DAMM v2 has no OtterSec hash at all. Our SOURCE_BUILD path remains the only provenance route, and it waits on LOCAL-1.
- **F4 (open, minor UX):** a System-owned address gives an unhelpful message. Unchanged.
- **F6 (new, please read before moving readiness): exit 0 is single-provider.** The verifier adds CROSS_CHECK to its inventory only when `--mainnet2` is passed. Without it, a one-provider run can exit 0, which is why it did not exit 2 as expected. CLAUDE.md requires a second-provider cross-check for critical reads. My proposal: treat this report as satisfying RO-1/RO-2 on a single provider, and add a blocker `RO-4: second-provider CROSS_CHECK not yet run`. Alternatively, make the verifier emit CROSS_CHECK UNAVAILABLE (exit 2) when `--mainnet2` is absent. That second option is a verifier behaviour change, so I have not made it.
- **F7 (new): devnet runs different program bytes than mainnet.** The executable hashes, deploy slots, upgrade authorities and ProgramData lengths all differ between clusters. Devnet integration results therefore do not prove mainnet behaviour, and DEVNET_INTEGRATION evidence should say so.
- **F8 (new): one key can upgrade both DBC and DAMM v2 on mainnet** (`JADaUV8k…`). That is normal for a team-run program, but it means the code under us can change at any time. I suggest recording the hashes above as a baseline and re-running the verifier before any later stage, flagging any drift in deploy slot or hash.
- **F9 (new, indicator only): the mainnet DBC IDL says 0.1.10 with no `create_config2`.** An IDL can lag the deployed code, so this proves nothing about 0.2.x. It still supports keeping `DBC_BASE_TRANSFER_FEE` disabled (ADR-003) until the capability is shown another way.

## 8. Acceptance items, updated
- **Item 8:** real mainnet and devnet reads, the draft round trip and a verifier run are all done. **Still open:** two independent providers (S1.12 and CROSS_CHECK) and largest-accounts data. My reading: substantially met; it is fully met once a second provider exists.
- Items 1–7 and 9 are unchanged and were re-observed live.
- **Readiness:** `readiness.ts` is unchanged (READ_ONLY_VERIFICATION is still BLOCKED in code), pending the decision in §2.3.

## 9. Git
- New commit on `milestone/inspector-draft`: this report, `evidence/full-rerun/`, and the four tracked evidence files the run regenerates (timestamps and paths only: `browser-boundary.json`, `chain-removal/proof.json`, `license-check.json`, `sbom/project-qf.cdx.json`).
- No code changes. The bundle `git/project-qf.bundle` was refreshed (fast-forward only).

## 10. Notes for Astra
1. **F1:** native-mint-only NOT_APPLICABLE for S1.10, or admit wSOL through S2.1 registry admission instead? I'll implement whichever you and Jeremy choose, test-first.
2. **F6:** which do you prefer: an RO-4 blocker in readiness, or the verifier reporting CROSS_CHECK UNAVAILABLE when `--mainnet2` is absent? I lean toward both. The verifier change is about 10 lines plus tests.
3. **F7/F8:** should the mainnet hashes and deploy slots in §6 become a pinned baseline in PROGRAM-VERIFICATION.md, with drift as a hard stop?
4. **Second provider:** please fold "must serve getTokenLargestAccounts" and "must be independent of api.mainnet.solana.com" into the DATA-PROVIDERS recommendation, so Jeremy can pick one.
5. The open asks from the milestone return report §11 still stand: the GitHub repo, SEC-A adoption on lockfile `f5c8d2e9`, and a send/hold on the Meteora inquiry.
