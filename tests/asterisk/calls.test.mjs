// Unit test for the Calls model (www/js/pages/asterisk/callsmodel.js): grouping of CDR lines into calls, direction, parties, filter, summary and
// the "how long ago" text. Pure functions: no router and no browser. Usage: node calls.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/asterisk/callsmodel.js')).href);

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

const call = (id, o = {}) => ({ id, linked: id, start: 1000, answer: null, end: 1010, duration: 10, billsec: 0, disposition: 'NO ANSWER', src: '', dst: '', clid: '', context: '', app: 'Dial', channel: '', dstchannel: '', from_endpoint: null, to_endpoint: null, ...o });
const trunks = new Set(['Vodafone', 'Clouditalia']);

console.log('== results and names ==');
check(j(m.resultOf('ANSWERED')) === j(['Answered', 'success', 'answered']) && m.resultOf('NO ANSWER')[2] === 'missed' && m.resultOf('BUSY')[2] === 'missed' && m.resultOf('FAILED')[2] === 'failed' && m.resultOf('CONGESTION')[2] === 'failed', 'dispositions are grouped as answered, missed and failed');
check(m.resultOf('WEIRD')[0] === 'WEIRD' && m.resultOf('')[0] === '–', 'an unknown disposition is shown as it is');
check(j(m.splitClid('"Rossi, ""Gino""" <+390212345678>')) === j({ name: 'Rossi, "Gino"', number: '+390212345678' }) && j(m.splitClid('"" <>')) === j({ name: '', number: '' }) && m.splitClid('1001').number === '1001', 'the caller id is split into name and number');

console.log('== grouping ==');
const legs = [call('a', { linked: 'x', start: 100 }), call('b', { linked: 'x', start: 100, dstchannel: 'PJSIP/1001-0000000a', to_endpoint: '1001' }), call('c', { start: 300 }), call('d', { start: 200 })];
const grouped = m.groupCalls(legs);
check(grouped.map(c => c.id).join() === 'c,d,b' && grouped.find(c => c.id === 'b').legs === 2 && grouped[0].legs === 1, 'legs with one linked id are one call, the one with a called channel stands for it, newest first', j(grouped.map(c => [c.id, c.legs])));
check(m.groupCalls(null).length === 0, 'no history, no calls');

console.log('== direction and parties ==');
const incoming = call('i', { from_endpoint: 'Vodafone', to_endpoint: '1001', src: '+393331234567', dst: '+390691602383', clid: '"" <+393331234567>' });
const outgoing = call('o', { from_endpoint: '1001', to_endpoint: 'Vodafone', src: '1001', dst: '0612345678', clid: '"1001" <1001>' });
const internal = call('n', { from_endpoint: '1001', to_endpoint: '1002', src: '1001', dst: '1002' });
check(m.directionOf(incoming, trunks) === 'in' && m.directionOf(outgoing, trunks) === 'out' && m.directionOf(internal, trunks) === 'internal' && m.directionOf(internal, null) === null, 'direction from the trunk endpoints; unknown without them');
const p = m.partiesOf(outgoing);
check(p.from === '1001' && p.to === '0612345678' && p.toVia === 'Vodafone' && p.fromVia === '' && p.fromName === '', 'parties of an outgoing call', j(p));
const q = m.partiesOf(call('s', { src: '+39333', dst: 's', clid: '"Mario" <+39333>', from_endpoint: 'Vodafone', to_endpoint: '1001' }));
check(q.from === '+39333' && q.fromName === 'Mario' && q.fromVia === 'Vodafone' && q.to === '1001', 'a call to the start extension shows the endpoint it rang', j(q));
check(m.partiesOf(call('e')).from === '–' && m.partiesOf(call('e')).to === '–', 'nothing known shows dashes');
const d = m.partiesOf(call('d', { src: '+39333', dst: 's', did: '+390691602383', from_endpoint: 'Vodafone', to_endpoint: '1001' }));
check(d.to === '+390691602383' && d.toVia === '1001', 'an incoming call shows the number dialed, the endpoint it rang as via', j(d));
check(m.partiesOf(call('d', { dst: 's', did: '+3906', from_endpoint: 'Vodafone' })).toVia === '', 'no ringing endpoint, no via');
check(m.groupCalls([call('a', { linked: 'x', did: '+3906' }), call('b', { linked: 'x', dstchannel: 'PJSIP/1001-0000000a', to_endpoint: '1001' })])[0].did === '+3906', 'the dialed number of any leg is kept for the call');

console.log('== filter and summary ==');
const list = [incoming, { ...outgoing, disposition: 'ANSWERED', billsec: 60 }, { ...internal, disposition: 'BUSY' }, { ...outgoing, id: 'f', disposition: 'FAILED', dst: '0699' }];
const ids = (...a) => m.filterCalls(list, trunks, ...a).map(c => c.id).join();
check(ids('all') === 'i,o,n,f' && ids('in') === 'i' && ids('out') === 'o,f' && ids('internal') === 'n' && ids('missed') === 'i,n', 'the kinds', ids('missed'));
check(ids('all', '0612') === 'o' && ids('all', 'vodafone failed') === 'f' && ids('all', 'nothing') === '' && ids('all', '  ') === 'i,o,n,f', 'the text filter needs every word, in numbers, endpoints and result');
const s = m.summarize(list);
check(s.calls === 4 && s.answered === 1 && s.missed === 2 && s.failed === 1 && s.talk === 60, 'the summary counts by group and adds the talk time', j(s));

console.log('== how long ago ==');
check(m.ago(1000, 1010) === 'just now' && m.ago(1000, 1000 + 300) === '5 min ago' && m.ago(1000, 1000 + 3 * 3600) === '3 h ago' && m.ago(1000, 1000 + 2 * 86400) === '2 d ago' && m.ago(1000, 900) === 'just now', 'ago texts');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll Calls model checks passed');
