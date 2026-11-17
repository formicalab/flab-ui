#!/usr/bin/ucode
//
// rpcd ucode plugin reporting WireGuard interfaces and their peers as JSON:
//   ubus call flab.wireguard status
//
// Everything is discovered at run time: interfaces from UCI network (proto "wireguard") plus whatever the
// kernel reports, peers from the `wireguard_<interface>` sections plus whatever the kernel knows, so a new
// interface or peer shows up on the next poll.
//
// Sources:
//   - UCI network: interface settings (addresses, listen port, MTU) and the configured peers (name,
//     allowed IPs, endpoint, keepalive)
//   - `wg show <if> <field>`: live state. Only the single-field forms are used (public-key, listen-port,
//     peers, endpoints, allowed-ips, latest-handshakes, transfer, persistent-keepalive), which
//     never print the private or pre-shared key
//   - UCI firewall: the zone an interface belongs to
//   - sysfs: interface MTU and counters, and /lib/netifd/proto/wireguard.uc (wireguard.sh on older releases): whether netifd has the protocol handler
//   - TCP connections to the router's web interface and SSH port (/proc/net/tcp, /proc/net/tcp6; the ports come from UCI
//     uhttpd and dropbear): the page uses their remote addresses to warn before a change cuts the tunnel the
//     administrator is working through
//
// Private and pre-shared keys are never read into the output. Public keys are not secret and identify peers.
// The page that edits the configuration reads it through this plugin: every option of an interface and of a peer
// section is returned except the secret ones (private_key, preshared_key and anything else named like a secret),
// which are reported only as "set" flags, so the browser never needs `uci get` on /etc/config/network.
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';
import { deferred } from 'flab.worker';

import { run, uci_all, sysfs, sysfs_raw, safe_ifname, num, as_list, fixture_time } from 'flab.util';

// A WireGuard session is rekeyed every 120 s while traffic flows and is rejected after 180 s without a
// handshake, so a peer whose last handshake is older than this is not currently connected.
const SESSION_S = 180;

// True for a WireGuard key in its base64 text form (32 bytes -> 43 characters plus one "=").
const is_key = (k) => match(k ?? '', /^[A-Za-z0-9+\/]{43}=$/) != null;

// Whether an option name may hold a secret: those options are never returned, only reported as set.
const is_secret_option = (name) => match(name, /private_key|preshared_key|psk|secret|passw|token/i) != null;

// The options of a UCI section split into { values, secrets }: `values` holds every option that is not secret (not
// the bookkeeping keys that start with a dot), `secrets` maps the name of each secret option that has a value to true.
function section_options(s) {
	let values = {}, secrets = {};
	for (let k, v in s ?? {}) {
		if (index(k, '.') == 0)
			continue;
		if (is_secret_option(k)) {
			if (v != null && v != '')
				secrets[k] = true;
		} else
			values[k] = v;
	}
	return { values, secrets };
}

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

// Name of the first firewall zone of the firewall config `fw` (see uci_all()) that lists `ifname` among its networks, or null.
function firewall_zone(fw, ifname) {
	for (let n, s in fw)
		if (s['.type'] == 'zone' && index(as_list(s.network), ifname) >= 0)
			return s.name;
	return null;
}

// The UCI sections of the peers of one interface, in configuration order. A section without a valid public key is
// kept (the page lets the user fix it); it has no live peer to match.
function peer_sections(all, ifname) {
	return sort(filter(values(all), (s) => s['.type'] == `wireguard_${ifname}`), (a, b) => a['.index'] - b['.index']);
}

// JSON view of one peer, merging the UCI section `conf` (may be null for a peer only the kernel knows) with
// the live `wg show` tables. `now` is the current epoch time. state is down (kernel has not loaded the peer),
// never (no handshake yet), connected (handshake within SESSION_S) or stale. handshake_age is in seconds.
// `section` is the UCI section name (an anonymous one is called cfgXXXXXX), `values` the section's options without
// the secret ones, `secrets` which secret options are set.
function peer_view(key, conf, live, now) {
	// wg prints the handshake as epoch seconds, 0 for "never".
	let hs = num(live.handshakes[key]?.[0]);
	let age = hs ? (now > hs ? now - hs : 0) : null;
	// wg prints "(none)" for fields that are unset.
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
	let opts = section_options(conf);
	// A public key option that is not a key may be a pasted secret, so it is never passed on.
	if (conf && !is_key(key))
		opts.values.public_key = '';
	return {
		name: conf?.description,
		public_key: key,
		section: conf?.['.name'] ?? null,
		values: opts.values,
		secrets: opts.secrets,
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

// JSON view of one interface: UCI settings overlaid with live kernel values when the interface is
// `running`, followed by its peers. `all` is the UCI network config and `fw` the UCI firewall config. `values` and `secrets` are the
// interface section's options as in peer_view().
function interface_view(all, fw, ifname, running, now) {
	let conf = all[ifname];
	let opts = section_options(conf);
	let view = {
		name: ifname,
		configured: conf != null,
		enabled: conf == null || conf.disabled != '1',
		up: running,
		zone: firewall_zone(fw, ifname),
		listen_port: num(conf?.listen_port),
		mtu: num(conf?.mtu),
		fwmark: conf?.fwmark,
		addresses: as_list(conf?.addresses),
		values: opts.values,
		secrets: opts.secrets,
	};

	// Live peer data keyed by public key; `known` is the set of peers the kernel has loaded.
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
	let seen = {};
	view.peers = [];
	for (let s in peer_sections(all, ifname)) {
		let key = trim(s.public_key ?? '');
		if (!is_key(key))
			key = '';
		else
			seen[key] = true;
		push(view.peers, peer_view(key, s, live, now));
	}
	for (let k, v in live.known)
		if (!seen[k])
			push(view.peers, peer_view(k, null, live, now));
	return view;
}

// The remote address of a hex address from /proc/net/tcp (IPv4, 8 hex digits, bytes in reverse order) or
// /proc/net/tcp6 (IPv6, 32 hex digits as four reversed 32-bit words); an IPv4-mapped address becomes dotted
// IPv4. Returns null for anything else.
function proc_address(text) {
	let bytes = [];
	if (length(text) == 8 || length(text) == 32) {
		for (let w = 0; w < length(text); w += 8)
			for (let b = 3; b >= 0; b--)
				push(bytes, hex(substr(text, w + b * 2, 2)));
	} else
		return null;
	if (length(bytes) == 4)
		return join('.', bytes);
	let mapped = true;
	for (let i = 0; i < 10; i++)
		if (bytes[i] != 0)
			mapped = false;
	if (mapped && bytes[10] == 255 && bytes[11] == 255)
		return join('.', slice(bytes, 12));
	let groups = [];
	for (let i = 0; i < 16; i += 2)
		push(groups, sprintf('%x', bytes[i] * 256 + bytes[i + 1]));
	return join(':', groups);
}

// The local ports the router can be administered on: the web server's and SSH server's (uci uhttpd, dropbear) plus
// the usual 22, 80 and 443.
function admin_ports() {
	let ports = { '22': true, '80': true, '443': true };
	for (let n, s in uci_all('uhttpd'))
		for (let opt in ['listen_http', 'listen_https'])
			for (let l in as_list(s[opt])) {
				let m = match(l, /:([0-9]+)$/);
				if (m)
					ports[m[1]] = true;
			}
	for (let n, s in uci_all('dropbear'))
		if (s.Port != null && match(s.Port, /^[0-9]+$/))
			ports[s.Port] = true;
	return ports;
}

// Established TCP connections to the router's administration ports, as [{ remote, port }] (loopback peers and
// duplicates left out). The page compares the remote addresses with the peers' allowed IPs to tell whether the
// administrator is connected through a tunnel.
function admin_sessions() {
	let ports = admin_ports(), seen = {}, out = [];
	for (let file in ['/proc/net/tcp', '/proc/net/tcp6'])
		for (let line in split(sysfs_raw(file) ?? '', '\n')) {
			let m = match(line, /^[[:space:]]*[0-9]+:[[:space:]]+([0-9A-Fa-f]+):([0-9A-Fa-f]+)[[:space:]]+([0-9A-Fa-f]+):([0-9A-Fa-f]+)[[:space:]]+([0-9A-Fa-f]{2})[[:space:]]/);
			let port = m ? hex(m[2]) : null;
			if (!m || m[5] != '01' || !ports[sprintf('%d', port)])
				continue;
			let remote = proc_address(m[3]);
			let key = `${remote}/${port}`;
			if (!remote || remote == '0:0:0:0:0:0:0:1' || index(remote, '127.') == 0 || seen[key])
				continue;
			seen[key] = true;
			push(out, { remote, port });
		}
	return slice(out, 0, 50);
}

// Builds the flab.wireguard status reply: every UCI wireguard interface plus any other interface listed by
// `wg show interfaces`, restricted to names that are safe to use on a command line. `names` lists the names of
// the sections of the network config (a new interface may not take one of them), `proto_installed` whether
// netifd has the wireguard protocol handler, `sessions` the administration connections (see admin_sessions()).
function collect() {
	let all = uci_all('network');
	// Loaded once for every interface's zone.
	let fw = uci_all('firewall');
	let now = fixture_time();

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

	let taken = [];
	for (let n, s in all)
		if (!s['.anonymous'])
			push(taken, n);

	return {
		generated: now,
		proto_installed: sysfs_raw('/lib/netifd/proto/wireguard.uc') != null || sysfs_raw('/lib/netifd/proto/wireguard.sh') != null,
		names: sort(taken),
		sessions: admin_sessions(),
		interfaces: map(filter(names, safe_ifname), (n) => interface_view(all, fw, n, running[n] == true, now)),
	};
}

// rpcd registration: ubus object flab.wireguard with the single method `status` (no arguments).
return deferred({
	'flab.wireguard': {
		status: {
			call: function() {
				return collect();
			},
		},
	},
});
