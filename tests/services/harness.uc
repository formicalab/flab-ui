// Test harness: runs the calls listed in the file named by FLAB_CASES against the flab.services plugin named by
// FLAB_PLUGIN and prints the results as one JSON object keyed by call id.
// With FLAB_FIXTURES set the plugin runs nothing (see rpcd/lib/flab/util.uc). Without it the plugin would act on the
// real router, so only `list` (which only reads) is allowed then; any other call stops the harness.
// Load the plugin and the calls.
import { readfile } from 'fs';
let plugin = loadfile(getenv('FLAB_PLUGIN'))()['flab.services'];
let cases = json(readfile(getenv('FLAB_CASES')));
let replay = getenv('FLAB_FIXTURES') != null && getenv('FLAB_FIXTURES') != '';
let out = {};
// Make every call and keep its result.
for (let c in cases) {
	if (!replay && c.method != 'list') {
		warn('refusing to run ' + c.method + ' on a real router\n');
		exit(2);
	}
	out[c.id] = plugin[c.method].call({ args: c.args });
}
print(sprintf('%J', out), '\n');
