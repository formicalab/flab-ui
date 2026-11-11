// Test harness: runs the flab.ipsec plugin against saved fixtures (FLAB_FIXTURES) and prints JSON.
// run.ps1 rewrites the loadfile path below to the plugin copy it uploaded and starts ucode with -L so
// that 'flab.util' and 'flab.vici' resolve to the repository copies instead of the deployed ones.
// Load the plugin module, call its rpcd "status" method once and print the result as JSON for assert.mjs.
const m = loadfile('/tmp/flab.ipsec.uc')();
print(sprintf('%J', m['flab.ipsec'].status.call()), '\n');
