#!/usr/bin/ucode
//
// rpcd ucode plugin reporting the BIRD BGP situation as JSON: ubus call flab.bgp status
//
// Sources:
//   - birdc (BIRD control socket): daemon status, protocols with channel statistics, the
//     master routing table with all BGP attributes, per-peer export tables, memory use
//   - ip route show proto bird: what the kernel protocol actually installed (ECMP next hops)
//
// BIRD 3 has no machine-readable output, so the human-readable birdc text is parsed. The parser
// ignores lines it does not know, so a newer BIRD only loses fields instead of breaking the page.
// rpcd runs plugins in-process; this plugin deliberately calls no ubus objects.

'use strict';

import { deferred } from 'flab.worker';
import { readfile } from 'fs';
import { run, num } from 'flab.util';

// Multipliers from the unit printed by `birdc show memory` to bytes (BIRD uses 1024-based units).
const MEM_UNITS = { B: 1, kB: 1024, MB: 1048576, GB: 1073741824 };
// Order of the counter columns in the "Import updates:" / "Export withdraws:" rows of `show protocols all`.
const STAT_COLUMNS = ['received', 'rejected', 'filtered', 'ignored', 'rx_limit', 'limit', 'accepted'];

// Test seam: with FLAB_BGP_FIXTURES=<dir> set (never the case inside rpcd) saved command output is read
// from <dir>/<name>.txt instead of running birdc/ip, so down-state and IPv6 samples can be tested.
const FIXTURES = getenv('FLAB_BGP_FIXTURES');

// Output of the command `cmd`, or of the fixture file `name` when the test seam is active.
function source(name, cmd) {
	return FIXTURES ? (readfile(`${FIXTURES}/${name}.txt`) ?? '') : run(cmd);
}

// Protocol names come from birdc output and are interpolated into a shell command, so validate them.
function safe_name(name) {
	return name && match(name, /^[A-Za-z0-9_.-]+$/) != null;
}

// Output of `birdc <cmd>` (stderr included so a connection failure is visible); the fixture name is the
// command with non-alphanumerics turned into "_".
function birdc(cmd) {
	return source(replace(cmd, /[^A-Za-z0-9]+/g, '_'), 'birdc ' + cmd + ' 2>&1');
}

// Normalized object key for a birdc label: lower case, runs of non-alphanumerics become "_"
// ("Neighbor AS" -> "neighbor_as").
function key_of(text) {
	return lc(replace(trim(text), /[^A-Za-z0-9]+/g, '_'));
}

// Numeric value of a birdc cell, or null for the placeholders "---", "-" and empty.
function number_or_null(v) {
	return (v == null || v == '---' || v == '' || v == '-') ? null : +v;
}

// "2026-11-06 15:59:38.576" -> epoch seconds (local time), or null.
function parse_time(text) {
	let m = match(text ?? '', /^([0-9]{4})-([0-9]{2})-([0-9]{2})([ T]([0-9]{2}):([0-9]{2}):([0-9]{2}))?/);
	if (!m)
		return null;
	return timelocal({ year: +m[1], mon: +m[2], mday: +m[3], hour: +(m[5] ?? 0), min: +(m[6] ?? 0), sec: +(m[7] ?? 0), isdst: -1 });
}

// Contents of every "(...)" group, e.g. "(0,12076) (65515, 1, 2)" -> ["0,12076", "65515, 1, 2"].
function groups(text) {
	let out = [];
	for (let g in match(text ?? '', /\(([^)]*)\)/g) ?? [])
		push(out, g[1]);
	return out;
}

//#region birdc show status / memory

// Parses `birdc show status` into { version, router_id, hostname, now, started, reconfigured, state };
// the three times are epoch seconds (see parse_time).
function parse_status(text) {
	let s = {};
	for (let line in split(text, '\n')) {
		let m;
		if ((m = match(line, /^BIRD ([0-9][0-9.]*)/)))
			s.version = m[1];
		else if ((m = match(line, /^Router ID is (.*)$/)))
			s.router_id = trim(m[1]);
		else if ((m = match(line, /^Hostname is (.*)$/)))
			s.hostname = trim(m[1]);
		else if ((m = match(line, /^Current server time is (.*)$/)))
			s.now = parse_time(m[1]);
		else if ((m = match(line, /^Last reboot on (.*)$/)))
			s.started = parse_time(m[1]);
		else if ((m = match(line, /^Last reconfiguration on (.*)$/)))
			s.reconfigured = parse_time(m[1]);
		else if (match(line, /^Daemon is /))
			s.state = trim(replace(line, /^Daemon is /, ''));
	}
	return s;
}

// Each line looks like "Routing tables:    162.9 kB     13.4 kB" (effective, overhead).
// Returns [{ name, effective, overhead }] with both values converted to bytes.
function parse_memory(text) {
	let rows = [];
	for (let line in split(text, '\n')) {
		let m = match(line, /^([A-Za-z][A-Za-z ]*):[ ]+(.*)$/);
		if (!m)
			continue;
		let tok = split(trim(m[2]), /[ ]+/);
		let values = [];
		// Tokens come in (number, unit) pairs; a non-unit token means this is not a memory row.
		for (let i = 0; i + 1 < length(tok); i += 2) {
			let unit = MEM_UNITS[tok[i + 1]];
			if (unit == null)
				break;
			push(values, int(+tok[i] * unit));
		}
		if (length(values))
			push(rows, { name: trim(m[1]), effective: values[0], overhead: values[1] });
	}
	return rows;
}
//#endregion

//#region birdc show protocols all

// A BGP timer value "left/total" (seconds, e.g. "3.2/10") as { left, total }; null when it does not parse.
function parse_timer(value) {
	let m = match(value ?? '', /^([0-9.]+)\/([0-9.]+)/);
	return m ? { left: +m[1], total: +m[2] } : null;
}

// Parses the counters of one "Import updates:" style row into an object keyed by STAT_COLUMNS
// (extra columns become c<N>); "---" cells become null.
function parse_stats_row(rest) {
	let tok = split(trim(rest), /[ ]+/);
	let row = {};
	for (let i = 0; i < length(tok); i++)
		row[STAT_COLUMNS[i] ?? ('c' + i)] = number_or_null(tok[i]);
	return row;
}

// Turns a channel's "Routes:" text ("3 imported, 1 filtered, ...") into { imported, filtered, ... } counts.
function finish_channel(ch) {
	let r = ch.routes;
	if (type(r) == 'string') {
		let counts = {};
		for (let word in ['imported', 'exported', 'preferred', 'filtered', 'rejected']) {
			let m = match(r, regexp('([0-9]+) ' + word));
			if (m)
				counts[word] = +m[1];
		}
		ch.routes = counts;
	}
}

// Converts the raw strings of a parsed BGP section into typed values: timers become { left, total },
// AS numbers numbers, and tx_pending the leading number of its text.
function finish_bgp(bgp) {
	bgp.hold_timer = parse_timer(bgp.hold_timer);
	bgp.keepalive_timer = parse_timer(bgp.keepalive_timer);
	bgp.send_hold_timer = parse_timer(bgp.send_hold_timer);
	bgp.connect_delay = parse_timer(bgp.connect_delay);
	bgp.neighbor_as = number_or_null(bgp.neighbor_as);
	bgp.local_as = number_or_null(bgp.local_as);
	bgp.tx_pending = number_or_null(match(bgp.tx_pending ?? '', /^[0-9]+/)?.[0]);
}

// Parses `birdc show protocols all` into [{ name, proto, table, state, since, info, channels: [...], bgp }].
// The output is indentation based: column 0 is the protocol summary line, 2 spaces a protocol attribute
// or "Channel <afi>", and deeper levels are BGP capabilities and channel statistics. `mode` records which
// block the deeper lines belong to.
function parse_protocols(text) {
	let protos = [];
	// p: current protocol, ch: current channel, caps/cap: BGP capability list and entry being filled.
	let p = null, ch = null, caps = null, cap = null, mode = null;

	for (let line in split(text, '\n')) {
		if (trim(line) == '')
			continue;

		let indent = 0;
		while (ord(line, indent) == 32)
			indent++;
		let body = trim(substr(line, indent));

		if (indent == 0) {
			let m = match(line, /^([A-Za-z0-9_.-]+)[ ]+([A-Za-z0-9]+)[ ]+([^ ]+)[ ]+([^ ]+)[ ]+([^ ]+)[ ]*(.*)$/);
			// Summary columns: Name Proto Table State Since Info; the header and banner lines are skipped.
			if (!m || m[1] == 'Name' || m[1] == 'BIRD')
				continue;
			let since = m[5], info = trim(m[6]);
			// A long time format puts the clock time in the next column.
			let t = match(info, /^([0-9]{2}:[0-9:.]+)[ ]*(.*)$/);
			if (match(since, /^[0-9]{4}-/) && t) {
				since += ' ' + t[1];
				info = trim(t[2]);
			}
			p = { name: m[1], proto: m[2], table: m[3] == '---' ? null : m[3], state: m[4], since, info, channels: [] };
			push(protos, p);
			ch = caps = cap = mode = null;
			continue;
		}
		if (!p)
			continue;

		if (indent == 2) {
			let m = match(body, /^Channel (.+)$/);
			if (m) {
				ch = { afi: trim(m[1]), stats: {} };
				push(p.channels, ch);
				mode = 'channel';
				continue;
			}
			m = match(body, /^([^:]+):[ ]*(.*)$/);
			if (!m)
				continue;
			let k = key_of(m[1]);
			if (k == 'bgp_state') {
				p.bgp = { state: trim(m[2]) };
				mode = 'bgp';
			}
			else {
				p[k] = trim(m[2]);
				mode = null;
			}
			continue;
		}

		if (mode == 'bgp') {
			if (indent == 4) {
				let c = match(body, /^(Local|Neighbor) capabilities$/);
				if (c) {
					caps = [];
					p.bgp[lc(c[1]) + '_caps'] = caps;
					cap = null;
					continue;
				}
				let m = match(body, /^([^:]+):[ ]*(.*)$/);
				if (m) {
					p.bgp[key_of(m[1])] = trim(m[2]);
					caps = cap = null;
				}
			}
			else if (caps && indent == 6) {
				cap = { name: body, details: {} };
				push(caps, cap);
			}
			else if (cap && indent >= 8) {
				let m = match(body, /^([^:]+):[ ]*(.*)$/);
				if (m)
					cap.details[key_of(m[1])] = trim(m[2]);
			}
		}
		else if (mode == 'channel' && ch) {
			let m = match(body, /^([^:]+):[ ]*(.*)$/);
			if (!m)
				continue;
			let k = key_of(m[1]);
			if (indent == 4 && k != 'route_change_stats')
				ch[k] = trim(m[2]);
			else if (indent >= 6 && match(k, /^(import|export)_(updates|withdraws)$/))
				ch.stats[k] = parse_stats_row(m[2]);
		}
	}

	for (let proto in protos) {
		for (let c in proto.channels)
			finish_channel(c);
		if (proto.bgp)
			finish_bgp(proto.bgp);
	}
	return protos;
}
//#endregion

//#region birdc show route all

// Parse the first line of a route entry (prefix may be omitted for additional paths of a prefix).
// Returns the route skeleton { prefix, type, protocol, since, best, preference, origin_as, nexthops,
// attrs }, or null when the line is not a route head. Format: "<prefix> unicast [peer since] * (pref) [ASnnni]".
function parse_route_head(line, last_prefix) {
	let m = match(line, /^([^ ]*)[ ]+(unicast|blackhole|unreachable|prohibit|multicast)[ ]+/);
	if (!m)
		return null;

	let rest = substr(line, length(m[0]));
	let end = index(rest, ']');
	if (ord(rest, 0) != 91 || end < 0)
		return null;

	let src = split(substr(rest, 1, end - 1), ' ', 2);
	let after = substr(rest, end + 1);
	// "*" marks the best path; the number in parentheses is the route preference.
	let flags = match(after, /^[ ]*(\*?)[ ]*\(([0-9]+)/);
	let summary = match(after, /\[(AS[0-9]+)([ie?])\]/);

	return {
		prefix: m[1] != '' ? m[1] : last_prefix,
		type: m[2],
		protocol: src[0],
		since: trim(src[1] ?? ''),
		best: flags ? flags[1] == '*' : false,
		preference: flags ? +flags[2] : null,
		origin_as: summary ? summary[1] : null,
		nexthops: [],
		attrs: {},
	};
}

// Derives the BGP-specific fields of a parsed route from its attribute lines (AS path, communities, MED,
// ...). Non-BGP routes only get source and from.
function finish_route(r) {
	let a = r.attrs;
	r.source = a.source;
	r.from = a.from;
	r.is_bgp = a.source == 'BGP';
	if (!r.is_bgp)
		return;

	r.as_path = a.bgp_path != null && a.bgp_path != '' ? split(a.bgp_path, ' ') : [];
	r.origin = a.bgp_origin;
	r.next_hop = a.bgp_next_hop;
	r.local_pref = number_or_null(a.bgp_local_pref);
	r.med = number_or_null(a.bgp_med);
	r.communities = groups(a.bgp_community);
	r.large_communities = groups(a.bgp_large_community);
	r.ext_communities = groups(a.bgp_ext_community);
	r.aggregator = a.bgp_aggregator;
	r.atomic_aggregate = a.bgp_atomic_aggr != null;
}

// Parses `birdc show route all` (or `show route export <peer>`) into a list of routes, one per path.
// Unindented lines start a route, tab-indented lines are its next hops ("via X on dev") and attributes
// ("bgp_path: ...").
function parse_routes(text) {
	let routes = [];
	let cur = null;
	let last_prefix = null;
	let table = null;

	for (let line in split(text, '\n')) {
		let t = match(line, /^Table (.+):$/);
		if (t) {
			table = t[1];
			last_prefix = null;
			continue;
		}
		if (trim(line) == '' || match(line, /^BIRD /))
			continue;

		if (ord(line, 0) == 9) {
			if (!cur)
				continue;
			let body = substr(line, 1);
			let m;
			if ((m = match(body, /^via ([^ ]+) on ([^ ]+)/)))
				push(cur.nexthops, { via: m[1], dev: m[2] });
			else if ((m = match(body, /^dev ([^ ]+)/)))
				push(cur.nexthops, { via: null, dev: m[1] });
			else if ((m = match(body, /^([a-z_0-9]+): (.*)$/)))
				cur.attrs[m[1]] = trim(m[2]);
			continue;
		}

		let head = parse_route_head(line, last_prefix);
		if (!head)
			continue;
		if (cur)
			finish_route(cur);
		cur = head;
		cur.table = table;
		last_prefix = head.prefix;
		push(routes, cur);
	}
	if (cur)
		finish_route(cur);
	return routes;
}
//#endregion

//#region kernel routes

// Prefix -> { kind, nexthops: [{ via, dev }] } as installed by BIRD's kernel protocol, IPv4 and IPv6.
// Parsed from `ip -4/-6 route show proto bird`; "default" is expanded to 0.0.0.0/0 or ::/0 and a bare
// address gets a host mask so the keys match birdc's prefixes. `kind` is set for blackhole-style routes.
function kernel_routes() {
	let table = {};
	// Prefix of the route being read, so indented ECMP "nexthop via ..." lines attach to it.
	let cur = null;

	for (let family in [4, 6]) {
		let host = family == 4 ? '/32' : '/128';
		let any = family == 4 ? '0.0.0.0/0' : '::/0';

		for (let line in split(source('ip' + family, `ip -${family} route show proto bird 2>/dev/null`), '\n')) {
			if (trim(line) == '')
				continue;
			let tok = split(trim(line), /[ ]+/);

			if (ord(line, 0) == 9 || ord(line, 0) == 32) {
				let m = match(trim(line), /^nexthop via ([^ ]+) dev ([^ ]+)/);
				if (m && cur)
					push(table[cur].nexthops, { via: m[1], dev: m[2] });
				continue;
			}

			let first = tok[0];
			let kind = null;
			if (first == 'blackhole' || first == 'unreachable' || first == 'prohibit') {
				kind = first;
				tok = slice(tok, 1);
				first = tok[0];
			}
			cur = first == 'default' ? any : (index(first, '/') < 0 ? first + host : first);
			table[cur] = { kind, nexthops: [] };

			let via = index(tok, 'via'), dev = index(tok, 'dev');
			if (dev >= 0)
				push(table[cur].nexthops, { via: via >= 0 ? tok[via + 1] : null, dev: tok[dev + 1] });
		}
	}
	return table;
}
//#endregion

//#region assembly

// JSON view of one BGP path: the route's attributes plus whether the kernel has a next hop for it
// (`kernel` is the kernel_routes() table).
function path_view(r, kernel) {
	let k = kernel[r.prefix];
	let via = r.next_hop ?? r.nexthops[0]?.via;
	// An IPv6 BGP next hop may list a global and a link-local address; the kernel uses either one.
	let candidates = [...split(trim(via ?? ''), /[ ]+/), ...map(r.nexthops, (n) => n.via)];
	let installed = false;
	for (let n in k?.nexthops ?? [])
		if (n.via != null && index(candidates, n.via) >= 0)
			installed = true;

	return {
		prefix: r.prefix, table: r.table, peer: r.protocol, best: r.best, preference: r.preference,
		local_pref: r.local_pref, med: r.med, as_path: r.as_path, origin: r.origin, origin_as: r.origin_as,
		next_hop: via, dev: r.nexthops[0]?.dev, communities: r.communities, large_communities: r.large_communities,
		ext_communities: r.ext_communities, aggregator: r.aggregator, since: r.since,
		in_kernel: installed, kernel_paths: length(k?.nexthops ?? []),
	};
}

// JSON view of a route that BIRD did not learn through BGP (static, direct, ...).
function local_view(r, kernel) {
	return {
		prefix: r.prefix, protocol: r.protocol, kind: r.type, source: r.source, preference: r.preference,
		best: r.best, dev: r.nexthops[0]?.dev, since: r.since, in_kernel: kernel[r.prefix] != null,
	};
}

// JSON view of one BGP peer: session state and timers, negotiated capabilities, the carrying interface
// and the routes this router exports to it (`exports` is keyed by protocol name).
function peer_view(p, exports, interfaces) {
	let bgp = p.bgp ?? {};
	let neighbor = bgp.neighbor_address;
	let iface = interfaces[neighbor];

	return {
		name: p.name, description: p.description, state: bgp.state ?? p.info, protocol_state: p.state, info: p.info,
		since: p.since, neighbor, neighbor_as: bgp.neighbor_as, local_as: bgp.local_as, router_id: bgp.neighbor_id,
		session: bgp.session, source_address: bgp.source_address, iface,
		hold_timer: bgp.hold_timer, keepalive_timer: bgp.keepalive_timer, send_hold_timer: bgp.send_hold_timer,
		tx_pending: bgp.tx_pending, last_error: bgp.last_error, connect_delay: bgp.connect_delay,
		local_caps: bgp.local_caps ?? [], neighbor_caps: bgp.neighbor_caps ?? [],
		channels: p.channels,
		exported: map(exports[p.name] ?? [], (r) => ({ prefix: r.prefix, table: r.table, protocol: r.protocol, kind: r.type, preference: r.preference })),
	};
}

// Interface that carries each BGP neighbor, taken from BIRD's own routes (the peer host route or a "via").
function neighbor_interfaces(routes, neighbors) {
	let map = {};
	for (let r in routes) {
		let host = replace(r.prefix, /\/(32|128)$/, '');
		for (let n in r.nexthops) {
			if (n.via != null && neighbors[n.via] && !map[n.via])
				map[n.via] = n.dev;
			if (n.via == null && neighbors[host] && !map[host])
				map[host] = n.dev;
		}
	}
	return map;
}

// Plain-language health notes as [{ level: good|warn|bad|info, text }]: session states, kernel
// installation of best routes, single-peer prefixes, empty exports, import filtering and graceful restart.
function findings(peers, paths) {
	let out = [];
	// Shorthands that append a finding of the given level.
	let ok = (text) => push(out, { level: 'good', text });
	let warn = (text) => push(out, { level: 'warn', text });
	let bad = (text) => push(out, { level: 'bad', text });
	let info = (text) => push(out, { level: 'info', text });

	if (!length(peers))
		return [{ level: 'info', text: 'No BGP protocols are configured in BIRD.' }];

	let down = filter(peers, (p) => p.state != 'Established');
	if (length(down))
		for (let p in down)
			bad(`${p.name} is ${p.state}${p.last_error ? ' (' + p.last_error + ')' : ''}; its routes are unavailable.`);
	else
		ok(`All ${length(peers)} BGP sessions are Established.`);

	// Per prefix: which peers offer it and whether the best path made it into the kernel.
	let by_prefix = {};
	for (let r in paths) {
		by_prefix[r.prefix] ??= { peers: {}, best_in_kernel: false, has_best: false };
		by_prefix[r.prefix].peers[r.peer] = true;
		if (r.best) {
			by_prefix[r.prefix].has_best = true;
			by_prefix[r.prefix].best_in_kernel = r.in_kernel;
		}
	}

	let single = [], missing = [];
	for (let prefix, v in by_prefix) {
		if (length(keys(v.peers)) < 2)
			push(single, prefix);
		if (v.has_best && !v.best_in_kernel)
			push(missing, prefix);
	}
	if (length(missing))
		bad(`${length(missing)} best BGP route(s) are not installed in the kernel: ${join(', ', slice(missing, 0, 5))}.`);
	else if (length(paths))
		ok('Every best BGP route is installed in the kernel routing table.');
	if (length(single))
		warn(`${length(single)} prefix(es) are learned from a single peer only (no redundancy): ${join(', ', slice(single, 0, 5))}${length(single) > 5 ? ', …' : ''}.`);
	else if (length(paths))
		ok('Every learned prefix is reachable through at least two peers.');

	for (let p in peers) {
		if (p.state != 'Established')
			continue;
		if (!length(p.exported))
			warn(`${p.name} is not receiving any announcement from this router.`);
		let dropped = 0;
		for (let ch in p.channels)
			dropped += (ch.stats?.import_updates?.filtered ?? 0) + (ch.stats?.import_updates?.rejected ?? 0);
		if (dropped > 0)
			info(`${p.name}: the import filter dropped ${dropped} received route(s).`);
		let local_gr = filter(p.local_caps, (c) => c.name == 'Graceful restart');
		let remote_gr = filter(p.neighbor_caps, (c) => c.name == 'Graceful restart');
		if (length(local_gr) && !length(remote_gr))
			warn(`${p.name}: graceful restart is configured here but the neighbor did not negotiate it.`);
	}
	return out;
}

// Builds the flab.bgp status reply. When birdc cannot reach the daemon it returns the same shape with
// daemon.running false and empty lists, so the page can show a "BIRD is down" state.
function collect() {
	let status_text = birdc('show status');
	if (match(status_text, /Unable to connect|No such file|not found/))
		return { generated: time(), daemon: { running: false, error: trim(replace(status_text, /\n.*/g, '')) }, peers: [], paths: [], local: [], protocols: [], memory: [], findings: [] };

	let status = parse_status(status_text);
	let protocols = parse_protocols(birdc('show protocols all'));
	let routes = parse_routes(birdc('show route all'));
	let kernel = kernel_routes();

	let bgp_protos = filter(protocols, (p) => p.proto == 'BGP');
	let neighbors = {};
	let exports = {};
	for (let p in bgp_protos) {
		if (p.bgp?.neighbor_address)
			neighbors[p.bgp.neighbor_address] = true;
		if (safe_name(p.name))
			exports[p.name] = parse_routes(birdc('show route export ' + p.name));
	}
	let interfaces = neighbor_interfaces(routes, neighbors);

	let paths = map(filter(routes, (r) => r.is_bgp), (r) => path_view(r, kernel));
	let local = map(filter(routes, (r) => !r.is_bgp), (r) => local_view(r, kernel));
	let peers = map(bgp_protos, (p) => peer_view(p, exports, interfaces));

	let uptime = status.started != null && status.now != null ? status.now - status.started : 0;
	let prefixes = {};
	for (let r in routes)
		prefixes[r.prefix] = true;

	return {
		generated: time(),
		daemon: { running: true, ...status, uptime, routes: length(routes), prefixes: length(keys(prefixes)) },
		peers, paths, local,
		protocols: map(protocols, (p) => ({
			name: p.name, proto: p.proto, table: p.table, state: p.state, since: p.since, info: p.info,
			channels: map(p.channels, (c) => ({ afi: c.afi, table: c.table, state: c.state, import_state: c.import_state, export_state: c.export_state,
				preference: num(c.preference), input_filter: c.input_filter, output_filter: c.output_filter, routes: c.routes, stats: c.stats })),
		})),
		memory: parse_memory(birdc('show memory')),
		findings: findings(peers, paths),
	};
}
//#endregion

// rpcd registration: ubus object flab.bgp with the single method `status` (no arguments).
return deferred({
	'flab.bgp': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
});
