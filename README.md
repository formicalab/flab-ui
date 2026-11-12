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
router except System settings (`/etc/config/system`), DHCP (`/etc/config/dhcp`), the channel of each radio on the Wi-Fi page (`/etc/config/wireless`) and the Services page, which starts, stops and restarts services; how configuration changes are made safely is described in
[Configuration changes](#configuration-changes) and how services are controlled under [Services](#services-route-services).

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
                |                    flab.network, flab.ipsec, flab.bgp, flab.routing, flab.diag, flab.traffic, flab.dns, flab.sensors, flab.system, flab.logs, flab.services
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
  tests/                     bgp/, dhcp/, dns/, ipsec/, network/ (network, Wi-Fi, mesh, WireGuard, firewall, logs, helpers), routing/, services/, settings/, toolbox/, traffic/, wifi/,
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
        editpage.js          createEditor(): the draft, banner, save/discard and notes every editing page shares
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
        wifi/                index.js (clients, and the editor of the channel), radios.js (radio cards), channels.js (pure model of
                             the channel change), picker.js (the channel picker); mesh interfaces are left to mesh/
        mesh/                index.js, node.js
        ipsec/               index.js, connection.js, daemon.js, names.js, rates.js
        wireguard/           index.js, iface.js
        firewall/            index.js, model.js (pure zone matrix), matrix.js, zones.js, rules.js, util.js
        dhcp/                DHCP: index.js, schema.js (the options), model.js (pure), leases.js, reservations.js, pools.js
        dns/                 DNS: index.js (page, state, the editing wiring), schema.js (the options and their areas, ZONE_FIELDS and ZONE_TYPES), edit.js (pure: draft, changes, problems, the UCI plan, the check after a save), zones.js (pure: the zone blocks of Unbound and the server entries of dnsmasq as a draft: items, changes, validation, plan, checks), model.js (pure: tiles, findings, activity, option areas), zonescard.js (the Zones card), zoneform.js (the dialog that adds or edits a zone), fold.js (the card that folds down to its header, used by Zones and Activity), cards.js (Configuration, Activity)
        interfaces/          Devices and Interfaces: index.js, layers.js (pure model), table.js
        routing/             Routing: index.js (page, tabs, state), model.js (pure: addresses, tables, findings, filtering, lookup meaning),
                             lookup.js (next-hop lookup card), tables.js (tables, rules and route list cards)
          bgp/               The BGP tab: tab.js (composition), topology.js, peer.js, routes.js, announced.js, system.js, util.js
        toolbox/             Toolbox: index.js (page, openTool), diag.js (form, job polling, result views of ping, traceroute and DNS; Wake-on-LAN),
                             diagviews.js (check, comparison and certificate views), diagmodel.js (pure: request checks, output
                             parsing, the check's verdict)
        traffic/             Traffic: index.js (page, tabs, state, polling), model.js (pure: interfaces and totals, WAN, findings, entries, NAT,
                             merging hosts by MAC, protocol rows), live.js, connections.js, usage.js (the three tabs)
        services.js          Re-exports services/index.js (keeps the registry's import path)
        services/            Services: index.js (page), model.js (pure: rows, actions, confirmations, outcomes)
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
  `load()` every `page.interval` ms unless `page.isPaused()` is true. A poll is also skipped while the previous
  one is still running and while the browser tab is in the background (the tab refreshes when it is shown again).
  Only the newest request counts: a late reply that was overtaken, or one for a page that was left, is dropped.
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
- **Type scale:** use these sizes and no others: `.75rem` captions, badges and uppercase labels (letter-spacing `.05em`), `.8rem`
  secondary text, table headers and monospace, `.875rem` body, `1rem` emphasis (a value or headline inside a card), `1.2rem`
  names and the page title, `1.5rem` stat values, `1.75rem` KPI tiles. Weights are 400 and 600 only; `base.css` makes `b`,
  `strong` and the headings 600 (bootstrap's are 700 and 500) and `small` / `.small` `.8rem` (bootstrap's is relative to the
  parent, so it differed in every container). Monospace text uses `var(--fl-mono)` (also bootstrap's `pre` and `code`); never
  spell the font stack out again.
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
  `temperatures.js` builds the temperature cards. A sensor that gives no reading (a Qualcomm Wi-Fi radio that is
  down) is not reported by the plugin and is ignored by the page.
- **Routing**: `index.js` owns the page state, the tabs and the command bar (the tab strip, the filters of each
  tab) and loads only the open tab; `model.js` holds the pure parts (address and prefix math, the table overview,
  findings, filtering and sorting, what a lookup answer means, who added a rule); `lookup.js` and `tables.js` build the
  Routes tab cards. The Toolbox page (`toolbox/`) is separate: `index.js` is the page and exports `openTool`, which the
  lookup answer's buttons use; `diag.js` is the form, job polling and the ping, traceroute and DNS views, `diagviews.js`
  the connectivity check, comparison and certificate views, and `diagmodel.js` the pure parts (the request a form may
  build, the parsers for every tool's output, the check's verdict).
  The BGP tab is `bgp/`: `tab.js` composes the sections; `topology.js`, `peer.js`, `routes.js`,
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
| `flab.diag.uc` | `flab.diag` | `status`, `start` (`tool`, `host`, options), `read` (`id`, `from`), `stop` (`id`), `wake` (`mac`, `iface`) | busybox `ping` and `traceroute`, the first of `dig`, `kdig`, `drill`, `nslookup`, and `openssl s_client` / `x509`, run detached under `timeout` with their output in `/tmp/flab-diag/<id>/out`; `ip route get` and `ip route show default` for the connectivity check; `etherwake` or `socat` for Wake-on-LAN, with the host list from uci dhcp hosts, `dhcp ipv4leases`, `/tmp/dhcp.leases`, `/etc/ethers` and `/proc/net/arp`; `command -v` for the tools, `/sys/class/net` for the interface names, `/tmp/resolv.conf.d/resolv.conf.auto` for the upstream resolvers; every argument validated before a command line is built |
| `flab.ipsec.uc` | `flab.ipsec` | `status` | `swanctl --raw` (via `flab.vici`), `ip -s xfrm state`, `network.device`, uci network |
| `flab.bgp.uc` | `flab.bgp` | `status` | `birdc` (`show status`, `show protocols all`, `show route all`, `show route export <peer>`, `show memory`), `ip -4 route show proto bird` |
| `flab.routing.uc` | `flab.routing` | `status`, `lookup` (`dst`, `src`, `iif`) | `ip -4/-6 route show table all`, `ip -4/-6 rule show`, `/etc/iproute2/rt_tables`, `command -v birdc`, `pidof charon`, uci network (only the `rule` and `rule6` sections, and only their section name, family, priority and lookup table); `lookup` runs `ip route get` and `ip route get ... fibmatch` for a validated address, optional source address and interface name |
| `flab.traffic.uc` | `flab.traffic` | `status`; `connections` (`q`, `limit`, `sort`, `proto`, `scope`); `usage_periods`; `usage` (`period`, `group`) | procfs `/proc/net/nf_conntrack` and `/proc/sys/net/netfilter/nf_conntrack_{count,max,acct}`; `command -v nlbw`, `pidof nlbwmon`, `nlbw -c list`, `nlbw -c json -g <group> [-t <period>]`; names from uci dhcp (`host` sections), `dhcp ipv4leases`/`ipv6leases` (ubus, odhcpd), `/tmp/dhcp.leases`, `/tmp/hosts/*`, `/etc/ethers`, `/proc/net/arp`, `ip -6 neigh show` (see [Traffic](#traffic-route-traffic)) |
| `flab.dns.uc` | `flab.dns` | `status` (no arguments) | procd `service list` (ubus), `pidof unbound`/`pidof dnsmasq`, `command -v unbound`/`dnsmasq`, `netstat -lntup`, `unbound-control status`/`stats_noreset`/`list_forwards`/`list_local_data`, `unbound -V`, the generated `/var/lib/unbound/unbound.conf` and `unbound_ext.conf` (forward-zone clauses), `dnsmasq --version`, ubus `dnsmasq metrics`, uci unbound and uci dhcp (the `unbound` and `dnsmasq` sections), `/tmp/resolv.conf.d/resolv.conf.auto`, `/tmp/hosts/*`, `/tmp/dhcp.leases`, `/proc/<pid>/stat` and `/proc/uptime` (see [DNS](#dns-route-dns)) |
| `flab.sensors.uc` | `flab.sensors` | `status` | sysfs `/sys/class/thermal`, `/sys/class/hwmon` |
| `flab.system.uc` | `flab.system` | `cpu` | procfs `/proc/stat`, `/proc/loadavg`, `/proc/uptime` |
| `flab.logs.uc` | `flab.logs` | `read` (`lines`, `source`) | `logread -l N` (logd ring buffer), `dmesg -r`, `/proc/uptime`; entries are parsed and secret-looking values redacted |
| `flab.services.uc` | `flab.services` | `list`; `control` (`name`, `action`) | `/etc/init.d` (executable files) and `/etc/rc.d` (`S<NN><name>` = starts at boot) for `list`; `control` runs `/etc/init.d/<name> start\|stop\|restart` after strict validation (see [Services](#services-route-services)); its ACL fragment grants `list` under `read` and `control` under `write` |

The System settings page needs no plugin: it reads `/etc/config/system` through rpcd's own `uci` object, whose
calls (on the `system` config only) are granted by `rpcd/acl.d/flab-settings.json`; the DHCP page likewise uses
`rpcd/acl.d/flab-dhcp.json` (ubus `dhcp` methods, `uci` read and write on `dhcp`, and reading `/tmp/*.leases` through
rpcd's `file` object for dnsmasq's lease file).

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
  cannot be compiled that way). `0 == ''` is true, so `util.num()` (which tests for `''`) turns the integer 0 of
  a ubus reply into null: use it for strings only, and test a number with `type(v) == 'int'`.

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
- **Controlling services.** `flab.services control` is the one call that runs a program on request. It never
  takes a command: it accepts only a plain file name that is in `/etc/init.d` and one of `start`, `stop`, `restart`,
  refuses the boot-sequence scripts, and the page asks for confirmation before a stop or restart that can lock the
  user out (see [Services](#services-route-services)). The ACL grants no generic `file exec`.
- **Transport.** uhttpd redirects HTTP to HTTPS and serves with the router certificate. The session token
  travels in the request body, not a cookie, so cross-site requests cannot ride on it.
- **Tests never need the root password.** The browser tests create a temporary rpcd session over ssh and grant
  it exactly what the ACL fragments grant, which is what root holds (`tests/TestSession.ps1`); a missing or wrong
  fragment fails a test as it fails a page for root. The session is destroyed when the test ends.

## Configuration changes

System settings, DHCP and the channel of the Wi-Fi radios change the router, and set the pattern every later editing page follows. The signed-in login (root) may write; a login that may not (`can('uci', 'set')` is false) gets the same
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
  so the page is only controls. Field checks, form rows, the sticky review banner and the draft, save and discard
  logic are shared (`core/fields.js`, `core/forms.js`, `core/ops.js`, `core/editpage.js` and `css/forms.css`): a
  page creates an editor with `createEditor()`, which also gives it `isPaused` and the notes above the form.
- Validate input in the page before staging; `uci` itself has no schema. Show the effect of the edits (the
  review list) before saving, and disable Save while anything is invalid.
- Write only what changed, delete an emptied option instead of storing an empty string, and leave options the
  page does not know untouched.
- Do not poll over unsaved edits: the shell redraws the page on every poll, so `isPaused()` must return true
  while there is something to lose.
- Mirror a change made to the router's configuration into `build/MT6000/etc/config/` in this repository.

**Status.** `core/ubus.js` and `core/uci.js` (including `applyChange`) are unit-tested against a fake transport
(`tests/network/uci.test.mjs`); the System settings, DHCP and Wi-Fi suites test their models and drive the whole flow in a
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

Cleanup removes all of the above (and the diagnostics' job directory `/tmp/flab-diag`, ending any diagnostic still running) and restarts rpcd again. No login or rpcd setting is created or changed.

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

Navigation order: Overview · Wired network · Bridges · Wi-Fi · Mesh · IPsec VPN · WireGuard · Firewall · DHCP · DNS ·
Devices and Interfaces · Routing · Traffic · Services · Toolbox · Logs, then Settings at the bottom, next to Sign out. The network
pages run from the physical layer up; DHCP and DNS, the services the clients of those networks use, come next; Devices and Interfaces recaps how they fit together, followed by routing
(the kernel's routes and BGP), traffic (where the bandwidth goes), the procd services, the toolbox (diagnostic tools) and the logs.

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
  and caches it. `ethtool` is optional: without it (small repeaters leave it out) the driver comes from the
  device's `driver` link in sysfs and the switch is still found from the device tree. A SoC MAC whose netdev has
  no device-tree node (the IPQ4019 Ethernet MAC) takes it from its parent device, so a switch's CPU port is still
  matched to its conduit and the diagram draws that MAC as the link into the switch, not as a port with a jack
  (an `ethN` is only internal when a DSA switch lists it as its conduit). A DSA port's PHY is the one at its
  `PHYAD` that is not attached to another netdev, which
  keeps a switch port on the switch's internal PHY instead of the SoC-bus PHY with the same address.
- **Error breakdown**: a port with errors or drops gets a Details button that opens a panel under it (it
  stays open across refreshes): the non-zero kernel counters with an explanation of each, the driver's own
  error counters (`ethtool -S`, error-like names only), recent system-log lines that mention the port, and
  whether anything is new since the page was opened. The backend only computes this for ports that have
  errors or drops.

### Bridges (route `#bridges`)
Same data as the Wired network page (one `flab.network` call, plus an optional `flab.mesh` call for the mesh peers),
one card per bridge (`card.js`). Tiles:
bridges, spanning-tree position, learned MACs. The health banner lists a blocked (alternate) STP port, a
topology change, a down bridge, STP off with several linked ports. Each card shows the spanning-tree position
(this bridge is the root, or the root bridge ID, the root port and path cost), bridge ID, priority, timers,
aging, learned MACs, VLAN filtering and default PVID, IGMP snooping, VLAN devices, addresses of the logical
interfaces on it, and a member table with type (Ethernet, Wi-Fi with SSID, or Mesh with its mesh ID and number
of peers), link, STP state and role, port cost, MACs learned per port and live throughput.

The spanning-tree diagram has the same shape on both sides of a mesh link: a bridge that is not the root draws
the root bridge (its ID), the link (root port, path cost) with the mesh peer on it, and itself; the root draws
itself, the link (port, path cost) with the mesh peers that reach it, and "downstream bridge, reached over the
mesh". The root cannot show the downstream bridge's ID because only that bridge knows it (the kernel reports the
root ID and root port on a non-root bridge only). Without a mesh the root keeps the one-line explanation.

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
the driver's cumulative survey counters); the channels allowed by the regulatory domain (a picker to change the
channel, below) with the running block highlighted and DFS (radar) channels marked; and a table of the SSIDs (BSSID,
networks, security, clients, live and total traffic, 802.11r/k/v, WPS, OCV, hidden, isolation, MAC filter
policy with entry count, BSS status). Findings appear when something is off: radio down, setup failing,
running channel different from the configured one, high noise, busy channel, DFS availability check in
progress, open network, country mismatch. Only whitelisted options are copied: keys, passwords, FT key
material and MAC lists never leave the router. Mesh (802.11s) interfaces are not listed here: a radio
carrying one shows a `mesh · <id>` badge linking to the Mesh page, and mesh peers are not in the clients list.

**Changing the channel** (`wifi/channels.js` model, `wifi/picker.js` control, the shared editor of
`core/editpage.js`): each radio card shows its allowed channels as tiles. Only the `channel` option of the radio's
`wifi-device` section is edited (a channel number or `auto`); the width stays as configured, so a channel is only
selectable when the whole block of that width fits around it in the regulatory domain (others are hatched).
- **Preview**: hovering or focusing a tile shows the block the radio would use at its configured width, in blue,
  or in red with the reason when it does not fit. The block is made of whole 20 MHz channels: on 5 and 6 GHz the
  fixed blocks (36-48 at 80 MHz, 100-128 at 160 MHz); on 2.4 GHz a 40 MHz block is the channel and the one four
  numbers away, on the side netifd picks (channels 1-6 above, 7-13 below, or an explicit `HT40+`/`HT40-`), so
  channel 4 with channel 8 covers 2417-2457 MHz. The channels between the two are shown as covered, the ones that
  stick out as partly overlapped (dashed). The sentence under the tiles says the same in words.
- **Choosing**: a click selects (green, with its block tinted), a second click undoes it; the Auto chip hands the
  choice to the radio. The yellow review banner lists the change from and to, with warnings that do not block Save:
  a block that reaches radar (DFS) channels (the radio listens for radar for 1 to 10 minutes before clients can
  connect), `auto`, and a radio that carries a mesh interface (the other mesh nodes must be moved to the same
  channel by hand). A channel the regulatory domain disables, or whose block does not fit, is an error that
  blocks Save.
- **Saving**: stage, apply with the rollback countdown, then read back only the radios' own sections (never the
  whole wireless config, which holds the Wi-Fi keys) and wait until each changed radio is up again; if it is not
  within 16 seconds the change is rolled back. A radio on a DFS channel counts as up while it listens for radar.
- Polling is suspended while the pointer is over a picker, while a choice is pending and during a save. A login
  that may not write, or a radio whose phy did not list its channels, gets the plain channel strip.
- The page needs the ACL fragment `rpcd/acl.d/flab-radio.json` (the plugin, and `uci` read and write on `wireless`).

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
daemon card. Compact/detailed toggle. When charon is not running, the daemon card is a red error if connections are
configured, and a plain note when `/etc/config/swanctl` has no sections (the init script then never starts charon);
the plugin reports this as `daemon.configured`.

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

### Routing (route `#routing`)
The kernel's routing state and, when the router has BIRD, BGP, in up to two tabs on one page
(the tab strip sits in the command bar; the BGP tab shows only when `birdc` is installed, which `flab.routing status`
reports as `bird`). Only the open tab is polled (every 5 s), and each tab has its own filters in the command bar.

#### Routes tab
Reads `flab.routing status` (and `network.interface dump` for the logical interface names such as `wan` next to
`pppoe-wan`). Top to bottom:
- **Tiles:** the IPv4 and IPv6 default routes (interface as the value, next hop underneath, "+ N more" when several
  exist), routes in the main table by family, the routing tables, policy rules (and how many were added beyond the
  kernel's own) and multipath routes.
- **Banner:** a missing IPv4 default route (warning), a missing IPv6 one (note), a default route that drops
  everything, routes with a next hop that is `dead` or `linkdown`, a truncated list, or `ip` not available.
- **Next hop lookup:** a destination, an optional source address and an optional arrival interface (policy rules can
  depend on both) go in; the kernel's answer comes out: the next hop, the interface, the source address it would
  use, the matched route (`ip route get ... fibmatch`), its routing table with a "Show this table" button, and the
  rules that consult that table ("Chosen by"). The answer says what the packet meets: forwarded, a local, broadcast,
  multicast or anycast address, dropped by a blackhole, unreachable or prohibit route (the kernel only reports these
  as an error code, so the page names the covering route itself), no route, or only a source-specific route ("fill
  in From"). An ECMP route lists all its next hops and says the kernel picked one per flow. The raw `ip` output is
  one click away. The lookup is part of the poll: once a query is set every refresh asks the kernel again, so the
  answer follows route changes (a failover shows up by itself), and the matched route is highlighted in the list.
  Polling pauses while a form field has focus; the form's text lives in the page state.
- **Policy rules:** the section starts with a short header, "How the kernel picks a route": rules are checked from
  the lowest priority number to the highest, a priority is not a table number, a table without a matching route
  sends the lookup on to the next rule, and the cases that end it (blackhole, unreachable and prohibit routes or
  rules; `throw` and `suppress_prefixlength` continue). Below it, every rule of both families in the order the
  kernel applies them (priority, family, what it
  matches, what it does) and an "Added by" column. The kernel does not record the author of a rule, so the page
  infers it and says so in the tooltip: the three kernel rules (0, 32766, 32767), a rule configured in
  `/etc/config/network` (same family and priority, a `config rule` or `rule6` section; netifd installs it),
  strongSwan's default (priority 220, table 220, every packet; the tooltip notes when charon is not running, so
  the rule may be a leftover), and netifd's IPv6 reject rule for a delegated prefix (priority 4200000000 with an
  `iif`). Anything else is flagged "unknown".
- **Routing tables:** every table that holds a route or is named by a rule or in `rt_tables` (name, number, what it
  is for, the rules that consult it, route counts per family). A click selects the table in the route list.
- **Routes:** the routes of the selected table (default: main) for the selected family, filtered by text (any
  destination, next hop, device, logical interface, protocol, ...), sortable by destination, type, next hop,
  interface, protocol, metric and table. A route shows its type (blackhole, unreachable, prohibit, throw, local,
  broadcast, ...), every next hop with its weight and interface, protocol, metric, preferred source address, table
  and details (scope, expiry, `pref`, MTU, `onlink`, `linkdown`, `dead`). Routes with a dead or link-down next hop
  are tinted. A long list draws its first 400 rows with a "Show all" button.

`flab.routing` parses the text of `ip` (iproute2; every router here has `ip-full` or `ip-tiny`): routes keep
their table, type, prefix (normalized to `address/length`, `default` becomes the zero prefix), source prefix,
protocol, scope, metric, preferred source, expiry, MTU, flags and next hops (the `nexthop` lines of a multipath
route, `via inet6`, `mtu lock`); rules keep their selectors in order and the action (lookup, goto or a drop type).
At most 4000 routes per family are returned (`truncated`). `lookup` accepts only an IPv4 or IPv6 address, an optional
source address and an interface name, and refuses anything else before a command is built, so nothing but those
three strings can reach the shell. The plugin is read-only, and the ACL fragment `rpcd/acl.d/flab-routing.json`
grants only `status` and `lookup`.

#### BGP tab
Status of BIRD 3 (`flab.bgp`). Sections, top to bottom:
- **Tiles:** sessions established, prefixes learned (and paths), prefixes announced, multipath (ECMP) share,
  kernel sync, BIRD version/uptime.
- **Topology:** this router, one node per peer, remote AS node (peers are grouped by neighbor AS). The router
  node lists what its peers actually receive ("Announces"), whichever BIRD protocol produced it. CSS grid plus
  SVG connectors (animated while a session is Established). Each peer keeps one color (`pc-0..5`) across every
  table on the page; colors are assigned on first sight and never reshuffled when other peers come and go
  (more than 6 peers reuse the least-used color). The connector math needs equal-height, touching peer cells
  (see the comment in `routing/bgp/topology.js`).
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

### Traffic (route `#traffic`)
Where the bandwidth goes, in three tabs on one page (the tab strip sits in the command bar). Connections is offered when
the router has connection tracking and Usage only when it has `nlbw`; `flab.traffic status` reports which features exist.
Only the open tab is polled, every 3 s. The connection table and nlbwmon cost the router more than reading a counter, so
those two tabs reuse their last answer until it is 10 s (Connections) or 30 s (Usage) old, unless the request changed or
Refresh was pressed. The state (open tab, filters, sorts) lives in the page, so it survives the redraw on every poll.

#### Live tab
Reads `flab.network status` and netifd's interface dump, the same calls and the same rate tracker as the Wired network page
(`network/shared.js`, `network/util.js`), so a counter sampled by one page serves the other, and `flab.traffic status` for the
connection count (optional: without the plugin the tab still works and is the only one). No counter is read a second time.
- **Interfaces** (`model.deviceRows`): every device `flab.network` reports, once each: Ethernet ports, the CPU conduit of a
  switch, bridges, their members (wired, Wi-Fi with the SSID, VLAN) and VLAN devices. They come from the router on every
  poll, with the logical interface names (`wan`, `lan`) from the interface dump. A PPPoE or tunnel device that
  `flab.network` does not list (`pppoe-wan`, `wg0`, `xfrm0`) has no row of its own; a PPPoE WAN is carried by the VLAN or port it
  runs on, which is listed.
- **WAN**: the interfaces that are up and have a default route (IPv4 or IPv6); a router without one falls back to an interface
  named `wan`. The row that carries it is the L3 device when it is listed, else the device it runs on (`pppoe-wan` runs on
  `eth1.1036`); links that share a device are listed once and the row is marked WAN and sorts first.
- **Table**: link state and speed (an unplugged port is neutral gray, not red), download and upload in line units
  (Mbit/s), a sparkline of both directions (60 samples), the share of the link speed the busier direction uses, and the
  counters since boot. A bridge, a VLAN device and the CPU conduit repeat what the ports under them carry, so they are
  dimmed and left out of the totals. A long list draws its first 40 rows with a "Show all" button.
- **Tiles**: WAN throughput (and which device carries it), all interfaces (ports, Wi-Fi and other members that count; routed
  traffic is counted on both sides, and the tile says so), the busiest interface, the connection count against the limit
  (amber from 80%, red from 95%) and what the WAN device moved since boot.
- **Banner**: the connection table nearly full, and nlbwmon installed but not running.

#### Connections tab
The connection tracking table (`flab.traffic connections`).
- **Tiles**: connections against the limit, TCP/UDP/ICMP counts, established, unanswered (never got a reply), translated by
  NAT, and the busiest source.
- **Banner**: the table close to its limit; an analysis that did not cover the whole table (see below); a host that holds
  100 or more connections and at least 40% of the analyzed table, or 3000 of them; unanswered connections (50 or more and a
  quarter of the table, or 20 or more from one host); packet and byte counters switched off (`nf_conntrack_acct=0`).
- **Busiest sources and destinations**: the ten hosts with the most connections and the ten with the most traffic, by original
  source and destination address, with the host name where the router knows one and the number of unanswered connections. A
  click on a host filters the table to it.
- **Table**: one row per tracked connection: family and protocol (ICMP types are named), the original endpoints with
  their ports (IPv6 in brackets and compressed) and the host names below, the **translated** tuple when NAT changed it, the
  state badges, the remaining life and the packets and bytes of both directions (↑ the original direction, ↓ the replies). SNAT is
  the masquerade of the LAN behind the WAN address (the source becomes the WAN address and port) and DNAT a port forward
  (the destination becomes the inside host and port); the badge's tooltip says so. A TCP row shows its state, a UDP flow without
  a state word shows `assured` or `replied`, a flow nobody answered has `UNREPLIED` and a tinted row, and a flow in the flow
  table shows `offloaded` with no countdown (the kernel prints no timeout for it). Without byte counters the size cell
  is a dash and nothing fails. A legend above the table explains these.
- **Controls** (command bar): filter text (host, name, address, port, protocol, state, flag; every word must match; typing waits
  for a pause before it asks again), a protocol selector filled from what the table holds, All traffic / Internet traffic /
  Internal only, the order (most traffic, most packets, longest timeout) and how many rows to fetch (300, 1000, 2000). The page
  draws the first 100 fetched rows and a "Show all" button for the rest. "Internal" means that all four addresses of the entry
  (both directions) are private, loopback, link-local, unique-local, multicast or shared (CGNAT) addresses; "Internet" is everything else.
  A filter the plugin would refuse is not sent: the page shows why.

#### Usage tab
nlbwmon's counters per host (`flab.traffic usage_periods` and `usage`); the tab exists only when `nlbw` is installed.
- **Note** above the tiles, one box: first the accounting period the numbers belong to (its dates, how many days it has run and,
  for the running period, when it ends and the counters start again from zero; a stored period shows both dates and that it is
  finished), then what the numbers are: what nlbwmon has counted since the period started, download is what a host
  received and upload what it sent, nlbwmon must be running (nothing is recorded while it is stopped) and only the networks it
  lists as `local_network` are counted. The period is worked out from `database_interval` in `/etc/config/nlbwmon` (a day of the
  month, negative from the end, or `YYYY-MM-DD/NN` for every NN days) and the router's date, because nlbwmon itself does not say
  when the running period began (it is listed by `nlbw -c list` only once committed to disk).
- **Period selector**: the running period with its start date (`nlbw` without `-t`; it is not listed a second time as a stored
  one, whose copy is only as new as the last commit) and the older stored periods `nlbw -c list` prints, newest first.
- **Tiles**: the period total (with the average per day over the days the period has run), download, upload, the top host (name and
  share), the number of hosts and connections. The totals come from the plugin and cover every row, also those left out of the reply.
- **Hosts**: one row per device: the IPv4 and IPv6 rows nlbwmon keeps for one MAC (it is asked for the group `mac,ip`) are
  summed, so a device with an IPv6 privacy address is still one row. Traffic with the all-zero MAC has no device behind it, so
  each of its addresses stays one host. The row shows the name (from DHCP and hosts data, else the address), the MAC, every
  address, download, upload, total, a share bar and the connections; the columns sort and the filter in the command bar
  matches name, MAC or address. A long list draws its first 50 rows with a "Show all" button. A device whose counters cannot be right
  (in a direction with at least 100000 packets, fewer than 28 bytes per packet on average, less than the smallest IP packet) is marked
  "counters look wrong".
- **Protocols**: the same period grouped by `layer7`: nlbwmon's application name (HTTPS, QUIC, DNS, ...), else the transport and
  port ("TCP 8443"), else "Other IP"; the twelve largest and the rest summed.
- **Banner**: nlbwmon installed but not running (the tab then shows only the note and no periods), a period with nothing counted,
  an error from `nlbw`, counters that cannot be right (a warning that says how bad, that totals are inflated and names a known cause,
  flow offloading, which on the main router fed nlbwmon about one byte per packet and inflated a month to tens of terabytes), rows
  left out by the plugin's cap.

#### The plugin
`flab.traffic` is read-only and the ACL fragment (`rpcd/acl.d/flab-traffic.json`) grants its four methods under `read`; there is
no write access and no generic `file` or exec grant. Live throughput is not here: it is the counters `flab.network` already reads.
- `status`: `conntrack` (the tracker is loaded: its count file exists), `count`, `max`, `acct`, `nlbw` (`command -v nlbw`),
  `nlbwmon_running` (`pidof nlbwmon`). It never reads the table itself.
- `connections` (`q`, `limit`, `sort`, `proto`, `scope`): parses `/proc/net/nf_conntrack` (read through `sysfs_raw`, so the
  tests can replay it), at most 20000 lines, and stops earlier when the call has used 3 s (a huge table on a small router must not hold
  up rpcd). `total` is the number of lines, `parsed` the entries analyzed, `truncated` says some were not, `matched` how many pass the
  filters, `entries` the first `limit` of them sorted, `names` the names of the addresses the reply mentions and `aggregates` the
  counts per protocol and TCP state, the unanswered and translated entries and the ten busiest sources and destinations by
  connections and by bytes (and the five sources with the most unanswered connections). The aggregates cover everything analyzed, not
  only what passed the filters. Each entry has `family`, `proto`, `state`, `timeout` (null for an offloaded flow), `flags`, `src`,
  `dst`, `sport`, `dport` (the original tuple), `icmp` (the ICMP type), `nat` (the original tuple as the other side of a
  translation sees it, only when the reply is not the mirror image of the original) and `bytes` / `packets` as [original, reply]
  (absent without counters). IPv6 addresses (zero-padded in the kernel's file) are compressed the way `ip` prints them; names come
  from uci dhcp `host` sections, odhcpd's `dhcp ipv4leases` and `ipv6leases`, `/tmp/dhcp.leases`, `/tmp/hosts/*`, `/etc/ethers` and the
  ARP and IPv6 neighbor tables (a SLAAC address takes the name of its MAC), with the domain removed, never from reverse DNS.
- `usage_periods`: `present`, `running`, the periods (only plain dates `nlbw -c list` printed, newest first; none while nlbwmon
  is stopped), `current` (the start date of the running period) and `today`, both worked out from `database_interval` and the
  router's date.
- `usage` (`period`, `group`): `period` is `current` or a date that `nlbw -c list` printed, `group` one of `fam`, `mac`, `ip`,
  `mac,ip`, `layer7`, `ip,layer7`, `mac,layer7` (nlbwmon's own columns follow: `family` for `fam`, `proto`, `port` and `layer7` for
  `layer7`). The reply has `columns`, `rows` (objects, largest total first, at most 3000, with `total_rows` and `truncated`), `totals`
  over every row, `names` by MAC and by IP and `window` (`start`, `end` (the first day of the next period), `today`, `ongoing`, `days`).
  Without nlbw, with nlbwmon stopped, for an unlisted period or when `nlbw` prints no data
  the reply is `{ ok: false, error }`.
- **Validation**: every argument is checked before anything is built, and a request that fails comes back as `{ ok: false, error }`
  without entries. `q`: a string of at most 64 characters from letters, digits and `. : - _ /` and space (a newline is refused too); `limit`: an
  integer from 1 to 2000 (default 300); `sort`: `bytes`, `packets` or `timeout`; `proto`: `all` or 1 to 12 lowercase letters and digits; `scope`: `all`,
  `internet` or `internal`; `period` and `group` as above. `connections` never reaches a shell. The only commands the plugin runs are
  the fixed strings `command -v nlbw`, `pidof nlbwmon`, `ls /tmp/hosts`, `ip -6 neigh show`, `nlbw -c list` and the `nlbw -c json`
  command, whose group is the allow-list's own string and whose period is the date taken from nlbw's own list, never the request's text; a test
  reads the plugin's source and fails if any other `run()` call appears or one is built from a template.
- **Speed**: ucode runs a few hundred thousand operations per second on a small router (5 to 7 s for 20000 entries on a GL-X3000
  with the time limit off, which is why the limit exists), so the loop cuts each line at its `src=` markers with string functions (regular expressions cost
  far more), reads TCP and UDP lines by position and builds the full entry only for the lines it returns.

### Services (route `#services`)
Refreshed every 5 s. Lists the router's services and starts, stops and restarts them. Two sources are merged by
name: the init scripts in `/etc/init.d` (`flab.services list`: whether each starts at boot and in which position,
from the `S<NN><name>` links of `/etc/rc.d`), which is why a service that is stopped but installed still appears, and
the daemons procd reports (`service list`: state and PIDs). procd's own `service` object cannot start or stop
anything, so the init scripts do the work, as they do for `/etc/init.d/<name> restart` in a shell.

- **State**: `running` (procd reports every instance running), `idle` (procd knows the service, nothing runs) or
  `no instance` (procd does not list it: stopped, a one-shot service such as `firewall` or `network`, or not managed
  by procd). The legend above the table says so. A procd service without an init script is listed without buttons.
- **Buttons**: Start (disabled while the service runs), Stop and Restart on every init script. The boot-sequence
  scripts (`boot`, `done`, `umount`) have none. While a call runs every button is disabled and the row says
  "Restarting…"; afterwards the outcome is shown above the tiles (green when the script exited 0, red with the
  script's own output when it failed, until dismissed) and the list is refreshed. A login that may not call
  `flab.services control` (`can()`) sees no buttons and a note; without the plugin the page is the read-only procd list.
- **Confirmation** (`model.js`, `riskOf`): stopping or restarting `rpcd`, `uhttpd`, `network`, `dropbear`,
  `firewall`, `wpad`, `dnsmasq`, `odhcpd` or `log` first shows what will happen, in plain words, with Confirm and
  Cancel; nothing is sent before Confirm. The notes that can lock the user out are red (restarting `rpcd` signs
  everyone out, including the user; stopping `uhttpd` or `rpcd` cannot be undone from the page; stopping `network`
  or `wpad` can cut the connection), the others yellow. Starting never asks.
- **Session loss**: `rpcd` keeps the sessions in memory, so after it restarts the next request is refused and the
  shell returns to the sign-in screen with "Session expired"; the outcome note says beforehand that the session ends.
- **Backend** (`flab.services`): `control` accepts a name that is, as a whole, a plain file name (letter or digit
  first, then letters, digits, `_`, `.` and `-`, at most 64 characters) **and** is in the list of executable files
  of `/etc/init.d`, an action that is exactly `start`, `stop` or `restart`, and refuses the boot-sequence scripts.
  Only that validated name and action reach the shell command line; nothing else is interpolated. A refused call
  returns `ok: false` and an `error`, and runs nothing. `reload` is not offered because whether a script supports
  it is not known without running it. The reply is `{ name, action, ok, code, detached, output, error }`; `output`
  is the script's output, at most 4096 bytes.
- **Waiting and background**: a call waits for the script (`timeout 45`, shorter than uhttpd's limit) with its
  output going to a file, so a daemon that keeps the output open cannot hold the call up. `stop` and `restart`
  of `rpcd`, `uhttpd` and `network`, which carry the reply or the connection, instead run in the background two
  seconds later and return `detached: true` at once; their result cannot be reported, so the page says the action
  was requested and refreshes a few seconds later.
- **ACL**: `rpcd/acl.d/flab-services.json` grants `flab.services` `list` (read) and `control` (write) and nothing
  generic such as `file exec`; the `service list` call comes from `flab-base.json`.

### Toolbox (route `#toolbox`)
Diagnostic tools that run on the router and show their output as it arrives: a connectivity check, ping, traceroute, DNS
lookups and comparisons, a TLS certificate check and Wake-on-LAN. The form has a tool selector, the host, and the options of the tool:
for ping the count
(1 to 10), the packet size (0 to 1400), the address family and a source (an interface or an address; the router's interface
names are offered as suggestions); for traceroute the maximum hops (1 to 30), the probes per hop (1 to 3), UDP or ICMP
probes, family and source; for DNS the record type (A, AAAA, MX, TXT, NS, CNAME, SOA, PTR, SRV, CAA) and an optional
server; for the comparison the record type and the servers; for the certificate check the port, a server name and a STARTTLS
protocol. A tool is offered only when the router has what it needs (the certificate check needs `openssl`, the DNS tools
and the check need a DNS tool). The form is checked in the browser
first (a host with a space, a leading `-` or shell characters never reaches the router), and the plugin checks everything
again. The form remembers its values while the page is open; Run is disabled for a login that may not start diagnostics.
- **Connectivity check:** one click that walks down the stack and says where it breaks: the default route, the next hop
  (found the way the kernel would route to 1.1.1.1, a PPP peer address when the link has no gateway) and a ping of it, two
  public addresses (1.1.1.1 and 8.8.8.8), a DNS lookup through the router's resolver and through 1.1.1.1, the IPv6
  equivalents (skipped when there is no IPv6 default route) and a TLS handshake to the host (`example.com` unless another is
  given). The steps turn from waiting to done while it runs, and a verdict says what is wrong in the order the problems
  matter: no default route; a dead next hop; a next hop that answers while the internet does not; a router resolver that
  fails while a public one answers; no DNS at all (port 53 blocked); a certificate that is not yet valid or expired (the
  router's clock is the first suspect); an IPv6 route that leads nowhere (a note, not the verdict). A script that cannot run
  at all (the shell's own message, such as a syntax error) is shown as the result instead of an empty checklist.
- **Ping:** figures (sent, received, loss, fastest, average, slowest, jitter) that update while it runs, one bar per ping
  (height is the round-trip time, a lost ping is a red marker: busybox prints nothing for a lost packet, so a gap in the
  sequence numbers is the sign of it), and a plain sentence for total loss, partial loss and a name that does not resolve.
- **Traceroute:** one row per hop as it arrives, with the routers that answered (a hop answered by two routers lists
  both), each probe's round-trip time (`*` for a lost probe), the average with a bar, silent hops marked "no reply", the
  destination highlighted, and a note when it was not reached within the hop limit. "Host names" can be switched to "look
  up names": the tool then runs without `-n` and prints `name (address)` for each router, shown as the name with the
  address beneath it; a router with no reverse record is printed as `address (address)` and shows just the address. The
  default is addresses only, because every lookup waits for the resolver and a hop without a reverse record can be slow.
- **DNS lookup:** how it went (the number of answers, NXDOMAIN, SERVFAIL, REFUSED, timeout, or no answer), the server that
  answered, and the tool's own output. The tool is the first of `dig`, `kdig`, `drill` and `nslookup` that the router has;
  busybox `nslookup` cannot show MX, TXT, NS, CNAME, SOA, SRV or CAA records in full (it prints "mail exchanger = 0" with no
  host), so the page says so when only nslookup exists and one of those types is chosen.
- **DNS compare:** asks the same question of up to six servers in turn: the router's own resolver, the upstream resolvers
  the router was given (read from `resolv.conf.auto`, loopback left out), Cloudflare, Google and Quad9, and one more of
  your choice. A row per server shows the result, the addresses, whether the resolver validated the answer with DNSSEC (the
  AD flag), the time the tool reports and the fastest server. Differing answers are highlighted, with the note that a
  CDN gives each resolver its own, correct set; a server that does not answer shows "No reply".
- **TLS certificate:** connects to a host and port (optionally with another server name, or after STARTTLS for SMTP, IMAP,
  POP3 and FTP) and shows the session (protocol, cipher, key exchange) and the certificates exactly as the server sent
  them, in the order sent: the router's own certificate authorities are never used to add or reorder any (`openssl
  s_client` lists the certificates received, not the chain it verified). Each shows subject, issuer, key and signature
  algorithm, validity with the days left, names, certificate authority flag, serial, SHA-256 fingerprint, and the PEM text
  with a copy button. Findings say whether the chain is trusted by the router's CA store, and judge the chain the server
  sent on its own: a server that sends only its own certificate, a gap or wrong order (a certificate that is not the
  issuer of the one before it), or a chain in order. A dashed marker shows where the issuer is missing; when the router
  trusts such a chain only because its CA store makes up for the missing certificate, the finding says so. Further findings
  say whether the certificate covers the name or address asked for (wildcards match
  one label), whether it is expired, not yet valid or ends within 14 days, a weak RSA key or a SHA-1 or MD5 signature, a
  protocol older than TLS 1.2, and why a connection failed (refused, timed out, name not found, or a server that hung up
  without sending a certificate).
- **Wake-on-LAN:** sends one magic packet (six `ff` bytes, then the MAC sixteen times) with `flab.diag wake`, which is not a job:
  it answers at once. The host is chosen from a list of the hosts the router knows (static DHCP hosts, odhcpd and dnsmasq
  leases, `/etc/ethers` and the ARP table; the status marks static DHCP hosts `reserved`): the reservations come first, then
  the hosts only seen on the network, each shown as name, address and MAC. *Another MAC address…* brings up a text field, which
  is the only control when the router knows no host. The interface is the one the host was last seen on, or
  `br-lan`, unless chosen. The packet goes out as a raw Ethernet frame with `etherwake` when the router has it, otherwise as a UDP
  broadcast to port 9 through `socat`; the tool is not offered when neither exists. The result names the host, the interface and the
  method, says the router cannot know whether the host woke up, and offers a ping of the host's address. The MAC is validated as six
  hex pairs and the interface must be a safe name of an existing device before either reaches a command. The permission is its own
  (`wake` under `write`).
- **From the Routing page:** a forwarded answer of the next-hop lookup offers Ping and Traceroute buttons that open the
  Toolbox with the destination filled in and start the job.
- **Jobs:** each run is a job. `flab.diag start` returns at once with a job id and `read` returns the output so far, which
  the page asks for every half second until the job ends; `stop` ends it. Nothing blocks rpcd, so the rest of the UI keeps
  working during a 60 second traceroute. The job and the form live in the page state: leaving the page stops the reading
  (the job keeps running on the router until it ends or its time limit), and coming back resumes it. The page does not
  poll (it re-reads what the router has once a minute, and not while the form has focus); Refresh redraws it and the job
  carries on.

`flab.diag` runs the tools detached (`timeout -k 2 <limit> <tool> ... >out 2>&1 &`, with the exit code written to a file)
under `/tmp/flab-diag/<id>/`: ping may run 25 seconds, traceroute 60, a DNS lookup 15, a certificate check 25, a comparison
60 and the connectivity check 75. The check, the comparison and the certificate check are small shell scripts (`job.sh`,
written with LF line endings only, because BusyBox sh rejects a carriage return) that print their output in blocks
(`### BEGIN <step> <uptime> <detail>` … `### END <exit code> <uptime>`), which the page
splits and reads; a block without an END line is still running. Every command in a script runs under its own `timeout`, and
a TERM sent to the script (Stop) ends the command at once. At most three jobs run at once,
twelve directories are kept, and a finished job is removed after ten minutes. Everything that reaches the shell is
validated: the tool, the record type and the STARTTLS protocol come from allow-lists, the host, the server name and the DNS
servers are made of letters, digits and `. : _ -` and do not start with `-` (they could be taken for an option), the port is
clamped to 1 to 65535, a comparison takes one to six servers that are each such a name (or `router`), the source is such
an address or an interface name,
the numbers are clamped to their ranges (a literal 0 is a number, not "absent"), the name-lookup switch must be a real
boolean, the argument list is built from those values
only, the job id is generated from `/dev/urandom` and checked as exactly twelve hex digits whenever it comes back, and `stop`
only kills a process whose name is one of the tools or the shell running one of its own `job.sh` scripts (so a recycled pid
is never hit). The ACL fragment
`rpcd/acl.d/flab-diag.json` grants `status` and `read` (read) and `start`, `stop` and `wake` (write).

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
Shows and edits odhcpd, the router's DHCPv6 and router advertisement (RA) server and, when it is the main server,
its DHCPv4 server too; it is configured in
`/etc/config/dhcp`. It refreshes every 10 s and reads through the ubus `dhcp` object (`ipv4leases`,
`ipv6leases`, `ipv6ra`), `network.interface dump` (which device belongs to which interface and its subnet),
`service list odhcpd` and `service list dnsmasq` and rpcd's `uci` object; it needs no plugin, only the ACL fragment
`rpcd/acl.d/flab-dhcp.json`. Leases are keyed by device (`br-lan`) in the ubus replies and shown under their
logical interface (`lan`). Top to bottom the page shows the tiles, then the settings (daemon, pools), then the
advertised prefixes, the leases and last the reservations.
- **Who serves DHCPv4** is detected: odhcpd when `odhcpd.maindhcp` is on, otherwise dnsmasq when its procd service
  runs (the usual split of dnsmasq for IPv4 and an IPv6-only odhcpd). In the dnsmasq case odhcpd has no
  `ipv4leases`, so the page reads dnsmasq's lease file (the `leasefile` option of `config dnsmasq`, default
  `/tmp/dhcp.leases`, through rpcd's `file` object, which the ACL fragment limits to `/tmp/*.leases`) and parses its
  `expiry MAC address hostname client-id` lines. A lease gets its interface from the subnet it falls in, counts as
  reserved when a reservation has its MAC or address, and shows the time left (0 means it never expires; the time
  is counted with the browser's clock). The tiles and the leases card say "from dnsmasq"; a lease file that cannot
  be read is reported instead of being shown as no leases.
- **Tiles**: whether odhcpd runs (and who serves DHCPv4), DHCPv4 leases (reserved and dynamic), DHCPv6 leases,
  reservations (how many hold a lease now).
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

### DNS (route `#dns`)
The state of the router's DNS resolver and its settings. It shows what the resolver does and how it is configured, and lets
you change the resolver's **single-valued options** (a yes/no option, a choice, a number, a name) in `/etc/config/unbound` or
`/etc/config/dhcp`, and its **zones** (Unbound's `config zone` blocks, dnsmasq's `server` entries: add, edit, remove, in a dialog);
lists of options are still read only (they are edited in the file for now). It
understands both engines, **Unbound** (read through `unbound-control`, which needs `option unbound_control '1'` in
`/etc/config/unbound`) and **dnsmasq** (read through the ubus object `dnsmasq metrics` and UCI), and every mix: Unbound
running, dnsmasq running, both (one of them on another port, for instance dnsmasq on 5353 behind Unbound; both are
reported and the one on port 53 is the engine the page describes), none running (a finding) and installed but stopped
(the configured engine is still described from its configuration). One call, `flab.dns status`, every 10 s; the page
pauses while a text box has the focus. Top to bottom:
- **Tiles**: Resolver (engine, version, uptime, and "dnsmasq also runs (port 5353)" when both run), Queries (since the resolver
  started, and the average per minute; for dnsmasq the forwarded plus the locally answered), the share answered without
  asking upstream (Unbound: cache hits against hits and misses; dnsmasq: its own answers against those and the forwarded
  ones, labeled "Answered locally"), Resolution time (Unbound's average and median; dnsmasq reports none, so the forwarded
  count is shown instead), Upstream servers (the default forwarders and the resolvers the WAN gave, each counted once;
  "Recursive" for an Unbound with no default forwarder) and DNSSEC (Validating, Off, or Not supported by this build).
- **Banner** (`model.findings`, worst first): no resolver installed or running, or installed but stopped (critical); a running
  engine with nothing on port 53; the other engine also running (information); DNSSEC off (a warning that says which option
  turns it on) and a dnsmasq build without DNSSEC (information only); rebind protection off; dnsmasq with no upstream at all
  (critical; an Unbound without forwarders is recursive, not broken); forwarding in clear text to a public address (information:
  every public `server=` of dnsmasq, and for Unbound a forward zone that is known not to use TLS); `unbound-control` not enabled
  or no dnsmasq metrics; SERVFAIL above 5% of the answers (needs extended statistics and at least 20 answers); bogus DNSSEC
  answers; rate-limited queries; dnsmasq with more than 2% of its forwarded queries unanswered (at least 20 forwarded); a cut list.
  **Clear text for Unbound**: `unbound-control list_forwards` does not say whether a forwarder uses TLS (the `+` flags are
  `i`, not DNSSEC-validated, and possibly others), so the plugin reads the `forward-tls-upstream` setting of each `forward-zone`
  clause of Unbound's generated configuration; a zone that is not found there is "unknown" and never accused.
- **Configuration** (full width, on top): every option the page knows, in collapsible areas with the same chevron as the folding
  cards of the DHCP page (right when folded, down when open; every area starts folded, and one the user opens stays open across
  the redraws). The header says the engine, the config file and how many addresses and ports it listens on.
  **General** comes first: the service and its monitoring first (enabled, remote control, statistics, log verbosity; for dnsmasq query
  logging), then *Listening on*: one chip per address and port with its protocols (from `netstat -lntup`, only the resolvers'
  sockets; Unbound's loopback control port 8953 and dnsmasq's DHCP socket are left out), where `0.0.0.0` and `[::]` are marked
  "all addresses" and the engine is named when both run; then listening and interfaces (port, LAN and WAN interfaces, IP protocols,
  EDNS size, DNS64; for dnsmasq the port, interfaces and upstream servers). Without a resolver the card is only *Listening on*.
  **Security and privacy** is second: who may ask and the rate limit, rebind protection, query privacy and DNSSEC.
  For Unbound it also shows, read only and folded, the domains exempt from rebind protection (`private-domain:`): the ones UCI
  generates for the local names (the local domain and the router's host name) and those listed in `/etc/unbound/unbound_srv.conf` (on the main router the Azure
  private-endpoint names). There is no UCI option for that list, so it is changed in the file; the plugin reports it as
  `private_domains` (`name`, `source` `uci` or `file`).
  The rest follow, folded: Local names and DHCP and Performance and cache (dnsmasq: Local names, Cache, DHCP). Each header gives
  the number of options and, for General and Security and privacy, a line about how they are set (port, interfaces, remote
  control, statistics; DNSSEC, rebind protection, who may ask, rate limit), so a folded area still says something. An "Other
  options" area holds options of the section the page has no description for. The options are described as data in `dns/schema.js`, in the format
  of `core/fields.js`, and drawn with the same controls as the System settings and DHCP pages (`core/forms.js`):
  a checkbox for a yes/no option, a drop-down for a fixed set of values (rebind protection,
  remote control, local domain type, DHCP server linked, IP protocols, recursion, resource profile, log verbosity, the
  router-name levels; the values and defaults are from the OpenWrt Unbound package's README and the dnsmasq manual), a number
  input with its range for a number, a text box for a name and a list for several values. An option that is not set shows its
  default (a placeholder, or "Default (…)" in a drop-down, or the default state of a checkbox).
  **Changing the options**: every described option of a single value can be edited when the login may write (`uci set`); lists
  and options the page has no description for stay disabled. An edit shows the review banner of the command bar (as on the System
  settings and DHCP pages: how many changes and which, *Details* with each one from → to, *Discard edits*, *Save and apply*),
  plus warnings for risky changes (switching off the control channel this page reads, another port, no longer local-only, no
  rebind protection, no DNSSEC, stopping Unbound, manual configuration; for dnsmasq DNSSEC in a build without it, port 0). A bad
  number is an error that blocks the save, marks the control and opens the folded area it is in. Saving stages the edits,
  applies them with the 30 second rollback countdown, reads `flab.dns status` back (changes held, and the resolver still runs;
  it gets a few seconds to restart) and confirms; otherwise the router puts the previous settings back, nothing stays staged
  and the edits stay in the form. Only what changed is written, to the `unbound` section of `/etc/config/unbound` or the dnsmasq
  section of `/etc/config/dhcp` (`flab.dns` reports it as `config_section`): a boolean as `1` or `0`, an emptied option is deleted.
  The model for all of this is `dns/edit.js` (pure and unit-tested); `core/editpage.js` takes the config name as a function
  because it depends on the engine. A login without the `uci` write methods sees the settings read only, with a note. Changes
  already staged in the session are reported and can be discarded first. Without a resolver the card is only *Listening on*.
- **Zones**: a card that is folded when the page opens (click its header; the chevron points right when folded and down when
  open, and the choice survives the redraws). It shows what UCI holds, as UCI holds it: a zone is one **block**, not one domain.
  For Unbound a zone is a `config zone` section of `/etc/config/unbound`, as described in the OpenWrt Unbound README
  (`net/unbound/files/README.md`, "config zone"): a `zone_type` (`forward_zone`, `stub_zone` or `auth_zone`), a list of domains
  (`zone_name`), a list of servers and the settings of that type. One section can serve any number of domains with the same
  servers, so the main router has `fwd_azure` for 89 domains, `fwd_lab`, `fwd_flumini`, `fwd_vodafone`, the default forwarders
  `fwd_cloudflare` (and the disabled `fwd_google`) and the disabled authoritative zone `auth_icann`: 7 zones, not 93 rows.
  For dnsmasq a zone is one entry of the `server` list of its section in `/etc/config/dhcp`
  (`/a/b/address#port`, `/a/` answers locally, `/a/#` uses the default servers, a plain address is a default forwarder).
  At the top it shows *Resolvers from the WAN* (full width): the resolvers in
  `/tmp/resolv.conf.d/resolv.conf.auto` (loopback ones left out), each marked *in use* or *not used*, and a sentence that says why. dnsmasq
  asks them unless its `noresolv` is set. Unbound asks them only through a forward zone with `resolv_conf '1'`, so they count as
  used when they are among the servers of the forwarders in force (the zones are named); otherwise the sentence says that Unbound
  uses its own forwarders, or recurses from the root servers, and how to change that. The header (engine, number of zones and of
  domains, and the verdict) repeats it, and the *Upstream servers* tile counts only the WAN resolvers that are used.
  Below that is one table, in the **order of the configuration** (the order of the sections in the file, which is the order the
  generator writes the clauses of `unbound.conf`; dnsmasq's entries in the order of the list), with the extension file after
  them, as it is appended last. A first column numbers the rows. The order does not decide which zone answers a query: Unbound and
  dnsmasq take the zone with the **longest matching domain**. Each row has the section name, the type, whether it is disabled (and
  *new*, *edited* or *removed* while a change is pending), the domains (the first six as chips, a button for the rest, and
  their count), the servers (a TLS or clear-text mark; the URL of an authoritative zone), the flags and where it is defined. The
  filter box matches names, types, domains, servers, flags and states, and redraws only the table, so typing is not interrupted.
  Flags: `i` is shown as "not DNSSEC-validated": it comes from `list domain_insecure` of the `unbound` section, which makes
  Unbound mark the zone `+i` in `list_forwards`; dnsmasq's `/zone/` (answered locally) and `/zone/#` (uses the default servers) are
  marked too. "Clear text" is worked out by the page: a forward zone without TLS (dnsmasq: always) whose server is a public
  address. Every label has a tooltip that says what it means, and a "What the labels mean" block in the header of the card (always
  visible, no expander) lists them (clear text, TLS, the flags, disabled and the pending states) for the engine in use. **Add zone**
  is on the toolbar, on the same line as the filter box and right next to it. Each zone says where it is defined: *UCI* (the section is named in the tooltip) or *unbound_ext.conf* (forward zones
  that only Unbound's extension file defines: read only, with a lock; the main router has none).
  **Add zone**, and **Edit** and **Remove** on every UCI zone, work on the draft of the page; nothing is written until the review
  banner at the top is saved (the same stage, apply with the 30 second rollback, read back, confirm as the options use).
  - The **dialog** (`core/modal.js`, on the native `<dialog>`: Escape and the close button leave it, the focus stays inside) has
    the fields of the zone's type (`ZONE_TYPES` in `dns/schema.js`): forward zones take domains, servers, TLS (use, certificate
    name, port), port, fall back, local resolver check and "also use the WAN resolvers"; stub zones domains, servers (addresses
    only), port, fall back, check and WAN; authoritative zones domains, servers (or a URL), the URL and fall back. The type is
    chosen for a new zone and fixed afterwards. A dnsmasq entry has domains, what dnsmasq does (forward, answer locally, use the
    default servers) and the server. The form works on a copy, checks as the user types (it shows the errors after the first
    edit) and cannot be accepted while it has one: domains and servers must be valid, a name may be taken by one enabled zone only
    (Unbound refuses two clauses for a name; the other zone is named), a stub zone needs addresses, an authoritative zone a server
    or a URL. A block whose lists the plugin had to cut, or of a type the page does not know, is read only.
  - **Remove** flags the row (dimmed, with a button that keeps it) and deletes the whole section when saved. A new zone gets a
    section named from its type and first domain (`fwd_corp_example`) and is written with `uci add` and only the settings that
    differ from the defaults. A changed zone writes only the changed options (`set`, and `delete` for an emptied one). dnsmasq
    writes the whole `server` list. The review list says what changed, for instance "fwd_azure: Domains: 86 domains → 85
    domains: −x"; warnings (not errors): a public server in clear text, TLS without a certificate name, a server on this router
    itself, and the last default forwarder going away.
  - After a save the page reads the status again and checks that the blocks hold what was asked, and that Unbound lists the domains
    it should forward (it may take a few seconds to restart); a resolver that stops, or a change that was not kept, is rolled back
    and the edit stays in the banner.
- **Activity** (full width, folded when the page opens like Zones; the header says how long ago the counters started): the engine's counters with a share bar where one makes sense, and, for Unbound with extended statistics, the answer
  codes. A counter the engine does not report (Unbound's extended ones when `extended_stats` is off) is left out, never shown as
  zero, and the card says how to turn them on.

#### The plugin
`flab.dns` itself is read-only (it never writes); the ACL fragment (`rpcd/acl.d/flab-dns.json`) grants its `status` method and, for
the option editing, rpcd's `uci` methods (`get`, `changes` under `read`; `set`, `add`, `delete`, `revert`, `apply`, `confirm`,
`rollback` under `write`) on the `unbound` and `dhcp` configs only: no generic `file` or exec grant, no other config. `status` takes no arguments: whatever a request carries is ignored, and every command the plugin runs
is a fixed string (a test reads the source and fails if a `run()` call takes a template or a variable). A command that fails or is
missing leaves its part null and adds a warning; it never fails the call, and the whole call is a handful of small commands.
- `ok`, `generated`; `engine` (`unbound`, `dnsmasq` or null: the running engine that listens on port 53, else any running one,
  Unbound first), `configured` (the engine described when none runs: the installed one, Unbound only when it is enabled in UCI or
  dnsmasq is absent); `engines.unbound` and `engines.dnsmasq` with `installed`, `running`, `pid` (procd's, else `pidof`), `version`,
  `uptime`, `port`, `stats` and, for Unbound, `control` (whether `unbound-control` answered).
- `version`, `uptime` (seconds: Unbound's own, or for dnsmasq the process age from `/proc/<pid>/stat` field 22 and `/proc/uptime`),
  `listeners` (`addr`, `port`, `proto`, `engine`; unique, at most 50), `stats`, `config` (the whitelisted UCI options that are set; a
  list stays a list; every option of `dns/schema.js` and no other, which a test checks), `config_section` (`config` and `name` of the UCI section that holds them, so the page can write them; null without one), `defaults` (what the engine does for an option that is not set, only where certain), `forwards` (`zone`,
  `servers`, `flags`, `tls`, `source`, `section`; the default zone first, at most 500; zones lowercase without a trailing dot;
  `source` is `uci` for a forwarder that UCI defines (an Unbound zone section, named in `section`, or a dnsmasq `server` entry) and
  `file` for one that only Unbound's extension file defines), `forward_uci` (the zones that can be changed through UCI: for
    Unbound every `config zone` section in the order of the file, of any `zone_type`, enabled or not, as `section`, `type`, `enabled`,
    `zones`, `servers` and `options` (`tls_upstream`, `tls_index`, `tls_port`, `port`, `fallback`, `dns_assist`, `resolv_conf`,
    `url_dir`), plus `cut: true` when its lists were longer than the plugin reads (500 domains, 50 servers), which makes the page treat
    it as read only; for dnsmasq the `server` entries as written, `index` and `value`), `upstream`,
  `upstream_used` (dnsmasq: not `noresolv`; null for Unbound, where the page checks whether the WAN resolvers are among the servers of the forwarders in force), `local_names` (Unbound: the distinct names of `list_local_data` without
  the reverse ones; dnsmasq: the names of the host files and named leases), `dnssec` (`supported`, `enabled`), `truncated`
  (`forwards`, `listeners`, `private_domains`, and `forward_uci` for a dnsmasq list that was cut) and `warnings`.
- `stats` for Unbound: `queries`, `cache_hits`, `cache_misses`, `prefetch`, `expired`, `ratelimited`, `timed_out`, `recursion_avg_ms`,
  `recursion_median_ms`, `rcodes`, `secure`, `bogus`, `unwanted_queries`, `unwanted_replies`, `cache_msgs`, `cache_rrsets`,
  `cache_bytes`, `since`, from the `total.*` lines of `stats_noreset`; whatever extended statistics would add is null when it is
  off. For dnsmasq: `forwarded`, `local_answered`, `auth_answered`, `stale_answered`, `unanswered`, `cache_inserted`,
  `cache_live_freed`, `cache_size` (the configured one) and `since`. `dnssec.enabled` for Unbound is whether the `validator` module is
  loaded; for dnsmasq the `dnssec` option, and `supported` is whether the build's compile options say `DNSSEC` (not `no-DNSSEC`).

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
- **Controls**: checkboxes show the value, or OpenWrt's default when the option is absent. An empty text control
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

The suites below are driven by `run.ps1` scripts that never change the router's configuration or touch a service. The BGP, IPsec, Routing and
network suites share one mechanism (the "Common mechanism" below): the repository's plugins run **on the router**
against saved fixtures (`FLAB_FIXTURES`, with `ucode -L` so the uploaded libraries win over the deployed ones), and
an optional browser pass opens the deployed UI in Edge through `playwright-core` (installed into a temporary
folder) with the plugin calls intercepted and answered with the scenario JSON. The Settings and DHCP suites have no
plugin: they unit-test their models and, with `-Browser`, drive the page against a mock of rpcd's `uci` object.

| Suite | Command | Covers |
|---|---|---|
| BGP | `pwsh -File flab-ui\tests\bgp\run.ps1 [-Browser]` | `flab.bgp` parser and findings, the BGP tab of the Routing page |
| Routing | `pwsh -File flab-ui\tests\routing\run.ps1 [-Browser]` | The Routing model (addresses, tables, findings, filters, lookup meaning, rule origins); `flab.routing` against a captured and a synthetic router (every route and rule syntax, every lookup answer, refused input); the Routes tab, the lookup and the BGP tab against mocked replies |
| Toolbox | `pwsh -File flab-ui\tests\toolbox\run.ps1 [-Browser] [-KeepWork]` | The Toolbox model (request checks, the parsers of ping, traceroute, DNS, comparison and certificate output, the connectivity check's verdicts, MAC handling); `flab.diag` running real jobs on the router (streaming, offsets, stop, DNS, traceroute, the router's own certificate, a comparison, a whole connectivity check, a Wake-on-LAN packet on loopback, every allowed option, 56 refused tool requests and 18 refused wake requests with an injection canary, job-id traversal, the three-job cap, CRLF source); the page against a scripted job engine |
| Traffic | `pwsh -File flab-ui\tests\traffic\run.ps1 [-Browser]` | The Traffic model (interfaces, WAN, totals, findings, endpoints, NAT, states, merging hosts by MAC, filtering and sorting, protocol rows); `flab.traffic` against a captured and several synthetic routers (every protocol, TCP state, NAT form and IPv6 spelling, a 60000-entry table, nlbwmon periods, no nlbw, no conntrack, no accounting) checked against an independent reference, and every refused argument; the Live, Connections and Usage tabs against mocked replies |
| IPsec | `pwsh -File flab-ui\tests\ipsec\run.ps1 [-Browser]` | `flab.ipsec`, IPsec page, throughput history |
| Network | `pwsh -File flab-ui\tests\network\run.ps1 [-Browser]` | `flab.network`, `flab.radio`, `flab.mesh`, `flab.wireguard`, `flab.firewall`, `flab.logs`; Wired network, Bridges, Devices and Interfaces, Wi-Fi, Mesh, WireGuard, Firewall and Logs pages; navigation order; unit tests of the shared helpers (including the session, `uci` and `applyChange` layer) |
| Settings | `pwsh -File flab-ui\tests\settings\run.ps1 [-Browser]` | System settings model, option table and zone table; the whole editing flow against a mock router |
| DHCP | `pwsh -File flab-ui\tests\dhcp\run.ps1 [-Browser]` | DHCP model (address helpers, reading config and leases, validation, change plan); the page against the router's own data, then the whole editing flow against a mock router |
| DNS | `pwsh -File flab-ui\tests\dns\run.ps1 [-Router ...] [-Url ...] [-Browser]` | The DNS model (tiles, findings, activity, options) and the zones (Unbound's blocks of every type and dnsmasq's entries: drafts, order, changes, validation, the UCI operations, the checks after a save); `flab.dns` against a captured and several synthetic routers (Unbound with and without extended statistics or `unbound-control`, dnsmasq, both, stopped, none, cut lists) and a call with shell metacharacters as arguments; the page against mocked replies, including adding, editing, removing and saving zones |
| Wi-Fi | `pwsh -File flab-ui\tests\wifi\run.ps1 [-Browser]` | Wi-Fi channel model (blocks of channels, errors and warnings, change plan); the radio cards and pickers against the router's own data, then the whole channel-change flow against a mock router |
| Services | `pwsh -File flab-ui\tests\services\run.ps1 [-Browser]` | Services model; `flab.services` against fixtures (nothing is executed) and a read-only `list` on the router; the page against the router's own services, then the whole start, stop and restart flow against a mock |

`-Browser` needs the UI deployed (`deploy.ps1 -Action Deploy`) and signs in with a temporary rpcd session that
`tests/TestSession.ps1` creates over ssh, grants what the ACL fragments grant, and destroys afterwards, so no
password is needed. Every suite removes its local temp folder when it finishes, and the BGP, IPsec, Routing and network
suites also remove their `/tmp/flab-*-test` folder on the router.

### Common mechanism (BGP, IPsec, Routing and network suites)

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
it). The browser pass adds peer removed, peer added and eight peers; it opens the BGP tab of the Routing page.

### Routing scenarios
`real` (what the router under test reports, checked for invariants only), `rich` (synthetic and deterministic: every
route and rule syntax the parser handles, an `/etc/config/network` with rules and a planted key that must never
appear in the output, a running charon) and `noip` (the tool printed nothing). The fourteen lookup cases cover a
forwarded packet, ECMP, local and broadcast addresses, a blackhole, an unreachable and a missing route, a lookup with a
source and an arrival interface for IPv4 and IPv6, an answer from a named table, mixed address families, and three
refused inputs (shell metacharacters in the destination, the source and the interface name; they have no fixture, so
a command that ran would show up as an error). Unlike the BGP plugin, `flab.routing` uses the shared fixture seam
(`FLAB_FIXTURES`, file names derived from the command line). The browser pass answers `flab.routing`, `flab.bgp` and the
interface dump from the scenario output and drives the Routes tab, the lookup (including the failover and the polling
pause, and its Ping and Traceroute buttons into the Toolbox, which are answered by a mock so nothing runs), the table and
rule cards, the BGP tab and the cases without BIRD, without `ip` and with a long route list.

### Toolbox suite
`pwsh -File flab-ui\tests\toolbox\run.ps1 [-Browser] [-KeepWork]`. `samples.mjs` holds the output busybox ping and traceroute and
the DNS tools printed on a router (a clean ping, 100% loss, a lost packet, a bad host name, traceroutes with silent hops and
with IPv6 hops answered by two routers, nslookup, kdig and drill answers and NXDOMAIN) and `samples-tools.mjs` the
output of the richer tools (a certificate check against the router's own HTTPS port, example.com, and the expired,
self-signed and hung-up cases of badssl.com, a refused port, a DNS comparison with a silent server, and a connectivity
check), shared by the unit test (`model.test.mjs`: the request a form may build, the parsers, the check's verdicts, a
certificate's findings) and the browser test. `flab.diag` is tested for real, not
against fixtures, because starting, reading, offsets and stopping are what it does: `run.ps1` runs the plugin with CRLF line
endings, as a Windows checkout deploys it, starts pings, a traceroute
and DNS lookups against 127.0.0.1 and localhost on the router, reads them while they run and after, reads from the end and
from an offset, stops one and checks that no process is left, starts every allowed option and compares the command line,
checks the router's own HTTPS certificate (the fingerprints, serials and dates it printed are compared with what Node
computes from the PEM text in the same output), a STARTTLS run against a closed port, a comparison of the router
against 127.0.0.1, and a complete connectivity check (whose script must carry no carriage return; a second one is stopped
half way, to see that a script job ends and leaves no ping or openssl behind),
sends the 56 lines of `refusals.txt` (shell metacharacters, leading `-`, out-of-range and non-numeric numbers, bad
sources, servers, ports, server names, protocols and types; several would create a canary file if a command ran) and checks that all were refused, no job
appeared and the canary does not exist, tries six job ids that are not the plugin's own (paths, wrong length, empty) on
`read` and `stop`, sends a Wake-on-LAN packet out of the loopback device (where nothing hears it) and the 18 lines of
`wake-refusals.txt` (a bad MAC, injections in the MAC and the interface, an interface that does not exist, wrong types), and starts four jobs to see the fourth refused. `live.mjs` answers `flab.diag` from a scripted job
engine (output revealed piece by piece, an endless ping, a refused start, a script that cannot run; the browser clock is held
at the day the samples were captured so the days left on a certificate do not drift) and drives the page: the navigation
entry above Logs, the form's checks, a ping
read while it runs and after, loss, no reply and a bad host, the options sent, stopping, traceroute (partial, not
reached, IPv6), DNS (answers, NXDOMAIN, the nslookup note), the connectivity check (a healthy router, a broken resolver, a dead
next hop, a script that fails), the comparison (the choices offered, rows arriving, DNSSEC, the fastest, a silent server), the certificate check (a good chain, a server that sends only its own certificate, a gap in the chain, the
PEM copy, expired, self-signed, hung up, refused, STARTTLS, a router without openssl), Wake-on-LAN (the host list with reservations first, a typed MAC, a bad MAC, a normalized
MAC, a chosen interface, a host without an address, a refusal from the router, etherwake and socat, the Ping button, a router with
neither tool, a login without the wake permission), leaving the page and coming back, a redraw
in the middle of a job, a login that
may not run diagnostics, and the dark theme. `-KeepWork` keeps the temporary folder so the browser test can be repeated.

### Traffic scenarios
`real` (what the router under test reports, replayed from a read-only capture of its connection table, netfilter numbers, DHCP and
hosts data and `nlbw` output, checked for invariants only: the counts add up, entries are sorted, addresses are canonical, totals are the
sums of the rows), `rich` (synthetic and deterministic: TCP in every state, UDP, ICMP and ICMPv6, GRE and an unknown protocol,
masquerade, a port forward with a changed port, an IPv6 translation, offloaded flows without a timeout, entries without counters, an
unreplied DHCPv6 request, every IPv6 compression case (a single zero group, two equal runs, the all-zero address), one heavy host
with ten unanswered connections, a garbage line, names from every source, and nlbwmon with three periods), `big` (60000 entries,
so the 20000-line cap and the speed show, and 3500 usage rows against the 3000-row cap), `noct` (no connection tracking), `noacct`
(`nf_conntrack_acct=0`, no counters), `nonlbw` and `stopped` (nlbw missing, nlbwmon not running), and `inflated` (nlbwmon counters of about
one byte per packet, as the main router's reported them). The suite pins today to 2026-11-12 (`FLAB_TRAFFIC_TODAY`), and `noct` and
`noacct` carry a `database_interval` of `2026-10-15/14` and `-2`, so the accounting window is checked under all three kinds of interval. `mkfx.mjs` writes the fixtures
(`files.json` for procfs and `/tmp`, one text file per command, one JSON file per ubus call, as `rpcd/lib/flab/util.uc` replays them) and an
independent JavaScript reference that computes what each connections call must return (the filtered, sorted and cut entries, the
counts and the top lists); `assert.mjs` compares the plugin's output with it entry by entry, and also checks the plugin source and the ACL.
The calls cover every sort, protocol and scope, name, IPv6 and port filters, translated tuples, limits and a call without arguments,
and 25 connections and 14 usage requests that must be refused (shell metacharacters, newline, subshell, wrong types, 65 characters, limits
0 and 2001, `age`, an unlisted period, a group that is not in the allow-list): each comes back as `{ ok: false }` with its reason and
no data. A call with a 50 ms time budget shows that a cut table is still the first lines only, sorted and counted. The browser pass
(`live.mjs`) answers `flab.network`, the interface dump and `flab.traffic` from the scenario outputs (the network's counters grow on
every poll), and drives the Live tab (WAN, totals, busiest interface, ordering, dimmed rows, findings, a long list, Pause, no plugin), the
Connections tab (tiles, every kind of entry, the top lists and their click-through, the filter with its debounce, the protocol, scope,
order and row selectors, invalid filters that are not sent, findings, no counters, no tracking, errors, 2000 rows, the polling cache),
the Usage tab (periods, the period note and its window under a monthly, a day-count and an end-of-month interval, tiles, merged hosts, names, filter, sort, protocols, another period, counters that cannot be right, 3000 hosts, an empty period, an error,
nlbwmon stopped and nlbw missing, which also removes the tab) and checks that the page wrote nothing and logged no error.

### DNS scenarios
`pwsh -File flab-ui\tests\dns\run.ps1 [-Router ...] [-Url ...] [-Browser]`. `real` records what the router under test reports (the capture is
read-only: `unbound-control` reads, the dnsmasq ubus metrics, UCI, procd's service list; on the main router it is Unbound, on the
GL-X3000 dnsmasq) and is checked for invariants only (shapes, uniqueness, no loopback WAN resolvers, counters that are null or
non-negative). The synthetic scenarios are hand-built, deterministic and run through the repository's plugin on the router with
`FLAB_FIXTURES`: `unbound` (extended statistics with answer codes, DNSSEC, cache sizes, ninety forward zones of which two carry
the `+i` flag, a clear-text public zone, a default zone over TLS known from the generated configuration, a WAN resolver, local
data), `unbound-basic` (extended statistics off as on the main router: the extended counters must be null, not zero),
`unbound-nocontrol` (`unbound-control` prints nothing: no statistics, a warning that says how to enable it, the version from
`unbound -V` and the forwarders from the generated configuration), `unbound-many` (520 zones and 60 sockets, to see both caps and the
`truncated` flags; two UCI zone sections, one of 89 domains that is read whole and one of 510 that is cut at 500 and so read only), `dnsmasq` (as the GL-X3000: ubus metrics, a server list with sixteen wildcard zones, a local DoH proxy and a
public server, a build without DNSSEC, the jail's pid pair, IPv6 sockets, host files and leases), `both` (dnsmasq on port 5353 behind
Unbound), `stopped` (both installed, nothing running) and `none`. A call with shell metacharacters in `host`, `zone` and `q` must give
the reply of a call without arguments, and `run.ps1` then checks that its canary file does not exist on the router. `assert.mjs` also
reads the plugin source (every `run()` call takes one fixed string, twelve different commands, nothing writes, `request.args` is never
used) and the ACL (`flab.dns: [status]` and the staged `uci` methods on the `unbound` and `dhcp` configs, nothing else). The browser pass (`live.mjs`) answers `flab.dns` from the scenario
outputs, `flab.diag` from a mock that records the request and runs nothing, and rpcd's `uci` object from a stateful mock (staged
edits, apply, confirm and rollback on the current scenario's section; any write to another config is refused and counted, and none
of it reaches the router), and drives every tile, finding and card for both
engines, both together, stopped and none; the Zones card (folded, numbered in the order of the configuration, one row per block with its
domains, filter, a focused filter that keeps the focus, read only blocks, a login that may not write); the
configuration with a default marked; the editing of the options (the review banner, the details, a save with its calls in order and
the values written, an emptied option deleted, warnings, an invalid number that opens its folded area, discarding, a resolver that
stops and is rolled back, an apply the router refuses, changes already staged, a login that may not write, dnsmasq's section); the
editing of the zones in the dialog (Unbound: edit a block, add a stub zone, a refused host name, a domain another zone takes, take one
domain out of 86, remove and keep, delete a section, the warning for the last default forwarder, a change that stops the resolver and
is rolled back, an authoritative zone and its URL; dnsmasq: edit an entry in place, add entries, remove one, the whole list written);
the WAN resolvers of the Zones card (in use, not used, partly); the
polling pause while a box has the focus; the type scale and weights; the dark theme; that nothing was written to another config and no console error
occurred. `-Router` and `-Url` default to the main router; the browser pass needs the UI deployed on the router it is given.

### IPsec scenarios
Captures `swanctl --list-conns|--list-sas|--stats|--version --raw`, `ip -s xfrm state` (key material is
redacted before it is copied; a canary key is planted), the xfrm interface addresses and their uci/netifd
data. Scenarios: `base`, `down`, `rekey` (two child SAs), `multi` (two IKE SAs under one name), `orphan` (SA
without connection, child SA without child config), `ipv6`, `daemondown`, `unconfigured` (charon stopped with an
empty swanctl config). `tests/ipsec/rates.test.mjs` unit
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
save, a change the router does not keep, a late confirmation, a stopped odhcpd, dnsmasq serving DHCPv4 (leases read
from its lease file, an unreadable file), a login without write access,
the dark theme and an expired session.

### Wi-Fi suite
Same shape as the DHCP suite. `model.test.mjs` covers the width of an htmode, the block a channel would occupy
(fixed blocks on 5 and 6 GHz; on 2.4 GHz the second half and the covered and overlapped channels, including
netifd's rule for the side), the blocks a radio is running on, the draft, the errors and warnings (not allowed, no
room for the width, DFS, mesh, auto), the operations and the read-back check; `network/uci.test.mjs` covers
`applyChange`. The browser pass (`live.mjs`) first shows the router's own radios with their pickers, with every uci
write blocked, then switches to a mock of the radio and Wi-Fi plugins and a stateful mock of `uci` and drives hover
previews (fitting and not fitting, 2.4 and 5 GHz, keyboard focus), choosing, undoing, Auto, the banner and its
warnings, a page that does not poll over a pending choice, a successful save (only the channels written, only the
radios' own sections read), a change the router does not keep, a radio that does not come back (rolled back),
leftovers from an earlier attempt, a login without write access, the dark theme and an expired session.

### Services suite
Never starts, stops or restarts a service: every control call is either answered by a fixture or by a mock.
- **Unit tests** (`model.test.mjs`, no router): merging the init scripts with procd's list (states, services
  without a script, a missing plugin), the filter, the summary, the buttons a row offers, the confirmation table
  (which services ask, the level, that `rpcd` says the session ends) and the outcome texts.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`; the calls and the expected command lines are in `cases.mjs`):
  `flab.services.uc` runs on the router with `FLAB_FIXTURES`, so it executes nothing: for each call it finds, in
  a fixture file named after the command line it builds, what that command would have printed. Scenarios `ok`
  (exit 0), `fail` (exit 1 with output), `timeout` (exit 124) and `noresult` (no exit code). The test checks the
  listing (sorted, boot state and position, junk names dropped, protected scripts), the waited calls, the calls
  that must run in the background, and 25 refused requests (protected scripts, an unknown service, names such as
  `../../bin/sh`, `dropbear; reboot`, `-h`, a name with a line break or longer than 64 characters, wrongly typed
  or missing arguments, actions `reload`, `restart; reboot`, `RESTART`): each has a fixture that would report
  success if its command were run, so a refused call that ran anyway shows up as `ok`. The harness refuses any
  call but `list` when no fixtures are set. `list` is also run once for real (it only reads) and compared with the
  router's `/etc/init.d` and `/etc/rc.d`.
- **Browser** (`live.mjs`): the page first lists the router's own services with any `control` call blocked and
  failing the test, then a mock of `service` and `flab.services` drives the buttons, the confirmation (warning and
  danger levels, Cancel sends nothing), buttons disabled while a call runs, success, a failing script with its
  output, an error from the router, stop and start without a question, a background restart, a login without
  permission, a missing plugin, the dark theme, a session that ends during a call, and `rpcd` restarted from the
  page (back to the sign-in screen).

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
