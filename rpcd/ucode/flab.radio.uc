#!/usr/bin/ucode
//
// rpcd ucode plugin reporting Wi-Fi radios, their configuration and their virtual interfaces as JSON:
//   ubus call flab.radio status    live state of every radio and SSID
//   ubus call flab.radio config    the wireless configuration without secrets, for editing it
//   ubus call flab.radio wps '{"ifname":"phy0-ap0","action":"start"}'   open (or "cancel") the WPS push button of an access point (on request only)
//
// Everything is discovered at run time: radios from UCI wireless, their phy from the kernel, interfaces
// from netifd, so a new radio, SSID or channel shows up on the next poll.
//
// Sources:
//   - UCI wireless: configured radios and SSIDs. Only whitelisted options are copied; keys, passwords,
//     MAC lists and FT key material are never forwarded (only the number of MAC filter entries).
//   - netifd (network.wireless status): radio and interface state
//   - iw / iwinfo: channel, width, tx power, noise, channel survey, antennas, allowed channels, hardware
//   - hostapd (ubus): BSSID, BSS status (ENABLED, DFS, ...), connected client count
//   - sysfs: interface counters
//
// `config` returns the whole wireless configuration (every wifi-device and wifi-iface option) for the page that edits it,
// WITHOUT its secrets: an option that holds a key, password, identity or key-holder list is never returned, only whether
// it is set (`secrets`). Next to it come what the page needs to validate an edit against this hardware: the modes each
// radio supports, the country list, the networks and the encryption features of the installed hostapd.
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself (this includes `iwinfo`, which
// is why the iwinfo command is used).

'use strict';
import { deferred } from 'flab.worker';

import { connect } from 'ubus';
import { run, ubus_call, uci_all, sysfs, safe_ifname as lib_safe_ifname, num, security_label, iw_channel_info } from 'flab.util';

// A name that reaches a command line or a path: an interface or phy name. The library check is anchored with ^...$, which ucode matches against
// the first line of a string, so "wlan0\nid" would pass it; a name with a line break is refused first.
function safe_ifname(name) {
	return type(name) == 'string' && index(name, '\n') < 0 && index(name, '\r') < 0 && lib_safe_ifname(name);
}

// Options of a wireless section that hold a secret: never returned. The WPA passphrase and WEP keys, the SAE password,
// the RADIUS, accounting and DAE secrets, EAP identity and passwords, the WPS PIN and the 802.11r key-holder lists.
const SECRET_OPTION = /^(key[1-4]?|identity|r0kh|r1kh|wps_pin|[a-z0-9_]*(passw|pwd|passphrase|secret|token)[a-z0-9_]*)$/i;

//#region Helpers

// UCI option as a string; list options are joined with spaces.
function opt(section, key) {
	let v = section[key];
	return type(v) == 'array' ? join(' ', v) : v;
}

// True when the UCI option is exactly "1".
function flag(section, key) {
	return opt(section, key) == '1';
}

// Number of set bits in `mask` (used to count the antennas in an iw antenna bitmask).
function popcount(mask) {
	let n = 0;
	for (let v = mask ?? 0; v > 0; v >>= 1)
		n += v & 1;
	return n;
}

// UCI sections of type `kind` in configuration order.
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

// UCI "path" of a radio may carry a "+N" suffix when one device hosts several phys (N-th phy by name). It is
// the sysfs device path relative to /sys/devices/platform for a platform device ("soc/18000000.wifi", though
// OpenWrt also writes "platform/soc/18000000.wifi") and relative to /sys/devices for others ("pci0000:00/..."), while
// phy_paths() keeps the path relative to /sys/devices: so the "platform/" prefix is ignored on both sides. A PCIe
// radio behind a platform controller is "soc/40000000.pcie/pci0000:00/..." in UCI.
function phy_for_path(paths, path) {
	let m = match(path ?? '', /^(.*)\+([0-9]+)$/);
	let base = replace(m ? m[1] : path ?? '', /^platform\//, ''), idx = m ? +m[2] : 0;
	let bare = (p) => replace(p ?? '', /^platform\//, '');
	let matching = filter(sort(keys(paths)), (phy) => paths[phy] != null && (bare(paths[phy]) == base || index(bare(paths[phy]), base + '/') == 0));
	return matching[idx];
}

// The htmodes a band of a phy supports, from the markers in its "Band N:" block of `iw phy info`: HT20/HT40 from the HT
// capabilities, VHT from the VHT capabilities (80 MHz off 2.4 GHz, 160 MHz when the width field says so), HE from the
// HE PHY capability strings ("HE40/", "HE80/", "HE160/") and EHT likewise (320 MHz when it is named).
function band_htmodes(block, band) {
	let has = (re) => match(block, re) != null;
	let modes = [];
	if (has(/\n\t\tCapabilities: 0x/)) {
		push(modes, 'HT20');
		if (has(/HT20\/HT40/))
			push(modes, 'HT40');
	}
	if (has(/VHT Capabilities/)) {
		push(modes, 'VHT20', 'VHT40');
		if (band != '2g')
			push(modes, 'VHT80');
		if (has(/Supported Channel Width: (160|80\+80)/))
			push(modes, 'VHT160');
	}
	// The width flags of the HE (and EHT) capabilities that gate each mode.
	let widths = [['20', true], ['40', has(/HE40\//)], ['80', has(/HE80\//)], ['160', has(/HE160\//)]];
	if (has(/HE Iftypes/))
		for (let w in widths)
			if (w[1])
				push(modes, 'HE' + w[0]);
	if (has(/EHT Iftypes/)) {
		for (let w in widths)
			if (w[1])
				push(modes, 'EHT' + w[0]);
		if (has(/320 ?MHz/i))
			push(modes, 'EHT320');
	}
	return modes;
}

// Sort rank of an htmode: the generation (HT, VHT, HE, EHT) first, then the width.
function htmode_rank(mode) {
	let m = match(mode, /^([A-Z]+)([0-9]+)$/);
	return m ? (index(['HT', 'VHT', 'HE', 'EHT'], m[1]) + 1) * 1000 + +m[2] : 9000;
}

// Capabilities, antennas and the channel list (with DFS and disabled flags) of a phy, parsed from
// `iw phy <phy> info`. Antenna counts come from the "Available Antennas" bitmasks. `standards` lists
// the 802.11 generations the phy advertises and `bands` the channel widths each band supports, as the
// `htmodes` a radio on that band may be configured with.
function phy_info(phy) {
	let out = { channels: [], standards: [], bands: [] };
	let text = run('iw phy ' + phy + ' info 2>/dev/null');
	if (text == '')
		return out;

	// Each "Band N:" block of the dump describes one band; the text before the first one is the phy header.
	let blocks = split(text, /\n\tBand [0-9]+:/);
	for (let i = 1; i < length(blocks); i++) {
		let f = match(blocks[i], /\* ([0-9]+)(\.[0-9]+)? MHz/);
		if (!f)
			continue;
		let mhz = +f[1];
		let band = mhz < 2500 ? '2g' : mhz < 5925 ? '5g' : mhz <= 7125 ? '6g' : '60g';
		push(out.bands, { band, htmodes: band_htmodes(blocks[i], band) });
	}

	let m = match(text, /Available Antennas: TX 0x([0-9a-f]+) RX 0x([0-9a-f]+)/);
	if (m)
		out.antennas = { tx: popcount(hex(m[1])), rx: popcount(hex(m[2])) };

	for (let line in split(text, '\n')) {
		// e.g. "* 5180 MHz [36] (23.0 dBm) (no IR)": f[1] MHz, f[3] channel, f[4] max power or
		// "disabled", f[5] trailing flags (radar detection = DFS).
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

	// Capability markers in the phy dump; each is only present when the phy supports that generation.
	if (match(text, /HT20\/HT40/)) push(out.standards, '802.11n');
	if (match(text, /VHT Capabilities/)) push(out.standards, '802.11ac');
	if (match(text, /HE Iftypes/)) push(out.standards, '802.11ax');
	if (match(text, /EHT Iftypes/)) push(out.standards, '802.11be');
	return out;
}

// Cumulative airtime counters of the channel in use (milliseconds) from `iw dev <if> survey dump`, or
// null when no channel is marked "[in use]". The UI turns two samples into a utilization percentage,
// so this stays a plain counter dump.
function survey(ifname) {
	// `current` is true while inside the survey block of the channel in use.
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

// Hardware name and supported modes ("hwmodes", e.g. "ac/n") from `iwinfo <if> info`; keys are only set
// when iwinfo reports them (an "unknown" hardware name is skipped).
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

// Where a phy sits and which driver runs it, from sysfs: the kernel driver and the bus (platform, pci, usb), the device-tree compatible string of a SoC radio,
// the PCI id (vendor:device) of a card and the USB id of a stick. Keys are only set when the device reports them. This works for a radio that is down too.
function phy_device(phy) {
	let out = {};
	let base = `/sys/class/ieee80211/${phy}/device`;
	for (let line in split(sysfs(base + '/uevent') ?? '', '\n')) {
		let m = match(line, /^([A-Z0-9_]+)=(.*)$/);
		if (!m)
			continue;
		if (m[1] == 'DRIVER') out.driver = m[2];
		else if (m[1] == 'PCI_ID') out.pci_id = lc(m[2]);
		else if (m[1] == 'PRODUCT') out.usb_id = m[2];
		else if (m[1] == 'OF_COMPATIBLE_0') out.compatible = m[2];
	}
	let bus = match(trim(run(`readlink ${base}/subsystem 2>/dev/null`) ?? ''), /\/([a-z0-9_-]+)$/);
	if (bus)
		out.bus = bus[1];
	return out;
}

// Regulatory domain from `iw reg get`: { country, dfs } (dfs is the DFS region such as "DFS-ETSI"), or null.
function regdomain() {
	let m = match(run('iw reg get 2>/dev/null'), /country ([A-Z0-9]+): (DFS-[A-Z]+|[A-Za-z-]+)/);
	return m ? { country: m[1], dfs: m[2] } : null;
}
//#endregion

//#region Interfaces

// JSON view of one wifi-iface section `s`, joined with netifd's entry `wl_iface` (null when the interface
// is not up) and hostapd's live status. Only whitelisted options are copied; the MAC filter list is reduced
// to its entry count and no keys are included.
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

// The phy of radio `r` (a wifi-device section) with netifd's state `st`: the phy of a running interface, else the one the
// device path names (a radio that is down).
function radio_phy(r, st, paths) {
	let phy = null;
	for (let i in st.interfaces ?? [])
		phy ??= i.ifname ? sysfs(`/sys/class/net/${i.ifname}/phy80211/name`) : null;
	return phy ?? phy_for_path(paths, r.path);
}

// Builds the flab.radio status reply: every wifi-device with its configuration, interfaces and, for radios
// that are up, live channel, survey and hardware data.
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
		let phy = radio_phy(r, st, paths);

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
			radio.live = iw_channel_info(live_if);
			radio.survey = survey(live_if);
			radio.hardware = hardware(live_if);
		}
		// The device the phy sits on (driver, bus, ids) is known whether the radio is up or not.
		let hw = radio.hardware ?? {};
		if (phy && safe_ifname(phy))
			for (let k, v in phy_device(phy))
				hw[k] = v;
		radio.hardware = hw;
		push(radios, radio);
	}

	return { generated: time(), regdomain: regdomain(), radios };
}

//#region Configuration

// Whether a UCI value is set: an empty string and an empty list are not.
function is_set(v) {
	return type(v) == 'array' ? length(v) > 0 : (v != null && '' + v != '');
}

// A UCI section for the `config` reply: its name, type and position, the options that may be shown (every one but the
// secrets) and which secrets are set: { values, secrets: { option: true } }. A secret's value is never copied.
function section_view(s) {
	let values = {}, secrets = {};
	for (let k, v in s) {
		if (index(k, '.') == 0)
			continue;
		if (match(k, SECRET_OPTION)) {
			if (is_set(v))
				secrets[k] = true;
			continue;
		}
		values[k] = v;
	}
	return { section: s['.name'], anonymous: s['.anonymous'] == true, index: s['.index'] ?? 0, type: s['.type'], values, secrets };
}

// The htmodes radio `r` may be set to: what iwinfo lists for one of its running interfaces (the list netifd and hostapd
// work from), else what the phy's capabilities for the radio's band allow. { source, modes }; the list is empty when the
// hardware could not be asked (a radio that is down and whose phy is unknown).
function radio_htmodes(r, phy, live_if) {
	let listed = [];
	if (live_if && safe_ifname(live_if))
		listed = filter(split(trim(run('iwinfo ' + live_if + ' htmodelist 2>/dev/null')), /[[:space:]]+/), (m) => m != '');
	if (length(listed))
		return { source: 'iwinfo', modes: sort(listed, (a, b) => htmode_rank(a) - htmode_rank(b)) };

	let bands = phy && safe_ifname(phy) ? phy_info(phy).bands : [];
	let band = filter(bands, (b) => b.band == r.band)[0] ?? (r.band == null && length(bands) == 1 ? bands[0] : null);
	return { source: band ? 'phy' : null, modes: band ? band.htmodes : [] };
}

// The countries the driver knows, as [{ code, name }], from `iwinfo <ifname> countrylist` (it needs a running interface).
function country_list(ifname) {
	let out = [];
	if (!ifname || !safe_ifname(ifname))
		return out;
	for (let line in split(run('iwinfo ' + ifname + ' countrylist 2>/dev/null'), '\n')) {
		let m = match(line, /^[[:space:]]*([A-Z0-9]{2}) "(.*)"$/);
		if (m)
			push(out, { code: m[1], name: m[2] });
	}
	return out;
}

// What the installed hostapd was built with, as { eap, sae, owe, ft, wps } booleans, from `hostapd -v<feature>` (exit status 0
// when supported); every value is null when hostapd is not installed, so the page does not restrict anything it cannot know.
function hostapd_features() {
	let known = match(run('hostapd -v 2>&1'), /hostapd v/) != null;
	let out = {};
	for (let f in [['eap', 'eap'], ['sae', 'sae'], ['owe', 'owe'], ['ft', '11r'], ['wps', 'wps']])
		out[f[0]] = known ? run('hostapd -v' + f[1] + ' >/dev/null 2>&1 && echo yes') != '' : null;
	return out;
}

// The logical interfaces of /etc/config/network that a wireless network can be attached to (loopback left out).
function network_list() {
	let out = [];
	for (let s in sections_of(uci_all('network'), 'interface'))
		if (s['.name'] != 'loopback')
			push(out, { name: s['.name'], proto: s.proto });
	return out;
}

// Builds the flab.radio config reply: every wifi-device and wifi-iface of /etc/config/wireless without secrets, what each
// radio supports, and the lists the page offers in its drop-downs. Sections of other types (wifi-vlan, wifi-station) are
// only listed by name: they hold keys and the page does not edit them.
function config() {
	let conn = connect();
	let all = uci_all('wireless');
	let wl = ubus_call(conn, 'network.wireless', 'status') ?? {};
	let paths = phy_paths();

	let radios = [], country_if = null;
	for (let r in sections_of(all, 'wifi-device')) {
		let st = wl[r['.name']] ?? {};
		let live_if = filter(map(st.interfaces ?? [], (i) => i.ifname), (n) => n != null)[0];
		country_if ??= live_if;
		let view = section_view(r);
		view.phy = radio_phy(r, st, paths);
		view.htmodes = radio_htmodes(r, view.phy, live_if);
		push(radios, view);
	}

	let others = [];
	for (let name, s in all)
		if (s['.type'] != 'wifi-device' && s['.type'] != 'wifi-iface')
			push(others, { section: s['.name'] ?? name, type: s['.type'] });

	return {
		generated: time(),
		radios,
		interfaces: map(sections_of(all, 'wifi-iface'), section_view),
		others,
		networks: network_list(),
		countries: country_list(country_if),
		features: hostapd_features(),
	};
}
//#endregion

//#region WPS push button

// The reply of `wps`: starts or cancels the WPS push button of the access point on `ifname` through hostapd's ubus object
// (`wps_start`, `wps_cancel`). While it is on (hostapd keeps it for two minutes) a device in range whose WPS button is pressed joins the
// network without the password, so it is only called on request. The interface must be an access point of the wireless config that
// has `wps_pushbutton` set; anything else is refused before hostapd is asked.
//   { ok, ifname, action } or { ok: false, ifname, action, error }
function wps(request) {
	let ifname = request?.args?.ifname;
	let action = request?.args?.action ?? 'start';
	let name = type(ifname) == 'string' && safe_ifname(ifname) ? ifname : null;
	let fail = (error) => ({ ok: false, ifname: name, action, error });
	if (name == null)
		return fail('The interface name is not valid.');
	if (action != 'start' && action != 'cancel')
		return fail('The action must be start or cancel.');
	let conn = connect();
	let all = uci_all('wireless');
	let wl = ubus_call(conn, 'network.wireless', 'status') ?? {};
	let section = null;
	for (let radio, st in wl)
		for (let i in st.interfaces ?? [])
			if (i.ifname == name)
				section = all[i.section];
	if (!section)
		return fail('That is not a running wireless interface.');
	if ((section.mode ?? 'ap') != 'ap' || !flag(section, 'wps_pushbutton'))
		return fail('The WPS push button is not enabled on that access point.');
	ubus_call(conn, 'hostapd.' + name, action == 'start' ? 'wps_start' : 'wps_cancel');
	let error = conn.error();
	if (error != null)
		return fail(`hostapd refused: ${error}. The WPS push button needs the full wpad and a WPA2-Personal network.`);
	return { ok: true, ifname: name, action };
}
//#endregion

// rpcd registration: ubus object flab.radio with the methods `status` and `config` (no arguments) and `wps` (ifname, action), which only runs on request.
return deferred({
	'flab.radio': {
		status: {
			call: function(request) {
				return collect();
			},
		},
		config: {
			call: function(request) {
				return config();
			},
		},
		wps: {
			args: { ifname: '', action: '' },
			call: function(request) {
				return wps(request);
			},
		},
	},
});
