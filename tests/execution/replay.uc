import { command_result } from 'flab.exec';
if (!getenv('FLAB_FIXTURES'))
	die('Fixtures are required.');
print(sprintf('%J\n', command_result('synthetic command')));
