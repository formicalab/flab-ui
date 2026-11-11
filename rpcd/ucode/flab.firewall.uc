#!/usr/bin/ucode
//
// rpcd ucode plugin reporting the firewall (firewall4 / nftables) as JSON:
//   ubus call flab.firewall status
//
// Everything is discovered at run time, so a new zone, rule or port forward shows up on the next poll.
//
// Sources (no LuCI component is used):
//   - UCI firewall: the configuration (defaults, zones, forwardings, traffic rules, port forwards, NAT, includes)
//   - UCI network: interface names, to find interfaces that are in no zone
//   - `nft -j list ruleset`: what is actually loaded: the hit counters of each rule (matched to the UCI rule by
//     the `!fw4: <name>` comment firewall4 puts on every rule), the packets rejected or dropped per zone, the
//     kernel devices behind each zone and the flow-offload devices
//   - procfs: connection tracking usage
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { run, uci_all, sysfs, num } from 'flab.util';

const as_list = (v) => v == null ? [] : (type(v) == 'array' ? v : split(trim(v), /[[:space:]]+/));
const sum_counter = (acc, c) => {
	acc.packets += c.packets ?? 0;
	acc.bytes += c.bytes ?? 0;
};

//#region nftables

function counter_of(rule) {
	for (let e in rule.expr ?? [])
		if (e.counter)
			return e.counter;
	return null;
}

// Devices named by an `iifname` / `oifname` match, whether a single name or a set.
function match_devices(rule) {
	let out = [];
	for (let e in rule.expr ?? []) {
		let key = e.match?.left?.meta?.key;
		if (key != 'iifname' && key != 'oifname')
			continue;
		let r = e.match.right;
		for (let d in (type(r) == 'object' ? r.set : [ r ]) ?? [])
			if (type(d) == 'string')
				push(out, d);
	}
	return out;
}

// What the kernel has loaded: null when nftables or the fw4 table is not there.
function nft_state() {
	let doc = json(run('nft -j list ruleset 2>/dev/null') || 'null');
	if (!doc?.nftables)
		return null;

	let st = { chains: 0, rules: 0, policy: {}, hits: {}, chain_hits: {}, devices: {}, flowtable: null };
	let found = false;
	for (let item in doc.nftables) {
		if (item.chain?.table == 'fw4' && item.chain.family == 'inet') {
			found = true;
			st.chains++;
			if (item.chain.policy)
				st.policy[item.chain.name] = item.chain.policy;
		}
		else if (item.flowtable?.table == 'fw4') {
			st.flowtable = { devices: item.flowtable.dev ?? [] };
		}
		else if (item.rule?.table == 'fw4' && item.rule.family == 'inet') {
			let rule = item.rule;
			st.rules++;
			let c = counter_of(rule);
			if (c) {
				let comment = rule.comment;
				if (comment && index(comment, '!fw4: ') == 0) {
					st.hits[comment] ??= { packets: 0, bytes: 0 };
					sum_counter(st.hits[comment], c);
				}
				st.chain_hits[rule.chain] ??= { packets: 0, bytes: 0 };
				sum_counter(st.chain_hits[rule.chain], c);
			}
			// The base chains jump to the per-zone chains by device, which tells which devices a zone covers.
			for (let e in rule.expr ?? []) {
				let m = match(e.jump?.target ?? '', /^(input|forward|output)_(.+)$/);
				if (m)
					for (let d in match_devices(rule)) {
						st.devices[m[2]] ??= {};
						st.devices[m[2]][d] = true;
					}
			}
		}
	}
	return found ? st : null;
}

//#endregion

//#region UCI

// The name firewall4 puts into the nft comment of a section: its `name` option, else `@<type>[N]` for an
// anonymous section (N counts sections of that type in configuration order) or the section name.
function comment_key(s, index_of_type) {
	if (s.name)
		return s.name;
	return s['.anonymous'] ? `@${s['.type']}[${index_of_type}]` : s['.name'];
}

function hits_of(nft, key, enabled) {
	if (!nft || !enabled)
		return null;
	return nft.hits[`!fw4: ${key}`] ?? null;
}

function blocked(nft, dir, zone) {
	if (!nft)
		return null;
	for (let action in [ 'reject', 'drop' ]) {
		let c = nft.chain_hits[`${action}_${dir}_${zone}`];
		if (c || nft.policy[`${action}_${dir}_${zone}`] != null)
			return { action, packets: c?.packets ?? 0, bytes: c?.bytes ?? 0 };
	}
	return null;
}

function zone_view(s, all, nft) {
	let name = s.name;
	let forwards = [];
	for (let n, f in all)
		if (f['.type'] == 'forwarding' && f.src == name && f.dest && f.enabled != '0')
			push(forwards, f.dest);
	let devices = nft?.devices[name] ? sort(keys(nft.devices[name])) : [];
	return {
		name,
		networks: as_list(s.network),
		devices,
		input: s.input ?? 'REJECT', output: s.output ?? 'REJECT', forward: s.forward ?? 'REJECT',
		masq: s.masq == '1', mtu_fix: s.mtu_fix == '1',
		forwards,
		enabled: s.enabled != '0',
		// Packets the zone's reject/drop chains turned away: traffic from the zone to the router (`from`) and
		// traffic forwarded towards the zone (`to`).
		blocked_from: blocked(nft, 'from', name),
		blocked_to: blocked(nft, 'to', name),
	};
}

function rule_view(s, key, nft) {
	let enabled = s.enabled != '0';
	return {
		name: s.name ?? null, key,
		src: s.src, dest: s.dest,
		proto: s.proto ? as_list(s.proto) : [],
		src_ip: as_list(s.src_ip), dest_ip: as_list(s.dest_ip),
		src_port: as_list(s.src_port), dest_port: as_list(s.dest_port),
		icmp_type: as_list(s.icmp_type),
		family: s.family ?? 'any',
		target: uc(s.target ?? 'DROP'),
		limit: s.limit,
		scheduled: s.start_time != null || s.stop_time != null || s.weekdays != null,
		enabled,
		hits: hits_of(nft, key, enabled),
	};
}

function redirect_view(s, key, nft) {
	let enabled = s.enabled != '0';
	let snat = s['.type'] == 'nat';
	return {
		name: s.name ?? null, key, kind: s['.type'],
		src: s.src, dest: s.dest,
		proto: s.proto ? as_list(s.proto) : [ 'tcp', 'udp' ],
		src_ip: as_list(s.src_ip), src_dip: as_list(s.src_dip), src_dport: as_list(s.src_dport),
		dest_ip: s.dest_ip ?? s.snat_ip, dest_port: as_list(s.dest_port ?? s.snat_port),
		family: s.family ?? 'any',
		target: uc(s.target ?? (snat ? 'SNAT' : 'DNAT')),
		enabled,
		hits: hits_of(nft, key, enabled),
	};
}

// Interfaces (netifd) that no zone contains: traffic from them reaches the final reject of the base chains.
function unzoned(all_zone_networks) {
	let out = [];
	for (let n, s in uci_all('network'))
		if (s['.type'] == 'interface' && n != 'loopback' && s.disabled != '1' && index(all_zone_networks, n) < 0)
			push(out, n);
	return sort(out);
}

//#endregion

function collect() {
	let all = uci_all('firewall');
	let nft = nft_state();
	let sections = sort(values(all), (a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));

	let defaults = {};
	for (let s in sections)
		if (s['.type'] == 'defaults') {
			defaults = {
				input: s.input ?? 'REJECT', output: s.output ?? 'REJECT', forward: s.forward ?? 'REJECT',
				synflood_protect: s.synflood_protect == '1',
				flow_offloading: s.flow_offloading == '1', flow_offloading_hw: s.flow_offloading_hw == '1',
				drop_invalid: s.drop_invalid == '1',
			};
			break;
		}

	let zones = [], rules = [], redirects = [], includes = [], ipsets = 0;
	let counts = {};
	for (let s in sections) {
		let t = s['.type'];
		let n = counts[t] ?? 0;
		counts[t] = n + 1;
		if (t == 'zone')
			push(zones, zone_view(s, all, nft));
		else if (t == 'rule')
			push(rules, rule_view(s, comment_key(s, n), nft));
		else if (t == 'redirect' || t == 'nat')
			push(redirects, redirect_view(s, comment_key(s, n), nft));
		else if (t == 'include' && s.path)
			push(includes, { path: s.path, type: s.type ?? 'script', enabled: s.enabled != '0' });
		else if (t == 'ipset')
			ipsets++;
	}

	let zoned = [];
	for (let z in zones)
		for (let n in z.networks)
			push(zoned, n);

	return {
		generated: time(),
		engine: nft ? 'nftables' : 'none',
		running: nft != null,
		defaults, zones, rules, redirects, includes, ipsets,
		hooks: nft ? { input: nft.policy.input, forward: nft.policy.forward, output: nft.policy.output } : null,
		flowtable: nft?.flowtable,
		nft: nft ? { chains: nft.chains, rules: nft.rules } : null,
		conntrack: {
			count: num(sysfs('/proc/sys/net/netfilter/nf_conntrack_count')),
			max: num(sysfs('/proc/sys/net/nf_conntrack_max')),
		},
		unzoned: unzoned(zoned),
	};
}

return {
	'flab.firewall': {
		status: {
			call: function(request) {
				return collect();
			},
		},
	},
};
