// Treasury member signer (devnet stand-in for three people's own wallets). It runs as its own process and is the only
// code that loads a member key; the launchpad server never does. Before signing anything it checks, with its own RPC
// connection and the same packages/tx binding the server uses:
//   - the multisig is the one this member pinned (and the vault is that multisig's vault);
//   - the unsigned transaction binds exactly to its terms (Squads instructions, accounts, signers, writable set);
//   - the claim inside is a platform fee claim paid to the vault and nothing else;
//   - for approve and execute, the VaultTransaction the program STORED (read here from chain, not from the server) is
//     that same claim. A server that lied about a proposal cannot get a member to approve or run something else.
//
//   node --use-env-proxy src/member.ts init                               creates member-1..3 keys (throwaway, devnet) and prints their PUBLIC keys
//   node --use-env-proxy src/member.ts pin <multisig>                     checks the multisig on chain and pins it for these members
//   node --use-env-proxy src/member.ts status                             the treasury as the server reports it
//   node --use-env-proxy src/member.ts propose <n> <mint> curve|damm [nftMint]   member n proposes (and approves) a platform fee claim
//   node --use-env-proxy src/member.ts approve <n> <index>                member n approves proposal <index>
//   node --use-env-proxy src/member.ts execute <n> <index>                member n runs an approved proposal
// Environment: QF_TREASURY_DIR (default ~/.qf-devnet/treasury; outside any git checkout, files mode 0600), QF_LP_URL
// (default http://127.0.0.1:8788), QF_RPC_DEVNET (default the public devnet endpoint).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectDevnet, loadOrCreateDevnetKeypair, publicKeyOf, type DevnetSigner } from '@project-qf/adapter-meteora-dbc/launchpad';
import { readProposal, readTreasury, readVaultTransactionAccount, signAsMember } from '@project-qf/adapter-meteora-dbc/treasury';
import {
  bindStoredVaultTransaction, bindTransactionToTerms, decodeTransactionBytes, fromBase64, squads, toBase64, validateTerms,
  type ApprovedTerms, type TreasuryInnerTerms,
} from '@project-qf/tx';

const env = process.env;
const dir = env.QF_TREASURY_DIR ?? join(homedir(), '.qf-devnet', 'treasury');
const base = (env.QF_LP_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
const pinFile = join(dir, 'treasury.json');
const [cmd, ...args] = process.argv.slice(2);
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
const fail = (m: string, details?: unknown): never => { console.error(`REFUSED: ${m}`); if (details) out(details); process.exit(2); };

const memberKey = (n: string): DevnetSigner => {
  if (!/^[123]$/.test(n)) fail('member must be 1, 2 or 3');
  const p = join(dir, `member-${n}.json`);
  if (cmd !== 'init' && !existsSync(p)) fail(`no key for member ${n}; run init first`);
  return loadOrCreateDevnetKeypair(p);
};
const pinned = (): { multisig: string; vault: string } => {
  if (!existsSync(pinFile)) fail('no treasury pinned; run pin <multisig> first');
  return JSON.parse(readFileSync(pinFile, 'utf8')) as { multisig: string; vault: string };
};
async function api(path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json() as Record<string, unknown> & { error?: { code: string; message: string; details?: string[] } };
  if (!r.ok) fail(`server answered ${r.status} ${j.error?.code}: ${j.error?.message}`, j.error?.details);
  return j;
}

/** The claim inside must pay the pinned vault only (the same rule the binding applies to treasury terms). */
function checkClaimTerms(t: { multisig: string; vault: string }, inner: TreasuryInnerTerms, member: string, index: string) {
  const v = validateTerms({ kind: 'TREASURY_EXECUTE', cluster: inner.cluster, policyVersion: inner.policyVersion, feePayer: member, compute: inner.compute,
    multisig: t.multisig, transactionIndex: index, vault: t.vault, vaultIndex: 0, member, inner } satisfies ApprovedTerms);
  if (v.length) fail('the claim inside this proposal is not a platform fee claim paid to the treasury vault', v);
}

async function checkAndSign(kp: DevnetSigner, built: Record<string, unknown>, ctx: { stored?: Uint8Array } = {}) {
  const t = pinned();
  const terms = built.terms as ApprovedTerms;
  if (!terms.kind.startsWith('TREASURY_')) fail(`not a treasury transaction (${terms.kind})`);
  const tt = terms as Extract<ApprovedTerms, { kind: `TREASURY_${string}` }>;
  if (tt.multisig !== t.multisig) fail(`multisig ${tt.multisig} is not the pinned treasury ${t.multisig}`);
  if ('vault' in tt && tt.vault !== t.vault) fail('vault is not the pinned treasury vault');
  const me = publicKeyOf(kp);
  if (terms.feePayer !== me) fail('this member is not the fee payer of the transaction it was asked to sign');
  const bytes = fromBase64(String(built.transaction));
  const v = await bindTransactionToTerms(decodeTransactionBytes(bytes), terms, ctx.stored ? { vaultTransactionAccount: ctx.stored } : {});
  if (v.length) fail('the transaction does not bind to its terms', v);
  const signed = await signAsMember(bytes, kp);
  return api('/api/lp/submit', { intentId: built.intentId, signedTransaction: toBase64(signed) });
}

const conn = cmd === 'init' ? null : await connectDevnet(env.QF_RPC_DEVNET ?? 'https://api.devnet.solana.com');

if (cmd === 'init') {
  out({ members: ['1', '2', '3'].map((n) => publicKeyOf(memberKey(n))), keysIn: dir, label: 'DEVNET_STAND_IN throwaway member keys' });
} else if (cmd === 'pin') {
  const multisig = args[0] ?? fail('usage: pin <multisig>');
  const st = await readTreasury(conn!, multisig);
  const mine = ['1', '2', '3'].map((n) => publicKeyOf(memberKey(n)));
  if (!mine.every((k) => st.members.some((m) => m.key === k)) || st.members.length !== 3) fail('the multisig members are not exactly these three keys', st.members);
  if (st.threshold !== 2 || st.configAuthority !== null || st.timeLock !== 0) fail('the multisig is not the 2-of-3 stand-in (threshold 2, no config authority, no time lock)', st);
  writeFileSync(pinFile, JSON.stringify({ multisig, vault: st.vault }, null, 2), { mode: 0o600 });
  out({ pinned: multisig, vault: st.vault, threshold: st.threshold, members: st.members.map((m) => m.key) });
} else if (cmd === 'status') {
  out(await api('/api/lp/treasury'));
} else if (cmd === 'propose') {
  const [n, mint, venue, nftMint] = args;
  const kp = memberKey(n ?? '');
  const built = await api('/api/lp/treasury/propose', { mint, venue, member: publicKeyOf(kp), ...(nftMint ? { nftMint } : {}) });
  const terms = built.terms as Extract<ApprovedTerms, { kind: 'TREASURY_PROPOSE' }>;
  checkClaimTerms(pinned(), terms.inner, publicKeyOf(kp), terms.transactionIndex);
  out({ proposing: { transactionIndex: built.transactionIndex, claim: terms.inner.kind, pool: terms.inner.pool, amounts: built.amounts, paidTo: pinned().vault }, result: await checkAndSign(kp, built) });
} else if (cmd === 'approve' || cmd === 'execute') {
  const [n, index] = args;
  const kp = memberKey(n ?? '');
  if (!index || !/^[1-9]\d{0,18}$/.test(index)) fail('usage: approve|execute <member> <index>');
  const t = pinned();
  const built = await api(`/api/lp/treasury/${cmd}`, { transactionIndex: index, member: publicKeyOf(kp) });
  const inner = built.inner as TreasuryInnerTerms;
  checkClaimTerms(t, inner, publicKeyOf(kp), index!);
  // what the program stored is what an approval approves and an execution runs: read it here, bind it here
  const stored = await readVaultTransactionAccount(conn!, t.multisig, index!) ?? fail('the proposal has no stored vault transaction on chain');
  const chk = await bindStoredVaultTransaction(stored, { multisig: t.multisig, transactionIndex: index!, vaultIndex: 0, inner });
  if (chk.violations.length) fail('the transaction stored on chain is not the claim described', chk.violations);
  const onChain = await readProposal(conn!, t.multisig, index!);
  const msg = squads.decodeVaultTransactionAccount(stored);
  out({ [cmd === 'approve' ? 'approving' : 'executing']: { transactionIndex: index, claim: inner.kind, pool: inner.pool, storedBy: msg.creator, proposal: onChain },
    result: await checkAndSign(kp, built, cmd === 'execute' ? { stored } : {}) });
} else {
  console.error('usage: member.ts init | pin <multisig> | status | propose <n> <mint> curve|damm [nftMint] | approve <n> <index> | execute <n> <index>');
  process.exitCode = 64;
}
