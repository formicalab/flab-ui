// Unit test for the model of the Routing page's Static routes tab (www/js/pages/routing/static-model.js): reading the route and route6
// sections (an older netmask joined to the target), the draft, the review list, validation and warnings, the confirmation risks, the
// UCI operations, the check after a save and the match against the kernel's routes. Pure functions: no router and no browser.
// Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/routing/static-model.js')).href);

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// A section as `uci get` returns it by type.
const sec = (type, name, values) => ({ [name]: { '.type': type, '.name': name, '.anonymous': true, ...values } });
// The IPv4 and IPv6 route sections of the sample router: a default route with a backup, a route with an older netmask, a disabled one,
// a blackhole in a table of its own, an IPv6 route, and a route with options the page does not edit.
const CFG4 = {
  ...sec('route', 'cfg01', { interface: 'wan', target: '0.0.0.0/0', gateway: '192.0.2.1', metric: '10' }),
  ...sec('route', 'cfg02', { interface: 'wan2', target: '0.0.0.0/0', gateway: '198.51.100.1', metric: '20' }),
  ...sec('route', 'cfg03', { interface: 'lan', target: '10.9.0.0', netmask: '255.255.0.0', gateway: '192.168.1.254', mtu: '1400' }),
  ...sec('route', 'cfg04', { interface: 'lan', target: '172.16.0.0/12', gateway: '192.168.1.254', disabled: '1' }),
  ...sec('route', 'cfg05', { interface: 'lan', target: '203.0.113.0/24', type: 'blackhole', table: 'voip' }),
  ...sec('route', 'cfg06', { interface: 'lan', target: '198.18.0.0/15', gateway: '192.168.1.254', onlink: '1', valid: '3600', proto: 'static' }),
};
const CFG6 = {
  ...sec('route6', 'cfg11', { interface: 'wan', target: '::/0', gateway: 'fe80::1' }),
  ...sec('route6', 'cfg12', { interface: 'lan', target: '2001:DB8:1::/48', gateway: 'fd00::fe' }),
};
// The router's live state: the interfaces with their subnets, and the kernel's routes.
const DUMP = { interface: [
  { interface: 'lan', up: true, 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }], 'ipv6-address': [{ address: 'fd00::1', mask: 64 }] },
  { interface: 'wan', up: true, 'ipv4-address': [{ address: '192.0.2.50', mask: 24 }], 'ipv6-address': [] },
  { interface: 'wan2', up: false, 'ipv4-address': [], 'ipv6-address': [] },
  { interface: 'loopback', up: true, 'ipv4-address': [{ address: '127.0.0.1', mask: 8 }], 'ipv6-address': [] },
] };
const kroute = (family, prefix, over = {}, ...hops) => ({ family, table: 'main', type: 'unicast', prefix, len: +prefix.split('/')[1], from: null, proto: 'static', metric: null, nexthops: hops.map(([via, dev]) => ({ via, dev })), ...over });
const STATUS = {
  available: true, table_ids: { main: 254, local: 255, default: 253, voip: 100 },
  routes: [
    kroute(4, '0.0.0.0/0', { metric: 10 }, ['192.0.2.1', 'wan']),
    kroute(4, '10.9.0.0/16', {}, ['192.168.1.254', 'br-lan']),
    kroute(4, '203.0.113.0/24', { type: 'blackhole', table: 'voip' }),
    kroute(6, '::/0', {}, ['fe80::1', 'wan']),
  ],
};
const read = (extras = { status: STATUS, dump: DUMP }) => m.readStatic(CFG4, CFG6, extras);
const rowOf = (draft, section) => draft.rows.find(r => r.section === section);
const errorsOf = (data, draft) => m.problems(data, draft).errors.map(e => e.key);

console.log('== reading ==');
let data = read();
let draft = m.draftFrom(data);
check(data.available && data.routes.length === 8 && data.routes.filter(r => r.family === 4).length === 6 && data.routes.filter(r => r.family === 6).length === 2, 'the IPv4 routes come from route sections and the IPv6 ones from route6 sections', j(data.routes.map(r => r.section)));
check(rowOf(draft, 'cfg03').values.target === '10.9.0.0/16' && rowOf(draft, 'cfg03').values.mtu === '1400', 'an older netmask is joined to the target as a prefix length');
check(rowOf(draft, 'cfg04').values.enabled === false && rowOf(draft, 'cfg01').values.enabled === true && rowOf(draft, 'cfg06').values.onlink === true, 'disabled and onlink are read as checkboxes');
check(rowOf(draft, 'cfg05').values.type === 'blackhole' && rowOf(draft, 'cfg05').values.table === 'voip' && rowOf(draft, 'cfg01').values.table === '', 'type and table are read; no table is the main table');
check(m.readStatic(null, CFG6).available === false && m.readStatic(CFG4, null).available === false && m.readStatic({}, {}).routes.length === 0, 'a login that cannot read the config, and a config without routes');
check(j(data.interfaces.map(i => i.name)) === j(['lan', 'loopback', 'wan', 'wan2']) && data.interfaces[0].v4[0].len === 24, 'the interfaces are listed by name with their subnets');
check(read({}).kernel === null && read({ status: { available: false } }).kernel === null, 'without the kernel state nothing is known about it');

console.log('== addresses ==');
check(m.parseCidr('10.0.0.0/8', 4).len === 8 && m.parseCidr('192.0.2.1', 4).len === 32 && m.parseCidr('2001:db8::/32', 6).len === 32 && m.parseCidr('::/0', 6).len === 0, 'prefixes with and without a length, in both families');
check(!m.parseCidr('10.0.0.0/33', 4) && !m.parseCidr('10.0.0.0/8/8', 4) && !m.parseCidr('10.0.0.0/x', 4) && !m.parseCidr('2001:db8::/129', 6) && !m.parseCidr('10.0.0.0/8', 6) && !m.parseCidr('::/0', 4) && !m.parseCidr('', 4) && !m.parseCidr('300.1.1.1', 4), 'bad lengths, the wrong family and bad addresses are refused');
check(m.parseCidr('10.1.2.3/8', 4).hostBits === true && m.parseCidr('10.0.0.0/8', 4).hostBits === false && m.cidrKey(m.parseCidr('10.1.2.3/8', 4)) === m.cidrKey(m.parseCidr('10.0.0.0/8', 4)), 'host bits are noticed and a prefix compares by its network');
check(m.cidrKey(m.parseCidr('2001:DB8::/32', 6)) === m.cidrKey(m.parseCidr('2001:db8:0:0::/32', 6)), 'IPv6 spellings of one prefix are the same key');

console.log('== the draft and the review list ==');
check(!m.isDirty(data, draft) && m.changesOf(data, draft).length === 0 && m.plan(data, draft).length === 0, 'the draft starts as the router has it: no change, no operation');
rowOf(draft, 'cfg01').values.gateway = '192.0.2.2';
check(j(m.changesOf(data, draft)) === j([{ key: 'route:r0:gateway', label: 'IPv4 route 0.0.0.0/0: Gateway', from: '192.0.2.1', to: '192.0.2.2' }]) && m.isDirty(data, draft), 'an edited field is one review line', j(m.changesOf(data, draft)));
check(j(m.plan(data, draft)) === j([{ op: 'set', config: 'network', section: 'cfg01', values: { gateway: '192.0.2.2' } }]), 'and one set operation with that option only', j(m.plan(data, draft)));
draft = m.draftFrom(data);
rowOf(draft, 'cfg01').values.metric = '';
rowOf(draft, 'cfg04').values.enabled = true;
rowOf(draft, 'cfg06').values.onlink = false;
check(j(m.plan(data, draft)) === j([
  { op: 'delete', config: 'network', section: 'cfg01', options: ['metric'] },
  { op: 'delete', config: 'network', section: 'cfg04', options: ['disabled'] },
  { op: 'delete', config: 'network', section: 'cfg06', options: ['onlink'] },
]), 'a cleared option, enabling a disabled route and clearing on-link delete their options', j(m.plan(data, draft)));
draft = m.draftFrom(data);
rowOf(draft, 'cfg02').values.enabled = false;
rowOf(draft, 'cfg02').values.onlink = true;
check(j(m.plan(data, draft)) === j([{ op: 'set', config: 'network', section: 'cfg02', values: { onlink: '1', disabled: '1' } }]), 'disabling a route and setting on-link write 1', j(m.plan(data, draft)));
draft = m.draftFrom(data);
rowOf(draft, 'cfg03').values.gateway = '192.168.1.253';
check(j(m.plan(data, draft)) === j([{ op: 'set', config: 'network', section: 'cfg03', values: { gateway: '192.168.1.253' } }]), 'a route with an older netmask keeps target and netmask when its target is not edited');
rowOf(draft, 'cfg03').values.target = '10.9.0.0/24';
check(j(m.plan(data, draft)) === j([
  { op: 'set', config: 'network', section: 'cfg03', values: { target: '10.9.0.0/24', gateway: '192.168.1.253' } },
  { op: 'delete', config: 'network', section: 'cfg03', options: ['netmask'] },
]), 'editing that target writes the prefix into target and removes the netmask', j(m.plan(data, draft)));
draft = m.draftFrom(data);
rowOf(draft, 'cfg06').values.gateway = '192.168.1.253';
check(m.plan(data, draft).every(o => !('valid' in (o.values ?? {})) && !(o.options ?? []).includes('valid') && !(o.options ?? []).includes('proto')), 'options the page does not edit (valid, proto) are never touched');

console.log('== adding and removing ==');
draft = m.draftFrom(data);
const blank = m.newRow(draft, 4);
check(blank.section === null && blank.values.enabled === true && blank.family === 4 && m.isDirty(data, draft) && m.changesOf(data, draft).length === 0 && m.plan(data, draft).length === 0 && m.problems(data, draft).errors.length === 0, 'a new row that is still empty is ignored: not a change, not an error (but a redraw keeps it)');
blank.values.interface = 'lan';
check(m.changesOf(data, draft).length === 0 && m.plan(data, draft).length === 0 && m.problems(data, draft).errors.length === 0, 'choosing only an interface does not make it a route');
Object.assign(blank.values, { target: '10.50.0.0/16', gateway: '192.168.1.254', metric: '5', table: 'voip', mtu: '1300', source: '192.168.1.0/24', onlink: true });
check(j(m.changesOf(data, draft)) === j([{ key: 'route:r8', label: 'New IPv4 route 10.50.0.0/16', from: 'none', to: 'via 192.168.1.254 · lan · metric 5 · table voip · mtu 1300 · from 192.168.1.0/24 · on-link' }]), 'a new route is one review line', j(m.changesOf(data, draft)));
check(j(m.plan(data, draft)) === j([{ op: 'add', config: 'network', type: 'route', values: { target: '10.50.0.0/16', gateway: '192.168.1.254', interface: 'lan', metric: '5', table: 'voip', mtu: '1300', source: '192.168.1.0/24', onlink: '1' } }]), 'and one add operation with the options that have a value', j(m.plan(data, draft)));
const six = m.newRow(draft, 6);
Object.assign(six.values, { target: '2001:db8:2::/48', interface: 'lan', gateway: 'fd00::fe', enabled: false });
check(m.plan(data, draft).at(-1).type === 'route6' && m.plan(data, draft).at(-1).values.disabled === '1' && m.plan(data, draft).at(-1).values.gateway === 'fd00::fe', 'an IPv6 route is added as a route6 section; a disabled one is written disabled');
draft.rows.splice(draft.rows.indexOf(six), 1);
draft.rows.splice(draft.rows.indexOf(blank), 1);
rowOf(draft, 'cfg02').removed = true;
check(j(m.plan(data, draft)) === j([{ op: 'delete', config: 'network', section: 'cfg02' }]) && m.changesOf(data, draft)[0].label === 'Remove IPv4 route 0.0.0.0/0' && m.changesOf(data, draft)[0].to === 'removed', 'removing a saved route deletes its section');
rowOf(draft, 'cfg02').removed = false;
check(!m.isDirty(data, draft), 'taking it back from removal restores the draft');

console.log('== validation ==');
draft = m.draftFrom(data);
const row = (family = 4) => { const r = m.newRow(draft, family); Object.assign(r.values, { target: family === 4 ? '10.60.0.0/16' : '2001:db8:3::/48', interface: 'lan' }); return r; };
let r = row();
check(m.problems(data, draft).errors.length === 0, 'a minimal route (target and interface) is valid');
r.values.target = '';
r.values.gateway = '1.2.3.4';
check(j(errorsOf(data, draft)) === j([`route:${r.key}:target`]), 'a route with a gateway but no target needs a target', j(errorsOf(data, draft)));
for (const [field, value, why] of [
  ['target', '10.0.0.0/33', 'a prefix length above 32'], ['target', 'lan', 'a name'], ['target', '2001:db8::/32', 'an IPv6 target on an IPv4 route'],
  ['gateway', '2001:db8::1', 'an IPv6 gateway on an IPv4 route'], ['gateway', 'router', 'a name as the gateway'],
  ['metric', '-1', 'a negative metric'], ['metric', '4294967296', 'a metric above 32 bits'], ['metric', 'x', 'a metric that is not a number'],
  ['mtu', '67', 'an MTU below 68'], ['mtu', '65536', 'an MTU above 65535'], ['table', 'nosuch', 'a table that is not in rt_tables'], ['table', 'a b', 'a table with a space'],
  ['type', 'teleport', 'an unknown type'], ['source', 'x', 'a source that is not an address'], ['source', '2001:db8::/32', 'an IPv6 source on an IPv4 route'], ['interface', 'ghost', 'an interface the router does not have'],
]) {
  draft = m.draftFrom(data);
  r = row();
  r.values[field] = value;
  check(errorsOf(data, draft).includes(`route:${r.key}:${field}`), `${why} is an error on its control`, j(errorsOf(data, draft)));
}
draft = m.draftFrom(data);
r = row();
Object.assign(r.values, { gateway: '192.168.1.254', metric: '0', mtu: '68', table: '100', type: '', source: '192.168.1.5' });
check(m.problems(data, draft).errors.length === 0, 'the edges are valid: metric 0, MTU 68, a numeric table, a host as the source');
r.values.table = 'voip';
check(m.problems(data, draft).errors.length === 0, 'a table name from rt_tables is valid');
r.values.table = 'nosuch';
check(m.problems(read({ dump: DUMP }), draft).errors.length === 0, 'without the kernel state the table names are not known, so none is refused');
r.values.table = '';
r = m.newRow(draft, 6);
Object.assign(r.values, { target: '2001:db8:4::/48', interface: 'lan', mtu: '1279' });
check(errorsOf(data, draft).includes(`route:${r.key}:mtu`), 'an IPv6 route needs an MTU of at least 1280');
r.values.mtu = '1280';
r.values.target = '2001:db8:4::/129';
check(errorsOf(data, draft).includes(`route:${r.key}:target`), 'an IPv6 prefix length above 128 is an error');
check(m.problems({ ...data, interfaces: [] }, draft).errors.every(e => !e.key.endsWith(':interface')), 'with no interface list from the router the interface name is not judged');

console.log('== warnings ==');
const warn = (mutate, family = 4) => {
  // Only the new row: the sample's own routes raise warnings of their own (one is on a down interface).
  draft = { rows: [], next: 0 };
  const x = row(family);
  mutate(x.values);
  return m.problems(data, draft).warnings.join(' | ');
};
check(/gateway 10\.1\.1\.1 is not inside a subnet of lan/.test(warn(v => { v.gateway = '10.1.1.1'; })), 'a gateway outside the interface\'s subnets warns');
check(warn(v => { v.gateway = '10.1.1.1'; v.onlink = true; }) === '', 'and does not when the route is on-link');
check(/is the router's own address on lan/.test(warn(v => { v.gateway = '192.168.1.1'; })), 'a gateway that is the router itself warns');
check(warn(v => { v.gateway = '192.168.1.254'; }) === '', 'a gateway inside a subnet of the interface is fine');
check(/interface wan2 is down/.test(warn(v => { v.interface = 'wan2'; })), 'a route on a down interface says it is not installed');
check(warn(v => { v.gateway = 'fe80::1'; v.interface = 'lan'; v.target = '2001:db8:5::/48'; }, 6) === '', 'an IPv6 link-local gateway is always reachable');
check(/not inside a subnet of lan/.test(warn(v => { v.gateway = '2001:db8:ffff::1'; }, 6)), 'a global IPv6 gateway outside the subnets warns');
check(/a blackhole route has no next hop/.test(warn(v => { v.type = 'blackhole'; v.gateway = '192.168.1.254'; })), 'a gateway on a blackhole route is ignored, and says so');
check(/"on-link" only matters together with a gateway/.test(warn(v => { v.onlink = true; })), 'on-link without a gateway is pointless');
check(/host bits set/.test(warn(v => { v.target = '10.60.0.5/16'; })), 'a target with host bits warns');
draft = m.draftFrom(data);
r = row();
r.values.target = '0.0.0.0/0';
r.values.metric = '10';
check(/has the same destination, table and metric as IPv4 route 0\.0\.0\.0\/0/.test(m.problems(data, draft).warnings.join(' | ')), 'two routes that are the same to the kernel warn');
r.values.metric = '30';
check(m.problems(data, draft).warnings.join('').indexOf('same destination') < 0, 'a different metric makes it a backup, not a duplicate');
r.values.metric = '10';
r.values.enabled = false;
check(m.problems(data, draft).warnings.join('').indexOf('same destination') < 0, 'a disabled route is not judged');
draft = m.draftFrom(data);
rowOf(draft, 'cfg04').values.interface = 'wan2';
check(!/172\.16/.test(m.problems(data, draft).warnings.join()), 'a disabled route raises no warnings about its interface');

console.log('== the risks to confirm ==');
draft = m.draftFrom(data);
check(m.risksOf(data, draft).length === 0, 'an untouched draft has no risk');
rowOf(draft, 'cfg03').values.gateway = '192.168.1.253';
check(m.risksOf(data, draft).length === 0, 'changing an ordinary route is no risk');
rowOf(draft, 'cfg01').removed = true;
check(j(m.risksOf(data, draft)) === j(['Removes the IPv4 default route via 192.0.2.1: without another one the router has no route to the internet.']), 'removing a default route is a risk', j(m.risksOf(data, draft)));
draft = m.draftFrom(data);
rowOf(draft, 'cfg01').values.enabled = false;
check(/Disables or moves the IPv4 default route/.test(m.risksOf(data, draft)[0]), 'disabling it is too');
draft = m.draftFrom(data);
rowOf(draft, 'cfg01').values.gateway = '192.0.2.9';
check(/Changes the IPv4 default route via 192\.0\.2\.1/.test(m.risksOf(data, draft)[0]), 'changing its gateway is too');
draft = m.draftFrom(data);
Object.assign(m.newRow(draft, 4).values, { target: '0.0.0.0/0', interface: 'wan', type: 'blackhole' });
check(/Adds an IPv4 blackhole default route that drops everything/.test(m.risksOf(data, draft)[0]), 'a new blackhole default route is a risk');
draft = m.draftFrom(data);
Object.assign(m.newRow(draft, 4).values, { target: '0.0.0.0/0', interface: 'wan', gateway: '192.0.2.1', table: 'voip' });
check(m.risksOf(data, draft).length === 0, 'a default route in another table does not decide where the router\'s traffic goes');
draft = m.draftFrom(data);
Object.assign(m.newRow(draft, 6).values, { target: '::/0', interface: 'wan', gateway: 'fe80::2' });
check(/Adds an IPv6 default route via fe80::2/.test(m.risksOf(data, draft)[0]), 'a new IPv6 default route is a risk');

console.log('== the check after a save ==');
draft = m.draftFrom(data);
rowOf(draft, 'cfg01').values.gateway = '192.0.2.9';
Object.assign(m.newRow(draft, 4).values, { target: '10.70.0.0/16', interface: 'lan', gateway: '192.168.1.254' });
rowOf(draft, 'cfg02').removed = true;
const after = m.readStatic({
  ...CFG4,
  ...sec('route', 'cfg01', { interface: 'wan', target: '0.0.0.0/0', gateway: '192.0.2.9', metric: '10' }),
  ...sec('route', 'cfg77', { interface: 'lan', target: '10.70.0.0/16', gateway: '192.168.1.254' }),
}, CFG6, {});
after.routes.splice(after.routes.findIndex(x => x.section === 'cfg02'), 1);
let thrown = null;
try { m.checkApplied(after, draft); } catch (e) { thrown = e; }
check(thrown === null, 'routes that match the draft (a new section name, an edit, a removal) pass the check', thrown?.message);
const stale = m.readStatic(CFG4, CFG6, {});
thrown = null;
try { m.checkApplied(stale, draft); } catch (e) { thrown = e; }
check(/does not hold the routes that were saved \(2 missing, 2 unexpected\)/.test(thrown?.message ?? ''), 'routes that were not kept fail it, counted', thrown?.message);
const ordering = m.readStatic({ ...sec('route', 'a2', { interface: 'lan', target: '10.1.0.0/16' }), ...sec('route', 'a1', { interface: 'lan', target: '10.2.0.0/16' }) }, {}, {});
draft = m.draftFrom(m.readStatic({ ...sec('route', 'a1', { interface: 'lan', target: '10.2.0.0/16' }), ...sec('route', 'a2', { interface: 'lan', target: '10.1.0.0/16' }) }, {}, {}));
thrown = null;
try { m.checkApplied(ordering, draft); } catch (e) { thrown = e; }
check(thrown === null, 'the order of the sections does not matter');
draft = m.draftFrom(read());
rowOf(draft, 'cfg11').values.gateway = 'FE80::1';
check(m.changesOf(read(), draft).length === 0 && m.plan(read(), draft).length === 0, 'an IPv6 address in capitals is the same value');

console.log('== the kernel ==');
data = read();
draft = m.draftFrom(data);
check(m.kernelState(rowOf(draft, 'cfg01'), data) === 'active' && m.kernelState(rowOf(draft, 'cfg11'), data) === 'active', 'a route the kernel holds (prefix, table, type and gateway) is active, in both families');
check(m.kernelState(rowOf(draft, 'cfg03'), data) === 'active', 'an older netmask route matches by its joined prefix');
check(m.kernelState(rowOf(draft, 'cfg05'), data) === 'active', 'a blackhole route in a named table matches by type and table');
check(m.kernelState(rowOf(draft, 'cfg02'), data) === 'missing' && m.kernelState(rowOf(draft, 'cfg12'), data) === 'missing' && m.kernelState(rowOf(draft, 'cfg06'), data) === 'missing', 'a route the kernel does not hold is missing');
check(m.kernelState(rowOf(draft, 'cfg04'), data) === 'disabled', 'a disabled route is disabled, not missing');
rowOf(draft, 'cfg01').values.gateway = '192.0.2.99';
check(m.kernelState(rowOf(draft, 'cfg01'), data) === 'missing', 'another gateway than the kernel\'s is not a match');
const fresh = m.newRow(draft, 4);
check(m.kernelState(fresh, data) === null && m.kernelState(rowOf(draft, 'cfg01'), read({})) === null, 'a new row, or no kernel data, has no state');
draft = m.draftFrom(data);
const c = m.counts(draft, data);
check(c.total === 8 && c.active === 4 && c.disabled === 1 && c.missing === 3, 'the counts of installed, missing and disabled routes', j(c));
draft = m.draftFrom(data);
rowOf(draft, 'cfg05').values.table = '100';
check(m.kernelState(rowOf(draft, 'cfg05'), data) === 'active', 'a table given by number matches the kernel\'s table by name');

console.log('== the interface choices ==');
draft = m.draftFrom(data);
check(j(m.interfaceChoices(data, draft)) === j(['lan', 'loopback', 'wan', 'wan2']), 'the choices are the router\'s interfaces');
rowOf(draft, 'cfg01').values.interface = 'oldwan';
check(m.interfaceChoices(data, draft).includes('oldwan'), 'a name a route already uses is kept, so it can be seen and fixed');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall Static routes model checks passed');
