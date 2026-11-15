#!/usr/bin/env bash
# Scope the working-tree source override to one copied package definition, never its dependencies.
set -euo pipefail
[ "$#" -eq 3 ] || { echo "Usage: stage-source.sh DEFINITION DESTINATION SOURCE" >&2; exit 1; }
definition=$1
destination=$2
source=$3
test -f "$definition/Makefile"
test -d "$source"
mkdir -p "$destination"
cp -a "$definition/." "$destination/"
{
  printf '# Working-tree build only: never pass this override in global MAKEFLAGS.\n'
  printf 'USE_SOURCE_DIR:=%s\nunexport USE_SOURCE_DIR\n\n' "$source"
  cat "$definition/Makefile"
} > "$destination/Makefile"
