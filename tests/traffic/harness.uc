// Test harness: runs one method of the flab.traffic plugin against saved fixtures (FLAB_FIXTURES) and prints its
// result as JSON. FLAB_PLUGIN is the plugin path, FLAB_METHOD the method (default: the first one) and FLAB_ARGS the
// JSON arguments of the call (default: none). run.ps1 starts ucode with -L so that 'flab.util' resolves to the
// repository copy instead of the deployed one. With FLAB_RECORD set, everything the plugin reads is saved (see
// rpcd/lib/flab/util.uc), which is how the real baseline is captured. With FLAB_TIME_FILE set, the milliseconds the
// call itself took are written to that file; the fixtures are loaded first, so loading them is not counted.
import { writefile } from 'fs';
import { sysfs_raw } from 'flab.util';

// Load the plugin module named by FLAB_PLUGIN.
let plugin = loadfile(getenv('FLAB_PLUGIN'))();
// The plugin exports one rpcd object; pick the method asked for.
let object = keys(plugin)[0];
let method = getenv('FLAB_METHOD') ?? keys(plugin[object])[0];
let args = getenv('FLAB_ARGS');
let timefile = getenv('FLAB_TIME_FILE');
if (timefile)
	sysfs_raw('/proc/net/nf_conntrack');
let t0 = clock(true);
// Call the method like rpcd does (the arguments arrive as request.args) and print the result as JSON for assert.mjs.
let result = plugin[object][method].call({ args: args ? json(args) : {} });
let t1 = clock(true);
if (timefile)
	writefile(timefile, `${(t1[0] - t0[0]) * 1000 + (t1[1] - t0[1]) / 1000000}\n`);
print(sprintf('%J', result), '\n');
