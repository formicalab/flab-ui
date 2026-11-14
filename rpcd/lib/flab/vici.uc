// Reader for strongSwan's VICI protocol through `swanctl --raw`. Deployed to
// /usr/share/ucode/flab/vici.uc and imported as: import { query, events, reply } from 'flab.vici';
//
// `swanctl --list-sas --raw` prints one event per line in the form
//   list-sa event {Name {key=value list=[a b] section {...}}}
// Scalar values may contain spaces ("class=pre-shared key"), so a value ends where the next
// "key=" or "key {" token starts. Only the swanctl binary is used.

'use strict';

import { run } from 'flab.util';

// True when `o` (a character code from ord()) can be part of a VICI key: [0-9A-Za-z_.-].
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
// Returns null when the line has no "{". Character codes used below: 32 space, 61 "=", 91 "[", 93 "]",
// 123 "{", 125 "}".
function parse_body(line) {
	let n = length(line);
	let i = index(line, '{');
	if (i < 0)
		return null;
	i++;

	// Parses "key=value", "key=[list]" and "key {...}" entries until the closing "}" of the current
	// section; `i` is shared with the caller so nested sections advance the same cursor.
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

			// "key {" is written with a space before the brace; "key{" and "key=" have none.
			if (ord(line, i) == 32 && ord(line, i + 1) == 123)
				i++;
			o = ord(line, i);

			if (o == 123) {
				i++;
				obj[key] = section();
			}
			else if (o == 61) {
				i++;
				// "[a b c]" is a list value; an empty "[]" gives an empty array.
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
					// Scalar: runs to the closing "}" or to the space before the next "key=" / "key {".
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

// Run a streaming swanctl command (list-sas, list-conns, ...) and return every event as
// { name, body } in output order. Several events can share a name (e.g. two IKE SAs of one connection).
export function events(cmd) {
	let out = [];
	for (let line in split(run('swanctl --' + cmd + ' --raw 2>/dev/null'), '\n')) {
		if (!match(line, /^[a-z-]+ event \{/))
			continue;
		let ev = parse_body(line);
		for (let k, v in ev ?? {})
			push(out, { name: k, body: v });
	}
	return out;
}

// Like events(), merged into one object keyed by name; a later event replaces an earlier one with the
// same name, so use it only where names are unique (list-conns).
export function query(cmd) {
	let out = {};
	for (let e in events(cmd))
		out[e.name] = e.body;
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
