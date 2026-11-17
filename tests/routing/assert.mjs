// Checks the JSON the flab.routing plugin produced for each scenario. Usage: node assert.mjs <dir with <scenario>.status.json,
// rich.lookup-<case>.json and lookup-names.json>. The scenarios are built by mkfx.mjs (see there).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
// Loads one output file as JSON.
const load = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

//#region The rich scenario: every syntax the parser handles
console.log('== rich: routes ==');
const s = load('rich.status.json');
const routes = s.routes;
// The first route of a family that has the table and prefix (and, when given, the source prefix).
const find = (family, table, prefix, from) => routes.find(r => r.family === family && r.table === table && r.prefix === prefix && (from === undefined || r.from === from));
check(s.available === true && s.truncated === false && s.bird === true, 'the router answered, nothing was cut, BIRD is installed');
check(s.table_ids.main === 254 && s.table_ids.local === 255 && s.table_ids.voip === 100 && s.table_ids.unspec === 0 && Object.keys(s.table_ids).length === 5, 'table names and numbers come from rt_tables (comments skipped)', j(s.table_ids));
check(routes.filter(r => r.family === 4).length === 14 && routes.filter(r => r.family === 6).length === 8, 'every route line is one route (next-hop lines do not count)', `${routes.length}`);

let r = find(4, 'main', '0.0.0.0/0');
check(r && r.len === 0 && r.type === 'unicast' && r.metric === 10 && r.proto === 'static' && r.nexthops.length === 1 && r.nexthops[0].via === '192.0.2.1' && r.nexthops[0].dev === 'wan', '"default" becomes 0.0.0.0/0 with its next hop, protocol and metric', j(r));
r = routes.find(x => x.metric === 20 && x.len === 0);
check(r && r.nexthops[0].flags.includes('linkdown') && r.flags.includes('linkdown'), 'a linkdown flag is kept on the next hop', j(r));
r = find(4, 'main', '10.0.0.0/22');
check(r && r.metric === 32 && r.proto === 'bird' && r.nexthops.length === 2 && r.nexthops[0].via === '10.0.0.12' && r.nexthops[0].dev === 'xfrm0' && r.nexthops[0].weight === 1
  && r.nexthops[1].via === '10.0.0.13' && j(r.nexthops[1].flags) === '["dead","linkdown"]', 'a multipath route collects its nexthop lines, with weights and flags', j(r));
r = find(4, 'main', '10.9.0.0/16');
check(r && r.nexthops[0].via === 'fe80::1' && j(r.nexthops[0].flags) === '["onlink"]', 'an IPv6 next hop of an IPv4 route ("via inet6") and the onlink flag', j(r));
r = find(4, 'main', '192.168.0.0/16');
check(r && r.type === 'blackhole' && r.nexthops.length === 0 && r.proto === 'bird', 'a blackhole route has no next hop');
check(find(4, 'main', '203.0.113.0/24')?.type === 'prohibit' && find(4, 'main', '198.18.0.0/15')?.type === 'throw', 'prohibit and throw routes');
r = find(4, 'main', '172.16.0.0/12');
check(r && r.mtu === 1380 && r.scope === 'link' && r.nexthops[0].dev === 'wg0' && r.nexthops[0].via === null, '"mtu lock 1380" gives the MTU; a route without via is directly connected', j(r));
r = find(4, 'main', '192.0.2.1/32');
check(r && r.src === '192.0.2.77' && r.scope === 'link' && r.proto === 'kernel', 'a host route gets /32 and keeps its source address');
r = find(4, 'voip', '10.20.0.0/16');
check(r && r.nexthops[0].via === '192.168.1.254' && r.proto === 'static', 'a route in a named table carries the table name');
check(find(4, '220', '0.0.0.0/0')?.nexthops[0].dev === 'wan', 'a route in a numbered table keeps the number');
r = find(4, 'local', '192.168.1.1/32');
check(r && r.type === 'local' && r.scope === 'host' && find(4, 'local', '192.168.1.255/32')?.type === 'broadcast', 'local and broadcast routes live in the local table');

r = find(6, 'main', '::/0');
check(r && r.from === '2001:db8:1::/48' && r.metric === 512 && r.pref === 'medium' && r.nexthops[0].via === 'fe80::1', 'an IPv6 default route with a source prefix', j(r));
check(find(6, 'main', '2001:db8:2::/64')?.expires === 1750 && find(6, 'main', '2001:db8:2::/64')?.proto === 'ra', '"expires 1750sec" is a number of seconds');
check(find(6, 'main', '2001:db8:1::/48')?.type === 'unreachable' && find(6, 'main', '2001:db8:1::/48')?.metric === 2147483647, 'an unreachable route with its metric');
r = find(6, 'main', 'fd00:1::/64');
check(r && r.nexthops.length === 2 && r.nexthops[1].dev === 'wg0', 'an IPv6 multipath route');
check(find(6, 'local', '::1/128')?.type === 'local' && find(6, 'local', 'ff00::/8')?.type === 'multicast', 'IPv6 host prefixes get /128; multicast routes are typed');

console.log('== rich: rules ==');
const rules = s.rules;
// The rule of address `family` with priority `prio`.
const rule = (family, prio) => rules.find(x => x.family === family && x.priority === prio);
check(rules.filter(x => x.family === 4).length === 8 && rules.filter(x => x.family === 6).length === 3, 'every rule line is one rule');
check(rule(4, 0).action === 'lookup' && rule(4, 0).table === 'local' && j(rule(4, 0).selectors) === '[["from","all"]]', 'the kernel\'s rule 0', j(rule(4, 0)));
check(j(rule(4, 100).selectors) === '[["from","192.168.1.0/24"],["iif","br-lan"]]' && rule(4, 100).table === 'voip', 'selectors keep their order; the table is named', j(rule(4, 100)));
check(j(rule(4, 200).selectors) === '[["not from","10.0.0.0/8"],["fwmark","0x1/0xff"]]' && rule(4, 200).table === '220' && rule(4, 200).suppress_prefixlength === 0, '"not", fwmark and suppress_prefixlength', j(rule(4, 200)));
check(rule(4, 300).action === 'goto' && rule(4, 300).goto === 32766 && rule(4, 300).table === null && j(rule(4, 300).selectors) === '[["from","all"],["uidrange","1000-1999"]]', 'a goto rule', j(rule(4, 300)));
check(rule(4, 400).action === 'prohibit' && j(rule(4, 400).selectors) === '[["from","all"],["to","203.0.113.0/24"]]', 'a prohibit rule', j(rule(4, 400)));
check(rule(6, 4200000000).action === 'unreachable' && j(rule(6, 4200000000).selectors) === '[["from","2001:db8:1::1/60"],["iif","br-lan"]]', 'an IPv6 rule with a very large priority', j(rule(6, 4200000000)));
check(rule(4, 220).action === 'lookup' && rule(4, 220).table === '220', 'strongSwan\'s default rule');

console.log('== rich: who could have added a rule ==');
check(s.charon === true, 'charon runs (pidof reports a process)');
check(j(s.uci_rules) === j([{ section: 'cfg0a1b2c', anonymous: true, family: 4, priority: 100, lookup: 'voip' }, { section: 'v6_extra', anonymous: false, family: 6, priority: 6000, lookup: 'main' }]), 'the rules configured in /etc/config/network, with only the fields the page needs', j(s.uci_rules));
check(!JSON.stringify(s).includes('TOPSECRETKEY') && !JSON.stringify(s).includes('private_key'), 'nothing else of the network config leaves the plugin (a planted key never appears)');
//#endregion

//#region Lookups
console.log('== lookups ==');
// The captured answer of the rich scenario's route lookup `n`.
const L = n => load(`rich.lookup-${n}.json`);
let l = L('fwd');
check(l.ok && l.family === 4 && l.get.ok && l.get.type === 'unicast' && l.get.via === '192.0.2.1' && l.get.dev === 'wan' && l.get.src === '192.0.2.77' && l.get.table === 'main', 'a forwarded packet: next hop, device, source address, table', j(l.get));
check(l.match.prefix === '0.0.0.0/0' && l.match.nexthops[0].via === '192.0.2.1' && l.match.metric === 10 && l.match_error === null, 'the FIB entry that answered', j(l.match));
check(/cache/.test(l.raw.get) && /^default via/.test(l.raw.match), 'the raw ip output is returned', j(l.raw));
l = L('ecmp');
check(l.match.nexthops.length === 2 && l.get.via === '10.0.0.12' && l.match.nexthops[1].flags.includes('dead'), 'an ECMP route: the kernel picked one path, the entry lists both', j(l));
l = L('local');
check(l.get.ok && l.get.type === 'local' && l.get.table === 'local' && j(l.get.flags) === '["local"]' && l.match.type === 'local' && l.match.nexthops[0].dev === 'br-lan', 'a local address', j(l));
l = L('broadcast');
check(l.get.type === 'broadcast' && j(l.get.flags) === '["local","brd"]', 'a broadcast address and its cache flags', j(l.get));
l = L('blackhole');
check(l.ok && l.get.ok === false && l.get.error === 'Invalid argument' && l.match === null && l.match_error === 'Invalid argument', 'a blackhole route makes the kernel answer with an error, which is passed on', j(l));
check(L('unreach6').get.error === 'Host is unreachable' && L('noroute6').get.error === 'Network unreachable' && L('noroute6').family === 6, 'unreachable and missing routes keep the kernel\'s words');
l = L('iif');
check(l.get.ok && l.get.from === '192.168.1.50' && l.get.iif === 'br-lan' && l.get.via === '192.0.2.1' && l.src === '192.168.1.50' && l.iif === 'br-lan', 'IPv4 lookup from a source on an interface (the interface is on the cache line)', j(l.get));
l = L('iif6');
check(l.get.ok && l.get.iif === 'br-lan' && l.get.from === '2001:db8:1::50' && l.get.proto === 'static' && l.get.metric === 512 && l.get.src === '2001:db8:1::1' && l.match.from === '2001:db8:1::/48', 'IPv6 lookup with a source prefix route', j(l));
l = L('table');
check(l.get.table === 'voip' && l.match.table === 'voip' && l.match.prefix === '10.20.0.0/16', 'an answer from a named table', j(l));
l = L('mismatch');
check(l.ok && l.get.ok === false && /inet prefix is expected/.test(l.get.error), 'mixed address families: the tool\'s message is returned', j(l.get));
check(L('injection').ok === false && /Enter an IPv4 or IPv6 address/.test(L('injection').error) && L('badsrc').ok === false && /source/.test(L('badsrc').error) && L('badiif').ok === false && /interface name/.test(L('badiif').error), 'shell metacharacters in the destination, source or interface are refused before any command runs');
check(L('newlinedst').ok === false && /Enter an IPv4 or IPv6 address/.test(L('newlinedst').error) && L('newlinesrc').ok === false && /source/.test(L('newlinesrc').error) && L('newlineiif').ok === false && /interface name/.test(L('newlineiif').error), 'a newline in the destination, source or interface is refused too (it would start a second shell command)');
//#endregion

//#region Without ip, and the real router
console.log('== noip ==');
const n = load('noip.status.json');
check(n.available === false && n.routes.length === 0 && n.rules.length === 0 && n.bird === false && n.charon === false && n.uci_rules.length === 0 && Object.keys(n.table_ids).length === 0, 'no ip output: nothing available, no error');

if (fs.existsSync(path.join(dir, 'real.status.json'))) {
  console.log('== the real router ==');
  const real = load('real.status.json');
  check(real.available && real.routes.length > 0 && real.rules.length > 0, 'the router reports routes and rules', `${real.routes.length} routes, ${real.rules.length} rules`);
  const bad = real.routes.filter(x => ![4, 6].includes(x.family) || !/^[0-9a-f:.]+\/\d+$/i.test(x.prefix) || typeof x.len !== 'number' || !x.table || !Array.isArray(x.nexthops) || !Array.isArray(x.flags));
  check(bad.length === 0, 'every route has a family, a normalized prefix with its length, a table and next-hop lists', j(bad[0]));
  const noHop = real.routes.filter(x => x.nexthops.length === 0 && x.type === 'unicast');
  check(noHop.length === 0, 'every unicast route has a next hop', j(noHop[0]));
  check(real.rules.every(x => Number.isInteger(x.priority) && x.selectors.length > 0 && ['lookup', 'goto', 'blackhole', 'unreachable', 'prohibit', 'l3mdev', 'nat'].includes(x.action)), 'every rule has a priority, selectors and an action');
  check(real.rules.some(x => x.priority === 0 && x.table === 'local') && real.rules.some(x => x.priority === 32766 && x.table === 'main'), 'the kernel\'s own rules are there');
  check(typeof real.charon === 'boolean' && Array.isArray(real.uci_rules) && real.uci_rules.every(x => [4, 6].includes(x.family) && typeof x.section === 'string'), 'the router says whether charon runs and lists its configured rules');
}
//#endregion

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall routing backend checks passed');
