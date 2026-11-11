#!/usr/bin/ucode
//
// rpcd ucode plugin reporting physical Ethernet ports, bridges, VLAN devices and the board's switch wiring as JSON:
//   ubus call flab.network status
//
// Everything is discovered at run time (nothing is hard-coded to this router's port names), so a changed
// board layout, a new bridge or a new VLAN device shows up on the next poll.
//
// Sources (no LuCI component is used):
//   - netifd (network.device status): device types, link speed and negotiation, bridge membership, counters
//   - sysfs: carrier and link-flap counters, bridge/STP state (/sys/class/net/<if>/bridge and brport)
//   - the bridge forwarding table (/sys/class/net/<bridge>/brforward): learned MAC addresses per port
//   - ethtool, /sys/class/mdio_bus, /proc/device-tree and /etc/board.json: driver, PHY and switch wiring
//   - UCI network, firewall and dhcp: tunnel links, zone membership and DHCP/RA service per interface
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { connect } from 'ubus';
import { readfile } from 'fs';
import { fixture, record_file, run, ubus_call, uci_all, sysfs, sysfs_raw, safe_ifname, num, as_list } from 'flab.util';

// Names of the kernel's bridge port STP states, indexed by the number in brport/state.
const STP_STATES = [ 'disabled', 'listening', 'learning', 'forwarding', 'blocking' ];

//#region Helpers

// Trimmed contents of /sys/class/net/<dev>/<file>; null when the device name is unsafe or the file is missing.
function sys(dev, file) {
	return safe_ifname(dev) ? sysfs(`/sys/class/net/${dev}/${file}`) : null;
}

// Number from a hex string such as "0x8001" (bridge port numbers are printed this way); null when absent.
function hex_value(text) {
	return text == null ? null : hex(replace(text, /^0x/, ''));
}

// netifd reports the negotiated speed as "2500F" (Mbit/s plus F/H for full/half duplex); returns
// { speed, duplex } with nulls when the text does not parse.
function link_speed(text) {
	let m = match(text ?? '', /^([0-9]+)([FH])?$/);
	return m ? { speed: +m[1], duplex: m[2] == 'F' ? 'full' : m[2] == 'H' ? 'half' : null } : { speed: null, duplex: null };
}

// Highest speed (Mbit/s) among mode names such as "2500baseT-F".
function top_speed(modes) {
	let best = null;
	for (let name in modes ?? []) {
		let m = match(name, /^([0-9]+)base/);
		if (m && (best == null || +m[1] > best))
			best = +m[1];
	}
	return best;
}

// Comparator for interface names: the numeric suffix is compared as a number, so "lan10" sorts after "lan2".
function natural_less(a, b) {
	let pa = match(a, /^(.*[^0-9])?([0-9]*)$/), pb = match(b, /^(.*[^0-9])?([0-9]*)$/);
	let sa = pa[1] ?? '', sb = pb[1] ?? '';
	if (sa != sb)
		return sa < sb ? -1 : 1;
	return (+pa[2] || 0) - (+pb[2] || 0);
}

// Every counter netifd reports (the page picks what it needs; the error breakdown shows the non-zero ones).
function stats_view(d) {
	let out = {};
	for (let k, v in d.statistics ?? {})
		out[k] = v;
	return out;
}
//#endregion

//#region Bridge forwarding table

// Learned and local MAC entries per bridge port number, from the kernel's binary forwarding table
// (16 bytes per entry: MAC[6], port, is_local, aging timer[4], high port byte, padding[3]).
// The result is keyed by the port number as a string; the full number is port + (high byte << 8).
function fdb_counts(bridge) {
	let raw = fixture('brforward_' + bridge);
	if (raw == null) {
		raw = readfile(`/sys/class/net/${bridge}/brforward`) ?? '';
		record_file('brforward_' + bridge, raw);
	}

	let out = {};
	for (let i = 0; i + 16 <= length(raw); i += 16) {
		let port = `${ord(raw, i + 6) + (ord(raw, i + 12) << 8)}`;
		out[port] ??= { macs: 0, local: 0 };
		if (ord(raw, i + 7))
			out[port].local++;
		else
			out[port].macs++;
	}
	return out;
}
//#endregion

//#region Devices

// JSON view of a netdev `d` (one netifd network.device status entry) with its link state, negotiated and
// maximum speeds (Mbit/s), flow control and carrier-flap counters. Speed and duplex are only reported while
// the carrier is up; sysfs fills in what netifd lacks.
function device_view(name, d) {
	let sp = link_speed(d.speed);
	let carrier = d.carrier ?? sys(name, 'carrier') == '1';
	let speed = carrier ? (sp.speed ?? (num(sys(name, 'speed')) > 0 ? num(sys(name, 'speed')) : null)) : null;
	let max_speed = top_speed(d['link-supported']);
	let partner_max = top_speed(d['link-partner-advertising']);

	return {
		name,
		type: d.devtype,
		up: d.up ?? false,
		carrier,
		operstate: sys(name, 'operstate'),
		mac: d.macaddr,
		mtu: d.mtu,
		speed,
		duplex: carrier ? sp.duplex ?? sys(name, 'duplex') : null,
		autoneg: d.autoneg,
		max_speed,
		partner_max,
		// Linked below what both ends can do: bad cable, a failing pair or a forced setting.
		downshifted: carrier && speed != null && max_speed != null && partner_max != null && speed < (partner_max < max_speed ? partner_max : max_speed),
		flow: d['flow-control']?.negotiated ?? [],
		carrier_changes: num(sys(name, 'carrier_changes')),
		link_ups: num(sys(name, 'carrier_up_count')),
		link_downs: num(sys(name, 'carrier_down_count')),
		stats: stats_view(d),
	};
}

// Spanning-tree view of one bridge port; null when the device is not a bridge port. `bridge` is the bridge's
// view, used to derive the port role.
function brport_view(name, bridge) {
	let base = `brport/`;
	let state = sys(name, base + 'state');
	if (state == null)
		return null;

	let port_no = hex_value(sys(name, base + 'port_no'));
	let bp = {
		state: +state,
		state_name: STP_STATES[+state] ?? 'unknown',
		port_no,
		path_cost: num(sys(name, base + 'path_cost')),
		priority: num(sys(name, base + 'priority')),
		designated_bridge: sys(name, base + 'designated_bridge'),
		designated_cost: num(sys(name, base + 'designated_cost')),
		hairpin: sys(name, base + 'hairpin_mode') == '1',
		learning: sys(name, base + 'learning') == '1',
		isolated: sys(name, base + 'isolated') == '1',
	};

	if (bridge.stp) {
		// Role is not exported by the kernel, so infer it from the state and the bridge-level root data.
		bp.role = bp.state == 0 ? 'disabled'
			: bridge.root_port == port_no ? 'root'
			: bp.state == 4 ? 'alternate'
			: bp.designated_bridge == bridge.bridge_id ? 'designated'
			: 'backup';
	}
	return bp;
}

// JSON view of a bridge: the device view plus STP/VLAN/multicast settings from /sys/class/net/<bridge>/bridge
// and its member ports (with forwarding-table MAC counts), sorted ethernet first then by kind and name.
function bridge_view(name, d, devices, conn) {
	let b = 'bridge/';
	// STP timers are kept in 1/100 s ticks by the kernel; converted to seconds.
	let ticks = (file) => { let v = num(sys(name, b + file)); return v == null ? null : v / 100; };
	let view = device_view(name, d);

	view.stp = sys(name, b + 'stp_state') == '1';
	view.bridge_id = sys(name, b + 'bridge_id');
	view.root_id = sys(name, b + 'root_id');
	view.is_root = view.bridge_id != null && view.bridge_id == view.root_id;
	view.root_port = num(sys(name, b + 'root_port'));
	view.root_path_cost = num(sys(name, b + 'root_path_cost'));
	view.priority = num(sys(name, b + 'priority'));
	view.forward_delay = ticks('forward_delay');
	view.hello_time = ticks('hello_time');
	view.max_age = ticks('max_age');
	view.ageing_time = ticks('ageing_time');
	view.topology_change = sys(name, b + 'topology_change') == '1';
	view.vlan_filtering = sys(name, b + 'vlan_filtering') == '1';
	view.default_pvid = num(sys(name, b + 'default_pvid'));
	view.igmp_snooping = sys(name, b + 'multicast_snooping') == '1';
	view.multicast_querier = sys(name, b + 'multicast_querier') == '1';

	let fdb = fdb_counts(name);
	let members = [];
	for (let m in d['bridge-members'] ?? []) {
		if (!safe_ifname(m))
			continue;
		let md = devices[m] ?? {};
		let mv = device_view(m, md);
		// Member kind: wired port, wifi interface (has a phy80211 link), VLAN device or other.
		let phy = sys(m, 'phy80211/name');
		mv.kind = md.devtype == 'dsa' || md.devtype == 'ethernet' ? 'ethernet' : phy != null ? 'wifi' : md.devtype == 'vlan' ? 'vlan' : 'other';
		if (phy != null) {
			mv.phy = phy;
			mv.ssid = ubus_call(conn, 'hostapd.' + m, 'get_status')?.ssid;
		}
		mv.brport = brport_view(m, view);
		let counts = fdb[`${mv.brport?.port_no}`] ?? { macs: 0, local: 0 };
		mv.macs = counts.macs;
		mv.local_macs = counts.local;
		push(members, mv);
	}
	view.members = sort(members, (a, c) => (a.kind == c.kind ? natural_less(a.name, c.name) : (a.kind == 'ethernet' ? -1 : c.kind == 'ethernet' ? 1 : natural_less(a.kind, c.kind))));

	// Only a non-root bridge has a root port; match it to a member by port number.
	let root_member = filter(members, (m) => m.brport?.port_no != null && m.brport.port_no == view.root_port)[0];
	view.root_port_name = view.stp && !view.is_root ? root_member?.name : null;
	view.macs = 0;
	for (let k, v in fdb)
		view.macs += v.macs;
	return view;
}
//#endregion

//#region Hardware and error diagnostics

// Device-tree vendor prefix (the part of "vendor,model" before the comma) -> display name.
const VENDORS = {
	mediatek: 'MediaTek', realtek: 'Realtek', qca: 'Qualcomm Atheros', qcom: 'Qualcomm', marvell: 'Marvell',
	brcm: 'Broadcom', broadcom: 'Broadcom', airoha: 'Airoha', microchip: 'Microchip', mscc: 'Microsemi',
	nxp: 'NXP', lantiq: 'Lantiq', intel: 'Intel', ralink: 'Ralink', ti: 'TI',
};

// Device-tree "compatible" strings are NUL-separated; "mediatek,mt7531" becomes "MediaTek MT7531".
// Only the first (most specific) entry is used and a "-eth"/"-switch"/"-mac" suffix is dropped.
function compat_label(text) {
	// Non-printable bytes (the NUL separators) become spaces, so the first word is the first entry.
	let first = filter(split(replace(text ?? '', /[^ -~]+/g, ' '), ' '), (s) => s != '')[0];
	let m = match(first ?? '', /^([^,]+),(.+)$/);
	if (!m)
		return null;
	return `${VENDORS[m[1]] ?? (uc(substr(m[1], 0, 1)) + substr(m[1], 1))} ${uc(replace(m[2], /-(eth|switch|mac)$/i, ''))}`;
}

// Last path component of a path or symlink target ("../../drivers/foo" -> "foo"); null when empty.
function last_part(path) {
	let m = match(trim(path ?? ''), /([^\/]+)$/);
	return m ? m[1] : null;
}

//#region Device tree

// Accessors for properties of the device tree under /proc/device-tree (paths are relative to it).
// Printable text of a property (NUL separators become spaces), or null when absent or empty.
function dt_text(path) {
	let raw = sysfs_raw('/proc/device-tree' + path);
	if (raw == null)
		return null;
	let text = trim(replace(raw, /[^ -~]+/g, ' '));
	return text == '' ? null : text;
}

// True when the device-tree node or property exists.
function dt_exists(path) {
	return sysfs_raw('/proc/device-tree' + path) != null;
}

// A property holding one big-endian 32-bit cell (e.g. a phandle or speed), or null when absent or short.
function dt_u32(path) {
	let raw = sysfs_raw('/proc/device-tree' + path);
	if (raw == null || length(raw) < 4)
		return null;
	return (ord(raw, 0) << 24) | (ord(raw, 1) << 16) | (ord(raw, 2) << 8) | ord(raw, 3);
}

// The CPU-facing ports of a DSA switch (those with an "ethernet" property) with their link mode and speed.
// `conduits` maps each candidate SoC MAC to its device-tree node so the "ethernet" phandle can be matched.
function switch_cpu_ports(node, conduits) {
	let out = [];
	for (let ent in split(run(`ls /proc/device-tree${node}/ports 2>/dev/null`), '\n')) {
		let m = match(ent, /^port@([0-9]+)$/);
		if (!m)
			continue;
		let path = `${node}/ports/${ent}`;
		let handle = dt_u32(path + '/ethernet');
		if (handle == null)
			continue;
		let cpu = { port: +m[1], mode: dt_text(path + '/phy-mode'), speed: dt_u32(path + '/fixed-link/speed') };
		for (let c, mac_node in conduits)
			if (dt_u32(mac_node + '/phandle') == handle)
				cpu.conduit = c;
		push(out, cpu);
	}
	// A single CPU port and a single conduit need no phandle matching.
	if (length(out) == 1 && !out[0].conduit && length(keys(conduits)) == 1)
		out[0].conduit = keys(conduits)[0];
	return sort(out, (a, b) => a.port - b.port);
}

// /etc/board.json: which netdevs OpenWrt treats as LAN or WAN ports, in the order the board lists them
// (usually the order printed on the case).
function board_roles() {
	let raw = sysfs('/etc/board.json');
	let board = raw ? json(raw) : null;
	let roles = {}, index = 0;
	for (let net, conf in board?.network ?? {}) {
		for (let dev in conf.ports ?? (conf.device ? [conf.device] : []))
			roles[dev] ??= { role: net, index: index++ };
	}
	return { roles, model: board?.model?.name };
}
//#endregion

// PHY chips on the MDIO buses with the netdev each one is attached to (static, so read once).
// Each entry is { bus, address (PHY address as a number), id (null when 0), name (driver), attached (netdev) }.
let mdio_cache = null;

// Returns the cached list of MDIO PHYs, reading /sys/class/mdio_bus on first use.
function mdio_phys() {
	if (mdio_cache)
		return mdio_cache;
	let out = [];
	for (let bus in split(run('ls /sys/class/mdio_bus 2>/dev/null'), '\n')) {
		if (!safe_ifname(bus))
			continue;
		for (let ent in split(run(`ls /sys/class/mdio_bus/${bus} 2>/dev/null`), '\n')) {
			// PHY devices are named "<bus>:<address as two hex digits>".
			let m = match(ent, /^[A-Za-z0-9_.-]+:([0-9a-f][0-9a-f])$/);
			if (!m || !safe_ifname(ent))
				continue;
			let dir = `/sys/class/mdio_bus/${bus}/${ent}`;
			let id = sysfs(dir + '/phy_id');
			if (id == null)
				continue;
			push(out, {
				bus, address: hex(m[1]), id: id == '0x00000000' ? null : id,
				name: last_part(run(`readlink ${dir}/driver 2>/dev/null`)),
				attached: last_part(run(`readlink ${dir}/attached_dev 2>/dev/null`)),
			});
		}
	}
	mdio_cache = out;
	return out;
}

// Chipset information of a port that does not change while the router runs: driver, switch or SoC MAC,
// and the PHY. Cached per device; null when ethtool reports no driver.
let hardware_cache = {};

// Gathers the hardware facts of netdev `name` (netifd entry `d`) from `ethtool -i`, `ethtool`, the
// device-tree node named in the interface's uevent, and the MDIO PHY list.
function hardware(name, d) {
	if (hardware_cache[name])
		return hardware_cache[name];

	let hw = {};
	for (let line in split(run(`ethtool -i ${name} 2>/dev/null`), '\n')) {
		let m = match(line, /^driver: (.+)$/);
		if (m)
			hw.driver = m[1];
		if ((m = match(line, /^bus-info: (.+)$/)) && m[1] != 'N/A' && m[1] != 'platform')
			hw.bus = m[1];
	}
	if (!hw.driver)
		return null;

	let phyad = null;
	for (let line in split(run(`ethtool ${name} 2>/dev/null`), '\n')) {
		let m = match(line, /PHYAD: ([0-9]+)/);
		if (m)
			phyad = +m[1];
		if ((m = match(line, /^[[:space:]]+Port: (.+)$/)))
			hw.media = m[1];
	}

	// OF_FULLNAME in the uevent is the device-tree path of the node that backs this netdev.
	let node = match(sys(name, 'uevent') ?? '', /OF_FULLNAME=([^\n]+)/);
	if (node) {
		let dt = (path) => compat_label(sysfs('/proc/device-tree' + path + '/compatible'));
		hw.of_node = node[1];
		if (d.devtype == 'dsa') {
			let sw = replace(node[1], /\/ports\/[^\/]+$/, '');
			let pn = match(node[1], /\/port@([0-9]+)$/);
			hw.switch = dt(sw);
			hw.switch_node = sw;
			hw.switch_port = pn ? +pn[1] : null;
			// A port with a phy-handle uses a PHY outside the switch; otherwise the switch's own PHY.
			hw.external_phy = dt_exists(node[1] + '/phy-handle');
			hw.phy_mode = dt_text(node[1] + '/phy-mode');
		}
		else
			hw.soc = dt(replace(node[1], /\/[^\/]+$/, ''));
	}

	// A PHY is either attached to this netdev, or (DSA ports) is the unattached one at the PHY address.
	let phys = mdio_phys();
	let phy = filter(phys, (p) => p.attached == name)[0];
	if (!phy && phyad != null && d.devtype == 'dsa')
		phy = filter(phys, (p) => p.address == phyad && !p.attached)[0];
	if (phy)
		hw.phy = { name: phy.name, id: phy.id, address: phy.address, bus: phy.bus };

	hardware_cache[name] = hw;
	return hw;
}

// Kernel counters that grow with normal traffic and say nothing about errors; excluded from diagnostics.
const NOISE = { rx_bytes: 1, tx_bytes: 1, rx_packets: 1, tx_packets: 1, multicast: 1, rx_compressed: 1, tx_compressed: 1 };

// True when the kernel counters show errors or drops on a port, which triggers the diagnostics lookup.
function has_problems(stats) {
	for (let k in [ 'rx_errors', 'tx_errors', 'rx_crc_errors', 'rx_dropped', 'tx_dropped' ])
		if (stats[k] > 0)
			return true;
	return false;
}

// What is behind a port's error and drop totals: the non-zero kernel counters, the driver's own error
// counters (ethtool -S) and recent kernel log lines that mention the port.
function diagnostics(name, stats) {
	let counters = {};
	for (let k, v in stats)
		if (v > 0 && !NOISE[k])
			counters[k] = v;

	let driver = {};
	for (let line in split(run(`ethtool -S ${name} 2>/dev/null`), '\n')) {
		// `ethtool -S` lines look like "     rx_crc_errors: 3"; keep only counters whose name suggests a fault.
		let m = match(line, /^[[:space:]]+([][A-Za-z0-9_.-]+): ([0-9]+)$/);
		if (m && +m[2] > 0 && match(m[1], /err|drop|crc|fail|discard|collision|underrun|overrun|fifo|abort|miss|lost|timeout|invalid|bad/i))
			driver[m[1]] = +m[2];
	}

	// Only the last 8 lines are kept.
	let log = filter(split(run(`logread -e '${name}' 2>/dev/null`), '\n'), (l) => l != '');
	return { counters, driver, log: slice(log, -8) };
}
//#endregion

// Interfaces that run over another interface (tunnels: `option tunlink`), as { interface: underlying interface }.
function tunlinks() {
	let out = {};
	for (let name, s in uci_all('network'))
		if (s['.type'] == 'interface' && s.tunlink)
			out[name] = s.tunlink;
	return out;
}

// Firewall zones: which netifd interfaces each contains, its default policies, NAT, and the zones it may
// forward to (the `forwarding` sections), so the interface table can say what a network is allowed to reach.
function firewall_zones() {
	let all = uci_all('firewall');
	let zones = [];
	for (let name, s in all) {
		if (s['.type'] != 'zone')
			continue;
		let forwards = [];
		for (let n2, f in all)
			if (f['.type'] == 'forwarding' && f.src == s.name && f.dest)
				push(forwards, f.dest);
		push(zones, {
			name: s.name, networks: as_list(s.network),
			input: s.input ?? 'REJECT', output: s.output ?? 'REJECT', forward: s.forward ?? 'REJECT',
			masq: s.masq == '1', forwards,
		});
	}
	return zones;
}

// DHCP / router-advertisement service per interface (UCI dhcp, served by dnsmasq and odhcpd), as
// { interface: { v4, v6, ra, start, limit, leasetime } }. Only the settings an operator looks for.
function dhcp_services() {
	let out = {};
	for (let name, s in uci_all('dhcp')) {
		if (s['.type'] != 'dhcp' || !s.interface)
			continue;
		out[s.interface] = {
			v4: s.ignore == '1' ? 'disabled' : (s.dhcpv4 ?? 'server'),
			v6: s.dhcpv6 ?? 'disabled', ra: s.ra ?? 'disabled',
			start: num(s.start), limit: num(s.limit), leasetime: s.leasetime,
		};
	}
	return out;
}

// Builds the flab.network status reply: Ethernet ports (switch ports, NICs and CPU conduits) with their
// hardware, bridges with members and STP state, VLAN devices, DSA switch wiring and the per-interface
// zone/DHCP/tunnel context.
function collect() {
	let conn = connect();
	let devices = ubus_call(conn, 'network.device', 'status', {}) ?? {};

	let ports = [], bridges = [], vlans = [];
	// Bridge each port name belongs to.
	let in_bridge = {};
	// Names of the SoC MAC devices that DSA switch ports use as their CPU conduit.
	let conduits = {};

	// A first pass finds the conduits so the second can label each port's role regardless of sort order.
	for (let name in sort(keys(devices))) {
		let d = devices[name];
		if (!safe_ifname(name) || !d.present)
			continue;
		if (d.conduit)
			conduits[d.conduit] = true;
	}

	for (let name in sort(keys(devices), natural_less)) {
		let d = devices[name];
		if (!safe_ifname(name) || !d.present)
			continue;

		if (d.devtype == 'bridge') {
			let b = bridge_view(name, d, devices, conn);
			for (let m in b.members)
				in_bridge[m.name] = b;
			push(bridges, b);
		}
		else if (d.devtype == 'vlan')
			push(vlans, { name, parent: d.parent, vid: d.vid, up: d.up ?? false, carrier: d.carrier ?? false, mac: d.macaddr, stats: stats_view(d) });
		else if (d.devtype == 'dsa' || d.devtype == 'ethernet') {
			let p = device_view(name, d);
			p.role = d.devtype == 'dsa' ? 'switch' : conduits[name] ? 'conduit' : 'nic';
			p.conduit = d.conduit;
			p.hardware = hardware(name, d);
			if (has_problems(p.stats))
				p.diagnostics = diagnostics(name, p.stats);
			push(ports, p);
		}
	}

	// Switch ports first (they are what is on the case), then standalone NICs, then the CPU conduit.
	const order = { switch: 0, nic: 1, conduit: 2 };
	ports = sort(ports, (a, b) => order[a.role] != order[b.role] ? order[a.role] - order[b.role] : natural_less(a.name, b.name));

	// Attach bridge membership, learned-MAC counts and VLAN children to each port and bridge.
	for (let p in ports) {
		let b = in_bridge[p.name];
		let m = b ? filter(b.members, (x) => x.name == p.name)[0] : null;
		p.bridge = b?.name;
		p.brport = m?.brport;
		p.macs = m?.macs;
		p.vlans = filter(vlans, (v) => v.parent == p.name);
	}
	for (let b in bridges)
		b.vlans = filter(vlans, (v) => v.parent == b.name);

	// Wiring of the board, all read from the device tree and /etc/board.json so it follows any router:
	// which switch chip each DSA port belongs to, the switch's CPU ports and which SoC MAC they reach.
	let board = board_roles();
	for (let p in ports)
		p.board = board.roles[p.name];

	// Device-tree nodes of the conduit MACs, used to match the switch CPU ports' "ethernet" phandles.
	let conduit_nodes = {};
	for (let p in ports)
		if (p.role == 'conduit' && p.hardware?.of_node)
			conduit_nodes[p.name] = p.hardware.of_node;

	// One entry per distinct switch chip, listing the ports that belong to it.
	let switches = [];
	let seen = {};
	for (let p in ports) {
		let node = p.hardware?.switch_node;
		if (!node || seen[node])
			continue;
		seen[node] = true;
		let members = filter(ports, (x) => x.hardware?.switch_node == node);
		push(switches, {
			node, label: p.hardware.switch,
			ports: map(members, (x) => x.name),
			cpu_ports: switch_cpu_ports(node, conduit_nodes),
		});
	}

	return { generated: time(), model: board.model, ports, bridges, vlans, switches, tunlinks: tunlinks(), zones: firewall_zones(), dhcp: dhcp_services() };
}

// rpcd registration: ubus object flab.network with the single method `status` (no arguments).
return {
	'flab.network': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
};
