// Checks the output of flab.ddns for each scenario built by mkfx.mjs, and (when present) a read-only run on the real router.
// Usage: node assert.mjs <dir with <scenario>.json files>
//   real.json, real-sections.txt and real-leaks.txt (optional): `status` and `log` run for real (they only read), the names of the
//   router's service sections as uci reports them, and how many times a stored secret appears in what the plugin returned.
import fs from 'node:fs';
import path from 'node:path';
import { CASES, REFUSED, REFUSED_LOG, RUN, SECRETS, SERVICES } from './cases.mjs';

const dir = process.argv[2];
// Loads one scenario's results (a JSON object keyed by call id).
const load = n => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// The calls that must be refused, in every scenario, without anything being run.
function refusals(sc, r) {
  const bad = [];
  for (const [section, action, pattern] of REFUSED) {
    const x = r[`refused:${section}:${action}`];
    if (!(x && x.ok === false && x.code === null && x.output === '' && pattern.test(x.error))) bad.push(`${section}/${action}: ${j(x)}`);
  }
  check(bad.length === 0, `${sc}: ${REFUSED.length} refused calls (unknown, disabled, invalid name, invalid action) say why and run nothing`, bad.join(' | '));
  const types = ['no-args', 'number', 'list', 'object-action', 'no-action'].filter(k => r[`refused:${k}`]?.ok !== false || r[`refused:${k}`]?.code !== null);
  check(types.length === 0, `${sc}: missing or wrongly typed arguments are refused`, types.join());
}

// The keys a service of the status reply has, and the runtime's.
const SERVICE_KEYS = 'runtime,secrets,section,values';
const RUNTIME_KEYS = 'detected_ip,error,last_update,local_ip,log,next_check,pid,problem,registered_ip,running,terminated';
const STATUS_KEYS = 'at_boot,ca,devices,generated,global,installed,logdir,networks,providers,rundir,running,services,tools,uptime,version';

console.log('== status ==');
const main = load('main');
const st = main.status;
check(Object.keys(st).sort().join() === STATUS_KEYS && st.services.every(s => Object.keys(s).sort().join() === SERVICE_KEYS && Object.keys(s.runtime).sort().join() === RUNTIME_KEYS), 'the reply has only the documented fields', Object.keys(st).sort().join());
check(st.installed === true && st.version === '2.8.4-12' && st.running === true && st.at_boot === true && st.uptime === 5000 && st.rundir === '/var/run/ddns' && st.logdir === '/var/log/ddns' && st.ca === '/etc/ssl/certs/ca-certificates.crt' && typeof st.generated === 'number', 'the updater, its version, whether it starts at boot, the directories and the CA certificates', j({ ...st, providers: 0, services: 0 }));
check(st.global.section === 'global' && j(Object.keys(st.global.values).sort()) === j(['ddns_dateformat', 'ddns_logdir', 'ddns_loglines', 'ddns_rundir']), 'the global section');
check(st.services.map(s => s.section).join() === SERVICES.join(), 'the services in file order', st.services.map(s => s.section).join());
check(j(main['status-args'].services.map(s => s.values)) === j(st.services.map(s => s.values)) && main['status-args'].providers.length === st.providers.length, 'arguments sent to status are ignored');

console.log('\n== secrets never leave the router ==');
// The service section called `n` in the reply of the main scenario.
const svc = n => st.services.find(s => s.section === n);
check(!('password' in svc('home').values) && !('api_token' in svc('home').values) && j(svc('home').secrets) === j({ password: true, api_token: true }) && svc('home').values.odd_option === 'x', 'a password and an option that is named like a secret are left out; an unknown ordinary option is kept');
check(j(svc('v6').secrets) === j({ password: true }) && j(svc('custom').secrets) === j({ password: true }) && j(svc('off').secrets) === '{}' && !('password' in svc('v6').values) && !('password' in svc('custom').values), 'the services say only whether a password is stored');
check(svc('home').values.proxy === 'proxyuser:***@proxy.example.com:3128', 'the password in a proxy address is masked', svc('home').values.proxy);
const everything = j(main);
const hidden = Object.entries(SECRETS).filter(([k]) => k !== 'short').map(([, s]) => s);
check(hidden.every(s => !everything.includes(s)), 'no secret appears anywhere in any reply (status, logs, errors); only the short one, which is not masked in text, can', hidden.filter(s => everything.includes(s)).join());

console.log('\n== what each service is doing ==');
// The runtime of service `n`.
const rt = n => svc(n).runtime;
check(rt('home').running === true && rt('home').pid === 4000 && rt('home').registered_ip === '203.0.113.7' && rt('home').local_ip === '203.0.113.7' && rt('home').detected_ip === '203.0.113.7' && rt('home').error === null && rt('home').log === true, 'home: running, with the registered address, the one the router has (from the network) and the one the updater detected');
check(st.generated - rt('home').last_update === 5000 - 4400 && rt('home').next_check - st.generated === 5040 - 5000, 'the run files hold uptime stamps, which become epoch times (last update 600 s ago, next check in 40 s)', j([st.generated, rt('home').last_update, rt('home').next_check]));
check(rt('home').problem === null && rt('home').terminated === null, 'a warning that a later lookup has put right is not a problem');
check(rt('v6').local_ip === '2001:db8::5' && rt('v6').registered_ip === '2001:db8::4' && rt('v6').running === true && rt('v6').pid === 4001, 'v6: the address read from a device with ip addr');
check(rt('v6').problem?.level === 'ERROR' && rt('v6').problem.time === '203001' && /^IP update not accepted by DDNS Provider: bad credentials \*\*\* for abc$/.test(rt('v6').problem.text) && /for \*\*\*$/.test(rt('v6').error) && rt('v6').terminated === null, 'an error after the last good lookup is the current problem, with the secret masked (a secret under four characters is left alone)', j(rt('v6').problem));
check(rt('custom').running === false && rt('custom').pid === null && rt('custom').local_ip === null && rt('custom').detected_ip === '198.51.100.9' && rt('custom').registered_ip === null, 'custom: not running; a web page as the source gives no local address but the updater\'s own');
check(rt('custom').terminated === "No valid certificate(s) found at '/x' for HTTPS communication" && rt('custom').problem?.text === rt('custom').terminated && rt('custom').last_update === null && rt('custom').next_check === null, 'it stopped on a fatal error (the log line ends with TERMINATE), and a stamp from the future (an old file) is ignored');
check(rt('off').running === false && rt('off').log === false && rt('off').registered_ip === null && rt('off').last_update === null && rt('off').problem === null, 'off: nothing is known about a service that never ran');
check(rt('evil').local_ip === null, 'a device whose name starts with a dash is never given to a command (the fixture for that command would have answered)', j(rt('evil')));

console.log('\n== what the router offers ==');
check(st.providers.map(p => p.name).join() === 'cloud.example-v4,duckdns.example,dyn.example,missing.example,old.example', 'the providers, sorted; a line without a tab or with bad JSON is ignored', st.providers.map(p => p.name).join());
// The provider called `n`.
const prov = n => st.providers.find(p => p.name === n);
check(j(prov('duckdns.example').needs) === j(['DOMAIN', 'PASSWORD']) && prov('duckdns.example').ipv6 === true && prov('duckdns.example').script === null && prov('duckdns.example').available === true && prov('duckdns.example').source === 'default', 'what a provider\'s update address needs, and IPv6 support');
check(j(prov('old.example').needs) === j(['DOMAIN', 'USERNAME', 'PASSWORD', 'PARAMOPT']) && prov('old.example').ipv6 === false, 'a provider with only an IPv4 address does not support IPv6');
check(prov('cloud.example-v4').needs === null && prov('cloud.example-v4').script === 'update_cloud_example_v4.sh' && prov('cloud.example-v4').available === true && prov('missing.example').available === false && prov('missing.example').script === 'update_missing_example.sh', 'a provider that is a script is available only when its script is installed');
check(prov('dyn.example').source === 'custom' && prov('dyn.example').ipv6 === false && j(prov('dyn.example').needs) === j(['DOMAIN']), 'a provider of the user\'s own replaces the one of the same name');
check(st.networks.join() === 'guest,lan,wan,wan6,wg0' && st.devices.join() === 'br-lan,eth0,eth1,lo,wan', 'networks (loopback left out, other uci types ignored) and devices (names that are not plain are left out)', j([st.networks, st.devices]));
check(j(st.tools) === j({ curl: true, wget: false, uclient_fetch: true, host: false }), 'the tools');

console.log('\n== log ==');
const logs = SERVICES.map(s => main[`log:${s}`]);
check(main['log:home'].ok && main['log:home'].exists && /Transfer failed - retry 1\/0/.test(main['log:home'].text) && main['log:home'].truncated === false && main['log:home'].section === 'home', 'the log of a service');
check(main['log:v6'].ok && /bad credentials \*\*\* for abc/.test(main['log:v6'].text) && !main['log:v6'].text.includes(SECRETS.v6password), 'a secret in a log is masked');
check(main['log:off'].ok && main['log:off'].exists === false && main['log:off'].text === '' && main['log:evil'].exists === false, 'a service without a log file has an empty log');
check(main['log:big'].truncated === true && main['log:big'].text.length === 65536 && main['log:big'].text.endsWith('filler line number 2499\n'), 'a log over 64 KB is cut from the start, so the newest lines stay');
const badLogs = [...REFUSED_LOG.map(s => `refusedlog:${s}`), 'refusedlog:no-args', 'refusedlog:number', 'refusedlog:list'].filter(k => !(main[k]?.ok === false && /no such service/.test(main[k].error) && !('text' in main[k])));
check(badLogs.length === 0, `${REFUSED_LOG.length + 3} log requests for a name that is not a service (paths, injection, wrong types) are refused`, badLogs.join());

console.log('\n== control: restarting an updater ==');
for (const [section, action] of RUN) {
  const x = main[`run:${section}:${action}`];
  check(x.ok === true && x.code === 0 && x.output === 'Restarting ddns' && x.error === null && x.section === section && x.action === action, `${action} ${section} restarts its updater and returns the init script's output`, j(x));
}
refusals('main', main);
const fail = load('fail');
check(RUN.every(([s, a]) => { const x = fail[`run:${s}:${a}`]; return x.ok === false && x.code === 1 && /exit code 1/.test(x.error) && /bad config/.test(x.output); }), 'a failing init script is a failure that carries the code and its output');
refusals('fail', fail);
const timeout = load('timeout');
check(RUN.every(([s, a]) => { const x = timeout[`run:${s}:${a}`]; return x.ok === false && x.code === 124 && /20 seconds/.test(x.error); }), 'an init script that hangs is reported as such');
const noresult = load('noresult');
check(RUN.every(([s, a]) => { const x = noresult[`run:${s}:${a}`]; return x.ok === false && x.code === null && /did not report/.test(x.error); }), 'a missing exit code is a failure, not a success');
refusals('timeout', timeout);
refusals('noresult', noresult);

console.log('\n== a router without ddns-scripts ==');
const empty = load('empty');
const es = empty.status;
check(es.installed === false && es.version === null && es.running === false && es.at_boot === false && es.services.length === 0 && es.global.section === null && j(es.global.values) === '{}' && es.providers.length === 0 && es.networks.length === 0 && es.ca === '', 'nothing is installed: an empty reply, not an error', j({ ...es, providers: 0 }));
check(CASES.filter(c => c.method === 'control').every(c => empty[c.id].ok === false && empty[c.id].code === null) && CASES.filter(c => c.method === 'log').every(c => empty[c.id].ok === false), 'every control and log request is refused');

if (fs.existsSync(path.join(dir, 'real.json'))) {
  console.log('\n== the real router (status and log only, nothing is run) ==');
  const real = load('real');
  const rs = real.status;
  const sections = fs.readFileSync(path.join(dir, 'real-sections.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  check(Object.keys(rs).sort().join() === STATUS_KEYS && rs.installed === true && rs.services.map(s => s.section).join() === sections.join(), 'the reply has the documented fields and lists every service section of the config', `${rs.services.map(s => s.section).join()} vs ${sections.join()}`);
  check(rs.services.every(s => Object.keys(s).sort().join() === SERVICE_KEYS && Object.keys(s.runtime).sort().join() === RUNTIME_KEYS && typeof s.runtime.running === 'boolean' && s.secrets && typeof s.secrets === 'object'), 'every service has its status and its secrets flags');
  check(rs.services.every(s => !Object.keys(s.values).some(k => /^(password|.*(passw|secret|token|apikey|api_key).*)$/i.test(k))), 'no option that holds a secret is returned');
  check(rs.providers.length > 20 && rs.providers.every(p => typeof p.name === 'string' && typeof p.ipv6 === 'boolean' && typeof p.available === 'boolean') && rs.networks.includes('wan') && rs.devices.length > 1 && typeof rs.tools.curl === 'boolean', 'the router\'s providers, networks and devices');
  check(rs.services.filter(s => s.values.enabled === '1').every(s => s.runtime.running ? Number.isInteger(s.runtime.pid) : true) && rs.uptime > 0 && Math.abs(rs.generated - Date.now() / 1000) < 600, 'running services have a process id; the router\'s clock agrees with this computer\'s to within ten minutes');
  const leaks = fs.readFileSync(path.join(dir, 'real-leaks.txt'), 'utf8').trim();
  check(leaks === '0', 'none of the router\'s stored secrets appears in anything the plugin returned (status or any log)', leaks);
  const logKeys = Object.keys(real).filter(k => k.startsWith('log:'));
  check(logKeys.length === sections.length && logKeys.every(k => real[k].ok === true && typeof real[k].exists === 'boolean'), 'the log of every service can be read');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Dynamic DNS backend checks passed');
process.exit(failed ? 1 : 0);
