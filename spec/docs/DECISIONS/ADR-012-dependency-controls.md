# ADR-012: Dependency controls — LGPL exception and `chain` removal

- Status: **Accepted** (2026-09-27, Decisions 1 and 4)
- Amends: LICENSES.md §1/§3, DEPENDENCIES.md §2, THREAT-MODEL.md

## Decision 1 — QF-LIC-EX-001
- **What.** `rpc-websockets@9.3.9` (LGPL-3.0-only), unmodified, allowed only for internal server-side use of `@project-qf/adapter-meteora-dbc`, via `@solana/web3.js@1.99.0`.
- **Record.** Integrity, dependency path, permitted and prohibited targets, owner, conditions and review triggers are in `LICENSE-MANIFEST.json` and LICENSES.md §5.
- **Not allowed.** No browser, downloadable SDK/CLI, mobile/desktop, customer container, on-prem or redistributable bundle.
- **Other LGPL packages.** Still denied. No scan suppression.
- **Browser boundary.** `tools/boundary` checks the web dependency graph, bundle inputs, emitted JS, the worker bundle and public source maps, plus wallet/UI packages. Canaries prove detection.
- **Verifier.** It no longer uses web3.js, so the exception does not extend to it.

## Decision 4 — QF-DEP-RM-001
- **Inspection first.** The pinned published artifact was inspected before install:
  - tarball sha256 `5bc51276…ba71`, integrity `sha512-Y3UPjP91…vcD8g==`;
  - ESM, CJS, exports map, dynamic imports and source maps were checked;
  - `chain` appears only in the manifest and in two "on-chain" comments.
- **Removal.** `pnpm-workspace.yaml` → `overrides: "@meteora-ag/cp-amm-sdk@1.4.10>chain": "-"`.
  - Installed in a disposable, secret-free environment with lifecycle scripts disabled.
  - A negative control without the override resolves `chain@0.4.2`, proving the override is what removes it.
- **Absence proof.** `pnpm deps:chain` checks the lockfile, resolved graph, `node_modules`, both SBOMs and runtime `require.cache`, and confirms the adapter tests pass without it (`evidence/chain-removal/proof.json`, 12/12 PASS).
- **Upstream.** The unmodified published manifest still declares `chain`; that is kept as evidence. It is not treated as a compromise.
- **If it turns out to be required.** Stop that adapter path; never fake behaviour with a stub.

## Consequences
Every install uses `--ignore-scripts`. Adding a dependency requires the licence and boundary checks to pass.

## Amendment 2026-09-27 (repair pass) — LIC-R1 pako and SEC-A dispositions
**QF-LIC-EX-002.** `pako@2.2.0` `(MIT AND Zlib)` is allowed as an exact exception (`status: APPROVED_EXACT` in `LICENSE-MANIFEST.json`), not as a policy change: Zlib stays REVIEW for every other package. `tools/license-check` enforces the licence expression, lockfile integrity, that the package is not patched, and that both upstream notices (`LICENSE` for MIT, `lib/zlib/README` for Zlib) are preserved byte-identical under `project-qf/licenses/pako@2.2.0/`. Both are reproduced in THIRD_PARTY_NOTICES.md.

**SEC-A.** No blanket waiver and no `audit fix --force`. The raw audit stays red and visible (`project-qf/evidence/sec-a/audit-prod-raw-{pre,post}-mitigation.json`). Each advisory has a version-bound record (`evidence/sec-a/dispositions.json`: advisory, version, integrity, target, call path, input reachability, mitigation, tests, approval, expiry 2026-12-27, recheck triggers), asserted against the installed artifacts by `packages/adapter-meteora-dbc/test/sec-a.test.ts`:

| Advisory | Package | Disposition | Mechanism |
|---|---|---|---|
| GHSA-3gc7-fjrx-p6mg | bigint-buffer 1.1.5 | MITIGATED_PATCHED | `patchedDependencies` removes the native loader; no addon installed or loaded (ignore-scripts alone is not relied on) |
| GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j | toml 3.0.0 → 4.2.0 | FIXED_BY_SCOPED_OVERRIDE | `"@coral-xyz/anchor@0.31.1>toml": "4.2.0"`; QF never reads `anchor.workspace` or any TOML |
| GHSA-w5hq-g745-h8pq | uuid 8.3.2 | NOT_AFFECTED_PATH_SPECIFIC | only jayson depends on it and only calls `v4()` with no buffer |
| GHSA-528h-pc64-c93x | stream-json 1.9.1 | NOT_AFFECTED_PATH_SPECIFIC | jayson requires only StreamValues/Verifier; not loaded at runtime; RPC responses bounded (8 MiB, depth 64) regardless |

Approval of these dispositions is the owner's (recorded as PENDING_OWNER). Prebuilt native `bufferutil`/`utf-8-validate` binaries loaded by `ws` are recorded as an observation outside the five advisories.

## Amendment 2026-09-27 (decision review) — SEC-A adopted; optional natives removed
- **SEC-A adopted by the owner** (thread message of 2026-09-27T15:59:36Z, Jeremy Gephart), scoped to the internal Node V0 adapter: bigint-buffer MITIGATED_PATCHED, both toml FIXED_BY_SCOPED_OVERRIDE, uuid and stream-json NOT_AFFECTED_PATH_SPECIFIC. Recorded in `project-qf/evidence/sec-a/dispositions.json` (schema /2) without any signature, with the owner's per-advisory conditions, review-by 2026-12-27 as a latest date, and earlier triggers. Not production approval; the raw audit stays red and visible.
- **Condition added for bigint-buffer:** approved integers are range-checked to their exact IDL width (u8…u128, i8…i128) in `packages/tx` `normalizeToIdl`, not assumed u64.
- **Optional natives removed.** `pnpm-workspace.yaml` `ignoredOptionalDependencies: [bufferutil, utf-8-validate]` (targeted; declared optional by `rpc-websockets@9.3.9`, optional peers of `ws`). `ws@7.5.13` ignores the `WS_NO_*` flags, so absence is the control. The lockfile was re-resolved with pnpm: only `bufferutil@4.1.0`, `utf-8-validate@6.0.6` and `node-gyp-build@4.8.4` left; the other 161 packages keep identical versions and integrities. Both ws versions pass pure-JS fallback and localhost echo tests; no `.node` file is loaded by the adapter runtime.
- **Evidence refreshed** on the new lockfile (sha256 `c2bb276a…90e6`): SEC-A tests 9/9, raw audit high 1 / moderate 2 (same three listed advisories). Whether the adoption given for lockfile `307d35be…` carries to the new lockfile is recorded as the owner's to confirm.
- **Transport bounds are separate from the stream-json disposition.** `createBoundedFetch` now counts bytes while streaming, cancels on overflow and keeps one deadline through the body (BODY-LIMIT).
