#!/usr/bin/ucode
//
// rpcd ucode plugin reporting the system log and the kernel log as structured JSON:
//   ubus call flab.logs read '{"lines":500}'               both logs
//   ubus call flab.logs read '{"source":"kernel"}'         one of them ("system" or "kernel")
//
// Sources (no LuCI component is used):
//   - `logread -l N`: logd's ring buffer, which holds every daemon's syslog messages (kernel messages too).
//     Lines look like "Wed Nov 11 12:06:15 2026 daemon.info odhcpd[2571]: message".
//   - `dmesg -r`: the kernel ring buffer in raw form: "<6>[ 272373.680866] message", where <N> is the
//     syslog priority (facility * 8 + severity) and the number in brackets is seconds since boot.
//   - procfs /proc/uptime: to turn the boot-relative kernel timestamps into wall-clock time.
//
// Only the last `lines` entries of each log are returned (default 500, at most 2000) so a poll stays cheap on
// a small router. Values that look like secrets (password=..., key: ..., psk=...) are replaced with
// <redacted>: daemons sometimes log them in verbose mode, and this page shows them to anyone who can sign in.
//
// rpcd runs plugins in-process, so this must not call ubus objects served by rpcd itself.

'use strict';

import { run, sysfs, num } from 'flab.util';

const DEFAULT_LINES = 500;
const MAX_LINES = 2000;

const SEVERITIES = [ 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug' ];
// logd prints the short syslog names ("warn", "error", "panic"); they are reported under the canonical ones.
const SEVERITY_ALIASES = { warn: 'warning', error: 'err', panic: 'emerg' };
const FACILITIES = [ 'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp' ];
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// "name = value" pairs whose name suggests a secret; the value (up to the next space) is blanked.
const SECRET = /((pass(word|wd|phrase)?|psk|secret|private[_ -]?key|preshared[_ -]?key|token|key)[ ]*[=:][ ]*)[^ ]+/gi;

// The message with secret-looking values blanked.
function redact(message) {
	return replace(message, SECRET, '$1<redacted>');
}

// `lines` from the request, clamped to 1..MAX_LINES; DEFAULT_LINES when absent or not a number.
function line_limit(request) {
	let n = +(request?.args?.lines ?? 0);
	if (!(n >= 1))
		return DEFAULT_LINES;
	return n > MAX_LINES ? MAX_LINES : int(n);
}

// The last `n` items of a list (all of them when it is shorter).
function tail(list, n) {
	return slice(list, length(list) > n ? length(list) - n : 0);
}

// The non-empty lines of command output.
function lines_of(text) {
	return filter(split(text ?? '', '\n'), (l) => l != '');
}

//#region System log

// One logread line as an entry; a line that does not match (a continuation, a truncated line) is kept whole
// with no time or origin so nothing is silently dropped.
function parse_system(line) {
	let m = match(line, /^[A-Za-z]{3} ([A-Za-z]{3}) +([0-9]+) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4}) ([a-z0-9]+)\.([a-z]+) ([^ :[]+)(\[([0-9]+)\])?: (.*)$/);
	if (!m)
		return { t: null, facility: null, severity: null, level: null, program: null, pid: null, message: redact(line) };
	let name = SEVERITY_ALIASES[m[8]] ?? m[8];
	let level = index(SEVERITIES, name);
	return {
		t: timelocal({ year: +m[6], mon: MONTHS[m[1]] ?? 1, mday: +m[2], hour: +m[3], min: +m[4], sec: +m[5], isdst: -1 }),
		facility: m[7],
		severity: level >= 0 ? name : null,
		level: level >= 0 ? level : null,
		program: m[9],
		pid: num(m[11]),
		message: redact(m[12]),
	};
}

// The last `n` entries of the system log, parsed.
function read_system(n) {
	return map(lines_of(run(`logread -l ${n} 2>/dev/null`)), parse_system);
}

//#endregion

//#region Kernel log

// One `dmesg -r` line as an entry; `boot` is the wall-clock time of boot, so t = boot + seconds since boot.
function parse_kernel(line, boot) {
	let m = match(line, /^<([0-9]+)>\[ *([0-9]+)\.([0-9]+)\] (.*)$/);
	if (!m)
		return { t: null, facility: 'kern', severity: null, level: null, program: 'kernel', pid: null, message: redact(line) };
	let pri = +m[1];
	let level = pri % 8;
	return {
		t: boot != null ? boot + (+m[2]) : null,
		uptime: +`${m[2]}.${m[3]}`,
		facility: FACILITIES[int(pri / 8)] ?? 'kern',
		severity: SEVERITIES[level],
		level,
		program: 'kernel',
		pid: null,
		message: redact(m[4]),
	};
}

// The last `n` entries of the kernel log, parsed, with wall-clock times derived from /proc/uptime.
function read_kernel(n) {
	let up = num(split(sysfs('/proc/uptime') ?? '', ' ')[0]);
	let boot = up != null ? int(time() - up) : null;
	return map(tail(lines_of(run('dmesg -r 2>/dev/null')), n), (l) => parse_kernel(l, boot));
}

//#endregion

// The reply of `read`: the requested log(s) as lists of entries, plus the router's time and the line limit used.
function collect(request) {
	let n = line_limit(request);
	let which = request?.args?.source;
	let out = { generated: time(), limit: n };
	if (which != 'kernel')
		out.system = read_system(n);
	if (which != 'system')
		out.kernel = read_kernel(n);
	return out;
}

return {
	'flab.logs': {
		read: {
			args: { lines: 0, source: '' },
			call: function(request) {
				return collect(request);
			},
		},
	},
};
