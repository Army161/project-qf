# Project QF Launchpad, Milestone 2: first real devnet run and the redesign (2026-10-03)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`, head `5f5c637` (plus this report). Cluster: **devnet only**. Mainnet writes: none. Real keys or funds: none.

## What happened

1. **Devnet opened on the owner's own words.** Jeremy wrote "unblock devnet" in the launchpad thread at 2026-10-03T21:06:00Z. `DEVNET_INTEGRATION` is now ACTIVE in `packages/core/src/readiness.ts`, and the decision is recorded in its scope text. The DEV-3 review of deployed-service terms is waived for devnet only and is still a MAINNET blocker. `LOCALNET_INTEGRATION` and `MAINNET` stay BLOCKED. CLAUDE.md's status line was amended to match.
2. **Platform set up on devnet** with a throwaway operator key outside git (`~/.qf-devnet/operator.json`, 5 devnet SOL from Jeremy's airdrop):
   - TEST_ONLY quote token qUSD, mint `GWjfymuG7NhkWm2aEKhCexJKkXvM8Fe6k3mQGB313Vez`, fixed supply, mint authority revoked.
   - DBC config `5EEfERmwCSGaDy7YEnieF13ohbZXzQytAaM3Kg4SKXaC` with a migration threshold of 1,000 qUSD.
3. **Two coins launched from the real UI.** A headless Chromium drove the app with an injected Wallet Standard test wallet. Each key was generated in the page with WebCrypto and never left it. The server built every transaction, the browser checked it against the terms, the wallet signed, and the server verified the exact message and every signature before sending.
   - $MCAT "Moon Cat", mint `81EixAtVvJHMpVkbaEeiHsC1V8DcCcYaEpBnurNZfcge`, pool `86cYZ61o6r8FcYSJvQGsyer9JfU22xiJF9x7EPcmUigu`.
   - $FROG "Devnet Frog", mint `4TzRBV1sP1sZUATwxJ4Q3w56ADhj3W885UJGaaWAyeQb`.
4. **Ten trades** (eight buys and two sells) came from four different wallets. All ten were indexed back from chain, and each was classified from the vault deltas.
5. **$MCAT graduated.** The last buy filled the curve. Within one crank pass the operator's crank migrated it to Meteora DAMM v2 pool `2CDuAUAnb7TdWZUG4RsenVu62SHKwrhN8qSe7Ezhw5XJ`. The migration transaction is finalized with no error.
   - The pool account is owned by `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.
   - Its tokens are MCAT and qUSD.
   - `permanentLockLiquidity` equals `liquidity` minus 1 unit of rounding, so the liquidity is effectively 100% permanently locked.

All signatures and addresses are in `evidence/devnet-run-2026-10-03.json`. That file holds public chain data only.

### Explorer links (devnet)

| What | Link |
|---|---|
| Launch $MCAT | https://explorer.solana.com/tx/3nKNmbC9cMFM9jcUW9CFktpUrYH8Smy9kMQzYeDAxq9DxCm8PcWH4YYwFqWCPTroNZE8bXSTrvFoUf7LjFqSRUns?cluster=devnet |
| First buy, 50 qUSD | https://explorer.solana.com/tx/21woG25Vf2a8siiiCKQn6hWNGZS4ZZNwm5gcrd19QgV8USSLKipaMjDBEpEGS1r8FeeryTXNzgWTjAfM28XK3XZa?cluster=devnet |
| A sell | https://explorer.solana.com/tx/31SnfN6kEF4UTSvw52efmYdG3zRz3G1H9Ap5FoUDfjkdqqgAg5QwbqpGajgGGoRSzFVprQ62SQNz2dSdJmMKY1AE?cluster=devnet |
| Last buy, 640.25 qUSD, fills the curve | https://explorer.solana.com/tx/649rs81xaxZ4QKhn31UE4o8KxmzrzgjXTDhbwkzQPEbT2xTkoqTadPpauYh5bJa3CN9yDJP73Kfg8kwKRv2qB7N2?cluster=devnet |
| Migration to DAMM v2 | https://explorer.solana.com/tx/4gMyG9fEZ6qewhZxY27u1N6dooCQhYjX7SHkMvHKsmg8VTh1F1gdQQQfW3Mvb4BAgVhFaZZmCYnyT4MrK453qYDH?cluster=devnet |
| DAMM v2 pool | https://explorer.solana.com/address/2CDuAUAnb7TdWZUG4RsenVu62SHKwrhN8qSe7Ezhw5XJ?cluster=devnet |
| Launch $FROG | https://explorer.solana.com/tx/c6WCUmz63ZbDjqaPbUFv5RUAhNPFr6ego6Mqo9PDC5vN6j5xb7XHWkaZZMcMsCmmTMSherSgFnZCQAFGCnLbvtk?cluster=devnet |

## The redesign

- **Direction.** It was drafted first on a design canvas (Explore, Token, Create, phone Explore, phone Token, signing sheet, look and feel), then built into the app.
- **Look.**
  - Dark ground (#0a0b0a).
  - Buy is lime (#c8f560) and sell is orange (#ff8a3d). They differ in lightness too, so they still read apart for color-blind traders.
  - Graduated coins are violet and devnet is amber.
- **Fonts.** Bricolage Grotesque for headlines, Geist for text and Geist Mono for numbers.
  - They are self-hosted from `@fontsource-variable/*@5.3.0` under OFL-1.1.
  - Each is an exact license exception (QF-LIC-EX-003/004/005), approved by Jeremy's "Allow fonts" tap at 21:04:20Z.
  - CSP gained only `font-src 'self'`. There are no third-party requests.
- **New pieces.**
  - Live trade tape.
  - "Next to graduate" feature card.
  - Sort tabs and search.
  - Token page with KPIs, price chart, graduation bar, trades table, trust line and a fixed Buy/Sell bar on phones.
  - Signing sheet with numbered steps and a "Checked in your browser" list.

## Bugs found by the live run, all fixed in `5f5c637`

| # | Found | Fix |
|---|---|---|
| L1 | The server crashed when the migration crank's pool read threw "Invalid account discriminator" (public devnet RPC, intermittent: seen twice, not reproducible in six direct reads) | The crank logs the failure and skips that pool for one pass, and a background-pass failure can no longer kill the process. Covered by a new test. |
| L2 | A buy larger than what's left on the curve was refused with "try a smaller one", so nobody could tell what amount would work | The server binary-searches the largest fillable amount with local curve math (no RPC). The token page offers a one-tap "Buy the rest · X qUSD" button. Covered by a test that also proves the advertised maximum fills and maximum + 1 does not. |
| L3 | Public RPC 429s returned 500 INTERNAL | Now 503 RPC_BUSY, so the client knows to retry. |
| L4 | The faucet gave 0.02 SOL, too little for a new wallet to pay a launch's rent | Now 0.1 devnet SOL, topped up only when a wallet holds less than 0.05. |
| L5 | The token page's "Balance:" line stayed stale after a trade | It repaints whenever balances refresh. |
| L6 | On a 390px phone the header took three rows and the token title wrapped badly | Tightened the header and token head under 520px. |

## Checks on `5f5c637`

| Check | Result |
|---|---|
| Tests | 241/241 |
| typecheck, license:check, deps:chain, boundary | pass |
| audit --prod | the same 3 known SEC-A advisories, unchanged |
| Live devnet E2E | 2 launches, 10 trades, 1 graduation, 0 failed transactions |

These are test results. They are not a security audit and not a readiness claim for mainnet.

## Not done yet (decisions are Jeremy's or Astra's; none blocks devnet work)

1. **Trading after graduation inside the app.** Today a graduated coin links out to its DAMM v2 pool. In-app swaps on the DAMM v2 pool through cp-amm-sdk need the same build, check and sign path. This is the next build item.
2. **Second RPC provider.** L1 and L3 are what single public-RPC dependence looks like. CLAUDE.md already requires a cross-check provider for critical reads.
3. **Public URL and metadata hosting.** Metadata URIs currently point at `127.0.0.1`, so Explorer shows no image or name for these coins.
4. **A real wallet** (Phantom or Solflare on devnet) instead of the injected test wallet.
5. Carried over from milestone 1: SOL as a quote token (binding amendment), and an atomic first buy at launch.

## Notes for Astra

- The readiness change follows the owner's first-hand words. It amends the stage table, not a decision: DEV-1 and DEV-2 notes and the F7 caveat are kept, and DEV-3 is re-filed under MAINNET.
- The font exceptions are narrow by design: exact name, version and integrity, notices preserved under `licenses/@fontsource-variable/`. No policy-wide OFL allowance was added.
- L1 is worth a second look: an anchor discriminator failure while reading an immutable config account, right after a swap landed, on the public devnet endpoint. My working theory is a bad response from one RPC backend. A second provider would confirm or kill that theory.
- Please review the max-fillable search (`apps/launchpad/src/server.ts`, `maxFillable`). It runs pure curve math against the pool snapshot already read for the quote, so it adds no RPC calls. The search is bounded by log2 of the requested amount.
