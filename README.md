# flab-ui

A lightweight, LuCI-free administration UI for OpenWrt, developed and tested on the GL.iNet GL-MT6000
(1 GB RAM). It is a static single-page app served by `uhttpd`, talking to the router through the
standard `ubus` JSON-RPC endpoint and a few small `rpcd` ucode plugins.

> **Hard rule: no LuCI components.** flab-ui is a replacement for LuCI, so it must never call
> `luci-rpc`, `luci.*` ubus objects or any LuCI library. Read data directly from `swanctl`, `netifd`,
> `procd`, `nft`, `wg`, sysfs, the kernel (`ip`, `iw`, `hostapd_cli`) and `uci`. rpcd's own `uci` object
> (staged edits, apply with rollback) is part of rpcd, not LuCI, and is what configuration changes use.

It is deployed to tmpfs for testing and removed again with one command; nothing is installed permanently. Like
LuCI, it signs in with the router's own `root` login and creates no login of its own. The pages that only
read the router are Overview, Mesh, IPsec VPN, Routing, Toolbox (which runs diagnostics and sends a Wake-on-LAN packet) and Logs. The others
edit its configuration through UCI: System settings (`/etc/config/system`), DHCP (`/etc/config/dhcp`, and the server DUID in `/etc/config/network`), DNS (`/etc/config/unbound`, or the dnsmasq section of `/etc/config/dhcp`), Dynamic DNS (`/etc/config/ddns`), Wi-Fi (the radios and wireless networks in `/etc/config/wireless`), Wired network (the VLAN sections of `/etc/config/network`), Devices and Interfaces, which holds the bridges (`/etc/config/network`), WireGuard (the WireGuard interfaces and peers in `/etc/config/network`), Firewall (`/etc/config/firewall`) and the Settings tab of Traffic (`/etc/config/nlbwmon`). The Services page starts, stops and restarts services. How configuration changes are made safely is described in
[Configuration changes](#configuration-changes) and how services are controlled under [Services](#services-route-services).

## Contents

1. [Architecture at a glance](#architecture-at-a-glance)
2. [Repository layout](#repository-layout)
3. [Frontend](#frontend)
4. [Backend (rpcd plugins)](#backend-rpcd-plugins)
5. [Security model](#security-model)
6. [Configuration changes](#configuration-changes)
7. [Deploy, test, clean up](#deploy-test-clean-up)
8. [OpenWrt package](#openwrt-package)
9. [License](#license)
10. [How to add a page](#how-to-add-a-page)
11. [Pages](#pages)
12. [Testing](#testing)
13. [Implementation notes](#implementation-notes)
14. [Conventions](#conventions)

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
  deploy.ps1                 Deploy / Cleanup / Sync script (PowerShell 7)
  tools/gen-zones.py         Regenerates pages/settings/zones.js from the IANA time zone database
  tools/router-lock.ps1      Reader-writer lock for sharing one test router between several people or agents (Mode Read or Write, -Suite)
  tests/                     bgp/, ddns/, dhcp/, dns/, fwedit/, ifedit/, ipsec/, network/ (network, Wi-Fi, mesh, WireGuard, firewall, logs, helpers), nlbwedit/, routing/, services/, settings/, toolbox/, traffic/, vlanedit/, wgedit/, wifi/, wifiedit/,
                             TestSession.ps1 (the temporary rpcd session the browser tests sign in with, and the Invoke-Native helper every run.ps1 uses)
  www/                       Static site, deployed to /tmp/flab and linked at /www/flab
    index.html               Shell page: loads vendor CSS, css/base.css and js/main.js
    vendor/bootstrap.min.css Bootstrap 5.3.3, vendored so the UI works offline
    css/
      base.css               Fluent tokens, app shell, shared component styles, sign-in screen
      <page>.css             Page-specific styles, loaded on first visit
      forms.css              Shared form, review-banner, dialog and folding-card styles (System settings, DHCP, DNS, Dynamic DNS and the other editing pages)
      netedit.css            Styles of the network editor's panels and wizard (Devices and Interfaces)
      board.css              The network board: lanes, cards, connectors, highlighting, the live bridge information
      drawer.css             The side panel of core/drawer.js
    js/
      main.js                Entry point: theme + start the app
      core/                  Framework-level modules shared by all pages
        app.js               Shell: nav pane, command bar, hash routing, refresh loop
        ubus.js              ubus JSON-RPC transport, session, AuthError, optional(), can()
        uci.js               The one wrapper for rpcd's `uci` object (staged edits, getByType(), order(), apply with rollback, applyChange())
        ops.js               stageOps(): turns a change plan (set / add / delete / order operations) into staged uci calls
        fields.js            Pure form-field model: option readers, value checks (IP, MAC, duration, ...), fieldError()
        forms.js             Form building blocks: legend, note, fieldRow() (a field with `secret` is a write-only password box; an enum's `blank` is the text of its empty choice), the sticky review banner (its countdown text follows the page's rollback seconds)
        editpage.js          createEditor(): the draft, banner, save/discard and notes every editing page shares; optional `timeoutS`, `settleMs` and `confirmSave` (a question before a risky change is applied)
        fold.js              Cards that fold down to their header: foldable(), chevron(), reveal() (opens what hides an error) (DHCP pools, Dynamic DNS)
        login.js             Sign-in screen (inline SVG and CSS only)
        dom.js               h() element builder (XSS-safe), byId()
        ui.js                Components: card, tile(s), table, badge, chip, kv, lifebar, meter, sparkline,
                             healthBanner, muted, mono, GRADE_KIND
        controls.js          Command-bar controls: search, select, pause, toggle, refresh
        format.js            Bytes, line rates, durations, numbers
        clipboard.js         copyText() and copyButton(): copy text with a button that confirms (Toolbox, certificates)
        modal.js             openDialog(): a Bootstrap-style modal (.modal, .modal-dialog, .modal-content, .modal-header with .btn-close, .modal-body, .modal-footer) on a native <dialog>; used by the DNS zone form, the cable test and the New network wizard
        drawer.js            openDrawer(): a side panel on the right edge (Bootstrap's offcanvas markup, not modal: the page stays visible and usable beside it; sticky header and footer, a scrolling body, Escape, a close button, closes when the route changes); used by Devices and Interfaces
        ip.js                parseAddress(): IPv4 and IPv6 addresses as BigInt values (Routing and BGP)
        rates.js             Rate tracker: turns cumulative counters into rates/ratios between polls
        icons.js             Inlined Bootstrap Icons path data, icon(name)
        theme.js             Follows the OS light/dark preference
      pages/
        index.js             Page registry and the page contract (read this first)
        overview/            index.js, cpu.js, temperatures.js
        network/             Wired network: index.js, shared.js, topology.js, tile.js, ports.js, diagnostics.js, cable.js (the cable test), vlans.js (VLAN matrices), vlanpage.js (the VLAN editor's wiring), vlanedit.js (the editable VLAN cards), vlanmodel.js (pure: the VLAN sections, tables, draft, validation, UCI operations, check after a save), util.js
        wifi/                index.js (clients, and the editor of the radios and wireless networks), radios.js (radio cards), editors.js (the
                             radio settings and the network forms), schema.js (the option tables), model.js (pure: draft, validation, UCI operations,
                             check after a save), channels.js (pure model of the channel change), picker.js (the channel picker); mesh interfaces are left to mesh/
        mesh/                index.js, node.js
        ipsec/               index.js, connection.js, daemon.js, names.js, rates.js
        wireguard/           index.js (page, tiles, the editor), iface.js (interface card, peers table, findings), edit.js (interface form, peer editor, key controls, confirmation), device.js (the add-a-device dialog), schema.js (option tables), model.js (pure: draft, validation, UCI plan, check after a save), addr.js (pure: address math), keys.js (pure: key checks, X25519)
        firewall/            index.js, model.js (pure zone matrix), matrix.js, zones.js, rules.js, util.js; the editor: schema.js (option tables), check.js (value checks), edit.js (reading and the draft), validate.js, plan.js (review list, UCI operations, check after a save), view.js (the draft laid over the live state), describe.js (plain words), itemdialog.js, controls.js, defaults.js (global settings), parts.js
        dhcp/                DHCP: index.js, schema.js (the options), model.js (pure), leases.js, reservations.js, pools.js (daemon and pool cards), boot6.js (network boot card)
        dns/                 DNS: index.js (page, state, the editing wiring), schema.js (the options and their areas, ZONE_FIELDS and ZONE_TYPES), edit.js (pure: draft, changes, problems, the UCI plan, the check after a save), zones.js (pure: the zone blocks of Unbound and the server entries of dnsmasq as a draft: items, changes, validation, plan, checks), model.js (pure: tiles, findings, activity, option areas), zonescard.js (the Zones card), zoneform.js (the dialog that adds or edits a zone), fold.js (the card that folds down to its header, used by Zones and Activity), cards.js (Configuration, Activity)
        ddns/                Dynamic DNS: index.js (page, tiles, the editing wiring), schema.js (the options and their groups), model.js (pure: reading the plugin's status, the draft, validation, the UCI plan, the check after a save, verdicts, intervals, log parsing), cards.js (service cards with status, actions and log; the global card)
        interfaces/          Devices and Interfaces (the network board): index.js (page, state, the drawer wiring), boardmodel.js (pure: lanes, items, edges, highlighting, findings, counts), board.js (the lanes, cards and connectors), livepanel.js (the read-only panels of a zone and of an item the page cannot edit), bridgelive.js (the live information of a bridge), panels.js (the editing panels), panelmodel.js (pure: protocol cards, essential options, device chooser, suggestions), panelparts.js and controls.js (parts the panels and the wizard share), wizard.js and wizardmodel.js (the New network wizard; the model is pure), editor.js (the draft, banner, confirmation), schema.js (option tables), model.js (pure: draft, validation, UCI plan, check after a save), checks.js (value checks)
        routing/             Routing: index.js (page, tabs, state), model.js (pure: addresses, tables, findings, filtering, lookup meaning),
                             lookup.js (next-hop lookup card), tables.js (tables, rules and route list cards)
          bgp/               The BGP tab: tab.js (composition), topology.js, peer.js, routes.js, announced.js, system.js, util.js
        toolbox/             Toolbox: index.js (page, openTool), diag.js (form, job polling, dispatch of the result views; Wake-on-LAN),
                             diagviews.js (ping, traceroute, DNS, check, comparison and certificate views), diagmodel.js (pure: request
                             checks, output parsing, the check's verdict), iperfmodel.js / iperfview.js (the iperf3 server),
                             dnstracemodel.js / dnstraceview.js (the DNS trace), pathmodel.js / pathview.js (mtr and AS data),
                             charts.js (SVG ping and throughput charts), tlsdiagram.js (certificate chain and expiry timeline)
        traffic/             Traffic: index.js (page, tabs, state, polling), model.js (pure: interfaces and totals, WAN, findings, entries, NAT,
                             merging hosts by MAC, protocol rows), live.js, connections.js, usage.js, settings.js (the Settings tab: cards and saving),
                             settings-schema.js (the nlbwmon option table), settings-model.js (pure: draft, validation, effects, UCI plan, check after a save)
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

`aliases` (exported next to `pages`) maps a route that was a page once to the page that replaced it (`bridges` → `interfaces`); `core/app.js` replaces the hash, so a bookmark keeps working.

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
  lookup answer's buttons use; `diag.js` is the form, job polling and the choice of result view, `diagviews.js`
  the ping, traceroute, DNS, check, comparison and certificate views, `diagmodel.js` the pure parts (the request a form may
  build, the parsers for the classic tools' output, the check's verdict), and the newer tools have a model and a view each
  (`iperfmodel.js`/`iperfview.js`, `dnstracemodel.js`/`dnstraceview.js`, `pathmodel.js`/`pathview.js`) plus `charts.js` and
  `tlsdiagram.js` for the pictures.
  The BGP tab is `bgp/`: `tab.js` composes the sections; `topology.js`, `peer.js`, `routes.js`,
  `announced.js` and `system.js` each export card builders that take the backend data; `util.js` holds the
  per-peer color helpers, AS-path chips and prefix sort key.
- **Pure models**: `firewall/model.js` (zone matrix) and `firewall/edit.js`, `validate.js`, `plan.js`, `view.js`, `check.js`, `describe.js` (the editor),
  `interfaces/boardmodel.js` (the network board), `interfaces/model.js`, `interfaces/checks.js`, `interfaces/panelmodel.js` and `interfaces/wizardmodel.js` (the network editor),
  `network/vlanmodel.js` (the VLAN editor), `wifi/model.js` and `wifi/channels.js`, `wireguard/model.js`, `wireguard/addr.js` and
  `wireguard/keys.js`, `traffic/settings-model.js`, `logs/entries.js` (log filtering and formatting), `settings/model.js` and `dhcp/model.js` (validation and the
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
| `flab.radio.uc` | `flab.radio` | `status`; `config` | `status`: uci wireless and network, ubus `network.wireless`, `hostapd.<if>`; `iw dev/phy info`, `iw survey dump`, `iw reg get`, `iwinfo <if> info`; sysfs counters. `config` (the editable wireless config): every option of the `wifi-device` and `wifi-iface` sections except secrets, which are only reported as set; `iwinfo <if> htmodelist/countrylist`, `hostapd -v<feature>` (what the installed hostapd can do; see [Wi-Fi](#wi-fi-route-wifi)) |
| `flab.mesh.uc` | `flab.mesh` | `status` | uci wireless (`wifi-iface mode=mesh`), ubus `network.wireless`; `iw dev/station dump`, `iw mpath dump`, `iw mpp dump`, `iw get mesh_param`; sysfs counters |
| `flab.wireguard.uc` | `flab.wireguard` | `status` | uci network (`proto wireguard` interfaces and `wireguard_<if>` peer sections: every option except the secret ones, which are only reported as set; the names of the named sections), uci firewall (zone), uci uhttpd and dropbear (the administration ports); `wg show <if> public-key/listen-port/peers/endpoints/allowed-ips/latest-handshakes/transfer/persistent-keepalive` (the single-field forms never print the private or pre-shared key); sysfs MTU and counters; `/lib/netifd/proto/wireguard.sh` (whether netifd has the protocol handler); `/proc/net/tcp` and `/proc/net/tcp6` (established connections to the router's web and SSH ports, see [WireGuard](#wireguard-route-wireguard)) |
| `flab.firewall.uc` | `flab.firewall` | `status` | uci firewall (defaults, zones, forwardings, `rule`, `redirect`, `nat`, `include`, `ipset`; every rule and port forward carries its section name), uci network (the interfaces and whether each is disabled), ubus `network.interface dump` (the router's addresses on each interface); `nft -j list ruleset` (per-rule hit counters matched through the `!fw4: <name>` comment, reject/drop chain counters per zone, the devices behind each zone, the zones that have an `input_<zone>` chain (`loaded_zones`), flowtable devices, base chain policies); procfs conntrack count and limit. A zone without a policy of its own reports the one of the defaults |
| `flab.network.uc` | `flab.network` | `status`; `config`; `cable_test` (`port`) | `config` (the editable part of the network config): uci network (the `interface` and `device` sections with every option except secrets, the first `globals` section as `globals` (`null` without one), the number of sections of each other type, and the `bridge-vlan` sections' device and VLAN). An option whose name says it is a secret (`password`, `passwd`, `pin`, `pincode`, anything containing `passw`, `secret`, `psk`, `key`, `token` or `credential`: a PPPoE or modem password, a SIM PIN, a WireGuard private or pre-shared key) is never returned, only whether it is set (`secrets`). `status`: ubus `network.device status` (netifd); sysfs `/sys/class/net/<if>/{carrier,bridge,brport}`; the bridge forwarding table `brforward`; `ethtool -i/-S`, `ethtool --show-eee` (EEE), `ethtool -m` (optical modules, only for ports that are optical cages), `/sys/class/mdio_bus`, `/proc/device-tree` (hardware and switch wiring), `/etc/board.json` (LAN/WAN roles, port order, swconfig switches); `swconfig list` / `dev <switch> help` / `dev <switch> show` (switches that are not DSA); `bridge vlan show` (when iproute2's `bridge` is installed) and uci network `bridge-vlan` sections (the VLAN tables); uci network (`tunlink`), uci firewall (zones, forwardings), uci dhcp (DHCP/RA service per interface); `logread` (error log lines). `cable_test` runs `timeout 30 ethtool --cable-test <port>` on one physical port after strict validation, only when asked (its ACL grant is under `write`; see [Wired network](#wired-network-route-network)) |
| `flab.diag.uc` | `flab.diag` | `status`, `start` (`tool`, `host`, options), `read` (`id`, `from`), `stop` (`id`), `wake` (`mac`, `iface`) | busybox `ping` and `traceroute`, `mtr --raw`, `iperf3 -s`, `kdig` for the DNS trace, the first of `dig`, `kdig`, `drill`, `nslookup`, and `openssl s_client` / `x509`, run detached under `timeout` with their output in `/tmp/flab-diag/<id>/out`; `ip route get` and `ip route show default` for the connectivity check; `etherwake` or `socat` for Wake-on-LAN, with the host list from uci dhcp hosts, `dhcp ipv4leases`, `/tmp/dhcp.leases`, `/etc/ethers` and `/proc/net/arp`; ubus `network.interface dump` and uci firewall for the iperf3 server's addresses and zones; `command -v` for the tools, `/sys/class/net` for the interface names, `/tmp/resolv.conf.d/resolv.conf.auto` for the upstream resolvers; every argument validated before a command line is built |
| `flab.ipsec.uc` | `flab.ipsec` | `status` | `swanctl --raw` (via `flab.vici`), `ip -s xfrm state`, `network.device`, uci network |
| `flab.bgp.uc` | `flab.bgp` | `status` | `birdc` (`show status`, `show protocols all`, `show route all`, `show route export <peer>`, `show memory`), `ip -4 route show proto bird` |
| `flab.routing.uc` | `flab.routing` | `status`, `lookup` (`dst`, `src`, `iif`) | `ip -4/-6 route show table all`, `ip -4/-6 rule show`, `/etc/iproute2/rt_tables`, `command -v birdc`, `pidof charon`, uci network (only the `rule` and `rule6` sections, and only their section name, family, priority and lookup table); `lookup` runs `ip route get` and `ip route get ... fibmatch` for a validated address, optional source address and interface name |
| `flab.traffic.uc` | `flab.traffic` | `status`; `connections` (`q`, `limit`, `sort`, `proto`, `scope`); `usage_periods`; `usage` (`period`, `group`); `nlbwmon_paths` (`dir`, `protocols`) | procfs `/proc/net/nf_conntrack` and `/proc/sys/net/netfilter/nf_conntrack_{count,max,acct}`; `command -v nlbw`, `pidof nlbwmon`, `nlbw -c list`, `nlbw -c json -g <group> [-t <period>]`; names from uci dhcp (`host` sections), `dhcp ipv4leases`/`ipv6leases` (ubus, odhcpd), `/tmp/dhcp.leases`, `/tmp/hosts/*`, `/etc/ethers`, `/proc/net/arp`, `ip -6 neigh show` (see [Traffic](#traffic-route-traffic)); for `nlbwmon_paths` the ucode functions `stat`, `lsdir`, `realpath` and `open` on the database directory and the protocol file, and `/proc/mounts` (never a shell) |
| `flab.dns.uc` | `flab.dns` | `status` (no arguments) | procd `service list` (ubus), `pidof unbound`/`pidof dnsmasq`, `command -v unbound`/`dnsmasq`, `netstat -lntup`, `unbound-control status`/`stats_noreset`/`list_forwards`/`list_local_data`, `unbound -V`, the generated `/var/lib/unbound/unbound.conf` and `unbound_ext.conf` (forward-zone clauses), `dnsmasq --version`, ubus `dnsmasq metrics`, uci unbound and uci dhcp (the `unbound` and `dnsmasq` sections), `/tmp/resolv.conf.d/resolv.conf.auto`, `/tmp/hosts/*`, `/tmp/dhcp.leases`, `/proc/<pid>/stat` and `/proc/uptime` (see [DNS](#dns-route-dns)) |
| `flab.sensors.uc` | `flab.sensors` | `status` | sysfs `/sys/class/thermal`, `/sys/class/hwmon` |
| `flab.system.uc` | `flab.system` | `cpu` | procfs `/proc/stat`, `/proc/loadavg`, `/proc/uptime` |
| `flab.ddns.uc` | `flab.ddns` | `status` (no arguments); `log` (`section`); `control` (`section`, `action` = `check` or `force`) | uci `ddns` and `network`, procd `service list` (the updater instances), ubus `network.interface dump`, the run files in `ddns_rundir` (`<service>.ip`, `.update`, `.nextcheck`, `.err`) and the logs in `ddns_logdir`, `/proc/uptime`, `/usr/share/ddns/{default,custom}/*.json` (the providers), `/usr/lib/ddns` (provider scripts), `/sys/class/net`, `ip addr`, `/etc/rc.d`; `control` runs `/etc/init.d/ddns stop` and `start` for one enabled service after strict validation (see [Dynamic DNS](#dynamic-dns-route-ddns)); passwords and tokens are never returned |
| `flab.logs.uc` | `flab.logs` | `read` (`lines`, `source`) | `logread -l N` (logd ring buffer), `dmesg -r`, `/proc/uptime`; entries are parsed and secret-looking values redacted |
| `flab.services.uc` | `flab.services` | `list`; `control` (`name`, `action`) | `/etc/init.d` (executable files) and `/etc/rc.d` (`S<NN><name>` = starts at boot), `netstat -lntup` and `/proc/sys/net/ipv4/ip_local_port_range` (the listening sockets) for `list`; `control` runs `/etc/init.d/<name> start\|stop\|restart\|enable\|disable` after strict validation (see [Services](#services-route-services)); its ACL fragment grants `list` under `read` and `control` under `write` |

The System settings and DHCP pages need no plugin of their own. Pages that edit a configuration through rpcd's own `uci` object need an ACL fragment that grants the `uci` methods on
the configs they touch (in `rpcd/acl.d/`; the page and plugin sections name them):

| Fragment | `uci` read (`get`, `changes`) and write (`set`, `add`, `delete`, `revert`, `apply`, `confirm`, `rollback`; `order` where noted) on |
|---|---|
| `flab-settings.json` | `system` |
| `flab-dhcp.json` | `dhcp` and `network` (the page reads and writes only the `globals` section of the latter, for the server DUID); also ubus `dhcp` methods and reading `/tmp/*.leases` through rpcd's `file` object for dnsmasq's lease file |
| `flab-dns.json` | `unbound` and `dhcp` |
| `flab-firewall.json` | `firewall` (with `order`) |
| `flab-traffic.json` | `nlbwmon` |
| `flab-vlan.json` | `network` (with `order`; the VLAN editor of the Wired network page) |
| `flab-network.json` | `network`: `changes` and the write methods only, no `get` (Devices and Interfaces, which reads the config through `flab.network config`) |
| `flab-radio.json` | `wireless`: `changes` and the write methods only, no `get` (the Wi-Fi page reads it through `flab.radio config`) |
| `flab-wireguard.json` | `network`: `changes` and the write methods only, no `get` (WireGuard reads it through `flab.wireguard status`) |
| `flab-ddns.json` | `ddns`: `changes` and the write methods only, no `get` (Dynamic DNS reads it through `flab.ddns status`) |

**Secrets.** A config that holds secrets is never read by the browser with `uci get` where the page can avoid it: `wireless` (Wi-Fi keys),
`network` (PPPoE passwords, WireGuard keys) and `ddns` (passwords and tokens) are read through the plugin of the page, which leaves
every secret out and reports only whether it is set, and the read-back after a save goes through the same plugin. Their password and key fields are
write-only: empty keeps the stored value, a typed value replaces it, and the review list shows "new value (hidden)" or nothing. The
configs a page reads with `uci get` itself (`system`, `dhcp`, `unbound`, `firewall`, `nlbwmon`) hold none. The VLAN editor reads the network config
with `uci get` filtered by section type (`bridge-vlan`, `device`, `switch`, `switch_vlan`, `switch_port`), never the whole config, and a test checks
that. rpcd cannot restrict `uci get` to section types, and root holds every fragment, so a root login can still call `uci get network` (through
`flab-dhcp.json` or `flab-vlan.json`); the pages never do.

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
    `wg show` forms that never print keys. The plugins that return an editable config (`flab.radio config`,
    `flab.network config`, `flab.wireguard status`, `flab.ddns status`) return every option except those whose name says
    it holds a secret, and report only that such an option is set.
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
  ubus calls and uci configs its page uses; each editing fragment grants `uci` write on the configs of its page only, for example `system` for the settings fragment and `nlbwmon` for the Traffic one), and the
  care the pages take: input is validated before it is staged, changes are applied with an automatic rollback,
  and nothing secret is forwarded or displayed (see [Backend rules](#backend-rules)).
- **Session.** The session id and the ACLs rpcd returned live in `sessionStorage` (this tab only, gone when it
  closes). The session expires after 900 s without use, and Sign out destroys it on the router.
- **Known exposure.** The editing pages list and edit the options of their configs (for example `/etc/config/system`) for anyone who can sign in as
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

System settings, DHCP, DNS, Dynamic DNS, Wi-Fi, Wired network (VLANs), Devices and Interfaces (which holds the bridges), WireGuard, Firewall and the Traffic settings change the router, and set the pattern every later editing page follows. The signed-in login (root) may write; a login that may not (`can('uci', 'set')` is false) gets the same
page with every control disabled and a note saying why.

**Flow** (all of it is rpcd's `uci` object, wrapped by `www/js/core/uci.js`; pages call `applyChange()`, not the
single steps):

1. **Stage.** `uci.set`, `uci.add`, `uci.delete` and `uci.order` (the sections of a config in a new order; the firewall rules use it) write into the session's staging area; the configuration on
   flash is untouched. rpcd keeps the staging area **per session**, so a second session never sees it.
   `uci.get` reads a whole config and `uci.getByType(config, type)` only the sections of one type, for a config that holds secrets elsewhere.
2. **Review.** `uci.changes()` lists what is staged and `uci.pending()` counts it; `uci.revert()` throws it
   away. `set` takes values as given (rpcd rejects `null`); to remove an option use `uci.delete(config,
   section, [option])`.
3. **Apply.** `uci.apply()` commits the staged changes, reloads the affected services (procd reload
   triggers, for example `system` and `sysntpd` on a `system` change) and starts a countdown
   (`APPLY_TIMEOUT_S`, 30 s; a page may set its own length through the editor's `timeoutS`, as Devices and Interfaces does with 90 s).
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
  page creates an editor with `createEditor()`, which also gives it `isPaused` and the notes above the form. The editor takes `timeoutS` (the
  countdown, which the review banner repeats), `settleMs` (how long to wait after the apply before verifying) and `confirmSave` (an async question asked before
  anything is applied; false cancels the save: the Firewall and Devices and Interfaces pages use it for a change that may cut the administrator off). A change plan
  (`core/ops.js`) is a list of `set`, `add`, `delete` and `order` operations; an `add` may carry an `id` that a later `order` uses for the section rpcd named.
- Validate input in the page before staging; `uci` itself has no schema. Show the effect of the edits (the
  review list) before saving, and disable Save while anything is invalid.
- Write only what changed, delete an emptied option instead of storing an empty string, and leave options the
  page does not know untouched.
- Do not poll over unsaved edits: the shell redraws the page on every poll, so `isPaused()` must return true
  while there is something to lose.
- Mirror a change made to the router's configuration into `build/MT6000/etc/config/` in this repository.

**Status.** `core/ubus.js` and `core/uci.js` (including `applyChange`) are unit-tested against a fake transport
(`tests/network/uci.test.mjs`); the suites of the editing pages (System settings, DHCP, DNS, Dynamic DNS, Wi-Fi, Wired network VLANs, Devices and Interfaces (with the bridges), WireGuard, Firewall and the Traffic settings) test their models and drive the whole flow in a
browser against a mock router. The real path was exercised against the router with the System settings model and
`applyChange`,
restoring the configuration afterwards: a confirmed change (zone, description, log port, NTP servers and
switch), the removal of options, a custom zone rule, a forced rollback and the countdown rollback of an
unconfirmed apply. The Wi-Fi, Wired network VLAN, Devices and Interfaces, WireGuard, Firewall and Traffic settings editors are exercised through their suites against mock routers only; the suites block every write on the real router.

## Deploy, test, clean up

Requires PowerShell 7, `ssh`/`scp` with key auth to the router (default `root@openwrt.lab.formicalab.casa`).

```powershell
# Install. Open https://<router>/flab/ and sign in as root with the router's root password
pwsh -File flab-ui\deploy.ps1 -Action Deploy

# Copy only www/ over the deployed UI (nothing is removed, rpcd is not restarted, no session ends)
pwsh -File flab-ui\deploy.ps1 -Action Sync

# Remove every trace from the router
pwsh -File flab-ui\deploy.ps1 -Action Cleanup
```

What Deploy does:

1. Runs the cleanup script first (idempotent).
2. Copies `www/` to `/tmp/flab` (tmpfs, gone after a reboot) and symlinks `/www/flab` to it.
3. Copies `rpcd/ucode/*` to `/usr/share/rpcd/ucode/`, `rpcd/acl.d/*` to `/usr/share/rpcd/acl.d/` and
   `rpcd/lib/flab/*` to `/usr/share/ucode/flab/`.
4. **Restarts rpcd**, which only reads its plugins and ACL fragments at start.

Cleanup removes all of the above (and the diagnostics' job directory `/tmp/flab-diag`, ending any diagnostic still running) and restarts rpcd again. No login or rpcd setting is created or changed, and no file of any other package is touched.

Things to know:

- `rpcd` is **restarted**, so every deploy/cleanup ends the active rpcd sessions (LuCI's and flab-ui's).
- Flash writes are limited to the rpcd plugin and ACL files and the symlink; Cleanup removes them.
- `scp -O` is required (dropbear has no sftp-server).
- After editing a front-end file, `deploy.ps1 -Action Sync` copies `www/` to the deployed UI without restarting rpcd (the UI must already be
  deployed; a changed plugin or ACL fragment needs a full Deploy); Ctrl+F5 reloads the page. For a single file, `scp -O <file> root@<router>:/tmp/flab/<path>` does the same. Backend changes need the file copied to `/usr/share/rpcd/ucode/` (or `/usr/share/ucode/flab/`) and
  `/etc/init.d/rpcd restart`.
- **Sharing one router.** A full Deploy or Cleanup ends every rpcd session, so it must not run while a browser test is signed in.
  `tools/router-lock.ps1` is a reader-writer lock for sharing one test router between several people or agents:
  `-Mode Read` for anything that uses the router and the deployed UI without replacing them (a `run.ps1`, `run.ps1 -Browser`, `deploy.ps1 -Action Sync`; any number
  at once) and `-Mode Write` for a full Deploy or Cleanup (waits for the readers, and no new reader starts meanwhile). `-Suite <name>` names the suite a command runs,
  because two runs of one suite use the same folders on the router and must queue. For example
  `pwsh -File flab-ui\tools\router-lock.ps1 -Mode Read -Suite ddns -Command 'pwsh -NoProfile -File flab-ui\tests\ddns\run.ps1 -Browser'`.
- To test a plugin without rpcd: copy it and `rpcd/lib/flab/` to `/tmp`, then run it with
  `ucode -L '/tmp/*.uc'` through a small script file (inline quoting over ssh is fragile).

## OpenWrt package

The `flab-ui` package (`admin/flab-ui` in the [openwrt/packages](https://github.com/openwrt/packages) feed) installs the
same files `deploy.ps1` copies, but permanently:

| Source | Installed to |
|---|---|
| `www/` | `/www/flab/` (served by uhttpd at `https://<router>/flab/`) |
| `rpcd/ucode/*.uc` | `/usr/share/rpcd/ucode/` |
| `rpcd/acl.d/*.json` | `/usr/share/rpcd/acl.d/` |
| `rpcd/lib/flab/*.uc` | `/usr/share/ucode/flab/` |

It depends only on `rpcd`, `rpcd-mod-ucode`, `ucode`, `ucode-mod-fs`, `ucode-mod-ubus`, `ucode-mod-uci`, `uhttpd` and
`uhttpd-mod-ubus`. The programs the pages read from (`swanctl`, `birdc`, `wg`, `nft`, `iw`, `nlbw`, ...) are optional
runtime tools, not dependencies: install the ones for the pages you use. Installing and removing the package reloads rpcd.
The package is built from the `v<version>` tag of this repository; `tests/`, `tools/` and `deploy.ps1` are not installed.
`deploy.ps1` and the package both use `/www/flab`, so remove the package before a Deploy, and run Cleanup before installing it.

## License

flab-ui is MIT licensed (see `LICENSE`). `www/vendor/bootstrap.min.css` is Bootstrap 5.3.3 and the icon paths in
`www/js/core/icons.js` are Bootstrap Icons 1.11.3; both are MIT licensed (Copyright the Bootstrap Authors).

## How to add a page

Example: an `ntp` page.

1. **Backend (only if new data is needed).**
   - `rpcd/ucode/flab.ntp.uc` returning `{ 'flab.ntp': { status: { call() {...} } } }`. Reuse
     `import { run } from 'flab.util'` and, for strongSwan-style output, `flab.vici`.
   - `rpcd/acl.d/flab-ntp.json`, so that root (read and write `*`) may call it:
     ```json
     { "flab": { "description": "flab-ui NTP page",
                 "read": { "ubus": { "flab.ntp": ["status"] } }, "write": {} } }
     ```
     A page that reads or writes a config through rpcd's `uci` object needs a fragment too, listing the config
     in its `uci` read (and write) lists, like `flab-settings.json`.
   - Prefer data sources that are not LuCI (see the hard rule above), and rpcd's own `uci`, `system` and
     `service` objects where they are enough: no plugin is needed for those.
2. **Frontend.** Create `www/js/pages/ntp.js` (or an `ntp/` folder with `index.js` plus helpers):
   ```js
   import { ubus } from '../core/ubus.js';
   import { card, table } from '../core/ui.js';
   export default {
     id: 'ntp', label: 'NTP', icon: 'clock', interval: 10000,
     load: () => ubus('flab.ntp', 'status'),
     view: data => [card('Servers', table(['Server', 'Offset'], data.servers.map(s => [s.name, s.offset])))],
   };
   ```
   Add `css: 'css/ntp.css'` and the file if the page needs its own styles.
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

Navigation order: Overview · Wired network · Wi-Fi · Mesh · IPsec VPN · WireGuard · Firewall · DHCP · DNS ·
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
Refreshed every 3 s. The physical ports only; the bridges and the layered device/interface view are on
the Devices and Interfaces page. The backend (`flab.network`) classifies whatever netifd reports (`devtype` dsa/ethernet = port, bridge,
vlan), so another board or a new bridge shows up on the next poll. `shared.js` holds the loader and the
address helpers the Wired network, Devices and Interfaces and Traffic pages share.

- **Summary tiles and health banner**: ports linked, live throughput of the external ports, switch chip,
  errors and drops, link changes. The banner lists what needs attention: a downshifted link (negotiated speed
  below what both ends support), link flaps and new errors since the page was opened.
- **Port topology** (`topology.js`, `tile.js`): the wiring of the Ethernet ports, drawn from what
  the router reports: SoC, its MAC(s), the CPU port and link speed into the switch chip, the chip with its
  numbered switch ports, an external PHY where one exists, and one jack per column (green/amber/gray by link
  state, LAN/WAN label, speed, live rate, chart, bridge, STP role, VLAN devices). The SoC MAC boxes show their MAC; a
  jack shows its own only when it differs from the MAC of the SoC port feeding its switch (DSA user ports inherit it,
  so every LAN jack of a typical router would repeat the same address; the tooltip always gives it). Jacks follow the order
  `/etc/board.json` lists its ports (usually the order on the case) with each switch's ports kept together; a
  switch's CPU port and the SoC MAC behind it come from the device tree (`ports/port@N` with an `ethernet`
  property, matched to the MAC by phandle); a port has an external PHY when its node has a `phy-handle`,
  otherwise the switch's internal one. A router without a switch gets MAC, PHY and jack columns. Nothing is assumed about the chips: the boxes show
  the names the router reports, and the lines under them are computed from its data (the fastest speed the ports of a switch
  or an external PHY advertise, the number of user ports, the CPU port's mode and speed), so any hardware is described the same way.
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
- **The CPU link**: the switch box says how much of the link into the SoC is in use (the busier direction, from the conduit MAC's
  counters) and, when the linked user ports could send more than it carries, how many times it is oversubscribed (for example
  five 2.5 Gbit/s ports into a 2.5 Gbit/s CPU port). A link above 90% used is a finding. It is computed from data the page
  already has, so it works for any switch.
- **EEE**: ports with Energy-Efficient Ethernet show a badge (active, idle or off) next to the negotiation, from
  `ethtool --show-eee`; a port that answers without it is not asked again.
- **Optical modules** (SFP and SFP+ cages: the device tree wires the port to an `sfp`, ethtool lists FIBRE among its ports, or the
  port type is fibre or direct attach): the module (vendor, part, type, connector, wavelength) and its diagnostics (Tx and Rx
  power, temperature, voltage, laser bias) from `ethtool -m`, shown with the hardware, an `SFP` tag on the jack and an
  alarm badge. Module alarms and warnings that read On are listed and are findings; an empty cage says so; a direct-attach
  cable shows no diagnostics. Optical ports have no cable test.
- **VLAN tables**: a card per bridge that filters VLANs or has VLANs (a matrix of VLANs against ports: tagged, untagged and the
  PVID), read with `bridge vlan show` when iproute2's `bridge` is installed and otherwise built from the `bridge-vlan` sections of
  the network config (the card says which); and a card per swconfig switch with its VLAN groups. A login that may change the
  network config sees an **Edit VLANs** button on each card, and a bridge that has Ethernet ports but no VLAN table gets a small
  **Set up VLAN filtering** card; a login that may not sees neither.
- **swconfig switches** (older boards whose switch ports are not network devices): `swconfig list` finds them, `dev <switch>
  help` gives the driver and the CPU port, `dev <switch> show` the link, speed, duplex and PVID of each port and the VLAN
  groups; `/etc/board.json` names the CPU netdev and the LAN/WAN role of each port. Each user port becomes a port named
  `port<N>` (the switch port number) with no counters (swconfig has none per port); the CPU netdev is the switch's conduit
  rather than a jack, and a port takes its bridge and VLAN devices from the VLAN devices (`eth0.1`, ...) that carry its VLAN
  groups. This follows the documented output of swconfig and is covered by fixtures only: this repository's router has no
  swconfig switch.
- **VLAN editor** (`vlanpage.js`, `vlanedit.js`, `vlanmodel.js`): **Edit VLANs** opens editable cards in place of the read-only
  ones, one matrix per bridge and per swconfig switch, each cell a drop-down. It edits the network **config**, not the live
  table: when the table the kernel runs (`bridge vlan show`) differs from the config the card says so and names the differences,
  and the read-only card keeps saying where its table was read. The config is read only while the editor is open and only by
  section type (`uci get` with `type`: `bridge-vlan`, `device`, `switch`, `switch_vlan`, `switch_port`), because the whole
  network config holds secrets (PPPoE passwords, WireGuard keys) that the page never asks for; the page does not poll while the
  editor is open (Refresh reloads). The changes use the same flow as the other editing pages: the review banner lists what
  changes from what to what, nothing is written until **Save and apply**, then the change is staged, applied with the rollback
  countdown, the config is read back by type and netifd's interface list (and the plugin) must still answer, and only then is it
  confirmed; a router that kept something else, or that cannot be reached, gets the old configuration back and the edits stay
  in the form. Changes staged earlier in the session are shown with a "Discard them" button. **Done** closes the editor (disabled
  while edits are unsaved; Discard edits in the banner drops them). Its ACL fragment is `rpcd/acl.d/flab-vlan.json`
  (see [Backend](#backend-rpcd-plugins)); the editor adds no plugin.
  - *Bridges* (DSA and VLAN-filtering bridges): one row per VLAN (`config bridge-vlan`: `option device`, `option vlan`,
    `list ports 'lan1:t'` / `'lan2:u*'`, `option local`), one column per port of the bridge (the ports of the bridge's `config
    device` section, else its Ethernet members), and a **Router** column (`local`: the router itself is a member and can have an
    address on the VLAN). A cell is not a member, tagged (`t`), untagged (`u`), untagged + PVID (`u*`) or, if the config has it,
    tagged + PVID (`t*`). An entry the edit does not touch keeps its spelling and place in the list; a VLAN is added with its id
    (1 to 4094), removed with its x button (its section is deleted), and its id cannot be edited (remove and add instead). A
    separate checkbox **VLAN filtering** sets `option vlan_filtering` on the bridge's device section (a bridge defined in an
    interface section instead has no such section, and the page says it cannot switch it); it is its own line in the review.
    Errors (block Save): an id that is not 1 to 4094, a VLAN twice, two PVIDs on one port, a port that is not a member of the
    bridge put into a VLAN. Warnings (do not block): VLAN filtering off while the table is edited (the table has no effect
    until the bridge filters), turning filtering on or off (the whole table takes effect at once; ports in no VLAN carry
    nothing), a VLAN device on the bridge (`br-lan.100`) that the table does not cover once the bridge filters, a port untagged
    in several VLANs or untagged with no PVID anywhere (what happens to its untagged frames depends on the netifd version), a
    member port in no VLAN, a VLAN with no member. **Lockout warnings** come from netifd's interface list: the interfaces that are
    up and have an address on the bridge's untagged VLAN or on `<bridge>.<vid>` are known, and removing such a VLAN, the router
    leaving it, or a port leaving or retagging it is warned about with the interface and address; the interface whose address
    is the one the page was opened with is called out ("You are connected through this address"). Only a bridge that filters (or
    is switched to filter) is checked for this, since the table is not in force otherwise.
  - *swconfig switches*: one row per `config switch_vlan` (`option device`, `option vlan` = the group number, `option vid` when
    it differs, `option ports '0t 1 2 3'`), one column per user port and one for the CPU port (a new group starts with the CPU
    port tagged and the lowest free group number); a cell is not a member, tagged (`3t`) or untagged (`3`). A checkbox sets
    `option enable_vlan` on the switch's `config switch` section. `switch_port` sections (the PVID of a port) are shown in a note
    and left as they are. Errors: an id or group number that is invalid or twice, a port untagged in more than one group (the
    documentation: an untagged port can only be in one VLAN). Warnings: VLANs off, turning them on or off, a port in no group,
    the CPU port in no group, or leaving the group that carries an interface of the router. **This is covered by a mock only**:
    this repository's router has no swconfig switch, so the swconfig editing has never run against a real one.
  - *What it does not do*: ranges of VLAN ids, `alias`, `local_pvid` and the multicast options of a `bridge-vlan` section (left as
    they are), ports of wireless interfaces, a bridge defined by an `interface` section.
- **Cable test**: a button in the Link column of each twisted-pair port (not the internal link to a switch, a swconfig port or an
  optical cage) runs `ethtool --cable-test` after a confirmation that says the PHY drops the link for several seconds (and
  that nothing is interrupted for a port without link). The result lists the four pairs (OK, open circuit, short within a pair,
  short to another pair) with the distance of a fault, stays under the port's row until closed, and says what it means: for
  a link at 100 Mbit/s or less, open pairs C and D are the reason it cannot reach 1 Gbit/s. The downshift finding points to
  it. Not every PHY driver supports it: the plugin remembers a port that does not (`cable_test: false`) and the button goes
  away. `cable_test` accepts only a physical Ethernet port that exists (never a bridge, a VLAN device or the SoC link into a
  switch) and builds no command otherwise; it is the only method of this plugin under `write` in the ACL fragment, so a login
  that may read but not write sees no buttons.

### Wi-Fi (route `#wifi`)
Two sections, both refreshed every 5 s.

**Radios** (`flab.radio`, `wifi/radios.js`): one card per radio from UCI `wifi-device`. Header with band, phy,
state, standards and hardware; key figures (running channel, frequency, width, center, TX power, noise floor,
antennas, clients); the configuration next to what is actually running (channel, mode, TX power with the
regulatory limit of that channel, country vs active regulatory domain, cell density, beacon interval,
options); channel utilization (busy, RX and TX airtime as a percentage and chart, derived in the browser from
the driver's cumulative survey counters); the channels allowed by the regulatory domain (a picker to change the
channel, see Editing below) with the running block highlighted and DFS (radar) channels marked; and a table of the SSIDs (BSSID,
networks, security, clients, live and total traffic, 802.11r/k/v, WPS, OCV, hidden, isolation, MAC filter
policy with entry count, BSS status). Findings appear when something is off: radio down, setup failing,
running channel different from the configured one, high noise, busy channel, DFS availability check in
progress, open network, country mismatch. `status` copies only whitelisted options: keys, passwords, FT key
material and MAC lists never leave the router through it (`config`, below, returns the MAC list of a filter because it is edited there). Mesh (802.11s) interfaces are not listed here: a radio
carrying one shows a `mesh · <id>` badge linking to the Mesh page, and mesh peers are not in the clients list.

**Editing the wireless configuration** (`wifi/schema.js` option tables, `wifi/model.js` pure model, `wifi/editors.js` controls,
`wifi/channels.js` and `wifi/picker.js` for the channel, the shared editor of `core/editpage.js`): the page edits
`/etc/config/wireless`, the radios (`wifi-device`) and the wireless networks (`wifi-iface` of mode `ap` and `sta`; mesh
interfaces are the Mesh page's). Everything it offers comes from what the router reports (radios, bands, channels, supported
modes, countries, hostapd features), so it works on any hardware.
- **Reading without secrets**: the configuration is read through `flab.radio config`, which returns every option of every
  `wifi-device` and `wifi-iface` section except the ones that hold a secret (`key`, `key1`-`key4`, `sae_password`,
  `auth_secret`, `acct_secret`, `dae_secret`, `identity`, `password`, `priv_key_pwd`, `wps_pin`, `r0kh`, `r1kh`, and any
  option whose name says password, passphrase, secret, pwd or token): for those it reports only that they are set. The
  browser never calls `uci get` on this config (the ACL fragment does not grant it), and the read-back after a save goes
  through the same method. Password fields are write-only: they are empty and say "stored; leave empty to keep it", a typed value
  replaces the stored one, and a value that was typed is never shown in the review list. The MAC list of a MAC filter is
  returned (it is edited here); `status` still only reports its entry count. Sections of other types (`wifi-vlan`,
  `wifi-station`, which can hold keys) are listed by name only.
- **Radio settings**: a foldable block per radio card with the options of the OpenWrt documentation, each with a hint: disable
  the radio, mode and channel width (`htmode`), country, transmit power, cell density, legacy 802.11b rates, minimum client
  standard, coexistence scan, beacon interval, 802.11d, distance, RTS and fragmentation thresholds, antenna gain and the hostapd
  log level. The mode list is what the hardware reports: the htmodes `iwinfo` lists for a running interface, else the widths the
  phy's capabilities advertise for the radio's band (HT, VHT, HE, EHT; the explicit `HT40+` and `HT40-` on 2.4 GHz and `NOHT` are
  added); a radio whose phy is unknown gets a text box checked for its form. The country list comes from the driver
  (`iwinfo <if> countrylist`), else a text box. Options that apply to one band are shown on it (legacy rates and the coexistence
  scan on 2.4 GHz) or when they are already set.
- **Wireless networks**: one foldable editor per `ap` and `sta` network on each radio, with groups (network, enterprise
  authentication, security options, clients and traffic, roaming 802.11r/k/v), and buttons that add an access point or a
  client network. Options: SSID, the networks it is attached to (a check box per network interface of the router), encryption
  (what the installed hostapd can do: SAE and OWE and WPA-Enterprise are offered only when `hostapd -vsae`, `-vowe`, `-veap`
  succeed; a value the file already holds, such as WEP or TKIP, stays selectable), the password, hidden SSID, disable,
  RADIUS server, port and secret and accounting for an enterprise access point, EAP method, identity, password and
  certificates for an enterprise client, protected management frames, SAE derivation, OCV, WPS, isolation, client limit,
  MAC filter and list, WMM, DTIM, inactivity, multicast to unicast, proxy ARP, 802.11r (mobility domain, FT over DS, local PSK
  generation, PMK-R1 push, NAS and R1 key holder, reassociation deadline), 802.11k, 802.11v, WNM sleep, time advertisement. An
  option that does not apply to the mode or the encryption is hidden, keeps its value in the file and is not written. A new
  network is added as a named section (`wifinetN`); a section without a name (`cfgXXXXXX`) is addressed by its generated name,
  and the check after a save finds the networks by position because that name changes with the content.
- **Validation** (errors block Save and mark the control; warnings do not): only what the draft changes is checked, so an
  odd configuration does not block an unrelated edit. Errors: an SSID over 32 bytes or empty, a network attached to nothing, a
  password that is not 8 to 63 printable ASCII characters or 64 hexadecimal digits, a missing password on a protected network
  (a stored one counts), an encryption the hostapd cannot do, missing RADIUS or EAP fields, protected management frames
  disabled with WPA3 or OWE, malformed MAC addresses, malformed 802.11r identifiers, numbers out of range, a mode the hardware does not
  report, a country the driver does not know, a channel the new mode cannot carry.
- **Warnings for dangerous changes**: switching a radio off (how many networks and clients it takes down, and that the router
  undoes the change by itself 30 seconds after the apply if the admin loses the connection), changing the SSID,
  password, encryption, networks, protected frames or hiding of a network that has clients (their number, and that the admin may be
  connected through it), removing or disabling a running network, an open network (who can join and what they reach), WEP, WPA1
  or TKIP, two networks with the same SSID on one radio, an access point and a client network sharing a radio (they share its
  channel), a power above the regulatory limit, changing the country, the 802.11r settings that break fast transition with
  WPA3, an allow filter with an empty list, a 40 MHz channel on 2.4 GHz, legacy rates, requiring 802.11ac, a hidden SSID.
- **Saving**: stage, apply with the rollback countdown (rpcd reloads Wi-Fi), read the configuration back through
  `flab.radio config` and compare every shown option (a typed password: that one is now stored), then wait up to 16 seconds for each
  changed radio to be up with its new or changed networks running (a radio that is switched off, or has no enabled network, is not
  waited for); if the check or the wait fails the change is rolled back. A radio on a DFS channel counts as up while it listens for radar.
- Polling is suspended while edits are pending, a control has the focus, the pointer is over a channel picker or a save runs. A login that may not write sees the
  forms read only; a router whose `flab.radio` has no `config` method gets the radios read only with a note, and a radio whose phy did not list its
  channels gets the plain channel strip.
- The page needs the ACL fragment `rpcd/acl.d/flab-radio.json`: `flab.radio` `status` and `config`, `uci changes` (read) and the
  `uci` write methods on `wireless`. It does not grant `uci get`.

**The channel picker** (`wifi/channels.js` model, `wifi/picker.js` control): each radio card shows its allowed channels as tiles. The
`channel` option of the radio is a channel number or `auto`; a channel is only selectable when the whole block of the width of the mode
being edited fits around it in the regulatory domain (others are hatched), so choosing a mode redraws which blocks fit, and a mode that
no longer fits the chosen channel is an error on both controls.
- **Preview**: hovering or focusing a tile shows the block the radio would use at that width, in blue,
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
poll (flagged as not in the configuration). The page also edits the configuration behind them.
- **Tiles**: interfaces up, peers connected, latest handshake, live traffic (rates derived in the browser from
  the byte counters).
- **Interface card**: state, firewall zone, addresses, listen port, public key (not secret), MTU, firewall
  mark, totals; the buttons *Add a device*, *Add peer* and *Remove interface*; a note with a link to the Firewall page when the interface is in no
  zone; the peers table; and the foldable *Interface settings* form. An interface that only the kernel has (made with `wg-quick` or `ip link`) is
  shown read only with a note.
- **Peers table**: name (UCI `description`) and a role badge from the allowed IPs (*client*: host routes only,
  *site*: a whole network behind the peer, *all traffic*: a `/0`), shortened public key (full key on hover),
  endpoint (empty for roaming peers), allowed IPs, handshake state, keepalive, live and total traffic, and the buttons *Edit* (opens the peer's
  editor under its row), *Remove* and *Undo*.
- **Handshake state**: *connected* when the last handshake is under 180 s old (WireGuard rekeys every 120 s
  and rejects a session after 180 s), *no recent handshake* when older, *never connected* when the kernel has
  no handshake, *not loaded* when the peer is configured but the interface is not running.
- **Findings**: interface down, interface in no firewall zone, a configured peer not loaded, stale or never
  connected peers (informational: roaming phones are often offline), a site peer whose `route_allowed_ips` is
  off.
- **Interface options** (hints from the OpenWrt documentation on each): disabled, listen port, addresses (a list), MTU, firewall mark, no host
  routes to endpoints, and the private key. Options the page has no control for (`tunlink`, `ip6prefix`, ...) are listed read only.
  An interface is added with *Add WireGuard interface* (name: letters, digits and underscores, at most 15, not the name of any section of the
  network config; the first free `wgN`, the first free UDP port from 51820 and a private key made in the browser are offered) and removed with
  its peers (until saved, with *Undo*).
- **Peer options**: name, disabled, public key, pre-shared key, allowed IPs (a list), create routes for the allowed IPs, endpoint host and port,
  keepalive. Peers are added (an anonymous `wireguard_<interface>` section, as LuCI makes them), edited in place and removed.
- **Keys never reach the browser, and a new one is made there.** The plugin never reads `private_key` or `preshared_key` (or any option named like a
  secret) into its output and reports only whether each is set; only the single-field `wg show` forms are used because they never print them. The test recorder
  scrubs both keys, and the test generator aborts if a capture still contains one. The key boxes are write-only: empty keeps the stored key, the review banner shows *new value
  (hidden)*, never the text. *Generate a key* makes an X25519 key pair in the browser with WebCrypto (feature-detected; where the browser has no
  X25519 a small BigInt implementation of RFC 7748 derives the public key from random bytes of the browser's own generator; where there is no
  secure random generator at all, the button is disabled and the page says to paste a key made with `wg genkey`). The public key of a typed or
  generated private key is shown next to the box (with *Copy*). A pre-shared key is 32 random bytes from the same generator.
- **Add a device**: a dialog for a phone or laptop of an interface that is running. It takes a name, the router's public address (offered: the
  host name the page was opened with), the UDP port, what the device sends through the tunnel (the tunnel networks, everything, or a list),
  an optional DNS server, a keepalive and whether to use a pre-shared key. It makes the device's key pair in the browser, adds the device as a peer
  of the form (its public key and the next free address of each family from the interface's tunnel network, skipping what other peers allow) and shows
  the device's WireGuard configuration once (`[Interface]` with its private key and address, `[Peer]` with the router's public key as `wg show`
  reports it, the endpoint and the allowed IPs), with *Copy* and *Download* (`<interface>-<device>.conf`). The device's private key exists
  only in the dialog; the peer reaches the router only when you press *Save and apply*. A QR code is not offered.
- **Validation** (errors block Save; warnings do not): the interface name, a listen port that is a number and that no other enabled interface (or
  an interface only the kernel has) uses, addresses as CIDR (a dotted netmask is accepted), the MTU range and the firewall mark, a typed key that is
  44 base64 characters with the right padding bits, a peer's public key (required, not the interface's own, not repeated on the interface),
  allowed IPs as CIDR with a prefix length, an endpoint host that is a name or an address (an IPv6 address without brackets), port and keepalive
  ranges, a new interface without a private key. Warnings: no address, an address without a prefix, overlapping tunnel networks of two interfaces,
  an MTU above 1420 or below 1280 with IPv6, no listen port on a router that peers connect to, overlapping allowed IPs between peers (the same
  prefix: the later one wins; a broader one: the more specific wins), a `/0` on a peer (the default route when routes are created, else that no
  route is created), a network on a peer without routes, no allowed IPs, an endpoint that does not look reachable (loopback, unspecified,
  link-local, multicast, a name without a dot or in `.local`/`.lan`, an address inside the router's own tunnel network), an endpoint port without a
  host, a new interface (it is in no firewall zone), a removed interface that a firewall zone still names.
- **Changes that may cut the tunnel you are working through.** The plugin reports the established TCP connections to the router's web and SSH
  ports (the ports in uci uhttpd and dropbear, plus 22, 80 and 443). A connection whose remote address is inside an enabled peer's allowed IPs of
  a running interface (the most specific one; a `/0` does not count) is probably your own, so removing, disabling or re-keying that interface
  or peer, or any change that restarts it, is called out in the banner, and removing the interface or the peer asks first in a dialog that names
  the address and the peer. Without such a connection a connected peer or interface gets a generic warning. The page does not know which
  connection is its own, so another administrator's session through the tunnel gives the same warning.
- **Saving** goes through `applyChange()` like the other editing pages (stage, apply with the rollback countdown, read the config back through
  the plugin, confirm). The check requires every option, every typed key (as set) and every new or removed interface and peer to be as drafted,
  and then that the tunnel really runs: an interface that was running, is new or is being enabled must be `up`, and a new, re-keyed or enabled
  peer must be loaded in the kernel. netifd takes a moment, so the read-back is repeated for about 7 s while something is not running yet; a
  configuration that makes the interface fail (no key, a bad key, a missing `wireguard-tools`) is rolled back and the edit stays in the form. Changes
  already staged in the session are shown with a "Discard them" button. The page does not poll over unsaved edits, a focused control or an open dialog.
- **The firewall zone is another page's job**: a new interface is in no zone until you put it in one on the Firewall page (the card links there); the
  listen port also needs a firewall rule from the zone the peers come from.
- **Plugin missing**: a router without `flab.wireguard` gets a note instead of the page; a router without netifd's wireguard protocol handler
  (`wireguard-tools`) gets a note that interfaces cannot start. A login that may not write sees the page read only.
- **ACL**: `rpcd/acl.d/flab-wireguard.json` grants `flab.wireguard` `status` (read), `uci` `changes` (read) and `set`, `add`, `delete`, `revert`, `apply`,
  `confirm`, `rollback` (write), and `uci` read and write on the `network` config. It has to list that config under read because `uci changes` needs it, although the config holds the
  private and pre-shared keys: it does not grant `uci get`, the page never calls it (a test fails if it does) and reads the config only through the plugin, which leaves the keys out.

### Firewall (route `#firewall`)
Refreshed every 5 s, from `flab.firewall` (firewall4 / nftables) and, to edit, rpcd's `uci` object. The live state comes from `nft -j list ruleset` (about 10 ms, ~30 KB), so a new zone, rule or port forward shows
up on the next poll and every number is a real kernel counter; the configuration is read with `uci get firewall` (it holds no secrets), so every section is known by its own name (an anonymous one is `cfgXXXXXX`, never "rule 3": positions change when sections are added or removed). The plugin's reply is joined to the config by that name; when the two do not agree (a reply made for another config, a change between the two reads, a rule with another enabled state) the page shows the plugin's own data read only.
- **Tiles**: zones, traffic rules (enabled / total), port forwards, packets turned away from the Internet
  (with a live rate), connection tracking usage, flow offloading (off, software or hardware, and the flowtable
  devices).
- **Who can reach whom** (`model.js` is the pure model, `matrix.js` draws it): rows are the source, columns
  the destination, and the router itself is both. The policies follow firewall4: *zone › router* is the zone's
  `input`, *router › zone* its `output`, *zone › same zone* its `forward`, and *zone › other zone* is open
  only through a `forwarding` section. A cell is green when the policy allows it, amber when it is blocked but
  specific rules or port forwards open parts of it ("N rules"), gray when closed; an open cell notes rules
  that block part of it. Hover a cell for the rule names. Disabled rules, rules naming an unknown zone and
  rules with neither side are ignored, as the firewall does. **Clicking a cell between two different zones switches the forwarding** from the row's zone to the column's: an enabled forwarding is removed, a disabled one is enabled, otherwise one is added; the cell says "forwarding added / removed, not saved". The same forwardings are ticked in the zone's dialog (below).
- **Zones**: configured interfaces, the kernel devices the loaded rules really match for the zone (read from
  the jumps in the base chains), input/output/forward *policy*, NAT and MSS clamping, where the zone may
  forward to, and the packets its reject/drop chains turned away, in each direction, with a live rate. The
  policies are defaults: `reject`/`drop` refuse everything except what a specific rule or forwarding allows
  (replies to allowed connections are always let back in), which the card's legend and the column tooltips
  spell out. *Forward* is only traffic between interfaces of the same zone; reaching other zones is the "May
  forward to" column. **Add zone** and each row's pencil and trash buttons open or remove a zone. The dialog has: name (letters, digits and `. _ - /`; it cannot be changed once saved, because rules and forwardings refer to it by name), enabled, the three policies (empty = the global default), the interfaces as check boxes over the router's interfaces (an interface can be in one zone only: choosing one that is in another zone says so and moves it, the other zone loses it when the form is accepted), devices (`tun+`) and subnets, address family, masquerading (`masq`, `masq6`, `masq_src`, `masq_dest`, `masq_allow_invalid`), MSS clamping, logging (`log`, `log_limit`) and connection tracking helpers, and **Traffic to and from other zones**: one box per other zone for "May forward to" and one for "May receive from". A `forwarding` section covers one direction only, so each box is one section: ticking adds it (or enables a disabled one), clearing removes it, and a forwarding that names "any zone" is left as it is. Removing a zone also removes the forwardings that name it (Undo brings both back); the rules and port forwards that still name it are errors until they are changed.
- **Traffic rules** and **Port forwards and NAT**: every section in configuration order with its match
  (protocol, ports, ICMP types, addresses, limit, family), action and hit counters, and **in plain words what it does** ("Allows TCP port 22 from zone wan to the router itself, from 10.0.0.0/8, IPv4 only."; "Forwards TCP port 8080 arriving from zone wan to 192.168.1.10 port 80 in zone lan."). nft counters are matched
  to the UCI section through the comment firewall4 puts on each rule (`!fw4: <name>`; an unnamed rule is
  `@<type>[N]`, N counting sections of that type); a rule that expands to several nft rules has its counters
  summed. A disabled rule is grayed out and has no counters; an edited or new item shows no counters until it is saved. A row has an enable switch (`option enabled`), buttons to move it up or down (the order is the order the firewall evaluates), Edit, Remove (struck through until saved, with Undo), and the card has Add rule / Add port forward. A `nat` section is listed read only ("edit in the file").
  - The **rule dialog** (what it does: name, enabled, action ACCEPT / REJECT / DROP / MARK / NOTRACK, source and destination zone, address family; which traffic: protocols as check boxes plus any other name or number, ICMP types (suggestions of every name fw4 knows), source and destination addresses (address, CIDR, mask, range `a-b`, an interface name, `!` in front), source MAC, source and destination ports and ranges; rate limit and burst, the mark of the action MARK; a schedule: times, days of the week ("every day except"), dates, UTC) writes only the options that differ from the firewall's defaults. A sentence at the top says in words what the rule does as the form is filled in.
  - The **port forward dialog** (kind DNAT or SNAT; protocols; source zone, "arrives at" address and port, only-from address, port and MAC; destination zone, internal address and port; reflection, its source and zones; rate limit and schedule) words its fields differently for a source NAT ("Rewrite the source address to").
- **Global settings** (a card, folded: `defaults` section): default input, output and forward policies, drop invalid packets, SYN-flood protection (rate and burst), the reject answers, software and hardware flow offloading, TCP SYN cookies, ECN, window scaling, ICMP redirects, source routing, helpers and nftables includes, each with a hint from the OpenWrt documentation. A router without a defaults section gets one on the first change.
- **Findings**: firewall not loaded (no fw4 table), an Internet-facing zone that accepts input or forwards
  within itself, a rule accepting every TCP/UDP port from it, rules naming a zone that does not exist,
  interfaces in no zone (their traffic is rejected), zones with no interface, SYN-flood protection off,
  disabled rules, connection tracking over 80 % full. While there are edits the findings (and the matrix, tables and tiles) describe the configuration as it will be once saved.
- **Validation** (errors block Save, warnings do not), following firewall4's own parsers: ports and ranges, addresses, subnets and ranges, MAC addresses, limits, times and dates, marks, ICMP types, protocols, weekdays; a zone name used twice or longer than 11 characters (the longest that works), an interface in two zones, a rule, forwarding or port forward that names a zone that does not exist or is being removed (a forwarding to a missing zone can never be saved), the action MARK without a mark, NOTRACK without a source zone, a port forward without a source zone (or with "any zone"), without an internal address or port, with a negated internal address, a source NAT without destination zone or address. Warnings: ports on a protocol that has none, IPv4 addresses with an IPv6-only family, a port forward that opens every port, a zone with nothing in it, an interface the router does not have, a disabled zone that rules name, hardware offloading without software offloading, rules sharing a name (their counters add up). A problem that is already in the file and sits in a section the form has not touched is only a warning, so unrelated edits can still be saved; one the edit causes is always an error.
- **Lock-out check**: the page works out, for the web interface's port and for SSH (22), which zones let their hosts reach it today (input policy ACCEPT, or an enabled ACCEPT rule with a source zone and no destination zone for TCP and that port) and which will after the edits. A zone that loses it gets a warning; when the address the page was opened with is one of the router's own (the plugin lists every interface's addresses) the interface and zone you are using is named ("Lock-out risk: you are reaching the router at 192.168.1.1 (interface lan, zone lan)…"). Save then asks for confirmation, listing the risks ("Apply anyway" / Cancel).
- **Saving** goes through `applyChange()` like the other editing pages (stage, apply with the rollback countdown, read back, confirm). The check after the apply reads the config back and requires every list to hold the same items in the same order with the same values (a new section is recognized by its place, because the router names it itself), and, when the firewall was loaded before, the fw4 table to exist with a chain set for exactly the enabled zones of the file (it waits up to 12 s for the reload). A change the router did not keep, or that makes the firewall stop loading (fw4 refuses the configuration and keeps the old ruleset), is rolled back at once and the edits stay in the form. Only the order of rules and port forwards is staged with `uci order` (a full list, every section of the file in its place; new sections are named by the router, and the page uses the names `add` returned); adding or removing a zone or forwarding needs none, because firewall4 reads sections by type and its types in any order.
- The page does not poll over unsaved edits, an open dialog or a focused control of the global settings. A login that may not write gets the page with every control disabled and a note; a login that may not read the firewall config, or a router whose plugin predates the editor, gets the read-only page. Not offered: renaming a zone (rules refer to zones by name), editing `nat`, `ipset`, `include` and `helper` sections, and options with no control (for example `src_mac` on a forwarding, `mark`, `dscp`, `helper`, `extra`), which stay untouched in the file. The lock-out check knows the interface the page was opened through only when the URL holds one of the router's own addresses; with a host name it names every zone that loses access.
- **ACL**: `rpcd/acl.d/flab-firewall.json` grants `flab.firewall` `status` and `uci` `get` and `changes` (read), and `uci` `set`, `add`, `delete`, `order`, `revert`, `apply`, `confirm`, `rollback` (write), on the `firewall` config only. The firewall config holds no secrets; the plugin's `networks` list carries only the name, whether it is disabled, the protocol and the router's own addresses of each interface, never a key.

### Devices and Interfaces (route `#interfaces`)
The network as a **board**: how it is built, from the cable up, on one screen, and the one place where the network configuration is edited. The bridges are part of it (the old
`#bridges` route opens this page: `aliases` in `pages/index.js`). Refreshed every 5 s. `boardmodel.js` is the pure model, `board.js` draws it. Data: `flab.network` (status and,
for editing, `config`), netifd's interface dump, `flab.radio` and `flab.mesh` (both optional: without them the page shows the wired layers, and a bridge shows no mesh peers).
OpenWrt builds a network in layers, and the board has one lane for each, left to right:
1. **Ports and radios** (physical): the front-panel Ethernet ports (link dot, speed, LAN or WAN position, a mark when the port has device settings), and the radios
   with their Wi-Fi and mesh interfaces as chips (SSID or mesh ID, mode; a chip links to the Wi-Fi or Mesh page). A configured wireless interface that is not running has no name
   yet, so it joins the interface named in its `network` option, shown as down. The DSA conduit and the pseudo ports of a swconfig switch are shown only when something is attached
   to them. A radio without an interface is a chip of its own.
2. **Devices**: bridges (port count, STP, VLAN filtering) and VLAN devices (`eth1.1036`, VLAN ID and base device), then other `device` sections and devices an interface names that
   the router does not describe (kept, marked, never dropped). The **Device** menu adds a bridge, a VLAN device or the settings of a port. A bridge or VLAN device is optional:
   an interface can sit on a port directly.
3. **Interfaces**: one card per netifd interface: name, protocol badge, state and uptime, what it sits on ("on br-lan", "on the PPPoE session of wan", "runs over wan"), its
   protocol device (`pppoe-wan`, `wg0`, `xfrm0`; "shared" when another interface owns it, as `wan6` on the PPPoE session of `wan`), addresses and gateway, and behind "details" the
   DNS servers when long, the non-default routes netifd installed for it (`on link` when the next hop is unspecified) and the IPv6 prefixes assigned to it or received on it. A tunnel runs over another interface
   (`tunlink`, read from UCI, e.g. IPsec XFRM interfaces over `wan`). An interface section without a protocol is flagged: netifd ignores its settings and its device stays down.
   The **Network** button opens the wizard.
4. **Zones and services** (read only): one card per firewall zone with its policies in words, NAT, the zones it may forward to, its networks and the DHCPv4 pool, DHCPv6 and
   router-advertisement mode of each (from `flab.network`: UCI firewall and dhcp); interfaces in no zone get a "No zone" card. The links go to the Firewall and DHCP pages.

A bridge hands its untagged frames to the interface bound to it, while an 802.1q VLAN device on that bridge picks out only the frames carrying its tag and gives a second, separate
interface on the same wires (a `lan` and a `lan100` on one bridge); the board shows each of them as its own chain. The lanes are ordered by the first front-panel port each chain
uses; chains with no port come last.

Curved **connectors** join the connected cards (port or Wi-Fi to bridge, bridge to VLAN device, device to interface, an interface to the interface that rides on its protocol device
or whose tunnel runs over it, interface to zone). They are drawn after layout and again whenever the board changes size. **Hovering** a card (or opening it) highlights everything
it is connected to, the cards it is built on and the cards built on it, and dims the rest; this works without the connectors too. Everything wraps (addresses break after a colon and,
last, anywhere); cards never overflow their lane or overlap. Below 760 px of board width the lanes stack and the connectors are off (the highlighting stays).

Cards that exist only in the form carry a **new** badge (dashed border), cards the form removes **to be removed**; the board follows the form as it is edited (a typed name, a chosen
device, a ticked port moves the cards and connectors at once). **Tiles**: interfaces up, bridges, VLAN devices, protocol devices, tunnels, radios up, wireless interfaces. The findings
banner lists down or pending interfaces, wireless interfaces no interface uses (an unattached wireless interface), interfaces without a protocol and the bridge findings (a blocked
alternate STP port, a topology change, a down bridge, STP off with several linked ports).

**The drawer** (`core/drawer.js`, `css/drawer.css`: Bootstrap's offcanvas markup without its JavaScript). A click (or Enter) on an interface, device, port or zone card opens it in a
side panel on the right: about 34 rem wide, full height, a sticky header and footer, a scrolling body, closed by Escape, its close button or leaving the page. It is not modal: on wide
screens the page makes room for it, the board stays visible and the chain of the open card stays highlighted; clicking another card shows that card in the same drawer. The editing
panels come from `panels.js` (an interface, a device or port, the network-wide settings); a zone, and any item when the login or router cannot edit, gets a read-only summary of what the router
reports (`livepanel.js`). The open card survives the redraw of every poll and of every edit (the panel is rebuilt from the draft and keeps its scroll position and the focused control); it
closes by itself when its card is gone (saved away, discarded). The page does not poll while a panel for an editable item is open, over unsaved edits, while a wizard is open or during a save.

**Bridge panel, live part** (`bridgelive.js`, `bridgeLive(net, mesh, name)`, from the `flab.network` status and the optional `flab.mesh` status; shown for a bridge the router runs, also one the
configuration does not know): the spanning-tree position (this bridge is the root, or the root bridge ID, the root port and path cost, with the mesh peers on the way), bridge ID, priority,
timers, MAC aging, VLAN filtering and default PVID, IGMP snooping, VLAN devices, MAC and MTU, live throughput, and a member table with type (Ethernet, Wi-Fi with SSID, or mesh with its mesh ID
and number of peers), link, STP state and role, port cost, learned MACs per port, live rate and link flaps. The spanning-tree diagram has the same shape on both sides of a mesh link: a bridge
that is not the root draws the root bridge (its ID), the link (root port, path cost) with the mesh peer on it, and itself; the root draws itself, the link (port, path cost) with the mesh peers
that reach it, and "downstream bridge, reached over the mesh". The root cannot show the downstream bridge's ID because only that bridge knows it (the kernel reports the root ID and root port
on a non-root bridge only). Learned MACs per port come from the kernel's binary forwarding table (`/sys/class/net/<bridge>/brforward`, 16 bytes per entry; the port number is the low byte at
offset 6 plus the high byte at offset 12), because the `bridge` utility is not installed.

**Editing** (`editor.js`, `panels.js`, `panelmodel.js`, `panelparts.js`, `controls.js`, `wizard.js`, `wizardmodel.js`, `schema.js`, `model.js`, `checks.js`): the page edits `/etc/config/network` through `flab.network config` and rpcd's `uci`. Every panel
edits the one shared draft; the review banner in the command bar lists the changes and Save applies them together.

**Words.** The panels use the OpenWrt documentation's words: a *network device* (a NIC or a switch port) and a *bridge device* carry frames; an *interface*
(a "logical network") holds the IP configuration and sits on one device; a *firewall zone* groups interfaces. A `device` section is optional when the layer 2
and layer 3 device is the same one, so a port with no device section is normal and an interface may sit on a port directly.

**Interface panel** (`interfacePanel`; click an interface). Header: the name and `Interface · <protocol>`. Below it, for an interface netifd runs: its
state, the device it runs on now (and the device its protocol creates, `pppoe-wan`), addresses, prefixes, gateway and DNS. Sections:
1. **Connects through**: the device chooser, one radio per device the router (or the form) has: bridges, ports, VLAN devices, the CPU link, and `@interface`
   aliases (borrow another interface's device), each with one line saying what it is, which interfaces already use it, and a warning for a port that is a bridge member.
   "No device" is a choice too. A device the config names but the router lacks stays selectable as "not found".
2. **Protocol**: protocol cards (Static address, DHCP client, DHCPv6 client, PPPoE, Unmanaged) with what each is for and what it asks for. The current one is
   selected; every other card says what a switch to it drops (`Switching drops: IPv4 addresses, IPv4 netmask`); after the switch the panel says what saving removes
   from the file, so a stale static address is never requested by a DHCP client. An interface with no protocol gets a warning (netifd ignores it and its device stays down);
   protocol `none` is described as "device up without IP configuration".
3. **Settings**: only the protocol's essential options (static: addresses, gateway, DNS servers; DHCP: use the provider's DNS and default route; DHCPv6: request
   address and prefix; PPPoE: username and the write-only password; none: nothing), then a folded **Advanced** block holding every other option of the protocol in groups (the
   title says how many hold a value), and the options the page has no control for, read only. The groups are Interface (device, boot, disabled, IPv6, MTU, MAC address, force link),
   IPv4 address (addresses with prefix or netmask, gateway, broadcast), IPv6 address and prefixes (static address and gateway, `ip6assign`, `ip6hint`, `ip6class`, `ip6ifaceid`, `delegate`),
   PPPoE login (access concentrator, service, AC MAC, Host-Uniq, keepalive, inactivity timeout, extra pppd options), DHCP client options (broadcast flag, host name, client id, vendor class,
   options to send and request, classless routes, release), DHCPv6 client options (address and prefix request, client id, request options, release, forced prefix, SLAAC, source filter),
   DNS and default route (servers, search domains, metric) and routing tables; every option has a hint from the OpenWrt documentation (`schema.js`; `panelmodel.js` only marks which options are essential).
4. **Used by**: the firewall zone (with its policy) and the DHCP/RA services of the interface, links to the Firewall, DHCP and Routing pages, and the interfaces that
   borrow its device or run over it. Footer: **Remove interface** (**Discard interface** for one that is not saved), with a note naming the interfaces that borrow
   its device (the model refuses the save until they are rebound or removed). A removed interface shows "removed when you save" and Undo. The loopback interface
   cannot be removed.

Interfaces whose protocol this page does not edit (WireGuard, IPsec, modems, tunnels) get a read-only panel: the protocol in words, its state, the options as they are
in the file (secrets as "hidden (a secret)"), a button to the owning page (WireGuard, IPsec) and the "Used by" section; they cannot be removed here.

**Device panel** (`devicePanel`; the argument is a section of the draft or a device name):
- **Bridge device**: the live bridge information (see above; omitted when the live bridge is missing), the **ports** picker, essential settings (spanning tree, VLAN filtering, IGMP
  snooping, MTU, MAC address), Advanced, and what uses it (interfaces, VLAN devices on it, Wi-Fi interfaces). A new bridge is named in the panel. The ports picker is a grid of check
  boxes: every Ethernet port the router has (not the DSA conduit, and not the ports of a swconfig switch, which are not devices; their VLAN devices are), VLAN devices (also ones added in
  the same form, but not one that sits on the bridge itself), the link state, and which bridge a port is in now. A port can be in one bridge only: ticking a port that another bridge of the
  form holds moves it (the review lists both bridges). A device name can be typed to add one the grid does not list (it must exist on the router, or be a port the config already names).
  Wi-Fi interfaces are not ports here: they join through the wireless `network` option, and the panel says so. Options, in folding groups with a hint each: VLAN filtering and "keep the
  bridge without ports"; spanning tree (STP, priority, forward delay, hello time, max age, MAC aging); multicast (IGMP snooping, querier, the intervals, hash size, robustness); packet handling
  (MAC address, MTU, IPv6 MTU, transmit queue, IPv6, promiscuous mode, ARP options, IGMP/MLD version, multicast to unicast, port isolation, DAD transmits).
- **VLAN device** (802.1Q and 802.1ad): the tag section (base device chooser, VLAN ID, the type for a new one), MTU and MAC, Advanced. While the name was not typed it follows `<base>.<id>`.
- **Network device settings** (a `device` section with no type, for a port): the live link (state, speed, duplex), speed, duplex, auto-negotiation, pause frames, EEE,
  MTU and MAC; Advanced for the rest. A port or bridge the config has no section for shows its live facts, says that having no section is normal, and offers
  **Add settings for this device**.
- Footer: Remove (bridge, VLAN device, or the settings), with a note naming the interfaces and VLAN devices that run on the device. Options the page has no control for are listed read only and
  kept; device sections of other types (macvlan, ...) are read only.

**Network-wide settings** (`globalsPanel`; the **Network-wide settings** button above the board): the options of the `globals` section of `/etc/config/network`,
edited through the same draft and the same save as everything else. Editable: **IPv6 ULA prefix** (`ula_prefix`: `auto`, or an IPv6 /48 inside `fd00::/8`;
changing it warns that the local IPv6 addresses of every interface with a delegated prefix length are renumbered, removing it warns that local IPv6 then depends on the
provider's prefix), **packet steering** (`packet_steering`: disabled, enabled, enabled for all CPUs), **netifd log level** (`netifd_loglevel`: critical, warning, notice,
info, debug), and the two VRF socket flags (`tcp_l3mdev`, `udp_l3mdev`). Shown read only: the default DHCP DUID (`dhcp_default_duid`, generated at first boot; a mistake could
cost the provider's lease) and any other option of the section. An empty option is deleted from the file; a router with no `globals` section gets one when something is set.
`flab.network config` returns the section as `globals` (`{ section, anonymous, values, secrets }`, none of its options is a secret) and `null` when there is none; the
`other` counts do not include it. A plugin without the `globals` key gets a description of the options and no controls.

**New network wizard** (`wizard.js`, `wizardmodel.js`; `openWizard(ctx, onDone)`; the **Network** button of the Interfaces lane): a dialog in three steps. 1 *Where does it connect?* an existing device that has
no interface yet (ports that are bridge members come last and are never the default) or the device of another interface, a new VLAN device (base device, ID, name; the ID and name are suggested) or a new bridge (name and ports). 2 *How
does it get its address?* the protocol cards. 3 *Details and name*: the interface name (a free one is suggested from the device), for a static network the address
with a prefix length (a free private /24 that overlaps no interface, tunnel address or route is suggested, with a button to restore it) and an optional gateway, for PPPoE the
username and the masked password. Every step shows what the draft would hold: the model's own validation (`problems()`) runs on a copy and its new errors and warnings are
listed (a taken name, a bad or clashing address, a gateway outside the subnet, a VLAN that exists, a PPPoE name that makes the device name too long; "Next" and "Finish" are
disabled while there is an error). The documentation limits a device name to 14 characters including prefixes (`pppoe-`, `br-`, the `.VLAN` suffix); suggestions respect
it and a name beyond it is a warning (the model itself enforces the kernel's 15). **Finish** adds the bridge or VLAN device and the interface to the draft through the
model functions the panels use; nothing is saved, and the board opens the new interface's panel. The last page lists what the flow does not do, with links: no firewall zone (Firewall page), no DHCP server or
router advertisements (DHCP page), no Wi-Fi network (Wi-Fi page), no static routes (Routing page). While a wizard is open the page does not poll (`wizardOpen()` in the page's
`isPaused`), because the wizard adds to the draft it was opened on; the page's context offers `current()` so the wizard always writes to the latest one.

The controls of one option, the name box, the ports picker, the list of options without a control and the state badge are shared by the panels and the wizard (`controls.js`);
styles are in `css/board.css` (the board and the live bridge information) and `css/netedit.css` (the `np-` rules of the panels; everything wraps with `overflow-wrap: anywhere` and `min-width: 0`).

**Rules and saving**, for all the panels and the wizard:
- **Validation** (errors block Save): IPv4/IPv6 addresses and prefixes, netmasks, MTU ranges, a static address without prefix and without netmask, a gateway outside the
  interface's subnet or equal to its address, two interfaces on the same subnet or with the same address (an overlap is a warning; a disabled interface does not count),
  a device that does not exist (only a warning for one the interface already had), an alias to a missing interface, DHCP and PPPoE option formats, interface and device names (including the
  `pppoe-<name>` length), a VLAN ID, the same VLAN twice, removing a device or interface that another one uses; for a bridge also device names (letters, digits, `_ . : -`, 15 characters, not taken), ports that do not exist or are bridges or listed twice, a port in two bridges, numbers and ranges from the documentation, the query response interval below the query interval. Warnings: no username or password for PPPoE, an MTU above 1492 for
  PPPoE or below 1280 with IPv6, a delegated prefix longer than /64, two interfaces with a default route of the same metric, an interface on a port that is a bridge member; for a bridge a bridge without ports, a forward delay below the 802.1D minimum with STP, the same MAC on two devices, ports the config names that the router lacks.
- **The password is write-only.** The plugin never returns it (nor any other option whose name says it is a secret: a SIM PIN, a modem password, a WireGuard key); the box starts empty and says that one is stored; empty keeps it; the review shows "new value (hidden)".
- **Dangerous changes.** The management network is the interface called `lan` and every interface in a firewall zone that accepts input without NAT; its bridge is the device it runs on.
  Changing its protocol, device, address, netmask, MTU, MAC address, gateway, disabling it, removing it, removing a port from its bridge, switching VLAN filtering and
  removing any interface are listed as warnings in the review banner and, before the change is applied, in a confirmation that says so (and names the address
  the browser is connected at when it is one being changed). Cancel applies nothing.
- **Saving** goes through `applyChange()` like the other editing pages with a **90 second** rollback countdown (set for these calls only through the editor's
  `timeoutS`, which the review banner repeats) and a 4 second settling time (`settleMs`). The check reads the config back through the plugin and netifd's interface dump, retrying for about 10 seconds
  while the network reloads (a failed read during a reload is not yet a failed save), and requires every field of every kept section to read back, new sections to exist, removed ones to be gone, and
  every static interface that was up and is enabled in the form to be up again; otherwise the change is rolled back at once and the message says which interface did not come up.
  Staged leftovers are shown with a "Discard them" button. Unsaved edits survive leaving the page and coming back, and one Save applies them together. A login that may not write, or a router whose plugin lacks `config`, gets the board with a read-only summary in the drawer instead of the editing panels.
- **ACL**: `rpcd/acl.d/flab-network.json` grants `flab.network` `status` and `config` and `uci` `changes` (read), `cable_test` and the `uci`
  write methods (write), and `uci` read and write on the `network` config. It does not grant `uci get`: the pages read the network
  config through `flab.network config` only, so a PPPoE password or a WireGuard key can never reach the browser.

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
Where the bandwidth goes, in four tabs on one page (the tab strip sits in the command bar). Connections is offered when
the router has connection tracking, Usage only when it has `nlbw`, and Settings whenever `flab.traffic` answers (it says so when
nlbwmon is not installed); `flab.traffic status` reports which features exist.
Only the open tab is polled, every 3 s. The connection table, nlbwmon and the settings cost the router more than reading a counter, so
those three tabs reuse their last answer until it is 10 s (Connections, Settings) or 30 s (Usage) old, unless the request changed or
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

#### Settings tab
The accounting settings of nlbwmon, editable through UCI (`/etc/config/nlbwmon`, the one `nlbwmon` section; the config holds no
secrets, so the page reads it with rpcd's own `uci get`). Every option of the init script has a control, the default as a
placeholder when it is not set, and a hint taken from nlbwmon's README, its source and the init script. A login without write
permission sees the same page read-only, with a note. The tab is `settings.js` (cards and saving), `settings-schema.js` (the option
table) and `settings-model.js` (pure: draft, validation, effects, the UCI plan, the check after a save).
- **Tiles**: nlbwmon (running or stopped, its process, and whether it runs with the saved settings: the command line procd reports
  is compared with what the saved options mean), the accounting period now (day N of M, its dates, when the next starts), the
  periods held against the number to keep, and the database (RAM, flash, external or read-only, where it really is and when it was
  last written).
- **What is counted**: `local_network`, a list. An entry is a network name (the init script resolves it to the network's subnets) or
  an address with a prefix or mask (IPv4 or IPv6); a name with a dot or colon is an address to nlbwmon. An invalid entry would stop
  nlbwmon from starting, so it is an error; a name the router does not have is a warning; an empty list warns that nothing is
  counted. The effect line shows the subnets the running daemon counts and the router's network names.
- **Accounting periods and history**: `database_interval` (a day of the month, negative from the end, or `YYYY-MM-DD/N` for every N
  days; the effect line shows the running period for the draft) and `database_generations` (0 to 1000, 0 keeps every period; the
  effect line and a warning name the stored periods that the next start of nlbwmon would delete, worked out the way nlbwmon does:
  every period that began this many periods back or earlier). Changing the interval warns that the stored periods keep the dates they
  were cut at (and that switching between a day of the month and N days may make them unreadable as periods); a start day of 29 to
  31 warns that the shorter months are not documented.
- **Database storage**: `database_directory`, `commit_interval`, `database_compress`. The directory is validated (absolute, at most
  126 characters because nlbwmon refuses longer, letters, digits and `. _ + @ : = , / -` only, no `..`, not `/`, `/proc`, `/sys`,
  `/rom` or `/dev`). The router then says what it is (`flab.traffic nlbwmon_paths`): the real path after links (`/var` is `/tmp`),
  the filesystem and whether it is RAM, the router's flash, external storage or read-only, whether it exists (nlbwmon creates it),
  and the database files in it. A path typed but not saved is asked about after a pause in typing, once per path. A directory that is
  a file, below a file or on a read-only filesystem is an error. Changing the directory warns that nothing is moved: the stored
  periods stay in the old directory and the running period starts from zero in the new one. The commit interval (units `w d h m s`,
  at most 24 days, because nlbwmon multiplies by 1000 into 32 bits) warns when it is under an hour and the directory is not in RAM,
  with the number of writes a day.
- **Polling, memory and protocols**: `refresh_interval` (at least 1 s; a very short or long one warns), `database_limit` (0 for no
  limit; the effect line gives the RAM it can use at roughly 100 bytes an entry and its share of the router's memory, and a very low,
  missing or huge limit warns), `database_prealloc` (warns that it does nothing without a limit), `netlink_buffer_size` (bytes, at
  least 32768, a `K` or `M` suffix is accepted and written in bytes, a buffer under 128 KiB warns) and `protocol_database` (the file
  must exist and be readable; the router is asked, and a missing, unreadable or non-regular file is an error because nlbwmon does not
  start without it).
- **Review and saving**: the shared review banner lists every change from what to what and every error and warning; Save is off
  while anything is invalid. Only what changed is written, an emptied option is deleted rather than set to an empty string, and a
  missing `nlbwmon` section is created. Saving uses `applyChange()`: stage, apply with the 30 s rollback countdown (the apply reloads
  nlbwmon, which writes its counts to disk first and deletes the periods beyond the number to keep when it starts), read the config
  back and compare it, then (when nlbwmon ran before the change) wait until procd shows nlbwmon running with a command line that
  matches the saved options and the same process in two looks 1.5 s apart (up to eight looks). A config that is not kept, a daemon
  that stopped, one that kept the old command line and one that keeps restarting each roll the change back and name the reason. When
  nlbwmon was not running before, only the config is checked.
- **States**: no nlbwmon (no config and no `nlbw`) is a note, not an error and not a form; a config that cannot be read although
  `nlbw` exists is an error note; a missing plugin removes the tab (the page falls back to Live); changes already staged in this
  session are shown with a "Discard them" button; the page does not poll over unsaved edits, a focused control or a save, and an
  unsaved edit survives a change of tab. The Settings tab also uses `service list`, `network.interface dump` and `system info`, which `flab-base.json` grants.

#### The plugin
`flab.traffic` only reads the router; it writes nothing. The ACL fragment
(`rpcd/acl.d/flab-traffic.json`) grants its five methods and `uci get` and `changes` on the `nlbwmon` config under `read`, and
`set`, `add`, `delete`, `revert`, `apply`, `confirm` and `rollback` on the `nlbwmon` config under `write`; there is no generic `file`
or exec grant. Live throughput is not here: it is the counters `flab.network` already reads.
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
- `nlbwmon_paths` (`dir`, `protocols`, each optional): describes the paths nlbwmon's settings name. `dir`: `path`, `resolved` (links
  followed, for a directory that does not exist yet the nearest existing parent plus the rest), `exists`, `is_dir`, `blocked` (not a
  directory, or below a file), `mount`, `fstype`, `device`, `readonly` (from `/proc/mounts`, longest mount point that is a prefix),
  `kind` (`volatile`: tmpfs or ramfs; `readonly`: mounted read-only or squashfs; `flash`: overlay, jffs2, ubifs, `/overlay` or a
  `/dev/mtd`, `/dev/ubi` or `/dev/loop` device; `storage`: anything else; `unknown`: no mount found), and `files` and `total`: the
  database files in it (`<YYYYMMDD>.db` or `.db.gz`, newest first, at most 100) with their size and last write. `protocols`: `path`,
  `exists`, `file`, `size`, `readable`. Each path is checked before any filesystem function sees it (an absolute path of at most 126
  characters for `dir` and 255 for `protocols`, only letters, digits and `. _ + @ : = , / -`, no `..`, no newline); one that fails
  comes back as `{ ok: false, error }` with no data. It uses only `stat`, `lsdir`, `realpath` and `open` of ucode and `/proc/mounts`,
  never a shell, so the rule about the only `run()` calls below still holds.
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
- **Listening**: the TCP and UDP ports the service's processes have open, one chip per protocol and port (TCP first,
  then by port), matched by PID: `flab.services list` also returns `listening` (from `netstat -lntup`, run as root so every
  socket has its owner), and a socket belongs to the row whose procd PIDs include its owner. The chip's tooltip names the
  addresses; a port open on loopback only (`127.0.0.1`, `::1`) is dashed and dimmed, so the ones reachable from the network
  stand out. UDP sockets in the kernel's ephemeral range (`ip_local_port_range`, 32768 and up: the port picked for an
  outgoing query) and sockets that no process owns (WireGuard's, which the kernel holds) are left out. A service that
  procd does not track by PID, or that has no open port, shows a dash.
- **Buttons**: Start (disabled while the service runs; a disabled button keeps the normal look at reduced opacity, as
  `base.css` defines the Bootstrap disabled-state variables for `.btn-fl` and `.btn-brand`), Stop and Restart on every
  init script, then **Disable** for a service that starts at boot or **Enable** for one that does not (the script's own
  `disable` and `enable`, which remove or add the `S<NN><name>` link in `/etc/rc.d`; the running service is not touched,
  and the Start at boot column changes once the list refreshes). The boot-sequence
  scripts (`boot`, `done`, `umount`) have none. While a call runs every button is disabled and the row says
  "Restarting…"; afterwards the outcome is shown above the tiles (green when the script exited 0, red with the
  script's own output when it failed, until dismissed) and the list is refreshed. A login that may not call
  `flab.services control` (`can()`) sees no buttons and a note; without the plugin the page is the read-only procd list.
- **Confirmation** (`model.js`, `riskOf`): stopping or restarting `rpcd`, `uhttpd`, `network`, `dropbear`,
  `firewall`, `wpad`, `dnsmasq`, `odhcpd` or `log`, and disabling any of them at boot, first shows what will happen, in
  plain words, with Confirm and Cancel; nothing is sent before Confirm. The notes that can lock the user out are red
  (restarting `rpcd` signs everyone out, including the user; stopping `uhttpd` or `rpcd` cannot be undone from the page;
  stopping `network` or `wpad` can cut the connection; disabling `rpcd`, `uhttpd`, `network` or `firewall` does nothing
  now but locks the router out or leaves it unprotected after its next restart), the others yellow. Starting and enabling
  never ask.
- **Session loss**: `rpcd` keeps the sessions in memory, so after it restarts the next request is refused and the
  shell returns to the sign-in screen with "Session expired"; the outcome note says beforehand that the session ends.
- **Backend** (`flab.services`): `control` accepts a name that is, as a whole, a plain file name (letter or digit
  first, then letters, digits, `_`, `.` and `-`, at most 64 characters) **and** is in the list of executable files
  of `/etc/init.d`, an action that is exactly `start`, `stop`, `restart`, `enable` or `disable`, and refuses the boot-sequence scripts.
  Only that validated name and action reach the shell command line; nothing else is interpolated. A refused call
  returns `ok: false` and an `error`, and runs nothing. `reload` is not offered because whether a script supports
  it is not known without running it. The reply is `{ name, action, ok, code, detached, output, error }`; `output`
  is the script's output, at most 4096 bytes.
- **Waiting and background**: a call waits for the script (`timeout 45`, shorter than uhttpd's limit) with its
  output going to a file, so a daemon that keeps the output open cannot hold the call up. `stop` and `restart`
  of `rpcd`, `uhttpd` and `network`, which carry the reply or the connection, instead run in the background two
  seconds later and return `detached: true` at once; their result cannot be reported, so the page says the action
  was requested and refreshes a few seconds later. `enable` and `disable` of those services only touch the boot links
  and run in the foreground like any other call.
- **ACL**: `rpcd/acl.d/flab-services.json` grants `flab.services` `list` (read) and `control` (write) and nothing
  generic such as `file exec`; the `service list` call comes from `flab-base.json`.

### Toolbox (route `#toolbox`)
Diagnostic tools that run on the router and show their output as it arrives: a connectivity check, ping, traceroute, MTR,
DNS lookups, a DNS trace and comparisons, a TLS certificate check, an iperf3 server and Wake-on-LAN. The form has a tool
selector, the host, and the options of the tool:
for ping the count
(1 to 60), the packet size (0 to 1400), the address family and the interface to send from (a dropdown of the router's
interfaces, "automatic" by default; the plugin also accepts an address); for traceroute the maximum hops (1 to 30), the probes per hop (1 to 3), UDP or ICMP
probes, whether to look up host names and networks, family and source; for MTR the rounds (3 to 60) and ICMP or UDP; for
DNS the record type (A, AAAA, MX, TXT, NS, CNAME, SOA, PTR, SRV, CAA) and an optional
server; for the DNS trace the record type and the address family; for the comparison the record type and the servers; for
the certificate check the port, a server name and a STARTTLS
protocol; for the iperf3 server the time to run, the port and the address to listen on. A tool is offered only when the router has what it needs (the certificate check needs `openssl`,
MTR needs `mtr`, the DNS trace needs `kdig`, the iperf3 server needs `iperf3`, the DNS tools
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
- **Ping:** figures (sent, received, loss, fastest, average, slowest, jitter) that update while it runs, and a line chart of
  the round-trip time of each ping (the average as a dashed line, the range between fastest and slowest as a band, a lost
  ping as a red cross: busybox prints nothing for a lost packet, so a gap in the
  sequence numbers is the sign of it; with no reply at all there is nothing to plot and no chart), and a plain sentence for
  total loss, partial loss and a name that does not resolve.
- **Traceroute:** one row per hop as it arrives, with the routers that answered (a hop answered by two routers lists
  both), each probe's round-trip time (`*` for a lost probe), the average with a bar, silent hops marked "no reply", the
  destination highlighted, and a note when it was not reached within the hop limit. "Host names" can be switched to "look
  up names": the tool then runs without `-n` and prints `name (address)` for each router, shown as the name with the
  address beneath it; a router with no reverse record is printed as `address (address)` and shows just the address. The
  default is addresses only, because every lookup waits for the resolver and a hop without a reverse record can be slow.
  "Networks (AS)" (on by default, offered when the router has `dig` or `kdig`) turns the job into a script: the traceroute
  is the first block, then each public address that answered (up to 30; private, loopback, link-local, shared-address and multicast addresses are
  skipped) is looked up through the router's own resolver in Team Cymru's DNS service (`<reversed address>.origin.asn.cymru.com`,
  `origin6` for IPv6, and `AS<n>.asn.cymru.com` for the name). Each router then shows its AS number, the organization
  and the country beneath the address, and a line under the table lists the
  networks the path crosses in order. An address that no AS announces (an operator's own infrastructure range, which has no
  origin record) is looked up in RIPE's whois instead (a TCP query to `whois.ripe.net` port 43, for the first 8 such
  addresses of a job; `nc` is needed) and shown as "not announced · NETNAME · country", with the registered range in the
  tooltip; a range RIPE does not manage, or an answer that does not come, leaves "no AS data". The addresses leave the
  router only inside those DNS queries and the whois queries.
- **MTR:** `mtr --raw` against the host for the chosen rounds (one probe a second per hop; ICMP or UDP). The table fills as
  the events arrive: per hop the address, loss with a small bar, probes sent, last, average, best, worst, the spread and a
  sparkline of the delay over time; hops after the first repeated address are cut. Findings in words: whether any probe to
  the destination was lost, a middle hop that shows loss while the later hops do not (it only limits its own replies, so the
  path is fine; shown in green, not as a fault), a destination that never answered, and a jump in delay between two hops. A probe
  still in flight is not counted as lost while the run goes on.
- **DNS lookup:** how it went (the number of answers, NXDOMAIN, SERVFAIL, REFUSED, timeout, or no answer), the server that
  answered, and the tool's own output. The tool is the first of `dig`, `kdig`, `drill` and `nslookup` that the router has;
  busybox `nslookup` cannot show MX, TXT, NS, CNAME, SOA, SRV or CAA records in full (it prints "mail exchanger = 0" with no
  host), so the page says so when only nslookup exists and one of those types is chosen.
- **DNS trace:** the way a resolver finds a name, step by step, as a script that needs `kdig`. It asks a root server
  (a, c, f or m), then the servers each answer points to, down to the zone's own server, with `+norecurse +dnssec`, one block
  per step (`step <n> <address> <name> <zone>`), and ends by asking the router's resolver the same question. A name server
  that came without an address in the referral is looked up through the router's resolver first (`lookup` block); an alias
  (CNAME) restarts the trace from the root for the new name (up to 4 times, `cname` block). Three servers in a row that
  do not answer end the trace, and it stops at 18 steps or 60 seconds. The page shows a summary (the outcome, the
  number of queries, the aliases followed, the time spent waiting), a timing bar with a segment per step, and a ladder of
  cards: the zone, the server asked and its address, the answer time and what it said (a referral with its name servers
  and which came with addresses, an alias, the authoritative answer with its records, or the denial of a name or a type).
  The DNSSEC records of each step are read: a signed delegation (the DS record's key tag, algorithm and digest), an unsigned
  one where the chain of trust ends, and the signature of the final answer (signer, key tag, expiry), summarized as a chain
  that is intact, not complete or absent. The last card compares the router's own resolver (whether it validated the answer,
  the time, the cache age) with the authoritative answer, and says that differences are normal for CDN names. NXDOMAIN
  answers that Cloudflare-style servers give as NOERROR with an NSEC `NXNAME` record are read as NXDOMAIN.
- **DNS compare:** asks the same question of up to six servers in turn: the router's own resolver, the upstream resolvers
  the router was given (read from `resolv.conf.auto`, loopback left out), Cloudflare, Google and Quad9, and one more of
  your choice. A bar chart (fastest first, the fastest marked) shows each server's response time, and a row per server
  shows the result, the addresses, whether the resolver validated the answer with DNSSEC (the
  AD flag), the time the tool reports and the fastest server. Differing answers are highlighted, with the note that a
  CDN gives each resolver its own, correct set; a server that does not answer shows "No reply".
- **TLS certificate:** connects to a host and port (optionally with another server name, or after STARTTLS for SMTP, IMAP,
  POP3 and FTP) and shows the session (protocol, cipher, key exchange) and the certificates exactly as the server sent
  them, in the order sent: the router's own certificate authorities are never used to add or reorder any (`openssl
  s_client` lists the certificates received, not the chain it verified). A "Chain and expiry" picture comes first: the
  certificates as boxes from the server's certificate down to the root (a missing issuer is a dashed placeholder; a root
  the server did not send but the router's store trusts is shown as such), and a timeline with a bar for each certificate's
  validity and a mark for today. A box or bar is red once expired, amber within 14 days of the end, yellow within 60 days,
  green otherwise. Each certificate is then listed with subject, issuer, key and signature
  algorithm, validity with the days left, names, certificate authority flag, serial, SHA-256 fingerprint, and the PEM text
  with a copy button. Findings say whether the chain is trusted by the router's CA store, and judge the chain the server
  sent on its own: a server that sends only its own certificate, a gap or wrong order (a certificate that is not the
  issuer of the one before it), or a chain in order. A dashed marker shows where the issuer is missing; when the router
  trusts such a chain only because its CA store makes up for the missing certificate, the finding says so. Further findings
  say whether the certificate covers the name or address asked for (wildcards match
  one label), whether it is expired, not yet valid or ends within 14 days, a weak RSA key or a SHA-1 or MD5 signature, a
  protocol older than TLS 1.2, and why a connection failed (refused, timed out, name not found, or a server that hung up
  without sending a certificate).
- **iperf3 server:** starts `iperf3 -s` on the router for a chosen time (1, 2, 5, 15 or 30 minutes; 2 is the default) so a
  computer on the LAN can measure the path to the router. The server prints one JSON event per line (`--json-stream`,
  flushed as produced) and stops by itself when the time is up (the job's `timeout` ends it, code 124); Stop ends it
  earlier (iperf3 then exits with 0, so the page records the Stop itself). The port is 5201 unless changed (1024 to
  65535), and the server listens on every address unless one of the router's own addresses is chosen (`-B`); only one
  server runs at a time, and it holds one of the three job slots. While it runs the page shows where it listens, a
  countdown, and "Connect from a computer": the router's addresses (from `network.interface dump`) with the firewall zone of each and
  what that zone does with traffic for the router, the `iperf3 -c` commands to type (upload, `-R` for download, `-P 4`
  parallel streams, `-u -b 500M` for UDP), each with a copy button, and the addresses the firewall blocks folded away.
  A warning appears when a zone that masquerades (the internet side) accepts traffic for the router, because a server on
  every address could then be reached from outside. Each client test shows as it runs: who connected, TCP or UDP,
  upload or download, the streams, the rate now, the peak, retransmits (TCP) or jitter and loss (UDP), and a throughput
  chart; earlier tests are listed in a table with their totals as the receiver (the router) measured them, and an
  interrupted test says why. A trailing sliver of under a quarter second and the duplicate interval iperf3 prints when a client
  aborts are left out.
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
under `/tmp/flab-diag/<id>/`: a ping may run its count plus 10 seconds, a traceroute 60 (with the AS lookups up to 108 more),
MTR its rounds plus 15, a DNS trace 60, a DNS lookup 15, a certificate check 25, a comparison
60, the connectivity check 75 and the iperf3 server the minutes asked for. The check, the comparison, the certificate check,
the DNS trace and a traceroute with AS lookups are small shell scripts (`job.sh`,
written with LF line endings only, because BusyBox sh rejects a carriage return) that print their output in blocks
(`### BEGIN <step> <uptime> <detail>` … `### END <exit code> <uptime>`), which the page
splits and reads; a block without an END line is still running. Every command in a script runs under its own `timeout`, and
a TERM sent to the script (Stop) ends the command at once. `read` returns the output from a byte offset (`from`), cut at the last
complete line while more is still being written, with `size` for the next call and `truncated` when more is pending, so a long
iperf3 server's output is fetched in pieces. At most three jobs run at once,
twelve directories are kept, and a finished job is removed after ten minutes. Everything that reaches the shell is
validated: the tool, the record type and the STARTTLS protocol come from allow-lists, the host, the server name and the DNS
servers are made of letters, digits and `. : _ -` and do not start with `-` (they could be taken for an option), the port is
clamped to 1 to 65535 (1024 to 65535 for the iperf3 server), a comparison takes one to six servers that are each such a name (or `router`), the source is such
an address or an interface name, the iperf3 time must be one of the offered minutes and the address to listen on one of the router's own addresses,
the numbers are clamped to their ranges (a literal 0 is a number, not "absent"), the name-lookup and network-lookup switches must be real
booleans, the argument list is built from those values
only, the job id is generated from `/dev/urandom` and checked as exactly twelve hex digits whenever it comes back, and `stop`
only kills a process whose name is one of the tools (including `mtr`, `mtr-packet` and `iperf3`) or the shell running one of its own `job.sh` scripts (so a recycled pid
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
- **Daemon** (`config odhcpd`): main DHCPv4 server switch, log level, lease file, trigger script, hosts directory,
  and so on, and the **server DUID** (`dhcp_default_duid`), which odhcpd reads from the `globals` section of
  `/etc/config/network` (the only part of that config the page reads, because the rest holds secrets; the ACL
  fragment grants the `network` config for it). Like the pools it is folded to its header (main switch and log level) until opened.
- **Pools** (`config dhcp`, one card per interface, folded to its header until opened, groups collapsible): Services (DHCPv4, DHCPv6, RA, NDP),
  DHCPv4 pool and options, DHCPv6, Router advertisements, Neighbor discovery proxy and Other (including the
  encrypted DNS servers `dnr`, the network device `ifname` and its alias `networkid`): every option odhcpd reads,
  taken from its option tables (`src/config.c`) and its README, and nothing it no longer reads. The header shows the subnet and the
  address range the pool resolves to (start and limit are offsets in the interface's subnet). A folded card or
  closed group that holds an error opens by itself, so an error is never hidden.
  - **Add pool** (below the pools) offers the interfaces that have none and creates a `config dhcp` section named after
    the interface (with `option interface`), as a server for DHCPv4, DHCPv6 and RA with every other option at its default; only options that differ from the default are written.
    **Remove pool** marks a pool for removal (grayed out, with Undo, and a warning that DHCP and RA stop on that
    interface); one added in the form and not yet saved is simply dropped.
  - **Other options** a section holds that no table describes (options of other programs that read the same file,
    such as `dhcp_option` or `force`, and `dhcpv6_raw`) are listed read only at the bottom of the card, so
    nothing in the file is hidden.
- **Leases**: the IPv6 prefixes advertised to clients in router advertisements (a stale one is flagged), DHCPv4 (address, MAC, hostname,
  reserved or dynamic, time left) with a *Reserve* button on every dynamic lease that adds a reservation to the
  form, and DHCPv6 (DUID, addresses, delegated prefixes). The command bar filters all three by text and by
  interface.
- **Reservations** (`config host`): one editable row each with name, IPv4 address, MAC address(es), DUID(s), IPv6
  host ID and lease time, and whether the client holds a lease now. A reservation with only a name and a MAC
  keeps the address dynamic. Rows can be added, removed (shown struck through, with Undo) and edited. New
  sections get their names from uci, so a saved reservation is recognized by its content.
- **Network boot (PXE)** (`config boot6`): one editable row each with the boot file address (`tftp://[fd11::1]/pxe.efi`)
  and the optional architecture code (7 is EFI x64; an entry without one is the default). Added, removed and
  verified like the reservations. Two entries for the same architecture warn.
- **Validation**: field checks come from `core/fields.js`; on top of them an address or MAC reserved twice
  (both rows are marked), the router's own address and a pool that starts beyond its subnet are errors. Warnings
  (they do not block Save): an address outside every served subnet, a pool longer than its subnet, DHCPv4 on an
  interface with no IPv4 address, odhcpd no longer the main DHCPv4 server, a removed pool, advertisement intervals out of
  proportion, the RA flag `none` combined with others, and `managed-config` with DHCPv6 disabled. Every
  reservation needs a MAC or a DUID and every boot entry an address. A value already invalid in the router's file is reported the same way and
  blocks Save until fixed.
- **Not offered**: the pool's `interface` (it binds the pool to its interface and is shown in the header).
- Saving uses the same flow and review banner as System settings (see
  [Configuration changes](#configuration-changes)); a change that includes the DUID stages both configs in one
  apply and the check after the save reads both back, so a change the router did not keep in either is rolled
  back. A pool or daemon change reloads odhcpd, which does not drop
  existing leases. A daemon that is not running is reported, and the configuration stays editable.

### DNS (route `#dns`)
The state of the router's DNS resolver and its settings. It shows what the resolver does and how it is configured, and lets
you change the resolver's **single-valued options** (a yes/no option, a choice, a number, a name) in `/etc/config/unbound` or
`/etc/config/dhcp`, and its **zones** (Unbound's `config zone` blocks, dnsmasq's `server` entries: add, edit, remove, in a dialog);
lists of options are shown read only (edit them in the file). It
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
  the redraws). The header has a badge that says whether the engine runs, in green "Unbound running" (or "dnsmasq running", whichever
  the page describes) and in red "… not running", like the daemon card of the DHCP page, then the config file and how many
  addresses and ports it listens on.
  **General** comes first: the service and its monitoring first (enabled, remote control, statistics, log verbosity; for dnsmasq query
  logging), then *Listening on*: one chip per address and port with its protocols (from `netstat -lntup`, only the resolvers'
  sockets; Unbound's loopback control port 8953 and dnsmasq's DHCP socket are left out), where `0.0.0.0` and `[::]` are marked
  "all addresses" and the engine is named when both run; then listening and interfaces (port, LAN and WAN interfaces, IP protocols,
  EDNS size, DNS64 with its prefix in the same cell, so the prefix is not left alone on a row; for dnsmasq the port, interfaces and upstream servers). Without a resolver the card is only *Listening on*.
  **Security and privacy** is second: who may ask and the rate limit, rebind protection, query privacy and DNSSEC.
  For Unbound it also shows, read only and folded, the domains exempt from rebind protection (`private-domain:`): the ones UCI
  generates for the local names (the local domain and the router's host name) and those listed in `/etc/unbound/unbound_srv.conf` (on the main router the Azure
  private-endpoint names). There is no UCI option for that list, so it is changed in the file: the generator
  (`/usr/lib/unbound/unbound.sh`, identical in OpenWrt's packages master) only writes `private-domain:` for the `domain` option, the
  router's own host name and, with `dhcp_link 'dnsmasq'`, the domains it takes from dnsmasq, and the only lists it reads from the
  `unbound` section are `domain_insecure`, `iface_lan` and `iface_wan`; the README's table of `config unbound` has no such option
  either. The plugin reports the list as
  `private_domains` (`name`, `source` `uci` or `file`).
  The rest follow, folded: Local names and DHCP and Performance and cache (dnsmasq: Local names, Cache, DHCP). Each header gives
  the number of options and, for General and Security and privacy, a line about how they are set (port, interfaces, remote
  control, statistics; DNSSEC, rebind protection, who may ask, rate limit), so a folded area still says something. An "Other
  options" area holds options of the section the page has no description for. The options are described as data in `dns/schema.js`, in the format
  of `core/fields.js`, and drawn with the same controls as the System settings and DHCP pages (`core/forms.js`):
  a checkbox for a yes/no option, a drop-down for a fixed set of values (rebind protection,
  remote control, local domain type, DHCP server linked, IP protocols, recursion, resource profile, log verbosity, the
  router-name levels; the values and defaults are from the OpenWrt Unbound package's README and the dnsmasq manual; a choice that is a
  number in the file (rebind protection, remote control, the names added to the DNS, log verbosity) shows the number before its
  words, "1: Block private addresses (RFC 1918 and 4193)", as the README's tables do: the opt-in `numbered` of a field in
  `core/fields.js`), a number
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
  because it depends on the engine (a page that writes sections of two configs, like the DHCP page, gives a list and a `readAfter`). A login without the `uci` write methods sees the settings read only, with a note. Changes
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
  - The **dialog** (`core/modal.js`: Bootstrap's modal markup and styles on a native `<dialog>`, so Escape and the close button leave it and the focus stays inside; a form keeps a click on the dimmed area from closing it) has
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

### Dynamic DNS (route `#ddns`)
The ddns-scripts client (`/etc/config/ddns`) that keeps a DNS name pointing at the router's changing public address. The page
shows what each service is doing now and edits the config behind it; it needs `ddns-scripts` (and a provider package or a
custom update address) on the router, and says so when it is missing.
- **Tiles**: whether the updater (procd's `ddns` service) runs and how many enabled services it runs, how many services are up
  to date, when the last update was sent and when the next check is.
- **One card per service** (click the header to fold it): the verdict in words, the addresses (the router's, where they come from,
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
  built from those validated words, and anything else is refused with a reason before a command runs. The ACL fragment
  (`rpcd/acl.d/flab-ddns.json`) grants `status` and `log` (read), `control` (write), and `uci` on the `ddns` config only.
- The intervals on a card are the ones the updater really uses: a `force_unit` without a `force_interval` applies the default number
  (72) in that unit, so `minutes` means a forced update every 72 minutes, and a check below the updater's minimum is replaced.

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
folder) with the plugin calls intercepted and answered with the scenario JSON. The Settings, DHCP, VLAN editor and Network panels suites have no
plugin: they unit-test their models and, with `-Browser`, drive the page against a mock (of rpcd's `uci` object; the Network panels suite also needs no router). The other editing suites (Wi-Fi editing, Network editors, Firewall editing, WireGuard editing, nlbwmon settings, Dynamic DNS, DNS, Services) also run their plugin on the router against fixtures.

| Suite | Command | Covers |
|---|---|---|
| BGP | `pwsh -File flab-ui\tests\bgp\run.ps1 [-Browser]` | `flab.bgp` parser and findings, the BGP tab of the Routing page |
| Routing | `pwsh -File flab-ui\tests\routing\run.ps1 [-Browser]` | The Routing model (addresses, tables, findings, filters, lookup meaning, rule origins); `flab.routing` against a captured and a synthetic router (every route and rule syntax, every lookup answer, refused input); the Routes tab, the lookup and the BGP tab against mocked replies |
| Toolbox | `pwsh -File flab-ui\tests\toolbox\run.ps1 [-Browser] [-KeepWork]` | The Toolbox model (request checks, the parsers of ping, traceroute, DNS, comparison and certificate output, the connectivity check's verdicts, MAC handling) and, from real captures, the parsers of the iperf3 events, the DNS trace and mtr and the AS data of a traceroute; `flab.diag` running real jobs on the router (streaming, offsets, stop, DNS, traceroute, mtr, a DNS trace, an iperf3 server with a loopback client, the router's own certificate, a comparison, a whole connectivity check, a Wake-on-LAN packet on loopback, every allowed option, 83 refused tool requests and 18 refused wake requests with an injection canary, job-id traversal, the three-job cap, CRLF source); the page against a scripted job engine |
| Traffic | `pwsh -File flab-ui\tests\traffic\run.ps1 [-Browser]` | The Traffic model (interfaces, WAN, totals, findings, endpoints, NAT, states, merging hosts by MAC, filtering and sorting, protocol rows); `flab.traffic` against a captured and several synthetic routers (every protocol, TCP state, NAT form and IPv6 spelling, a 60000-entry table, nlbwmon periods, no nlbw, no conntrack, no accounting) checked against an independent reference, and every refused argument; the Live, Connections and Usage tabs against mocked replies (the Settings tab is covered by the nlbwmon settings suite) |
| IPsec | `pwsh -File flab-ui\tests\ipsec\run.ps1 [-Browser]` | `flab.ipsec`, IPsec page, throughput history |
| Network | `pwsh -File flab-ui\tests\network\run.ps1 [-Browser]` | `flab.network`, `flab.radio`, `flab.mesh`, `flab.wireguard`, `flab.firewall`, `flab.logs`; Wired network, Devices and Interfaces (the bridges on its board), Wi-Fi, Mesh, WireGuard, Firewall and Logs pages; navigation order; unit tests of the shared helpers (including the session, `uci` and `applyChange` layer) |
| Settings | `pwsh -File flab-ui\tests\settings\run.ps1 [-Browser]` | System settings model, option table and zone table; the whole editing flow against a mock router |
| DHCP | `pwsh -File flab-ui\tests\dhcp\run.ps1 [-Browser]` | DHCP model (address helpers, reading config and leases, validation, change plan); the page against the router's own data, then the whole editing flow against a mock router |
| DNS | `pwsh -File flab-ui\tests\dns\run.ps1 [-Router ...] [-Url ...] [-Browser]` | The DNS model (tiles, findings, activity, options) and the zones (Unbound's blocks of every type and dnsmasq's entries: drafts, order, changes, validation, the UCI operations, the checks after a save); `flab.dns` against a captured and several synthetic routers (Unbound with and without extended statistics or `unbound-control`, dnsmasq, both, stopped, none, cut lists) and a call with shell metacharacters as arguments; the page against mocked replies, including adding, editing, removing and saving zones |
| Wi-Fi | `pwsh -File flab-ui\tests\wifi\run.ps1 [-Browser]` | Wi-Fi channel model (blocks of channels, errors and warnings, change plan); the radio cards and pickers against the router's own data, then the whole channel-change flow against a mock router |
| Wi-Fi editing | `pwsh -File flab-ui\tests\wifiedit\run.ps1 [-Browser]` | The editing model (reading, draft, review, validation, warnings, UCI operations, check after a save, what to wait for); `flab.radio config` and `status` against fixtures (nothing is executed) and a read-only run on the router with a check that none of its stored Wi-Fi secrets is in a reply; the radio settings and network editors against the router's own configuration, then the whole editing flow against a mock router |
| Network editors | `pwsh -File flab-ui\tests\ifedit\run.ps1 [-Browser]` | The editors of the Devices and Interfaces page (the panels in the drawer): the model (value checks, option tables, draft, review, validation, dangerous changes, UCI operations, check after a save); `flab.network config` (the `globals` section included) against fixtures with a secret in every kind of place and a read-only run on the router; the board against the router's own data, then the whole editing flow against a mock router |
| Network board | `pwsh -File flab-ui\tests\netboard\run.ps1 [-Browser]` | The board model (lanes, edges, protocol devices, tunnels, wireless, the draft's new and removed items, highlighting, findings, counts) and the pure parts of the drawer and of the bridge information; the board against the router's own data (read only) at 1920, 1280 and 900 px in both themes, the drawer, the Device menu, highlighting, leaving the page and the old `#bridges` route |
| Network panels | `pwsh -File flab-ui\tests\netpanels\run.ps1 [-Browser]` | The panel and wizard model (protocol cards, essential and advanced options, device chooser, what a protocol change drops, used by, suggestions, the wizard's draft effects, validation and plan); with `-Browser`, the real panels, drawer and wizard against a stateful mock of the network config, served by a local web server (no router, nothing to deploy) |
| VLAN editor | `pwsh -File flab-ui\tests\vlanedit\run.ps1 [-Browser]` | The VLAN editor's model (reading the sections, the tables of a bridge and of a swconfig switch, the draft, the review, validation and lockout warnings, the UCI operations, the check after a save); the Wired network page against the router's own config (read only), then the whole editing flow of a bridge and of a swconfig switch against a mock router |
| WireGuard editing | `pwsh -File flab-ui\tests\wgedit\run.ps1 [-Browser]` | The WireGuard model (address math, keys, draft, review, UCI plan, validation, the tunnel you work through, check after a save, add-a-device helpers); `flab.wireguard` against fixtures and read only on the router; the page against the router's own interfaces, then the whole editing flow against a mock router |
| Firewall editing | `pwsh -File flab-ui\tests\fwedit\run.ps1 [-Browser]` | The Firewall editing model (reading, draft, zones, forwardings, rules, port forwards, defaults, validation, the lock-out check, UCI operations and section order, the check after a save); `flab.firewall` against fixtures and read only on the router; the page against the router's own firewall (read only), then the whole editing flow against a mock router |
| nlbwmon settings | `pwsh -File flab-ui\tests\nlbwedit\run.ps1 [-Browser]` | The nlbwmon settings model (reading, every option's validation, the accounting window and the periods a lower count deletes, effects, warnings, the UCI plan, the check after a save, the daemon check); `flab.traffic nlbwmon_paths` against fixtures (RAM, flash, USB, read-only, network share, a missing or blocked directory, 100+ files, no `/proc/mounts`, refused paths) and once for real; the Settings tab against the router's own config, then the whole editing flow against a mock router |
| Services | `pwsh -File flab-ui\tests\services\run.ps1 [-Browser]` | Services model; `flab.services` against fixtures (nothing is executed) and a read-only `list` on the router; the page against the router's own services, then the whole start, stop and restart flow against a mock |
| Dynamic DNS | `pwsh -File flab-ui\tests\ddns\run.ps1 [-Browser]` | Dynamic DNS model (reading, draft, validation, change plan, check after a save, verdicts, intervals, log parsing); `flab.ddns` against fixtures (nothing is executed) and a read-only `status` and `log` on the router; the page against the router's own services, then the whole editing and action flow against a mock |

`-Browser` needs the UI deployed (`deploy.ps1 -Action Deploy`, or `-Action Sync` after a front-end change) and signs in with a temporary rpcd session that
`tests/TestSession.ps1` creates over ssh, grants what the ACL fragments grant, and destroys afterwards, so no
password is needed. Every suite removes its local temp folder when it finishes, and the BGP, IPsec, Routing and network
suites also remove their `/tmp/flab-*-test` folder on the router. When several people or agents share one router, run a suite through `tools/router-lock.ps1` (see [Deploy, test, clean up](#deploy-test-clean-up)).

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
certificate's findings) and the browser test. `fixtures/` holds output the tools really printed on the router (iperf3 3.22
`--json-stream` events of TCP, reverse, UDP, an aborted client and a busy port; the DNS trace script's job output for
example.com, a name behind two aliases, an in-zone alias, a name that does not exist and an IPv6 trace; `mtr --raw`; a
traceroute with its AS lookups), read by `tools.test.mjs` (the requests the form builds for mtr, the trace and the iperf3
server, the iperf3 events, the DNS trace, the mtr table and the findings about it, the AS data) and by the browser test. `flab.diag` is tested for real, not
against fixtures, because starting, reading, offsets and stopping are what it does: `run.ps1` runs the plugin with CRLF line
endings, as a Windows checkout deploys it, starts pings, a traceroute
and DNS lookups against 127.0.0.1 and localhost on the router, reads them while they run and after, reads from the end and
from an offset, stops one and checks that no process is left, starts every allowed option and compares the command line,
checks the router's own HTTPS certificate (the fingerprints, serials and dates it printed are compared with what Node
computes from the PEM text in the same output), a STARTTLS run against a closed port, a comparison of the router
against 127.0.0.1, and a complete connectivity check (whose script must carry no carriage return; a second one is stopped
half way, to see that a script job ends and leaves no ping or openssl behind), an mtr run and a traceroute with AS lookups
against loopback (no address to look up), a DNS trace of example.com from the real root servers, and an iperf3 server on
a spare port with an iperf3 client on loopback (the server reports the test, a second server is refused, Stop ends it and
no iperf3 is left),
sends the 83 lines of `refusals.txt` (shell metacharacters, leading `-`, out-of-range and non-numeric numbers, bad
sources, servers, ports, server names, protocols and types, rounds, minutes and addresses to listen on; several would create a canary file if a command ran) and checks that all were refused, no job
appeared and the canary does not exist, tries six job ids that are not the plugin's own (paths, wrong length, empty) on
`read` and `stop`, sends a Wake-on-LAN packet out of the loopback device (where nothing hears it) and the 18 lines of
`wake-refusals.txt` (a bad MAC, injections in the MAC and the interface, an interface that does not exist, wrong types), and starts four jobs to see the fourth refused. `live.mjs` answers `flab.diag` from a scripted job
engine (output revealed piece by piece, an endless ping, a refused start, a script that cannot run; the browser clock is held
at the day the samples were captured so the days left on a certificate do not drift) and drives the page: the navigation
entry above Logs, the form's checks, a ping
read while it runs and after, loss, no reply and a bad host, the ping chart, the options sent, stopping, traceroute (partial, not
reached, IPv6, with the networks of the hops), mtr, the DNS trace (a plain trace, two aliases, a name that does not exist, IPv6), DNS (answers, NXDOMAIN, the nslookup note), the connectivity check (a healthy router, a broken resolver, a dead
next hop, a script that fails), the comparison (the choices offered, rows arriving, DNSSEC, the fastest, the response-time chart, a silent server), the certificate check (a good chain, the chain and expiry pictures, an expired certificate, a server that sends only its own certificate, a gap in the chain, the
PEM copy, expired, self-signed, hung up, refused, STARTTLS, a router without openssl), Wake-on-LAN (the host list with reservations first, a typed MAC, a bad MAC, a normalized
MAC, a chosen interface, a host without an address, a refusal from the router, etherwake and socat, the Ping button, a router with
neither tool, a login without the wake permission), the iperf3 server (the form, the countdown, the connect commands, tests
arriving, Stop, the time running out, a port below 1024, an exposed zone), a router without mtr, kdig or iperf3, leaving the page and coming back, a redraw
in the middle of a job, a login that
may not run diagnostics, and the dark theme (with the new views). `-KeepWork` keeps the temporary folder so the browser test can be repeated.

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
- **Unit tests** (`tests/network/*.test.mjs`, no router): `rates` (the rate tracker), `firewall` (zone matrix and findings), `logs` (level and text filters,
  summaries, formatting) and `uci` (the session helper `can()`, `optional()`, the `uci` wrapper and `applyChange`
  against a fake transport).
- **Scenarios**: `n-linkdown`, `n-downshift`, `n-root`, `n-blocked`, `n-nostp`, `n-vlanfilter`, `n-newbridge`,
  `n-highport`, `n-nodevices`, `n-board` (a different router: other model, four LAN ports in reverse order, no
  external PHY), `n-nodsa` (no switch), `n-errors`; `n-sfp` (an optical module with an alarm, an empty cage and a
  direct-attach cable), `n-vlantable` (the kernel's `bridge vlan show`, with continuation lines and a port that is not a
  member), `n-vlanconfig` (no `bridge` tool: the `bridge-vlan` sections, one of another bridge), `n-swconfig` (an older
  board: the DSA ports removed, `swconfig list/help/show` fixtures, VLAN devices `eth0.1` and `eth0.2`, a swconfig
  `board.json`), `n-cable` (see below); radios `r-down`, `r-dfs`, `r-channel`, `r-disabled`,
  `r-newssid`; mesh `m-twopeers`, `m-weak`, `m-fwdoff`, `m-nopeer`, `m-down`, `m-nomesh`; WireGuard `w-stale`,
  `w-down`, `w-newpeer`, `w-noroutes`, `w-nozone`, `w-nowg`; firewall `f-stopped`, `f-redirect`, `f-exposed`,
  `f-disabled`, `f-anonymous`, `f-unzoned`, `f-conntrack`; logs `l-odd` (a secret, an unparsable line, an
  unknown severity, another kernel facility) and `l-empty`. A capture's handshake times age while the test
  runs, so the base scenario pins the connected WireGuard peer to "30 s ago".
- **Cable test**: `cable-harness.uc` makes the calls of `n-cable` (an intact cable, open pairs, a short with its distance, a PHY
  that cannot test (asked twice, the second time answered from memory), output that is not a result, and the refusals: the
  SoC link, a bridge, an unknown name, `lan1; reboot`, a number, no argument). Every refused port also has a fixture that would
  read intact, so a refused call that ran anyway would show up as ok. The harness refuses to run without fixtures, so no
  cable is ever tested and no link ever drops during the suite; the browser test answers the call from the same results and
  fails if one would reach the real router.
- **Browser** (`live.mjs`) additions: the MAC boxes and which jacks show a MAC, the CPU link (percent used, a busy link
  in the box and the banner, oversubscription), an optical module (tag, amber tile, banner, module and optics lines, no cable
  test on a cage), EEE badges, the VLAN cards (kernel table, config table, filtering with no VLAN, none at all), an older swconfig
  board (jacks, circles, CPU link, port table, VLAN groups), and the whole cable-test flow (confirmation text for a port
  with and without link, Cancel, the four results, survival of a poll, Close, the downshift hint, a PHY that cannot test, a
  port known not to support it, and a login without write permission). The bridge and interface checks use the Devices and Interfaces board: the bridge cards and, through `bridgelive.js`, the live
  bridge information (STP root, mesh peers, a blocked port, STP off, a second bridge, no devices), and the interface cards (what each sits on, hover highlighting, zone cards, routes and prefixes under "details", an unknown
  device kept, an unattached Wi-Fi interface in the findings).

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
Same shape as the Settings suite, with no backend part. `model.test.mjs` covers the option tables (checked against
odhcpd's own option table: every option edited, none that odhcpd no longer reads), the address
and range helpers, reading `uci get dhcp` with the lease replies (leases mapped from device to interface),
validation, the change plan (reservations added, removed and edited, pool and daemon options, pools added and
removed, network boot entries, the server DUID in the network config) and the read-back
check; `network/uci.test.mjs` covers `applyChange`. The browser pass (`live.mjs`) first shows the router's own
leases, reservations and pools with every uci write blocked, then switches to a stateful mock of `uci` (two configs),
the `dhcp` object, the interface dump and `service list` and drives filtering, reservation edits (duplicates, the
router's own address, bad MACs, Reserve from a lease, Add, Remove and Undo), pool and daemon edits, adding and
removing pools, network boot entries, the server DUID, options without a control, a successful
save across both configs, a change the router does not keep (also in the network config), a late confirmation, a stopped odhcpd, dnsmasq serving DHCPv4 (leases read
from its lease file, an unreadable file), a login without write access,
the dark theme and an expired session.

### Wi-Fi suite
Same shape as the DHCP suite. `model.test.mjs` covers the width of an htmode, the block a channel would occupy
(fixed blocks on 5 and 6 GHz; on 2.4 GHz the second half and the covered and overlapped channels, including
netifd's rule for the side), the blocks a radio is running on, the channel part of the draft, the errors and warnings (not allowed, no
room for the width, DFS, mesh, auto), the operations and the read-back check; `network/uci.test.mjs` covers
`applyChange`. The browser pass (`live.mjs`) first shows the router's own radios with their pickers, with every uci
write and `uci get` blocked, then switches to a mock of the radio and Wi-Fi plugins (including `flab.radio config`) and a stateful mock of `uci` and drives hover
previews (fitting and not fitting, 2.4 and 5 GHz, keyboard focus), choosing, undoing, Auto, the banner and its
warnings, a page that does not poll over a pending choice, a successful save (only the channels written, the config read back through
the plugin and never with `uci get`), a change the router does not keep, a radio that does not come back (rolled back),
leftovers from an earlier attempt, a login without write access, the dark theme and an expired session.

### Services suite
Never starts, stops or restarts a service: every control call is either answered by a fixture or by a mock.
- **Unit tests** (`model.test.mjs`, no router): merging the init scripts with procd's list (states, services
  without a script, a missing plugin), the ports of a service's pids (grouping, scope), the filter, the summary, the buttons a row offers, the confirmation table
  (which services ask, the level, that `rpcd` says the session ends) and the outcome texts.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`; the calls and the expected command lines are in `cases.mjs`):
  `flab.services.uc` runs on the router with `FLAB_FIXTURES`, so it executes nothing: for each call it finds, in
  a fixture file named after the command line it builds, what that command would have printed. Scenarios `ok`
  (exit 0), `fail` (exit 1 with output), `timeout` (exit 124) and `noresult` (no exit code). The test checks the
  listing (sorted, boot state and position, junk names dropped, protected scripts), the listening sockets (parsed from a
  real `netstat -lntup` capture: repeated lines, IPv6 wildcard, loopback, a kernel socket, ephemeral UDP ports), the waited calls, the calls
  that must run in the background, and 32 refused requests (protected scripts, an unknown service, names such as
  `../../bin/sh`, `dropbear; reboot`, `-h`, a name with a line break or longer than 64 characters, wrongly typed
  or missing arguments, actions `reload`, `toggle`, `restart; reboot`, `RESTART`, `ENABLE`, `enable; reboot`; enabling or
  disabling a boot-sequence script or an unknown service): each has a fixture that would report
  success if its command were run, so a refused call that ran anyway shows up as `ok`. `enable` and `disable` are also
  checked to run in the foreground for `rpcd`, `uhttpd` and `network`. The harness refuses any
  call but `list` when no fixtures are set. `list` is also run once for real (it only reads) and compared with the
  router's `/etc/init.d` and `/etc/rc.d`.
- **Browser** (`live.mjs`): the page first lists the router's own services with any `control` call blocked and
  failing the test, then a mock of `service` and `flab.services` drives the ports of each service (chips, loopback-only
  dimming, tooltips, a socket nobody owns), the buttons, the confirmation (warning and
  danger levels, Cancel sends nothing), enabling and disabling at boot (the button that swaps, the boot column, the
  questions for the critical services, no end of the session for `rpcd`), buttons disabled while a call runs, success, a failing script with its
  output, an error from the router, stop and start without a question, a background restart, a login without
  permission, a missing plugin, the dark theme, a session that ends during a call, and `rpcd` restarted from the
  page (back to the sign-in screen).

### Dynamic DNS suite
Never changes the router's configuration and never restarts an updater: every write and every `control` call is either answered by a
fixture or by a mock, and blocked (failing the test) in the phase that talks to the real router.
- **Unit tests** (`model.test.mjs`, no router): reading the plugin's reply, the draft, which controls apply, the name and value checks,
  the errors and warnings, the UCI plan (a secret is written only when typed, an unchanged option is not written, a removed option
  is deleted only when it exists), the check after a save, the verdicts, the intervals as the updater really uses them, and log
  parsing.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`; the calls and the expected command lines are in `cases.mjs`): `flab.ddns.uc`
  runs on the router with `FLAB_FIXTURES`, so it executes nothing. Scenarios `main` (five services: secrets in several places, three
  address sources, a stopped updater, a custom provider, a log over the size limit, a device named like an option), `fail` (the init
  script exits 1 with output), `timeout` (exit 124), `noresult` (no exit code) and `empty` (no ddns-scripts). The test checks that no
  secret appears anywhere in any reply, the run-file times (uptime stamps become epoch times, a stamp from the future is ignored),
  the problem and fatal-error detection, the address of each source, the providers (a custom one overrides a default, bad lines are
  ignored), the log (masked, cut at 64 KB), and the refused requests (unknown or disabled services, names such as `home; reboot`,
  `../../etc` and a name with a line break, wrongly typed or missing arguments, other actions): each has a fixture that would
  report success if its command were run, so a refused call that ran anyway shows up as `ok`. The harness refuses `control` when no
  fixtures are set. `status` and every service's `log` are also run once for real (they only read): the reply is compared with
  the router's config, and the number of times a stored secret appears in it is counted on the router (only the count leaves it).
- **Browser** (`live.mjs`): the page first shows the router's own services, with every `uci` write and `control` call blocked and
  failing the test; then mocked replies and a stateful `uci` mock drive the tiles, the verdict of each kind of service, the actions
  (busy state, success, a failing init script), the log (filter, every line, scroll), editing (validation, the write-only password
  and its review text, the provider switch), saving, adding and removing services, a change the router does not keep, staged
  leftovers, a stopped updater, a missing ddns-scripts or plugin, a login that may not write or run actions, the dark theme and a
  session that expires. It also checks that the page never calls `uci get`.

### Wi-Fi editing suite
Never changes the router's configuration (the only things created on the router are the fixtures and the plugin copy in
`/tmp/flab-wifiedit-test`, removed afterwards).
- **Unit tests** (`model.test.mjs`, no router): reading the plugins' replies (editable and read-only data, live state joined by
  section name), the draft (strings, booleans, lists, "none" as the open choice, secrets empty), the review list (a password is
  never shown), the operations (only changed options, emptied options deleted, one value of `network` as a plain option, a
  password written as typed and removed when it no longer applies, added networks as named `add`, removed ones as `delete`,
  hidden options neither written nor compared), adding and removing networks, every validation and warning, the check
  after a save (including an unnamed section that got a new name, an added and a removed network, a password that did not
  stick) and what to wait for.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): the repository's `flab.radio.uc` runs on the router against fixtures
  (`FLAB_FIXTURES`): a router with three radios (one running, one switched off, one whose phy is unknown), access points and a
  client network that hold every kind of secret (including a passphrase with spaces, a hex key, an option named like a secret,
  `wifi-station` and `wifi-vlan` sections), a mesh interface, an unnamed section, a smaller hostapd, no hostapd and no radios.
  It asserts the documented fields, the names of the secrets (never their values), that options that only look like secrets (a
  `wpa_psk_file` path, an `r1_key_holder`, `ft_psk_generate_local`) are returned, the htmode lists (from `iwinfo`, derived from
  the phy, unknown), the countries, the hostapd features and the networks, and that no canary appears anywhere in `config` or
  `status`. It then runs both methods for real (they only read) and counts how often any of the router's stored Wi-Fi secrets
  appears in the replies (it must be zero; the count of secrets looked for must not be).
- **Browser** (`live.mjs`): first the router's own configuration with every uci write and every `uci get` blocked (a settings
  block per radio, an editor per network, empty password fields that say one is stored, a hint on every option), then a mock of
  `flab.radio` and a stateful mock of rpcd's `uci` object: the radio settings (mode list from the hardware, band-specific
  options, validation, disabling a radio), a mode that decides which channels fit, a successful save (only the changed options
  written, read back through the plugin), renaming a network with clients, a new password (never visible), an unnamed section,
  validation of names, passwords and network lists, the dangerous changes, the MAC filter, 802.11r and enterprise options
  appearing when they apply, adding, discarding and removing networks, a change the router does not keep, a radio and a new
  network that do not come back, a refused confirmation, leftovers from an earlier attempt, a login without write access, a plugin
  without `config`, a router without the radio plugin, the dark theme and an expired session.

### Network editors suite
The Devices and Interfaces page (the board and the panels in its drawer). Never changes the router's configuration: every write is answered by a mock, and blocked (failing the test) in the phase that talks to the real router.
- **Unit tests** (`model.test.mjs`, no router): netmasks, prefixes and subnet math; the value checks; the option tables (unique ids and options per protocol and device type, a hint on every field);
  reading the plugin's reply (a reply of another shape is "unavailable"); the router's devices; an untouched draft changes nothing; the UCI plan (a list for addresses, a deleted emptied option, flags as 1/0,
  a secret only when typed, an interface with a protocol the page does not edit never written, a protocol change deleting the old protocol's options first, defaults that follow the protocol, new and removed
  interfaces and devices, a port moved between bridges, the network-wide `globals` options); every validation rule; which interfaces are management interfaces and which changes are dangerous; the check after a save against an independently
  built "router after the plan"; interfaces that are down after a change.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.network.uc` runs `config` on the router with `FLAB_FIXTURES` (scenarios `main`: a PPPoE password, a WireGuard private and pre-shared key, a SIM PIN, a modem
  password, `psk` and `key` options and a canary in each, anonymous and named sections in a shuffled key order, other section types, bridge VLANs, a `globals` section; `empty`; `missing`). It asserts that no canary appears in any reply,
  that the secrets are only flagged, that `keepalive` is not taken for a key, file order, list options, the counts of other sections, the `globals` reply. The harness refuses every call but `config`. `config` is also run once for real
  (only reads): the counts match `uci show network`, and the number of times a stored secret appears in the reply is counted on the router (only the count leaves it) and must be zero.
- **Browser** (`live.mjs`): the board first shows the router's own configuration with every write blocked (the panels of the PPPoE interfaces, the bridge and the network-wide settings open read only on the real data); then a stateful mock of rpcd's `uci` object and mocked flab.network and netifd replies drive
  reading (cards, values, hints, read-only protocols, the stored password never in the page), validation, a protocol change through the protocol cards, the write-only password, adding a VLAN network with the wizard (a new VLAN device and interface, applied and confirmed), adding, discarding and removing interfaces, VLAN devices and port settings, a risky change and its
  confirmation (Cancel applies nothing), the 90 second countdown on the apply call, a change the router does not keep, an interface that stays down after the change, a refused confirmation, staged leftovers, moving ports
  between bridges, the network-wide settings, a login that may not write, a login without the config call, a plugin without it, a reply of another shape, the dark theme, edits surviving leaving the page, the panel closing when its card is gone or the page is left, the board following the form (new cards, names, devices), the old `#bridges` route and an expired session. The selectors of the panels' contents are in the helper block at the top of `live.mjs`.

### Network board suite
Never changes the router's configuration: every `uci` write is blocked (and fails the test); the draft lives in the page only.
- **Unit tests** (`boardmodel.test.mjs`, no router): the lanes and their order (front-panel position first, tunnels last); the conduit and swconfig pseudo ports hidden unless used;
  bridges grouping ports and Wi-Fi, VLAN devices on a port or a bridge; PPPoE over a VLAN; a second VLAN on one port; an interface riding on another's protocol device (`wan6`);
  tunnels with and without `tunlink`; an interface directly on a port; an unknown device; zones, services and the "No zone" card; the highlighting set (what an item is built on and what
  is built on it, not its siblings); findings (down, pending, unattached wireless, no protocol) and the counts of the tiles; loops and empty routers; wireless (radio groups, bands, mesh, a
  configured interface that is not running joining its bridge, a station interface under an interface, radios without interfaces, no radio data); the draft (items keep their id while a name is typed,
  new and removed sections, a device moved in the form moves the edge, the settings of a port as a mark on the port, a VLAN or bridge of the form, a bridge with a port the router lacks, no editor).
  `drawer.test.mjs`: when a key closes the drawer, footer normalization and the mesh peers of the bridge information.
- **Browser** (`live.mjs`): the board at 1920, 1280 and 900 px in the light and dark themes against the real router: no sideways scrolling, no card whose text overflows, no overlapping cards,
  every card inside its lane, four lanes with connectors that start and end on card sides (stacked lanes, no connectors below 760 px of board width); hover highlighting; the drawer (opens with a
  title, is full height on the right edge, makes room on a wide screen, another card replaces its content, survives a refresh, Escape and the close button, a zone's read-only recap, closes when the page is left);
  the Device menu (Escape and a click elsewhere close it, adding a bridge puts a new card on the board and opens it, Discard edits removes it); the Network-wide settings button; the old `#bridges` route.

### Network panels suite
Needs no router: it never connects to one and needs no deploy. Unit tests (`panelmodel.test.mjs`, with `fixture.mjs`, a router
of the shape of a real one and a mock of what rpcd does with the UCI operations of `plan()`) cover the protocol cards, the essential/advanced split (every essential
option exists for its protocol), the device chooser, what a protocol change drops (and that the model drops exactly that), what interfaces and devices are used by,
the free /24 (overlap with live addresses, routes, tunnel addresses and addresses typed in the form, exhaustion), name suggestions, and the draft effects of every wizard
choice with its validation and plan. With `-Browser`, `live.mjs` serves `www/` and `tests/netpanels/` from this checkout, opens `harness.html` (the real
`panels.js` in the real `core/drawer.js` over the real stylesheets, against the mock) in Edge and checks: the sections and essential/advanced controls, a protocol card click and
what it drops, the device chooser, the write-only password (typed, reviewed, saved, read back as "set"), read-only protocols, removal and Undo with the dependants rule, the
bridge ports picker and live information, VLAN and port panels, the network-wide settings (edit, validation, save, a plugin without the section), a login that may not write (everything disabled, the wizard refuses), the wizard end to end
for a new bridge, a new VLAN device with PPPoE and an existing device with DHCP (saved and read back through the model's check), the wizard's validation, no horizontal
overflow of the panels and the wizard with long IPv6 addresses and names at 1920, 1280, 900 and 480 px, light and dark screenshots (`FLAB_SHOTS`), no script errors and no
request outside the local server.

### VLAN editor suite
Never changes the router's configuration: every `uci` write is blocked (and fails the test) in the phase that talks to the real
router, and the editing flow runs against a stateful mock of rpcd's `uci` object. There is no backend part: the editor adds no
plugin.
- **Unit tests** (`model.test.mjs`, no router): the port entries and tokens, the sections as `uci get` returns them
  (anonymous and named, the `name` option of a device section), the tables (columns from the device section, a port named by a VLAN
  but not in the bridge, the interfaces of the router on the bridge's VLANs and the management one, a kernel table against the
  config), the draft, the review text and the UCI operations (only what changed is set, untouched entries keep their spelling, `local`,
  an emptied row, a new or removed VLAN, filtering, `enable_vlan`, a swconfig group's tokens and `vid`), every error and warning, and
  the check after a save (a config that holds the draft, one that kept nothing, other members, a switch that stayed).
- **Browser** (`live.mjs`): the Wired network page first shows the real router read only: the bridge without a table offers
  **Set up VLAN filtering**, the editor opens with the real `br-lan` and its filtering state, every `uci get` carries a section
  type (never the whole network config), **Done** closes it, and nothing is staged or written. Then a mock router (the real
  status of the router with the bridge's VLAN table and filtering following a mocked network config that also holds an interface
  with a password) drives: the read-only card, the cells, the PVID error and its two marked cells, the review text, saving (the
  order of the calls, the ports written in the notation of the file, the read-back by type), adding (an id out of range, one in
  use, Enter, the validation of the new row) and removing a VLAN, the lockout warnings, VLAN filtering off and turning it on, a
  router that applies nothing, one that refuses the confirmation, staged leftovers, a kernel table that differs, an older swconfig
  board (the groups, the CPU port, the `vid`, the untagged-once rule, a new group, `enable_vlan`; mock only, since the router has no
  swconfig switch), a login that may not write or may not read, and a session that expires while saving.

### WireGuard editing suite
Never changes the router's configuration: every uci write is answered by a mock, and blocked (failing the test) in the phase that talks to the
real router.
- **Unit tests** (`model.test.mjs`, no router): the address math (parsing, netmasks, IPv6 text, overlap, the next free host, endpoint
  checks), the keys (X25519 against the RFC 7748 vectors, WebCrypto against the plain implementation, clamping, the key text check), reading the
  plugin's reply (also from a plugin without the new fields), the draft, the review list, the UCI plan (only what changed, deletes only of options
  that exist, a key only when typed, a new interface and its peers, a removed interface and its peers), every validation, the sessions that belong to
  a tunnel and each warning about cutting it, the check after a save (kept, not kept, a key stored, a new peer found by its public key, a removed one
  gone, an interface that did not come up, a peer that did not load, what is not expected to run) and the add-a-device helpers (the next address,
  refusals, the allowed IPs, the configuration text, the file name).
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.wireguard.uc` runs on the router with `FLAB_FIXTURES`, so it executes nothing. Scenarios
  `main` (a running interface with three peers, pre-shared keys, a peer whose public key option holds a pasted secret, a disabled peer; a disabled
  interface without a running tunnel; an interface and a peer only the kernel has; a firewall zone; `/proc/net/tcp` and `tcp6` with connections on
  the default, uhttpd and dropbear ports from IPv4, IPv4-mapped, native IPv6 and loopback addresses, plus listening, closing and unrelated sockets)
  and `empty` (no WireGuard, no protocol handler). The test checks the options and their secret flags, that no key, token, password or pasted secret
  (canaries) is anywhere in a reply and no secret-named option among the options, the order of interfaces and peers, the names list, the sessions
  (addresses of both families, the ports, no duplicates). It also runs `status` once for real, which only reads: the count of the router's stored
  keys that appear in the reply is zero (only the count leaves the router), every `wireguard_*` section is reported by its section name, and the ssh
  connection the test arrived on is among the sessions.
- **Browser** (`live.mjs`): the page first shows the router's own interfaces and peers with every uci write blocked and failing the test, then a
  mock of the plugin built from a stateful mock of `uci` drives: validation of each kind of field, the key generator and the public key it shows,
  the review list (a key only as "new value (hidden)"), a save (call order, what was written, that the page never calls `uci get`), editing a peer in
  place, adding and removing peers with Undo, the dialogs that ask before cutting your own session (Cancel, confirm, the banner), the generic
  warning when no session goes through the tunnel, the add-a-device dialog (the next address, the configuration text, that the stored public key is
  the one of the shown private key, Copy, Download, Cancel), adding an interface (name, port and key offered, taken names, a taken port, a peer, the
  note and link for the firewall zone), an interface that does not come up (rolled back, nothing staged), removing an interface and its peers, a change
  the router does not keep, a confirmation that comes too late, leftovers from an earlier attempt, an interface only the kernel has, a router without
  the protocol handler or without the plugin, no interface at all, a login without write access, the dark theme and an expired session.

### Firewall editing suite
Never changes the router's configuration: every `uci` write (including `order`) is blocked, and fails the test, in the phase that talks to the real router; the editing flow runs against a stateful mock of rpcd's `uci` object. It also runs the network suite's `firewall.test.mjs` and `uci.test.mjs`.
- **Unit tests** (`model.test.mjs`, no router): reading sections in file order by name, form values (loose spellings, absent options, legacy `syn_flood`), zones (edit, add with an interface moving between zones, removal with its forwardings and Undo, duplicate names, an interface in two zones), forwardings (the matrix switch), rules (edits staged by section name, an emptied option deleted, add, move, remove, the order of every section of the file including named sections, new rules after the last rule, no needless `order`), port forwards (DNAT and SNAT checks), the defaults (including creating the section), the lock-out check (zone and address recognition, rules that keep HTTPS, port ranges, defaults, removal, interfaces leaving a zone), the check after a save (a new section matched by place, a change not kept, a stopped firewall, a zone that was not loaded), `stageOps` with an `order`, the view joined to counters, every value check and the plain words.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.firewall.uc` runs on the router with `FLAB_FIXTURES`: `main` (the lab-like config with anonymous and named sections, a `nat` section, an include, an ipset, interfaces with addresses, counters, a canary private key in the network config), `nodefaults`, `legacy`, `stopped`, `nonet`, `partial`. It also runs once for real (read only) and compares the counts with `uci show` and the private keys it finds with the reply.
- **Browser** (`live.mjs`): the page first shows the real router read only (editing controls present, dialogs open and cancel, every write blocked); then a mock router drives the matrix, every dialog and its validation, reorder, enable and delete with Undo, the defaults card, saving (the order of the calls, the sections written, the order of rules, a new section renamed by the router afterwards), a change the router does not keep, a firewall that keeps the old ruleset or stops loading, a refused confirmation, staged leftovers, the lock-out confirmation (Cancel and Apply anyway), a login that may not write or read, a plugin reply that does not match the config, a missing plugin, the dark theme and an expiring session.

### nlbwmon settings suite
Never changes the router's configuration and never touches the daemon: every uci write is either answered by a mock or blocked
(failing the test) in the phase that talks to the real router.
- **Unit tests** (`model.test.mjs`, no router): reading the config and the replies, the defaults of an absent option, the tables,
  durations, sizes (K, M, hexadecimal) and IPv4/IPv6 subnets as nlbwmon parses them, the accounting window under a day of the month,
  from the end and every N days, the periods a lower count deletes, the daemon's command line and its comparison with the config,
  the daemon check (restart, never back, wrong command line, crash loop), the draft, the review list, the UCI plan (a size in bytes,
  deleted options, a missing section), the check after a save, the validation of every option with good and bad values, every
  warning, what the router says about paths, and the effect texts.
- **Backend** (`mkfx.mjs`, `harness.uc`, `assert.mjs`): `flab.traffic.uc` runs on the router with `FLAB_FIXTURES`, so it reads a
  fake filesystem (`nlbwmon_fs.json` plus `/proc/mounts` in `files.json`) and executes nothing: a database directory in RAM behind
  the `/var` link, new and existing directories on a USB disk, under `/etc` (flash), under `/rom` and on a read-only card, on a
  network share, a path that is a file or below one, the root, a trailing slash, 120 database files, no `/proc/mounts`, the
  protocol file present, missing, a directory and unreadable, and 22 refused values tried as each argument (relative, empty, `..`,
  spaces, shell metacharacters, a newline, wrong types, 300 characters), the 126/127 character limit. It also checks the plugin
  source (no program is started in the new code, both paths are checked first) and the ACL, and runs the method once for real on
  the router's own paths, comparing the kind with `/proc/mounts` and the files with the periods `nlbw -c list` prints.
- **Browser** (`live.mjs`): the Settings tab first shows the router's own config, with every uci write blocked and failing the
  test; then a stateful `uci` mock, procd's service list (a daemon whose command line is built the way the init script builds it, and
  which restarts, stops, keeps the old command line or restarts forever when a change is applied) and a mock of the plugin drive
  the tiles, every option and its default, the effect lines, the validation of every option, the warnings, the typed-path probes
  (one question after a pause, none for a path that was asked or is already refused, errors for a read-only filesystem, a file, a
  missing protocol file), saving (only the changed options written, a size in bytes, a switch as 0), removing an option, a stopped
  daemon, a change the router does not keep, a change that stops nlbwmon, a daemon on the old settings, a daemon that keeps
  restarting, a refused confirmation, leftovers staged in the session, a daemon that differs from the file, a config without a
  section, no nlbwmon, no plugin, unsaved edits across a tab change with no polling, a login that may not write, the dark theme and a
  session that expires.

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
  obvious, why. Comments describe current behavior, never history; neither does this README. Text, comments and
  this README use American English (color, center, gray, synchronize).
- PowerShell follows `Set-StrictMode -Version Latest`, `$ErrorActionPreference = 'Stop'`, comment-based help
  on functions and scripts, and `#region` blocks.
- ucode uses tabs, JavaScript and CSS use two spaces.
- Everything shown is discovered from the router at run time; nothing is hard-coded to one board.
- Legends sit at the top of the card or section they explain.
- Code in `rpcd/` and `www/` is deployed as is; there is no build step to keep in sync.
- When the router configuration is changed outside this folder, the corresponding files under
  `build/MT6000/` in this repository must be updated as well and pushed.
