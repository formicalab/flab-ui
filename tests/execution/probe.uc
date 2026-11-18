'use strict';

import { command_result, begin_budget } from 'flab.exec';
import { launch_job, MAX_JOB_OUTPUT } from 'flab.jobs';
import { command_line, int_in, valid_host } from 'flab.diag-validation';
import { read_job } from 'flab.diag-jobs';
import { mkdir, readfile, stat, writefile } from 'fs';
import { safe_ifname, one_line } from 'flab.util';

let out = {};
// ucode's `^...$` matches the first line of a multi-line string; the validators must refuse the second line.
out.validators = {
	ifname: safe_ifname('lan1'),
	ifname_newline: safe_ifname('lan1\nid'),
	ifname_cr: safe_ifname('lan1\rid'),
	ifname_empty: safe_ifname(''),
	ifname_number: safe_ifname(5),
	line: one_line('1.1.1.1'),
	line_newline: one_line('1.1.1.1\nid'),
	line_cr: one_line('1.1.1.1\rid'),
	line_null: one_line(null),
	host: valid_host('router.example'),
	host_option: valid_host('-bad.example'),
	number: int_in('12', 1, 20, 5),
	number_bad: int_in('12x', 1, 20, 5),
	command: command_line(['ping', '-c', 3, 'router.example']),
	command_refuses_line: command_line(['ping', '127.0.0.1\nid']) == null,
};
mkdir(`${getenv('FLAB_JOB_DIR')}/abcdef123456`);
writefile(`${getenv('FLAB_JOB_DIR')}/abcdef123456/out`, "first\nsecond\n");
writefile(`${getenv('FLAB_JOB_DIR')}/abcdef123456/rc`, '0\n');
out.job_read = read_job(getenv('FLAB_JOB_DIR'), 'abcdef123456', 0, 64, 262144);
out.job_bad_id = read_job(getenv('FLAB_JOB_DIR'), '../../etc', 0, 64, 262144);
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
