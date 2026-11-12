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
const { can, optional, AuthError, login, clearSession, ubus } = await core('ubus.js');

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
check(JSON.stringify(await createUci(fake({ 'uci.changes': { changes: [] } }).call).changes('network')) === '{}' && await createUci(fake({ 'uci.changes': {} }).call).pending() === 0, 'nothing staged: empty and zero');
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
const noWait = { settleMs: 0, sleep: async () => {} };
let verified = 0;
f = fake({ 'uci.changes': { changes: [] } });
await applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', { enabled: '0' }), async () => { verified++; }, noWait);
check(names(f.calls) === 'changes set apply confirm' && verified === 1 && f.calls[2][2].rollback === true, 'checks nothing is staged, stages, applies with the rollback armed, verifies, then confirms', names(f.calls));
f = fake({ 'uci.changes': { changes: [['set', 'ntp', 'enabled', '0']] } });
let msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(/already staged/.test(msg) && names(f.calls) === 'changes', 'staged changes from someone else stop it before anything is written', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], async () => { throw new Error('bad value'); }, async () => {}, noWait));
check(msg === 'bad value' && names(f.calls) === 'changes revert', 'a failure while staging reverts what was staged and never applies', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] }, 'uci.apply': () => { throw new Error('reload failed'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(msg === 'reload failed' && names(f.calls) === 'changes set apply revert', 'a failed apply reverts the staged edits', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => { throw new Error('the zone was not saved'); }, noWait));
check(/rolled back/.test(msg) && /zone was not saved/.test(msg) && names(f.calls) === 'changes set apply rollback revert', 'a failed check rolls back at once, discards the re-staged edits and never confirms', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] }, 'uci.confirm': () => { throw new Error('nothing to confirm'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => {}, noWait));
check(/did not accept the confirmation/.test(msg) && names(f.calls) === 'changes set apply confirm revert', 'a confirmation that comes too late (the router already rolled back) is reported and the leftovers discarded', `${msg} / ${names(f.calls)}`);
f = fake({ 'uci.changes': { changes: [] }, 'uci.rollback': () => { throw new Error('gone'); } });
msg = await attempt(() => applyChange(createUci(f.call), ['system'], ed => ed.set('system', 'ntp', {}), async () => { throw new Error('x'); }, noWait));
check(/rolled back/.test(msg), 'even if the rollback call itself fails the error is reported (the countdown restores the config)', msg);
f = fake({ 'uci.changes': { changes: [] } });
await applyChange(createUci(f.call), ['system', 'dhcp'], async () => {}, async () => {}, noWait);
check(f.calls.filter(c => c[1] === 'changes').length === 2, 'every config in the list is checked for staged changes');

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
globalThis.fetch = real;

console.log('== optional() ==');
check(await optional(Promise.reject(new Error('plugin missing'))) === null && await optional(Promise.resolve(5)) === 5, 'a failed optional call gives null, a good one its value');
let raised = false;
try { await optional(Promise.reject(new AuthError('Session expired'))); } catch (e) { raised = e instanceof AuthError; }
check(raised, 'an expired session is still raised, so the page returns to sign-in');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall session and uci helper checks passed');
