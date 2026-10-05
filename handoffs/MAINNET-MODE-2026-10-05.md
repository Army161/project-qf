# Project QF Launchpad: mainnet mode, setup plan and hosting package (2026-10-05)

Author: Claude (implementer). Owner: Jeremy Gephart. Reviewer: Astra.

- Branch `milestone/launchpad-devnet`, on top of the treasury authorization pass (`a2f5c4d`). Commits `a50c55c` and `ed53a4d`.
- Mainnet: **read-only**. Writes: none; this build has no mainnet write path. Keys: none created, none loaded on mainnet. Real funds: none.
- Devnet: unchanged. Readiness: unchanged (`MAINNET` BLOCKED, `MAINNET_WRITES=false`).

## What Jeremy asked, and what this delivers

At 20:38Z Jeremy asked for everything "completely built live on main". Five things only he can supply gate real-money mainnet:

1. Meteora's permission (the email went out at 20:43Z).
2. A lawyer's sign-off.
3. Three real treasury signers.
4. An outside security review.
5. Accounts: a domain, hosting, paid RPC providers and a product name.

I promised to make the switch ready meanwhile. This pass does that:

| Promised | Delivered | Proof |
|---|---|---|
| USDC instead of test qUSD | Mainnet mode quotes in USDC (`EPjF…Dt1v`, 6 decimals), read from chain and checked at start and every 10 minutes | `evidence/mainnet-readonly/chain-check.json` |
| No faucet | The faucet answers 404 `NO_FAUCET` on mainnet, and the web app hides it | `write-refusals.txt`, screenshots |
| Every read checked against two RPCs | The USDC mint and the DBC, DAMM v2 and Squads programs are read at `finalized` from two providers and compared. If they disagree, both are read again from the later slot. With one provider the result says `SINGLE_PROVIDER`, never MATCH. | live: all 4 MATCH at slots 453696899/453696900; in the container: 4 MATCH again |
| Platform config owned by the multisig from day one | The **mainnet setup plan**: the exact multisig and USDC config transactions, with the fee claimer and leftover receiver set to the treasury vault. They are built for review and cannot be signed (below). | `evidence/mainnet-plan/` |
| Deploy package for hosting | A container image, a settings template with no secrets, `fly.toml` and a runbook. The image was built and run here: as a non-root user, on a read-only disk, with a root-owned volume, and the image holds no keys. | `deploy/`, `evidence/deploy/` |
| What is left | The launch checklist: owner items, engineering items and the launch-day order | `handoffs/MAINNET-LAUNCH-CHECKLIST-2026-10-05.md` |

## 1. Mainnet read-only mode (`QF_CLUSTER=mainnet-beta`)

- **No write path.** The adapter's mainnet connection proves the mainnet genesis hash. It wraps the RPC client so that `sendRawTransaction`, `sendTransaction`, `sendEncodedTransaction`, `requestAirdrop`, `simulateTransaction` and `confirmTransaction` throw `WRITES_LOCKED`. The wrapper cannot be patched at run time (tested).
- **One gate in the server.** Every route that builds, sends or moves anything answers 423 `WRITES_LOCKED` with the reasons: launch, swap, submit, claim, and treasury propose, approve and execute. The faucet answers 404. Read routes still work.
- **On mainnet the CLI allows only `serve`, `chain-check` and `plan`.** No operator key is loaded. `MAINNET_WRITES=true` in the environment is ignored, and the page says so.
- **Separate databases.** A database is bound to its network on first use. A mainnet database refuses to open as devnet, and the reverse (`STORE_CLUSTER_MISMATCH`, tested and shown in the container).
- **Web app.**
  - A "MAINNET · READ-ONLY" bar.
  - A **Status** page with the four chain checks, why sending is locked, and the open readiness items.
  - The Create page says "Launching is locked".
  - Screenshots on desktop and phone: no console errors, no horizontal overflow (`evidence/mainnet-readonly/shots/`).

## 2. Mainnet setup plan (`node src/main.ts plan`, mainnet only)

The plan describes the two transactions the real launch would run:

1. Create the 2-of-3 Squads v4 treasury: every member can initiate, vote and execute; no config authority; time lock as chosen.
2. Create the DBC config: USDC quote, with the fee claimer and leftover receiver both set to the treasury's vault.

**It cannot be signed or landed.** The fee payer, the multisig create key and the config account are placeholders: sha256 of a label, so no one holds a key for them. The blockhash is a placeholder too. The plan checks this on the decoded bytes (`NOT_SIGNABLE`, `NOT_LANDABLE`).

**Checks on what was built.** A live run against mainnet with two providers passed all 11:

- the Squads program config was read from both providers (creation fee 0 lamports);
- the multisig and vault addresses were derived twice, by the Squads SDK and by QF's own derivation;
- the multisig arguments were decoded back from the instruction bytes;
- the config transaction was decoded by QF's pinned decoder and bound to `CREATE_CONFIG` terms: every account, signer and writable, and the parameter digest;
- the fee claimer and the leftover receiver are the vault, the quote is USDC, and the pinned program ids are used;
- no member is a placeholder signer.

**Cost from mainnet today:** 0.007818 SOL. That is rent for the 231-byte multisig and the 1,048-byte config (both providers agree), plus network fees.

**Labelled clearly:**
- The economics are `STANDARD_V1@0-v0test` (V0_TEST): not approved for production.
- The graduation target (5,000 USDC, the migration policy's default) assumes USDC at $1.00, with no live evidence.
- The members are placeholders until the owner names the real signers.

**Owner decisions** are listed in `MAINNET-SETUP-PLAN.md`: signers, threshold, time lock, production fees, graduation target and the setup wallet.

## 3. Hosting package (`deploy/`)

- **`Dockerfile`**
  - Node 22.22.0 pinned by digest.
  - Frozen lockfile, with no dependency scripts.
  - The web build and the **browser boundary check** run inside the image build, so a web bundle that ever picked up web3.js, `rpc-websockets` or `@meteora-ag/*` stops the build.
  - The runtime holds only the launchpad's production dependencies.
  - It defaults to mainnet read-only.
- **`entrypoint.sh`.** Hosts such as Fly.io mount a new volume owned by root. The entrypoint hands `/data` to the unprivileged `node` user, then replaces itself with the server, run as that user (`setpriv`).
  - **Found and fixed here:** without it, the server could not open its database on a root-owned volume.
  - **Also found:** as PID 1, the server ignored the stop signal, so Docker killed it after 10 s. It now closes cleanly on SIGTERM (exit 0, under a second).
- **Tested in this container (Docker 29):**
  - read-only root filesystem; runs as uid 1000;
  - healthy by its own health check;
  - 4 MATCH across two providers;
  - 7× 423 and the faucet 404;
  - strict CSP and security headers;
  - about 89 MB of memory;
  - devnet mode boots and makes its throwaway key with mode 0600 on the volume;
  - the runbook's admin command reads the same key as the server.
- **Key scan of the image's files:** 0 hits, 149 files (`image-key-scan.jsonl`). The sandbox's proxy address is not in the image.
- **`launchpad.env.example`.** Setting names and safe defaults only. RPC URLs with API keys are marked SECRET, for the host's secret store.
- **`fly.toml` and `RUNBOOK.md`.**
  - Covers Fly.io and Render: the volume, secrets, domain, post-deploy checks, an optional public devnet test launchpad, the setup plan, updates, rollback, backups and incidents.
  - It says the image is private and the app runs on one machine.
- **New setting `QF_CLIENT_IP_HEADER`.** Behind a host's proxy, every request comes from the proxy, so per-person rate limits need the header the proxy sets (Fly.io: `fly-client-ip`). Only the named header is trusted; for `X-Forwarded-For` only the rightmost entry is used (tested).

## Checks (`evidence/mainnet-mode/checks.txt`, secret-free wrapper)

- install, typecheck, **test (317/317: 300 before, plus 17 new)**, license:check, deps:chain, build:web and boundary all exit 0.
- `pnpm audit --prod` exits 1 with the same 3 known SEC-A advisories (bigint-buffer, uuid, stream-json).
- No dependency was added.
- A key scan of the new and changed files found 0 hits.

These are test results, not an audit or a readiness claim.

## Notes for Astra

1. **Readiness text is stale. I did not change it.** `READ_ONLY_VERIFICATION` is still BLOCKED, and its RO-1 line says "no live evidence exists". Live read-only runs happened on 2026-10-03 and again today. Updating that record is the owner's and your call.
2. **Four multisig roles in DEPLOYMENT.md §2.5.**
   - A DBC config has no instruction that changes it after creation (as far as the pinned SDK and IDL show; noted in milestone 7). So `CONFIG_OWNER` reduces to who may create configs, and `FEE_CLAIMER` is the treasury vault in this plan.
   - `REWARD_AUTHORITY` comes with holder rewards. `DEPLOYMENT_ADMIN` is whoever controls the hosting account.
   - Worth confirming that this reading of §2.5 is acceptable.
3. **QF-LIC-EX-001 and hosting.** The image contains `rpc-websockets` (LGPL) server-side, as the exception allows. My reading: our own private image on our own Fly.io or Render app is server-side use, not a "customer container". The runbook forbids public registries and giving the image to anyone. The lawyer should confirm this alongside the Meteora question.
4. **The setup plan is not an execution path.** The real run needs the setup executor (checklist E2): the create key and config key generated in the signer's wallet session, never on the server, plus live USDC price evidence (E3).
5. **Next, in Astra's order:**
   - the origin proof for the LP residuals (recompute each position's share from the DAMM fee accumulator);
   - then holder rewards on devnet: the fee ledger for funding, a separate balance-over-time history for allocation, and only deposited rewards distributable.

## Files

- **Mainnet mode:**
  - `apps/launchpad/src/cluster.ts` (new)
  - `apps/launchpad/src/server.ts`, `store.ts` and `main.ts`
  - `packages/adapter-meteora-dbc/src/launchpad.ts`
  - web `main.ts`, `format.ts`, `launchpad.css` and `launchpad.html`
- **Plan:** `packages/adapter-meteora-dbc/src/mainnet-plan.ts` and `apps/launchpad/src/mainnet-plan.ts` (new).
- **Hosting:** `deploy/` (new) and `.dockerignore` (new).
- **Tests:**
  - `packages/adapter-meteora-dbc/test/mainnet-readonly.test.ts` (5)
  - `apps/launchpad/test/mainnet-mode.test.ts` (7)
  - `apps/launchpad/test/mainnet-plan.test.ts` (5)
- **Evidence:** `evidence/mainnet-readonly/`, `evidence/mainnet-plan/`, `evidence/deploy/` and `evidence/mainnet-mode/`.
- **Handoffs:** this report and `MAINNET-LAUNCH-CHECKLIST-2026-10-05.md`.
