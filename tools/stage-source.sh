#!/usr/bin/env bash
# Scope the working-tree source override to one copied package definition, never its dependencies.
# MAKE_SOURCE optionally names that source through a container mount; SOURCE is always validated on the host.
set -euo pipefail
[ "$#" -ge 3 ] && [ "$#" -le 4 ] || { echo "Usage: stage-source.sh DEFINITION DESTINATION SOURCE [MAKE_SOURCE]" >&2; exit 1; }
definition=$1
destination=$2
source=$3
make_source=${4:-$source}
test -f "$definition/Makefile"
test -d "$source"
mkdir -p "$destination"
cp -a "$definition/." "$destination/"
{
  printf '# Working-tree build only: never pass this override in global MAKEFLAGS.\n'
  printf 'USE_SOURCE_DIR:=%s\nunexport USE_SOURCE_DIR\n\n' "$make_source"
  cat "$definition/Makefile"
} > "$destination/Makefile"
