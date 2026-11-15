#!/usr/bin/ucode
//
// rpcd ucode plugin with the state of the router's DNS resolver as JSON:
//   ubus call flab.dns status
//
// Two engines are understood and both may be present: Unbound (read through `unbound-control`, which talks to
// its local control socket) and dnsmasq (read through its ubus object `dnsmasq metrics` and its UCI section).
// The reply names the engine that answers on port 53, its version, uptime, listening sockets, counters,
// forwarders (the default ones and the conditional zones), the resolvers learned from the WAN, the configuration
// options that are set and whether DNSSEC validation is available and on.
//
// Read-only: the plugin never writes anything (the page changes settings through rpcd's own `uci` object). `status` takes no arguments (anything sent is ignored), so no value from a request ever reaches
// a shell; every command below is a fixed string. A command that fails or prints nothing leaves its part of the
// reply null and adds a warning, it never fails the call.

'use strict';
import { deferred } from 'flab.worker';

import { connect } from 'ubus';
import { run, sysfs_raw, ubus_call, uci_all, num } from 'flab.util';

// Forwarders, listening sockets and values of one list option returned at most.
const MAX_FORWARDS = 500;
const MAX_LISTENERS = 50;
const MAX_LIST = 50;
const MAX_PRIVATE = 500;
// The generated Unbound configuration (the forward-zone clauses of UCI and of the user's extension file).
const UNBOUND_CONFS = ['/var/lib/unbound/unbound.conf', '/var/lib/unbound/unbound_ext.conf'];
// The user's own options for the server clause (private-domain, domain-insecure, local-data, ...), copied there at start.
const UNBOUND_SRV = '/var/lib/unbound/unbound_srv.conf';
// The resolvers netifd learned from the WAN (DHCP, PPP, RA), and the default lease file of dnsmasq.
const RESOLV_AUTO = '/tmp/resolv.conf.d/resolv.conf.auto';
const LEASES = '/tmp/dhcp.leases';
// The UCI options of each engine that are reported (only the ones that are set), in display order.
const UNBOUND_OPTIONS = ['enabled', 'listen_port', 'validator', 'validator_ntp', 'domain_insecure', 'root_age', 'rebind_protection', 'rebind_localhost',
	'dns64', 'dns64_prefix', 'domain', 'domain_type', 'dhcp_link', 'dhcp4_slaac6', 'add_extra_dns', 'add_local_fqdn', 'add_wan_fqdn', 'exclude_ipv6_ga',
	'hide_binddata', 'interface_auto', 'extended_stats', 'unbound_control', 'num_threads', 'rate_limit', 'ttl_min', 'ttl_neg_max', 'edns_size',
	'protocol', 'query_minimize', 'query_min_strict', 'recursion', 'resource', 'localservice', 'iface_lan', 'iface_wan', 'iface_trig', 'manual_conf',
	'verbosity'];
const DNSMASQ_OPTIONS = ['domain', 'port', 'cachesize', 'min_cache_ttl', 'max_cache_ttl', 'rebind_protection', 'rebind_domain', 'localise_queries',
	'domainneeded', 'local', 'noresolv', 'resolvfile', 'strictorder', 'allservers', 'dnssec', 'logqueries', 'localservice', 'ednspacket_max',
	'dnsforwardmax', 'authoritative', 'readethers', 'leasefile', 'interface', 'expandhosts', 'boguspriv', 'filterwin2k', 'sequential_ip', 'rapidcommit'];
// The options of a UCI zone section that are reported, besides its type, name, servers and `enabled`.
const ZONE_OPTIONS = ['tls_upstream', 'tls_index', 'tls_port', 'port', 'fallback', 'dns_assist', 'resolv_conf', 'url_dir'];
// What the engines do when an option is not set (only the defaults that are certain).
const UNBOUND_DEFAULTS = { listen_port: '53', extended_stats: '0', unbound_control: '0', edns_size: '1232', rate_limit: '0', dns64: '0' };
const DNSMASQ_DEFAULTS = { port: '53', cachesize: '150', rebind_protection: '1', localservice: '1' };

//#region Text helpers

// The non-empty lines of a command's output (null counts as empty).
function text_lines(text) {
	return filter(split(trim(text ?? ''), '\n'), l => trim(l) != '');
}

// An address as `ip` and the resolvers print it, without a zone id ("fe80::1%eth0").
function bare_address(a) {
	return replace(a, /%.*$/, '');
}

// A zone name the way the page shows it: lowercase, no trailing dot, "." kept for the root (the default forwarders).
function norm_zone(z) {
	z = lc(trim(z));
	if (z == '' || z == '.')
		return '.';
	return replace(z, /\.$/, '');
}

// Round to one decimal.
function round1(x) {
	return int(x * 10 + 0.5) / 10.0;
}

// The first value of a UCI option that may be a list.
function first_of(v) {
	return type(v) == 'array' ? v[0] : v;
}

//#endregion

//#region Processes and sockets

// The pid and state of one procd service, from the reply of `ubus call service list`: { running, pid, instance }.
function service_state(services, name) {
	let out = { running: false, pid: null, instance: null };
	let instances = services?.[name]?.instances ?? {};
	for (let iname, inst in instances) {
		if (inst?.running && out.instance == null) {
			out.running = true;
			out.pid = type(inst.pid) == 'int' ? inst.pid : null;
			out.instance = iname;
		}
	}
	return out;
}

// The smallest pid in the output of `pidof`, or null (the parent of a jailed dnsmasq has the smallest).
function lowest_pid(text) {
	let best = null;
	for (let w in split(trim(text ?? ''), /[[:space:]]+/)) {
		if (!match(w, /^[0-9]+$/))
			continue;
		if (best == null || +w < best)
			best = +w;
	}
	return best;
}

// Seconds a process has been running: field 22 of /proc/<pid>/stat (clock ticks since boot, 100 a second)
// against /proc/uptime. Null when either cannot be read.
function process_age(pid) {
	if (type(pid) != 'int' || pid < 1)
		return null;
	let stat = sysfs_raw(`/proc/${pid}/stat`);
	let up = sysfs_raw('/proc/uptime');
	if (!stat || !up)
		return null;
	// The command name sits in parentheses and may hold spaces, so the fields are counted after the last ")".
	let rest = split(trim(substr(stat, rindex(stat, ')') + 1)), /[[:space:]]+/);
	if (length(rest) < 20)
		return null;
	let start = +rest[19];
	let now = +split(trim(up), /[[:space:]]+/)[0];
	if (!(start >= 0) || !(now > 0))
		return null;
	let age = int(now - start / 100.0);
	return age < 0 ? 0 : age;
}

// The listening sockets of `netstat -lntup` as [{ proto, addr, port, program }]. The local address is split at its
// last colon, so "::" is the IPv6 wildcard (":::53") and an IPv6 address keeps its own colons.
function parse_netstat(text) {
	let out = [];
	for (let line in text_lines(text)) {
		let m = match(trim(line), /^(tcp|udp)6?[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+([^[:space:]]+)[[:space:]]+[^[:space:]]+[[:space:]]*(LISTEN)?[[:space:]]*([0-9]+\/[^[:space:]]+)?/);
		if (!m)
			continue;
		let ci = rindex(m[2], ':');
		if (ci < 0)
			continue;
		let prog = m[4] ? split(m[4], '/')[1] : null;
		push(out, { proto: m[1], addr: substr(m[2], 0, ci), port: +substr(m[2], ci + 1), program: prog });
	}
	return out;
}

//#endregion

//#region UCI

// The first section of a UCI config whose type is `type`, or {}. A name in `prefer` wins when several exist.
function find_section(all, type_name, prefer) {
	let found = null;
	for (let name, sec in all) {
		if (sec?.['.type'] != type_name)
			continue;
		if (found == null || name == prefer)
			found = sec;
	}
	return found ?? {};
}

// The listed options of a UCI section that are set. A list option keeps at most MAX_LIST values.
function pick_options(section, names) {
	let out = {};
	for (let k in names) {
		let v = section[k];
		if (v == null)
			continue;
		out[k] = type(v) == 'array' ? slice(v, 0, MAX_LIST) : v;
	}
	return out;
}

//#endregion

//#region Unbound

// `unbound-control status` as { version, uptime, threads, modules, validator }, or null when it printed no version
// (control disabled, no socket, unbound-control missing).
function parse_unbound_status(text) {
	let st = {};
	for (let line in text_lines(text)) {
		let m = match(line, /^([a-z]+): (.*)$/);
		if (m)
			st[m[1]] = m[2];
	}
	if (st.version == null)
		return null;
	let up = match(st.uptime ?? '', /^([0-9]+)/);
	return {
		version: st.version, uptime: up ? +up[1] : null, threads: num(st.threads), modules: st.modules ?? '',
		validator: match(st.modules ?? '', /[[:space:]]validator[[:space:]]/) != null,
	};
}

// `key=value` lines (unbound-control stats_noreset) as an object, or null when there are none.
function parse_key_values(text) {
	let st = {};
	for (let line in text_lines(text)) {
		let i = index(line, '=');
		if (i > 0)
			st[substr(line, 0, i)] = substr(line, i + 1);
	}
	return length(st) ? st : null;
}

// The normalized counters of Unbound from its statistics (total.* is the sum of the threads). A key the statistics do
// not have (the extended ones are off by default) stays null.
function unbound_stats(st) {
	let rcodes = {};
	for (let k, v in st) {
		let m = match(k, /^num\.answer\.rcode\.([A-Za-z0-9]+)$/);
		if (m && m[1] != 'nodata')
			rcodes[m[1]] = +v;
	}
	let replies = num(st['total.num.recursivereplies']);
	let avg = num(st['total.recursion.time.avg']);
	let median = num(st['total.recursion.time.median']);
	let up = num(st['time.up']);
	let mem = num(st['mem.cache.message']);
	let mem_rr = num(st['mem.cache.rrset']);
	return {
		queries: num(st['total.num.queries']), cache_hits: num(st['total.num.cachehits']), cache_misses: num(st['total.num.cachemiss']),
		prefetch: num(st['total.num.prefetch']), expired: num(st['total.num.expired']), ratelimited: num(st['total.num.queries_ip_ratelimited']),
		timed_out: num(st['total.num.queries_timed_out']),
		// With no recursive reply yet the averages are meaningless zeros.
		recursion_avg_ms: (avg == null || !replies) ? null : round1(avg * 1000),
		recursion_median_ms: (median == null || !replies) ? null : round1(median * 1000),
		rcodes, secure: num(st['num.answer.secure']), bogus: num(st['num.answer.bogus']),
		unwanted_queries: num(st['unwanted.queries']), unwanted_replies: num(st['unwanted.replies']),
		cache_msgs: num(st['msg.cache.count']), cache_rrsets: num(st['rrset.cache.count']),
		cache_bytes: (mem == null && mem_rr == null) ? null : (mem ?? 0) + (mem_rr ?? 0),
		since: up == null ? null : int(up),
	};
}

// The forward zones of `unbound-control list_forwards` ("zone. IN forward [+flags] addr addr ..."). Flags are the single
// letters after the "+" ("i": DNSSEC is not validated for the zone). Root hints (`stub`) lines are not forwarders.
function parse_unbound_forwards(text) {
	let rows = [];
	for (let line in text_lines(text)) {
		let m = match(line, /^([^[:space:]]+)[[:space:]]+IN[[:space:]]+forward[[:space:]]*(.*)$/);
		if (!m)
			continue;
		let servers = [], flags = [];
		for (let w in split(trim(m[2]), /[[:space:]]+/)) {
			if (w == '')
				continue;
			if (substr(w, 0, 1) == '+') {
				for (let c in split(substr(w, 1), ''))
					push(flags, c);
			} else {
				push(servers, w);
			}
		}
		push(rows, { zone: norm_zone(m[1]), servers, flags, tls: null });
	}
	return rows;
}

// The forward-zone clauses of Unbound's generated configuration as [{ zone, servers, tls }]. The addresses lose their
// "@port#name" suffix; a clause without `forward-tls-upstream: yes` is clear text.
function parse_forward_blocks(text) {
	let rows = [], cur = null;
	for (let line in text_lines(text)) {
		let t = trim(line);
		if (substr(t, 0, 1) == '#')
			continue;
		if (match(t, /^forward-zone:/)) {
			cur = { zone: '.', servers: [], tls: false };
			push(rows, cur);
			continue;
		}
		// Any other clause header (server:, remote-control:, ...) ends the forward-zone.
		if (match(t, /^[a-z0-9-]+:[[:space:]]*$/)) {
			cur = null;
			continue;
		}
		if (!cur)
			continue;
		let m = match(t, /^name:[[:space:]]*"?([^"[:space:]]+)"?/);
		if (m) {
			cur.zone = norm_zone(m[1]);
			continue;
		}
		if ((m = match(t, /^forward-addr:[[:space:]]*"?([^"[:space:]]+)"?/))) {
			push(cur.servers, replace(m[1], /[@#].*$/, ''));
			continue;
		}
		if ((m = match(t, /^forward-tls-upstream:[[:space:]]*(yes|no)/)))
			cur.tls = m[1] == 'yes';
	}
	return rows;
}

// How many distinct names `unbound-control list_local_data` holds (reverse-lookup names under arpa. are not counted).
function count_local_names(text) {
	let names = {};
	for (let line in text_lines(text)) {
		let owner = split(trim(line), /[[:space:]]+/)[0];
		if (owner && !match(owner, /arpa\.?$/))
			names[lc(owner)] = true;
	}
	return length(keys(names));
}

// The `private-domain:` names of a configuration text, lowercase without quotes or a trailing dot: the domains whose answers may
// point to private addresses although rebind protection is on.
function parse_private_domains(text) {
	let names = [];
	for (let line in text_lines(text)) {
		let m = match(trim(line), /^private-domain:[[:space:]]*"?([^"[:space:]]+)"?/);
		if (m)
			push(names, norm_zone(m[1]));
	}
	return names;
}

// Everything the page shows about Unbound. `info` is { installed, running }, `section` the UCI section.
function collect_unbound(info, section, warnings) {
	let out = { version: null, uptime: null, control: null, stats: null, forwards: [], local_names: null, validating: null, private_domains: [] };
	// The rebind-protection exceptions: those UCI generates (the local domain), then those the user lists in the srv file,
	// each name once.
	let seen = {};
	for (let spec in [ [ UNBOUND_CONFS[0], 'uci' ], [ UNBOUND_SRV, 'file' ] ])
		for (let n in parse_private_domains(sysfs_raw(spec[0])))
			if (!seen[n]) {
				seen[n] = true;
				push(out.private_domains, { name: n, source: spec[1] });
			}
	let blocks = [];
	for (let path in UNBOUND_CONFS)
		for (let b in parse_forward_blocks(sysfs_raw(path)))
			push(blocks, b);
	let st = null;
	if (info.running) {
		st = parse_unbound_status(run('unbound-control status 2>/dev/null'));
		out.control = st != null;
	}
	if (st) {
		out.version = st.version;
		out.uptime = st.uptime;
		out.validating = st.validator;
		out.stats = null;
		let raw = parse_key_values(run('unbound-control stats_noreset 2>/dev/null'));
		if (raw)
			out.stats = unbound_stats(raw);
		else
			push(warnings, 'unbound-control returned no statistics.');
		out.forwards = parse_unbound_forwards(run('unbound-control list_forwards 2>/dev/null'));
		out.local_names = count_local_names(run('unbound-control list_local_data 2>/dev/null'));
		// unbound-control does not say which forwarders use TLS; the generated configuration does.
		let tls = {};
		for (let b in blocks)
			tls[b.zone] = b.tls;
		for (let f in out.forwards)
			if (length(blocks))
				f.tls = tls[f.zone] ?? null;
	} else {
		if (info.running)
			push(warnings, "unbound-control is not enabled, so statistics, forwarders and local names are not available. Set option unbound_control '1' in /etc/config/unbound and restart unbound.");
		// Without the control channel the forwarders come from the generated configuration.
		for (let b in blocks)
			push(out.forwards, { zone: b.zone, servers: b.servers, flags: [], tls: b.tls });
		if (info.installed) {
			let ver = match(run('unbound -V 2>/dev/null'), /^Version ([^[:space:]]+)/);
			out.version = ver ? ver[1] : null;
		}
		if (info.running)
			out.validating = section.validator == null ? null : section.validator == '1';
	}
	return out;
}

//#endregion

//#region dnsmasq

// The version and whether the build has DNSSEC from `dnsmasq --version`: { version, dnssec }, or nulls.
function parse_dnsmasq_version(text) {
	let out = { version: null, dnssec: null };
	for (let line in text_lines(text)) {
		let m = match(line, /^Dnsmasq version ([^[:space:]]+)/i);
		if (m)
			out.version = m[1];
		if ((m = match(line, /^Compile time options:(.*)$/)))
			out.dnssec = ('DNSSEC' in split(trim(m[1]), /[[:space:]]+/));
	}
	return out;
}

// The `server` list of the dnsmasq section as forward zones: "/a/b/1.2.3.4" sends zones a and b to 1.2.3.4, "/a/" answers
// a locally only, "/a/#" uses the default servers for a, and a plain address is a default forwarder (zone ".").
function parse_dnsmasq_servers(list) {
	let rows = [], by_zone = {};
	for (let item in list) {
		let s = trim(item);
		if (s == '')
			continue;
		let zones = ['.'], server = s, flags = [];
		if (substr(s, 0, 1) == '/') {
			let parts = split(s, '/');
			server = trim(parts[length(parts) - 1]);
			zones = map(filter(slice(parts, 1, length(parts) - 1), z => z != ''), z => norm_zone(replace(z, /^\*?\./, '')));
			if (!length(zones))
				zones = ['.'];
			if (server == '')
				push(flags, 'local-only');
			else if (server == '#') {
				push(flags, 'default-servers');
				server = '';
			}
		}
		for (let z in zones) {
			if (!by_zone[z]) {
				by_zone[z] = { zone: z, servers: [], flags: [], tls: null };
				push(rows, by_zone[z]);
			}
			if (server != '' && !(server in by_zone[z].servers))
				push(by_zone[z].servers, server);
			for (let f in flags)
				if (!(f in by_zone[z].flags))
					push(by_zone[z].flags, f);
		}
	}
	// The default forwarders lead the list.
	let rest = [], lead = [];
	for (let r in rows)
		push(r.zone == '.' ? lead : rest, r);
	return [...lead, ...rest];
}

// The zones held in /etc/config/unbound (every `config zone` section, enabled or not, of any zone_type: forward_zone,
// stub_zone or auth_zone): the ones that can be changed through UCI, as [{ section, type, enabled, zones, servers, options }].
// The zones that only exist in the user's extension file (unbound_ext.conf) are not here.
function unbound_uci_zones(all) {
	let out = [];
	for (let name, sec in all) {
		if (sec?.['.type'] != 'zone')
			continue;
		let all_names = type(sec.zone_name) == 'array' ? sec.zone_name : (sec.zone_name != null ? [sec.zone_name] : []);
		let all_servers = type(sec.server) == 'array' ? sec.server : (sec.server != null ? [sec.server] : []);
		let names = slice(all_names, 0, MAX_FORWARDS);
		let servers = slice(all_servers, 0, MAX_LIST);
		let entry = { section: name, type: sec.zone_type ?? '', enabled: sec.enabled == '1', zones: map(names, z => norm_zone(z)), servers, options: pick_options(sec, ZONE_OPTIONS) };
		// A section whose lists were cut must not be written back from this copy: the page treats it as read only.
		if (length(all_names) > MAX_FORWARDS || length(all_servers) > MAX_LIST)
			entry.cut = true;
		push(out, entry);
	}
	return out;
}

// The `server` entries of the dnsmasq section as written, [{ index, value }]: each is a forwarder or a zone rule that can be
// changed through UCI. At most MAX_FORWARDS are listed; the caller says when the list was longer.
function dnsmasq_uci_servers(section) {
	let list = type(section.server) == 'array' ? section.server : (section.server != null ? [section.server] : []);
	let out = [];
	for (let i = 0; i < length(list) && i < MAX_FORWARDS; i++)
		push(out, { index: i, value: trim(list[i]) });
	return out;
}

// A counter of the ubus reply: a number as it is, anything else (a missing key) null. util's num() would turn the
// integer 0 into null, because ucode compares 0 == '' as equal.
function metric(v) {
	return (type(v) == 'int' || type(v) == 'double') ? v : null;
}

// The counters of `ubus call dnsmasq metrics` normalized. `cache_size` is what the configuration asks for.
function dnsmasq_stats(m, cache_size, since) {
	return {
		forwarded: metric(m.dns_queries_forwarded), local_answered: metric(m.dns_local_answered), auth_answered: metric(m.dns_auth_answered),
		stale_answered: metric(m.dns_stale_answered), unanswered: metric(m.dns_unanswered), cache_inserted: metric(m.dns_cache_inserted),
		cache_live_freed: metric(m.dns_cache_live_freed), cache_size, since,
	};
}

// How many distinct names dnsmasq serves locally: the host files in /tmp/hosts and the named DHCP leases.
function dnsmasq_local_names(leasefile) {
	let names = {};
	for (let f in text_lines(run('ls /tmp/hosts 2>/dev/null'))) {
		f = trim(f);
		// The names come from the router's own directory listing; only plain file names are opened.
		if (!match(f, /^[A-Za-z0-9._-]+$/))
			continue;
		for (let line in text_lines(sysfs_raw(`/tmp/hosts/${f}`))) {
			let fields = split(trim(replace(line, /#.*$/, '')), /[[:space:]]+/);
			for (let i = 1; i < length(fields); i++)
				if (fields[i] != '')
					names[lc(fields[i])] = true;
		}
	}
	let path = (type(leasefile) == 'string' && match(leasefile, /^\/[A-Za-z0-9._\/-]+$/) && !match(leasefile, /\.\./)) ? leasefile : LEASES;
	for (let line in text_lines(sysfs_raw(path))) {
		// "expiry mac address hostname client-id"; "*" is a lease without a name.
		let name = split(trim(line), /[[:space:]]+/)[3];
		if (name && name != '*')
			names[lc(name)] = true;
	}
	return length(keys(names));
}

// Everything the page shows about dnsmasq. `info` is { installed, running, pid }, `section` the UCI section.
function collect_dnsmasq(info, section, conn, warnings) {
	let out = { version: null, uptime: null, stats: null, forwards: [], local_names: null, dnssec_supported: null };
	if (info.installed) {
		let v = parse_dnsmasq_version(run('dnsmasq --version 2>/dev/null'));
		out.version = v.version;
		out.dnssec_supported = v.dnssec;
	}
	out.forwards = parse_dnsmasq_servers(type(section.server) == 'array' ? section.server : (section.server != null ? [section.server] : []));
	if (info.running) {
		out.uptime = process_age(info.pid);
		let metrics = ubus_call(conn, 'dnsmasq', 'metrics', {});
		if (metrics != null) {
			let size = num(section.cachesize);
			out.stats = dnsmasq_stats(metrics, size ?? +DNSMASQ_DEFAULTS.cachesize, out.uptime);
		} else
			push(warnings, 'dnsmasq reported no counters: its ubus object dnsmasq.metrics did not answer (dnsmasq must be built with UBus).');
		out.local_names = dnsmasq_local_names(first_of(section.leasefile));
	}
	return out;
}

//#endregion

//#region The reply

// The resolvers netifd learned from the WAN (/tmp/resolv.conf.d/resolv.conf.auto), without loopback addresses.
function wan_resolvers() {
	let out = [];
	for (let line in text_lines(sysfs_raw(RESOLV_AUTO))) {
		let m = match(trim(line), /^nameserver[[:space:]]+([^[:space:]]+)/);
		if (!m)
			continue;
		let a = bare_address(m[1]);
		if (match(a, /^127\./) || a == '::1')
			continue;
		if (!(a in out))
			push(out, a);
	}
	return out;
}

// The sockets that belong to the resolvers: Unbound's (but not its loopback control port 8953) and the DNS port of
// dnsmasq (not its DHCP and TFTP sockets). `ports` are the DNS ports the configurations name. A socket whose owner
// netstat could not tell is given to the engine configured on that port when only one is.
function resolver_sockets(all, ports) {
	let out = [], seen = {};
	for (let s in all) {
		let owner = s.program;
		if (owner != 'unbound' && owner != 'dnsmasq') {
			if (owner != null)
				continue;
			let cands = filter(['unbound', 'dnsmasq'], e => ports[e] == s.port);
			if (length(cands) != 1)
				continue;
			owner = cands[0];
		}
		if (owner == 'unbound' && s.proto == 'tcp' && s.port == 8953 && (s.addr == '127.0.0.1' || s.addr == '::1'))
			continue;
		if (owner == 'dnsmasq' && s.port != ports.dnsmasq)
			continue;
		let key = `${s.proto}|${s.addr}|${s.port}`;
		if (seen[key])
			continue;
		seen[key] = true;
		push(out, { addr: s.addr, port: s.port, proto: s.proto, engine: owner });
	}
	return out;
}

// The state of the router's DNS resolvers (see the header comment for the reply's shape).
function status() {
	let warnings = [];
	let conn = connect();
	let services = ubus_call(conn, 'service', 'list', {}) ?? {};

	let sec_ub_all = uci_all('unbound');
	let sec_ub = find_section(sec_ub_all, 'unbound', null);
	let sv_dm = service_state(services, 'dnsmasq');
	let sec_dm = find_section(uci_all('dhcp'), 'dnsmasq', sv_dm.instance);

	let engines = {};
	for (let name in ['unbound', 'dnsmasq']) {
		let sv = service_state(services, name);
		if (!sv.running) {
			let p = lowest_pid(name == 'unbound' ? run('pidof unbound 2>/dev/null') : run('pidof dnsmasq 2>/dev/null'));
			if (p != null) {
				sv.running = true;
				sv.pid = p;
			}
		}
		let present = trim(name == 'unbound' ? run('command -v unbound 2>/dev/null') : run('command -v dnsmasq 2>/dev/null')) != '';
		engines[name] = { installed: present || sv.running, running: sv.running, pid: sv.pid };
	}

	let ub = collect_unbound(engines.unbound, sec_ub, warnings);
	let dm = collect_dnsmasq(engines.dnsmasq, sec_dm, conn, warnings);
	let ports = { unbound: +(sec_ub.listen_port ?? UNBOUND_DEFAULTS.listen_port), dnsmasq: +(sec_dm.port ?? DNSMASQ_DEFAULTS.port) };

	let net = run('netstat -lntup 2>/dev/null');
	let sockets = resolver_sockets(parse_netstat(net), ports);
	if (trim(net) == '')
		push(warnings, 'The listening sockets could not be read.');
	for (let e in ['unbound', 'dnsmasq'])
		engines[e].listens53 = length(filter(sockets, s => s.engine == e && s.port == 53)) > 0;

	// The engine that answers: the one listening on port 53, else any that runs (Unbound first).
	let engine = null;
	if (engines.unbound.running && engines.unbound.listens53)
		engine = 'unbound';
	else if (engines.dnsmasq.running && engines.dnsmasq.listens53)
		engine = 'dnsmasq';
	else if (engines.unbound.running)
		engine = 'unbound';
	else if (engines.dnsmasq.running)
		engine = 'dnsmasq';

	// What the page describes: the running engine, else the installed one that is configured (dnsmasq unless Unbound is enabled).
	let configured = engine;
	if (configured == null) {
		if (engines.unbound.installed && (sec_ub.enabled == '1' || !engines.dnsmasq.installed))
			configured = 'unbound';
		else if (engines.dnsmasq.installed)
			configured = 'dnsmasq';
	}
	let detail = configured == 'unbound' ? ub : (configured == 'dnsmasq' ? dm : null);

	let forwards = detail?.forwards ?? [];
	let cut_forwards = length(forwards) > MAX_FORWARDS;
	if (cut_forwards)
		forwards = slice(forwards, 0, MAX_FORWARDS);

	// Where each forwarder is defined: in UCI (a zone section of Unbound, a `server` entry of dnsmasq), which can be changed
	// through UCI, or in a file (Unbound's extension file), which cannot.
	let uci_zones = configured == 'unbound' ? unbound_uci_zones(sec_ub_all) : [];
	let section_of = {};
	for (let z in uci_zones)
		if (z.enabled && z.type == 'forward_zone')
			for (let n in z.zones)
				section_of[n] = z.section;
	for (let f in forwards) {
		if (configured == 'dnsmasq')
			f.source = 'uci';
		else if (section_of[f.zone] != null) {
			f.source = 'uci';
			f.section = section_of[f.zone];
		} else
			f.source = 'file';
	}
	let private_domains = configured == 'unbound' ? ub.private_domains : [];
	let cut_private = length(private_domains) > MAX_PRIVATE;
	if (cut_private)
		private_domains = slice(private_domains, 0, MAX_PRIVATE);
	let forward_uci = configured == 'unbound' ? uci_zones : (configured == 'dnsmasq' ? dnsmasq_uci_servers(sec_dm) : []);
	let cut_forward_uci = configured == 'dnsmasq' && type(sec_dm.server) == 'array' && length(sec_dm.server) > MAX_FORWARDS;

	// The UCI section that holds the described engine's options, so a page can write them: Unbound's `unbound` section of
	// /etc/config/unbound, dnsmasq's section of /etc/config/dhcp. Null when the engine has no such section.
	let owner = configured == 'unbound' ? sec_ub : (configured == 'dnsmasq' ? sec_dm : null);
	let config_section = owner?.['.name'] != null ? { config: configured == 'unbound' ? 'unbound' : 'dhcp', name: owner['.name'] } : null;
	let cut_listeners = length(sockets) > MAX_LISTENERS;
	if (cut_listeners)
		sockets = slice(sockets, 0, MAX_LISTENERS);

	let config = configured == 'unbound' ? pick_options(sec_ub, UNBOUND_OPTIONS) : (configured == 'dnsmasq' ? pick_options(sec_dm, DNSMASQ_OPTIONS) : {});
	let upstream = wan_resolvers();

	let dnssec = { supported: null, enabled: null };
	if (configured == 'unbound') {
		dnssec.supported = true;
		dnssec.enabled = ub.validating ?? (config.validator == null ? null : config.validator == '1');
	} else if (configured == 'dnsmasq') {
		dnssec.supported = dm.dnssec_supported;
		dnssec.enabled = dm.dnssec_supported == false ? false : (config.dnssec == '1');
	}

	engines.unbound = { ...engines.unbound, version: ub.version, uptime: ub.uptime, port: ports.unbound, control: ub.control, stats: ub.stats };
	engines.dnsmasq = { ...engines.dnsmasq, version: dm.version, uptime: dm.uptime, port: ports.dnsmasq, stats: dm.stats };

	return {
		ok: true,
		generated: time(),
		engine,
		configured,
		engines,
		version: detail?.version,
		uptime: engine ? detail.uptime : null,
		listeners: sockets,
		stats: engine ? detail.stats : null,
		config,
		config_section,
		defaults: configured == 'unbound' ? UNBOUND_DEFAULTS : (configured == 'dnsmasq' ? DNSMASQ_DEFAULTS : {}),
		forwards,
		forward_uci,
		private_domains,
		upstream,
		// dnsmasq ignores the WAN resolvers when told not to read a resolv file; Unbound's use of them is not known here.
		upstream_used: configured == 'dnsmasq' ? (sec_dm.noresolv != '1') : null,
		local_names: engine ? detail.local_names : null,
		dnssec,
		truncated: { forwards: cut_forwards, listeners: cut_listeners, private_domains: cut_private, forward_uci: cut_forward_uci },
		warnings,
	};
}

//#endregion

// rpcd registration: ubus object flab.dns. `status` takes no arguments.
return deferred({
	'flab.dns': {
		status: {
			call: function(request) {
				return status();
			},
		},
	},
});
