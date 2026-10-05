# Project QF Launchpad, Milestone 4: creators get paid (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`, head `6b7fb02` (plus this report). Cluster: devnet only. Mainnet writes: none. Real keys or funds: none.
This builds on milestone 3 (`handoffs/LAUNCHPAD-MILESTONE-3-2026-10-03.md`).

## What changed for a user

Before, a creator could see "Creator fees" on their coin's page, but nothing in the app let them collect them. After graduation their share of trading fees sat in a locked LP position that nobody could reach from the app.

Now the coin's creator sees a "Your creator earnings" card on the token page with two rows:

- **Bonding curve.** Their share of every trade on the curve, with a Claim button.
- **Locked LP position.** After graduation, the fees earned by the creator's permanently locked DAMM v2 position, with its own Claim button.

Each claim goes through the same signing sheet as a trade. The server builds the transaction, the browser checks it, and the creator's wallet signs it. The money goes straight to the creator's wallet. Anyone else who opens the page sees no card.

## Proven on devnet

Coin $CASH "Creator Cash", mint `6RxnQppWqqsRYeeRFUbrEjfoCMTdRyrCySsPSh1nNQE1`. It was launched, traded, claimed, graduated, traded again and claimed again by one throwaway wallet in one browser session, all through the real UI.

| What | Link |
|---|---|
| Launch | https://explorer.solana.com/tx/2TbM8REqBKaxbX2NFK6TnC3zZ2hMs7dT9xttmed99R6pYvzVQoosUhceRWsaPRBFqKs5cJUNSnBxGnTmbzFTfxq?cluster=devnet |
| Claim curve fees, 1.40 qUSD | https://explorer.solana.com/tx/2egKXucfREhg9D8Ec64KaJ1aLAqpj9guMVCXQNxc4kRHokSUBrMogZxXTZFQ4nzS7PgbRMHfyZs1BdMQQbsZQ8dK?cluster=devnet |
| Last buy, fills the curve | https://explorer.solana.com/tx/41aQ3aTSCz4qYYS5P8TeJS8nsTXZuhYAX6gM9D58gvuh2wZTdyp1UibEqj2wF5t8Lho3HtawWnpGuGk8rZHBLWyf?cluster=devnet |
| Graduation to DAMM v2 (operator crank) | https://explorer.solana.com/tx/3cAv59KGB6MH5hEZfKyagCyF9SvN1EQDxPdfCBcaefFYxuBZxR8o61Z8jsxA5p5wu8K1aECjuKjeyZo2tVfibF55?cluster=devnet |
| Buy and sell on DAMM v2 | https://explorer.solana.com/tx/LFJ1LVYQ8SNsMjUiw5kcLtBiFK37rZjAcFpLNatoF9gJL55FzKNCpwp3TMWJLCDokbXdks5odBVsbG6My9w66KR?cluster=devnet and https://explorer.solana.com/tx/34YEPYJon2C7ZAX1ASSxXg9YHxAY2XbKwd7tB985Mz79NNuUNCfNwEedNiFsqETxUwEb5DKSUJ4uehKLboejvv16?cluster=devnet |
| Claim locked LP position fees, 4.99 qUSD | https://explorer.solana.com/tx/EtuZ5PrcrWmjdW159aFpmizpCqWUGyxEaKyhxLCMb7wNWuKdxPNp15kEj3eXHupfgN1SdY6bWx4FjZQ4SmBirHx?cluster=devnet |

The amounts match the economics:

- **Curve.** 350 qUSD of volume at a 1% fee is 3.50 qUSD. Meteora takes 20% of that, and the creator gets half of the rest (`creatorTradingFeePct` 50): 1.40 qUSD.
- **LP position.** About 1,240 qUSD of DAMM volume at 1% is 12.40 qUSD. 80% of that goes to LPs (9.92 qUSD), and the creator's position holds half the liquidity: about 4.96 qUSD. The 4.99 qUSD claimed is consistent with that estimate.

All signatures are in `evidence/devnet-run-2026-10-05.json`, which holds public chain data only.

## How it is protected

- **Curve claims** use the existing `CLAIM_CREATOR_TRADING_FEE` binding, which has role USER_WALLET.
  - The server refuses a build unless the requesting wallet is the coin's recorded creator.
  - The terms fix `receiver = creator`, so the payout ATAs are the creator's own.
- **Position claims** use a new kind, `DAMM_CLAIM_POSITION_FEE`, in `packages/tx`.
  - **Role.** USER_WALLET. The server never holds the key.
  - **Terms.** The pool, the owner, the position NFT mint, both mints and both token programs (SPL Token only).
  - **Pool.** It must be the DAMM v2 PDA of the V0 migration config and the pair. Any other config is refused.
  - **Accounts.** Every account is bound by name:
    - the position PDA and NFT account, both derived from the NFT mint;
    - both payout ATAs, owned by the signer;
    - both vaults (derived), both mints, the token programs, the event authority and the program.
  - **Remaining accounts.** None are allowed.
  - `claim_position_fee` joins the pinned DAMM IDL subset. The subset is still generated from the MIT cp-amm-sdk 1.4.10 bundle and drift-tested.
  - The server also refuses a build unless the wallet currently holds that position in that pool. The program enforces NFT ownership on-chain as well.
- **Browser.** The same check list runs, with new plain-language lines such as "Fees are paid to your wallet" and "It is your LP position".
- **Tests.** 251/251 pass.
  - The baseline binds with zero violations.
  - Mutations are rejected:
    - a foreign position (`ACCOUNT_MISMATCH position`);
    - an attacker payout account;
    - a different owner (`ACCOUNT_MISMATCH signer`);
    - another pool or config;
    - an extra DAMM swap (`MULTIPLE_ENGINE_INSTRUCTIONS`);
    - a token SetAuthority;
    - the claim under swap terms (`WRONG_OPERATION`);
    - the claim under curve-claim terms (wrong engine).
  - A server test covers who sees what, who can build which claim, and the browser check on both claim types.

## Bugs found by the live runs, all fixed in `6b7fb02`

| # | Found | Fix |
|---|---|---|
| B1 | After graduation, an open token page stayed on "Curve full… runs automatically within a minute" until the person reloaded. | The page polls every 6 s while the curve is full (20 s otherwise) and re-renders when the coin changes phase (curve full → graduated, venue → DAMM v2). The proof run waited on the open page with no navigation, and the DAMM panel appeared by itself. |
| B2 | **The server crashed.** A 429 from the public devnet RPC hit a call that web3.js's `confirmTransaction` had started and never awaited, so the rejection was unhandled. | Confirmation is now our own awaited polling of signature status with backoff on busy responses and an expiry check. Operator sends (faucet, migration crank) use the same path. `serve` also logs any unhandled rejection instead of exiting. Three tests cover it. |
| B3 | Signing-sheet lines read like "creator is what you entered". | Plain-language labels. |

Diagnostic: when a pool read fails with "Invalid account discriminator" (seen twice more today, on a pool created minutes earlier), the error now records what the RPC returned for that account (owner, length, first 8 bytes). The next occurrence will show whether a lagging RPC node returned stale or empty data. A 429 now logs one line instead of a stack.

Earlier attempts left two test coins on devnet: $PAYDAY (claimed and graduated; it exposed B1) and $TIPJAR (still bonding; its run hit B2). Neither key was kept.

## Checks on `6b7fb02`

| Check | Result |
|---|---|
| Tests | 251/251 |
| typecheck, license:check, deps:chain, boundary | pass |
| audit --prod | the same 3 known SEC-A advisories |

These are test results. They are not a security audit and not a mainnet readiness claim.

## Notes for Astra

1. **`DAMM_CLAIM_POSITION_FEE` amends the tx-binding policy** the same way `DAMM_SWAP` did. It adds a new USER_WALLET kind with its own pinned format and loosens nothing. Please confirm.
2. **Platform fees are not claimable in-app, on purpose.**
   - The platform's share sits in two places: the DBC partner fee (role FEE_CLAIMER) and the partner's locked DAMM position.
   - On devnet both belong to the disposable operator key. Policy says FEE_CLAIMER is a multisig role and must never be server-held, so I did not build a server-side claim.
   - Live today: the operator's locked position on $MCAT holds about 0.15 qUSD.
   - This needs an owner decision on who holds the platform fee claimer for mainnet (multisig) and how it claims.
3. **Fees accrue in qUSD only** (`collectFeeMode` QUOTE_ONLY), so the base rows always show 0. The UI still shows base amounts if a future config collects both.
4. **B2 deserves a look beyond this app.** Any server using web3.js `confirmTransaction` or `sendAndConfirmTransaction` against a rate-limited RPC can lose the process the same way. The read-only API (`apps/api`) uses its own client and is not affected.

## Still open (owner decisions; none blocks devnet work)

- Second RPC provider. B2, the 429s and the discriminator reads all come from a single public endpoint.
- Public URL and metadata hosting. URIs still point at `127.0.0.1`.
- Real-wallet test (Phantom or Solflare on devnet).
- SOL as a quote token; atomic first buy.
- Platform fee claimer for mainnet (note 2).
