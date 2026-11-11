// Unit test for the System settings model (www/js/pages/settings/{schema,model}.js) and its zone table. Pure
// functions: no router and no browser. Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const page = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/settings', f)).href);
const m = await page('model.js');
const { FIELDS, GROUPS } = await page('schema.js');
const { ZONES } = await page('zones.js');

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// A `uci get system` reply for a router like the real one; `system` and `ntp` override or add options (undefined removes one).
const cfg = (system = {}, ntp = {}) => ({
  cfg0: { '.anonymous': true, '.type': 'system', '.name': 'cfg0', hostname: 'openwrt', timezone: 'CET-1CEST,M3.5.0,M10.5.0/3', zonename: 'Europe/Rome', ttylogin: '0', log_size: '512', ...system },
  ntp: { '.anonymous': false, '.type': 'timeserver', '.name': 'ntp', use_dhcp: '0', server: ['time.ien.it', 'pool.ntp.org'], ...ntp },
});
const data = (...a) => m.readSettings(cfg(...a));
const draftOf = (d, edit) => { const dr = m.draftFrom(d); edit?.(dr); return dr; };
const keys = (d, dr) => m.changesOf(d, dr).map(c => c.key).join();

console.log('== the schema ==');
check(new Set(FIELDS.map(f => f.key)).size === FIELDS.length, 'every option appears once');
check(FIELDS.every(f => GROUPS.some(g => g.id === f.group) && ['system', 'ntp'].includes(f.section) && ['string', 'text', 'bool', 'int', 'enum', 'list'].includes(f.type) && f.label), 'every field has a card, a section, a known type and a label');
check(FIELDS.filter(f => f.type === 'enum').every(f => f.options.length > 1 && f.options.includes(f.default)) && FIELDS.filter(f => f.type === 'bool').every(f => typeof f.default === 'boolean'), 'enums list their default, switches have a boolean default');
check(FIELDS.every(f => !f.check || ['label', 'host', 'ip', 'path', 'seed', 'ifname'].includes(f.check)) && FIELDS.filter(f => f.type === 'int').every(f => f.min != null && (f.max == null || f.max >= f.min)), 'checks and integer bounds are sane');
const documented = ['hostname', 'description', 'notes', 'buffersize', 'conloglevel', 'cronloglevel', 'log_buffer_size', 'log_file', 'log_hostname', 'log_ip', 'log_port', 'log_prefix', 'log_proto', 'log_remote', 'log_size', 'log_trailer_null', 'log_type', 'ttylogin', 'urandom_seed', 'zram_comp_algo', 'zram_size_mb', 'enabled', 'enable_server', 'server', 'interface', 'use_dhcp', 'dhcp_interface'];
check(documented.every(k => FIELDS.some(f => f.key === k)) && FIELDS.length === documented.length, 'every option of the OpenWrt wiki pages is covered (the zone is separate)', documented.filter(k => !FIELDS.some(f => f.key === k)).join());

console.log('== the zone table ==');
check(Object.keys(ZONES).length > 350 && ZONES['Europe/Rome'] === 'CET-1CEST,M3.5.0,M10.5.0/3' && ZONES['Europe/London'] === 'GMT0BST,M3.5.0/1,M10.5.0' && ZONES.UTC === 'UTC0', 'Rome, London and UTC carry their POSIX rules');
check(Object.entries(ZONES).every(([, r]) => m.validRule(r)), 'every rule in the table passes the rule check', Object.entries(ZONES).filter(([, r]) => !m.validRule(r)).map(e => e.join('=')).join(' '));
check(!['', 'garbage', 'CET', 'CET-1CEST,M3.5.0', '12', 'a b-1'].some(m.validRule), 'typos in a hand-written rule are refused');
const groups = m.zoneGroups();
check(groups.some(([r, names]) => r === 'Europe' && names.includes('Europe/Rome')) && groups.some(([r]) => r === 'UTC') && groups.reduce((n, [, l]) => n + l.length, 0) === Object.keys(ZONES).length, 'the drop-down groups every zone once, by region');

console.log('== reading ==');
let d = data();
check(d.system.section === 'cfg0' && d.ntp.section === 'ntp' && d.system.values.hostname === 'openwrt' && !('.type' in d.system.values), 'both sections are found and their bookkeeping keys dropped', j(d.system));
check(d.clock === null && d.ntpd === null, 'without the clock and the service reply both are null');
const full = m.readSettings(cfg(), { unixtime: 1000, localtime: 4600 }, { sysntpd: { instances: { instance1: { running: true, command: ['/usr/sbin/ntpd', '-n', '-p', 'a.example', '-p', 'b.example'] } } } });
check(full.clock.offset === 3600 && full.ntpd.running && j(full.ntpd.servers) === '["a.example","b.example"]', 'the clock offset and the servers on ntpd\'s command line', j([full.clock, full.ntpd]));
check(m.readSettings(cfg(), null, {}).ntpd.running === false, 'a stopped or missing sysntpd is not running');
check(m.readSettings({}).system.section === null && m.readSettings({ x: { '.type': 'rpcd' } }).ntp.section === null, 'a config without the sections reports none');
const byName = f => FIELDS.find(x => x.key === f);
check(m.currentValue(byName('enabled'), d) === true && m.currentValue(byName('use_dhcp'), d) === false && m.currentValue(byName('enable_server'), d) === false, 'absent switches take OpenWrt\'s defaults, 0 is off');
check(m.currentValue(byName('ttylogin'), data({ ttylogin: 'off' })) === false && m.currentValue(byName('ttylogin'), data({ ttylogin: 'yes' })) === true, 'switches in other spellings');
check(j(m.currentValue(byName('server'), data({}, { server: 'a.example b.example' }))) === '["a.example","b.example"]' && m.currentValue(byName('dhcp_interface'), d).length === 0, 'a space-separated single value is a list, absent is empty');
check(m.currentValue(byName('log_size'), d) === '512' && m.currentValue(byName('log_port'), d) === '', 'numbers are strings, absent is empty');

console.log('== no edit, no change ==');
check(m.changesOf(d, m.draftFrom(d)).length === 0 && !m.isDirty(d, m.draftFrom(d)) && m.plan(d, m.draftFrom(d)).length === 0, 'an untouched form has no changes and writes nothing');
d = data();
check(m.isDirty(d, draftOf(d, x => x.values.server.push(''))) && m.plan(d, draftOf(d, x => x.values.server.push(''))).length === 0, 'a blank list row is dirty (it can be discarded) but writes nothing');
check(m.changesOf(d, draftOf(d, x => { x.values.hostname = '  openwrt '; })).length === 0, 'surrounding spaces are not a change');
const odd = data({ zonename: 'Nowhere/Land', timezone: 'XYZ-3' });
check(m.draftFrom(odd).zone.name === '' && m.draftFrom(odd).zone.rule === 'XYZ-3' && m.changesOf(odd, m.draftFrom(odd)).length === 0, 'a zone name the table does not know is shown as a custom rule and left alone');

console.log('== validation ==');
const errs = (edit, base = data()) => m.problems(base, draftOf(base, edit)).errors;
check(errs(x => { x.values.hostname = 'my.router'; }).length === 1 && errs(x => { x.values.hostname = 'my-router1'; }).length === 0 && errs(x => { x.values.hostname = ''; }).length === 0, 'a hostname is one label (dots refused); empty means default');
check(errs(x => { x.values.log_port = '70000'; }).length === 1 && errs(x => { x.values.log_port = '0'; }).length === 1 && errs(x => { x.values.log_port = '5x'; }).length === 1 && errs(x => { x.values.log_port = '514'; }).length === 0, 'a port is 1 to 65535');
check(errs(x => { x.values.conloglevel = '9'; }).length === 1 && errs(x => { x.values.conloglevel = '3'; }).length === 0 && errs(x => { x.values.zram_size_mb = '0'; }).length === 1, 'bounds of the other numbers');
check(errs(x => { x.values.log_ip = '999.1.1.1'; }).length === 1 && errs(x => { x.values.log_ip = '10.0.0.5'; }).length === 0 && errs(x => { x.values.log_ip = '2001:db8::5'; }).length === 0 && errs(x => { x.values.log_ip = 'syslog.lan'; }).length === 1, 'the syslog server is an IP address');
check(errs(x => { x.values.log_file = 'messages'; }).length === 1 && errs(x => { x.values.log_file = '/var/log/messages'; }).length === 0 && errs(x => { x.values.urandom_seed = '/etc/urandom.seed'; }).length === 0 && errs(x => { x.values.urandom_seed = '1'; }).length === 1, 'paths are absolute; the seed may also be 0');
check(errs(x => { x.values.log_proto = 'sctp'; }).length === 1 && errs(x => { x.values.log_proto = 'tcp'; }).length === 0, 'an enum accepts only its values');
check(errs(x => { x.values.description = 'two\nlines'; }).length === 1 && errs(x => { x.values.notes = 'two\nlines'; }).length === 0, 'a description is one line, notes may have several');
check(errs(x => { x.values.interface = 'lan wan'; }).length === 1 && errs(x => { x.values.dhcp_interface = ['wan', 'bad name']; }).length === 1 && errs(x => { x.values.dhcp_interface = ['wan', 'wan6']; }).length === 0, 'interface names');
let e = errs(x => { x.values.server = ['ok.example', 'bad host', 'OK.example', ' ']; });
check(e.length === 2 && e[0].key === 'server' && e[0].index === 1 && /bad host/.test(e[0].text) && e[1].index === 2 && /listed twice/.test(e[1].text), 'a list marks the row of an invalid host and of a duplicate (any case); blank rows are ignored', j(e));
e = errs(x => { x.zone.name = ''; x.zone.rule = 'nonsense'; });
check(e.length === 1 && e[0].key === 'zone', 'a custom rule that is not a rule is an error on the zone');
check(errs(x => { x.zone.name = ''; x.zone.rule = ''; }).length === 1 && errs(x => { x.zone.name = ''; x.zone.rule = 'EST5EDT,M3.2.0,M11.1.0'; }).length === 0, 'an empty custom rule is an error, a good one is not');
check(errs(x => { x.values.hostname = 'bad.name'; }, odd).length === 1 && errs(() => {}, odd).length === 0, 'a router with an unknown zone name or a hand-written rule is not flagged until the zone is touched');
const warn = (edit, base = data()) => m.problems(base, draftOf(base, edit)).warnings;
check(warn(x => { x.values.server = []; }).length === 1 && /DHCP/.test(warn(x => { x.values.server = []; x.values.use_dhcp = true; })[0]) && warn(x => { x.values.server = []; x.values.enabled = false; }).length === 0, 'NTP on with no servers warns (with or without DHCP); off needs none');
check(warn(x => { x.values.log_type = 'file'; }).length === 1 && warn(x => { x.values.log_type = 'file'; x.values.log_file = '/var/log/m'; }).length === 0, 'file storage without a file warns');
check(warn(x => { x.values.log_remote = false; }).length === 0 && warn(x => { x.values.log_remote = true; }).length === 0 && warn(x => { x.values.log_remote = true; x.values.log_ip = ''; }, data({ log_remote: '0' })).length === 1, 'remote logging switched on without a server warns only when the switch is what changed');

console.log('== the UCI operations ==');
d = data();
let ops = m.plan(d, draftOf(d, x => { x.values.hostname = 'router'; x.values.description = 'lab'; x.values.ttylogin = true; }));
check(j(ops) === j([{ op: 'set', config: 'system', section: 'cfg0', values: { hostname: 'router', description: 'lab', ttylogin: '1' } }]), 'strings are set, switches written as 0/1, all in one set on the section the router reported', j(ops));
ops = m.plan(d, draftOf(d, x => { x.values.log_size = ''; x.values.zonename = undefined; }));
check(j(ops) === j([{ op: 'delete', config: 'system', section: 'cfg0', options: ['log_size'] }]), 'an emptied option is deleted, not set to an empty string', j(ops));
ops = m.plan(d, draftOf(d, x => { x.values.description = ''; }));
check(ops.length === 0, 'emptying an option that is not set writes nothing');
ops = m.plan(d, draftOf(d, x => { x.values.server = ['a.example']; x.values.enabled = false; }));
check(j(ops) === j([{ op: 'set', config: 'system', section: 'ntp', values: { enabled: '0', server: ['a.example'] } }]), 'NTP options go to the timeserver section, a list as an array', j(ops));
ops = m.plan(d, draftOf(d, x => { x.values.server = []; }));
check(j(ops) === j([{ op: 'delete', config: 'system', section: 'ntp', options: ['server'] }]), 'an empty list deletes the option');
ops = m.plan(d, draftOf(d, x => { x.values.server = ['pool.ntp.org', 'time.ien.it']; }));
check(ops.length === 1 && m.changesOf(d, draftOf(d, x => { x.values.server = ['pool.ntp.org', 'time.ien.it']; }))[0].key === 'server', 'a different order is a change');
ops = m.plan(d, draftOf(d, x => { x.zone.name = 'Europe/London'; }));
check(j(ops) === j([{ op: 'set', config: 'system', section: 'cfg0', values: { timezone: 'GMT0BST,M3.5.0/1,M10.5.0', zonename: 'Europe/London' } }]), 'a new zone sets timezone and zonename together', j(ops));
ops = m.plan(d, draftOf(d, x => { x.zone.name = ''; x.zone.rule = 'EST5EDT,M3.2.0,M11.1.0'; }));
check(j(ops) === j([{ op: 'set', config: 'system', section: 'cfg0', values: { timezone: 'EST5EDT,M3.2.0,M11.1.0' } }, { op: 'delete', config: 'system', section: 'cfg0', options: ['zonename'] }]), 'a custom rule sets the rule and drops the zone name', j(ops));
ops = m.plan(odd, draftOf(odd, x => { x.zone.rule = 'EST5EDT,M3.2.0,M11.1.0'; }));
check(j(ops) === j([{ op: 'set', config: 'system', section: 'cfg0', values: { timezone: 'EST5EDT,M3.2.0,M11.1.0' } }, { op: 'delete', config: 'system', section: 'cfg0', options: ['zonename'] }]), 'editing a hand-written rule keeps it custom');
ops = m.plan(d, draftOf(d, x => { x.zone.name = 'Asia/Tokyo'; x.values.hostname = 'r'; x.values.enabled = false; }));
check(ops.length === 2 && ops[0].section === 'cfg0' && ops[0].values.hostname === 'r' && ops[0].values.zonename === 'Asia/Tokyo' && ops[1].section === 'ntp', 'one set per section, however many options changed');
const noNtp = m.readSettings({ cfg0: cfg().cfg0 });
ops = m.plan(noNtp, draftOf(noNtp, x => { x.values.server = ['pool.ntp.org']; x.values.use_dhcp = false; }));
check(j(ops) === j([{ op: 'add', config: 'system', type: 'timeserver', name: 'ntp', values: { use_dhcp: '0', server: ['pool.ntp.org'] } }]), 'a missing timeserver section is created, named ntp', j(ops));
check(m.plan(noNtp, draftOf(noNtp, x => { x.values.server = []; })).length === 0, 'and nothing is written when there is nothing to delete');
const noSys = m.readSettings({});
ops = m.plan(noSys, draftOf(noSys, x => { x.values.hostname = 'r'; }));
check(j(ops) === j([{ op: 'add', config: 'system', type: 'system', values: { hostname: 'r' } }]), 'a missing system section is created');

console.log('== staging through a uci API ==');
const calls = [];
const ed = { set: async (...a) => calls.push(['set', ...a]), add: async (...a) => calls.push(['add', ...a]), delete: async (...a) => calls.push(['delete', ...a]) };
await m.stage(ed, m.plan(d, draftOf(d, x => { x.values.hostname = 'r'; x.values.server = []; })));
check(j(calls) === j([['set', 'system', 'cfg0', { hostname: 'r' }], ['delete', 'system', 'ntp', ['server']]]), 'each operation becomes one uci call', j(calls));

console.log('== reading back after apply ==');
const want = draftOf(d, x => { x.zone.name = 'Europe/London'; x.values.hostname = 'r'; x.values.server = ['x.example']; });
const saved = data({ zonename: 'Europe/London', timezone: 'GMT0BST,M3.5.0/1,M10.5.0', hostname: 'r' }, { server: ['x.example'] });
const verdict = (after, draft = want) => { try { m.checkApplied(d, after, draft); return null; } catch (err) { return err.message; } };
check(verdict(saved) === null, 'matching data passes');
check(/Time zone/.test(verdict(data({ hostname: 'r' }, { server: ['x.example'] }))), 'a zone that did not stick is reported by name');
check(/Hostname, Time servers/.test(verdict(data({ zonename: 'Europe/London', timezone: 'GMT0BST,M3.5.0/1,M10.5.0' }))) && /were not saved/.test(verdict(data({ zonename: 'Europe/London', timezone: 'GMT0BST,M3.5.0/1,M10.5.0' }))), 'several options that did not stick are all named');
check(/rule/.test(verdict(data({ zonename: 'Europe/London', timezone: 'CET-1CEST', hostname: 'r' }, { server: ['x.example'] }))), 'a zone name saved with the wrong rule is reported');
check(m.checkApplied(d, d, m.draftFrom(d)) === undefined, 'an untouched draft always verifies, even for a router whose rule differs from its zone name');

console.log('== formatting ==');
check(m.fmtOffset(3600) === 'UTC+01:00' && m.fmtOffset(-18000) === 'UTC-05:00' && m.fmtOffset(19800) === 'UTC+05:30' && m.fmtOffset(0) === 'UTC+00:00', 'offsets as UTC±hh:mm');
check(m.fmtLocal(1794401624) === '2026-11-11 12:53:44' && m.fmtDate(1794401624) === '2026-11-11' && m.fmtTime(1794401624) === '12:53:44', 'local seconds as a date and a time, without a browser time zone shift', m.fmtLocal(1794401624));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall model checks passed');
process.exit(failed ? 1 : 0);
