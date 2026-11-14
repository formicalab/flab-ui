// Test harness: runs one method of the flab.traffic plugin against saved fixtures (FLAB_FIXTURES) or, without them, against the
// real router (the nlbwmon_paths method only reads), and prints its result as JSON. FLAB_PLUGIN is the plugin path, FLAB_METHOD
// the method and FLAB_ARGS the JSON arguments of the call. run.ps1 starts ucode with -L so that 'flab.util' resolves to the
// repository copy instead of the deployed one.
let plugin = loadfile(getenv('FLAB_PLUGIN'))();
let object = keys(plugin)[0];
let method = getenv('FLAB_METHOD');
let args = getenv('FLAB_ARGS');
// Only the one method this suite tests may run: it never starts a program.
if (method != 'nlbwmon_paths') {
	warn('refusing to run ' + method + '\n');
	exit(2);
}
// Call the method like rpcd does (the arguments arrive as request.args) and print the result as JSON for assert.mjs.
print(sprintf('%J', plugin[object][method].call({ args: args ? json(args) : {} })), '\n');
