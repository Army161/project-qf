export type Freshness = 'FRESH' | 'STALE' | 'FUTURE_TIMESTAMP' | 'BAD_TIMESTAMP';

export function freshness(observedAt: string, now: string, maxAgeSeconds: number, maxSkewSeconds: number): Freshness {
  const t = Date.parse(observedAt);
  const n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return 'BAD_TIMESTAMP';
  if (t > n + maxSkewSeconds * 1000) return 'FUTURE_TIMESTAMP';
  if (n - t > maxAgeSeconds * 1000) return 'STALE';
  return 'FRESH';
}
