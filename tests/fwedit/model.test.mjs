// Unit test of the Firewall page's editing model (www/js/pages/firewall: schema.js, check.js, edit.js, validate.js, plan.js, view.js and
// describe.js): reading the config, the draft and its operations, the review list, validation (errors, warnings, the lock-out check), the UCI
// operations and the order of sections, the check after a save, and the words that describe a rule. Pure functions: no router and no
// browser. Usage: node model.test.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Imports one module of the page.
const mod = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/firewall', f)).href);
const E = await mod('edit.js');
const V = await mod('validate.js');
const P = await mod('plan.js');
const C = await mod('check.js');
const D = await mod('describe.js');
const W = await mod('view.js');
const { stageOps } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/core/ops.js')).href);
const { createUci } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/core/uci.js')).href);

let failed = 0;
// Prints PASS or FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// Whether two objects hold the same keys and values, whatever the order of the keys.
const same = (a, b) => j(Object.entries(a).sort()) === j(Object.entries(b).sort());
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

// One section of `uci get firewall`: `name` is cfgXXXXXX for an anonymous one, a word for a named one.
const sec = (index, name, type, opts) => [name, { '.anonymous': name.startsWith('cfg'), '.type': type, '.name': name, '.index': index, ...opts }];
// A config like the lab router's: defaults, zones lan, wan and vpn, forwardings, anonymous and named rules, a port forward, an include.
const baseCfg = () => Object.fromEntries([
  sec(0, 'cfg01', 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', synflood_protect: '1' }),
  sec(1, 'cfg02', 'zone', { name: 'lan', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', network: ['lan', 'lan100'] }),
  sec(2, 'cfg03', 'zone', { name: 'wan', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1', mtu_fix: '1', network: ['wan', 'wan6'] }),
  sec(3, 'cfg04', 'forwarding', { src: 'lan', dest: 'wan' }),
  sec(4, 'cfg05', 'rule', { name: 'Allow-Ping', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' }),
  sec(5, 'cfg06', 'rule', { name: 'Allow-IPSec', src: 'wan', proto: 'udp', dest_port: ['500', '4500'], family: 'ipv4', target: 'ACCEPT' }),
  sec(6, 'wg', 'rule', { name: 'Allow-WireGuard', src: 'wan', dest_port: '51820', proto: 'udp', target: 'ACCEPT' }),
  sec(7, 'cfg07', 'zone', { name: 'vpn', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', mtu_fix: '1', network: ['xfrm0'] }),
  sec(8, 'cfg08', 'forwarding', { src: 'lan', dest: 'vpn' }),
  sec(9, 'cfg09', 'rule', { src: 'vpn', proto: 'tcp', dest_port: '3128', target: 'REJECT' }),
  sec(10, 'cfg0a', 'redirect', { name: 'Web', src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10', dest_port: '80', proto: 'tcp', target: 'DNAT' }),
  sec(11, 'cfg0b', 'include', { path: '/etc/firewall.user' }),
]);
// The reply of flab.firewall status that goes with baseCfg: counters for the rules, the loaded zones, the router's interfaces.
const baseStatus = () => ({
  running: true, defaults: {}, includes: [], ipsets: 0, conntrack: { count: 10, max: 100 }, flowtable: null, unzoned: [], loaded_zones: ['lan', 'wan', 'vpn'],
  zones: [{ name: 'lan', enabled: true, networks: ['lan', 'lan100'], devices: ['br-lan'], blocked_from: null, blocked_to: null }, { name: 'wan', enabled: true, networks: ['wan', 'wan6'], devices: ['wan'], blocked_from: { action: 'reject', packets: 5, bytes: 500 }, blocked_to: null }, { name: 'vpn', enabled: true, networks: ['xfrm0'], devices: ['xfrm0'], blocked_from: null, blocked_to: null }],
  rules: [{ section: 'cfg05', enabled: true, key: 'Allow-Ping', hits: { packets: 3, bytes: 300 } }, { section: 'cfg06', enabled: true, key: 'Allow-IPSec', hits: null }, { section: 'wg', enabled: true, key: 'Allow-WireGuard', hits: { packets: 9, bytes: 900 } }, { section: 'cfg09', enabled: true, key: '@rule[3]', hits: null }],
  redirects: [{ section: 'cfg0a', enabled: true, key: 'Web', kind: 'redirect', hits: { packets: 1, bytes: 60 } }],
  networks: [{ name: 'lan', addrs: ['192.168.1.1'] }, { name: 'lan100', addrs: ['192.168.100.1'] }, { name: 'wan', addrs: [] }, { name: 'wan6', addrs: [] }, { name: 'voip', addrs: [] }, { name: 'xfrm0', addrs: [] }, { name: 'guest', addrs: ['192.168.50.1'] }, { name: 'loopback', addrs: ['127.0.0.1'] }],
});
// The page's data for the base router.
const data = () => E.readFirewall(baseStatus(), baseCfg());
// A fresh draft of the base router, with the data.
const fresh = () => { const d = data(); return { d, draft: E.draftFrom(d) }; };
// The operations of a draft as compact text, for comparing.
const ops = (d, draft) => P.plan(d, draft);

//#region Reading
console.log('== reading ==');
{
  const d = data();
  check(d.zones.length === 3 && d.forwardings.length === 2 && d.rules.length === 4 && d.redirects.length === 1 && d.nat.length === 0, 'the sections of each type', `${d.zones.length} ${d.rules.length}`);
  check(d.defaults.section === 'cfg01' && d.sections.map(s => s.section).join() === 'cfg01,cfg02,cfg03,cfg04,cfg05,cfg06,wg,cfg07,cfg08,cfg09,cfg0a,cfg0b', 'the defaults section and the order of every section');
  check(d.rules[2].section === 'wg' && d.rules[3].section === 'cfg09', 'a rule is identified by its section name, a named one included');
  check(d.editable && E.networkNames(d).includes('voip'), 'the config is editable and the router\'s interfaces are known');
  const sorted = E.readFirewall(baseStatus(), Object.fromEntries(Object.entries(baseCfg()).reverse()));
  check(sorted.sections[0].section === 'cfg01' && sorted.rules[0].section === 'cfg05', 'sections are put in file order by their index, not by the order of the reply');
  check(!E.readFirewall(baseStatus(), null).editable, 'no config (the login may not read it) means read only');
  const draft = E.draftFrom(d);
  const lan = draft.zones[0].values, ping = draft.rules[0].values, ipsec = draft.rules[1].values;
  check(lan.name === 'lan' && lan.input === 'ACCEPT' && lan.network.join() === 'lan,lan100' && lan.masq === false && lan.enabled === true, 'a zone\'s form values', j(lan));
  check(ping.proto.join() === 'icmp' && ping.icmp_type.join() === 'echo-request' && ping.target === 'ACCEPT' && ping.enabled === true && ping.family === 'ipv4', 'a rule\'s form values (a single value is a list of one)', j(ping));
  check(ipsec.dest_port.join() === '500,4500', 'a list option is a list');
  check(draft.rules[3].values.name === '' && draft.rules[3].values.target === 'REJECT', 'an unnamed rule has an empty name');
  const odd = E.formValues(E.KINDS.rules.fields, { target: 'reject', family: 'all' });
  check(odd.target === 'REJECT' && odd.family === 'any', 'fw4 reads values loosely: the form shows the listed spelling');
  check(E.formValues(E.KINDS.rules.fields, {}).target === 'DROP', 'a rule without an action drops (the firewall\'s default)');
  check(E.formValues(E.KINDS.redirects.fields, {}).target === 'DNAT' && E.formValues(E.KINDS.redirects.fields, {}).reflection === true, 'a port forward without a kind is DNAT, with reflection on');
  check(E.formValues(E.KINDS.rules.fields, { weekdays: ['mon', 'tue'] }).weekdays === 'mon tue', 'a weekday list written as a UCI list is read as one string');
  const legacy = E.formValues(P ? (await mod('schema.js')).DEFAULT_FIELDS : [], { syn_flood: '1' });
  check(legacy.synflood_protect === true, 'the legacy syn_flood option reads as SYN-flood protection');
  check(E.adminNetworks(d, '192.168.1.1').join() === 'lan' && E.adminNetworks(d, 'router.lan').length === 0 && E.adminNetworks(d, '[fd00::1]').length === 0, 'the interface the page was opened through is recognized by the router\'s address');
}
//#endregion

//#region Nothing changed
console.log('\n== nothing changed ==');
{
  const { d, draft } = fresh();
  check(P.changesOf(d, draft).length === 0 && !P.isDirty(d, draft) && P.plan(d, draft).length === 0, 'an untouched draft has no changes and no operations');
  const found = V.problems(d, draft);
  check(found.errors.length === 0 && found.warnings.length === 0, 'and no problems', j(found));
}
//#endregion

//#region Zones
console.log('\n== zones ==');
{
  const { d, draft } = fresh();
  draft.zones[1].values.input = 'DROP';
  draft.zones[1].values.log = '1';
  const plan = ops(d, draft);
  check(j(plan) === j([{ op: 'set', config: 'firewall', section: 'cfg03', values: { input: 'DROP', log: '1' } }]), 'a policy and the logging are set on that zone only', j(plan));
  const ch = P.changesOf(d, draft);
  check(ch.length === 2 && ch[0].label === 'Zone wan: Input policy' && ch[0].from === 'REJECT' && ch[0].to === 'DROP', 'the review shows what changes from what to what', j(ch));
}
{
  const { d, draft } = fresh();
  draft.zones[1].values.mtu_fix = false;
  draft.zones[1].values.network = [];
  const plan = ops(d, draft);
  check(plan.length === 2 && plan[0].values.mtu_fix === '0' && plan[1].op === 'delete' && plan[1].options.join() === 'network', 'a turned-off switch is written as 0 and an emptied list is deleted', j(plan));
}
{
  const { d, draft } = fresh();
  const values = { ...E.newValues('zones', d), name: 'guest', network: ['guest', 'lan100'], masq: false };
  check(values.input === 'REJECT' && values.output === 'ACCEPT' && values.forward === 'REJECT', 'a new zone starts with input and forward rejected');
  const id = E.commitItem(draft, 'zones', null, values);
  check(id === 'new:1' && draft.zones.length === 4 && draft.zones[3].isNew, 'a new zone gets an id of its own');
  check(draft.zones[0].values.network.join() === 'lan' && V.problems(d, draft).errors.length === 0, 'choosing an interface of another zone moves it: it is taken out of that zone');
  const plan = ops(d, draft);
  const add = plan.find(o => o.op === 'add');
  check(add.type === 'zone' && add.id === 'new:1' && j(add.values) === j({ name: 'guest', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', network: ['guest', 'lan100'] }), 'a new zone is added with only the options that matter', j(add));
  check(plan.some(o => o.op === 'set' && o.section === 'cfg02' && j(o.values) === j({ network: ['lan'] })), 'the zone that lost the interface is changed');
  check(!plan.some(o => o.op === 'order'), 'the order of zones does not matter to the firewall, so a new zone is simply added', j(plan));
}
{
  const { d, draft } = fresh();
  E.removeZone(draft, 'cfg03');
  check(draft.zones[1].removed && draft.forwardings[0].removed && !draft.forwardings[1].removed, 'removing a zone removes the forwardings that name it');
  check(V.problems(d, draft).errors.some(e => /Allow-Ping/.test(e.text) && /being removed/.test(e.text)), 'rules that still refer to it are errors, so Save is blocked', j(V.problems(d, draft).errors));
  const plan = ops(d, draft);
  check(plan.filter(o => o.op === 'delete').map(o => o.section).sort().join() === 'cfg03,cfg04', 'the zone and its forwarding are deleted');
  E.restoreZone(draft, 'cfg03');
  check(P.changesOf(d, draft).length === 0, 'taking the zone back takes its forwardings back');
}
{
  const { d, draft } = fresh();
  draft.zones[0].values.network = ['lan', 'lan100', 'wan'];
  const e = V.problems(d, draft).errors.filter(x => /also in zone/.test(x.text));
  check(e.length === 2, 'an interface in two zones is an error for both', j(e));
  const { d: d2, draft: draft2 } = fresh();
  draft2.zones[0].values.name = 'wan';
  check(V.problems(d2, draft2).errors.some(x => /unique/.test(x.text)), 'two zones with one name are an error');
  const e3 = V.itemProblems('zones', null, { ...E.newValues('zones', d2), name: 'bad name!', network: ['voip'] }, draft2, d2);
  check(e3.some(x => x.key === 'name' && x.level === 'error'), 'a zone name with a space is refused', j(e3));
  const e4 = V.itemProblems('zones', null, { ...E.newValues('zones', d2), name: 'x', network: [] }, draft2, d2);
  check(e4.some(x => x.level === 'warn' && /looks for an interface called "x"/.test(x.text)) && !e4.some(x => x.level === 'error'), 'a zone with nothing in it is a warning', j(e4));
  const e5 = V.itemProblems('zones', null, { ...E.newValues('zones', d2), name: 'x', network: ['nosuch'], subnet: ['300.1.1.1/24'] }, draft2, d2);
  check(e5.some(x => x.key === 'network' && x.level === 'warn') && e5.some(x => x.key === 'subnet' && x.level === 'error'), 'an unknown interface is a warning, a bad subnet is an error', j(e5));
}
//#endregion

//#region Forwardings
console.log('\n== forwardings ==');
{
  const { d, draft } = fresh();
  check(E.toggleForwarding(draft, 'lan', 'wan') === 'removed' && draft.forwardings[0].removed, 'clicking an open cell removes the forwarding');
  check(E.toggleForwarding(draft, 'wan', 'lan') === 'added' && draft.forwardings.at(-1).isNew, 'clicking a closed cell adds one');
  const plan = ops(d, draft);
  check(j(plan) === j([{ op: 'delete', config: 'firewall', section: 'cfg04' }, { op: 'add', config: 'firewall', type: 'forwarding', id: 'new:1', values: { src: 'wan', dest: 'lan' } }]), 'one section is deleted and one added (with no needless options)', j(plan));
  check(E.toggleForwarding(draft, 'wan', 'lan') === 'removed' && draft.forwardings.length === 2, 'clicking again drops the new one');
  const { d: d2, draft: draft2 } = fresh();
  draft2.forwardings[0].values.enabled = false;
  check(E.toggleForwarding(draft2, 'lan', 'wan') === 'enabled' && P.changesOf(d2, draft2).length === 0, 'a disabled forwarding is enabled by the click, not duplicated');
  const view = W.effectiveView(d, draft);
  check(view.zones.find(z => z.name === 'lan').forwards.join() === 'vpn' && view.zones.find(z => z.name === 'wan').forwards.join() === '', 'the view follows the draft: lan no longer forwards to wan');
}
{
  const { d, draft } = fresh();
  draft.forwardings[0].values.dest = 'nosuch';
  check(V.problems(d, draft).errors.some(e => /does not exist/.test(e.text)), 'a forwarding to a zone that does not exist is an error');
  draft.forwardings[0].values.dest = 'lan';
  draft.forwardings[0].values.src = 'lan';
  check(V.problems(d, draft).warnings.some(w => /does nothing/.test(w)), 'a forwarding from a zone to itself is a warning');
}
//#endregion

//#region Rules
console.log('\n== rules ==');
{
  const { d, draft } = fresh();
  draft.rules[0].values.enabled = false;
  draft.rules[1].values.dest_port = ['500'];
  draft.rules[1].values.limit = '3/min';
  draft.rules[2].values.name = '';
  const plan = ops(d, draft);
  check(j(plan) === j([
    { op: 'set', config: 'firewall', section: 'cfg05', values: { enabled: '0' } },
    { op: 'set', config: 'firewall', section: 'cfg06', values: { dest_port: ['500'], limit: '3/min' } },
    { op: 'delete', config: 'firewall', section: 'wg', options: ['name'] },
  ]), 'edits are staged by section name: a switch, a list, a new option, an emptied option', j(plan));
}
{
  const { d, draft } = fresh();
  const id = E.addItem(draft, 'rules', { ...E.newValues('rules', d), name: 'Allow-SSH', src: 'wan', proto: ['tcp'], dest_port: ['22'], family: 'ipv4' });
  const plan = ops(d, draft);
  const add = plan.find(o => o.op === 'add');
  check(add.id === id && same(add.values, { name: 'Allow-SSH', target: 'ACCEPT', src: 'wan', proto: ['tcp'], dest_port: ['22'], family: 'ipv4' }), 'a new rule is added with its action and what it sets', j(add));
  const o = plan.find(x => x.op === 'order');
  check(o && o.sections.join() === 'cfg01,cfg02,cfg03,cfg04,cfg05,cfg06,wg,cfg07,cfg08,cfg09,new:2,cfg0a,cfg0b'.replace('new:2', id), 'the new rule is put after the last rule, not at the end of the file', o ? o.sections.join() : 'no order');
  const ch = P.changesOf(d, draft);
  check(ch.length === 1 && ch[0].label === 'New rule' && /Allows TCP port 22 from zone wan to the router itself/.test(ch[0].to), 'the review says in words what the new rule does', j(ch));
}
{
  const { d, draft } = fresh();
  E.moveItem(draft, 'rules', 'cfg06', -1);
  check(draft.rules.map(r => r.id).join() === 'cfg06,cfg05,wg,cfg09', 'a rule moves up');
  const plan = ops(d, draft);
  check(plan.length === 1 && plan[0].op === 'order' && plan[0].sections.join() === 'cfg01,cfg02,cfg03,cfg04,cfg06,cfg05,wg,cfg07,cfg08,cfg09,cfg0a,cfg0b', 'only the order is staged, with every section of the file in its place', j(plan));
  check(P.changesOf(d, draft).some(c => c.label === 'Traffic rules: order'), 'the review lists the new order');
  E.moveItem(draft, 'rules', 'cfg06', -1);
  check(draft.rules[0].id === 'cfg06', 'moving the first rule up changes nothing');
  E.moveItem(draft, 'rules', 'cfg06', 1);
  check(!P.isDirty(d, draft), 'moving it back is no change');
  E.removeItem(draft, 'rules', 'cfg05');
  E.moveItem(draft, 'rules', 'wg', -1);
  check(draft.rules.map(r => r.id).join() === 'wg,cfg05,cfg06,cfg09' || draft.rules.map(r => r.id).join() === 'cfg05,wg,cfg06,cfg09', 'a removed rule is skipped when moving', draft.rules.map(r => r.id).join());
}
{
  const { d, draft } = fresh();
  E.removeItem(draft, 'rules', 'wg');
  const plan = ops(d, draft);
  check(j(plan) === j([{ op: 'delete', config: 'firewall', section: 'wg' }]) && P.changesOf(d, draft)[0].label === 'Remove rule "Allow-WireGuard"', 'deleting a rule deletes that section, named or not');
  const { d: d2, draft: draft2 } = fresh();
  E.removeItem(draft2, 'rules', 'cfg09');
  check(P.changesOf(d2, draft2)[0].label === 'Remove rule #4', 'an unnamed rule is called by its place in the list');
  E.addItem(draft, 'rules', { ...E.newValues('rules', d), src: 'wan', target: 'DROP' });
  E.addItem(draft, 'rules', { ...E.newValues('rules', d), src: 'lan', target: 'DROP' });
  const o2 = ops(d, draft).find(x => x.op === 'order');
  check(o2 && o2.sections.indexOf('new:1') < o2.sections.indexOf('cfg0a') && o2.sections.indexOf('new:2') === o2.sections.indexOf('new:1') + 1, 'two new rules keep their order', j(o2));
}
{
  // Rules are the last sections: a new rule needs no order operation.
  const cfg = baseCfg();
  delete cfg.cfg0a; delete cfg.cfg0b;
  const d = E.readFirewall({ ...baseStatus(), redirects: [] }, cfg);
  const draft = E.draftFrom(d);
  E.addItem(draft, 'rules', { ...E.newValues('rules', d), src: 'wan', target: 'DROP' });
  check(!ops(d, draft).some(o => o.op === 'order'), 'a rule added after the last rule of a file that ends with rules needs no order operation');
}
{
  const { d, draft } = fresh();
  const v = draft.rules[0].values;
  v.dest_port = ['70000', '80', '80'];
  v.src_ip = ['10.0.0.1/33'];
  v.icmp_type = ['nonsense'];
  v.limit = 'fast';
  v.start_time = '25:00';
  const errs = V.problems(d, draft).errors.map(e => e.text);
  check(errs.some(t => /70000/.test(t)) && errs.some(t => /listed twice/.test(t)) && errs.some(t => /10\.0\.0\.1\/33/.test(t)) && errs.some(t => /nonsense/.test(t)) && errs.some(t => /fast/.test(t)) && errs.some(t => /25:00/.test(t)), 'bad ports, a repeated port, a bad prefix, an unknown ICMP type, a bad limit and a bad time are all errors', j(errs));
  check(P.changesOf(d, draft).length > 0, 'and they are listed as changes (the form is not hiding them)');
}
{
  const { d, draft } = fresh();
  draft.rules[1].values.proto = ['esp'];
  draft.rules[0].values.src = 'nosuch';
  draft.rules[0].values.family = 'ipv6';
  draft.rules[0].values.src_ip = ['10.0.0.1'];
  const f = V.problems(d, draft);
  check(f.warnings.some(w => /ports/i.test(w) && /ignored/.test(w)), 'ports on a protocol that has none are a warning', j(f.warnings));
  check(f.errors.some(e => /nosuch/.test(e.text)), 'a source zone that does not exist is an error');
  check(f.warnings.some(w => /IPv4 but the address family is IPv6/.test(w)), 'IPv4 addresses with an IPv6-only family are a warning');
  const mark = V.itemProblems('rules', null, { ...E.newValues('rules', d), target: 'MARK', src: 'lan' }, draft, d);
  check(mark.some(p => /needs a mark/.test(p.text)), 'the action MARK needs a mark');
  const notrack = V.itemProblems('rules', null, { ...E.newValues('rules', d), target: 'NOTRACK' }, draft, d);
  check(notrack.some(p => /needs a source zone/.test(p.text)), 'NOTRACK needs a source zone');
}
{
  // Something already wrong in the file is only a warning until the form touches that rule.
  const cfg = baseCfg();
  cfg.cfg09.dest_port = '99999';
  cfg.cfg06.src = 'ghost';
  const d = E.readFirewall(baseStatus(), cfg);
  const draft = E.draftFrom(d);
  const f = V.problems(d, draft);
  check(f.errors.length === 0 && f.warnings.some(w => /99999/.test(w) && /already in the configuration/.test(w)) && f.warnings.some(w => /ghost/.test(w)), 'a problem already in the file is a warning, so other edits can be saved', j(f));
  draft.rules[3].values.name = 'Squid';
  check(V.problems(d, draft).errors.some(e => /99999/.test(e.text)), 'but touching that rule makes it an error');
  const view = W.effectiveView(d, E.draftFrom(d));
  check(view.rules.length === 4, 'the view still lists it');
}
//#endregion

//#region Port forwards
console.log('\n== port forwards ==');
{
  const { d, draft } = fresh();
  const base = E.newValues('redirects', d);
  const ok = V.itemProblems('redirects', null, { ...base, name: 'SSH', src: 'wan', src_dport: '2222', dest: 'lan', dest_ip: '192.168.1.5', dest_port: '22', proto: ['tcp'] }, draft, d);
  check(!ok.some(p => p.level === 'error') && !ok.some(p => p.level === 'warn'), 'a complete port forward has no problem', j(ok));
  const noSrc = V.itemProblems('redirects', null, { ...base, dest_ip: '192.168.1.5' }, draft, d);
  check(noSrc.some(p => /needs a source zone/.test(p.text)), 'a port forward needs a source zone');
  const star = V.itemProblems('redirects', null, { ...base, src: '*', dest_ip: '192.168.1.5' }, draft, d);
  check(star.some(p => /any zone/.test(p.text) && p.level === 'error'), 'and not "any zone"');
  const nothing = V.itemProblems('redirects', null, { ...base, src: 'wan' }, draft, d);
  check(nothing.some(p => /nothing to forward to/.test(p.text)), 'one that forwards to nothing is an error');
  const allPorts = V.itemProblems('redirects', null, { ...base, src: 'wan', dest_ip: '192.168.1.5' }, draft, d);
  check(allPorts.some(p => p.level === 'warn' && /every port/.test(p.text)), 'one without a port to match is a warning: it opens every port');
  const neg = V.itemProblems('redirects', null, { ...base, src: 'wan', dest_ip: '!192.168.1.5', src_dport: '80' }, draft, d);
  check(neg.some(p => /cannot be negated/.test(p.text)), 'the internal address cannot be negated');
  const snat = V.itemProblems('redirects', null, { ...base, target: 'SNAT', src: 'lan' }, draft, d);
  check(snat.some(p => /needs a destination zone/.test(p.text)) && snat.some(p => p.key === 'src_dip' && /is required/.test(p.text)), 'a source NAT needs a destination zone and the address to rewrite to', j(snat));
  const snatOk = V.itemProblems('redirects', null, { ...base, target: 'SNAT', src: 'lan', dest: 'wan', src_dip: '203.0.113.5' }, draft, d);
  check(!snatOk.some(p => p.level === 'error'), 'a complete source NAT is fine', j(snatOk));
  check(E.fieldFor(E.KINDS.redirects.fields.find(f => f.key === 'src_dip'), { target: 'SNAT' }).label === 'Rewrite the source address to', 'a source NAT words its fields differently');
  const refl = V.itemProblems('redirects', null, { ...base, src: 'wan', src_dport: '80', dest_ip: '10.0.0.1', reflection_zone: ['nosuch'] }, draft, d);
  check(refl.some(p => /reflection zone "nosuch"/.test(p.text)), 'a reflection zone that does not exist is an error');
  const plan = (() => { E.addItem(draft, 'redirects', { ...base, name: 'SSH', src: 'wan', src_dport: '2222', dest_ip: '192.168.1.5', dest_port: '22', proto: ['tcp'], reflection: false }); return ops(d, draft); })();
  check(same(plan.find(o => o.op === 'add').values, { name: 'SSH', target: 'DNAT', proto: ['tcp'], src: 'wan', src_dport: '2222', dest_ip: '192.168.1.5', dest_port: '22', reflection: '0' }), 'a new port forward writes its options', j(plan));
  check(D.redirectWords(base).includes('router itself'), 'a forward with no address is described as a redirect to the router itself');
}
//#endregion

//#region Defaults
console.log('\n== global defaults ==');
{
  const { d, draft } = fresh();
  draft.defaults.drop_invalid = true;
  draft.defaults.synflood_protect = false;
  draft.defaults.flow_offloading = true;
  draft.defaults.synflood_rate = '50/second';
  const plan = ops(d, draft);
  check(plan.length === 1 && plan[0].section === 'cfg01' && same(plan[0].values, { drop_invalid: '1', synflood_protect: '0', flow_offloading: '1', synflood_rate: '50/second' }), 'the defaults are one set operation on the defaults section', j(plan));
  draft.defaults.input = '';
  const plan2 = ops(d, draft);
  check(plan2.some(o => o.op === 'delete' && o.options.join() === 'input'), 'an emptied option is deleted');
  const ch = P.changesOf(d, draft);
  check(ch.every(c => c.label.startsWith('Global settings: ')), 'the review names the setting');
  draft.defaults.synflood_protect = true;
  draft.defaults.synflood_rate = '50/fast';
  check(V.problems(d, draft).errors.some(e => /SYN rate/.test(e.text)), 'a bad rate is an error');
  const { d: d2, draft: draft2 } = fresh();
  draft2.defaults.flow_offloading_hw = true;
  check(V.problems(d2, draft2).warnings.some(w => /depends on software/.test(w)), 'hardware offloading without software offloading is a warning');
}
{
  // A router without a defaults section: the first change creates one.
  const cfg = baseCfg();
  delete cfg.cfg01;
  const d = E.readFirewall(baseStatus(), cfg);
  const draft = E.draftFrom(d);
  draft.defaults.drop_invalid = true;
  const plan = ops(d, draft);
  check(plan.length === 1 && plan[0].op === 'add' && plan[0].type === 'defaults' && j(plan[0].values) === j({ drop_invalid: '1' }), 'the defaults section is created with what was set', j(plan));
}
//#endregion

//#region Lock-out
console.log('\n== lock-out ==');
{
  const ctx = { host: '192.168.1.1', port: 443, admin: ['lan'] };
  const { d, draft } = fresh();
  draft.zones[0].values.input = 'REJECT';
  const w = V.lockoutWarnings(d, draft, ctx);
  check(w.length === 2 && /Lock-out risk/.test(w[0]) && /192\.168\.1\.1/.test(w[0]) && /web interface/.test(w[0]) && /SSH/.test(w[1]), 'closing the input of the zone you are in warns, for the web interface and for SSH', j(w));
  draft.rules.push({ id: 'new:9', isNew: true, removed: false, values: { ...E.newValues('rules', d), src: 'lan', proto: ['tcp'], dest_port: ['443'], target: 'ACCEPT' } });
  const w2 = V.lockoutWarnings(d, draft, ctx);
  check(w2.length === 1 && /SSH/.test(w2[0]), 'a rule that accepts HTTPS from that zone makes the web interface safe again', j(w2));
  draft.rules.at(-1).values.dest_port = ['400-500'];
  check(V.lockoutWarnings(d, draft, ctx).length === 1, 'a port range that holds 443 counts');
  draft.rules.at(-1).values.proto = ['udp'];
  check(V.lockoutWarnings(d, draft, ctx).length === 2, 'a UDP rule does not');
  draft.rules.at(-1).values.proto = ['tcp'];
  draft.rules.at(-1).values.dest = 'wan';
  check(V.lockoutWarnings(d, draft, ctx).length === 2, 'and neither does a rule about forwarded traffic');
  const p = V.problems(d, draft, ctx);
  check(p.warnings.filter(x => /Lock-out/.test(x)).length === 2, 'the warnings are part of the problems, as warnings (they do not block Save)', j(p.warnings));
  check(p.errors.length === 0, 'and are not errors');
}
{
  const ctx = { host: 'router.lan', port: 443, admin: [] };
  const { d, draft } = fresh();
  draft.zones[0].values.input = 'DROP';
  const w = V.lockoutWarnings(d, draft, ctx);
  check(w.length === 2 && /Zone lan lets its hosts reach/.test(w[0]), 'when the address is a name the zone is named instead', j(w));
  const { d: d2, draft: draft2 } = fresh();
  E.removeZone(draft2, 'cfg02');
  check(V.lockoutWarnings(d2, draft2, { host: '192.168.1.1', admin: ['lan'] }).some(x => /Lock-out risk/.test(x)), 'removing the zone you are in warns');
  const { d: d3, draft: draft3 } = fresh();
  draft3.zones[0].values.network = ['lan100'];
  check(V.lockoutWarnings(d3, draft3, { host: '192.168.1.1', admin: ['lan'] }).some(x => /interface lan/.test(x)), 'so does taking your interface out of a zone');
  const { d: d4, draft: draft4 } = fresh();
  draft4.defaults.input = 'DROP';
  draft4.zones[2].values.input = '';
  check(V.lockoutWarnings(d4, draft4, { host: 'x', admin: [] }).some(x => /Zone vpn/.test(x)), 'a zone with no policy of its own follows the global default');
  const { d: d5, draft: draft5 } = fresh();
  draft5.zones[1].values.input = 'DROP';
  check(V.lockoutWarnings(d5, draft5, ctx).length === 0, 'closing a zone that did not accept anyway is no risk');
}
//#endregion

//#region The check after a save
console.log('\n== the check after a save ==');
{
  const { d, draft } = fresh();
  draft.zones[1].values.input = 'DROP';
  E.addItem(draft, 'rules', { ...E.newValues('rules', d), name: 'New', src: 'wan', proto: ['tcp'], dest_port: ['22'] });
  E.removeItem(draft, 'rules', 'cfg06');
  const cfg = baseCfg();
  cfg.cfg03.input = 'DROP';
  delete cfg.cfg06;
  cfg.cfg0z = { '.anonymous': true, '.type': 'rule', '.name': 'cfg0z', '.index': 9.5, name: 'New', src: 'wan', proto: ['tcp'], dest_port: ['22'], target: 'ACCEPT' };
  const after = E.readFirewall(baseStatus(), cfg);
  let threw = null;
  try { P.checkApplied(d, draft, after); } catch (e) { threw = e; }
  check(!threw, 'a config that holds the draft passes (a new section is matched by its place, not its name)', threw?.message);
  const lost = clone(cfg);
  lost.cfg03.input = 'REJECT';
  try { P.checkApplied(d, draft, E.readFirewall(baseStatus(), lost)); threw = null; } catch (e) { threw = e; }
  check(threw && /Zone wan: Input policy/.test(threw.message), 'a change the router did not keep is named', threw?.message);
  const missing = clone(cfg);
  delete missing.cfg0z;
  try { P.checkApplied(d, draft, E.readFirewall(baseStatus(), missing)); threw = null; } catch (e) { threw = e; }
  check(threw && /number of rules/.test(threw.message), 'a missing section is noticed', threw?.message);
  const reordered = clone(cfg);
  reordered.cfg0z['.index'] = 0.5;
  try { P.checkApplied(d, draft, E.readFirewall(baseStatus(), reordered)); threw = null; } catch (e) { threw = e; }
  check(threw, 'a new section in the wrong place is noticed', threw?.message);
  const st = baseStatus();
  st.running = false;
  try { P.checkApplied(d, draft, E.readFirewall(st, cfg)); threw = null; } catch (e) { threw = e; }
  check(threw && /no longer loaded/.test(threw.message), 'a firewall that stopped loading is an error (the change is rolled back)', threw?.message);
  const stale = baseStatus();
  try { P.checkApplied(d, draft, E.readFirewall(stale, (() => { const c = clone(cfg); c.cfg0y = { '.anonymous': true, '.type': 'zone', '.name': 'cfg0y', '.index': 20, name: 'dmz', network: ['voip'] }; return c; })())); threw = null; } catch (e) { threw = e; }
  check(threw && /not keep|number of zones/.test(threw.message), 'an extra zone that nobody asked for is noticed', threw?.message);
  // A zone that is added but not loaded by the firewall.
  const { d: d2, draft: draft2 } = fresh();
  E.commitItem(draft2, 'zones', null, { ...E.newValues('zones', d2), name: 'dmz', network: ['voip'] });
  const cfg2 = baseCfg();
  cfg2.cfg0y = { '.anonymous': true, '.type': 'zone', '.name': 'cfg0y', '.index': 20, name: 'dmz', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', network: ['voip'] };
  try { P.checkApplied(d2, draft2, E.readFirewall(baseStatus(), cfg2)); threw = null; } catch (e) { threw = e; }
  check(threw && /no rules for zone dmz/.test(threw.message), 'a zone that the firewall did not load is an error', threw?.message);
  const st2 = baseStatus();
  st2.loaded_zones.push('dmz');
  try { P.checkApplied(d2, draft2, E.readFirewall(st2, cfg2)); threw = null; } catch (e) { threw = e; }
  check(!threw, 'and fine once it is loaded', threw?.message);
  const off = { ...baseStatus(), running: false };
  const dOff = E.readFirewall(off, baseCfg());
  try { P.checkApplied(dOff, E.draftFrom(dOff), E.readFirewall(off, baseCfg())); threw = null; } catch (e) { threw = e; }
  check(!threw, 'a firewall that was not running before is not blamed');
}
//#endregion

//#region Staging
console.log('\n== staging ==');
{
  const { d, draft } = fresh();
  E.addItem(draft, 'rules', { ...E.newValues('rules', d), name: 'A', src: 'wan', target: 'DROP' });
  E.removeItem(draft, 'rules', 'cfg05');
  const calls = [];
  // A fake uci API that records every call; `add` answers with a name the router chose.
  const ed = { set: async (...a) => calls.push(['set', ...a]), add: async (...a) => { calls.push(['add', ...a]); return 'cfgnew1'; }, delete: async (...a) => calls.push(['delete', ...a]), order: async (...a) => calls.push(['order', ...a]) };
  await stageOps(ed, P.plan(d, draft));
  const order = calls.find(c => c[0] === 'order');
  check(order && order[2].includes('cfgnew1') && !order[2].includes('new:1') && !order[2].includes('cfg05'), 'the order operation uses the name the router gave the new section, and leaves out the removed one', j(calls));
  const seen = [];
  const uci = createUci(async (obj, method, args) => { seen.push([obj, method, args]); return {}; });
  await uci.order('firewall', ['a', 'b']);
  check(j(seen) === j([['uci', 'order', { config: 'firewall', sections: ['a', 'b'] }]]), 'the uci wrapper calls rpcd\'s order method', j(seen));
}
//#endregion

//#region The view
console.log('\n== the view ==');
{
  const { d, draft } = fresh();
  check(W.consistent(d), 'the plugin\'s reply and the config agree');
  const st = baseStatus();
  st.rules.pop();
  check(!W.consistent(E.readFirewall(st, baseCfg())), 'a reply with another set of rules is not used to join');
  const off = baseStatus();
  off.rules[0].enabled = false;
  check(!W.consistent(E.readFirewall(off, baseCfg())), 'nor is a reply in which a rule has another enabled state than the config');
  const moved = baseStatus();
  moved.zones[0].networks = ['lan'];
  check(!W.consistent(E.readFirewall(moved, baseCfg())), 'nor one in which a zone holds other interfaces');
  const v = W.effectiveView(d, draft);
  check(v.zones.length === 3 && v.rules.length === 4 && v.redirects.length === 1 && v.rows.rules.length === 4, 'the view has every zone, rule and port forward');
  check(v.rules[0].hits.packets === 3 && v.rules[0].key === 'Allow-Ping' && v.redirects[0].hits.packets === 1, 'counters are joined by section name');
  check(v.zones[1].devices.join() === 'wan' && v.zones[1].blocked_from.packets === 5, 'a zone keeps its loaded devices and counters');
  check(v.unzoned.join() === 'guest,voip', 'interfaces in no zone are found from the router\'s interfaces (not loopback)', v.unzoned.join());
  draft.rules[0].values.dest_port = ['1'];
  draft.zones[1].values.input = 'ACCEPT';
  const w = W.effectiveView(d, draft);
  check(w.rules[0].pending === 'edited' && w.rules[0].hits === null && w.zones[1].pending === 'edited' && w.zones[1].devices.length === 0, 'an edited item shows no counters (they are about the old rule)');
  check(w.zones[1].input === 'ACCEPT' && w.rules[1].pending === null, 'the view shows the draft\'s values');
  E.removeItem(draft, 'rules', 'wg');
  const x = W.effectiveView(d, draft);
  check(x.rules.length === 3 && x.rows.rules.length === 4 && x.rows.rules[2].removed, 'a removed rule is out of the list the matrix reads but still a row');
  const f = W.forwardingRows(d, draft);
  check(f.length === 2 && f.every(r => r.plain), 'the forwardings the matrix can show are marked');
}
//#endregion

//#region Checks and words
console.log('\n== value checks ==');
{
  const ok = (fn, ...vals) => vals.every(v => fn(v) === null);
  const bad = (fn, ...vals) => vals.every(v => fn(v) !== null);
  check(ok(C.portError, '22', '6666-6670', '6666:6670', '!80', '65535') && bad(C.portError, '0x50', '70000', '90-80', 'http', '1-', ''), 'ports and ranges');
  const net = { networks: ['lan'] };
  check(ok(v => C.subnetError(v, net), '192.168.1.1', '192.168.1.0/24', '10.0.0.0/255.0.0.0', '2001:db8::/32', 'fe80::1', '!10.0.0.0/8', '192.168.1.10-192.168.1.20', 'lan') && bad(v => C.subnetError(v, net), '300.1.1.1', '10.0.0.0/33', '2001:db8::/129', '10.0.0.1-2001:db8::1', 'nosuch', '10.0.0.1/', '1.2.3'), 'addresses, subnets, ranges and interface names');
  check(ok(C.limitError, '3', '3/second', '3/min', '10/hour', '5/d') && bad(C.limitError, 'fast', '3/week', '/min', '3/'), 'rate limits');
  check(ok(C.timeError, '8', '08:30', '23:59:59') && bad(C.timeError, '24:00', '12:60', '12:30:61', 'noon'), 'times');
  check(ok(C.dateError, '2026-12-31', '2026', '2030-1-5') && bad(C.dateError, '1969-01-01', '2026-13-01', '2026-01-32', 'today'), 'dates');
  check(ok(C.markError, '0x10', '0x10/0xff', '16') && bad(C.markError, 'zz', '0x1ffffffff', 'ff'), 'marks');
  check(ok(C.icmpError, 'echo-request', 'destination-unreachable', '3', '3/1', 'packet-too-big') && bad(C.icmpError, 'ping-me', '300', '3/256'), 'ICMP types');
  check(ok(C.protocolError, 'tcp', 'esp', '47', 'ipv6-icmp') && bad(C.protocolError, '256', 'a b', ''), 'protocols');
  check(ok(C.weekdaysError, 'mon tue', '! sat sun', 'Monday') && bad(C.weekdaysError, 'funday', ''), 'weekdays');
  check(ok(C.CHECKS.mac, '00:11:22:33:44:55', '0:1:2:3:4:5', '!aa-bb-cc-dd-ee-ff') && bad(C.CHECKS.mac, '00:11:22', 'gg:11:22:33:44:55'), 'MAC addresses');
  check(ok(C.CHECKS.zoneName, 'lan', 'vpn_2', 'a.b-c/d') && bad(C.CHECKS.zoneName, '1lan', 'my zone', 'a$'), 'zone names');
  check(C.subnetFamily('!10.0.0.0/8') === 4 && C.subnetFamily('2001:db8::1') === 6 && C.subnetFamily('lan') === null, 'the family of an address');
}
console.log('\n== words ==');
{
  const rule = (o = {}) => ({ ...E.formValues(E.KINDS.rules.fields, {}), target: 'ACCEPT', ...o });
  check(D.ruleWords(rule({ src: 'wan', proto: ['tcp'], dest_port: ['22'] })) === 'Allows TCP port 22 from zone wan to the router itself.', D.ruleWords(rule({ src: 'wan', proto: ['tcp'], dest_port: ['22'] })));
  check(D.ruleWords(rule({ src: 'lan', dest: 'wan', target: 'REJECT', src_ip: ['192.168.1.5'], proto: ['tcp', 'udp'], dest_port: ['80', '443'] })) === 'Rejects TCP and UDP ports 80 and 443 from zone lan to zone wan (forwarded through the router), from 192.168.1.5.', D.ruleWords(rule({ src: 'lan', dest: 'wan', target: 'REJECT', src_ip: ['192.168.1.5'], proto: ['tcp', 'udp'], dest_port: ['80', '443'] })));
  check(/^Silently drops TCP and UDP traffic from the router itself to zone wan, IPv6 only\.$/.test(D.ruleWords(rule({ dest: 'wan', target: 'DROP', family: 'ipv6' }))), 'an output rule and the family');
  check(D.ruleWords(rule({ src: '*', dest: 'lan', proto: ['icmp'], icmp_type: ['echo-request', 'echo-reply'] })) === 'Allows ICMP echo-request and echo-reply from any zone to zone lan (forwarded through the router).', 'ICMP types');
  check(D.ruleWords(rule({ src: 'lan', limit: '3/min', weekdays: 'mon tue', start_time: '08:00', stop_time: '17:00' })) === 'Allows TCP and UDP traffic from zone lan to the router itself, at most 3/min, on mon and tue, from 08:00 until 17:00.', 'a limit and a schedule');
  check(/every day except sat and sun/.test(D.ruleWords(rule({ src: 'lan', weekdays: '! sat sun' }))), 'an inverted list of weekdays');
  check(/\(the rule is disabled\)/.test(D.ruleWords(rule({ enabled: false, src: 'lan' }))), 'a disabled rule says so');
  const rd = (o = {}) => ({ ...E.formValues(E.KINDS.redirects.fields, {}), ...o });
  check(D.redirectWords(rd({ src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10', dest_port: '80', proto: ['tcp'] })).startsWith('Forwards TCP port 8080 arriving from zone wan to 192.168.1.10 port 80 in zone lan.'), D.redirectWords(rd({ src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10', dest_port: '80', proto: ['tcp'] })));
  check(/^Rewrites the source address of TCP and UDP traffic in zone lan leaving through zone wan to 203\.0\.113\.5\./.test(D.redirectWords(rd({ target: 'SNAT', src: 'lan', dest: 'wan', src_dip: '203.0.113.5' }))), 'a source NAT');
  check(D.forwardingWords({ src: 'lan', dest: 'wan', family: '' }) === 'Lets zone lan send traffic to zone wan', 'a forwarding');
  check(D.andList(['a']) === 'a' && D.andList(['a', 'b', 'c']) === 'a, b and c', 'lists of words');
}
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall firewall editing model checks passed');
process.exit(failed ? 1 : 0);
