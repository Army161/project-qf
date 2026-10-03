# DEPENDENCIES — pinned versions (2026-09-26)

Exact pins for Solana/Meteora packages. Upgrades follow §3.

## 1. Runtime / tooling
| Item | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.12.0 (LTS 22.x) | Meteora Invent requires ≥ 22.12.0 |
| pnpm | 10.x | Matches Meteora repos |
| TypeScript | 5.x (strict) | |
| Solana CLI (Agave) | 3.x | DBC/DAMM v2 built against solana 3.1.10; used for `solana-test-validator` cloning |
| Rust / Anchor CLI | not required in V1 | Only if building upstream programs for research |
| Postgres | 16 (+ TimescaleDB) | |
| Redis | 7.x | Queues (BullMQ) and caches |

## 2. npm packages
| Package | Pin | Where | License |
|---|---|---|---|
| `@meteora-ag/dynamic-bonding-curve-sdk` | 1.5.13 | adapter-meteora-dbc | MIT |
| `@meteora-ag/cp-amm-sdk` | 1.4.10 | adapter-meteora-dbc | MIT |
| `@solana/web3.js` | 1.99.0 | adapter-meteora-dbc only | MIT |
| `@solana/addresses` | 8.3.0 | tools/program-verify (own lockfile) | MIT |
| `@noble/hashes` | 1.8.0 | policy, rewards, econ-sim | MIT |
| `@coral-xyz/anchor` | resolved by Meteora SDK range `^0.31.0` (latest published 0.32.1 is outside that range) | transitive | MIT OR Apache-2.0 |
| `@solana/spl-token` | resolved by Meteora SDK range `^0.4.13` (latest 0.4.15) | transitive | Apache-2.0 |
| `@solana/kit` | 8.3.0 | rewards, tx (non-adapter packages) | MIT |
| `@solana-program/token-2022` | 0.19.0 | validator | Apache-2.0 |
| `@solana-program/token` | 0.17.0 | validator | Apache-2.0 |
| `@pythnetwork/hermes-client` | 3.1.0 | providers | Apache-2.0 |
| `@jup-ag/api` | 6.0.48 | providers (gated, not installed by default) | MIT client |

Resolved transitive versions (FACT, npm install 2026-09-26): `@coral-xyz/anchor@0.31.1`, `@solana/spl-token@0.4.15`.

### Required pnpm settings (amended 2026-09-27, Decision 4 / ADR-012)
```yaml
# pnpm-workspace.yaml (project-qf root)
overrides:
  "@meteora-ag/cp-amm-sdk@1.4.10>chain": "-"   # remove the unused stray dependency; no stub, no pin
onlyBuiltDependencies: []                       # no dependency install scripts
```
Plus `.npmrc`: `ignore-scripts=true`, `save-exact=true`, `engine-strict=true`. Install only in a disposable environment without secrets. The earlier `"chain": "0.4.2"` / empty-stub proposal is withdrawn.

`@solana/web3.js` v1 (and its LGPL transitive `rpc-websockets`) must not appear in the `apps/web` dependency graph, bundles, worker bundles or source maps; enforced by `pnpm boundary` (`tools/boundary`).

### Evidence (project-qf/)
- `pnpm-lock.yaml`: the frozen lockfile.
- `sbom/project-qf.cdx.json`, `sbom/apps-web.cdx.json`: CycloneDX 1.6 generated from the resolved graph. These replace `sbom/planned-sbom.cdx.json` as the source of truth.
- `evidence/chain-removal/`:
  - published-artifact inspection;
  - negative control without the override;
  - 12-check absence proof.
- `evidence/lifecycle-scripts-not-run.json`: the install scripts that were skipped.

## 3. Upgrade procedure
1. Bot opens PR; license scanner + OSV + SBOM diff.
2. For Meteora SDK/program changes: read CHANGELOG, run adapter compatibility suite on localnet-clone and mainnet-fork (read-only), re-run PROGRAM-VERIFICATION.
3. SDK 2.x (breaking) is adopted only under ADR-003 gate.

## 4. Known upcoming changes
DBC 0.2.2 (`release_0.2.2` @ `746806e`) and SDK 2.0.0 (PR #114) — see METEORA.md §4.

### Amendment 2026-09-27 (decision review)
The workspace now also carries, in addition to the settings above: the SEC-A scoped override `"@coral-xyz/anchor@0.31.1>toml": "4.2.0"`, `patchedDependencies: bigint-buffer@1.1.5`, and `ignoredOptionalDependencies: [bufferutil, utf-8-validate]` (ADR-012 amendments). Resolved graph: 161 packages (esbuild platform binaries for other OSes included as NOT_INSTALLED), lockfile sha256 `c2bb276af21b15c87bba002d20b51e7f9564cde2247d082370bec4d27f3a90e6`.

### Amendment 2026-10-03 — inspector milestone, release tracking, bigint-buffer exit path
- **SDK upgrade rule (§3 item 3, §4).** Any DBC SDK release that adds program 0.2.2 / `create_config2` support is adopted only under the ADR-003 gate. Upstream proposes that release as 1.6.0 (PR #116), separate from the 2.0 refactor (PR #117). The gate is capability, released artifact and integrity, deployment, security and tests, not "SDK 2.x". The SDK pin is unchanged at 1.5.13.
- **Inspector milestone lockfile.** It adds three workspace packages: `@project-qf/contracts`, `@project-qf/features` and `apps/api`. `apps/web` now depends on `@project-qf/contracts`.
  - No third-party package was added, removed or re-resolved. The `packages` and `snapshots` sections are byte-identical to lockfile `c2bb276a…`; only `importers` changed, by 42 added `workspace:*` link lines.
  - The new lockfile sha256 is in the milestone return report and in `evidence/milestone-inspector/LOCKFILE-DIFF.txt`.
  - Persistence uses Node's built-in `node:sqlite` (Node 22, experimental) and HTTP uses `node:http`; neither is an npm dependency.
  - The SEC-A owner adoption recommended for `c2bb276a…` must be made, for real, against the lockfile actually committed.
- **bigint-buffer exit path (roadmap, not adopted).** Per Astra's `DEPENDENCY-EXIT-PATH.md` (2026-10-03), no maintained drop-in replacement for the exact SDK pair has been verified. Keep the patched, isolated adapter for V0.
  - Investigate upstream-first: a Meteora release that removes every introducing path.
  - Otherwise investigate a bounded client-layer replacement (permitted IDLs, `@solana/kit` codecs, parity tests). Start with one narrow decode or instruction-build path, never a port of program source.
  - Acceptance: no `bigint-buffer` in the resolved production closure or runtime artifacts, parity and width tests green, and the raw audit and SBOM showing the actual graph.
