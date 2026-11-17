# Changelog

## Unreleased

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
