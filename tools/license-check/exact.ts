// QF-LIC-EX-002 style exceptions: one exact package version whose licence expression is allowed only as a whole, with
// its upstream notices preserved verbatim in the repo. Deliberately not a policy-wide allowance for the licence ids.
export interface ExactException {
  exceptionId: string; name: string; version: string; license: string; resolvedIntegrity: string;
  notices: { upstreamPath: string; preservedAt: string }[];
}
export interface ExactObservation {
  license: string; integrity: string | undefined; patched: boolean;
  /** upstreamPath -> [installed file text | undefined, preserved copy text | undefined] */
  notices: Map<string, [string | undefined, string | undefined]>;
}

export function checkExactException(ex: ExactException, o: ExactObservation): string[] {
  const problems: string[] = [];
  if (o.license !== ex.license) problems.push(`license ${JSON.stringify(o.license)} != ${JSON.stringify(ex.license)}`);
  if (o.integrity !== ex.resolvedIntegrity) problems.push(`integrity ${o.integrity} != ${ex.resolvedIntegrity}`);
  if (o.patched) problems.push('package is patched; the exception covers the unmodified upstream only');
  if (!ex.notices?.length) problems.push('no notices recorded');
  for (const n of ex.notices ?? []) {
    const [installed, preserved] = o.notices.get(n.upstreamPath) ?? [undefined, undefined];
    if (installed === undefined) problems.push(`upstream notice ${n.upstreamPath} missing from installed package`);
    else if (preserved === undefined) problems.push(`notice not preserved at ${n.preservedAt}`);
    else if (preserved !== installed) problems.push(`preserved notice ${n.preservedAt} differs from upstream ${n.upstreamPath}`);
  }
  return problems;
}
