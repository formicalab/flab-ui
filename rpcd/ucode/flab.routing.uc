#!/usr/bin/ucode
//
// rpcd ucode plugin with the kernel routing state as JSON:
//   ubus call flab.routing status
//   ubus call flab.routing lookup '{"dst":"1.1.1.1","src":"192.168.1.50","iif":"br-lan"}'
//
// `status` returns every route of every routing table (`ip route show table all`, both families), the policy
// rules (`ip rule show`), the table names of /etc/iproute2/rt_tables and whether BIRD is installed. `lookup`
// asks the kernel where a packet would go (`ip route get`, and `fibmatch` for the FIB entry that answered).
// Both are read-only. The text of `ip` is parsed; the arguments of `lookup` are validated before they reach
// the shell, so only an address and an interface name can ever be interpolated.

'use strict';

import { deferred } from 'flab.worker';
import { run, command_result, sysfs_raw, num, safe_ifname, uci_all } from 'flab.util';

// Route types `ip` prints in front of the prefix (a plain unicast route has no type word).
const TYPES = ['unicast', 'local', 'broadcast', 'multicast', 'anycast', 'blackhole', 'unreachable', 'prohibit', 'throw', 'nat', 'unspec', 'xresolve'];
// Words of a route line that stand alone (flags of a next hop).
const FLAGS = ['onlink', 'linkdown', 'dead', 'offload', 'trap', 'notify', 'pervasive', 'unresolved'];
// Words of a route line that are followed by their value.
const KEYS = ['via', 'dev', 'table', 'proto', 'scope', 'src', 'metric', 'from', 'expires', 'pref', 'mtu', 'weight', 'nhid', 'iif'];
// Words of a rule that are followed by a selector value.
const SELECTORS = ['from', 'to', 'iif', 'oif', 'fwmark', 'tos', 'dsfield', 'uidrange', 'ipproto', 'sport', 'dport', 'protocol'];
// Routes returned per address family; a router carrying a full routing table would otherwise send megabytes.
const MAX_ROUTES = 4000;

//#region Parsing

// The key/value pairs and flags of the words of a route line from index `i` on, as { flags, <key>: value }.
// Words that are neither (advmss, hoplimit, encap data, ...) are skipped.
function scan(t, i) {
	let o = { flags: [] };
	for (; i < length(t); i++) {
		let k = t[i];
		if (k in FLAGS) {
			push(o.flags, k);
			continue;
		}
		if (!(k in KEYS))
			continue;
		i++;
		let v = t[i];
		// "via inet6 fe80::1" (an IPv6 next hop of an IPv4 route) and "mtu lock 1500" carry one more word.
		if ((k == 'via' && (v == 'inet' || v == 'inet6')) || (k == 'mtu' && v == 'lock')) {
			i++;
			v = t[i];
		}
		o[k] = v;
	}
	return o;
}

// "address/length" for a route destination: "default" becomes the zero prefix, a host route gets /32 or /128.
function norm_prefix(dst, family) {
	if (dst == 'default')
		return family == 6 ? '::/0' : '0.0.0.0/0';
	return index(dst, '/') >= 0 ? dst : dst + (family == 6 ? '/128' : '/32');
}

// One next hop from the values `scan` found.
function hop(o) {
	return { via: o.via, dev: o.dev, weight: num(o.weight), flags: o.flags };
}

// One route from a line of `ip route show` (or the answer of `fibmatch`). A route with several next hops has
// no via/dev on its own line; the "nexthop" lines that follow add them (see parse_routes).
function parse_route(line, family) {
	let t = split(trim(line), /[ \t]+/);
	let type = 'unicast';
	if (t[0] in TYPES)
		type = shift(t);
	let prefix = norm_prefix(shift(t), family);
	let o = scan(t, 0);
	return {
		family, table: o.table ?? 'main', type, prefix, len: +split(prefix, '/')[1],
		from: o.from, proto: o.proto, scope: o.scope, metric: num(o.metric), src: o.src, pref: o.pref,
		expires: o.expires != null ? num(replace(o.expires, /sec$/, '')) : null,
		mtu: num(o.mtu), nhid: num(o.nhid), flags: o.flags,
		nexthops: (o.via != null || o.dev != null) ? [hop(o)] : [],
	};
}

// Appends the routes of the text of `ip route show` to `out`, at most `cap` of them. Returns true when more
// were present than fitted.
function parse_routes(text, family, out, cap) {
	let last = null;
	let before = length(out);
	let truncated = false;
	for (let line in split(text ?? '', '\n')) {
		if (trim(line) == '')
			continue;
		if (match(line, /^[ \t]+nexthop /)) {
			if (last)
				push(last.nexthops, hop(scan(split(trim(line), /[ \t]+/), 1)));
			continue;
		}
		// Any other indented line (cache details) belongs to the previous route and is not needed.
		if (match(line, /^[ \t]/))
			continue;
		if (length(out) - before >= cap) {
			truncated = true;
			last = null;
			continue;
		}
		last = parse_route(line, family);
		push(out, last);
	}
	return truncated;
}

// One policy rule from a line of `ip rule show`, e.g. "220:\tfrom all lookup 220" or
// "4200000000:\tfrom fd00::1/64 iif br-lan unreachable". `selectors` keeps the matching conditions in the
// order `ip` prints them as [name, value] pairs; the action is lookup (with `table`), goto, or a drop type.
function parse_rule(line, family) {
	let m = match(line, /^([0-9]+):[ \t]+(.*)$/);
	if (!m)
		return null;
	let t = split(trim(m[2]), /[ \t]+/);
	let r = { family, priority: +m[1], selectors: [], action: 'lookup', table: null, goto: null, suppress_prefixlength: null };
	let negate = false;
	for (let i = 0; i < length(t); i++) {
		let k = t[i];
		if (k == 'not') {
			negate = true;
		} else if (k in SELECTORS) {
			i++;
			push(r.selectors, [(negate ? 'not ' : '') + k, t[i]]);
			negate = false;
		} else if (k == 'lookup') {
			i++;
			r.action = 'lookup';
			r.table = t[i];
		} else if (k == 'goto') {
			i++;
			r.action = 'goto';
			r.goto = num(t[i]);
		} else if (k == 'suppress_prefixlength') {
			i++;
			r.suppress_prefixlength = num(t[i]);
		} else if (k in ['blackhole', 'unreachable', 'prohibit', 'l3mdev']) {
			r.action = k;
		}
	}
	return r;
}

// Table name -> number from the text of /etc/iproute2/rt_tables ("254\tmain"); comments are skipped.
function parse_table_ids(text) {
	let ids = {};
	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^[ \t]*([0-9]+)[ \t]+([^ \t#]+)/);
		if (m)
			ids[m[2]] = +m[1];
	}
	return ids;
}

//#endregion

//#region status

// The policy rules configured in /etc/config/network (`config rule` and `config rule6`), as
// { section, anonymous, family, priority, lookup }. netifd installs them, so the page can say who added a rule
// that matches one. Only these fields leave the plugin; the rest of the network config is not copied.
function configured_rules() {
	let out = [];
	let all = uci_all('network');
	for (let name in keys(all)) {
		let s = all[name];
		if (s['.type'] != 'rule' && s['.type'] != 'rule6')
			continue;
		push(out, { section: name, anonymous: s['.anonymous'] == true, family: s['.type'] == 'rule6' ? 6 : 4, priority: num(s.priority), lookup: s.lookup });
	}
	return out;
}

// The reply of `status`: every route and rule, the table names, whether BIRD is installed, whether strongSwan's
// charon runs (it adds the policy rule for table 220) and the rules configured in UCI.
function collect() {
	let routes = [];
	let truncated = false;
	let errors = [];
	for (let family in [4, 6]) {
		let result = command_result(`/sbin/ip -${family} route show table all 2>/dev/null`);
		if (!result.ok)
			push(errors, `IPv${family} route query failed (exit ${result.code ?? 'unknown'}).`);
		if (parse_routes(result.output, family, routes, MAX_ROUTES) || result.truncated)
			truncated = true;
	}

	let rules = [];
	for (let family in [4, 6]) {
		let result = command_result(`/sbin/ip -${family} rule show 2>/dev/null`);
		if (!result.ok)
			push(errors, `IPv${family} rule query failed (exit ${result.code ?? 'unknown'}).`);
		for (let line in split(result.output, '\n')) {
			let r = parse_rule(line, family);
			if (r)
				push(rules, r);
		}
	}

	return {
		generated: time(),
		// No routes at all means `ip` could not be run (or reported nothing), which the page says instead of an empty table.
		available: length(errors) == 0 && length(routes) > 0,
		...(length(errors) ? { ok: false, error: join(' ', errors) } : {}),
		truncated,
		routes, rules,
		table_ids: parse_table_ids(sysfs_raw('/etc/iproute2/rt_tables')),
		bird: trim(run('command -v birdc 2>/dev/null') ?? '') != '',
		charon: trim(run('pidof charon 2>/dev/null') ?? '') != '',
		uci_rules: configured_rules(),
	};
}

//#endregion

//#region lookup

// Whether `text` is a string without a newline. The regular expression engine matches line by line, so "^...$" accepts
// the first line of a longer text; the newline would then start another command in the shell line built from it.
function one_line(text) {
	return type(text) == 'string' && index(text, '\n') < 0;
}

// Whether `a` is an IPv4 or IPv6 address (only characters an address can hold, so it is safe in a command line).
function is_address(a) {
	if (!one_line(a))
		return false;
	if (match(a, /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/))
		return true;
	return index(a, ':') >= 0 && match(a, /^[0-9A-Fa-f:.]{2,45}$/) != null;
}

// The error text of an `ip` failure line ("RTNETLINK answers: Network is unreachable", "Error: ..."), or null
// when the line is a route.
function failure(text) {
	let first = trim(split(trim(text ?? ''), '\n')[0] ?? '');
	if (first == '')
		return 'The kernel gave no answer.';
	return match(first, /^(RTNETLINK answers:|Error:)/) ? trim(replace(first, /^(RTNETLINK answers:|Error:)[ \t]*/, '')) : null;
}

// The answer of `ip route get`: where the packet would go, as the kernel resolved it (one path of a multipath
// route, with the source address it would use). ok is false with the kernel's message when there is no route.
function parse_get(text, family) {
	let err = failure(text);
	if (err != null)
		return { ok: false, error: err };

	let lines = split(trim(text), '\n');
	let t = split(trim(lines[0]), /[ \t]+/);
	let kind = 'unicast';
	if (t[0] in TYPES)
		kind = shift(t);
	let dst = shift(t);
	let o = scan(t, 0);
	let flags = [];
	let iif = o.iif;
	// The second line ("cache <local,brd> iif br-lan") carries the cache flags and, for IPv4, the input interface.
	for (let l in slice(lines, 1)) {
		let c = match(l, /cache[ \t]*(<([^>]*)>)?/);
		if (c && c[2])
			flags = split(c[2], ',');
		let i = match(l, /iif ([^ \t]+)/);
		if (i)
			iif = i[1];
	}
	return {
		ok: true, type: kind, dst, via: o.via, dev: o.dev, src: o.src, table: o.table ?? 'main', proto: o.proto,
		metric: num(o.metric), from: o.from == '::' ? null : o.from, iif, flags,
	};
}

// The reply of `lookup`: the kernel's answer for a destination (with optional source address and input
// interface, which policy rules can match) and the FIB entry that answered. The raw `ip` text is included so
// the page can show exactly what the kernel said.
function lookup(args) {
	let dst = args?.dst;
	let src = args?.src == '' ? null : args?.src;
	let iif = args?.iif == '' ? null : args?.iif;
	let out = { generated: time(), dst, src, iif };

	if (!is_address(dst))
		return { ...out, ok: false, error: 'Enter an IPv4 or IPv6 address.' };
	if (src != null && !is_address(src))
		return { ...out, ok: false, error: 'The source must be an IPv4 or IPv6 address.' };
	if (iif != null && !(one_line(iif) && safe_ifname(iif)))
		return { ...out, ok: false, error: 'The interface name is not valid.' };

	let family = index(dst, ':') >= 0 ? 6 : 4;
	let cmd = `/sbin/ip -${family} route get ${dst}` + (src != null ? ` from ${src}` : '') + (iif != null ? ` iif ${iif}` : '');
	let got_result = command_result(cmd + ' 2>&1');
	let fib_result = command_result(cmd + ' fibmatch 2>&1');
	let got = got_result.output, fib = fib_result.output;

	let match_error = !fib_result.ok ? (failure(fib) ?? `The FIB query failed (exit ${fib_result.code ?? 'unknown'}).`) : failure(fib);
	let entries = [];
	if (match_error == null)
		parse_routes(fib, family, entries, 1);

	return {
		...out, ok: true, family,
		get: got_result.ok ? parse_get(got, family) : { ok: false, error: failure(got) ?? `The route query failed (exit ${got_result.code ?? 'unknown'}).` },
		match: entries[0],
		match_error,
		raw: { get: trim(got ?? ''), match: trim(fib ?? '') },
	};
}

//#endregion

// rpcd registration: ubus object flab.routing with `status` (no arguments) and `lookup` (dst, src, iif).
return deferred({
	'flab.routing': {
		status: {
			call: function(request) {
				return collect();
			},
		},
		lookup: {
			args: { dst: '', src: '', iif: '' },
			call: function(request) {
				return lookup(request.args);
			},
		},
	},
});
