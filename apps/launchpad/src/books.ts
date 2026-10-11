// The books: does every fee recorded trade by trade add up to what the chain holds plus what was claimed, and does the
// treasury vault hold exactly the proven claim receipts? Read-only. `main.ts verify` prints these checks as PASS/FAIL;
// the app's pages do not show them.
import type { LaunchpadChain, LiveDammPool } from './chain.ts';
import type { DammCache, PoolCache } from './indexer.ts';
import { storedCoverage, toBalanceChanges } from './holders.ts';
import { explainLpResidual, type LpResidualProof } from './lp-residual.ts';
import { feeClaimerFor, type PlatformRecord } from './platform.ts';
import { resolveClaims } from './receipts.ts';
import { coinRewards, type CoinRewards } from './rewards.ts';
import { depositsFor, payoutsFor, rewardsVaultOf, storedVaultCoverage } from './rewards-vault.ts';
import { sumFees, type ClaimRow, type FeeTotals, type LaunchRow, type LaunchpadStore } from './store.ts';

/** Per-coin check that the fees recorded trade by trade add up to what the chain holds and what was claimed:
 *    curve: creator and platform shares from trades = the pool's unclaimed counter + proven claims through the app;
 *    LP (after graduation): LP fees from trades = the positions' unclaimed fees + proven claims.
 *  MATCH only on an exact match. On the LP side the trades may say a few raw units more than the positions hold (the
 *  program rounds down when it shares a fee out to positions): such a difference, up to `residualBound`, is RESIDUAL, kept
 *  explicit with its amount. Its origin is NOT_PROVEN until the pool's own fee accounting explains it (lp-residual.ts);
 *  then it is PROVEN_ROUNDING, with the proof attached. A small difference is never relabelled as a match. Anything else is MISMATCH; missing inputs make it INCOMPLETE with the
 *  reasons. A claim made outside this app is not in the receipts and shows as a MISMATCH. */
export type CheckStatus = 'MATCH' | 'RESIDUAL' | 'MISMATCH' | 'INCOMPLETE';
export interface FeeCheck { fromTradesRaw: string; onChainRaw: string | null; claimedRaw: string; differenceRaw: string | null; status: CheckStatus; reasons: string[];
  residual?: { raw: string; boundRaw: string; origin: 'NOT_PROVEN' | 'PROVEN_ROUNDING'; note: string; proof?: LpResidualProof } }
/** Largest LP residual per DAMM v2 trade that is reported as RESIDUAL rather than MISMATCH. */
export const LP_RESIDUAL_BOUND_PER_TRADE = 2n;
export function feeCheck(fromTrades: bigint, unclaimed: string | null, claimed: bigint, reasons: string[], residualBound = 0n): FeeCheck {
  const onChain = unclaimed === null ? null : BigInt(unclaimed) + claimed;
  const diff = onChain === null ? null : fromTrades - onChain;
  const why = [...reasons, ...(onChain === null ? ['the pool or positions could not be read'] : [])];
  const base = { fromTradesRaw: fromTrades.toString(), onChainRaw: onChain === null ? null : onChain.toString(), claimedRaw: claimed.toString(), differenceRaw: diff === null ? null : diff.toString() };
  if (why.length) return { ...base, status: 'INCOMPLETE', reasons: why };
  if (diff === 0n) return { ...base, status: 'MATCH', reasons: [] };
  if (diff! > 0n && diff! <= residualBound) return { ...base, status: 'RESIDUAL', reasons: [],
    residual: { raw: diff!.toString(), boundRaw: residualBound.toString(), origin: 'NOT_PROVEN',
      note: `${diff} raw unit(s) recorded in trades are in no known position or claim. Kept as an explicit residual; its origin is not yet proven from the pool's fee accumulator.` } };
  return { ...base, status: 'MISMATCH', reasons: [] };
}

/** What the devnet treasury's signers are, so the test setup is never read as production control. */
export const TREASURY_SIGNERS_NOTE = 'Devnet stand-in. All three member keys are throwaway test keys held by one operator in one container, so this '
  + 'demonstrates the approval flow, not separation of control. The real signers, threshold and time lock are decided before mainnet.';
export const treasuryView = (p: PlatformRecord) => ({ multisig: p.treasury!.multisig, vault: p.treasury!.vault, threshold: p.treasury!.threshold, members: p.treasury!.members,
  label: p.treasury!.label, signers: 'ONE_OPERATOR_TEST_KEYS' as const, separationOfControl: false, note: TREASURY_SIGNERS_NOTE });

/** The vault's quote balance on chain against what this app proves went in and out: claim receipts in, rewards deposits out
 *  (each an executed treasury proposal whose transaction the rewards vault recorded as a deposit). */
export interface VaultCheck { status: 'MATCH' | 'MISMATCH' | 'INCOMPLETE'; vaultQuoteRaw: string | null; receiptsRaw: string; depositsOutRaw: string; differenceRaw: string | null; reasons: string[] }
export function vaultCheck(vaultQuoteRaw: bigint | null, receiptsRaw: bigint, unresolvedReceipts: number, depositsOutRaw = 0n, unprovenDeposits = 0): VaultCheck {
  const reasons = [...(vaultQuoteRaw === null ? ['the vault balance could not be read'] : []),
    ...(unresolvedReceipts ? [`${unresolvedReceipts} treasury receipt(s) not proven yet`] : []),
    ...(unprovenDeposits ? [`${unprovenDeposits} rewards deposit(s) not read back from the rewards vault yet`] : [])];
  const base = { vaultQuoteRaw: vaultQuoteRaw?.toString() ?? null, receiptsRaw: receiptsRaw.toString(), depositsOutRaw: depositsOutRaw.toString() };
  if (reasons.length) return { status: 'INCOMPLETE', ...base, differenceRaw: null, reasons };
  const d = vaultQuoteRaw! - (receiptsRaw - depositsOutRaw);
  if (d === 0n) return { status: 'MATCH', ...base, differenceRaw: '0', reasons: [] };
  return { status: 'MISMATCH', ...base, differenceRaw: (d < 0n ? -d : d).toString(), reasons: [d > 0n
    ? 'the vault holds more than receipts minus rewards deposits: tokens reached it outside a claim made in this app'
    : 'the vault holds less than receipts minus rewards deposits: tokens left it outside a rewards deposit made in this app'] };
}

/** Unresolved claim receipts checked against their transactions per run (the RPC is shared). */
export const RECEIPT_CHECKS_PER_RUN = 5;
const FINAL_PROPOSAL = new Set(['Executed', 'Rejected', 'Cancelled']);
type Unclaimed = { creatorQuoteRaw: string | null; platformQuoteRaw: string | null };
type ConfigRole = 'CURRENT' | 'LEGACY';
export interface BooksCoin { mint: string; symbol: string; name: string; status: LaunchRow['status']; creator: string;
  curve: Unclaimed | null; lp: Unclaimed | 'UNAVAILABLE' | null; platformWallet: string; treasury: boolean;
  /** the config the coin launched on: CURRENT, or LEGACY (an earlier config, kept unchanged so its coins' fee entitlements hold) */
  configRole: ConfigRole;
  /** fees recorded trade by trade for this coin, and whether they add up to the chain (see feeCheck) */
  fromTrades?: FeeTotals; checks?: { creatorCurve: FeeCheck; platformCurve: FeeCheck; lp: FeeCheck | null } }
export type BooksClaim = ClaimRow & { symbol: string; byCreator: boolean; byTreasury: boolean };
const lpOf = (c: BooksCoin) => (c.lp && c.lp !== 'UNAVAILABLE' ? c.lp : null);

export interface BooksDeps { store: LaunchpadStore; chain: LaunchpadChain; platform: PlatformRecord; pools: PoolCache; damms: DammCache; now: () => Date; cluster: string }

/** What reached the treasury vault through executed proposals (proven receipts only), what is still waiting, and whether
 *  the vault's own balance equals those receipts. The receipts are part of "claimed through the app"; they are not added again. */
async function treasuryBooks(d: BooksDeps, claims: BooksClaim[]) {
  const p = d.platform;
  const mine = claims.filter((c) => c.byTreasury);
  const paid = mine.filter((c) => c.status === 'RESOLVED').reduce((a, c) => a + BigInt(c.quoteRaw!), 0n);
  const unresolvedReceipts = mine.filter((c) => c.status === 'UNKNOWN').length;
  const held = await d.chain.balances(p.treasury!.vault, [p.quote.mint]).then((b) => BigInt(b.tokens[p.quote.mint] ?? '0')).catch(() => null);
  // what left through this app's one outbound route: rewards deposits, each proven by the rewards vault's record of its transaction
  const rv = await rewardsVaultOf(p), vrows = rv ? d.store.listRewardVaultTxs(rv.quoteAccount) : [];
  const proposals = d.store.listTreasuryProposals(p.treasury!.multisig);
  let depositsOut = 0n, unprovenDeposits = 0;
  for (const r of proposals.filter((x) => x.venue === 'REWARDS_DEPOSIT' && x.status === 'Executed')) {
    const row = vrows.find((x) => x.sig === r.executeSig && x.status === 'DONE' && x.kind === 'DEPOSIT');
    if (row) depositsOut += BigInt(row.deltaRaw!); else unprovenDeposits++;
  }
  return { ...treasuryView(p), paidToTreasuryQuoteRaw: paid.toString(), includedIn: 'claimedThroughApp' as const, unresolvedReceipts,
    openProposals: proposals.filter((r) => !FINAL_PROPOSAL.has(r.status)).length,
    vaultCheck: vaultCheck(held, paid, unresolvedReceipts, depositsOut, unprovenDeposits) };
}

/** Per coin: unclaimed curve fees (creator and platform counters in the DBC pool), unclaimed LP fees of the positions the
 *  creator and the platform fee claimer hold in the DAMM v2 pool, the claims made through this app with what they paid
 *  out, and the checks that tie them to the fees recorded trade by trade. Accrued is not claimed, and claimed is not
 *  retained revenue. Nothing here can move funds. */
export async function computeBooks(d: BooksDeps) {
  const p = d.platform;
  const platformWallet = p.config.feeClaimer;
  const vault = p.treasury?.vault ?? null;
  const launches = d.store.listLaunches(['LIVE', 'MIGRATED']);
  const sumQuote = (ps: { feeQuoteRaw: string }[] | null) => (ps === null ? null : ps.reduce((a, x) => a + BigInt(x.feeQuoteRaw), 0n).toString());
  const coins: BooksCoin[] = [];
  const dammOf = new Map<string, LiveDammPool>();
  for (const l of launches) {
    const pool = await d.pools.get(l.pool).catch(() => null);
    const dp = l.status === 'MIGRATED' ? await d.damms.get(l).catch(() => null) : null;
    if (dp) dammOf.set(l.mint, dp);
    const positions = async (owner: string) => (dp ? await d.chain.dammPositions(dp, owner).catch(() => null) : null);
    // each coin's platform share belongs to the fee claimer of the config it launched on: the operator for earlier
    // coins, the treasury vault for coins launched since the treasury config
    const claimer = feeClaimerFor(p, l.config) ?? platformWallet;
    coins.push({ mint: l.mint, symbol: l.symbol, name: l.name, status: l.status, creator: l.creator, platformWallet: claimer, treasury: claimer === vault,
      configRole: l.config === p.config.config ? 'CURRENT' : 'LEGACY',
      curve: pool ? { creatorQuoteRaw: pool.creatorQuoteFee, platformQuoteRaw: pool.partnerQuoteFee } : null,
      lp: l.status !== 'MIGRATED' ? null : dp ? { creatorQuoteRaw: sumQuote(await positions(l.creator)), platformQuoteRaw: sumQuote(await positions(claimer)) } : 'UNAVAILABLE' });
  }
  // receipts still waiting for evidence: each is checked against its own transaction and vaults (a few per run)
  await resolveClaims(d, RECEIPT_CHECKS_PER_RUN);
  const claims: BooksClaim[] = d.store.listClaims().map((c) => {
    const l = launches.find((x) => x.mint === c.mint) ?? d.store.getLaunch(c.mint);
    return { ...c, symbol: l?.symbol ?? '?', byCreator: l?.creator === c.claimer, byTreasury: c.claimer === vault };
  });
  const unresolvedClaims = claims.filter((c) => c.status === 'UNKNOWN').length;
  for (const c of coins) {
    const l = launches.find((x) => x.mint === c.mint)!;
    const ft = d.store.feeTotals(['mint'], { mint: c.mint })[0] ?? sumFees([]);
    const mine = claims.filter((x) => x.mint === c.mint);
    const claimed = (venue: string, who: (x: BooksClaim) => boolean) =>
      mine.filter((x) => x.venue === venue && x.status === 'RESOLVED' && who(x)).reduce((a, x) => a + BigInt(x.quoteRaw!), 0n);
    const h = d.store.backfillCounts(c.mint);
    const reasons = (venue: string) => [
      ...(ft.unknownTrades ? [`${ft.unknownTrades} trade(s) whose fees are not read yet`] : []),
      ...(h.pending || h.unavailable ? [`${h.pending + h.unavailable} transaction(s) still being read`] : []),
      ...(mine.some((x) => x.venue === venue && x.status === 'UNKNOWN') ? ['a claim receipt is not proven yet'] : []),
    ];
    const lp = lpOf(c);
    const dammTrades = BigInt(d.store.listTrades(c.mint, 100_000).filter((t) => t.venue === 'DAMM_V2').length);
    c.fromTrades = ft;
    c.checks = {
      creatorCurve: feeCheck(BigInt(ft.creatorRaw), c.curve?.creatorQuoteRaw ?? null, claimed('CURVE', (x) => x.claimer === l.creator), reasons('CURVE')),
      platformCurve: feeCheck(BigInt(ft.platformRaw), c.curve?.platformQuoteRaw ?? null, claimed('CURVE', (x) => x.claimer === c.platformWallet), reasons('CURVE')),
      lp: l.status !== 'MIGRATED' ? null : feeCheck(BigInt(ft.lpRaw), lp && lp.creatorQuoteRaw !== null && lp.platformQuoteRaw !== null
        ? (BigInt(lp.creatorQuoteRaw) + BigInt(lp.platformQuoteRaw)).toString() : null, claimed('DAMM_V2', () => true), reasons('DAMM_V2'), LP_RESIDUAL_BOUND_PER_TRADE * dammTrades),
    };
    // an LP residual: try to prove where it comes from, from the pool's own fee accounting (one snapshot read)
    const r = c.checks.lp?.residual, dp = dammOf.get(c.mint);
    if (r && dp) {
      const accounting = await d.chain.dammFeeAccounting(dp).catch(() => null);
      const lpClaims = mine.filter((x) => x.venue === 'DAMM_V2' && x.status === 'RESOLVED');
      const proof = accounting && explainLpResidual({ ledgerLpRaw: BigInt(ft.lpRaw), dammTrades: Number(dammTrades), accounting,
        claimsRaw: lpClaims.reduce((a, x) => a + BigInt(x.quoteRaw!), 0n), claims: lpClaims.length });
      if (proof && proof.residualRaw === r.raw) {
        r.proof = proof;
        if (proof.status === 'PROVEN_ROUNDING') {
          r.origin = 'PROVEN_ROUNDING';
          r.note = `${r.raw} raw unit(s) are rounding in the DAMM v2 program's own fee math: positions are paid whole units and each settlement drops the fraction `
            + `(${proof.parts.settlementRaw} raw), and the fee accumulator keeps a little less than the fees (${proof.parts.accumulatorRaw} raw). Recomputed from the pool's accounting; every check passed.`;
        } else r.note += ` Proof attempted: ${proof.checks.filter((x) => !x.ok).map((x) => x.id).join(', ')} did not pass.`;
      } else if (proof) r.note += ` The pool's accounting snapshot gives ${proof.residualRaw} raw instead (it moved between reads); the proof is tried again on the next run.`;
      else r.note += ' The pool\'s fee accounting could not be read on this run; the proof is tried again on the next run.';
    }
  }
  const add = (pick: (c: BooksCoin) => string | null | undefined) => coins.reduce((a, c) => a + BigInt(pick(c) ?? '0'), 0n).toString();
  // two separate questions: were all pools and positions read (unclaimed), and is every receipt proven (claims)
  const unclaimedComplete = !coins.some((c) => !c.curve || c.lp === 'UNAVAILABLE' || (lpOf(c) && (lpOf(c)!.creatorQuoteRaw === null || lpOf(c)!.platformQuoteRaw === null)));
  return { cluster: d.cluster, quote: p.quote, platformWallet, asOf: d.now().toISOString(),
    totals: {
      unclaimed: { creatorCurve: add((c) => c.curve?.creatorQuoteRaw), platformCurve: add((c) => c.curve?.platformQuoteRaw),
        creatorLp: add((c) => lpOf(c)?.creatorQuoteRaw), platformLp: add((c) => lpOf(c)?.platformQuoteRaw) },
      // only receipts proven from their transaction count; unresolved ones are reported in coverage, not added as 0
      claimedThroughApp: claims.reduce((a, c) => a + (c.status === 'UNKNOWN' ? 0n : BigInt(c.quoteRaw!)), 0n).toString(),
      coverage: { unclaimedComplete, claimsComplete: unresolvedClaims === 0, unresolvedClaims },
      incomplete: !unclaimedComplete || unresolvedClaims > 0 },
    treasury: p.treasury ? await treasuryBooks(d, claims) : null,
    coins, claims };
}
export type Books = Awaited<ReturnType<typeof computeBooks>>;

/** Every coin's holder-reward epochs, recomputed from the stored balance history and the rewards vault's own transactions.
 *  Final epochs are frozen the first time and must reproduce identically afterwards (rewards.ts). */
export async function allCoinRewards(d: Pick<BooksDeps, 'store' | 'chain' | 'platform' | 'now' | 'cluster'>): Promise<CoinRewards[]> {
  const coins: CoinRewards[] = [];
  const rv = await rewardsVaultOf(d.platform), vcov = storedVaultCoverage(d);
  const vrows = rv ? d.store.listRewardVaultTxs(rv.quoteAccount) : [];
  for (const l of d.store.listLaunches(['LIVE', 'MIGRATED'])) {
    const deps = depositsFor(vrows, l.mint);
    coins.push(await coinRewards({ store: d.store, chain: d.chain, platform: d.platform, cluster: d.cluster, nowSec: Math.floor(d.now().getTime() / 1000),
      coverage: storedCoverage(d.store, l.mint), changes: toBalanceChanges(d.store.holderChanges(l.mint)), rewardsVault: rv?.vault ?? null,
      deposits: (epochId) => deps.filter((x) => x.epochId === epochId), payouts: (epochId) => payoutsFor(vrows, l.mint, epochId),
      // with a rewards vault, an epoch is final only once the vault's history is read past its end
      ...(rv ? { depositsProvenToSlot: vcov?.account === rv.quoteAccount ? vcov.checkedToSlot : 0 } : {}) }, l));
  }
  return coins.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
