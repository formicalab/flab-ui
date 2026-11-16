#!/usr/bin/ucode
//
// rpcd ucode plugin that runs network diagnostics (ping, traceroute, mtr, DNS lookups, a DNS trace from the root servers,
// certificate checks) and an iperf3 server as background jobs and streams their output:
//   ubus call flab.diag status
//   ubus call flab.diag start '{"tool":"ping","host":"1.1.1.1","count":4}'
//   ubus call flab.diag start '{"tool":"iperf","minutes":2}'
//   ubus call flab.diag read '{"id":"<id from start>","from":0}'
//   ubus call flab.diag stop '{"id":"<id from start>"}'
//   ubus call flab.diag wake '{"mac":"aa:bb:cc:dd:ee:ff","iface":"br-lan"}'
//
// `wake` is not a job: it sends one Wake-on-LAN magic packet (etherwake when the router has it, else a UDP broadcast
// through socat) and returns at once. The MAC address is validated as six hex pairs and the interface must be a
// safe name of an existing network device before either reaches a command.
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
// DNS comparison, the DNS trace, a traceroute with AS lookups and the connectivity check) write a script owned by this
// plugin into the job directory; the only values in it from the request are the validated words above. The iperf3 server
// is the one job that waits for outside clients: its port is at least 1024, the address it listens on must be one of the
// router's own, only one runs at a time and `timeout` ends it after the minutes chosen.

'use strict';
import { deferred } from 'flab.worker';
import { launch_job, MAX_JOB_OUTPUT } from 'flab.jobs';

import { run, command_result, safe_ifname, uci_all, ubus_call, as_list } from 'flab.util';
import { connect } from 'ubus';
import { mkdir, readfile, writefile, lsdir, stat, access, open } from 'fs';

// Where the jobs live (tmpfs): one directory per job with `out` (the output), `pid` and `rc` (the exit code).
const ROOT = getenv('FLAB_DIAG_ROOT') ?? '/tmp/flab-diag';
// At most this many jobs run at once, and only this many job directories are kept.
const MAX_RUNNING = 3;
const MAX_JOBS = 12;
// Seconds a finished job stays readable.
const KEEP = 600;
// The most output `read` returns in one reply.
const MAX_OUTPUT = 65536;
// The seconds each tool may run before `timeout` ends it. A ping, an mtr run and an iperf3 server have no fixed limit: it
// follows from the number of pings, the cycles or the minutes asked for.
const LIMITS = { ping: 25, traceroute: 60, dns: 15, tls: 25, compare: 60, check: 75, trace: 60, mtr: 15 };
// The tools `start` accepts.
const TOOLS = [ 'ping', 'traceroute', 'dns', 'tls', 'compare', 'check', 'trace', 'mtr', 'iperf' ];
// The protocols s_client can upgrade to TLS in (STARTTLS), and the most servers one comparison asks.
const STARTTLS = [ 'smtp', 'imap', 'pop3', 'ftp' ];
const MAX_SERVERS = 6;
// The name the connectivity check looks up and connects to when none is given.
const CHECK_HOST = 'example.com';
// DNS record types the page offers.
const TYPES = [ 'A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'PTR', 'SRV', 'CAA' ];
// How many pings one run may send, and the range of mtr cycles (one probe per hop and second each).
const MAX_PINGS = 60;
const MTR_CYCLES = [ 3, 60, 10 ];
// The packet sizes mtr accepts here, headers included.
const MTR_SIZE = [ 28, 1400 ];
// The minutes an iperf3 server may stay up (the page offers these), its default port and the lowest port it may use.
const IPERF_MINUTES = [ 1, 2, 5, 15, 30 ];
const IPERF_PORT = 5201;
const IPERF_MIN_PORT = 1024;
// The most hop addresses one traceroute looks up the autonomous system of.
const MAX_ASN = 30;
const MAX_WHOIS = 8;
// The process names of everything a job can run (/proc/<pid>/comm), checked before `stop` sends a kill.
const OURS = [ 'timeout', 'ping', 'ping6', 'traceroute', 'traceroute6', 'nslookup', 'dig', 'kdig', 'drill', 'mtr', 'mtr-packet', 'iperf3' ];

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

// The argument list of a ping from the request: [ argv ] or { error }. The run lasts `count` seconds (one ping a second)
// plus a margin, so the deadline and the time limit follow the count.
function build_ping(a) {
	let count = int_in(a.count, 1, MAX_PINGS, 4), size = int_in(a.size, 0, 1400, 56);
	if (count == null)
		return { error: `The number of pings must be between 1 and ${MAX_PINGS}.` };
	if (size == null)
		return { error: 'The packet size must be between 0 and 1400 bytes.' };
	let argv = [ 'ping', '-c', count, '-W', 2, '-w', count + 5, '-s', size ];
	if (a.family == '4' || a.family == '6')
		push(argv, `-${a.family}`);
	if (a.source != null && a.source != '') {
		if (!is_address(a.source) && !valid_iface(a.source))
			return { error: 'The source must be an address or an interface name.' };
		push(argv, '-I', a.source);
	}
	push(argv, a.host);
	return { argv, limit: count + 10 };
}

//#region iperf3 server

// The router's own addresses with the firewall zone each one is in and what that zone does with traffic addressed to the
// router: [{ iface, device, ip, family, zone, input }] (`input` is the zone's ACCEPT, REJECT or DROP, the firewall default
// when the zone sets none; an interface in no zone gets REJECT, which is what fw4 does with it). Loopback and link-local
// addresses are left out, and so are interfaces that are down.
function own_addresses() {
	let dump = ubus_call(connect(), 'network.interface', 'dump', {}) ?? {};
	let fw = uci_all('firewall');
	let fallback = 'REJECT';
	let zones = [];
	for (let name, s in fw) {
		if (s['.type'] == 'defaults')
			fallback = s.input ?? fallback;
		else if (s['.type'] == 'zone')
			push(zones, s);
	}
	let out = [];
	for (let i in dump.interface ?? []) {
		if (i.interface == 'loopback' || !i.up)
			continue;
		let zone = null;
		for (let z in zones)
			if (index(as_list(z.network), i.interface) >= 0)
				zone = z;
		let base = { iface: i.interface, device: i.l3_device ?? i.device, zone: zone?.name, input: zone ? uc(zone.input ?? fallback) : 'REJECT' };
		for (let a in i['ipv4-address'] ?? [])
			push(out, { ...base, ip: a.address, family: 4 });
		for (let a in i['ipv6-address'] ?? [])
			if (!match(a.address, /^fe[89ab]/i))
				push(out, { ...base, ip: a.address, family: 6 });
	}
	return out;
}

// The names of the firewall zones that masquerade (the ones facing the internet) and still accept traffic addressed to the
// router: a server listening on every address would be reachable from outside through them.
function exposed_zones() {
	let fw = uci_all('firewall');
	let fallback = 'REJECT';
	for (let name, s in fw)
		if (s['.type'] == 'defaults')
			fallback = s.input ?? fallback;
	let out = [];
	for (let name, s in fw)
		if (s['.type'] == 'zone' && (s.masq == '1' || s.name == 'wan') && uc(s.input ?? fallback) == 'ACCEPT')
			push(out, s.name);
	return out;
}

// What the page needs to offer an iperf3 server: the minutes it may run, the default port, the addresses clients would
// connect to, and the zones that would expose it to the internet.
function iperf_info() {
	return { minutes: IPERF_MINUTES, port: IPERF_PORT, min_port: IPERF_MIN_PORT, addresses: own_addresses(), exposed: exposed_zones() };
}

// The argument list of an iperf3 server that stops by itself after the chosen minutes. It prints one JSON event per line
// (--json-stream: the start of a test, an event per second, the end), flushed as it is produced. `bind` may name one of
// the router's own addresses to listen on only that one; without it the server listens on every address and the firewall
// decides who can reach it. Only one server runs at a time.
function build_iperf(a) {
	let minutes = int_in(a.minutes, 1, 30, 2);
	if (minutes == null || index(IPERF_MINUTES, minutes) < 0)
		return { error: 'The server may run for ' + join(', ', IPERF_MINUTES) + ' minutes.' };
	let port = int_in(a.port, IPERF_MIN_PORT, 65535, IPERF_PORT);
	if (port == null)
		return { error: `The port must be between ${IPERF_MIN_PORT} and 65535.` };
	if (trim(run('command -v iperf3 2>/dev/null') ?? '') == '')
		return { error: 'The router has no iperf3.' };
	let argv = [ 'iperf3', '-s', '-p', port, '--json-stream', '--forceflush' ];
	if (a.bind != null && a.bind != '') {
		let own = filter(own_addresses(), (x) => x.ip == a.bind);
		if (!length(own))
			return { error: 'The address to listen on must be one of the router\'s own addresses.' };
		push(argv, '-B', a.bind);
	}
	if (trim(run('pidof iperf3 2>/dev/null') ?? '') != '')
		return { error: 'An iperf3 server is already running on this router. Stop it first.' };
	return { argv, limit: minutes * 60, display: `iperf3 -s -p ${port}` + (a.bind ? ` -B ${a.bind}` : '') + ` (stops after ${minutes} minute${minutes == 1 ? '' : 's'})` };
}

//#endregion

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
// server sent (serial, SHA-256 fingerprint, alternative names, CA flag), each under a `### CERT n` line. s_client lists
// the certificates received, in the order received, even when the router's CA store could complete the chain. `sni` is the
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

// The first of dig and kdig that is installed ('' when neither is): the AS lookups use `+short`, which drill and nslookup
// do not have.
function asn_tool() {
	for (let t in [ 'kdig', 'dig' ])
		if (trim(run(`command -v ${t} 2>/dev/null`) ?? '') != '')
			return t;
	return '';
}

// The awk program that picks the addresses of a traceroute's output that are worth looking up: every public IPv4 and IPv6
// address once, each followed by the name of its Team Cymru origin record (the reversed address under
// origin.asn.cymru.com, or the reversed nibbles under origin6.asn.cymru.com). Private, shared, loopback, link-local and
// multicast addresses are skipped. It contains no single quote, so the shell can wrap it in single quotes.
const ASN_AWK = `function priv4(a,   p) { split(a, p, "."); return (p[1] == 10 || p[1] == 127 || p[1] == 0 || p[1] >= 224 || (p[1] == 172 && p[2] >= 16 && p[2] <= 31) || (p[1] == 192 && p[2] == 168) || (p[1] == 169 && p[2] == 254) || (p[1] == 100 && p[2] >= 64 && p[2] <= 127)) }
function rev4(a,   p) { split(a, p, "."); return p[4] "." p[3] "." p[2] "." p[1] ".origin.asn.cymru.com" }
function rev6(a,   k, head, tail, nh, nt, h, t, i, x, r) {
  k = index(a, "::")
  if (k) { head = substr(a, 1, k - 1); tail = substr(a, k + 2) } else { head = a; tail = "" }
  nh = (head == "") ? 0 : split(head, h, ":")
  nt = (tail == "") ? 0 : split(tail, t, ":")
  x = ""
  for (i = 1; i <= nh; i++) x = x substr("0000" h[i], length(h[i]) + 1)
  if (k) for (i = 1; i <= 8 - nh - nt; i++) x = x "0000"
  for (i = 1; i <= nt; i++) x = x substr("0000" t[i], length(t[i]) + 1)
  r = ""
  for (i = 32; i >= 1; i--) r = r substr(x, i, 1) "."
  return r "origin6.asn.cymru.com"
}
/^###/ { next }
/^traceroute to / { next }
{ for (i = 1; i <= NF; i++) { t = $i; gsub(/[()]/, "", t)
    if (t in seen) continue
    if (t ~ /^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/) { seen[t] = 1; if (!priv4(t)) print t, rev4(t) }
    else if (index(t, ":") && t ~ /^[0-9A-Fa-f:]+$/) { seen[t] = 1; if (t !~ /^(fe[89abAB]|f[cdCD])/ && t != "::1") print t, rev6(t) } } }`;

// The awk program that keeps, of a whois answer, the first object's range, network name, country and first description.
// It contains no single quote.
const WHOIS_AWK = `NF == 0 { if (n) exit; next }
/^%/ { next }
{ n = 1 }
/^(inetnum|inet6num|netname|country):/ || (/^descr:/ && !d) { if (/^descr:/) d = 1; print }`;

// The script of a traceroute or mtr run with AS lookups: the run itself (its output streams as usual, inside a block named
// `id`, for `seconds`), then
// for each public address that answered a TXT lookup of its origin record at Team Cymru (`asn` blocks: the AS number, the
// prefix and the registry), for the first MAX_WHOIS of those without an origin (an address no AS announces, such as an
// operator's own infrastructure range) a whois query to RIPE for the registered network name (`net` blocks), then one
// lookup per distinct AS number for its name (`asname` blocks). `argv` is the
// validated traceroute or mtr command, `tool` dig or kdig.
function trace_asn_script(tool, argv, id, seconds) {
	let s = PRELUDE;
	s += `set -f\nblk ${id}\nrun ${seconds} ${join(' ', map(argv, (w) => `'${w}'`))}\n`;
	s += `awk '${ASN_AWK}' out > ips.all\nhead -n ${MAX_ASN} ips.all > ips.txt\n: > asns.txt\nnw=0\n`;
	s += `while read ip rev; do\n  blk asn "$ip"\n  cap a.out 4 ${tool} +short TXT "$rev"\n  rc=$?\n  cat a.out\n  end $rc\n`;
	s += `  awk -F'|' 'NR == 1 { gsub(/[^0-9]/, "", $1); if ($1 != "") print $1 }' a.out >> asns.txt\n`;
	s += `  if ! grep -q '^"[0-9]' a.out && [ $nw -lt ${MAX_WHOIS} ]; then\n    nw=$((nw + 1))\n    blk net "$ip"\n`;
	s += `    cap w.out 6 sh -c '(printf "%s\\n" "$0"; sleep 1) | nc -w 4 whois.ripe.net 43' "$ip" </dev/null\n    rc=$?\n    awk '${WHOIS_AWK}' w.out\n    end $rc\n  fi\ndone < ips.txt\n`;
	s += `for asn in $(sort -u asns.txt); do\n  blk asname "$asn"\n  cap n.out 4 ${tool} +short TXT "AS$asn.asn.cymru.com"\n  rc=$?\n  cat n.out\n  end $rc\ndone\n`;
	return s;
}

// The awk program that reads one answer of a DNS query and says what the trace does next, one line per candidate: `done`
// (an answer, or a negative answer from the authority), `fail <rcode>` (REFUSED, SERVFAIL, ...), `cname <target>` (the
// answer is an alias to start over for), or the name servers of a referral, those with an address in the additional
// section first as `next <address> <name> <zone>`, then the others as `lookup <name> <zone>`. `want` is the record type
// asked for, `fam` the -4 or -6 that picks which glue addresses count. It contains no single quote.
const TRACE_AWK = `/^;; ->>HEADER<<-/ { st = $0; sub(/.*status: /, "", st); sub(/;.*/, "", st); next }
/^;; ANSWER SECTION:/ { s = "an"; next }
/^;; AUTHORITY SECTION:/ { s = "au"; next }
/^;; ADDITIONAL SECTION:/ { s = "ad"; next }
/^;/ { s = ""; next }
NF < 5 { next }
s == "an" && $4 != "RRSIG" { an++; if ($4 == want) hit = 1; else if ($4 == "CNAME") cn = $5 }
s == "au" && $4 == "NS" { ns[++nn] = $5; zone = $1 }
s == "ad" && (($4 == "A" && fam == "-4") || ($4 == "AAAA" && fam == "-6")) { if (!($1 in glue)) glue[$1] = $5 }
END {
  if (st == "REFUSED" || st == "SERVFAIL" || st == "FORMERR" || st == "NOTIMP") { print "fail " st; exit }
  if (hit) { print "done"; exit }
  if (an && cn) { print "cname " cn; exit }
  if (an || !nn) { print "done"; exit }
  for (i = 1; i <= nn; i++) if (ns[i] in glue) print "next " glue[ns[i]] " " ns[i] " " zone
  for (i = 1; i <= nn; i++) if (!(ns[i] in glue)) print "lookup " ns[i] " " zone
}`;

// The body of the DNS trace script (the name, the record type and the address family are set in front of it). It asks a
// root server, then follows the referrals down to the server that answers, one `step` block per query (the raw answer of
// kdig, which prints who answered and how long it took), a `lookup` block for a name server that came without an address
// (asked of the router's own resolver), a `cname` block when the answer is an alias and the trace starts over for its
// target, and at the end a `resolver` block with what the router's own resolver says. A server that does not answer is
// replaced by the next one of the same referral; three failures in a row end the trace. Names that came from the network
// are only ever used inside double quotes and never start a command line option.
const TRACE_BODY = `set -f
roots() {
  if [ "$F" = "-6" ]; then
    { echo "next 2001:503:ba3e::2:30 a.root-servers.net ."; echo "next 2001:500:2::c c.root-servers.net ."; echo "next 2001:500:2f::f f.root-servers.net ."; echo "next 2001:dc3::35 m.root-servers.net ."; } > cand
  else
    { echo "next 198.41.0.4 a.root-servers.net ."; echo "next 192.33.4.12 c.root-servers.net ."; echo "next 192.5.5.241 f.root-servers.net ."; echo "next 202.12.27.33 m.root-servers.net ."; } > cand
  fi
}
if [ "$F" = "-6" ]; then RT=AAAA; else RT=A; fi
n=0; cn=0; fails=0
roots
while [ $n -lt 18 ] && [ -s cand ]; do
  line=$(head -n 1 cand)
  tail -n +2 cand > cand.t; mv cand.t cand
  set -- $line
  if [ "$1" = "lookup" ]; then
    case "$2" in -*) continue ;; esac
    blk lookup "$2" "$3"
    cap l.out 6 kdig +short "$2" $RT
    rc=$?
    cat l.out
    end $rc
    addr=$(grep -E '^[0-9a-fA-F:.]+$' l.out | head -n 1)
    if [ -z "$addr" ]; then continue; fi
    set -- next "$addr" "$2" "$3"
  fi
  n=$((n + 1))
  blk step "$n" "$2" "$3" "$4"
  cap q.out 6 kdig $F +norecurse +dnssec +time=3 +retry=0 "@$2" "$Q" "$T"
  rc=$?
  cat q.out
  end $rc
  if [ $rc -ne 0 ]; then
    fails=$((fails + 1))
    if [ $fails -ge 3 ]; then break; fi
    continue
  fi
  fails=0
  awk -v want="$T" -v fam="$F" '${TRACE_AWK}' q.out > dec
  kind=$(head -n 1 dec | cut -d' ' -f1)
  case "$kind" in
    next|lookup) cp dec cand ;;
    cname)
      cn=$((cn + 1))
      if [ $cn -gt 4 ]; then break; fi
      Q=$(head -n 1 dec | cut -d' ' -f2)
      case "$Q" in -*) break ;; esac
      blk cname "$Q"
      end 0
      roots ;;
    *) break ;;
  esac
done
blk resolver "$O"
cap r.out 8 kdig +dnssec +time=3 +retry=0 "$O" "$T"
rc=$?
cat r.out
end $rc
`;

// The script of the DNS trace for `name` and record type `type_` (a validated name and an allow-listed type) over IPv4
// (`fam` is -4) or IPv6 (-6).
function trace_script(name, type_, fam) {
	return PRELUDE + `Q='${name}'\nO='${name}'\nT='${type_}'\nF=${fam}\n` + TRACE_BODY;
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

// The argument list of a traceroute. Output is numeric unless `resolve` is true: busybox then looks up a host name for
// every router that answers, which can slow a trace down when the resolver is slow or has no reverse records. With
// `asn` set the tool becomes a script that follows the trace with the AS lookups of the routers that answered.
function build_traceroute(a) {
	let hops = int_in(a.hops, 1, 30, 20), probes = int_in(a.probes, 1, 3, 2);
	if (hops == null)
		return { error: 'The maximum number of hops must be between 1 and 30.' };
	if (probes == null)
		return { error: 'The number of probes per hop must be between 1 and 3.' };
	if (a.resolve != null && a.resolve !== true && a.resolve !== false)
		return { error: 'Resolving names must be true or false.' };
	if (a.asn != null && a.asn !== true && a.asn !== false)
		return { error: 'Looking up the networks must be true or false.' };
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
	if (a.asn !== true)
		return { argv, limit: LIMITS.traceroute };
	let tool = asn_tool();
	if (tool == '')
		return { error: 'Looking up the networks needs dig or kdig, which this router does not have.' };
	return { script: trace_asn_script(tool, argv, 'trace', LIMITS.traceroute), limit: LIMITS.traceroute + MAX_ASN * 2 + MAX_WHOIS * 6, display: join(' ', argv) + ' (with AS lookups)' };
}

// The argument list of an mtr run: `cycles` rounds of one probe per hop, in raw mode (a line per probe, which the page
// turns into the live table). Addresses only unless `resolve` is true: a name lookup per hop slows the first rounds down.
// The method is ICMP (the default), UDP or TCP SYN; a port applies to the last two, a packet size to all but TCP, and a
// source is an address (-a) or an interface (-I). With `asn` set the run becomes a script that follows it with the AS
// lookups of the routers that answered, as a traceroute does.
function build_mtr(a) {
	let cycles = int_in(a.cycles, MTR_CYCLES[0], MTR_CYCLES[1], MTR_CYCLES[2]);
	if (cycles == null)
		return { error: `The number of rounds must be between ${MTR_CYCLES[0]} and ${MTR_CYCLES[1]}.` };
	let method = a.method == null || a.method == '' ? 'icmp' : a.method;
	if (index([ 'icmp', 'udp', 'tcp' ], method) < 0)
		return { error: 'The method must be icmp, udp or tcp.' };
	// 0 stands for "not given": int_in returns it only for an absent value, and a literal 0 is out of range.
	let port = int_in(a.port, 1, 65535, 0);
	if (port == null)
		return { error: 'The port must be between 1 and 65535.' };
	if (port != 0 && method == 'icmp')
		return { error: 'A port needs UDP or TCP probes.' };
	let size = int_in(a.size, MTR_SIZE[0], MTR_SIZE[1], 0);
	if (size == null)
		return { error: `The packet size must be between ${MTR_SIZE[0]} and ${MTR_SIZE[1]} bytes.` };
	if (size != 0 && method == 'tcp')
		return { error: 'TCP probes carry no payload, so they have no packet size.' };
	if (a.resolve != null && a.resolve !== true && a.resolve !== false)
		return { error: 'Resolving names must be true or false.' };
	if (a.asn != null && a.asn !== true && a.asn !== false)
		return { error: 'Looking up the networks must be true or false.' };
	if (trim(run('command -v mtr 2>/dev/null') ?? '') == '')
		return { error: 'The router has no mtr.' };
	let argv = [ 'mtr', '--raw', '-c', cycles, '-i', 1, '-G', 2 ];
	if (a.resolve !== true)
		splice(argv, 2, 0, '-n');
	if (a.family == '4' || a.family == '6')
		push(argv, `-${a.family}`);
	if (method == 'udp')
		push(argv, '-u');
	else if (method == 'tcp')
		push(argv, '-T');
	if (port != 0)
		push(argv, '-P', port);
	if (size != 0)
		push(argv, '-s', size);
	if (a.source != null && a.source != '') {
		if (is_address(a.source))
			push(argv, '-a', a.source);
		else if (valid_iface(a.source))
			push(argv, '-I', a.source);
		else
			return { error: 'The source must be an address or an interface name.' };
	}
	push(argv, a.host);
	let limit = cycles + 15;
	if (a.asn !== true)
		return { argv, limit };
	let tool = asn_tool();
	if (tool == '')
		return { error: 'Looking up the networks needs dig or kdig, which this router does not have.' };
	return { script: trace_asn_script(tool, argv, 'mtr', limit), limit: limit + MAX_ASN * 2 + MAX_WHOIS * 6, display: join(' ', argv) + ' (with AS lookups)' };
}

// The DNS trace: the name, a record type and the address family (4 or 6, default 4). It needs kdig, whose output names the
// server that answered and the time it took.
function build_trace(a) {
	if (trim(run('command -v kdig 2>/dev/null') ?? '') == '')
		return { error: 'The DNS trace needs kdig (knot-dig), which this router does not have.' };
	let type_ = a.type == null || a.type == '' ? 'A' : uc(a.type);
	if (index(TYPES, type_) < 0)
		return { error: 'The record type is not one of ' + join(', ', TYPES) + '.' };
	let fam = a.family == '6' ? '-6' : '-4';
	return { script: trace_script(a.host, type_, fam), limit: LIMITS.trace, tool: 'kdig', display: `DNS trace ${a.host} ${type_}` };
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

// The reply of `start`: validates the request, then launches the tool in the background.
function start(request) {
	let a = request?.args ?? {};
	let tool = a.tool;
	if (index(TOOLS, tool) < 0)
		return { ok: false, error: 'The tool must be one of ' + join(', ', TOOLS) + '.' };
	// The connectivity check has a default host; the iperf3 server has none; every other tool needs one.
	if (tool == 'check' && (a.host == null || a.host == ''))
		a.host = CHECK_HOST;
	if (tool != 'iperf' && !valid_host(a.host))
		return { ok: false, error: 'Enter a host name or an IPv4 or IPv6 address.' };
	let builders = { ping: build_ping, traceroute: build_traceroute, dns: build_dns, tls: build_tls, compare: build_compare, check: build_check, trace: build_trace, mtr: build_mtr, iperf: build_iperf };
	let built = builders[tool](a);
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
	let launched = command_result(`cd ${ROOT}/${id} || exit 1\n${launch_job(command, built.limit)}`);
	if (!launched.ok)
		return { ok: false, error: 'Could not launch the diagnostic job.' };
	return { ok: true, id, tool, command: built.display ?? command, limit: built.limit, max_output: MAX_JOB_OUTPUT, dns_tool: built.tool ?? null, started: time() };
}

// The reply of `read`: the output of a job from byte offset `from` (at most MAX_OUTPUT bytes, ending at a line break when
// there is more to come), and whether it still runs. `size` is the offset to ask for next, so a job whose output outgrows
// one reply (an iperf3 server that stays up for minutes) is read in pieces.
function read(request) {
	let id = request?.args?.id;
	if (!valid_id(id) || stat(`${ROOT}/${id}`) == null)
		return { ok: false, error: 'There is no such job.' };
	let path = `${ROOT}/${id}/out`;
	let total = stat(path)?.size ?? 0;
	let from = int_in(request.args.from, 0, 1000000000, 0) ?? 0;
	if (from > total)
		from = total;
	let text = '';
	if (from < total) {
		let f = open(path, 'r');
		if (f != null) {
			f.seek(from);
			text = f.read(MAX_OUTPUT) ?? '';
			f.close();
		}
		// A reply that stops short of the end of the output ends at a line break, so no line (and no multi-byte character)
		// is split between two replies.
		if (from + length(text) < total) {
			let cut = rindex(text, '\n');
			if (cut >= 0)
				text = substr(text, 0, cut + 1);
		}
	}
	let s = job_state(id);
	return {
		ok: true, id, running: s.running, exit: s.exit,
		size: from + length(text), text,
		truncated: from + length(text) < total,
		output_limited: stat(`${ROOT}/${id}/truncated`) != null,
		max_output: MAX_JOB_OUTPUT,
		timed_out: stat(`${ROOT}/${id}/timed_out`) != null || s.exit == 124 || s.exit == 137,
		stopped: s.exit == 143 && stat(`${ROOT}/${id}/timed_out`) == null && stat(`${ROOT}/${id}/truncated`) == null,
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

//#region Wake-on-LAN

// The most hosts `status` lists for Wake-on-LAN.
const MAX_HOSTS = 300;

// A MAC address written as six hex pairs separated by ":" or "-", as lowercase pairs joined by ":"; null for anything else.
function norm_mac(s) {
	if (!whole(s, /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/))
		return null;
	return lc(replace(s, '-', ':'));
}

// How a magic packet can be sent from this router: "etherwake" (a raw Ethernet frame), "socat" (a UDP broadcast to
// port 9) or "" when neither is installed.
function wol_method() {
	for (let t in [ 'etherwake', 'socat' ])
		if (trim(run(`command -v ${t} 2>/dev/null`) ?? '') != '')
			return t;
	return '';
}

// The hosts a magic packet can be sent to, as [{ mac, name, ip, dev, reserved }] sorted by name then address. The MACs come
// from the static DHCP hosts (`reserved`: true), the leases (odhcpd through ubus, dnsmasq's lease file), /etc/ethers and the
// ARP table; `dev` is the interface a host was last seen on (ARP), which is where its packet has to go.
function wol_hosts() {
	let by = {};
	// Records a field of a host; the first non-empty value for a field wins, so the sources are listed by precedence.
	let put = (mac, field, value) => {
		mac = norm_mac(mac ?? '');
		if (mac == null || value == null || value == '')
			return;
		by[mac] ??= { mac };
		by[mac][field] ??= '' + value;
	};
	for (let name, s in uci_all('dhcp')) {
		if (s['.type'] != 'host' || s.mac == null)
			continue;
		for (let mac in (type(s.mac) == 'array' ? s.mac : split(s.mac, /[ \t]+/))) {
			put(mac, 'name', s.name);
			put(mac, 'ip', s.ip);
			// A static DHCP host is a reservation: the router hands this host this address, so it is the list's first choice.
			let key = norm_mac(mac);
			if (key != null) {
				by[key] ??= { mac: key };
				by[key].reserved = true;
			}
		}
	}
	let v4 = ubus_call(connect(), 'dhcp', 'ipv4leases', {}) ?? {};
	for (let dev, d in v4.device ?? {})
		for (let l in d.leases ?? []) {
			put(l.mac, 'name', l.hostname);
			put(l.mac, 'ip', l.address);
		}
	for (let line in split(readfile('/tmp/dhcp.leases') ?? '', '\n')) {
		let f = split(trim(line), /[ \t]+/);
		if (length(f) >= 4 && index(f[2], ':') < 0) {
			put(f[1], 'name', f[3] == '*' ? null : f[3]);
			put(f[1], 'ip', f[2]);
		}
	}
	for (let line in split(readfile('/etc/ethers') ?? '', '\n')) {
		let f = split(trim(line), /[ \t]+/);
		if (length(f) >= 2 && substr(f[0], 0, 1) != '#') {
			put(f[0], is_address(f[1]) ? 'ip' : 'name', f[1]);
		}
	}
	let arp = split(readfile('/proc/net/arp') ?? '', '\n');
	for (let i = 1; i < length(arp); i++) {
		let f = split(trim(arp[i]), /[ \t]+/);
		// Flag 0x2 is a complete entry; an incomplete one has the all-zero MAC.
		if (length(f) >= 6 && (hex(substr(f[2], 2)) & 2) && valid_iface(f[5])) {
			put(f[3], 'ip', f[0]);
			put(f[3], 'dev', f[5]);
		}
	}
	let key = (h) => lc(h.name ?? '~');
	let list = sort(values(by), (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : (a.ip ?? '') < (b.ip ?? '') ? -1 : 1);
	return length(list) > MAX_HOSTS ? slice(list, 0, MAX_HOSTS) : list;
}

// The bytes of a magic packet for `mac` (six 0xff, then the MAC sixteen times) as the escapes `printf` turns back into bytes.
function magic_format(mac) {
	let bytes = split(mac, ':');
	let s = '\\xff\\xff\\xff\\xff\\xff\\xff';
	for (let i = 0; i < 16; i++)
		for (let b in bytes)
			s += '\\x' + b;
	return s;
}

// The reply of `wake`: sends a magic packet for a MAC address out of an interface (the one the host was last seen on, or
// br-lan, when none is given).
function wake(request) {
	let a = request?.args ?? {};
	let mac = norm_mac(a.mac);
	if (mac == null)
		return { ok: false, error: 'Enter a MAC address such as aa:bb:cc:dd:ee:ff.' };
	let method = wol_method();
	if (method == '')
		return { ok: false, error: 'The router has neither etherwake nor socat, so it cannot send a magic packet.' };
	let devices = lsdir('/sys/class/net') ?? [];
	let iface = a.iface;
	if (iface == null || iface == '') {
		iface = null;
		for (let h in wol_hosts())
			if (h.mac == mac && h.dev != null)
				iface = h.dev;
		if (iface == null && index(devices, 'br-lan') >= 0)
			iface = 'br-lan';
		if (iface == null)
			return { ok: false, error: 'Choose the interface the host is connected to.' };
	}
	if (!valid_iface(iface) || index(devices, iface) < 0)
		return { ok: false, error: 'The interface must be a network device of this router.' };

	let command, display;
	if (method == 'etherwake') {
		command = `timeout 5 etherwake -i '${iface}' '${mac}' 2>&1`;
		display = `etherwake -i ${iface} ${mac}`;
	} else {
		command = `printf '${magic_format(mac)}' | timeout 5 socat - UDP-DATAGRAM:255.255.255.255:9,broadcast,so-bindtodevice=${iface} 2>&1`;
		display = `UDP broadcast to 255.255.255.255:9 on ${iface} (socat)`;
	}
	let result = command_result(command, { timeout: 7, max_output: 4096 });
	let output = trim(result.output);
	if (!result.ok)
		return { ok: false, error: output != '' ? output : 'The magic packet could not be sent.', method, iface, mac, command: display };
	return { ok: true, mac, iface, method, command: display, output, sent: time() };
}

//#endregion

//#region Status

// The reply of `status`: which tools exist, which DNS tool is used, the resolvers the router asks upstream, the
// interface names, how a Wake-on-LAN packet can be sent and the hosts it can be sent to, and (when iperf3 is installed)
// what an iperf3 server needs to be offered.
function status() {
	let tools = {};
	for (let t in [ 'ping', 'traceroute', 'nslookup', 'dig', 'kdig', 'drill', 'openssl', 'mtr', 'iperf3' ])
		tools[t] = trim(run(`command -v ${t} 2>/dev/null`) ?? '') != '';
	let devices = sort(filter(lsdir('/sys/class/net') ?? [], valid_iface));
	return {
		generated: time(), tools, dns_tool: dns_tool(), asn: asn_tool() != '', types: TYPES, devices, limits: LIMITS, max_pings: MAX_PINGS, mtr_cycles: MTR_CYCLES,
		starttls: STARTTLS, upstream: upstream_resolvers(), check_host: CHECK_HOST, wol: wol_method(), hosts: wol_hosts(), iperf: tools.iperf3 ? iperf_info() : null,
	};
}

//#endregion

// rpcd registration: ubus object flab.diag.
return deferred({
	'flab.diag': {
		status: {
			call: function(request) {
				return status();
			},
		},
		start: {
			args: { tool: '', host: '', count: 0, size: 0, hops: 0, probes: 0, resolve: false, asn: false, family: '', source: '', method: '', type: '', server: '', port: 0, sni: '', starttls: '', servers: [], cycles: 0, minutes: 0, bind: '' },
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
		wake: {
			args: { mac: '', iface: '' },
			call: function(request) {
				return wake(request);
			},
		},
	},
});
