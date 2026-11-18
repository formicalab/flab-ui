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
		status: { call: () => command_result('sleep 2; printf status') },
		config: { call: () => ({ interfaces: [], devices: [] }) },
		control: { call: () => command_result('sleep 3; printf control') },
		// Intentionally last: a reused loop binding must not classify preceding read methods as mutations.
		cable_test: { call: () => ({ ok: true }) },
	},
});
let other = deferred({
	'flab.execution-other': {
		sleep: { call: () => command_result('sleep 2; printf other') },
	},
	'flab.execution-third': {
		sleep: { call: () => command_result('sleep 2; printf third') },
	},
});
for (let object, handlers in other)
	methods[object] = handlers;
methods['flab.execution-test'].pulse = { call: () => ({ ticks }) };
return methods;
