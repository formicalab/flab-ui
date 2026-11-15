#!/usr/bin/env bash
# Scope the working-tree source override to one copied package definition, never its dependencies.
# An optional RELEASE replaces PKG_RELEASE in that copy, so a working-tree build never carries the release number
# of a published apk; the feed's own Makefile is not touched.
set -euo pipefail
{ [ "$#" -eq 3 ] || [ "$#" -eq 4 ]; } || { echo "Usage: stage-source.sh DEFINITION DESTINATION SOURCE [RELEASE]" >&2; exit 1; }
definition=$1
destination=$2
source=$3
release=${4:-}
test -f "$definition/Makefile"
test -d "$source"
[ -z "$release" ] || [[ $release =~ ^[0-9]+$ ]] || { echo "RELEASE must be a number: $release" >&2; exit 1; }
if [ -n "$release" ]; then
  [ "$(grep -c '^PKG_RELEASE:=' "$definition/Makefile")" -eq 1 ] || { echo "PKG_RELEASE must be set exactly once in the Makefile." >&2; exit 1; }
fi
mkdir -p "$destination"
cp -a "$definition/." "$destination/"
{
  printf '# Working-tree build only: never pass this override in global MAKEFLAGS.\n'
  printf 'USE_SOURCE_DIR:=%s\nunexport USE_SOURCE_DIR\n\n' "$source"
  if [ -n "$release" ]; then
    sed -E "s/^PKG_RELEASE:=.*/PKG_RELEASE:=$release/" "$definition/Makefile"
  else
    cat "$definition/Makefile"
  fi
} > "$destination/Makefile"
