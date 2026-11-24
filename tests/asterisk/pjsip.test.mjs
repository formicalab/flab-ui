// Unit test for the PJSIP view model and the configuration reader of the Asterisk page (pjsipmodel.js, configmodel.js). Pure functions.
// Usage: node pjsip.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const load = f => import(pathToFileURL(path.resolve(import.meta.dirname, `../../www/js/pages/asterisk/${f}`)).href);
const m = await load('pjsipmodel.js');
const c = await load('configmodel.js');

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

const contact = (hash, status = 'Avail', rtt = 40) => ({ aor: 'x', uri: `sip:${hash}@h`, hash, status, rtt });
const endpoint = (name, role, state, extra = {}) => ({ name, role, state, channels: 0, auths: [], aors: [], contacts: [], identifies: [], codecs: ['alaw'], context: 'c', registration: null, transport: null, settings: {}, ...extra });
const pjsip = {
  available: true,
  registrations: [{ name: 'V', status: 'Registered' }, { name: 'C', status: 'Rejected' }],
  endpoints: [
    endpoint('1001', 'phone', 'Unavailable', { aors: [{ name: '1001', max_contacts: 2 }] }),
    endpoint('V', 'trunk', 'In use', { channels: 1, contacts: [contact('aa'), contact('bb', 'Unavail', null)], identifies: [{ name: 'V', matches: ['10.0.0.0/8'] }], registration: 'V', transport: { name: 'transport-udp' } }),
  ],
  channels: [{ channel: 'PJSIP/V-1' }],
};

console.log('== kinds and texts ==');
check(m.endpointKind({ state: 'Not in use' }) === 'success' && m.endpointKind({ state: 'In use' }) === 'info' && m.endpointKind({ state: 'Busy' }) === 'warning', 'endpoint state kinds');
check(m.endpointKind({ state: 'Unavailable', role: 'trunk' }) === 'danger' && m.endpointKind({ state: 'Unavailable', role: 'phone' }) === 'warning', 'an unreachable trunk is an error, a phone a warning');
check(m.registrationKind('Registered') === 'success' && m.registrationKind('Rejected') === 'danger' && m.registrationKind('Unregistered') === 'warning' && m.registrationKind('Stopped') === '', 'registration kinds');
check(m.contactKind('Avail') === 'success' && m.contactKind('Unavail') === 'danger' && m.contactKind('NonQual') === '', 'contact kinds');
check(m.countdown(45) === 'in 45 s' && m.countdown(600) === 'in 10 min' && m.countdown(3900) === 'in 1 h 5 min' && m.countdown(7200) === 'in 2 h' && m.countdown(null) === null, 'countdown texts');
check(m.fmtRtt(53.428) === '53 ms' && m.fmtRtt(0.44) === '0.4 ms' && m.fmtRtt(null) === '–', 'round-trip texts');

console.log('== filter ==');
const names = (q, role) => pjsip.endpoints.filter(e => m.matchesEndpoint(e, q, role)).map(e => e.name).join();
check(names('') === '1001,V' && names('trunk') === 'V' && names('', 'phone') === '1001' && names('10.0.0 in use') === 'V' && names('nothing') === '', 'the filter searches name, role, state and identify criteria; the role filter narrows');
check(m.endpointNotes(pjsip.endpoints[0]).some(n => n.level === 'warn' && /No contact is registered/.test(n.text)) && m.endpointNotes(pjsip.endpoints[1]).some(n => /does not answer/.test(n.text)), 'endpoint notes');
check(m.endpointNotes(endpoint('p', 'phone', 'Unavailable', { contacts: [contact('zz', 'Unavail', null)] })).some(n => /registered, but none of its contacts answers/.test(n.text)), 'a phone whose contacts do not answer is told apart from one with none');

console.log('== round-trip history ==');
const h = new Map();
m.recordRtt(h, pjsip, 3);
for (let i = 0; i < 4; i++) m.recordRtt(h, { endpoints: [endpoint('V', 'trunk', 'x', { contacts: [contact('aa', 'Avail', 50 + i)] })] }, 3);
check(j([...h.keys()]) === '["V|aa"]' && j(h.get('V|aa')) === '[51,52,53]', 'the last values are kept per contact and gone contacts are dropped', j([...h]));
check(m.recordRtt(new Map(), pjsip).get('V|bb') === undefined, 'a contact without a round-trip time has no history');

console.log('== configuration files ==');
const text = [';--', 'a block comment', 'password=in-a-comment', '--;', '; line comment', '[transport-udp]', 'type=transport', 'bind=0.0.0.0:5060 ; the port', '', '[Vodafone]', 'type = endpoint', '[Vodafone]', 'type=aor',
  'exten => 1000,1,NoOp()', ' same => n,Hangup()', '#include "x.conf"', '[globals]', 'TTS_VOICE=it-IT'].join('\n');
const lines = c.readLines(text);
const kinds = lines.map(l => l.kind).join();
check(kinds === 'comment,comment,comment,comment,comment,section,option,option,blank,section,option,section,option,exten,exten,include,section,option', 'line kinds, including block comments', kinds);
check(lines[5].name === 'transport-udp' && lines[0].no === 1 && lines[17].no === 18, 'section names and line numbers');
check(j(c.sections(lines).map(x => [x.name, x.type, x.line])) === j([['transport-udp', 'transport', 6], ['Vodafone', 'endpoint', 10], ['Vodafone', 'aor', 12], ['globals', null, 17]]), 'sections with their type, repeated names kept apart', j(c.sections(lines)));
const o = c.splitOption('bind=0.0.0.0:5060 ; the port');
check(o.key === 'bind' && o.value === '0.0.0.0:5060' && o.comment === ' ; the port' && o.sep === '=', 'an option line splits into key, value and comment', j(o));
check(c.splitOption('same => n,Hangup()') === null || c.splitOption('same => n,Hangup()').key === 'same', 'dialplan lines do not break the splitter');

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll PJSIP and configuration model checks passed');
