#!/usr/bin/ucode
//
// rpcd ucode plugin reporting physical Ethernet ports and bridges as JSON:
//   ubus call flab.network status
//
// Everything is discovered at run time (nothing is hard-coded to this router's port names), so a changed
// board layout, a new bridge or a new VLAN device shows up on the next poll.
//
// Sources (no LuCI component is used):
//   - netifd (network.device status): device types, link speed and negotiation, bridge membership, counters
//   - sysfs: carrier and link-flap counters, bridge/STP state (/sys/class/net/<if>/bridge and brport)
//   - the bridge forwarding table (/sys/class/net/<bridge>/brforward): learned MAC addresses per port
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { connect } from 'ubus';
import { readfile } from 'fs';
import { fixture, record_file, run, ubus_call, sysfs, safe_ifname, num } from 'flab.util';

const STP_STATES = [ 'disabled', 'listening', 'learning', 'forwarding', 'blocking' ];

//#region Helpers

function sys(dev, file) {
	return safe_ifname(dev) ? sysfs(`/sys/class/net/${dev}/${file}`) : null;
}

function hex_value(text) {
	return text == null ? null : hex(replace(text, /^0x/, ''));
}

// netifd reports the negotiated speed as "2500F" (Mbit/s plus F/H for full/half duplex).
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

// "lan10" sorts after "lan2".
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
// (16 bytes per entry: MAC[6], port, is_local, ageing timer[4], high port byte, padding[3]).
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

// Spanning-tree view of one bridge port.
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
		bp.role = bp.state == 0 ? 'disabled'
			: bridge.root_port == port_no ? 'root'
			: bp.state == 4 ? 'alternate'
			: bp.designated_bridge == bridge.bridge_id ? 'designated'
			: 'backup';
	}
	return bp;
}

function bridge_view(name, d, devices, conn) {
	let b = 'bridge/';
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

	let root_member = filter(members, (m) => m.brport?.port_no != null && m.brport.port_no == view.root_port)[0];
	view.root_port_name = view.stp && !view.is_root ? root_member?.name : null;
	view.macs = 0;
	for (let k, v in fdb)
		view.macs += v.macs;
	return view;
}
//#endregion

//#region Hardware and error diagnostics

const VENDORS = {
	mediatek: 'MediaTek', realtek: 'Realtek', qca: 'Qualcomm Atheros', qcom: 'Qualcomm', marvell: 'Marvell',
	brcm: 'Broadcom', broadcom: 'Broadcom', airoha: 'Airoha', microchip: 'Microchip', mscc: 'Microsemi',
	nxp: 'NXP', lantiq: 'Lantiq', intel: 'Intel', ralink: 'Ralink', ti: 'TI',
};

// Device-tree "compatible" strings are NUL-separated; "mediatek,mt7531" becomes "MediaTek MT7531".
function compat_label(text) {
	let first = filter(split(replace(text ?? '', /[^ -~]+/g, ' '), ' '), (s) => s != '')[0];
	let m = match(first ?? '', /^([^,]+),(.+)$/);
	if (!m)
		return null;
	return `${VENDORS[m[1]] ?? (uc(substr(m[1], 0, 1)) + substr(m[1], 1))} ${uc(replace(m[2], /-(eth|switch|mac)$/i, ''))}`;
}

function last_part(path) {
	let m = match(trim(path ?? ''), /([^\/]+)$/);
	return m ? m[1] : null;
}

// PHY chips on the MDIO buses with the netdev each one is attached to (static, so read once).
let mdio_cache = null;
function mdio_phys() {
	if (mdio_cache)
		return mdio_cache;
	let out = [];
	for (let bus in split(run('ls /sys/class/mdio_bus 2>/dev/null'), '\n')) {
		if (!safe_ifname(bus))
			continue;
		for (let ent in split(run(`ls /sys/class/mdio_bus/${bus} 2>/dev/null`), '\n')) {
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
// and the PHY. Cached per device.
let hardware_cache = {};
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

	let node = match(sys(name, 'uevent') ?? '', /OF_FULLNAME=([^\n]+)/);
	if (node) {
		let dt = (path) => compat_label(sysfs('/proc/device-tree' + path + '/compatible'));
		if (d.devtype == 'dsa')
			hw.switch = dt(replace(node[1], /\/ports\/[^\/]+$/, ''));
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

const NOISE = { rx_bytes: 1, tx_bytes: 1, rx_packets: 1, tx_packets: 1, multicast: 1, rx_compressed: 1, tx_compressed: 1 };

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
		let m = match(line, /^[[:space:]]+([][A-Za-z0-9_.-]+): ([0-9]+)$/);
		if (m && +m[2] > 0 && match(m[1], /err|drop|crc|fail|discard|collision|underrun|overrun|fifo|abort|miss|lost|timeout|invalid|bad/i))
			driver[m[1]] = +m[2];
	}

	let log = filter(split(run(`logread -e '${name}' 2>/dev/null`), '\n'), (l) => l != '');
	return { counters, driver, log: slice(log, -8) };
}
//#endregion

function collect() {
	let conn = connect();
	let devices = ubus_call(conn, 'network.device', 'status', {}) ?? {};

	let ports = [], bridges = [], vlans = [];
	let in_bridge = {};
	let conduits = {};

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

	return { generated: time(), ports, bridges, vlans };
}

return {
	'flab.network': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
};
