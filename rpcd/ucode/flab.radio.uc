#!/usr/bin/ucode
//
// rpcd ucode plugin reporting Wi-Fi radios, their configuration and their virtual interfaces as JSON:
//   ubus call flab.radio status
//
// Everything is discovered at run time: radios from UCI wireless, their phy from the kernel, interfaces
// from netifd, so a new radio, SSID or channel shows up on the next poll.
//
// Sources (no LuCI component is used):
//   - UCI wireless: configured radios and SSIDs. Only whitelisted options are copied; keys, passwords,
//     MAC lists and FT key material are never forwarded (only the number of MAC filter entries).
//   - netifd (network.wireless status): radio and interface state
//   - iw / iwinfo: channel, width, tx power, noise, channel survey, antennas, allowed channels, hardware
//   - hostapd (ubus): BSSID, BSS status (ENABLED, DFS, ...), connected client count
//   - sysfs: interface counters
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { connect } from 'ubus';
import { run, ubus_call, uci_all, sysfs, safe_ifname, num } from 'flab.util';

//#region Helpers

function opt(section, key) {
	let v = section[key];
	return type(v) == 'array' ? join(' ', v) : v;
}

function flag(section, key) {
	return opt(section, key) == '1';
}

function popcount(mask) {
	let n = 0;
	for (let v = mask ?? 0; v > 0; v >>= 1)
		n += v & 1;
	return n;
}

function security_label(enc) {
	enc ??= '';
	if (enc == '' || enc == 'none') return 'Open/None';
	if (match(enc, /owe/)) return 'OWE (Enhanced Open)';
	if (match(enc, /psk2\+psk3|sae-mixed/)) return 'WPA2/WPA3 Mixed';
	if (match(enc, /psk3|sae/)) return 'WPA3-Personal (SAE)';
	if (match(enc, /psk2/)) return 'WPA2-PSK';
	if (match(enc, /psk-mixed/)) return 'WPA/WPA2 Mixed';
	if (match(enc, /psk/)) return 'WPA-PSK';
	if (match(enc, /wpa3/)) return 'WPA3-Enterprise';
	if (match(enc, /wpa2/)) return 'WPA2-Enterprise';
	if (match(enc, /wpa/)) return 'WPA-Enterprise';
	if (match(enc, /wep/)) return 'WEP (Legacy)';
	return enc;
}

function sections_of(all, kind) {
	let list = [];
	for (let name in keys(all))
		if (all[name]['.type'] == kind)
			push(list, all[name]);
	return sort(list, (a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));
}
//#endregion

//#region Kernel and driver data

// Radios and the sysfs device path of each phy, e.g. phy1 -> "platform/soc/18000000.wifi".
function phy_paths() {
	let out = {};
	for (let phy in split(run('ls /sys/class/ieee80211 2>/dev/null'), '\n')) {
		if (!safe_ifname(phy))
			continue;
		let m = match(trim(run('readlink -f /sys/class/ieee80211/' + phy + '/device 2>/dev/null')), /\/sys\/devices\/(.*)$/);
		out[phy] = m ? m[1] : null;
	}
	return out;
}

// UCI "path" of a radio may carry a "+N" suffix when one device hosts several phys (N-th phy by name).
function phy_for_path(paths, path) {
	let m = match(path ?? '', /^(.*)\+([0-9]+)$/);
	let base = m ? m[1] : path, idx = m ? +m[2] : 0;
	let matching = filter(sort(keys(paths)), (phy) => paths[phy] == base || (paths[phy] != null && index(paths[phy], base + '/') == 0));
	return matching[idx];
}

// Capabilities, antennas and the channel list (with DFS and disabled flags) of a phy.
function phy_info(phy) {
	let out = { channels: [], standards: [] };
	let text = run('iw phy ' + phy + ' info 2>/dev/null');
	if (text == '')
		return out;

	let m = match(text, /Available Antennas: TX 0x([0-9a-f]+) RX 0x([0-9a-f]+)/);
	if (m)
		out.antennas = { tx: popcount(hex(m[1])), rx: popcount(hex(m[2])) };

	for (let line in split(text, '\n')) {
		let f = match(line, /\* ([0-9]+)(\.[0-9]+)? MHz \[([0-9]+)\] \((disabled|[0-9.]+ dBm)\)(.*)$/);
		if (!f)
			continue;
		let off = f[4] == 'disabled';
		push(out.channels, {
			channel: +f[3], freq: +f[1],
			max_power: off ? null : +replace(f[4], / dBm/, ''),
			disabled: off,
			dfs: index(f[5], 'radar') >= 0,
			no_ir: index(f[5], 'no IR') >= 0,
		});
	}

	if (match(text, /HT20\/HT40/)) push(out.standards, '802.11n');
	if (match(text, /VHT Capabilities/)) push(out.standards, '802.11ac');
	if (match(text, /HE Iftypes/)) push(out.standards, '802.11ax');
	if (match(text, /EHT Iftypes/)) push(out.standards, '802.11be');
	return out;
}

// Current channel, width, centre and tx power of an interface (iw dev <if> info).
function iface_info(ifname) {
	let out = {};
	for (let line in split(run('iw dev ' + ifname + ' info 2>/dev/null'), '\n')) {
		let m = match(line, /channel ([0-9]+) \(([0-9]+) MHz\), width: ([0-9]+) MHz(, center1: ([0-9]+) MHz)?/);
		if (m) {
			out.channel = +m[1];
			out.freq = +m[2];
			out.width = +m[3];
			out.center = num(m[5]);
		}
		if ((m = match(line, /txpower ([0-9.]+) dBm/)))
			out.txpower = +m[1];
	}
	return out;
}

// Cumulative airtime counters of the channel in use (milliseconds); the UI turns two samples into a
// utilisation percentage, so this stays a plain counter dump.
function survey(ifname) {
	let current = false, out = null;
	for (let line in split(run('iw dev ' + ifname + ' survey dump 2>/dev/null'), '\n')) {
		if (match(line, /^Survey data from/)) {
			current = false;
			continue;
		}
		let m = match(line, /frequency:[[:space:]]+([0-9]+) MHz( \[in use\])?/);
		if (m) {
			current = m[2] != null;
			if (current)
				out = { freq: +m[1] };
			continue;
		}
		if (!current)
			continue;
		if ((m = match(line, /noise:[[:space:]]+(-?[0-9]+) dBm/))) out.noise = +m[1];
		else if ((m = match(line, /channel active time:[[:space:]]+([0-9]+) ms/))) out.active = +m[1];
		else if ((m = match(line, /channel busy time:[[:space:]]+([0-9]+) ms/))) out.busy = +m[1];
		else if ((m = match(line, /channel receive time:[[:space:]]+([0-9]+) ms/))) out.rx = +m[1];
		else if ((m = match(line, /channel transmit time:[[:space:]]+([0-9]+) ms/))) out.tx = +m[1];
	}
	return out;
}

// Hardware name and supported modes from iwinfo's text output.
function hardware(ifname) {
	let out = {};
	for (let line in split(run('iwinfo ' + ifname + ' info 2>/dev/null'), '\n')) {
		let m = match(line, /Hardware: (.*[^ ])/);
		if (m && m[1] != 'unknown')
			out.hardware = m[1];
		if ((m = match(line, /HW Mode\(s\): ([^ ]+)/)))
			out.hwmodes = m[1];
	}
	return out;
}

function regdomain() {
	let m = match(run('iw reg get 2>/dev/null'), /country ([A-Z0-9]+): (DFS-[A-Z]+|[A-Za-z-]+)/);
	return m ? { country: m[1], dfs: m[2] } : null;
}
//#endregion

//#region Interfaces

function interface_view(conn, s, wl_iface) {
	let ifname = wl_iface?.ifname;
	let mode = s.mode ?? 'ap';
	let view = {
		section: s['.name'],
		ifname,
		mode,
		ssid: mode == 'mesh' ? s.mesh_id : s.ssid,
		networks: filter(split(opt(s, 'network') ?? '', /[[:space:]]+/), (n) => n != ''),
		encryption: s.encryption ?? 'none',
		security: security_label(s.encryption),
		enabled: !flag(s, 'disabled'),
		hidden: flag(s, 'hidden'),
		isolate: flag(s, 'isolate'),
		max_clients: num(s.maxassoc),
		macfilter: s.macfilter ? { policy: s.macfilter, entries: length(type(s.maclist) == 'array' ? s.maclist : (s.maclist ? [s.maclist] : [])) } : null,
		features: {
			roaming_11r: flag(s, 'ieee80211r'),
			neighbor_11k: flag(s, 'ieee80211k'),
			bss_transition_11v: flag(s, 'bss_transition'),
			wps: flag(s, 'wps_pushbutton'),
			ocv: flag(s, 'ocv'),
			proxy_arp: flag(s, 'proxy_arp'),
			wnm_sleep: flag(s, 'wnm_sleep_mode'),
		},
		// Whether netifd brought the interface up (an enabled interface without an ifname is not running).
		up: ifname != null,
	};

	if (ifname && safe_ifname(ifname)) {
		let hs = ubus_call(conn, 'hostapd.' + ifname, 'get_status');
		view.bssid = hs?.bssid ?? sysfs(`/sys/class/net/${ifname}/address`);
		view.bss_status = hs?.status;
		view.bss_color = hs?.bss_color;
		view.beacon_interval = hs?.beacon_interval;
		let clients = ubus_call(conn, 'hostapd.' + ifname, 'get_clients')?.clients;
		view.clients = clients != null ? length(keys(clients)) : null;
		view.rx_bytes = num(sysfs(`/sys/class/net/${ifname}/statistics/rx_bytes`));
		view.tx_bytes = num(sysfs(`/sys/class/net/${ifname}/statistics/tx_bytes`));
	}
	return view;
}
//#endregion

function collect() {
	let conn = connect();
	let all = uci_all('wireless');
	let wl = ubus_call(conn, 'network.wireless', 'status') ?? {};
	let paths = phy_paths();
	let ifaces = sections_of(all, 'wifi-iface');

	let radios = [];
	for (let r in sections_of(all, 'wifi-device')) {
		let name = r['.name'];
		let st = wl[name] ?? {};

		// Prefer the phy of a running interface; fall back to the device path for radios that are down.
		let phy = null;
		for (let i in st.interfaces ?? [])
			phy ??= i.ifname ? sysfs(`/sys/class/net/${i.ifname}/phy80211/name`) : null;
		phy ??= phy_for_path(paths, r.path);

		let views = [];
		for (let s in ifaces) {
			if (s.device != name)
				continue;
			let match_iface = filter(st.interfaces ?? [], (i) => i.section == s['.name'])[0];
			push(views, interface_view(conn, s, match_iface));
		}

		let radio = {
			name, phy,
			band: r.band,
			enabled: !flag(r, 'disabled'),
			up: st.up ?? false,
			pending: st.pending ?? false,
			retry_failed: st.retry_setup_failed ?? false,
			config: {
				channel: r.channel ?? 'auto', htmode: r.htmode, country: r.country, txpower: num(r.txpower),
				cell_density: num(r.cell_density), noscan: flag(r, 'noscan'), legacy_rates: flag(r, 'legacy_rates'),
				beacon_int: num(r.beacon_int), path: r.path,
			},
			interfaces: views,
		};

		if (phy && safe_ifname(phy)) {
			let info = phy_info(phy);
			radio.antennas = info.antennas;
			radio.standards = info.standards;
			radio.channels = info.channels;
		}

		// Live values come from the first interface that is actually up.
		let live_if = filter(views, (v) => v.ifname != null)[0]?.ifname;
		if (live_if && safe_ifname(live_if)) {
			radio.live = iface_info(live_if);
			radio.survey = survey(live_if);
			radio.hardware = hardware(live_if);
		}
		push(radios, radio);
	}

	return { generated: time(), regdomain: regdomain(), radios };
}

return {
	'flab.radio': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
};
