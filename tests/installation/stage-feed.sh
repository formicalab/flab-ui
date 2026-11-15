#!/usr/bin/env bash
# Prepare the official SDK action's /feed mount, separate from the checkout (the action chowns its mounts).
# Usage: stage-feed.sh EMPTY_ABSOLUTE_WORK [SOURCE_ROOT]. Output: WORK/feed and WORK/artifacts.
# FLAB_FEED_REV must be an immutable fork commit; FLAB_PACKAGES_DIR optionally supplies a read-only local definition.
set -euo pipefail
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo "Usage: stage-feed.sh WORK [SOURCE_ROOT]" >&2; exit 1; }
cd "$(dirname "$0")/../.."
ROOT=$PWD
[[ "$1" = /* ]] || { echo "The SDK feed work directory must be absolute." >&2; exit 1; }
WORK=$(realpath -m -- "$1")
case "$ROOT/" in "$WORK/"*) echo "The SDK feed work directory must not contain the checkout." >&2; exit 1 ;; esac
SOURCE=$(realpath -e -- "${2:-$ROOT}")
case "$WORK/" in
  "$SOURCE/www/"*|"$SOURCE/rpcd/"*|"$ROOT/.git/"*)
    echo "The SDK feed work directory must not be inside packaged source or Git metadata." >&2; exit 1 ;;
esac
test -d "$SOURCE/www"
test -d "$SOURCE/rpcd"
test -f "$SOURCE/LICENSE"
mkdir -p "$WORK"
[ -z "$(find "$WORK" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
  echo "The SDK feed work directory must be empty; refusing to overwrite it." >&2; exit 1;
}
REVISION=${FLAB_FEED_REV:-7986c4571cf590003f00886dc857426a246ec72d}
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "FLAB_FEED_REV must be an immutable commit SHA." >&2; exit 1; }
if [ -n "${FLAB_PACKAGES_DIR:-}" ]; then
  DEFINITION="$FLAB_PACKAGES_DIR/admin/flab-ui"
else
  git init --quiet "$WORK/definition"
  git -C "$WORK/definition" fetch --quiet --depth 1 https://github.com/formicalab/packages.git "$REVISION"
  git -C "$WORK/definition" checkout --quiet --detach FETCH_HEAD
  [ "$(git -C "$WORK/definition" rev-parse HEAD)" = "$REVISION" ]
  DEFINITION="$WORK/definition/admin/flab-ui"
fi
mkdir -p "$WORK/feed/source" "$WORK/artifacts"
cp -a "$SOURCE/www" "$SOURCE/rpcd" "$SOURCE/LICENSE" "$WORK/feed/source/"
# The helper validates the real snapshot, but writes the path the SDK container sees through its /feed mount.
bash "$ROOT/tools/stage-source.sh" "$DEFINITION" "$WORK/feed/flab-ui" "$WORK/feed/source" /feed/source
printf '%s\n' "$REVISION" > "$WORK/feed-revision"
