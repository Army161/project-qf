// Treasury binding (QF-SEC-01 applied to the Squads v4 platform treasury). A treasury transaction is bound like any
// other: every top-level instruction decoded under the pinned Squads subset, every account bound by name, exact
// signer and writable sets. On top of that, the claim the vault will sign is bound to its own approved terms twice:
//   - at propose time, from the message bytes inside vault_transaction_create;
//   - at approve and execute time, from the VaultTransaction account the program stored (bindStoredVaultTransaction),
//     because that, not the server's description, is what members approve and what execute runs.
// Browser-safe (Solana Kit only).
import { PROGRAM_IDS } from './programs.ts';
import type { DecodedInstruction, DecodedTransaction } from './decoder.ts';
import type { ApprovedTerms, TreasuryInnerTerms } from './terms.ts';
import { decodeExact, type Decoded } from './engine/borsh.ts';
import type { IdlInstruction } from './engine/idl-types.ts';
import { SQUADS_IDL_SUBSET } from './engine/squads-idl-subset.ts';
import {
  decodeCompactMessageHex, decodeVaultTransactionAccount, isWritableIndex, squadsProposal, squadsTransaction, squadsVault, vaultMessageAsTransaction,
  type VaultMessage,
} from './engine/squads.ts';
import { bindTransactionToTerms, checkComputeBudget, type BindingContext } from './semantic.ts';

type TreasuryTerms = Extract<ApprovedTerms, { kind: 'TREASURY_PROPOSE' | 'TREASURY_APPROVE' | 'TREASURY_EXECUTE' }>;
const P = PROGRAM_IDS;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const OPS = Object.fromEntries(SQUADS_IDL_SUBSET.instructions.map((i) => [i.name, i])) as Record<string, IdlInstruction>;

/** A rewards deposit goes from this multisig's treasury vault to this multisig's rewards vault (index 1), nowhere else. */
async function rewardsVaultViolations(multisig: string, inner: TreasuryInnerTerms): Promise<string[]> {
  if (inner.kind !== 'REWARDS_DEPOSIT') return [];
  return inner.to === await squadsVault(multisig, 1) ? [] : ['TERMS_REWARDS_DEPOSIT_NOT_TO_REWARDS_VAULT'];
}

interface Step { op: IdlInstruction; accounts: Record<string, string>; check: (a: Record<string, Decoded>) => Promise<string[]> }

/** The vault message must be exactly the approved claim, run by the vault and nothing else. */
export async function bindVaultMessage(m: VaultMessage, inner: TreasuryInnerTerms): Promise<string[]> {
  const v: string[] = [];
  if (m.addressTableLookups > 0) v.push('INNER_ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED');
  const d = vaultMessageAsTransaction(m);
  // ComputeBudget cannot be invoked through CPI; inside a vault transaction it would only make execution fail.
  if (d.instructions.some((ix) => ix.programAddress === P.COMPUTE_BUDGET)) v.push('INNER_COMPUTE_BUDGET_NOT_ALLOWED');
  v.push(...(await bindTransactionToTerms(d, inner)).map((x) => `INNER_${x}`));
  return v;
}

/** Checks a stored VaultTransaction account against what members are asked to approve or execute. */
export async function bindStoredVaultTransaction(accountData: Uint8Array,
  t: { multisig: string; transactionIndex: string; vaultIndex: number; inner: TreasuryInnerTerms }): Promise<{ violations: string[]; message: VaultMessage | null }> {
  let s;
  try { s = decodeVaultTransactionAccount(accountData); } catch (e) { return { violations: [`STORED_TX_DECODE_FAILED ${(e as Error).message}`], message: null }; }
  const v: string[] = [];
  if (s.multisig !== t.multisig) v.push('STORED_TX_MULTISIG_MISMATCH');
  if (s.index !== BigInt(t.transactionIndex)) v.push('STORED_TX_INDEX_MISMATCH');
  if (s.vaultIndex !== t.vaultIndex) v.push('STORED_TX_VAULT_INDEX_MISMATCH');
  if (s.ephemeralSignerBumps.length) v.push('STORED_TX_EPHEMERAL_SIGNERS');
  v.push(...await rewardsVaultViolations(t.multisig, t.inner));
  v.push(...(await bindVaultMessage(s.message, t.inner)).map((x) => `STORED_${x}`));
  return { violations: v, message: s.message };
}

function decodeSquads(ix: DecodedInstruction): { op: IdlInstruction; args: Record<string, Decoded> } | { error: string } {
  const data = fromHex(ix.dataHex);
  if (data.length < 8) return { error: 'SQUADS_DECODE_FAILED data shorter than discriminator' };
  const op = SQUADS_IDL_SUBSET.instructions.find((i) => i.discriminator.every((b, k) => data[k] === b));
  if (!op) return { error: `SQUADS_UNKNOWN_INSTRUCTION discriminator ${ix.dataHex.slice(0, 16)}` };
  try { return { op, args: decodeExact(data.subarray(8), op.args, SQUADS_IDL_SUBSET.types) }; }
  catch (e) { return { error: `SQUADS_DECODE_FAILED ${op.name}: ${(e as Error).message}` }; }
}

export async function bindTreasury(d: DecodedTransaction, t: TreasuryTerms, ctx: BindingContext): Promise<string[]> {
  const v: string[] = [];
  if (d.addressTableLookups > 0) v.push('ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED_IN_PREVIEW');
  if (d.feePayer !== t.feePayer) v.push('FEE_PAYER_MISMATCH');
  const index = BigInt(t.transactionIndex);
  const transaction = await squadsTransaction(t.multisig, index), proposal = await squadsProposal(t.multisig, index);
  if (t.kind !== 'TREASURY_APPROVE' && t.vault !== await squadsVault(t.multisig, t.vaultIndex)) v.push('TERMS_VAULT_NOT_DERIVED_FROM_MULTISIG');
  if (t.kind !== 'TREASURY_APPROVE') v.push(...await rewardsVaultViolations(t.multisig, t.inner));
  const memoNone = (a: Record<string, Decoded>) => (a.args as Record<string, Decoded>).memo === null ? [] : ['ARG_POLICY memo must be empty'];

  const steps: Step[] = [];
  const signers = new Set<string>([t.feePayer]);
  const writable = new Set<string>([t.feePayer]);
  let remaining: { keys: string[]; writable: Set<string> } = { keys: [], writable: new Set() };

  if (t.kind === 'TREASURY_PROPOSE') {
    signers.add(t.creator).add(t.rentPayer);
    steps.push({ op: OPS.vault_transaction_create!, accounts: { multisig: t.multisig, transaction, creator: t.creator, rent_payer: t.rentPayer, system_program: P.SYSTEM },
      check: async (a) => {
        const x = a.args as Record<string, Decoded>;
        const out: string[] = [];
        if (x.vault_index !== t.vaultIndex) out.push('ARG_MISMATCH vault_index');
        if (x.ephemeral_signers !== 0) out.push('ARG_POLICY ephemeral_signers must be 0');
        out.push(...memoNone(a));
        let m: VaultMessage;
        try { m = decodeCompactMessageHex(x.transaction_message as string); } catch (e) { return [...out, `INNER_DECODE_FAILED ${(e as Error).message}`]; }
        return [...out, ...await bindVaultMessage(m, t.inner)];
      } });
    steps.push({ op: OPS.proposal_create!, accounts: { multisig: t.multisig, proposal, creator: t.creator, rent_payer: t.rentPayer, system_program: P.SYSTEM },
      check: async (a) => {
        const x = a.args as Record<string, Decoded>;
        return [...(BigInt(x.transaction_index as bigint) === index ? [] : ['ARG_MISMATCH transaction_index']), ...(x.draft === false ? [] : ['ARG_POLICY draft must be false'])];
      } });
    if (t.approve) steps.push({ op: OPS.proposal_approve!, accounts: { multisig: t.multisig, member: t.creator, proposal }, check: async (a) => memoNone(a) });
  } else if (t.kind === 'TREASURY_APPROVE') {
    signers.add(t.member);
    steps.push({ op: OPS.proposal_approve!, accounts: { multisig: t.multisig, member: t.member, proposal }, check: async (a) => memoNone(a) });
  } else {
    signers.add(t.member);
    steps.push({ op: OPS.vault_transaction_execute!, accounts: { multisig: t.multisig, proposal, transaction, member: t.member }, check: async () => [] });
    if (!ctx.vaultTransactionAccount) v.push('EXECUTE_NEEDS_STORED_TRANSACTION');
    else {
      const r = await bindStoredVaultTransaction(ctx.vaultTransactionAccount, t);
      v.push(...r.violations);
      // execute passes the stored message's accounts, in order, with the same writability (the vault is signed for by
      // the program, so no message account is a signer of the outer transaction)
      if (r.message) remaining = { keys: r.message.accountKeys, writable: new Set(r.message.accountKeys.filter((_, k) => isWritableIndex(r.message!, k))) };
    }
  }

  let step = 0, limitSeen = 0, priceSeen = 0;
  for (const [k, ix] of d.instructions.entries()) {
    const at = `#${k}`;
    if (ix.programAddress === P.COMPUTE_BUDGET) {
      const r = checkComputeBudget(ix, t, at);
      v.push(...r.v); limitSeen += r.limit; priceSeen += r.price;
      continue;
    }
    if (ix.programAddress !== P.SQUADS_V4) { v.push(`UNEXPECTED_PROGRAM ${ix.programAddress} ${at}`); continue; }
    const want = steps[step++];
    const r = decodeSquads(ix);
    if ('error' in r) { v.push(`${r.error} ${at}`); continue; }
    if (!want) { v.push(`UNEXPECTED_INSTRUCTION ${r.op.name} ${at}`); continue; }
    if (r.op.name !== want.op.name) { v.push(`WRONG_OPERATION ${r.op.name} (approved ${want.op.name}) ${at}`); continue; }
    const n = r.op.accounts.length;
    if (ix.accounts.length < n) { v.push(`ACCOUNT_COUNT ${ix.accounts.length} < ${n} ${at}`); continue; }
    for (const [j, meta] of r.op.accounts.entries()) {
      const got = ix.accounts[j]!;
      if (got !== want.accounts[meta.name]) v.push(`ACCOUNT_MISMATCH ${meta.name} ${at}`);
      if (meta.writable) { writable.add(got); if (!d.writableAccounts.includes(got)) v.push(`MISSING_WRITABLE ${meta.name} ${at}`); }
      if (meta.signer && !d.signers.includes(got)) v.push(`REQUIRED_SIGNER_MISSING ${meta.name} ${at}`);
    }
    const extra = ix.accounts.slice(n);
    if (r.op.name === 'vault_transaction_execute') {
      if (extra.length !== remaining.keys.length || extra.some((a, j) => a !== remaining.keys[j])) v.push(`EXECUTE_ACCOUNTS_NOT_STORED_MESSAGE ${at}`);
      for (const a of remaining.writable) { writable.add(a); if (!d.writableAccounts.includes(a)) v.push(`MISSING_WRITABLE ${a} ${at}`); }
    } else if (extra.length) v.push(`UNEXPECTED_REMAINING_ACCOUNT ${extra.join(',')} ${at}`);
    v.push(...(await want.check(r.args)).map((x) => `${x} ${at}`));
  }
  if (step < steps.length) v.push(`MISSING_INSTRUCTION ${steps.slice(step).map((s) => s.op.name).join(',')}`);
  if (limitSeen > 1 || priceSeen > 1) v.push('COMPUTE_BUDGET_DUPLICATE');
  for (const s of d.signers) if (!signers.has(s)) v.push(`UNEXPECTED_SIGNER ${s}`);
  for (const s of signers) if (!d.signers.includes(s)) v.push(`REQUIRED_SIGNER_MISSING ${s}`);
  for (const w of d.writableAccounts) if (!writable.has(w)) v.push(`UNEXPECTED_WRITABLE ${w}`);
  return [...new Set(v)];
}
