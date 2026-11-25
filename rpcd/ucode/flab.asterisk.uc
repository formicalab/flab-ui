#!/usr/bin/ucode
//
// rpcd ucode plugin reporting the Asterisk PBX as JSON: ubus call flab.asterisk status|pjsip|endpoint|dialplan|resolve|config|calls|active|reload
//
// Everything is read only except `reload` (three fixed reload commands). Sources:
//   - the Asterisk CLI (`asterisk -rx '<command>'`, over the control socket): core status, PJSIP registrations, endpoints, contacts and
//     transports, the active channels, the loaded dialplan, and `dialplan show <exten>@<context>` to resolve a dialed number
//   - /etc/asterisk/*.conf and /etc/config/asterisk (secrets redacted), /var/log/asterisk/messages.log (the recent warnings and errors) and
//     /var/log/asterisk/cdr-csv/Master.csv (the call history written by cdr_csv.so)
//   - /var/run/asterisk/asterisk.pid and /proc/<pid>/status (is it alive, how much memory)
//
// Asterisk's CLI has no machine-readable output, so the human-readable text is parsed. The parsers ignore lines they do not know, so a newer
// Asterisk only loses fields instead of breaking the page. Every command goes through flab.exec (bounded in time and output); a test sets
// FLAB_FIXTURES=<dir> to replay saved output (see tests/asterisk). rpcd runs plugins in-process; this plugin calls no ubus objects.

'use strict';

import { deferred } from 'flab.worker';
import { readfile, writefile, stat, open, lsdir } from 'fs';
import { command_result, fixture_time, sysfs, uci_all, record_file } from 'flab.util';

const BINARY = '/usr/sbin/asterisk';
const CONF_DIR = '/etc/asterisk';
const UCI_FILE = '/etc/config/asterisk';
const PID_FILE = '/var/run/asterisk/asterisk.pid';
const LOG_FILE = '/var/log/asterisk/messages.log';
// Seconds one CLI command may take.
const CLI_TIMEOUT = 10;
// The most bytes of CLI output kept per command, and of one configuration file returned.
const MAX_OUTPUT = 262144;
const MAX_CONFIG = 262144;
// The most bytes read from the end of the log, and the most problems returned.
const MAX_LOG_TAIL = 131072;
const MAX_PROBLEMS = 30;
// The most endpoints, registrations and transports that get a detail query (one CLI call each) in `pjsip`.
const MAX_DETAIL = 40;
const MAX_TRANSPORT_DETAIL = 8;

// Test seam: with FLAB_FIXTURES=<dir> set (never the case inside rpcd) saved output is read instead of running the CLI (flab.exec
// names the files), and the plugin's own file reads come from <dir>/file_*.txt. With FLAB_RECORD=<dir> the real files are saved too.
const FIXTURES = getenv('FLAB_FIXTURES');
const RECORD = getenv('FLAB_RECORD');
const slug = (s) => replace(s, /[^A-Za-z0-9]+/g, '_');

//#region commands and files

// The result of one CLI command: { ok, output, truncated }. The command text must be a constant or built from validated names (no quote).
function cli_result(cmd, max) {
	let r = command_result(`${BINARY} -rx '${cmd}' 2>/dev/null`, { timeout: CLI_TIMEOUT, max_output: max ?? MAX_OUTPUT });
	return { ok: r.ok, output: r.output ?? '', truncated: r.truncated };
}

// The output of a CLI command, or null when Asterisk did not answer (not running, no control socket, timeout).
function cli(cmd, max) {
	let r = cli_result(cmd, max);
	return r.ok ? r.output : null;
}

// Whether the asterisk program is installed (an `installed.txt` holding 0 says no in the test seam).
function installed() {
	return FIXTURES ? trim(readfile(`${FIXTURES}/installed.txt`) ?? '1') != '0' : stat(BINARY) != null;
}

// Text and size/mtime of a file, or null when it cannot be read. `tail` reads only the last MAX_LOG_TAIL bytes.
function read_file(path, limit, tail) {
	let name = slug(path);
	if (FIXTURES) {
		let text = readfile(`${FIXTURES}/file_${name}.txt`);
		if (text == null)
			return null;
		let meta = json(readfile(`${FIXTURES}/file_${name}.meta.json`) ?? '{}');
		return { text, size: meta.size ?? length(text), mtime: meta.mtime ?? fixture_time() };
	}
	let st = stat(path);
	if (!st || st.type != 'file')
		return null;
	let text;
	if (tail && st.size > limit) {
		let f = open(path);
		if (!f)
			return null;
		f.seek(st.size - limit);
		text = f.read(limit);
		f.close();
		// The first line is cut in the middle.
		let nl = index(text ?? '', '\n');
		text = nl >= 0 ? substr(text, nl + 1) : text;
	}
	else {
		text = readfile(path, limit + 1);
	}
	if (text == null)
		return null;
	if (RECORD) {
		record_file(`file_${name}.txt`, text);
		record_file(`file_${name}.meta.json`, sprintf('%J', { size: st.size, mtime: st.mtime }));
	}
	return { text, size: st.size, mtime: st.mtime };
}

// Normalized object key for a label: lower case, runs of non-alphanumerics become "_" ("Maximum calls" -> "maximum_calls").
function key_of(text) {
	return lc(replace(trim(text), /[^A-Za-z0-9]+/g, '_'));
}

// Numeric value, or null for anything else.
function number_or_null(v) {
	return (v != null && match(v, /^-?[0-9]+(\.[0-9]+)?$/)) ? +v : null;
}

// The lines of a command output after its "=====" separator (the table body).
function table_lines(text) {
	let out = [], seen = false;
	for (let line in split(text ?? '', '\n')) {
		if (!seen) {
			if (match(line, /^[ ]*={10,}[ ]*$/))
				seen = true;
			continue;
		}
		push(out, line);
	}
	return out;
}

// Whether an object name may be passed to the CLI: a plain PJSIP/dialplan identifier, no quote, no space, no leading "-".
function safe_name(name) {
	return type(name) == 'string' && length(name) > 0 && length(name) <= 80 && index(name, '\n') < 0 &&
		match(name, /^[A-Za-z0-9_.@+:*#-]+$/) != null && substr(name, 0, 1) != '-';
}
//#endregion

//#region redaction

// Words that mark a configuration option or dialplan variable as secret when they are a whole `_`-separated part of its name.
const SECRET_NAME = /(^|_)(pin|pass|passwd|password|passcode|secret|token|apikey|credential|cred)(_|$)/;

function secret_name(name) {
	return match(lc(name ?? ''), SECRET_NAME) != null;
}

// `text` of one dialplan application call or expression with the secrets hidden: the argument of Authenticate and DISA, the value Set()
// gives to a variable named like a secret, and the literal such a variable is compared with ($["${PIN}" = "3003"]; an empty literal or
// another variable, as in $["${PIN}" = "${REMOTE_ACCESS_PIN}"], hides nothing). `counter.n` counts
// what was hidden. This is best effort: a secret that has no telltale name cannot be recognized.
function redact_data(text, counter) {
	text = replace(text, /(Authenticate|DISA)\(([^,)]*)/gi, (all, app, arg) => {
		if (arg == '' || arg == '<redacted>')
			return all;
		counter.n++;
		return `${app}(<redacted>`;
	});
	text = replace(text, /(Set|MSet)\(([A-Za-z0-9_]+)=([^,)]*)/gi, (all, app, name, value) => {
		if (!secret_name(name) || value == '' || value == '<redacted>')
			return all;
		counter.n++;
		return `${app}(${name}=<redacted>`;
	});
	text = replace(text, /\$\{([A-Za-z0-9_]+)\}"?[ ]*(==|=|!=)[ ]*("[^"]*"|[^ "?)]+)/g, (all, name, op, rhs) => {
		if (!secret_name(name) || rhs == '"<redacted>"' || rhs == '""' || index(rhs, '${') >= 0)
			return all;
		counter.n++;
		return substr(all, 0, length(all) - length(rhs)) + '"<redacted>"';
	});
	return text;
}

// A whole configuration file with the secrets hidden: the value of `password`, `secret` and the like, and what redact_data() hides in
// dialplan lines. Only the text inside a line changes, so line numbers stay valid. Returns { text, count }.
function redact_config(text) {
	let counter = { n: 0 };
	let lines = split(text, '\n');
	for (let i = 0; i < length(lines); i++) {
		let m = match(lines[i], /^([ \t]*)([A-Za-z0-9_.-]+)([ \t]*=>?[ \t]*)(.*)$/);
		if (m && secret_name(m[2]) && trim(m[4]) != '' && trim(m[4]) != '<redacted>') {
			lines[i] = `${m[1]}${m[2]}${m[3]}<redacted>`;
			counter.n++;
		}
		else {
			lines[i] = redact_data(lines[i], counter);
		}
	}
	return { text: join('\n', lines), count: counter.n };
}
//#endregion

//#region parsers

// `core show uptime seconds` -> { uptime, reload } in seconds (reload = seconds since the last reload).
function parse_uptime(text) {
	let up = match(text ?? '', /System uptime: ([0-9]+)/), rl = match(text ?? '', /Last reload: ([0-9]+)/);
	return { uptime: up ? +up[1] : null, reload: rl ? +rl[1] : null };
}

// `core show settings` -> { values: { key: text }, directories } with the keys of key_of().
function parse_settings(text) {
	let v = {};
	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^[ ]+([A-Za-z][^:]*):[ ]+(.*)$/);
		if (m)
			v[key_of(m[1])] = trim(m[2]);
	}
	return v;
}

// `module show` -> [{ name, desc, use, status, support }]. The description column overflows for long names, so each line is read from the
// right: use count, status and support level are single words.
function parse_modules(text) {
	let out = [];
	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^([A-Za-z0-9_.-]+\.so)[ ]+(.*[^ ])[ ]+([0-9]+)[ ]+(Running|Not Running|Failed)[ ]+([A-Za-z]+)[ ]*$/);
		if (m)
			push(out, { name: m[1], desc: m[2], use: +m[3], status: m[4], support: m[5] });
	}
	return out;
}

// `core show calls` -> { active, processed }.
function parse_calls(text) {
	let a = match(text ?? '', /([0-9]+) active calls?/), p = match(text ?? '', /([0-9]+) calls? processed/);
	return { active: a ? +a[1] : null, processed: p ? +p[1] : null };
}

// `logger show channels` -> [{ channel, type, status, levels: [..] }].
function parse_logger(text) {
	let out = [];
	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^(.+[^ ])[ ]+(File|Console|Syslog)[ ]+([^ ]+)[ ]+(Enabled|Disabled)[ ]+-[ ]?(.*)$/);
		if (m)
			push(out, { channel: m[1], type: m[2], status: m[4], levels: filter(split(trim(m[5]), /[ ]+/), (x) => x != '') });
	}
	return out;
}

// `cdr show status` -> { enabled, backends: [names] }.
function parse_cdr(text) {
	let en = match(text ?? '', /Logging:[ ]+(Enabled|Disabled)/), backends = [], in_list = false;
	for (let line in split(text ?? '', '\n')) {
		if (match(line, /Registered Backends/)) {
			in_list = true;
			continue;
		}
		let m = in_list ? match(line, /^[ ]{4}([A-Za-z0-9_.-]+)[ ]*$/) : null;
		if (m)
			push(backends, m[1]);
	}
	return { enabled: en ? en[1] == 'Enabled' : null, backends };
}

// `pjsip show registrations` or `pjsip list registrations` -> [{ name, server_uri, auth, status, expires }].
function parse_registrations(text) {
	let out = [];
	for (let line in table_lines(text)) {
		let m = match(line, /^[ ]+([^ \/]+)\/([^ ]+)[ ]+([^ ]+)[ ]+([A-Za-z]+)([ ]+\(exp\. ([0-9]+)s\))?[ ]*$/);
		if (m)
			push(out, { name: m[1], server_uri: m[2], auth: m[3], status: m[4], expires: number_or_null(m[6]) });
	}
	return out;
}

// `pjsip show transports` -> [{ name, type, cos, tos, bind }].
function parse_transports(text) {
	let out = [];
	for (let line in table_lines(text)) {
		let m = match(line, /^Transport:[ ]+([^ ]+)[ ]+([a-z0-9]+)[ ]+([0-9]+)[ ]+([0-9]+)[ ]+(.*[^ ])[ ]*$/);
		if (m)
			push(out, { name: m[1], type: m[2], cos: +m[3], tos: +m[4], bind: m[5] });
	}
	return out;
}

// The rows of a "ParameterName : ParameterValue" table -> [{ name, value }] (a repeated name gives repeated rows). Secrets are hidden.
function parse_params(text) {
	let out = [];
	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^ ([A-Za-z0-9_]+)[ ]+:[ ]?(.*)$/);
		if (!m || m[1] == 'ParameterName')
			continue;
		push(out, { name: m[1], value: (secret_name(m[1]) && trim(m[2]) != '') ? '<redacted>' : trim(m[2]) });
	}
	return out;
}

// The value of parameter `name` of a parse_params() result, or null.
function param(params, name) {
	for (let p in params)
		if (p.name == name)
			return p.value;
	return null;
}

// Every value of a parameter that repeats (local_net).
function param_all(params, name) {
	return map(filter(params, (p) => p.name == name), (p) => p.value);
}

// `pjsip show endpoints` -> [{ name, callerid, state, channels, max_channels, auths, aors, contacts, transport, identifies, calls }].
// Each endpoint is a block: the "Endpoint:" line, then its auths, AORs (with their contacts), transport, identifies (with their match
// criteria) and active channels. The pattern for each line is the one in the table header of the same output.
function parse_endpoints(text) {
	let out = [], ep = null, aor = null, ident = null, call = null;
	for (let line in table_lines(text)) {
		let m;
		if ((m = match(line, /^ Endpoint:[ ]+(.*[^ ])[ ]+(Unavailable|Not in use|In use|Busy|Ringing|Ring\+Inuse|On Hold|Invalid|Unknown)[ ]+([0-9]+) of ([0-9]+|inf)[ ]*$/))) {
			let slash = index(m[1], '/');
			ep = {
				name: slash >= 0 ? substr(m[1], 0, slash) : m[1], callerid: slash >= 0 ? substr(m[1], slash + 1) : null,
				state: m[2], channels: +m[3], max_channels: m[4] == 'inf' ? null : +m[4],
				auths: [], aors: [], contacts: [], transport: null, identifies: [], calls: [],
			};
			push(out, ep);
			aor = ident = call = null;
		}
		else if (!ep) {
			continue;
		}
		else if ((m = match(line, /^[ ]+(InAuth|OutAuth):[ ]+([^\/ ]+)\/(.*[^ ])[ ]*$/))) {
			push(ep.auths, { dir: m[1] == 'InAuth' ? 'in' : 'out', id: m[2], username: m[3] });
		}
		else if ((m = match(line, /^[ ]+Aor:[ ]+([^ ]+)[ ]+([0-9]+)[ ]*$/))) {
			aor = { name: m[1], max_contacts: +m[2] };
			push(ep.aors, aor);
		}
		else if ((m = match(line, /^[ ]+Contact:[ ]+([^\/ ]+)\/([^ ]+)[ ]+([0-9a-fA-F]+)[ ]+([A-Za-z]+)[ ]+([0-9A-Za-z.]+)[ ]*$/))) {
			push(ep.contacts, { aor: m[1], uri: m[2], hash: m[3], status: m[4], rtt: number_or_null(m[5]) });
		}
		else if ((m = match(line, /^[ ]+Transport:[ ]+([^ ]+)[ ]+([a-z0-9]+)[ ]+([0-9]+)[ ]+([0-9]+)[ ]+(.*[^ ])[ ]*$/))) {
			ep.transport = { name: m[1], type: m[2], bind: m[5] };
		}
		else if ((m = match(line, /^[ ]+Identify:[ ]+([^\/ ]+)\/([^ ]+)[ ]*$/))) {
			ident = { name: m[2], matches: [] };
			push(ep.identifies, ident);
		}
		else if (ident && (m = match(line, /^[ ]+Match:[ ]+(.*[^ ])[ ]*$/))) {
			push(ident.matches, m[1]);
		}
		else if ((m = match(line, /^[ ]+Channel:[ ]+([^ ]+)[ ]+(.*[^ ])[ ]+([0-9]+:[0-9:]+)[ ]*$/))) {
			call = { channel: m[1], state: m[2], time: m[3], exten: null };
			push(ep.calls, call);
		}
		else if (call && (m = match(line, /^[ ]+Exten:[ ]+(.*[^ ])[ ]+CLCID:[ ]+(.*[^ ])[ ]*$/))) {
			call.exten = m[1];
		}
	}
	return out;
}

// `core show channels concise` -> [{ channel, context, exten, priority, state, app, data, callerid, duration, bridge, uniqueid }].
// Concise lines have 14 fields separated by "!" (Asterisk's CONCISE_FORMAT_STRING).
function parse_channels(text) {
	let out = [];
	for (let line in split(text ?? '', '\n')) {
		let f = split(line, '!');
		if (length(f) < 12 || !match(f[0], /^[A-Za-z]+\//))
			continue;
		push(out, {
			channel: f[0], context: f[1], exten: f[2], priority: number_or_null(f[3]), state: f[4], app: f[5], data: f[6], callerid: f[7],
			duration: number_or_null(f[11]), bridge: f[12] ?? '', uniqueid: f[13] ?? '',
		});
	}
	return out;
}

// One dialplan step: what `dialplan show` prints after the priority number, "App(data) [file:line]".
function dialplan_step(prio, label, rest, counter) {
	rest = trim(rest);
	let src = match(rest, /[ ]+\[([A-Za-z0-9_.\/-]+):([0-9]+)\][ ]*$/), source = null;
	if (src) {
		source = { file: src[1], line: +src[2] };
		rest = trim(substr(rest, 0, length(rest) - length(src[0])));
	}
	let call = match(rest, /^([A-Za-z0-9_]+)\((.*)\)$/);
	let app = call ? call[1] : rest, data = call ? call[2] : '';
	// redact_data() recognizes whole calls, so give it the application with its data and take the data back out.
	if (call) {
		let whole = redact_data(`${app}(${data})`, counter);
		data = substr(whole, length(app) + 1, length(whole) - length(app) - 2);
	}
	return { prio: +prio, label: label || null, app, data, source };
}

// `dialplan show` (or `dialplan show <exten>@<context>`) -> { contexts: [{ name, creator, included, includes, switches, extensions:
// [{ pattern, steps }] }], redacted }. The extensions keep the order Asterisk prints them in, which is the order it tries them
// (the exact extensions by name, then the patterns by how specific they are), so the first that matches a number wins.
function parse_dialplan(text) {
	let counter = { n: 0 }, contexts = [], ctx = null, ext = null;
	for (let line in split(text ?? '', '\n')) {
		let m;
		if ((m = match(line, /^\[ (Included context|Context) '([^']*)' created by '([^']*)' \]/))) {
			ctx = { name: m[2], creator: m[3], included: m[1] != 'Context', includes: [], switches: [], extensions: [] };
			push(contexts, ctx);
			ext = null;
		}
		else if (!ctx) {
			continue;
		}
		else if ((m = match(line, /^  Include =>[ ]+'([^']*)'/))) {
			push(ctx.includes, m[1]);
		}
		else if ((m = match(line, /^  Alt\. Switch =>[ ]+'([^']*)'/))) {
			push(ctx.switches, m[1]);
		}
		else if ((m = match(line, /^  '([^']*)' =>[ ]*(\[([^]]*)\][ ]+)?(-?[0-9]+)\. (.*)$/))) {
			ext = { pattern: m[1], steps: [ dialplan_step(m[4], m[3], m[5], counter) ] };
			push(ctx.extensions, ext);
		}
		else if (ext && (m = match(line, /^[ ]+(\[([^]]*)\][ ]+)?(-?[0-9]+)\. (.*)$/))) {
			push(ext.steps, dialplan_step(m[3], m[2], m[4], counter));
		}
	}
	return { contexts, redacted: counter.n };
}

// `dialplan show globals` -> [{ name, value }] with the secrets hidden.
function parse_globals(text, counter) {
	let out = [];
	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^[ ]+([A-Za-z0-9_]+)=(.*)$/);
		if (!m)
			continue;
		let hide = secret_name(m[1]) && m[2] != '';
		if (hide)
			counter.n++;
		push(out, { name: m[1], value: hide ? '<redacted>' : m[2] });
	}
	return out;
}
//#endregion

//#region the log

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// "Nov 20 07:07:02" (no year in Asterisk's log) -> epoch seconds, taking the latest year that is not in the future; null when unreadable.
function log_time(text, now) {
	let m = match(text ?? '', /^([A-Z][a-z]{2})[ ]+([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/);
	if (!m || !MONTHS[m[1]])
		return null;
	let year = localtime(now).year;
	let at = timelocal({ year, mon: MONTHS[m[1]], mday: +m[2], hour: +m[3], min: +m[4], sec: +m[5], isdst: -1 });
	return at > now + 86400 ? timelocal({ year: year - 1, mon: MONTHS[m[1]], mday: +m[2], hour: +m[3], min: +m[4], sec: +m[5], isdst: -1 }) : at;
}

// Log lines that are not a fault. On musl (OpenWrt) the resolver API cannot list the nameservers, so res_pjsip always logs this at start and
// on reload and then resolves through the system resolver, which works. They stay in the list (marked `benign`) but do not raise a finding.
const BENIGN = [
	{ source: 'res_pjsip/config_system.c', text: /^There are no local system nameservers configured, resorting to system resolution/,
		why: 'Harmless on OpenWrt: Asterisk cannot read the nameservers from the musl resolver, so PJSIP resolves names through the system resolver (the one in /etc/resolv.conf) instead of its own.' },
];

// The newest warnings and errors of messages.log, oldest first: [{ at, time, level, source, text, benign? }]. NOTICE lines are kept too, because the
// failed-call reason is often one (app_dial.c: Unable to create channel).
function recent_problems(now) {
	let file = read_file(LOG_FILE, MAX_LOG_TAIL, true);
	if (!file)
		return { available: false, entries: [] };
	let entries = [];
	for (let line in split(file.text, '\n')) {
		let m = match(line, /^\[([^\]]+)\] (NOTICE|WARNING|ERROR|FATAL)\[[0-9]+\](\[[^\]]*\])? ([^ :]+): (.*)$/);
		if (!m)
			continue;
		let e = { at: log_time(m[1], now), time: m[1], level: lc(m[2]), source: m[4], text: m[5] };
		for (let b in BENIGN)
			if (e.source == b.source && match(e.text, b.text))
				e.benign = b.why;
		push(entries, e);
	}
	return { available: true, entries: slice(entries, -MAX_PROBLEMS) };
}
//#endregion

//#region call history

// The CDR file of cdr_csv.so and what one call of it looks like in the reply. cdr_csv writes one line per call leg:
//   accountcode,src,dst,dcontext,clid,channel,dstchannel,lastapp,lastdata,start,answer,end,duration,billsec,disposition,amaflags,uniqueid,userfield
// (plus peeraccount,linkedid,sequence with newcdrcolumns=yes). Text is quoted with "" for a quote, dates are "YYYY-MM-DD HH:MM:SS" in GMT
// (usegmtime=yes in cdr.conf) or empty, numbers are bare. lastdata and userfield are not returned: lastdata holds the expanded arguments of the
// last application, which can contain dialed digits or a PIN being compared. Only an account code of the form "did:<number>" is, as `did`.
const CDR_FILE = '/var/log/asterisk/cdr-csv/Master.csv';
const MAX_CDR_TAIL = 262144;
const MAX_CALLS = 300;

// One CSV line as a list of strings; "" inside a quoted field is a quote.
function csv_fields(line) {
	let out = [], cur = '', quoted = false, n = length(line);
	for (let i = 0; i < n; i++) {
		let c = substr(line, i, 1);
		if (quoted) {
			if (c != '"')
				cur += c;
			else if (substr(line, i + 1, 1) == '"') {
				cur += '"';
				i++;
			}
			else
				quoted = false;
		}
		else if (c == '"')
			quoted = true;
		else if (c == ',') {
			push(out, cur);
			cur = '';
		}
		else
			cur += c;
	}
	push(out, cur);
	return out;
}

// "2026-11-24 12:48:38" (GMT) -> epoch seconds, or null for an empty or unreadable date.
function cdr_time(text) {
	let m = match(text ?? '', /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/);
	return m ? timegm({ year: +m[1], mon: +m[2], mday: +m[3], hour: +m[4], min: +m[5], sec: +m[6] }) : null;
}

// The endpoint of a channel name: "PJSIP/1001-0000000a" -> "1001", "Local/6000@lab-0000000f;1" -> "6000@lab"; null for no channel.
function channel_endpoint(name) {
	let at = index(name ?? '', '/');
	if (at < 0)
		return null;
	return replace(replace(substr(name, at + 1), /;[12]$/, ''), /-[0-9a-f]{8}$/, '');
}

// The number an incoming call dialed, which the dialplan stores in the account code as "did:<number>" (the CDR's dst is the last extension
// reached, "s"); null for any other account code, which is never passed on.
function cdr_did(accountcode) {
	let m = match(accountcode ?? '', /^did:([+0-9]{1,32})$/);
	return m ? m[1] : null;
}

// One parsed CDR line as a call, or null when the line is not a complete record.
function cdr_call(line) {
	let f = csv_fields(line);
	if (length(f) < 18)
		return null;
	let start = cdr_time(f[9]);
	if (start == null)
		return null;
	return {
		did: cdr_did(f[0]),
		id: f[16], linked: f[19] || f[16], start, answer: cdr_time(f[10]), end: cdr_time(f[11]),
		duration: number_or_null(f[12]), billsec: number_or_null(f[13]), disposition: f[14],
		src: f[1], dst: f[2], clid: f[4], context: f[3], app: f[7],
		channel: f[5], dstchannel: f[6], from_endpoint: channel_endpoint(f[5]), to_endpoint: channel_endpoint(f[6]),
	};
}

// The reply of `calls`: the newest calls of the CDR file, newest first, and whether a backend writes it. The file is readable even when
// Asterisk is down, so the history of the last calls stays visible then.
function calls() {
	let up = installed();
	let cdr = parse_cdr(up ? cli('cdr show status') : null);
	let out = { installed: up, enabled: cdr.enabled, backends: cdr.backends, csv: index(cdr.backends, 'csv') >= 0, file: CDR_FILE, entries: [], truncated: false, size: null };
	let file = read_file(CDR_FILE, MAX_CDR_TAIL, true);
	if (!file)
		return out;
	out.size = file.size;
	out.truncated = file.size > MAX_CDR_TAIL;
	let lines = split(file.text, '\n');
	for (let i = length(lines) - 1; i >= 0 && length(out.entries) < MAX_CALLS; i--) {
		let call = lines[i] != '' ? cdr_call(lines[i]) : null;
		if (call)
			push(out.entries, call);
	}
	sort(out.entries, (a, b) => b.start - a.start);
	return out;
}
//#endregion

//#region configuration files

// Whether a configuration file has anything but comments and blank lines (the `;--` ... `--;` blocks are comments).
function active_lines(text) {
	let n = 0, block = false;
	for (let line in split(text, '\n')) {
		let t = trim(line);
		if (block) {
			if (index(t, '--;') >= 0)
				block = false;
			continue;
		}
		if (index(t, ';--') == 0) {
			block = index(t, '--;', 3) < 0;
			continue;
		}
		if (t != '' && substr(t, 0, 1) != ';')
			n++;
	}
	return n;
}

// The configuration files: [{ name, key, path, size, mtime, active }] (active = lines that are not comments, null when only stat'ed).
function conf_index(with_active) {
	if (FIXTURES)
		return json(readfile(`${FIXTURES}/conf_index.json`) ?? '[]');
	let out = [];
	for (let name in sort(lsdir(CONF_DIR) ?? [])) {
		if (!match(name, /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.conf$/))
			continue;
		let st = stat(`${CONF_DIR}/${name}`);
		if (!st || st.type != 'file')
			continue;
		let active = null;
		if (with_active)
			active = active_lines(readfile(`${CONF_DIR}/${name}`, MAX_CONFIG) ?? '');
		push(out, { name, key: name, path: `${CONF_DIR}/${name}`, size: st.size, mtime: st.mtime, active });
	}
	let uci = stat(UCI_FILE);
	if (uci)
		push(out, { name: 'asterisk (UCI)', key: 'uci', path: UCI_FILE, size: uci.size, mtime: uci.mtime,
			active: with_active ? active_lines(readfile(UCI_FILE, MAX_CONFIG) ?? '') : null });
	if (RECORD)
		record_file('conf_index.json', sprintf('%J', out));
	return out;
}

// Seconds since the epoch that `core show uptime` puts the last reload at, or null. Only a full `core reload` moves it.
function reload_epoch(now, up) {
	return up.reload != null ? now - up.reload : null;
}

// A reload made through `reload` (the page's buttons) leaves its time in a marker file, because `dialplan reload` and a PJSIP reload do not
// move `Last reload`. The markers are in /tmp: after a reboot Asterisk loads everything again anyway.
const RELOAD_MARK = '/tmp/flab-asterisk-reload';
const RELOAD_FILES = { dialplan: /^extensions[A-Za-z0-9_.-]*\.conf$/, pjsip: /^pjsip[A-Za-z0-9_.-]*\.conf$/ };

// When Asterisk last loaded the configuration file `name`: the later of the last full reload and the last reload that covers that file.
function loaded_at(name, reloaded) {
	let at = reloaded;
	if (FIXTURES || at == null)
		return at;
	for (let what, files in RELOAD_FILES) {
		let raw = match(name, files) ? trim(readfile(`${RELOAD_MARK}.${what}`) ?? '') : '';
		let marked = match(raw, /^[0-9]+$/) ? +raw : 0;
		if (marked > at)
			at = marked;
	}
	return at;
}

// The reply of `config`: without a file name the list of files; with one, that file (secrets redacted) with its size and mtime.
function config(request, reloaded) {
	let want = request?.args?.file;
	let files = conf_index(true);
	for (let f in files)
		f.changed = reloaded != null && f.mtime > loaded_at(f.name, reloaded) + 2;
	if (want == null || want == '')
		return { files, reloaded };
	let entry = filter(files, (f) => f.key == want)[0];
	if (type(want) != 'string' || !entry)
		return { error: 'That file is not an Asterisk configuration file.' };
	let file = read_file(entry.path, MAX_CONFIG);
	if (!file)
		return { error: 'The file cannot be read.' };
	let truncated = length(file.text) > MAX_CONFIG;
	let hidden = redact_config(truncated ? substr(file.text, 0, MAX_CONFIG) : file.text);
	return { name: entry.name, key: entry.key, path: entry.path, size: file.size, mtime: file.mtime, changed: entry.changed,
		truncated, redacted: hidden.count, text: hidden.text, files, reloaded };
}
//#endregion

//#region core status

// What needs attention, as [{ level: 'good' | 'info' | 'warn' | 'bad', text }].
function findings(s) {
	let out = [];
	if (!s.installed)
		return out;
	if (!s.running) {
		if (s.state == 'unreachable')
			push(out, { level: 'warn', text: 'The Asterisk process is alive but does not answer on its control socket. It may still be starting.' });
		else if (s.enabled === false)
			push(out, { level: 'info', text: 'Asterisk is not running because it is disabled in /etc/config/asterisk (option enabled is 0).' });
		else
			push(out, { level: 'bad', text: 'Asterisk is not running. Check the system log for the reason.' });
		return out;
	}
	let sum = s.summary;
	for (let r in sum.registrations_list)
		if (r.status != 'Registered')
			push(out, { level: 'bad', text: `The registration ${r.name} is ${r.status}: calls through that trunk will fail.` });
	for (let e in sum.endpoints_list)
		if (e.state == 'Unavailable')
			push(out, { level: 'warn', text: `Endpoint ${e.name} is unavailable: it has no reachable contact, so calls to it fail.` });
	for (let f in s.changed_files)
		push(out, { level: 'warn', text: `${f} was changed after Asterisk last loaded its configuration: use Reload on this page (or asterisk -rx "core reload") to apply the change.` });
	let day = s.now - 86400, errors = filter(s.problems.entries, (p) => p.level == 'error' && p.at != null && p.at >= day && !p.benign);
	if (length(errors))
		push(out, { level: 'warn', text: `${length(errors)} error${length(errors) == 1 ? '' : 's'} in the Asterisk log in the last 24 hours; the latest: ${errors[length(errors) - 1].text}` });
	if (!s.pjsip_loaded)
		push(out, { level: 'info', text: 'The PJSIP channel driver is not loaded, so there is nothing to show about SIP.' });
	else if (!length(sum.registrations_list) && !length(sum.endpoints_list))
		push(out, { level: 'info', text: 'PJSIP is loaded but no endpoint or registration is configured.' });
	return out;
}

// The reply of `status`.
function status() {
	let now = fixture_time();
	let s = { installed: installed(), now };
	if (!s.installed)
		return { ...s, running: false, state: 'not_installed', findings: [] };

	let all = uci_all('asterisk');
	let enabled = all?.general?.enabled;
	s.enabled = enabled == null ? null : (enabled == '1' || enabled == 'true' || enabled == 'on' || enabled == 'yes');
	let pid = sysfs(PID_FILE);
	pid = (pid != null && match(pid, /^[0-9]+$/)) ? +pid : null;
	let proc = pid ? sysfs(`/proc/${pid}/status`) : null;
	let uptime_text = cli('core show uptime seconds');
	s.running = uptime_text != null && match(uptime_text, /System uptime/) != null;
	s.pid = proc != null ? pid : null;
	s.state = s.running ? 'running' : (proc != null ? 'unreachable' : (s.enabled === false ? 'disabled' : 'stopped'));
	let rss = match(proc ?? '', /VmRSS:[ \t]+([0-9]+) kB/);
	s.rss_kb = rss ? +rss[1] : null;

	let index_ = conf_index(false);
	if (!s.running) {
		s.summary = { registrations_list: [], endpoints_list: [] };
		s.problems = recent_problems(now);
		s.findings = findings(s);
		return s;
	}

	let up = parse_uptime(uptime_text);
	s.uptime = up.uptime;
	s.started = up.uptime != null ? now - up.uptime : null;
	s.reloaded = reload_epoch(now, up);
	s.version = match(cli('core show version') ?? '', /^Asterisk ([0-9][^ ]*)/)?.[1] ?? null;
	s.pjproject = match(cli('pjsip show version') ?? '', /running against: ([0-9][^ \n]*)/)?.[1] ?? null;

	let settings = parse_settings(cli('core show settings'));
	s.settings = {
		max_calls: number_or_null(settings.maximum_calls), max_open_files: number_or_null(settings.maximum_open_file_handles),
		entity_id: settings.entity_id ?? null, language: settings.default_language ?? null, system_name: settings.system_name || null,
	};
	s.subsystems = {
		ami: settings.manager_ami == 'Enabled', ami_http: settings.web_manager_ami_http == 'Enabled',
		cdr: settings.call_data_records == 'Enabled', realtime: settings.realtime_architecture_ara == 'Enabled',
	};
	s.directories = {
		config: settings.configuration_directory ?? null, modules: settings.module_directory ?? null, spool: settings.spool_directory ?? null,
		log: settings.log_directory ?? null, run: settings.run_sockets_directory ?? null, data: settings.data_directory ?? null,
	};

	s.calls = parse_calls(cli('core show calls'));
	s.modules = parse_modules(cli('module show'));
	s.pjsip_loaded = length(filter(s.modules, (m) => m.name == 'res_pjsip.so' && m.status == 'Running')) > 0;
	s.logger = parse_logger(cli('logger show channels'));
	s.cdr = parse_cdr(cli('cdr show status'));

	let regs = [], eps = [];
	if (s.pjsip_loaded) {
		regs = parse_registrations(cli('pjsip list registrations'));
		eps = parse_endpoints(cli('pjsip list endpoints'));
	}
	// `pjsip list endpoints` has only the Endpoint lines; parse_endpoints() reads those too.
	s.summary = {
		registrations_list: regs, endpoints_list: map(eps, (e) => ({ name: e.name, state: e.state, channels: e.channels })),
		registrations: length(regs), registered: length(filter(regs, (r) => r.status == 'Registered')),
		endpoints: length(eps), available: length(filter(eps, (e) => e.state != 'Unavailable' && e.state != 'Invalid')),
	};
	s.changed_files = map(filter(index_, (f) => f.mtime > loaded_at(f.name, s.reloaded ?? now) + 2 && f.key != 'uci'), (f) => f.name);
	s.problems = recent_problems(now);
	s.findings = findings(s);
	return s;
}
//#endregion

//#region PJSIP

// The settings of an endpoint that the lists and the routing map use, from `pjsip show endpoint <name>`'s parameter rows.
const ENDPOINT_KEYS = [
	'context', 'allow', 'disallow', 'transport', 'aors', 'auth', 'outbound_auth', 'acl', 'contact_acl', 'direct_media', 'dtmf_mode',
	'from_user', 'from_domain', 'identify_by', 'media_encryption', 'outbound_proxy', 'callerid', 'rtp_symmetric', 'force_rport',
	'ice_support', 'rewrite_contact', 'rtp_timeout', 'max_audio_streams', 'timers', 'contact_user',
];
// The settings of an outbound registration.
const REGISTRATION_KEYS = [
	'client_uri', 'server_uri', 'endpoint', 'expiration', 'retry_interval', 'fatal_retry_interval', 'forbidden_retry_interval', 'max_retries',
	'outbound_auth', 'outbound_proxy', 'transport', 'line', 'contact_user', 'auth_rejection_permanent',
];
// The settings of a transport.
const TRANSPORT_KEYS = [
	'bind', 'protocol', 'external_media_address', 'external_signaling_address', 'external_signaling_port', 'local_net', 'tos', 'cos',
	'symmetric_transport', 'websocket_write_timeout',
];

// The named parameters of `params`, as { key: value } (a repeated one as a list).
function pick(params, keys) {
	let out = {};
	for (let k in keys) {
		let all = param_all(params, k);
		if (length(all) == 1)
			out[k] = all[0];
		else if (length(all) > 1)
			out[k] = all;
	}
	return out;
}

// The codecs of an `allow` value such as "(alaw|ulaw)".
function codecs(value) {
	return filter(split(replace(value ?? '', /[()]/g, ''), '|'), (c) => c != '');
}

// The reply of `pjsip`: transports, outbound registrations, endpoints (with auths, AORs, contacts, identifies, settings and calls) and
// the active channels.
function pjsip() {
	let eps_text = cli('pjsip show endpoints');
	if (eps_text == null)
		return { available: false, reason: 'running' };
	if (match(eps_text, /No such command/))
		return { available: false, reason: 'module' };

	let endpoints = parse_endpoints(eps_text);
	let registrations = parse_registrations(cli('pjsip show registrations'));
	let transports = parse_transports(cli('pjsip show transports'));
	let channels = parse_channels(cli('core show channels concise'));
	let truncated = false;

	// Settings that only the per-object commands print.
	let n = 0;
	for (let e in endpoints) {
		if (!safe_name(e.name) || n >= MAX_DETAIL) {
			truncated = truncated || n >= MAX_DETAIL;
			continue;
		}
		n++;
		let params = parse_params(cli(`pjsip show endpoint ${e.name}`, 65536));
		e.settings = pick(params, ENDPOINT_KEYS);
		e.codecs = codecs(e.settings.allow);
		e.context = e.settings.context || null;
	}
	n = 0;
	for (let r in registrations) {
		if (!safe_name(r.name) || n >= MAX_DETAIL)
			continue;
		n++;
		r.settings = pick(parse_params(cli(`pjsip show registration ${r.name}`, 65536)), REGISTRATION_KEYS);
		r.endpoint = r.settings.endpoint || null;
	}
	n = 0;
	for (let t in transports) {
		if (!safe_name(t.name) || n >= MAX_TRANSPORT_DETAIL)
			continue;
		n++;
		t.settings = pick(parse_params(cli(`pjsip show transport ${t.name}`, 65536)), TRANSPORT_KEYS);
	}

	// A trunk talks to a provider (it has a registration or matches the provider's address); a phone registers with us.
	for (let e in endpoints) {
		let reg = filter(registrations, (r) => r.endpoint == e.name)[0];
		e.registration = reg?.name ?? null;
		let has_in = length(filter(e.auths, (a) => a.dir == 'in')) > 0, phone_aor = length(filter(e.aors, (a) => a.max_contacts > 0)) > 0;
		e.role = (reg || length(e.identifies)) ? 'trunk' : ((has_in || phone_aor) ? 'phone' : 'other');
		e.active_channels = filter(channels, (c) => index(c.channel, `PJSIP/${e.name}-`) == 0);
	}
	return { available: true, endpoints, registrations, transports, channels, truncated };
}

// The reply of `endpoint`: every parameter of one endpoint, as the CLI prints them.
function endpoint(request) {
	let name = request?.args?.name;
	if (!safe_name(name))
		return { found: false, name, error: 'The endpoint name is not valid.' };
	let known = filter(parse_endpoints(cli('pjsip list endpoints')), (e) => e.name == name);
	if (!length(known))
		return { found: false, name, error: 'Asterisk has no endpoint of that name.' };
	let params = parse_params(cli(`pjsip show endpoint ${name}`, 65536));
	return { found: true, name, params };
}
//#endregion

//#region calls in progress

// The most channels that get a `core show channel` query (one CLI call each) in `active`.
const MAX_ACTIVE = 24;

// Channel names that may go into a CLI command (no quote, no space), such as "PJSIP/1001-0000000a" or "Local/6000@lab-0000000f;1".
function safe_channel(name) {
	return type(name) == 'string' && length(name) <= 120 && match(name, /^[A-Za-z0-9_.\/@;+:*#-]+$/) != null && substr(name, 0, 1) != '-';
}

// `core show channel <name>` -> { native, read, write, read_transcode, write_transcode, dnid, name, hangup_at, streams }: the codecs the channel
// offers (NativeFormats), the ones in use in each direction, and whether Asterisk converts between them ("Yes <path>" when it does; transcode is
// null when not printed); the number dialed (DNID Digits) and the caller's name when there are any; the moment the channel is hung up by itself
// (the dialplan's TIMEOUT(absolute)), as epoch seconds; the ids that tie the channel to its call (linked id, call identifier); the media streams with their state (sendrecv, or sendonly/inactive on hold).
// Only these lines are read: the rest (variables, which can hold a PIN) is not needed.
function parse_channel_detail(text) {
	let out = { native: [], read: null, write: null, read_transcode: null, write_transcode: null, dnid: null, name: null, hangup_at: null, linked: null, identifier: null, streams: [] };
	let in_streams = false, stream = null;
	for (let line in split(text ?? '', '\n')) {
		if (match(line, /^ -- Streams --/)) {
			in_streams = true;
			continue;
		}
		if (in_streams) {
			let s = match(line, /^[ ]*(Name|Type|State|Formats):(.*)$/);
			if (!s)
				continue;
			if (s[1] == 'Name') {
				stream = { name: trim(s[2]), type: null, state: null, formats: [] };
				push(out.streams, stream);
			}
			else if (stream) {
				if (s[1] == 'Formats')
					stream.formats = codecs(trim(s[2]));
				else
					stream[lc(s[1])] = trim(s[2]);
			}
			continue;
		}
		let m = match(line, /^[ ]*(NativeFormats|WriteFormat|ReadFormat|WriteTranscode|ReadTranscode|DNID Digits|Caller ID Name|Time to Hangup|LinkedID|Call Identifier):(.*)$/);
		if (!m)
			continue;
		let v = trim(m[2]);
		if (m[1] == 'NativeFormats')
			out.native = codecs(v);
		else if (m[1] == 'WriteFormat')
			out.write = v == '' ? null : v;
		else if (m[1] == 'ReadFormat')
			out.read = v == '' ? null : v;
		else if (m[1] == 'DNID Digits')
			out.dnid = (v == '' || v == '(N/A)') ? null : v;
		else if (m[1] == 'Caller ID Name')
			out.name = (v == '' || v == '(N/A)') ? null : v;
		else if (m[1] == 'LinkedID')
			out.linked = v == '' ? null : v;
		else if (m[1] == 'Call Identifier')
			out.identifier = (v == '' || v == '(None)') ? null : replace(v, /[][]/g, '');
		else if (m[1] == 'Time to Hangup')
			out.hangup_at = (match(v, /^[0-9]+$/) && +v > 1000000000) ? +v : null;
		else {
			let yes = match(v, /^Yes(.*)$/);
			out[m[1] == 'WriteTranscode' ? 'write_transcode' : 'read_transcode'] = yes ? (trim(yes[1]) == '' ? true : trim(yes[1])) : (v == '' ? null : false);
		}
	}
	return out;
}
// A count as `pjsip show channelstats` prints it: divided by 1000 with a "K" after it when it is over 100000; null when it is not a number.
function stat_number(token) {
	let m = match(token ?? '', /^([0-9]+(\.[0-9]+)?)(K?)$/);
	return m ? +m[1] * (m[3] == 'K' ? 1000 : 1) : null;
}

// `pjsip show channelstats` -> [{ channel, bridge, uptime, codec, rx: { packets, lost, loss_pct, jitter }, tx: { .. }, rtt }]. Jitter and round
// trip time are in seconds (a round trip time of 0 means the peer sends no RTCP report). A line is: [bridge id] name uptime codec, then count,
// lost, pct, jitter for each direction and the round trip time. The bridge id is missing for a channel that is not bridged, and the name has no
// "PJSIP/" in front and is cut to 18 characters; a call with direct media has no line of numbers.
function parse_channelstats(text) {
	let out = [];
	for (let line in split(text ?? '', '\n')) {
		let t = split(trim(line), /[ ]+/);
		if (length(t) != 12 && length(t) != 13)
			continue;
		let at = length(t) - 12;
		let n = map(slice(t, at + 3), (x) => stat_number(x));
		if (length(filter(n, (x) => x == null)) || !match(t[at + 1], /^[0-9]+:[0-9:]+$/))
			continue;
		push(out, {
			channel: t[at], bridge: at ? t[0] : '', uptime: t[at + 1], codec: t[at + 2],
			rx: { packets: n[0], lost: n[1], loss_pct: n[2], jitter: n[3] },
			tx: { packets: n[4], lost: n[5], loss_pct: n[6], jitter: n[7] },
			rtt: n[8],
		});
	}
	return out;
}
// `bridge show all` -> [{ id, name, channels, type, technology, duration }]: the bridges that join the channels of the calls. The technology says how the
// media goes: simple_bridge passes it through Asterisk (which can convert or mix it), native_rtp lets the two sides exchange it directly, holding is a
// channel parked on hold. A line is: id, name (may be <unknown>), channel count, type, technology, duration (h:mm:ss).
function parse_bridges(text) {
	let out = [];
	for (let line in split(text ?? '', '\n')) {
		let t = split(trim(line), /[ ]+/);
		if (length(t) < 6 || !match(t[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
			continue;
		let d = match(t[length(t) - 1], /^([0-9]+):([0-9]+):([0-9]+)$/);
		if (!d || !match(t[length(t) - 4], /^[0-9]+$/))
			continue;
		push(out, {
			id: t[0], name: length(t) > 6 ? join(' ', slice(t, 1, length(t) - 4)) : (t[1] == '<unknown>' ? null : t[1]),
			channels: +t[length(t) - 4], type: t[length(t) - 3], technology: t[length(t) - 2], duration: +d[1] * 3600 + +d[2] * 60 + +d[3],
		});
	}
	return out;
}
// The reply of `active`: the calls in progress as channels, each with its codecs (native, in use for reading and writing, transcoding) and, for
// a PJSIP channel, the RTP statistics. Channels that share a bridge id are the two sides of one call (the page joins them).
function active() {
	let text = cli('core show channels concise');
	if (text == null)
		return { available: false };
	let channels = parse_channels(text);
	let stats = parse_channelstats(cli('pjsip show channelstats'));
	let bridges = parse_bridges(cli('bridge show all'));
	let allowed = {};
	let n = 0;
	for (let c in channels) {
		// The arguments of the application (dialed digits, a PIN being compared) are not passed on.
		delete c.data;
		c.type = split(c.channel, '/')[0];
		c.endpoint = channel_endpoint(c.channel);
		// What our endpoint is configured to allow (its `allow` list, the order is our preference): one query per endpoint.
		if (c.type == 'PJSIP' && safe_name(c.endpoint)) {
			if (!exists(allowed, c.endpoint))
				allowed[c.endpoint] = codecs(param(parse_params(cli(`pjsip show endpoint ${c.endpoint}`, 65536)), 'allow'));
			c.allowed = allowed[c.endpoint];
		}
		if (safe_channel(c.channel) && n < MAX_ACTIVE) {
			n++;
			c.formats = parse_channel_detail(cli(`core show channel ${c.channel}`, 65536));
		}
		let local = substr(c.channel, index(c.channel, '/') + 1);
		let hit = c.type != 'PJSIP' ? [] : filter(stats, (s) => index(local, s.channel) == 0 && (s.bridge == '' || index(c.bridge, s.bridge) == 0));
		c.rtp = length(hit) ? { bridge: hit[0].bridge, uptime: hit[0].uptime, codec: hit[0].codec, rx: hit[0].rx, tx: hit[0].tx, rtt: hit[0].rtt } : null;
	}
	return { available: true, now: fixture_time(), truncated: n >= MAX_ACTIVE && length(channels) > MAX_ACTIVE, channels, bridges };
}
//#endregion

//#region dialplan

// The reply of `dialplan`: all contexts with their extensions and steps, and the [globals] variables.
function dialplan() {
	let r = cli_result('dialplan show');
	if (!r.ok && !r.truncated)
		return { available: false };
	let parsed = parse_dialplan(r.output);
	let counter = { n: parsed.redacted };
	let globals = parse_globals(cli('dialplan show globals'), counter);
	let extensions = 0, steps = 0;
	for (let c in parsed.contexts)
		for (let e in c.extensions) {
			extensions++;
			steps += length(e.steps);
		}
	return { available: true, truncated: r.truncated, contexts: parsed.contexts, globals, redacted: counter.n,
		totals: { contexts: length(parsed.contexts), extensions, steps } };
}

// The reply of `resolve`: what Asterisk itself finds for a dialed number in a context (includes followed), through
// `dialplan show <exten>@<context>`. The number tester compares its own answer with this one.
function resolve(request) {
	let ctx = request?.args?.context, ext = request?.args?.exten;
	if (type(ctx) != 'string' || !match(ctx, /^[A-Za-z0-9_.-]{1,80}$/) || index(ctx, '\n') >= 0)
		return { found: false, error: 'The context name is not valid.' };
	if (type(ext) != 'string' || !match(ext, /^[A-Za-z0-9_+*#.-]{1,64}$/) || index(ext, '\n') >= 0)
		return { found: false, error: 'The number is not valid: use digits, letters, + * # . or -.' };
	let out = cli(`dialplan show ${ext}@${ctx}`);
	if (out == null)
		return { found: false, error: 'Asterisk did not answer.' };
	let parsed = parse_dialplan(out);
	let hit = filter(parsed.contexts, (c) => length(c.extensions) > 0)[0];
	return { found: hit != null, context: ctx, exten: ext, in_context: hit?.name ?? null, via_include: hit?.included ?? false,
		pattern: hit?.extensions[0]?.pattern ?? null, steps: hit?.extensions[0]?.steps ?? [] };
}
// The reply of `reload`: asks Asterisk to re-read its configuration. `what` is core (every module: `core reload`), dialplan (extensions.conf
// only) or pjsip (pjsip.conf: endpoints and registrations). Only these fixed commands run; nothing of the request reaches the command line.
const RELOADS = {
	core: 'core reload',
	dialplan: 'dialplan reload',
	pjsip: 'module reload res_pjsip.so',
};

function reload(request) {
	let what = request?.args?.what;
	if (type(what) != 'string' || !match(what, /^[a-z]{1,16}$/) || !RELOADS[what])
		return { ok: false, what, command: null, output: '', error: 'What to reload must be core, dialplan or pjsip.' };
	let r = cli_result(RELOADS[what]);
	// The marker is written when Asterisk answered, whatever it printed; `core` needs none (it moves `Last reload`).
	if (r.ok && !FIXTURES && RELOAD_FILES[what])
		writefile(`${RELOAD_MARK}.${what}`, `${time()}`);
	return { ok: r.ok, what, command: RELOADS[what], output: trim(r.output), error: r.ok ? null : 'Asterisk did not answer.' };
}
//#endregion

// rpcd registration: ubus object flab.asterisk. Every method but `reload` only reads. `status` is the Overview, `pjsip` the SIP objects, `endpoint` takes
// { name }, `dialplan` the whole loaded dialplan, `resolve` takes { context, exten }, `config` takes an optional { file }, `calls` the call history,
// `active` the calls in progress with their codecs, `reload` takes { what }.
return deferred({
	'flab.asterisk': {
		reload: {
			args: { what: '' },
			call: function(request) {
				return reload(request);
			},
		},
		status: {
			call: function(request) {
				return status();
			},
		},
		pjsip: {
			call: function(request) {
				return pjsip();
			},
		},
		endpoint: {
			args: { name: '' },
			call: function(request) {
				return endpoint(request);
			},
		},
		dialplan: {
			call: function(request) {
				return dialplan();
			},
		},
		resolve: {
			args: { context: '', exten: '' },
			call: function(request) {
				return resolve(request);
			},
		},
		calls: {
			call: function(request) {
				return calls();
			},
		},
		active: {
			call: function(request) {
				return active();
			},
		},
		config: {
			args: { file: '' },
			call: function(request) {
				let up = parse_uptime(cli('core show uptime seconds'));
				return config(request, reload_epoch(fixture_time(), up));
			},
		},
	},
});
