# Project QF: where we really are (status report, 2026-09-28)

From Claude, the build thread. Written for Jeremy, and pasteable to Astra as-is.

Every statement below is labelled one of three ways:
- **FACT**: in the spec, the code or a test run;
- **DECIDED**: a decision you made;
- **PROPOSAL**: my recommendation, which nobody has decided yet.

## 0. The short version

- **About 20% of the way to a launch-ready product** (my honest range: 15–25%). How I got there is in §8.
- The **design is nearly finished**, and the **offline safety core is built and tested**: about 6,500 lines of code, backed by about 2,200 lines of tests, with 185 passing tests.
- **Nothing the public would touch exists yet.** There's no real app screen, no backend, no live Solana connection, no data pipeline, no scoring or AI, and no hosting.
- Building has started. What hasn't started is the **product** part: we built the brakes before the car.
- **Three things hold us back.** The cloud environment can't reach Solana. There's no GitHub repo yet. And the legal and permission questions with Meteora haven't been asked.
- **The biggest speed-up is to build the ~60% of the product that nothing blocks** (§10), starting today, in parallel threads.

## 1. What it is

**FACT** (spec/docs/PRODUCT.md)

Project QF is a **Solana token-launch studio with intelligence built in**. A creator comes to launch a community token. QF does four things for them:
1. checks whether the asset they want to pair against (the "quote asset") is real and safe;
2. scores the opportunity;
3. proposes a launch configuration that the launch engine actually supports;
4. shows exactly what they're about to sign before their own wallet signs it.

The launch runs on **Meteora's Dynamic Bonding Curve**. When the token hits its target, it graduates automatically into a **Meteora DAMM v2 liquidity pool**. QF never holds keys or user funds.

"QuoteForge" is an internal codename only. The public name is undecided (ROADMAP open item 9).

## 2. What it does

**FACT**: the V1 capability list in PRODUCT.md.

1. **Search** quote assets by mint address. It never trusts symbols, because fake "USDC"s are trivial to make.
2. **Validator report.** Each check gets PASS, WARN or FAIL, with the evidence and the policy version recorded. For example, quote-market liquidity under $25K is FAIL, $25K–250K is WARN, and $250K or more is PASS (DECIDED).
3. **Opportunity and risk scores**, with the source of every number recorded. An AI narrative sits on top, and it is advisory only.
4. **Configure the token**: name, symbol, image and description.
5. **AI Launch Architect.** It proposes a configuration, the Policy Engine clamps it to safe values, and a simulation runs before anything is built.
6. **Decoded transaction preview**, plus a risk acknowledgement. Then the creator's wallet signs.
7. **Create the token and its curve** on QF's partner config.
8. **Lifecycle timeline**: trading, curve progress, graduation, migration and the live pool.
9. **Migration crank**, for when Meteora's keepers don't migrate the pool.
10. **Fee harvesting**, with transparent accounting.
11. **Holder rewards**, paid in the quote asset from QF's share of fees. Mainnet payouts are gated on an audit.

## 3. How it works

**FACT**: see the attached diagram `qf-architecture-2026-09-28.png`.

- **Browser app.** This is what creators and holders use. It never loads Meteora or web3.js code, and a boundary gate enforces that.
- **QF core libraries** (built):
  - Validator;
  - Policy (economics, curve template, migration threshold);
  - Rewards (time-weighted balances, allocation, Merkle tree);
  - Transaction checker (decodes each transaction and binds it to the terms the creator approved);
  - Core (readiness stages, integer money math).
- **Meteora adapter** (built, offline only). This is the only code that talks to Meteora's SDKs, and it runs on the server only. It builds **unsigned** transactions, and the creator's wallet signs them.
- **Intelligence layer** (not built): an indexer, a feature store, deterministic scores, and then an AI narrative. The rule is "measure first, AI last". The model never computes a score.
- **Infra** (not built): hosting, monitoring, two RPC providers cross-checking each other, alerting on program upgrades, and multisigs for QF's own fee and reward accounts.

## 4. Who it's for

**FACT** (PRODUCT.md personas)

| Who | What they get | In V1? |
|---|---|---|
| **Creators / community launchers** | Launch a token that's more likely to graduate and keep holders, without getting burned by a fake or illiquid quote asset | Full |
| **Holders** | Trade anywhere, and claim rewards in the QF app | Yes |
| **QF operator (us)** | A console for policy, registry and multisig | Internal |
| **Launch partners** with their own configs | A white-label pipeline | V2 |

## 5. Core workflow

**FACT**: this is the flow the mock UI walks through.

1. **Pick the quote asset** (by mint) → validator report
2. **Scores and narrative**
3. **Configure the token**
4. **Architect proposal**, clamped by the policy engine
5. **Simulation**
6. **Economics preview** and consent
7. **Decoded transaction preview**
8. **The creator's wallet signs**
9. **Live on the curve**
10. **Graduation** → DAMM v2 pool
11. **Fees harvested**
12. **Holder reward epochs** → holders claim

The long-term loop is **DISCOVER → VALIDATE → SCORE → SIMULATE → ARCHITECT → EXECUTE → MEASURE → LEARN**. Every launch's outcome becomes training history for the scores, and that loop is the moat (VISION.md).

## 6. The hook

**PROPOSAL.** The spec defines the problem but not the pitch.

The spec is explicit that "launch against any quote asset" is **not** the moat, because competitors already do it (VISION.md). The hook I'd use:

> **"Launch against the asset your community already holds, with proof it's the real asset, a setup that actually works on the engine, and holder rewards paid in that asset."**

Why it lands:
- Creators fear three things: fake or illiquid pairings, configs that never graduate, and launches that die after day one.
- QF answers each of them with evidence, not vibes.
- The holder-rewards angle gives holders a reason to stay after graduation.

Compliance note (DECIDED, COMPLIANCE.md): the copy may never promise returns or safety ("guaranteed", "safe investment" and so on are banned). The hook sells **verification and fit**, never profit.

## 7. Growth plan and pricing

**Pricing and monetization.** The mechanism is FACT and DECIDED; the numbers are not decided.
- QF earns a **share of the trading fees** on every launch through its partner config. There is no subscription in the spec.
- The fee path (ECONOMICS.md):
  - Meteora keeps 20% of each trading fee.
  - The other 80% is split between the creator and QF's partner account.
  - QF's partner share is split again, between QF revenue and the holder reward pool.
- After graduation, QF's permanently locked LP position in the DAMM v2 pool keeps earning pool fees.
- Worked example using the **V0 test values only**: a 1% fee, 50% to the creator and a 50/50 QF split. QF revenue then comes to about **0.2% of curve trading volume**, and holder rewards get another 0.2%. The production percentages are open (ROADMAP item 10) and are set by simulation.
- **PROPOSAL:**
  - keep launches **free up front**, with no pool-creation fee (it is 0 in V0);
  - earn from the fee share and the locked-LP fees;
  - add a paid **Pro intelligence tier** later: deeper scores, saved reports and alerts;
  - add **partner/white-label** pricing in V2.
  
  Free-to-launch is the norm for launchpads, so charging up front would hurt adoption.

**Growth plan.** PROPOSAL; there is no growth plan in the spec.
1. **Seed:** use the Opportunity Engine's saturation score to find 3–5 underserved asset communities, and help one creator in each launch well. That gives hand-held launches and case studies.
2. **Shareable validator reports:** every quote-asset check becomes a public page ("is this the real X?"). These are useful even to people who never launch, and they bring in search traffic.
3. **Holder rewards as the loop:** holders come to the QF app to claim, see other launches, and some become creators.
4. **Partnerships** with asset communities and their DAOs, who want safe tokens launched against their asset.
5. **Measured claim:** after 90 days, publish QF launches' graduation and retention against the DBC baseline (PAIN-POINT.md defines this metric). If the number is good, it becomes the marketing.

Guardrail: no paid shilling or yield promises, because of the compliance rules. Referral incentives only once counsel clears them.

## 8. How far along: about 20%

This is weighted by the work needed for a **V1.0 mainnet beta**, not by test counts.

| Area | Share of total work | Done | Contributes | Evidence |
|---|---|---|---|---|
| Spec, architecture, decisions | 10% | ~90% | 9% | 13 ADRs, 30 spec docs, validation report PASS |
| Offline core logic (validator, policy, rewards, tx checker, adapter) | 20% | ~60% | 12% | 185 tests; licence, SBOM and boundary gates. Some logic still runs on mock inputs. |
| Live Solana integration (verifier run, indexer, devnet then mainnet flows, migration crank, fee harvesting) | 20% | ~2% | 0.5% | Verifier built; attempted, never successfully verified live (blocked) *(wording corrected 2026-10-03)* |
| Real product UI (creator studio, holder claims, operator console) | 15% | ~5% | 0.75% | Only a mock walk-through page |
| Intelligence (data providers, feature store, scores, AI narrative) | 10% | ~3% | 0.3% | Scores are specified, not coded |
| Backend, infra, ops (API, database, hosting, monitoring, CI, multisigs) | 10% | ~0% | 0% | Nothing yet; no repo online |
| Legal, permission, audit, compliance | 15% | ~5% | 0.75% | Meteora inquiry drafted, not sent; no counsel yet; no external security review |
| **Total** | | | **≈ 23%, which I call ~20%** | |

## 9. What's left

In roughly this order:
1. **Live read-only verification.** Confirm that the deployed Meteora programs, authorities and configs match what we built against. This is blocked only by network access.
2. **GitHub repo and CI.** The repo is ready to push. It is blocked only by you creating the repo.
3. **Meteora's answers.** Are U.S. developers eligible? Is commercial integration allowed? Can we copy programs locally (LOCAL-1)?
4. **Unblocked product build**: live read-only data (RPC and Pyth), a lite indexer, the validator on real assets, scores v1, the creator studio UI, a backend API and database, and hosting.
5. **Localnet, then devnet integration**: real transactions on test networks, the migration crank, fee harvesting and reward epochs end to end. This needs item 3.
6. **Counsel**: jurisdictions, sanctions screening, disclosures and the product name.
7. **Mainnet gate** (DEPLOYMENT.md §2):
   - hardware multisigs;
   - production economics from simulation;
   - an **external security review** of the QF code;
   - Meteora or counsel confirmation;
   - alerting on program upgrades.
8. **Beta launch**, then reward payouts once their own audit gate passes.

## 10. Why the product build hasn't started, and what's holding us back

I'll be straight about this.
- **We chose safety-first on purpose.** The first passes built exactly what you can't retrofit: transaction binding, licence and boundary gates, dependency and security controls.
- **Then we looped.** Each Claude → Astra → Claude round found real but small issues, and the next pass fixed them. Three passes in a row polished offline code while nothing on-chain was verified. That's where the time went.
- **Hard blockers outside the code:**
  - the cloud environment gets **403** on the Solana RPC hosts, so I cannot touch the chain;
  - there is **no GitHub repo**, so there's one working copy and no parallel threads or pull requests;
  - **Meteora's permission and U.S.-eligibility questions are unasked**, and they gate localnet, devnet and mainnet;
  - **no counsel yet**, which gates mainnet.
- **What wasn't a blocker, but got treated like one:** the creator UI, the backend, read-only live data and the scores are **not** gated by Meteora or legal at all. We just never prioritized them. That's on the process, and I should have said so sooner.

## 11. How to speed this up

Ranked by payoff per minute of your time:

| # | Action | Your effort | What it unblocks |
|---|---|---|---|
| 1 | Add `api.mainnet.solana.com`, `api.devnet.solana.com` and `verify.osec.io` to allowed domains in Project settings. Add `hermes.pyth.network` for prices too. | ~2 min | Live verification today, and real data for the validator and scores |
| 2 | Create an **empty private** GitHub repo `Army161/project-qf` | ~1 min | Push, CI, PRs, several Claude threads building in parallel |
| 3 | Say **"send it"** on the Meteora inquiry | 1 word | Starts the longest external clock (their reply). It gates devnet and beyond. |
| 4 | Say **"build the unblocked product"** | 1 line | I split the work into parallel threads: creator studio UI; backend and database; live data and indexer-lite; scores v1. Each one opens pull requests. |
| 5 | Start looking for crypto counsel, and budget for an external security review | Your call | Removes the two slowest mainnet gates. These take calendar time, not code time. |
| 6 | Change the review rhythm: Astra reviews **merged milestones**, not every pass | 1 line | Stops the offline polish loop |
| 7 | Later: a paid RPC provider (for example Helius or Triton) | $ | Public RPC is rate-limited. We need it for the indexer and for the rule that two providers cross-check each other. |

## 12. The $100 cloud computer credit

- **Honest answer:** I can't see your account's billing, so I don't know exactly which credit this is.
- **If it's credit for Claude's cloud sessions** (Claude Code on the web, the kind of cloud computer I'm running on right now), then yes, it's useful. It pays for **more parallel build threads** like this one. Once the repo exists (item 2), that's exactly how we'd go faster: 3–4 threads each building one piece, instead of one thread doing everything in sequence.
- **What it can't do:** buy past the real blockers. No amount of compute fixes the network allowlist, Meteora's permission, counsel or an audit.
- **"One-shot build" warning:** a single giant session that tries to build the whole product at once would burn the credit and give you a demo, not a launchable product. The safety gates exist because real money moves through this.
- **My recommendation:** spend it on parallel threads **after** items 1 and 2, each with a tight scope and pull requests you can see.
- **I need to know where you saw the credit** (which page or email, and what it says it's for). Then I can tell you exactly how to point it at this.

## 13. Timeline

**Done (FACT):**
- **2026-09-26:** architecture gate, spec package, validation PASS.
- **2026-09-27:** V0 decisions applied. Offline V0 built. Two repair passes: safety controls, dependencies, config type and body limits.
- **2026-09-28:** handoff to Astra, local git repo, architecture diagram.

**Ahead (PROPOSAL; estimates, not promises).** It depends on how fast items 1–5 in §11 happen and on outside parties.

| Phase | Needs | Rough build effort once unblocked |
|---|---|---|
| Live read-only verification | Item 1 | Hours |
| Unblocked product slice (UI, backend, live data, scores v1, on mainnet read-only) | Items 1, 2 and 4 | ~2–4 weeks with parallel threads |
| Localnet, then devnet end to end | Meteora's answer (item 3) | ~2–3 weeks after the answer |
| Mainnet beta | Counsel, external security review, multisigs, production economics | Mostly waiting on third parties: often 4–8+ weeks of calendar time |
| Reward payouts on mainnet | Their own audit gate | After the beta |

The critical path is **not the code**. It's Meteora's reply, counsel and the security review. So the best move is to start those clocks now (items 3 and 5), and build everything else in parallel while they run.

## 14. What I need from you

In one line each:
1. Allow the Solana hosts in Project settings.
2. Create the empty private repo `project-qf`.
3. Tell me "send it" or "hold" on the Meteora email.
4. Tell me "build the unblocked product", yes or no.
5. Tell me where you saw the $100 credit.

Still open from before:
- "SEC-A adoption covers lockfile c2bb276a".

Attach with this report: `qf-architecture-2026-09-28.png`, `qf-web-app-2026-09-28.png`, and for Astra, `HANDOFF-TO-ASTRA-2026-09-28.md`.
