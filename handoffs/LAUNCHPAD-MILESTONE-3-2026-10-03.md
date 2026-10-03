# Project QF Launchpad, Milestone 3: trading after graduation (2026-10-03)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`, head `89b21ee` (plus this report). Cluster: devnet only. Mainnet writes: none. Real keys or funds: none.
This builds on milestone 2 (`handoffs/LAUNCHPAD-MILESTONE-2-2026-10-03.md`).

## What changed for a user

Before, a graduated coin's page swapped its Buy/Sell panel for a link to Explorer. After graduation nobody could trade the coin in the app.

Now the page keeps its Buy/Sell panel after graduation. A violet note says the coin trades on its Meteora DAMM v2 pool with liquidity locked forever. Price and market cap come from the live DAMM v2 pool, and trades on that pool appear in the trade list and the tape.

## Proven on devnet

Graduated $MCAT, pool `2CDuAUAnb7TdWZUG4RsenVu62SHKwrhN8qSe7Ezhw5XJ`. A fresh throwaway wallet traded through the real UI:

| What | Link |
|---|---|
| Buy, 25 qUSD on DAMM v2 | https://explorer.solana.com/tx/2373GZy8bvnRvEJDz2eHyWqmTCdpgpS66TceA2zXriWa22PVTQ5Wam3oxSJ6GP4kLPhaky9AoKiH9aes1g6iKzWz?cluster=devnet |
| Sell, 50% of holdings, 12.40 qUSD out | https://explorer.solana.com/tx/KMT4QWADFUhbsVpVeApx17TRkd8UVjSUuDhZPDAJKcK9iKNLtF85ZMThaxLnRnTqi4U9QLnWFHhVrCEH1U8u1Gx?cluster=devnet |

Both trades were recorded at submit. The background indexer then walked the DAMM pool's history: it found the same two trades and nothing else, so the migration transaction was correctly not counted as a trade.

## How it is protected (same rules as the curve)

- **New operation kind `DAMM_SWAP`** in `packages/tx`.
  - The role is the user's wallet. The server never holds the key.
  - The terms name the pool, the user, both mints, both token programs (SPL Token only), the direction, `amountIn` and `minimumAmountOut`.
  - The pool must equal the DAMM v2 PDA of the V0 migration config (`A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`) and the pair. Any other config is refused.
- **Binding.**
  - The DAMM v2 `swap` instruction is decoded under a pinned IDL subset (`packages/tx/src/engine/damm-idl-subset.ts`). That subset is generated from the MIT cp-amm-sdk 1.4.10 bundle and drift-tested, the same way as the DBC subset.
  - Every account is bound by name: pool authority, pool, the user's ATAs, both vaults (derived), both mints with token A as base, the payer, the token programs, referral set to none, the event authority and the program.
  - Each kind allows exactly one engine program. A DBC instruction inside a DAMM swap fails, and so does a DAMM instruction under curve terms.
  - No remaining accounts are allowed. If a pool ever turns on Meteora's rate-limiter fee, the SDK would add the instructions sysvar and the binding would refuse it. That is deliberate: it fails closed.
- **Server.** `readDammPool` refuses a pool unless token A is the launch's mint and token B is the quote token. Quotes are exact-in, with price impact measured against spot excluding fees, the same as the curve.
- **Browser.** It runs the same check list. The program line reads "Only Meteora DAMM v2 and token programs are called".
- **Tests.**
  - The baseline binds with zero violations.
  - Mutations are rejected: foreign pool, attacker output account, wrong amount, minimum raised past the built value, wrong config, flipped direction, extra token instruction, and cross-engine mixing in both directions.
  - A server test quotes, builds and runs the browser check for both buy and sell on a graduated coin.
  - The DAMM pool test fixture is a public devnet pool account (TEST_ONLY), with its mints and vaults re-keyed to synthetic addresses.

## Checks on `89b21ee`

| Check | Result |
|---|---|
| Tests | 245/245 |
| typecheck, license:check, deps:chain, boundary | pass |
| audit --prod | the same 3 known SEC-A advisories |

These are test results. They are not a security audit and not a mainnet readiness claim.

## Notes for Astra

1. **`DAMM_SWAP` amends the tx-binding policy.** It adds a new operation kind with its own pinned format. It does not loosen any existing kind. It sits inside the decided V1 boundary (DBC → DAMM v2), so I treated it as implementation rather than a new decision. Please confirm that reading.
2. **Fee split differs after graduation.** On the migrated pool the fee was 1%: 0.8% LP/claiming and 0.2% protocol, read from the pool on devnet. That split comes from Meteora's migration fee option, not from our curve config. The creator's share of post-graduation fees accrues to the locked LP positions, not to the creator-fee counter shown on the page. A position-fee claim flow would be the next piece if the owner wants creators paid after graduation.
3. **Rate-limiter fee mode.** If a future config enables it, the binder will need an explicit `allowSysvarInstructions` flag for `DAMM_SWAP`, as `SWAP` already has.

## Still open (owner decisions; none blocks devnet work)

- Second RPC provider.
- Public URL and metadata hosting.
- Real-wallet test.
- SOL as a quote token.
- Atomic first buy.
- Creator fee claims (the curve and post-graduation positions).
