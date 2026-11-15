'use strict';

export const MAX_JOB_OUTPUT = 262144;

// Run in a freshly-created private job directory. A separate bounded pump, rather than a post-hoc head,
// guarantees out never grows past the total budget. Reaching it terminates the producer immediately.
export function launch_job(command, seconds) {
	return replace(`mkfifo stream || exit 1
	(
		ulimit -f 512
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
}
