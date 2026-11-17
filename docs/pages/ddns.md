# Dynamic DNS (route `#ddns`)
The ddns-scripts client (`/etc/config/ddns`) that keeps a DNS name pointing at the router's changing public address. The page
shows what each service is doing now and edits the config behind it; it needs `ddns-scripts` (and a provider package or a
custom update address) on the router, and says so when it is missing.
- **Tiles**: whether the updater (procd's `ddns` service) runs and how many enabled services it runs, how many services are up
  to date, when the last update was sent and when the next check is.
- **One card per service** (click the header to fold it, like the cards of the DHCP and DNS pages): the verdict in words, the addresses (the router's, where they come from,
  and the one the provider has registered), the last update and the next check, the check and forced-update intervals as the
  updater will really use them, and the updater's process. The verdict is one of *Up to date* (registered address equals the
  router's), *Update pending*, *Problem* (the newest warning or error in the log that no later success has put right), *Not
  running* (with the fatal error when the updater stopped on one), *Checking* (nothing looked up yet) and *Disabled*.
- **Actions**: *Check now* restarts the updater of that one service (it reads the address and updates the provider if it
  differs); *Force update* first forgets the last update, so the address is sent even if unchanged. Both are verified to touch only
  that instance, are off for a disabled service or a login without the `control` permission, and report the init script's
  output when it fails. *Log* opens the updater's own log for the service: the lines that matter (warnings, errors, notes), or
  every line, scrolled to the newest, with secrets masked.
- **Options**: every option of a service in folding groups (provider and account, detecting the address, custom provider,
  connection, intervals, logging), from the OpenWrt documentation and the updater's source, with a hint on each. Controls show
  only when they apply (for example *Update address* only without a provider, *Network* only for the network address source),
  and a provider's own needs (domain, username, password) are required only when its update address uses them. Options the page
  has no control for are listed read only. Services can be added (the section name is typed once and cannot be changed:
  letters, digits and underscores) and removed (until saved, with Undo). The **Global settings** card (folded: the
  documentation advises leaving them alone) holds the options of the `global` section.
- **Validation** (errors block Save; warnings do not): characters the updater refuses in host names, domains and addresses, numbers
  and units, a proxy without a port, an enabled service without a provider or update address, what the provider's update address
  contains, an address source without its setting; warnings for IPv6 with a provider that does not support it, HTTPS without
  certificates, a check below the updater's minimum (it is replaced, and the warning says by what), no interface set, a script
  provider that is not installed, options that need the `host` command on a router without it, and two enabled services for the
  same name and address family.
- **The password is write-only.** The page never receives it: it reads the config through the plugin, which leaves out any option
  that holds a secret (`password`, `*token*`, `*secret*`, `*apikey*`) and reports only whether it is set, and the password in a
  proxy address is masked. The box starts empty and says that one is stored; typing a value replaces it, empty keeps it. The review
  banner shows *new value (hidden)*, never the text. Log lines and errors are masked too. The ACL fragment does not grant `uci get`
  and the page never calls it.
- **Some characters need care in a password.** flab-ui never changes the ddns-scripts package, and ddns-scripts itself does not pass
  every character through: its `urlencode()` (every provider that puts `[PASSWORD]` in its update address) hands the string to
  `awk -v`, which reads a backslash as an escape, and indexes it by ASCII only, so an accented letter or the euro sign becomes
  `%00`; and the Cloudflare script writes the password inside single quotes that it later `eval`s, so a single quote ends the
  quoting (`$` is not a problem). The page therefore warns (the warning does not block Save) when a password holds a single quote, a
  backslash or a non-ASCII character, and says to choose one without them.
- **Saving** goes through `applyChange()` like the other editing pages (stage, apply with the rollback countdown, read the config
  back through the plugin, confirm); the check after a save also requires a typed password to be stored. A change the router does
  not keep is rolled back and the edit stays in the form. Changes already staged in the session are shown with a "Discard them"
  button. The page does not poll over unsaved edits, a focused control or a running action.
- **The plugin** (`flab.ddns`): `status` takes no arguments and returns the config without secrets, each service's runtime (from the
  updater's run files and log: registered address, last update and next check as epoch times, the pid from procd, the problem or
  fatal error from the log), the providers (name, IPv6 support, what the update address needs, script and whether it is installed;
  a provider in `/usr/share/ddns/custom` replaces one of the same name; the list is read again at most once a minute, because reading
  the ~70 provider files is the most expensive part of the call), the networks, devices and tools, whether the updater
  starts at boot, the version and the CA certificates. `log` reads one service's log (the newest 64 KB). `control` accepts only the
  name of an existing enabled service (letters, digits, underscore; at most 64) and the action `check` or `force`; every command is
  built from those validated words, and anything else is refused with a reason before a command runs. A device name read from a service
  (the `interface` address source) reaches a command only after `safe_ifname()` of `flab.util`, which also rejects a name with a line
  break (ucode's `^...$` matches the first line of a multi-line string). The ACL fragment
  (`rpcd/acl.d/flab-ddns.json`) grants `status` and `log` (read), `control` (write), and `uci` on the `ddns` config only.
- The intervals on a card are the ones the updater really uses: a `force_unit` without a `force_interval` applies the default number
  (72) in that unit, so `minutes` means a forced update every 72 minutes, and a check below the updater's minimum is replaced.
