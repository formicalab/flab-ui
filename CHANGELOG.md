# Changelog

## 0.1.22 - unreleased

### Asterisk (new optional module, `flab-ui-mod-asterisk`)

A read-only page for the Asterisk PBX (built for Asterisk 23, the version in the OpenWrt telephony feed), **Telephony: Asterisk** in
the navigation. It reads Asterisk through its CLI and changes nothing: no reload, no originate, no edit.

- **Overview**: is the daemon up (and why not: disabled, stopped, not answering, not installed), version, uptime, memory, call
  counters, what is exposed (AMI, HTTP), CDR and logging, the loaded modules, a banner of what needs attention (a registration that is
  not `Registered`, an unavailable endpoint, a file changed after the last reload, recent errors), and the log's recent warnings and errors.
- **PJSIP**: one card per outbound registration, a signalling diagram, the endpoints (trunk or phone, state, calls, context,
  codecs, contacts, identify addresses) with a side panel and every parameter on demand, contacts with their round-trip history,
  transports and active channels.
- **Dialplan** (the loaded one, not the file): a **browser** (contexts, extensions explained in words, steps with their application,
  where each can go next and the source line), a **routing map** (endpoints → contexts → dialed endpoints, with the live state and the
  wiring problems it finds), and a **number tester** that follows Asterisk's search (own extensions in Asterisk's order, then includes)
  and asks Asterisk itself (`dialplan show <number>@<context>`) whether the two agree.
- **Configuration**: the files of `/etc/asterisk` and `/etc/config/asterisk`, with a jump to a section and to the line a dialplan step
  came from, and a mark on a file changed after the last reload.
- PINs, passwords and secrets are hidden by the backend before anything reaches the browser: configuration values named
  `password`, `secret`, `md5_cred`, `pin` and the like, `Authenticate()` and `DISA()` arguments, `Set(<secret name>=…)`, a literal compared
  with a secret-named variable, secret-named global variables and PJSIP parameters. This is best effort (a secret under an innocent
  name cannot be recognized); line numbers stay valid.
- Backend: `flab.asterisk` (`status`, `pjsip`, `endpoint`, `dialplan`, `resolve`, `config`; all read only) and its ACL fragment, package
  `flab-ui-mod-asterisk`. Tests: `tests/asterisk` (pure models, the backend against a real capture and twelve scenarios, and the page in a browser).
- Not included: call history (the PBX needs a CDR backend for it), and AMI or ARI as a data source (both are off on a stock install).

## 0.1.21 - 2026-11-21

### Routing: BGP

- **BIRD configuration** card: a read-only view of `/etc/bird.conf` (the text after `password` and `secret` is redacted),
  a *Check* button that runs `birdc configure check` (it applies nothing), a closeable result, a review of the file
  (for example, external BGP sessions without filters), filter sources one click away, and each peer's own lines of the file.
- **Peer actions**: restart, enable, disable, and reload in or out, for BGP protocols only, with a confirmation.
- **Route choice**: a click on a prefix opens a drawer that explains why BIRD preferred one path over the others.
- **BIRD protocols** opens with a **flow diagram** that follows the BIRD 3.3.3 guide: one lane per protocol, the routing
  table on the right, and a spline for each import and export, as thick as the number of routes. Each spline carries its
  filter (the filter's name, `accept all`, `reject all`, or `default` when the file has no such line, with BIRD's own
  default explained in a tooltip); a blocked edge is a short stub that ends in a ✕. BGP sessions that are alike share one
  lane, which opens on a click. A click on a route count lists those routes in a drawer. Unnamed protocols are matched by the
  name BIRD gives them (`kernel1`, `static1`).
- A legend explains the protocol types and the filters; local routes (Direct, Static) fold under their protocol row;
  the announced-routes table shows what each peer is sent now, and why the counters differ.
- The tooltip of a Direct import says that its routes are the next hops that the multihop BGP sessions resolve.
- Backend: `flab.bgp` has `config`, `check` and `action` methods, and returns the routes that the table hands to each
  non-BGP protocol (`protocols[].exported`, up to 2000).

## 0.1.20 - 2026-11-21

### Interface

- On every page the command bar's topmost line holds the title at the left and, grouped at the right, the Pause and
  Refresh buttons followed by the "Updated" timestamp. Summary tiles, tabs and filters follow on the lines below.
- Pause was added to DHCP, DNS and Dynamic DNS (one Pause for both tabs), Services and System settings, so every page
  that polls has Pause and Refresh (Overview and Toolbox have neither).

### Page order

- DHCP shows the advertised IPv6 prefixes (Router advertisements) before the leases.
- IPsec shows the strongSwan daemon card right below the tiles, before the score explanation and the connections.
- The Routing BGP tab shows the BIRD daemon, memory and protocols cards right below the tiles, before the topology.

## 0.1.19 - 2026-11-20

### Toolbox

- The tools are grouped (reachability, names and certificates, traffic, Wake-on-LAN) in a Bootstrap button group, and the
  page opens on the connectivity check. DNS lookup and DNS trace are one **DNS** tab with a Method selector, and
  traceroute and MTR are one **Traceroute / MTR** tab; the method selector is hidden when the router has only one of
  them.
- Every tool has a collapsed "About this tool" help, the host box suggests recent hosts and the clients the router
  knows, each tool keeps its form and last result when you switch tabs, and the form labels line up. The page has no
  Refresh button any more, since it has nothing to refresh.
- Ping and Traceroute buttons in the Routing lookup and Ping and Wake buttons on DHCP clients open the Toolbox, and are
  offered only when the optional Toolbox package is installed.

### Interface

- When Refresh is the only control it sits at the bottom right of the summary tiles; with tabs, filters or Pause it stays
  in that button row.

## 0.1.18 - 2026-11-20

### DHCP

- The page is rebuilt around one client list: the DHCPv4 and DHCPv6 leases a client holds are joined to its static
  lease in one row, with a single filter (text, interface, type), **Make static** for dynamic clients and an editor
  with every `host` option under each static lease. "Reservations" are now called static leases.
- Settings (daemon, pools, network boot) come before the client list and the advertised prefixes, and the icons of the
  page were made consistent. Corrected the defaults shown for the log level (4) and the router lifetime (1800).

### Interface

- Bootstrap 5.3.9 and native components throughout: alerts, progress bars, spinners, input groups, button groups and
  responsive tables replace custom CSS. The summary tiles of every page stay on top of the command bar, expanders use
  one chevron icon, and typing in a filter no longer loses focus when the page redraws.

## 0.1.17 - 2026-11-20

### DHCP

- DHCPv6 lease rows now distinguish address associations (IA_NA) from delegated prefixes (IA_PD), identify clients by
  matching link-layer DUID or DHCPv4 identity, and show how many `/64` networks fit in each delegated prefix.
- The DHCPv6 summary reports how many active clients hold an IA_PD lease, and the lease filter searches the new
  client identity and association details.

## 0.1.16 - 2026-11-19

### Security

- Configuration backups are created in directories only root can read, and the 15-minute expiry of old backups now
  actually runs. Proxy passwords in Dynamic DNS status are masked completely, and interface and BGP peer names that
  start with `-` are refused. Log redaction covers quoted and JSON values.
- The WireGuard add-a-device dialog closes when you leave the page and refuses a DNS value that could add lines to the
  generated client configuration. The wizard forgets its PPPoE password after Finish.
- Percentages from the router are clamped before they reach style attributes, a manifest can only load
  `./<folder>/index.js`, and a route such as `#constructor` is no longer resolved through inherited object properties.
- The release workflow no longer keeps the packages token in the checkout during the SDK download and build, and its
  actions are pinned to commit SHAs. `tools/package.ps1` refuses a router argument that is an ssh option, and
  `Sync -Backend` no longer carries directory permissions to the router.

### Fixes and speed

- Toolbox: a redraw during a read no longer starts a second poll that duplicates output; malformed trace, iperf and
  ping data no longer stall the page. The TLS and connectivity checks accept IPv6 literals.
- The kernel log is read again with fewer lines instead of failing when it is large. WireGuard administration
  sessions are read correctly on big-endian boards. The Traffic connections call reads the conntrack table in chunks
  and never holds a huge one in memory.
- Routing: the BGP learned-routes table draws 400 paths until "Show all", and the sorted tables are cached while you
  type a filter. Settings backups redraw one status line instead of the page and check the size of the download.
- Dead code, stale comments and old-page wording are removed from the sources and the documentation.

## 0.1.15 - 2026-11-19

### Overview

- Raw NAND flash (UBI) is now understood, as found on repeaters and many routers: the Storage card shows the chip
  (vendor, model, cell type), the most-worn block's erase count, bad blocks against UBI's spare reserve, ECC
  activity and the UBI volumes, with a spare-block health badge. Mounts on UBI volumes name their hardware instead of
  "Loop device" or "Block storage".
- A router behind another router (static private address, for example a repeater or access point in a mesh) is shown
  as "Upstream router" with its default route, a "static" badge instead of "received", and no empty IPv6 delegation
  half. "Provider" wording is only used where a prefix really is delegated.

## 0.1.14 - 2026-11-19

### Overview

- Storage: rename the disk badge from "healthy" to "wear normal" (it reflects only the eMMC's own wear and
  spare-block registers, with a tooltip saying so), and report the more worn area correctly when a device exposes
  only one life-time register.

## 0.1.13 - 2026-11-19

### Overview

- Fix the Storage "Written since boot" figure: discards that the overlay's loop device sends to the eMMC (for example
  the overlay format) are no longer counted as data written. The call reports them separately as `discarded` and the
  tile's tooltip says so.
- Drop the redundant Network card header and stack Internet connectivity and IPv6 delegation below 1800 px so long
  IPv6 addresses never overflow.
- Say plainly when there is no Internet, no IPv6, no delegated prefix or a prefix delegated to no LAN. A refused or
  failed interface call now reads "Unknown / data is unavailable" instead of "Offline"; a router behind a modem or
  CGNAT (private WAN address) is shown as connected; a WAN route without an address is flagged "no address".

### Sign-in

- Center the host name pill against the title in the compact sign-in header.

## 0.1.12 - 2026-11-19

### Overview

- Replace the sparse tile-only Overview with a hero card (identity, uptime, load, memory, free storage, CPU temperature), one
  Network card (WAN connectivity with IPv4/IPv6 addresses, gateways and DNS, plus the delegated IPv6 prefix and
  per-interface assignments) and a full-width Storage card listing every mount point with its backing hardware
  (e.g. eMMC model and partition), filesystem, device and usage. Redundant tiles and the system table are gone.
- Add the `flab.system storage` call (base ACL) behind the Storage card. It also reports the physical disks (eMMC,
  NVMe, SATA/USB): vendor, model, firmware, wear estimate, traffic since boot and partitions.

### Configuration backup

- Add configuration backup download, archive upload validation and explicit restore-and-reboot to System settings.
  Backups use `sysupgrade`, transfer in bounded chunks and remain only in temporary router storage. A full archive
  restore is explicitly warned as not having automatic rollback.
- Add one-click NTP resynchronization by restarting `sysntpd` with its configured servers.

## 0.1.10 - 2026-11-18

### Connected devices

- Add learned Ethernet clients to Devices and Interfaces using the bridge forwarding database, correlated with DHCP,
  ARP/NDP and static reservation names. Each entry reports the Ethernet port it was learned through without assuming
  that the device is directly attached.
- Replace the client list with port/AP topology cards and curved dependency lines, with matching styling for Ethernet
  ports and Wi-Fi access points.
- Merge Wi-Fi networks into one Wi-Fi devices pane, show security and a colored RSSI meter beside each client, and keep
  expanded client details open across automatic refreshes.

### Interface

- Reorder the DHCP page to show daemon settings, pool settings, reservations and network boot before current leases.
- Improve connected-device spacing, borders and mobile layout; keep the Wi-Fi legend visible in a lightly tinted panel.

## 0.1.9 - 2026-11-18

### Packaging

- Split the installation into the required `flab-ui-base` package, eleven independently installable feature
  packages and a `flab-ui` full-install metapackage.
- Discover installed feature manifests at run time and register only the pages and rpcd backends provided by
  installed modules. The base package is usable on its own.
- Make package installation and removal restart rpcd reliably, while preserving shared assets and dependencies
  without cross-package file conflicts.
- Build, install, verify and publish the complete APK set, including installed-file checksums and package smoke
  tests for plugin/ACL pairs.

### Reliability

- Retry feature-module discovery after a transient rpcd failure instead of leaving the page base-only for the
  remainder of the browser session.
- Bound diagnostic workers process-wide, separate diagnostic validation and job lifecycle code, and improve package
  artifact and release recovery validation.

## 0.1.8 - 2026-11-17

### Interface

- **One look for every fold.** Native folds (setting groups, "show more", legends, raw output) are built by `disclosure()` in `core/fold.js` with one arrow, the same as a folded card; the per-page summary and arrow styles are gone. The DNS cards use the shared fold code too.
- **WireGuard: Add client shows a QR code.** The dialog is wider (fewer wrapped hints) and, after the keys are made, shows the client's configuration as a QR code that the WireGuard app of a phone scans, beside the text with Copy and Download. The code is drawn in the browser with the vendored qrcode-generator (MIT, loaded only when needed); nothing is sent anywhere. Terminology is now **client** (a phone or laptop, made here with its keys) and **peer** (the generic WireGuard word; *Add site-to-site peer* connects the router of another network and starts with routes for its networks on), with *client*, *site-to-site* and *all traffic* as the role badges in the table, explained by a legend above it.
- Checkboxes, radios and switches had the pale card stroke as their border, so an unchecked, enabled box looked disabled. They now have the same stronger border as the text inputs and the brand color when checked, in both themes; a disabled one is the only faded one.
- Buttons are built by `button()` (now takes `title`, `disabled` and `ariaLabel`); the icon vocabulary (remove, add, save, revert, error, warning and so on) is applied on every page and documented in `docs/frontend.md`. The Toolbox error and finding banners share one helper.
- Fixes: WireGuard reported "the protocol handler is not installed" on current OpenWrt, where netifd's handler is `wireguard.uc` (not `wireguard.sh`); both are recognized now. The WireGuard peer form suggests site-to-site values (a name such as "Branch office", a branch endpoint, a network behind the other router). A failed sign-in for a reason other than the credentials says why; the DDNS Log and Refresh buttons return to the sign-in screen when the session expired; the Routing lookup fold keeps its state across refreshes; the Ethernet ports cable-test button disappears for a port that cannot run it; the Overview temperature labels no longer assume one board.

### Backend

- **Security:** ucode regular expressions with `^...$` match the first line of a string that holds a newline, so a value such as `"1.1.1.1\nid"` passed validation and reached a shell command in `flab.routing lookup`, and an interface name could do the same through `safe_ifname()`. Both now refuse line breaks (`one_line()` in `flab.util`), as do the other plugins that take an interface name; regression cases are in the routing, toolbox, services, DDNS, network and execution suites.
- **Smaller:** `flab.traffic usage` answers "no data" for malformed `nlbw` output; `flab.firewall` reports a timeout or an oversized reply as such; `flab.diag status` probes each command once; the network plugin reads its UCI configuration once per request; `flab.logs` no longer fails when the log is larger than the output cap of one command, it reads fewer lines and says how many.

### Code and documentation

- Removed unused code, styles and exports, the duplicated `reveal`, `sleep` and legend helpers and the `pages/services.js` re-export; added file headers and contract comments; updated the docs to match.

## 0.1.7 - 2026-11-17

### Pages

- **Two hardware pages: Ethernet ports and Wi-Fi radios.** They read and change the hardware and what runs on it, and everything about it is configured there, not in drawers.
  **Ethernet ports** (`#network`) is the Ports table of the old Ethernet page (link with its negotiation, hardware, traffic graph, errors, bridge and VLAN devices, cable
  test, the editable VLAN tables) with a collapsible **Port settings** section under every port: the port's device settings (MTU, MAC address, link speed, flow control and
  the rest) open under its row, and a port without a device section can get one. **Wi-Fi radios** (`#radios`) has a card per radio with its live figures, channel
  utilization, its **radio settings** (which start with the channel picker) and its **wireless networks**; the radio settings cover every `wifi-device` option of the OpenWrt wireless
  documentation (the channels of automatic selection, the basic and supported rates, the HT capabilities, the antennas, the HT coexistence flag, the narrow channel width and extra
  hostapd options). The networks on a radio are the access points, the client networks and the **802.11s mesh points**: each is a block with what it is doing now (clients,
  BSSID and traffic; for a mesh point the peers, paths and the mesh parameters in force, the old Mesh page) above its settings, and the buttons **Add access point**,
  **Add client network** and **Add mesh point** create them. A mesh point has the options the wireless configuration can hold (Mesh ID, networks, SAE, password, multicast rate),
  its mesh parameters are shown read only because only `iw` or mesh11sd can set them, and the checks warn that spanning tree does not see a mesh (the OpenWrt 802.11s page).
  **The Wi-Fi and Mesh pages are gone**: `#wifi` and `#mesh` open the Wi-Fi radios page, and the chips of the Devices and Interfaces board link to it. The radios and
  their networks share one draft and one Save. The channel picker is part of the Radio group of the radio settings (under the mode), and an access point whose WPS push button is enabled has a **WPS** button on its summary line that opens the button for two minutes after a confirmation (the new `flab.radio wps` method; sign in again to get the permission). The two hardware pages are built alike: summary tiles with totals only, the live state of each device, and one settings fold per
  device that is the only place a configured value is shown and edited (the same fold control). A radio card no longer has a Configuration block or a Clients figure (the
  configured channel, width and power are in the key figures, the clients in each network), the Ethernet table has one Link column that includes the negotiation and one Bridge and VLANs
  column, and the Switch and Link changes tiles are gone because the switch line and the rows say the same.- **Devices and Interfaces** has the tabs **Board** and **Connected devices**. A click on a port or a radio card opens the hardware page instead of a drawer, and the
  Device menu no longer offers port settings. The ports' hardware is shown in one line on a port card; a radio is a container card of its Wi-Fi and mesh interfaces.
  Interface cards no longer show an uptime (the interface drawer still does). The lanes have wider gaps. A page's refresh period may now be a function.
- **A Connected devices tab** lists the connected Wi-Fi clients per network, moved from the Wi-Fi page (with a filter and a radio selector in the command bar of the tab).
### Toolbox

- New **Packet capture** tool (needs `tcpdump`): records the packets of an interface (or all) and lists them as they arrive, with
  figures (captured, matched, dropped, new connections, resets), findings, the protocols and busiest conversations. The filter
  has a protocol, an address and a port, and an **advanced filter** for any tcpdump expression (checked against a safe
  alphabet and passed after `--`). It stops at its duration or packet count, or on Stop. **Download .pcap** saves the whole
  capture for Wireshark (`flab.diag download`, in pieces; the new permission means a session opened before the update has to sign
  in again). Only one capture runs at a time and the file lives in memory.
- The **connectivity check** takes a **port** for its last step: 443 is the TLS handshake as before; another port is a
  connection that is judged as TLS when the service speaks it, as a plain TCP service that works when it does not, and as a
  failure when it refuses or stays silent.

- MTR does what Traceroute does: the form gains TCP SYN probes with a port (for a firewall that only passes web traffic), a
  packet size, a source (an address or an interface), host names and the **Networks (AS)** lookup. Each router shows its AS
  number, organization and country.
- MTR shows the route as a strip of networks: one card per AS with the hops inside it, the delay it adds and its share of the
  whole delay; loss starting inside a network turns its card amber. The findings place a delay jump at the handoff between two
  networks or inside one, name the network that adds most of the delay, and say in which network loss that reaches the
  destination starts (and whether that is the ISP's side, the middle or the destination's own).
- **Copy report** on a finished MTR run copies it as plain text (table with networks, networks crossed, findings) for a support
  ticket.
- The Toolbox opens on MTR when the router has `mtr`, and Traceroute offers a "Use MTR" button that keeps the host. Ping and
  Traceroute stay as they are: they need nothing installed, and Traceroute still lists every router of a load-balanced hop.

## 0.1.6 - 2026-11-15

### Ethernet

- Rename the "Wired network" page to "Ethernet" (the route stays `#network`).
- Replace the wiring diagram (SoC, MACs, switch chip, PHYs and connectors) and the port tiles with the port table alone.
  How those parts are connected differs from board to board and cannot be drawn correctly for all of them, and the tiles
  repeated what the table says. Each row now has a jack icon tinted by link state, the LAN/WAN role, the SFP tag and the
  MAC, and a graph of the recent traffic next to the live rates. Link changes sit under the speed in the Link column and
  the learned-MAC count under the bridge state. One line per switch above the table keeps what the diagram said about it:
  user ports, CPU ports, the CPU link's capacity and use, and how oversubscribed it is. The Hardware column gives each
  switch port's number.
- Add a **Settings** button to every front-panel port on the Ethernet page. It opens that port in the drawer of Devices and
  Interfaces, with the same editing panel as a click on the port's card there. The editing itself stays on the board.
- Remove the "All ports look healthy." banner from the Ethernet page. It only looked at changes since the page was opened,
  so it appeared next to a port with thousands of old errors. The findings banner now shows only when there is something
  to report (a downshifted link, flaps, new errors, an optical alarm or a busy CPU link).

### Reliability

- Stop a slow refresh from rebuilding a form the user has started to use. The refresh of an open page took one to two
  seconds on a real router, and its reply was applied even if the user had clicked into a form meanwhile, which rebuilt
  the form, took the focus away and could disturb a save in progress. A reply to a timer refresh is now dropped when the
  page has become paused; explicit reloads (a save, Refresh) are still applied.

## 0.1.5 - 2026-11-15

### Routing

- Show the policy rules, the static-route editor and the routing tables in lookup order (full-width rules card, then the
  static routes, then the tables overview, then the final list). "How the kernel picks a route" is now a foldable card
  (folded at first) that also explains where static routes fit and how the metric breaks ties: static routes are not a
  stage before or after the rules; each is an entry in a table (its Table option, else its interface's table) and is
  reached only through the rules that consult that table.
- Merge the four static-route tiles into one tile with the other tiles at the top: the number configured, and how many are
  installed, not installed and disabled.
- Fix a false "gateway is not inside a subnet of <interface>" warning in the static-route editor on point-to-point links such
  as PPPoE, where the gateway is the peer address of a /32 link.
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
