#!/usr/bin/ucode
//
// rpcd ucode plugin that runs network diagnostics (ping, traceroute, DNS lookups) as background jobs and streams
// their output:
//   ubus call flab.diag status
//   ubus call flab.diag start '{"tool":"ping","host":"1.1.1.1","count":4}'
//   ubus call flab.diag read '{"id":"<id from start>","from":0}'
//   ubus call flab.diag stop '{"id":"<id from start>"}'
//
// rpcd runs plugins in-process, so a call that waited for a ten-second ping (or a traceroute) would hold up every
// other call, including the page's own polling. `start` therefore launches the tool detached and returns at once
// with a job id; the tool writes into /tmp/flab-diag/<id>/out, and `read` returns what has been written so far, so
// the page shows the output as it arrives. `stop` ends a running job. Jobs are removed ten minutes after they end.
//
// Everything that reaches the shell is validated first, because the request comes from a browser:
//   - the target is a host name or an address made of letters, digits, ".", ":", "_" and "-", and does not start
//     with "-" (it could be taken for an option);
//   - the source is such an address or an interface name; numbers are clamped to fixed ranges;
//   - the tool, the address family, the traceroute method and the DNS record type come from allow-lists, and the
//     name-resolution switch must be a real boolean.
// The tools are fixed (busybox ping and traceroute, the first of dig, kdig, drill and nslookup that exists, and
// openssl), the argument list or script is built from validated values only, and the job id is generated here and
// checked again whenever it comes back from the browser. `timeout` caps every job. The script tools (the TLS check, the
// DNS comparison and the connectivity check) write a script owned by this plugin into the job directory; the only
// values in it from the request are the validated words above.

'use strict';

import { run, safe_ifname } from 'flab.util';
import { mkdir, readfile, writefile, lsdir, stat, access } from 'fs';

// Where the jobs live (tmpfs): one directory per job with `out` (the output), `pid` and `rc` (the exit code).
const ROOT = '/tmp/flab-diag';
// At most this many jobs run at once, and only this many job directories are kept.
const MAX_RUNNING = 3;
const MAX_JOBS = 12;
// Seconds a finished job stays readable.
const KEEP = 600;
// The most output `read` returns in one reply.
const MAX_OUTPUT = 65536;
// The seconds each tool may run before `timeout` ends it.
const LIMITS = { ping: 25, traceroute: 60, dns: 15, tls: 25, compare: 60, check: 75 };
// The tools `start` accepts.
const TOOLS = [ 'ping', 'traceroute', 'dns', 'tls', 'compare', 'check' ];
// The protocols s_client can upgrade to TLS in (STARTTLS), and the most servers one comparison asks.
const STARTTLS = [ 'smtp', 'imap', 'pop3', 'ftp' ];
const MAX_SERVERS = 6;
// The name the connectivity check looks up and connects to when none is given.
const CHECK_HOST = 'example.com';
// DNS record types the page offers.
const TYPES = [ 'A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'PTR', 'SRV', 'CAA' ];
// The process names of everything a job can run (/proc/<pid>/comm), checked before `stop` sends a kill.
const OURS = [ 'timeout', 'ping', 'ping6', 'traceroute', 'traceroute6', 'nslookup', 'dig', 'kdig', 'drill' ];

//#region Validation

// Whether `s` is a string that matches `re` as a whole (`^` and `$` also match at line breaks, so a match has to
// cover the entire string).
function whole(s, re) {
	let m = type(s) == 'string' ? match(s, re) : null;
	return m != null && m[0] == s;
}

// A host name or an address: at most 253 characters of letters, digits, ".", ":", "_" and "-", not starting with "-".
function valid_host(s) {
	return whole(s, /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,252}$/);
}

// An IPv4 or IPv6 address (only characters an address can hold).
function is_address(s) {
	if (whole(s, /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/))
		return true;
	return type(s) == 'string' && index(s, ':') >= 0 && whole(s, /^[0-9A-Fa-f:.]{2,45}$/);
}

// An interface name that cannot be taken for an option.
function valid_iface(s) {
	return safe_ifname(s) && substr(s, 0, 1) != '-';
}

// `v` as an integer between lo and hi; `def` when it is absent or an empty string; null when it is out of range or
// not a number (a literal 0 is a number, not "absent").
function int_in(v, lo, hi, def) {
	if (v == null || (type(v) == 'string' && v == ''))
		return def;
	let n = +v;
	return (n >= lo && n <= hi && n == int(n)) ? int(n) : null;
}

//#endregion

//#region Tools

// The first of the DNS tools that is installed ('' when none is): dig, kdig and drill answer every record type
// properly; busybox nslookup is the last resort and cannot show MX, SRV and similar records in full.
function dns_tool() {
	for (let t in [ 'dig', 'kdig', 'drill', 'nslookup' ])
		if (trim(run(`command -v ${t} 2>/dev/null`) ?? '') != '')
			return t;
	return '';
}

// The argument list of a ping from the request: [ argv ] or { error }.
function build_ping(a) {
	let count = int_in(a.count, 1, 10, 4), size = int_in(a.size, 0, 1400, 56);
	if (count == null)
		return { error: 'The number of pings must be between 1 and 10.' };
	if (size == null)
		return { error: 'The packet size must be between 0 and 1400 bytes.' };
	let argv = [ 'ping', '-c', count, '-W', 2, '-w', 20, '-s', size ];
	if (a.family == '4' || a.family == '6')
		push(argv, `-${a.family}`);
	if (a.source != null && a.source != '') {
		if (!is_address(a.source) && !valid_iface(a.source))
			return { error: 'The source must be an address or an interface name.' };
		push(argv, '-I', a.source);
	}
	push(argv, a.host);
	return { argv, limit: LIMITS.ping };
}

// The argument list of a traceroute. Output is numeric unless `resolve` is true: busybox then looks up a host name for
// every router that answers, which can slow a trace down when the resolver is slow or has no reverse records.
function build_traceroute(a) {
	let hops = int_in(a.hops, 1, 30, 20), probes = int_in(a.probes, 1, 3, 2);
	if (hops == null)
		return { error: 'The maximum number of hops must be between 1 and 30.' };
	if (probes == null)
		return { error: 'The number of probes per hop must be between 1 and 3.' };
	if (a.resolve != null && a.resolve !== true && a.resolve !== false)
		return { error: 'Resolving names must be true or false.' };
	let argv = [ 'traceroute', '-w', 2, '-q', probes, '-m', hops ];
	if (a.resolve !== true)
		splice(argv, 1, 0, '-n');
	if (a.method == 'icmp')
		push(argv, '-I');
	if (a.family == '4' || a.family == '6')
		push(argv, `-${a.family}`);
	if (a.source != null && a.source != '') {
		if (is_address(a.source))
			push(argv, '-s', a.source);
		else if (valid_iface(a.source))
			push(argv, '-i', a.source);
		else
			return { error: 'The source must be an address or an interface name.' };
	}
	push(argv, a.host);
	return { argv, limit: LIMITS.traceroute };
}

// The argument list of a DNS query with `tool` for `host` and record type `type_`, against `server` (null: the router's
// own resolver). PTR on an address becomes a reverse lookup. The server and host are validated by the callers.
function dns_argv(tool, host, type_, server) {
	let reverse = type_ == 'PTR' && is_address(host);
	if (tool == 'nslookup') {
		let argv = [ 'nslookup', `-type=${type_}`, host ];
		if (server != null)
			push(argv, server);
		return argv;
	}
	let argv = tool == 'dig' ? [ 'dig', '+time=3', '+tries=1' ] : (tool == 'kdig' ? [ 'kdig', '+time=3', '+retry=0' ] : [ 'drill' ]);
	if (server != null)
		push(argv, `@${server}`);
	if (reverse)
		push(argv, '-x', host);
	else
		push(argv, host, type_);
	return argv;
}

// The argument list of a DNS lookup with the best tool the router has. A server may be named (it must be a host
// name or an address).
function build_dns(a) {
	let tool = dns_tool();
	if (tool == '')
		return { error: 'The router has no DNS lookup tool (dig, kdig, drill or nslookup).' };
	let type_ = a.type == null || a.type == '' ? 'A' : uc(a.type);
	if (index(TYPES, type_) < 0)
		return { error: 'The record type is not one of ' + join(', ', TYPES) + '.' };
	let server = a.server == null || a.server == '' ? null : a.server;
	if (server != null && !valid_host(server))
		return { error: 'The DNS server must be a host name or an address.' };
	return { argv: dns_argv(tool, a.host, type_, server), limit: LIMITS.dns, tool };
}

//#endregion

//#region Scripts

// The functions every job script starts with. A job script prints its output in blocks: `blk <id> [detail ...]` opens
// one (`### BEGIN <id> <uptime> <detail>`), the command's output follows, and `end <exit code>` closes it
// (`### END <exit code> <uptime>`). `run <seconds> cmd ...`
// runs a command under `timeout` in the background and waits for it, so that a TERM sent to the script (Stop) ends the
// command at once instead of after it finishes. `cap <file> <seconds> cmd ...` does the same with the output kept in a
// file (and not printed). Nothing here uses a value from the browser.
const PRELUDE = `u() { cut -d' ' -f1 /proc/uptime; }
cpid=
trap 'kill $cpid 2>/dev/null; exit 143' TERM
blk() { id=$1; shift; printf '### BEGIN %s %s %s\\n' "$id" "$(u)" "$*"; }
end() { printf '\\n### END %s %s\\n' "$1" "$(u)"; }
run() { t=$1; shift; timeout "$t" "$@" 2>&1 & cpid=$!; wait $cpid; rc=$?; end $rc; }
cap() { f=$1; t=$2; shift 2; timeout "$t" "$@" >"$f" 2>&1 & cpid=$!; wait $cpid; return $?; }
`;

// The shell text that runs `argv` (validated words) under a time limit as one block: single quotes around every word
// keep it one word each, and the validators already refuse quotes.
function block(id, detail, seconds, argv) {
	return `blk ${id} ${detail ?? ''}\nrun ${seconds} ${join(' ', map(argv, (w) => `'${w}'`))}\n`;
}

// The option that makes s_client check the certificate against the name asked for: -verify_ip for an address,
// -verify_hostname for a name. An address is not sent as the SNI name.
function verify_options(name) {
	return is_address(name) ? `-verify_ip '${name}'` : `-servername '${name}' -verify_hostname '${name}'`;
}

// The script of the connectivity check: the default routes, the next hop (found the way the kernel would route to
// 1.1.1.1; a PPP link has no gateway address, so its peer address is used), pings of the gateway and of two public
// addresses, a lookup through the router's resolver and through a public one, the IPv6 equivalents, and a TLS
// handshake that also shows a wrong clock (a certificate that is "not yet valid" or "expired"). `name` is the host
// used for the lookups and the handshake. Every block's raw output goes to the page, which draws the verdict.
function check_script(tool, name) {
	let s = PRELUDE;
	s += `blk route4\n/sbin/ip -4 route show default 2>&1\nend 0\n`;
	s += `blk route6\n/sbin/ip -6 route show default 2>&1\nend 0\n`;
	s += `route=$(/sbin/ip -4 route get 1.1.1.1 2>/dev/null)
dev=$(echo "$route" | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
gw=$(echo "$route" | awk '{for(i=1;i<=NF;i++) if($i=="via") {print $(i+1); exit}}')
if [ -z "$gw" ] && [ -n "$dev" ]; then gw=$(/sbin/ip -4 addr show dev "$dev" 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="peer") {sub("/.*","",$(i+1)); print $(i+1); exit}}'); fi
blk gateway "$gw" "$dev"
if [ -n "$gw" ]; then run 8 ping -c 2 -W 2 -w 6 "$gw"; else echo "no next hop address"; end 2; fi
`;
	s += block('internet4', '1.1.1.1', 8, [ 'ping', '-4', '-c', 2, '-W', 2, '-w', 6, '1.1.1.1' ]);
	s += block('internet4', '8.8.8.8', 8, [ 'ping', '-4', '-c', 2, '-W', 2, '-w', 6, '8.8.8.8' ]);
	s += block('dns_router', name, 8, dns_argv(tool, name, 'A', null));
	s += block('dns_public', name, 8, dns_argv(tool, name, 'A', '1.1.1.1'));
	s += block('internet6', '2606:4700:4700::1111', 8, [ 'ping', '-6', '-c', 2, '-W', 2, '-w', 6, '2606:4700:4700::1111' ]);
	s += block('dns6', name, 8, dns_argv(tool, name, 'AAAA', null));
	s += `blk tls ${name}\ncap tls.raw 12 openssl s_client -connect '${name}:443' ${verify_options(name)} </dev/null\nrc=$?\ncat tls.raw\nend $rc\n`;
	return s;
}

// The script of the DNS comparison: the same question put to each server in turn, one block per server.
function compare_script(tool, name, type_, servers) {
	let s = PRELUDE;
	for (let server in servers)
		s += block('server', server, 8, dns_argv(tool, name, type_, server == 'router' ? null : server));
	return s;
}

// The script of the certificate check: the handshake with the full chain, then `openssl x509` on every certificate the
// server sent (serial, SHA-256 fingerprint, alternative names, CA flag), each under a `### CERT n` line. `sni` is the
// name sent to the server (null for an address) and `starttls` an allow-listed protocol or null.
function tls_script(host, port, sni, starttls) {
	let s = PRELUDE;
	let extra = (sni != null ? `-servername '${sni}' ` : '') + (is_address(host) ? `-verify_ip '${host}'` : `-verify_hostname '${sni ?? host}'`);
	if (starttls != null)
		extra += ' -starttls ' + starttls;
	s += `blk tls ${host} ${port}\n`;
	s += `cap tls.raw 15 openssl s_client -connect '${host}:${port}' ${extra} -showcerts </dev/null\nrc=$?\ncat tls.raw\n`;
	s += `awk 'BEGIN{n=0} /-----BEGIN CERTIFICATE-----/{n++; f="cert" n ".pem"} f{print > f} /-----END CERTIFICATE-----/{close(f); f=""}' tls.raw\n`;
	s += `n=$(ls cert*.pem 2>/dev/null | wc -l); i=1\nwhile [ $i -le $n ]; do echo "### CERT $i"; openssl x509 -in cert$i.pem -noout -serial -fingerprint -sha256 2>&1; openssl x509 -in cert$i.pem -noout -ext subjectAltName,basicConstraints 2>&1; i=$((i + 1)); done\nend $rc\n`;
	return s;
}

//#endregion

//#region Request builders for the script tools

// The certificate check: host, port (default 443), the name sent as SNI (default the host; none for an address) and an
// optional STARTTLS protocol.
function build_tls(a) {
	let port = int_in(a.port, 1, 65535, 443);
	if (port == null)
		return { error: 'The port must be between 1 and 65535.' };
	let sni = a.sni == null || a.sni == '' ? null : a.sni;
	if (sni != null && !valid_host(sni))
		return { error: 'The server name must be a host name.' };
	let starttls = a.starttls == null || a.starttls == '' ? null : a.starttls;
	if (starttls != null && index(STARTTLS, starttls) < 0)
		return { error: 'STARTTLS must be one of ' + join(', ', STARTTLS) + '.' };
	if (trim(run('command -v openssl 2>/dev/null') ?? '') == '')
		return { error: 'The router has no openssl, which this check needs.' };
	// A name is sent as SNI (the host itself when none is given); an address is not.
	let name = sni ?? (is_address(a.host) ? null : a.host);
	return { script: tls_script(a.host, port, name, starttls), limit: LIMITS.tls, display: `openssl s_client -connect ${a.host}:${port}` + (starttls != null ? ` -starttls ${starttls}` : '') };
}

// The DNS comparison: the name, the record type and one to MAX_SERVERS servers (host names or addresses, or "router" for
// the router's own resolver).
function build_compare(a) {
	let tool = dns_tool();
	if (tool == '')
		return { error: 'The router has no DNS lookup tool (dig, kdig, drill or nslookup).' };
	let type_ = a.type == null || a.type == '' ? 'A' : uc(a.type);
	if (index(TYPES, type_) < 0)
		return { error: 'The record type is not one of ' + join(', ', TYPES) + '.' };
	if (type(a.servers) != 'array' || length(a.servers) < 1 || length(a.servers) > MAX_SERVERS)
		return { error: `Choose between 1 and ${MAX_SERVERS} servers.` };
	let servers = [];
	for (let s in a.servers) {
		if (!valid_host(s))
			return { error: 'A DNS server must be "router", a host name or an address.' };
		if (index(servers, s) < 0)
			push(servers, s);
	}
	return { script: compare_script(tool, a.host, type_, servers), limit: LIMITS.compare, tool, display: `${tool} ${a.host} ${type_} @${join(' @', servers)}` };
}

// The connectivity check, which takes an optional host (default CHECK_HOST) to look up and connect to.
function build_check(a) {
	let tool = dns_tool();
	if (tool == '')
		return { error: 'The router has no DNS lookup tool (dig, kdig, drill or nslookup).' };
	return { script: check_script(tool, a.host), limit: LIMITS.check, tool, display: `connectivity check (${a.host})` };
}

//#endregion

//#region Jobs

// A job id: twelve lowercase hex digits.
function valid_id(s) {
	return whole(s, /^[0-9a-f]{12}$/);
}

// Whether a process with this pid exists.
function alive(pid) {
	return pid != null && access(`/proc/${pid}`) == true;
}

// The state of one job directory: { running, exit, pid, mtime }. A job whose `rc` file is missing but whose
// process is gone (stopped by a kill) is finished with no exit code.
function job_state(id) {
	let dir = `${ROOT}/${id}`;
	let rc = trim(readfile(`${dir}/rc`) ?? '');
	let pid = trim(readfile(`${dir}/pid`) ?? '');
	pid = match(pid, /^[0-9]+$/) ? +pid : null;
	let st = stat(`${dir}/out`) ?? stat(dir);
	let age = st ? time() - st.mtime : 0;
	if (rc != '')
		return { running: false, exit: +rc, pid, mtime: st?.mtime };
	// The pid file appears a moment after the directory; until then the job has just started.
	if (pid == null)
		return { running: age < 3, exit: null, pid, mtime: st?.mtime };
	return { running: alive(pid), exit: null, pid, mtime: st?.mtime };
}

// Removes finished jobs older than KEEP seconds, and the oldest ones beyond MAX_JOBS; returns the number running.
function sweep() {
	let ids = filter(lsdir(ROOT) ?? [], valid_id);
	let running = 0, kept = [];
	for (let id in ids) {
		let s = job_state(id);
		if (s.running) {
			running++;
			continue;
		}
		if (s.mtime != null && time() - s.mtime > KEEP)
			run(`rm -rf ${ROOT}/${id}`);
		else
			push(kept, { id, mtime: s.mtime ?? 0 });
	}
	kept = sort(kept, (a, b) => a.mtime - b.mtime);
	while (length(kept) >= MAX_JOBS)
		run(`rm -rf ${ROOT}/${shift(kept).id}`);
	return running;
}

// A new random job id (12 hex digits from /dev/urandom) that has no directory yet, or null.
function new_id() {
	for (let i = 0; i < 5; i++) {
		let id = hexenc(readfile('/dev/urandom', 6) ?? '');
		if (valid_id(id) && mkdir(`${ROOT}/${id}`))
			return id;
	}
	return null;
}

// The name servers the router was told to use by its upstream (the DHCP or PPP server of the ISP), from the
// resolv.conf that netifd writes: addresses only, loopback and duplicates left out, at most four.
function upstream_resolvers() {
	let out = [];
	for (let file in [ '/tmp/resolv.conf.d/resolv.conf.auto', '/tmp/resolv.conf.auto' ]) {
		for (let line in split(readfile(file) ?? '', '\n')) {
			let m = match(line, /^[ \t]*nameserver[ \t]+([0-9A-Fa-f:.]+)[ \t]*$/);
			if (m && is_address(m[1]) && !match(m[1], /^(127\.|::1$)/) && index(out, m[1]) < 0 && length(out) < 4)
				push(out, m[1]);
		}
		if (length(out))
			break;
	}
	return out;
}

// The reply of `status`: which tools exist, which DNS tool is used, the resolvers the router asks upstream, and the
// interface names.
function status() {
	let tools = {};
	for (let t in [ 'ping', 'traceroute', 'nslookup', 'dig', 'kdig', 'drill', 'openssl' ])
		tools[t] = trim(run(`command -v ${t} 2>/dev/null`) ?? '') != '';
	let devices = sort(filter(lsdir('/sys/class/net') ?? [], valid_iface));
	return { generated: time(), tools, dns_tool: dns_tool(), types: TYPES, devices, limits: LIMITS, starttls: STARTTLS, upstream: upstream_resolvers(), check_host: CHECK_HOST };
}

// The reply of `start`: validates the request, then launches the tool in the background.
function start(request) {
	let a = request?.args ?? {};
	let tool = a.tool;
	if (index(TOOLS, tool) < 0)
		return { ok: false, error: 'The tool must be one of ' + join(', ', TOOLS) + '.' };
	// The connectivity check has a default host; every other tool needs one.
	if (tool == 'check' && (a.host == null || a.host == ''))
		a.host = CHECK_HOST;
	if (!valid_host(a.host))
		return { ok: false, error: 'Enter a host name or an IPv4 or IPv6 address.' };
	let built = tool == 'ping' ? build_ping(a) : (tool == 'traceroute' ? build_traceroute(a) : (tool == 'dns' ? build_dns(a)
		: (tool == 'tls' ? build_tls(a) : (tool == 'compare' ? build_compare(a) : build_check(a)))));
	if (built.error != null)
		return { ok: false, error: built.error };

	mkdir(ROOT, 0700);
	if (sweep() >= MAX_RUNNING)
		return { ok: false, error: `${MAX_RUNNING} diagnostics are already running. Stop one or wait for it to end.` };
	let id = new_id();
	if (id == null)
		return { ok: false, error: 'Could not create a job.' };

	// A simple tool is its validated words joined by spaces; a script tool writes its script (built from validated
	// values only) into the job directory and runs that. The subshell records the pid of `timeout` (which forwards a
	// kill to the tool) and the exit code, and is detached from this call.
	let command = built.script != null ? 'sh job.sh' : join(' ', built.argv);
	if (built.script != null)
		// A script is written with LF line endings only: BusyBox sh rejects a carriage return, and the source file may carry CRLF
	// (a Windows checkout) inside the multi-line parts of the templates.
	writefile(`${ROOT}/${id}/job.sh`, replace(built.script, /\r/g, ''));
	run(`cd ${ROOT}/${id} && ( timeout -k 2 ${built.limit} ${command} >out 2>&1 & echo $! >pid; wait $!; echo $? >rc ) </dev/null >/dev/null 2>&1 &`);
	return { ok: true, id, tool, command: built.display ?? command, limit: built.limit, dns_tool: built.tool ?? null, started: time() };
}

// The reply of `read`: the output of a job from byte offset `from`, and whether it still runs.
function read(request) {
	let id = request?.args?.id;
	if (!valid_id(id) || stat(`${ROOT}/${id}`) == null)
		return { ok: false, error: 'There is no such job.' };
	let from = int_in(request.args.from, 0, 100000000, 0) ?? 0;
	let text = readfile(`${ROOT}/${id}/out`, MAX_OUTPUT) ?? '';
	let s = job_state(id);
	return {
		ok: true, id, running: s.running, exit: s.exit,
		size: length(text), text: from < length(text) ? substr(text, from) : '',
		truncated: length(text) >= MAX_OUTPUT,
		timed_out: s.exit == 124 || s.exit == 137,
		stopped: s.exit == 143,
	};
}

// The reply of `stop`: ends a running job (a kill for `timeout`, which passes it on to the tool).
function stop(request) {
	let id = request?.args?.id;
	if (!valid_id(id) || stat(`${ROOT}/${id}`) == null)
		return { ok: false, error: 'There is no such job.' };
	let s = job_state(id);
	if (!s.running)
		return { ok: true, id, running: false };
	// Only a process that is one of our tools (or their `timeout` wrapper, or the shell running one of our job scripts)
	// is killed, so a recycled pid is never hit. busybox records the tool itself for `$!`, and `timeout` passes the kill
	// on, so either name is possible.
	if (s.pid != null) {
		let comm = trim(readfile(`/proc/${s.pid}/comm`) ?? '');
		let cmdline = readfile(`/proc/${s.pid}/cmdline`) ?? '';
		if (index(OURS, comm) >= 0 || (comm == 'sh' && index(cmdline, 'job.sh') >= 0))
			run(`kill ${s.pid} 2>/dev/null`);
	}
	return { ok: true, id, running: false };
}

//#endregion

// rpcd registration: ubus object flab.diag.
return {
	'flab.diag': {
		status: {
			call: function(request) {
				return status();
			},
		},
		start: {
			args: { tool: '', host: '', count: 0, size: 0, hops: 0, probes: 0, resolve: false, family: '', source: '', method: '', type: '', server: '', port: 0, sni: '', starttls: '', servers: [] },
			call: function(request) {
				return start(request);
			},
		},
		read: {
			args: { id: '', from: 0 },
			call: function(request) {
				return read(request);
			},
		},
		stop: {
			args: { id: '' },
			call: function(request) {
				return stop(request);
			},
		},
	},
};
