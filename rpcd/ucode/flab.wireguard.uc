#!/usr/bin/ucode
//
// rpcd ucode plugin reporting WireGuard interfaces and their peers as JSON:
//   ubus call flab.wireguard status
//
// Everything is discovered at run time: interfaces from UCI network (proto "wireguard") plus whatever the
// kernel reports, peers from the `wireguard_<interface>` sections plus whatever the kernel knows, so a new
// interface or peer shows up on the next poll.
//
// Sources (no LuCI component is used):
//   - UCI network: interface settings (addresses, listen port, MTU) and the configured peers (name,
//     allowed IPs, endpoint, keepalive)
//   - `wg show <if> <field>`: live state. Only the single-field forms are used (public-key, listen-port,
//     fwmark, peers, endpoints, allowed-ips, latest-handshakes, transfer, persistent-keepalive), which
//     never print the private or pre-shared key
//   - UCI firewall: the zone an interface belongs to
//   - sysfs: interface MTU and counters
//
// Private and pre-shared keys are never read into the output. Public keys are not secret and identify peers.
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { run, uci_all, sysfs, safe_ifname, num } from 'flab.util';

// A WireGuard session is rekeyed every 120 s while traffic flows and is rejected after 180 s without a
// handshake, so a peer whose last handshake is older than this is not currently connected.
const SESSION_S = 180;

const as_list = (v) => v == null ? [] : (type(v) == 'array' ? v : split(trim(v), /[[:space:]]+/));
const is_key = (k) => match(k ?? '', /^[A-Za-z0-9+\/]{43}=$/) != null;

// `wg show <if> <field>` lines as { public key: [ remaining tab-separated columns ] }.
function table(ifname, field) {
	let out = {};
	for (let line in split(run(`wg show ${ifname} ${field} 2>/dev/null`), '\n')) {
		let cols = split(line, '\t');
		if (is_key(cols[0]))
			out[cols[0]] = slice(cols, 1);
	}
	return out;
}

function firewall_zone(ifname) {
	for (let n, s in uci_all('firewall'))
		if (s['.type'] == 'zone' && index(as_list(s.network), ifname) >= 0)
			return s.name;
	return null;
}

// Configured peers of one interface, by public key.
function configured_peers(all, ifname) {
	let out = {};
	for (let n, s in all)
		if (s['.type'] == `wireguard_${ifname}` && is_key(trim(s.public_key ?? '')))
			out[trim(s.public_key)] = s;
	return out;
}

function peer_view(key, conf, live, now) {
	let hs = num(live.handshakes[key]?.[0]);
	let age = hs ? (now > hs ? now - hs : 0) : null;
	let endpoint = live.endpoints[key]?.[0];
	if (endpoint == '(none)')
		endpoint = null;
	endpoint ??= conf?.endpoint_host ? `${conf.endpoint_host}${conf.endpoint_port ? ':' + conf.endpoint_port : ''}` : null;
	let allowed = live.allowed[key] ? as_list(live.allowed[key][0]) : as_list(conf?.allowed_ips);
	if (length(allowed) == 1 && allowed[0] == '(none)')
		allowed = [];
	// The kernel says "off" when no keepalive is set; the configuration only counts for peers it has not loaded.
	let ka = live.keepalive[key]?.[0];
	let keepalive = live.known[key] ? (ka == null || ka == 'off' ? null : num(ka)) : num(conf?.persistent_keepalive);
	return {
		name: conf?.description,
		public_key: key,
		endpoint,
		allowed_ips: allowed,
		route_allowed_ips: conf?.route_allowed_ips == '1',
		keepalive,
		handshake_age: age,
		state: !live.known[key] ? 'down' : age == null ? 'never' : age < SESSION_S ? 'connected' : 'stale',
		rx_bytes: num(live.transfer[key]?.[0]),
		tx_bytes: num(live.transfer[key]?.[1]),
		configured: conf != null,
		enabled: conf == null || conf.disabled != '1',
	};
}

function interface_view(all, ifname, running, now) {
	let conf = all[ifname];
	let view = {
		name: ifname,
		configured: conf != null,
		enabled: conf == null || conf.disabled != '1',
		up: running,
		zone: firewall_zone(ifname),
		listen_port: num(conf?.listen_port),
		mtu: num(conf?.mtu),
		fwmark: conf?.fwmark,
		addresses: as_list(conf?.addresses),
	};

	let live = { known: {}, endpoints: {}, allowed: {}, handshakes: {}, transfer: {}, keepalive: {} };
	if (running && safe_ifname(ifname)) {
		view.public_key = trim(run(`wg show ${ifname} public-key 2>/dev/null`)) || null;
		view.listen_port = num(trim(run(`wg show ${ifname} listen-port 2>/dev/null`))) ?? view.listen_port;
		view.mtu = num(sysfs(`/sys/class/net/${ifname}/mtu`)) ?? view.mtu;
		view.rx_bytes = num(sysfs(`/sys/class/net/${ifname}/statistics/rx_bytes`));
		view.tx_bytes = num(sysfs(`/sys/class/net/${ifname}/statistics/tx_bytes`));
		for (let line in split(run(`wg show ${ifname} peers 2>/dev/null`), '\n'))
			if (is_key(trim(line)))
				live.known[trim(line)] = true;
		live.endpoints = table(ifname, 'endpoints');
		live.allowed = table(ifname, 'allowed-ips');
		live.handshakes = table(ifname, 'latest-handshakes');
		live.transfer = table(ifname, 'transfer');
		live.keepalive = table(ifname, 'persistent-keepalive');
	}

	// Configured peers first, in configuration order, then peers the kernel has that UCI does not.
	let confs = configured_peers(all, ifname);
	let sections = sort(filter(values(all), (s) => s['.type'] == `wireguard_${ifname}` && confs[trim(s.public_key ?? '')]), (a, b) => a['.index'] - b['.index']);
	let order = map(sections, (s) => trim(s.public_key));
	for (let k, v in live.known)
		if (index(order, k) < 0)
			push(order, k);

	view.peers = map(order, (k) => peer_view(k, confs[k], live, now));
	return view;
}

function collect() {
	let all = uci_all('network');
	let now = time();

	let names = [], configured = {};
	for (let n, s in all)
		if (s['.type'] == 'interface' && s.proto == 'wireguard') {
			push(names, n);
			configured[n] = true;
		}
	let running = {};
	for (let n in split(trim(run('wg show interfaces 2>/dev/null')), /[[:space:]]+/))
		if (n != '') {
			running[n] = true;
			if (!configured[n])
				push(names, n);
		}

	return { generated: now, interfaces: map(filter(names, safe_ifname), (n) => interface_view(all, n, running[n] == true, now)) };
}

return {
	'flab.wireguard': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
};
