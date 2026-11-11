#!/usr/bin/ucode
//
// rpcd ucode plugin exposing the Wi-Fi client report of
// utilities/list_connected_devices.uc as JSON: ubus call flab.wifi clients
//
// Only sanitized client data is returned; Wi-Fi keys from `network.wireless status`
// are never copied into the result.
//
// Sources (no LuCI component is used): ubus (network.wireless status, hostapd.<if> get_clients, dhcp
// ipv4leases), `hostapd_cli all_sta`, `iw dev <if> station dump`, UCI wireless/network/dhcp, /proc/net/arp,
// `ip -6 neigh`, /etc/ethers and /tmp/hosts.
//
// rpcd runs plugins in-process, so this must not call ubus objects that rpcd itself
// serves (any rpcd plugin object): the call would block on rpcd's own event loop.

'use strict';

import { cursor } from 'uci';
import { connect } from 'ubus';
import { readfile } from 'fs';
import { run, safe_ifname, normalize_mac, security_label } from 'flab.util';

// IEEE 802.11 AKM suite selectors (OUI-type as hostapd prints them) -> short authentication names.
const AKM_NAMES = {
	'00-0f-ac-1': '802.1X', '00-0f-ac-2': 'PSK', '00-0f-ac-3': 'FT-802.1X',
	'00-0f-ac-4': 'FT-PSK', '00-0f-ac-5': 'WPA-SHA256', '00-0f-ac-6': 'PSK-SHA256',
	'00-0f-ac-8': 'SAE', '00-0f-ac-9': 'FT-SAE', '00-0f-ac-11': 'Suite-B',
	'00-0f-ac-12': 'Suite-B-192', '00-0f-ac-13': 'FT-802.1X-SHA384', '00-0f-ac-18': 'OWE',
};
// Pairwise cipher suite selectors -> short cipher names.
const CIPHER_NAMES = {
	'00-0f-ac-2': 'TKIP', '00-0f-ac-4': 'CCMP', '00-0f-ac-8': 'GCMP',
	'00-0f-ac-9': 'GCMP-256', '00-0f-ac-10': 'CCMP-256',
};
// Per-client label for mixed WPA2/WPA3 interfaces, keyed by AKM suite.
const AKM_SECURITY = {
	'00-0f-ac-8': 'WPA3 (SAE)', '00-0f-ac-9': 'WPA3 (FT-SAE)', '00-0f-ac-2': 'WPA2 (PSK)',
	'00-0f-ac-6': 'WPA2 (PSK-256)', '00-0f-ac-4': 'WPA2 (FT-PSK)', '00-0f-ac-18': 'OWE',
};
// Security score components (see security_score): points per AKM name, pairwise cipher and SAE group
// (IANA group number as a string). Higher is stronger; the weights match the CLI utility.
const AKM_SCORES = {
	'FT-SAE': 48, 'SAE': 48, 'Suite-B-192': 45, 'FT-802.1X-SHA384': 42, 'Suite-B': 40,
	'802.1X': 40, 'FT-802.1X': 38, 'OWE': 35, 'PSK-SHA256': 32, 'FT-PSK': 30,
	'WPA-SHA256': 28, 'PSK': 25,
};
const CIPHER_SCORES = { 'GCMP-256': 25, 'GCMP': 23, 'CCMP-256': 20, 'CCMP': 18, 'TKIP': 5 };
const SAE_GROUP_SCORES = { '21': 15, '20': 12, '19': 10 };

// Parse `hostapd_cli all_sta` into { mac: { key: value } }; the AKM, cipher, SAE group and
// PMF fields are not exposed by ubus get_clients.
function hostapd_all_sta(ifname) {
	let result = {};
	if (!safe_ifname(ifname))
		return result;

	let current = null;
	for (let line in split(run('hostapd_cli -i ' + ifname + ' all_sta 2>/dev/null'), '\n')) {
		let mac = match(line, /^([0-9a-fA-F:]{17})$/);
		if (mac) {
			current = {};
			result[lc(mac[1])] = current;
			continue;
		}
		let kv = current ? match(line, /^([^=]+)=(.*)$/) : null;
		if (kv)
			current[kv[1]] = kv[2];
	}
	return result;
}

// Parse `iw dev <if> station dump` into { mac: raw block }; the only source of channel width.
function iw_stations(ifname) {
	let result = {};
	if (!safe_ifname(ifname))
		return result;

	for (let block in split(run('iw dev ' + ifname + ' station dump 2>/dev/null'), /\nStation /)) {
		let m = match(block, /^(Station )?([0-9a-fA-F:]{17})/);
		if (m)
			result[lc(m[2])] = block;
	}
	return result;
}

// Normalises the various PMF (802.11w, protected management frames) indications to 1 (in use), 0 (not
// in use) or null (unknown). Precedence: the [MFP] station flag, then hostapd's explicit value, then
// inference from the AKM.
function normalize_pmf(akm_code, raw, flags) {
	if (flags && match(flags, /\[MFP\]/))
		return 1;
	if (raw === true || raw == 'true' || raw == '1')
		return 1;
	if (raw === false || raw == 'false')
		return 0;
	if (raw != null)
		return (+raw >= 1) ? 1 : 0;
	// SAE and OWE mandate PMF, so infer it when hostapd does not report it.
	if (akm_code && match(akm_code, /^00-0f-ac-(8|9|18)$/))
		return 1;
	return null;
}

// Raw security facts of one client: AKM and cipher selector codes, SAE group and PMF state. `hc` is the
// ubus get_clients entry and `hs` the `hostapd_cli all_sta` entry; either may be undefined, and hostapd_cli
// is preferred because get_clients does not carry these fields.
function security_fields(hc, hs) {
	let akm_code = hs?.AKMSuiteSelector ?? hc?.akm_suite_selector ?? hc?.AKMSuiteSelector;
	let cipher_code = hs?.dot11RSNAStatsSelectedPairwiseCipher ?? hc?.pairwise_cipher;
	let sae_group = hs?.sae_group ?? hc?.sae_group;
	let raw_pmf = hs?.hostapdMFPR ?? hs?.mfp ?? hc?.mfp;

	return {
		akm_code, cipher_code, sae_group,
		pmf: normalize_pmf(akm_code, raw_pmf, hs?.flags),
	};
}

// Same 0-100 scoring as the CLI utility; `partial` flags neutral defaults for missing fields.
// The grade thresholds are A+ >= 95, A >= 85, B >= 70, C >= 50, else D. PMF counts 10 when on, 2 when off.
function security_score(akm, cipher, sae_group, pmf) {
	let partial = false;
	let akm_score = AKM_SCORES[akm];
	if (akm_score == null) {
		akm_score = 20;
		partial = true;
	}
	let cipher_score = CIPHER_SCORES[cipher];
	if (cipher_score == null) {
		cipher_score = 15;
		partial = true;
	}

	let group_score = 8;
	// Only SAE has a Diffie-Hellman group to rate; other AKMs get a flat 8.
	if (match(akm, /SAE/)) {
		group_score = SAE_GROUP_SCORES['' + sae_group];
		if (group_score == null) {
			group_score = SAE_GROUP_SCORES['19'];
			partial = true;
		}
	}

	let pmf_score = 5;
	if (pmf != null)
		pmf_score = (+pmf >= 1) ? 10 : 2;
	else
		partial = true;

	let score = akm_score + cipher_score + group_score + pmf_score;
	let grade = score >= 95 ? 'A+' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
	return { score, grade, partial };
}

// Wi-Fi generation of a client: from hostapd's capability flags when present, else from the MCS wording
// of the iw bitrate lines. A plain legacy rate is reported as 802.11a/g.
function wifi_standard(hc, block) {
	if (hc?.eht) return '802.11be';
	if (hc?.he) return '802.11ax';
	if (hc?.vht) return '802.11ac';
	if (hc?.ht) return '802.11n';
	if (!block) return null;
	if (match(block, /[rt]x bitrate.*EHT-MCS/)) return '802.11be';
	if (match(block, /[rt]x bitrate.*HE-MCS/)) return '802.11ax';
	if (match(block, /[rt]x bitrate.*VHT-MCS/)) return '802.11ac';
	if (match(block, /[rt]x bitrate.*MCS/)) return '802.11n';
	if (match(block, /rx bitrate.*(54|48|36|24|18|12|9|6) MBit\/s/)) return '802.11a/g';
	return null;
}

// Bitrate in Mbit/s for `dir` ("tx" or "rx"): hostapd reports 10 bit/s units, iw reports Mbit/s text.
function bitrate(hc, block, dir) {
	let raw = hc?.rate?.[dir];
	if (raw != null && +raw > 0)
		return +raw / 100000.0;
	let m = block ? match(block, regexp(dir + ' bitrate:\\s+([0-9.]+)')) : null;
	return m ? +m[1] : null;
}

// Channel width in MHz of a station, from the "NNMHz" token in its iw bitrate lines; a bitrate line
// without one is a 20 MHz legacy rate. Null without iw data.
function channel_width(block) {
	if (!block)
		return null;
	let m = match(block, /([0-9]+)MHz/);
	if (m)
		return +m[1];
	return match(block, /bitrate/) ? 20 : null;
}

// Signal strength in dBm: hostapd's ubus value first, then all_sta, then iw's "signal:" line.
function signal_dbm(hc, hs, block) {
	if (hc?.signal != null) return +hc.signal;
	if (hs?.signal != null) return +hs.signal;
	let m = block ? match(block, /signal:\s+(-?[0-9]+)/) : null;
	return m ? +m[1] : null;
}

// Sort rank of an IPv6 address (higher sorts first via ipv6_by_mac): link-local 10, ULA (fc/fd) 20,
// anything else (global) 30.
function ipv6_rank(addr) {
	return match(addr, /^fe80:/i) ? 10 : match(addr, /^(fc|fd)/i) ? 20 : 30;
}

// Netdevs behind wireless networks ({ device: true }); ARP/neighbour rows on WAN, VPN or service links are ignored.
function wireless_devices(uci) {
	let devices = {};
	uci.foreach('wireless', 'wifi-iface', (s) => {
		let nets = type(s.network) == 'array' ? s.network : split(s.network ?? '', /\s+/);
		for (let net in nets) {
			let dev = net ? (uci.get('network', net, 'device') ?? uci.get('network', net, 'ifname')) : null;
			if (dev)
				devices[dev] = true;
		}
	});
	return devices;
}

// IPv4 address per MAC from /proc/net/arp (resolved entries only, flag 0x2 = ATF_COM, restricted to the
// wireless devices when known), overridden by the active DHCP lease.
function ipv4_by_mac(devices, leases) {
	let cache = {};
	let arp = split(readfile('/proc/net/arp') ?? '', '\n');
	// Row 0 is the column header; columns: IP, HW type, flags, MAC, mask, device.
	for (let i = 1; i < length(arp); i++) {
		let p = split(arp[i], /\s+/);
		if (length(p) >= 6 && (+p[2] & 0x2) && p[3] != '00:00:00:00:00:00' &&
		    (!length(keys(devices)) || devices[p[5]]))
			cache[lc(p[3])] = p[0];
	}
	// An active DHCP lease is the most authoritative address.
	for (let mac, l in leases)
		if (l.address)
			cache[mac] = l.address;
	return cache;
}

// IPv6 addresses per MAC from `ip -6 neigh show` as { mac: [address, ...] }, skipping failed/incomplete
// entries and non-wireless devices, with global addresses ordered before ULA and link-local ones.
function ipv6_by_mac(devices) {
	let cache = {};
	for (let line in split(run('ip -6 neigh show 2>/dev/null'), '\n')) {
		let p = split(line, /\s+/);
		// Lines look like "<addr> dev <if> lladdr <mac> <STATE>"; locate the keyword positions.
		let dev = index(p, 'dev'), ll = index(p, 'lladdr');
		if (dev < 0 || ll < 0 || ll + 1 >= length(p) || dev + 1 >= length(p))
			continue;
		let state = p[length(p) - 1];
		if (state == 'FAILED' || state == 'INCOMPLETE' ||
		    (length(keys(devices)) && !devices[p[dev + 1]]))
			continue;
		let mac = lc(p[ll + 1]);
		cache[mac] ??= [];
		if (index(cache[mac], p[0]) < 0)
			push(cache[mac], p[0]);
	}
	// Rank globally routable addresses first; ties keep neighbour-table order like the CLI utility.
	for (let mac, list in cache) {
		let seen = slice(list);
		cache[mac] = sort(list, (a, b) => (ipv6_rank(b) - ipv6_rank(a)) || (index(seen, a) - index(seen, b)));
	}
	return cache;
}

// Active DHCPv4 leases as { normalized mac: lease }, from the dhcp ubus object (served by odhcpd, not rpcd).
function lease_map(ubus) {
	let map = {};
	let res = ubus.call('dhcp', 'ipv4leases') ?? {};
	for (let dev, d in res.device ?? {}) {
		for (let l in d.leases ?? []) {
			let mac = normalize_mac(l.mac ?? '');
			if (mac)
				map[mac] = l;
		}
	}
	return map;
}

// Display name per MAC, in order of precedence: static dhcp host entries, DHCP lease hostnames, then
// /etc/ethers ("<mac> <name>" lines).
function name_by_mac(uci, leases) {
	let names = {};
	uci.load('dhcp');
	uci.foreach('dhcp', 'host', (s) => {
		let mac = s.mac ? normalize_mac(s.mac) : null;
		if (mac && s.name)
			names[mac] = s.name;
	});
	for (let mac, l in leases)
		if (!names[mac] && l.hostname && l.hostname != '*')
			names[mac] = l.hostname;
	for (let line in split(readfile('/etc/ethers') ?? '', '\n')) {
		let p = split(line, /\s+/);
		let mac = length(p) >= 2 ? normalize_mac(p[0]) : null;
		if (mac && !names[mac])
			names[mac] = p[1];
	}
	return names;
}

// Assembles the JSON object of one client from the three data sources (`hc` ubus get_clients entry, `hs`
// hostapd_cli all_sta entry, `block` iw station text; any may be undefined) and the address/name maps
// in `net`. On a mixed WPA2/WPA3 interface the client's own AKM decides the security label. The rating is
// only computed when both AKM and cipher are known; hostname has any domain suffix stripped.
function build_client(mac, base_security, hc, hs, block, net) {
	let sec = security_fields(hc, hs);
	let akm = sec.akm_code ? (AKM_NAMES[sec.akm_code] ?? sec.akm_code) : null;
	let cipher = sec.cipher_code ? (CIPHER_NAMES[sec.cipher_code] ?? sec.cipher_code) : null;

	let security = base_security;
	if (match(base_security, /Mixed/)) {
		if (sec.akm_code && AKM_SECURITY[sec.akm_code])
			security = AKM_SECURITY[sec.akm_code];
		else if (sec.sae_group != null)
			security = 'WPA3 (SAE)';
	}

	let client = {
		mac,
		ipv4: net.ipv4[mac],
		ipv6: net.ipv6[mac] ?? [],
		hostname: net.names[mac] ?? (net.ipv4[mac] ? net.hosts[net.ipv4[mac]] : null),
		signal: signal_dbm(hc, hs, block),
		standard: wifi_standard(hc, block),
		width: channel_width(block),
		tx: bitrate(hc, block, 'tx'),
		rx: bitrate(hc, block, 'rx'),
		security,
		akm, cipher,
		sae_group: sec.sae_group != null ? +sec.sae_group : null,
		pmf: sec.pmf,
		connected: hs?.connected_time != null ? +hs.connected_time : null,
		rx_bytes: hc?.bytes?.rx,
		tx_bytes: hc?.bytes?.tx,
	};

	if (client.hostname) {
		let dot = index(client.hostname, '.');
		if (dot > 0)
			client.hostname = substr(client.hostname, 0, dot);
	}
	if (akm && cipher)
		client.rating = security_score(akm, cipher, sec.sae_group, sec.pmf);
	return client;
}

// Hostname per IP address from the dnsmasq/odhcpd hosts files in /tmp/hosts (first entry wins).
function ip_hosts() {
	let map = {};
	for (let f in split(run('ls /tmp/hosts 2>/dev/null'), '\n')) {
		if (!match(f, /^[A-Za-z0-9._-]+$/))
			continue;
		for (let line in split(readfile('/tmp/hosts/' + f) ?? '', '\n')) {
			let p = split(line, /\s+/);
			if (length(p) >= 2 && p[1] != '' && !map[p[0]])
				map[p[0]] = p[1];
		}
	}
	return map;
}

// Builds the flab.wifi clients reply: for every enabled radio and interface, the union of the clients seen
// by hostapd (ubus and all_sta) and iw, keyed by MAC.
function collect() {
	let uci = cursor();
	let ubus = connect();
	uci.load('wireless');
	uci.load('network');

	let wl = ubus.call('network.wireless', 'status') ?? {};
	let devices = wireless_devices(uci);
	let leases = lease_map(ubus);
	let net = {
		ipv4: ipv4_by_mac(devices, leases),
		ipv6: ipv6_by_mac(devices),
		names: name_by_mac(uci, leases),
		hosts: ip_hosts(),
	};

	let radios = [];
	let total = 0;

	uci.foreach('wireless', 'wifi-device', (r) => {
		if (r.disabled == '1')
			return;
		let name = r['.name'];
		let cfg = wl[name]?.config ?? {};
		let radio = {
			name,
			band: r.band ?? cfg.band,
			channel: cfg.channel ?? r.channel ?? 'auto',
			htmode: cfg.htmode ?? r.htmode,
			interfaces: [],
		};

		uci.foreach('wireless', 'wifi-iface', (s) => {
			if (s.device != name || s.disabled == '1')
				return;

			// Match the netifd interface by section, or by SSID as a fallback; the UCI ifname is the last resort.
			let ifname = null;
			for (let i in wl[name]?.interfaces ?? []) {
				if (i.section == s['.name'] || (i.config?.ssid == s.ssid && i.ifname)) {
					ifname = i.ifname ?? i.config?.ifname;
					break;
				}
			}
			ifname ??= s.ifname;

			let iface = {
				section: s['.name'],
				ssid: s.ssid,
				mode: s.mode ?? 'ap',
				security: security_label(s.encryption),
				ifname,
				clients: [],
			};

			if (ifname && safe_ifname(ifname)) {
				let hc_all = ubus.call('hostapd.' + ifname, 'get_clients')?.clients ?? {};
				let hs_all = hostapd_all_sta(ifname);
				let iw_all = iw_stations(ifname);

				// Union of the MACs known to any of the three sources.
				let macs = {};
				for (let m in hc_all) macs[lc(m)] = true;
				for (let m in hs_all) macs[m] = true;
				for (let m in iw_all) macs[m] = true;

				for (let mac in sort(keys(macs)))
					push(iface.clients, build_client(mac, iface.security, hc_all[mac], hs_all[mac], iw_all[mac], net));
				total += length(iface.clients);
			}
			push(radio.interfaces, iface);
		});

		push(radios, radio);
	});

	return { total, radios };
}

// rpcd registration: ubus object flab.wifi with the single method `clients` (no arguments).
return {
	'flab.wifi': {
		clients: {
			call: function(request) {
				return collect();
			},
		},
	},
};
