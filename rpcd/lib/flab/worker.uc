'use strict';

// Runs every method of a plugin in a forked worker (uloop task), so a slow command never blocks rpcd's event loop.
// A plugin ends with `return deferred({ 'flab.<name>': { <method>: { args, call(request) { ... } } } });`. The handler
// gets { args } and returns the reply object; throwing is turned into { error: ... }. See docs/backend.md.
import { task, timer } from 'uloop';
import { STATUS_NO_DATA, STATUS_TIMEOUT, STATUS_NO_MEMORY, STATUS_UNKNOWN_ERROR } from 'ubus';
import { lsdir, mkdir, rmdir, stat } from 'fs';
import { begin_budget } from 'flab.exec';

// Seconds; stay below rpcd's default 30-second request timeout, including cleanup. The commands of one request share
// DEADLINE - 2 seconds (flab.exec begin_budget()), so the worker can still answer when they ran out.
const DEADLINE = 24;
// Bytes of JSON a reply may have.
const MAX_REPLY = 1048576;
// One bounded pool per plugin module, shared by its requests; excess calls fail instead of queueing.
const MAX_WORKERS = 4;
// Process-wide guard across independently loaded plugin modules. A router polling many pages must not create
// four forks per plugin at once.
const MAX_TOTAL_WORKERS = 8;
const SLOT_ROOT = '/tmp/flab-workers';

// Reserves one of the process-wide worker slots using an atomic mkdir. A slot cannot outlive the worker's
// 24-second deadline; older directories are leftovers from a process crash and may be reclaimed.
function reserve_worker_slot() {
	mkdir(SLOT_ROOT, 0700);
	for (let name in lsdir(SLOT_ROOT) ?? []) {
		let info = stat(`${SLOT_ROOT}/${name}`);
		if (match(name, /^[0-9]+$/) && info && time() - info.mtime > DEADLINE + 5)
			rmdir(`${SLOT_ROOT}/${name}`);
	}
	for (let slot = 0; slot < MAX_TOTAL_WORKERS; slot++) {
		let path = `${SLOT_ROOT}/${slot}`;
		if (mkdir(path, 0700))
			return path;
	}
	return null;
};
// Methods that change something on the router (start or stop a service, wake a host, run a test): at most one per object at a
// time, a second one is refused while the first runs.
const MUTATING = [ 'control', 'start', 'stop', 'wake', 'cable_test', 'wps' ];

// Wraps the `call` of every method in `objects` ({ object: { method: { args, call } } }) and returns `objects`.
export function deferred(objects) {
	let active = 0, mutations = {};
	for (let object, methods in objects)
		for (let name, method in methods) {
			let handler = method.call;
			// ucode reuses for-in bindings: capture method classification and object identity before closing over them.
			let object_name = object;
			let mutating = index(MUTATING, name) >= 0;
			method.call = function(request) {
				// Fixture/direct-call harnesses intentionally keep their synchronous API.
				if (type(request?.defer) != 'function')
					return handler(request);
				if (active >= MAX_WORKERS || (mutating && mutations[object_name])) {
					request.reply({ error: 'This object is busy. Try again shortly.' }, STATUS_UNKNOWN_ERROR);
					return null;
				}
				let slot = reserve_worker_slot();
				if (slot == null) {
					request.reply({ error: 'The backend worker budget is busy. Try again shortly.' }, STATUS_UNKNOWN_ERROR);
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
					rmdir(slot);
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
