// Deploys the devnet test launchpad (deploy/alwaysdata/build.mjs output) to an alwaysdata Free account, over HTTPS only
// (the alwaysdata API and WebDAV; no SSH needed). Free plan: no card, 1 GB disk that persists, 256 MB RAM, a free
// https://<account>.alwaysdata.net address. Devnet only: valueless test coins, a throwaway operator key.
//
// Settings (environment; never in Git, chat or logs):
//   ALWAYSDATA_ACCOUNT      the account name (also the address: https://<account>.alwaysdata.net)
//   ALWAYSDATA_API_TOKEN    Profile > Tokens in the alwaysdata admin (the profile needs two-factor login to make one)
//   QF_ALCHEMY_API_KEY      optional: Alchemy Solana devnet key; the site's RPC when set
//   QF_HELIUS_API_KEY       optional: Helius key; the site's RPC when there is no Alchemy key (one key is enough)
//   ALWAYSDATA_WEBDAV_URL   optional override (default https://webdav-<account>.alwaysdata.net)
// Without RPC keys the site uses the public devnet endpoint, which is rate-limited.
//
// What it does:
//   1. checks the token against the account
//   2. first deploy only: makes a throwaway devnet operator key on this machine, in ~/.qf-alwaysdata-init/<account> (mode
//      0700). The launchpad runs on Project QF's own engine, which is already set up on devnet, so there is no platform setup.
//      The operator pays for the test-SOL faucet and the graduation crank, so it needs devnet SOL: the script asks the devnet
//      faucet, and if that is refused it prints the PUBLIC address to fund and stops; run it again once funded.
//   3. makes a temporary WebDAV user with a random password, uploads app/ (and, the first time, the key), deletes the user
//   4. creates or updates the Node.js site at <account>.alwaysdata.net: Node 22, never idle, settings in the site's environment
//   5. restarts it, waits for /api/lp/healthz, then deletes the local copy of the key
// Usage, from the repository root:
//   pnpm build:web && pnpm boundary && node deploy/alwaysdata/build.mjs
//   node --no-warnings [--use-env-proxy] deploy/alwaysdata/deploy.mjs [--dry-run]   (--dry-run prints the site settings, checks the token, changes nothing)
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = process.env;
const dryRun = process.argv.includes('--dry-run');
const account = need('ALWAYSDATA_ACCOUNT');
const token = need('ALWAYSDATA_API_TOKEN');
if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(account)) fail(`ALWAYSDATA_ACCOUNT looks wrong: ${JSON.stringify(account)}`);
const host = `${account}.alwaysdata.net`;
const publicUrl = `https://${host}`;
const webdavBase = (env.ALWAYSDATA_WEBDAV_URL ?? `https://webdav-${account}.alwaysdata.net`).replace(/\/$/, '');
const app = resolve(dirname(fileURLToPath(import.meta.url)), 'out', 'app');
const remoteRoot = 'qf-launchpad';               // relative to the account's home
const home = `/home/${account}`;
const dataDir = `${home}/${remoteRoot}/data`;
const dbName = 'qf-launchpad-engine-devnet.sqlite';
const initDir = join(homedir(), '.qf-alwaysdata-init', account);
const proxyFlag = env.HTTPS_PROXY ? ['--use-env-proxy'] : [];

// RPC: Alchemy primary when present (largest free allowance), Helius second; the public endpoint otherwise
const rpc = [env.QF_ALCHEMY_API_KEY && `https://solana-devnet.g.alchemy.com/v2/${env.QF_ALCHEMY_API_KEY}`,
  env.QF_HELIUS_API_KEY && `https://devnet.helius-rpc.com/?api-key=${env.QF_HELIUS_API_KEY}`].filter(Boolean);
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

function need(k) { const v = env[k]?.trim(); if (!v) fail(`${k} is not set`); return v; }
function fail(m) { console.error(`deploy: ${m}`); process.exit(1); }
const say = (m) => console.log(`[deploy ${new Date().toISOString()}] ${m}`);
const redact = (s) => s.replace(/(api-key=|\/v2\/)[^"\s&]+/g, '$1<redacted>');

// ---------------------------------------------------------------- alwaysdata API
const auth = 'Basic ' + Buffer.from(`${token} account=${account}:`).toString('base64');
async function api(method, path, body) {
  const r = await fetch(`https://api.alwaysdata.com/v1${path}`, { method, headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${redact(text).slice(0, 300)}`);
  return { status: r.status, location: r.headers.get('location'), json: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}
const idFrom = (x) => Number(String(x?.href ?? x ?? '').match(/\/(\d+)\/?$/)?.[1]);

// ---------------------------------------------------------------- WebDAV
async function dav(method, path, user, pass, body, extra = {}) {
  const r = await fetch(`${webdavBase}/${path.split('/').map(encodeURIComponent).join('/')}`, { method, body,
    headers: { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'), ...extra } });
  return r;
}
async function upload(localDir, remoteDir, user, pass) {
  const files = [], dirs = new Set([remoteDir]);
  const walk = (d) => { for (const x of readdirSync(d)) { const p = join(d, x); if (statSync(p).isDirectory()) { dirs.add(`${remoteDir}/${relative(localDir, p)}`); walk(p); } else files.push(p); } };
  walk(localDir);
  for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    const parts = d.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      const r = await dav('MKCOL', sub, user, pass);
      if (![201, 405, 301].includes(r.status)) throw new Error(`MKCOL ${sub}: ${r.status}`);
    }
  }
  let done = 0;
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await dav('PUT', `${remoteDir}/${relative(localDir, f)}`, user, pass, readFileSync(f));
      if (![200, 201, 204].includes(r.status)) throw new Error(`PUT ${relative(localDir, f)}: ${r.status}`);
      if (++done % 100 === 0) say(`uploaded ${done}/${files.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  say(`uploaded ${files.length} files to ~/${remoteDir}`);
}

// ---------------------------------------------------------------- devnet
async function rpcCall(method, params) {
  const r = await fetch(rpc[0] ?? PUBLIC_DEVNET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const lamportsOf = async (a) => BigInt((await rpcCall('getBalance', [a, { commitment: 'confirmed' }])).value);
function runApp(cmd, extraEnv) {
  return execFileSync(process.execPath, [...proxyFlag, '--no-warnings', join(app, 'server.mjs'), cmd], { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { PATH: env.PATH, HOME: initDir, ...(env.HTTPS_PROXY ? { HTTPS_PROXY: env.HTTPS_PROXY, HTTP_PROXY: env.HTTP_PROXY ?? env.HTTPS_PROXY } : {}),
      ...(env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS } : {}),
      QF_DEVNET_KEY: join(initDir, 'operator.json'), QF_LP_DB: join(initDir, dbName), QF_PUBLIC_BASE_URL: publicUrl,
      ...(rpc[0] ? { QF_RPC_URL: rpc[0] } : {}), ...extraEnv } });
}

/** First deploy: a throwaway operator key, made here and uploaded to the site's data folder. */
async function initPlatform() {
  mkdirSync(initDir, { recursive: true, mode: 0o700 });
  chmodSync(initDir, 0o700);
  const { operator } = JSON.parse(runApp('operator').trim().split('\n').pop());
  say(`devnet operator (PUBLIC address): ${operator}`);
  let lamports = await lamportsOf(operator);
  if (lamports < 500_000_000n) {
    say('asking the devnet faucet for 1 SOL (test SOL, no value)');
    try { await rpcCall('requestAirdrop', [operator, 1_000_000_000]); } catch (e) { say(`faucet refused: ${e.message}`); }
    for (let i = 0; i < 12 && lamports < 500_000_000n; i++) { await new Promise((s) => setTimeout(s, 5000)); lamports = await lamportsOf(operator); }
  }
  if (lamports < 100_000_000n) {
    console.log(`\nThe operator needs devnet SOL before the launchpad can run its faucet and graduation crank. Send about 1 devnet SOL (free, no value) to\n  ${operator}\nfrom https://faucet.solana.com (choose Devnet), then run this again. The key stays in ${initDir} until then.`);
    process.exit(2);
  }
  const clean = join(initDir, 'upload');
  rmSync(clean, { recursive: true, force: true });
  mkdirSync(clean, { mode: 0o700 });
  // no store to upload: the site makes its store on first start and reads every coin on the engine from the chain
  execFileSync('cp', [join(initDir, 'operator.json'), join(clean, 'operator.json')]);
  return { clean, operator };
}

// ---------------------------------------------------------------- main
if (!existsSync(join(app, 'server.mjs'))) fail('deploy/alwaysdata/out/app is missing: run `node deploy/alwaysdata/build.mjs` first');
const build = JSON.parse(readFileSync(join(app, 'BUILD.json'), 'utf8'));
say(`account ${account}, build ${build.commit}, ${build.files.length} files, RPC ${rpc.length ? (env.QF_ALCHEMY_API_KEY ? 'Alchemy' : 'Helius') : 'public devnet endpoint'}`);

const environment = Object.entries({
  QF_LP_DB: `${dataDir}/${dbName}`, QF_DEVNET_KEY: `${dataDir}/operator.json`,
  QF_LP_HOST: '::', QF_LP_PORT: '8100', QF_STATIC_DIR: `${home}/${remoteRoot}/app/web`, QF_PUBLIC_BASE_URL: publicUrl,
  QF_LP_INTERVAL_MS: '30000', ...(rpc[0] ? { QF_RPC_URL: rpc[0] } : {}),
}).map(([k, v]) => `${k}=${/[\s"'?&=]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v}`).join(' ');
const site = { type: 'nodejs', name: 'qf-launchpad-devnet', addresses: [host], working_directory: remoteRoot,
  command: 'node --max-old-space-size=160 --no-warnings app/server.mjs serve', nodejs_version: '22', environment, max_idle_time: 0, ssl_force: true };
if (dryRun) console.log(JSON.stringify({ dryRun: true, site: { ...site, environment: redact(environment) }, webdav: webdavBase, publicUrl }, null, 1));
const acc = await api('GET', '/account/').catch((e) => fail(`the alwaysdata token or account name was not accepted (${e.message})`));
say(`token works (${Array.isArray(acc.json) ? acc.json.length : 1} account(s) visible)`);
if (dryRun) process.exit(0);

// a temporary WebDAV user, deleted at the end
const davUser = `${account}_qfdeploy`, davPass = randomBytes(24).toString('base64url');
for (const u of (await api('GET', '/webdav/')).json ?? []) if (u.name === davUser) await api('DELETE', `/webdav/${idFrom(u)}/`);
const created = await api('POST', '/webdav/', { name: davUser, password: davPass, path: '/' });
const davId = idFrom(created.location) || idFrom((await api('GET', '/webdav/')).json.find((u) => u.name === davUser));
let init = null;
try {
  // first deploy: no operator key on the site yet
  const first = (await dav('PROPFIND', `${remoteRoot}/data/operator.json`, davUser, davPass, undefined, { depth: '0' })).status === 404;
  if (first) init = await initPlatform();
  await upload(app, `${remoteRoot}/app`, davUser, davPass);
  if (init) await upload(init.clean, `${remoteRoot}/data`, davUser, davPass);
} finally {
  if (davId) await api('DELETE', `/webdav/${davId}/`).catch((e) => say(`could not delete the temporary WebDAV user ${davUser}: ${e.message}`));
}

// the site: the account's default site at <account>.alwaysdata.net becomes the launchpad
const sites = (await api('GET', '/site/')).json ?? [];
const existing = sites.find((s) => (s.addresses ?? []).some((a) => (a.address ?? a) === host || String(a).includes(host)));
let siteId = existing ? idFrom(existing) : null;
if (siteId) { await api('PATCH', `/site/${siteId}/`, site); say(`updated site ${siteId}`); }
else { const r = await api('POST', '/site/', site); siteId = idFrom(r.location); say(`created site ${siteId}`); }
await api('POST', `/site/${siteId}/restart/`).catch((e) => say(`restart: ${e.message} (a new site starts on its first request)`));

let ok = false;
for (let i = 0; i < 36 && !ok; i++) {
  await new Promise((s) => setTimeout(s, 5000));
  ok = await fetch(`${publicUrl}/api/lp/healthz`).then(async (r) => r.ok && (await r.json()).ok === true).catch(() => false);
}
if (!ok) fail(`${publicUrl}/api/lp/healthz did not answer ok within 3 minutes; check the site's log in the alwaysdata admin (Logs)`);
const platform = await fetch(`${publicUrl}/api/lp/platform`).then((r) => r.json()).catch(() => null);
say(`live: ${publicUrl} (${platform?.mode ?? '?'}; launching ${platform?.writesEnabled ? 'on' : 'off'})`);
if (init) { rmSync(initDir, { recursive: true, force: true }); say(`deleted the local copy of the operator key (${initDir}); the site's copy is in ~/${remoteRoot}/data`); }
