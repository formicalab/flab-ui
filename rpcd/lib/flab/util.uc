// Shared helpers for the flab-ui rpcd plugins. Deployed to /usr/share/ucode/flab/util.uc and
// imported as: import { run } from 'flab.util';

'use strict';

import { popen } from 'fs';

// Run a shell command and return its stdout ('' on failure). Callers must pass only trusted strings.
export function run(cmd) {
	let p = popen(cmd, 'r');
	if (!p)
		return '';
	let out = p.read('all') ?? '';
	p.close();
	return out;
}

// Interface names reach shell command lines, so restrict them to a safe alphabet.
export function safe_ifname(name) {
	return name && match(name, /^[A-Za-z0-9_.:-]+$/) != null;
}

// Return a lowercase colon-separated MAC from any common spelling, or null.
export function normalize_mac(raw) {
	let hex = lc(replace(raw, /[^0-9a-fA-F]/g, ''));
	if (length(hex) != 12)
		return null;
	return join(':', slice(match(hex, /(..)(..)(..)(..)(..)(..)/), 1));
}

// Numeric value of a string field, or null when absent or empty.
export function num(v) {
	return (v == null || v == '') ? null : +v;
}
