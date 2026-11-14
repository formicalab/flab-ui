# Wired network (route `#network`)
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
  (see [Backend](../backend.md#backend-rpcd-plugins)); the editor adds no plugin.
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
