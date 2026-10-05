# Mainnet launch checklist (2026-10-05)

Owner: Jeremy Gephart. Reviewer: Astra. Prepared by Claude.

**Today:** mainnet runs read-only. The app reads real mainnet: the USDC mint, the Meteora DBC and DAMM v2 programs and the Squads program. Both RPC providers agree on all four. Every launch, trade, claim, treasury step and faucet request is refused. This build has no mainnet write path at all, so turning mainnet on is a reviewed code change made after the gate below, not a setting.

## What only you can do, in the order that unblocks the most

| # | Item | Why it blocks | Status today | Gate |
|---|---|---|---|---|
| 1 | **Meteora's written answer** on commercial use of their deployed programs | Their licence covers the SDKs, not the programs. You are a US user. | Email sent from your Gmail at 20:43Z. Waiting for a reply. | DEPLOYMENT.md §2.1, DEV-3 |
| 2 | **A lawyer's sign-off**: which countries, sanctions screening, the disclosures people see before buying | Real people would put real money into coins launched here | Not started | §2.4 |
| 3 | **Three treasury signers**: three different people, each with a hardware wallet (Ledger). Also the threshold (2 of 3 recommended) and the time lock (0, or for example 24 hours). | Platform fees go to this multisig from the first coin. The server must never hold a signer key. | Devnet stand-in only (three test keys, one operator) | §2.5, TRE-1 |
| 4 | **An outside security review** of the transaction builder, preview decoder, Meteora adapter, policy engine and signing routes | No one outside has read the code that would move money | Not started. The scope is in DEPLOYMENT.md §2.7. | §2.7 |
| 5 | **Accounts**: a domain, Fly.io or Render, two paid RPC providers from different companies, and the public product name (not "QuoteForge") | Hosting, reliable reads, branding | None yet. The deploy package is ready (`deploy/RUNBOOK.md`). | §2.8 |
| 6 | **Production fees**: approve the trading fee, the creator and platform split, and the graduation target, after reading the simulation report | A config cannot be changed after it is created | Test economics only: 1% fee, Meteora 20% of it, creator and platform 50/50 of the rest, graduation at 5,000 USDC | §2.6 |
| 7 | **A setup wallet** with about 0.01 SOL | Pays rent for the multisig and the config. It gets no rights over either. | Cost read from mainnet today: 0.007818 SOL plus network fees | `MAINNET-SETUP-PLAN.md` |

Once item 5 exists, the read-only site can go up at your domain the same day (runbook §3 or §4). Items 1 to 4 and 6 gate real money.

## What Claude still builds before the switch

| # | Item | Status |
|---|---|---|
| E1 | The mainnet write path, as one reviewed change: the same unsigned-transaction, preview and binding flow as devnet, enabled only when the gate is met. The server still never signs for anyone. | Not started, on purpose: it waits for items 1 to 4 |
| E2 | Setup executor: builds the two setup transactions with the real payer, and generates the multisig create key and the config account key in the signer's own wallet session, never on the server | Plan only today (`mainnet-plan.ts`, unsignable by construction) |
| E3 | Graduation target from live USDC price and liquidity evidence, replacing the plan's $1.00 assumption | Plan assumption today |
| E4 | Config registry: proposed, then active only after the on-chain config is read back and matches (DEPLOYMENT.md §3) | Read-back steps are listed in the plan |
| E5 | Program verification on mainnet with two providers, and alerts if a program is upgraded (§2.2) | Done with one provider (exit 0). The verifier needs a second provider passed in for the cross-check. |
| E6 | Trade history at production volume (IDX-1) | Open (Astra, milestone 6 review) |
| E7 | Incident runbook (§5): pause launches, alert holders | Hosting part done (`deploy/RUNBOOK.md` §9). The product part is open. |
| E8 | A private GitHub repository and CI (§4) | No repository yet. Code travels as the Git bundle. |
| E9 | The three known `pnpm audit` advisories (SEC-A). The dispositions need your approval and expire 2026-12-27. | Pending your approval |
| E10 | Holder rewards: devnet first, under Astra's criteria. Mainnet payouts have their own gate (REWARDS.md §6). | Next milestone |

## Launch day, once everything above is done

1. The read-only site runs at your domain with two paid providers. The Status page shows MATCH on all four checks.
2. Run `plan` with the real signer addresses, threshold, time lock, production fees and graduation target. You, the signers and the reviewers read the decoded transactions.
3. The setup wallet and the signers create the multisig, then the config, through the setup executor (E2).
4. Both are read back from two providers and compared with the plan. Only then is the config recorded as active.
5. Ship the reviewed change that turns on mainnet writes (E1). It needs your explicit go-ahead in words.
6. You launch the first coin with a small amount, and we watch the Earnings checks.

## Not part of this launch

Holder-reward payouts, transfer-fee coins (`DBC_BASE_TRANSFER_FEE`), Jupiter, and any custom on-chain program. Each has its own gate.
