# Launchpad hosting runbook

One container image runs the launchpad server and serves the web app (§2-§4). For the free test link without Docker, a one-file build of the same server runs on alwaysdata (§6a). It has two modes:

| Mode | Setting | What people can do | Keys on the host |
|---|---|---|---|
| **Mainnet read-only** (default; DEPLOYMENT.md "staging") | `QF_CLUSTER=mainnet-beta` | browse, read the Status page; every launch, trade, claim, treasury step and faucet request is refused (423 / 404) | none |
| **Devnet test launchpad** | `QF_CLUSTER=devnet` | launch and trade valueless test coins with a devnet wallet, use the test faucet | one throwaway devnet operator key, generated on first start, on the volume (`/data/.qf-devnet/`) |

This build cannot write to mainnet in any setting. Going live on mainnet is a reviewed code change after the owner's gate (DEPLOYMENT.md §2; `handoffs/MAINNET-LAUNCH-CHECKLIST-2026-10-05.md`), not a deploy option.

## Rules that do not bend

- **The image is private.** It contains proprietary code and, under exception QF-LIC-EX-001, the LGPL `rpc-websockets@9.3.9` inside the server-side adapter. Push it only to your own host's private registry (Fly.io or Render build it for you from this repository). Never push it to Docker Hub or any public registry, and never give it to anyone else.
- **No mainnet keys on the host.** Nothing in mainnet mode loads a key, and none is needed.
- **Secrets go in the host's secret store**: RPC URLs that carry API keys. Never in `fly.toml`, Git, chat or logs.
- **One machine.** The database is SQLite on one volume. Do not scale to two machines.

## 1. Before you start (owner)

**Free, for now: a public devnet test link (§6a).** No card, no domain, nothing to pay.

- [ ] An alwaysdata Free account (https://www.alwaysdata.com). The account name becomes the address `https://<name>.alwaysdata.net`.
- [ ] Optional, recommended: a free Helius API key and a free Alchemy key for a Solana Devnet app. Without them the site uses the public devnet endpoint, which is rate-limited.

**Paid, later: mainnet read-only now, real launches after the owner's gate (§3, §4).**

- [ ] A host account with a persistent disk: Fly.io or Render.
- [ ] A domain, and the public product name (not "QuoteForge", DEPLOYMENT.md §2 item 8).
- [ ] Two RPC providers from different companies (for example Helius plus Triton or QuickNode), mainnet https endpoints. The public endpoints work for a trial but are rate-limited.

Free options checked on 2026-10-10 and not used: Render Free (the disk is wiped on every restart and the service sleeps after 15 minutes, so the SQLite store would be lost), Koyeb (needs a card; no disk on the free instance), Railway (a $1 monthly credit), Fly.io (no free plan), Oracle Cloud Always Free (a real server, but sign-up needs a card for verification; the fallback if alwaysdata's 256 MB of memory turns out too small). QuickNode's free offer is a 30-day trial.

## 2. Build and run it on your own computer (optional)

From the repository root, with Docker installed:

```sh
docker build -f deploy/Dockerfile -t qf-launchpad .
docker run --rm -p 8080:8080 -v qf-data:/data --read-only --tmpfs /tmp qf-launchpad
# open http://localhost:8080 ; the Status page shows the chain checks
```

The build runs the browser boundary check. If `@solana/web3.js`, `rpc-websockets` or `@meteora-ag/*` ever reached the web bundle, the build stops.

## 3. Fly.io

From the repository root, with `flyctl` installed and logged in:

```sh
fly apps create <app-name>                      # then put <app-name> in deploy/fly.toml
fly volumes create qf_data --size 1 --region iad --app <app-name>
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

Set the RPC URLs as secrets in the Fly dashboard (app → Secrets), so the key never sits in your shell history: `QF_RPC_URL` and `QF_RPC_URL_2`. Secrets take effect when the machine restarts or you deploy again.

Your domain: `fly certs add <your domain>`, then add the DNS records Fly prints. Then set `QF_PUBLIC_BASE_URL` in `fly.toml` and deploy again.

## 4. Render

1. New → Web Service → connect this repository.
2. Runtime **Docker**. Dockerfile path `deploy/Dockerfile`. Docker build context `.` (the repository root).
3. Add a **Disk** mounted at `/data` (1 GB is plenty). Disks need a paid instance type.
4. Environment: `QF_CLUSTER=mainnet-beta`, `QF_LP_DB=/data/qf-launchpad-mainnet.sqlite`. Add `QF_RPC_URL` and `QF_RPC_URL_2` as secret values.
5. Health check path: `/api/lp/healthz`.
6. Client address for rate limits: log one request's headers first, then set `QF_CLIENT_IP_HEADER` to the header that carries the visitor's address. Until then leave it unset. Every visitor then shares one rate limit, which is safe but stricter.

## 5. After every deploy

1. `https://<domain>/api/lp/healthz` returns `{"ok":true,...,"mode":"MAINNET_READ_ONLY"}`.
2. The **Status** page lists the four chain checks (USDC mint and the DBC, DAMM v2 and Squads programs) as **MATCH**, cross-checked across two providers. `SINGLE_PROVIDER` means `QF_RPC_URL_2` is missing.
3. The Create page says "Launching is locked" and lists why.
4. The page loads with no console errors. The server sends a strict Content-Security-Policy; nothing loads from another site.

## 6. Devnet test launchpad on a host (optional)

For testing with real wallets (Phantom or Solflare set to devnet) at a public address:

1. Set `QF_CLUSTER=devnet`, `QF_LP_DB=/data/qf-launchpad-devnet.sqlite` and `QF_PUBLIC_BASE_URL=https://<domain>`. Use a separate app and volume from mainnet read-only. A database refuses to open on the other network anyway.
2. The first start generates a throwaway operator key at `/data/.qf-devnet/operator.json` (mode 0600). Print its public address. The command runs as the server's own user with the server's settings, so it reads the same key:
   ```sh
   fly ssh console -C "setpriv --reuid=node --regid=node --init-groups env HOME=/data QF_CLUSTER=devnet QF_LP_DB=/data/qf-launchpad-devnet.sqlite sh -c 'cd /app/apps/launchpad && node --no-warnings src/main.ts operator'"
   ```
3. Send it about 1 devnet SOL from https://faucet.solana.com (free test SOL, no value).
4. Create the test token and config once: the same command with `setup` in place of `operator`.
5. Restart the machine. The home page now offers launching and the test faucet.

This host gets its own test token and config. The coins launched in the development container stay there.

## 6a. Free devnet test link (alwaysdata, no card, no domain)

The same devnet test launchpad as §6, on alwaysdata's free plan: €0, no card, 1 GB disk that persists, 256 MB memory, an always-on Node.js site at `https://<account>.alwaysdata.net`. alwaysdata has no Docker, so the server is built into one file and uploaded over HTTPS. Devnet only: valueless test coins, a throwaway operator key.

**Owner, once:**

1. Sign up for alwaysdata Free (no card). Pick the account name you want in the address.
2. In the alwaysdata admin, Profile: turn on two-factor login (the token page needs it), then Profile → Tokens → add a token.
3. Optional, recommended: a free Helius account (copy the API key) and a free Alchemy account with an app on **Solana Devnet** (copy the API key).
4. In this project's cloud environment settings (Project settings → Cloud environment → the gear next to the environment), add `ALWAYSDATA_ACCOUNT`, `ALWAYSDATA_API_TOKEN` and, if you made them, `QF_HELIUS_API_KEY` and `QF_ALCHEMY_API_KEY`. Never paste them in chat. Settings reach new sessions only, so the deploy runs in a fresh thread.

**Deploy (Claude, in a fresh session, from the repository root):**

```sh
pnpm install --frozen-lockfile --ignore-scripts      # in a secret-free environment (env -i ...)
pnpm build:web && pnpm boundary
node deploy/alwaysdata/build.mjs                     # deploy/alwaysdata/out/app: server.mjs, web/, NOTICES/, BUILD.json
node --no-warnings --use-env-proxy deploy/alwaysdata/deploy.mjs --dry-run   # prints the site settings, checks the token
node --no-warnings --use-env-proxy deploy/alwaysdata/deploy.mjs
```

`deploy.mjs` checks the token, and on the first deploy makes a throwaway devnet operator key and this host's test token and config on the deploying machine. The operator needs about 1 devnet SOL. The script asks the devnet faucet; when the faucet refuses (it refuses the cloud container), it prints the operator's public address and stops with exit code 2. Send it about 1 devnet SOL from https://faucet.solana.com (choose Devnet), or from the launchpad operator, then run it again. It then uploads the app (and, the first time, the data folder with the key and the store) through a temporary WebDAV login that it deletes at the end, creates or updates the Node.js site (Node 22, never idle, listening on `::` port 8100, settings in the site's environment), restarts it and waits for `/api/lp/healthz`. On success it deletes the local copy of the key; the host's copy is in `~/qf-launchpad/data` (outside the web folder, not served).

What runs on the host: `~/qf-launchpad/app/server.mjs` (the server in one file), `app/node_modules/` (unmodified `rpc-websockets@9.3.9` and its dependencies, QF-LIC-EX-001: server-side only), `app/web/` (the launchpad page only: no source maps, no inspector or mock pages), `app/NOTICES/`, `app/BUILD.json`. It stays on the owner's account; the rules above apply as they do to the image.

**First-deploy checks (Claude):** the site log in the admin (Logs) shows the server listening; §5 items 1, 3 and 4 with `mode` `DEVNET`; the Status page shows `SINGLE_PROVIDER` unless both RPC keys are set. Not yet confirmed against the live service, so check them on the first run: the API's login format (the script uses the token with `account=<name>`), the WebDAV address (`https://webdav-<account>.alwaysdata.net`; override with `ALWAYSDATA_WEBDAV_URL`), how the site's environment field reads the quoted RPC URL, and memory (the server runs with `--max-old-space-size=160` and used 110-145 MB in the container). Leave `QF_CLIENT_IP_HEADER` unset until one request's headers show which one carries the visitor's address.

**Update:** run `build.mjs` and `deploy.mjs` again; the data folder is left alone. **Take it down:** in the admin, Web → Sites, delete the site (or stop it). The store and key stay in `~/qf-launchpad/data` until you delete that folder.

## 7. Mainnet setup plan (review only)

`node src/main.ts plan` (mainnet mode) writes `mainnet-setup-plan.json` and `MAINNET-SETUP-PLAN.md`. They describe the treasury multisig and the USDC config the real launch would create. Both transactions use placeholder signers and a placeholder blockhash, so they can be read and checked but never signed or sent. Options: `--members a,b,c --threshold 2 --time-lock 0 --graduation-usd 5000 --out <dir>`.

## 8. Updates, rollback, backups

- Update: deploy again. The database schema migrates forward on start.
- Rollback: `fly releases` then `fly deploy --image <previous image>`. An older build may not open a database a newer one migrated. Restore the volume snapshot taken before the update.
- Backups: Fly takes daily volume snapshots (`fly volumes snapshots list <volume id>`). Render: take a manual disk snapshot before risky changes.

## 9. Incident

- Something looks wrong on the public site: stop the machine (`fly machine stop`). Mainnet mode holds no keys and cannot move funds, so stopping it loses only availability.
- A provider disagrees (Status shows MISMATCH): the server keeps refusing writes in any case. Check both providers' status pages, and replace the one that is wrong.
