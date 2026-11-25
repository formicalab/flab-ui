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
//   benignerr    the nameserver error musl always causes: listed, marked harmless, no finding
//   nocdr        no CDR backend and no call history file
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
  const rc = load('base', 'reload.core'), rp = load('base', 'reload.pjsip'), rd = load('base', 'reload.dialplan');
  check(rc.ok && rc.command === 'core reload' && rp.ok && rp.command === 'module reload res_pjsip.so' && rd.ok && rd.command === 'dialplan reload', 'reload runs only its three fixed commands', JSON.stringify([rc, rp, rd]));
  check(load('base', 'reload.bad').ok === false && load('base', 'reload.bad').command === null && /core, dialplan or pjsip/.test(load('base', 'reload.bad').error) && load('base', 'reload.none').ok === false, 'reload refuses anything else');
}

console.log('== unreachable / stopped / disabled / not installed ==');
{
  const u = load('unreachable', 'status');
  check(!u.running && u.state === 'unreachable', 'a live process without a control socket is "unreachable"', u.state);
  check(u.findings.some(f => f.level === 'warn' && /control socket/.test(f.text)), 'warns about the control socket', texts(u.findings));
  check(load('unreachable', 'pjsip').available === false, 'pjsip is unavailable', JSON.stringify(load('unreachable', 'pjsip')));
  check(load('unreachable', 'dialplan').available === false, 'dialplan is unavailable');
  check(load('unreachable', 'reload.core').ok === false && /did not answer/.test(load('unreachable', 'reload.core').error), 'a reload of an unreachable daemon fails with a reason');
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

console.log('== calls in progress ==');
{
  const a = load('calls', 'active'), [a1, a2] = a.channels;
  check(a.available && a.channels.length === 2 && a.truncated === false && a.now > 0, 'two channels in progress, with the router clock', JSON.stringify(a));
  check(a1.channel === 'PJSIP/1001-0000000a' && a1.type === 'PJSIP' && a1.endpoint === '1001' && a1.bridge === '2f5b1c3e-aaaa-4bbb-8ccc-0123456789ab' && a1.duration === 125, 'the concise list is kept, with type and endpoint', JSON.stringify(a1));
  check(a1.formats.native.join() === 'ulaw,alaw' && a1.formats.read === 'ulaw' && a1.formats.write === 'ulaw' && a1.formats.read_transcode === false && a1.formats.write_transcode === false, 'codecs of a channel without transcoding', JSON.stringify(a1.formats));
  check(a2.formats.native.join() === 'alaw' && a2.formats.write_transcode === 'ulaw@8000->alaw@8000' && a2.formats.read_transcode === 'alaw@8000->ulaw@8000', 'a transcoding channel says how', JSON.stringify(a2.formats));
  check(a1.rtp.codec === 'ulaw' && a1.rtp.rx.packets === 6250 && a1.rtp.rx.lost === 2 && a1.rtp.tx.jitter === 0.001 && a1.rtp.rtt === 0.012, 'RTP statistics matched to the channel by the cut name and the bridge', JSON.stringify(a1.rtp));
  check(a2.rtp.rx.packets === 150000 && a2.rtp.tx.lost === 3 && !('channel' in a2.rtp), 'a count with K is multiplied by 1000', JSON.stringify(a2.rtp));
  check(Array.isArray(a1.allowed) && Array.isArray(a2.allowed) && a2.allowed.length > 0 && a2.allowed.every(c => typeof c === 'string' && !/[()|]/.test(c)), 'the codecs our endpoint allows are read once per endpoint', JSON.stringify([a1.allowed, a2.allowed]));
  check(!strings([a]).some(t => t.includes('SECRET-DIGITS') || t.includes('PIN-MARKER')) && !a.channels.some(c => 'data' in c), 'the arguments of the application and the channel variables never reach the reply');
  check(a1.formats.dnid === '+390612345' && a1.formats.name === 'Gino Rossi' && a1.formats.hangup_at === a.now + 500 && a1.formats.streams.length === 1 && a1.formats.streams[0].state === 'sendrecv' && a2.formats.streams[0].state === 'sendonly' && a2.formats.dnid === '+390612345' && a1.formats.linked === '1700000000.10' && a1.formats.identifier === 'C-00000026', 'dialed number, caller name, automatic hangup time, ids and stream state', JSON.stringify(a1.formats));
  const b = load('base', 'active');
  check(a.bridges.length === 2 && a.bridges[0].id === '2f5b1c3e-aaaa-4bbb-8ccc-0123456789ab' && a.bridges[0].name === null && a.bridges[0].channels === 2 && a.bridges[0].type === 'basic' && a.bridges[0].technology === 'simple_bridge' && a.bridges[0].duration === 124 && a.bridges[1].name === 'my bridge' && a.bridges[1].technology === 'holding_bridge', 'bridges with their technology', JSON.stringify(a.bridges));
  check(b.available === true && b.channels.length === 0, 'no call in progress', JSON.stringify(b));
  check(load('unreachable', 'active').available === false, 'with Asterisk down the channels cannot be read');
}

console.log('== call history ==');
{
  const h = load('base', 'calls'), ids = h.entries.map(e => e.id);
  check(h.installed && h.enabled === true && h.csv === true && h.backends.includes('csv'), 'the csv backend is seen', JSON.stringify(h.backends));
  check(ids.join() === '1000.8,1000.7,1000.6,1000.5,1000.4,1000.3,1000.2,1000.1' || ids.join() === '1000.8,1000.6,1000.7,1000.5,1000.4,1000.3,1000.2,1000.1', 'eight calls, the newest first; the broken and empty lines are skipped', ids.join());
  const by = id => h.entries.find(e => e.id === id);
  const out = by('1000.1');
  check(out.duration === 125 && out.billsec === 122 && out.disposition === 'ANSWERED' && out.from_endpoint === '1001' && out.to_endpoint === 'Vodafone' && out.answer - out.start === 3 && out.end - out.start === 125, 'an outgoing call: times, seconds, endpoints from the channel names', JSON.stringify(out));
  check(by('1000.2').disposition === 'NO ANSWER' && by('1000.2').answer === null && by('1000.2').from_endpoint === 'Vodafone', 'an unanswered call has no answer time');
  check(by('1000.3').clid === '"Rossi, ""Gino""" <+390212345678>', 'a comma and doubled quotes inside a quoted field are read back', by('1000.3').clid);
  check(by('1000.6').from_endpoint === '6000@internal-lab' && by('1000.6').linked === '1000.6' && by('1000.7').linked === '1000.6' && by('1000.8').linked === '1000.8', 'Local legs share a linked id, an old line falls back to its own id');
  check(!strings([h]).some(t => t.includes('LASTDATA-MARKER')), 'the arguments of the last application never reach the reply');
  check(h.file === '/var/log/asterisk/cdr-csv/Master.csv' && h.truncated === false, 'the file and whether it was cut');
  const n = load('nocdr', 'calls');
  check(n.csv === false && n.backends.length === 0 && n.entries.length === 0, 'without a backend and a file: nothing, and the reason is in csv', JSON.stringify(n));
  const u = load('unreachable', 'calls');
  check(u.csv === false && u.entries.length === 8, 'with Asterisk down the file is still read', `${u.csv} ${u.entries.length}`);
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
  check(r.findings.some(f => /errors? in the Asterisk log in the last 24 hours.*Synthetic failure/.test(f.text)), 'a fresh error is a finding', texts(r.findings));
  const b = load('benignerr', 'status');
  const countOf = s => +(s.findings.find(f => /in the Asterisk log in the last 24 hours/.test(f.text))?.text.match(/^(\d+)/)?.[1] ?? 0);
  check(b.problems.entries.some(e => /no local system nameservers/.test(e.text) && e.level === 'error' && e.benign) && countOf(b) === countOf(load('base', 'status')) && !b.findings.some(f => /nameservers/.test(f.text)), 'the musl nameserver error is listed as harmless and adds nothing to the findings', texts(b.findings));
  check(!r.problems.entries.some(e => /Synthetic failure/.test(e.text) && e.benign), 'other errors are not marked harmless');
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
  check(ctx[4].data === '$["${PIN}" != "" & "${PIN}" = "${REMOTE_ACCESS_PIN}"]?ok', 'an empty literal or another variable hides nothing', ctx[4].data);
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
