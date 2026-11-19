// Shared helpers for the flab-ui rpcd plugins. Deployed to /usr/share/ucode/flab/util.uc and
// imported as: import { run, fixture } from 'flab.util';

'use strict';

import { readfile, writefile } from 'fs';
import { cursor } from 'uci';
import { command_result as execute, stem } from 'flab.exec';

// Test seam: with FLAB_FIXTURES=<dir> set (never the case inside rpcd) run() returns saved command
// output instead of executing anything. The file is named after the command (flab.exec stem()): every run of
// non-alphanumerics turned into "_" and a trailing "2>/dev/null" dropped, e.g.
// "swanctl --list-sas --raw 2>/dev/null" -> swanctl_list_sas_raw.txt
// The helpers below follow the same idea for ubus calls (<object>_<method>.json), UCI
// (uci_<config>.json) and kernel pseudo-files (files.json: path -> contents).
// With FLAB_RECORD=<dir> set (also never inside rpcd) every real call additionally saves its result under
// the same names, so a fixture set is captured by simply running the plugin once on the router. Keys and
// passwords found in recorded ubus/UCI data are blanked before they are written.
//
// Safety: command strings run through `sh -c` (see flab.exec), so only put validated values in them; interface names must
// pass safe_ifname() first.
const FIXTURES = getenv('FLAB_FIXTURES');
const RECORD = getenv('FLAB_RECORD');
// Turns an "object method" string into the file-name stem used by ubus fixtures.
const slug = (s) => replace(s, /[^A-Za-z0-9]+/g, '_');

// Saves data as <FLAB_RECORD>/<name>; does nothing unless recording.
export function record_file(name, data) {
	if (RECORD && data != null)
		writefile(`${RECORD}/${name}`, data);
};

// Deep copy of recorded ubus/UCI data with key and password-like values (PSKs, passphrases, private keys,
// 802.11r key-holder secrets) replaced by 'REDACTED'. Matching is on the option name, case-insensitive.
function scrub(v) {
	if (type(v) == 'array')
		return map(v, scrub);
	if (type(v) != 'object')
		return v;
	let out = {};
	for (let k, x in v)
		out[k] = match(k, /^(key|r0kh|r1kh|[a-z_]*(psk|password|passphrase|secret|private_key|preshared_key)[a-z_]*)$/i) ? 'REDACTED' : scrub(x);
	return out;
}

// Contents of <FLAB_FIXTURES>/<name>, or null when the seam is inactive.
export function fixture(name) {
	return FIXTURES ? (readfile(`${FIXTURES}/${name}`) ?? '') : null;
};

// Replay wall-clock-dependent state against the same instant at which its synthetic timestamps were built.
export function fixture_time() {
	let fixed = FIXTURES ? trim(fixture('clock.txt') ?? '') : '';
	return match(fixed, /^[0-9]+$/) ? +fixed : time();
};

// Bounded compatibility reader for optional probes. Empty output alone cannot distinguish failure from success;
// callers which require success must use command_result(). All real rpcd calls run in deferred workers.
export function run(cmd) {
	// Replay mode: the command is never executed, only looked up by name.
	if (FIXTURES)
		return fixture(stem(cmd) + '.txt');

	let result = execute(cmd);
	if (result.truncated || result.timed_out)
		die(result.truncated ? 'The command output budget was exhausted.' : 'The command timed out.');
	return result.output;
};

// Runs a command and returns { ok, code, output, truncated, timed_out } (flab.exec command_result(), with `timeout` and
// `max_output` options). Unlike run(), a failure is reported, not turned into an exception.
export function command_result(cmd, options) {
	return execute(cmd, options);
};

// Call a ubus object served by another daemon (netifd, hostapd, ...); null on failure. rpcd runs
// plugins in-process, so never use this for objects rpcd serves itself.
export function ubus_call(conn, object, method, args) {
	if (FIXTURES) {
		let raw = fixture(slug(`${object} ${method}`) + '.json');
		return raw ? json(raw) : null;
	}
	let res = conn.call(object, method, args);
	if (RECORD)
		record_file(slug(`${object} ${method}`) + '.json', res != null ? sprintf('%J', scrub(res)) : '');
	return res;
};

// Every section of a UCI config as { name: { '.type': ..., option: value } }.
export function uci_all(config) {
	if (FIXTURES) {
		let raw = fixture(`uci_${config}.json`);
		return raw ? json(raw).values : {};
	}
	let c = cursor();
	c.load(config);
	let all = c.get_all(config) ?? {};
	if (RECORD)
		record_file(`uci_${config}.json`, sprintf('%J', { values: scrub(all) }));
	return all;
};

// Lazily loaded files.json map (path -> contents), used for both replay and recording.
let saved_files = null;
// Device-tree properties hold binary values, so they are stored hex-encoded.
const is_binary = (path) => index(path, '/proc/device-tree/') == 0;

// Contents of a small kernel pseudo-file such as /sys/class/net/<if>/carrier, exactly as read (device-tree
// properties are binary), or null when it is missing or unreadable (a down link refuses to report its
// speed, for instance). Binary files are recorded hex-encoded ("hex:...") because JSON cannot carry
// arbitrary bytes; the fixture reader decodes them again.
export function sysfs_raw(path) {
	if (FIXTURES) {
		saved_files ??= json(fixture('files.json') || '{}');
		let v = saved_files[path];
		return (type(v) == 'string' && index(v, 'hex:') == 0) ? hexdec(substr(v, 4)) : v;
	}
	let s = readfile(path);
	if (RECORD && s != null) {
		// Several plugins record into one folder, so merge with what an earlier run saved.
		saved_files ??= json(readfile(`${RECORD}/files.json`) ?? '{}');
		saved_files[path] = is_binary(path) ? 'hex:' + hexenc(s) : s;
		writefile(`${RECORD}/files.json`, sprintf('%J', saved_files));
	}
	return s;
};

// Like sysfs_raw(), but with surrounding whitespace (the trailing newline) removed.
export function sysfs(path) {
	let s = sysfs_raw(path);
	return s == null ? null : trim(s);
};

// True when `s` is a string without a line break. ucode's `^...$` patterns match the first line of a multi-line string, so
// "1.1.1.1\nid" passes /^[0-9.]+$/: test one_line() before any pattern check on a value that reaches a shell string, a command
// argument or a path.
export function one_line(s) {
	return type(s) == 'string' && index(s, '\n') < 0 && index(s, '\r') < 0;
};

// Interface names reach shell command lines and sysfs paths, so restrict them to a safe alphabet. A leading "-" (an option to
// the command) and the path components "." and ".." are refused too.
export function safe_ifname(name) {
	return one_line(name) && length(name) > 0 && match(name, /^[A-Za-z0-9_.:-]+$/) != null &&
		substr(name, 0, 1) != '-' && name != '.' && name != '..';
};

// Return a lowercase colon-separated MAC from any common spelling, or null.
export function normalize_mac(raw) {
	let hex = lc(replace(raw, /[^0-9a-fA-F]/g, ''));
	if (length(hex) != 12)
		return null;
	// Split the 12 hex digits into six pairs; slice() drops the full-match element.
	return join(':', slice(match(hex, /(..)(..)(..)(..)(..)(..)/), 1));
};

// Numeric value of a string field, or null when absent or empty.
export function num(v) {
	return (v == null || v == '') ? null : +v;
};

// A UCI option as a list: UCI stores multi-value options as arrays but a single value as a plain string
// ("a b c" is also accepted); null becomes an empty list.
export function as_list(v) {
	return v == null ? [] : (type(v) == 'array' ? v : split(trim(v), /[[:space:]]+/));
};

// Channel, frequency, width, center frequency and TX power of a wireless interface, from `iw dev <if> info`.
// Only the keys iw reports are set. The interface name must already have passed safe_ifname().
export function iw_channel_info(ifname) {
	let out = {};
	for (let line in split(run(`iw dev ${ifname} info 2>/dev/null`), '\n')) {
		// e.g. "channel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz"; center1 is absent for 20 MHz.
		let m = match(line, /channel ([0-9]+) \(([0-9]+) MHz\), width: ([0-9]+) MHz(, center1: ([0-9]+) MHz)?/);
		if (m) {
			out.channel = +m[1];
			out.freq = +m[2];
			out.width = +m[3];
			out.center = num(m[5]);
		}
		if ((m = match(line, /txpower ([0-9.]+) dBm/)))
			out.txpower = +m[1];
	}
	return out;
};

// Human label for a UCI wireless `encryption` value. Order matters: the more specific patterns
// (psk2+psk3, psk-mixed) are tested before the substrings they contain (psk2, psk). An unrecognized
// value is returned unchanged.
export function security_label(enc) {
	enc ??= '';
	if (enc == '' || enc == 'none') return 'Open/None';
	if (match(enc, /owe/)) return 'OWE (Enhanced Open)';
	if (match(enc, /psk2\+psk3|sae-mixed/)) return 'WPA2/WPA3 Mixed';
	if (match(enc, /psk3|sae/)) return 'WPA3-Personal (SAE)';
	if (match(enc, /psk2/)) return 'WPA2-PSK';
	if (match(enc, /psk-mixed/)) return 'WPA/WPA2 Mixed';
	if (match(enc, /psk/)) return 'WPA-PSK';
	if (match(enc, /wpa3/)) return 'WPA3-Enterprise';
	if (match(enc, /wpa2/)) return 'WPA2-Enterprise';
	if (match(enc, /wpa/)) return 'WPA-Enterprise';
	if (match(enc, /wep/)) return 'WEP (Legacy)';
	return enc;
};
