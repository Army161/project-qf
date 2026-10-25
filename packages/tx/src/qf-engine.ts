// Transactions on Project QF's own engine (ADR-014): what each kind of terms builds, and the binding a preview checks.
// One rule binds them all. After at most one compute-unit limit and one compute-unit price (within the approved caps),
// the transaction holds exactly the instructions qfInstructions(terms) builds, in order and byte for byte: program,
// every account, data. Its signers and writable accounts are exactly those instructions' (plus the fee payer).
// The server builds with the same function, so there is one definition of each transaction. Browser-safe (Kit only).
import { isSignerRole, isWritableRole, type Instruction } from '@solana/kit';
import * as E from '@project-qf/engine';
import type { DecodedInstruction, DecodedTransaction } from './decoder.ts';
import { validateTerms, type ApprovedTerms, type QfTerms } from './terms.ts';

const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: ArrayLike<number> | undefined) => (b ? Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('') : '');

/**
 * The instructions a transaction of these terms holds, without compute budget. With a wrapped-SOL quote the person's
 * SOL is wrapped just before a buy and their wrapped-SOL account is closed at the end, so what they receive or have
 * left arrives as plain SOL in their wallet.
 */
export async function qfInstructions(t: QfTerms): Promise<Instruction[]> {
  const native = t.quoteMint === E.NATIVE_MINT;
  const quoteAta = async (owner: string) => E.ata(owner, t.quoteMint, E.TOKEN);
  const coinAccount = (owner: string) => E.createAtaIdempotentIx(owner, owner, t.baseMint, E.TOKEN_2022);
  const quoteAccount = (owner: string) => E.createAtaIdempotentIx(owner, owner, t.quoteMint, E.TOKEN);
  const unwrap = async (owner: string) => (native ? [E.closeAccountIx(await quoteAta(owner), owner, owner)] : []);
  switch (t.kind) {
    case 'QF_CREATE':
      return [await E.createLaunchIx({ creator: t.creator, mint: t.baseMint, quoteMint: t.quoteMint, ammConfig: t.ammConfig, name: t.name, symbol: t.symbol, uri: t.uri })];
    case 'QF_SWAP':
    case 'QF_POOL_SWAP': {
      const buy = t.direction === 'QUOTE_TO_BASE';
      const amountIn = BigInt(t.amountIn), minOut = BigInt(t.minimumAmountOut);
      const wrap = native && buy ? [E.transferSolIx(t.user, await quoteAta(t.user), amountIn), E.syncNativeIx(await quoteAta(t.user))] : [];
      const trade = t.kind === 'QF_POOL_SWAP'
        ? await E.coinPoolSwapIx({ payer: t.user, mint: t.baseMint, quoteMint: t.quoteMint, ammConfig: t.ammConfig, side: buy ? 'buy' : 'sell', amountIn, minOut })
        : buy ? await E.buyIx({ trader: t.user, mint: t.baseMint, quoteMint: t.quoteMint, quoteIn: amountIn, minBaseOut: minOut })
          : await E.sellIx({ trader: t.user, mint: t.baseMint, quoteMint: t.quoteMint, baseIn: amountIn, minQuoteOut: minOut });
      return [...(buy ? [await coinAccount(t.user)] : []), await quoteAccount(t.user), ...wrap, trade, ...(await unwrap(t.user))];
    }
    case 'QF_CLAIM_CREATOR_FEES':
      return [await quoteAccount(t.creator), await E.claimCreatorFeesIx({ mint: t.baseMint, quoteMint: t.quoteMint, to: await quoteAta(t.creator) }), ...(await unwrap(t.creator))];
    case 'QF_COLLECT_POOL_CREATOR_FEE':
      // the pool program creates the creator's token accounts itself when missing (the creator pays, as payer)
      return [await E.collectPoolCreatorFeeIx({ payer: t.creator, creator: t.creator, mint: t.baseMint, quoteMint: t.quoteMint, ammConfig: t.ammConfig }), ...(await unwrap(t.creator))];
  }
}

/** One ComputeBudget instruction: SetComputeUnitLimit / SetComputeUnitPrice within the approved caps, nothing else. */
export function checkComputeBudget(ix: DecodedInstruction, terms: ApprovedTerms, at: string): { v: string[]; limit: number; price: number } {
  const v: string[] = [];
  const data = fromHex(ix.dataHex);
  if (ix.accounts.length) v.push(`COMPUTE_BUDGET_WITH_ACCOUNTS ${at}`);
  if (data[0] === 2 && data.length === 5) {
    const units = data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! * 2 ** 24);
    if (units > terms.compute.maxUnitLimit) v.push(`COMPUTE_LIMIT_EXCEEDS_CAP ${units} > ${terms.compute.maxUnitLimit} ${at}`);
    return { v, limit: 1, price: 0 };
  }
  if (data[0] === 3 && data.length === 9) {
    let price = 0n; for (let j = 8; j >= 1; j--) price = (price << 8n) | BigInt(data[j]!);
    if (price > BigInt(terms.compute.maxUnitPriceMicroLamports)) v.push(`COMPUTE_PRICE_EXCEEDS_CAP ${price} > ${terms.compute.maxUnitPriceMicroLamports} ${at}`);
    return { v, limit: 0, price: 1 };
  }
  v.push(`COMPUTE_BUDGET_UNSUPPORTED ${ix.dataHex.slice(0, 2)} ${at}`);
  return { v, limit: 0, price: 0 };
}

/** A short name for an instruction in a violation message. */
function label(ix: { programAddress: string; data?: ArrayLike<number> | undefined }): string {
  const d = ix.data ?? [];
  for (const idl of [E.CURVE_IDL, E.POOL_IDL]) {
    if (ix.programAddress !== idl.provenance.programId) continue;
    const op = idl.instructions.find((i) => d.length >= 8 && i.discriminator.every((b: number, k: number) => d[k] === b));
    return op ? op.name : `${idl.provenance.idlName} instruction`;
  }
  if (ix.programAddress === E.ASSOCIATED_TOKEN) return 'create token account';
  if (ix.programAddress === E.SYSTEM) return 'SOL transfer';
  if (ix.programAddress === E.TOKEN) return d[0] === 17 ? 'sync wrapped SOL' : d[0] === 9 ? 'close token account' : 'token instruction';
  return ix.programAddress;
}

/** Binds a decoded transaction to engine terms. Returns violations; empty means it is exactly what the terms build. */
export async function bindQfTransaction(d: DecodedTransaction, t: QfTerms): Promise<string[]> {
  const tv = validateTerms(t);
  if (tv.length) return tv;
  const v: string[] = [];
  if (d.addressTableLookups > 0) v.push('ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED_IN_PREVIEW');
  if (d.feePayer !== t.feePayer) v.push('FEE_PAYER_MISMATCH');
  let limitSeen = 0, priceSeen = 0;
  const rest: { at: string; ix: DecodedTransaction['instructions'][number] }[] = [];
  for (const [k, ix] of d.instructions.entries()) {
    if (ix.programAddress !== E.COMPUTE_BUDGET) { rest.push({ at: `#${k}`, ix }); continue; }
    if (rest.length) v.push(`COMPUTE_BUDGET_NOT_FIRST #${k}`);
    const r = checkComputeBudget(ix, t, `#${k}`);
    v.push(...r.v); limitSeen += r.limit; priceSeen += r.price;
  }
  if (limitSeen > 1 || priceSeen > 1) v.push('COMPUTE_BUDGET_DUPLICATE');
  const want = await qfInstructions(t);
  if (rest.length !== want.length) v.push(`INSTRUCTION_COUNT ${rest.length} (expected ${want.length}: ${want.map(label).join(', ')})`);
  for (const [j, w] of want.entries()) {
    const got = rest[j];
    if (!got) continue;
    const name = label(w);
    if (got.ix.programAddress !== w.programAddress) { v.push(`WRONG_PROGRAM ${got.ix.programAddress} (expected ${name}) ${got.at}`); continue; }
    const accounts = (w.accounts ?? []).map((a) => a.address as string);
    if (got.ix.accounts.length !== accounts.length || got.ix.accounts.some((a, k) => a !== accounts[k])) v.push(`ACCOUNTS_MISMATCH ${name} ${got.at}`);
    if (got.ix.dataHex !== hex(w.data)) v.push(`DATA_MISMATCH ${name} ${got.at}`);
  }
  const signers = new Set<string>([t.feePayer]), writable = new Set<string>([t.feePayer]);
  for (const w of want) for (const a of w.accounts ?? []) {
    if (isSignerRole(a.role)) signers.add(a.address);
    if (isWritableRole(a.role)) writable.add(a.address);
  }
  for (const s of d.signers) if (!signers.has(s)) v.push(`UNEXPECTED_SIGNER ${s}`);
  for (const s of signers) if (!d.signers.includes(s)) v.push(`REQUIRED_SIGNER_MISSING ${s}`);
  for (const a of d.writableAccounts) if (!writable.has(a)) v.push(`UNEXPECTED_WRITABLE ${a}`);
  for (const a of writable) if (!d.writableAccounts.includes(a)) v.push(`MISSING_WRITABLE ${a}`);
  return [...new Set(v)];
}

/** Binds a decoded transaction to approved terms (QF-SEC-01). Returns violations; empty means every instruction is accounted for. */
export const bindTransactionToTerms = (d: DecodedTransaction, terms: ApprovedTerms): Promise<string[]> => bindQfTransaction(d, terms);
