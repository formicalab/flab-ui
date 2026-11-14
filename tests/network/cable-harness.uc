// Test harness for the cable-test method of flab.network: makes the calls listed in the file named by FLAB_CASES against the plugin named
// by FLAB_PLUGIN and prints the results as one JSON object keyed by call id. It only runs with FLAB_FIXTURES set (see
// rpcd/lib/flab/util.uc): the plugin then runs no command, so no cable is ever tested and no link ever drops. Without fixtures the
// harness stops, because the call would act on the real router.
import { readfile } from 'fs';
if (!getenv('FLAB_FIXTURES')) {
	warn('refusing to run a cable test on a real router\n');
	exit(2);
}
let plugin = loadfile(getenv('FLAB_PLUGIN'))()['flab.network'];
let cases = json(readfile(getenv('FLAB_CASES')));
let out = {};
// Make every call and keep its result.
for (let c in cases)
	out[c.id] = plugin.cable_test.call({ args: c.args });
print(sprintf('%J', out), '\n');
