// Holder-rewards transfers (devnet): what a treasury vault signs to fund or pay holder rewards. Bound exactly, like every
// other QF transaction: the message may contain only SPL Token TransferChecked instructions from the vault's own quote
// account, in the approved order and amounts, to the approved owners' associated token accounts, followed by one memo
// naming the coin and epoch. No account creation, no other program, no other signer. Browser-safe (Solana Kit only).
import { PROGRAM_IDS } from './programs.ts';
import type { DecodedTransaction } from './decoder.ts';
import { rewardsMemo, type RewardsInnerTerms } from './terms.ts';
import { ata } from './engine/pda.ts';

const P = PROGRAM_IDS;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const TRANSFER_CHECKED = 12;

/** TransferChecked data: [12, amount u64 LE, decimals u8]. Null when the bytes are anything else. */
export function decodeTransferChecked(dataHex: string): { amount: bigint; decimals: number } | null {
  const d = fromHex(dataHex);
  if (d.length !== 10 || d[0] !== TRANSFER_CHECKED) return null;
  let amount = 0n;
  for (let i = 8; i >= 1; i--) amount = (amount << 8n) | BigInt(d[i]!);
  return { amount, decimals: d[9]! };
}

/** The transfers a rewards deposit or payout must contain, in order: [owner, amount]. */
export const rewardsTransfers = (t: RewardsInnerTerms): { owner: string; amountRaw: string }[] =>
  t.kind === 'REWARDS_DEPOSIT' ? [{ owner: t.to, amountRaw: t.amountRaw }] : t.payouts;

export async function bindRewardsTransfer(d: DecodedTransaction, t: RewardsInnerTerms): Promise<string[]> {
  const v: string[] = [];
  if (d.addressTableLookups > 0) v.push('ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED_IN_PREVIEW');
  if (d.feePayer !== t.feePayer) v.push('FEE_PAYER_MISMATCH');
  const source = await ata(t.from, t.quoteMint, t.quoteTokenProgram);
  const want = rewardsTransfers(t);
  const dest = await Promise.all(want.map((w) => ata(w.owner, t.quoteMint, t.quoteTokenProgram)));
  if (new Set(dest).size !== dest.length || dest.includes(source)) v.push('REWARDS_DESTINATIONS_NOT_DISTINCT');
  const writable = new Set<string>([t.feePayer, source, ...dest]);
  const memo = new TextEncoder().encode(rewardsMemo(t));
  const memoHex = Array.from(memo, (x) => x.toString(16).padStart(2, '0')).join('');
  let k = 0, memos = 0;
  for (const [i, ix] of d.instructions.entries()) {
    const at = `#${i}`;
    if (ix.programAddress === t.quoteTokenProgram) {
      const w = want[k], to = dest[k];
      k++;
      if (!w || !to) { v.push(`UNEXPECTED_TRANSFER ${at}`); continue; }
      const x = decodeTransferChecked(ix.dataHex);
      if (!x) { v.push(`TOKEN_INSTRUCTION_NOT_TRANSFER_CHECKED ${at}`); continue; }
      if (ix.accounts.length !== 4) { v.push(`TRANSFER_ACCOUNT_COUNT ${ix.accounts.length} ${at}`); continue; }
      const [src, mint, dst, authority] = ix.accounts;
      if (src !== source) v.push(`TRANSFER_SOURCE_NOT_VAULT_ACCOUNT ${at}`);
      if (mint !== t.quoteMint) v.push(`TRANSFER_MINT_MISMATCH ${at}`);
      if (dst !== to) v.push(`TRANSFER_DESTINATION_MISMATCH ${w.owner} ${at}`);
      if (authority !== t.from) v.push(`TRANSFER_AUTHORITY_NOT_VAULT ${at}`);
      if (x.amount !== BigInt(w.amountRaw)) v.push(`TRANSFER_AMOUNT_MISMATCH ${w.owner} ${x.amount} (approved ${w.amountRaw}) ${at}`);
      if (x.decimals !== t.quoteDecimals) v.push(`TRANSFER_DECIMALS_MISMATCH ${at}`);
      if (authority && !d.signers.includes(authority)) v.push(`REQUIRED_SIGNER_MISSING authority ${at}`);
    } else if (ix.programAddress === P.MEMO) {
      memos++;
      if (k !== want.length) v.push(`MEMO_BEFORE_TRANSFERS ${at}`);
      if (ix.accounts.length !== 0) v.push(`MEMO_HAS_ACCOUNTS ${at}`);
      if (ix.dataHex !== memoHex) v.push(`MEMO_MISMATCH ${at}`);
    } else v.push(`UNEXPECTED_PROGRAM ${ix.programAddress} ${at}`);
  }
  if (k < want.length) v.push(`MISSING_TRANSFERS ${want.length - k}`);
  if (memos !== 1) v.push(`MEMO_COUNT ${memos} (exactly 1)`);
  for (const s of d.signers) if (s !== t.from) v.push(`UNEXPECTED_SIGNER ${s}`);
  if (!d.signers.includes(t.from)) v.push(`REQUIRED_SIGNER_MISSING ${t.from}`);
  for (const w of d.writableAccounts) if (!writable.has(w)) v.push(`UNEXPECTED_WRITABLE ${w}`);
  return [...new Set(v)];
}
