/** Canonical JSON: sorted keys, bigint as decimal string. Hash it to bind consent/artifacts. */
export function canonicalJson(x: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Map) return norm(Object.fromEntries(v));
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(x));
}
