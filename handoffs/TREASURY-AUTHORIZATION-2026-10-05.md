# Project QF Launchpad: devnet treasury authorization, checked line by line (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`. The base is the fee ledger (`09115d7`); the commit is named in the ZIP manifest.
Cluster: devnet only. Mainnet writes: none. Real keys or funds: none. Fee percentages: unchanged. Holder-reward distributions: none.

At 20:40Z Jeremy posted this authorization: "build and test the platform treasury on Solana DEVNET ONLY, including a test multisig and a new platform configuration for new devnet coins". Most of it was already built in milestone 7, under his 18:27Z "Build on devnet" card.

This pass did the following:
- checked every line of the authorization against what exists;
- filled the four gaps it named;
- re-ran the licence and deployed-program checks before any devnet transaction;
- ran the whole flow again with the fee ledger in place;
- scanned the Git history and every exported ZIP for keys.

## Line by line

| Jeremy's line | Status | Evidence |
|---|---|---|
| Devnet only; test multisig; new config for new devnet coins | Done in milestone 7; unchanged | `treasury-chain-state.json` (finalized read now), `platform.json` |
| Keep Milestone 6 closed | Not reopened. Nothing in the backfill queue or receipt code changed in this pass. Milestone 7 only let the receipt check accept the partner-claim kind. | `git diff 09115d7 --stat` touches `server.ts`, two test files and the web page only |
| Preserve existing pools and their fee entitlements | Unchanged. DBC has no instruction to change a config's fee claimer. The 5 older coins still pay the operator, and their checks all match. | `earnings-final.json` |
| Clearly label the old configuration as legacy | **New.** The API marks each config `role: CURRENT` or `LEGACY`, with a label. Earnings shows a "legacy config" chip on the 5 older coins. | `platform.json`, `shots/earnings-coins-*.png` |
| Complete the SDK licence and deployed-program checks first | Re-run at 20:49Z, before the first transaction at 20:50Z (details below). | `checks-first.txt`, `sdk-licences.txt`, `program-verify/` |
| Preserve all eligibility and security gates | No gate code changed: packages `core`, `tx` and the adapter are untouched. 300/300 tests pass. | `checks.txt`, `test.log` |
| Disposable funds and test signers only; no keys in prompts, logs, Git or ZIPs | Throwaway keys only. Key scan of everything we ship: **0 hits** (details below). | `key-scan.jsonl` |
| Document the signer roles and approval threshold | **New section** below, from a fresh finalized read. | `treasury-chain-state.json` |
| A one-operator test multisig is not production separation of control | **New.** The API says `signers: ONE_OPERATOR_TEST_KEYS` and `separationOfControl: false`. The Earnings treasury card shows a "test signers, one operator" chip and says so in words. | `shots/earnings-treasury-*.png`, test in `treasury.test.ts` |
| Demonstrate fees accrue, approvals obtained, claim into treasury, Earnings reconciles without double counting | **Done again live**, now with the fee ledger and a new vault balance check. | `devnet-run-2026-10-05-treasury-authorization.json` |
| No mainnet activation, real funds, reward distributions, fee % changes or production-authority changes | None of these happened. `MAINNET_WRITES` is still false. The new coin used the existing treasury config (same economics). | this report |

### Checks run first (20:49Z)

- `license:check`: exit 0, 211 packages, 0 failures.
- SDK licences: DBC SDK 1.5.13, cp-amm SDK 1.4.10, `@sqds/multisig` 2.1.4 and `@solana/web3.js` 1.99.0 are all MIT.
- Verifier offline tests: 55/55.
- Live read-only program verification: exit 0, REQUIRED_CHECKS_SATISFIED, 104/104 inventory, single provider.
  - Mainnet Squads v4 is immutable, and its hash equals OtterSec's on-chain hash.

### Key scan

- **What was scanned:**
  - all Git objects on every branch;
  - the shared `project-qf.bundle`;
  - all 15 exported ZIPs;
  - all of `/mnt/project-files/quoteforge`;
  - the working tree;
  - the server log.
- **What it looks for:**
  - the four real devnet secrets (operator and members) in hex, base58, base64 and JSON-array form;
  - any 64-byte value that is a valid ed25519 keypair (its second half equals the public key of its first half), in JSON-array, base58, hex or base64 form;
  - mnemonic-like text.
- **Results:**
  - 0 hits.
  - The 64-byte candidates it found (about 1,700 in the Git history) are transaction signatures, and none of them is a keypair.
  - A positive control with a fresh throwaway key was detected in JSON and hex form.
- The scanner prints counts and paths only, never key material.
- No seed phrase exists anywhere: keys are generated as raw keypairs.

## Signer roles and approval threshold

All read from chain at `finalized` (`treasury-chain-state.json`).

| Role | Devnet holder | Can | Cannot |
|---|---|---|---|
| Treasury member 1 | `68awUL2h…QLWz` | initiate, vote, execute (Squads permission mask 7); pays its own fees and rent | move funds alone |
| Treasury member 2 | `AXwufa2E…rorQ` | the same | the same |
| Treasury member 3 | `AWQwPuzN…7nww` | the same | the same |
| Approval threshold | **2 of 3** | a proposal runs only after 2 members approved; the proposer's approval counts as one | — |
| Config authority | **none** | changing members or threshold takes its own 2-of-3 config transaction; the app has no code that builds one | — |
| Time lock / spending limits | **0 / none** | — | no member can spend under a limit without a vote |
| Vault (index 0) `7ac8CDv8…fCoB` | the multisig | is the new config's fee claimer and leftover receiver; receives the claims | release anything without an executed proposal |
| Operator `4eup3PdJ…PArX` | the server's devnet key | paid for setup and created the config | propose, approve or execute (`NOT_A_MEMBER`, refused live today); claim treasury fees directly (DBC returns `Unauthorized` 6053, simulated in milestone 7) |
| Server (API) | — | builds unsigned transactions, binds them to their terms, records receipts | sign anything in the treasury path: it holds no member key, and a source test enforces this |
| Member signer `apps/launchpad/src/member.ts` | stand-in for three people's wallets | the only code that loads a member key; checks the multisig on chain and binds each transaction itself before signing | — |

**Separation of control: not demonstrated, by design.** All three member keys are throwaway devnet keys held by one operator, in one container (`~/.qf-devnet/treasury/`, mode 0600, outside Git). This shows that the approval flow and its checks work. It does not show that three independent people control the money.

For mainnet the owner picks the real signers, ideally on hardware wallets, plus the threshold, the time lock and any spending limits (readiness blocker TRE-1).

## Fresh devnet run (20:50 to 20:59Z)

| Step | Result |
|---|---|
| Launch | `$TRSY` on the treasury config `7Jcu6G…5UE`, mint `2d66yf…MqX`, sig `47gubQXy…` |
| Fees accrue | 5 trades by 3 throwaway wallets (4 buys, 1 sell), every fee read from its own `EvtSwap2` event: 1.050074 qUSD in total (creator 0.420030, platform 0.420030, Meteora 0.210014). The pool's platform counter was 0.420030: MATCH. |
| Refused before approval | execute with 1 approval → `NOT_APPROVED`; proposer approving again → `ALREADY_APPROVED`; a trader proposing → `NOT_A_MEMBER`; the operator proposing → `NOT_A_MEMBER` |
| Approvals | member 1 proposed (index 4, sig `4SaPsKNR…`), member 3 approved (`CE68nEcq…`), member 2 executed (`7DsBcUn3…`). The executing transaction has exactly one signer, member 2. |
| Claim into treasury | the pool's quote vault −420,030 raw, the vault's token account +420,030 raw (read directly from the public devnet RPC, finalized: `independent-rpc-check.json`) |
| Earnings | receipt RESOLVED at 420,030. The vault holds 6,060,434 raw, which equals the proven treasury receipts: **vault check MATCH**. `$TRSY` platform check is MATCH (0.420030 from trades = 0 left in the pool + 0.420030 claimed). |

## Counted once, and how that is checked

A treasury receipt appears in three places:

1. In "Claimed in the app": 13,439,408 → 13,859,438, a rise of exactly 420,030.
2. In "Paid to treasury": 5,640,404 → 6,060,434, a rise of exactly 420,030.
   - That figure is part of the total in (1), not added to it. The API says `includedIn: claimedThroughApp`, and the card says so.
3. In the per-coin check: trades = still in the pool + claimed.
   - A receipt counted twice would make this a MISMATCH.

The new **vault check** compares the vault's own balance on chain with the proven receipts. If the vault holds more, it says tokens reached it outside a claim. If it holds less, it says tokens left it. A receipt that is not yet proven leaves the check INCOMPLETE, never MATCH.

New tests (`treasury.test.ts`):
- The same signed execution submitted twice, and then found again by the indexer in the pool's history, still gives one receipt and no trade.
- Every one of the three places above shows the receipt once.
- The vault check covers both directions of a difference and incomplete evidence.
- Legacy labels and the one-operator flags are tested.

## Astra's fee-ledger response (relayed 20:54Z)

- **LP residuals are no longer called rounding.** A per-coin LP difference is now:
  - MATCH only when it is exact;
  - `RESIDUAL` with its amount and `origin: NOT_PROVEN` when it is within 2 raw units per DAMM trade;
  - MISMATCH beyond that.
- Live residuals today: $VAULT 2 raw, $CASH 1 raw, $MCAT 1 raw. $PAYDAY is exact.
- The evidence of their origin (recomputing each position's share from the pool's fee accumulator) is the first step of the next milestone.
- **Holder rewards** will follow Astra's criteria, which are now recorded:
  - the fee ledger decides funding;
  - a separate holder balance-over-time history, including direct transfers, decides allocation;
  - only tokens actually deposited in the rewards vault are distributable.
- **"62.48 qUSD" was all trading fees** (creator, platform, LP and Meteora shares), not platform revenue. Agreed. The Fees page shows each share separately.

## Checks (`evidence/treasury-auth/checks.txt`, secret-free wrapper)

- install, typecheck, test (300/300: 296 plus 4 new), license:check, deps:chain, build:web and boundary all exit 0.
- `pnpm audit --prod` exits 1 with the same 3 known SEC-A advisories.
- No dependency was added.
- Screenshots: `evidence/treasury-auth/shots/` (desktop and phone), with no console errors and no horizontal overflow.

These are test results, not an audit or a readiness claim.

## Files changed

- `apps/launchpad/src/server.ts`:
  - config `role` and `label`, and the coin `configRole`;
  - the treasury `signers`, `separationOfControl` and `note` fields;
  - `vaultCheck`, and treasury `includedIn`;
  - the `RESIDUAL` status in `feeCheck`.
- `apps/web/src/launchpad/main.ts`, `apps/web/launchpad.css`:
  - the legacy chip and the one-operator chip and note;
  - the "Vault holds" stat;
  - the residual label.
- Tests: `apps/launchpad/test/treasury.test.ts` (+3) and `fees.test.ts` (+1).
- Evidence: `evidence/treasury-auth/` and `evidence/devnet-run-2026-10-05-treasury-authorization.json`.
  - The `*.ts.txt` files are the read-only and devnet driver scripts, kept as text.
- `handoffs/METEORA-INQUIRY-SENT-2026-10-05.md`: the Meteora email exactly as sent at 20:43Z, from Jeremy's Gmail on his "Send now".

## Still open

- **Real signers.** Real treasury signers, threshold and time lock (mainnet only, TRE-1).
- **Meteora.** Meteora's written answer; the email was sent at 20:43Z.
- **Second RPC provider.** Today's only flake was again the single public endpoint: one $PAYDAY position read, which succeeded on retry.
- **Next milestones:**
  - LP residual origin evidence;
  - holder rewards on devnet;
  - mainnet mode (USDC, no faucet, sending locked until approved).
