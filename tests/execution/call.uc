// Fixture-only direct-call seam. Never execute a service action or cable test on the router.
if (!getenv('FLAB_FIXTURES'))
	die('Fixtures are required.');
let plugin = loadfile(getenv('FLAB_PLUGIN'))();
let object = keys(plugin)[0];
let args = json(getenv('FLAB_ARGS') ?? '{}');
print(sprintf('%J\n', plugin[object][getenv('FLAB_METHOD') ?? 'status'].call({ args })));
