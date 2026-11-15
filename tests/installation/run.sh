#!/usr/bin/env bash
# Linux: bash tests/installation/run.sh /absolute/path/to/flab-ui-VERSION.apk. Never builds or contacts a router.
# Optional FLAB_INSTALL_WORK: explicit absolute, dedicated work directory (for example $HOME/flab-install-work
# on WSL's Linux ext4 filesystem). It must be empty on first use; subsequent runs require this runner's marker.
# Rootfs download and logs are retained for reuse. EXIT cleanup stops the image only, never deletes the work directory.
set -euo pipefail
[ "$#" -eq 1 ] || { echo "Usage: run.sh BUILT_APK" >&2; exit 1; }
APK=$(realpath -e -- "$1")
[ -f "$APK" ] && [ -s "$APK" ] && [[ "$APK" = *.apk ]] || { echo "A nonempty built APK is required." >&2; exit 1; }
cd "$(dirname "$0")/../.."
ROOT=$PWD
WORK=${FLAB_INSTALL_WORK:-"$ROOT/tests/installation/.work"}
[[ "$WORK" = /* ]] || { echo "FLAB_INSTALL_WORK must be an absolute Linux path." >&2; exit 1; }
WORK=$(realpath -m -- "$WORK")
case "$WORK" in
  /|/home|/root|/usr|/etc|/var|/run|/dev|/proc|/sys|/boot|/tmp|/tmp/*|/var/tmp|/var/tmp/*|"$HOME")
    echo "Refusing unsafe installation work directory: $WORK" >&2; exit 1 ;;
esac
case "$ROOT/" in "$WORK/"*) echo "Work directory must not contain the source checkout." >&2; exit 1 ;; esac
case "$WORK/" in
  "$ROOT/www/"*|"$ROOT/rpcd/"*|"$ROOT/.git/"*)
    echo "Work directory must not be inside packaged source or Git metadata." >&2; exit 1 ;;
esac
mkdir -p "$WORK"
marker="$WORK/.flab-install-work"
owner="flab-ui-installation:$ROOT"
if [ -e "$marker" ] || [ -L "$marker" ]; then
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(cat "$marker")" = "$owner" ] || {
    echo "Work directory has an invalid ownership marker: $WORK" >&2; exit 1;
  }
else
  [ -z "$(find "$WORK" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
    echo "Work directory must be empty on first use: $WORK" >&2; exit 1;
  }
  (set -o noclobber; printf '%s\n' "$owner" > "$marker")
fi
[ -z "$(find "$WORK" -mindepth 1 -maxdepth 1 -type l -print -quit)" ] || {
  echo "Work directory must not contain top-level symlinks." >&2; exit 1;
}
exec 9>"$WORK/.lock"
flock -n 9 || { echo "Installation work directory is already in use: $WORK" >&2; exit 1; }
BASE=https://downloads.openwrt.org/releases/25.12.0/targets/x86/64
runtime_pid=
cleanup() {
  if [ -n "$runtime_pid" ]; then kill "$runtime_pid" 2>/dev/null || true; wait "$runtime_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

download() {
  local name=$1 hash=$2
  if [ ! -f "$WORK/$name" ]; then curl --silent --show-error --fail --location --retry 3 "$BASE/$name" -o "$WORK/$name"; fi
  printf '%s  %s\n' "$hash" "$WORK/$name" | sha256sum -c -
}
download openwrt-25.12.0-x86-64-rootfs.tar.gz 11c2f26b9d48c02cbdb3b63d499e1f6413ed62bcdbbea78937b12279b95acb1e
if [ "$APK" != "$WORK/flab-ui.apk" ]; then cp "$APK" "$WORK/flab-ui.apk"; fi
rm -rf "$WORK/rootfs"
mkdir -p "$WORK/rootfs"
tar -xzf "$WORK/openwrt-25.12.0-x86-64-rootfs.tar.gz" --no-same-owner -C "$WORK/rootfs"
cp --remove-destination /etc/resolv.conf "$WORK/rootfs/etc/resolv.conf"
cp tests/installation/start.sh "$WORK/start.sh"
# A test-only password hash, used for both rpcd role logins and the image's root login.
openssl passwd -6 -salt flab-ci flab-ci-only > "$WORK/password.hash"
FLAB_SMOKE_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
export FLAB_SMOKE_PORT
export FLAB_SMOKE_URL="http://127.0.0.1:$FLAB_SMOKE_PORT"
export FLAB_INSTALLED_ROOT="$WORK/rootfs"

# Only the disposable image is writable; no host filesystem, SSH key, router or checkout ACL is mounted.
# A private PID namespace ensures all image daemons die when the foreground uhttpd exits.
bwrap --unshare-user --uid 0 --gid 0 --unshare-pid --die-with-parent \
  --bind "$WORK/rootfs" / --dev /dev --proc /proc \
  --ro-bind "$WORK/flab-ui.apk" /flab-ui.apk \
  --ro-bind "$WORK/start.sh" /start.sh \
  --ro-bind "$WORK/password.hash" /password.hash \
  --setenv FLAB_SMOKE_PORT "$FLAB_SMOKE_PORT" \
  /bin/sh /start.sh > "$WORK/runtime.log" 2>&1 &
runtime_pid=$!
for attempt in $(seq 1 120); do
  if curl --silent --fail "$FLAB_SMOKE_URL/flab/" > /dev/null; then break; fi
  if ! kill -0 "$runtime_pid" 2>/dev/null; then cat "$WORK/runtime.log" >&2; exit 1; fi
  sleep 1
done
curl --silent --fail "$FLAB_SMOKE_URL/flab/" > /dev/null || { cat "$WORK/runtime.log" >&2; exit 1; }
node tests/installation/smoke.mjs || { cat "$WORK/runtime.log" >&2; exit 1; }
