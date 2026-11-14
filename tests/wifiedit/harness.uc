// Test harness: runs the calls listed in the file named by FLAB_CASES against the flab.radio plugin named by FLAB_PLUGIN and
// prints the results as one JSON object keyed by call id.
// With FLAB_FIXTURES set the plugin runs nothing (see rpcd/lib/flab/util.uc). Without it the plugin acts on the real router; both
// methods only read, so that is allowed, and it is how the test checks the stored secrets of the real router do not leak.
// Load the plugin and the calls.
import { readfile } from 'fs';
let plugin = loadfile(getenv('FLAB_PLUGIN'))()['flab.radio'];
let cases = json(readfile(getenv('FLAB_CASES')));
let out = {};
// Make every call and keep its result.
for (let c in cases)
	out[c.id] = plugin[c.method].call({ args: c.args });
print(sprintf('%J', out), '\n');
