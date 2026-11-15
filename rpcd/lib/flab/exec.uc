'use strict';

import { popen, readfile, writefile } from 'fs';

const MAX_COMMAND_OUTPUT = 262144;
const MAX_REQUEST_OUTPUT = 1048576;
const MAX_COMMAND_SECONDS = 20;
let budget = null;

function now() {
	let t = clock(true);
	return t[0] + t[1] / 1000000000;
}

export function begin_budget(seconds) {
	budget = { end: now() + seconds, left: MAX_REQUEST_OUTPUT };
};

function stem(cmd) {
	return replace(replace(cmd, / 2>\/dev\/null$/, ''), /[^A-Za-z0-9]+/g, '_');
}

function quote(s) {
	return "'" + replace(s, "'", "'\\''") + "'";
}

// Synchronous by design, but called only in a deferred worker or a direct test harness.
// close() preserves the real shell exit status, including negative signal numbers.
export function command_result(cmd, options) {
	options ??= {};
	let cap = int(options.max_output ?? MAX_COMMAND_OUTPUT);
	cap = min(MAX_COMMAND_OUTPUT, max(1, cap));
	let seconds = min(MAX_COMMAND_SECONDS, max(1, int(options.timeout ?? MAX_COMMAND_SECONDS)));
	if (budget) {
		if (budget.left <= 0 || now() >= budget.end)
			die('The request command budget was exhausted.');
		cap = min(cap, budget.left);
		seconds = min(seconds, max(1, int(budget.end - now())));
	}
	let name = stem(cmd), fixtures = getenv('FLAB_FIXTURES');
	let started = now();
	let result;
	if (fixtures) {
		let saved = readfile(`${fixtures}/${name}.result.json`);
		let text = readfile(`${fixtures}/${name}.txt`);
		result = saved ? json(saved) : { output: text ?? '', code: text == null ? null : 0 };
		// Text is canonical so synthetic scenarios can edit captured output without rewriting status metadata.
		if (text != null)
			result.output = text;
	} else {
		// The outer timeout also bounds a daemon which inherits stdout without exiting.
		// Reading at most cap+1 bounds allocation even when the producer never stops.
		let p = popen(`printf '%s\\n' "$$"; exec timeout -k 1 ${seconds} sh -c ${quote(cmd)} 2>&1`, 'r');
		if (!p)
			return { ok: false, code: null, output: '', truncated: false, timed_out: false };
		let pid = trim(p.read('line') ?? '');
		let output = '';
		while (length(output) <= cap) {
			let chunk = p.read(min(4096, cap + 1 - length(output)));
			if (chunk == null || chunk == '')
				break;
			output += chunk;
		}
		if (length(output) > cap && match(pid, /^[0-9]+$/)) {
			// This wait is inside the worker. Do not leave a silent producer running after its pipe fills.
			system(`/bin/kill -TERM ${pid} 2>/dev/null`);
		}
		let code = p.close();
		result = { output, code };
	}
	let truncated = length(result.output ?? '') > cap || result.truncated == true;
	let output = substr(result.output ?? '', 0, cap);
	if (budget)
		budget.left -= length(output);
	let timed_out = result.timed_out == true || result.code == 124 ||
		(index([ -15, -9, 143, 137 ], result.code) >= 0 && now() - started >= seconds - 0.05);
	let out = { ok: result.code === 0 && !truncated && !timed_out, code: result.code, output, truncated, timed_out };
	let record = getenv('FLAB_RECORD');
	if (record) {
		writefile(`${record}/${name}.txt`, output);
		writefile(`${record}/${name}.result.json`, sprintf('%J', { code: out.code, truncated, timed_out }));
	}
	return out;
};
