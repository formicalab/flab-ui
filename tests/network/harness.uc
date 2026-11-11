// Test harness: runs one rpcd plugin against saved fixtures (FLAB_FIXTURES) and prints its first method's
// result as JSON. The plugin path comes from FLAB_PLUGIN; run.ps1 starts ucode with -L so that
// 'flab.util' resolves to the repository copy instead of the deployed one.
let plugin = loadfile(getenv('FLAB_PLUGIN'))();
let object = keys(plugin)[0];
let method = keys(plugin[object])[0];
print(sprintf('%J', plugin[object][method].call()), '\n');
