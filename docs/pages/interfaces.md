# Devices and Interfaces (route `#interfaces`)
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
