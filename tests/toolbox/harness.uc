// Test harness: runs one method of the flab.routing plugin against saved fixtures (FLAB_FIXTURES) and prints its
// result as JSON. FLAB_PLUGIN is the plugin path, FLAB_METHOD the method (default: the first one) and FLAB_ARGS the
// JSON arguments of the call (default: none). run.ps1 starts ucode with -L so that 'flab.util' resolves to the
// repository copy instead of the deployed one. With FLAB_RECORD set, every real command the plugin runs is saved
// (see rpcd/lib/flab/util.uc), which is how the real baseline is captured.
// Load the plugin module named by FLAB_PLUGIN.
let plugin = loadfile(getenv('FLAB_PLUGIN'))();
// The plugin exports one rpcd object; pick the method asked for.
let object = keys(plugin)[0];
let method = getenv('FLAB_METHOD') ?? keys(plugin[object])[0];
let args = getenv('FLAB_ARGS');
// Call the method like rpcd does (the arguments arrive as request.args) and print the result as JSON for assert.mjs.
print(sprintf('%J', plugin[object][method].call({ args: args ? json(args) : {} })), '\n');
