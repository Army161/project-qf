// SERVER-ONLY. The mainnet setup plan: the two transactions that would create the real platform treasury (a Squads v4
// multisig) and the mainnet DBC config whose fee claimer and leftover receiver is that treasury's vault, so platform fees
// belong to the multisig from the first coin. Built for review only. Nothing here signs, simulates or sends:
//   - the fee payer, the multisig create key and the config account are PLACEHOLDERS: 32 bytes from a hash, so no one
//     holds a private key for them and neither transaction can be signed;
//   - the recent blockhash is a placeholder too, so a signed copy could not land either;
//   - the only RPC calls are reads (Squads program config, rent) at finalized, through the read-only connection.
// Running it for real is a reviewed code change after the owner's mainnet gate (DEPLOYMENT.md §2), with real members,
// a real payer and production economics.
import { createHash } from 'node:crypto';
import * as sq from '@sqds/multisig';
import { DynamicBondingCurveClient, type ConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  PROGRAM_IDS, TX_BINDING_POLICY_VERSION, bindTransactionToTerms, decodeTransactionBytes, squads, type ApprovedTerms,
} from '@project-qf/tx';
import { approvedConfigParametersDigest } from './index.ts';
import { COMPUTE_CAPS, crossCheckAccounts, type CrossCheck } from './launchpad.ts';

const SQUADS = new PublicKey(PROGRAM_IDS.SQUADS_V4);
const DBC = new PublicKey(PROGRAM_IDS.DBC);
/** Squads v4 Multisig account size: 132 fixed bytes + 33 per member (measured: the 3-member devnet treasury is 231 bytes). */
export const multisigAccountSize = (members: number) => 132 + 33 * members;

/** A placeholder address: sha256 of a label. Not a key anyone holds, so nothing addressed to it as a signer can be signed. */
export function placeholder(label: string): string {
  return new PublicKey(createHash('sha256').update(`QF-PLAN-ONLY:${label}`).digest()).toBase58();
}
export const PLACEHOLDERS = Object.freeze({
  payer: placeholder('payer'),
  createKey: placeholder('multisig-create-key'),
  config: placeholder('dbc-config-account'),
  blockhash: placeholder('recent-blockhash'),
});
export const placeholderMembers = (n: number) => Array.from({ length: n }, (_, k) => placeholder(`member-${k + 1}`));

export interface PlanInput {
  /** real member public keys, or null for placeholders (the owner has not named the signers yet) */
  members: string[] | null;
  memberCount: number;
  threshold: number;
  timeLockSeconds: number;
  quote: { mint: string; decimals: number };
  params: ConfigParameters;
}

export interface PlannedAccount { name: string; address: string; signer: boolean; writable: boolean }
export interface PlannedTransaction {
  title: string;
  program: string;
  instruction: string;
  /** unsigned wire bytes (empty signature slots), base64 */
  transactionBase64: string;
  /** the message the signers would sign, base64; paste into a transaction inspector to read it independently */
  messageBase64: string;
  requiredSigners: string[];
  accounts: PlannedAccount[];
  args: unknown;
  rent: { accountBytes: number; lamports: string | null; providers: string };
}
export interface MainnetSetupTransactions {
  placeholders: typeof PLACEHOLDERS;
  members: { address: string; placeholder: boolean }[];
  squadsProgramConfig: CrossCheck;
  multisig: PlannedTransaction & { multisig: string; vault: string; creationFeeLamports: string | null; squadsTreasury: string | null };
  config: PlannedTransaction & { config: string; feeClaimer: string; leftoverReceiver: string; quoteMint: string; configParametersDigest: string;
    terms: ApprovedTerms; bindingViolations: string[] };
  /** independent checks of what was built: derived addresses, signers, decoded arguments */
  checks: { id: string; ok: boolean; detail: string }[];
}

const jsonable = (x: unknown): unknown => {
  if (x === null || x === undefined) return x ?? null;
  if (typeof x === 'bigint') return x.toString();
  if (x instanceof PublicKey) return x.toBase58();
  if (typeof x === 'object' && 'toArrayLike' in (x as object) && typeof (x as { toString: unknown }).toString === 'function') return (x as { toString(): string }).toString(); // BN
  if (x instanceof Uint8Array) return Buffer.from(x).toString('hex');
  if (Array.isArray(x)) return x.map(jsonable);
  if (typeof x === 'object') return Object.fromEntries(Object.entries(x as object).map(([k, v]) => [k, jsonable(v)]));
  return x;
};

function unsigned(ix: TransactionInstruction): { tx: Transaction; bytes: Uint8Array; message: Uint8Array } {
  const tx = new Transaction().add(ix);
  tx.feePayer = new PublicKey(PLACEHOLDERS.payer);
  tx.recentBlockhash = PLACEHOLDERS.blockhash;
  return { tx, bytes: new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), message: new Uint8Array(tx.serializeMessage()) };
}
const accountsOf = (ix: TransactionInstruction, names: string[]): PlannedAccount[] =>
  ix.keys.map((k, i) => ({ name: names[i] ?? `remaining_${i - names.length}`, address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable }));

async function rentFor(a: Connection, b: Connection | null, bytes: number) {
  const ra = await a.getMinimumBalanceForRentExemption(bytes, 'finalized');
  if (!b) return { accountBytes: bytes, lamports: String(ra), providers: 'one provider' };
  const rb = await b.getMinimumBalanceForRentExemption(bytes, 'finalized');
  return { accountBytes: bytes, lamports: ra === rb ? String(ra) : null, providers: ra === rb ? 'both providers agree' : `providers disagree (${ra} vs ${rb})` };
}

/** Builds and checks the two mainnet setup transactions with placeholder signers. Reads only. */
export async function buildMainnetSetupTransactions(a: Connection, b: Connection | null, input: PlanInput): Promise<MainnetSetupTransactions> {
  const members = input.members ?? placeholderMembers(input.memberCount);
  const checks: MainnetSetupTransactions['checks'] = [];
  const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  // Squads charges a creation fee to its own treasury account; both are in its program config, read from both providers
  const programConfigPda = sq.getProgramConfigPda({})[0];
  const [pc] = await crossCheckAccounts(a, b, [{ address: programConfigPda.toBase58(), label: 'Squads v4 program config (creation fee and its treasury)',
    pick: (i) => { const [c] = sq.accounts.ProgramConfig.deserialize(i.data); return { owner: i.owner, authority: c.authority.toBase58(), multisigCreationFee: c.multisigCreationFee.toString(), treasury: c.treasury.toBase58() }; } }]);
  const pcv = pc!.value as { owner: string; treasury: string; multisigCreationFee: string } | null;
  check('SQUADS_PROGRAM_CONFIG', !!pcv && pcv.owner === PROGRAM_IDS.SQUADS_V4 && (pc!.status === 'MATCH' || pc!.status === 'SINGLE_PROVIDER'),
    pcv ? `read at finalized, ${pc!.status}: fee ${pcv.multisigCreationFee} lamports to ${pcv.treasury}` : `not readable: ${pc!.status} ${pc!.detail ?? ''}`);

  // 1. the treasury multisig: members get every permission (initiate, vote, execute); no config authority, so changing members
  //    or threshold later needs its own threshold-approved config transaction
  const createKey = new PublicKey(PLACEHOLDERS.createKey);
  const [multisigPda] = sq.getMultisigPda({ createKey });
  const vault = sq.getVaultPda({ multisigPda, index: 0 })[0];
  const msIx = sq.instructions.multisigCreateV2({ treasury: new PublicKey(pcv?.treasury ?? PublicKey.default), creator: new PublicKey(PLACEHOLDERS.payer), multisigPda,
    configAuthority: null, threshold: input.threshold, timeLock: input.timeLockSeconds, createKey, rentCollector: null,
    members: members.map((k) => ({ key: new PublicKey(k), permissions: sq.types.Permissions.all() })) });
  const ms = unsigned(msIx);
  const [msArgs] = sq.generated.multisigCreateV2Struct.deserialize(Buffer.from(msIx.data));
  const msSize = multisigAccountSize(members.length);
  const multisig = {
    title: `Create the ${input.threshold}-of-${members.length} platform treasury (Squads v4 multisig)`, program: PROGRAM_IDS.SQUADS_V4, instruction: 'multisig_create_v2',
    transactionBase64: Buffer.from(ms.bytes).toString('base64'), messageBase64: Buffer.from(ms.message).toString('base64'),
    requiredSigners: msIx.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
    accounts: accountsOf(msIx, ['program_config', 'squads_treasury', 'multisig', 'create_key', 'creator (payer)', 'system_program']),
    args: jsonable(msArgs.args), rent: await rentFor(a, b, msSize),
    multisig: multisigPda.toBase58(), vault: vault.toBase58(), creationFeeLamports: pcv?.multisigCreationFee ?? null, squadsTreasury: pcv?.treasury ?? null,
  };
  // derived twice: by the Squads SDK above and by QF's own derivation (packages/tx)
  const qfMultisig = await squads.squadsMultisig(createKey.toBase58()), qfVault = await squads.squadsVault(qfMultisig, 0);
  check('MULTISIG_ADDRESS_DERIVED_TWICE', qfMultisig === multisig.multisig && qfVault === multisig.vault, `multisig ${qfMultisig}, vault ${qfVault} (Squads SDK and QF derivation agree)`);
  const da = msArgs.args;
  check('MULTISIG_ARGS', da.threshold === input.threshold && da.timeLock === input.timeLockSeconds && da.configAuthority === null && da.rentCollector === null
    && da.members.length === members.length && da.members.every((m, k) => m.key.toBase58() === members[k] && m.permissions.mask === 7),
  `decoded from the instruction bytes: threshold ${da.threshold}, time lock ${da.timeLock}s, config authority none, ${da.members.length} members with initiate+vote+execute`);

  // 2. the mainnet DBC config: USDC quote, fee claimer and leftover receiver = the treasury vault
  const client = new DynamicBondingCurveClient(a, 'finalized');
  const cfgTx = await client.partner.createConfig({ ...(input.params as object), config: new PublicKey(PLACEHOLDERS.config), feeClaimer: vault,
    leftoverReceiver: vault, quoteMint: new PublicKey(input.quote.mint), payer: new PublicKey(PLACEHOLDERS.payer) } as never);
  if (cfgTx.instructions.length !== 1) throw new Error(`PLAN_UNEXPECTED_SHAPE createConfig built ${cfgTx.instructions.length} instructions`);
  const cfgIx = cfgTx.instructions[0]!;
  const cfg = unsigned(cfgIx);
  const digest = await approvedConfigParametersDigest(input.params);
  const terms: ApprovedTerms = { kind: 'CREATE_CONFIG', cluster: 'mainnet-beta', policyVersion: TX_BINDING_POLICY_VERSION, feePayer: PLACEHOLDERS.payer,
    compute: { ...COMPUTE_CAPS }, config: PLACEHOLDERS.config, payer: PLACEHOLDERS.payer, feeClaimer: multisig.vault, leftoverReceiver: multisig.vault,
    quoteMint: input.quote.mint, configParametersDigest: digest };
  // decoded again by QF's own pinned decoder and bound to the terms above: every account, signer, writable and argument
  const bindingViolations = await bindTransactionToTerms(decodeTransactionBytes(cfg.bytes), terms);
  // the SDK's own Anchor coder (BorshInstructionCoder; its decode is not on the InstructionCoder interface type)
  const decoded = (client.partner.program.coder.instruction as unknown as { decode(d: Buffer): { name: string; data: unknown } | null }).decode(Buffer.from(cfgIx.data));
  const cfgSize = client.partner.program.account.poolConfig.size;
  const config = {
    title: 'Create the mainnet DBC config (USDC quote; platform fees and leftovers to the treasury vault)', program: PROGRAM_IDS.DBC, instruction: decoded?.name ?? 'unknown',
    transactionBase64: Buffer.from(cfg.bytes).toString('base64'), messageBase64: Buffer.from(cfg.message).toString('base64'),
    requiredSigners: cfgIx.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
    accounts: accountsOf(cfgIx, ['config', 'fee_claimer', 'leftover_receiver', 'quote_mint', 'payer', 'system_program', 'event_authority', 'program']),
    args: jsonable(decoded?.data ?? null), rent: await rentFor(a, b, cfgSize),
    config: PLACEHOLDERS.config, feeClaimer: multisig.vault, leftoverReceiver: multisig.vault, quoteMint: input.quote.mint, configParametersDigest: digest, terms, bindingViolations,
  };
  check('CONFIG_BOUND_TO_TERMS', bindingViolations.length === 0, bindingViolations.length ? bindingViolations.join('; ') : 'QF decoder: one create_config, every account, signer, writable and the parameter digest match');
  check('FEE_CLAIMER_IS_TREASURY_VAULT', config.accounts.find((x) => x.name === 'fee_claimer')?.address === multisig.vault, `fee_claimer ${multisig.vault}`);
  check('LEFTOVER_RECEIVER_IS_TREASURY_VAULT', config.accounts.find((x) => x.name === 'leftover_receiver')?.address === multisig.vault, `leftover_receiver ${multisig.vault}`);
  check('QUOTE_MINT', config.accounts.find((x) => x.name === 'quote_mint')?.address === input.quote.mint, `quote_mint ${input.quote.mint}`);
  check('DBC_PROGRAM', cfgIx.programId.equals(DBC) && msIx.programId.equals(SQUADS), 'config instruction calls the pinned DBC program; multisig instruction calls the pinned Squads v4 program');

  // 3. neither transaction can be signed or land: every required signer is a placeholder, and so is the blockhash
  const placeholderSet = new Set<string>([PLACEHOLDERS.payer, PLACEHOLDERS.createKey, PLACEHOLDERS.config]);
  const signers = [...multisig.requiredSigners, ...config.requiredSigners];
  const wire = [decodeTransactionBytes(ms.bytes), decodeTransactionBytes(cfg.bytes)];
  check('NOT_SIGNABLE', signers.every((s) => placeholderSet.has(s)) && wire.every((d) => d.feePayer === PLACEHOLDERS.payer && d.signers.every((s) => placeholderSet.has(s))),
    `required signers ${[...new Set(signers)].join(', ')} are all placeholders (sha256 of a label; no one holds their keys)`);
  check('NOT_LANDABLE', [ms.tx, cfg.tx].every((t) => t.recentBlockhash === PLACEHOLDERS.blockhash) && !Object.values(PLACEHOLDERS).includes(PublicKey.default.toBase58()),
    `recent blockhash ${PLACEHOLDERS.blockhash} is a placeholder, not a mainnet blockhash`);
  check('MEMBERS_NOT_PLACEHOLDER_SIGNERS', members.every((m) => !placeholderSet.has(m)), 'no member is the payer, create key or config account');

  return { placeholders: PLACEHOLDERS, members: members.map((m) => ({ address: m, placeholder: !input.members })), squadsProgramConfig: pc!, multisig, config, checks };
}
