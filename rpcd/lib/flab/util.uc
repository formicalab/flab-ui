// Shared helpers for the flab-ui rpcd plugins. Deployed to /usr/share/ucode/flab/util.uc and
// imported as: import { run, fixture } from 'flab.util';

'use strict';

import { popen, readfile } from 'fs';

// Test seam: with FLAB_FIXTURES=<dir> set (never the case inside rpcd) run() returns saved command
// output instead of executing anything. The file is named after the command with every run of
// non-alphanumerics turned into "_" and a trailing "2>/dev/null" dropped, e.g.
// "swanctl --list-sas --raw 2>/dev/null" -> swanctl_list_sas_raw.txt
const FIXTURES = getenv('FLAB_FIXTURES');

// Contents of <FLAB_FIXTURES>/<name>, or null when the seam is inactive.
export function fixture(name) {
	return FIXTURES ? (readfile(`${FIXTURES}/${name}`) ?? '') : null;
}

// Run a shell command and return its stdout ('' on failure). Callers must pass only trusted strings.
export function run(cmd) {
	if (FIXTURES)
		return fixture(replace(replace(cmd, / 2>\/dev\/null$/, ''), /[^A-Za-z0-9]+/g, '_') + '.txt');

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
