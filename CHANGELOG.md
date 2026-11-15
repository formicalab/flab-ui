# Changelog

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
- Add regression tests, CI and disposable-image checks for installed ACLs and the normal login path.
- Refresh the README files, developer documentation and comments to describe the actual behavior and limitations.
