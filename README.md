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
9. [Gotchas learned the hard way](#gotchas-learned-the-hard-way)

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
   '----- ucode plugins:    flab.wifi, flab.ipsec, flab.sensors   (this repo)
                |  import
                v
        shared ucode modules: flab.util, flab.vici
                |
                v
   swanctl --raw (VICI) · ip xfrm · hostapd_cli · iw · netifd · uci · sysfs
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
  www/                       Static site, deployed to /tmp/flab and linked at /www/flab
    index.html               Shell page: loads vendor CSS, css/base.css and js/main.js
    vendor/bootstrap.min.css Bootstrap 5.3.3, vendored so the UI works offline
    css/
      base.css               Fluent tokens, app shell, shared component styles
      <page>.css             Page-specific styles, loaded on first visit (overview, ipsec)
    js/
      main.js                Entry point: theme + start the app
      core/                  Framework-level modules shared by all pages
        app.js               Shell: nav pane, command bar, hash routing, refresh loop
        ubus.js              ubus JSON-RPC transport, session, AuthError
        login.js             Sign-in screen
        dom.js               h() element builder (XSS-safe), byId()
        ui.js                Components: card, tile(s), table, badge, chip, kv, lifebar, meter, sparkline
        controls.js          Command-bar controls: search, select, pause, toggle, refresh
        format.js            Bytes, rates, durations, numbers
        icons.js             Inlined Bootstrap Icons path data, icon(name)
        theme.js             Follows the OS light/dark preference
      pages/
        index.js             Page registry and the page contract (read this first)
        overview/            index.js + temperatures.js
        wifi.js              Wi-Fi clients
        ipsec/               index.js, connection.js, daemon.js, names.js, rates.js
        network.js           Interfaces
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
| `css` | no | Stylesheet loaded on first visit |

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
  `xfrmN` interface counters because they survive child SA rekeys); `daemon.js` shows daemon state and
  the score model.
- **Overview** (`pages/overview/`): the sensors call is optional (`optional()` wrapper), so a missing
  plugin or ACL hides the temperature section instead of breaking the page.

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
| `flab.ipsec.uc` | `flab.ipsec` | `status` | `swanctl --raw` (via `flab.vici`), `ip -s xfrm state`, `network.device`, uci network |
| `flab.sensors.uc` | `flab.sensors` | `status` | sysfs `/sys/class/thermal`, `/sys/class/hwmon` |

Shared modules (`rpcd/lib/flab/`, imported as `flab.util` and `flab.vici`):

- **`flab.util`**: `run(cmd)`, `safe_ifname()`, `normalize_mac()`, `num()`.
- **`flab.vici`**: parses `swanctl --list-sas|--list-conns|--stats --raw` output into nested objects.
  The raw format is `name {key=value list=[a b] section {...}}`; values may contain spaces
  (`class=pre-shared key`), so a value ends where the next `key=` or `key {` begins.

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
- Browser testing used Playwright (`playwright-core` with the installed Edge) from a temp folder, with
  screenshots at 1920x1080 in both themes, then deleted. Keep test tooling out of the repo.

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
KPI tiles (uptime, load, memory, CPU temperature, hottest sensor, kernel), a Temperatures card, system
info and memory breakdown. Temperatures come from `flab.sensors`: thermal zones plus hwmon sensors
(deduplicated, since the CPU appears as both). On the MT6000: CPU, two RTL8221B 2.5G Ethernet PHYs and
two MT7915 Wi-Fi radios. Health: Normal below 75 C, Warm from 75 C, Hot from 90 C or at a sensor's own
throttle/critical limit. Also shows CPU trip points, throttling state and cooling devices (passive
only; no fan is reported).

### Wi-Fi
Port of `utilities/list_connected_devices.uc`: clients per radio and SSID with MAC, IPv4/IPv6, hostname,
signal, Wi-Fi standard, bandwidth, TX/RX bitrate, security label, AKM/SAE group/cipher/PMF details and
the 0-100 security score (same AKM, cipher, SAE group and PMF scoring as the CLI tool). Filter, radio
selector, sortable columns, pause, legend. Output was cross-checked against the CLI tool.

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

### Network
`network.interface dump`: state, protocol, device, addresses, uptime per interface.

### Services
`service list` (procd): running vs idle/one-shot services with PIDs.

## Gotchas learned the hard way

- **`rpcd reload` does not pick up new logins**; use `restart`.
- **Password hashes**: rpcd rejected `$1$` MD5 hashes on this build; use SHA-512 (`openssl passwd -6`).
  PowerShell adds `\r` to piped input, so strip it before hashing.
- **BusyBox** has no `od`; `scp` needs `-O`; shell snippets sent over ssh must be LF-only.
- **Splatting a single path** in PowerShell iterates its characters; wrap in `@(...)`.
- **hostapd rate units**: `ubus hostapd.<if> get_clients` reports rates in units of 10 bit/s, so divide
  by 100000 to get Mbit/s.
- **VICI parsing**: scalar values can contain spaces; see `flab.vici`.
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
