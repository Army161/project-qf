// Semantic transaction binding (QF-SEC-01). Every top-level instruction must be decoded under a pinned
// format and bound to the approved terms: operation, arguments, every account, signer set, writable set,
// supporting ATA / ComputeBudget instructions, and compute caps. Anything not bound is a violation.
// Browser-safe (Solana Kit only).
import { PROGRAM_IDS } from './programs.ts';
import type { DecodedInstruction, DecodedTransaction } from './decoder.ts';
import { validateTerms, type ApprovedTerms } from './terms.ts';
import { DBC_IDL_SUBSET } from './engine/dbc-idl-subset.ts';
import { DAMM_IDL_SUBSET } from './engine/damm-idl-subset.ts';
import type { IdlSubset } from './engine/idl-types.ts';
import { decodeExact, type Decoded } from './engine/borsh.ts';
import type { IdlInstruction } from './engine/idl-types.ts';
import * as D from './engine/pda.ts';
import { canonicalJson } from '@project-qf/core';
import { sha256Hex } from './terms.ts';
import { bindTreasury } from './treasury.ts';

const P = PROGRAM_IDS;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const OP_FOR_KIND: Record<Exclude<ApprovedTerms['kind'], `TREASURY_${string}`>, string> = {
  CREATE_CONFIG: 'create_config', CREATE_POOL: 'initialize_virtual_pool_with_spl_token', SWAP: 'swap',
  MIGRATE_DAMM_V2: 'migration_damm_v2', CLAIM_PARTNER_TRADING_FEE: 'claim_trading_fee', CLAIM_CREATOR_TRADING_FEE: 'claim_creator_trading_fee',
  DAMM_SWAP: 'swap', DAMM_CLAIM_POSITION_FEE: 'claim_position_fee',
};
/** The one engine program a transaction of each kind may call, and the pinned format its instruction is decoded under. */
interface Engine { program: string; label: string; subset: IdlSubset }
const DBC_ENGINE: Engine = { program: P.DBC, label: 'DBC', subset: DBC_IDL_SUBSET };
const DAMM_ENGINE: Engine = { program: P.DAMM_V2, label: 'DAMM', subset: DAMM_IDL_SUBSET };
type EngineTerms = Exclude<ApprovedTerms, { kind: `TREASURY_${string}` }>;
const engineFor = (kind: ApprovedTerms['kind']) => (kind === 'DAMM_SWAP' || kind === 'DAMM_CLAIM_POSITION_FEE' ? DAMM_ENGINE : DBC_ENGINE);

/** Digest of a ConfigParameters value in decoded (snake_case, bigint) form; the adapter computes the same via normalizeToIdl. */
export const configParametersDigest = (value: Decoded) => sha256Hex(canonicalJson({ domain: 'QF-DBC-CONFIG-PARAMETERS', value }));

interface Expected {
  op: IdlInstruction;
  accounts: Record<string, string | { ephemeral: string }>; // ephemeral: a fresh signer whose derived accounts are checked
  remaining: { required: string[]; optional: string[] };
  signers: Set<string>;
  ephemeralSigners: number;
  atas: { owner: string; mint: string; tokenProgram: string; address: string }[];
  checkArgs: (a: Record<string, Decoded>) => Promise<string[]>;
}

async function expectedFor(t: EngineTerms): Promise<{ e: Expected; termViolations: string[] }> {
  const op = engineFor(t.kind).subset.instructions.find((i) => i.name === OP_FOR_KIND[t.kind])!;
  const common = { event_authority: await D.dbcEventAuthority(), program: P.DBC, system_program: P.SYSTEM, pool_authority: D.DBC_POOL_AUTHORITY };
  const tv: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => (a === b ? [] : [`ARG_MISMATCH ${name}`]);
  switch (t.kind) {
    case 'CREATE_CONFIG':
      return { termViolations: tv, e: { op, remaining: { required: [], optional: [] }, ephemeralSigners: 0, atas: [],
        signers: new Set([t.feePayer, t.payer, t.config]),
        accounts: { ...common, config: t.config, fee_claimer: t.feeClaimer, leftover_receiver: t.leftoverReceiver, quote_mint: t.quoteMint, payer: t.payer },
        checkArgs: async (a) => {
          const cp = a.config_parameters as Record<string, Decoded>;
          const v: string[] = [];
          if (await configParametersDigest(cp) !== t.configParametersDigest) v.push('ARG_MISMATCH config_parameters (digest differs from approved)');
          if (cp.token_type !== 0) v.push('ARG_POLICY token_type must be SPL Token in V0 (transfer-fee launches disabled)');
          return v;
        } } };
    case 'CREATE_POOL': {
      const pool = await D.dbcPool(t.config, t.baseMint, t.quoteMint);
      return { termViolations: tv, e: { op, remaining: { required: [], optional: [] }, ephemeralSigners: 0, atas: [],
        signers: new Set([t.feePayer, t.creator, t.baseMint, t.payer]),
        accounts: { ...common, config: t.config, creator: t.creator, base_mint: t.baseMint, quote_mint: t.quoteMint, pool,
          base_vault: await D.dbcVault(t.baseMint, pool), quote_vault: await D.dbcVault(t.quoteMint, pool), mint_metadata: await D.mintMetadata(t.baseMint),
          metadata_program: P.METAPLEX_METADATA, payer: t.payer, token_quote_program: t.quoteTokenProgram, token_program: P.TOKEN },
        checkArgs: async (a) => { const p = a.params as Record<string, Decoded>; return [...eq('name', p.name, t.name), ...eq('symbol', p.symbol, t.symbol), ...eq('uri', p.uri, t.uri)]; } } };
    }
    case 'SWAP': {
      const pool = await D.dbcPool(t.config, t.baseMint, t.quoteMint);
      if (pool !== t.pool) tv.push('TERMS_POOL_NOT_DERIVED_FROM_CONFIG_AND_MINTS');
      const q2b = t.direction === 'QUOTE_TO_BASE';
      const [inMint, inProg, outMint, outProg] = q2b ? [t.quoteMint, t.quoteTokenProgram, t.baseMint, t.baseTokenProgram] : [t.baseMint, t.baseTokenProgram, t.quoteMint, t.quoteTokenProgram];
      const inAta = await D.ata(t.user, inMint, inProg), outAta = await D.ata(t.user, outMint, outProg);
      return { termViolations: tv, e: { op, ephemeralSigners: 0, signers: new Set([t.feePayer, t.user]),
        remaining: { required: [], optional: t.allowSysvarInstructions ? [D.SYSVAR_INSTRUCTIONS] : [] },
        atas: [{ owner: t.user, mint: inMint, tokenProgram: inProg, address: inAta }, { owner: t.user, mint: outMint, tokenProgram: outProg, address: outAta }],
        accounts: { ...common, config: t.config, pool, input_token_account: inAta, output_token_account: outAta,
          base_vault: await D.dbcVault(t.baseMint, pool), quote_vault: await D.dbcVault(t.quoteMint, pool), base_mint: t.baseMint, quote_mint: t.quoteMint,
          payer: t.user, token_base_program: t.baseTokenProgram, token_quote_program: t.quoteTokenProgram, referral_token_account: t.referralTokenAccount ?? P.DBC },
        checkArgs: async (a) => {
          const p = a.params as Record<string, Decoded>;
          const v = eq('amount_in', String(p.amount_in), t.amountIn);
          if (BigInt(p.minimum_amount_out as bigint) < BigInt(t.minimumAmountOut)) v.push('ARG_BELOW_APPROVED minimum_amount_out');
          return v;
        } } };
    }
    case 'DAMM_SWAP': {
      const pool = await D.dammPool(t.dammConfig, t.baseMint, t.quoteMint);
      if (pool !== t.pool) tv.push('TERMS_POOL_NOT_DERIVED_FROM_DAMM_CONFIG_AND_MINTS');
      const q2b = t.direction === 'QUOTE_TO_BASE';
      const [inMint, inProg, outMint, outProg] = q2b ? [t.quoteMint, t.quoteTokenProgram, t.baseMint, t.baseTokenProgram] : [t.baseMint, t.baseTokenProgram, t.quoteMint, t.quoteTokenProgram];
      const inAta = await D.ata(t.user, inMint, inProg), outAta = await D.ata(t.user, outMint, outProg);
      return { termViolations: tv, e: { op, ephemeralSigners: 0, signers: new Set([t.feePayer, t.user]), remaining: { required: [], optional: [] },
        atas: [{ owner: t.user, mint: inMint, tokenProgram: inProg, address: inAta }, { owner: t.user, mint: outMint, tokenProgram: outProg, address: outAta }],
        // A graduated launch's pool holds the base token as token A and the quote token as token B.
        accounts: { pool_authority: await D.dammPoolAuthority(), pool, input_token_account: inAta, output_token_account: outAta,
          token_a_vault: await D.dammVault(t.baseMint, pool), token_b_vault: await D.dammVault(t.quoteMint, pool), token_a_mint: t.baseMint, token_b_mint: t.quoteMint,
          payer: t.user, token_a_program: t.baseTokenProgram, token_b_program: t.quoteTokenProgram, referral_token_account: P.DAMM_V2,
          event_authority: await D.dammEventAuthority(), program: P.DAMM_V2 },
        checkArgs: async (a) => {
          const p = a._params as Record<string, Decoded>;
          const v = eq('amount_in', String(p.amount_in), t.amountIn);
          if (BigInt(p.minimum_amount_out as bigint) < BigInt(t.minimumAmountOut)) v.push('ARG_BELOW_APPROVED minimum_amount_out');
          return v;
        } } };
    }
    case 'DAMM_CLAIM_POSITION_FEE': {
      const pool = await D.dammPool(t.dammConfig, t.baseMint, t.quoteMint);
      if (pool !== t.pool) tv.push('TERMS_POOL_NOT_DERIVED_FROM_DAMM_CONFIG_AND_MINTS');
      const a = await D.ata(t.owner, t.baseMint, t.baseTokenProgram), b = await D.ata(t.owner, t.quoteMint, t.quoteTokenProgram);
      return { termViolations: tv, e: { op, ephemeralSigners: 0, signers: new Set([t.feePayer, t.owner]), remaining: { required: [], optional: [] },
        atas: [{ owner: t.owner, mint: t.baseMint, tokenProgram: t.baseTokenProgram, address: a }, { owner: t.owner, mint: t.quoteMint, tokenProgram: t.quoteTokenProgram, address: b }],
        // fees go only to the position owner's own accounts; the program checks the owner holds the position NFT
        accounts: { pool_authority: await D.dammPoolAuthority(), pool, position: await D.dammPosition(t.positionNftMint), token_a_account: a, token_b_account: b,
          token_a_vault: await D.dammVault(t.baseMint, pool), token_b_vault: await D.dammVault(t.quoteMint, pool), token_a_mint: t.baseMint, token_b_mint: t.quoteMint,
          position_nft_account: await D.dammPositionNftAccount(t.positionNftMint), signer: t.owner, token_a_program: t.baseTokenProgram, token_b_program: t.quoteTokenProgram,
          event_authority: await D.dammEventAuthority(), program: P.DAMM_V2 },
        checkArgs: async () => [] } };
    }
    case 'MIGRATE_DAMM_V2': {
      const pool = await D.dbcPool(t.config, t.baseMint, t.quoteMint);
      if (pool !== t.pool) tv.push('TERMS_POOL_NOT_DERIVED_FROM_CONFIG_AND_MINTS');
      const dPool = await D.dammPool(t.dammConfig, t.baseMint, t.quoteMint);
      return { termViolations: tv, e: { op, ephemeralSigners: 2, signers: new Set([t.feePayer, t.payer]), atas: [],
        remaining: { required: [t.dammConfig], optional: [] },
        accounts: { system_program: P.SYSTEM, pool_authority: D.DBC_POOL_AUTHORITY, virtual_pool: pool, migration_metadata: await D.dammMigrationMetadata(pool), config: t.config, pool: dPool,
          first_position_nft_mint: { ephemeral: 'first' }, first_position_nft_account: { ephemeral: 'first:nft_account' }, first_position: { ephemeral: 'first:position' },
          second_position_nft_mint: { ephemeral: 'second' }, second_position_nft_account: { ephemeral: 'second:nft_account' }, second_position: { ephemeral: 'second:position' },
          damm_pool_authority: await D.dammPoolAuthority(), amm_program: P.DAMM_V2, base_mint: t.baseMint, quote_mint: t.quoteMint,
          token_a_vault: await D.dammVault(t.baseMint, dPool), token_b_vault: await D.dammVault(t.quoteMint, dPool),
          base_vault: await D.dbcVault(t.baseMint, pool), quote_vault: await D.dbcVault(t.quoteMint, pool), payer: t.payer,
          token_base_program: t.baseTokenProgram, token_quote_program: t.quoteTokenProgram, token_2022_program: P.TOKEN_2022, damm_event_authority: await D.dammEventAuthority() },
        checkArgs: async () => [] } };
    }
    case 'CLAIM_PARTNER_TRADING_FEE':
    case 'CLAIM_CREATOR_TRADING_FEE': {
      const pool = await D.dbcPool(t.config, t.baseMint, t.quoteMint);
      if (pool !== t.pool) tv.push('TERMS_POOL_NOT_DERIVED_FROM_CONFIG_AND_MINTS');
      const a = await D.ata(t.receiver, t.baseMint, t.baseTokenProgram), b = await D.ata(t.receiver, t.quoteMint, t.quoteTokenProgram);
      const partner = t.kind === 'CLAIM_PARTNER_TRADING_FEE';
      const authority = partner ? t.feeClaimer : t.creator;
      const [nA, nB] = partner ? ['max_amount_a', 'max_amount_b'] : ['max_base_amount', 'max_quote_amount'];
      return { termViolations: tv, e: { op, ephemeralSigners: 0, signers: new Set([t.feePayer, authority]), remaining: { required: [], optional: [] },
        atas: [{ owner: t.receiver, mint: t.baseMint, tokenProgram: t.baseTokenProgram, address: a }, { owner: t.receiver, mint: t.quoteMint, tokenProgram: t.quoteTokenProgram, address: b }],
        accounts: { ...common, ...(partner ? { config: t.config, fee_claimer: authority } : { creator: authority }), pool, token_a_account: a, token_b_account: b,
          base_vault: await D.dbcVault(t.baseMint, pool), quote_vault: await D.dbcVault(t.quoteMint, pool), base_mint: t.baseMint, quote_mint: t.quoteMint,
          token_base_program: t.baseTokenProgram, token_quote_program: t.quoteTokenProgram },
        checkArgs: async (x) => [...eq(nA, String(x[nA]), t.maxBaseAmount), ...eq(nB, String(x[nB]), t.maxQuoteAmount)] } };
    }
  }
}

function decodeEngine(ix: DecodedInstruction, en: Engine): { op: IdlInstruction; args: Record<string, Decoded> } | { error: string } {
  const data = fromHex(ix.dataHex);
  if (data.length < 8) return { error: `${en.label}_DECODE_FAILED data shorter than discriminator` };
  const op = en.subset.instructions.find((i) => i.discriminator.every((b, k) => data[k] === b));
  if (!op) return { error: `${en.label}_UNKNOWN_INSTRUCTION discriminator ${ix.dataHex.slice(0, 16)}` };
  try { return { op, args: decodeExact(data.subarray(8), op.args, en.subset.types) }; }
  catch (e) { return { error: `${en.label}_DECODE_FAILED ${op.name}: ${(e as Error).message}` }; }
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

/** Evidence some bindings need besides the transaction: execute runs what the multisig stored, so the stored
 *  VaultTransaction account (raw data) must be supplied and is bound to the approved inner terms too. */
export interface BindingContext { vaultTransactionAccount?: Uint8Array }

/** Binds a decoded transaction to approved terms. Returns violations; empty means every instruction is accounted for. */
export async function bindTransactionToTerms(d: DecodedTransaction, terms: ApprovedTerms, ctx: BindingContext = {}): Promise<string[]> {
  const tv = validateTerms(terms);
  if (tv.length) return tv;
  if (terms.kind === 'TREASURY_PROPOSE' || terms.kind === 'TREASURY_APPROVE' || terms.kind === 'TREASURY_EXECUTE') return bindTreasury(d, terms, ctx);
  const v: string[] = [];
  if (d.addressTableLookups > 0) v.push('ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED_IN_PREVIEW');
  if (d.feePayer !== terms.feePayer) v.push('FEE_PAYER_MISMATCH');
  const { e, termViolations } = await expectedFor(terms);
  const engine = engineFor(terms.kind);
  v.push(...termViolations);

  const writableExpected = new Set<string>([terms.feePayer]);
  const signersExpected = new Set(e.signers);
  let engineCount = 0, limitSeen = 0, priceSeen = 0;
  const atasUsed = new Set<string>();

  for (const [k, ix] of d.instructions.entries()) {
    const at = `#${k}`;
    if (ix.programAddress === engine.program) {
      engineCount++;
      const r = decodeEngine(ix, engine);
      if ('error' in r) { v.push(`${r.error} ${at}`); continue; }
      if (r.op.name !== e.op.name) { v.push(`WRONG_OPERATION ${r.op.name} (approved ${e.op.name}) ${at}`); continue; }
      const n = r.op.accounts.length;
      const extra = ix.accounts.slice(n);
      if (ix.accounts.length < n) { v.push(`ACCOUNT_COUNT ${ix.accounts.length} < ${n} ${at}`); continue; }
      const eph: Record<string, string> = {};
      for (const [j, meta] of r.op.accounts.entries()) {
        const got = ix.accounts[j]!;
        const want = e.accounts[meta.name];
        if (want === undefined) { v.push(`INTERNAL_NO_EXPECTATION ${meta.name}`); continue; }
        if (typeof want === 'object') {
          if (!want.ephemeral.includes(':')) eph[want.ephemeral] = got;
          continue;
        }
        if (meta.address && got !== meta.address) v.push(`ACCOUNT_MISMATCH ${meta.name} (fixed address) ${at}`);
        if (got !== want) v.push(`ACCOUNT_MISMATCH ${meta.name} ${at}`);
        if (meta.writable && !(meta.name === 'referral_token_account' && got === engine.program)) {
          writableExpected.add(got);
          if (!d.writableAccounts.includes(got)) v.push(`MISSING_WRITABLE ${meta.name} ${at}`);
        }
        if (meta.signer && !d.signers.includes(got)) v.push(`REQUIRED_SIGNER_MISSING ${meta.name} ${at}`);
      }
      // ephemeral signers (DAMM position NFT mints): fresh, distinct, and their derived accounts must match
      if (e.ephemeralSigners) {
        const known = new Set(Object.values(e.accounts).filter((x): x is string => typeof x === 'string'));
        const mints = [eph.first, eph.second].filter((x): x is string => !!x);
        if (mints.length !== e.ephemeralSigners || new Set(mints).size !== mints.length) v.push(`EPHEMERAL_SIGNERS_INVALID ${at}`);
        for (const [slot, mint] of [['first', eph.first], ['second', eph.second]] as const) {
          if (!mint) continue;
          if (known.has(mint) || mint === terms.feePayer) v.push(`EPHEMERAL_SIGNER_REUSES_KNOWN_ACCOUNT ${slot} ${at}`);
          if (!d.signers.includes(mint)) v.push(`REQUIRED_SIGNER_MISSING ${slot}_position_nft_mint ${at}`);
          signersExpected.add(mint);
          const idx = r.op.accounts.findIndex((m) => m.name === `${slot}_position_nft_mint`);
          const nftAcc = ix.accounts[idx + 1], pos = ix.accounts[idx + 2];
          if (nftAcc !== await D.dammPositionNftAccount(mint)) v.push(`ACCOUNT_MISMATCH ${slot}_position_nft_account ${at}`);
          if (pos !== await D.dammPosition(mint)) v.push(`ACCOUNT_MISMATCH ${slot}_position ${at}`);
          for (const a of [mint, nftAcc, pos]) if (a) writableExpected.add(a);
        }
      }
      // remaining accounts: exactly the required ones, plus approved optional ones, read-only
      const req = [...e.remaining.required];
      for (const a of extra) {
        const i = req.indexOf(a);
        if (i >= 0) req.splice(i, 1);
        else if (!e.remaining.optional.includes(a)) v.push(`UNEXPECTED_REMAINING_ACCOUNT ${a} ${at}`);
        if (d.writableAccounts.includes(a) && !writableExpected.has(a)) v.push(`REMAINING_ACCOUNT_WRITABLE ${a} ${at}`);
      }
      for (const a of req) v.push(`MISSING_REMAINING_ACCOUNT ${a} ${at}`);
      v.push(...(await e.checkArgs(r.args)).map((x) => `${x} ${at}`));
    } else if (ix.programAddress === P.COMPUTE_BUDGET) {
      const r = checkComputeBudget(ix, terms, at);
      v.push(...r.v); limitSeen += r.limit; priceSeen += r.price;
    } else if (ix.programAddress === P.ASSOCIATED_TOKEN) {
      // CreateIdempotent only: [payer(W,S), ata(W), owner, mint, system, token program]
      const [payer, addr, owner, mint, sys, tokenProg] = ix.accounts;
      const bound = e.atas.find((x) => x.address === addr && x.owner === owner && x.mint === mint && x.tokenProgram === tokenProg);
      if (ix.dataHex !== '01' || ix.accounts.length !== 6 || sys !== P.SYSTEM) v.push(`ATA_NOT_CREATE_IDEMPOTENT ${at}`);
      else if (!bound) v.push(`ATA_NOT_BOUND owner=${owner} mint=${mint} ${at}`);
      else if (payer !== terms.feePayer) v.push(`ATA_PAYER_NOT_FEE_PAYER ${at}`);
      else if (atasUsed.has(addr!)) v.push(`ATA_DUPLICATE ${at}`);
      else { atasUsed.add(addr!); writableExpected.add(addr!); }
    } else if (([P.SYSTEM, P.TOKEN, P.TOKEN_2022] as string[]).includes(ix.programAddress)) {
      v.push(`UNBOUND_INSTRUCTION ${ix.programAddress} ${at}`);
    } else {
      v.push(`UNEXPECTED_PROGRAM ${ix.programAddress} ${at}`);
    }
  }
  if (engineCount === 0) v.push('NO_ENGINE_INSTRUCTION');
  if (engineCount > 1) v.push(`MULTIPLE_ENGINE_INSTRUCTIONS ${engineCount}`);
  if (limitSeen > 1 || priceSeen > 1) v.push('COMPUTE_BUDGET_DUPLICATE');
  for (const s of d.signers) if (!signersExpected.has(s)) v.push(`UNEXPECTED_SIGNER ${s}`);
  for (const s of e.signers) if (!d.signers.includes(s)) v.push(`REQUIRED_SIGNER_MISSING ${s}`);
  for (const w of d.writableAccounts) if (!writableExpected.has(w)) v.push(`UNEXPECTED_WRITABLE ${w}`);
  return [...new Set(v)];
}
