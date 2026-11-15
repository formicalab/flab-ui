'use strict';

import { deferred } from 'flab.worker';
import { command_result } from 'flab.exec';
import { timer } from 'uloop';

let ticks = 0;
let pulse;
pulse = timer(50, () => { ticks++; pulse.set(50); });
let methods = deferred({
	'flab.execution-test': {
		sleep: { call: () => command_result('sleep 2; printf awake') },
		fail: { call: () => command_result('exit 9') },
		timeout: { call: () => command_result('sleep 4', { timeout: 1 }) },
		flood: { call: () => command_result('yes flood', { timeout: 1, max_output: 1024 }) },
		crash: { call: () => { die('synthetic worker failure'); } },
		noresult: { call: () => null },
		intentional: { call: () => ({ ok: false, error: 'Synthetic validation refusal.' }) },
		oversized: { call: () => {
			let text = 'x';
			for (let i = 0; i < 21; i++)
				text += text;
			return { text };
		} },
		deadline: { call: () => { while (true) {} } },
	},
});
methods['flab.execution-test'].pulse = { call: () => ({ ticks }) };
return methods;
