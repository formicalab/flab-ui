// Test harness: runs one rpcd plugin against saved fixtures (FLAB_FIXTURES) and prints its first method's
// result as JSON. The plugin path comes from FLAB_PLUGIN; run.ps1 starts ucode with -L so that
// Test harness: runs one rpcd plugin against saved fixtures (FLAB_FIXTURES) and prints its first method's
// result as JSON. The plugin path comes from FLAB_PLUGIN; run.ps1 starts ucode with -L so that
// 'flab.util' resolves to the repository copy instead of the deployed one. With FLAB_RECORD set, every
// real call the plugin makes is additionally saved (see rpcd/lib/flab/util.uc), which is how run.ps1 captures a baseline.
// Load the plugin module named by FLAB_PLUGIN.
let plugin = loadfile(getenv('FLAB_PLUGIN'))();
// A plugin exports one rpcd object with one method; take the first of each.
let object = keys(plugin)[0];
let method = keys(plugin[object])[0];
// Call the method and print its result as JSON for assert.mjs.
print(sprintf('%J', plugin[object][method].call()), '\n');
