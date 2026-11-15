'use strict';

import { command_result, begin_budget } from 'flab.exec';
import { launch_job, MAX_JOB_OUTPUT } from 'flab.jobs';
import { stat, readfile } from 'fs';

let out = {};
out.empty = command_result('exit 0');
out.failure = command_result('printf failed; exit 7');
out.timeout = command_result('sleep 4', { timeout: 1 });
out.flood = command_result('yes flood', { timeout: 1, max_output: 4096 });
let before = time();
out.silent_after_cap = command_result('head -c 8192 /dev/zero; sleep 4', { timeout: 5, max_output: 4096 });
out.silent_after_cap_seconds = time() - before;
out.launch = command_result(`cd ${getenv('FLAB_JOB_DIR')} || exit 1\n${launch_job('yes flood', 5)}`);
for (let i = 0; i < 6 && stat(`${getenv('FLAB_JOB_DIR')}/rc`) == null; i++)
	system('sleep 1');
out.job = {
	size: stat(`${getenv('FLAB_JOB_DIR')}/out`)?.size,
	limited: stat(`${getenv('FLAB_JOB_DIR')}/truncated`) != null,
	code: trim(readfile(`${getenv('FLAB_JOB_DIR')}/rc`) ?? ''),
	max: MAX_JOB_OUTPUT,
};
out.stream_launch = command_result(`cd ${getenv('FLAB_STREAM_DIR')} || exit 1\n${launch_job("sh -c 'printf header; sleep 1; printf first; sleep 3; printf last'", 7)}`);
system('sleep 2');
out.streaming = {
	text: readfile(`${getenv('FLAB_STREAM_DIR')}/out`) ?? '',
	running: stat(`${getenv('FLAB_STREAM_DIR')}/rc`) == null,
};
begin_budget(5);
for (let i = 0; i < 4; i++)
	command_result('head -c 262144 /dev/zero');
try {
	command_result('echo must-not-run');
	out.aggregate = false;
} catch (e) {
	out.aggregate = true;
}
print(sprintf('%J\n', out));
