# Project QF: V0 decisions applied and offline work started

Date: 2026-09-27. Scope: the five V0 decisions in DECISION-ADDENDUM.md and CLAUDE-V0-HANDOFF.md.
Package: `quoteforge-v0-2026-09-27.zip` (spec, verifier, `project-qf` source and evidence; see MANIFEST.json and SHA256SUMS inside).

**How to read this.**
- The five decisions and the readiness split were applied by amending existing files, not by regenerating the spec.
- All results below are from runs in Claude's cloud sandbox. **No part of the package has been independently audited.** The ChatGPT review covered three summary documents only.
- **VERIFICATION-CHECKLIST.md was not attached** and was not available. I used the addendum's "Live verification" section and the handoff's "Run the verifier correctly" section as the acceptance criteria instead.
- Mock and simulation outputs are labelled as such and are not blockchain results.
- No wallet was connected, no key was created, and nothing was signed, sent, simulated on-chain or attested.

## 1. Readiness (ADR-011, `project-qf/packages/core/src/readiness.ts`)

| Stage | Status | What blocks it |
|---|---|---|
| **OFFLINE_V0** | **ACTIVE** | Nothing. The dependency controls passed (§4, §5) |
| **LOCALNET_INTEGRATION** | **BLOCKED** | **LOCAL-1**: written Meteora or counsel permission for local program copies, source builds, CI caching and distribution (ADR-013). **LOCAL-2**: artifact provenance tied to a verified deployment. **LOCAL-3**: compatible Agave tooling and the clone list from a successful verification |
| **DEVNET_INTEGRATION** | **BLOCKED** | **DEV-1**: the verifier must reach devnet and exit 0; RPC was blocked here (§6). **DEV-2**: cluster-safety checks (genesis-bound endpoint; disposable, unfunded wallet generated outside model context; no mainnet write path). **DEV-3**: devnet/service terms review. Also: disposition of the 5 open audit advisories (§5.4) |
| **MAINNET** | **BLOCKED** | Unchanged: P0-M1 to M7 (commercial-use confirmation, jurisdiction policy, production economics, external security review, multisigs, final name, rewards settlement audit) |

## 2. Decisions applied

Decision IDs: **D1** = LGPL exception, **D2** = liquidity floor, **D3** = migration ceiling, **D4** = `chain` removal, **D5** = fee scheduler, **R** = readiness split.

| Decision | Result | Where |
|---|---|---|
| D1 | `rpc-websockets@9.3.9` recorded as **QF-LIC-EX-001, APPROVED_NARROW**. The record holds its integrity, the only dependency path, permitted and prohibited targets, owner, conditions and review triggers. `license:check` enforces that the package appears only via the adapter. `pnpm boundary` passes on the web graph, bundles, worker and source maps. The verifier no longer uses web3.js | LICENSE-MANIFEST.json, LICENSES.md §5, ADR-012 |
| D2 | `liquidityFailUsd = 25000` is an EXPERIMENTAL validator-v0.1 parameter. It applies to existing quote-asset markets only, with pool dedupe, S3.1 exit depth as a separate check, exact decimals, and TEST_ONLY namespace and promotion guards | QUOTE-ASSETS.md §8, ADR-007, `packages/validator` |
| D3 | `ceilUsd = 100000` is a configurable V0 experiment ceiling only. The spec keeps five quantities separate. The builder is `buildCurve`, and `migrationMarketCap` is never used. Requests outside the floor and ceiling are rejected, never clamped. Every threshold records its raw amount and price evidence. Stale prices require repricing; material changes require new consent. The adapter fails closed on SDK drift | ECONOMICS.md §6, `packages/policy`, adapter |
| D4 | `chain` was removed with `"@meteora-ag/cp-amm-sdk@1.4.10>chain": "-"`, after inspecting the published artifact. Removal is proven (§5) | DEPENDENCIES.md, ADR-012, THREAT-MODEL.md |
| D5 | The flat fee stays the V0_TEST baseline. One bounded decay (2,500 → 100 bps, 12 × 10 s) is SIMULATION_ONLY, and the tx layer rejects it. Six identical traces were run; failures are retained | ECONOMICS.md §6.3, `docs/simulations/FEE-SCHEDULER-COMPARISON-V0.md` |
| R | Four readiness stages; mocks labelled | ADR-011, CLAUDE.md, README.md |

## 3. Files changed

**Spec: amended.**
- Root files: CLAUDE.md, README.md, THIRD_PARTY_NOTICES.md, LICENSE-MANIFEST.json.
- docs: LICENSES.md, DEPENDENCIES.md, THREAT-MODEL.md, QUOTE-ASSETS.md, ECONOMICS.md, DEVNET.md, PROGRAM-VERIFICATION.md, TESTING.md, ROADMAP.md.
- ADRs: ADR-002, ADR-003, ADR-004, ADR-007.

**Spec: new.**
- ADR-011 (readiness stages).
- ADR-012 (dependency controls).
- ADR-013 (no local program copies until permission).
- `docs/simulations/FEE-SCHEDULER-COMPARISON-V0.md`.
- `docs/verification/PROGRAM-VERIFICATION-2026-09-27.{md,json}`.
- This report.

**Spec: rewritten.** `tools/program-verify/`:
- `lib.mjs` and `verify-programs.mjs`;
- `package.json`, `pnpm-lock.yaml`, `.npmrc`, `README.md`;
- `test/verify.test.mjs`.

The other 32 spec files are unchanged.

**Code: new, `project-qf/` (107 files).** Packages:
- core, validator, policy, rewards, tx;
- adapter-meteora-dbc (server-only);
- apps/web (mock UI);
- tools: license-check, deps, boundary, econ-sim, lib.

Also the lockfile, SBOMs and `evidence/`.

## 4. Tests

All runs used a secret-free `env -i` wrapper with lifecycle scripts off (Node v22.22.2, pnpm 10.33.0). The full log with outputs and exit codes is `project-qf/evidence/test-run.txt`.

| Command | Exit | Result |
|---|---|---|
| `pnpm install --frozen-lockfile --offline --ignore-scripts` | 0 | lockfile sha256 `c1943e1c…3d73b` |
| `pnpm sbom` | 0 | CycloneDX 1.6: 136 components (all), 53 (apps/web) |
| `pnpm deps:chain` | 0 | 12/12 PASS |
| `pnpm license:check` | 0 | 164 packages: ALLOW 137, ALLOW_EXCEPTION 1, REVIEW 1 (pako), NOT_INSTALLED 25 |
| `pnpm build:web` | 0 | |
| `pnpm boundary` | 0 | PASS |
| `pnpm typecheck` | 0 | strict tsc, clean |
| `pnpm test` | 0 | **108 tests, 108 pass, 0 fail, 0 skipped, 0 todo** |
| `pnpm sim` | 0 | resultsHash `3f8bd4e7…15a9` |
| `pnpm audit --prod` | **1** | 3 high, 2 moderate, all in adapter transitive dependencies (§5.4) |
| verifier `pnpm test` (fresh copy of the spec folder) | 0 | **16/16 pass**, 0 skipped |
| verifier `pnpm audit --prod` | 0 | no known vulnerabilities |

**Test counts by package:**

| Package | Tests |
|---|---|
| core | 9 |
| validator | 33 |
| policy | 16 |
| rewards | 11 |
| tx | 11 |
| adapter-meteora-dbc | 16 |
| econ-sim | 8 |
| license-check | 3 |
| apps/web e2e | 1 |

**Test-first evidence.** Red runs before implementation are in `evidence/tdd/`, for core, validator, policy, rewards, tx, econ-sim and the verifier.

**Skipped tests.** None were skipped.

**Not run:**
- Localnet, devnet and mainnet-fork integration layers (blocked, §1).
- vitest and fast-check. I used `node --test` instead, to keep the dependency tree small (TESTING.md §5).

## 5. Dependency controls

### 5.1 `chain` removal (D4)

**Inspection before install.** I inspected the published tarball of `@meteora-ag/cp-amm-sdk@1.4.10`:
- sha256 `5bc51276e5a1b4fb063f48cfd8a8e1854083bf17499b416be865b45f882fba71`;
- integrity `sha512-Y3UPjP91VWrj86hOr4kDmU1UXiESspy8YP6Z/4XtWD1eCVwUN0xMEzCvKXM2IRz5ECSj8alO2od1czhMhvcD8g==`.

It has no install scripts and no `exports` map. Its CJS and ESM builds require only anchor, spl-token, web3.js, bn.js, decimal.js and invariant. There are no dynamic imports and no `eval`. The word "chain" appears only in two "on-chain" comments. Evidence: `evidence/chain-removal/published-artifact.json`.

**Negative control.** Without the override, the lockfile resolves `chain@0.4.2` (`sha512-GtM+TlN3…MDg==`). Evidence: `negative-control-without-override.txt`.

**With the override, all 12 checks pass** (`evidence/chain-removal/proof.json`):
- the override is declared and recorded in the lockfile;
- the lockfile has no `chain` package and no `chain` edge;
- the resolved graph and `node_modules` have no `chain`;
- runtime `require.cache` has no `chain`;
- the published artifact's imports, unmodified manifest and integrity match the inspection;
- both SBOMs are free of `chain`.

**Adapter still works without it.** The adapter compatibility tests pass: CJS and ESM import, and `buildCurve` validation for flat and decay. Quote fees are 10,000,000 total and 2,000,000 protocol. Transactions are built for createConfig, createPool, swap, migrateToDammV2 (including the Customizable DAMM v2 config), claimTradingFee and claimCreatorTradingFee. Each runs against a **labelled MOCK RPC**, then is decoded by the independent Kit decoder and checked against the program allowlist.

**Install scripts.** None were run: bigint-buffer, bufferutil, utf-8-validate, esbuild postinstall, and several prepare scripts (`evidence/lifecycle-scripts-not-run.json`). bigint-buffer falls back to pure JS.

### 5.2 Licence (D1)
- `rpc-websockets@9.3.9` is ALLOW_EXCEPTION. Its conditions hold: integrity matches, it is reached only via the adapter, and no browser importer uses it.
- No other LGPL package is present. No scan suppression is used.
- **pako@2.2.0 `(MIT AND Zlib)` needs owner review.** Zlib is permissive but not on the allowlist. It comes in via anchor.
- The verifier's own tree is 9 packages, all MIT (`evidence/rpc-attempt/verifier-licenses.json`).

### 5.3 Browser boundary (D1): PASS (`evidence/browser-boundary.json`)
- **Web graph.** 58 packages. None forbidden: no web3.js, rpc-websockets, jayson, Meteora SDKs, adapter or `chain`. Every licence is plain ALLOW. There are no wallet packages yet; the check will cover them when added.
- **Bundle and artifacts.** The esbuild metafile inputs and emitted artifacts are clean: `main.js`, `merkle.worker.js`, both `.map` files with `sourcesContent`, the LEGAL files, HTML and CSS.
- **Canary A.** A deliberate web3.js import is detected in metafile inputs, JS and source maps (web3.js, rpc-websockets, jayson).
- **Canary B.** A browser build that imports the adapter fails to resolve, because the adapter exports only a `node` condition.
- **E2E.** The mock UI shows the MOCK banner and 9 MOCK lifecycle cards. The worker's Merkle root equals the Node root. It makes no non-localhost requests and logs no console errors. Screenshot: `evidence/mock-ui-screenshot.png`.

### 5.4 Audit (`evidence/audit-prod.json`): not clean

I bumped the adapter's direct `bn.js` pin from 5.2.2 to 5.2.5 (a patched release, deduplicated with the SDKs' copy); tests passed after the bump. Five advisories remain, all on server-side adapter transitive paths. I did not override them, because changing SDK internals without review is itself risky.

| Package | Advisory | Severity | Fix |
|---|---|---|---|
| bigint-buffer 1.1.5 | GHSA-3gc7-fjrx-p6mg | high | no patched version exists |
| toml 3.0.0 (via anchor) | GHSA-82x6-q7mm-w9cf | high | ≥ 4.2.0 |
| toml 3.0.0 (via anchor) | GHSA-v5mp-jgw5-2x6j | high | ≥ 4.1.2 |
| uuid 8.3.2 | GHSA-w5hq-g745-h8pq | moderate | ≥ 11.1.1 |
| stream-json 1.9.1 | GHSA-528h-pc64-c93x | moderate | ≥ 3.5.0 |

None of these are in the web graph. Their exploitability in QF's use was **not assessed**. This needs a decision before devnet.

## 6. Program verification: RPC still blocked, nothing verified

**Contract inspected first.** The original CLI takes `--mainnet`, `--mainnet2`, `--devnet` and `--out`, and reads no environment variables; there was no RPC allowlist in the script. v0.2.0 keeps exactly those flags, and rejects unknown flags with exit 64. It adds:
- genesis validation, against `solana-sdk` `ClusterType::get_genesis_hash`, which I read from source today;
- separate per-check statuses (PROGRAM-VERIFICATION.md §4);
- a 3-method read-only RPC allowlist;
- credential redaction;
- exit codes 0, 2, 3 and 64.

It now depends only on `@solana/addresses`.

**The run.** Command: `node --use-env-proxy verify-programs.mjs` (defaults), through this sandbox's own egress proxy. TLS was not relaxed and nothing was bypassed.
- Result: **exit 2**. CONNECTIVITY FAIL on mainnet-beta and devnet; the sanitized error is `TypeError: fetch failed: cause: Request was cancelled`. Every other check is UNKNOWN.
- The curl probe (`evidence/rpc-attempt/curl-probe.txt`) shows the proxy answered **403 to CONNECT** for:
  - api.mainnet-beta.solana.com
  - api.mainnet.solana.com
  - api.devnet.solana.com
  - verify.osec.io
- Output: `docs/verification/PROGRAM-VERIFICATION-2026-09-27.{md,json}`.
- **Consequence.** The OtterSec observations remain REPORT from 2026-09-26. Upgrade authorities, devnet presence, deployed hashes and config presence are unverified.

**To run it correctly elsewhere:**
```sh
cd spec/tools/program-verify
pnpm install --frozen-lockfile --ignore-scripts && pnpm test
node verify-programs.mjs --mainnet https://api.mainnet-beta.solana.com --devnet https://api.devnet.solana.com
# behind a proxy: node --use-env-proxy verify-programs.mjs ...
# optional independent cross-check: --mainnet2 <second provider URL>
```
- Allow egress to the chosen RPC hosts and verify.osec.io.
- Exit 0 is required for DEV-1.
- A hash does not identify 0.2.1 vs 0.2.2, `is_verified=false` is not a mismatch, and a source match is not an audit. The report says each of these.

## 7. Decision 5 results (simulation only, not sniper-proof)

Out of 30 hypothesis checks: **19 PASS, 7 FAIL, 4 N/A. All retained.**
- **Early bursts.** Decay cut early-bot PnL by about two thirds in the t=0 burst and the sybil split, and made the fast pump-and-dump unprofitable.
- **Supply share barely moved.** Decay reduced the bot share of acquired supply by only 6–8%, so H1 failed in every bot trace.
- **Waiting defeats decay.** A bot that waited 121 s did slightly *better* than under flat fees.
- **Early organic cost.** Early organic buyers paid more: the organic fee rate rose from 100 to 199 bps in organic_only.
- **Graduation.** The graduation outcome was unchanged in all traces.
- **Conservation.** Conservation was exact in all 12 runs.

Limitations: no demand elasticity, six invented traces, and SDK math rather than the program. No production template is selected.

## 8. Remaining blockers and open items

| ID | Scope | Needs |
|---|---|---|
| LOCAL-1 | Localnet | Written Meteora or counsel permission for local copies, builds, CI caching and distribution (ADR-013) |
| LOCAL-2 / LOCAL-3 | Localnet | Provenance and tooling, after DEV-1 produces real hashes and configs |
| DEV-1 | Devnet | Verifier exit 0 from an environment that can reach Solana RPC and verify.osec.io. The owner can add those hosts to this environment's allowed domains, or run it locally |
| DEV-2 / DEV-3 | Devnet | Cluster-safety checks; terms review |
| SEC-A | Devnet | Disposition of the 5 audit advisories (§5.4) |
| LIC-R1 | Licence | Owner review of pako `(MIT AND Zlib)` |
| EV-1 | Validator | Confirm `evidence-v0.1`: price 120 s, pool 300 s, route 120 s, skew 5 s, ≥ 2 sources. Proposed V0_TEST values, not owner decisions |
| ECON-1 | Economics | `percentageSupplyOnMigration = 20` is a new V0_TEST value that `buildCurve` requires. Production economics stay P0-M3 |
| UP-1 | Supply chain | Report the stray `chain` dependency to Meteora (not done: no outbound messages authorized) |
| P0-M1…M7 | Mainnet | Unchanged |
