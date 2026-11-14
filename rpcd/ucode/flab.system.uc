#!/usr/bin/ucode
//
// rpcd ucode plugin with CPU statistics as JSON: ubus call flab.system cpu
//
// Returns the kernel's cumulative CPU time counters (/proc/stat), the load average and the task counts.
// Utilization is a rate, so it is derived from the difference between two successive calls (the UI does
// this); the counters are not converted here, which keeps the call instantaneous and rpcd unblocked.
// Reads procfs only; no other tool is involved.

'use strict';

import { readfile } from 'fs';

// Order of the columns on a "cpu" line in /proc/stat (guest times are already part of user/nice).
const FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];

// Parses the text of /proc/stat into { cpus: [{ id, user, nice, ... }], ctxt, procs_running,
// procs_blocked }. The "cpu" line is the all-core total; "cpuN" lines are the individual cores. Values are
// cumulative jiffies (USER_HZ ticks), left unconverted; missing columns on old kernels count as 0.
function parse_stat(text) {
	let out = { cpus: [], ctxt: null, procs_running: null, procs_blocked: null };

	for (let line in split(text ?? '', '\n')) {
		let m = match(line, /^(cpu[0-9]*)[ ]+(.*)$/);
		if (m) {
			// Counters follow the id in the order given by FIELDS.
			let tok = split(trim(m[2]), /[ ]+/);
			let cpu = { id: m[1] };
			for (let i = 0; i < length(FIELDS); i++)
				cpu[FIELDS[i]] = +(tok[i] ?? 0);
			push(out.cpus, cpu);
			continue;
		}

		m = match(line, /^(ctxt|procs_running|procs_blocked) ([0-9]+)/);
		if (m)
			out[m[1]] = +m[2];
	}
	return out;
}

// Builds the flab.system cpu reply from /proc/stat, /proc/loadavg and /proc/uptime. `cores` counts the
// per-core "cpuN" entries (the aggregate "cpu" entry is excluded); fields are null when a file is unreadable.
function collect() {
	let stat = parse_stat(readfile('/proc/stat'));

	// "0.01 0.03 0.05 2/210 16460": three averages, runnable/total tasks, last pid.
	let la = match(readfile('/proc/loadavg') ?? '', /^([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9]+)\/([0-9]+)/);
	let up = match(readfile('/proc/uptime') ?? '', /^([0-9.]+)/);

	return {
		generated: time(),
		// Router uptime lets the UI detect gaps between samples (e.g. after a pause) without its own clock.
		uptime: up ? +up[1] : null,
		cores: length(filter(stat.cpus, (c) => c.id != 'cpu')),
		cpus: stat.cpus,
		ctxt: stat.ctxt,
		procs_running: stat.procs_running,
		procs_blocked: stat.procs_blocked,
		load: la ? [+la[1], +la[2], +la[3]] : null,
		runnable: la ? +la[4] : null,
		tasks: la ? +la[5] : null,
	};
}

// rpcd registration: ubus object flab.system with the single method `cpu` (no arguments).
return {
	'flab.system': {
		cpu: {
			call: function(request) {
				return collect();
			},
		},
	},
};
