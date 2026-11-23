// Checks the backend JSON the flab.asterisk plugin produced for each scenario (built by mkfx.mjs from the real capture and replayed on the router).
// Usage: node assert.mjs <dir with <scenario>.<name>.json files and secrets.json>
//   base         the real captured state: running, PJSIP registrations and endpoints, a dialplan, configuration files
//   unreachable  the process lives but the control socket does not answer
//   stopped / disabled / notinstalled   the states that look like it
//   regfail      a trunk registration is Rejected
//   calls        a call in progress with two contacts on a phone
//   nopjsip      the PJSIP modules are not loaded
//   changed      pjsip.conf changed after Asterisk last loaded it
//   recenterr    a fresh error in the log
//   many         more endpoints than get a detail query
//   secrets      secrets in the configuration, the dialplan, the globals and the endpoint parameters
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const load = (scenario, name) => JSON.parse(fs.readFileSync(path.join(dir, `${scenario}.${name}.json`), 'utf8'));
const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const texts = findings => findings.map(f => f.text).join(' | ');
// Every string value inside a JSON value (numbers are skipped, so a secret like 3003 cannot match a timestamp).
const strings = v => typeof v === 'string' ? [v] : (v && typeof v === 'object') ? Object.values(v).flatMap(strings) : [];
// The secrets of the router that appear in the strings of the given replies.
const leaks = replies => secrets.filter(s => strings(replies).some(t => t.includes(s)));

console.log('== base (real captured output) ==');
{
  const s = load('base', 'status'), p = load('base', 'pjsip'), d = load('base', 'dialplan'), c = load('base', 'config');
  check(s.installed && s.running && s.state === 'running', 'running state', s.state);
  check(/^\d+\.\d+\.\d+/.test(s.version) && /^\d+\.\d+/.test(s.pjproject), 'version and PJPROJECT parsed', `${s.version} ${s.pjproject}`);
  check(s.uptime > 0 && s.started < s.now && s.reloaded <= s.now, 'uptime and times are consistent');
  check(s.pid > 0 && s.rss_kb > 0, 'process id and memory read from /proc');
  check(s.calls.active === 0 && s.calls.processed >= 0, 'call counters parsed', JSON.stringify(s.calls));
  check(s.modules.length > 10 && s.modules.some(m => m.name === 'res_pjsip.so'), 'modules listed, including res_pjsip');
  check(s.subsystems.ami === false && typeof s.subsystems.cdr === 'boolean', 'subsystems read (AMI off)');
  check(s.logger.length >= 1 && s.cdr.enabled !== null, 'logger channels and CDR status parsed');
  check(s.summary.registrations === s.summary.registrations_list.length && s.summary.endpoints === s.summary.endpoints_list.length, 'summary counts match the lists');
  check(s.problems.available && Array.isArray(s.problems.entries) && s.problems.entries.every(e => e.level && e.text), 'log problems parsed');
  check(p.available && p.endpoints.length === s.summary.endpoints && p.registrations.length === s.summary.registrations, 'pjsip lists agree with the status summary');
  check(p.transports.length >= 1 && p.transports.every(t => t.name && t.bind), 'transports parsed with their bind address');
  check(p.endpoints.every(e => ['trunk', 'phone', 'other'].includes(e.role)), 'every endpoint has a role');
  check(p.endpoints.every(e => e.context && e.settings && Array.isArray(e.codecs)), 'endpoint settings (context, codecs) read from the detail query');
  const trunk = p.endpoints.find(e => e.registration);
  check(!trunk || (trunk.role === 'trunk' && p.registrations.find(r => r.name === trunk.registration)?.endpoint === trunk.name), 'a registered trunk is linked both ways');
  check(p.registrations.every(r => r.status && r.settings.server_uri), 'registrations carry state and settings');
  check(d.available && d.totals.contexts === d.contexts.length, 'dialplan contexts counted');
  check(d.contexts.every(x => x.name && x.extensions.every(e => e.pattern && e.steps.length && e.steps.every(st => Number.isInteger(st.prio) && st.app))), 'every extension has parsed steps');
  check(d.contexts.flatMap(x => x.extensions).flatMap(e => e.steps).some(st => st.source?.file && st.source.line > 0), 'steps carry their source file and line');
  check(d.totals.steps === d.contexts.reduce((n, x) => n + x.extensions.reduce((m, e) => m + e.steps.length, 0), 0), 'step total matches');
  check(Array.isArray(d.globals), 'globals parsed');
  check(c.files.some(f => f.name === 'pjsip.conf' && f.active > 0), 'configuration index lists pjsip.conf with active lines');
  const raw = [s, p, d, c, load('base', 'config.pjsip'), load('base', 'config.extensions'), load('base', 'endpoint')];
  check(secrets.length > 0 && leaks(raw).length === 0, 'no real secret of the router reaches any reply', leaks(raw).join(','));
  const pj = load('base', 'config.pjsip');
  check(pj.redacted > 0 && /password=<redacted>/.test(pj.text), 'pjsip.conf passwords are redacted', String(pj.redacted));
  check(pj.text.split('\n').length === fs.readFileSync(path.join(dir, 'raw-pjsip.conf'), 'utf8').split('\n').length, 'redaction keeps the line numbers');
  check(load('base', 'config.extensions').redacted >= 0 && load('base', 'config.extensions').text.length > 100, 'extensions.conf read');
  const e = load('base', 'endpoint');
  check(e.found && e.params.length > 50 && !e.params.some(x => x.name === 'ParameterName'), 'endpoint detail has its parameter rows', String(e.params.length));
  check(load('base', 'resolve.ok').found && load('base', 'resolve.ok').via_include === true && load('base', 'resolve.ok').pattern === '6000', 'resolve finds a number through an include');
  check(load('base', 'resolve.none').found === false, 'resolve of an unmatched number says so');
  check(load('base', 'resolve.badctx').found === false && /not valid/.test(load('base', 'resolve.badctx').error), 'resolve refuses an unsafe context');
  check(load('base', 'resolve.badnum').found === false && /not valid/.test(load('base', 'resolve.badnum').error), 'resolve refuses an unsafe number');
  check(load('base', 'endpoint.bad').found === false, 'endpoint refuses an unsafe or unknown name');
  check(load('base', 'config.bad').error, 'config refuses a file that is not a configuration file');
}

console.log('== unreachable / stopped / disabled / not installed ==');
{
  const u = load('unreachable', 'status');
  check(!u.running && u.state === 'unreachable', 'a live process without a control socket is "unreachable"', u.state);
  check(u.findings.some(f => f.level === 'warn' && /control socket/.test(f.text)), 'warns about the control socket', texts(u.findings));
  check(load('unreachable', 'pjsip').available === false, 'pjsip is unavailable', JSON.stringify(load('unreachable', 'pjsip')));
  check(load('unreachable', 'dialplan').available === false, 'dialplan is unavailable');
  const st = load('stopped', 'status');
  check(!st.running && st.state === 'stopped' && st.findings.some(f => f.level === 'bad'), 'a stopped daemon that is enabled is an error', texts(st.findings));
  const di = load('disabled', 'status');
  check(!di.running && di.state === 'disabled' && di.enabled === false && di.findings.every(f => f.level === 'info'), 'a disabled daemon is only a note', texts(di.findings));
  const ni = load('notinstalled', 'status');
  check(ni.installed === false && ni.state === 'not_installed' && ni.findings.length === 0, 'not installed is reported without findings');
}

console.log('== regfail ==');
{
  const s = load('regfail', 'status'), p = load('regfail', 'pjsip');
  check(s.summary.registered === s.summary.registrations - 1, 'one registration is not Registered', JSON.stringify(s.summary));
  check(s.findings.some(f => f.level === 'bad' && /Vodafone is Rejected/.test(f.text)), 'a rejected registration is an error', texts(s.findings));
  check(p.registrations.find(r => r.name === 'Vodafone').status === 'Rejected' && p.registrations.find(r => r.name === 'Vodafone').expires === null, 'rejected state has no expiry');
}

console.log('== calls ==');
{
  const s = load('calls', 'status'), p = load('calls', 'pjsip');
  check(s.calls.active === 1 && s.calls.processed === 5, 'call counters follow', JSON.stringify(s.calls));
  check(p.channels.length === 2 && p.channels[0].channel === 'PJSIP/1001-0000000a' && p.channels[0].duration === 125 && p.channels[0].app === 'Dial', 'channels parsed from the concise list', JSON.stringify(p.channels[0]));
  const e = p.endpoints.find(x => x.name === '1001');
  check(e.state === 'In use' && e.channels === 1 && e.contacts.length === 2 && e.contacts.every(c => c.status === 'Avail'), '1001 is in use with two contacts', JSON.stringify(e.contacts));
  check(e.calls.length === 1 && e.calls[0].time === '00:02:05' && e.calls[0].exten === '+390612345', 'the endpoint block lists its call', JSON.stringify(e.calls));
  check(e.active_channels.length === 1 && e.active_channels[0].channel === 'PJSIP/1001-0000000a', 'channels are matched to their endpoint');
  check(!s.findings.some(f => /1001/.test(f.text)), 'an endpoint in use is not reported as unavailable', texts(s.findings));
}

console.log('== nopjsip ==');
{
  const s = load('nopjsip', 'status'), p = load('nopjsip', 'pjsip');
  check(s.running && s.pjsip_loaded === false && s.summary.endpoints === 0, 'no PJSIP: nothing counted', JSON.stringify(s.summary));
  check(s.findings.some(f => /PJSIP channel driver is not loaded/.test(f.text)), 'says PJSIP is not loaded', texts(s.findings));
  check(p.available === false && p.reason === 'module', 'pjsip answers with the reason', JSON.stringify(p));
}

console.log('== changed / recenterr / many ==');
{
  const s = load('changed', 'status');
  check(s.changed_files.join() === 'pjsip.conf' && s.findings.some(f => /pjsip\.conf was changed after Asterisk last loaded/.test(f.text)), 'a file changed after the last reload is flagged', texts(s.findings));
  check(load('changed', 'config').files.find(f => f.name === 'pjsip.conf').changed === true && load('changed', 'config').files.filter(f => f.changed).length === 1, 'the config index marks exactly that file');
  check(load('base', 'status').changed_files.length === 0, 'an unchanged configuration is not flagged');
  const r = load('recenterr', 'status');
  check(r.problems.entries.some(e => /Synthetic failure/.test(e.text) && e.level === 'error' && e.source === 'res_pjsip.c'), 'the new log line is a problem entry', JSON.stringify(r.problems.entries.slice(-1)));
  check(r.findings.some(f => /error in the Asterisk log in the last 24 hours.*Synthetic failure/.test(f.text)), 'a fresh error is a finding', texts(r.findings));
  const m = load('many', 'pjsip');
  check(m.endpoints.length === 45 && m.truncated === true, '45 endpoints are all listed, detail queries are capped', `${m.endpoints.length} ${m.truncated}`);
  check(m.endpoints.filter(e => e.settings).length === 40, 'exactly 40 endpoints got a detail query', String(m.endpoints.filter(e => e.settings).length));
}

console.log('== secrets ==');
{
  const planted = ['4321', 'hunter2', '9999', 'abc123xyz', 'swordfish', 'topsecret-1', 'deadbeefmd5'];
  const replies = ['status', 'pjsip', 'dialplan', 'config', 'config.pjsip', 'config.extensions', 'endpoint'].map(n => load('secrets', n));
  for (const s of planted) check(!strings(replies).some(t => t.includes(s)), `the planted secret ${s} never reaches a reply`);
  const d = load('secrets', 'dialplan');
  const ctx = d.contexts.find(c => c.name === 'secrets').extensions[0].steps;
  check(ctx[0].data === '<redacted>' && ctx[1].data === 'SIP_PASSWORD=<redacted>', 'Authenticate and Set(…PASSWORD=) are redacted in the dialplan', JSON.stringify(ctx.slice(0, 2)));
  check(ctx[2].data === '$["${ADMIN_PIN}" != "<redacted>"]?bad', 'a compare of a secret variable keeps its shape', ctx[2].data);
  check(ctx[3].data === 'PLAIN=ok', 'an ordinary Set is not touched', ctx[3].data);
  check(d.globals.find(g => g.name === 'API_TOKEN').value === '<redacted>' && d.globals.find(g => g.name === 'VISIBLE_NAME').value === 'shown', 'globals: the secret-named one is hidden, the other shown');
  const pj = load('secrets', 'config.pjsip');
  check(/username=visible-user/.test(pj.text) && /secret=<redacted>/.test(pj.text) && /md5_cred=<redacted>/.test(pj.text), 'configuration: secrets hidden, the user name kept');
  const ex = load('secrets', 'config.extensions');
  check(/Authenticate\(<redacted>/.test(ex.text) && /SIP_PASSWORD=<redacted>/.test(ex.text) && /"<redacted>"\?bad|!= "<redacted>"/.test(ex.text), 'extensions.conf: dialplan lines are redacted too');
  check(load('secrets', 'endpoint').params.find(p => p.name === 'password').value === '<redacted>', 'a password parameter of an endpoint is hidden');
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll Asterisk backend checks passed');
