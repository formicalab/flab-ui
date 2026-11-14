// Test harness: runs the status call of the flab.wireguard plugin named by FLAB_PLUGIN and prints the reply as JSON.
// With FLAB_FIXTURES set the plugin runs nothing (see rpcd/lib/flab/util.uc). Without it the call reads the real router (uci, wg show,
// procfs), which changes nothing.
let plugin = loadfile(getenv('FLAB_PLUGIN'))()['flab.wireguard'];
print(sprintf('%J', plugin.status.call({ args: {} })), '\n');
