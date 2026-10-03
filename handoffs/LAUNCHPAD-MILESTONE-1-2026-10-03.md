# Project QF — Launchpad milestone 1 (built, tested offline; devnet run pending)

Date: 2026-10-03 · Author: Claude (implementer) · Reviewer: Astra · Owner: Jeremy Gephart
Branch: `milestone/launchpad-devnet` (on top of `milestone/inspector-draft` 87cb8db) · Commits: 8495551, a388d30, plus the evidence commit
Stage: code complete for devnet; **no devnet transaction has been sent yet**. Readiness `DEVNET_INTEGRATION` is still BLOCKED in `packages/core/src/readiness.ts`.

## 1. What exists now

A user-facing meme coin launchpad, running against Meteora DBC → DAMM v2, devnet only.

| Page / flow | What the person does | What happens |
|---|---|---|
| Explore | Sees every launched coin with image, market cap, volume, progress to graduation; sorts by newest, market cap, about to graduate | Server lists launches it indexed; live pool state read through the adapter |
| Connect wallet | Picks any Wallet Standard wallet (Phantom, Solflare, Backpack…) | Hand-rolled Wallet Standard discovery; no wallet SDK in the bundle |
| Get test qUSD | One click | Server sends 10,000 TEST_ONLY qUSD (+0.02 SOL if the wallet is empty), 3 claims per wallet per day |
| Create a coin | Name, ticker, description, image, links; ticks the launch-economics box; one wallet signature | Browser generates the mint key, server builds the unsigned DBC `createPool`, browser decodes and checks it, wallet signs, server verifies and sends |
| Token page | Price, market cap, volume, trades, price chart, bonding-curve progress, buy/sell with presets and slippage, live quote (you receive, minimum, fee, price impact) | Same build → verify in browser → sign → confirm flow for swaps; trades indexed from pool vault balance changes |
| Graduation | Nothing; it happens when the curve fills | Server crank calls DBC `migrateToDammV2` (Customizable DAMM v2 config); page switches to "Graduated" with the DAMM v2 pool link |

Screens (offline run, SAMPLE data, see §3): `evidence/launchpad-offline/screens/01…12`.

## 2. Safety properties (unchanged decisions, now enforced in the app)

- The server never signs for a user. It signs only its own operator actions (faucet, migration crank, one-time platform setup).
- Every user transaction is built by the server, then **decoded independently in the browser** (`apps/web/src/launchpad/txcheck.ts`) against the same `packages/tx` binding checker the server uses. The page shows each check; any failure stops before the wallet is asked.
- Submit accepts only the exact message the server built (hex match), with every required signature valid (WebCrypto Ed25519), once, before a 120 s expiry.
- Launch requires the person to accept the economics digest; the server refuses if the digest differs from the platform's.
- Devnet only: the adapter refuses mainnet genesis and requires `MAINNET_WRITES=false`; operator key lives outside git (`~/.qf-devnet/operator.json`, mode 0600) and is refused inside a checkout.
- Browser boundary: no web3.js / rpc-websockets / @meteora-ag in any browser bundle (`pnpm boundary` PASS). CSP `default-src 'none'`, `connect-src 'self'`, no inline script or style.
- Quote asset is a TEST_ONLY SPL token "qUSD" (6 dp, fixed supply, mint authority revoked). Native SOL quote stays refused by the binding rules (see decision D1).

## 3. What was proven, and how

| Check | Result | Evidence |
|---|---|---|
| Unit + integration tests | 239/239 pass (230 before + 9 launchpad) | `evidence/launchpad-offline/08-test.txt` |
| Typecheck | pass | `07-typecheck.txt` |
| Licence scan | pass | `license-check.txt` |
| `chain` package absent | pass | `deps-chain.txt` |
| Browser boundary | pass | `boundary.txt` |
| `pnpm audit --prod` | same 3 known advisories as before (bigint-buffer high; uuid, stream-json moderate), all transitive in the server-side adapter, SEC-A disposition still pending | `10-audit-prod.txt` |
| Headless browser run | Explore, connect, faucet, token, quote, buy flow, graduated, create, create flow, mobile; no console errors except the two expected 409s from the closed gate | `screens/`, `ui-driver.mjs.txt`, `test-wallet.js.txt` |

How the browser run worked: real launchpad server + real built web app + an injected TEST wallet (Ed25519 key generated inside the page, never exported), against an in-process chain double with SAMPLE launches (`offline-preview-server.ts.txt`). Prices and trades in the screenshots are sample data, not chain data. Buy and Launch stop at "transaction intent is refused by policy (stage DEVNET_INTEGRATION is BLOCKED)", which is the gate working as designed.

Bugs the browser run found and fixed (commit a388d30):
1. Progress bars always looked full: the CSP blocks style attributes. Widths now set through CSSOM.
2. Token page overflowed phone screens by ~90 px. Grid columns now shrink.
3. A finished dialog followed the person to the next page. Idle dialogs now close on navigation.
4. Amounts the curve cannot fill returned HTTP 500. Now 409 `AMOUNT_NOT_FILLABLE` with a plain message (test added).
5. "Price impact" showed the post-trade price move (~2x the real cost). Now: fill vs spot price, fee excluded (test added).
6. Market cap read as 0 when a config has no fixed supply (a zero BN is truthy). Now compares the value (test added).

## 4. What is NOT proven yet

- No devnet transaction has been sent: not the platform setup, launch, buy, sell, graduation or faucet. Two things block it, both Jeremy's:
  1. **Gate**: Jeremy's own tap on "Unblock devnet" in the launchpad thread (the coordinator's relay of an earlier tap is not accepted by my safety check for a gate change).
  2. **Devnet SOL**: the public faucet refuses this cloud IP (HTTP 429). Operator wallet `4eup3PdJfMjbPXA9g6Qy43HPmiC7EMD4PvC74DGVPArX` needs ~5–10 devnet SOL from https://faucet.solana.com.
- No real wallet extension has signed yet (only the injected test wallet).
- Nobody can open the app from outside the cloud box yet (no public URL; see D3).
- Second RPC provider still absent; the migration crank reads at one provider (the program itself enforces curve completion, so a wrong read cannot migrate early, only late).
- F7 still applies: devnet program bytes differ from mainnet, so a devnet pass is not mainnet evidence.

Once both blockers clear, the run is: `main.ts setup` (qUSD mint + DBC config), serve, then launch → buy → sell → fill the curve to the 1,000 qUSD test threshold → crank migration → verify the DAMM v2 pool, with Explorer links and screenshots.

## 5. Decisions needed (none block the devnet run)

| # | Decision | Default I'm using |
|---|---|---|
| D1 | Allow native SOL as the quote asset (needs a tx-binding amendment for wSOL wrap/unwrap) | qUSD TEST_ONLY on devnet; SOL quote not built |
| D2 | Atomic creator first-buy in the launch transaction (also a binding amendment) | Off; creator buys in a second signature |
| D3 | Public hosting / URL for the devnet app | None; runs inside the cloud box only |
| D4 | Token metadata hosting (now served by our server at `/m/<mint>.json`) vs Arweave/IPFS | Our server, devnet only |
| D5 | Second RPC provider (also needed for the inspector) | Single provider |
| D6 | Real-wallet test on Jeremy's machine (Phantom on devnet) | After D3 |

## 6. Notes for Astra

- Please review `apps/launchpad/src/server.ts` (submit path: exact-message match, signature verification, single-use intent claim) and `apps/web/src/launchpad/txcheck.ts` (browser-side binding) as the two security-critical files.
- The readiness file is unchanged on purpose. When Jeremy's own tap arrives I will flip `DEVNET_INTEGRATION` to ACTIVE with his decision and timestamp, carry DEV-3 (terms review) to the MAINNET blockers, and update the three tests that pin BLOCKED.
- Amendment requests (D1, D2) are proposals only; the binding rules were not touched.
- Test threshold 1,000 qUSD is labelled TEST_ONLY evidence through `proposeMigrationThreshold`; it is not a production policy.
- The SAMPLE preview server is scratch (git-ignored); its source is in the evidence folder for reproducibility only.
