export type LicenseClass = 'ALLOW' | 'REVIEW' | 'DENY' | 'UNKNOWN';
export interface LicensePolicy { allow: string[]; review: string[]; deny: string[] }

const strip = (s: string) => s.trim().replace(/^\((.*)\)$/, '$1').trim();
const rank: Record<LicenseClass, number> = { ALLOW: 0, REVIEW: 1, UNKNOWN: 2, DENY: 3 };

/** Classify a simple SPDX expression: OR takes the best alternative, AND the worst component. */
export function classify(expr: string, p: LicensePolicy): LicenseClass {
  const e = strip(expr);
  if (p.allow.includes(e) || p.allow.includes(`(${e})`)) return 'ALLOW';
  const one = (id: string): LicenseClass => {
    const x = strip(id).replace(/\+$/, '');
    if (p.allow.includes(x)) return 'ALLOW';
    if (p.deny.some((d) => x === d || x.startsWith(`${d}-`))) return 'DENY';
    if (p.review.includes(x)) return 'REVIEW';
    return 'UNKNOWN';
  };
  if (/ OR /i.test(e)) return e.split(/ OR /i).map((a) => classify(a, p)).reduce((b, c) => (rank[c] < rank[b] ? c : b));
  if (/ AND /i.test(e)) return e.split(/ AND /i).map((a) => classify(a, p)).reduce((b, c) => (rank[c] > rank[b] ? c : b));
  return one(e);
}
