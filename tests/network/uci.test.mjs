// Unit test for the browser-side session helpers and the configuration-change layer (www/js/core/ubus.js: can(),
// optional(); www/js/core/uci.js: the uci wrapper and applyChange()). They run against a fake transport, so it
// needs no router and changes nothing.
// Usage: node uci.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// ubus.js reads its session from sessionStorage when it loads, which node does not have.
const store = new Map();
globalThis.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
// Dynamically imports a module from www/js/core, after the sessionStorage stand-in above is in place.
const core = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/core', f)).href);
const { createUci, APPLY_TIMEOUT_S } = await core('uci.js');
const { can, optional, AuthError, AccessError, UnavailableError, login, clearSession, ubus, REQUEST_TIMEOUT_MS, PLUGIN_REQUEST_TIMEOUT_MS } = await core('ubus.js');

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

// A fake ubus: records the calls and answers from a table keyed "object.method".
function fake(answers = {}) {
  const calls = [];
  // Records the call and returns the canned answer for "object.method" (called with args if it is a function).
  const call = async (object, method, args) => { calls.push([object, method, args]); const a = answers[`${object}.${method}`]; return typeof a === 'function' ? a(args) : (a ?? {}); };
  return { call, calls };
}

console.log('== uci: reading ==');
let f = fake({ 'uci.configs': { configs: ['network', 'firewall'] }, 'uci.get': a => a.option ? { value: 'br-lan' } : { values: { lan: { '.type': 'interface' } } } });
let uci = createUci(f.call);
check((await uci.configs()).join() === 'network,firewall', 'the readable configs');
check(JSON.stringify(await uci.get('network', 'lan')) === '{"lan":{".type":"interface"}}' && await uci.get('network', 'lan', 'device') === 'br-lan', 'a section or a single option');
check(JSON.stringify(f.calls[1][2]) === '{"config":"network","section":"lan"}' && JSON.stringify(f.calls[2][2]) === '{"config":"network","section":"lan","option":"device"}', 'only the named parts are sent', JSON.stringify(f.calls));
check((await createUci(fake({ 'uci.configs': {} }).call).configs()).length === 0, 'no configs: an empty list');

console.log('== uci: staging ==');
f = fake({ 'uci.add': { section: 'cfg123' } });
uci = createUci(f.call);
await uci.set('network', 'lan', { ipaddr: '192.168.1.1', metric: 10 });
check(JSON.stringify(f.calls[0]) === '["uci","set",{"config":"network","section":"lan","values":{"ipaddr":"192.168.1.1","metric":10}}]', 'set stages option values as given', JSON.stringify(f.calls[0]));
check(await uci.add('firewall', 'rule', { name: 'x' }) === 'cfg123' && JSON.stringify(f.calls[1][2]) === '{"config":"firewall","type":"rule","values":{"name":"x"}}', 'add returns the new section name');
await uci.add('firewall', 'zone', {}, 'wg');
check(f.calls[2][2].name === 'wg', 'a named section passes its name');
await uci.delete('firewall', 'cfg123');
await uci.delete('firewall', 'cfg123', ['dest_port']);
check(JSON.stringify(f.calls[3][2]) === '{"config":"firewall","section":"cfg123"}' && JSON.stringify(f.calls[4][2]) === '{"config":"firewall","section":"cfg123","options":["dest_port"]}', 'delete a section or only some options');

console.log('== uci: pending changes ==');
f = fake({ 'uci.changes': a => a.config ? { changes: [['set', 'lan', 'ipaddr', '10.0.0.1']] } : { changes: { network: [['set', 'lan', 'ipaddr', '10.0.0.1']], firewall: [['add', 'x', 'rule'], ['set', 'x', 'name', 'y']] } } });
uci = createUci(f.call);
check((await uci.changes()).firewall.length === 2 && await uci.pending() === 3, 'all staged changes are counted');
check(JSON.stringify(await uci.changes('network')) === '{"network":[["set","lan","ipaddr","10.0.0.1"]]}' && await uci.pending('network') === 1, 'one config: the bare list is returned keyed like the rest');
check(JSON.stringify(await createUci(fake({ 'uci.changes': { changes: [] } }).call).changes('network')) === '{}' && await createUci(fake({ 'uci.changes': { changes: {} } }).call).pending() === 0, 'nothing staged: empty and zero');
f = fake({ 'uci.changes': { changes: { network: [1], firewall: [1] } } });
await createUci(f.call).revert();
check(f.calls.filter(c => c[1] === 'revert').map(c => c[2].config).join() === 'network,firewall', 'revert with no argument reverts every staged config');
f = fake();
await createUci(f.call).revert('dhcp');
check(f.calls.length === 1 && f.calls[0][2].config === 'dhcp', 'revert of one config only calls that one');

console.log('== uci: apply, confirm, rollback ==');
f = fake();
uci = createUci(f.call);
await uci.apply();
await uci.apply(10);
await uci.confirm();
await uci.rollback();
check(APPLY_TIMEOUT_S >= 10 && f.calls[0][1] === 'apply' && f.calls[0][2].rollback === true && f.calls[0][2].timeout === APPLY_TIMEOUT_S, 'apply always arms the rollback, with the default countdown');
check(f.calls[1][2].timeout === 10 && f.calls[2][1] === 'confirm' && f.calls[3][1] === 'rollback', 'a custom countdown, confirm and rollback are plain calls');

console.log('== uci: applyChange, the whole change with its safety net ==');
const { applyChange } = await core('uci.js');
// The ubus method names of `calls`, space-joined in call order.
const names = calls => calls.map(c => c[1]).join(' ');
// The error message `fn` rejects with, or null when it succeeds.
const attempt = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };
const caught = async fn => { try { await fn(); return null; } catch (e) { return e; } };
const noWait = { settleMs: 0, sleep: async () => {} };
let verified = 0;
f = fake({ 'uci.changes': { changes: [] } });
await applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', { enabled: '0' }), async () => { verified++; }, noWait);
check(names(f.calls) === 'changes set apply confirm' && verified === 1 && f.calls[2][2].rollback === true, 'checks nothing is staged, stages, applies with the rollback armed, verifies, then confirms', names(f.calls));
f = fake({ 'uci.changes': { changes: { system: [['set', 'ntp', 'enabled', '0']] } } });
let msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(/already staged/.test(msg) && names(f.calls) === 'changes', 'staged changes from someone else stop it before anything is written', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': a => ({ changes: a.config ? [] : { firewall: [['set', 'rule', 'enabled', '0']] } }) });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(/already staged.*"firewall"/.test(msg) && names(f.calls) === 'changes' && Object.keys(f.calls[0][2]).length === 0, 'an unrelated staged config blocks session-wide apply and is never reverted', `${msg} / ${names(f.calls)}`);
for (const answer of [{}, { changes: null }, { changes: { firewall: null } }, { changes: [['set', 'ntp', 'enabled', '0']] }]) {
  f = fake({ 'uci.changes': answer });
  msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
  check(/could not be checked.*no changes were staged or applied/.test(msg) && names(f.calls) === 'changes', 'an unreadable session-wide preflight fails closed', `${JSON.stringify(answer)} / ${msg} / ${names(f.calls)}`);
}
f = fake({ 'uci.changes': () => { throw new Error('Access denied by ACL'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], async () => {}, async () => {}, noWait));
check(/could not be checked.*Access denied/.test(msg) && names(f.calls) === 'changes', 'an inaccessible preflight does not stage, apply or clean up anything', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], async () => { throw new Error('bad value'); }, async () => {}, noWait));
check(msg === 'bad value' && names(f.calls) === 'changes revert', 'a failure while staging reverts what was staged and never applies', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] }, 'uci.apply': () => { throw new Error('reload failed'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(/rolled back \(confirmed by the router\).*reload failed/.test(msg) && names(f.calls) === 'changes set apply rollback revert', 'a failed apply requests rollback before cleaning up its staged edits', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: {} }, 'uci.apply': () => { throw new Error('apply reply lost'); }, 'uci.rollback': () => { throw new Error('router unreachable'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(/Apply failed; the outcome is uncertain/.test(msg) && /apply reply lost/.test(msg) && !/was rolled back/.test(msg) && names(f.calls) === 'changes set apply rollback revert', 'a lost apply reply and unconfirmed rollback never claim the old config is restored or retry apply', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => { throw new Error('the zone was not saved'); }, noWait));
check(/rolled back/.test(msg) && /zone was not saved/.test(msg) && names(f.calls) === 'changes set apply rollback revert', 'a failed check rolls back at once, discards the re-staged edits and never confirms', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] }, 'uci.confirm': () => { throw new Error('nothing to confirm'); }, 'uci.rollback': () => { throw new Error('no active rollback'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(/Confirmation failed; the outcome is uncertain/.test(msg) && !/was rolled back/.test(msg) && names(f.calls) === 'changes set apply confirm rollback revert', 'a confirmation failure without an acknowledged rollback is reported as uncertain', `${msg} / ${names(f.calls)}`);
let kept = false;
f = fake({
  'uci.changes': { changes: {} },
  'uci.confirm': () => { kept = true; throw new Error('confirm reply lost'); },
  'uci.rollback': () => { if (kept) throw new Error('no active rollback'); },
});
msg = await attempt(() => applyChange(createUci(f.call), ['network'], ed => ed.set('network', 'lan', {}), async () => {}, { ...noWait, timeoutS: 90 }));
check(kept && /Confirmation failed; the outcome is uncertain/.test(msg) && /automatic rollback is not guaranteed/.test(msg) && /confirm reply lost/.test(msg) && !/was rolled back|did not accept/.test(msg)
  && f.calls.filter(c => c[1] === 'confirm').length === 1 && f.calls.find(c => c[1] === 'apply')[2].timeout === 90,
  'an accepted confirmation with a lost reply is not called rejection or rollback and is never retried', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] }, 'uci.rollback': () => { throw new Error('gone'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => { throw new Error('x'); }, noWait));
check(/outcome is uncertain/.test(msg) && /Rollback could not be confirmed: gone/.test(msg) && !/was rolled back/.test(msg), 'a failed rollback does not claim that the countdown has restored the config', msg);
f = fake({ 'uci.changes': { changes: {} }, 'uci.revert': a => { throw new Error(`cannot clean ${a.config}`); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system', 'dhcp'], async () => { throw new Error('bad value'); }, async () => {}, noWait));
check(/bad value/.test(msg) && /Staged changes could not be discarded/.test(msg) && /cannot clean system/.test(msg) && /cannot clean dhcp/.test(msg)
  && names(f.calls) === 'changes revert revert' && !/rolled back/.test(msg), 'staging cleanup failures for every owned config are explicit and none is swallowed', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: {} }, 'uci.revert': () => { throw new Error('cleanup offline'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], async () => {}, async () => { throw new Error('bad readback'); }, noWait));
check(/rolled back \(confirmed by the router\)/.test(msg) && /cleanup offline/.test(msg) && /Staged changes may remain/.test(msg), 'an acknowledged rollback and a failed staged cleanup are reported separately', msg);
f = fake({ 'uci.changes': { changes: {} }, 'uci.rollback': () => { throw new Error('rollback offline'); }, 'uci.revert': () => { throw new Error('cleanup offline'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['network'], async () => {}, async () => { throw new Error('bad readback'); }, noWait));
check(/bad readback/.test(msg) && /rollback offline/.test(msg) && /cleanup offline/.test(msg) && /uncertain/.test(msg), 'verification, rollback and cleanup failures are all retained', msg);
f = fake({ 'uci.changes': { changes: [] } });
await applyChange(createUci(f.call), ['system', 'dhcp'], async () => {}, async () => {}, noWait);
check(f.calls.filter(c => c[1] === 'changes').length === 1 && Object.keys(f.calls[0][2]).length === 0, 'multi-config changes use one unscoped session-wide preflight');
let clock = 0;
f = fake({ 'uci.changes': { changes: {} } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], async () => {}, async () => { clock = APPLY_TIMEOUT_S * 1000 - REQUEST_TIMEOUT_MS; }, { ...noWait, now: () => clock }));
check(/confirmation window is too short/.test(msg) && names(f.calls) === 'changes apply rollback revert', 'confirmation reserves its request deadline and is not sent after the safe rollback window', `${msg} / ${names(f.calls)}`);
let finishStage;
f = fake({ 'uci.changes': { changes: {} } });
const inProgress = applyChange(createUci(f.call), ['system'], async () => new Promise(resolve => { finishStage = resolve; }), async () => {}, noWait);
await Promise.resolve();
const other = fake({ 'uci.changes': { changes: {} } });
msg = await attempt(() => applyChange(createUci(other.call), ['network'], async () => {}, async () => {}, noWait));
check(/already in progress/.test(msg) && other.calls.length === 0, 'overlapping changes, including other configs, are blocked before preflight', `${msg} / ${names(other.calls)}`);
finishStage();
await inProgress;
await applyChange(createUci(other.call), ['network'], async () => {}, async () => {}, noWait);
check(names(other.calls) === 'changes apply confirm', 'the change lock is released after completion');
for (const method of ['changes', 'set', 'apply', 'confirm', 'rollback', 'revert']) {
  f = fake({ 'uci.changes': { changes: {} }, [`uci.${method}`]: () => { throw new AuthError('Session expired'); } });
  const err = await caught(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {
    if (method === 'rollback' || method === 'revert') throw new Error('verification failed');
  }, noWait));
  check(err instanceof AuthError, `an expired session during ${method} retains AuthError for the sign-in flow`, err?.message);
}
f = fake({ 'uci.changes': { changes: {} } });
const expired = await caught(() => applyChange(createUci(f.call), ['system'], async () => {}, async () => { throw new AuthError('Session expired'); }, noWait));
check(expired instanceof AuthError, 'an expired session during verification is not converted into an ordinary rollback error', expired?.message);

console.log('== session: what this login may call ==');
const real = globalThis.fetch;
// Stubs fetch so that every request answers with the ubus `result`.
const reply = result => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ result }) }); };
reply([0, { ubus_rpc_session: 'abc', acls: { ubus: { 'flab.network': ['status'], uci: ['set', 'apply'], 'flab.any': ['*'] } } }]);
await login('someone', 'x');
check(can('flab.network', 'status') && !can('flab.network', 'reload') && can('uci', 'set') && !can('uci', 'commit') && can('flab.any', 'whatever') && !can('nope', 'x'), 'can() answers from the ACLs returned at sign-in; "*" grants every method');
check(JSON.parse(store.get('acls')).ubus.uci.length === 2 && store.get('sid') === 'abc', 'the ACLs are kept with the session id');
reply([0, { ubus_rpc_session: 'ghi', acls: { ubus: { '*': ['*'] }, uci: { '*': ['read', 'write'] } } }]);
await login('root', 'x');
check(can('uci', 'set') && can('system', 'board') && can('anything', 'at all'), 'root\'s ACL (object "*", method "*") allows every call');
reply([0, { ubus_rpc_session: 'def' }]);
await login('nobody', 'x');
check(!can('uci', 'set') && !can('flab.network', 'status'), 'a login that reports no ACLs may call nothing from the UI\'s point of view');
clearSession();
check(store.get('sid') === undefined && store.get('acls') === undefined && !can('flab.network', 'status'), 'signing out forgets the ACLs too');
// The error message ubus('system', 'board') fails with when fetch is replaced by `fetchImpl`, or null if it succeeds.
const fails = async fetchImpl => { globalThis.fetch = fetchImpl; try { await ubus('system', 'board'); return null; } catch (e) { return e.message; } };
check(/cannot be reached/.test(await fails(async () => { throw new TypeError('Failed to fetch'); })), 'a network failure says the router cannot be reached');
check(/HTTP 502/.test(await fails(async () => ({ ok: false, status: 502, json: async () => ({}) }))), 'an HTTP error status is reported as such, not as a parse error');
check(/unreadable/.test(await fails(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }))), 'a reply that is not JSON is reported as unreadable');
check(/unexpected reply/.test(await fails(async () => ({ ok: true, json: async () => ({}) }))), 'a JSON reply without a result is reported as unexpected');
check(/unexpected reply/.test(await fails(async () => ({ ok: true, json: async () => null }))), 'a null JSON reply is reported as unexpected');
let infrastructureCalls = 0;
globalThis.fetch = async () => {
  infrastructureCalls++;
  return { ok: true, json: async () => ({ result: [9, { error: 'Worker output limit exceeded.' }] }) };
};
const infrastructureError = await caught(() => ubus('flab.services', 'control', { name: 'dnsmasq', action: 'restart' }));
check(infrastructureError?.message === 'flab.services.control failed (ubus code 9): Worker output limit exceeded.' && infrastructureCalls === 1,
  'infrastructure errors retain the object, method, status and server detail without retrying a control', infrastructureError?.message);
reply([9, { error: { message: 'not a string' } }]);
const malformedDetail = await caught(() => ubus('flab.network', 'status'));
check(malformedDetail?.message === 'flab.network.status failed (ubus code 9)', 'non-string error data is not coerced into a misleading transport error', malformedDetail?.message);
reply([9, { error: 'x'.repeat(600) }]);
const longDetail = await caught(() => ubus('flab.network', 'status'));
check(longDetail?.message === `flab.network.status failed (ubus code 9): ${'x'.repeat(499)}…`, 'server error details are visibly truncated to 500 characters', longDetail?.message);
const handlerFailure = { ok: false, error: 'The service refused to start.' };
reply([0, handlerFailure]);
check(await ubus('flab.services', 'control', { name: 'dnsmasq', action: 'start' }) === handlerFailure,
  'successful RPC replies preserve intentional handler-level failure payloads');
let requests = [];
const denied = { error: { code: -32002, message: 'Access denied' } };
globalThis.fetch = async (_, options) => {
  requests.push(JSON.parse(options.body).params.slice(1, 3).join('.'));
  return { ok: true, json: async () => denied };
};
let error = await caught(() => ubus('uci', 'confirm'));
check(error instanceof AuthError && requests.join() === 'uci.confirm,session.access', 'expired sessions are distinguished from ACL errors without retrying confirmation', `${error?.message} / ${requests}`);
requests = [];
globalThis.fetch = async (_, options) => {
  requests.push(JSON.parse(options.body).params.slice(1, 3).join('.'));
  return { ok: true, json: async () => ({ result: [6] }) };
};
error = await caught(() => ubus('uci', 'confirm'));
check(error instanceof AuthError && requests.join() === 'uci.confirm,session.access', 'ubus permission-denied status also preserves the expired-session sign-in flow without retrying confirmation', error?.message);
requests = [];
globalThis.fetch = async (_, options) => {
  requests.push(JSON.parse(options.body).params.slice(1, 3).join('.'));
  return { ok: true, json: async () => requests.length === 1 ? denied : { result: [0, { access: false }] } };
};
error = await caught(() => ubus('uci', 'set', {}));
check(!(error instanceof AuthError) && /Access denied by ACL: uci.set/.test(error?.message) && requests.join() === 'uci.set,session.access', 'a live but restricted session gets the explicit ACL error without retrying a mutation', error?.message);
requests = [];
globalThis.fetch = async (_, options) => {
  requests.push(JSON.parse(options.body).params.slice(1, 3).join('.'));
  if (requests.length > 1) throw new TypeError('Failed to fetch');
  return { ok: true, json: async () => denied };
};
error = await caught(() => ubus('uci', 'apply', {}));
check(!(error instanceof AuthError) && /cannot be reached/.test(error?.message), 'an unreachable session probe is not falsely reported as a confirmed expiry', error?.message);
reply([3]);
error = await caught(() => ubus('flab.optional', 'status'));
check(error instanceof UnavailableError, 'a missing ubus method is classified as unavailable');
reply([9, { error: 'worker failed' }]);
error = await caught(() => ubus('flab.optional', 'status'));
check(!(error instanceof UnavailableError) && /worker failed/.test(error?.message), 'an ordinary worker failure is not classified as unavailable', error?.message);

console.log('== transport: explicit deadlines, including stalled response bodies ==');
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
for (const { bodyStalls, object, method, options, expectedMs } of [
  { bodyStalls: false, object: 'uci', method: 'confirm', expectedMs: REQUEST_TIMEOUT_MS },
  { bodyStalls: true, object: 'uci', method: 'confirm', expectedMs: REQUEST_TIMEOUT_MS },
  { bodyStalls: false, object: 'flab.services', method: 'control', expectedMs: PLUGIN_REQUEST_TIMEOUT_MS },
  { bodyStalls: true, object: 'flab.network', method: 'status', expectedMs: PLUGIN_REQUEST_TIMEOUT_MS },
  { bodyStalls: false, object: 'flab.network', method: 'status', options: { timeoutMs: 1200 }, expectedMs: 1200 },
  { bodyStalls: false, object: 'flab.services', method: 'control', options: { timeoutMs: 90000 }, expectedMs: PLUGIN_REQUEST_TIMEOUT_MS },
  { bodyStalls: false, object: 'uci', method: 'apply', options: { timeoutMs: 27000 }, expectedMs: REQUEST_TIMEOUT_MS },
]) {
  let expire, timeoutMs, signal, requestCount = 0, cleared = false;
  const timer = {};
  globalThis.setTimeout = (fn, ms) => { expire = fn; timeoutMs = ms; return timer; };
  globalThis.clearTimeout = id => { cleared = id === timer; };
  globalThis.fetch = async (_, options) => {
    requestCount++;
    signal = options.signal;
    return bodyStalls ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
  };
  try {
    const request = ubus(object, method, {}, options);
    await Promise.resolve();
    check(timeoutMs === expectedMs && timeoutMs > 0 && timeoutMs < APPLY_TIMEOUT_S * 1000 && signal instanceof AbortSignal,
      `${object}.${method} ${bodyStalls ? 'response bodies' : 'fetch requests'} have the explicit bounded request deadline`, timeoutMs);
    expire();
    error = await caught(() => request);
    check(error?.message === `The router did not answer ${object}.${method} within ${expectedMs / 1000} seconds.` && signal.aborted && requestCount === 1 && cleared,
      `a stalled ${object}.${method} ${bodyStalls ? 'response body' : 'fetch'} is bounded, aborted and never retried`, error?.message);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}
let invalidFetches = 0;
globalThis.fetch = async () => { invalidFetches++; return { ok: true, json: async () => ({ result: [0, {}] }) }; };
for (const timeoutMs of [0, -1, Infinity, NaN]) {
  error = await caught(() => ubus('flab.services', 'control', {}, { timeoutMs }));
  check(/deadline must be a positive finite/.test(error?.message) && invalidFetches === 0, 'invalid deadline overrides fail before dispatching a mutation', error?.message);
}
globalThis.fetch = real;

console.log('== optional() ==');
check(await optional(Promise.reject(new AccessError('not granted'))) === null
  && await optional(Promise.reject(new UnavailableError('plugin missing'))) === null
  && await optional(Promise.resolve(5)) === 5,
  'only unavailable optional calls give null; successful calls keep their value');
let backendFailure = false;
try { await optional(Promise.reject(new Error('worker failed'))); } catch (e) { backendFailure = e.message === 'worker failed'; }
check(backendFailure, 'an ordinary backend failure remains visible instead of looking like a missing optional feature');
let raised = false;
try { await optional(Promise.reject(new AuthError('Session expired'))); } catch (e) { raised = e instanceof AuthError; }
check(raised, 'an expired session is still raised, so the page returns to sign-in');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall session and uci helper checks passed');
