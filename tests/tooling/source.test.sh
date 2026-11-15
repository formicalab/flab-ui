#!/usr/bin/env bash
# Exercise recursive GNU make source isolation without an SDK, network, compiler or package installation.
set -euo pipefail
cd "$(dirname "$0")/../.."
TEST="$PWD/tests/tooling/.source-test-$$"
mkdir "$TEST"
trap 'rm -rf -- "$TEST"' EXIT
mkdir -p "$TEST/definition" "$TEST/dependency" "$TEST/current/www" "$TEST/sdk-package"
printf 'application fixture\n' > "$TEST/current/www/index.html"
printf 'dependency fixture\n' > "$TEST/dependency/CMakeLists.txt"
cat > "$TEST/dependency/Makefile" <<'MAKE'
all:
	@test -z "$(USE_SOURCE_DIR)"
	@test -z "$$USE_SOURCE_DIR"
	@test -f CMakeLists.txt
MAKE
cat > "$TEST/definition/Makefile" <<'MAKE'
all:
	@test "$(USE_SOURCE_DIR)" = "$(EXPECTED_SOURCE)"
	@test -f "$(USE_SOURCE_DIR)/www/index.html"
	@$(MAKE) --no-print-directory -C "$(DEPENDENCY)"
MAKE
cp "$TEST/definition/Makefile" "$TEST/original-Makefile"
printf 'package auxiliary file\n' > "$TEST/definition/keep"
bash tools/stage-source.sh "$TEST/definition" "$TEST/sdk-package" "$TEST/current"
cmp "$TEST/definition/Makefile" "$TEST/original-Makefile"
cmp "$TEST/definition/keep" "$TEST/sdk-package/keep"
cat > "$TEST/Makefile" <<'MAKE'
all:
	@$(MAKE) --no-print-directory -C "$(DEPENDENCY)"
	@$(MAKE) --no-print-directory -C "$(APPLICATION)"
MAKE
args=(-s --no-print-directory -C "$TEST" "DEPENDENCY=$TEST/dependency" "APPLICATION=$TEST/sdk-package" "EXPECTED_SOURCE=$TEST/current")
if make "${args[@]}" "USE_SOURCE_DIR=$TEST/current" > "$TEST/leaked.log" 2>&1; then
  echo 'Fixture failed to detect a global source override leaking into a dependency.' >&2
  exit 1
fi
make "${args[@]}"
echo 'PASS package-local current source, unchanged feed definition and recursive dependency isolation'
