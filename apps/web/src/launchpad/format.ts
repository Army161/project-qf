// Exact integer formatting for token amounts (bigint base units -> display strings). Never float math on amounts.

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** raw base units -> "1,234.56" with at most `maxFrac` fraction digits (rounded down). */
export function units(raw: bigint | string, decimals: number, maxFrac = 2): string {
  const v = BigInt(raw), neg = v < 0n, a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals, s.length - decimals + maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${group(int)}${frac ? `.${frac}` : ''}`;
}

/** "1.5" (UI units) -> raw bigint; throws on bad input or too many decimals. */
export function parseUnits(ui: string, decimals: number): bigint {
  const t = ui.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) throw new Error('enter a positive number');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Compact display for large raw amounts: 12.3K, 4.56M. */
export function compact(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw), unit = 10n ** BigInt(decimals);
  const steps: [bigint, string][] = [[10n ** 9n, 'B'], [10n ** 6n, 'M'], [10n ** 3n, 'K']];
  for (const [d, sfx] of steps) {
    if (v >= d * unit) { const x = (v * 100n) / (d * unit); return `${group((x / 100n).toString())}.${(x % 100n).toString().padStart(2, '0').replace(/0+$/, '') || '0'}${sfx}`.replace(/\.0(?=[KMB])/, ''); }
  }
  return units(v, decimals, 2);
}

/** Fixed-point (x1e18) quote-raw-per-base-UI price -> quote UI with 4 significant digits, e.g. "0.0000123". */
export function price(fp18: bigint | string, quoteDecimals: number): string {
  const v = BigInt(fp18);
  if (v === 0n) return '0';
  const scale = 18 + quoteDecimals;
  const s = v.toString();
  if (s.length > scale) return units(v, scale, 4);
  const zeros = scale - s.length;
  const sig = s.slice(0, 4).replace(/0+$/, '');
  return `0.${'0'.repeat(zeros)}${sig}`;
}

export const short = (a: string, n = 4) => (a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

export function ago(iso: string | number | null, now = Date.now()): string {
  if (iso === null) return '';
  const t = typeof iso === 'number' ? iso * 1000 : Date.parse(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

let explorerQuery = '?cluster=devnet';
/** Explorer links point at the network this server runs on (set once at boot from lp-api/platform). */
export const setExplorerCluster = (cluster: 'devnet' | 'localnet' | 'mainnet-beta') => {
  explorerQuery = cluster === 'devnet' ? '?cluster=devnet' : cluster === 'localnet' ? '?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899' : '';
};
export const explorer = (kind: 'tx' | 'address', id: string) => `https://explorer.solana.com/${kind}/${id}${explorerQuery}`;
