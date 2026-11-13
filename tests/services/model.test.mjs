// Unit test for the Services page model (www/js/pages/services/model.js): merging the init scripts with procd's
// list, the actions a row offers, the confirmations, the filter, the summary and the outcome texts. Pure
// functions: no router and no browser. Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/services/model.js')).href);

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// A `flab.services list` reply and a `service list` reply shaped like the router's.
const list = { services: [
  { name: 'boot', enabled: true, start: 10, protected: true },
  { name: 'dnsmasq', enabled: true, start: 19, protected: false },
  { name: 'firewall', enabled: true, start: 19, protected: false },
  { name: 'acme', enabled: false, start: null, protected: false },
  { name: 'rpcd', enabled: true, start: 12, protected: false },
] };
const svc = {
  dnsmasq: { instances: { cfg01: { running: true, pid: 1234 }, cfg02: { running: true, pid: 1240 } } },
  rpcd: { instances: { instance1: { running: true, pid: 10 } } },
  acme: {},
  ubus: { instances: { instance1: { running: true, pid: 5 } } },
  half: { instances: { a: { running: true, pid: 7 }, b: { running: false } } },
};

console.log('== reading procd ==');
const procd = m.readProcd(svc);
check(procd.dnsmasq.running && j(procd.dnsmasq.pids) === '[1234,1240]', 'a service whose instances all run is running, with every pid', j(procd.dnsmasq));
check(!procd.acme.running && procd.acme.pids.length === 0, 'a procd entry without instances is not running');
check(!procd.half.running && j(procd.half.pids) === '[7]', 'one stopped instance makes the service not running; its pid is still listed', j(procd.half));
check(j(m.readProcd(null)) === '{}' && j(m.readProcd({ x: null })) === '{"x":{"running":false,"pids":[]}}', 'a missing or empty reply does not fail');

console.log('\n== rows ==');
const rows = m.buildRows(list, procd);
// The row of service `n`.
const by = n => rows.find(r => r.name === n);
check(rows.map(r => r.name).join() === 'acme,boot,dnsmasq,firewall,half,rpcd,ubus', 'init scripts and procd-only services, sorted by name', rows.map(r => r.name).join());
check(by('dnsmasq').state === 'running' && by('dnsmasq').enabled && by('dnsmasq').start === 19 && by('dnsmasq').controllable, 'a running, enabled script is controllable');
check(by('acme').state === 'idle' && by('acme').enabled === false && by('acme').start === null, 'idle: known to procd, nothing running; disabled at boot');
check(by('firewall').state === 'none' && by('firewall').controllable, 'a script procd does not list shows no instance and can still be controlled');
check(by('boot').protected && !by('boot').controllable, 'a boot-sequence script is not controllable');
check(!by('ubus').installed && !by('ubus').controllable && by('ubus').enabled === null && by('ubus').state === 'running', 'a procd service without an init script is shown but cannot be controlled');
const noPlugin = m.buildRows(null, procd);
check(noPlugin.length === 5 && noPlugin.every(r => !r.controllable), 'without the plugin only procd\'s services are shown, none controllable');
check(m.buildRows({ services: [] }, null).length === 0, 'nothing at all gives no rows');

console.log('\n== listening ports ==');
const socks = [
  { proto: 'udp', address: '0.0.0.0', port: 53, pid: 1234 }, { proto: 'tcp', address: '::', port: 53, pid: 1234 }, { proto: 'tcp', address: '0.0.0.0', port: 53, pid: 1234 },
  { proto: 'tcp', address: '127.0.0.1', port: 8953, pid: 1240 }, { proto: 'tcp', address: '::1', port: 8953, pid: 1240 },
  { proto: 'tcp', address: '192.168.1.1', port: 3493, pid: 7 }, { proto: 'tcp', address: '127.0.0.1', port: 3493, pid: 7 },
  { proto: 'tcp', address: '0.0.0.0', port: 22, pid: 999 },
];
const ports = m.portsOf(socks, [1234, 1240]);
check(j(ports.map(p => `${p.proto}/${p.port}`)) === '["tcp/53","tcp/8953","udp/53"]', 'the ports of a service\'s pids, one entry per protocol and port, TCP first and by port; a socket of another pid is left out', j(ports));
check(j(ports[0].addresses) === '["::","0.0.0.0"]' && ports[0].scope === 'all' && ports[1].scope === 'local' && j(ports[1].addresses) === '["127.0.0.1","::1"]', 'a wildcard address means every address; loopback addresses alone mean loopback only');
check(m.portsOf(socks, [7])[0].scope === 'some' && m.portsOf(socks, []).length === 0 && m.portsOf(null, [1]).length === 0 && m.portsOf(undefined, []).length === 0, 'a specific address is neither; no pids or no sockets give no ports');
const withPorts = m.buildRows({ services: list.services, listening: socks }, procd);
check(withPorts.find(r => r.name === 'dnsmasq').ports.length === 3 && withPorts.find(r => r.name === 'acme').ports.length === 0 && m.buildRows(list, procd).every(r => r.ports.length === 0), 'rows carry the ports of their pids; a list without sockets gives none');

console.log('\n== filter and summary ==');
check(m.filterRows(rows, 'DNS').map(r => r.name).join() === 'dnsmasq', 'the filter is case-insensitive and matches part of a name');
check(m.filterRows(rows, ' r  d').map(r => r.name).join() === 'rpcd', 'every word must match', m.filterRows(rows, ' r  d').map(r => r.name).join());
check(m.filterRows(rows, '').length === rows.length && m.filterRows(rows, undefined).length === rows.length, 'an empty filter keeps everything');
const sum = m.summarize(rows);
check(sum.running === 3 && sum.notRunning === 4 && sum.scripts === 5 && sum.enabled === 4, 'summary: running, not running, init scripts, enabled at boot', j(sum));

console.log('\n== actions ==');
check(j(m.actionsFor(by('dnsmasq'))) === '[{"action":"start","disabled":true},{"action":"stop","disabled":false},{"action":"restart","disabled":false},{"action":"disable","disabled":false}]', 'a running service cannot be started again; one that starts at boot offers Disable', j(m.actionsFor(by('dnsmasq'))));
check(m.actionsFor(by('acme')).every(a => !a.disabled) && m.actionsFor(by('firewall')).every(a => !a.disabled), 'a service that is not running can be started; Start, Stop and Restart are always there');
check(m.actionsFor(by('acme')).at(-1).action === 'enable' && m.actionsFor(by('acme')).length === 4 && m.actionsFor(by('dnsmasq')).at(-1).action === 'disable', 'the last button changes the boot setting: Enable for a service that does not start at boot, Disable for one that does');
check(m.actionsFor(by('boot')).length === 0 && m.actionsFor(by('ubus')).length === 0, 'protected rows and rows without a script offer none');
check(j(m.ACTIONS) === '["start","stop","restart","enable","disable"]' && m.LABELS.enable === 'Enable' && m.PROGRESS.disable === 'Disabling', 'the actions are start, stop, restart, enable and disable');

console.log('\n== confirmations ==');
const crit = ['rpcd', 'uhttpd', 'network', 'dropbear', 'firewall', 'wpad'];
check(crit.every(n => m.riskOf(n, 'stop') && m.riskOf(n, 'restart')), 'stopping or restarting a critical service asks first', crit.filter(n => !m.riskOf(n, 'stop') || !m.riskOf(n, 'restart')).join());
check(crit.every(n => m.riskOf(n, 'start') === null && m.riskOf(n, 'enable') === null), 'starting and enabling never ask');
check(['rpcd', 'uhttpd', 'network', 'dropbear', 'firewall', 'wpad', 'dnsmasq', 'odhcpd', 'log'].every(n => m.riskOf(n, 'disable') && m.riskOf(n, 'disable').text.length > 40 && m.riskOf(n, 'disable').end === false) && m.riskOf('cron', 'disable') === null, 'disabling a critical service at boot asks first and explains what happens after the next restart; an ordinary one needs no question, and none of them ends the session');
check(['rpcd', 'uhttpd', 'network', 'firewall'].every(n => m.riskOf(n, 'disable').level === 'danger') && ['dropbear', 'wpad', 'dnsmasq'].every(n => m.riskOf(n, 'disable').level === 'warning') && m.riskOf('rpcd', 'disable').title === 'Disable rpcd?' && /ssh: \/etc\/init\.d\/rpcd enable/.test(m.riskOf('rpcd', 'disable').text), 'the level tells a lock-out from a lost function, and the title and the way back are named');
check(m.riskOf('cron', 'stop') === null && m.riskOf('sysntpd', 'restart') === null && m.riskOf('nosuch', 'restart') === null, 'an ordinary service needs no confirmation');
const rr = m.riskOf('rpcd', 'restart');
check(rr.end && rr.level === 'danger' && rr.title === 'Restart rpcd?' && /sign in again/.test(rr.text) && /signs everyone out/.test(rr.text), 'restarting rpcd says that the session ends', j(rr));
check(m.riskOf('uhttpd', 'restart').end === false && /unavailable for a few seconds/.test(m.riskOf('uhttpd', 'restart').text), 'restarting uhttpd says the page is unavailable for a moment');
check(/ssh: \/etc\/init\.d\/uhttpd start/.test(m.riskOf('uhttpd', 'stop').text) && /ssh: \/etc\/init\.d\/rpcd start/.test(m.riskOf('rpcd', 'stop').text), 'stopping the web server or rpcd explains how to get it back');
check(m.riskOf('dnsmasq', 'restart').level === 'warning' && m.riskOf('network', 'stop').level === 'danger', 'the level tells a short interruption from a lock-out');
check(['stop', 'restart'].every(a => crit.every(n => m.riskOf(n, a).text.length > 40)), 'every warning explains the consequence');

console.log('\n== outcomes ==');
const ok = m.describeOutcome('dnsmasq', 'restart', { ok: true, output: 'done' }, null);
check(ok.kind === 'ok' && ok.text === 'dnsmasq restarted.' && ok.output === 'done', 'a success says what was done', j(ok));
check(m.describeOutcome('cron', 'start', { ok: true }, null).text === 'cron started.' && m.describeOutcome('cron', 'stop', { ok: true }, null).text === 'cron stopped.', 'past tense for start and stop');
check(m.describeOutcome('cron', 'disable', { ok: true }, null).text === 'cron disabled at boot.' && m.describeOutcome('cron', 'enable', { ok: true }, null).text === 'cron enabled at boot.' && /^Enable cron failed: /.test(m.describeOutcome('cron', 'enable', { ok: false, error: 'x' }, null).text), 'enable and disable say that it is the boot setting that changed');
const bad = m.describeOutcome('cron', 'start', { ok: false, error: 'The service script failed with exit code 1.', output: 'no config' }, null);
check(bad.kind === 'bad' && /failed with exit code 1/.test(bad.text) && bad.output === 'no config', 'a failure carries the reason and the script\'s output', j(bad));
const det = m.describeOutcome('rpcd', 'restart', { ok: true, detached: true }, null);
check(det.kind === 'info' && det.end && /sign in again/.test(det.text), 'a background restart of rpcd says it ends the session', j(det));
check(!m.describeOutcome('uhttpd', 'restart', { ok: true, detached: true }, null).end, 'a background restart of uhttpd does not end the session');
check(m.describeOutcome('cron', 'stop', null, 'The router cannot be reached.').kind === 'bad' && /cannot be reached/.test(m.describeOutcome('cron', 'stop', null, 'The router cannot be reached.').text), 'a transport error is reported as a failure');
check(m.describeOutcome('cron', 'stop', {}, null).kind === 'bad' && /no reason/.test(m.describeOutcome('cron', 'stop', {}, null).text), 'a failure without a reason still says it failed');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Services model checks passed');
process.exit(failed ? 1 : 0);
