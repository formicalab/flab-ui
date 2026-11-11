// Test harness: runs the flab.bgp plugin against saved fixtures (FLAB_BGP_FIXTURES) and prints JSON.
// run.ps1 rewrites the loadfile path below to the plugin copy it uploaded.
const m = loadfile('/tmp/flab.bgp.uc')();
print(sprintf('%J', m['flab.bgp'].status.call()), '\n');
