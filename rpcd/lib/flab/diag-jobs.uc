'use strict';

// Bounded lifecycle and I/O for the background jobs of flab.diag. Browser-supplied ids are validated in
// flab.diag-validation before they enter these functions.
import { access, lsdir, mkdir, open, readfile, stat } from 'fs';
import { run } from 'flab.util';
import { int_in, valid_job_id } from 'flab.diag-validation';

// The state of a job from its files: `rc` (written when the command ends) means finished; otherwise the job runs while its
// `pid` is alive. Before `pid` exists a job counts as running for its first 3 seconds. `mtime` is that of `out` (the job
// directory before `out` exists).
function job_state(root, id) {
	let dir = `${root}/${id}`;
	let rc = trim(readfile(`${dir}/rc`) ?? '');
	let pid = trim(readfile(`${dir}/pid`) ?? '');
	pid = match(pid, /^[0-9]+$/) ? +pid : null;
	let st = stat(`${dir}/out`) ?? stat(dir);
	let age = st ? time() - st.mtime : 0;
	if (rc != '')
		return { running: false, exit: +rc, pid, mtime: st?.mtime };
	if (pid == null)
		return { running: age < 3, exit: null, pid, mtime: st?.mtime };
	return { running: access(`/proc/${pid}`) == true, exit: null, pid, mtime: st?.mtime };
}

// Removes finished jobs older than `keep` seconds, then the oldest finished ones until fewer than `max_jobs` directories are
// left (room for a new job). Returns how many jobs still run; those are never removed.
export function sweep_jobs(root, keep, max_jobs) {
	let running = 0, kept = [];
	for (let id in filter(lsdir(root) ?? [], valid_job_id)) {
		let state = job_state(root, id);
		if (state.running) {
			running++;
			continue;
		}
		if (state.mtime != null && time() - state.mtime > keep)
			run(`rm -rf ${root}/${id}`);
		else
			push(kept, { id, mtime: state.mtime ?? 0 });
	}
	kept = sort(kept, (a, b) => a.mtime - b.mtime);
	while (length(kept) >= max_jobs)
		run(`rm -rf ${root}/${shift(kept).id}`);
	return running;
};

export function new_job_id(root) {
	for (let i = 0; i < 5; i++) {
		let id = hexenc(readfile('/dev/urandom', 6) ?? '');
		if (valid_job_id(id) && mkdir(`${root}/${id}`))
			return id;
	}
	return null;
};

export function read_job(root, id, from, max_read, max_output) {
	if (!valid_job_id(id) || stat(`${root}/${id}`) == null)
		return { ok: false, error: 'There is no such job.' };
	let path = `${root}/${id}/out`;
	let total = stat(path)?.size ?? 0;
	from = int_in(from, 0, 1000000000, 0) ?? 0;
	if (from > total)
		from = total;
	let text = '';
	if (from < total) {
		let file = open(path, 'r');
		if (file != null) {
			file.seek(from);
			text = file.read(max_read) ?? '';
			file.close();
		}
		if (from + length(text) < total) {
			let cut = rindex(text, '\n');
			if (cut >= 0)
				text = substr(text, 0, cut + 1);
		}
	}
	let state = job_state(root, id);
	return {
		ok: true, id, running: state.running, exit: state.exit,
		size: from + length(text), text,
		truncated: from + length(text) < total,
		output_limited: stat(`${root}/${id}/truncated`) != null,
		max_output,
		timed_out: stat(`${root}/${id}/timed_out`) != null || state.exit == 124 || state.exit == 137,
		stopped: state.exit == 143 && stat(`${root}/${id}/timed_out`) == null && stat(`${root}/${id}/truncated`) == null,
	};
};

export function download_job(root, id, from, chunk_size) {
	if (!valid_job_id(id) || stat(`${root}/${id}`) == null)
		return { ok: false, error: 'There is no such job.' };
	let path = `${root}/${id}/cap.pcap`;
	let st = stat(path);
	if (st == null)
		return { ok: false, error: 'This job has no capture file. A newer capture may have replaced it.' };
	from = int_in(from, 0, 1000000000, 0) ?? 0;
	let data = '';
	let file = from < st.size ? open(path, 'r') : null;
	if (file != null) {
		file.seek(from);
		data = file.read(chunk_size) ?? '';
		file.close();
	}
	return { ok: true, id, from, size: st.size, length: length(data), data: b64enc(data),
		done: from + length(data) >= st.size, running: job_state(root, id).running };
};

export function stop_job(root, id, allowed_processes) {
	if (!valid_job_id(id) || stat(`${root}/${id}`) == null)
		return { ok: false, error: 'There is no such job.' };
	let state = job_state(root, id);
	if (!state.running)
		return { ok: true, id, running: false };
	if (state.pid != null) {
		let comm = trim(readfile(`/proc/${state.pid}/comm`) ?? '');
		let cmdline = readfile(`/proc/${state.pid}/cmdline`) ?? '';
		if (index(allowed_processes, comm) >= 0 || (comm == 'sh' && index(cmdline, 'job.sh') >= 0))
			run(`kill ${state.pid} 2>/dev/null`);
	}
	return { ok: true, id, running: false };
};
