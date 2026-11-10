// Reader for strongSwan's VICI protocol through `swanctl --raw`. Deployed to
// /usr/share/ucode/flab/vici.uc and imported as: import { query, reply } from 'flab.vici';
//
// `swanctl --list-sas --raw` prints one event per line in the form
//   list-sa event {Name {key=value list=[a b] section {...}}}
// Scalar values may contain spaces ("class=pre-shared key"), so a value ends where the next
// "key=" or "key {" token starts. Only the swanctl binary is used; no LuCI component is involved.

'use strict';

import { run } from 'flab.util';

function is_key_char(o) {
	return (o >= 48 && o <= 57) || (o >= 65 && o <= 90) || (o >= 97 && o <= 122) || o == 95 || o == 46 || o == 45;
}

// True when a "key=" or "key {" token begins at `pos`.
function starts_token(s, pos) {
	let i = pos;
	while (is_key_char(ord(s, i)))
		i++;
	if (i == pos)
		return false;
	let o = ord(s, i);
	return o == 61 || o == 123 || (o == 32 && ord(s, i + 1) == 123);
}

// Parse the "{...}" body that follows the first "{" of a raw VICI line into nested objects.
function parse_body(line) {
	let n = length(line);
	let i = index(line, '{');
	if (i < 0)
		return null;
	i++;

	function section() {
		let obj = {};
		while (i < n) {
			let o = ord(line, i);
			if (o == 32) { i++; continue; }
			if (o == 125) { i++; return obj; }

			let start = i;
			while (is_key_char(ord(line, i)))
				i++;
			if (i == start) { i++; continue; }
			let key = substr(line, start, i - start);

			if (ord(line, i) == 32 && ord(line, i + 1) == 123)
				i++;
			o = ord(line, i);

			if (o == 123) {
				i++;
				obj[key] = section();
			}
			else if (o == 61) {
				i++;
				if (ord(line, i) == 91) {
					i++;
					let vs = i;
					while (i < n && ord(line, i) != 93)
						i++;
					let text = substr(line, vs, i - vs);
					i++;
					obj[key] = (text == '') ? [] : split(text, ' ');
				}
				else {
					let vs = i;
					while (i < n) {
						let c = ord(line, i);
						if (c == 125 || (c == 32 && starts_token(line, i + 1)))
							break;
						i++;
					}
					obj[key] = substr(line, vs, i - vs);
				}
			}
		}
		return obj;
	}

	return section();
}

// Run a streaming swanctl command (list-sas, list-conns, ...) and merge all event objects.
export function query(cmd) {
	let out = {};
	for (let line in split(run('swanctl --' + cmd + ' --raw 2>/dev/null'), '\n')) {
		if (!match(line, /^[a-z-]+ event \{/))
			continue;
		let ev = parse_body(line);
		for (let k, v in ev ?? {})
			out[k] = v;
	}
	return out;
}

// Run a request/reply swanctl command (stats, ...) and return its parsed reply, or null when
// the daemon is unreachable.
export function reply(cmd) {
	for (let line in split(run('swanctl --' + cmd + ' --raw 2>/dev/null'), '\n')) {
		if (match(line, /^[a-z-]+ reply \{/))
			return parse_body(line);
	}
	return null;
}
