// The mainnet setup plan, for review before the owner's mainnet gate (DEPLOYMENT.md §2 and §3). It shows exactly what
// would be created on mainnet so the platform config is owned by the multisig from day one: the treasury multisig
// (FEE_CLAIMER role) and the DBC config with USDC as the quote token, paying platform fees and leftovers to its vault.
// PLAN ONLY: both transactions are built with placeholder signers and a placeholder blockhash, so they can be read and
// checked but never signed or sent (packages/adapter-meteora-dbc/src/mainnet-plan.ts). The economics are the V0_TEST
// objects, which are not approved for production; the graduation target uses USDC at par without live price evidence.
import { CAPABILITY_FLAGS, READINESS } from '@project-qf/core';
import {
  ECONOMICS_V0_TEST, MIGRATION_POLICY_V0, STANDARD_V1_FLAT_V0_TEST, proposeMigrationThreshold, validateCurveTemplate, validateEconomics,
  type MigrationThresholdRecord,
} from '@project-qf/policy';
import { EVIDENCE_POLICY_V0_1 } from '@project-qf/validator';
import { buildCurveConfig } from '@project-qf/adapter-meteora-dbc';
import { buildMainnetSetupTransactions, type MainnetSetupTransactions } from '@project-qf/adapter-meteora-dbc/mainnet-plan';
import type { DevnetConnection as Connection } from '@project-qf/adapter-meteora-dbc/launchpad';
import { USDC_MAINNET } from '@project-qf/adapter-meteora-dbc/launchpad';

/** Solana base fee per signature; each setup transaction has two signers (payer plus create key or config account). */
const LAMPORTS_PER_SIGNATURE = 5000n;

export interface PlanOptions { members: string[] | null; threshold: number; timeLockSeconds: number; graduationUsd: string; now?: Date }
export interface OwnerDecision { id: string; question: string; planUses: string; note: string }
export interface MainnetSetupPlan {
  domain: 'QF-MAINNET-SETUP-PLAN';
  status: 'PLAN_ONLY';
  signable: false;
  generatedAt: string;
  cluster: 'mainnet-beta';
  notice: string[];
  gate: { mainnetReadiness: string; mainnetWrites: boolean; openItems: readonly string[] };
  inputs: { members: 'PLACEHOLDER' | 'OWNER_PROVIDED'; memberCount: number; threshold: number; timeLockSeconds: number; graduationUsd: string };
  economics: { version: string; usage: string; approvedForProduction: false; template: string; summary: Record<string, string> };
  graduation: MigrationThresholdRecord & { evidence: 'PLAN_ONLY_PAR_ASSUMPTION' };
  costs: { item: string; lamports: string | null }[];
  totalLamports: string | null;
  transactions: MainnetSetupTransactions;
  ok: boolean;
  ownerDecisions: OwnerDecision[];
  afterExecution: string[];
}

export function validatePlanOptions(o: PlanOptions): string[] {
  const v: string[] = [];
  const n = o.members?.length ?? 3;
  if (o.members && new Set(o.members).size !== o.members.length) v.push('members must be distinct');
  if (n < 2 || n > 10) v.push('between 2 and 10 members');
  if (!Number.isInteger(o.threshold) || o.threshold < 2 || o.threshold > n) v.push(`threshold must be an integer from 2 to ${n}`);
  if (!Number.isInteger(o.timeLockSeconds) || o.timeLockSeconds < 0 || o.timeLockSeconds > 90 * 86400) v.push('time lock must be 0 to 90 days, in whole seconds');
  if (!/^[1-9]\d*$/.test(o.graduationUsd)) v.push('graduation target must be a whole number of USD');
  else if (BigInt(o.graduationUsd) < BigInt(MIGRATION_POLICY_V0.floorUsd) || BigInt(o.graduationUsd) > BigInt(MIGRATION_POLICY_V0.ceilUsd)) v.push(`graduation target must be within the migration policy's ${MIGRATION_POLICY_V0.floorUsd} to ${MIGRATION_POLICY_V0.ceilUsd} USD`);
  return v;
}

/** USDC at par, labelled as an assumption: the real record is made at execution from live price and liquidity evidence. */
export function planGraduation(graduationUsd: string, now: Date): MigrationThresholdRecord {
  const at = now.toISOString();
  const r = proposeMigrationThreshold({
    policy: MIGRATION_POLICY_V0, evidencePolicy: EVIDENCE_POLICY_V0_1, now: at, requestedUsd: graduationUsd,
    quote: { mint: USDC_MAINNET.mint, decimals: USDC_MAINNET.decimals },
    price: { status: 'OK', priceUsd: '1', sources: ['plan-only:usdc-par-assumption-a', 'plan-only:usdc-par-assumption-b'], observedAt: at },
    liquidity: { id: 'S3.2', decision: 'PASS', reason: 'PLAN_ONLY: USDC liquidity not measured for this plan', evidence: [], details: { eligibleUsd: '1000000000' }, policyVersion: 'validator-v0.1' },
    exitDepth: { id: 'S3.1', decision: 'PASS', reason: 'PLAN_ONLY: exit depth not measured for this plan', evidence: [], details: { notionalRaw: (10n ** 18n).toString() }, policyVersion: 'validator-v0.1' },
  } as never);
  if (r.status !== 'OK' || !r.record) throw new Error(`graduation target ${r.status}: ${r.reasons.join('; ')}`);
  return r.record;
}

export async function buildMainnetSetupPlan(a: Connection, b: Connection | null, o: PlanOptions): Promise<MainnetSetupPlan> {
  const bad = validatePlanOptions(o);
  if (bad.length) throw new Error(`PLAN_BAD_OPTIONS ${bad.join('; ')}`);
  const now = o.now ?? new Date();
  const e = ECONOMICS_V0_TEST, t = STANDARD_V1_FLAT_V0_TEST;
  const pv = [...validateEconomics(e), ...validateCurveTemplate(t, e)];
  if (pv.length) throw new Error(`PLAN_POLICY_INVALID ${pv.join('; ')}`);
  const graduation = planGraduation(o.graduationUsd, now);
  const params = buildCurveConfig(t, e, graduation);
  const memberCount = o.members?.length ?? 3;
  const transactions = await buildMainnetSetupTransactions(a, b, { members: o.members, memberCount, threshold: o.threshold, timeLockSeconds: o.timeLockSeconds,
    quote: { mint: USDC_MAINNET.mint, decimals: USDC_MAINNET.decimals }, params });

  const ms = transactions.multisig, cfg = transactions.config;
  const fees = 4n * LAMPORTS_PER_SIGNATURE;
  const costs = [
    { item: 'Squads multisig creation fee (from its program config on mainnet)', lamports: ms.creationFeeLamports },
    { item: `rent for the multisig account (${ms.rent.accountBytes} bytes; ${ms.rent.providers})`, lamports: ms.rent.lamports },
    { item: `rent for the DBC config account (${cfg.rent.accountBytes} bytes; ${cfg.rent.providers})`, lamports: cfg.rent.lamports },
    { item: 'network fees (2 transactions x 2 signatures x 5,000 lamports; no priority fee)', lamports: fees.toString() },
  ];
  const totalLamports = costs.every((c) => c.lamports !== null) ? costs.reduce((s, c) => s + BigInt(c.lamports!), 0n).toString() : null;
  const pct = (n: number) => `${n}%`;
  return {
    domain: 'QF-MAINNET-SETUP-PLAN', status: 'PLAN_ONLY', signable: false, generatedAt: now.toISOString(), cluster: 'mainnet-beta',
    notice: [
      'PLAN ONLY. Nothing here was signed, simulated or sent, and nothing can be: the payer, the multisig create key, the config account and the blockhash are placeholders no one holds a key for.',
      `The economics are ${e.version} (usage ${e.usage}), the devnet test economics. They are not approved for production (DEPLOYMENT.md §2 item 6).`,
      'The graduation target assumes USDC at $1.00 with no live price or liquidity evidence. At execution the record is made again from live evidence.',
      o.members ? 'Members are the public keys given to the plan command.' : 'Members are placeholders: the owner has not named the real signers yet (TRE-1).',
    ],
    gate: { mainnetReadiness: READINESS.MAINNET.status, mainnetWrites: CAPABILITY_FLAGS.MAINNET_WRITES as boolean, openItems: READINESS.MAINNET.blockers },
    inputs: { members: o.members ? 'OWNER_PROVIDED' : 'PLACEHOLDER', memberCount, threshold: o.threshold, timeLockSeconds: o.timeLockSeconds, graduationUsd: o.graduationUsd },
    economics: { version: e.version, usage: e.usage, approvedForProduction: false, template: t.version, summary: {
      'trading fee on the curve': `${e.baseFeeBps / 100}% of each trade (flat; dynamic fee off)`,
      "Meteora's protocol share": '20% of that fee, set by the DBC program (observed on every devnet trade)',
      'creator share of the rest': pct(e.creatorTradingFeePct),
      'platform share of the rest': `${pct(100 - e.creatorTradingFeePct)}, to the treasury vault`,
      'platform share split (revenue / holder rewards)': `${e.partnerRevenueSplitPct} / ${e.partnerRewardsSplitPct} (policy only: holder rewards are not built for mainnet)`,
      'fee collected in': 'the quote token (USDC)',
      'graduated DAMM v2 pool fee': `${e.migratedPoolFeeBps / 100}%`,
      'LP after graduation': `platform ${e.lp.partnerPermanentLockedPct}% and creator ${e.lp.creatorPermanentLockedPct}%, both permanently locked (fees claimable, principal not)`,
      'migration fee taken by the platform': pct(e.migrationExtractionFeePct),
      'pool creation fee charged to creators': `${e.poolCreationFeeLamports} lamports`,
      'token mint and update authority after launch': e.tokenAuthorityOption,
      'token supply': `${t.token.totalTokenSupply} (6 decimals), ${t.percentageSupplyOnMigration}% of supply moves to DAMM v2 at graduation`,
    } },
    graduation: { ...graduation, evidence: 'PLAN_ONLY_PAR_ASSUMPTION' },
    costs, totalLamports, transactions,
    ok: transactions.checks.every((c) => c.ok),
    ownerDecisions: [
      { id: 'TRE-1 members', question: 'Who are the treasury signers?', planUses: o.members ? `${memberCount} provided keys` : '3 placeholders',
        note: 'Three different people, each on a hardware wallet (DEPLOYMENT.md §2 item 5). No signer may be the server, the payer or a hot wallet.' },
      { id: 'TRE-1 threshold', question: 'How many approvals move money?', planUses: `${o.threshold} of ${memberCount}`,
        note: 'The policy says 2-of-3. With 3-of-3, one lost device locks the treasury for good.' },
      { id: 'TRE-1 time lock', question: 'Should approved proposals wait before they can run?', planUses: `${o.timeLockSeconds} seconds`,
        note: 'A time lock (for example 24 hours) gives signers a window to cancel a bad proposal, and delays every fee claim by the same amount.' },
      { id: 'ECON', question: 'Which fees go live?', planUses: `${e.version} (test economics)`,
        note: 'Production economics and curve template need approval with a simulation report (DEPLOYMENT.md §2 item 6). A config cannot be changed after it is created; new economics mean a new config.' },
      { id: 'GRAD', question: 'At how many USDC does a coin graduate to DAMM v2?', planUses: `${o.graduationUsd} USDC`,
        note: `The migration policy allows ${MIGRATION_POLICY_V0.floorUsd} to ${MIGRATION_POLICY_V0.ceilUsd} USD; ${MIGRATION_POLICY_V0.targetUsd} is its standard default.` },
      { id: 'PAYER', question: 'Which wallet pays for setup?', planUses: 'placeholder',
        note: `A funded wallet with about ${totalLamports ? (Number(totalLamports) / 1e9).toFixed(4) : '?'} SOL. It gets no rights over the treasury or the config.` },
    ],
    afterExecution: [
      'Read the multisig back at finalized from two providers: members, threshold, time lock, config authority none.',
      'Read the DBC config back at finalized from two providers and decode it: fee claimer and leftover receiver are the vault, quote mint is USDC, every parameter equals the approved digest (DEPLOYMENT.md §3, verifier parity).',
      'Record the config in the registry as active only after both read-backs match.',
      'Run program-verify on mainnet with two RPCs and set up upgrade alerting (DEPLOYMENT.md §2 item 2).',
    ],
  };
}

const lamportsToSol = (l: string | null) => (l === null ? 'not known' : `${(Number(l) / 1e9).toFixed(6)} SOL`);

/** A plain-language rendering for the owner and reviewers. Shortened addresses only where the full one is in the JSON. */
export function renderPlanMarkdown(p: MainnetSetupPlan): string {
  const t = p.transactions;
  const lines: string[] = [];
  lines.push('# Mainnet setup plan (PLAN ONLY, not signable)', '', `Generated ${p.generatedAt} from real mainnet reads. Mainnet readiness: ${p.gate.mainnetReadiness}. MAINNET_WRITES: ${p.gate.mainnetWrites}.`, '');
  for (const n of p.notice) lines.push(`- ${n}`);
  lines.push('', '## What would be created', '');
  lines.push(`1. **${t.multisig.title}.** Multisig \`${t.multisig.multisig}\`, vault \`${t.multisig.vault}\`. These addresses come from the placeholder create key, so the real ones will differ.`);
  lines.push(`2. **${t.config.title}.** Fee claimer and leftover receiver: the vault above. Quote: USDC \`${t.config.quoteMint}\`.`);
  lines.push('', '## Treasury members', '', '| # | Address | Placeholder |', '|---|---|---|');
  t.members.forEach((m, k) => lines.push(`| ${k + 1} | \`${m.address}\` | ${m.placeholder ? 'yes' : 'no'} |`));
  lines.push('', `Approvals needed: **${p.inputs.threshold} of ${p.inputs.memberCount}**. Time lock: **${p.inputs.timeLockSeconds} s**. Config authority: **none**. Every member can propose, approve and execute.`);
  lines.push('', '## Economics in this plan (test economics, not approved for production)', '', '| Item | Value |', '|---|---|');
  for (const [k, v] of Object.entries(p.economics.summary)) lines.push(`| ${k} | ${v} |`);
  lines.push(`| graduation target | ${p.inputs.graduationUsd} USDC = ${p.graduation.rawQuoteThreshold} raw (USDC at par; plan assumption) |`);
  lines.push('', '## Cost to set up', '', '| Item | Amount |', '|---|---|');
  for (const c of p.costs) lines.push(`| ${c.item} | ${lamportsToSol(c.lamports)} |`);
  lines.push(`| **total** | **${lamportsToSol(p.totalLamports)}** |`);
  lines.push('', '## Checks on what was built', '', '| Check | Result | Detail |', '|---|---|---|');
  for (const c of t.checks) lines.push(`| ${c.id} | ${c.ok ? 'PASS' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`);
  lines.push('', '## Decisions only the owner can make', '', '| Item | Question | This plan uses | Note |', '|---|---|---|---|');
  for (const d of p.ownerDecisions) lines.push(`| ${d.id} | ${d.question} | ${d.planUses} | ${d.note} |`);
  lines.push('', '## After the real run', '');
  p.afterExecution.forEach((s, k) => lines.push(`${k + 1}. ${s}`));
  lines.push('', '## Transactions (unsigned; read them independently)', '');
  for (const x of [t.multisig, t.config]) {
    lines.push(`### ${x.title}`, '', `Program \`${x.program}\`, instruction \`${x.instruction}\`. Required signers (all placeholders): ${x.requiredSigners.map((s) => `\`${s}\``).join(', ')}.`, '');
    lines.push('| Account | Address | Signer | Writable |', '|---|---|---|---|');
    for (const acc of x.accounts) lines.push(`| ${acc.name} | \`${acc.address}\` | ${acc.signer ? 'yes' : ''} | ${acc.writable ? 'yes' : ''} |`);
    lines.push('', 'Message (base64; paste into a Solana transaction inspector to decode it yourself):', '', '```', x.messageBase64, '```', '');
  }
  lines.push('The full decoded arguments, the QF binding terms and the open mainnet items are in the JSON next to this file.');
  return lines.join('\n') + '\n';
}
