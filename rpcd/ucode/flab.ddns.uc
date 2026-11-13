#!/usr/bin/ucode
//
// rpcd ucode plugin for the Dynamic DNS page (ddns-scripts):
//   ubus call flab.ddns status
//   ubus call flab.ddns log '{"section":"myddns"}'
//   ubus call flab.ddns control '{"section":"myddns","action":"check"}'
//
// `status` returns the ddns config WITHOUT its secrets, and what each service is doing right now:
//   - /etc/config/ddns through the uci module: the `global` section and every `service` section. An option that holds a secret
//     (the password or token, or any option whose name says so) is never returned, only whether it is set (`secrets`); the
//     credentials in a proxy address (user:password@host:port) are masked. The page edits the file through rpcd's own `uci`
//     object, so it never needs to read a secret back.
//   - ddns-scripts' own run files in the run directory (`ddns_rundir`, /var/run/ddns): <section>.pid, .ip (the address the
//     provider has registered, as the last lookup saw it), .update (the uptime in seconds of the last update that was sent)
//     and .nextcheck (the uptime of the next check), and <section>.log in the log directory, from which the latest problem and
//     the address the updater detected are taken. procd's `service list` says whether the updater runs for each section.
//   - the address the router has now, for the sources the plugin can read without network traffic: `network` (netifd's
//     `network.interface dump`) and `interface` (`ip addr`); `web` and `script` use the address in the log.
//   - the providers ddns-scripts knows (the JSON files of /usr/share/ddns/default and /usr/share/ddns/custom: whether the
//     provider supports IPv6, what it needs, whether its script is installed), the logical interfaces and the network devices.
// `log` returns the log of one service with any secret removed. `control` restarts the updater of one enabled service
// (`check`: it looks at the address at once) or also forgets the time of the last update (`force`: it sends the address even
// if nothing changed).
//
// Only `control` changes anything, and it is strict about what it runs: the section must be an existing service section with a
// plain name (letters, digits and underscores, which is what ddns-scripts allows), the action one of the two above, and the
// run directory a plain absolute path; those validated strings are the only ones that reach the shell. rpcd runs plugins
// in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { connect } from 'ubus';
import { run, sysfs, sysfs_raw, ubus_call, uci_all, safe_ifname } from 'flab.util';

// The uci config of the ddns client.
const CONFIG = 'ddns';
// Where ddns-scripts keeps its run files and logs unless the global section says otherwise.
const DEFAULT_RUNDIR = '/var/run/ddns';
const DEFAULT_LOGDIR = '/var/log/ddns';
// The provider definitions: the ones shipped with ddns-scripts and the user's own (which win, as in the updater).
const PROVIDER_DIRS = [ '/usr/share/ddns/default', '/usr/share/ddns/custom' ];
// The updater process and the directory of its provider scripts.
const UPDATER = '/usr/lib/ddns/dynamic_dns_updater.sh';
const SCRIPT_DIR = '/usr/lib/ddns';
// The actions `control` accepts.
const ACTIONS = [ 'check', 'force' ];
// A service section name: letters, digits and underscores (ddns-scripts does not allow a dash).
const NAME = /^[A-Za-z0-9_]{1,64}$/;
// An absolute path of plain characters, for the run and log directories read from the config.
const DIR = /^\/[A-Za-z0-9_.\/-]+$/;
// Options whose value is a secret: never returned.
const SECRET_OPTION = /^(password|[a-z_]*(passw|secret|token|apikey|api_key)[a-z_]*)$/i;
// The most of a log that is returned, in bytes.
const MAX_LOG = 65536;
// The most of an update error file that is returned, in characters.
const MAX_ERROR = 300;
// How many of the newest log lines are searched for the latest problem.
const PROBLEM_LINES = 60;
// How long `control` waits for the init script, in seconds, and the most output it returns.
const RUN_TIMEOUT = 30;
const MAX_OUTPUT = 4096;
// Where the output of the init script is collected while it runs (one call runs at a time inside rpcd).
const OUTPUT_FILE = '/tmp/flab-ddns.out';

//#region Helpers

// Whether `s` is a string that matches `re` as a whole (`^` and `$` also match at line breaks, so the match must cover the
// entire string).
function whole(s, re) {
	let m = type(s) == 'string' ? match(s, re) : null;
	return m != null && m[0] == s;
}

// Whether `p` is a directory path that may reach a command line.
function valid_dir(p) {
	return whole(p, DIR) && index(p, '..') < 0;
}

// Whether `n` is a network device name that may reach a command line: a plain interface name that does not start with a dash (which a command would read as an option).
function plain_ifname(n) {
	return safe_ifname(n) && index(n, '-') != 0;
}

// An option value as a plain string ('' when absent).
function text(v) {
	return v == null ? '' : '' + v;
}

// The uci `service` sections in file order, as { name, values } where `values` holds every option as uci returns it.
function service_sections() {
	let out = [];
	for (let name, s in uci_all(CONFIG))
		if (s['.type'] == 'service')
			push(out, { name: s['.name'] ?? name, index: s['.index'] ?? 0, values: s });
	return sort(out, (a, b) => a.index - b.index);
}

// The `global` section of the ddns config: { section, values } (section null when the file has none).
function global_section() {
	for (let name, s in uci_all(CONFIG))
		if (s['.type'] == 'ddns')
			return { section: s['.name'] ?? name, values: s };
	return { section: null, values: {} };
}

// A proxy address with the password of its credentials masked: "user:secret@host:8080" gives "user:***@host:8080".
function mask_proxy(v) {
	let m = type(v) == 'string' ? match(v, /^([^@\/:]*):([^@\/]*)@(.*)$/) : null;
	return m ? `${m[1]}:***@${m[3]}` : v;
}

// The options of a section that may be shown (every one but the secrets, bookkeeping keys left out), and which secrets are set:
// { values, secrets: { option: true } }.
function public_options(sec) {
	let values = {}, secrets = {};
	for (let k, v in sec) {
		if (index(k, '.') == 0)
			continue;
		if (match(k, SECRET_OPTION)) {
			if (text(v) != '')
				secrets[k] = true;
			continue;
		}
		values[k] = k == 'proxy' ? mask_proxy(v) : v;
	}
	return { values, secrets };
}

// Every secret a section holds, as strings to remove from text that is returned: the secret options and the password of a proxy.
function secret_strings(sec) {
	let out = [];
	for (let k, v in sec) {
		if (index(k, '.') == 0)
			continue;
		if (match(k, SECRET_OPTION) && text(v) != '')
			push(out, text(v));
		if (k == 'proxy') {
			let m = match(text(v), /^[^@\/:]*:([^@\/]*)@/);
			if (m && m[1] != '')
				push(out, m[1]);
		}
	}
	return out;
}

// `s` with every secret replaced by "***". A secret of fewer than four characters is not replaced: it would mangle ordinary text
// (the updater's own log already masks the password it sends).
function redact(s, secrets) {
	for (let x in secrets)
		if (length(x) >= 4)
			s = replace(s, x, '***');
	return s;
}

//#endregion

//#region Log

// The lines of a ddns-scripts log as [{ time, level, text }]: lines look like " 202526  info : message" (a time of day without
// separators, the level when it is not a debug line, a colon), and a line that does not fit is kept as it is.
function parse_log(raw) {
	let out = [];
	for (let line in split(replace(raw ?? '', /\r/g, ''), '\n')) {
		if (trim(line) == '')
			continue;
		let m = match(line, /^ *([0-9]{6}) +(EMERG|ALERT|CRIT|ERROR|WARN|note|info)? *: ?(.*)$/);
		push(out, m ? { time: m[1], level: m[2] ?? '', text: m[3] } : { time: '', level: '', text: trim(line) });
	}
	return out;
}

// What the updater's log says: the newest problem that no later cycle has put right, the address the updater itself detected,
// and why it stopped when it did. A line of level WARN or worse is a problem until a later line shows that an update went
// through or that the registered address could be read again.
//   { problem: { time, level, text } | null, detected_ip, terminated: text | null }
function log_facts(lines) {
	let from = length(lines) > PROBLEM_LINES ? length(lines) - PROBLEM_LINES : 0;
	let problem = null, detected = null;
	for (let i = length(lines) - 1; i >= from; i--) {
		let l = lines[i];
		if (detected == null) {
			let m = match(l.text, /^Detected IP: ([0-9A-Fa-f.:]+)/);
			if (m)
				detected = m[1];
		}
		if (match(l.text, /[Uu]pdate successful|Registered IP '[^']*' detected/))
			break;
		if (problem == null && index([ 'EMERG', 'ALERT', 'CRIT', 'ERROR', 'WARN' ], l.level) >= 0)
			problem = { time: l.time, level: l.level, text: replace(l.text, / - TERMINATE$/, '') };
	}
	// The address the updater detected is looked for in the whole log, not only in the problem window.
	for (let i = length(lines) - 1; i >= 0 && detected == null; i--) {
		let m = match(lines[i].text, /^Detected IP: ([0-9A-Fa-f.:]+)/);
		if (m)
			detected = m[1];
	}
	let last = length(lines) ? lines[length(lines) - 1] : null;
	let stopped = last && match(last.text, / - TERMINATE$/) ? replace(last.text, / - TERMINATE$/, '') : null;
	return { problem, detected_ip: detected, terminated: stopped };
}

//#endregion

//#region Runtime state

// The seconds the router has been up (the reference the updater's .update and .nextcheck files use), or null.
function uptime() {
	let m = match(sysfs('/proc/uptime') ?? '', /^([0-9]+)/);
	return m ? +m[1] : null;
}

// The epoch time of an uptime stamp read from a run file (`stamp` seconds of uptime), or null when it is unusable. A stamp
// later than the uptime is only accepted when it is meant to be in the future (`future`, the time of the next check); the time
// of the last update cannot be.
function epoch_of(stamp, up, now, future) {
	let m = match(text(stamp), /^[0-9]+$/);
	if (!m || up == null || (!future && +m[0] > up))
		return null;
	return now - up + +m[0];
}

// The address the router has now for a service that reads it from a network or an interface. Null for the other sources (the
// updater reads those over the network, which a status call must not do) and when there is no address.
function local_address(sec, dump) {
	let v6 = text(sec.use_ipv6) == '1';
	let source = sec.ip_source ?? 'network';
	if (source == 'network') {
		for (let i in dump?.interface ?? []) {
			if (i.interface != sec.ip_network)
				continue;
			if (!v6) {
				let a = i['ipv4-address'];
				return a && length(a) ? a[0].address : null;
			}
			for (let a in i['ipv6-address'] ?? [])
				if (!match(a.address, /^fe[89ab]/i))
					return a.address;
			return null;
		}
		return null;
	}
	if (source == 'interface' && plain_ifname(sec.ip_interface)) {
		let out = run(`ip -o -${v6 ? 6 : 4} addr show dev ${sec.ip_interface} scope global 2>/dev/null`);
		let m = match(out, v6 ? /inet6 ([0-9a-fA-F:]+)\// : /inet ([0-9.]+)\//);
		return m ? m[1] : null;
	}
	return null;
}

// What one service is doing: the run files, the process and the log.
//   { running, pid, registered_ip, local_ip, detected_ip, last_update, next_check, error, problem, terminated, log }
// Times are epoch seconds. `log` is whether a log file exists.
function runtime(sec, ctx) {
	let name = sec['.name'];
	let secrets = secret_strings(sec);
	let inst = ctx.instances?.[name];
	let file = (ext) => sysfs(`${ctx.rundir}/${name}.${ext}`);
	let raw_log = sysfs_raw(`${ctx.logdir}/${name}.log`);
	let facts = log_facts(parse_log(raw_log));
	let ip = trim(file('ip') ?? '');
	let err = trim(redact(file('err') ?? '', secrets));
	return {
		running: inst?.running == true,
		pid: inst?.pid ?? null,
		registered_ip: ip == '' ? null : ip,
		local_ip: local_address(sec, ctx.dump),
		detected_ip: facts.detected_ip,
		last_update: epoch_of(file('update'), ctx.uptime, ctx.now),
		next_check: epoch_of(file('nextcheck'), ctx.uptime, ctx.now, true),
		error: err == '' ? null : substr(err, 0, MAX_ERROR),
		problem: facts.problem ? { ...facts.problem, text: redact(facts.problem.text, secrets) } : null,
		terminated: facts.terminated != null ? redact(facts.terminated, secrets) : null,
		log: raw_log != null,
	};
}

//#endregion

//#region What the router offers

// The providers ddns-scripts knows: [{ name, ipv6, needs, script, available, source }]. `needs` lists which of DOMAIN, USERNAME,
// PASSWORD, PARAMENC and PARAMOPT the provider's update address contains (null for a provider that is a script, which reads
// the options itself); `script` is the name of the provider's script and `available` whether it is installed. A provider in the
// user's own directory replaces one of the same name.
function providers() {
	let script = '[ -f "$f" ] && { printf "%s\\t" "$f"; tr -d "\\n\\t" < "$f"; echo; }';
	let out = run(`for f in ${join(' ', map(PROVIDER_DIRS, (d) => d + '/*.json'))}; do ${script}; done 2>/dev/null`);
	let installed = {};
	for (let f in split(run(`ls -1 ${SCRIPT_DIR} 2>/dev/null`) ?? '', '\n'))
		installed[trim(f)] = true;
	let by_name = {};
	for (let line in split(out ?? '', '\n')) {
		let tab = index(line, '\t');
		if (tab < 0)
			continue;
		let path = substr(line, 0, tab);
		let def = null;
		try {
			def = json(substr(line, tab + 1));
		}
		catch (e) {
			continue;
		}
		if (type(def) != 'object' || type(def.name) != 'string')
			continue;
		let urls = [ def.ipv4?.url, def.ipv6?.url ];
		let is_script = false, needs = [];
		for (let u in urls) {
			if (type(u) != 'string' || u == '')
				continue;
			if (index(u, 'http') != 0)
				is_script = true;
			for (let token in [ 'DOMAIN', 'USERNAME', 'PASSWORD', 'PARAMENC', 'PARAMOPT' ])
				if (index(u, `[${token}]`) >= 0 && index(needs, token) < 0)
					push(needs, token);
		}
		let script_name = is_script ? (filter(urls, (u) => type(u) == 'string' && index(u, 'http') != 0)[0]) : null;
		by_name[def.name] = {
			name: def.name,
			ipv6: type(def.ipv6) == 'object',
			needs: is_script ? null : needs,
			script: script_name,
			available: !is_script || installed[script_name] == true,
			source: index(path, '/custom/') >= 0 ? 'custom' : 'default',
		};
	}
	return sort(map(keys(by_name), (k) => by_name[k]), (a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
}

// The logical interfaces (the uci network sections of type interface and the ones netifd reports, without loopback), sorted.
function networks(dump) {
	let seen = {};
	for (let name, s in uci_all('network'))
		if (s['.type'] == 'interface' && name != 'loopback')
			seen[name] = true;
	for (let i in dump?.interface ?? [])
		if (i.interface != 'loopback')
			seen[i.interface] = true;
	return sort(keys(seen));
}

// The network devices of the router, sorted (a name that is not a plain interface name is left out).
function devices() {
	return sort(filter(map(split(run('ls -1 /sys/class/net 2>/dev/null') ?? '', '\n'), (n) => trim(n)), (n) => n != '' && plain_ifname(n)));
}

// The download and lookup tools that decide which options work: curl and wget carry the updates, and `host` (bind-host) is
// what forcing an IP version, DNS over TCP or a glue-record check need.
function tools() {
	let found = {};
	for (let t in split(run('for t in curl wget uclient-fetch host; do command -v $t >/dev/null 2>&1 && echo $t; done') ?? '', '\n'))
		found[trim(t)] = true;
	return { curl: found.curl == true, wget: found.wget == true, uclient_fetch: found['uclient-fetch'] == true, host: found.host == true };
}

// The CA certificates the router has for HTTPS: the bundle file when it exists, else the directory, else ''. A new service starts
// with it as its "CA certificates" setting.
function ca_path() {
	return trim(run('if [ -f /etc/ssl/certs/ca-certificates.crt ]; then echo /etc/ssl/certs/ca-certificates.crt; elif [ -d /etc/ssl/certs ]; then echo /etc/ssl/certs; fi') ?? '');
}

// Whether the updater passes every character of a password through unchanged. The package's urlencode() reads backslash sequences
// and non-ASCII characters wrongly and the Cloudflare script breaks on a single quote; tools/patch-ddns-scripts.sh corrects both
// and leaves a marker in each file, which this looks for (the Cloudflare script only when it is installed).
function password_exact() {
	return trim(run('grep -q \'flab-ui: byte-exact\' /usr/lib/ddns/dynamic_dns_functions.sh 2>/dev/null && { [ ! -f /usr/lib/ddns/update_cloudflare_com_v4.sh ] || grep -q \'flab-ui: quoted\' /usr/lib/ddns/update_cloudflare_com_v4.sh; } && echo 1') ?? '') == '1';
}

//#endregion

// The reply of `status`.
function status() {
	let conn = connect();
	let now = time();
	let up = uptime();
	let glob = global_section();
	let rundir = valid_dir(glob.values.ddns_rundir) ? glob.values.ddns_rundir : DEFAULT_RUNDIR;
	let logdir = valid_dir(glob.values.ddns_logdir) ? glob.values.ddns_logdir : DEFAULT_LOGDIR;
	let procd = ubus_call(conn, 'service', 'list', { name: 'ddns' });
	let dump = ubus_call(conn, 'network.interface', 'dump', {});
	let ctx = { now, uptime: up, rundir, logdir, instances: procd?.ddns?.instances, dump };
	let services = [];
	for (let s in service_sections()) {
		let o = public_options(s.values);
		push(services, { section: s.name, values: o.values, secrets: o.secrets, runtime: runtime(s.values, ctx) });
	}
	let g = public_options(glob.values);
	let boot = run('ls -1 /etc/rc.d 2>/dev/null') ?? '';
	return {
		generated: now,
		uptime: up,
		installed: trim(run(`[ -x ${UPDATER} ] && echo 1`) ?? '') == '1',
		version: sysfs('/usr/share/ddns/version'),
		running: length(procd?.ddns?.instances ?? {}) > 0,
		at_boot: match(boot, /(^|\n)S[0-9]+ddns(\n|$)/) != null,
		rundir,
		logdir,
		ca: ca_path(),
		password_exact: password_exact(),
		global: { section: glob.section, values: g.values },
		services,
		providers: providers(),
		networks: networks(dump),
		devices: devices(),
		tools: tools(),
	};
}

// The reply of `log`: the log of one service, without secrets.
//   { ok, section, exists, text } or { ok: false, error }
function read_log(request) {
	let name = request?.args?.section;
	let sec = whole(name, NAME) ? filter(service_sections(), (s) => s.name == name)[0] : null;
	if (!sec)
		return { ok: false, error: 'There is no such service.' };
	let glob = global_section();
	let logdir = valid_dir(glob.values.ddns_logdir) ? glob.values.ddns_logdir : DEFAULT_LOGDIR;
	let raw = sysfs_raw(`${logdir}/${name}.log`);
	if (raw == null)
		return { ok: true, section: name, exists: false, text: '' };
	let cut = length(raw) > MAX_LOG;
	if (cut)
		raw = substr(raw, length(raw) - MAX_LOG);
	return { ok: true, section: name, exists: true, truncated: cut, text: redact(replace(raw, /\r/g, ''), secret_strings(sec.values)) };
}

// A failed reply of `control`.
function refuse(section, action, error) {
	return { ok: false, section, action, code: null, output: '', error };
}

// The reply of `control`: validates the request and restarts the updater of one service. The updater is stopped and started
// again through the init script (`ddns stop <section>` ends that one instance, `ddns start <section>` starts it), so it reads
// the address and compares it with the registered one at once. `force` first removes the file with the time of the last update,
// so the updater sends the address even when it has not changed.
function control(request) {
	let name = request?.args?.section;
	let action = request?.args?.action;
	if (!whole(name, NAME))
		return refuse(name, action, 'The service name is not valid.');
	if (type(action) != 'string' || index(ACTIONS, action) < 0)
		return refuse(name, action, 'The action must be check or force.');
	let sec = filter(service_sections(), (s) => s.name == name)[0];
	if (!sec)
		return refuse(name, action, 'There is no such service.');
	if (index([ '1', 'true', 'yes', 'on' ], sec.values.enabled) < 0)
		return refuse(name, action, 'This service is disabled. Enable it and save first.');
	let glob = global_section();
	let rundir = valid_dir(glob.values.ddns_rundir) ? glob.values.ddns_rundir : DEFAULT_RUNDIR;
	if (action == 'force')
		run(`rm -f ${rundir}/${name}.update`);
	let code = trim(run(`timeout ${RUN_TIMEOUT} /etc/init.d/ddns stop ${name} </dev/null >${OUTPUT_FILE} 2>&1; timeout ${RUN_TIMEOUT} /etc/init.d/ddns start ${name} </dev/null >>${OUTPUT_FILE} 2>&1; echo $?`) ?? '');
	let output = trim(run(`head -c ${MAX_OUTPUT} ${OUTPUT_FILE} 2>/dev/null; rm -f ${OUTPUT_FILE}`) ?? '');
	if (match(code, /^[0-9]+$/) == null)
		return refuse(name, action, 'The init script did not report a result.');
	code = +code;
	return {
		ok: code == 0,
		section: name,
		action,
		code,
		output,
		error: code == 0 ? null : (code == 124 ? `The init script did not finish within ${RUN_TIMEOUT} seconds.` : `The init script failed with exit code ${code}.`),
	};
}

// rpcd registration: ubus object flab.ddns.
return {
	'flab.ddns': {
		status: {
			call: function() {
				return status();
			},
		},
		log: {
			args: { section: '' },
			call: function(request) {
				return read_log(request);
			},
		},
		control: {
			args: { section: '', action: '' },
			call: function(request) {
				return control(request);
			},
		},
	},
};
