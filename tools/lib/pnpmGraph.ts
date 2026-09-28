// Reads the resolved dependency graph from pnpm (pnpm list --json) and the lockfile integrity map.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GraphNode { name: string; version: string; path: string; importer: string; chain: string[]; dev: boolean }
interface ListDep { version: string; path: string; dependencies?: Record<string, ListDep> }
interface ListImporter { name: string; path: string; dependencies?: Record<string, ListDep>; devDependencies?: Record<string, ListDep> }

export function pnpmList(root: string, args: string[] = []): ListImporter[] {
  const out = execFileSync('pnpm', ['list', '-r', '--depth', 'Infinity', '--json', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out) as ListImporter[];
}

/** Every (importer, package, dependency chain) occurrence. Workspace links are followed by name only. */
export function walkGraph(importers: ListImporter[], opts: { includeDev: boolean }): GraphNode[] {
  const out: GraphNode[] = [];
  const walk = (deps: Record<string, ListDep> | undefined, importer: string, chain: string[], dev: boolean, seen: Set<string>) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const key = `${name}@${d.version}`;
      out.push({ name, version: d.version, path: d.path, importer, chain: [...chain, key], dev });
      if (seen.has(key)) continue;
      walk(d.dependencies, importer, [...chain, key], dev, new Set([...seen, key]));
    }
  };
  for (const imp of importers) {
    walk(imp.dependencies, imp.name, [imp.name], false, new Set());
    if (opts.includeDev) walk(imp.devDependencies, imp.name, [imp.name], true, new Set());
  }
  return out;
}

/** name@version -> integrity from pnpm-lock.yaml `packages:` section. */
export function lockIntegrity(root: string): Map<string, string> {
  const text = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const m = new Map<string, string>();
  const re = /^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@([^\s'(:]+)'?:\n {4}resolution: \{integrity: ([^,}]+)/gm;
  for (const x of text.matchAll(re)) m.set(`${x[1]}@${x[2]}`, x[3]!);
  return m;
}

export function readPackageLicense(pkgPath: string): string {
  try {
    const pj = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')) as { license?: unknown; licenses?: unknown };
    const l = pj.license ?? pj.licenses;
    if (typeof l === 'string') return l;
    if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : (x as { type?: string }).type ?? 'UNKNOWN')).join(' OR ');
    if (l && typeof l === 'object') return (l as { type?: string }).type ?? 'UNKNOWN';
    return 'NONE';
  } catch { return 'UNREADABLE'; }
}
