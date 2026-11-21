// Test harness: runs the flab.bgp plugin against saved fixtures (FLAB_BGP_FIXTURES) and prints JSON.
// run.ps1 rewrites the loadfile path below to the plugin copy it uploaded.
// Calls one rpcd method of the plugin and prints the result as JSON for assert.mjs: `status` unless FLAB_BGP_METHOD names another;
// for `action` the arguments come from FLAB_BGP_NAME and FLAB_BGP_ACTION.
const m = loadfile('/tmp/flab.bgp.uc')();
const method = getenv('FLAB_BGP_METHOD') ?? 'status';
const args = method == 'action' ? { name: getenv('FLAB_BGP_NAME'), action: getenv('FLAB_BGP_ACTION') } : {};
print(sprintf('%J', m['flab.bgp'][method].call({ args })), '\n');
