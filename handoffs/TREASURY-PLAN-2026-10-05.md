# Platform treasury: devnet plan (waiting on the owner's go-ahead)

Author: Claude. Owner: Jeremy Gephart. Reviewer: Astra. Status: plan only. No keys were created, no authority was changed and nothing was written on chain for this plan.

Astra's milestone 6 review recommends the treasury next and holder rewards after it. This note lays out the whole authority path first, as that review asked.

## Who controls the platform's money today (devnet)

All of it sits with one throwaway hot key, the operator `4eup3P…PArX` (`~/.qf-devnet/operator.json`, outside git).

| Entitlement | Where it sits | Who can move it |
|---|---|---|
| Partner share of curve trading fees | DBC config `5EEfER…KaC`, `fee_claimer` = operator | the operator key |
| Partner's locked DAMM v2 LP positions (one per graduated coin) | Position NFTs minted to `fee_claimer` at migration | whoever holds the NFT: the operator |
| Curve leftovers after migration | `leftover_receiver` = operator | the operator key |
| Fee payer for the migration crank and the faucet | operator | the operator key |

Two facts shape the plan:

1. **The existing config can never point at a treasury.** The DBC program has no instruction that changes a config's `fee_claimer`; I checked the instruction list of the pinned DBC SDK 1.5.13. A treasury needs a new config. Coins already launched on `5EEfER…KaC` keep paying the operator for as long as they trade.
2. **The LP position NFTs can move.** The partner's locked positions follow their NFT, so they can be transferred to the treasury.

## Devnet stand-in (proposed)

- **Multisig.** A Squads v4 multisig (program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`), 2-of-3.
  - **Members.** Three throwaway devnet keys generated outside git, standing in for the real signers.
  - **Settings.** No config authority, so a change of members or threshold itself needs 2 of 3 votes. No spending limits. No time lock.
- **Treasury address.** The multisig's **vault PDA** (index 0). It is never the multisig account itself.
- **New platform config.** Same economics and fee settings as today. `fee_claimer` and `leftover_receiver` are both the vault PDA. New launches use it; existing coins stay on the old config.
- **Platform claims.** The server builds the claim (`claim_trading_fee`, and `claim_position_fee` for the partner's LP positions) as a Squads vault-transaction proposal. The browser decodes the inner transaction and checks it against bound terms, the same way user transactions are checked today. Two members approve in their own wallets, and a member executes it.
- **What the server can and cannot do.** It can propose and pay fees. It holds no member key, so it cannot approve or execute, and it cannot spend.
- **Earnings page.** Shows the platform's claims ("paid to treasury"), with the old config and the new config separated.
- **Optional.** Move the operator's devnet LP position NFTs into the vault.

## What it needs

- **Squads SDK.** `@sqds/multisig` 2.1.4 is MIT. Its dependencies are MIT/Apache-2.0 packages (web3.js, spl-token, beet). It would run server-side in the adapter only, never in the browser, and must pass `license:check` and `boundary`.
- **Program verification.** The Squads v4 program goes into the read-only verifier, devnet only for now.
- **Before mainnet.** A deployed-service terms review for Squads, like DEV-3 for Meteora.

## Decided later by the owner (mainnet)

- Who holds the three member keys, on hardware.
- The threshold.
- Any time lock.
- Whether any spending limit exists. A spending limit lets one member move funds without a vote, so the default is none.

## Not in this milestone

- **Holder rewards.** The rewards spec (`spec/docs/REWARDS.md`) already computes allocations from indexed balance history (TWAB), not from the trade list, which covers Astra's point about direct transfers. Rewards stay behind `REWARDS_SETTLEMENT_MAINNET=false`.
- **The indexer scaling bound.** It is now mainnet blocker `IDX-1` in `packages/core/src/readiness.ts`.
