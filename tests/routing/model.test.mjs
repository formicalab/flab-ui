// Unit test for the Routing page's model (www/js/pages/routing/model.js): address parsing and prefix matching, the
// table overview, findings, filtering and sorting, and what a lookup answer means. Pure functions: no router and no
// browser. Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/routing/model.js')).href);

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// A route as the plugin returns it; `over` replaces fields. `hops` are [via, dev, flags] triples.
const route = (prefix, over = {}, ...hops) => {
  const family = prefix.includes(':') ? 6 : 4;
  return {
    family, table: 'main', type: 'unicast', prefix, len: +prefix.split('/')[1], from: null, proto: 'static', scope: null, metric: null,
    src: null, pref: null, expires: null, mtu: null, nhid: null, flags: [],
    nexthops: hops.map(([via, dev, flags = []]) => ({ via, dev, weight: null, flags })), ...over,
  };
};
// A policy rule as the plugin returns it (IPv4, action lookup); `over` replaces fields.
const rule = (priority, table, selectors = [['from', 'all']], over = {}) => ({ family: 4, priority, selectors, action: 'lookup', table, goto: null, suppress_prefixlength: null, ...over });
// A full sample of the plugin's answer: routes, rules and the table names.
const data = () => ({
  available: true, truncated: false, bird: true, table_ids: { main: 254, local: 255, default: 253, voip: 100 },
  routes: [
    route('0.0.0.0/0', { metric: 10 }, ['192.0.2.1', 'wan']),
    route('0.0.0.0/0', { metric: 20 }, ['198.51.100.1', 'wan2', ['linkdown']]),
    route('10.0.0.0/22', { proto: 'bird', metric: 32 }, ['10.0.0.12', 'xfrm0'], ['10.0.0.13', 'xfrm1']),
    route('192.168.0.0/16', { type: 'blackhole', proto: 'bird', metric: 32 }),
    route('192.168.1.0/24', { proto: 'kernel', scope: 'link', src: '192.168.1.1' }, [null, 'br-lan']),
    route('10.20.0.0/16', { table: 'voip' }, ['192.168.1.254', 'br-lan']),
    route('192.168.1.1/32', { table: 'local', type: 'local' }, [null, 'br-lan']),
    route('::/0', { metric: 512, from: '2001:db8:1::/48' }, ['fe80::1', 'wan']),
    route('2001:db8:1::/48', { type: 'unreachable', metric: 2147483647 }, [null, 'lo']),
  ],
  rules: [rule(0, 'local'), rule(100, 'voip', [['from', '192.168.1.0/24'], ['iif', 'br-lan']]), rule(32766, 'main'), rule(32767, 'default')],
});

console.log('== addresses ==');
check(m.parseAddress('192.168.1.1').family === 4 && m.parseAddress('192.168.1.1').value === 3232235777n && m.parseAddress('256.1.1.1') === null && m.parseAddress('1.2.3') === null && m.parseAddress('') === null, 'IPv4 addresses');
check(m.parseAddress('::').value === 0n && m.parseAddress('::1').value === 1n && m.parseAddress('2001:db8::1').family === 6 && m.parseAddress('fe80::1').value >> 118n === 0x3fan, 'IPv6 addresses with "::"');
check(m.parseAddress('::ffff:1.2.3.4').value === 0xffff01020304n && m.parseAddress('1:2:3:4:5:6:1.2.3.4') !== null, 'an IPv4 tail in an IPv6 address');
check(['1::2::3', '1:2:3:4:5:6:7:8:9', 'gggg::1', '1.2.3.4.5', '::1.2.3', '1:2:3:4:5:6:7::8'].every(x => m.parseAddress(x) === null), 'things that are not addresses', ['1::2::3', '1:2:3:4:5:6:7:8:9', 'gggg::1', '1.2.3.4.5', '::1.2.3', '1:2:3:4:5:6:7::8'].filter(x => m.parseAddress(x)).join());
check(m.isAddress(' 10.0.0.1 ') && !m.isAddress('10.0.0.1; reboot') && !m.isAddress('example.com'), 'isAddress trims, and refuses names and shell text');
check(m.covers('10.0.0.0/22', '10.0.3.255') && !m.covers('10.0.0.0/22', '10.0.4.0') && m.covers('0.0.0.0/0', '8.8.8.8') && m.covers('1.2.3.4/32', '1.2.3.4') && !m.covers('1.2.3.4/32', '1.2.3.5'), 'IPv4 prefixes cover the right addresses');
check(m.covers('2001:db8:1::/48', '2001:db8:1:ffff::9') && !m.covers('2001:db8:1::/48', '2001:db8:2::1') && m.covers('::/0', '2606:4700::1') && !m.covers('::/0', '1.1.1.1') && !m.covers('10.0.0.0/8', '::1'), 'IPv6 prefixes cover the right addresses, and a family never matches the other');

console.log('== routes, tables, rules ==');
let d = data();
check(m.destination(d.routes[0]) === 'default' && m.destination(d.routes[2]) === '10.0.0.0/22', 'a zero-length prefix is shown as "default"');
check(m.routeKey(d.routes[0]) === '4|main|0.0.0.0/0||10' && m.routeKey(d.routes[4]) === '4|main|192.168.1.0/24||0' && m.routeKey(d.routes[7]) === '6|main|::/0|2001:db8:1::/48|512', 'a route\'s key: family, table, prefix, source prefix, metric');
check(m.routeText(d.routes[0]) === 'default via 192.0.2.1 dev wan proto static metric 10' && m.routeText(d.routes[3]) === 'blackhole 192.168.0.0/16 proto bird metric 32', 'a route as ip prints it', m.routeText(d.routes[0]));
check(m.routeText(d.routes[2]) === '10.0.0.0/22 proto bird metric 32\n  nexthop via 10.0.0.12 dev xfrm0\n  nexthop via 10.0.0.13 dev xfrm1', 'a multipath route lists its next hops', m.routeText(d.routes[2]));
check(m.tableId('voip', d.table_ids) === 100 && m.tableId('220', {}) === 220 && m.tableId('weird', {}) === null && m.tableLabel('main', d.table_ids) === 'main (254)' && m.tableLabel('220', {}) === '220', 'table numbers and labels');
const tables = m.tablesOf(d);
check(tables.map(t => t.name).join() === 'main,local,default,voip' || tables.map(t => t.name).join() === 'main,local,voip,default', 'the tables: main and local first, then by number', tables.map(t => t.name).join());
const main = tables.find(t => t.name === 'main'), voip = tables.find(t => t.name === 'voip');
check(main.v4 === 5 && main.v6 === 2 && j(main.rules) === '[32766]' && voip.v4 === 1 && j(voip.rules) === '[100]' && tables.find(t => t.name === 'default').rules[0] === 32767, 'route counts per family and the rules that consult each table', j(tables));
check(m.defaultRoutes(d, 4).length === 2 && m.defaultRoutes(d, 4)[0].metric === 10 && m.defaultRoutes(d, 6).length === 1 && m.defaultRoutes({ ...d, routes: [] }, 4).length === 0, 'default routes, best metric first');
check(d.rules.filter(m.isKernelRule).length === 3 && !m.isKernelRule(d.rules[1]) && !m.isKernelRule(rule(0, 'local', [['from', 'all']], { family: 4, action: 'goto' })) && !m.isKernelRule(rule(0, 'main')), 'only the three rules the kernel creates are kernel rules');
check(j(m.rulesFor(d, 'voip').map(r => r.priority)) === '[100]', 'the rules that consult a table');

console.log('== who added a rule ==');
// What routing.ruleOrigin says about rule `r`, with the UCI rules (none) and charon (running) overridable by `over`.
const origin = (r, over = {}) => m.ruleOrigin(r, { uci_rules: [], charon: true, ...over });
check(origin(d.rules[0]).kind === 'kernel' && origin(d.rules[2]).kind === 'kernel', 'the kernel\'s own rules say so');
let o = origin(d.rules[1], { uci_rules: [{ section: 'cfg0a1b2c', anonymous: true, family: 4, priority: 100, lookup: 'voip' }] });
check(o.kind === 'netifd' && /anonymous|a "config rule" section/.test(o.title) && /priority 100/.test(o.title), 'a rule configured in /etc/config/network (same family and priority) is netifd\'s', j(o));
o = origin(d.rules[1], { uci_rules: [{ section: 'voip_rule', anonymous: false, family: 4, priority: 100, lookup: 'voip' }] });
check(/"config rule voip_rule"/.test(o.title), 'a named section is named');
check(origin(d.rules[1], { uci_rules: [{ section: 'x', anonymous: true, family: 6, priority: 100 }, { section: 'y', anonymous: true, family: 4, priority: 101 }] }).kind === 'unknown', 'another family or priority is not a match');
o = origin(rule(220, '220'));
check(o.kind === 'strongswan' && o.label === 'strongSwan' && /charon.routing_table/.test(o.title) && !/leftover/.test(o.title), 'priority 220 on table 220 for every packet is strongSwan\'s', j(o));
check(/leftover/.test(origin(rule(220, '220'), { charon: false }).title), 'with charon stopped the rule may be a leftover');
check(origin(rule(220, '221')).kind === 'unknown' && origin(rule(230, '220')).kind === 'unknown' && origin(rule(220, '220', [['from', '10.0.0.0/8']])).kind === 'unknown', 'only strongSwan\'s exact defaults count');
const reject = rule(4200000000, null, [['from', 'fd00:1::1/60'], ['iif', 'br-lan']], { family: 6, action: 'unreachable' });
check(origin(reject).kind === 'netifd' && /delegated IPv6 prefix/.test(origin(reject).title) && origin({ ...reject, selectors: [['from', 'fd00:1::1/60']] }).kind === 'unknown' && origin({ ...reject, family: 4 }).kind === 'unknown', 'netifd\'s IPv6 reject rule, recognized by its pattern');
o = origin(rule(300, null, [['from', 'all'], ['uidrange', '1000-1999']], { action: 'goto', goto: 32766 }));
check(o.kind === 'unknown' && /does not say who added/.test(o.title), 'anything else is unknown, with the reason');
const names = m.interfaceNames({ interface: [{ interface: 'wan', l3_device: 'pppoe-wan', device: 'eth1' }, { interface: 'lan', device: 'br-lan' }, { interface: 'loopback', device: 'lo' }] });
check(names.get('pppoe-wan') === 'wan' && names.get('eth1') === 'wan' && names.get('br-lan') === 'lan' && m.interfaceNames(null).size === 0, 'device to logical interface names');

console.log('== findings ==');
let f = m.findings(d);
check(f.some(x => x.level === 'bad' && /1 route uses a next hop that is down/.test(x.text) && /default via wan2/.test(x.text)) && !f.some(x => /no IPv4 default/.test(x.text)) && !f.some(x => /IPv6 default/.test(x.text)), 'a next hop with linkdown is a problem; both defaults exist', j(f));
f = m.findings({ ...d, routes: d.routes.filter(r => r.len !== 0) });
check(f.some(x => x.level === 'warn' && /no IPv4 default route/.test(x.text)) && f.some(x => x.level === 'info' && /no IPv6 default route/.test(x.text)), 'a missing default route: a warning for IPv4, a note for IPv6');
f = m.findings({ ...d, routes: [route('0.0.0.0/0', { type: 'blackhole' })] });
check(f.some(x => x.level === 'bad' && /default route is a blackhole route/.test(x.text)), 'a blackhole default route is a problem');
check(m.findings({ ...d, available: false })[0].level === 'bad' && m.findings({ ...d, truncated: true }).some(x => /more routes than are listed/.test(x.text)), 'ip not available; a truncated list is mentioned');
check(m.findings({ ...d, routes: [route('0.0.0.0/0', {}, ['1.1.1.1', 'wan']), route('::/0', {}, ['fe80::1', 'wan'])] }).length === 0, 'a healthy state has no findings');

console.log('== filtering and sorting ==');
const all = d.routes;
check(m.filterRoutes(all, { table: 'main' }).length === 7 && m.filterRoutes(all, { table: 'all' }).length === 9 && m.filterRoutes(all, { table: 'voip' }).length === 1, 'the table selector');
check(m.filterRoutes(all, { table: 'all', family: '6' }).length === 2 && m.filterRoutes(all, { table: 'all', family: '4' }).length === 7, 'the family selector');
check(m.filterRoutes(all, { table: 'all', q: 'xfrm1' }).length === 1 && m.filterRoutes(all, { table: 'all', q: 'BLACKHOLE' }).length === 1 && m.filterRoutes(all, { table: 'all', q: 'static wan2' }).length === 1 && m.filterRoutes(all, { table: 'all', q: 'nothing-here' }).length === 0, 'text filter: every word, any column, case-insensitive');
check(m.filterRoutes(all, { table: 'all', q: 'azure' }, new Map([['xfrm0', 'azure']])).length === 1 && m.filterRoutes(all, { table: 'all', q: 'azure' }).length === 0, 'the logical interface name is searchable too');
let sorted = m.sortRoutes(m.filterRoutes(all, { table: 'main' }), { key: 'prefix', dir: 1 });
check(sorted.map(r => r.prefix).join() === '0.0.0.0/0,0.0.0.0/0,10.0.0.0/22,192.168.0.0/16,192.168.1.0/24,::/0,2001:db8:1::/48', 'by destination: IPv4 before IPv6, numerically', sorted.map(r => r.prefix).join());
sorted = m.sortRoutes(m.filterRoutes(all, { table: 'main', family: '4' }), { key: 'metric', dir: -1 });
check(sorted[0].metric === 32 && (sorted.at(-1).metric ?? 0) === 0, 'by metric, descending');
sorted = m.sortRoutes(m.filterRoutes(all, { table: 'all', family: '4' }), { key: 'dev', dir: 1 });
check(sorted[0].nexthops[0]?.dev === '' || sorted[0].nexthops.length === 0 || sorted[0].nexthops[0].dev <= sorted[1].nexthops[0]?.dev, 'by interface');
sorted = m.sortRoutes(m.filterRoutes(all, { table: 'all', family: '4' }), { key: 'table', dir: 1 });
check(sorted.map(r => r.table).join() === 'local,main,main,main,main,main,voip', 'by table, the table name decides', sorted.map(r => r.table).join());
check(m.sortRoutes(all, { key: 'unknown', dir: 1 }).length === all.length, 'an unknown sort key falls back to the destination');

console.log('== the meaning of a lookup answer ==');
// A successful lookup answer for 1.1.1.1 via the main table; `over` replaces fields.
const answer = over => ({ ok: true, family: 4, dst: '1.1.1.1', get: { ok: true, type: 'unicast', via: '192.0.2.1', dev: 'wan', src: '192.0.2.77', table: 'main', flags: [] }, match: d.routes[0], match_error: null, raw: {}, ...over });
let v = m.interpret(answer(), d.routes);
check(v.verdict === 'forward' && v.nextHop === '192.0.2.1' && v.dev === 'wan' && v.src === '192.0.2.77' && v.table === 'main' && v.paths === 1 && v.route === d.routes[0], 'a forwarded packet', j(v));
v = m.interpret(answer({ get: { ok: true, type: 'unicast', via: null, dev: 'br-lan', src: '192.168.1.1', table: 'main', flags: [] }, match: d.routes[4] }), d.routes);
check(v.verdict === 'forward' && v.nextHop === null && /directly reachable through br-lan/.test(v.text), 'a destination on the link has no next hop');
v = m.interpret(answer({ match: d.routes[2] }), d.routes);
check(v.paths === 2, 'an ECMP route has several paths');
v = m.interpret(answer({ dst: '192.168.1.1', get: { ok: true, type: 'local', via: null, dev: 'lo', src: '192.168.1.1', table: 'local', flags: ['local'] }, match: d.routes[6] }), d.routes);
check(v.verdict === 'local' && v.dev === 'br-lan' && v.table === 'local' && /belongs to this router/.test(v.text), 'a local address names the real device, not lo', j(v));
check(m.interpret(answer({ get: { ok: true, type: 'broadcast', dev: 'br-lan', table: 'local', flags: [] } }), d.routes).verdict === 'broadcast', 'a broadcast address');
v = m.interpret(answer({ dst: '192.168.5.5', get: { ok: false, error: 'Invalid argument' }, match: null, match_error: 'Invalid argument' }), d.routes);
check(v.verdict === 'drop' && v.route.type === 'blackhole' && v.table === 'main' && /silently discarded/.test(v.text), 'an "Invalid argument" error inside a blackhole route is a drop', j(v));
v = m.interpret(answer({ family: 6, dst: '2001:db8:1::99', get: { ok: false, error: 'Host is unreachable' }, match: null }), d.routes);
check(v.verdict === 'drop' && v.route.type === 'unreachable' && /host unreachable/.test(v.text), 'an unreachable route');
v = m.interpret(answer({ family: 6, dst: '2606:4700::1', get: { ok: false, error: 'Network unreachable' }, match: null }), d.routes.filter(r => r.len !== 0));
check(v.verdict === 'none' && /No route covers/.test(v.text), 'no covering route at all');
v = m.interpret(answer({ get: { ok: false, error: 'Network is unreachable' }, match: null }), d.routes);
check(v.verdict === 'error' && v.text === 'Network is unreachable', 'a refusal that no route explains keeps the kernel\'s words (the default route covers the address)');
v = m.interpret(answer({ family: 6, dst: '2606:4700::1', get: { ok: false, error: 'Network unreachable' }, match: null }), d.routes);
check(v.verdict === 'none' && /restricted to certain source addresses/.test(v.text) && /2001:db8:1::\/48/.test(v.text), 'only a source-specific default route covers the address: the answer says a source is needed', j(v));
v = m.interpret({ ok: false, error: 'Enter an IPv4 or IPv6 address.' }, d.routes);
check(v.verdict === 'invalid' && v.text === 'Enter an IPv4 or IPv6 address.' && m.interpret(null, []) === null, 'refused input; no lookup yet');
check(m.coveringRoutes(d.routes, '10.0.1.5')[0].prefix === '10.0.0.0/22' && m.coveringRoutes(d.routes, '10.0.1.5').at(-1).len === 0 && m.coveringRoutes(d.routes, 'not an ip').length === 0, 'covering routes, most specific first');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall routing model checks passed');
