#!/usr/bin/env bash
# Linux: bash tests/installation/run.sh. Never contacts a router.
# Optional FLAB_PACKAGES_DIR: copy a local (possibly dirty) package definition, without modifying it.
# Otherwise FLAB_FEED_REV selects an immutable fork revision. Update it when package dependencies change.
# Optional FLAB_INSTALL_WORK: explicit absolute, dedicated work directory (for example $HOME/flab-install-work
# on WSL's Linux ext4 filesystem). It must be empty on first use; subsequent runs require this runner's marker.
# Downloads, SDK and logs are retained for reuse. EXIT cleanup stops the image only, never deletes the work directory.
set -euo pipefail
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
SDK_NAME=openwrt-sdk-25.12.0-x86-64_gcc-14.3.0_musl.Linux-x86_64
FEED_REV=${FLAB_FEED_REV:-7986c4571cf590003f00886dc857426a246ec72d}
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
download "$SDK_NAME.tar.zst" 9f371906ce6d2f95418f69fac06df58bf9df0ffc4abed6206c30f1b547fcfc12
download openwrt-25.12.0-x86-64-rootfs.tar.gz 11c2f26b9d48c02cbdb3b63d499e1f6413ed62bcdbbea78937b12279b95acb1e
if [ ! -f "$WORK/$SDK_NAME/.flab-extracted" ]; then
  rm -rf "$WORK/$SDK_NAME"
  tar --zstd -xf "$WORK/$SDK_NAME.tar.zst" -C "$WORK"
  touch "$WORK/$SDK_NAME/.flab-extracted"
fi
SDK="$WORK/$SDK_NAME"

if [ -n "${FLAB_PACKAGES_DIR:-}" ]; then
  DEFINITION="$FLAB_PACKAGES_DIR/admin/flab-ui"
else
  if [ ! -d "$WORK/feed/.git" ]; then git init -q "$WORK/feed"; fi
  git -C "$WORK/feed" fetch --quiet --depth 1 https://github.com/formicalab/packages.git "$FEED_REV"
  git -C "$WORK/feed" checkout --quiet --detach FETCH_HEAD
  DEFINITION="$WORK/feed/admin/flab-ui"
fi
test -f "$DEFINITION/Makefile"
rm -rf "$SDK/package/flab-ui" "$WORK/source" "$WORK/rootfs"
mkdir -p "$SDK/package/flab-ui" "$WORK/source" "$WORK/rootfs"
cp -a "$DEFINITION/." "$SDK/package/flab-ui/"
cp -a www rpcd LICENSE "$WORK/source/"
(
  cd "$SDK"
  # The checksum-pinned SDK's feeds.conf.default pins the base feed to its matching OpenWrt commit.
  # Runtime packages are installed by apk in the image, never smuggled in from the build host.
  if [ ! -d feeds/base ]; then
    ./scripts/feeds update base > "$WORK/build.log" 2>&1
    ./scripts/feeds install -a -p base >> "$WORK/build.log" 2>&1
  fi
  printf 'CONFIG_PACKAGE_flab-ui=m\n' > .config
  make defconfig >> "$WORK/build.log" 2>&1
  make package/flab-ui/clean >> "$WORK/build.log" 2>&1
  make package/flab-ui/compile V=s USE_SOURCE_DIR="$WORK/source" >> "$WORK/build.log" 2>&1
) || { tail -100 "$WORK/build.log" >&2; exit 1; }
APK=$(find "$SDK/bin/packages" -name 'flab-ui-*.apk' -print | sort | tail -1)
test -n "$APK"
cp "$APK" "$WORK/flab-ui.apk"
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
