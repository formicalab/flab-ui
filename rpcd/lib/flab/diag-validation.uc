'use strict';

// Request validators and command-line quoting for flab.diag. Keep every browser-supplied value behind these
// helpers before it reaches a shell command, script or job path.
import { safe_ifname } from 'flab.util';

export function whole(s, re) {
	let m = type(s) == 'string' ? match(s, re) : null;
	return m != null && m[0] == s;
};

export function valid_host(s) {
	return whole(s, /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,252}$/);
};

export function is_address(s) {
	if (whole(s, /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/))
		return true;
	return type(s) == 'string' && index(s, ':') >= 0 && whole(s, /^[0-9A-Fa-f:.]{2,45}$/);
};

export function valid_iface(s) {
	return safe_ifname(s) && substr(s, 0, 1) != '-';
};

export function int_in(v, lo, hi, def) {
	if (v == null || (type(v) == 'string' && v == ''))
		return def;
	let n = +v;
	return (n >= lo && n <= hi && n == int(n)) ? int(n) : null;
};

export function valid_job_id(s) {
	return whole(s, /^[0-9a-f]{12}$/);
};

// One shell word. No line break or NUL is accepted; single quotes are escaped for BusyBox sh.
export function shell_word(value) {
	let s = '' + value;
	if (index(s, '\n') >= 0 || index(s, '\r') >= 0 || index(s, '\0') >= 0)
		return null;
	return match(s, /^[A-Za-z0-9_./:=+@,-]+$/) ? s : "'" + replace(s, "'", "'\\''") + "'";
};

// A command assembled from already-validated words. It rejects line breaks and quotes every argument, so a
// future validator regression cannot turn one argument into shell syntax. Returns null for an invalid word.
export function command_line(words) {
	let out = [];
	for (let word in words ?? []) {
		let quoted = shell_word(word);
		if (quoted == null)
			return null;
		push(out, quoted);
	}
	return length(out) ? join(' ', out) : null;
};
