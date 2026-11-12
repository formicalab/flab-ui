#!/usr/bin/ucode
//
// rpcd ucode plugin that shows where the bandwidth goes: the connection tracking table and nlbwmon's per-host usage.
//   ubus call flab.traffic status
//   ubus call flab.traffic connections '{"q":"192.168.1","limit":300,"sort":"bytes","proto":"tcp","scope":"internet"}'
//   ubus call flab.traffic usage_periods
//   ubus call flab.traffic usage '{"period":"current","group":"mac,ip"}'
//
// `status` reports which features exist (conntrack readable, nlbw installed and nlbwmon running, byte accounting on)
// and the conntrack count and limit. `connections` parses /proc/net/nf_conntrack (at most MAX_PARSE entries), counts
// them per protocol, state and host, and returns the entries that pass the filters, sorted and cut to `limit`.
// `usage_periods` and `usage` run `nlbw` (nlbwmon's client) for the periods it keeps and the traffic of one period.
// Everything is read-only. Live throughput per interface is not here: the page takes it from flab.network.
//
// Safety: a connections request never reaches a shell (it only reads procfs). The only commands ever run are the
// fixed `command -v nlbw`, `pidof nlbwmon`, `ls /tmp/hosts`, `ip -6 neigh show` and `nlbw -c list|json`; the group is
// copied from an allow-list, and a period is used only when it is one of the dates `nlbw -c list` printed, so no
// text of the request can end up in a command line. Names come from the DHCP/hosts data of the router, never from
// reverse DNS.
//
// Speed: ucode runs a few hundred thousand operations per second on a small router, so the loop over the table
// does as little as it can per line: it cuts the line at its two "src=" markers with plain string functions (regular
// expressions cost far more), reads TCP and UDP lines by position, and builds the full entry (parse_line) only for
// the lines that are returned. A call also stops reading after BUDGET_MS and says so (`truncated`), so a huge table
// on a slow router cannot hold up rpcd.

'use strict';

import { connect } from 'ubus';
import { run, sysfs, sysfs_raw, ubus_call, uci_all, normalize_mac, as_list } from 'flab.util';

// The kernel's connection table and the netfilter settings next to it.
const CT_FILE = '/proc/net/nf_conntrack';
const NF_DIR = '/proc/sys/net/netfilter/';
// The most conntrack lines parsed per call (the main router can hold tens of thousands), and the entry limits.
const MAX_PARSE = 20000;
const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;
// How many hosts the top lists hold, and the most usage rows a reply carries.
const TOP_N = 10;
const MAX_USAGE_ROWS = 3000;
// Allow-lists of the request values that are not free text.
const SORTS = ['bytes', 'packets', 'timeout'];
const SCOPES = ['all', 'internet', 'internal'];
const GROUPS = ['fam', 'mac', 'ip', 'mac,ip', 'layer7', 'ip,layer7', 'mac,layer7'];
// What `q` may not contain: anything but letters, digits and . : - _ / space. A negated class never matches a newline
// (the regular expression engine treats lines separately), so has_other() looks for the newline itself as well.
const FILTER_BAD = /[^A-Za-z0-9.:_\/ -]/;
// The longest a call may spend reading the table, in milliseconds (0 = no limit); the loop stops there and the reply
// says the table was cut. rpcd runs plugins in its own event loop, so a long call would hold up every other one.
// Only the tests set the environment variable.
const BUDGET_MS = getenv('FLAB_TRAFFIC_BUDGET_MS') != null ? +getenv('FLAB_TRAFFIC_BUDGET_MS') : 3000;
// The date the tests pin "today" to (YYYY-MM-DD) so the length of a period is the same on every run; unset on a router.
const TODAY = getenv('FLAB_TRAFFIC_TODAY');

//#region Addresses

// The eight 16-bit groups of an IPv6 address written in any compression ("::" allowed), or null when it is not a
// plain IPv6 address (an embedded IPv4 tail is not handled).
function expand6(text) {
	if (index(text, '.') >= 0)
		return null;
	let parts = split(text, '::');
	if (length(parts) > 2)
		return null;
	let head = parts[0] == '' ? [] : split(parts[0], ':');
	let tail = (length(parts) == 2 && parts[1] != '') ? split(parts[1], ':') : [];
	let fill = 8 - length(head) - length(tail);
	if (length(parts) == 1 ? fill != 0 : fill < 1)
		return null;
	let out = [];
	for (let g in [...head, ...tail]) {
		if (!match(g, /^[0-9A-Fa-f]{1,4}$/))
			return null;
	}
	for (let g in head)
		push(out, hex(g));
	for (let i = 0; i < fill; i++)
		push(out, 0);
	for (let g in tail)
		push(out, hex(g));
	return out;
}

// The canonical text of eight groups, the way `ip` prints it: lowercase, no leading zeros, the longest run of two
// or more zero groups (the first when equal) written "::", and an IPv4-mapped address with a dotted tail.
function compress6(g) {
	if (g[0] == 0 && g[1] == 0 && g[2] == 0 && g[3] == 0 && g[4] == 0 && g[5] == 0xffff)
		return sprintf('::ffff:%d.%d.%d.%d', g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255);
	let best = -1, best_len = 0, cur = -1, cur_len = 0;
	for (let i = 0; i < 8; i++) {
		if (g[i] == 0) {
			if (cur < 0) {
				cur = i;
				cur_len = 0;
			}
			cur_len++;
			if (cur_len > best_len) {
				best = cur;
				best_len = cur_len;
			}
		}
		else
			cur = -1;
	}
	let text = [];
	for (let i = 0; i < 8; i++)
		push(text, sprintf('%x', g[i]));
	if (best_len < 2)
		return join(':', text);
	return join(':', slice(text, 0, best)) + '::' + join(':', slice(text, best + best_len));
}

// Memo of compressed IPv6 spellings, so a host that appears in thousands of entries is converted once.
let memo6 = {};

// The canonical form of an address: IPv6 is compressed (conntrack prints eight zero-padded groups), IPv4 and
// anything unrecognized are returned unchanged.
function canon(addr) {
	if (index(addr, ':') < 0)
		return addr;
	let c = memo6[addr];
	if (c == null) {
		let g = expand6(addr);
		c = g ? compress6(g) : lc(addr);
		memo6[addr] = c;
	}
	return c;
}

// Memo of whether an address is private (see is_private).
let memo_private = {};

// Whether an address stays inside the local network: IPv4 private, loopback, link-local, shared (CGNAT, which
// Tailscale uses), multicast and broadcast ranges; IPv6 loopback, unspecified, link-local, unique-local and multicast.
function is_private(addr) {
	let p = memo_private[addr];
	if (p != null)
		return p;
	if (index(addr, ':') >= 0) {
		let a = lc(addr);
		p = a == '::' || a == '::1' || match(a, /^(fe[89ab]|f[cd]|ff)/) != null;
	}
	else {
		let m = match(addr, /^([0-9]+)\.([0-9]+)\./);
		let a = m ? +m[1] : 0, b = m ? +m[2] : 0;
		p = m != null && (a == 0 || a == 10 || a == 127 || a >= 224 || (a == 172 && b >= 16 && b <= 31) ||
			(a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127));
	}
	memo_private[addr] = p;
	return p;
}

//#endregion

//#region Host names

// A host name without its domain; null for the placeholders DHCP clients send.
function short_name(name) {
	if (name == null || name == '' || name == '*')
		return null;
	let dot = index(name, '.');
	return dot > 0 ? substr(name, 0, dot) : name;
}

// Sets map[key] to the name unless the key already has one (the first source to name a host wins).
function put_name(map, key, name) {
	name = short_name(name);
	if (key != null && key != '' && name != null && map[key] == null)
		map[key] = name;
}

// Display names of the local hosts as { ip: { address: name }, mac: { address: name } }. Sources, in order of
// precedence: static DHCP host entries, the DHCP leases (odhcpd through ubus and dnsmasq's lease file), the hosts
// files dnsmasq and odhcpd write to /tmp/hosts, /etc/ethers, and the neighbor tables, which give a host that
// has a name the names of its other addresses (a SLAAC address of a laptop has no lease).
function name_maps() {
	let by_ip = {}, by_mac = {};
	let conn = connect();

	// Static host entries: name, one or more MACs and an optional address.
	for (let name, s in uci_all('dhcp')) {
		if (s['.type'] != 'host')
			continue;
		for (let mac in as_list(s.mac)) {
			put_name(by_mac, normalize_mac(mac), s.name);
			put_name(by_ip, s.ip, s.name);
		}
		if (s.mac == null)
			put_name(by_ip, s.ip, s.name);
	}

	// Leases served by odhcpd.
	let v4 = ubus_call(conn, 'dhcp', 'ipv4leases', {}) ?? {};
	for (let dev, d in v4.device ?? {})
		for (let l in d.leases ?? []) {
			put_name(by_mac, normalize_mac(l.mac ?? ''), l.hostname);
			put_name(by_ip, l.address, l.hostname);
		}
	let v6 = ubus_call(conn, 'dhcp', 'ipv6leases', {}) ?? {};
	for (let dev, d in v6.device ?? {})
		for (let l in d.leases ?? [])
			for (let a in l['ipv6-addr'] ?? [])
				put_name(by_ip, canon(a.address ?? ''), l.hostname);

	// dnsmasq's lease file: "expiry mac ip name clientid" for IPv4, "expiry iaid ip6 name duid" for IPv6.
	for (let line in split(sysfs_raw('/tmp/dhcp.leases') ?? '', '\n')) {
		let f = split(trim(line), /[ \t]+/);
		if (length(f) < 4 || f[0] == 'duid')
			continue;
		if (index(f[2], ':') >= 0)
			put_name(by_ip, canon(f[2]), f[3]);
		else {
			put_name(by_mac, normalize_mac(f[1]), f[3]);
			put_name(by_ip, f[2], f[3]);
		}
	}

	// Hosts files: "address name" lines.
	for (let f in split(run('ls /tmp/hosts 2>/dev/null') ?? '', '\n')) {
		if (!match(f, /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/))
			continue;
		for (let line in split(sysfs_raw('/tmp/hosts/' + f) ?? '', '\n')) {
			let p = split(trim(line), /[ \t]+/);
			if (length(p) >= 2 && substr(p[0], 0, 1) != '#')
				put_name(by_ip, canon(p[0]), p[1]);
		}
	}

	for (let line in split(sysfs_raw('/etc/ethers') ?? '', '\n')) {
		let p = split(trim(line), /[ \t]+/);
		if (length(p) >= 2)
			put_name(by_mac, normalize_mac(p[0]), p[1]);
	}

	// Neighbor tables: an address whose MAC has a name takes it. Row 0 of /proc/net/arp is the header.
	let arp = split(sysfs_raw('/proc/net/arp') ?? '', '\n');
	for (let i = 1; i < length(arp); i++) {
		let p = split(trim(arp[i]), /[ \t]+/);
		let mac = length(p) >= 6 && (hex(substr(p[2], 2)) & 2) ? normalize_mac(p[3]) : null;
		if (mac != null)
			put_name(by_ip, p[0], by_mac[mac]);
	}
	for (let line in split(run('ip -6 neigh show 2>/dev/null') ?? '', '\n')) {
		let p = split(trim(line), /[ \t]+/);
		let ll = index(p, 'lladdr');
		let mac = (ll > 0 && ll + 1 < length(p)) ? normalize_mac(p[ll + 1]) : null;
		if (mac != null)
			put_name(by_ip, canon(p[0]), by_mac[mac]);
	}
	return { ip: by_ip, mac: by_mac };
}

//#endregion

//#region Features

// Whether the nlbw client is installed.
function has_nlbw() {
	return trim(run('command -v nlbw 2>/dev/null') ?? '') != '';
}

// Whether the nlbwmon daemon runs (nlbw talks to it; without it every nlbw command fails).
function nlbwmon_running() {
	return trim(run('pidof nlbwmon 2>/dev/null') ?? '') != '';
}

// A number from a /proc/sys/net/netfilter file, or null when the file is missing.
function nf_number(name) {
	let v = sysfs(NF_DIR + name);
	return (v != null && match(v, /^[0-9]+$/)) ? +v : null;
}

// The connection counters of the kernel: { count, max, acct (whether packet and byte counters are kept, null when
// unknown) }. The table itself is not read here, which would cost a whole dump on a busy router; the count file
// exists exactly when the connection tracker is loaded, so it also says whether the table can be read.
function conntrack_info() {
	let acct = nf_number('nf_conntrack_acct');
	return { count: nf_number('nf_conntrack_count'), max: nf_number('nf_conntrack_max'), acct: acct == null ? null : acct == 1 };
}

// The reply of `status`: what exists on this router.
function status() {
	let ct = conntrack_info();
	return {
		generated: time(),
		conntrack: ct.count != null,
		count: ct.count,
		max: ct.max,
		acct: ct.acct,
		nlbw: has_nlbw(),
		nlbwmon_running: nlbwmon_running(),
	};
}

//#endregion

//#region Connections

// Whether a text holds a character that `bad` matches or a newline.
function has_other(text, bad) {
	return index(text, '\n') >= 0 || match(text, bad) != null;
}

// The fields of one tuple of a conntrack line from its text, which starts after the "src=" marker and so reads
// "A dst=B sport=1 dport=2 packets=3 bytes=4 [UNREPLIED] ...": { src, dst, sport, dport, type (ICMP), packets,
// bytes, flags }. Keys it does not know (mark, zone, use, GRE keys) are skipped.
function read_tuple(text) {
	let t = split(text, ' ');
	let o = { src: t[0], flags: [] };
	for (let i = 1; i < length(t); i++) {
		let tok = t[i];
		let eq = index(tok, '=');
		if (eq > 0) {
			let k = substr(tok, 0, eq);
			if (k == 'dst')
				o.dst = substr(tok, 4);
			else if (k == 'sport')
				o.sport = +substr(tok, 6);
			else if (k == 'dport')
				o.dport = +substr(tok, 6);
			else if (k == 'packets')
				o.packets = +substr(tok, 8);
			else if (k == 'bytes')
				o.bytes = +substr(tok, 6);
			else if (k == 'type')
				o.type = +substr(tok, 5);
		}
		else if (substr(tok, 0, 1) == '[')
			push(o.flags, substr(tok, 1, length(tok) - 2));
	}
	return o;
}

// One line of /proc/net/nf_conntrack as an entry, or null when it is not one. A line reads
//   ipv4     2 tcp      6 300 ESTABLISHED src=A dst=B sport=1 dport=2 packets=3 bytes=4 src=B dst=A sport=2 dport=1
//   packets=5 bytes=6 [ASSURED] mark=0 zone=0 use=2
// (the kernel pads the family to 8 characters and the protocol name to 8; the state word exists for TCP and a few
// other protocols, [UNREPLIED] sits between the two tuples, the packet and byte counters exist only with
// nf_conntrack_acct, and a flow in the hardware or software flow table has [OFFLOAD] and no timeout). `nat` is set
// when the reply tuple is not the mirror image of the original one: it holds the original tuple as the other side
// of the translation sees it.
function parse_line(line) {
	let p = split(line, 'src=');
	if (length(p) != 3)
		return null;
	// Cutting the head at spaces leaves empty words for the padding: family, then four empty words, the number of the
	// address family, the protocol name, 8 - length(name) empty words, then the protocol number, timeout and state.
	let hd = split(p[0], ' ');
	let proto = hd[6];
	if ((hd[0] != 'ipv4' && hd[0] != 'ipv6') || !proto)
		return null;
	let at = 7 + (length(proto) < 8 ? 8 - length(proto) : 0);
	let o = read_tuple(p[1]), r = read_tuple(p[2]);
	if (o.dst == null)
		return null;

	let v6 = hd[0] == 'ipv6';
	let e = {
		family: v6 ? 6 : 4, proto, state: hd[at + 2] || null, timeout: hd[at + 1] ? +hd[at + 1] : null,
		flags: [...o.flags, ...r.flags],
		src: v6 ? canon(o.src) : o.src, dst: v6 ? canon(o.dst) : o.dst, sport: o.sport, dport: o.dport,
		rsrc: v6 ? canon(r.src) : r.src, rdst: v6 ? canon(r.dst) : r.dst,
	};
	if (o.type != null)
		e.icmp = o.type;
	if (r.dst != null && (r.src != o.dst || r.dst != o.src || r.sport != o.dport || r.dport != o.sport))
		e.nat = { src: e.rdst, dst: e.rsrc, sport: r.dport, dport: r.sport };
	if (o.bytes != null || r.bytes != null) {
		e.bytes = [o.bytes ?? 0, r.bytes ?? 0];
		e.packets = [o.packets ?? 0, r.packets ?? 0];
	}
	return e;
}

// The `n` hosts of a tally ({ address: [connections, bytes, unreplied] }) with the largest value at position `at`,
// largest first, as [{ addr, connections, bytes, unreplied }]; equal values are ordered by address so the result does
// not depend on the table's order. Hosts with a zero value are left out.
function top_hosts(tally, at, n) {
	let best = [];
	for (let addr, c in tally) {
		let x = c[at];
		if (x <= 0)
			continue;
		if (length(best) >= n) {
			let last = best[n - 1];
			if (x < last.v || (x == last.v && addr > last.addr))
				continue;
		}
		let i = length(best);
		while (i > 0 && (best[i - 1].v < x || (best[i - 1].v == x && best[i - 1].addr > addr)))
			i--;
		splice(best, i, 0, { addr, v: x, connections: c[0], bytes: c[1], unreplied: c[2] });
		if (length(best) > n)
			pop(best);
	}
	return map(best, (h) => ({ addr: h.addr, connections: h.connections, bytes: h.bytes, unreplied: h.unreplied }));
}

// A { name: count } tally as [{ name, count }], largest first.
function counted(map) {
	let out = [];
	for (let name, count in map)
		push(out, { name, count });
	return sort(out, (a, b) => (b.count - a.count) || (a.name < b.name ? -1 : 1));
}

// The positions of the `limit` largest values of `values`, largest first; equal values keep the table's order. A
// plain numeric sort finds the cut-off so that only the entries that are kept go through the slower comparison.
function largest(values, limit) {
	let n = length(values);
	let keep = [];
	if (n <= limit)
		for (let i = 0; i < n; i++)
			push(keep, i);
	else {
		let cut = sort(slice(values))[n - limit];
		let ties = [];
		for (let i = 0; i < n; i++) {
			if (values[i] > cut)
				push(keep, i);
			else if (values[i] == cut)
				push(ties, i);
		}
		for (let i in ties) {
			if (length(keep) >= limit)
				break;
			push(keep, i);
		}
	}
	return sort(keep, (a, b) => (values[b] - values[a]) || (a - b));
}

// The request of `connections` checked against the allow-lists as { q, limit, sort, proto, scope }, or { error }.
function connection_request(args) {
	let q = args?.q ?? '';
	if (type(q) != 'string' || length(q) > 64 || has_other(q, FILTER_BAD))
		return { error: 'The filter may hold letters, digits and . : - _ / space, at most 64 characters.' };
	let limit = args?.limit ?? DEFAULT_LIMIT;
	if (type(limit) != 'int' || limit < 1 || limit > MAX_LIMIT)
		return { error: `The limit must be a whole number from 1 to ${MAX_LIMIT}.` };
	let sort_by = args?.sort ?? 'bytes';
	if (type(sort_by) != 'string' || !(sort_by in SORTS))
		return { error: `The sort must be one of ${join(', ', SORTS)}.` };
	let proto = args?.proto ?? 'all';
	if (type(proto) != 'string' || (proto != 'all' && (length(proto) > 12 || !length(proto) || has_other(proto, /[^a-z0-9]/))))
		return { error: 'The protocol must be a lowercase name such as tcp.' };
	let scope = args?.scope ?? 'all';
	if (type(scope) != 'string' || !(scope in SCOPES))
		return { error: `The scope must be one of ${join(', ', SCOPES)}.` };
	return { q: trim(q), limit, sort: sort_by, proto, scope };
}

// The reply of `connections`; see the header for the request and README.md for the shape of the reply.
function connections(args) {
	let req = connection_request(args);
	if (req.error)
		return { ok: false, error: req.error };

	let ct = conntrack_info();
	let out = {
		ok: true, generated: time(), available: ct.count != null, count: ct.count, max: ct.max, acct: ct.acct,
		request: req, total: 0, parsed: 0, truncated: false, matched: 0, entries: [], names: {},
		aggregates: { protocols: [], states: [], unreplied: 0, nat: 0, sources: {}, destinations: {}, unreplied_sources: [] },
	};
	let raw = sysfs_raw(CT_FILE);
	if (raw == null || raw == '')
		return out;

	let lines = split(raw, '\n');
	let total = length(lines);
	if (total && lines[total - 1] == '')
		total--;
	let parsed = total < MAX_PARSE ? total : MAX_PARSE;
	out.total = total;
	out.truncated = total > parsed;

	let names = name_maps();
	let terms = filter(split(lc(req.q), ' '), (t) => t != '');
	let texty = length(terms) > 0, scoped = req.scope != 'all', by_proto = req.proto != 'all';
	let by_timeout = req.sort == 'timeout', by_packets = req.sort == 'packets';
	// Per-host tallies are [connections, bytes, unreplied]; hits are the positions of the lines that pass the filters
	// and values their sort keys.
	let protocols = {}, states = {}, srcs = {}, dsts = {};
	let hits = [], values = [];
	let unreplied = 0, translated = 0, count = 0;
	let started = clock(true);

	for (let i = 0; i < parsed; i++) {
		// Every 512 lines, stop when the call has used up its time (see BUDGET_MS).
		if (BUDGET_MS > 0 && (i & 511) == 511) {
			let now = clock(true);
			if ((now[0] - started[0]) * 1000 + (now[1] - started[1]) / 1000000 > BUDGET_MS) {
				out.truncated = true;
				break;
			}
		}
		let line = lines[i];
		let p = split(line, 'src=');
		if (length(p) != 3)
			continue;
		let hd = split(p[0], ' ');
		let a = split(p[1], ' '), b = split(p[2], ' ');
		let proto = hd[6], fam = hd[0];
		let src, dst, state, timeout, sum = 0, psum = 0, lost, natted, e = null;

		// TCP and UDP lines have a fixed layout (three-letter protocol names put the timeout at word 13 and the
		// state at word 14): the original tuple is [src, dst=, sport=, dport=, (packets=, bytes=,) (flag,) ""], and the
		// reply tuple starts the same way. Anything else goes through the general parser.
		if ((proto == 'tcp' || proto == 'udp') && (fam == 'ipv4' || fam == 'ipv6') && length(a) >= 5 && length(b) >= 5 && substr(a[1], 0, 4) == 'dst=') {
			src = a[0];
			dst = substr(a[1], 4);
			timeout = hd[13] ? +hd[13] : null;
			state = hd[14] || null;
			if (substr(a[4], 0, 1) == 'p') {
				sum = +substr(a[5], 6) + +substr(b[5], 6);
				if (by_packets)
					psum = +substr(a[4], 8) + +substr(b[4], 8);
			}
			lost = index(p[1], '[UNREPLIED]') >= 0;
			// Translated when the reply does not start with the mirror image of the original tuple.
			natted = index(p[2], `${dst} dst=${src} sport=${substr(a[3], 6)} dport=${substr(a[2], 6)} `) != 0;
			if (fam == 'ipv6') {
				src = memo6[src] ?? canon(src);
				dst = memo6[dst] ?? canon(dst);
			}
		}
		else {
			e = parse_line(line);
			if (!e)
				continue;
			src = e.src;
			dst = e.dst;
			proto = e.proto;
			state = e.state;
			timeout = e.timeout;
			lost = index(e.flags, 'UNREPLIED') >= 0;
			natted = e.nat != null;
			if (e.bytes)
				sum = e.bytes[0] + e.bytes[1];
			if (e.packets)
				psum = e.packets[0] + e.packets[1];
		}

		count++;
		protocols[proto] = (protocols[proto] ?? 0) + 1;
		if (state)
			states[state] = (states[state] ?? 0) + 1;
		let c = srcs[src];
		if (c) {
			c[0] += 1;
			c[1] += sum;
			if (lost)
				c[2] += 1;
		}
		else
			srcs[src] = [1, sum, lost ? 1 : 0];
		c = dsts[dst];
		if (c) {
			c[0] += 1;
			c[1] += sum;
			if (lost)
				c[2] += 1;
		}
		else
			dsts[dst] = [1, sum, lost ? 1 : 0];
		if (lost)
			unreplied++;
		if (natted)
			translated++;

		if (by_proto && proto != req.proto)
			continue;
		if (scoped) {
			// An entry is internal when all four addresses are local.
			let rs, rd;
			if (e) {
				rs = e.rsrc;
				rd = e.rdst;
			}
			else {
				rs = canon(b[0]);
				rd = canon(substr(b[1], 4));
			}
			let local = is_private(src) && is_private(dst) && is_private(rs) && is_private(rd);
			if (local != (req.scope == 'internal'))
				continue;
		}
		if (texty) {
			// The text a filter searches: family, protocol, state, both endpoints and their ports, the names of the
			// hosts, the flags and the translated tuple.
			let fam_text, sp, dp, flags, moved = '';
			if (e) {
				fam_text = e.family == 6 ? 'ipv6' : 'ipv4';
				sp = e.sport ?? '';
				dp = e.dport ?? '';
				flags = join(' ', e.flags);
				if (e.nat)
					moved = `${e.nat.src} ${e.nat.dst} ${e.nat.sport ?? ''} ${e.nat.dport ?? ''}`;
			}
			else {
				fam_text = fam;
				sp = substr(a[2], 6);
				dp = substr(a[3], 6);
				flags = (lost ? 'UNREPLIED ' : '') + (index(p[2], '[ASSURED]') >= 0 ? 'ASSURED ' : '') + (index(p[2], '[OFFLOAD]') >= 0 ? 'OFFLOAD' : '');
				if (natted)
					moved = `${canon(b[0])} ${canon(substr(b[1], 4))} ${substr(b[2], 6)} ${substr(b[3], 6)}`;
			}
			let hay = lc(`${fam_text} ${proto} ${state ?? ''} ${src} ${dst} ${sp} ${dp} ${names.ip[src] ?? ''} ${names.ip[dst] ?? ''} ${flags} ${moved}`);
			let all = true;
			for (let t in terms)
				if (index(hay, t) < 0) {
					all = false;
					break;
				}
			if (!all)
				continue;
		}
		push(hits, i);
		push(values, by_timeout ? (timeout ?? 0) : by_packets ? psum : sum);
	}

	// Only the entries that are returned are parsed in full.
	let chosen = [];
	for (let pos in largest(values, req.limit)) {
		let e = parse_line(lines[hits[pos]]);
		if (e) {
			// The reply tuple's addresses served the scope check; the page needs only `nat`.
			delete e.rsrc;
			delete e.rdst;
			push(chosen, e);
		}
	}

	// The addresses the reply mentions get a name when the router knows one.
	let wanted = {};
	for (let e in chosen) {
		wanted[e.src] = wanted[e.dst] = true;
		if (e.nat)
			wanted[e.nat.src] = wanted[e.nat.dst] = true;
	}
	let tops = {
		sources: { by_connections: top_hosts(srcs, 0, TOP_N), by_bytes: top_hosts(srcs, 1, TOP_N) },
		destinations: { by_connections: top_hosts(dsts, 0, TOP_N), by_bytes: top_hosts(dsts, 1, TOP_N) },
		unreplied_sources: top_hosts(srcs, 2, 5),
	};
	for (let list in [tops.sources.by_connections, tops.sources.by_bytes, tops.destinations.by_connections, tops.destinations.by_bytes, tops.unreplied_sources])
		for (let h in list)
			wanted[h.addr] = true;
	for (let addr in keys(wanted))
		if (names.ip[addr] != null)
			out.names[addr] = names.ip[addr];

	out.parsed = count;
	out.matched = length(hits);
	out.entries = chosen;
	out.aggregates = {
		protocols: counted(protocols), states: counted(states), unreplied, nat: translated,
		sources: tops.sources, destinations: tops.destinations, unreplied_sources: tops.unreplied_sources,
	};
	return out;
}

//#endregion

//#region Usage

// The accounting periods nlbwmon keeps, newest first. Only lines that are plain dates count, so whatever else the
// tool prints is ignored and every period handed out is safe to put into a command line.
function periods() {
	let out = [];
	for (let line in split(run('nlbw -c list 2>/dev/null') ?? '', '\n')) {
		line = trim(line);
		if (match(line, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/))
			push(out, line);
	}
	return reverse(sort(out));
}

// The length of month `m` (1 to 12) of year `y`, in days.
function month_len(y, m) {
	if (m == 2)
		return ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) ? 29 : 28;
	return index([ 4, 6, 9, 11 ], m) >= 0 ? 30 : 31;
}

// The day number (days since 1970-01-01) of a YYYY-MM-DD date, or null when `s` is not a real date.
function day_of(s) {
	let m = type(s) == 'string' ? match(s, /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/) : null;
	if (m == null)
		return null;
	let mon = +m[2], d = +m[3];
	if (mon < 1 || mon > 12 || d < 1 || d > month_len(+m[1], mon))
		return null;
	return int(timegm({ year: +m[1], mon, mday: d, hour: 0, min: 0, sec: 0 }) / 86400);
}

// The YYYY-MM-DD date of a day number.
function date_of(day) {
	let t = gmtime(day * 86400);
	return sprintf('%04d-%02d-%02d', t.year, t.mon, t.mday);
}

// The day number of today in the router's time zone (the date nlbwmon's periods are counted in).
function today_day() {
	let pinned = day_of(TODAY);
	if (pinned != null)
		return pinned;
	let t = localtime(time());
	return day_of(sprintf('%04d-%02d-%02d', t.year, t.mon, t.mday));
}

// The accounting interval nlbwmon is configured with (option database_interval); "1", its default, when unset.
function interval() {
	for (let name, s in uci_all('nlbwmon'))
		if (s['.type'] == 'nlbwmon' && s.database_interval != null)
			return '' + s.database_interval;
	return '1';
}

// The day number a monthly period starts on in month `m` of year `y`: day `n` of the month (cut to the month's length),
// or counted from the end for a negative `n` (-1 is the last day, -2 the one before).
function month_start(y, m, n) {
	let len = month_len(y, m);
	let d = n > 0 ? (n > len ? len : n) : len + n + 1;
	return day_of(sprintf('%04d-%02d-%02d', y, m, d < 1 ? 1 : d));
}

// The period that contains day `day` under the interval `spec`: { start, end } as day numbers, `end` being the first day
// of the next period. The interval is either "YYYY-MM-DD/NN" (a period every NN days from that date) or a day of the
// month (what nlbwmon's database_interval documents).
function period_bounds(spec, day) {
	let m = match(spec, /^([0-9]{4}-[0-9]{2}-[0-9]{2})\/([0-9]+)$/);
	if (m != null && day_of(m[1]) != null && +m[2] > 0) {
		let base = day_of(m[1]), n = +m[2];
		let start = day < base ? base : base + int((day - base) / n) * n;
		return { start, end: start + n };
	}
	let n = match(spec, /^-?[0-9]+$/) != null ? int(spec) : 1;
	if (n == 0 || n > 31 || n < -31)
		n = 1;
	let t = gmtime(day * 86400);
	let y = t.year, mo = t.mon;
	let start = month_start(y, mo, n);
	if (start > day) {
		mo--;
		if (mo < 1) {
			mo = 12;
			y--;
		}
		start = month_start(y, mo, n);
	}
	let ny = y, nm = mo + 1;
	if (nm > 12) {
		nm = 1;
		ny++;
	}
	return { start, end: month_start(ny, nm, n) };
}

// The accounting period of a reply: when it starts and ends (the end is the first day of the next period), today, whether
// it is still running and how many days it covers so far. `period` is "current" or a listed date; null for anything else.
function period_window(period) {
	let spec = interval();
	let now = today_day();
	let cur = period_bounds(spec, now);
	let start = period == 'current' ? cur.start : day_of(period);
	if (start == null)
		return null;
	let end = start == cur.start ? cur.end : period_bounds(spec, start).end;
	let ongoing = end > now;
	let days = (ongoing ? now : end - 1) - start + 1;
	return { start: date_of(start), end: date_of(end), today: date_of(now), ongoing, days: days < 1 ? 1 : days };
}

// The reply of `usage_periods`: whether nlbw and its daemon exist, the periods available and the start of the one that is
// running now (it is only listed once nlbwmon has committed it to disk).
function usage_periods() {
	let present = has_nlbw();
	let running = present && nlbwmon_running();
	return { ok: true, generated: time(), present, running, periods: running ? periods() : [], current: period_window('current').start, today: date_of(today_day()) };
}

// The reply of `usage`: the traffic nlbwmon counted for one period, grouped by one allow-listed group, as
// { columns, rows (objects keyed by column, largest total first, at most MAX_USAGE_ROWS), totals, names }.
function usage(args) {
	let period = args?.period ?? 'current';
	let group = args?.group;
	if (type(period) != 'string' || length(period) > 10 || (period != 'current' && !match(period, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)))
		return { ok: false, error: 'The period must be "current" or one of the listed dates.' };
	// The group in the command is the allow-list's own string, never the one from the request.
	let gi = type(group) == 'string' ? index(GROUPS, group) : -1;
	if (gi < 0)
		return { ok: false, error: `The group must be one of ${join(', ', GROUPS)}.` };
	if (!has_nlbw())
		return { ok: false, error: 'nlbw is not installed.' };
	if (!nlbwmon_running())
		return { ok: false, error: 'nlbwmon is not running.' };

	let cmd = `nlbw -c json -g ${GROUPS[gi]}`;
	if (period != 'current') {
		let listed = filter(periods(), (p) => p == period)[0];
		if (listed == null)
			return { ok: false, error: 'That period is not one nlbwmon keeps.' };
		cmd += ` -t ${listed}`;
	}
	let text = trim(run(cmd + ' 2>/dev/null') ?? '');
	let data = substr(text, 0, 1) == '{' ? json(text) : null;
	if (type(data?.columns) != 'array' || type(data?.data) != 'array')
		return { ok: false, error: 'nlbw returned no data for that period.' };

	let rows = [];
	let totals = { conns: 0, rx_bytes: 0, rx_pkts: 0, tx_bytes: 0, tx_pkts: 0 };
	for (let r in data.data) {
		let row = {};
		for (let i = 0; i < length(data.columns); i++)
			row[data.columns[i]] = r[i];
		for (let k, v in totals)
			totals[k] += +(row[k] ?? 0);
		push(rows, row);
	}
	rows = sort(rows, (a, b) => ((+b.rx_bytes + +b.tx_bytes) - (+a.rx_bytes + +a.tx_bytes)));
	let total_rows = length(rows);
	if (total_rows > MAX_USAGE_ROWS)
		rows = slice(rows, 0, MAX_USAGE_ROWS);

	let names = name_maps();
	let named = { ip: {}, mac: {} };
	for (let row in rows) {
		if (row.ip != null && names.ip[canon(row.ip)] != null)
			named.ip[row.ip] = names.ip[canon(row.ip)];
		if (row.mac != null && names.mac[row.mac] != null)
			named.mac[row.mac] = names.mac[row.mac];
	}
	return { ok: true, generated: time(), period, window: period_window(period), group: GROUPS[gi], columns: data.columns, rows, total_rows, truncated: total_rows > length(rows), totals, names: named };
}

//#endregion

// rpcd registration: ubus object flab.traffic. The args objects name the accepted fields and their types.
return {
	'flab.traffic': {
		status: {
			call: function(request) {
				return status();
			},
		},
		connections: {
			args: { q: '', limit: 0, sort: '', proto: '', scope: '' },
			call: function(request) {
				return connections(request.args);
			},
		},
		usage_periods: {
			call: function(request) {
				return usage_periods();
			},
		},
		usage: {
			args: { period: '', group: '' },
			call: function(request) {
				return usage(request.args);
			},
		},
	},
};
