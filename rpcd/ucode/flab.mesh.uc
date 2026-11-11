#!/usr/bin/ucode
//
// rpcd ucode plugin reporting 802.11s mesh interfaces as JSON:
//   ubus call flab.mesh status
//
// Everything is discovered at run time: mesh interfaces from UCI wireless (mode "mesh") and netifd, their
// peers, paths and parameters from the kernel's mac80211, so a new mesh interface, peer or path shows up on
// the next poll.
//
// Sources (no LuCI component is used):
//   - UCI wireless: configured mesh interfaces (mesh id, encryption label, forwarding). The key is never
//     read into the output.
//   - netifd (network.wireless status): which interface name a mesh section has
//   - iw: channel and width (dev info), peers (station dump), paths (mpath dump), proxied destinations
//     (mpp dump) and mesh parameters (get mesh_param)
//   - sysfs: interface address and counters
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { connect } from 'ubus';
import { run, ubus_call, uci_all, sysfs, safe_ifname, num, security_label, iw_channel_info } from 'flab.util';

// Mesh parameters worth showing, read with `iw dev <if> get mesh_param <name>`.
const PARAMS = [
	'mesh_fwding', 'mesh_ttl', 'mesh_max_peer_links', 'mesh_auto_open_plinks', 'mesh_rssi_threshold',
	'mesh_hwmp_rootmode', 'mesh_hwmp_rann_interval', 'mesh_gate_announcements', 'mesh_nolearn',
	'mesh_plink_timeout', 'mesh_power_mode',
];

// Path flags of the kernel's mesh path table (MESH_PATH_*).
const PATH_FLAGS = [ [ 0x1, 'active' ], [ 0x2, 'resolving' ], [ 0x4, 'sn_valid' ], [ 0x8, 'fixed' ], [ 0x10, 'resolved' ] ];

//#region Peers

// True for the string "yes", which iw uses for booleans in station dumps.
const yes = (v) => v == 'yes';

// Parses an iw bitrate such as "130.0 MBit/s MCS 15 short GI" into { mbit, detail }; null when absent.
function bitrate(v) {
	let m = match(v ?? '', /^([0-9.]+) MBit\/s(.*)$/);
	return m ? { mbit: +m[1], detail: trim(m[2]) } : null;
}

// Parses one block of `iw dev <if> station dump` (the text after "Station ") into a peer object keyed by
// its MAC, or null when the block does not start with a MAC. Counters are numbers (null when unparsable),
// inactive_ms is milliseconds and connected_s seconds, signal values are dBm.
function parse_station(block) {
	let m = match(block, /^([0-9a-f:]{17})/i);
	if (!m)
		return null;
	let st = { mac: lc(m[1]) };
	for (let line in split(block, '\n')) {
		// Attribute lines are indented "key:   value"; n is the leading number of the value, if any.
		let kv = match(line, /^[[:space:]]+([^:]+):[[:space:]]*(.*)$/);
		if (!kv)
			continue;
		let k = trim(kv[1]), v = trim(kv[2]), n = match(v, /^(-?[0-9.]+)/);
		if (k == 'mesh plink') st.plink = v;
		else if (k == 'mesh airtime link metric') st.airtime_metric = n ? +n[1] : null;
		else if (k == 'mesh connected to gate') st.gate = yes(v);
		else if (k == 'mesh local PS mode') st.ps_mode = v;
		else if (k == 'authorized') st.authorized = yes(v);
		else if (k == 'authenticated') st.authenticated = yes(v);
		else if (k == 'MFP') st.mfp = yes(v);
		else if (k == 'inactive time') st.inactive_ms = n ? +n[1] : null;
		else if (k == 'connected time') st.connected_s = n ? +n[1] : null;
		else if (k == 'rx bytes') st.rx_bytes = n ? +n[1] : null;
		else if (k == 'tx bytes') st.tx_bytes = n ? +n[1] : null;
		else if (k == 'rx packets') st.rx_packets = n ? +n[1] : null;
		else if (k == 'tx packets') st.tx_packets = n ? +n[1] : null;
		else if (k == 'tx retries') st.tx_retries = n ? +n[1] : null;
		else if (k == 'tx failed') st.tx_failed = n ? +n[1] : null;
		else if (k == 'rx drop misc') st.rx_drop_misc = n ? +n[1] : null;
		else if (k == 'signal') st.signal = n ? +n[1] : null;
		else if (k == 'signal avg') st.signal_avg = n ? +n[1] : null;
		else if (k == 'expected throughput') st.expected_mbit = n ? +n[1] : null;
		else if (k == 'tx bitrate') st.tx_rate = bitrate(v);
		else if (k == 'rx bitrate') st.rx_rate = bitrate(v);
	}
	return st;
}

// Mesh peers of `ifname` from `iw dev <if> station dump`, sorted by MAC.
function peers(ifname) {
	let out = [];
	// The leading "\n" lets the first station match the "\nStation " separator too.
	for (let block in split('\n' + run(`iw dev ${ifname} station dump 2>/dev/null`), /\nStation /)) {
		let st = parse_station(block);
		if (st)
			push(out, st);
	}
	return sort(out, (a, b) => a.mac < b.mac ? -1 : a.mac > b.mac);
}
//#endregion

//#region Paths and parameters

// iw prints this all-zero address as the next hop of a path that has none yet.
const NO_HOP = '00:00:00:00:00:00';

// Mesh paths of `ifname` from `iw dev <if> mpath dump`, sorted by destination. Columns are:
// DEST ADDR  NEXT HOP  IFACE  SN  METRIC  QLEN  EXPTIME  DTIM  DRET  FLAGS  HOP_COUNT  PATH_CHANGE
// exptime_ms is milliseconds; flags is the list of PATH_FLAGS names set in the hex FLAGS column.
function paths(ifname) {
	let out = [];
	for (let line in split(run(`iw dev ${ifname} mpath dump 2>/dev/null`), '\n')) {
		let f = split(trim(line), /[[:space:]]+/);
		if (length(f) < 12 || !match(f[0], /^[0-9a-f:]{17}$/i))
			continue;
		let flags = hex(replace(f[9], /^0x/, ''));
		push(out, {
			dest: lc(f[0]), next_hop: f[1] == NO_HOP ? null : lc(f[1]),
			sn: +f[3], metric: +f[4], exptime_ms: +f[6], hop_count: +f[10], path_changes: +f[11],
			flags: map(filter(PATH_FLAGS, (p) => (flags & p[0]) != 0), (p) => p[1]),
		});
	}
	return sort(out, (a, b) => a.dest < b.dest ? -1 : a.dest > b.dest);
}

// Destinations reached through a mesh proxy gate (`iw dev <if> mpp dump`) as [{ dest, proxy }]; columns:
// DEST ADDR  PROXY NODE  IFACE
function proxied(ifname) {
	let out = [];
	for (let line in split(run(`iw dev ${ifname} mpp dump 2>/dev/null`), '\n')) {
		let f = split(trim(line), /[[:space:]]+/);
		if (length(f) >= 2 && match(f[0], /^[0-9a-f:]{17}$/i))
			push(out, { dest: lc(f[0]), proxy: lc(f[1]) });
	}
	return out;
}

// Mesh parameters change only when someone edits the configuration, so they are read at most once a minute.
// Per-interface cache of { at: epoch seconds, values }; it lives as long as rpcd keeps the plugin loaded.
let param_cache = {};

// Values of the PARAMS mesh parameters for `ifname` as { name: value string }; unreadable ones are left out.
function params(ifname) {
	let hit = param_cache[ifname];
	if (hit && time() - hit.at < 60)
		return hit.values;
	let values = {};
	for (let p in PARAMS) {
		let v = trim(run(`iw dev ${ifname} get mesh_param ${p} 2>/dev/null`));
		if (v != '')
			values[p] = v;
	}
	param_cache[ifname] = { at: time(), values };
	return values;
}
//#endregion

// Every mesh interface of the configuration, with live data for the ones that are running.
function collect() {
	let conn = connect();
	let all = uci_all('wireless');
	let wl = ubus_call(conn, 'network.wireless', 'status') ?? {};

	// Mesh sections in configuration order.
	let sections = [];
	for (let name in keys(all))
		if (all[name]['.type'] == 'wifi-iface' && all[name].mode == 'mesh')
			push(sections, all[name]);
	sections = sort(sections, (a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));

	let nodes = [];
	for (let s in sections) {
		// netifd knows the live interface name only for sections that are up; null means down.
		let radio = wl[s.device] ?? {};
		let ifname = filter(radio.interfaces ?? [], (i) => i.section == s['.name'])[0]?.ifname;
		let nets = type(s.network) == 'array' ? s.network : split(s.network ?? '', /[[:space:]]+/);

		let node = {
			section: s['.name'], radio: s.device, ifname,
			mesh_id: s.mesh_id,
			encryption: s.encryption ?? 'none', security: security_label(s.encryption),
			enabled: s.disabled != '1',
			up: ifname != null,
			networks: filter(nets, (n) => n != ''),
			config: { mesh_fwding: s.mesh_fwding, mesh_rssi_threshold: s.mesh_rssi_threshold },
		};

		if (ifname && safe_ifname(ifname)) {
			node.mac = sysfs(`/sys/class/net/${ifname}/address`);
			node.rx_bytes = num(sysfs(`/sys/class/net/${ifname}/statistics/rx_bytes`));
			node.tx_bytes = num(sysfs(`/sys/class/net/${ifname}/statistics/tx_bytes`));
			node.live = iw_channel_info(ifname);
			node.peers = peers(ifname);
			node.paths = paths(ifname);
			node.proxied = proxied(ifname);
			node.params = params(ifname);
		}
		push(nodes, node);
	}

	return { generated: time(), nodes };
}

// rpcd registration: ubus object flab.mesh with the single method `status` (no arguments).
return {
	'flab.mesh': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
};
