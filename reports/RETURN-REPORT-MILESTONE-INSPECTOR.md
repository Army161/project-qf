# Return report: private read-only milestone "Quote Asset Inspector + Saved Creator Draft"

Date: 2026-10-03. Author: Claude (implementer). Reviewer: Astra. Owner: Jeremy Gephart.
Scope source: `spec/reviews/2026-10-03-alignment/` (Astra's package, stored verbatim). This report is one file and can be pasted as is. The ZIP that carries it also has the code, the evidence and a git bundle; see `MANIFEST.json` and `SHA256SUMS` in the ZIP.

## 1. Result in one paragraph
The integrated slice works end to end on the real server process and a real SQLite database:
1. enter a mint;
2. the server reads it through a read-only RPC client, or shows exactly why it could not;
3. the report shows all 26 QUOTE-ASSETS checks plus an evidence check, with sources, network, slots and timestamps;
4. a creator draft is saved, bound to the report digest and the policy versions;
5. the draft and its report reload from the database after a server restart;
6. measured feature components are shown, with every missing input named.

It is **offline-complete, not live-ready**. Every live read from this environment was refused by the egress proxy (CONNECT 403), so live acceptance (item 8) is still blocked. Nothing in the slice can sign, send, simulate or write to a chain, and it binds to 127.0.0.1 only.

Tests: **230/230** project tests (185 before, 45 added) and **55/55** verifier tests. Typecheck, browser boundary, licence check, chain-absence proof and SBOM all pass. The raw `pnpm audit --prod` stays red with the **same three advisories** as the SEC-A record. Nothing is new, and all three sit under the server-only Meteora adapter.

## 2. Acceptance items (MILESTONE-ACCEPTANCE.md)
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Invalid mint and wrong network rejected | **Met** | Strict parser: non-base58, wrong length, unknown cluster, unknown fields → 400 (`packages/contracts/test/contracts.test.ts`). Wrong network: each provider must return the expected genesis hash, else `WRONG_NETWORK` and no account read (`apps/api/test/api.test.ts`, "wrong network"). Not found on the chosen network: S1.1 FAIL "check the network". |
| 2 | Unavailable, stale or disagreeing data is explicit; no spurious PASS | **Met** | LIVE aggregate FAILs whenever a required check is missing or SKIP. Unavailable reads show the reason. Two providers disagreeing → S1.12 FAIL. Reports carry `ageSeconds` and FRESH/STALE (3600 s). Tampered stored reports → 500 INTEGRITY_ERROR. |
| 3 | TEST_ONLY separate; blocked live never falls back | **Met** | Fixtures answer only the explicit `test-only` network, are labelled `TEST_ONLY_FIXTURE`, and are capped at WARN. A blocked live read of a mint that *is* a fixture still shows UNAVAILABLE + FAIL with no fixture provider in the report (API test, and the Chromium e2e, which also checks the page). |
| 4 | Drafts and evidence/policy refs survive restart; unauthorized access rejected | **Met** | The API test closes and reopens the database and server. The demo restarts the real process: the draft is byte-identical and the report digest matches. Bearer tokens are stored as SHA-256 only. Another user's report or draft reads as 404 and cannot be linked or edited. |
| 5 | Missing social/history/cohort inputs stay null; no fabricated history or ranking; LLM never the source | **Met** | `features-v0.1`: 25 components, each MEASURED or UNAVAILABLE with a reason. `overallScore` is always null with the reason given. No LLM anywhere in the slice. |
| 6 | Policy changes go through review/consent; no silent clamping | **Met for this slice** | Drafts contain no economic terms, so nothing can be clamped. Each draft records the economics version and digest, the template, validator, inspection and features versions. On read, `policyStale` and `policyChanges` name anything that changed, and the UI shows "POLICY CHANGED". Re-saving records the current policies as a new version; the old version stays in append-only history. Consent binding stays in `packages/tx`, unchanged. |
| 7 | Boundary, security, licence controls and existing tests still pass; raw advisories separate | **Met** | §4. The browser bundle now includes `app.js` (contracts + core only). The boundary scan covers it, the worker and the source maps, and both canaries still fire. Raw audit reported separately in §4. |
| 8 | Live acceptance needs real authorized reads | **Blocked (honestly)** | The real-server demo tried mainnet and devnet through the actual network path. Both got `NETWORK_POLICY_DENIED (egress proxy refused the tunnel: HTTP 403)`, and curl sees the same CONNECT 403. Nothing was claimed live. §6 says what unblocks it. |
| 9 | One integrated vertical slice | **Met** | `apps/web/test/inspector.e2e.test.ts` drives Chromium against the real API server: sign in → inspect → save draft → reload page → reopen draft from backend → edit (v2) → blocked live read. The demo (§5) repeats this on the real `serve` process. |

## 3. What was built
| Piece | Path | Notes |
|---|---|---|
| Mint decoder | `packages/validator/src/mint.ts` | SPL Token and Token-2022. TLV extensions 1–28 by name, transfer-fee config decoded. Rejects wrong owner, wrong length, bad option tags, non-zero padding, wrong account type, TLV overrun, duplicate extensions. Round-trip fixture encoder. |
| Inspection | `packages/validator/src/inspect.ts` | `inspection-v0.1`, run on raw observations; details in §7. |
| Features | `packages/features` | `features-v0.1`. Mint facts, plus top-1 and top-10 token-account share in bps; the caveat says program-owned accounts are *not* excluded. 16 named UNAVAILABLE sources. |
| Contracts | `packages/contracts` | `qf-api/1` types and strict parsers shared by server and browser. Rejects unknown fields; text is bounded; control and bidi characters are rejected. |
| RPC client | `apps/api/src/rpc.ts` | Three methods only (`getGenesisHash`, `getAccountInfo`, `getTokenLargestAccounts`), finalized commitment. Responses are capped while streaming, with a deadline. Cluster proven by genesis hash, never by hostname. Endpoints must be https without credentials. Errors are sanitized; a proxy tunnel refusal is read from the error's cause chain. |
| API | `apps/api/src/server.ts`, `main.ts` | `node:http`, bound to 127.0.0.1. Bearer auth and owner scoping. JSON only, 16 KiB body cap, 30 inspections per minute per user. The report digest is re-checked on every read. Optimistic draft versions (409 on conflict). Same-origin static hosting with a strict CSP. |
| Store | `apps/api/src/store.ts` | `node:sqlite` (built into Node 22) with versioned migrations; it refuses a newer schema. Append-only draft history. |
| UI | `apps/web/index.html`, `src/app.ts` | Sign-in, inspect, report, draft, saved drafts, recent inspections. Text only (no innerHTML); the token is kept in sessionStorage for the tab. CSP `connect-src 'self'`, so the browser never calls an RPC. The mock lifecycle moved to `mock.html`. |

No new third-party dependency. In the lockfile, `packages` and `snapshots` are byte-identical to `c2bb276a…`. Only `importers` changed: 42 added `workspace:*` link lines (`evidence/milestone-inspector/LOCKFILE-DIFF.txt`). New lockfile sha256: **`f5c8d2e908297ad6dd140ba72ba2c42ee1716690f7e80b97093b95f4b36bc42b`**.

## 4. Commands and actual outputs (final run on the committed code)
Every command ran in the secret-free clean environment with `--ignore-scripts`. Logs: `evidence/milestone-inspector/full-run/` (each with command, UTC time and exit code). Runtime: Node v22.22.2, pnpm 10.33.0.

| Step | Command | Exit | Result |
|---|---|---|---|
| 01 | `pnpm install --frozen-lockfile --ignore-scripts` (fresh, node_modules deleted) | 0 | |
| 02 | `pnpm sbom` | 0 | SBOMs regenerated |
| 03 | `pnpm deps:chain` | 0 | RESULT PASS; `chain` absent from both SBOMs |
| 04 | `pnpm license:check` | 0 | 0 failures, 0 review-required |
| 05 | `pnpm build:web` | 0 | app.js, main.js, merkle.worker.js + maps |
| 06 | `pnpm boundary` | 0 | PASS; canary A detected, canary B refused |
| 07 | `pnpm typecheck` | 0 | |
| 08 | `pnpm test` | 0 | **230 tests, 230 pass, 0 fail** |
| 09 | `pnpm sim` | 0 | |
| 10 | `pnpm audit --prod --json` | 1 | Raw: 1 high, 2 moderate, the **same three as SEC-A**. GHSA-3gc7-fjrx-p6mg (bigint-buffer, high), GHSA-w5hq-g745-h8pq (uuid), GHSA-528h-pc64-c93x (stream-json), all only via `packages/adapter-meteora-dbc`. None reach `apps/api`, `apps/web` or the new packages. |
| 11–12 | verifier (copy of `spec/tools/program-verify`): install + `pnpm test` | 0 / 0 | **55 tests, 55 pass** |

New tests (45):
- `packages/validator/test/inspect.test.ts`: 12
- `packages/features/test/features.test.ts`: 4
- `packages/contracts/test/contracts.test.ts`: 6
- `apps/api/test/rpc.test.ts`: 7
- `apps/api/test/api.test.ts`: 15
- `apps/web/test/inspector.e2e.test.ts`: 1

The existing mock e2e now loads `/mock.html`. Before the final run, two problems found while testing were fixed test-first:
- The check inventory dropped S1.3, S1.7 and S1.11 when evidence was missing, and never listed S3.7 or S3.8. It now always lists all 26.
- A real proxy refusal surfaced as "Request was cancelled". It now reads `NETWORK_POLICY_DENIED (egress proxy refused the tunnel: HTTP 403)`, taken from the cause chain.

## 5. Integrated demo (real server process)
Transcript: `evidence/milestone-inspector/demo/demo-transcript.txt` (token redacted). Screenshots: `demo/screens/` (sign-in; draft reloaded from backend; live read blocked).
1. `create-user` printed a token once; only its SHA-256 is stored. `GET /api/session` without the token → 401.
2. TEST_ONLY inspection of the qUSD fixture: WARN (never PASS), 13 evaluated, 13 skipped of 26, 9 of 25 features measured, overall score null.
3. Draft saved (v1) bound to that report's digest and policy versions.
4. **Server process restarted.** Draft reloaded byte-identical, and the inspection's report digest matched.
5. Edit with `expectedVersion 1` → v2; a second stale edit → **409 VERSION_CONFLICT**.
6. **Live** mainnet and devnet inspections of the USDC mint through the real network path both returned UNAVAILABLE with `NETWORK_POLICY_DENIED (egress proxy refused the tunnel: HTTP 403)`. IN.1 FAILs, the aggregate is FAIL, no facts, 0 features measured. curl through the same proxy: `CONNECT tunnel failed, response 403` for both hosts.

## 6. Remaining blockers and owner actions
These are owner actions. None of them blocks more offline work.
1. **Network access for live reads.**
   - The actual surface: this is a Claude Code cloud session inside your claude.ai Project. The project has **no cloud environment selected**, so it runs on a built-in environment that has no settings to change.
   - To allow reads, open Project settings → Environment, open the Cloud environment menu and choose **Add cloud environment**. Under Network access choose **Custom**, add the RPC hosts you pick (for example `api.mainnet.solana.com`, `api.devnet.solana.com`, a second provider's host, and `verify.osec.io` for the verifier), and keep the default package-manager list. Docs: https://code.claude.com/docs/en/cloud-environments#network-access.
   - Sessions started after that run on the new environment; this session does not change.
   - Alternative: run the read-only kit on your own machine.
2. **A second independent mainnet RPC provider**, with its terms accepted by you. Without it S1.12 stays SKIP and a live inspection cannot PASS by design. The public Solana endpoints are rate-limited and not for production.
3. **SEC-A carryover adoption.** Astra recommends carrying the narrow SEC-A acceptance over to the graph. The graph is unchanged, but the lockfile hash is now `f5c8d2e9…` because only workspace links were added. Your adoption has to be real and recorded against the lockfile that is actually committed. Nothing was signed or adopted for you.
4. **GitHub remote.** Still not created; Astra's lookup of Army161/project-qf returned 404. The git bundle in this ZIP carries `main` and `milestone/inspector-draft` with full history. Once an empty private repo exists and is connected, I push both branches as they are: no rewrite, no force-push.
5. **Meteora inquiry.** Still unsent. It needs your explicit "send it" and goes with no attachments and no QF source.
6. The $100 credit is not a blocker.

## 7. Caveats and things I am flagging
- **`node:sqlite` is experimental** in Node 22 (it prints a warning). It was chosen to avoid a new native dependency. If that's not acceptable, the alternative is a reviewed SQLite package, which needs a licence and SEC-A review.
- **Inspection rules.**
  - **S1.6** applies the TOKEN-2022.md §2 permissionless rule; it was not re-derived from `is_supported_quote_mint` in this pass.
  - **S1.7** badge lookup is not implemented, so any quote mint that needs a TokenBadge FAILs.
  - **S1.11** metadata is not read.
  - **S3.4** program-account exclusion is not implemented; raw shares are reported as features only.
- **Single-process limits.** The rate limit and the genesis cache live in memory. There is no token rotation or expiry UI. This is a private 127.0.0.1 tool, not a deployable service.
- **Staleness is shown, not enforced.** A draft can be saved against a STALE inspection; the report shows STALE and the draft records the decision at save time.
- **Release tracking.** The facts about PR #116 and #117 come from Astra's evidence. I did not open those pull requests, because this session's GitHub scope does not cover third-party repositories. The citation checks for authority equality and Dynamic config type were done by me against the pinned files (blob SHAs in PROGRAM-VERIFICATION §7).
- **Wording.** "The verifier has been attempted and has never successfully verified the live chain." Two earlier reports said "never run"; both now carry a dated correction.

## 8. Spec amendments (appended, nothing regenerated)
- **ADR-003, PROTOCOL §3, METEORA §4–5, DEPENDENCIES, `core/flags.ts`, CLAUDE.md:** the transfer-fee gate tracks a released capability (PR #116 proposes SDK 1.6.0; PR #117 is the separate 2.0 refactor; PR #114 is closed), not "SDK 2.x". Nothing was upgraded; the capability stays disabled.
- **PROGRAM-VERIFICATION §7:** "checked against pinned source, not deployed bytecode", with file, line and blob SHA. Run status worded precisely.
- **DEPENDENCIES and ROADMAP:** bigint-buffer exit-path investigation (upstream first, then one narrow client-layer proof; not adopted). Inspector milestone row. Live-acceptance prerequisites.
- **QUOTE-ASSETS §10:** the `inspection-v0.1` mapping. **TESTING §7:** suites and counts. **README:** how to run the inspector.

## 9. Git
- Branch `milestone/inspector-draft` on top of `main` (4 commits, unchanged):
  - `7ebac1c513b99adc0d6b52c8d3adce7d811ab3c4` inspector and drafts;
  - `14ea8ba04e8fdde1ff67bced6a69c1e93e18c0b7` spec amendments;
  - this report is the next commit.
- History was preserved: nothing was rebased, reinitialized or force-pushed. The bundle's hash is in the ZIP's `SHA256SUMS`.
- Restore: `git clone project-qf.bundle project-qf && cd project-qf && git checkout milestone/inspector-draft`.

## 10. Next concrete action
- **For Jeremy:** do §6 item 1 (add a cloud environment that allows your chosen RPC hosts) and pick the second provider.
- **Then for Claude, in a new session on that environment:**
  - run the live acceptance (item 8): real mainnet reads from two providers;
  - store the evidence;
  - run the verifier;
  - report what passes and what stays SKIP.
- **Meanwhile, offline:** TokenBadge lookup (S1.7) and program-account exclusion (S3.4) are the next checks that can be built test-first against fixtures.

## 11. Handoff to Astra
Please review the integrated milestone against MILESTONE-ACCEPTANCE.md. Specific asks:
1. **Escalation check.** This slice adds a local HTTP API, bearer-token auth and a SQLite store (`node:sqlite`, experimental, built into Node). I read these as in scope (you asked for API, DB and access control), not as a new architecture. Tell me if you see it differently.
2. **S1.6.** Is the TOKEN-2022.md §2 rule acceptable for `inspection-v0.1`, or do you want S1.6 re-derived from DBC 0.2.1 `is_supported_quote_mint`? If so, please give the pinned path and lines as you did for the config rules.
3. **Staleness at save.** Should saving a draft against a STALE inspection be refused (re-inspect first) instead of displayed?
4. **SEC-A.** Please confirm that the carryover applies to the identical resolved graph under the new lockfile hash `f5c8d2e9…` (importers-only change, proof in `evidence/milestone-inspector/LOCKFILE-DIFF.txt`), so Jeremy can adopt it against the committed file.
5. **Second provider.** Is there an approved provider you'd recommend from DATA-PROVIDERS.md? Its terms decide whether QF may store the reads.
