#!/usr/bin/env bash
# Runs this commit's M5-R1/M5-R2 reproduction tests against a base commit (default 6617acd, milestone 5) and then
# against this checkout. Expected: every "reproduces" test FAILS on the base (exit 1) and PASSES here (exit 0).
# Offline: synthetic chain reads only; no network, no wallet, no chain writes. Needs `pnpm install` done here.
set -u
BASE=${1:-6617acd}
ROOT=$(git rev-parse --show-toplevel)
WT=$(mktemp -d)/base
cd "$ROOT"
git worktree add -q --detach "$WT" "$BASE"
trap 'git -C "$ROOT" worktree remove --force "$WT"; git -C "$ROOT" worktree prune' EXIT
# The base shares this checkout's installed dependencies (resolved to this checkout's packages/; they differ from the base only in
# getNewSignatures paging, which these tests never call: they use a fake chain). apps/launchpad/src is the base's own.
for d in $(find . -maxdepth 3 -name node_modules -type d -not -path './node_modules/*' | sed 's|^\./||'); do ln -s "$ROOT/$d" "$WT/$d"; done
mkdir -p "$WT/apps/launchpad/test/support"
cp apps/launchpad/test/support/harness.ts "$WT/apps/launchpad/test/support/"
cp apps/launchpad/test/m5-reliability.test.ts "$WT/apps/launchpad/test/"
echo "== base $(git -C "$WT" rev-parse --short HEAD): reproduction tests"
(cd "$WT" && node --no-warnings --test --test-reporter=spec --test-name-pattern=reproduces apps/launchpad/test/m5-reliability.test.ts); BASE_EXIT=$?
echo "== this checkout $(git rev-parse --short HEAD): reproduction tests"
node --no-warnings --test --test-reporter=spec --test-name-pattern=reproduces apps/launchpad/test/m5-reliability.test.ts; HEAD_EXIT=$?
echo "base exit=$BASE_EXIT (expected 1)  this checkout exit=$HEAD_EXIT (expected 0)"
[ "$BASE_EXIT" -ne 0 ] && [ "$HEAD_EXIT" -eq 0 ]
