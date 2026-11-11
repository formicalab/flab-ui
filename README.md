# flab-ui

A lightweight, LuCI-free administration UI for OpenWrt, developed and tested on the GL.iNet GL-MT6000
(1 GB RAM). It is a static single-page app served by `uhttpd`, talking to the router through the
standard `ubus` JSON-RPC endpoint and a few small `rpcd` ucode plugins.

> **Hard rule: no LuCI components.** flab-ui is a replacement for LuCI, so it must never call
> `luci-rpc`, `luci.*` ubus objects or any LuCI library. Read data directly from `swanctl`, `netifd`,
> `procd`, `nft`, `wg`, sysfs, the kernel (`ip`, `iw`, `hostapd_cli`) and `uci`. rpcd's own `uci` object
> (staged edits, apply with rollback) is part of rpcd, not LuCI, and is what configuration changes use.

It is deployed to tmpfs for testing and removed again with one command; nothing is installed permanently. Like
LuCI, it signs in with the router's own `root` login and creates no login of its own. Every page only reads the
router except System settings (`/etc/config/system`) and DHCP (`/etc/config/dhcp`); how changes are made safely is described in
[Configuration changes](#configuration-changes).

## Contents

1. [Architecture at a glance](#architecture-at-a-glance)
2. [Repository layout](#repository-layout)
3. [Frontend](#frontend)
4. [Backend (rpcd plugins)](#backend-rpcd-plugins)
5. [Security model](#security-model)
6. [Configuration changes](#configuration-changes)
7. [Deploy, test, clean up](#deploy-test-clean-up)
8. [How to add a page](#how-to-add-a-page)
9. [Pages](#pages)
10. [Testing](#testing)
11. [Implementation notes](#implementation-notes)
12. [Conventions](#conventions)

## Architecture at a glance

```
Browser (ES modules, Bootstrap 5.3 + Fluent theme, no build step)
   |  HTTPS POST /ubus   {"jsonrpc":"2.0","method":"call","params":[sid, object, method, args]}
   v
uhttpd  (ubus_prefix '/ubus', static files from /www/flab -> /tmp/flab)
   |  ubus
   v
rpcd ---- built-in objects:  session, system, network.interface, service, uci (configuration changes)
   |
   '----- ucode plugins (this repo): flab.wifi, flab.radio, flab.mesh, flab.wireguard, flab.firewall,
                |                    flab.network, flab.ipsec, flab.bgp, flab.sensors, flab.system, flab.logs
                |  import
                v
        shared ucode modules: flab.util, flab.vici
                |
                v
   swanctl --raw (VICI) · birdc · nft · wg · ip xfrm/route · hostapd_cli · iw · logread · dmesg · netifd · uci · sysfs
```

Design principles:

- **No build step, no framework.** Plain ES modules and CSS. The whole app (excluding Bootstrap) is
  small enough to run from the router's RAM.
- **Thin server, rich client.** Plugins return sanitized JSON; the browser does all presentation.
- **Everything is discovered at run time.** Ports, bridges, radios, tunnels, zones and peers come from the
  router on every poll; nothing is hard-coded to one board, so another router is reflected correctly.
- **The router's own login.** The UI signs in as `root` through rpcd, exactly as LuCI does, and creates no login.
  rpcd gives root read and write `*`, which means every ACL group installed on the router; the ACL fragments in
  `rpcd/acl.d` are what add the flab-ui calls to it. Everything the plugins and pages read or write is therefore
  limited by what root may do, and by the safeguards below (validation, apply with rollback).
- **Modular by page.** One folder or file per page on each side, registered in one list.
- **No secrets leave the router.** Plugins whitelist fields; key material is never forwarded, and log lines
  that look like secrets are redacted.

## Repository layout

```
flab-ui/
  deploy.ps1                 Deploy / Cleanup script (PowerShell 7)
  tools/gen-zones.py         Regenerates pages/settings/zones.js from the IANA time zone database
  tests/                     bgp/, dhcp/, ipsec/, network/ (network, Wi-Fi, mesh, WireGuard, firewall, logs, helpers), settings/,
                             TestSession.ps1 (the temporary rpcd session the browser tests sign in with)
  www/                       Static site, deployed to /tmp/flab and linked at /www/flab
    index.html               Shell page: loads vendor CSS, css/base.css and js/main.js
    vendor/bootstrap.min.css Bootstrap 5.3.3, vendored so the UI works offline
    css/
      base.css               Fluent tokens, app shell, shared component styles, sign-in screen
      <page>.css             Page-specific styles, loaded on first visit
      forms.css              Shared form and review-banner styles (System settings, DHCP)
    js/
      main.js                Entry point: theme + start the app
      core/                  Framework-level modules shared by all pages
        app.js               Shell: nav pane, command bar, hash routing, refresh loop
        ubus.js              ubus JSON-RPC transport, session, AuthError, optional(), can()
        uci.js               The one wrapper for rpcd's `uci` object (staged edits, apply with rollback, applyChange())
        ops.js               stageOps(): turns a change plan (set / add / delete operations) into staged uci calls
        fields.js            Pure form-field model: option readers, value checks (IP, MAC, duration, ...), fieldError()
        forms.js             Form building blocks: legend, note, fieldRow(), the sticky review banner
        login.js             Sign-in screen (inline SVG and CSS only)
        dom.js               h() element builder (XSS-safe), byId()
        ui.js                Components: card, tile(s), table, badge, chip, kv, lifebar, meter, sparkline,
                             healthBanner, muted, mono, GRADE_KIND
        controls.js          Command-bar controls: search, select, pause, toggle, refresh
        format.js            Bytes, line rates, durations, numbers
        rates.js             Rate tracker: turns cumulative counters into rates/ratios between polls
        icons.js             Inlined Bootstrap Icons path data, icon(name)
        theme.js             Follows the OS light/dark preference
      pages/
        index.js             Page registry and the page contract (read this first)
        overview/            index.js, cpu.js, temperatures.js
        network/             Wired network: index.js, shared.js, topology.js, tile.js, chips.js, ports.js, diagnostics.js, util.js
        bridges/             index.js, card.js
        wifi/                index.js (clients), radios.js (radio cards); mesh interfaces are left to mesh/
        mesh/                index.js, node.js
        ipsec/               index.js, connection.js, daemon.js, names.js, rates.js
        wireguard/           index.js, iface.js
        firewall/            index.js, model.js (pure zone matrix), matrix.js, zones.js, rules.js, util.js
        dhcp/                DHCP: index.js, schema.js (the options), model.js (pure), leases.js, reservations.js, pools.js
        interfaces/          Devices and Interfaces: index.js, layers.js (pure model), table.js
        bgp/                 index.js, topology.js, peer.js, routes.js, announced.js, system.js, util.js
        services.js          procd services
        logs/                index.js, entries.js (pure helpers)
        settings/            System settings: index.js, schema.js (the options), model.js (pure: validation, change plan), zones.js (generated)
  rpcd/
    ucode/flab.<name>.uc     rpcd plugins  -> /usr/share/rpcd/ucode/
    acl.d/flab-<name>.json   ACL fragments -> /usr/share/rpcd/acl.d/
    lib/flab/*.uc            Shared ucode modules -> /usr/share/ucode/flab/ (import 'flab.util')
```

## Frontend

### Boot and routing (`js/core/app.js`)

- `main.js` calls `initTheme()` then `start()`.
- Routing is hash based (`#overview`, `#wifi`, ...). The first entry in `pages/index.js` is the default.
- On every route change the shell rebuilds: navigation pane, command bar (page title, the page's
  persistent controls, "Updated hh:mm:ss" stamp) and a `<main>` results area.
- `page.load()` fetches data, `page.view(data, rerender)` returns nodes. A `setInterval` repeats
  `load()` every `page.interval` ms unless `page.isPaused()` is true.
- Page CSS (`page.css`) is added once to `<head>` the first time the page opens.
- An `AuthError` anywhere returns the user to the sign-in screen ("Session expired").

### Page contract

Every page is a plain object, default-exported from its module (full text in `js/pages/index.js`):

| Member | Required | Meaning |
|---|---|---|
| `id` | yes | Route name / URL hash |
| `label` | yes | Navigation text (`title` optionally overrides the command-bar heading) |
| `icon` | yes | Name from `core/icons.js` |
| `nav` | no | `'bottom'` puts the link below the spacer, next to Sign out (System settings); default is the main list |
| `interval` | yes | Auto-refresh period in ms |
| `load()` | yes | Async; returns the page data, usually one ubus call |
| `view(data, rerender)` | yes | Returns an array of DOM nodes |
| `controls({ rerender, reload })` | no | Returns `{ nodes, update?(data) }`; controls persist across refreshes |
| `isPaused()` | no | Return true to suspend auto-refresh |
| `css` | no | Stylesheet (or array of stylesheets) loaded on first visit |

**State that must survive refreshes** (filter text, sort order, selected radio, paused flag, scroll
position) lives in a module-level `state` object in the page, never in the DOM. The controls are created
once per route; only `<main>` is redrawn on refresh, so typing in a filter box is never interrupted.

### Core building blocks

- **`h(tag, props, ...children)`** builds elements from properties and text nodes only. Router data is
  therefore never parsed as HTML. Never use `innerHTML` with data (the only `innerHTML` is static markup:
  the icon path data in `icons.js` and the sign-in logo).
- **`ui.js`** components: `card`, `tile`/`tiles` (KPI row), `table`, `badge` (soft pill: `success`,
  `warning`, `danger`, `info`), `chip`, `kv` (label/value list), `section`, `lifebar`, `meter`,
  `sparkline`, `emptyState`, `button`, `healthBanner` (findings list or all-clear), `muted` and `mono`
  (inline text), `GRADE_KIND` (badge kind of the A+ to D security grades).
- **`controls.js`**: `searchControl`, `selectControl`, `pauseControl`, `toggleControl`, `refreshControl`
  bind to a page's `state` object.
- **`format.js`**: `fmtBytes`, `fmtBps`, `fmtLine` (bytes per second as Mbit/s), `fmtDur`, `fmtSpan`,
  `fmtNum`, `fmtRate`.
- **`rates.js`**: `createTracker()` turns the cumulative counters the router reports into per-second rates
  and ratios from successive polls. A series restarts after a gap (polling paused, background tab), a counter
  that goes backwards counts as zero, and `keep()` drops series whose key disappeared. Every page that shows
  live traffic uses it; `pages/ipsec/rates.js` only chooses which IPsec counters to feed it.
- **`ubus.js`**: `ubus(object, method, args)`. A JSON-RPC error `-32002` is ambiguous (expired session
  or ACL denial), so it asks `session.access` to tell them apart: an expired session raises
  `AuthError`; an ACL denial raises a normal error naming the object and method. `optional(promise)`
  resolves to `null` for data a page can do without (a missing plugin or ACL) but still raises
  `AuthError`. `can(object, method)` answers from the ACLs returned at sign-in (root's `*` allows everything),
  so a page can disable controls the login may not use.
- **`uci.js`**: the only code that calls rpcd's `uci` object, see [Configuration changes](#configuration-changes).
  `applyChange()` runs a whole change with its safety net; pages should call that, not the single steps.
- The session id and ACLs live in `sessionStorage` (cleared when the tab closes). Login timeout is 900 s.

### Styling

- Bootstrap 5.3 supplies grid, forms, tables and utilities; `css/base.css` layers a Fluent 2 look on
  top through `--fl-*` CSS variables (surfaces, strokes, brand, soft status colors) for light and dark.
- Light/dark follows the OS (`prefers-color-scheme`) via Bootstrap's `data-bs-theme`.
- The layout fills the whole viewport: a 240 px navigation pane, a sticky acrylic command bar, then a
  fluid content area. Tables use `table-layout: fixed` with percentage column widths where several tables
  must align (`.fixed-grid`, widths must sum to 100).
- Prefer the `--fl-*` variables over hard-coded colors so both themes keep working.
- Shared pieces (status `.dot`, health banner, table helpers) live in `base.css` because page CSS is
  loaded lazily.
- **Legends and "how to read" notes sit at the top of the card or section they explain**, so the key is read
  before the data. Keep that when adding a page.

### Page-specific frontend notes

- **IPsec**: `connection.js` renders one card per connection from the backend JSON; `names.js` maps
  strongSwan identifiers to friendly names (`AES_GCM_16`+256 to `AES-256-GCM`); `rates.js` feeds the shared
  tracker with the `xfrmN` interface counters (they survive child SA rekeys), keyed by the backend's
  `conn.key`; `daemon.js` shows daemon state and the score model.
- **Overview**: the sensors and CPU calls are optional, so a missing plugin or ACL hides that section
  instead of breaking the page. `cpu.js` keeps the sample history and builds the CPU card;
  `temperatures.js` builds the temperature cards.
- **BGP**: `index.js` owns the page state and composes the sections; `topology.js`, `peer.js`, `routes.js`,
  `announced.js` and `system.js` each export card builders that take the backend data; `util.js` holds the
  per-peer color helpers, AS-path chips and prefix sort key.
- **Pure models**: `firewall/model.js` (zone matrix), `interfaces/layers.js` (network layers),
  `logs/entries.js` (log filtering and formatting), `settings/model.js` and `dhcp/model.js` (validation and the
  UCI change plan) and `core/fields.js` (field checks)
  have no DOM access and are unit-tested on their own.

## Backend (rpcd plugins)

rpcd loads every `*.uc` file in `/usr/share/rpcd/ucode/`; each plugin returns an object
mapping ubus object names to methods:

```ucode
return {
  'flab.example': {
    status: { call: function(request) { return { ... }; } },
  },
};
```

| Plugin | ubus object | Method | Sources |
|---|---|---|---|
| `flab.wifi.uc` | `flab.wifi` | `clients` | uci wireless/network/dhcp, ubus `network.wireless`, `dhcp`, `hostapd.<if>`; `hostapd_cli all_sta`, `iw station dump`, `/proc/net/arp`, `ip -6 neigh` |
| `flab.radio.uc` | `flab.radio` | `status` | uci wireless, ubus `network.wireless`, `hostapd.<if>`; `iw dev/phy info`, `iw survey dump`, `iwinfo`, `iw reg get`; sysfs counters |
| `flab.mesh.uc` | `flab.mesh` | `status` | uci wireless (`wifi-iface mode=mesh`), ubus `network.wireless`; `iw dev/station dump`, `iw mpath dump`, `iw mpp dump`, `iw get mesh_param`; sysfs counters |
| `flab.wireguard.uc` | `flab.wireguard` | `status` | uci network (`proto wireguard` interfaces and `wireguard_<if>` peer sections), uci firewall (zone); `wg show <if> public-key/listen-port/peers/endpoints/allowed-ips/latest-handshakes/transfer/persistent-keepalive` (the single-field forms never print the private or pre-shared key); sysfs MTU and counters |
| `flab.firewall.uc` | `flab.firewall` | `status` | uci firewall (defaults, zones, forwardings, `rule`, `redirect`, `nat`, `include`, `ipset`), uci network (interface names); `nft -j list ruleset` (per-rule hit counters matched through the `!fw4: <name>` comment, reject/drop chain counters per zone, the devices behind each zone, flowtable devices, base chain policies); procfs conntrack count and limit |
| `flab.network.uc` | `flab.network` | `status` | ubus `network.device status` (netifd); sysfs `/sys/class/net/<if>/{carrier,bridge,brport}`; the bridge forwarding table `brforward`; `ethtool -i/-S`, `/sys/class/mdio_bus`, `/proc/device-tree` (hardware and switch wiring), `/etc/board.json` (LAN/WAN roles and port order); uci network (`tunlink`), uci firewall (zones, forwardings), uci dhcp (DHCP/RA service per interface); `logread` (error log lines) |
| `flab.ipsec.uc` | `flab.ipsec` | `status` | `swanctl --raw` (via `flab.vici`), `ip -s xfrm state`, `network.device`, uci network |
| `flab.bgp.uc` | `flab.bgp` | `status` | `birdc` (`show status`, `show protocols all`, `show route all`, `show route export <peer>`, `show memory`), `ip -4 route show proto bird` |
| `flab.sensors.uc` | `flab.sensors` | `status` | sysfs `/sys/class/thermal`, `/sys/class/hwmon` |
| `flab.system.uc` | `flab.system` | `cpu` | procfs `/proc/stat`, `/proc/loadavg`, `/proc/uptime` |
| `flab.logs.uc` | `flab.logs` | `read` (`lines`, `source`) | `logread -l N` (logd ring buffer), `dmesg -r`, `/proc/uptime`; entries are parsed and secret-looking values redacted |

The System settings page needs no plugin: it reads `/etc/config/system` through rpcd's own `uci` object, whose
calls (on the `system` config only) are granted by `rpcd/acl.d/flab-settings.json`; the DHCP page likewise uses
`rpcd/acl.d/flab-dhcp.json` (ubus `dhcp` methods, `uci` read and write on `dhcp`).

Shared modules (`rpcd/lib/flab/`, imported as `flab.util` and `flab.vici`):

- **`flab.util`**: `run(cmd)`, `ubus_call(conn, object, method, args)`, `uci_all(config)`, `sysfs(path)`,
  `fixture(name)`, `safe_ifname()`, `normalize_mac()`, `num()`, `as_list()` (a UCI option as a list),
  `iw_channel_info()` (channel, width and TX power from `iw dev <if> info`) and `security_label()`
  (human label of a wireless `encryption` value). They are also the test seam: with `FLAB_FIXTURES=<dir>`
  set (rpcd never does) `run()` returns `<dir>/<command>.txt` instead of executing the command (file name =
  the command with every run of non-alphanumerics turned into `_` and a trailing `2>/dev/null` dropped),
  `ubus_call()` reads `<object>_<method>.json`, `uci_all()` reads `uci_<config>.json` and `sysfs()` looks
  the path up in `files.json`. A plugin written with these helpers is testable without any plugin-specific
  hook. With `FLAB_RECORD=<dir>` set the same helpers save what they read under those names (keys,
  passwords and WireGuard keys blanked), so a fixture set is captured by running the plugin once;
  `tests/network/run.ps1` does exactly that.
- **`flab.vici`**: parses `swanctl --list-sas|--list-conns|--stats --raw` output into nested objects.
  The raw format is `name {key=value list=[a b] section {...}}`; values may contain spaces
  (`class=pre-shared key`), so a value ends where the next `key=` or `key {` begins. `events()` returns
  every event (several IKE SAs can share a connection name); `query()` merges them by name and is only
  safe where names are unique (`list-conns`); `reply()` is for request/reply commands such as `stats`.

### Backend rules

- **Whitelist fields.** Build the response explicitly; never pass a raw dump through. `flab.ipsec`
  parses `ip xfrm state` but only copies algorithm names, sizes, counters and encapsulation; the key hex
  is dropped. `flab.wifi` never copies Wi-Fi keys from `network.wireless status`; `flab.wireguard` only uses
  `wg show` forms that never print keys.
- **Redact free text.** `flab.logs` replaces values after `password`, `psk`, `secret`, `token`, `key` and
  similar names with `<redacted>`, because daemons sometimes log them and the page shows them to anyone who
  can sign in (and they end up in downloaded files).
- **Never call a ubus object served by rpcd itself** from a plugin (any `flab.*`, `session`, `file`, ...).
  rpcd runs plugins in-process, so the call blocks its own event loop. Calling `netifd`, `hostapd.*`,
  `dhcp`, `network.*` objects is fine.
- **Shell safety.** Anything interpolated into a command line must be validated (`safe_ifname`).
- **Speed.** Collect once per call and cache in local variables. The UI polls every 3 to 10 s; the logs
  plugin returns at most 2000 lines per source (500 by default) so a poll stays small.
- **ucode specifics.** Arrays have no methods (`push(arr, x)`, `slice(arr, 1)`, not `arr.push`). Function
  declarations are not hoisted: define a helper before its caller. Redeclaring a `let` makes rpcd silently
  skip the plugin. Regular expressions are POSIX ERE (no `(?:` non-capturing groups, no lazy quantifiers); the
  code uses `[[:space:]]` instead of `\s` in classes. Use `100000.0` to force float division. Optional
  chaining (`a?.b`) and `??` work. `ucode -c <plugin>.uc` checks syntax (library modules with `export`
  cannot be compiled that way).

## Security model

- **The router's own login.** The UI signs in with rpcd's `session login`, as `root` (the login every OpenWrt
  router has, with read and write `*` on everything), exactly as LuCI does. flab-ui creates no login, installs no
  ACL and changes no rpcd configuration, so it can never grant itself or anyone else more than root already has,
  and nothing about it persists in `/etc/config/rpcd`.
- **What protects the router** is therefore the root password, HTTPS, the ACL fragments (each lists exactly the
  ubus calls and uci configs its page uses; the settings fragment grants `uci` write on `system` only), and the
  care the pages take: input is validated before it is staged, changes are applied with an automatic rollback,
  and nothing secret is forwarded or displayed (see [Backend rules](#backend-rules)).
- **Session.** The session id and the ACLs rpcd returned live in `sessionStorage` (this tab only, gone when it
  closes). The session expires after 900 s without use, and Sign out destroys it on the router.
- **Known exposure.** The page lists and edits the options of `/etc/config/system` for anyone who can sign in as
  root; there is no per-option restriction and none is needed. Plugins run inside rpcd with its privileges, which
  is why they whitelist the fields they return.
- **Transport.** uhttpd redirects HTTP to HTTPS and serves with the router certificate. The session token
  travels in the request body, not a cookie, so cross-site requests cannot ride on it.
- **Tests never need the root password.** The browser tests create a temporary rpcd session over ssh and grant
  it exactly what the ACL fragments grant, which is what root holds (`tests/TestSession.ps1`); a missing or wrong
  fragment fails a test as it fails a page for root. The session is destroyed when the test ends.

## Configuration changes

System settings and DHCP change the router, and set the pattern every later editing page follows. The signed-in login (root) may write; a login that may not (`can('uci', 'set')` is false) gets the same
page with every control disabled and a note saying why.

**Flow** (all of it is rpcd's `uci` object, wrapped by `www/js/core/uci.js`; pages call `applyChange()`, not the
single steps):

1. **Stage.** `uci.set`, `uci.add`, `uci.delete` write into the session's staging area; the configuration on
   flash is untouched. rpcd keeps the staging area **per session**, so a second session never sees it.
2. **Review.** `uci.changes()` lists what is staged and `uci.pending()` counts it; `uci.revert()` throws it
   away. `set` takes values as given (rpcd rejects `null`); to remove an option use `uci.delete(config,
   section, [option])`.
3. **Apply.** `uci.apply()` commits the staged changes, reloads the affected services (procd reload
   triggers, for example `system` and `sysntpd` on a `system` change) and starts a countdown
   (`APPLY_TIMEOUT_S`, 30 s).
4. **Verify and confirm.** The page reads the config back (which also proves the router is still reachable) and
   then calls `uci.confirm()` within the countdown. If the check fails the page calls `uci.rollback()` at once;
   if the page is closed or the connection is cut, the countdown runs out and rpcd restores the previous
   configuration by itself. That rollback is what makes it safe to edit network and firewall settings remotely.
5. **Clean up.** After any rollback rpcd puts the rolled-back edits back into the session's staging area so
   they can be retried. `applyChange()` discards them, so the next attempt starts clean, and refuses to start
   while something is already staged (apply would commit it too); System settings shows such leftovers with a
   "Discard them" button.

`applyChange(ed, configs, stage, verify)` does steps 1 to 5 and throws an Error whose message says what
happened; the router is on its previous configuration after every failure.

**Rules for the page that edits.**
- Describe the options as data (`settings/schema.js`, `dhcp/schema.js`) and keep the model pure
  (`settings/model.js`: the form's draft, validation, the change list, the UCI operations, the read-back check),
  so the page is only controls. Field checks, form rows and the sticky review banner are shared
  (`core/fields.js`, `core/forms.js`, `core/ops.js`, `css/forms.css`).
- Validate input in the page before staging; `uci` itself has no schema. Show the effect of the edits (the
  review list) before saving, and disable Save while anything is invalid.
- Write only what changed, delete an emptied option instead of storing an empty string, and leave options the
  page does not know untouched.
- Do not poll over unsaved edits: the shell redraws the page on every poll, so `isPaused()` must return true
  while there is something to lose.
- Mirror a change made to the router's configuration into `build/MT6000/etc/config/` in this repository.

**Status.** `core/ubus.js` and `core/uci.js` (including `applyChange`) are unit-tested against a fake transport
(`tests/network/uci.test.mjs`); the System settings and DHCP suites test their models and drive the whole flow in a
browser against a mock router. The real path was exercised against the router with the System settings model and
`applyChange`,
restoring the configuration afterwards: a confirmed change (zone, description, log port, NTP servers and
switch), the removal of options, a custom zone rule, a forced rollback and the countdown rollback of an
unconfirmed apply.

## Deploy, test, clean up

Requires PowerShell 7, `ssh`/`scp` with key auth to the router (default `root@openwrt.lab.formicalab.casa`).

```powershell
# Install. Open https://<router>/flab/ and sign in as root with the router's root password
pwsh -File flab-ui\deploy.ps1 -Action Deploy

# Remove every trace from the router
pwsh -File flab-ui\deploy.ps1 -Action Cleanup
```

What Deploy does:

1. Runs the cleanup script first (idempotent).
2. Copies `www/` to `/tmp/flab` (tmpfs, gone after a reboot) and symlinks `/www/flab` to it.
3. Copies `rpcd/ucode/*` to `/usr/share/rpcd/ucode/`, `rpcd/acl.d/*` to `/usr/share/rpcd/acl.d/` and
   `rpcd/lib/flab/*` to `/usr/share/ucode/flab/`.
4. **Restarts rpcd**, which only reads its plugins and ACL fragments at start.

Cleanup removes all of the above and restarts rpcd again. No login or rpcd setting is created or changed.

Things to know:

- `rpcd` is **restarted**, so every deploy/cleanup ends the active rpcd sessions (LuCI's and flab-ui's).
- Flash writes are limited to the rpcd plugin and ACL files and the symlink; Cleanup removes them.
- `scp -O` is required (dropbear has no sftp-server).
- After editing a front-end file, a quick iteration is `scp -O <file> root@<router>:/tmp/flab/<path>` and
  Ctrl+F5. Backend changes need the file copied to `/usr/share/rpcd/ucode/` (or `/usr/share/ucode/flab/`) and
  `/etc/init.d/rpcd restart`.
- To test a plugin without rpcd: copy it and `rpcd/lib/flab/` to `/tmp`, then run it with
  `ucode -L '/tmp/*.uc'` through a small script file (inline quoting over ssh is fragile).

## How to add a page

Example: a `dhcp` page.

1. **Backend (only if new data is needed).**
   - `rpcd/ucode/flab.dhcp.uc` returning `{ 'flab.dhcp': { status: { call() {...} } } }`. Reuse
     `import { run } from 'flab.util'` and, for strongSwan-style output, `flab.vici`.
   - `rpcd/acl.d/flab-dhcp.json`, so that root (read and write `*`) may call it:
     ```json
     { "flab": { "description": "flab-ui DHCP page",
                 "read": { "ubus": { "flab.dhcp": ["status"] } }, "write": {} } }
     ```
     A page that reads or writes a config through rpcd's `uci` object needs a fragment too, listing the config
     in its `uci` read (and write) lists, like `flab-settings.json`.
   - Prefer data sources that are not LuCI (see the hard rule above), and rpcd's own `uci`, `system` and
     `service` objects where they are enough: no plugin is needed for those.
2. **Frontend.** Create `www/js/pages/dhcp.js` (or a `dhcp/` folder with `index.js` plus helpers):
   ```js
   import { ubus } from '../core/ubus.js';
   import { card, table } from '../core/ui.js';
   export default {
     id: 'dhcp', label: 'DHCP', icon: 'hdd-stack', interval: 10000,
     load: () => ubus('flab.dhcp', 'status'),
     view: data => [card('Leases', table(['Host', 'IP'], data.leases.map(l => [l.name, l.ip])))],
   };
   ```
   Add `css: 'css/dhcp.css'` and the file if the page needs its own styles.
3. **Register.** Import it in `www/js/pages/index.js` and add it to the `pages` array. Array order is
   navigation order.
4. **Icons.** If you need a new icon, paste its `<path>` markup from icons.getbootstrap.com into the
   `PATHS` map in `core/icons.js`.
5. **Tests.** Add the plugin to `$plugins` in `tests/network/run.ps1`, scenarios to `tests/network/mkfx.mjs`,
   assertions to `assert.mjs` and a browser section to `live.mjs` (or extend the suite that fits best).
6. **Deploy and test** with `deploy.ps1`; every file in `rpcd/` and `www/` is picked up automatically.

Reuse before writing new code: if two pages need the same widget, move it to `core/ui.js`; if the same
parsing is needed by two plugins, move it to `rpcd/lib/flab/`. Comment every function and lookup table, put
legends at the top of the card they explain, and keep pure logic (models, filters) in a DOM-free module with a
unit test.

## Pages

Navigation order: Overview · Wired network · Bridges · Wi-Fi · Mesh · IPsec VPN · WireGuard · Firewall · DHCP ·
Devices and Interfaces · BGP · Services · Logs, then Settings at the bottom, next to Sign out. The network
pages run from the physical layer up; Devices and Interfaces recaps how they fit together, followed by routing
(BGP), the procd services and the logs.

### Overview (default)
KPI tiles (uptime, CPU usage, load, memory, CPU temperature, hottest sensor), a CPU load card, a
Temperatures card, system info (including the kernel version) and the memory breakdown.

**CPU load** comes from `flab.system cpu`, which returns the kernel's cumulative counters from
`/proc/stat` (plus load average and task counts). Utilization is a rate, so the browser derives it from
the difference between two successive samples (`overview/cpu.js`): total busy percentage, a stacked bar per
state (user, system, interrupts = irq + softirq, I/O wait, steal), one bar per core and a 60-sample history
chart. "Busy" excludes idle and I/O wait, like top and htop. On a router the interrupts share is worth
watching: packet forwarding and Wi-Fi show up as softirq. The first visit takes a second sample a moment after
the first, so numbers appear immediately; the history restarts if the router uptime shows a gap longer than
20 s (page paused or not open), since a delta over minutes would be a misleading average. A fixed-clock CPU
(no cpufreq policy) shows no frequency.

Temperatures come from `flab.sensors`: thermal zones plus hwmon sensors (deduplicated, since the CPU appears
as both). Health: Normal below 75 C, Warm from 75 C, Hot from 90 C or at a sensor's own throttle/critical
limit. Also shows CPU trip points, throttling state and cooling devices (passive only when no fan is reported).

### Wired network (route `#network`)
Refreshed every 3 s. The physical ports only; bridges and the layered device/interface view have their own
pages. The backend (`flab.network`) classifies whatever netifd reports (`devtype` dsa/ethernet = port, bridge,
vlan), so another board or a new bridge shows up on the next poll. `shared.js` holds the loader and the
address helpers the three network pages share.

- **Summary tiles and health banner**: ports linked, live throughput of the external ports, switch chip,
  errors and drops, link changes. The banner lists what needs attention: a downshifted link (negotiated speed
  below what both ends support), link flaps and new errors since the page was opened.
- **Port topology** (`topology.js`, `tile.js`, `chips.js`): the wiring of the Ethernet ports, drawn from what
  the router reports: SoC, its MAC(s), the CPU port and link speed into the switch chip, the chip with its
  numbered switch ports, an external PHY where one exists, and one jack per column (green/amber/gray by link
  state, LAN/WAN label, speed, live rate, chart, bridge, STP role, VLAN devices). Jacks follow the order
  `/etc/board.json` lists its ports (usually the order on the case) with each switch's ports kept together; a
  switch's CPU port and the SoC MAC behind it come from the device tree (`ports/port@N` with an `ethernet`
  property, matched to the MAC by phandle); a port has an external PHY when its node has a `phy-handle`,
  otherwise the switch's internal one. A router without a switch gets MAC, PHY and jack columns. `chips.js`
  adds a one-line description for a few well-known chips (MT7531, RTL8221B, ...); an unknown chip shows only
  its name.
- **Port table** (`ports.js`): the hardware, link, speed and duplex, negotiation (auto/forced, max speed,
  partner speed, pause), live and total traffic, errors and drops, link-change counter, STP state and role,
  learned MACs and VLAN devices per port. A missing link is shown in neutral gray, not red: an unplugged port
  is normal.
- **Hardware** (when known): the PHY chip (driver name, ID, MDIO address and bus), the switch chip (from the
  device tree of the DSA switch node), the SoC Ethernet MAC, the kernel driver and bus, and the medium. The
  backend reads it once per port (`ethtool -i`, `ethtool`, `/sys/class/mdio_bus`, device-tree `compatible`)
  and caches it. A DSA port's PHY is the one at its `PHYAD` that is not attached to another netdev, which
  keeps a switch port on the switch's internal PHY instead of the SoC-bus PHY with the same address.
- **Error breakdown**: a port with errors or drops gets a Details button that opens a panel under it (it
  stays open across refreshes): the non-zero kernel counters with an explanation of each, the driver's own
  error counters (`ethtool -S`, error-like names only), recent system-log lines that mention the port, and
  whether anything is new since the page was opened. The backend only computes this for ports that have
  errors or drops.

### Bridges (route `#bridges`)
Same data as the Wired network page (one `flab.network` call), one card per bridge (`card.js`). Tiles:
bridges, spanning-tree position, learned MACs. The health banner lists a blocked (alternate) STP port, a
topology change, a down bridge, STP off with several linked ports. Each card shows the spanning-tree position
(this bridge is the root, or the root bridge ID, the root port and path cost), bridge ID, priority, timers,
aging, learned MACs, VLAN filtering and default PVID, IGMP snooping, VLAN devices, addresses of the logical
interfaces on it, and a member table with type (Ethernet or Wi-Fi with SSID), link, STP state and role, port
cost, MACs learned per port and live throughput.

Learned MACs per port come from the kernel's binary forwarding table (`/sys/class/net/<bridge>/brforward`, 16
bytes per entry; the port number is the low byte at offset 6 plus the high byte at offset 12), because the
`bridge` utility is not installed. The CPU link (the DSA conduit) carries every switch port's traffic, so it
is excluded from the throughput tile.

### Wi-Fi (route `#wifi`)
Two sections, both refreshed every 5 s.

**Radios** (`flab.radio`, `wifi/radios.js`): one card per radio from UCI `wifi-device`. Header with band, phy,
state, standards and hardware; key figures (running channel, frequency, width, center, TX power, noise floor,
antennas, clients); the configuration next to what is actually running (channel, mode, TX power with the
regulatory limit of that channel, country vs active regulatory domain, cell density, beacon interval,
options); channel utilization (busy, RX and TX airtime as a percentage and chart, derived in the browser from
the driver's cumulative survey counters); the channels allowed by the regulatory domain with the running
channel and its width span highlighted and DFS (radar) channels marked; and a table of the SSIDs (BSSID,
networks, security, clients, live and total traffic, 802.11r/k/v, WPS, OCV, hidden, isolation, MAC filter
policy with entry count, BSS status). Findings appear when something is off: radio down, setup failing,
running channel different from the configured one, high noise, busy channel, DFS availability check in
progress, open network, country mismatch. Only whitelisted options are copied: keys, passwords, FT key
material and MAC lists never leave the router. Mesh (802.11s) interfaces are not listed here: a radio
carrying one shows a `mesh · <id>` badge linking to the Mesh page, and mesh peers are not in the clients list.

**Clients** (`flab.wifi`, a port of `utilities/list_connected_devices.uc`): clients per radio and SSID with
MAC, IPv4/IPv6, hostname, signal, Wi-Fi standard, bandwidth, TX/RX bitrate, security label, AKM/SAE
group/cipher/PMF details and the 0-100 security score (AKM, cipher, SAE group and PMF scoring). Filter, radio
selector, sortable columns, pause and a legend above the tables.

### Mesh (route `#mesh`)
Refreshed every 5 s, from `flab.mesh`. Discovered from UCI: one node card per `wifi-iface` with `mode=mesh`,
so a router without mesh shows an empty page and a second mesh interface gets its own card.
- **Tiles**: mesh interfaces, peers established, weakest link (signal), mesh paths, forwarding.
- **Node card** (`node.js`): mesh ID, interface, MAC, security label (SAE/WPA3 detected from the encryption
  setting), channel, frequency and width, traffic counters. A configured interface that is not running says
  so and shows no live data.
- **Peers**: link state (ESTAB, LISTEN, ...), signal and average, TX/RX bit rate, airtime link metric,
  expected throughput, connected time, retries and failed transmissions, mesh gate flag.
- **Paths**: destination, next hop, hop count, metric, lifetime and the decoded flags (active, resolving,
  sequence-number valid, fixed, resolved). Entries appear and disappear as the mesh converges.
- **Mesh parameters** (`iw get mesh_param`, cached 60 s in the plugin) with findings, e.g. forwarding off.
- **STP note**: when the bridge's root is reached through the mesh port, the root bridge MAC is matched to a
  peer by its first five octets (the bridge MAC and the radio MAC differ in the last octet).
- The mesh key (`key` / SAE password) is never read into the output; the tests plant a canary to prove it.

### IPsec VPN (route `#ipsec`)
One card per strongSwan connection: header with state and security grade, a router-to-gateway flow diagram,
IKE SA details, tunnel (child SA) details, live traffic with interface counters and a chart, and a 0-100 score
breakdown with warnings. The score explanation sits above the cards (IKE encryption 20, IKE PRF/integrity 10,
IKE key exchange 20, authentication 10, ESP encryption 20, PFS 15, rekeying and liveness 5), followed by the
daemon card. Compact/detailed toggle.

- IKE may float to UDP/4500 while ESP stays native (no UDP encapsulation); these are reported separately.
- `xfrmN` interfaces are matched to child SAs by `if_id` (hex in VICI, decimal in uci `ifid`).
- Pre-shared-key authentication caps the authentication score at 6/10 and raises a warning, because key
  entropy cannot be observed.
- The page is rebuilt from the backend reply on every poll, so connections, rekeys and state changes show up
  without a reload. The backend lists every configured connection (DOWN when it has no SA) and every live IKE
  SA. A connection with several IKE SAs (`unique = no`) gets one card per SA (`instance` = IKE SA id, `key` =
  `name#id`). An SA whose connection is not in the loaded configuration, or a child SA whose child config is
  absent, is still shown and flagged `orphan`; its authentication and lifetime policy cannot be seen, so those
  score parts are neutral (`unknown`) instead of producing false pre-shared-key or lifetime advice. Global
  IPv6 addresses on an `xfrmN` interface are listed next to the IPv4 tunnel address; link-local ones are
  skipped.

### WireGuard (route `#wireguard`)
Refreshed every 5 s, from `flab.wireguard`. Interfaces come from UCI network (`proto wireguard`) plus whatever
`wg show interfaces` reports, peers from the `wireguard_<interface>` sections plus whatever the kernel has
(matched by public key), so a new interface or a peer added at run time with `wg set` shows up on the next
poll (flagged as not in the configuration).
- **Tiles**: interfaces up, peers connected, latest handshake, live traffic (rates derived in the browser from
  the byte counters).
- **Interface card**: state, firewall zone, addresses, listen port, public key (not secret), MTU, firewall
  mark, totals.
- **Peers table**: name (UCI `description`) and a role badge from the allowed IPs (*client*: host routes only,
  *site*: a whole network behind the peer, *all traffic*: a `/0`), shortened public key (full key on hover),
  endpoint (empty for roaming peers), allowed IPs, handshake state, keepalive, live and total traffic.
- **Handshake state**: *connected* when the last handshake is under 180 s old (WireGuard rekeys every 120 s
  and rejects a session after 180 s), *no recent handshake* when older, *never connected* when the kernel has
  no handshake, *not loaded* when the peer is configured but the interface is not running.
- **Findings**: interface down, interface in no firewall zone, a configured peer not loaded, stale or never
  connected peers (informational: roaming phones are often offline), a site peer whose `route_allowed_ips` is
  off.
- Secrets: the plugin never reads `private_key` or `preshared_key` into its output, and only the single-field
  `wg show` forms are used because they never print them. The test recorder scrubs both keys, and the test
  generator aborts if a capture still contains one.

### Firewall (route `#firewall`)
Refreshed every 5 s, from `flab.firewall` (firewall4 / nftables). The configuration comes from UCI firewall
and the live state from `nft -j list ruleset` (about 10 ms, ~30 KB), so a new zone, rule or port forward shows
up on the next poll and every number is a real kernel counter.
- **Tiles**: zones, traffic rules (enabled / total), port forwards, packets turned away from the Internet
  (with a live rate), connection tracking usage, flow offloading (off, software or hardware, and the flowtable
  devices).
- **Who can reach whom** (`model.js` is the pure model, `matrix.js` draws it): rows are the source, columns
  the destination, and the router itself is both. The policies follow firewall4: *zone › router* is the zone's
  `input`, *router › zone* its `output`, *zone › same zone* its `forward`, and *zone › other zone* is open
  only through a `forwarding` section. A cell is green when the policy allows it, amber when it is blocked but
  specific rules or port forwards open parts of it ("N rules"), gray when closed; an open cell notes rules
  that block part of it. Hover a cell for the rule names. Disabled rules, rules naming an unknown zone and
  rules with neither side are ignored, as the firewall does.
- **Zones**: configured interfaces, the kernel devices the loaded rules really match for the zone (read from
  the jumps in the base chains), input/output/forward *policy*, NAT and MSS clamping, where the zone may
  forward to, and the packets its reject/drop chains turned away, in each direction, with a live rate. The
  policies are defaults: `reject`/`drop` refuse everything except what a specific rule or forwarding allows
  (replies to allowed connections are always let back in), which the card's legend and the column tooltips
  spell out. *Forward* is only traffic between interfaces of the same zone; reaching other zones is the "May
  forward to" column.
- **Reachable from the Internet**: the zones that masquerade are treated as facing the Internet; this lists
  the accepting rules and port forwards that start there, i.e. everything a stranger can reach.
- **Traffic rules** and **Port forwards and NAT**: every section in configuration order with its match
  (protocol, ports, ICMP types, addresses, limit, family), action and hit counters. nft counters are matched
  to the UCI section through the comment firewall4 puts on each rule (`!fw4: <name>`; an unnamed rule is
  `@<type>[N]`, N counting sections of that type); a rule that expands to several nft rules has its counters
  summed. A disabled rule is grayed out and has no counters.
- **Findings**: firewall not loaded (no fw4 table), an Internet-facing zone that accepts input or forwards
  within itself, a rule accepting every TCP/UDP port from it, rules naming a zone that does not exist,
  interfaces in no zone (their traffic is rejected), zones with no interface, SYN-flood protection off,
  disabled rules, connection tracking over 80 % full.

### Devices and Interfaces (route `#interfaces`)
Refreshed every 5 s. `layers.js` is the pure model, `table.js` renders it. Data: `flab.network`, netifd's
interface dump and (optional: a missing plugin only drops the wireless layer) `flab.radio`. OpenWrt builds a
network in layers, and the table shows one row per interface with the whole chain: physical ports and radios
with their Wi-Fi and mesh interfaces, then the devices built on them (a bridge groups ports and Wi-Fi; an
802.1q VLAN device sits on a port or a bridge), then the netifd interface that binds to one device and holds
the protocol, addresses, gateway and DNS, then the protocol device some protocols create on top (the PPPoE
session `pppoe-wan`, a WireGuard or XFRM device). An interface can ride on another interface's protocol device
(`wan6` on the PPPoE session of `wan`, shown as shared) or run over another interface (`tunlink`, read from
UCI, e.g. IPsec XFRM interfaces over `wan`). Rows are ordered by the first front-panel port they use, tunnels
last; a device the router does not describe is kept as an unknown device, never dropped.
- **Wireless nodes**: a Wi-Fi or mesh interface is a chip with its SSID or mesh ID and the radio and band it
  runs on, linking to the Wi-Fi or Mesh page. Bridge members and interfaces directly on a Wi-Fi device
  (station mode) are matched to `flab.radio` by interface name. A configured interface that is not running has
  no name yet, so it joins the interface named in its `network` option, shown as down.
- **Unattached wireless**: a wireless interface that reaches no netifd interface, and a radio with no
  interface at all, get a row of their own at the end; the former also raises a finding.
- **Several interfaces on the same ports** (a `lan` and a `lan100` on one bridge): a bridge hands its untagged
  frames to the interface bound to it, while an 802.1q VLAN device on that bridge picks out only the frames
  carrying its tag and gives a second, separate interface on the same wires. Rows that sit on the same set of
  ports and radios list them once; later rows say "same N ports and radios as <first row>", and the Devices
  column says what each row carries ("the bridge's untagged frames", "only frames tagged VLAN 100 on br-lan").
- **Firewall zone and services** (from `flab.network`: UCI firewall and dhcp): the zone of each interface
  (tooltip: input/output/forward policy, NAT, zones it may forward to) and the DHCPv4 pool, DHCPv6 and
  router-advertisement mode of the interfaces that serve them.
- **Addressing** also lists non-default routes netifd installed for the interface (`on link` when the next hop
  is unspecified) and the IPv6 prefixes assigned to it or received on it.
- **Tiles**: interfaces up, bridges, VLAN devices, protocol devices, tunnels, radios up, wireless interfaces.

### BGP (route `#bgp`)
Status of BIRD 3 (`flab.bgp`). Sections, top to bottom:
- **Tiles:** sessions established, prefixes learned (and paths), prefixes announced, multipath (ECMP) share,
  kernel sync, BIRD version/uptime.
- **Topology:** this router, one node per peer, remote AS node (peers are grouped by neighbor AS). The router
  node lists what its peers actually receive ("Announces"), whichever BIRD protocol produced it. CSS grid plus
  SVG connectors (animated while a session is Established). Each peer keeps one color (`pc-0..5`) across every
  table on the page; colors are assigned on first sight and never reshuffled when other peers come and go
  (more than 6 peers reuse the least-used color). The connector math needs equal-height, touching peer cells
  (see the comment in `bgp/topology.js`).
- **Health** (findings from the backend) and **active next hops per peer** (how many prefixes use each peer as
  an installed next hop).
- **One card per peer:** session (state, neighbor/local AS, session type, interface, hold/keepalive/send-hold
  timers as remaining-time bars; a session that is down shows its last error and the next connect attempt),
  capability comparison for both directions (rows where only one side offers a capability are highlighted),
  one routing block per channel (ipv4, ipv6, ...: state, filters, route counts) and the BIRD route-change
  statistics.
- **Learned routes:** every BGP path grouped by prefix. Status is Best, ECMP (installed in the kernel as an
  equal-cost next hop) or Backup. Columns: peer, next hop, interface, AS path chips (prepending collapses to
  `65520 x2`), origin, local pref, MED and communities (the last two only appear when some path has them),
  since. Filter, peer selector, "Best paths only", sortable columns.
- **Announced routes:** prefix x peer matrix plus export-filter results per peer (considered, blocked by
  filter, rejected, announced). **Local & connected routes**, **BIRD protocols**, **daemon** and **memory**
  cards close the page.

Notes:
- **Everything is derived from live data on every poll** (5 s): peers, channels, routes, announcements
  (`show route export <peer>` per peer), findings. IPv4 and IPv6 are both handled (`master4`/`master6` tables,
  `ip -4`/`ip -6` kernel routes, prefixes sort IPv4 first, then IPv6 numerically).
- A path counts as "in kernel" when the kernel route (`ip -4/-6 route show proto bird`) has a next hop via one
  of that path's next-hop addresses (an IPv6 BGP next hop can list a global and a link-local address). With
  `merge paths on` in the kernel protocol this gives ECMP across both gateways of a region; paths with a
  longer AS path are Backup.
- BIRD prints only the **date** in `Since` for anything older than a day, so session uptime cannot be shown
  precisely.
- BIRD's **kernel protocol re-exports the whole table every `scan time`**: after each scan `krt_prune()`
  requests a full refeed, so "Export updates received" of the kernel protocol grows by the table size every
  scan while "accepted" grows by the number of exportable prefixes. This is normal: `krt_rt_notify()` drops
  updates for routes already in the kernel and no netlink message is sent. Do not report these counters as
  churn.
- Findings are computed in the backend: sessions not Established, best routes missing from the kernel,
  prefixes learned from only one peer, import-filter drops, graceful-restart mismatch, peers receiving no
  announcement.

### Services (route `#services`)
`service list` (procd): running vs idle/one-shot services with PIDs.

### Logs (route `#logs`)
Refreshed every 5 s, from `flab.logs`. The last entries of the **system log** (`logread`, logd's ring buffer
in RAM: every daemon's messages and the kernel's) or the **kernel log** (`dmesg`), newest at the bottom.
- **Parsing** happens on the router: a system line `Wed Nov 11 12:06:15 2026 daemon.info odhcpd[2571]: ...`
  becomes time, facility, severity (emerg 0 to debug 7; logd's short names `warn`, `error` and `panic` count as
  warning, err and emerg), program, pid and message; a kernel line
  `<6>[ 272373.68] ...` takes its severity and facility from the syslog priority and its wall-clock time from
  the boot time. A line that does not parse is kept whole, with no time or origin, so nothing is dropped.
- **Controls**: log to read, text filter (origin, priority and message; every word must match), minimum
  severity, one source (program), how many lines to load (200 to 2000), Newest (jump to the bottom), Download
  (the filtered entries as a text file; nothing is uploaded), pause, refresh.
- **Follow**: the pane opens scrolled to the bottom and keeps following new entries while it stays there;
  scrolling up stops following and a refresh keeps the position.
- **Tiles**: entries shown of loaded, errors (severity err or worse), warnings, age of the newest entry.
  Rows are tinted by severity.
- **Redaction**: values after `password`, `psk`, `secret`, `token`, `key` and similar names are replaced with
  `<redacted>` on the router before they are sent.
- Filtering is done in the browser on the loaded tail, so changing a filter is instant; the log and the line
  count are requested from the router.

### DHCP (route `#dhcp`)
Shows and edits odhcpd, the router's DHCPv4, DHCPv6 and router advertisement (RA) server, which is configured in
`/etc/config/dhcp`. It refreshes every 10 s and reads through the ubus `dhcp` object (`ipv4leases`,
`ipv6leases`, `ipv6ra`), `network.interface dump` (which device belongs to which interface and its subnet),
`service list odhcpd` and rpcd's `uci` object; it needs no plugin, only the ACL fragment
`rpcd/acl.d/flab-dhcp.json`. Leases are keyed by device (`br-lan`) in the ubus replies and shown under their
logical interface (`lan`). Top to bottom the page shows the tiles, then the settings (daemon, pools), then the
advertised prefixes, the leases and last the reservations.
- **Tiles**: whether odhcpd runs, DHCPv4 leases (reserved and dynamic), DHCPv6 leases, reservations (how many hold
  a lease now).
- **Daemon** (`config odhcpd`): main DHCPv4 server switch, legacy mode, log level, lease file, trigger script,
  hosts directory, and so on. Like the pools it is folded to its header (main switch and log level) until opened.
- **Pools** (`config dhcp`, one card per interface, folded to its header until opened, groups collapsible): Services (DHCPv4, DHCPv6, RA, NDP),
  DHCPv4 pool and options, DHCPv6, Router advertisements, Neighbor discovery proxy and Other, about 50 options
  from the odhcpd documentation. The header shows the subnet and the address range the pool resolves to
  (start and limit are offsets in the interface's subnet). A folded card or closed group that holds an error
  opens by itself, so an error is never hidden.
- **Leases**: the IPv6 prefixes advertised to clients in router advertisements (a stale one is flagged), DHCPv4 (address, MAC, hostname,
  reserved or dynamic, time left) with a *Reserve* button on every dynamic lease that adds a reservation to the
  form, and DHCPv6 (DUID, addresses, delegated prefixes). The command bar filters all three by text and by
  interface.
- **Reservations** (`config host`): one editable row each with name, IPv4 address, MAC address(es), DUID(s), IPv6
  host ID and lease time, and whether the client holds a lease now. A reservation with only a name and a MAC
  keeps the address dynamic. Rows can be added, removed (shown struck through, with Undo) and edited. New
  sections get their names from uci, so a saved reservation is recognized by its content.
- **Validation**: field checks come from `core/fields.js`; on top of them an address or MAC reserved twice
  (both rows are marked), the router's own address and a pool that starts beyond its subnet are errors. Warnings
  (they do not block Save): an address outside every served subnet, a pool longer than its subnet, DHCPv4 on an
  interface with no IPv4 address, odhcpd no longer the main DHCPv4 server, advertisement intervals out of
  proportion, the RA flag `none` combined with others, and `managed-config` with DHCPv6 disabled. Every
  reservation needs a MAC or a DUID. A value already invalid in the router's file is reported the same way and
  blocks Save until fixed.
- **Not offered**: adding or removing pools (they follow the interfaces), the pool's `interface`, `ifname`,
  `networkid` and `dnr`, and `boot6`.
- Saving uses the same flow and review banner as System settings (see
  [Configuration changes](#configuration-changes)); a pool or daemon change reloads odhcpd, which does not drop
  existing leases. A daemon that is not running is reported, and the configuration stays editable.

### System settings (route `#settings`)
Changes the router: it shows and edits `/etc/config/system`: every option the OpenWrt wiki
documents for the `system` section and for its `timeserver` (NTP) section, in four cards that each take the full
width of the page: General, Time zone and NTP, System log, and Kernel, cron and memory. It is shown at the
bottom of the navigation pane and refreshes every 10 s. It reads through rpcd's `uci` object (`uci get system`),
`system info` (the clock) and `service list sysntpd` (what the NTP client runs with); it needs no plugin, only
the ACL fragment `rpcd/acl.d/flab-settings.json`.
- **Tiles**: the router's clock with its UTC offset, the hostname and description, the time zone and its POSIX
  rule, the NTP client (on or off, and whether `ntpd` runs).
- **The options are data.** `settings/schema.js` lists every field (key, section, card, type, label, hint,
  default, check, bounds); the controls, validation, change list and UCI operations are generated from it by
  `index.js` and `model.js`, so supporting another option is one entry. Options in the file that the table does
  not know are left untouched.
- **General**: `hostname`, `description`, `notes`, `ttylogin`, `urandom_seed`; the fields flow in as many
  columns as fit.
- **Time zone and NTP**: one pane with three columns side by side. *Time zone*: pick an IANA zone. Saving writes
  **both** `zonename` (the name) and `timezone` (its POSIX rule, which is what the system applies, including
  daylight saving time). The router has no zoneinfo files, so `pages/settings/zones.js` carries the table (about
  420 zones, from the IANA database); regenerate it with `python tools/gen-zones.py` (needs `pip install tzdata`;
  `--check` tells whether it is current). "Custom POSIX rule" edits the rule alone and drops `zonename`; a router
  whose zone name is not in the table (a hand-written rule) is shown that way and left alone unless the zone is
  touched. *NTP client* (`timeserver` section): `enabled`, `use_dhcp`, the ordered `server` list,
  `dhcp_interface`, and what `ntpd` is running with. *NTP server for the network*: `enable_server`, `interface`.
  NTP on with no way to find a server is only a warning. A missing `timeserver` section is created, named `ntp`.
- **System log**: `log_size`, `log_buffer_size`, `log_type`, `log_file`, `log_remote`, `log_ip`, `log_port`,
  `log_proto`, `log_hostname`, `log_prefix`, `log_trailer_null`.
- **Kernel, cron and memory**: `buffersize`, `conloglevel`, `cronloglevel`, `zram_comp_algo`, `zram_size_mb`.
- **Controls**: switches show the value, or OpenWrt's default when the option is absent. An empty text control
  shows "default: ..." or an example in gray italics, never a value-looking placeholder. Numbers, hosts, IP
  addresses, paths, interface names, enums and the time zone rule are validated; a bad entry is marked, explained
  and blocks saving. An emptied option is deleted from the file instead of being stored empty.
- **Review banner**: a row at the bottom of the sticky command bar, so Save is always on screen however far the
  form is scrolled. It is hidden while there is nothing to report and appears with the first edit: the number and
  names of the pending changes, Details (the full list of what changes from what to what, and how a save works),
  Discard edits and Save and apply (flow in [Configuration changes](#configuration-changes)), then the
  validation errors and warnings and the outcome of the last save (dismissable; it also disappears with the next
  edit). A renamed router shows its new hostname in the navigation header right away. Changes already staged in
  the session (for example from an attempt that was rolled back) are shown with a "Discard them" button. The page
  does not poll over unsaved edits, a focused control or a save in progress.

## Testing

Five suites, driven by `run.ps1` scripts that never change the router's configuration. The BGP, IPsec and
network suites share one mechanism: the repository's plugins run **on the router** against saved fixtures
(`FLAB_FIXTURES`, with `ucode -L` so the uploaded libraries win over the deployed ones), and an optional browser
pass opens the deployed UI in Edge through `playwright-core` (installed into a temporary folder) with the plugin
calls intercepted and answered with the scenario JSON.

| Suite | Command | Covers |
|---|---|---|
| BGP | `pwsh -File flab-ui\tests\bgp\run.ps1 [-Browser]` | `flab.bgp` parser and findings, BGP page |
| IPsec | `pwsh -File flab-ui\tests\ipsec\run.ps1 [-Browser]` | `flab.ipsec`, IPsec page, throughput history |
| Network | `pwsh -File flab-ui\tests\network\run.ps1 [-Browser]` | `flab.network`, `flab.radio`, `flab.mesh`, `flab.wireguard`, `flab.firewall`, `flab.logs`; Wired network, Bridges, Devices and Interfaces, Wi-Fi, Mesh, WireGuard, Firewall and Logs pages; navigation order; unit tests of the shared helpers (including the session, `uci` and `applyChange` layer) |
| Settings | `pwsh -File flab-ui\tests\settings\run.ps1 [-Browser]` | System settings model, option table and zone table; the whole editing flow against a mock router |
| DHCP | `pwsh -File flab-ui\tests\dhcp\run.ps1 [-Browser]` | DHCP model (address helpers, reading config and leases, validation, change plan); the page against the router's own data, then the whole editing flow against a mock router |

`-Browser` needs the UI deployed (`deploy.ps1 -Action Deploy`) and signs in with a temporary rpcd session that
`tests/TestSession.ps1` creates over ssh, grants what the ACL fragments grant, and destroys afterwards, so no
password is needed. Each suite removes its
`/tmp/flab-*-test` folder on the router and its local temp folder when it finishes.

### Common mechanism

1. **Capture**: each plugin is run once on the router with `FLAB_RECORD` set, so it saves its own inputs
   (`ubus call` results, UCI, sysfs files, command output) under the fixture names. Keys and passwords
   (including WireGuard `private_key` / `preshared_key`) are blanked while recording, and the scenario builder
   plants a canary secret in every place the router keeps one so the assertions prove it is never forwarded;
   it aborts if a capture still holds a real WireGuard key.
2. **Scenarios** (`mkfx.mjs`): the captured state with targeted edits. Binary data is generated or encoded
   (the bridge forwarding table is synthesized; device-tree files are recorded hex-encoded as `hex:...`).
3. **Backend run** on the router for every scenario and plugin, then **assertions** (`assert.mjs`) on the JSON.
4. **Browser pass** (`live.mjs`): drives each page through the scenarios without a reload, checks tiles,
   cards, findings, legends above their data, simulated live rates and the absence of console errors.

### BGP scenarios
`base` (unchanged), `down` (a peer in Active with an error and a connect timer; synthetic), `dual` (IPv6
channels, IPv6 ECMP routes with link-local next hops, one best route missing from the kernel, an IPv6
announcement), `announce` (different announcements per peer, a non-static origin, a peer that receives
nothing). The plugin reads `FLAB_BGP_FIXTURES` instead of running `birdc`/`ip` when it is set (rpcd never sets
it). The browser pass adds peer removed, peer added and eight peers.

### IPsec scenarios
Captures `swanctl --list-conns|--list-sas|--stats|--version --raw`, `ip -s xfrm state` (key material is
redacted before it is copied; a canary key is planted), the xfrm interface addresses and their uci/netifd
data. Scenarios: `base`, `down`, `rekey` (two child SAs), `multi` (two IKE SAs under one name), `orphan` (SA
without connection, child SA without child config), `ipv6`, `daemondown`. `tests/ipsec/rates.test.mjs` unit
tests the throughput history (rates, counter resets, gaps, pauses, per-SA keys, removed connections).

### Network suite
- **Unit tests** (`tests/network/*.test.mjs`, no router): `rates` (the rate tracker), `layers` (bridge and VLAN
  stacking, PPPoE over a VLAN, shared protocol devices, tunnels, unknown devices, parent loops, wireless nodes
  and unattached wireless), `firewall` (zone matrix and findings), `logs` (level and text filters,
  summaries, formatting) and `uci` (the session helper `can()`, `optional()`, the `uci` wrapper and `applyChange`
  against a fake transport).
- **Scenarios**: `n-linkdown`, `n-downshift`, `n-root`, `n-blocked`, `n-nostp`, `n-vlanfilter`, `n-newbridge`,
  `n-highport`, `n-nodevices`, `n-board` (a different router: other model, four LAN ports in reverse order, no
  external PHY), `n-nodsa` (no switch), `n-errors`; radios `r-down`, `r-dfs`, `r-channel`, `r-disabled`,
  `r-newssid`; mesh `m-twopeers`, `m-weak`, `m-fwdoff`, `m-nopeer`, `m-down`, `m-nomesh`; WireGuard `w-stale`,
  `w-down`, `w-newpeer`, `w-noroutes`, `w-nozone`, `w-nowg`; firewall `f-stopped`, `f-redirect`, `f-exposed`,
  `f-disabled`, `f-anonymous`, `f-unzoned`, `f-conntrack`; logs `l-odd` (a secret, an unparsable line, an
  unknown severity, another kernel facility) and `l-empty`. A capture's handshake times age while the test
  runs, so the base scenario pins the connected WireGuard peer to "30 s ago".

### Settings suite
Unlike the other suites it has no backend part: the page reads rpcd's `uci` object, which is not ours to fake on
the router. The unit tests (`model.test.mjs`) cover the option table (every wiki option present, every entry
well-formed), the zone table (every rule passes the rule check), reading `uci get system`, every validator, the
change plan (what is written for each kind of edit: set, delete, create a section, the two zone options, a
custom rule), staging and the read-back check; `network/uci.test.mjs` covers `applyChange`. The browser pass
(`live.mjs`) first reads the router's own `/etc/config/system` through the real page, with any uci write blocked
and failing the test, then switches to a stateful mock of `uci`, the clock and the NTP client and drives:
validation of each kind of field, the review list, a page that does not poll over edits, Discard edits, a
successful save (call order, what was written, the new hostname in the navigation header), removing an option and
a list, a change the router does not keep (rolled back), a confirmation that comes too late, leftovers from an
earlier attempt, a login without write access, the dark theme and an expired session. The mock keeps the real
router's configuration out of reach, so the suite never writes to it.

### DHCP suite
Same shape as the Settings suite, with no backend part. `model.test.mjs` covers the option tables, the address
and range helpers, reading `uci get dhcp` with the lease replies (leases mapped from device to interface),
validation, the change plan (reservations added, removed and edited, pool and daemon options) and the read-back
check; `network/uci.test.mjs` covers `applyChange`. The browser pass (`live.mjs`) first shows the router's own
leases, reservations and pools with every uci write blocked, then switches to a stateful mock of `uci`, the
`dhcp` object, the interface dump and `service list` and drives filtering, reservation edits (duplicates, the
router's own address, bad MACs, Reserve from a lease, Add, Remove and Undo), pool and daemon edits, a successful
save, a change the router does not keep, a late confirmation, a stopped odhcpd, a login without write access,
the dark theme and an expired session.

## Implementation notes

- **rpcd reads its plugins and ACL fragments only at start**: copy them and `restart` rpcd (`reload` is not enough).
- **A session without a password**: `ubus call session create` plus `session grant` (scopes `ubus` and `uci`)
  over ssh gives a session that works through `/ubus` like a real sign-in; the browser tests grant it what the
  ACL fragments list.
- **Root's `*`**: `read` and `write` `*` in an rpcd login is a list (`list read '*'`) naming every ACL group in
  `/usr/share/rpcd/acl.d`. It is not a wildcard over objects, so a call that no fragment grants is denied even
  for root (JSON-RPC `-32002`). A login that sets `*` as a plain option gets no groups at all.
- **rpcd `uci` object**: staged edits are kept per session, `set` rejects `null` values (use `delete` with
  `options`), `apply` takes no config list (it applies everything staged), and after any rollback (explicit or
  by the countdown) the rolled-back edits reappear in the staging area. `uci get <config>` returns every section
  keyed by name with `.type`, `.name` and `.anonymous`, and a list option as an array. A method the session may
  not call is refused with JSON-RPC `-32002`; a config it may not use is refused by rpcd with ubus status 6.
- **Time zone**: `/etc/config/system` holds `zonename` (IANA name) and `timezone` (POSIX rule); the system only
  uses the rule. `uci apply` on `system` triggers procd to reload `system` (rewrites `/etc/TZ`) and `sysntpd`.
- **UCI file order**: deleting and re-adding an option moves it within the section, and an explicit default
  (`enabled '1'`) stays in the file, so a change and its undo are equivalent but not byte-identical.
- **BusyBox** has no `od`; `scp` needs `-O`; shell snippets sent over ssh must be LF-only.
- **Splatting a single path** in PowerShell iterates its characters; wrap it in `@(...)`.
- **hostapd rate units**: `ubus hostapd.<if> get_clients` reports rates in units of 10 bit/s, so divide by
  100000 to get Mbit/s.
- **VICI parsing**: scalar values can contain spaces; see `flab.vici`.
- **`ip monitor`**: `timeout ip ...` runs BusyBox's reduced `ip` applet, which has no `monitor`. Call
  `/sbin/ip` (iproute2) by full path.
- **BIRD has no JSON output**: `flab.bgp` parses `birdc` text (indentation-based sections for protocols,
  header plus tab-indented attribute lines for routes). The parser skips unknown lines, so a newer BIRD only
  loses fields. Protocol names from `birdc` are validated before being used in a shell command.
- **ucode numbers and time**: `+"08"` is 8 (decimal), `timelocal({...})` works for BIRD and logread
  timestamps (month 1-12), `match(s, /re/g)` returns an array of `[full, group]` pairs, `split(s, sep, limit)`
  is supported, `replace(s, /re/gi, '$1<redacted>')` supports backreferences.
- **nft counters**: firewall4 puts a `counter` and a `!fw4: <name>` comment on each rule; chains named
  `reject_from_<zone>` / `drop_from_<zone>` (and `_to_`) hold the packets turned away per zone.
- **Log volume**: logd's buffer holds thousands of lines (every SSH login is several); the plugin asks
  `logread -l N` for the tail instead of reading everything.
- **No favicon request**: `index.html` uses an empty data-URI icon.

## Conventions

- Every function, lookup table and non-obvious block has a comment saying what it does and, where it is not
  obvious, why. Comments describe current behavior, never history; neither does this README.
- PowerShell follows `Set-StrictMode -Version Latest`, `$ErrorActionPreference = 'Stop'`, comment-based help
  on functions and scripts, and `#region` blocks.
- ucode uses tabs, JavaScript and CSS use two spaces.
- Everything shown is discovered from the router at run time; nothing is hard-coded to one board.
- Legends sit at the top of the card or section they explain.
- Code in `rpcd/` and `www/` is deployed as is; there is no build step to keep in sync.
- When the router configuration is changed outside this folder, the corresponding files under
  `build/MT6000/` in this repository must be updated as well and pushed.
