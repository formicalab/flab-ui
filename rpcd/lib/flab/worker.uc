'use strict';

import { task, timer } from 'uloop';
import { STATUS_NO_DATA, STATUS_TIMEOUT, STATUS_NO_MEMORY, STATUS_UNKNOWN_ERROR } from 'ubus';
import { begin_budget } from 'flab.exec';

// Stay below rpcd's default 30-second request timeout, including cleanup.
const DEADLINE = 24;
const MAX_REPLY = 1048576;
// One bounded pool per plugin module, shared by its requests; excess calls fail instead of queueing.
const MAX_WORKERS = 4;

export function deferred(objects) {
	let active = 0, mutations = {};
	for (let object, methods in objects)
		for (let name, method in methods) {
			let handler = method.call;
			// ucode reuses for-in bindings: capture method classification and object identity before closing over them.
			let object_name = object;
			let mutating = index([ 'control', 'start', 'stop', 'wake', 'cable_test' ], name) >= 0;
			method.call = function(request) {
				// Fixture/direct-call harnesses intentionally keep their synchronous API.
				if (type(request?.defer) != 'function')
					return handler(request);
				if (active >= MAX_WORKERS || (mutating && mutations[object_name])) {
					request.reply({ error: 'This object is busy. Try again shortly.' }, STATUS_UNKNOWN_ERROR);
					return null;
				}
				let args = request.args;
				let pending = request.defer();
				let finished = false, guard, child;
				let finish = (result, status) => {
					if (finished)
						return;
					finished = true;
					active--;
					if (mutating)
						delete mutations[object_name];
					guard?.cancel();
					request.reply(result, status);
				};
				active++;
				if (mutating)
					mutations[object_name] = true;
				child = task(() => {
					// Module caches are private fork snapshots. Results are returned, never merged into rpcd's VM.
					begin_budget(DEADLINE - 2);
					try {
						let result = handler({ args });
						if (type(result) != 'object')
							return { response: { error: 'The backend worker returned no result.' }, status: STATUS_NO_DATA };
						if (length(sprintf('%J', result)) > MAX_REPLY)
							return { response: { error: 'The request result exceeded its output budget.', truncated: true }, status: STATUS_NO_MEMORY };
						// Keep transport failures separate from deliberate handler payloads such as { ok: false }.
						return { response: result, status: 0 };
					} catch (e) {
						return { response: { error: `The backend request failed: ${e}` }, status: STATUS_UNKNOWN_ERROR };
					}
				}, (message) => {
					if (type(message?.response) != 'object' || type(message?.status) != 'int')
						finish({ error: 'The backend worker returned an invalid response.' }, STATUS_UNKNOWN_ERROR);
					else
						finish(message.response, message.status);
				});
				if (!child) {
					finish({ error: 'Could not start the backend worker.' }, STATUS_NO_MEMORY);
					return null;
				}
				guard = timer(DEADLINE * 1000, () => {
					child.kill();
					finish({ error: 'The backend request timed out.', timed_out: true }, STATUS_TIMEOUT);
				});
				if (!guard) {
					child.kill();
					finish({ error: 'Could not arm the backend worker deadline.' }, STATUS_NO_MEMORY);
					return null;
				}
				return pending;
			};
		}
	return objects;
};
