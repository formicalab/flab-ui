#!/usr/bin/ucode
//
// rpcd ucode plugin that lists the init scripts of /etc/init.d and starts, stops, restarts, enables or disables one of them:
//   ubus call flab.services list
//   ubus call flab.services control '{"name":"dnsmasq","action":"restart"}'
//
// procd's `service` object only reports running daemons; it cannot start or stop anything. The init scripts
// are what OpenWrt itself uses to do that, so they are what this plugin runs.
//
// Sources:
//   - /etc/init.d: every executable file directly in it is a service (listed by one shell loop).
//   - /etc/rc.d: an `S<NN><name>` link means <name> starts at boot, in position NN.
//   - `netstat -lntup` and /proc/sys/net/ipv4/ip_local_port_range: the listening sockets with the pid that owns each, which
//     the page matches to the pids procd reports (read only).
//
// `control` is the only thing here that changes the router, so it is strict about what it runs:
//   - the name must look like a plain file name AND be in the list of installed init scripts (no path
//     separators, no shell characters, nothing that is not an executable in /etc/init.d);
//   - the action must be one of start, stop, restart, enable and disable;
//   - the boot-sequence scripts (PROTECTED) are refused, because running them again would redo the boot or
//     unmount the filesystems.
// A validated name and action are the only strings that reach the shell command line.
//
// A script that carries this reply (rpcd, uhttpd) or the connection to the browser (network) is stopped or
// restarted in the background after a short delay, so the reply is out before the service goes away; the
// outcome of such a call cannot be reported, and `detached` says so. Every other call waits for the script (at
// most RUN_TIMEOUT seconds) and returns its exit code and output.
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { run } from 'flab.util';

// Actions `control` accepts. enable and disable only add or remove the start-at-boot links (the script's own `enable` and
// `disable`); they never start or stop the running service.
const ACTIONS = [ 'start', 'stop', 'restart', 'enable', 'disable' ];
// Init scripts that are part of the boot and shutdown sequence; running one again is never what a user wants.
const PROTECTED = [ 'boot', 'done', 'umount' ];
// Init scripts whose stop or restart cuts the reply or the browser connection: run detached.
const DETACHED = [ 'rpcd', 'uhttpd', 'network' ];
// How long `control` waits for an init script, in seconds (shorter than the web server's own limit).
const RUN_TIMEOUT = 45;
// Seconds a detached call waits before running the script, so the reply can leave first.
const DETACH_DELAY = 2;
// The most output of an init script that is returned.
const MAX_OUTPUT = 4096;
// Where the output of a script is collected while it runs (one call runs at a time inside rpcd).
const OUTPUT_FILE = '/tmp/flab-service.out';

// A plain file name: starts with a letter or digit, then letters, digits, "_", "." and "-". No "/", no spaces
// and no shell metacharacters.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// Whether `name` is a string that is, as a whole, a plain file name (`^` and `$` also match at line breaks, so
// the match must cover the entire string).
function valid_name(name) {
	let m = type(name) == 'string' ? match(name, NAME) : null;
	return m != null && m[0] == name;
}

// The names of the executable files in /etc/init.d, sorted; names that are not plain file names are dropped.
function installed() {
	let out = run('for f in /etc/init.d/*; do [ -f "$f" ] && [ -x "$f" ] && echo "${f##*/}"; done 2>/dev/null');
	return sort(filter(split(out ?? '', '\n'), valid_name));
}

// The boot position of every service that starts at boot: { name: NN }, from the S<NN><name> links of /etc/rc.d.
function boot_order() {
	let order = {};
	for (let l in split(run('ls -1 /etc/rc.d 2>/dev/null') ?? '', '\n')) {
		let m = match(l, /^S([0-9]+)(.+)$/);
		if (m)
			order[m[2]] = +m[1];
	}
	return order;
}

// The listening sockets that belong to a process, from `netstat -lntup`: [{ proto, address, port, pid }], sorted by port.
// The local address is split at its last colon, so "::" is the IPv6 wildcard (":::53") and an IPv6 address keeps its own
// colons. UDP sockets in the range of ephemeral ports (the kernel's choice for an outgoing query, not a service) and
// sockets that no process owns (the kernel's, such as WireGuard) are left out.
function listening() {
	let range = split(trim(run('cat /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null') ?? ''), /[[:space:]]+/);
	let ephemeral = +range[0] > 0 ? +range[0] : 32768;
	let seen = {};
	let out = [];
	for (let line in split(run('netstat -lntup 2>/dev/null') ?? '', '\n')) {
		let m = match(trim(line), /^(tcp|udp)6?[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+([^[:space:]]+)[[:space:]]+[^[:space:]]+[[:space:]]*(LISTEN)?[[:space:]]*([0-9]+)\//);
		let ci = m ? rindex(m[2], ':') : -1;
		if (ci < 0)
			continue;
		let port = +substr(m[2], ci + 1), address = substr(m[2], 0, ci);
		if (m[1] == 'udp' && port >= ephemeral)
			continue;
		let key = `${m[1]} ${address} ${port} ${m[4]}`;
		if (seen[key])
			continue;
		seen[key] = true;
		push(out, { proto: m[1], address, port, pid: +m[4] });
	}
	return sort(out, (a, b) => a.port - b.port || (a.proto == b.proto ? 0 : (a.proto < b.proto ? -1 : 1)) || (a.address < b.address ? -1 : (a.address > b.address ? 1 : 0)));
}

// The reply of `list`: one entry per init script with its boot state, and the listening sockets of the router.
function list() {
	let order = boot_order();
	return {
		generated: time(),
		listening: listening(),
		services: map(installed(), (name) => ({
			name,
			enabled: order[name] != null,
			start: order[name] ?? null,
			protected: index(PROTECTED, name) >= 0,
		})),
	};
}

// A failed reply of `control`.
function refuse(name, action, error) {
	return { name, action, ok: false, code: null, detached: false, output: '', error };
}

// Runs a script in the background after DETACH_DELAY seconds and returns at once.
function control_detached(name, action) {
	run(`(sleep ${DETACH_DELAY}; /etc/init.d/${name} ${action}) </dev/null >/dev/null 2>&1 &`);
	return { name, action, ok: true, code: null, detached: true, output: '', error: null };
}

// Runs a script, waits for it and returns its exit code and output. The output goes to a file first, so a
// daemon that keeps the script's output open cannot hold this call up.
function control_wait(name, action) {
	let code = trim(run(`timeout ${RUN_TIMEOUT} /etc/init.d/${name} ${action} </dev/null >${OUTPUT_FILE} 2>&1; echo $?`) ?? '');
	let output = trim(run(`head -c ${MAX_OUTPUT} ${OUTPUT_FILE} 2>/dev/null; rm -f ${OUTPUT_FILE}`) ?? '');
	if (match(code, /^[0-9]+$/) == null)
		return refuse(name, action, 'The service script did not report a result.');
	code = +code;
	return {
		name,
		action,
		ok: code == 0,
		code,
		detached: false,
		output,
		error: code == 0 ? null : (code == 124 ? `The service script did not finish within ${RUN_TIMEOUT} seconds.` : `The service script failed with exit code ${code}.`),
	};
}

// The reply of `control`: validates the request and runs the init script.
function control(request) {
	let name = request?.args?.name;
	let action = request?.args?.action;
	if (!valid_name(name))
		return refuse(name, action, 'The service name is not valid.');
	if (type(action) != 'string' || index(ACTIONS, action) < 0)
		return refuse(name, action, 'The action must be start, stop, restart, enable or disable.');
	if (index(installed(), name) < 0)
		return refuse(name, action, 'There is no such service.');
	if (index(PROTECTED, name) >= 0)
		return refuse(name, action, 'This service belongs to the boot sequence and cannot be controlled here.');
	return ((action == 'stop' || action == 'restart') && index(DETACHED, name) >= 0) ? control_detached(name, action) : control_wait(name, action);
}

return {
	'flab.services': {
		list: {
			call: function() {
				return list();
			},
		},
		control: {
			args: { name: '', action: '' },
			call: function(request) {
				return control(request);
			},
		},
	},
};
