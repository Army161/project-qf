# project-qf (private, proprietary — see spec/PROPRIETARY-NOTICE.md)

A meme-coin launchpad on Solana **devnet**: launch a coin on a Meteora DBC bonding curve, trade it, graduate it to a Meteora DAMM v2 pool with locked liquidity, claim creator fees, a 2-of-3 platform treasury, and daily holder rewards. Devnet only: valueless test coins, a throwaway operator key. Mainnet is BLOCKED (`packages/core/src/readiness.ts`). Hosting: `deploy/RUNBOOK.md`.

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
| `pnpm build:web` | esbuild browser build of the launchpad (`launchpad.html`), needed before the browser test |
| `pnpm test` | all `node --test` suites (packages, tools, apps, and the launchpad browser test with preinstalled Chromium) |
| `pnpm license:check` | resolved-graph licence gate, enforces exceptions QF-LIC-EX-001 (rpc-websockets, narrow) and QF-LIC-EX-002 (pako, exact; notices in `licenses/`) → `evidence/license-check.json` |
| `pnpm deps:chain` | proves `chain` absent → `evidence/chain-removal/proof.json` |
| `pnpm boundary` | browser dependency and artifact boundary, with canaries → `evidence/browser-boundary.json` |
| `pnpm sbom` | CycloneDX 1.6 from the resolved graph → `sbom/*.cdx.json` |
| `pnpm sim` | Decision 5 simulation → `evidence/econ-sim/results.json`, `tools/econ-sim/traces/` |
| `pnpm audit --prod` | advisory audit; stays red by design (3 listed). Owner-adopted, version-bound dispositions: `evidence/sec-a/dispositions.json`, asserted by `packages/adapter-meteora-dbc/test/sec-a.test.ts`. The optional native ws accelerators are excluded (`ignoredOptionalDependencies`) |

The browser test uses `playwright-core` with Chromium at `/opt/pw-browsers/chromium` (`QF_CHROMIUM` points it elsewhere).

Run the launchpad (from `apps/launchpad`, devnet): `node --use-env-proxy src/main.ts operator` prints the throwaway operator's address to fund with devnet SOL, `setup` creates the test quote token and config once, `serve` starts it on http://127.0.0.1:8788, and `verify` checks the books against the chain (PASS / FAIL / WAIT; `deploy/RUNBOOK.md` §5). With `QF_ENGINE=qf` the same commands (`operator`, `serve`, `verify`; no `setup`) run Project QF's own engine instead of Meteora, quoted in SOL, with its own store; `QF_CLUSTER=localnet` runs it against a validator on 127.0.0.1. In engine mode `verify` first reads every coin on the engine and its history from the chain (it sends nothing), so it works on a new store too. The whole app runs end to end against the real engine programs on a local validator with `QF_LOCALNET_THEN=apps/launchpad/scripts/engine-localnet.ts sh packages/engine/scripts/localnet.sh <evidence.json>` (`packages/engine/README.md`), and against the engine on devnet with `node --use-env-proxy apps/launchpad/scripts/engine-devnet.ts <evidence.json>` (paid by the operator key, a few hundredths of a test SOL; every wallet it makes returns its SOL).

## Layout
- `packages/core` — decimals, flags, readiness stages, mock labels, canonical JSON
- `packages/validator` — validator-v0.1 S3.1/S3.2, price evidence, aggregate, TEST_ONLY registry guard
- `packages/policy` — EconomicsPolicy, CurveTemplate (flat baseline + simulation-only decay), migration threshold (Decision 3)
- `packages/rewards` — TWAB, allocation, SF Rewards-format Merkle
- `packages/tx` — transaction intent validation, independent Kit decoder, strict DBC Borsh decoding and binding of the decoded message to approved terms and consent (repair pass)
- `packages/adapter-meteora-dbc` — **server-only** Meteora SDK adapter (the only web3.js v1 user)
- `packages/engine` — Project QF's own launch engine (qf-curve + qf-pool): addresses, unsigned instruction builders, curve and pool math, account and event decoders; browser-safe, Kit only. Checked against the engine's own client and, on a local validator, against the real programs (`packages/engine/README.md`). The app uses it behind `QF_ENGINE=qf` (`apps/launchpad/src/engine/`) and finds every coin on the engine, including ones it did not launch. The engine's devnet proof run passed on 2026-10-11; Meteora stays the default until the owner OKs the switch
- `apps/launchpad` — **server-only** launchpad (`lp-api/1`): builds unsigned transactions for wallets, relays signed ones after exact-message checks, indexes trades, cranks graduation, keeps the books (`books.ts`, `verify.ts`); never signs for a user
- `apps/web` — the launchpad's browser app (`launchpad.html`; talks only to the same-origin server and the user's wallet, and checks every transaction before the wallet signs it)
- `tools/*` — licence check, chain proof, SBOM, boundary, econ-sim
- `evidence/` — outputs of the runs above (earlier milestones' runs, including the retired inspector's, stay in their folders), including red TDD runs and `test-run.txt`; repair-pass red/green logs and the full clean-env run are in `evidence/repair/`, the decision-review pass (config type, streaming limits, natives) in `evidence/readonly-readiness/`, SEC-A in `evidence/sec-a/`
- `patches/` — `bigint-buffer@1.1.5.patch` (SEC-A: native loader removed); `licenses/` — preserved upstream notices for exact licence exceptions
