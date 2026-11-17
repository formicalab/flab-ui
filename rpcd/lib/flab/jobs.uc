'use strict';

// Starts a long-running command (a packet capture, an iperf3 run) as a detached background job whose output is collected
// in the job directory the script is run in, so rpcd never waits for it. `command` goes into a shell script: build it from
// constants and validated values only (see flab.util). The job writes there:
//   out         the first MAX_JOB_OUTPUT bytes of stdout and stderr      pid        the command's process id
//   rc          its exit status, written when it ends                    timed_out  exists when `seconds` ran out
//   truncated   exists when the output reached MAX_JOB_OUTPUT (the command is then stopped)
export const MAX_JOB_OUTPUT = 262144;

// Returns the shell script text; the caller runs it in a freshly created private job directory. A separate bounded pump, rather
// than a post-hoc head, guarantees out never grows past the total budget. Reaching it terminates the producer immediately.
// `seconds` is the command's time limit. `fsize` is the size limit of the files the job writes, in 512 byte blocks (default
// 512, 256 KiB; a packet capture needs more).
export function launch_job(command, seconds, fsize) {
	if (fsize == null)
		fsize = 512;
	return replace(`mkfifo stream || exit 1
	(
		ulimit -f ${fsize}
		(
			start=$(date +%s)
			timeout -k 2 ${seconds} ${command} >stream 2>&1 & p=$!
			echo $p >pid
			wait $p; code=$?
			if [ "$(( $(date +%s) - start ))" -ge ${seconds} ] && { [ "$code" = 143 ] || [ "$code" = 137 ] || [ "$code" = 124 ]; }; then
				: >timed_out
			fi
			echo $code >rc
		) &
		supervisor=$!
		dd bs=1 count=${MAX_JOB_OUTPUT} <stream >out 2>/dev/null
		if [ "$(wc -c <out)" -ge ${MAX_JOB_OUTPUT} ]; then
			: >truncated
			read p <pid; kill "$p" 2>/dev/null
		fi
		wait "$supervisor"
		rm -f stream
	) </dev/null >/dev/null 2>&1 &`, /\r/g, '');
};
