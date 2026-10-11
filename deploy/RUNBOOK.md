# Launchpad hosting runbook

The launchpad runs on **devnet only**: valueless test coins and a throwaway operator key. The free public test link runs it on alwaysdata's free plan (€0, no card, no domain). This build cannot write to mainnet in any setting; mainnet comes with the QF engine after the owner's gate, as a reviewed code change, not a deploy option.

## Rules that do not bend

- **The build is private.** It contains proprietary code and, under exception QF-LIC-EX-001, the unmodified LGPL `rpc-websockets@9.3.9` beside the server. It goes only to the owner's own host account; never to a public registry or to anyone else.
- **Secrets go in settings, never in Git, chat or logs**: the alwaysdata token and RPC keys.
- **One server.** The database is SQLite on one disk. Do not run two copies against it.

## 1. Owner, once

1. Sign up for alwaysdata Free (https://www.alwaysdata.com, no card). The account name becomes the address `https://<name>.alwaysdata.net`.
2. In the alwaysdata admin, Profile: turn on two-factor login (the token page needs it), then Profile → Tokens → add a token.
3. Optional, recommended: a free Helius API key, or a free Alchemy key for an app on **Solana Devnet**. One is enough. Without one the site uses the public devnet endpoint, which is rate-limited.
4. In this project's cloud environment settings (Project settings → Cloud environment → the gear next to the environment), add `ALWAYSDATA_ACCOUNT`, `ALWAYSDATA_API_TOKEN` and, if you made one, `QF_HELIUS_API_KEY` or `QF_ALCHEMY_API_KEY`. Never paste them in chat. Settings reach new sessions only, so the deploy runs in a fresh thread.

## 2. Deploy (Claude, in a fresh session, from the repository root)

```sh
pnpm install --frozen-lockfile --ignore-scripts      # in a secret-free environment (env -i ...)
pnpm build:web && pnpm boundary
node deploy/alwaysdata/build.mjs                     # deploy/alwaysdata/out/app: server.mjs, web/, NOTICES/, BUILD.json
node --no-warnings --use-env-proxy deploy/alwaysdata/deploy.mjs --dry-run   # prints the site settings, checks the token
node --no-warnings --use-env-proxy deploy/alwaysdata/deploy.mjs
```

`deploy.mjs` checks the token. On the first deploy it makes a throwaway devnet operator key and this host's test token and config on the deploying machine. The operator needs about 1 devnet SOL: the script asks the devnet faucet, and when the faucet refuses (it refuses the cloud container) it prints the operator's public address and stops with exit code 2. Send it about 1 devnet SOL from https://faucet.solana.com (choose Devnet), or from the launchpad operator, then run it again.

It then uploads the app (and, the first time, the data folder with the key and the store) through a temporary WebDAV login that it deletes at the end, creates or updates the Node.js site (Node 22, never idle, listening on `::` port 8100, settings in the site's environment), restarts it and waits for `/api/lp/healthz`. On success it deletes the local copy of the key; the host's copy is in `~/qf-launchpad/data` (outside the web folder, not served).

What runs on the host: `~/qf-launchpad/app/server.mjs` (the server in one file), `app/node_modules/` (unmodified `rpc-websockets@9.3.9` and its dependencies, server-side only), `app/web/` (the launchpad page only, no source maps), `app/NOTICES/`, `app/BUILD.json`.

Not yet confirmed against the live service, so check on the first run: the API's login format (the script uses the token with `account=<name>`), the WebDAV address (`https://webdav-<account>.alwaysdata.net`; override with `ALWAYSDATA_WEBDAV_URL`), how the site's environment field reads the quoted RPC URL, and memory (the server runs with `--max-old-space-size=160` and used 110-145 MB in the container). If 256 MB turns out too small, the fallback is Oracle Cloud Always Free (sign-up asks for a card as an ID check; ask the owner first).

## 3. After every deploy

1. `https://<account>.alwaysdata.net/api/lp/healthz` returns `{"ok":true,...,"mode":"DEVNET"}`.
2. The home page loads with no console errors and offers Create and the test faucet. The server sends a strict Content-Security-Policy; nothing loads from another site.
3. The books add up: `verify` (§5) prints no FAIL.

## 4. Settings

`deploy.mjs` writes these into the site's environment; set them by hand only to run the server somewhere else.

| Setting | Default | What it is |
|---|---|---|
| `QF_RPC_URL` | public devnet endpoint | devnet RPC. Secret when it carries an API key |
| `QF_LP_DB` | `./qf-launchpad.sqlite` | the store (one per network; it refuses to open on another) |
| `QF_DEVNET_KEY` | `~/.qf-devnet/operator.json` | the throwaway operator key (mode 0600, outside any git checkout) |
| `QF_LP_HOST`, `QF_LP_PORT` | `127.0.0.1`, `8788` | where the server listens |
| `QF_STATIC_DIR` | `apps/web/dist` | the built web app |
| `QF_PUBLIC_BASE_URL` | `http://127.0.0.1:<port>` | the public https address; written into new coins' metadata links, so set it before the first launch |
| `QF_CLIENT_IP_HEADER` | unset | the header carrying the visitor's address behind the host's proxy, for per-person rate limits. Leave unset until one request's headers show which one; until then every visitor shares one limit (safe, stricter) |
| `QF_LP_INTERVAL_MS` | `15000` | how often the indexer and the graduation crank run |
| `QF_ENGINE` | `meteora` | `qf` runs Project QF's own engine (SOL-quoted, its own store, no `setup`); `meteora` the Meteora one. Anything else refuses to start |
| `QF_CLUSTER` | `devnet` | engine mode only: `localnet` runs against a validator on 127.0.0.1 (refused anywhere else, and refused if the genesis is devnet's) |
| `QF_LP_DB` (engine) | `./qf-launchpad-engine.sqlite` | engine mode's store (`./qf-launchpad-engine-localnet.sqlite` on localnet); Meteora coins are in the other store and do not show in engine mode |

## 5. Checking the books

```sh
cd apps/launchpad && QF_LP_DB=<store> node --no-warnings --use-env-proxy src/main.ts verify [--json out.json]
```

It reads the chain and prints one line per check, then a total:

- **PASS**: the numbers agree exactly (fees recorded trade by trade = what the pool still holds + what was claimed; the treasury vault = claim receipts in − rewards deposits out; each frozen holder-rewards record recomputes to the same hash; each payout matches its record), or differ only by rounding proven from the pool's own fee accounting.
- **FAIL**: they disagree. The exit code is 1.
- **WAIT**: something could not be read yet (a transaction, a pool, the RPC was busy). Run it again later.

In engine mode (`QF_ENGINE=qf … src/main.ts verify [--json]`) the checks are per coin and exact to the raw unit: each curve vault against the curve account, the curve against its last trade, platform and creator fees (every trade's fee − claims = unclaimed on chain), the pool's LP supply is 0 after graduation, and the pool's creator fee against every pool swap − collected.

## 6. Updates, take down, backups

- **Update:** run `build.mjs` and `deploy.mjs` again. The data folder is left alone, and the database schema migrates forward on start.
- **Take it down:** in the alwaysdata admin, Web → Sites, delete or stop the site. The store and key stay in `~/qf-launchpad/data` until you delete that folder.
- **Backup:** download `~/qf-launchpad/data` over the admin's file access before risky changes. It holds a throwaway devnet key only.
- **Something looks wrong:** stop the site. It holds no mainnet keys and cannot move real funds, so stopping it loses only availability.

## Later, when there is money (not now)

A paid host with a persistent disk, a domain and the public product name, and a paid RPC plan. That move goes with the QF engine and the owner's gate (lawyer, real treasury signers, outside security review), so its steps will be written then, for that engine.
