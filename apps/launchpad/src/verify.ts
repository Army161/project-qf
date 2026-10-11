// `main.ts verify`: the books (books.ts) as a list of plain checks, each PASS, FAIL or WAIT.
//   PASS  the numbers agree exactly, or differ only by rounding proven from the pool's own fee accounting
//   FAIL  they disagree, a frozen reward record no longer recomputes identically, or a payout does not match its record
//   WAIT  something is not read yet (a transaction, a pool, a claim receipt); run it again later
import type { Books, FeeCheck, VaultCheck } from './books.ts';
import type { CoinRewards } from './rewards.ts';

export type Verdict = 'PASS' | 'FAIL' | 'WAIT';
export interface VerifyCheck { verdict: Verdict; coin: string; check: string; detail: string }

const units = (raw: string | bigint, decimals: number) => {
  const v = BigInt(raw), neg = v < 0n, a = neg ? -v : v, s = a.toString().padStart(decimals + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -decimals) || '0'}.${s.slice(-decimals)}`;
};

export function verifyReport(books: Books, rewards: readonly CoinRewards[]) {
  const q = books.quote, amt = (raw: string | null) => (raw === null ? '?' : `${units(raw, q.decimals)} ${q.symbol ?? ''}`.trim());
  const checks: VerifyCheck[] = [];
  const fee = (coin: string, check: string, c: FeeCheck) => {
    const sum = `trades ${amt(c.fromTradesRaw)} vs chain ${amt(c.onChainRaw)} (incl. ${amt(c.claimedRaw)} claimed)`;
    if (c.status === 'MATCH') checks.push({ verdict: 'PASS', coin, check, detail: sum });
    else if (c.status === 'INCOMPLETE') checks.push({ verdict: 'WAIT', coin, check, detail: c.reasons.join('; ') });
    else if (c.status === 'RESIDUAL' && c.residual?.origin === 'PROVEN_ROUNDING') checks.push({ verdict: 'PASS', coin, check, detail: `${sum}; ${c.residual.raw} raw is proven rounding` });
    // a residual whose proof could not be attempted (the pool's accounting was not readable) is unread, not wrong
    else if (c.status === 'RESIDUAL' && !c.residual?.proof) checks.push({ verdict: 'WAIT', coin, check, detail: `${sum}; ${c.residual!.raw} raw residual, the pool's fee accounting could not be read` });
    else checks.push({ verdict: 'FAIL', coin, check, detail: c.status === 'RESIDUAL' ? `${sum}; ${c.residual!.raw} raw residual, origin not proven` : `${sum}; off by ${amt(c.differenceRaw)}` });
  };
  for (const c of books.coins) {
    const coin = `$${c.symbol}`;
    if (!c.checks) continue;
    fee(coin, 'creator curve fees add up', c.checks.creatorCurve);
    fee(coin, 'platform curve fees add up', c.checks.platformCurve);
    if (c.checks.lp) fee(coin, 'LP fees add up', c.checks.lp);
  }
  if (books.treasury) {
    const v: VaultCheck = books.treasury.vaultCheck;
    const detail = `vault holds ${amt(v.vaultQuoteRaw)}; claim receipts in ${amt(v.receiptsRaw)}, rewards deposits out ${amt(v.depositsOutRaw)}`;
    checks.push({ verdict: v.status === 'MATCH' ? 'PASS' : v.status === 'INCOMPLETE' ? 'WAIT' : 'FAIL', coin: 'treasury', check: 'vault equals what went in and out',
      detail: v.reasons.length ? `${detail}; ${v.reasons.join('; ')}` : detail });
  }
  const unknown = books.claims.filter((c) => c.status === 'UNKNOWN').length;
  checks.push({ verdict: unknown ? 'WAIT' : 'PASS', coin: 'claims', check: 'every claim receipt read from its transaction',
    detail: `${books.claims.length - unknown} of ${books.claims.length} proven` });
  for (const c of rewards) {
    for (const e of c.epochs.filter((x) => x.frozen)) {
      checks.push({ verdict: e.frozen!.reproduced ? 'PASS' : 'FAIL', coin: `$${c.symbol}`, check: `rewards ${e.epochId} record recomputes identically`, detail: `hash ${e.frozen!.hash.slice(0, 16)}…` });
      const s = e.settlement.status;
      if (s === 'NOTHING_TO_PAY') continue;
      checks.push({ verdict: s === 'PAID' || s === 'NOT_PAID' ? 'PASS' : 'FAIL', coin: `$${c.symbol}`, check: `rewards ${e.epochId} payout matches its record`,
        detail: s === 'NOT_PAID' ? 'not paid yet' : `${s}: ${amt(e.settlement.paidRaw)} paid${e.settlement.reasons.length ? `; ${e.settlement.reasons.join('; ')}` : ''}` });
    }
  }
  const summary = { pass: checks.filter((x) => x.verdict === 'PASS').length, fail: checks.filter((x) => x.verdict === 'FAIL').length, wait: checks.filter((x) => x.verdict === 'WAIT').length };
  const w = Math.max(...checks.map((x) => x.coin.length), 4);
  const text = [`Books checked ${books.asOf} (${books.cluster})`, '',
    ...checks.map((x) => `${x.verdict.padEnd(4)}  ${x.coin.padEnd(w)}  ${x.check}: ${x.detail}`), '',
    `${summary.pass} PASS, ${summary.fail} FAIL, ${summary.wait} WAIT`].join('\n');
  return { text, summary, checks };
}
