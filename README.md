# flab-ui

A lightweight, LuCI-free administration UI for OpenWrt, developed and tested on the GL.iNet GL-MT6000
(1 GB RAM). It is a static single-page app served by `uhttpd`, talking to the router through the
standard `ubus` JSON-RPC endpoint and a few small `rpcd` ucode plugins.

> **Hard rule: no LuCI components.** flab-ui is a replacement for LuCI, so it must never call
> `luci-rpc`, `luci.*` ubus objects or any LuCI library. Read data directly from `swanctl`, `netifd`,
> `procd`, sysfs, the kernel (`ip`, `iw`, `hostapd_cli`) and `uci`.

Status: experimental. It is deployed to tmpfs for testing and removed again with one command; nothing
is installed permanently.

## Contents

1. [Architecture at a glance](#architecture-at-a-glance)
2. [Repository layout](#repository-layout)
3. [Frontend](#frontend)
4. [Backend (rpcd plugins)](#backend-rpcd-plugins)
5. [Security model](#security-model)
6. [Deploy, test, clean up](#deploy-test-clean-up)
7. [How to add a page](#how-to-add-a-page)
8. [Existing pages](#existing-pages)
9. [Testing](#testing)
10. [Gotchas learned the hard way](#gotchas-learned-the-hard-way)

## Architecture at a glance

```
Browser (ES modules, Bootstrap 5.3 + Fluent theme, no build step)
   |  HTTPS POST /ubus   {"jsonrpc":"2.0","method":"call","params":[sid, object, method, args]}
   v
uhttpd  (ubus_prefix '/ubus', static files from /www/flab -> /tmp/flab)
   |  ubus
   v
rpcd ---- built-in objects:  session, system, network.interface, service
   |
   '----- ucode plugins:    flab.wifi, flab.radio, flab.mesh, flab.wireguard, flab.firewall, flab.network, flab.ipsec, flab.bgp, flab.sensors, flab.system   (this repo)
                |  import
                v
        shared ucode modules: flab.util, flab.vici
                |
                v
   swanctl --raw (VICI) · birdc · ip xfrm/route · hostapd_cli · iw · netifd · uci · sysfs
```

Design principles:

- **No build step, no framework.** Plain ES modules and CSS. The whole app (excluding Bootstrap) is
  about 120 KB of source and runs from the router's RAM.
- **Thin server, rich client.** Plugins return sanitized JSON; the browser does all presentation.
- **Least privilege.** A dedicated read-only rpcd login whose ACL lists exactly the ubus calls the
  pages use.
- **Modular by page.** One folder or file per page on each side, registered in one list.
- **No secrets leave the router.** Plugins whitelist fields; key material is never forwarded.

## Repository layout

```
flab-ui/
  deploy.ps1                 Deploy / Cleanup script (PowerShell 7)
  tests/bgp/, tests/ipsec/, tests/network/   Test suites for the BGP and IPsec pages, and for the Wired network, Bridges, Devices and Interfaces, Wi-Fi radio, Mesh, WireGuard and Firewall pages (run.ps1, see "Testing")
  www/                       Static site, deployed to /tmp/flab and linked at /www/flab
    index.html               Shell page: loads vendor CSS, css/base.css and js/main.js
    vendor/bootstrap.min.css Bootstrap 5.3.3, vendored so the UI works offline
    css/
      base.css               Fluent tokens, app shell, shared component styles
      <page>.css             Page-specific styles, loaded on first visit (overview, wifi, ipsec, bgp, network, bridges, interfaces, mesh, wireguard, firewall)
    js/
      main.js                Entry point: theme + start the app
      core/                  Framework-level modules shared by all pages
        app.js               Shell: nav pane, command bar, hash routing, refresh loop
        ubus.js              ubus JSON-RPC transport, session, AuthError
        login.js             Sign-in screen: gradient hero with logo, network motif, icon fields, show-password toggle (inline SVG/CSS only)
        dom.js               h() element builder (XSS-safe), byId()
        ui.js                Components: card, tile(s), table, badge, chip, kv, lifebar, meter, sparkline, healthBanner
        controls.js          Command-bar controls: search, select, pause, toggle, refresh
        format.js            Bytes, rates, durations, numbers
        rates.js             Rate tracker: turns cumulative counters into rates/ratios between polls
        icons.js             Inlined Bootstrap Icons path data, icon(name)
        theme.js             Follows the OS light/dark preference
      pages/
        index.js             Page registry and the page contract (read this first)
        overview/            index.js + cpu.js + temperatures.js
        wifi/                index.js (page + clients table), radios.js (radio cards); mesh interfaces are left to mesh/
        mesh/                index.js, node.js (802.11s mesh: peers, paths, parameters)
        wireguard/           index.js, iface.js (interface cards, peers table, findings)
        firewall/            index.js, model.js (pure zone matrix), matrix.js, zones.js, rules.js, util.js (rates, findings)
        ipsec/               index.js, connection.js, daemon.js, names.js, rates.js
        bgp/                 index.js, topology.js, peer.js, routes.js, announced.js, system.js, util.js
        network/             Wired network: index.js, shared.js (loader + address helpers), topology.js, tile.js, chips.js, ports.js, diagnostics.js, util.js
        bridges/             index.js, card.js
        interfaces/          Devices and Interfaces: index.js, layers.js (pure model), table.js
        services.js          procd services
  rpcd/
    ucode/flab.<page>.uc     rpcd plugins  -> /usr/share/rpcd/ucode/
    acl.d/flab-<page>.json   ACL fragments -> /usr/share/rpcd/acl.d/
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
| `interval` | yes | Auto-refresh period in ms |
| `load()` | yes | Async; returns the page data, usually one ubus call |
| `view(data, rerender)` | yes | Returns an array of DOM nodes |
| `controls({ rerender, reload })` | no | Returns `{ nodes, update?(data) }`; controls persist across refreshes |
| `isPaused()` | no | Return true to suspend auto-refresh |
| `css` | no | Stylesheet (or array of stylesheets) loaded on first visit |

**State that must survive refreshes** (filter text, sort order, selected radio, paused flag, compact
toggle) lives in a module-level `state` object in the page, never in the DOM. The controls are created
once per route; only `<main>` is redrawn on refresh, so typing in a filter box is never interrupted.

### Core building blocks

- **`h(tag, props, ...children)`** builds elements from properties and text nodes only. Router data is
  therefore never parsed as HTML. Never use `innerHTML` with data (the only `innerHTML` is the static
  icon path data in `icons.js`).
- **`ui.js`** components: `card`, `tile`/`tiles` (KPI row), `table`, `badge` (soft pill: `success`,
  `warning`, `danger`, `info`), `chip` (algorithm chip by strength: `good`/`fair`/`weak`/`info`), `kv`
  (label/value list), `section`, `lifebar`, `meter`, `sparkline`, `emptyState`, `button`.
- **`controls.js`**: `searchControl`, `selectControl`, `pauseControl`, `toggleControl`, `refreshControl`
  bind to a page's `state` object.
- **`ubus.js`**: `ubus(object, method, args)`. A JSON-RPC error `-32002` is ambiguous (expired session
  or ACL denial), so it asks `session.access` to tell them apart: an expired session raises
  `AuthError`; an ACL denial raises a normal error naming the object and method.
- The session id lives in `sessionStorage` (cleared when the tab closes). Login timeout is 900 s.

### Styling

- Bootstrap 5.3 supplies grid, forms, tables and utilities; `css/base.css` layers a Fluent 2 look on
  top through `--fl-*` CSS variables (surfaces, strokes, brand, soft status colors) for light and dark.
- Light/dark follows the OS (`prefers-color-scheme`) via Bootstrap's `data-bs-theme`.
- The layout fills the whole viewport: a 240 px navigation pane, a sticky acrylic command bar, then a
  fluid content area. Tables use `table-layout: fixed` with percentage column widths so tables for
  different SSIDs align (`.fixed-grid`, widths must sum to 100).
- Prefer the `--fl-*` variables over hard-coded colors so both themes keep working.

### Page-specific frontend notes

- **IPsec** (`pages/ipsec/`): `connection.js` renders one card per connection from the backend JSON;
  `names.js` maps strongSwan identifiers to friendly names (`AES_GCM_16`+256 to `AES-256-GCM`);
  `rates.js` derives throughput from successive counter samples kept in memory (60 samples; uses the
  `xfrmN` interface counters because they survive child SA rekeys). A series is keyed by the backend's
  `conn.key`, restarts after 15 s without a sample (tunnel down, polling paused, background tab) so a gap
  is never averaged into one bogus rate, and is dropped when its connection disappears; `daemon.js` shows
  daemon state and the score model.
- **Overview** (`pages/overview/`): the sensors and CPU calls are optional (`optional()` wrapper), so a
  missing plugin or ACL hides that section instead of breaking the page. `cpu.js` keeps the sample
  history and builds the CPU card; `temperatures.js` builds the temperature cards.
- **BGP** (`pages/bgp/`): `index.js` owns the page state and composes the sections; `topology.js`,
  `peer.js`, `routes.js`, `announced.js` and `system.js` each export card builders that take the backend
  data; `util.js` holds the per-peer color helpers, AS-path chips and prefix sort key. Shared styles for
  the pulsing status `.dot` live in `base.css` because page CSS is loaded lazily.

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
| `flab.firewall.uc` | `flab.firewall` | `status` | uci firewall (defaults, zones, forwardings, `rule`, `redirect`, `nat`, `include`, `ipset`), uci network (interface names); `nft -j list ruleset` (per-rule hit counters matched through the `!fw4: <name>` comment, reject/drop chain counters per zone, the devices behind each zone, flowtable devices, base chain policies); procfs conntrack count and limit |
| `flab.wireguard.uc` | `flab.wireguard` | `status` | uci network (`proto wireguard` interfaces and `wireguard_<if>` peer sections), uci firewall (zone); `wg show <if> public-key/listen-port/peers/endpoints/allowed-ips/latest-handshakes/transfer/persistent-keepalive` (the single-field forms never print the private or pre-shared key); sysfs MTU and counters |
| `flab.network.uc` | `flab.network` | `status` | ubus `network.device status` (netifd); sysfs `/sys/class/net/<if>/{carrier,bridge,brport}`; the bridge forwarding table `brforward`; `ethtool -i/-S`, `/sys/class/mdio_bus`, `/proc/device-tree` (hardware and switch wiring), `/etc/board.json` (LAN/WAN roles and port order); uci network (`tunlink`), uci firewall (zones, forwardings), uci dhcp (DHCP/RA service per interface); `logread` (error log lines) |
| `flab.ipsec.uc` | `flab.ipsec` | `status` | `swanctl --raw` (via `flab.vici`), `ip -s xfrm state`, `network.device`, uci network |
| `flab.bgp.uc` | `flab.bgp` | `status` | `birdc` (`show status`, `show protocols all`, `show route all`, `show route export <peer>`, `show memory`), `ip -4 route show proto bird` |
| `flab.sensors.uc` | `flab.sensors` | `status` | sysfs `/sys/class/thermal`, `/sys/class/hwmon` |
| `flab.system.uc` | `flab.system` | `cpu` | procfs `/proc/stat`, `/proc/loadavg`, `/proc/uptime` |

Shared modules (`rpcd/lib/flab/`, imported as `flab.util` and `flab.vici`):

- **`flab.util`**: `run(cmd)`, `ubus_call(conn, object, method, args)`, `uci_all(config)`, `sysfs(path)`,
  `fixture(name)`, `safe_ifname()`, `normalize_mac()`, `num()`. They are also the test seam: with
  `FLAB_FIXTURES=<dir>` set (rpcd never does) `run()` returns `<dir>/<command>.txt` instead of executing the
  command (file name = the command with every run of non-alphanumerics turned into `_` and a trailing
  `2>/dev/null` dropped), `ubus_call()` reads `<object>_<method>.json`, `uci_all()` reads
  `uci_<config>.json` and `sysfs()` looks the path up in `files.json`. A plugin written with these helpers
  is testable without any plugin-specific hook. With `FLAB_RECORD=<dir>` set the same helpers save what
  they read under those names (keys and passwords blanked), so a fixture set is captured by running the
  plugin once; `tests/network/run.ps1` does exactly that.
- **`flab.vici`**: parses `swanctl --list-sas|--list-conns|--stats --raw` output into nested objects.
  The raw format is `name {key=value list=[a b] section {...}}`; values may contain spaces
  (`class=pre-shared key`), so a value ends where the next `key=` or `key {` begins. `events()` returns
  every event (several IKE SAs can share a connection name); `query()` merges them by name and is only
  safe where names are unique (`list-conns`); `reply()` is for request/reply commands such as `stats`.

### Backend rules

- **Whitelist fields.** Build the response explicitly; never pass a raw dump through. `flab.ipsec`
  parses `ip xfrm state` but only copies algorithm names, sizes, counters and encapsulation; the key hex
  is dropped. `flab.wifi` never copies Wi-Fi keys from `network.wireless status`.
- **Never call a ubus object served by rpcd itself** from a plugin (any `flab.*`, `luci.*`, `session`,
  `file`, ...). rpcd runs plugins in-process, so the call blocks its own event loop. Calling `netifd`,
  `hostapd.*`, `dhcp`, `network.*` objects is fine.
- **Shell safety.** Anything interpolated into a command line must be validated (`safe_ifname`).
- **Speed.** Collect once per call and cache in local variables. Measured over HTTP: wifi about 0.3 s,
  ipsec about 0.35 s; sensors only read a few sysfs files. The UI polls every 5-10 s.
- **ucode specifics.** Arrays have no methods (`push(arr, x)`, `slice(arr, 1)`, not `arr.push`).
  Regular expressions are POSIX ERE (no `(?:` non-capturing groups); the code uses `[[:space:]]`
  instead of `\s`/`\t` in classes. Use `100000.0` to force float division. Optional chaining (`a?.b`)
  and `??` work.

## Security model

- **Dedicated login.** `deploy.ps1` adds an rpcd login section `rpcd.flab_ui` (user `flab`) with only a
  `read` group `flab`; there is no `write` group. The password is stored as a SHA-512 crypt hash.
- **ACL fragments.** Each page ships `rpcd/acl.d/flab-<page>.json` granting its ubus calls under the
  `flab` group; rpcd merges them. `flab-base.json` holds the shared calls (`system board/info`,
  `network.interface dump`, `service list`, `session access/destroy`).
- **Verified boundaries.** The `flab` user is denied `uci get`, `file exec`, `network.wireless status` and
  every `luci.*` object; an unauthenticated session cannot call the `flab.*` objects.
- **Known weakness.** `ubus list *` still shows object names to a logged-in user (names only; calls stay
  blocked).
- **Transport.** uhttpd redirects HTTP to HTTPS and serves with the router certificate.
- **Default test password** is `flab` for convenience; pass `-Password` to `deploy.ps1` for anything
  other than a short test.

## Deploy, test, clean up

Requires PowerShell 7, `ssh`/`scp` with key auth to the router (default `root@openwrt.lab.formicalab.casa`).

```powershell
# Install (random password unless -Password is given). Open https://<router>/flab/
pwsh -File flab-ui\deploy.ps1 -Action Deploy -Password flab

# Remove every trace from the router
pwsh -File flab-ui\deploy.ps1 -Action Cleanup
```

What Deploy does:

1. Runs the cleanup script first (idempotent).
2. Copies `www/` to `/tmp/flab` (tmpfs, gone after a reboot) and symlinks `/www/flab` to it.
3. Copies `rpcd/ucode/*` to `/usr/share/rpcd/ucode/`, `rpcd/acl.d/*` to `/usr/share/rpcd/acl.d/` and
   `rpcd/lib/flab/*` to `/usr/share/ucode/flab/`.
4. Creates the `flab` rpcd login (password hash computed on the router; the password is passed over
   stdin, never on a command line) and **restarts rpcd**.

Cleanup removes all of the above and restarts rpcd again.

Things to know:

- `rpcd` must be **restarted** (not reloaded) to pick up new logins, so every deploy/cleanup logs out
  active LuCI sessions.
- Flash writes are limited to the rpcd files, the rpcd login and the symlink; Cleanup removes them.
- `scp -O` is required (dropbear has no sftp-server).
- After editing a file, a quick iteration is `scp -O <file> root@<router>:/tmp/flab/<path>` and Ctrl+F5.
  Backend changes need the file copied to `/usr/share/rpcd/ucode/` (or `/usr/share/ucode/flab/`) and
  `/etc/init.d/rpcd restart`.
- To test a plugin without rpcd: copy it to `/tmp`, then
  `ucode -e 'print(sprintf("%.1J", loadfile("/tmp/x.uc")()["flab.x"].status.call()))'`
  (use a script file rather than inline quoting over ssh), or call it as the `flab` user over HTTP.
- Ad-hoc browser checks used Playwright (`playwright-core` with the installed Edge) from a temp folder
  with screenshots at 1920x1080 in both themes, then deleted. The BGP page has a repeatable suite, see
  [Testing](#testing).

## How to add a page

Example: a `dhcp` page.

1. **Backend (only if new data is needed).**
   - `rpcd/ucode/flab.dhcp.uc` returning `{ 'flab.dhcp': { status: { call() {...} } } }`. Reuse
     `import { run } from 'flab.util'` and, for strongSwan-style output, `flab.vici`.
   - `rpcd/acl.d/flab-dhcp.json`:
     ```json
     { "flab": { "description": "flab-ui DHCP page",
                 "read": { "ubus": { "flab.dhcp": ["status"] } }, "write": {} } }
     ```
   - Prefer data sources that are not LuCI (see the hard rule above).
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
5. **Deploy and test** with `deploy.ps1`; every file in `rpcd/` and `www/` is picked up automatically.

Reuse before writing new code: if two pages need the same widget, move it to `core/ui.js`; if the same
parsing is needed by two plugins, move it to `rpcd/lib/flab/`.

## Existing pages

### Overview (default)
KPI tiles (uptime, CPU usage, load, memory, CPU temperature, hottest sensor), a CPU load card, a
Temperatures card, system info (including the kernel version) and the memory breakdown.

**CPU load** comes from `flab.system cpu`, which returns the kernel's cumulative counters from
`/proc/stat` (plus load average and task counts). Utilization is a rate, so the browser derives it from
the difference between two successive samples (`overview/cpu.js`, same idea as the IPsec throughput):
total busy percentage, a stacked bar per state (user, system, interrupts = irq + softirq, I/O wait,
steal), one bar per core and a 60-sample history chart. "Busy" excludes idle and I/O wait, like top and
htop. On a router the interrupts share is worth watching: packet forwarding and Wi-Fi show up as
softirq. The first visit takes a second sample a moment after the first, so numbers appear immediately;
the history restarts if the router uptime shows a gap longer than 20 s (page paused or not open), since a
delta over minutes would be a misleading average. This router has no cpufreq policy (fixed clock), so no
frequency is shown.

Temperatures come from `flab.sensors`: thermal zones plus hwmon sensors
(deduplicated, since the CPU appears as both). On the MT6000: CPU, two RTL8221B 2.5G Ethernet PHYs and
two MT7915 Wi-Fi radios. Health: Normal below 75 C, Warm from 75 C, Hot from 90 C or at a sensor's own
throttle/critical limit. Also shows CPU trip points, throttling state and cooling devices (passive
only; no fan is reported).

### Wi-Fi
Two sections, both refreshed every 5 s.

**Radios** (`flab.radio`, `pages/wifi/radios.js`): one card per radio from UCI `wifi-device`, discovered
at run time. Header with band, phy, state, standards and hardware; key figures (running channel,
frequency, width, centre, TX power, noise floor, antennas, clients); the configuration next to what is
actually running (channel, mode, TX power with the regulatory limit of that channel, country vs active
regulatory domain, cell density, beacon interval, options); channel utilisation (busy, RX and TX airtime
as a percentage and chart, derived in the browser from the driver's cumulative survey counters); the
channels allowed by the regulatory domain with the running channel and its width span highlighted and
DFS (radar) channels marked; and a table of the SSIDs (BSSID, networks, security,
clients, live and total traffic, 802.11r/k/v, WPS, OCV, hidden, isolation, MAC filter policy with entry
count, BSS status). Findings appear when something is off: radio down, setup failing, running channel
different from the configured one, high noise, busy channel, DFS availability check in progress, open
network, country mismatch. Only whitelisted options are copied: keys, passwords, FT key material and MAC
lists never leave the router. Mesh (802.11s) interfaces are not listed here: a radio carrying one shows a
`mesh · <id>` badge linking to the Mesh page, and mesh peers are not in the clients list.

**Clients**: port of `utilities/list_connected_devices.uc`: clients per radio and SSID with MAC,
IPv4/IPv6, hostname, signal, Wi-Fi standard, bandwidth, TX/RX bitrate, security label, AKM/SAE
group/cipher/PMF details and the 0-100 security score (same AKM, cipher, SAE group and PMF scoring as the
CLI tool). Filter, radio selector, sortable columns, pause, legend. Output was cross-checked against the
CLI tool.

### IPsec VPN
One card per strongSwan connection: header with state and security grade, a router-to-gateway flow
diagram, IKE SA details, tunnel (child SA) details, live traffic with interface counters and a chart,
and a 0-100 score breakdown with warnings. Daemon card and a collapsible explanation of the score
(IKE encryption 20, IKE PRF/integrity 10, IKE key exchange 20, authentication 10, ESP encryption 20,
PFS 15, rekeying and liveness 5). Compact/detailed toggle.

Facts worth remembering:
- IKE may float to UDP/4500 while ESP stays native (no UDP encapsulation); these are reported
  separately.
- `xfrmN` interfaces are matched to child SAs by `if_id` (hex in VICI, decimal in uci `ifid`).
- On the lab router `xfrm0..3` carry the BGP point-to-point addresses set by
  `build/MT6000/etc/hotplug.d/iface/90-xfrm`; `xfrm0` has a few TX errors the page flags.
- Pre-shared-key authentication caps the authentication score at 6/10 and raises a warning, because
  key entropy cannot be observed.
- The page is rebuilt from the backend reply on every poll, so connections, rekeys and state changes
  show up without a reload. The backend lists every configured connection (DOWN when it has no SA) and
  every live IKE SA. A connection with several IKE SAs (`unique = no`) gets one card per SA
  (`instance` = IKE SA id, `key` = `name#id`). An SA whose connection is no longer loaded, or a child SA
  whose child config was removed, is still shown and flagged `orphan`; its authentication and lifetime
  policy cannot be seen, so those score parts are neutral (`unknown`) instead of producing false
  pre-shared-key or lifetime advice. Global IPv6 addresses on an `xfrmN` interface are listed next to the
  IPv4 tunnel address; link-local ones are skipped.

### WireGuard (route `#wireguard`)
Refreshed every 5 s, from `flab.wireguard`. Interfaces come from UCI network (`proto wireguard`) plus whatever
`wg show interfaces` reports, peers from the `wireguard_<interface>` sections plus whatever the kernel has
(matched by public key), so a new interface or a peer added at run time with `wg set` shows up on the next
poll (flagged as not in the configuration).
- **Tiles**: interfaces up, peers connected, latest handshake, live traffic (rates derived in the browser
  from the byte counters).
- **Interface card**: state, firewall zone, addresses, listen port, public key (not secret), MTU, firewall
  mark, totals.
- **Peers table**: name (UCI `description`) and a role badge from the allowed IPs (*client*: host routes only,
  *site*: a whole network behind the peer, *all traffic*: a `/0`), shortened public key (full key on hover),
  endpoint (empty for roaming peers), allowed IPs, handshake state, keepalive, live and total traffic.
- **Handshake state**: *connected* when the last handshake is under 180 s old (WireGuard rekeys every 120 s
  and rejects a session after 180 s), *no recent handshake* when older, *never connected* when the kernel has
  no handshake, *not loaded* when the peer is configured but the interface is not running.
- **Findings**: interface down, interface in no firewall zone, a configured peer not loaded, stale or never
  connected peers (informational: roaming phones are often offline), a site peer whose `route_allowed_ips` is off.
- Secrets: the plugin never reads `private_key` or `preshared_key` into its output, and only the single-field
  `wg show` forms are used because they never print them. The test recorder scrubs both keys, and the test
  generator aborts if a capture still contains one.

### Firewall (route `#firewall`)
Refreshed every 5 s, from `flab.firewall` (firewall4 / nftables). The configuration comes from UCI firewall and the
live state from `nft -j list ruleset` (about 10 ms, ~30 KB), so a new zone, rule or port forward shows up on the
next poll and every number is a real kernel counter.
- **Tiles**: zones, traffic rules (enabled / total), port forwards, packets turned away from the Internet (with a
  live rate), connection tracking usage, flow offloading (off, software or hardware, and the flowtable devices).
- **Who can reach whom** (`model.js` is the pure model, unit-tested; `matrix.js` draws it): rows are the source,
  columns the destination, and the router itself is both. The policies follow firewall4: *zone › router* is the
  zone's `input`, *router › zone* its `output`, *zone › same zone* its `forward`, and *zone › other zone* is open
  only through a `forwarding` section. A cell is green when the policy allows it, amber when it is blocked but
  specific rules or port forwards open parts of it ("N rules"), grey when closed; an open cell notes rules that
  block part of it. Hover a cell for the rule names. Disabled rules, rules naming an unknown zone and rules with
  neither side are ignored, as the firewall does.
- **Zones**: configured interfaces, the kernel devices the loaded rules really match for the zone (read from the
  jumps in the base chains), input/output/forward *policy*, NAT and MSS clamping, where the zone may forward to, and
  the packets its reject/drop chains turned away, in each direction, with a live rate. The policies are defaults:
  `reject`/`drop` refuse everything except what a specific rule or forwarding allows (replies to allowed
  connections are always let back in), which the card's legend and the column tooltips spell out. *Forward* is
  only traffic between interfaces of the same zone; reaching other zones is the "May forward to" column.
- **Reachable from the Internet**: the zones that masquerade are treated as facing the Internet; this lists the
  accepting rules and port forwards that start there, i.e. everything a stranger can reach.
- **Traffic rules** and **Port forwards and NAT**: every section in configuration order with its match
  (protocol, ports, ICMP types, addresses, limit, family), action and hit counters. nft counters are matched to
  the UCI section through the comment firewall4 puts on each rule (`!fw4: <name>`; an unnamed rule is
  `@<type>[N]`, N counting sections of that type); a rule that expands to several nft rules has its counters
  summed. A disabled rule is greyed out and has no counters.
- **Findings**: firewall not loaded (no fw4 table), an Internet-facing zone that accepts input or forwards within
  itself, a rule accepting every TCP/UDP port from it, rules naming a zone that does not exist, interfaces in no zone
  (their traffic is rejected), zones with no interface, SYN-flood protection off, disabled rules, connection tracking
  over 80 % full.

### BGP
Status of BIRD 3 (`flab.bgp`); the lab setup is four eBGP sessions to Azure (AS 65515) over the `xfrm0..3`
tunnels (`build/MT6000/etc/bird.conf`). Sections, top to bottom:
- **Tiles:** sessions established, prefixes learned (and paths), prefixes announced, multipath (ECMP) share,
  kernel sync, BIRD version/uptime.
- **Topology:** this router, one node per peer, remote AS node (peers are grouped by neighbor AS). The
  router node lists what its peers actually receive ("Announces"), whichever BIRD protocol produced it.
  CSS grid plus SVG connectors (animated while a session is Established). Each peer keeps one color
  (`pc-0..5`) across every table on the page; colors are assigned on first sight and never reshuffled when
  other peers come and go (more than 6 peers reuse the least-used color). The connector math needs
  equal-height, touching peer cells (see the comment in `bgp/topology.js`).
- **Health** (findings from the backend) and **active next hops per peer** (how many prefixes use each
  peer as an installed next hop).
- **One card per peer:** session (state, neighbor/local AS, session type, interface, hold/keepalive/
  send-hold timers as remaining-time bars; a session that is down shows its last error and the next
  connect attempt), capability comparison for both directions (rows where only one side offers a
  capability are highlighted), one routing block per channel (ipv4, ipv6, ...: state, filters, route
  counts) and the BIRD route-change statistics.
- **Learned routes:** every BGP path grouped by prefix. Status is Best, ECMP (installed in the kernel
  as an equal-cost next hop) or Backup. Columns: peer, next hop, interface, AS path chips (prepending
  collapses to `65520 x2`), origin, local pref, MED and communities (the last two only appear when some
  path has them), since. Filter, peer selector, "Best paths only", sortable columns.
- **Announced routes:** prefix x peer matrix plus export-filter results per peer (considered, blocked by
  filter, rejected, announced). **Local & connected routes**, **BIRD protocols**, **daemon** and
  **memory** cards close the page.

Facts worth remembering:
- **Everything is derived from live data on every poll** (5 s): peers, channels, routes, announcements
  (`show route export <peer>` per peer), findings. Nothing about the Azure setup is hard-coded. IPv4 and
  IPv6 are both handled (`master4`/`master6` tables, `ip -4`/`ip -6` kernel routes, prefixes sort IPv4
  first, then IPv6 numerically).
- A path counts as "in kernel" when the kernel route (`ip -4/-6 route show proto bird`) has a next hop via
  one of that path's next-hop addresses (an IPv6 BGP next hop can list a global and a link-local address).
  With `merge paths on` in the kernel protocol this gives ECMP across both
  gateways of a region; paths with a longer AS path (`65515 65520 65520`, learned through the other
  region) are Backup.
- BIRD prints only the **date** in `Since` for anything older than a day, so session uptime cannot be
  shown precisely.
- BIRD's **kernel protocol re-exports the whole table every `scan time`** (20 s in `bird.conf`): in v3.3.3
  `krt_prune()` calls `channel_request_full_refeed()` after each scan. So `show protocols all kernel1`
  shows "Export updates received" growing by the table size (45 here) every 20 s, about 2.25/s and
  hundreds of thousands per few days, while "accepted" grows by the number of exportable prefixes (16).
  This is normal: `krt_rt_notify()` drops updates for routes already in the kernel, no netlink message
  is sent (verified with `ip monitor route`), and BIRD used about 10 ms of CPU per 25 s. Do not report
  these counters as churn. (The page once did; that finding was removed.)
- Findings are computed in the backend: sessions not Established, best routes missing from the kernel,
  prefixes learned from only one peer, import-filter drops, graceful-restart mismatch, peers receiving no
  announcement.

### Wired network (route `#network`)
Refreshed every 3 s. The physical ports only; bridges and the layered device/interface view have their own
pages. Nothing is hard-coded to this router: the backend (`flab.network`) classifies whatever netifd
reports (`devtype` dsa/ethernet = port, bridge, vlan), so another board or a new bridge shows up on the
next poll. `shared.js` holds the loader and the address helpers the three network pages share.

- **Summary tiles and health banner**: ports linked, live throughput of the external ports, switch chip,
  errors and drops, link changes. The banner (`healthBanner` in `core/ui.js`) lists what needs attention:
  downshifted link (negotiated speed below what both ends support), link flaps and new errors since the
  page was opened.
- **Port topology** (`topology.js`, `tile.js`, `chips.js`): the wiring of the Ethernet ports, drawn from
  what the router reports, so another board gets its own picture: SoC, its MAC(s), the CPU port and link
  speed into the switch chip, the chip with its numbered switch ports, an external PHY where one exists, and
  one jack per column (green/amber/grey by link state, LAN/WAN label, speed, live rate, chart, bridge, STP
  role, VLAN devices). Jacks follow the order `/etc/board.json` lists its ports (usually the order on the
  case) with each switch's ports kept together; a switch's CPU port and the SoC MAC behind it come from the
  device tree (`ports/port@N` with an `ethernet` property, matched to the MAC by phandle); a port has an
  external PHY when its node has a `phy-handle`, otherwise the switch's internal one. A router without a
  switch just gets MAC, PHY and jack columns. `chips.js` adds a one-line description for a few well-known
  chips (MT7531, RTL8221B, ...); it is optional enrichment, an unknown chip shows only its name. On the lab
  router this reproduces the OpenWrt table-of-hardware diagram: MT7986 eth0 into CPU port 6 of the MT7531,
  switch ports 0-3 as lan2-lan5 on the internal PHYs, port 5 as lan1 through an RTL8221B, and eth1
  through a second RTL8221B as WAN.
- **Port table** (`ports.js`): the hardware, link, speed and duplex, negotiation (auto/forced, max speed,
  partner speed, pause), live and total traffic, errors and drops, link-change counter, STP state and role,
  learned MACs and VLAN devices per port. A missing link is shown in neutral grey, not red: an unplugged
  port is normal.
- **Hardware** (when known): the PHY chip (driver name, ID, MDIO address and bus), the switch chip (from the
  device tree of the DSA switch node), the SoC Ethernet MAC, the kernel driver and bus, and the medium.
  The backend reads it once per port (`ethtool -i`, `ethtool`, `/sys/class/mdio_bus`, device-tree
  `compatible`) and caches it. A DSA port's PHY is the one at its `PHYAD` that is not attached to another
  netdev, which keeps `lan3` on the switch's internal PHY instead of the SoC-bus PHY with the same address.
- **Error breakdown**: a port with errors or drops gets a Details button that opens a panel under it (it
  stays open across refreshes): the non-zero kernel counters with an explanation of each, the driver's own
  error counters (`ethtool -S`, error-like names only, e.g. `rx_checksum_errors`), recent system-log lines
  that mention the port, and whether anything is new since the page was opened. The backend only computes
  this for ports that have errors or drops. On the lab router `eth1` shows 42 RX checksum errors: the
  hardware flagged corrupt frames on the WAN link, a cable/connector/peer symptom.

### Bridges (route `#bridges`)
Same data as the Wired network page (one `flab.network` call), one card per bridge (`card.js`).
Tiles: bridges, spanning-tree position, learned MACs. The health banner lists a blocked (alternate) STP
port, a topology change, a down bridge, STP off with several linked ports. Each card shows the
spanning-tree position (this bridge is the root, or the root bridge ID, the root port and path cost),
bridge ID, priority, timers, ageing, learned MACs, VLAN filtering and default PVID, IGMP snooping, VLAN
devices, addresses of the logical interfaces on it, and a member table with type (Ethernet or Wi-Fi with
SSID), link, STP state and role, port cost, MACs learned per port and live throughput.

### Mesh (route `#mesh`)
Refreshed every 5 s, from `flab.mesh`. Discovered from UCI: one node card per `wifi-iface` with
`mode=mesh`, so a router without mesh shows an empty page and a second mesh interface gets its own card.
- **Tiles**: mesh interfaces, peers established, weakest link (signal), mesh paths, forwarding.
- **Node card** (`node.js`): mesh ID, interface, MAC, security label (SAE/WPA3 detected from the
  encryption setting), channel, frequency and width, traffic counters. If the interface is configured but
  not running the card says so and shows no live data.
- **Peers**: link state (ESTAB, LISTEN, ...), signal and average, TX/RX bit rate, airtime link metric,
  expected throughput, connected time, retries and failed transmissions, mesh gate flag.
- **Paths**: destination, next hop, hop count, metric, lifetime and the decoded flags (active, resolving,
  sequence-number valid, fixed, resolved). Entries appear and disappear as the mesh converges.
- **Mesh parameters** (`iw get mesh_param`, cached 60 s in the plugin) with findings, e.g. forwarding off.
- **STP note**: when the bridge's root is reached through the mesh port, the root bridge MAC is matched to
  a peer by its first five octets (the bridge MAC and the radio MAC differ in the last octet).
- The mesh key (`key` / SAE password) is never read into the output; the tests plant a canary to prove it.

### Devices and Interfaces (route `#interfaces`)
Refreshed every 5 s, after the Wired network, Bridges, Wi-Fi and Mesh pages because it ties them together.
`layers.js` is the pure model (unit-tested), `table.js` renders it. Data: `flab.network`, netifd's
interface dump and (optional, a missing plugin only drops the wireless layer) `flab.radio`. OpenWrt builds a
network in layers, and the table shows one row per interface with the whole chain: physical ports and
radios with their Wi-Fi and mesh interfaces, then the devices built on them (a bridge groups ports and
Wi-Fi; an 802.1q VLAN device sits on a port or a bridge), then the netifd interface that binds to one device
and holds the protocol, addresses, gateway and DNS, then the protocol device some protocols create on top
(the PPPoE session `pppoe-wan`, a WireGuard or XFRM device). An interface can ride on another interface's
protocol device (`wan6` on the PPPoE session of `wan`, shown as shared) or run over another interface
(`tunlink`, read from UCI, e.g. the IPsec XFRM interfaces over `wan`). Rows are ordered by the first
front-panel port they use, tunnels last; a device the router does not describe is kept as an unknown device,
never dropped.
- **Wireless nodes**: a Wi-Fi or mesh interface is a chip with its SSID or mesh ID and the radio and band it
  runs on, linking to the Wi-Fi or Mesh page. Bridge members and interfaces directly on a Wi-Fi device
  (station mode) are matched to `flab.radio` by interface name. A configured interface that is not running
  has no name yet, so it joins the interface named in its `network` option, shown as down.
- **Unattached wireless**: a wireless interface that reaches no netifd interface, and a radio with no
  interface at all, get a row of their own at the end; the former also raises a finding.
- **Several interfaces on the same ports** (the lab's `lan` and `lan100`): a bridge hands its untagged frames
  to the interface bound to it, while an 802.1q VLAN device on that bridge picks out only the frames carrying
  its tag and gives a second, separate interface on the same wires. Rows that sit on the same set of ports
  and radios list them once; later rows say "same N ports and radios as <first row>", and the Devices column
  says what each row carries ("the bridge's untagged frames", "only frames tagged VLAN 100 on br-lan").
- **Firewall zone and services** (from `flab.network`: UCI firewall and dhcp): the zone of each interface
  (tooltip: input/output/forward policy, NAT, zones it may forward to) and the DHCPv4 pool, DHCPv6 and
  router-advertisement mode of the interfaces that serve them.
- **Addressing** also lists non-default routes netifd installed for the interface (`on link` when the next hop
  is unspecified) and the IPv6 prefixes assigned to it or received on it.
- **Tiles**: interfaces up, bridges, VLAN devices, protocol devices, tunnels, radios up, wireless interfaces.

The page order is the layers of the network from the bottom: Wired network, Bridges, Wi-Fi, Mesh, IPsec VPN,
WireGuard, Firewall, then Devices and Interfaces, which recaps how all of them fit together, followed by BGP
(routing over the tunnels) and Services.

**Legends and "how to read" notes sit at the top of the card or section they explain** (Devices and Interfaces,
the port diagram, the zone matrix, the Wi-Fi client legend, the IPsec score explanation), so the key is read
before the data rather than after scrolling past it. Keep that when adding a page.

Facts worth remembering (Wired network, Bridges and Mesh pages):
- Learned MACs per port come from the kernel's binary forwarding table (`/sys/class/net/<bridge>/brforward`,
  16 bytes per entry; the port number is the low byte at offset 6 plus the high byte at offset 12). The
  `bridge` utility is not installed on the router.
- The CPU link (`eth0`) is the DSA conduit: every switch port's traffic also crosses it, so it is excluded
  from the throughput tile.
- On the lab router the bridge is not the STP root: the root bridge is reached through the mesh port
  (`phy0-mesh0`), which therefore has the Root role.

### Services
`service list` (procd): running vs idle/one-shot services with PIDs.

## Testing

`tests/bgp/run.ps1` tests the BGP page without touching the router's BGP sessions. The page parses BIRD's
text output, so this guards against both parser regressions and a new BIRD version changing the format.

```powershell
pwsh -File flab-ui\tests\bgp\run.ps1            # backend: parser + findings against 4 scenarios
pwsh -File flab-ui\tests\bgp\run.ps1 -Browser   # plus the live-update test in Edge (needs the UI deployed)
```

How it works:
1. **Capture** the real `birdc`/`ip` output the plugin parses (read-only commands).
2. **Build scenarios** (`mkfx.mjs`) from it: `base` (unchanged), `down` (a peer in Active with an error and a
   connect timer; synthetic, modeled on BIRD's documented format, not captured), `dual` (IPv6 channels,
   IPv6 ECMP routes with link-local next hops, one best route deliberately missing from the kernel, an
   IPv6 announcement) and `announce` (different announcements per peer, a non-static origin, a peer that
   receives nothing).
3. **Run the repository's `flab.bgp.uc` on the router** against each scenario. The plugin has a small test
   seam: when `FLAB_BGP_FIXTURES=<dir>` is set it reads `<dir>/<command>.txt` instead of running `birdc`
   and `ip`. rpcd never sets it, so production behavior is unchanged.
4. **Assert** (`assert.mjs`): parsed fields, findings, kernel-sync detection, IPv6 handling.
5. **Browser test** (`live.mjs`, `-Browser`): the deployed UI is opened in Edge via `playwright-core`
   (installed into the temporary work folder). The `flab.bgp status` call is intercepted and answered with
   the scenario JSON, so the page is driven through normal, peer down, IPv6, changed announcements, peer
   removed, peer added and eight peers, and back to the live router, all without a reload. It checks the
   tiles, topology, cards, tables, findings, the peer dropdown, color stability and the absence of console
   errors.

The suite removes `/tmp/flab-bgp-test` on the router and its local temp folder when it finishes. Add a
scenario by extending `mkfx.mjs` and `assert.mjs`; add a captured sample of a state you want to keep
testing as extra `.txt` files.

### IPsec tests

`tests/ipsec/run.ps1` works the same way for the IPsec page and never touches the tunnels:

```powershell
pwsh -File flab-ui\tests\ipsec\run.ps1            # unit test + backend scenarios
pwsh -File flab-ui\tests\ipsec\run.ps1 -Browser   # plus the live-update test in Edge (needs the UI deployed)
```

1. `rates.test.mjs`: unit test of the throughput history (rates, counter resets, gaps, pauses, per-SA
   keys, removed connections); needs no router.
2. Capture `swanctl --list-conns|--list-sas|--stats|--version --raw`, `ip -s xfrm state` (key material is
   redacted on the router before it is copied; `mkfx.mjs` then plants a canary key so the assertions prove
   the plugin never forwards it), the xfrm interface addresses and their uci/netifd data.
3. `mkfx.mjs` builds `base`, `down`, `rekey` (two child SAs), `multi` (two IKE SAs under one name),
   `orphan` (SA without connection, child SA without child config), `ipv6` and `daemondown`. These are
   synthetic variations of the captured output, not captured states.
4. The repository's `flab.ipsec.uc` and `rpcd/lib/flab/*` run on the router with `FLAB_FIXTURES` and
   `ucode -L`, so the uploaded libraries win over the deployed ones; `assert.mjs` checks the JSON.
5. `live.mjs` (`-Browser`) intercepts `flab.ipsec status` and drives the page through all scenarios plus
   simulated traffic, checking tiles, cards, badges, IPv6 rows, the stopped-daemon state and console errors.

It cleans up `/tmp/flab-ipsec-test` and its local temp folder.

### Network, Wi-Fi radio, Mesh, WireGuard and Firewall tests

`tests/network/run.ps1` covers the `flab.network`, `flab.radio`, `flab.mesh`, `flab.wireguard` and `flab.firewall`
plugins and the Wired network, Bridges, Devices and Interfaces, Wi-Fi, Mesh, WireGuard and Firewall pages, again
without changing anything on the router:

```powershell
pwsh -File flab-ui\tests\network\run.ps1            # unit test + backend scenarios
pwsh -File flab-ui\tests\network\run.ps1 -Browser   # plus the live-update test in Edge (needs the UI deployed)
```

1. `rates.test.mjs`: unit test of `core/rates.js` (rates, ratios, counter resets, gaps, capping, pruning);
   `layers.test.mjs`: unit test of the network layer model (bridge and VLAN stacking, PPPoE over a VLAN,
   an interface riding on another's protocol device, tunnels with and without an underlay, unknown devices,
   parent loops, Wi-Fi and mesh nodes with their radio, configured-but-down interfaces, unattached wireless
   and radios without interfaces); `firewall.test.mjs`: unit test of the zone matrix and the firewall findings
   (forwardings, policies, `dest "*"`, port forwards, disabled and invalid rules, open WAN, unzoned interfaces).
2. Capture what the plugins read: each plugin is run once on the router with `FLAB_RECORD` set, so it saves
   its own inputs (`ubus call` results, UCI, sysfs files, command output). Keys and passwords are blanked
   while recording (including WireGuard `private_key` / `preshared_key`), and `mkfx.mjs` plants a canary in every
   `wifi-iface` and in the WireGuard secrets so the assertions prove they are never forwarded; it aborts if a
   capture still holds a real WireGuard key.
3. `mkfx.mjs` builds scenarios: `n-linkdown`, `n-downshift`, `n-root`, `n-blocked`, `n-nostp`,
   `n-vlanfilter`, `n-newbridge` (a second bridge takes over a port), `n-highport` (port number above 255),
   `n-nodevices`, `n-board` (a different router: other model, four LAN ports in reverse order, no external
   PHY), `n-nodsa` (no switch at all), `n-errors`, `r-down`, `r-dfs`, `r-channel`, `r-disabled`, `r-newssid`,
   and for the mesh `m-twopeers` (a second peer in LISTEN that is a gate, a two-hop path, an unresolved
   path), `m-weak` (weak, lossy link), `m-fwdoff`, `m-nopeer`, `m-down` (configured but not running),
   `m-nomesh` (no mesh configured), and for WireGuard `w-stale` (a handshake 1000 s old), `w-down` (configured
   but not running), `w-newpeer` (a peer the kernel has but UCI does not), `w-noroutes` (a site peer without
   routes), `w-nozone` (interface in no firewall zone), `w-nowg` (no WireGuard at all), and for the firewall
   `f-stopped` (no nftables), `f-redirect` (a port forward with a hit counter), `f-exposed` (the WAN zone accepts
   input and a rule opens every port), `f-disabled`, `f-anonymous` (an unnamed rule, matched through `@rule[N]`),
   `f-unzoned` (an interface in no zone), `f-conntrack` (table nearly full). Handshake times in a
   capture age while the test runs, so the base scenario pins the connected peer to "30 s ago".
   The bridge forwarding table is binary, so it is generated; everything else is the captured state with
   targeted edits. Device-tree files are recorded hex-encoded (`hex:...`) because JSON cannot carry bytes.
4. The repository's plugins and `rpcd/lib/flab/*` run on the router with `FLAB_FIXTURES` and `ucode -L`
   (`harness.uc` runs the plugin named in `FLAB_PLUGIN`); `assert.mjs` checks the JSON.
5. `live.mjs` (`-Browser`) intercepts the status calls and drives each page through every scenario (Wired
   network, Bridges, Devices and Interfaces, Mesh, WireGuard, Firewall, Wi-Fi), checking that mesh interfaces and
   clients stay off the Wi-Fi page and that legends sit above what they explain, then simulates traffic, nft
   counters and airtime counters to check live rates and the utilisation percentage.

It cleans up `/tmp/flab-net-test` and its local temp folder.

## Gotchas learned the hard way

- **`rpcd reload` does not pick up new logins**; use `restart`.
- **Password hashes**: rpcd rejected `$1$` MD5 hashes on this build; use SHA-512 (`openssl passwd -6`).
  PowerShell adds `\r` to piped input, so strip it before hashing.
- **BusyBox** has no `od`; `scp` needs `-O`; shell snippets sent over ssh must be LF-only.
- **Splatting a single path** in PowerShell iterates its characters; wrap in `@(...)`.
- **hostapd rate units**: `ubus hostapd.<if> get_clients` reports rates in units of 10 bit/s, so divide
  by 100000 to get Mbit/s.
- **VICI parsing**: scalar values can contain spaces; see `flab.vici`.
- **`ip monitor` on the router**: `timeout ip ...` runs BusyBox's reduced `ip` applet, which has no
  `monitor`. Call `/sbin/ip` (iproute2) by full path.
- **BIRD has no JSON output**: `flab.bgp` parses `birdc` text (indentation-based sections for protocols,
  header plus tab-indented attribute lines for routes). The parser skips unknown lines, so a newer BIRD
  only loses fields. Protocol names from `birdc` are validated before being used in a shell command.
- **ucode numbers and time**: `+"08"` is 8 (decimal), `timelocal({...})` works for BIRD timestamps,
  `match(s, /re/g)` returns an array of `[full, group]` pairs, `split(s, sep, limit)` is supported.
- **The 404 for `favicon.ico`** is avoided with an empty data-URI icon in `index.html`.
- All pages were exercised in light and dark at 1920x1080 with no console errors; the Wi-Fi page was
  also checked at 2560x1300. None showed horizontal page overflow.

## Conventions

- Code comments only where they add clarity (intent, non-obvious behavior); no comment narration.
- PowerShell follows `Set-StrictMode -Version Latest`, `$ErrorActionPreference = 'Stop'`, comment-based
  help on functions and `#region` blocks.
- ucode uses tabs, JavaScript and CSS use two spaces.
- When the router configuration is changed outside this folder, the corresponding files under
  `build/MT6000/` in this repository must be updated as well and pushed.
