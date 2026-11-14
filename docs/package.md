# Package

## OpenWrt package

The `flab-ui` package (`admin/flab-ui` in the [openwrt/packages](https://github.com/openwrt/packages) feed) installs:

| Source | Installed to |
|---|---|
| `www/` | `/www/flab/` (served by uhttpd at `https://<router>/flab/`) |
| `rpcd/ucode/*.uc` | `/usr/share/rpcd/ucode/` |
| `rpcd/acl.d/*.json` | `/usr/share/rpcd/acl.d/` |
| `rpcd/lib/flab/*.uc` | `/usr/share/ucode/flab/` |

It depends only on `rpcd`, `rpcd-mod-ucode`, `ucode`, `ucode-mod-fs`, `ucode-mod-ubus`, `ucode-mod-uci`, `uhttpd` and
`uhttpd-mod-ubus`. The programs the pages read from (`swanctl`, `birdc`, `wg`, `nft`, `iw`, `nlbw`, ...) are optional
runtime tools, not dependencies: install the ones for the pages you use. Installing and removing the package reloads rpcd.
The package is built from the `v<version>` tag of this repository; `tests/` and `tools/` are not installed.

**Development loop with the package.** `tools/apk-deploy.ps1` builds the package from the working tree, not from the tag
tarball of the feed Makefile, and installs it with apk:

```powershell
pwsh -File flab-ui\tools\apk-deploy.ps1 -Action Deploy   # build, remove the installed flab-ui, add the new one, check
pwsh -File flab-ui\tools\apk-deploy.ps1 -Action Remove   # apk del flab-ui and check that no flab.* object is left
```

It needs an OpenWrt SDK in WSL (`-Distro`, `-Sdk`; defaults `Ubuntu-26.04`, `$HOME/sdk/openwrt-sdk-*`) whose feeds hold
`admin/flab-ui` from a checkout of openwrt/packages (a `src-link` feed, `./scripts/feeds install flab-ui`, and
`CONFIG_PACKAGE_flab-ui=m` in the SDK's `.config`). Deploy stages `www/`, `rpcd/` and `LICENSE`, builds with
`USE_SOURCE_DIR`, copies the apk to the router and replaces the installed package (apk does not reinstall the version
that is already installed, so the old one is removed first). It then waits until rpcd serves one `flab.*` object per
plugin in `rpcd/ucode/` and the page answers over HTTPS. The package is unsigned, so the router installs it with
`--allow-untrusted`. Open `https://<router>/flab/` and sign in as root with the router's root password. It needs
PowerShell 7 and `ssh`/`scp` with key auth to the router (default `root@openwrt.lab.formicalab.casa`; `scp -O` is used
because dropbear has no sftp-server).

Things to know:

- **Sharing one router.** A Deploy or Remove replaces the plugins and the web files that a signed-in page uses, so it must
  not run while a browser test is running. `tools/router-lock.ps1` is a reader-writer lock for sharing one test router
  between several people or agents: `-Mode Read` for anything that uses the router and the installed UI without replacing
  them (a `run.ps1` or `run.ps1 -Browser`; any number at once) and `-Mode Write` for `apk-deploy.ps1` (waits for the readers,
  and no new reader starts meanwhile). `-Suite <name>` names the suite a command runs, because two runs of one suite use the
  same folders on the router and must queue. For example
  `pwsh -File flab-ui\tools\router-lock.ps1 -Mode Read -Suite ddns -Command 'pwsh -NoProfile -File flab-ui\tests\ddns\run.ps1 -Browser'`.
- To test a plugin without rpcd: copy it and `rpcd/lib/flab/` to `/tmp`, then run it with
  `ucode -L '/tmp/*.uc'` through a small script file (inline quoting over ssh is fragile).

## License

flab-ui is MIT licensed (see `LICENSE`). `www/vendor/bootstrap.min.css` is Bootstrap 5.3.3 and the icon paths in
`www/js/core/icons.js` are Bootstrap Icons 1.11.3; both are MIT licensed (Copyright the Bootstrap Authors).
