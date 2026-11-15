# Architecture

flab-ui is a static single-page app served by `uhttpd`, talking to the router through the
standard `ubus` JSON-RPC endpoint and a few small `rpcd` ucode plugins. It was developed and tested on the GL.iNet GL-MT6000
(1 GB RAM).

> **Hard rule: standalone.** flab-ui must never depend on the ubus objects or libraries of another web UI. Read data
> directly from `swanctl`, `netifd`, `procd`, `nft`, `wg`, sysfs, the kernel (`ip`, `iw`, `hostapd_cli`) and `uci`. rpcd's
> own `uci` object (staged edits, apply with rollback) is part of rpcd and is what configuration changes use.

It is installed as the `flab-ui` package (see [OpenWrt package](package.md#openwrt-package)). It signs in with the router's own
`root` login and creates no login of its own. The pages that only
read the router are Overview, Mesh, IPsec VPN, Toolbox (which runs diagnostics and sends a Wake-on-LAN packet) and Logs. The others
edit its configuration through UCI: System settings (`/etc/config/system`), DHCP (`/etc/config/dhcp`, and the server DUID in `/etc/config/network`), DNS (`/etc/config/unbound`, or the dnsmasq section of `/etc/config/dhcp`), Dynamic DNS (`/etc/config/ddns`), Wi-Fi (the radios and wireless networks in `/etc/config/wireless`), Wired network (the VLAN sections of `/etc/config/network`), Devices and Interfaces, which holds the bridges (`/etc/config/network`), WireGuard (the WireGuard interfaces and peers in `/etc/config/network`), Firewall (`/etc/config/firewall`), the static-route editor on Routing (the `route` and `route6` sections of `/etc/config/network`) and the Settings tab of Traffic (`/etc/config/nlbwmon`). The Services page starts, stops and restarts services. How configuration changes are made safely is described in
[Configuration changes](#configuration-changes) and how services are controlled under [Services](pages/services.md#services-route-services).

## Architecture at a glance

```
Browser (ES modules, Bootstrap 5.3 + Fluent theme, no build step)
   |  HTTPS POST /ubus   {"jsonrpc":"2.0","method":"call","params":[sid, object, method, args]}
   v
uhttpd  (ubus_prefix '/ubus', static files from /www/flab)
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
- **The router's own login.** The UI signs in as `root` through rpcd and creates no login.
  rpcd gives root read and write `*`, which means every ACL group installed on the router; the ACL fragments in
  `rpcd/acl.d` are what add the flab-ui calls to it. Everything the plugins and pages read or write is therefore
  limited by what root may do, and by the safeguards below (validation, apply with rollback).
- **Modular by page.** One folder or file per page on each side, registered in one list.
- **No secrets leave the router.** Plugins whitelist fields; key material is never forwarded, and log lines
  that look like secrets are redacted.

## Repository layout

```
flab-ui/
  README.md                  What flab-ui is, how to install it
  LICENSE                    MIT license
  docs/                      The documentation (start at docs/README.md); one file per page under docs/pages/
  tools/gen-zones.py         Regenerates pages/settings/zones.js from the IANA time zone database
  tools/package.ps1          Builds the OpenWrt package with an SDK (Linux, or WSL on Windows), installs or removes it on the router with apk, and publishes releases (Action Build, Deploy, Remove or Release)
  tests/                     bgp/, ddns/, dhcp/, dns/, fwedit/, ifedit/, ipsec/, network/ (network, Wi-Fi, mesh, WireGuard, firewall, logs, helpers), nlbwedit/, routeedit/, routing/, services/, settings/, toolbox/, traffic/, vlanedit/, wgedit/, wifi/, wifiedit/,
                             TestSession.ps1 (the temporary rpcd session the browser tests sign in with, and the Invoke-Native helper every run.ps1 uses)
  www/                       Static site, installed to /www/flab
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
                             lookup.js (next-hop lookup card), tables.js (tables, rules and route list cards), static.js (static-route tables and
                             editor wiring), static-model.js (pure: the route and route6 sections, draft, validation, risks, UCI operations, check after a save)
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

## Security model

- **The router's own login.** The UI signs in with rpcd's `session login`, as `root` (the login every OpenWrt
  router has, with read and write `*` on everything). flab-ui creates no login and changes no rpcd configuration. The
  package ships ACL fragments (in `/usr/share/rpcd/acl.d`) that list the calls of its pages; root's `*` already covers
  every installed fragment, so they can never grant more than root already has, and nothing about it persists in
  `/etc/config/rpcd`.
- **What protects the router** is therefore the root password, HTTPS, the ACL fragments (each lists exactly the
  ubus calls and uci configs its page uses; each editing fragment grants `uci` write on the configs of its page only, for example `system` for the settings fragment and `nlbwmon` for the Traffic one), and the
  care the pages take: input is validated before it is staged, changes use rpcd's rollback timer,
  and recognized stored secret options are filtered (see [Backend rules](backend.md#backend-rules)). Custom options
  and free text are not a guaranteed secret-free boundary; typed or browser-generated credentials necessarily
  exist in the browser.
- **Session.** The session id and the ACLs rpcd returned live in `sessionStorage` (this tab only, gone when it
  closes, unless browser session restoration restores it). The session expires after 900 s without RPC activity;
  polling keeps it alive. Sign out attempts to destroy it on the router and clears the local copy even if that call fails.
- **Known exposure.** The editing pages list and edit the options of their configs (for example `/etc/config/system`) for anyone who can sign in as
  root; there is no per-option restriction and none is needed. Plugins run inside rpcd with its privileges, which
  is why they whitelist the fields they return.
- **On-demand operations.** `flab.services control`, `flab.ddns control`, `flab.network cable_test` and the diagnostic
  methods run programs on request; these are not protected by UCI rollback. Service control never takes a command:
  it accepts only a plain file name that is in `/etc/init.d` and one of `start`, `stop`, `restart`, `enable`, `disable`,
  refuses the boot-sequence scripts, and the page asks for confirmation before a stop or restart that can lock the
  user out (see [Services](pages/services.md#services-route-services)). The ACL grants no generic `file exec`.
- **Transport.** Configure uhttpd to redirect HTTP to HTTPS and serve with a suitable certificate; the package does
  not configure either. The session token
  travels in the request body, not a cookie, so cross-site requests cannot ride on it.
- **Tests never need the root password.** The browser tests create a temporary rpcd session over ssh and grant
  it the permissions declared in the repository's ACL fragments (`tests/TestSession.ps1`). This exercises those
  declarations, not the installed ACL files or the actual root login configuration. The session is destroyed when the test ends.

## Configuration changes

System settings, DHCP, DNS, Dynamic DNS, Wi-Fi, Wired network (VLANs), Devices and Interfaces (which holds the bridges), WireGuard, Firewall, the static routes of Routing and the Traffic settings change the router, and set the pattern every later editing page follows. The signed-in login (root) may write; a login that may not (`can('uci', 'set')` is false) gets the same
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
   they can be retried. `applyChange()` attempts to discard them before another save, and refuses to start
   while anything is staged anywhere in the session (apply would commit it too). Editing pages show the session-wide
   count; their discard button reverts only the configs that page owns, never unrelated changes.

`applyChange(ed, configs, stage, verify)` does steps 1 to 5 and throws an Error whose message says what
happened. Rollback is reported as confirmed only when rpcd acknowledges it; cleanup errors are included, and a lost
confirmation reply with no acknowledged rollback is explicitly uncertain. No mutation is automatically retried.

### Configuration-change limitations

- rpcd applies **all** configs staged in a session. The preflight checks the entire session and fails closed if it
  cannot read that state, but it does not provide a lock against another client using the same token.
- Verification is not an internet connectivity test. Static-route saves compare stored sections and the full FIB
  identity of changed enabled routes on running interfaces; dormant routes may be saved for later.
- A lost confirmation reply is ambiguous: rpcd may have accepted it already. If explicit rollback cannot be
  acknowledged, check the router before retrying; the UI reports that uncertainty and any cleanup failures.
- Native RPCs, including UCI writes, have a five-second request/body deadline; plugin requests allow 27 seconds
  for bounded backend work. Confirmation reserves a native-request deadline within the rollback window.
- Restarting or reloading rpcd loses its in-memory rollback timer. Do not combine configuration applies with package
  changes or service restarts, and retain alternate access.
- The editor does not lock out other administrators or detect every external config change. Avoid concurrent editors
  and keep a console or a second management path for network changes.

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

**Status.** `core/ubus.js` and `core/uci.js` (including `applyChange`) are unit-tested against a fake transport
(`tests/network/uci.test.mjs`); the suites of the editing pages (System settings, DHCP, DNS, Dynamic DNS, Wi-Fi, Wired network VLANs, Devices and Interfaces (with the bridges), WireGuard, Firewall, Static routes and the Traffic settings) test their models and drive the whole flow in a
browser against a mock router. The real path was exercised against the router with the System settings model and
`applyChange`,
restoring the configuration afterwards: a confirmed change (zone, description, log port, NTP servers and
switch), the removal of options, a custom zone rule, a forced rollback and the countdown rollback of an
unconfirmed apply. The Wi-Fi, Wired network VLAN, Devices and Interfaces, WireGuard, Firewall, Static routes and Traffic settings editors are exercised through their suites against mock routers only; the suites block every write on the real router.
