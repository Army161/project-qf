#!/bin/sh
# Project QF — owner-run READ-ONLY verification on your own computer and ordinary network (decision 2026-09-27).
# Runs: frozen install (registry.npmjs.org) -> offline tests -> the existing verifier CLI against public endpoints.
# Runtime hosts contacted by the verifier: api.mainnet.solana.com, api.devnet.solana.com, verify.osec.io only.
# No wallet, key, airdrop, simulation, signature, transaction or attestation. Stops at the first failing step and keeps
# every exit code in verification-results/RUN-LOG.txt. Do not add secret-bearing RPC URLs here or in shell history.
set -u
cd "$(dirname "$0")" || exit 1
OUT=./verification-results
mkdir -p "$OUT"
LOG="$OUT/RUN-LOG.txt"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
: > "$LOG"
say "# Project QF read-only run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "node $(node -v 2>/dev/null || echo MISSING) (tested: v22.22.2) · pnpm $(pnpm -v 2>/dev/null || echo MISSING) (tested: 10.33.0) · $(uname -sm)"
case "$(node -v 2>/dev/null)" in v22.2[2-9].*|v22.[3-9][0-9].*) ;; *) say "STOP: needs Node >= 22.22 (tested v22.22.2) for --use-env-proxy and type stripping parity"; exit 70 ;; esac
step() { name=$1; shift; say "## $name: $*"; "$@" >>"$LOG" 2>&1; e=$?; say "## $name exit $e"; [ $e -eq 0 ] || { say "STOP: $name failed; later steps not run"; exit $e; }; }
step install pnpm install --frozen-lockfile --ignore-scripts
step offline-tests pnpm test
say "## verify: node verify-programs.mjs --mainnet https://api.mainnet.solana.com --devnet https://api.devnet.solana.com --out $OUT"
node verify-programs.mjs --mainnet https://api.mainnet.solana.com --devnet https://api.devnet.solana.com --out "$OUT" >>"$LOG" 2>&1
e=$?
say "## verify exit $e (0 = inventory complete and every required check satisfied; 2 = something unavailable; 3 = a required check failed, disagreed or is unknown; 64 = usage)"
say "Send back the whole $OUT folder. Exit 0 is evidence for READ_ONLY_VERIFICATION only; it does not unlock devnet or mainnet."
exit $e
