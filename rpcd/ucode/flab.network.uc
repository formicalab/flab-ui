#!/usr/bin/ucode
//
// rpcd ucode plugin reporting physical Ethernet ports, bridges, VLAN devices and the board's switch wiring as JSON:
//   ubus call flab.network status
//   ubus call flab.network config   (the editable part of /etc/config/network, recognized secret options omitted)
//   ubus call flab.network cable_test '{"port":"lan1"}'   (on request: it can drop the link for a few seconds)
//
// Everything is discovered at run time (nothing is hard-coded to this router's port names), so a changed
// board layout, a new bridge or a new VLAN device shows up on the next poll.
//
// Sources:
//   - netifd (network.device status): device types, link speed and negotiation, bridge membership, counters
//   - sysfs: carrier and link-flap counters, bridge/STP state (/sys/class/net/<if>/bridge and brport)
//   - the bridge forwarding table (/sys/class/net/<bridge>/brforward): learned MAC addresses per port
//   - ethtool, /sys/class/mdio_bus, /proc/device-tree and /etc/board.json: driver, PHY and switch wiring, EEE, optical modules (ethtool -m)
//   - swconfig (older boards whose switch ports are not network devices) and `bridge vlan show` or the bridge-vlan sections of UCI network
//   - UCI network, firewall and dhcp: tunnel links, zone membership and DHCP/RA service per interface
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';
import { deferred } from 'flab.worker';

import { connect } from 'ubus';
import { readfile } from 'fs';
import { fixture, record_file, run, command_result, ubus_call, uci_all, sysfs, sysfs_raw, safe_ifname, num, as_list, normalize_mac } from 'flab.util';

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
// The full port number is port + (high byte << 8).
function fdb_entries(bridge) {
	let raw = fixture('brforward_' + bridge);
	if (raw == null) {
		raw = readfile(`/sys/class/net/${bridge}/brforward`) ?? '';
		record_file('brforward_' + bridge, raw);
	}

	let out = [];
	for (let i = 0; i + 16 <= length(raw); i += 16) {
		let port = ord(raw, i + 6) + (ord(raw, i + 12) << 8);
		let mac = sprintf('%02x:%02x:%02x:%02x:%02x:%02x',
			ord(raw, i), ord(raw, i + 1), ord(raw, i + 2),
			ord(raw, i + 3), ord(raw, i + 4), ord(raw, i + 5));
		push(out, { port, mac, local: ord(raw, i + 7) != 0 });
	}
	return out;
}

function fdb_counts(bridge) {
	let out = {};
	for (let entry in fdb_entries(bridge)) {
		let port = `${entry.port}`;
		out[port] ??= { macs: 0, local: 0 };
		if (entry.local)
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
	let base = 'brport/';
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

//#region Connected Ethernet devices

// Active DHCPv4 leases keyed by normalized MAC, including dnsmasq's lease file when odhcpd is not the server.
function ethernet_leases(conn) {
	let map = {};
	let reply = ubus_call(conn, 'dhcp', 'ipv4leases', {}) ?? {};
	for (let dev, value in reply.device ?? {})
		for (let lease in value.leases ?? []) {
			let mac = normalize_mac(lease.mac ?? '');
			if (mac)
				map[mac] = lease;
		}
	for (let line in split(readfile('/tmp/dhcp.leases') ?? '', '\n')) {
		let p = split(line, /\s+/);
		let mac = length(p) >= 5 ? normalize_mac(p[1]) : null;
		if (mac)
			map[mac] = { address: p[2], hostname: p[3] != '*' ? p[3] : null };
	}
	return map;
}

// Host labels use static DHCP reservations first, then active DHCP names and /etc/ethers.
function ethernet_names(leases) {
	let names = {};
	for (let name, section in uci_all('dhcp')) {
		if (section['.type'] != 'host')
			continue;
		for (let raw in as_list(section.mac)) {
			let mac = normalize_mac(raw);
			if (mac && section.name)
				names[mac] = section.name;
		}
	}
	for (let mac, lease in leases)
		if (!names[mac] && lease.hostname)
			names[mac] = lease.hostname;
	for (let line in split(readfile('/etc/ethers') ?? '', '\n')) {
		let p = split(line, /\s+/);
		let mac = length(p) >= 2 ? normalize_mac(p[0]) : null;
		if (mac && !names[mac])
			names[mac] = p[1];
	}
	return names;
}

function ethernet_addresses(leases) {
	let ipv4 = {}, ipv6 = {};
	for (let mac, lease in leases)
		if (lease.address)
			ipv4[mac] = lease.address;
	// ARP fills addresses for clients which do not currently have a DHCP lease.
	for (let line in split(readfile('/proc/net/arp') ?? '', '\n')) {
		let p = split(line, /\s+/);
		let mac = length(p) >= 6 && (+p[2] & 2) ? normalize_mac(p[3]) : null;
		if (mac && !ipv4[mac] && p[3] != '00:00:00:00:00:00')
			ipv4[mac] = p[0];
	}
	for (let line in split(run('ip -6 neigh show 2>/dev/null'), '\n')) {
		let p = split(line, /\s+/), ll = index(p, 'lladdr');
		let mac = ll >= 0 && ll + 1 < length(p) ? normalize_mac(p[ll + 1]) : null;
		let state = p[length(p) - 1];
		if (mac && state != 'FAILED' && state != 'INCOMPLETE') {
			ipv6[mac] ??= [];
			if (index(ipv6[mac], p[0]) < 0)
				push(ipv6[mac], p[0]);
		}
	}
	return { ipv4, ipv6 };
}

// Ethernet clients observed through each bridge member's forwarding table. Multiple devices can be learned on one
// physical port when an unmanaged switch is attached; the reply intentionally says "port", not "directly connected".
function ethernet_clients() {
	let conn = connect();
	let devices = ubus_call(conn, 'network.device', 'status', {}) ?? {};
	let leases = ethernet_leases(conn);
	let names = ethernet_names(leases);
	let addresses = ethernet_addresses(leases);
	let clients = [];
	let links = {};

	for (let bridge, device in devices) {
		if (!safe_ifname(bridge) || device.devtype != 'bridge')
			continue;
		let ports = {};
		for (let member in device['bridge-members'] ?? []) {
			let memberDevice = devices[member] ?? {};
			if (memberDevice.devtype != 'dsa' && memberDevice.devtype != 'ethernet')
				continue;
			let portNo = hex_value(sys(member, 'brport/port_no'));
			if (portNo != null)
				ports[`${portNo}`] = member;
		}
		for (let entry in fdb_entries(bridge)) {
			let port = ports[`${entry.port}`];
			if (!port || entry.local)
				continue;
			// Every client of a port shares its link, so the sysfs reads of device_view() happen once per port.
			links[port] ??= device_view(port, devices[port] ?? {});
			let deviceView = links[port];
			push(clients, {
				bridge,
				port,
				mac: entry.mac,
				ipv4: addresses.ipv4[entry.mac],
				ipv6: addresses.ipv6[entry.mac] ?? [],
				hostname: names[entry.mac],
				speed: deviceView.speed,
				duplex: deviceView.duplex,
			});
		}
	}

	clients = sort(clients, (a, b) => {
		let byPort = natural_less(a.port, b.port);
		return byPort != 0 ? byPort : (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0);
	});
	return { generated: time(), clients };
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
			if (mac_node != '' && dt_u32(mac_node + '/phandle') == handle)
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
	return { roles, model: board?.model?.name, switch: board?.switch };
}
//#endregion

// PHY chips on the MDIO buses with the netdev each one is attached to (read once per worker).
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
// and the PHY. Cached per device within this worker; null when ethtool reports no driver.
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
		// ethtool is not installed on every router (small repeaters leave it out): the driver link of the
		// device then names the driver.
		hw.driver = last_part(run(`readlink /sys/class/net/${name}/device/driver 2>/dev/null`)) || null;
	if (!hw.driver)
		return null;

	let phyad = null;
	for (let line in split(run(`ethtool ${name} 2>/dev/null`), '\n')) {
		let m = match(line, /PHYAD: ([0-9]+)/);
		if (m)
			phyad = +m[1];
		if ((m = match(line, /^[[:space:]]+Port: (.+)$/)))
			hw.media = m[1];
		// "Supported ports: [ TP MII ]" or "[ FIBRE ]": a FIBRE port is an optical cage.
		if ((m = match(line, /Supported ports: \[ ?([^\]]*)\]/)))
			hw.ports = filter(split(trim(m[1]), ' '), (s) => s != '');
	}

	// OF_FULLNAME in the uevent is the device-tree path of the node that backs this netdev. Some drivers (the
	// IPQ4019 Ethernet MAC) leave it off the netdev; its parent device then names the node.
	let node = match(sys(name, 'uevent') ?? '', /OF_FULLNAME=([^\n]+)/);
	if (!node && d.devtype != 'dsa')
		node = match(sys(name, 'device/uevent') ?? '', /OF_FULLNAME=([^\n]+)/);
	// The path reaches `ls` command lines below, so only the characters of device-tree node names are accepted (a carriage return is
	// refused explicitly: the capture above stops at a line feed, and the anchored pattern would take the first line of a longer string).
	if (node && (index(node[1], '\r') >= 0 || !match(node[1], /^(\/[A-Za-z0-9,._+@-]+)+$/)))
		node = null;
	if (node) {
		let dt = (path) => compat_label(sysfs('/proc/device-tree' + path + '/compatible'));
		hw.of_node = node[1];
		// A `sfp` property points at the optical cage that the port is wired to.
		hw.sfp_dt = dt_exists(node[1] + '/sfp');
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

//#region EEE, optical modules, cable test

// Energy-Efficient Ethernet state of a port from `ethtool --show-eee`: { enabled, active }, or null when the PHY or driver has
// no EEE (an unsupported port is not asked again within the same worker).
let eee_unsupported = {};

// Reads the EEE state of port `name`.
function eee_view(name) {
	if (eee_unsupported[name])
		return null;
	let m = match(run(`ethtool --show-eee ${name} 2>/dev/null`) ?? '', /EEE status: ([a-z]+)( - ([a-z]+))?/);
	if (!m) {
		eee_unsupported[name] = true;
		return null;
	}
	return { enabled: m[1] == 'enabled', active: m[3] == 'active' };
}

// The number at the start of a text like "38.80 degrees C / 101.84 degrees F", or null.
function first_number(text) {
	let m = match(text ?? '', /^(-?[0-9]+(\.[0-9]+)?)/);
	return m ? +m[1] : null;
}

// The dBm figure of a text like "0.3322 mW / -4.79 dBm" (null for "-inf" or when absent).
function dbm_of(text) {
	let m = match(text ?? '', /\/ (-?[0-9]+(\.[0-9]+)?) dBm/);
	return m ? +m[1] : null;
}

// The text in parentheses of a value like "0x03 (SFP)", or the value itself.
function paren_of(text) {
	let m = match(text ?? '', /\(([^)]*)\)/);
	return m ? m[1] : (text == '' ? null : text);
}

// Parses `ethtool -m` (the SFF-8472 module data) into the module and its optical diagnostics; null when the text is not
// module data (no module inserted, or the port is not a cage). The key names are those of ethtool's output; a key that
// appears twice keeps its first value, and every key that ends in "alarm" or "warning" and reads "On" is listed.
function sfp_parse(text) {
	let kv = {}, alarms = [], warnings = [];
	for (let line in split(text, '\n')) {
		let m = match(line, /^[[:space:]]*([^:]*[^:[:space:]])[[:space:]]*:[[:space:]]*(.*)$/);
		if (!m)
			continue;
		let val = trim(m[2]);
		kv[m[1]] ??= val;
		if (val == 'On' && match(m[1], / (alarm|warning)$/))
			push(match(m[1], / alarm$/) ? alarms : warnings, replace(m[1], / (alarm|warning)$/, ''));
	}
	if (kv.Identifier == null)
		return null;
	return {
		present: true,
		identifier: paren_of(kv.Identifier),
		connector: paren_of(kv.Connector),
		type: kv['Transceiver type'],
		vendor: kv['Vendor name'],
		part: kv['Vendor PN'],
		revision: kv['Vendor rev'],
		serial: kv['Vendor SN'],
		date: kv['Date code'],
		wavelength_nm: first_number(kv['Laser wavelength']),
		diagnostics: kv['Optical diagnostics support'] == 'Yes',
		temperature_c: first_number(kv['Module temperature']),
		voltage_v: first_number(kv['Module voltage']),
		tx_bias_ma: first_number(kv['Laser bias current']),
		tx_power_dbm: dbm_of(kv['Laser output power']),
		rx_power_dbm: dbm_of(kv['Receiver signal average optical power']),
		alarms,
		warnings,
	};
}

// What is in the optical cage of port `name`: the module and its diagnostics, or { present: false } when nothing answers.
function sfp_view(name) {
	return sfp_parse(run(`ethtool -m ${name} 2>/dev/null`) ?? '') ?? { present: false };
}

// Whether a port (by its hardware facts) is an optical cage or a direct-attach cable port: the device tree wires it to an SFP,
// ethtool lists FIBRE among its ports, or the port type is fibre or direct attach.
function sfp_candidate(hw) {
	return hw != null && (hw.sfp_dt == true || index(hw.ports ?? [], 'FIBRE') >= 0 || hw.media == 'FIBRE' || hw.media == 'Direct Attach');
}

// Process-local unsupported-port memo. It persists in direct-call harnesses, not across production workers, so the page keeps its own
// memory of a `supported: false` reply (www/js/pages/network/cable.js).
let cable_unsupported = {};

// The reply of `cable_test`: runs `ethtool --cable-test` on one physical port and returns the result of each of the four
// pairs. A PHY that supports it drops the link for a few seconds, so this is only called on request. Anything that is not a
// physical Ethernet port (a bridge, a VLAN device, the SoC MAC that feeds a switch) is refused before a command is built. The
// exec helper stops the command after its own 20-second limit, whatever the `timeout` in the command line says.
//   { ok, port, pairs: [{ pair, code, length_m }] } or { ok: false, port, supported, error }
function cable_test(request) {
	let port = request?.args?.port;
	let fail = (error, supported) => ({ ok: false, port: type(port) == 'string' && safe_ifname(port) ? port : null, supported, error });
	if (type(port) != 'string' || !safe_ifname(port))
		return fail('The port name is not valid.', null);
	let conn = connect();
	let devices = ubus_call(conn, 'network.device', 'status', {}) ?? {};
	let d = devices[port];
	if (!d || !d.present || (d.devtype != 'dsa' && d.devtype != 'ethernet'))
		return fail('That is not a physical Ethernet port.', null);
	for (let n, other in devices)
		if (other.conduit == port)
			return fail('That is the internal link to the switch, not a cable.', null);
	if (cable_unsupported[port])
		return fail('The PHY driver of this port does not support cable testing.', false);

	let result = command_result(`timeout 30 ethtool --cable-test ${port} 2>&1`);
	let out = result.output;
	if (match(out, /not support|Operation not supported|Not supported/i)) {
		cable_unsupported[port] = true;
		return fail('The PHY driver of this port does not support cable testing.', false);
	}
	if (!result.ok)
		return fail(result.timed_out ? 'The cable test timed out.' : (result.truncated ? 'The cable test exceeded its output budget.' : `The cable test failed (exit ${result.code ?? 'unknown'}).`), null);
	let pairs = {};
	for (let line in split(out, '\n')) {
		let code = match(line, /Pair ([A-D]) code (.+)$/);
		if (code)
			pairs[code[1]] = { pair: code[1], code: trim(code[2]), length_m: null };
		let len = match(line, /Pair ([A-D]), fault length: ([0-9.]+)m/);
		if (len) {
			pairs[len[1]] ??= { pair: len[1], code: 'Fault', length_m: null };
			pairs[len[1]].length_m = +len[2];
		}
	}
	if (!length(keys(pairs))) {
		let text = trim(replace(out, /[^ -~\n]+/g, ' '));
		return fail(text == '' ? 'The test returned nothing.' : `The test did not complete: ${substr(text, 0, 200)}`, null);
	}
	return { ok: true, port, supported: true, pairs: map(sort(keys(pairs)), (k) => pairs[k]) };
}
//#endregion

//#region Bridge VLAN tables

// The VLANs the kernel has on each bridge port, from `bridge vlan show` (iproute2's `bridge`, which small builds leave out),
// as { port: [{ vid, pvid, untagged }] }. The lines are "port  vid flags"; a continuation line has no port name.
function bridge_vlan_live() {
	let out = {}, port = null;
	for (let line in split(run('bridge vlan show 2>/dev/null') ?? '', '\n')) {
		let m = match(line, /^([^[:space:]]+)?[[:space:]]+([0-9]+)(.*)$/);
		if (!m)
			continue;
		port = m[1] ?? port;
		if (port == null)
			continue;
		out[port] ??= [];
		push(out[port], { vid: +m[2], pvid: match(m[3], /PVID/) != null, untagged: match(m[3], /Untagged/) != null });
	}
	return out;
}

// The VLAN table of bridge `b` as { source, vlans: [{ vid, ports: [{ name, tagged, pvid }] }] }: from the kernel when `bridge`
// is installed, else from the `bridge-vlan` sections of the network config ("lan1:t" is tagged, "lan2:u*" untagged and the
// PVID). null when the bridge has no VLANs and does no VLAN filtering.
function vlan_table(b, live, conf) {
	let names = map(b.members, (m) => m.name);
	let by_vid = {}, source = null;
	// Adds a port to a VLAN of the table.
	let add = (vid, name, tagged, pvid) => {
		by_vid[vid] ??= { vid, ports: [] };
		push(by_vid[vid].ports, { name, tagged, pvid });
	};
	for (let port, list in live) {
		if (port != b.name && index(names, port) < 0)
			continue;
		for (let e in list) {
			add(e.vid, port, !e.untagged, e.pvid);
			source = 'kernel';
		}
	}
	if (source == null) {
		for (let name, s in conf) {
			if (s['.type'] != 'bridge-vlan' || s.device != b.name || !+s.vlan)
				continue;
			for (let entry in as_list(s.ports)) {
				let m = match(entry, /^([^:]+)(:(.*))?$/);
				if (m) {
					add(+s.vlan, m[1], match(m[3] ?? '', /t/) != null, match(m[3] ?? '', /\*/) != null);
					source = 'config';
				}
			}
		}
	}
	if (source == null && !b.vlan_filtering)
		return null;
	return { source, vlans: sort(map(keys(by_vid), (k) => by_vid[k]), (a, c) => a.vid - c.vid) };
}
//#endregion

//#region swconfig switches

// The attribute blocks of `swconfig dev <switch> show`: { global, ports: { n: {...} }, vlans: [{...}] }. Every line inside a
// block is "name: value"; the blocks start with "Global attributes:", "Port N:" and "VLAN N:".
function swconfig_show(text) {
	let out = { global: {}, ports: {}, vlans: [] }, cur = out.global;
	for (let line in split(text, '\n')) {
		let p = match(line, /^Port ([0-9]+):/), v = match(line, /^VLAN ([0-9]+):/);
		if (p)
			cur = out.ports[p[1]] = { num: +p[1] };
		else if (v) {
			cur = { index: +v[1] };
			push(out.vlans, cur);
		}
		else if (match(line, /^Global attributes:/))
			cur = out.global;
		else {
			let kv = match(line, /^[[:space:]]+([A-Za-z0-9_]+): ?(.*)$/);
			if (kv)
				cur[kv[1]] = trim(kv[2]);
		}
	}
	return out;
}

// The link of a swconfig port from its `link:` attribute ("port:1 link:up speed:1000baseT full-duplex txflow rxflow").
function swconfig_link(text) {
	let up = match(text ?? '', /link:up/) != null;
	let speed = match(text ?? '', /speed:([0-9]+)base/);
	let flow = [];
	if (match(text ?? '', /rxflow/))
		push(flow, 'rx');
	if (match(text ?? '', /txflow/))
		push(flow, 'tx');
	return {
		carrier: up,
		speed: up && speed ? +speed[1] : null,
		duplex: up ? (match(text, /half-duplex/) ? 'half' : match(text, /full-duplex/) ? 'full' : null) : null,
		flow,
	};
}

// Switches that the kernel drives through swconfig rather than DSA (older boards: the switch ports are not network devices, so
// they only exist here). For each switch of `swconfig list` this returns the switch entry (with its VLAN groups) and one port
// object per user port, shaped like a DSA port, plus the name of the netdev that is the switch's CPU conduit.
// `board_switch` is the `switch` section of /etc/board.json, which names the CPU device and the role (lan/wan) of each port.
function swconfig_switches(board_switch) {
	let switches = [], ports = [];
	for (let line in split(run('swconfig list 2>/dev/null') ?? '', '\n')) {
		let f = match(line, /^Found: ([A-Za-z0-9_.-]+)/);
		if (!f || !safe_ifname(f[1]))
			continue;
		let name = f[1];
		let help = match(run(`swconfig dev ${name} help 2>/dev/null`) ?? '', /^[^:]+: ([^(]+)\(([^)]*)\), ports: ([0-9]+) \(cpu @ ([0-9]+)\), vlans: ([0-9]+)/);
		let show = swconfig_show(run(`swconfig dev ${name} show 2>/dev/null`) ?? '');
		let conf = board_switch?.[name] ?? {};
		let cpu = help ? +help[4] : null, conduit = null;
		for (let bp in conf.ports ?? []) {
			if (bp.device) {
				conduit = bp.device;
				cpu ??= +bp.num;
			}
		}
		let node = `swconfig:${name}`;
		let label = help ? uc(trim(help[1])) : name;
		let sw = { node, kind: 'swconfig', label, ports: [], cpu_ports: [{ port: cpu, conduit, mode: null, speed: null }], vlans: [], vlan_enabled: show.global.enable_vlan == '1' };

		let position = 0;
		for (let num in sort(map(keys(show.ports), (k) => +k))) {
			let attrs = show.ports[`${num}`];
			if (num == cpu)
				continue;
			let role = filter(conf.ports ?? [], (bp) => bp.num == num)[0];
			let link = swconfig_link(attrs.link);
			let port = `port${num}`;
			push(sw.ports, port);
			push(ports, {
				name: port, type: 'swconfig', up: true, carrier: link.carrier, operstate: link.carrier ? 'up' : 'down',
				mac: null, mtu: null, speed: link.speed, duplex: link.duplex, autoneg: null, max_speed: null, partner_max: null,
				downshifted: false, flow: link.flow, carrier_changes: null, link_ups: null, link_downs: null, stats: {},
				role: 'switch', conduit, pvid: attrs.pvid != null ? +attrs.pvid : null,
				board: role?.role ? { role: role.role, index: 500 + position } : { index: 500 + position },
				hardware: { driver: 'swconfig', switch: label, switch_node: node, switch_port: num, external_phy: false },
			});
			position++;
		}
		for (let v in show.vlans) {
			let members = [];
			for (let tok in split(v.ports ?? '', ' ')) {
				let m = match(tok, /^([0-9]+)(t?)$/);
				if (m && +m[1] != cpu)
					push(members, { name: `port${m[1]}`, tagged: m[2] == 't' });
			}
			if (length(members))
				push(sw.vlans, { vid: +(v.vid ?? v.index), ports: members });
		}
		push(switches, sw);
	}
	return { switches, ports };
}
//#endregion

// Interfaces that run over another interface (tunnels: `option tunlink`), as { interface: underlying interface }; `all` is the
// network config (uci_all).
function tunlinks(all) {
	let out = {};
	for (let name, s in all)
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
			// Live state that the page shows next to the link: EEE, the optical module and whether a cable test is known to be
			// impossible (null until it has been tried).
			p.eee = p.carrier ? eee_view(name) : null;
			p.sfp = sfp_candidate(p.hardware) ? sfp_view(name) : null;
			p.cable_test = cable_unsupported[name] ? false : null;
			if (has_problems(p.stats))
				p.diagnostics = diagnostics(name, p.stats);
			push(ports, p);
		}
	}

	// Switches driven through swconfig have no network device per port: their ports are added here, and the netdev that carries
	// them to the SoC becomes the switch's conduit instead of a jack of its own.
	let board = board_roles();
	let swc = swconfig_switches(board.switch);
	for (let sw in swc.switches)
		for (let cp in sw.cpu_ports)
			for (let p in ports)
				if (p.name == cp.conduit && p.role == 'nic')
					p.role = 'conduit';
	for (let sp in swc.ports)
		push(ports, sp);

	// Switch ports first (they are what is on the case), then standalone NICs, then the CPU conduit.
	const order = { switch: 0, nic: 1, conduit: 2 };
	ports = sort(ports, (a, b) => order[a.role] != order[b.role] ? order[a.role] - order[b.role] : natural_less(a.name, b.name));

	// Attach bridge membership, learned-MAC counts and VLAN children to each port and bridge. A swconfig port is not a bridge
	// member itself: the VLAN devices of its switch (eth0.1, ...) that carry it are, so it takes the bridge and the VLANs from them.
	for (let p in ports) {
		if (p.type == 'swconfig') {
			let groups = filter(swc.switches, (s) => s.node == p.hardware.switch_node)[0]?.vlans ?? [];
			let mine = filter(groups, (g) => length(filter(g.ports, (m) => m.name == p.name)) > 0);
			p.vlans = filter(vlans, (v) => v.parent == p.conduit && length(filter(mine, (g) => g.vid == v.vid)) > 0);
			p.bridge = in_bridge[p.vlans[0]?.name]?.name;
			continue;
		}
		let b = in_bridge[p.name];
		let m = b ? filter(b.members, (x) => x.name == p.name)[0] : null;
		p.bridge = b?.name;
		p.brport = m?.brport;
		p.macs = m?.macs;
		p.vlans = filter(vlans, (v) => v.parent == p.name);
	}
	let live_vlans = bridge_vlan_live();
	let net_conf = uci_all('network');
	for (let b in bridges) {
		b.vlans = filter(vlans, (v) => v.parent == b.name);
		b.vlan_table = vlan_table(b, live_vlans, net_conf);
	}

	// Wiring of the board, all read from the device tree and /etc/board.json so it follows any router:
	// which switch chip each DSA port belongs to, the switch's CPU ports and which SoC MAC they reach.
	for (let p in ports)
		p.board = board.roles[p.name] ?? p.board;

	// Device-tree nodes of the conduit MACs, used to match the switch CPU ports' "ethernet" phandles. A conduit
	// whose node is unknown is still listed (with an empty node), so a single CPU port can be matched to it.
	let conduit_nodes = {};
	for (let p in ports)
		if (p.role == 'conduit')
			conduit_nodes[p.name] = p.hardware?.of_node ?? '';

	// One entry per distinct switch chip, listing the ports that belong to it.
	let switches = [];
	let seen = {};
	for (let p in ports) {
		let node = p.hardware?.switch_node;
		if (!node || seen[node] || p.type == 'swconfig')
			continue;
		seen[node] = true;
		let members = filter(ports, (x) => x.hardware?.switch_node == node);
		push(switches, {
			node, label: p.hardware.switch,
			ports: map(members, (x) => x.name),
			cpu_ports: switch_cpu_ports(node, conduit_nodes),
		});
	}
	for (let sw in swc.switches)
		push(switches, sw);

	return { generated: time(), model: board.model, ports, bridges, vlans, switches, tunlinks: tunlinks(net_conf), zones: firewall_zones(), dhcp: dhcp_services() };
}

// Options whose value is a secret (PPPoE and modem passwords, SIM PINs, WireGuard and pre-shared keys, 802.1x and WPA keys): never
// returned by `config`, only whether they are set.
const SECRET_OPTION = /^(password|passwd|pin|pincode|[a-z0-9_]*(passw|secret|psk|key|token|credential)[a-z0-9_]*)$/i;

// The options of one UCI section that may be shown, and which secrets are set: { values, secrets: { option: true } }.
// Bookkeeping keys (.type, .name, ...) are left out.
function section_options(sec) {
	let values = {}, secrets = {};
	for (let k, v in sec) {
		if (substr(k, 0, 1) == '.')
			continue;
		if (match(k, SECRET_OPTION)) {
			if (type(v) == 'array' ? length(v) > 0 : (v != null && v != ''))
				secrets[k] = true;
			continue;
		}
		values[k] = v;
	}
	return { values, secrets };
}

// The sections of one type in file order, as [{ section, anonymous, values, secrets }].
function sections_of(all, kind) {
	let list = [];
	for (let name, s in all)
		if (s['.type'] == kind)
			push(list, { index: s['.index'] ?? 0, section: name, anonymous: s['.anonymous'] == true, ...section_options(s) });
	return map(sort(list, (a, b) => a.index - b.index), (x) => ({ section: x.section, anonymous: x.anonymous, values: x.values, secrets: x.secrets }));
}

// Builds the flab.network config reply: the `interface` and `device` sections of /etc/config/network without any secret (they are only
// reported as set), the `globals` section (its options are network-wide settings, none a secret), the number of sections of every other
// type, and the devices that have `bridge-vlan` sections. Everything the Devices and Interfaces page edits is here; the other sections
// (routes, rules, WireGuard peers, switch VLANs) are not.
function network_config() {
	let all = uci_all('network');
	let other = {}, bridge_vlans = [];
	let globals = sections_of(all, 'globals');
	for (let name, s in all) {
		let t = s['.type'];
		if (t == 'interface' || t == 'device')
			continue;
		other[t] = (other[t] ?? 0) + 1;
		if (t == 'bridge-vlan')
			push(bridge_vlans, { section: name, device: s.device, vlan: s.vlan });
	}
	// The first globals section is the one netifd reads; a second one is only counted.
	if (length(globals) > 0) {
		other.globals -= 1;
		if (!other.globals)
			delete other.globals;
	}
	return { generated: time(), interfaces: sections_of(all, 'interface'), devices: sections_of(all, 'device'), globals: globals[0] ?? null, other, bridge_vlans };
}

// rpcd registration: ubus object flab.network. `status` takes no arguments; `clients` reports learned Ethernet devices;
// `config` returns the editable part of the network config without secrets; `cable_test` runs one cable test on request.
return deferred({
	'flab.network': {
		status: {
			call: function(request) {
				return collect();
			},
		},
		clients: {
			call: function(request) {
				return ethernet_clients();
			},
		},
		config: {
			call: function(request) {
				return network_config();
			},
		},
		cable_test: {
			args: { port: '' },
			call: function(request) {
				return cable_test(request);
			},
		},
	},
});
