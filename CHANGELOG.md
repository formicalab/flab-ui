# Changelog

## Unreleased

### Routing

- Show the policy rules, the static-route editor and the routing tables in lookup order (full-width rules card, then the
  static routes, then the tables overview, then the final list). The static-route description is part of "How the kernel
  picks a route": static routes are not a stage before or after the rules; each is an entry in a table (its Table option,
  else its interface's table) and is reached only through the rules that consult that table.
- Merge the four static-route tiles into one tile with the other tiles at the top: the number configured, and how many are
  installed, not installed and disabled.
- Add a "Consulted by" column to the static-route editor: the table each route lands in and the policy rules that look
  it up, with a "no rule" warning for a table nothing consults.

### Upgrades

- Make the browser pick up a new version by itself. uhttpd sends no `Cache-Control` and the package files have an
  old modification time, so browsers kept showing the previous pages (for example the removed "Static routes" tab)
  until a hard reload. The router now reports an identifier and the list of its web files (`flab.system build`), and
  the page downloads them again and restarts when the identifier changed. After upgrading from 0.1.4 or earlier,
  reload once with Ctrl+F5.

### Development

- Add `tools/package.ps1 -Action Sync` to copy the pages (and with `-Backend`, the rpcd files) to a router without
  building an apk, and `-Action Check` to verify that the Makefile, tag, hash, changelog, GitHub release and installed
  apk agree.
- Give working-tree apks a release number made of the build time, so they cannot be mistaken for the published `-r1`;
  `Deploy` now verifies that the router reports the version it built, installs normal file permissions and removes
  leftover web files before installing.

## 0.1.4 - 2026-11-15

### Routing

- Put static-route editing, policy rules and the final route list together on the Routes view.
- Include configured static routes in the final list, without duplicating installed entries; clearly label disabled,
  uninstalled and unverified configuration.
- Explain when netifd installs static routes and how policy rules, longest-prefix matching and metrics select between
  static, connected, DHCP and routing-daemon routes.
- Match installed routes by interface, gateway, metric, source prefix, destination, type and effective table.
- Verify changed enabled routes on running interfaces before confirming an apply; allow dormant routes to be saved.

### Reliability

- Reject pre-existing staged UCI changes across the entire session before saving.
- Bound browser requests and report uncertain apply/confirmation outcomes and failed cleanup explicitly.
- Prevent overlapping saves and confirmation dialogs.
- Move slow plugin work off rpcd's main event loop and bound command execution and output.
- Cap diagnostic job output and retained browser output, with explicit limit reporting.
- Load page modules on demand instead of downloading every page at startup.
- Recover local package Git state when release publication fails before the feed push.
- Allow release-specific changelog notes alongside the installation and checksum information.

### Packaging and testing

- Declare `ucode-mod-uloop` and include the bundled Bootstrap license notices in package metadata and installed files.
- Add local regression tests for worker concurrency, streaming limits, configuration recovery, lazy loading and
  SDK source isolation. Build and validate locally with the OpenWrt SDK in WSL; no repository CI workflow is included.
- Refresh the README files, developer documentation and comments to describe the actual behavior and limitations.
