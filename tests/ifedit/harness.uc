// Test harness: runs the calls listed in the file named by FLAB_CASES against the flab.network plugin named by FLAB_PLUGIN and prints the
// results as one JSON object keyed by call id. Only `config` is allowed, which only reads; any other call stops the harness (a call such as
// `cable_test` could change the link of a real router).
import { readfile } from 'fs';
let plugin = loadfile(getenv('FLAB_PLUGIN'))()['flab.network'];
let cases = json(readfile(getenv('FLAB_CASES')));
let out = {};
// Make every call and keep its result.
for (let c in cases) {
	if (c.method != 'config') {
		warn('refusing to run ' + c.method + '\n');
		exit(2);
	}
	out[c.id] = plugin[c.method].call({ args: c.args });
}
print(sprintf('%J', out), '\n');
