// Pure scanning logic for the browser boundary (exported for tests and canaries).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Never in a browser bundle: web3.js v1 and its LGPL websocket client, Meteora's SDKs, Anchor, and the launchpad server.
export const FORBIDDEN_PACKAGES = Object.freeze([
  '@solana/web3.js', 'rpc-websockets', '@meteora-ag/dynamic-bonding-curve-sdk', '@meteora-ag/cp-amm-sdk',
  '@coral-xyz/anchor', '@coral-xyz/borsh', 'jayson', 'chain', '@project-qf/launchpad',
]);
const FORBIDDEN_PATH_FRAGMENTS = ['apps/launchpad/'];
const TEXT_MARKERS = [/GNU LESSER GENERAL PUBLIC LICENSE/, /\bLGPL-3\.0/, /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?rpc-websockets\//,
  /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@solana\/web3\.js\//, /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@meteora-ag\//,
  /['"]@project-qf\/launchpad['"]/, /apps\/launchpad\/src\//];

/** Package name for a bundled input path like node_modules/.pnpm/x/node_modules/@scope/name/lib/a.js */
export function packageOf(p: string): string | undefined {
  const i = p.lastIndexOf('node_modules/');
  if (i < 0) return undefined;
  const rest = p.slice(i + 'node_modules/'.length).split('/');
  return rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

export interface Violation { where: string; what: string }

export function scanMetafile(meta: { inputs: Record<string, unknown> }): { packages: string[]; violations: Violation[] } {
  const pkgs = new Set<string>();
  const v: Violation[] = [];
  for (const input of Object.keys(meta.inputs)) {
    const pkg = packageOf(input);
    if (pkg) pkgs.add(pkg);
    if (pkg && FORBIDDEN_PACKAGES.includes(pkg)) v.push({ where: 'metafile.inputs', what: `${pkg} (${input})` });
    for (const f of FORBIDDEN_PATH_FRAGMENTS) if (input.includes(f)) v.push({ where: 'metafile.inputs', what: input });
  }
  return { packages: [...pkgs].sort(), violations: v };
}

export function scanArtifacts(dir: string): { files: string[]; violations: Violation[] } {
  const files: string[] = [];
  const v: Violation[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(dir);
  for (const f of files) {
    if (f.endsWith('meta.json')) continue; // build metadata, not served
    const text = readFileSync(f, 'utf8');
    for (const re of TEXT_MARKERS) if (re.test(text)) v.push({ where: f.slice(dir.length + 1), what: `marker ${re}` });
    if (f.endsWith('.map')) {
      const map = JSON.parse(text) as { sources: string[]; sourcesContent?: (string | null)[] };
      for (const s of map.sources) {
        const pkg = packageOf(s);
        if (pkg && FORBIDDEN_PACKAGES.includes(pkg)) v.push({ where: `${f.slice(dir.length + 1)} sources`, what: s });
        for (const frag of FORBIDDEN_PATH_FRAGMENTS) if (s.includes(frag)) v.push({ where: `${f.slice(dir.length + 1)} sources`, what: s });
      }
      if (!map.sourcesContent || map.sourcesContent.length !== map.sources.length) v.push({ where: f, what: 'source map lacks sourcesContent (cannot audit)' });
    }
  }
  return { files: files.map((f) => f.slice(dir.length + 1)).sort(), violations: v };
}
