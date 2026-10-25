# project-qf (private, proprietary — see spec/PROPRIETARY-NOTICE.md)

A meme-coin launchpad on Solana **devnet**, on Project QF's own engine (ADR-014): launch a coin on its bonding curve priced in SOL, trade it, watch it graduate into its own pool with every LP token burned, and claim creator fees. Devnet only: valueless test coins, a throwaway operator key. Mainnet is BLOCKED (`packages/core/src/readiness.ts`). Hosting: `deploy/RUNBOOK.md`.

## Setup (disposable, secret-free environment)
```sh
corepack enable            # pnpm 10.33.0, Node >= 22.12
pnpm install --frozen-lockfile --ignore-scripts
```
`.npmrc` sets `ignore-scripts=true`.

## Commands
| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm build:web` | esbuild browser build of the launchpad (`launchpad.html`), needed before the browser test |
| `pnpm test` | all `node --test` suites (packages, tools, apps, and the launchpad browser test with preinstalled Chromium) |
| `pnpm license:check` | resolved-graph licence gate; the only exceptions are the exact OFL-1.1 web fonts (QF-LIC-EX-003..005, notices in `licenses/`); packages recorded as REMOVED are denied if they come back → `evidence/license-check.json` |
| `pnpm boundary` | browser dependency and artifact boundary, with canaries → `evidence/browser-boundary.json` |
| `pnpm sbom` | CycloneDX 1.6 from the resolved graph → `sbom/*.cdx.json` |
| `pnpm audit --prod` | advisory audit; clean since the Meteora adapter was removed (2026-10-25). Every earlier SEC-A advisory was on that adapter's tree and is recorded as resolved by removal in `evidence/sec-a/dispositions.json` |

The browser test uses `playwright-core` with Chromium at `/opt/pw-browsers/chromium` (`QF_CHROMIUM` points it elsewhere).

Run the launchpad (from `apps/launchpad`, devnet): `node --use-env-proxy src/main.ts operator` prints the throwaway operator's address to fund with devnet SOL (it pays for the test-SOL faucet and the graduation crank), `serve` starts it on http://127.0.0.1:8788, and `verify` checks the books against the chain (PASS / FAIL / WAIT; `deploy/RUNBOOK.md` §5). The engine is set up on devnet by its admin, so the app has no setup step. `verify` first reads every coin on the engine and its history from the chain (it sends nothing), so it works on a new store too. `QF_CLUSTER=localnet` runs the app against a validator on 127.0.0.1. The whole app runs end to end against the real engine programs on a local validator with `QF_LOCALNET_THEN=apps/launchpad/scripts/engine-localnet.ts sh packages/engine/scripts/localnet.sh <evidence.json>` (`packages/engine/README.md`), and against the engine on devnet with `node --use-env-proxy apps/launchpad/scripts/engine-devnet.ts <evidence.json>` (paid by the operator key, a few hundredths of a test SOL; every wallet it makes returns its SOL).

## Layout
- `packages/core` — decimals, flags, readiness stages, mock labels, canonical JSON
- `packages/validator` — validator-v0.1 S3.1/S3.2, price evidence, aggregate, TEST_ONLY registry guard
- `packages/policy` — the economics digest the launch form is bound to, plus the V0 EconomicsPolicy and migration-threshold rules (Decision 3)
- `packages/rewards` — TWAB, allocation, SF Rewards-format Merkle
- `packages/tx` — transaction intent validation, an independent Kit decoder, and the byte-for-byte binding of a decoded transaction to its approved terms and consent (`qf-engine.ts`)
- `packages/engine` — Project QF's own launch engine (qf-curve + qf-pool): addresses, unsigned instruction builders, curve and pool math, account and event decoders; browser-safe, Kit only. Checked against the engine's own client and, on a local validator, against the real programs (`packages/engine/README.md`). The app runs on it and finds every coin on the engine, including ones it did not launch. The engine's devnet proof run passed on 2026-10-11; the owner switched the app to it on 2026-10-25 and the Meteora code was removed
- `apps/launchpad` — **server-only** launchpad (`lp-api/1`): builds unsigned transactions for wallets, relays signed ones after exact-message checks, indexes trades, cranks graduation, keeps the books (`books.ts`, `main.ts verify`); never signs for a user
- `apps/web` — the launchpad's browser app (`launchpad.html`; talks only to the same-origin server and the user's wallet, and checks every transaction before the wallet signs it)
- `tools/*` — licence check, SBOM, boundary
- `evidence/` — outputs of the runs above (earlier milestones' runs, including the retired inspector's, stay in their folders), including red TDD runs and `test-run.txt`; repair-pass red/green logs and the full clean-env run are in `evidence/repair/`, the decision-review pass (config type, streaming limits, natives) in `evidence/readonly-readiness/`, SEC-A in `evidence/sec-a/`
- `licenses/` — preserved upstream notices for the exact licence exceptions (web fonts)
