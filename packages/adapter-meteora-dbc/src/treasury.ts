// SERVER-ONLY platform treasury on devnet (milestone 7): a Squads v4 multisig whose vault PDA is the fee claimer and
// leftover receiver of the treasury DBC config. Devnet stand-in only: three throwaway member keys, 2-of-3, no config
// authority, no spending limits, no time lock. Real signers, threshold and time lock are the owner's mainnet decisions.
//
// What runs where:
//   - The operator key creates the multisig (it pays; it is NOT a member) and nothing else here.
//   - Every proposal, approval and execution is built UNSIGNED for a member, who pays its own fee and signs for itself.
//     The server process never loads a member key, so it cannot approve or execute, and the vault cannot be spent
//     without two members.
//   - The vault only ever signs platform fee claims into its own accounts (bound in packages/tx).
import * as sq from '@sqds/multisig';
import BN from 'bn.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, type Commitment,
} from '@solana/web3.js';
import { PROGRAM_IDS, rewardsMemo, rewardsTransfers, squads, vaultIndexFor, type ApprovedTerms, type RewardsInnerTerms, type TreasuryInnerTerms } from '@project-qf/tx';
import { common, dammClaimTransaction, finish, operatorSend, type BuiltTx, type LiveDammPool, type LivePool } from './launchpad.ts';

const COMMITMENT: Commitment = 'confirmed';
const SQUADS = new PublicKey(PROGRAM_IDS.SQUADS_V4);
if (!sq.PROGRAM_ID.equals(SQUADS)) throw new Error('Squads SDK program id differs from the pinned PROGRAM_IDS.SQUADS_V4');
/** Execute runs the claim through CPI (Squads -> DBC or DAMM v2 -> event CPI), above the 200k default. Within COMPUTE_CAPS. */
export const EXECUTE_COMPUTE_UNITS = 400_000;

export interface TreasuryState {
  multisig: string; vault: string; threshold: number; timeLock: number; configAuthority: string | null;
  members: { key: string; mask: number }[]; transactionIndex: bigint; staleTransactionIndex: bigint;
}
export interface TreasuryRecord { multisig: string; vault: string; createKey: string; threshold: number; members: string[]; signature: string; createdAt: string; label: 'DEVNET_STAND_IN' }

const vaultOf = (multisig: PublicKey, index = 0) => sq.getVaultPda({ multisigPda: multisig, index })[0];
/** The rewards vault: the same multisig's vault index 1. Holder rewards are deposited here and paid from here. */
export const rewardsVaultOf = (multisig: string) => vaultOf(new PublicKey(multisig), 1).toBase58();

/** Reads the multisig and fails closed if it is not the stand-in this milestone describes. */
export async function readTreasury(conn: Connection, multisig: string): Promise<TreasuryState> {
  const pk = new PublicKey(multisig);
  const info = await conn.getAccountInfo(pk, COMMITMENT);
  if (!info) throw new Error(`TREASURY_NOT_FOUND ${multisig}`);
  if (!info.owner.equals(SQUADS)) throw new Error(`TREASURY_NOT_SQUADS ${multisig} is owned by ${info.owner.toBase58()}`);
  const [m] = sq.accounts.Multisig.fromAccountInfo(info);
  const ca = m.configAuthority.toBase58();
  return { multisig, vault: vaultOf(pk).toBase58(), threshold: m.threshold, timeLock: m.timeLock, configAuthority: ca === PublicKey.default.toBase58() ? null : ca,
    members: m.members.map((x) => ({ key: x.key.toBase58(), mask: x.permissions.mask })),
    transactionIndex: BigInt(m.transactionIndex.toString()), staleTransactionIndex: BigInt(m.staleTransactionIndex.toString()) };
}

/** Creates the 2-of-3 stand-in. The operator pays and is not a member; members get every permission (initiate, vote, execute). */
export async function createTreasuryMultisig(conn: Connection, operator: Keypair, members: string[], threshold: number): Promise<TreasuryRecord> {
  if (new Set(members).size !== members.length || members.length < threshold || threshold < 2) throw new Error('TREASURY_BAD_MEMBERS need distinct members and a threshold of at least 2');
  if (members.includes(operator.publicKey.toBase58())) throw new Error('TREASURY_OPERATOR_IS_MEMBER the operator key must not be a member');
  const createKey = Keypair.generate();
  const [multisigPda] = sq.getMultisigPda({ createKey: createKey.publicKey });
  const programConfig = await sq.accounts.ProgramConfig.fromAccountAddress(conn, sq.getProgramConfigPda({})[0]);
  const ix = sq.instructions.multisigCreateV2({ treasury: programConfig.treasury, creator: operator.publicKey, multisigPda, configAuthority: null, threshold,
    members: members.map((k) => ({ key: new PublicKey(k), permissions: sq.types.Permissions.all() })), timeLock: 0, createKey: createKey.publicKey, rentCollector: null });
  const signature = await operatorSend(conn, new Transaction().add(ix), [operator, createKey]);
  const st = await readTreasury(conn, multisigPda.toBase58());
  const want = [...members].sort().join(), got = st.members.map((x) => x.key).sort().join();
  if (st.threshold !== threshold || got !== want || st.configAuthority !== null || st.timeLock !== 0) throw new Error(`TREASURY_READBACK_MISMATCH ${JSON.stringify({ ...st, transactionIndex: String(st.transactionIndex), staleTransactionIndex: String(st.staleTransactionIndex) })}`);
  return { multisig: multisigPda.toBase58(), vault: st.vault, createKey: createKey.publicKey.toBase58(), threshold, members, signature, createdAt: new Date().toISOString(), label: 'DEVNET_STAND_IN' };
}

// ------------------------------------------------------------------ what the vault signs (inner claims)

export interface InnerClaim { instructions: TransactionInstruction[]; terms: TreasuryInnerTerms; amounts: { baseRaw: string; quoteRaw: string } }

/** Partner share of curve trading fees, claimed by the vault (the treasury config's fee claimer) into its own accounts. */
export async function partnerCurveClaim(conn: Connection, pool: LivePool, vault: string): Promise<InnerClaim> {
  const maxBaseAmount = pool.partnerBaseFee, maxQuoteAmount = pool.partnerQuoteFee;
  if (BigInt(maxBaseAmount) === 0n && BigInt(maxQuoteAmount) === 0n) throw new Error('NOTHING_TO_CLAIM: no platform fees on the curve yet');
  const v = new PublicKey(vault);
  const tx = await new DynamicBondingCurveClient(conn, COMMITMENT).partner.claimPartnerTradingFee({ feeClaimer: v, payer: v, pool: new PublicKey(pool.pool), receiver: v,
    maxBaseAmount: new BN(maxBaseAmount), maxQuoteAmount: new BN(maxQuoteAmount) });
  const terms: ApprovedTerms = { ...common(vault), kind: 'CLAIM_PARTNER_TRADING_FEE', config: pool.config, pool: pool.pool, feeClaimer: vault, receiver: vault,
    baseMint: pool.baseMint, quoteMint: pool.quoteMint, baseTokenProgram: PROGRAM_IDS.TOKEN, quoteTokenProgram: PROGRAM_IDS.TOKEN, maxBaseAmount, maxQuoteAmount };
  return { instructions: tx.instructions, terms, amounts: { baseRaw: maxBaseAmount, quoteRaw: maxQuoteAmount } };
}

/** Fees of a DAMM v2 position whose NFT the vault holds (the partner's locked LP after graduation). */
export async function vaultDammClaim(conn: Connection, p: LiveDammPool, vault: string, nftMint: string, amounts: InnerClaim['amounts']): Promise<InnerClaim> {
  const { tx, terms } = await dammClaimTransaction(conn, p, vault, nftMint);
  return { instructions: tx.instructions, terms: terms as TreasuryInnerTerms, amounts };
}

// ------------------------------------------------------------------ holder rewards (what the vaults sign)

const TOKEN = new PublicKey(PROGRAM_IDS.TOKEN), ATA = new PublicKey(PROGRAM_IDS.ASSOCIATED_TOKEN), MEMO = new PublicKey(PROGRAM_IDS.MEMO);
const ataOf = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
export const quoteAccountOf = (owner: string, mint: string) => ataOf(new PublicKey(owner), new PublicKey(mint)).toBase58();

/** A deposit into the rewards vault or a payout from it: TransferChecked from the vault's own quote account, then the memo. */
export function rewardsTransferInner(terms: RewardsInnerTerms): InnerClaim {
  const from = new PublicKey(terms.from), mint = new PublicKey(terms.quoteMint), src = ataOf(from, mint);
  const instructions = rewardsTransfers(terms).map((w) => {
    const data = Buffer.alloc(10);
    data[0] = 12; data.writeBigUInt64LE(BigInt(w.amountRaw), 1); data[9] = terms.quoteDecimals;
    return new TransactionInstruction({ programId: TOKEN, data, keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ataOf(new PublicKey(w.owner), mint), isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }] });
  });
  instructions.push(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(rewardsMemo(terms), 'utf8') }));
  const total = rewardsTransfers(terms).reduce((x, w) => x + BigInt(w.amountRaw), 0n);
  return { instructions, terms, amounts: { baseRaw: '0', quoteRaw: total.toString() } };
}

/** The operator pays the rent for any missing quote account of these owners (create-idempotent; moves no tokens). */
export async function ensureQuoteAccounts(conn: Connection, operator: Keypair, owners: string[], quoteMint: string): Promise<{ created: string[]; signature: string | null }> {
  const mint = new PublicKey(quoteMint);
  const want = owners.map((o) => ({ owner: new PublicKey(o), ata: ataOf(new PublicKey(o), mint) }));
  const infos = await conn.getMultipleAccountsInfo(want.map((w) => w.ata), COMMITMENT);
  const missing = want.filter((_, i) => !infos[i]);
  if (!missing.length) return { created: [], signature: null };
  const tx = new Transaction().add(...missing.map((m) => new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [
    { pubkey: operator.publicKey, isSigner: true, isWritable: true }, { pubkey: m.ata, isSigner: false, isWritable: true }, { pubkey: m.owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: new PublicKey(PROGRAM_IDS.SYSTEM), isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] })));
  return { created: missing.map((m) => m.owner.toBase58()), signature: await operatorSend(conn, tx, [operator]) };
}

// ------------------------------------------------------------------ member transactions (unsigned)

const pdas = (multisig: PublicKey, index: bigint) => ({
  transaction: sq.getTransactionPda({ multisigPda: multisig, index })[0], proposal: sq.getProposalPda({ multisigPda: multisig, transactionIndex: index })[0] });

/** vault_transaction_create + proposal_create + the creating member's own approval, in one transaction the member signs. */
export function proposeTransaction(r: { multisig: string; member: string; transactionIndex: bigint; claim: InnerClaim }): { tx: Transaction; terms: ApprovedTerms } {
  const ms = new PublicKey(r.multisig), member = new PublicKey(r.member), index = r.transactionIndex;
  const vaultIndex = vaultIndexFor(r.claim.terms);
  const vault = vaultOf(ms, vaultIndex);
  if (vault.toBase58() !== r.claim.terms.feePayer) throw new Error('CLAIM_NOT_FOR_THIS_VAULT');
  // the blockhash inside a vault message is never used by the program; the outer transaction carries the real one
  const message = new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: r.claim.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)) });
  const tx = new Transaction().add(
    sq.instructions.vaultTransactionCreate({ multisigPda: ms, transactionIndex: index, creator: member, rentPayer: member, vaultIndex, ephemeralSigners: 0, transactionMessage: message }),
    sq.instructions.proposalCreate({ multisigPda: ms, transactionIndex: index, creator: member, rentPayer: member }),
    sq.instructions.proposalApprove({ multisigPda: ms, transactionIndex: index, member }),
  );
  const terms: ApprovedTerms = { ...common(r.member), kind: 'TREASURY_PROPOSE', multisig: r.multisig, transactionIndex: index.toString(), vault: vault.toBase58(), vaultIndex,
    creator: r.member, rentPayer: r.member, approve: true, inner: r.claim.terms };
  return { tx, terms };
}
/** Proposes at the multisig's next transaction index (read from chain). */
export async function buildTreasuryPropose(conn: Connection, r: { multisig: string; member: string; claim: InnerClaim }): Promise<BuiltTx & { transactionIndex: string }> {
  const st = await readTreasury(conn, r.multisig);
  if (!st.members.some((m) => m.key === r.member)) throw new Error('NOT_A_MEMBER');
  return buildTreasuryProposeAt(conn, { ...r, transactionIndex: st.transactionIndex + 1n });
}
export async function buildTreasuryProposeAt(conn: Connection, r: Parameters<typeof proposeTransaction>[0]): Promise<BuiltTx & { transactionIndex: string }> {
  const { tx, terms } = proposeTransaction(r);
  return { ...(await finish(conn, tx, new PublicKey(r.member))), terms, transactionIndex: r.transactionIndex.toString() };
}

export function approveTransaction(r: { multisig: string; member: string; transactionIndex: string }): { tx: Transaction; terms: ApprovedTerms } {
  const tx = new Transaction().add(sq.instructions.proposalApprove({ multisigPda: new PublicKey(r.multisig), transactionIndex: BigInt(r.transactionIndex), member: new PublicKey(r.member) }));
  return { tx, terms: { ...common(r.member), kind: 'TREASURY_APPROVE', multisig: r.multisig, transactionIndex: r.transactionIndex, member: r.member } };
}
export async function buildTreasuryApprove(conn: Connection, r: { multisig: string; member: string; transactionIndex: string }): Promise<BuiltTx> {
  const { tx, terms } = approveTransaction(r);
  return { ...(await finish(conn, tx, new PublicKey(r.member))), terms };
}

/** Raw data of the stored VaultTransaction (what members approve and execute runs), or null if absent. */
export async function readVaultTransactionAccount(conn: Connection, multisig: string, transactionIndex: string): Promise<Uint8Array | null> {
  const info = await conn.getAccountInfo(pdas(new PublicKey(multisig), BigInt(transactionIndex)).transaction, COMMITMENT);
  if (!info) return null;
  if (!info.owner.equals(SQUADS)) throw new Error('VAULT_TRANSACTION_NOT_SQUADS');
  return new Uint8Array(info.data);
}

export type ProposalState = { status: string; approved: string[]; rejected: string[]; cancelled: string[] } | null;
export async function readProposal(conn: Connection, multisig: string, transactionIndex: string): Promise<ProposalState> {
  const info = await conn.getAccountInfo(pdas(new PublicKey(multisig), BigInt(transactionIndex)).proposal, COMMITMENT);
  if (!info) return null;
  if (!info.owner.equals(SQUADS)) throw new Error('PROPOSAL_NOT_SQUADS');
  const [p] = sq.accounts.Proposal.fromAccountInfo(info);
  return { status: p.status.__kind, approved: p.approved.map((k) => k.toBase58()), rejected: p.rejected.map((k) => k.toBase58()), cancelled: p.cancelled.map((k) => k.toBase58()) };
}

/** vault_transaction_execute with the stored message's accounts as remaining accounts (decoded by packages/tx, the same
 *  decoder the binding uses), plus a compute limit. `stored` is the account data the caller already bound. */
export function executeTransaction(r: { multisig: string; member: string; transactionIndex: string; vault: string; inner: TreasuryInnerTerms; stored: Uint8Array }): { tx: Transaction; terms: ApprovedTerms } {
  const ms = new PublicKey(r.multisig), member = new PublicKey(r.member);
  const m = squads.decodeVaultTransactionAccount(r.stored).message;
  const { transaction, proposal } = pdas(ms, BigInt(r.transactionIndex));
  const ix = sq.generated.createVaultTransactionExecuteInstruction({ multisig: ms, proposal, transaction, member,
    anchorRemainingAccounts: m.accountKeys.map((k, i) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: squads.isWritableIndex(m, i) })) });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: EXECUTE_COMPUTE_UNITS }), ix);
  return { tx, terms: { ...common(r.member), kind: 'TREASURY_EXECUTE', multisig: r.multisig, transactionIndex: r.transactionIndex, vault: r.vault, vaultIndex: vaultIndexFor(r.inner), member: r.member, inner: r.inner } };
}
export async function buildTreasuryExecute(conn: Connection, r: Parameters<typeof executeTransaction>[0]): Promise<BuiltTx> {
  const { tx, terms } = executeTransaction(r);
  return { ...(await finish(conn, tx, new PublicKey(r.member))), terms };
}

// ------------------------------------------------------------------ member signing (member CLI only; never the server)

/** Adds `kp`'s signature over the exact message bytes (the message is not re-serialised, so the server's MESSAGE_CHANGED check holds). */
export async function signAsMember(bytes: Uint8Array, kp: Keypair): Promise<Uint8Array> {
  const { addSignature } = await import('@project-qf/tx');
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...kp.secretKey.subarray(0, 32)]);
  const key = await globalThis.crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  pkcs8.fill(0);
  return addSignature(bytes, kp.publicKey.toBase58(), key);
}
