# Project QF Launchpad, Milestone 7: platform treasury on devnet (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.
Branch `milestone/launchpad-devnet`. Base `245e3b0` (milestone 6 plus the treasury plan). Implementation `3ac536e`, evidence and Earnings view `d884701`, plus this report.
Cluster: devnet only. Mainnet writes: none. Real keys or funds: none.

Authority for this milestone: Jeremy chose "Build on devnet" at 18:27Z on the card "Build the platform treasury on devnet with a throwaway 2-of-3 Squads multisig?" ("I create 3 throwaway member keys, a 2-of-3 Squads multisig and a new platform config, so new coins pay platform fees into its vault."). Nothing beyond that was created or changed: no change to the old config, the operator key, fee settings or any user-facing flow.

## Before and after

| | Before (milestone 6) | After (milestone 7) |
|---|---|---|
| Platform fee claimer for new coins | the operator, a single hot key held by the server | the **vault PDA** (index 0) of a 2-of-3 Squads v4 multisig |
| Who can move platform fees | the server, alone | 2 of 3 members, each signing in their own process; the server cannot |
| Partner LP position after graduation | NFT minted to the operator | NFT minted to the vault (seen live: position `57uwTd…ahfb`, permanently locked) |
| Curve leftovers | operator | vault |
| Coins launched before today | operator | still the operator: DBC has no instruction to change a config's fee claimer |

## Authority path, end to end

1. **Setup** (`main.ts treasury-setup <m1,m2,m3>`, operator pays, operator is not a member). It creates the multisig with threshold 2, `configAuthority` null, `timeLock` 0 and no spending limits. It reads the account back and refuses to continue unless it is exactly that. Then it creates the new DBC config with `fee_claimer` = `leftover_receiver` = vault and the same economics. New launches use the new config.
2. **Propose.** A member asks `POST /api/lp/treasury/propose` for a claim on a treasury coin. The server returns an UNSIGNED transaction with terms `TREASURY_PROPOSE`: `vault_transaction_create` + `proposal_create` + `proposal_approve`, member is fee payer and rent payer.
3. **Approve.** A second member asks `/approve` and receives an unsigned `proposal_approve`.
4. **Execute.** Any member asks `/execute` and receives an unsigned `vault_transaction_execute`. The server builds it only after re-reading the stored VaultTransaction from chain and binding it to the recorded claim (`STORED_TRANSACTION_MISMATCH` otherwise).
5. **Submit.** The signed transaction goes to `/api/lp/submit`, which binds it to its terms again before sending. For execute it re-reads the stored transaction again.

What packages/tx enforces (QF-SEC-01), at every step, in the member signer and in the server:

- Top level: only ComputeBudget and Squads v4. Squads instructions are decoded from the IDL subset (discriminators checked against the SDK in a drift test).
- Every Squads account (multisig, transaction, proposal, vault, member, rent payer, program config) must equal the terms; the vault must be derived from the multisig.
- `ephemeral_signers` 0, no memo, no draft proposal, `transaction_index` equal to the terms.
- The inner message must be exactly one platform fee claim (`CLAIM_PARTNER_TRADING_FEE` or DAMM v2 `claim_position_fee`) plus the ATA create it needs. No ComputeBudget inside. Fee payer, fee claimer, receiver and owner must all be the vault.
- Execute: the remaining accounts must be the STORED message's keys, in order, with the stored writability, none a signer. A transaction that passes other accounts fails with `EXECUTE_ACCOUNTS_NOT_STORED_MESSAGE`.

**Member signer** (`apps/launchpad/src/member.ts`, a stand-in for three people's own wallets). It is the only code that loads a member key (`~/.qf-devnet/treasury/member-{1,2,3}.json`, mode 0600, outside git). `pin` checks the multisig on chain (exactly these 3 members, threshold 2, no config authority, no time lock) and pins it. Before signing it binds the transaction to its terms itself. For approve and execute it reads the stored VaultTransaction with its own RPC connection and binds that. A server that lied about a proposal cannot get a member to approve or run something else. A source test asserts the server files never reference member keys.

## Tests

288/288 (272 at milestone 6, plus 16):

- `packages/adapter-meteora-dbc/test/treasury-binding.test.ts`, 12 tests. They use real SDK-built transactions and SDK-serialized stored accounts:
  - baselines for a curve claim and a DAMM v2 claim: propose, approve and execute bind with zero violations;
  - a claim paid to an attacker, or an extra SPL or SOL transfer out of the vault;
  - a vault message for another pool or another claim kind;
  - ComputeBudget inside the vault message;
  - ephemeral signers, a memo, a draft proposal, or another index;
  - any other Squads instruction (adding a member, a config change);
  - an approve for another member, proposal or multisig;
  - an execute without the stored transaction, with other remaining accounts, or against a stored message that is not the claim;
  - a vault not derived from the multisig, a member equal to the vault, and a server-held member role.
- `apps/launchpad/test/treasury.test.ts`, 3 tests:
  - the full propose, approve, execute flow over the API, with ALREADY_APPROVED and NOT_APPROVED refusals;
  - NOT_A_MEMBER, NOT_TREASURY_COIN, and STORED_TRANSACTION_MISMATCH when the chain holds a different claim;
  - no member key path in server code.
- `idl-subset.test.ts`, 1 new test: the Squads IDL subset has no drift and its discriminators match the SDK. The existing MIT test now covers `@sqds/multisig` too.
- Readiness test: `TRE-1` stays a mainnet blocker.

## Live devnet run (`evidence/devnet-run-2026-10-05-treasury.json`)

| | Address / signature |
|---|---|
| Multisig (2 of 3) | `6VWeQwhL4nWAWz34LPhZtbC97DfDL1ndNufVdySUcEJd`, created `5q3D5Dow…` |
| Vault (treasury address) | `7ac8CDv8vcb7wAUgrmzamJUUnNgPqiQfg2MhxSGufCoB` |
| Members (throwaway) | `68awUL2h…`, `AXwufa2E…`, `AWQwPuzN…` |
| New config | `7Jcu6GtNEqgfvYNTk9XNEWrWq6duuFFdSXjhNE6nU5UE`, created `5oj2MbA4…` |
| Test coin $VAULT | mint `FN2tqDtS…`, launched `4WJvYiST…`, graduated `29ozx8xm…`, DAMM v2 pool `HDnxLVQz…` |

Three proposals, rotating roles so every member proposed, approved and executed once:

| # | Claim | Proposer → second approver → executor | Paid to vault (qUSD) |
|---|---|---|---|
| 1 | curve partner fees | m1 → m2 → m3 | 1.200000 |
| 2 | vault's DAMM v2 LP position fees | m3 → m1 → m2 | 1.599999 |
| 3 | curve partner fees (accrued before graduation) | m2 → m3 → m1 | 2.840405 |

Result:

- The vault's qUSD went from 0 to 5,640,404 raw, exactly the sum of the three receipts. All three are RESOLVED from their own transactions.
- Vault lamports went from 100,000,000 to 97,023,120. The vault paid its quote token account rent on the first claim.
- Earnings shows `paidToTreasuryQuoteRaw` 5640404, 0 unresolved, 0 open proposals.

Refusals checked live:

- The operator proposing: `NOT_A_MEMBER`.
- Approving an executed proposal: `NOT_ACTIVE`.
- A treasury claim on $CASH (old config): `NOT_TREASURY_COIN`.
- Simulated, not sent: the operator calling DBC's partner claim on the treasury config directly. DBC refuses it with `Unauthorized` 6053 (`operator-cannot-claim.json`). The server key has no route to treasury money even outside the app.

Earnings page (screenshots in `evidence/m7-treasury/shots/`, desktop and phone, no console errors):

- a "Platform treasury" card with the "devnet stand-in" tag;
- a "treasury" chip on coins that pay the vault;
- "Treasury (2 of 3)" as the claimer for its claims.

`unclaimedComplete` was false at the time: the curve of the older coin $MCAT could not be read, the same public-RPC flake as before.

## Checks (`evidence/m7-treasury/checks.txt`)

All checks ran in the secret-free wrapper (`env -i PATH HOME HTTPS_PROXY HTTP_PROXY NODE_EXTRA_CA_CERTS`).

| Command | Exit | Result |
|---|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | 0 | |
| `pnpm -s typecheck` | 0 | |
| `pnpm -s test` | 0 | 288/288 |
| `pnpm -s license:check` | 0 | `@sqds/multisig@2.1.4` MIT; its 46 transitive packages are MIT, ISC or Apache-2.0 (listed in `spec/THIRD_PARTY_NOTICES.md`) |
| `pnpm -s deps:chain` | 0 | |
| `pnpm -s build:web` | 0 | |
| `pnpm -s boundary` | 0 | no Squads or web3.js code in the browser |
| `pnpm audit --prod` | 1 | the same 3 known SEC-A advisories as milestone 6, nothing new |
| verifier offline tests | 0 | 55/55 |
| verifier live read-only run | 0 | REQUIRED_CHECKS_SATISFIED, 104/104 inventory, single provider |

These are test results. They are not a security audit and not a mainnet readiness claim.

## Notes for Astra

1. **Deviation from the plan: members pay their own fees.** The plan said the server would propose and pay fees. I made every treasury transaction member-paid (fee payer and rent payer), so the server signs nothing in the treasury path at all. The cost is that each member needs a little SOL; setup funded each with 0.05 devnet SOL.
2. **No browser approval flow yet.** The plan said members approve "in their own wallets" in the browser. Here the member signer is a CLI stand-in that does the same checks. A browser approval page with a wallet adapter is a follow-up once real signers exist.
3. **Settings, stated explicitly:** threshold 2 of 3; `configAuthority` none, so changing members or threshold itself needs a 2-of-3 config transaction; time lock 0; spending limits **none** (a spending limit lets one member move funds without a vote). The app has no code that creates config transactions or spending limits.
4. **Execute sets a 400,000 compute unit limit** (ComputeBudget at top level, priority fee 0). The vault message itself may not contain ComputeBudget.
5. **Squads program, verifier finding.** The mainnet Squads v4 program is immutable (no upgrade authority, hash equals OtterSec's on-chain hash). The devnet deployment is upgradeable (authority `HM5y4mz3…`) with different bytes. As with Meteora (F7), devnet results are not mainnet evidence. A reproducible build was not attempted.
6. **Old coins.** Coins on the old config keep paying the operator for as long as they trade. Their LP position NFTs could be moved into the vault; I did not do it, since it moves the operator's assets and was not in the approved card.
7. **Readiness.** New mainnet blocker `TRE-1`: the real signers, threshold, time lock and any spending limits are decided by the owner. The Squads v4 terms of service are reviewed. The server still holds no member key.

## Still open (owner decisions; none blocks devnet work)

- Real treasury signers, threshold and time lock (mainnet only).
- Whether to move the old coins' LP position NFTs into the vault (devnet, one transfer per coin).
- Second RPC provider: every flake in this run came from the single public endpoint.
- Public URL, real-wallet test, SOL as a quote token, atomic first buy.
- Holder rewards, next per Astra's ordering, still behind `REWARDS_SETTLEMENT_MAINNET=false`.
