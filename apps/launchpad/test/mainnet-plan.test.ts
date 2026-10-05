// The mainnet setup plan: what it builds, that it can never be signed or landed, that the config is bound to the treasury
// vault and USDC, and that it only reads. TEST_ONLY: provider doubles; the Squads program config bytes are a copy of the
// public mainnet account BSTq9w3k…cNZr read at finalized, slot 453699155 (no network in tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTransactionBytes } from '@project-qf/tx';
import { PLACEHOLDERS, placeholder } from '@project-qf/adapter-meteora-dbc/mainnet-plan';
import { USDC_MAINNET, readOnlyConnection } from '@project-qf/adapter-meteora-dbc/launchpad';
import { buildMainnetSetupPlan, renderPlanMarkdown, validatePlanOptions } from '../src/mainnet-plan.ts';

const SQUADS_PROGRAM_CONFIG = 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr';
const PROGRAM_CONFIG_DATA = Buffer.from('xNJa55CVjD92Raz2HiWPdZHPcd7iP2i7V0ot8H6/wFdsT5Tc2zbKegAAAAAAAAAAPpPXMsRIJCeQ0tu1MaQKvRnxbFXjEyz/UnetydaTq1oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'base64');
const SQUADS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

/** A provider double that answers only the two reads the plan makes and records every method called. */
function provider(opts: { slot?: number; data?: Buffer; rentPerByte?: number } = {}) {
  const calls: string[] = [];
  const target = {
    getMultipleAccountsInfoAndContext: async (keys: { toBase58(): string }[]) => {
      calls.push('getMultipleAccountsInfoAndContext');
      return { context: { slot: opts.slot ?? 453699155 }, value: keys.map((k) => (k.toBase58() === SQUADS_PROGRAM_CONFIG
        ? { owner: { toBase58: () => SQUADS }, executable: false, data: opts.data ?? PROGRAM_CONFIG_DATA, lamports: 1 } : null)) };
    },
    getMinimumBalanceForRentExemption: async (bytes: number) => { calls.push('getMinimumBalanceForRentExemption'); return (128 + bytes) * (opts.rentPerByte ?? 5080); },
    sendRawTransaction: async () => { calls.push('sendRawTransaction'); return 'sent'; },
    simulateTransaction: async () => { calls.push('simulateTransaction'); return {}; },
  };
  return { conn: readOnlyConnection(target as never), calls };
}
const opts = { members: null, threshold: 2, timeLockSeconds: 0, graduationUsd: '5000', now: new Date('2026-10-05T21:30:00Z') };

test('the plan builds the treasury multisig and the USDC config paying the vault, and every check passes', async () => {
  const a = provider(), b = provider();
  const p = await buildMainnetSetupPlan(a.conn, b.conn, opts);
  assert.equal(p.status, 'PLAN_ONLY');
  assert.equal(p.signable, false);
  assert.equal(p.ok, true, JSON.stringify(p.transactions.checks.filter((c) => !c.ok)));
  const t = p.transactions;
  assert.equal(t.config.feeClaimer, t.multisig.vault);
  assert.equal(t.config.leftoverReceiver, t.multisig.vault);
  assert.equal(t.config.quoteMint, USDC_MAINNET.mint);
  assert.deepEqual(t.config.bindingViolations, []);
  assert.equal(t.config.instruction, 'createConfig');
  assert.equal(t.squadsProgramConfig.status, 'MATCH');
  assert.equal(t.multisig.squadsTreasury, '5DH2e3cJmFpyi6mk65EGFediunm4ui6BiKNUNrhWtD1b');
  assert.deepEqual(t.members.map((m) => m.placeholder), [true, true, true]);
  // the economics are labelled as test economics and the graduation target as a par assumption
  assert.equal(p.economics.approvedForProduction, false);
  assert.equal(p.economics.usage, 'V0_TEST');
  assert.equal(p.graduation.evidence, 'PLAN_ONLY_PAR_ASSUMPTION');
  assert.equal(p.graduation.rawQuoteThreshold, '5000000000');
  assert.equal((t.config.args as { configParameters: { migrationQuoteThreshold: string } }).configParameters.migrationQuoteThreshold, '5000000000');
  // costs: creation fee 0 (from the mainnet program config), rent for 231 + 1048 bytes, 4 signatures
  assert.equal(p.totalLamports, String(0 + (128 + 231) * 5080 + (128 + 1048) * 5080 + 20000));
  assert.match(renderPlanMarkdown(p), /PLAN ONLY, not signable/);
});

test('neither transaction can be signed or land: every signer and the blockhash are placeholders', async () => {
  const p = await buildMainnetSetupPlan(provider().conn, provider().conn, opts);
  const holders = new Set([PLACEHOLDERS.payer, PLACEHOLDERS.createKey, PLACEHOLDERS.config]);
  for (const x of [p.transactions.multisig, p.transactions.config]) {
    const d = decodeTransactionBytes(Buffer.from(x.transactionBase64, 'base64'));
    assert.equal(d.feePayer, PLACEHOLDERS.payer);
    assert.ok(d.signers.length === 2 && d.signers.every((s) => holders.has(s)), d.signers.join());
    assert.equal(d.lifetimeToken, PLACEHOLDERS.blockhash);
  }
  assert.equal(PLACEHOLDERS.payer, placeholder('payer'));
});

test('the plan only reads: no send or simulate is ever called, and a read-only connection would refuse one anyway', async () => {
  const a = provider(), b = provider();
  await buildMainnetSetupPlan(a.conn, b.conn, opts);
  for (const c of [a.calls, b.calls]) assert.deepEqual([...new Set(c)].sort(), ['getMinimumBalanceForRentExemption', 'getMultipleAccountsInfoAndContext']);
  await assert.rejects(() => (a.conn as unknown as { sendRawTransaction(): Promise<string> }).sendRawTransaction(), /WRITES_LOCKED/);
  assert.ok(!a.calls.includes('sendRawTransaction'));
});

test('real member keys go into the multisig exactly; providers that disagree make the plan fail', async () => {
  const members = ['alice', 'bob', 'carol'].map((n) => placeholder(`test-member-${n}`));
  const p = await buildMainnetSetupPlan(provider().conn, provider().conn, { ...opts, members });
  assert.equal(p.inputs.members, 'OWNER_PROVIDED');
  assert.deepEqual((p.transactions.multisig.args as { members: { key: string }[] }).members.map((m) => m.key), members);
  assert.equal(p.ok, true);
  // a member that is also a placeholder signer (the payer) fails the plan
  const clash = await buildMainnetSetupPlan(provider().conn, provider().conn, { ...opts, members: [PLACEHOLDERS.payer, members[1]!, members[2]!] });
  assert.equal(clash.transactions.checks.find((c) => c.id === 'MEMBERS_NOT_PLACEHOLDER_SIGNERS')?.ok, false);
  assert.equal(clash.ok, false);
  const other = Buffer.from(PROGRAM_CONFIG_DATA); other[40] = 9; // provider B reports a different creation fee (u64 at byte 40)
  const bad = await buildMainnetSetupPlan(provider().conn, provider({ data: other }).conn, opts);
  assert.equal(bad.ok, false);
  assert.equal(bad.transactions.squadsProgramConfig.status, 'MISMATCH');
  assert.equal(bad.transactions.checks.find((c) => c.id === 'SQUADS_PROGRAM_CONFIG')?.ok, false);
});

test('plan options: at least 2 approvals, no more than the members, distinct members, a policy-bound graduation target', () => {
  assert.deepEqual(validatePlanOptions(opts), []);
  assert.match(validatePlanOptions({ ...opts, threshold: 1 }).join(), /threshold/);
  assert.match(validatePlanOptions({ ...opts, threshold: 4 }).join(), /threshold/);
  assert.match(validatePlanOptions({ ...opts, members: [PLACEHOLDERS.payer, PLACEHOLDERS.payer, PLACEHOLDERS.config] }).join(), /distinct/);
  assert.match(validatePlanOptions({ ...opts, graduationUsd: '999' }).join(), /graduation target must be within/);
  assert.match(validatePlanOptions({ ...opts, graduationUsd: '5000.5' }).join(), /whole number/);
  assert.match(validatePlanOptions({ ...opts, timeLockSeconds: -1 }).join(), /time lock/);
});
