# project-qf (private, proprietary — see spec/PROPRIETARY-NOTICE.md)

V0 offline implementation of Project QF. Stage: **OFFLINE_V0 ACTIVE**. Localnet, devnet and mainnet are BLOCKED (spec ADR-011). Every mock surface is labelled MOCK or TEST_ONLY and is never a live blockchain result.

## Setup (disposable, secret-free environment)
```sh
corepack enable            # pnpm 10.33.0, Node >= 22.12
pnpm install --frozen-lockfile --ignore-scripts
```
`.npmrc` sets `ignore-scripts=true`. `pnpm-workspace.yaml` removes the stray `chain` dependency with `"@meteora-ag/cp-amm-sdk@1.4.10>chain": "-"` (ADR-012).

## Commands
| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm build:web` | esbuild browser build of the mock UI, needed before the e2e test |
| `pnpm test` | all `node --test` suites (packages, tools, apps/web e2e with preinstalled Chromium) |
| `pnpm license:check` | resolved-graph licence gate, enforces exceptions QF-LIC-EX-001 (rpc-websockets, narrow) and QF-LIC-EX-002 (pako, exact; notices in `licenses/`) → `evidence/license-check.json` |
| `pnpm deps:chain` | proves `chain` absent → `evidence/chain-removal/proof.json` |
| `pnpm boundary` | browser dependency and artifact boundary, with canaries → `evidence/browser-boundary.json` |
| `pnpm sbom` | CycloneDX 1.6 from the resolved graph → `sbom/*.cdx.json` |
| `pnpm sim` | Decision 5 simulation → `evidence/econ-sim/results.json`, `tools/econ-sim/traces/` |
| `pnpm audit --prod` | advisory audit; stays red by design (3 listed). Owner-adopted, version-bound dispositions: `evidence/sec-a/dispositions.json`, asserted by `packages/adapter-meteora-dbc/test/sec-a.test.ts`. The optional native ws accelerators are excluded (`ignoredOptionalDependencies`) |

The e2e test uses `playwright-core` with Chromium at `/opt/pw-browsers/chromium`. Elsewhere, point it at a local Chromium.

## Layout
- `packages/core` — decimals, flags, readiness stages, mock labels, canonical JSON
- `packages/validator` — validator-v0.1 S3.1/S3.2, price evidence, aggregate, TEST_ONLY registry guard
- `packages/policy` — EconomicsPolicy, CurveTemplate (flat baseline + simulation-only decay), migration threshold (Decision 3)
- `packages/rewards` — TWAB, allocation, SF Rewards-format Merkle
- `packages/tx` — transaction intent validation, independent Kit decoder, strict DBC Borsh decoding and binding of the decoded message to approved terms and consent (repair pass)
- `packages/adapter-meteora-dbc` — **server-only** Meteora SDK adapter (the only web3.js v1 user)
- `apps/web` — mock lifecycle UI (MOCK data only)
- `tools/*` — licence check, chain proof, SBOM, boundary, econ-sim
- `evidence/` — outputs of the runs above, including red TDD runs and `test-run.txt`; repair-pass red/green logs and the full clean-env run are in `evidence/repair/`, the decision-review pass (config type, streaming limits, natives) in `evidence/readonly-readiness/`, SEC-A in `evidence/sec-a/`
- `patches/` — `bigint-buffer@1.1.5.patch` (SEC-A: native loader removed); `licenses/` — preserved upstream notices for exact licence exceptions
