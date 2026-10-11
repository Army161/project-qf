#!/bin/sh
# Runs scripts/localnet-run.ts against the real engine programs on a fresh local validator.
#   QF_ENGINE_DIR=<engine-qf checkout or source copy> sh packages/engine/scripts/localnet.sh [evidence.json]
# The two program binaries are checked against the engine build's sha256 before they are loaded. The curve's upgrade
# authority and the treasury are throwaway keys generated into $QF_LOCALNET_KEYS (default ~/.qf-localnet, outside
# the repo). The pool admin's one-time accounts (pool config, graduator permission, pool-fee account) are preloaded
# with --account, because the pool admin key is compiled into qf-pool and is not on this machine.
set -eu
ENGINE="${QF_ENGINE_DIR:?set QF_ENGINE_DIR to the engine source (with target/deploy/*.so)}"
KEYS="${QF_LOCALNET_KEYS:-$HOME/.qf-localnet}"
OUT="${1:-$KEYS/localnet-evidence.json}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LEDGER="$KEYS/ledger"
CURVE_SO="$ENGINE/target/deploy/qf_curve.so"
POOL_SO="$ENGINE/target/deploy/raydium_cp_swap.so"

check() { test "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" || { echo "sha256 mismatch: $1"; exit 1; }; }
check "$CURVE_SO" 5a350d74edbb08a601fb87e9b477cdd01f618d1c893015e569123ed48a28622a
check "$POOL_SO" 0640371eb9565372e941deef6ea9cf34db3690793cb09460bc9a5fe4db4ee587

mkdir -p "$KEYS"
[ -f "$KEYS/authority.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$KEYS/authority.json" > /dev/null
[ -f "$KEYS/treasury.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$KEYS/treasury.json" > /dev/null
AUTHORITY=$(solana-keygen pubkey "$KEYS/authority.json")
TREASURY=$(solana-keygen pubkey "$KEYS/treasury.json")

node --no-warnings "$HERE/localnet-run.ts" prepare "$KEYS/accounts" "$TREASURY"

if [ -f "$KEYS/validator.pid" ]; then kill "$(cat "$KEYS/validator.pid")" 2>/dev/null || true; sleep 2; fi
rm -rf "$LEDGER"
ACCOUNTS=""
for f in "$KEYS"/accounts/*.json; do ACCOUNTS="$ACCOUNTS --account $(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).pubkey)" "$f") $f"; done
# shellcheck disable=SC2086
solana-test-validator --reset --quiet --ledger "$LEDGER" --rpc-port 8899 --bind-address 127.0.0.1 \
  --upgradeable-program CaX3gfwE1y3AustJ5e2JQFmaDtXB5oeX6ayvNzLGsFoX "$CURVE_SO" "$AUTHORITY" \
  --upgradeable-program FHG8GyPytpydCRFL6yvwu92vyWSk7bSYZknyLn3v6ewU "$POOL_SO" "$AUTHORITY" \
  $ACCOUNTS > "$KEYS/validator.log" 2>&1 &
echo $! > "$KEYS/validator.pid"
trap 'kill "$(cat "$KEYS/validator.pid")" 2>/dev/null || true' EXIT
for i in $(seq 1 90); do
  if solana -u http://127.0.0.1:8899 cluster-version > /dev/null 2>&1; then break; fi
  [ "$i" = 90 ] && { echo "validator did not start"; tail -20 "$KEYS/validator.log"; exit 1; }
  sleep 1
done
# wait until the preloaded accounts and programs are visible
sleep 3
node --no-warnings "$HERE/localnet-run.ts" run "$OUT" "$KEYS/authority.json" "$TREASURY"
