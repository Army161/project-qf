# Project QF: back brief, 2026-10-03

From Claude (the build thread), for Jeremy and Astra.
The full detail is in `PROJECT-QF-STATUS-REPORT-2026-09-28.md`; this page is the short version.

## Where we are: about 20% of the way to a launch-ready product

Nothing has changed since 2026-09-28. Everything below is still waiting on the owner actions in "What's next".

**Done**
- **Architecture and spec:** reviewed, approved with changes, 13 ADRs.
- **Offline core** (about 6,500 lines of code, 185 passing tests):
  - quote-asset validator;
  - economics and migration policy;
  - reward math with Merkle trees;
  - a transaction checker that binds what gets signed to what the creator approved;
  - the Meteora adapter, which runs server-side only.
- **Safety gates:** licence, dependency, browser-boundary and security dispositions (SEC-A).
- **Read-only verifier**, built to check Meteora's live programs. It has never been run, because Solana is blocked from the cloud.
- **Local git repo**, with 3 commits. A backup copy is in `git/project-qf.bundle`.
- **Pictures** in `images/`: an architecture diagram and the mock web app.
- **Status report and handoff to Astra** (2026-09-28).

**Not started**

These are the parts a user would actually touch:
- the real creator app;
- the backend and database;
- live Solana data;
- scores and AI;
- hosting;
- devnet and mainnet transactions.

## New since last time (checked today)

- **Meteora DBC SDK 2.x has NOT shipped.** npm still shows 1.5.13 as latest (published 2026-09-24), and that is the version we're pinned to. Native transfer-fee launches stay behind a disabled flag, as decided.
- **The cloud still can't reach Solana.** The verifier still can't run here.
- **No GitHub repo exists yet.**

## What's holding us back

1. **No Solana network access** from the cloud.
2. **No GitHub repo**, so there's one working copy and no parallel building.
3. **The Meteora inquiry hasn't been sent.** Their answer on U.S. eligibility and permissions gates devnet and mainnet. It's the longest outside wait.
4. **No crypto counsel and no external security review yet.** Both gate mainnet.

## What's next

Each of these is one action or one line from Jeremy:

| # | Action | Unblocks |
|---|---|---|
| 1 | Allow `api.mainnet.solana.com`, `api.devnet.solana.com`, `verify.osec.io` and `hermes.pyth.network` in Project settings | Live verification today, plus real data |
| 2 | Create an empty private GitHub repo `Army161/project-qf` | Push, CI, parallel build threads |
| 3 | Reply "send it" on the Meteora email | Starts the longest outside clock |
| 4 | Reply "build the unblocked product" | Creator app, backend, live data and scores v1, built in parallel. None of this waits on Meteora or legal. |
| 5 | Tell me where the $100 credit is from | I'll tell you how to point it at item 4 |

Still open from before:
- confirm "SEC-A adoption covers lockfile c2bb276a".

## For Astra

- Please keep reviewing **milestones**, not every pass. The offline core is solid. The value now is in live verification and the product build.
- My open asks from the 2026-09-28 handoff still stand:
  - checkable source citations (repo, commit, path, lines and quoted text) for the DBC Customizable rules;
  - a path off `bigint-buffer`.
