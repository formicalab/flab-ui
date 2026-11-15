# Package

## OpenWrt package

The proposed `flab-ui` package (`admin/flab-ui` on the
[`flab-ui` branch of formicalab/packages](https://github.com/formicalab/packages/tree/flab-ui/admin/flab-ui), not yet
merged into [openwrt/packages](https://github.com/openwrt/packages)) installs:

| Source | Installed to |
|---|---|
| `www/` | `/www/flab/` (served by uhttpd at `https://<router>/flab/`) |
| `rpcd/ucode/*.uc` | `/usr/share/rpcd/ucode/` |
| `rpcd/acl.d/*.json` | `/usr/share/rpcd/acl.d/` |
| `rpcd/lib/flab/*.uc` | `/usr/share/ucode/flab/` |

It depends only on `rpcd`, `rpcd-mod-ucode`, `ucode`, `ucode-mod-fs`, `ucode-mod-ubus`, `ucode-mod-uci`, `ucode-mod-uloop`, `uhttpd` and
`uhttpd-mod-ubus`. The programs the pages read from (`swanctl`, `birdc`, `wg`, `nft`, `iw`, `nlbw`, ...) are optional
runtime tools, not dependencies: install the ones for the pages you use. Installing and removing the package reloads rpcd.
The package is built from the `v<version>` tag of this repository; `tests/` and `tools/` are not installed.
It does not configure uhttpd's document root, HTTPS listener, certificate, redirect or firewall access. `/www` and
`/ubus` must already be served, and a working HTTPS setup needs the router's TLS support as well as uhttpd.

## Building the package

The package definition (`Makefile` and the CI tests) is `admin/flab-ui` in the
[openwrt/packages](https://github.com/openwrt/packages) feed. It is not merged there yet; until it is, it is on the
branch [`flab-ui`](https://github.com/formicalab/packages/tree/flab-ui) of a fork:

```sh
git clone --depth 1 -b flab-ui https://github.com/formicalab/packages.git
```

It builds an architecture-independent apk, so an SDK or buildroot for any target works. The SDK only runs on Linux; on
Windows use WSL.

**With any OpenWrt SDK.** Download an SDK from [downloads.openwrt.org](https://downloads.openwrt.org) (an apk-based
snapshot), unpack it, and from its top directory:

```sh
# Make admin/flab-ui visible to the SDK. Either copy the package directory ...
cp -r /path/to/packages/admin/flab-ui package/flab-ui
# ... or use a checkout of the feed that holds it:
#   echo "src-link packages /path/to/packages" >> feeds.conf
#   ./scripts/feeds update packages && ./scripts/feeds install flab-ui

make defconfig
echo CONFIG_PACKAGE_flab-ui=m >> .config && make defconfig
make package/flab-ui/compile
ls bin/packages/*/*/flab-ui-*.apk
```

This downloads the `v<version>` tag of this repository, as the Makefile says, and checks its hash.

**From a local checkout.** To build the working tree instead of the tag, give the SDK a directory with `www/`, `rpcd/`
and `LICENSE`. The SDK writes its build stamps into that directory, so use a copy:

```sh
mkdir /tmp/flab-ui-src && cp -a www rpcd LICENSE /tmp/flab-ui-src/
make package/flab-ui/clean
make package/flab-ui/compile USE_SOURCE_DIR=/tmp/flab-ui-src
```

**Install.** The package is unsigned, so apk needs `--allow-untrusted`:

```sh
scp -O bin/packages/*/*/flab-ui-*.apk root@<router>:/tmp/
ssh root@<router> 'apk add --allow-untrusted /tmp/flab-ui-*.apk'
```

Installing and removing (`apk del flab-ui`) reload rpcd. apk does not reinstall the version that is already installed,
so to try a rebuilt package of the same version, remove the installed one first.

## Package script

`tools/package.ps1` is the one script for building, installing and releasing the package. It needs PowerShell 7 and,
for `Deploy` and `Remove`, `ssh` and `scp` with key auth to the router (`scp -O` is used because dropbear has no
sftp-server).

```powershell
pwsh -File tools/package.ps1 -Action Build                             # only build the apk (no router needed)
pwsh -File tools/package.ps1 -Action Deploy -Router root@192.168.1.1   # build, replace the installed flab-ui, check
pwsh -File tools/package.ps1 -Action Remove -Router root@192.168.1.1   # apk del flab-ui and check that no flab.* object is left
pwsh -File tools/package.ps1 -Action Release -Version 0.1.4 -Router root@192.168.1.1 -Amend -NotesFile CHANGELOG.md
```

`Build` and `Deploy` do the "from a local checkout" build described above.

- **Where the SDK is.** On Linux the build runs directly in bash. On Windows it runs in WSL (`-Distro`, default
  `Ubuntu-26.04`) and reaches the working tree through `/mnt`. `-Sdk` is the SDK directory as that shell sees it
  (default `$HOME/sdk/openwrt-sdk-*`; a glob is allowed).
- **SDK setup.** The SDK must already hold `admin/flab-ui` (copied or through a feed, as above) and have
  `CONFIG_PACKAGE_flab-ui=m` in its `.config`. The script checks that and says what is missing.
- **Router.** `-Router` defaults to the `FLAB_ROUTER` environment variable, else `root@192.168.1.1`. The router must run
  an apk-based OpenWrt.
- **Output.** `-OutDir` (default: `artifacts/packages` in the checkout, ignored by Git) receives the apk.
- **What Deploy does.** It builds, copies the apk to the router, removes the installed package and adds the new one,
  then waits until rpcd serves one `flab.*` object per plugin in `rpcd/ucode/` and the page answers over HTTPS. Open
  `https://<router>/flab/` and sign in as root with the router's root password.
- **Building from the tag.** `-UseFeedSource` builds from the source the feed Makefile names (the tag tarball, whose
  hash the SDK checks) instead of the working tree; `Release` always does.

## Releasing

The tag and the package Makefile have to name the same version. The feed definition lives in the packages fork,
separately from this source: the release tarball is finalized before its hash is recorded in the feed. `-Action Release` keeps them aligned,
so a release is one command and the version is chosen only there:

```powershell
pwsh -File tools/package.ps1 -Action Release -Version 0.1.4 -Router root@192.168.1.1 -PackagesDir ../packages -Amend -NotesFile CHANGELOG.md
```

It checks that this repository is on a clean, pushed `main`, tags `v<Version>`, downloads the tag's tarball, writes
`PKG_VERSION`, `PKG_HASH` and `PKG_RELEASE:=1` into `admin/flab-ui/Makefile` of the packages checkout, builds the apk
from that tarball (so the SDK checks the hash), installs it on the router as a check (`-SkipInstallCheck` to skip),
commits and pushes the Makefile to the fork (`-Remote`, default `fork`), and creates the GitHub release with the apk and
its SHA-256 file (`-Draft` makes it a draft). `-PackagesDir` is the checkout of the feed branch (default: the
`FLAB_PACKAGES` environment variable, else a `packages` folder next to this repository). `-Amend` folds the Makefile
change into the single package commit while the package is not merged; without it the script adds a commit
`flab-ui: update to <Version>`. Choose an unused version; the example is not a version pin.
`-NotesFile` is required and must contain the actual changes for this release. Installation and checksum instructions
are appended automatically; the notes are validated before any Git state changes.
Before the packages branch is published, failure recovery restores its recorded branch HEAD, Makefile index and
working bytes, but refuses to overwrite a branch moved by another process. A pushed or possibly published tag is
kept whenever deleting it could invalidate remote package work. This is not a transaction across Git, GitHub and the
router: a package already installed on the router is not reverted. It needs `git` and an authenticated `gh`.

## Preparing the feed pull request

Follow the current [contributing guide](https://github.com/openwrt/packages/blob/master/CONTRIBUTING.md) and
[review rules](https://github.com/openwrt/packages/blob/master/.github/llm-review-rules.md). Submit the package
definition and smoke test to `master`, not this application's source tree. Keep the source archive immutable and
hash-verified, use a real maintainer identity and matching `Signed-off-by`, and reset `PKG_RELEASE` on a version bump.
The source is architecture-independent, but fresh-image dependency checks and more than one board remain important.

Run the feed build, its `test.sh` and current upstream formalities before submission. The smoke test compiles installed
plugins and checks the `flab.util` import; it does not exercise the web UI, actual rollback, or optional daemon behavior.
Keep the license notices of bundled third-party assets in the distributed package as well as in the source.
The contribution policy requires disclosure of AI assistance and human review. The current workflow stops at
preparation and updates to this source repository and its packages fork: do not open a PR against the main OpenWrt
repositories.

## Testing a plugin without rpcd

A Deploy or Remove replaces the plugins and the web files that a signed-in page uses, so do not run one while a browser
test is running on the same router. To test a plugin without rpcd: copy it and `rpcd/lib/flab/` to `/tmp`, then run it
with `ucode -L '/tmp/*.uc'` through a small script file (inline quoting over ssh is fragile).

## License

flab-ui is MIT licensed (see `LICENSE`). `www/vendor/bootstrap.min.css` is Bootstrap 5.3.3 and the icon paths in
`www/js/core/icons.js` are Bootstrap Icons 1.11.3; both are MIT licensed (Copyright the Bootstrap Authors).
`www/LICENSE` carries the application and third-party notices and the MIT permission text; the package's existing
`www/` install rule includes it at `/www/flab/LICENSE`. Changes made after a published tag require a new release
before the feed tarball includes them.
The feed Makefile lists `LICENSE www/LICENSE` in `PKG_LICENSE_FILES`. The package and both bundled Bootstrap assets
use MIT, so `PKG_LICENSE:=MIT` remains the correct SPDX expression; separate identifiers are not needed for multiple
components under the same license. `PKG_LICENSE_FILES` is optional OpenWrt metadata, but retaining the actual notices
in the distributed files is still required by MIT.
