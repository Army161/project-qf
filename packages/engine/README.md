# @project-qf/engine

Everything the app needs to use Project QF's own launch engine. Browser-safe: it depends only on `@solana/kit`, holds no keys and sends nothing.

| Program | What it does | Id |
|---|---|---|
| qf-curve | Creates a coin, trades it on the bonding curve, graduates it, pays fees. Project QF original. | `CaX3gfwE1y3AustJ5e2JQFmaDtXB5oeX6ayvNzLGsFoX` |
| qf-pool | The pool where graduated coins trade. A fork of Raydium's raydium-cp-swap (Apache-2.0). | `FHG8GyPytpydCRFL6yvwu92vyWSk7bSYZknyLn3v6ewU` |

The programs live in the engine's own repository (`quoteforge/engine-qf/`). Its README explains the design, fees and admin powers.

## Files

| File | Holds |
|---|---|
| `src/programs.ts` | Program ids and fixed accounts. |
| `src/config.ts` | The launch and pool presets the engine was tested with. Every coin keeps its own copy on chain. |
| `src/addresses.ts` | Every derived address: launch, vaults, graduator, pool and pool vaults. |
| `src/instructions.ts` | Unsigned instruction builders, driven by the pinned IDL. They cover create, buy, sell, graduate, both fee claims, pool swap, the pool creator fee, settings, and token-account helpers. |
| `src/math.ts` | Curve math, line for line with `math.rs`. It also refuses every trade the program would refuse. |
| `src/pool-math.ts` | Pool swap quotes, ported from raydium-cp-swap. |
| `src/accounts.ts` | Strict decoders for Global, Launch, AmmConfig, PoolState, token accounts and mints. Also `readCoin` and `readCoinPool`. |
| `src/events.ts` | Engine events from transaction logs, attributed to the program that wrote them. |
| `src/tx.ts` | Compiles an unsigned legacy transaction for a wallet to sign. |
| `src/idl.ts` | Generated from `idl/*.json` by `scripts/extract-idl.ts`. Do not edit it by hand. |
| `idl/` | The two IDLs exactly as the engine build produced them (sha256-pinned in `test/idl.test.ts`). |

## How it is checked

- `test/golden.test.ts` compares the package with the engine's own client (`client/qf.mjs`). The vectors are in `test/fixtures/` and are labelled TEST_ONLY. It checks:
  - every address;
  - every instruction, byte for byte, including signer and writable flags;
  - 360 curve-math vectors.
- `test/idl.test.ts` checks three things:
  - the IDL files match the engine build's sha256;
  - `src/idl.ts` has not drifted from what the generator produces;
  - every PDA in every built instruction matches the seeds the IDL records.
- `scripts/localnet.sh` runs one full coin against the real program binaries on a local validator. Every quote, event, account and token balance is compared to the raw unit, and the books are reconciled after every step. Run it with:

  ```
  QF_ENGINE_DIR=/mnt/project-files/quoteforge/engine-qf/src sh packages/engine/scripts/localnet.sh
  ```

  It needs the Agave CLI on `PATH`. The keys are throwaway and live in `~/.qf-localnet`, outside the repo. The curve binary it loads is pinned to the build that is live on devnet (sha256 `5d7a424e…dcbd`, the same bytes a clean rebuild of the engine gives).

- With `QF_LOCALNET_THEN=apps/launchpad/scripts/engine-localnet.ts` the same validator runs the whole app instead: the launchpad server in engine mode, with the script acting as the browser and the wallet (it checks every built transaction with the web app's own checker before signing). It launches a coin, trades it on the curve, buys it out, cranks the graduation, trades on the pool, claims every fee and reconciles the books before and after the claims. Pass the evidence file as the argument, for example `evidence/engine-localnet/app-localnet.json`.
- `apps/launchpad/scripts/engine-devnet.ts` runs the app against the engine on devnet, using the engine's devnet setup as it is. It finds the engine's own proof coin, launches a coin, trades on its curve and in the proof coin's pool, claims, and reconciles the books before and after the claims (`evidence/engine-devnet/`).

## Licence

The package is Project QF proprietary code, except for two files derived from raydium-cp-swap under Apache-2.0: `idl/qf_pool.json` and `src/pool-math.ts`. See `third_party/raydium-cp-swap/` (LICENSE and NOTICE).
