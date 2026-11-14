// Test harness: runs the status call of the flab.firewall plugin named by FLAB_PLUGIN against the fixtures named by FLAB_FIXTURES (the plugin
// then runs no command and touches nothing) and prints the result as JSON. run.ps1 starts ucode with -L so that 'flab.util' resolves to the
// repository copy instead of the deployed one. The call only reads, so it is also made against the real router without fixtures.
// Load the plugin module named by FLAB_PLUGIN.
let plugin = loadfile(getenv('FLAB_PLUGIN'))();
// Call the status method and print its result as JSON for assert.mjs.
print(sprintf('%J', plugin['flab.firewall'].status.call()), '\n');
