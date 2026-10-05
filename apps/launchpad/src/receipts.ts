// Fee-claim receipts. A receipt's amount is what left that claim's own pool vaults in its own confirmed transaction.
// The vaults are fixed when the claim is recorded: derived from the terms its transaction was bound to (pool and mints),
// never from whichever pools happen to be readable later. Missing evidence (no transaction details, a vault the
// transaction does not touch, no balance observation for a vault) leaves the receipt UNKNOWN; it never becomes a zero.
import { derive, type ApprovedTerms } from '@project-qf/tx';
import type { LaunchpadChain, TxSummary } from './chain.ts';
import type { ClaimRow, ClaimStatus, LaunchRow, LaunchpadStore } from './store.ts';

export interface ClaimIdentity { venue: ClaimRow['venue']; pool: string; quoteVault: string; baseVault: string }
export const CLAIM_KINDS = Object.freeze({ CLAIM_CREATOR_TRADING_FEE: 'CURVE', DAMM_CLAIM_POSITION_FEE: 'DAMM_V2' } as const);

/** The pool and vaults a claim transaction was bound to, checked against the coin it is recorded for. Null when the
 *  terms are not a claim of that coin on that venue. */
export async function claimIdentity(terms: ApprovedTerms, l: Pick<LaunchRow, 'mint' | 'quoteMint' | 'pool' | 'dammPool'>): Promise<ClaimIdentity | null> {
  if (terms.kind !== 'CLAIM_CREATOR_TRADING_FEE' && terms.kind !== 'CLAIM_PARTNER_TRADING_FEE' && terms.kind !== 'DAMM_CLAIM_POSITION_FEE') return null;
  if (terms.baseMint !== l.mint || terms.quoteMint !== l.quoteMint) return null;
  if (terms.kind === 'CLAIM_CREATOR_TRADING_FEE' || terms.kind === 'CLAIM_PARTNER_TRADING_FEE') {
    if (terms.pool !== l.pool) return null;
    return { venue: 'CURVE', pool: terms.pool, quoteVault: await derive.dbcVault(terms.quoteMint, terms.pool), baseVault: await derive.dbcVault(terms.baseMint, terms.pool) };
  }
  if (!l.dammPool || terms.pool !== l.dammPool) return null;
  return { venue: 'DAMM_V2', pool: terms.pool, quoteVault: await derive.dammVault(terms.quoteMint, terms.pool), baseVault: await derive.dammVault(terms.baseMint, terms.pool) };
}

export type Receipt = { status: ClaimStatus; evidence: string; quoteRaw: string | null; baseRaw: string | null };
const unknown = (evidence: string): Receipt => ({ status: 'UNKNOWN', evidence, quoteRaw: null, baseRaw: null });

/** What one claim paid out, from its transaction. Definitive only when both vaults are in the transaction and both
 *  balances were observed; a zero is stored only on that complete evidence (or when the transaction failed). */
export function claimReceipt(id: { quoteVault: string | null; baseVault: string | null }, sum: TxSummary | null): Receipt {
  if (!id.quoteVault || !id.baseVault) return unknown('NO_VAULT_IDENTITY');
  if (!sum) return unknown('NO_TX_DETAILS');
  if (sum.err) return { status: 'FAILED_TX', evidence: 'TX_FAILED', quoteRaw: '0', baseRaw: '0' }; // a failed transaction moved nothing
  const vaults = [id.quoteVault, id.baseVault];
  if (!vaults.every((v) => sum.accountKeys.includes(v))) return unknown('VAULT_NOT_IN_TX');
  if (!vaults.every((v) => Object.hasOwn(sum.tokenDeltas, v))) return unknown('NO_BALANCE_OBSERVATION');
  const [dq, db] = vaults.map((v) => sum.tokenDeltas[v]!) as [bigint, bigint];
  if (dq > 0n || db > 0n) return unknown('VAULT_INFLOW'); // a claim only takes from the vaults; anything else is not this claim
  return { status: 'RESOLVED', evidence: 'TX_VAULT_DELTAS', quoteRaw: (-dq).toString(), baseRaw: (-db).toString() };
}

/** Fills in the identity of receipts recorded before identities were kept (from their confirmed intent), then checks up
 *  to `budget` unresolved receipts against their transactions. Safe to call repeatedly; the RPC is shared, so it is bounded. */
export async function resolveClaims(o: { store: LaunchpadStore; chain: Pick<LaunchpadChain, 'txSummary'> }, budget: number): Promise<void> {
  for (const c of o.store.unresolvedClaims(budget)) {
    let id: { quoteVault: string | null; baseVault: string | null } = c;
    if (!c.pool) {
      const intent = o.store.confirmedIntentBySignature(c.sig);
      const l = o.store.getLaunch(c.mint);
      const found = intent && l && CLAIM_KINDS[intent.kind as keyof typeof CLAIM_KINDS] === c.venue
        ? await claimIdentity((JSON.parse(intent.termsJson) as { terms: ApprovedTerms }).terms, l) : null;
      if (found && found.venue === c.venue) { o.store.setClaimIdentity(c.sig, found); id = found; }
      else { o.store.setClaimEvidence(c.sig, unknown('NO_VAULT_IDENTITY')); continue; }
    }
    const sum = await o.chain.txSummary(c.sig).catch(() => null);
    o.store.setClaimEvidence(c.sig, claimReceipt(id, sum));
  }
}
