// Test harness: runs one method of the flab.asterisk plugin and prints its reply as JSON. FLAB_METHOD names the method (default status) and
// FLAB_ARGS holds its arguments as JSON. With FLAB_FIXTURES set the plugin replays saved output; with FLAB_RECORD set it saves what it reads.
// run.ps1 rewrites the loadfile path below to the plugin copy it uploaded and starts ucode with -L so that 'flab.util' and the other
// libraries resolve to the repository copies instead of the deployed ones.
const method = getenv('FLAB_METHOD') ?? 'status';
const args = json(getenv('FLAB_ARGS') ?? '{}');
const m = loadfile('/tmp/flab.asterisk.uc')();
print(sprintf('%J', m['flab.asterisk'][method].call({ args })), '\n');
