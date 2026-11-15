#!/usr/bin/env bash
# The local definition fixture avoids Git/network; source paths match the official action's actual /feed mount.
set -euo pipefail
cd "$(dirname "$0")/../.."
TEST="$PWD/tests/installation/.feed-test-$$"
mkdir "$TEST"
trap 'rm -rf -- "$TEST"' EXIT
mkdir -p "$TEST/packages/admin/flab-ui" "$TEST/current/www" "$TEST/current/rpcd/acl.d"
cat > "$TEST/packages/admin/flab-ui/Makefile" <<'MAKE'
PKG_VERSION:=0.1.3
PKG_RELEASE:=2
PKG_LICENSE_FILES:=LICENSE
all:
	@test "$(USE_SOURCE_DIR)" = /feed/source
	@test -z "$$USE_SOURCE_DIR"
MAKE
cp "$TEST/packages/admin/flab-ui/Makefile" "$TEST/original-Makefile"
printf 'current browser source\n' > "$TEST/current/www/index.html"
printf 'current web license\n' > "$TEST/current/www/LICENSE"
printf 'current package license\n' > "$TEST/current/LICENSE"
printf '{"flab":{}}\n' > "$TEST/current/rpcd/acl.d/flab-test.json"
FLAB_PACKAGES_DIR="$TEST/packages" bash tests/installation/stage-feed.sh "$TEST/work" "$TEST/current"
if FLAB_PACKAGES_DIR="$TEST/packages" bash tests/installation/stage-feed.sh "$TEST/current/www/work" "$TEST/current" > "$TEST/error" 2>&1; then
  echo 'Feed staging must not recursively stage into the source snapshot.' >&2
  exit 1
fi
cmp "$TEST/packages/admin/flab-ui/Makefile" "$TEST/original-Makefile"
cmp "$TEST/current/www/index.html" "$TEST/work/feed/source/www/index.html"
cmp "$TEST/current/www/LICENSE" "$TEST/work/feed/source/www/LICENSE"
cmp "$TEST/current/rpcd/acl.d/flab-test.json" "$TEST/work/feed/source/rpcd/acl.d/flab-test.json"
cmp "$TEST/current/LICENSE" "$TEST/work/feed/source/LICENSE"
test -d "$TEST/work/artifacts"
test "$(cat "$TEST/work/feed-revision")" = 7986c4571cf590003f00886dc857426a246ec72d
make -s --no-print-directory -C "$TEST/work/feed/flab-ui"
printf 'later source edit\n' > "$TEST/current/www/index.html"
test "$(cat "$TEST/work/feed/source/www/index.html")" = "current browser source"
if FLAB_PACKAGES_DIR="$TEST/packages" bash tests/installation/stage-feed.sh "$TEST/work" "$TEST/current" > "$TEST/error" 2>&1; then
  echo 'Feed staging must not overwrite an existing work directory.' >&2
  exit 1
fi
test "$(cat "$TEST/work/feed/source/www/index.html")" = "current browser source"
echo 'PASS official SDK feed mount, current-source snapshot, immutable definition and safe staging'
