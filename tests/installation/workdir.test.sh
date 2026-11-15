#!/usr/bin/env bash
# Guard tests only: curl is replaced before any image download, extraction or installation can occur.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
TEST="$ROOT/tests/installation/.work-path-test-$$"
mkdir "$TEST"
trap 'rm -rf -- "$TEST"' EXIT
mkdir "$TEST/bin"
printf '#!/bin/sh\nexit 77\n' > "$TEST/bin/curl"
chmod +x "$TEST/bin/curl"
export PATH="$TEST/bin:$PATH"

expect_status() {
  local expected=$1 directory=$2 result=0
  FLAB_INSTALL_WORK="$directory" bash tests/installation/run.sh > "$TEST/output" 2>&1 || result=$?
  if [ "$result" -ne "$expected" ]; then
    cat "$TEST/output" >&2
    echo "Expected exit $expected, got $result for $directory" >&2
    exit 1
  fi
}

for directory in / "$HOME" "$ROOT" "$(dirname "$ROOT")" "$ROOT/www/work-test" "$ROOT/.git/work-test" /tmp/flab-test /var/tmp/flab-test relative-path; do
  expect_status 1 "$directory"
done
mkdir "$TEST/nonempty"
printf 'unrelated\n' > "$TEST/nonempty/keep"
expect_status 1 "$TEST/nonempty"
test "$(cat "$TEST/nonempty/keep")" = unrelated
expect_status 77 "$TEST/owned"
test -f "$TEST/owned/.flab-install-work"
expect_status 77 "$TEST/owned"
(
  flock -n 9
  expect_status 1 "$TEST/owned"
) 9>"$TEST/owned/.lock"
ln -s "$TEST/nonempty" "$TEST/owned/source"
expect_status 1 "$TEST/owned"
test "$(cat "$TEST/nonempty/keep")" = unrelated
rm "$TEST/owned/source"
printf 'different-owner\n' > "$TEST/owned/.flab-install-work"
expect_status 1 "$TEST/owned"
rm "$TEST/owned/.flab-install-work"
ln -s "$TEST/nonempty/keep" "$TEST/owned/.flab-install-work"
expect_status 1 "$TEST/owned"
test "$(cat "$TEST/nonempty/keep")" = unrelated
echo 'PASS explicit installation work directory guards and safe reuse'
