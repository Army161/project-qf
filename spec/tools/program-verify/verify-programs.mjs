#!/usr/bin/env node
// Project QF — READ-ONLY program verification diagnostic (PROGRAM-VERIFICATION.md).
// Performs only JSON-RPC reads and HTTPS GETs. It never signs, never sends a transaction,
// never loads a key and never publishes an attestation. No environment variables are read.
//
// Usage (unchanged flags):
//   node verify-programs.mjs [--mainnet <RPC_URL_A>] [--mainnet2 <RPC_URL_B>] [--devnet <RPC_URL>] [--out <dir>]
// Defaults: https://api.mainnet-beta.solana.com and https://api.devnet.solana.com; --out defaults to
// ../../docs/verification relative to this script. Output: PROGRAM-VERIFICATION-YYYY-MM-DD.{md,json}
// Exit codes: 0 the expected inventory is complete and every required check is satisfied
//             2 nothing contradicts, but a cluster, the second provider or a read was unavailable
//             3 a required check failed, disagreed, is unknown, missing, duplicated or unexpected
//             64 usage
// --mainnet2 makes CROSS_CHECK required for mainnet-beta. Endpoints are printed as scheme://host[:port] only;
// paths, userinfo, query strings and fragments are never written to the report or the console.
// Do not place secret-bearing URLs in shell history; no secret-input mechanism is provided (by design).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, createJsonRpc, verifyCluster, summarize, exitCodeFor, renderMarkdown, fetchOsecStatus, VERIFIER_VERSION, REPORT_SCHEMA_VERSION } from './lib.mjs';

let args;
try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`usage error: ${e.message}`); process.exit(64); }

const here = dirname(fileURLToPath(import.meta.url));
const targets = [
  { cluster: 'mainnet-beta', url: args.mainnet ?? 'https://api.mainnet-beta.solana.com', url2: args.mainnet2 ?? null },
  { cluster: 'devnet', url: args.devnet ?? 'https://api.devnet.solana.com', url2: null },
];

const clusters = [];
for (const t of targets) {
  clusters.push(await verifyCluster({ cluster: t.cluster, endpoint: t.url, rpc: createJsonRpc(t.url), rpc2: t.url2 ? createJsonRpc(t.url2) : null, osec: fetchOsecStatus }));
}
const plan = targets.map((t) => ({ cluster: t.cluster, crossCheck: !!t.url2 }));
const generatedAt = new Date().toISOString();
const report = { tool: 'project-qf/program-verify', version: VERIFIER_VERSION, schemaVersion: REPORT_SCHEMA_VERSION, generatedAt, readOnly: true, plan,
  clusters, summary: summarize(clusters, plan), exitCode: exitCodeFor(clusters, plan) };
const outDir = resolve(args.out ?? join(here, '..', '..', 'docs', 'verification'));
mkdirSync(outDir, { recursive: true });
const base = join(outDir, `PROGRAM-VERIFICATION-${generatedAt.slice(0, 10)}`);
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
writeFileSync(`${base}.md`, renderMarkdown(report));
console.log(`wrote ${base}.md and .json (exit ${report.exitCode})`);
process.exitCode = report.exitCode;
