# Package

## OpenWrt package

The proposed `flab-ui` package (`admin/flab-ui` on the
[`flab-ui` branch of formicalab/packages](https://github.com/formicalab/packages/tree/flab-ui/admin/flab-ui), not yet
merged into [openwrt/packages](https://github.com/openwrt/packages)) builds one base package, feature modules and a
full-install metapackage:

| Package | Purpose |
|---|---|
| `flab-ui-base` | Shell, shared assets/libraries, Overview and System settings |
| `flab-ui-mod-network` | Ethernet ports, VLANs, Devices and Interfaces, connected clients |
| `flab-ui-mod-wireless` | Wi-Fi radios, networks and mesh |
| `flab-ui-mod-firewall` | Firewall |
| `flab-ui-mod-vpn` | IPsec and WireGuard |
| `flab-ui-mod-dhcp` | DHCP and router advertisements |
| `flab-ui-mod-dns` | DNS and Dynamic DNS |
| `flab-ui-mod-routing` | Routes and BGP |
| `flab-ui-mod-traffic` | Traffic and nlbwmon |
| `flab-ui-mod-toolbox` | Network diagnostic tools |
| `flab-ui-mod-services` | Service control |
| `flab-ui-mod-logs` | System and kernel logs |
| `flab-ui` | Metapackage that depends on the base and every module |

Feature modules install a JSON manifest in `/www/flab/modules`. `flab.system modules` reads them, and the shell
registers only installed pages. Removing a feature package therefore removes its navigation entry and rpcd backend.
`flab-ui-base` remains required by every module.

| Source | Installed to |
|---|---|
| `www/` | `/www/flab/` (served by uhttpd at `https://<router>/flab/`) |
| `rpcd/ucode/*.uc` | `/usr/share/rpcd/ucode/` |
| `rpcd/acl.d/*.json` | `/usr/share/rpcd/acl.d/` |
| `rpcd/lib/flab/*.uc` | `/usr/share/ucode/flab/` |
| `admin/flab-ui/files/.../acl.d/*.json` in the packages checkout | `/usr/share/rpcd/acl.d/` |

It depends only on `rpcd`, `rpcd-mod-ucode`, `ucode`, `ucode-mod-fs`, `ucode-mod-ubus`, `ucode-mod-uci`, `ucode-mod-uloop`, `uhttpd` and
`uhttpd-mod-ubus`. The programs the pages read from (`swanctl`, `birdc`, `wg`, `nft`, `iw`, `nlbw`, ...) are optional
runtime tools, not dependencies: install the ones for the pages you use. Installing and removing a package restarts rpcd
so it rescans the plugin executables.
The packages are built from the `v<version>` tag of this repository; `tests/` and `tools/` are not installed.
`tools/artifact-manifest.json` is the checked-in source-to-install contract. Builds reject missing plugin/ACL pairs,
and installs verify every declared target plus the complete `/www/flab` file set.
The source `rpcd/acl.d/` files are authoritative for development. Release tooling copies them into the packages
checkout's `admin/flab-ui/files/usr/share/rpcd/acl.d/`, where the OpenWrt Makefile installs the reviewed copies rather
than taking ACL integration files from the source archive.
It does not configure uhttpd's document root, HTTPS listener, certificate, redirect or firewall access. `/www` and
`/ubus` must already be served, and a working HTTPS setup needs the router's TLS support as well as uhttpd.

## Building the package

The package definition (`Makefile` and the package smoke test) is `admin/flab-ui` in the
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

Installing or removing the base and backend feature packages reloads rpcd. apk does not reinstall the version that is
already installed, so to try a rebuilt package of the same version, remove the installed packages first (`Deploy` and
`Remove` handle all of them). Removing only `flab-ui` deletes the metapackage, not its dependencies.

## Package script

`tools/package.ps1` is the one script for building, installing and releasing the package. It needs PowerShell 7 and,
for `Deploy` and `Remove`, `ssh` and `scp` with key auth to the router (`scp -O` is used because dropbear has no
sftp-server).

```powershell
pwsh -File tools/package.ps1 -Action Sync -Router root@192.168.1.1     # fast loop: copy www/ to the router, no apk
pwsh -File tools/package.ps1 -Action Sync -Backend -Router root@192.168.1.1   # also copy rpcd/ and reload rpcd
pwsh -File tools/package.ps1 -Action Deploy -Router root@192.168.1.1   # build, replace the installed flab-ui, check
pwsh -File tools/package.ps1 -Action Build                             # only build the apk (no router needed)
pwsh -File tools/package.ps1 -Action Remove -Router root@192.168.1.1   # purge every package and verify no files or objects remain
pwsh -File tools/package.ps1 -Action Check -Router root@192.168.1.1    # do Makefile, tag, hash, changelog, release and router agree?
pwsh -File tools/package.ps1 -Action Release -Version <version> -Amend -NotesFile CHANGELOG.md
```

`Build` and `Deploy` do the "from a local checkout" build described above.

- **Editing loop.** Use `Sync` while changing pages: it replaces `/www/flab` with a copy of `www/` in about a second
  and needs no SDK. Reload the browser: the page notices that the router's files changed and downloads them again
  (see [Browser cache](frontend.md#browser-cache)). `-Backend` also copies `rpcd/` to the places the package installs
  it and restarts rpcd; do not use it while a configuration apply is waiting for confirmation, because the rollback
  timer lives in rpcd's memory. `Sync -Backend` and `Deploy` both remove flab plugin, library and ACL files that no longer exist in `rpcd/`. Use `Deploy`
  before calling a change done: it exercises the real package (files, permissions, dependencies, scripts).
- **Versions.** The version of a working-tree apk is the Makefile's `PKG_VERSION`, and its release is the UTC build time
  (for example `flab-ui-<version>-r<UTC timestamp>.apk`), so it is clearly not the published `-r1`, upgrades it, and the
  next tagged version still sorts above it. `Deploy` verifies that the router reports exactly the version it built.
  The feed's Makefile is never modified by a working-tree build.
- **Keeping the release in step.** The Makefile (`PKG_VERSION`, `PKG_RELEASE:=1`, `PKG_HASH`), the tag `v<version>`, the
  changelog section and the GitHub release's apk name one version; only `Release` writes them, together. `Check`
  reports each of them and the apk installed on the router, and fails on a mismatch. It also fails when the feed's
  ACL files differ from the tag's `rpcd/acl.d`, or when the feed Makefile does not install a plugin, ACL file, page
  folder, stylesheet or module manifest of the tag, or names one it does not have. It also says how many commits
  the source is past the tag: those are not in the published apk.
- **Where the SDK is.** On Linux the build runs directly in bash. On Windows it runs in WSL (`-Distro`, default
  `Ubuntu-26.04`) and reaches the working tree through `/mnt`. `-Sdk` is the SDK directory as that shell sees it
  (default `$HOME/sdk/openwrt-sdk-*`; a glob is allowed).
- **SDK setup.** The SDK must already hold `admin/flab-ui` (copied or through a feed, as above) and have
  `CONFIG_PACKAGE_flab-ui=m` in its `.config`. The script checks that and says what is missing.
- **Router.** `-Router` defaults to the `FLAB_ROUTER` environment variable, else `root@192.168.1.1`. The router must run
  an apk-based OpenWrt.
- **Output.** `-OutDir` (default: `artifacts/packages` in the checkout, ignored by Git) receives the apk.
- **Removal.** `Remove` discovers and purges the metapackage, base package and every independently installed
  `flab-ui-mod-*` package in one apk transaction. It also cleans flab-owned web/backend files left by development
  syncs, removes copied apk files from `/tmp`, restarts rpcd, and verifies that no matching package, ubus object or
  installed artifact remains. It is safe to run when flab-ui is already absent.
- **What Deploy does.** It builds, copies the apk to the router, removes the installed package and adds the new one,
  then waits until rpcd serves one `flab.*` object per plugin in `rpcd/ucode/` and the page answers over HTTPS. Open
  `https://<router>/flab/` and sign in as root with the router's root password.
- **Building from the tag.** `-UseFeedSource` builds from the source the feed Makefile names (the tag tarball, whose
  hash the SDK checks) instead of the working tree; `Release` always does.

## Releasing

**To cut a release, one command does everything:**

```powershell
pwsh -File tools/package.ps1 -Action Cut -Message "<commit message>" [-Version <version>] [-Install -Router root@<router>]
```

Write the `## <version>` section of `CHANGELOG.md` first (it is the release notes). `Cut` then takes the patch after
the latest tag (or `-Version`), commits any pending changes with `-Message`, and, before anything is pushed or tagged,
checks that the feed `Makefile` (which is edited by hand, not by the workflow) installs every rpcd plugin, ACL file,
page folder, stylesheet and module manifest of the tree and defines, builds and lists in the metapackage every module
package; a new file that no package would install stops the release. It then pushes `main`, runs the hosted release
with `-Amend`, fast-forwards the local `packages` checkout to the feed branch the workflow rewrote, and runs `Check`, so
the packages `Makefile` (`PKG_VERSION`, `PKG_RELEASE`, `PKG_HASH`), the tag, the changelog, the GitHub release, the
feed's ACL files (which must equal the tag's `rpcd/acl.d`), the local and the remote repositories are verified to
agree. `-Install` also downloads the published apks, verifies their
checksums, installs them on the router and compares every installed file with the tag. Dropped connections to GitHub
are retried, and the workflow run is judged by its final status, not by the connection that watched it. `-DryRun`
builds on GitHub without touching anything. The apks are built by the hosted workflow, never locally.

The steps below are what `Cut` runs through `Release`.

The tag and the package Makefile have to name the same version. The feed definition lives in the packages fork,
separately from this source: the release tarball is finalized before its hash is recorded in the feed. A GitHub-hosted
workflow owns that sequence, so releases are reproducible and do not require a local WSL SDK:

```powershell
pwsh -File tools/package.ps1 -Action Release -Version <version> -Amend -NotesFile CHANGELOG.md
```

The local command checks that `main` is clean and matches `origin/main`, validates the tracked notes file and unused
tag, dispatches `.github/workflows/release.yml`, and waits for the hosted workflow.

The workflow:

1. Creates and pushes `v<version>`.
2. Downloads that tag's source tarball and calculates the hash that the feed Makefile will verify.
3. Updates `PKG_VERSION`, `PKG_RELEASE`, `PKG_HASH`, the license files and copied ACL integration files in the
   `flab-ui` branch of `formicalab/packages`.
4. Builds all thirteen APKs with a pinned OpenWrt 25.12.6 SDK from the immutable tag tarball.
5. Uploads the APK set and a combined SHA-256 file as workflow artifacts.
6. Pushes the package branch and creates the GitHub release with the APKs and checksums. `-Draft` creates a draft
   release.

`-Amend` folds the feed update into the existing single package commit and force-pushes with an explicit lease, so a local
`packages` checkout is left on the replaced commit until it is reset to the fork (`Release` and `Cut` do that when the
checkout is clean and differs only in the Makefile). The commit subject stays that of the first version it was made for.
Without it, the workflow adds `flab-ui: update to <version>`.
Use `-DryRun` to run the complete hosted APK build without creating a tag, changing the package branch or publishing a
release. Choose an unused version; these examples are placeholders.

Pinned actions (`actions/checkout`, `actions/upload-artifact`) are referenced by commit SHA with the version in a comment; update them deliberately.

The repository secret `PACKAGES_TOKEN` must be a fine-grained GitHub token limited to `formicalab/packages` with
**Contents: Read and write**. The workflow's normal `GITHUB_TOKEN` can tag and release `formicalab/flab-ui`, but it
cannot write the separate packages repository. The packages checkout does not keep the token; only the final push step
receives it, so the SDK download and the build never see it.

Router installation is intentionally a separate post-release check. Download the release APKs and install them with
the normal package commands, or use a trusted self-hosted workflow. A failed hosted build does not publish the package
branch, and a failed GitHub-release step can be retried from the retained tag and package commit.

## Preparing the feed pull request

Follow the current [contributing guide](https://github.com/openwrt/packages/blob/master/CONTRIBUTING.md) and
[review rules](https://github.com/openwrt/packages/blob/master/.github/llm-review-rules.md). Submit the package
definition and smoke test to `master`, not this application's source tree. Keep the source archive immutable and
hash-verified, use a real maintainer identity and matching `Signed-off-by`, and reset `PKG_RELEASE` on a version bump.
The source is architecture-independent, but fresh-image dependency checks and more than one board remain important.

Run the feed build, its `test.sh` and current upstream formalities before submission. The smoke test handles each
subpackage, compiles installed plugins, checks every plugin/ACL pair and validates base shared imports; it does not
exercise the web UI, actual rollback, or optional daemon behavior.
Keep the license notices of bundled third-party assets in the distributed package as well as in the source.
The contribution policy requires disclosure of AI assistance and human review. The current workflow stops at
preparation and updates to this source repository and its packages fork: do not open a PR against the main OpenWrt
repositories.

## Testing a plugin without rpcd

A Deploy, Sync or Remove replaces the plugins and the web files that a signed-in page uses (Sync without `-Backend` only
the web files), so do not run one while a browser
test is running on the same router. To test a plugin without rpcd: copy it and `rpcd/lib/flab/` to `/tmp`, then run it
with `ucode -L '/tmp/*.uc'` through a small script file (inline quoting over ssh is fragile).

## License

flab-ui is MIT licensed (see `LICENSE`). `www/vendor/bootstrap.min.css` is Bootstrap 5.3.3, `www/vendor/qrcode.js` is qrcode-generator 2.0.4 (MIT, Kazuhiko Arase) and the icon paths in
`www/js/core/icons.js` are Bootstrap Icons 1.11.3 (Copyright the Bootstrap Authors); all three are MIT licensed.
`www/LICENSE` carries the application and third-party notices and the MIT permission text; the package's existing
`www/` install rule includes it at `/www/flab/LICENSE`. Changes made after a published tag require a new release
before the feed tarball includes them.
The feed Makefile lists `LICENSE www/LICENSE` in `PKG_LICENSE_FILES`. The package and the bundled Bootstrap, Bootstrap Icons
and qrcode-generator all use MIT, so `PKG_LICENSE:=MIT` remains the correct SPDX expression; separate identifiers are not needed for multiple
components under the same license. `PKG_LICENSE_FILES` is optional OpenWrt metadata, but retaining the actual notices
in the distributed files is still required by MIT.
