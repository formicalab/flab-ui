// Unit test for the Calls model (www/js/pages/asterisk/callsmodel.js): grouping of CDR lines into calls, direction, parties, filter, summary,
// the clock times, and the calls in progress (grouping by bridge, codecs, far end, direction, quality, hold, hangup). Pure functions: no router and no browser. Usage: node calls.test.mjs
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

console.log('== calls in progress ==');
const leg = (channel, o = {}) => ({ channel, bridge: 'b1', uniqueid: channel, duration: 10, formats: { native: ['ulaw'], read: 'ulaw', write: 'ulaw', read_transcode: false, write_transcode: false }, rtp: null, ...o });
const live = m.groupActive([leg('PJSIP/1001-a', { duration: 5 }), leg('PJSIP/V-b', { duration: 7 }), leg('PJSIP/1002-c', { bridge: '', duration: 2 }), leg('PJSIP/1003-d', { bridge: 'b2', duration: 30 })]);
check(live.map(c => c.legs.map(l => l.channel).join('+')).join() === 'PJSIP/1003-d,PJSIP/V-b+PJSIP/1001-a,PJSIP/1002-c', 'channels of one bridge are one call, a channel without a bridge is alone, the longest call first', j(live.map(c => c.id)));
check(live[1].duration === 7 && m.groupActive(null).length === 0, 'a call lasts as long as its longest channel; nothing in progress, no calls');
const withBridge = m.groupActive([leg('PJSIP/1001-a'), leg('PJSIP/1002-c', { bridge: '' })], [{ id: 'b1', technology: 'native_rtp' }]);
check(withBridge.find(c => c.id === 'b1').bridge.technology === 'native_rtp' && withBridge.find(c => c.id !== 'b1').bridge === null && m.BRIDGE_TEXT.native_rtp, 'a call gets the facts of its bridge, a channel in no bridge has none');
check(m.codecOf(leg('a')).text === 'ulaw' && !m.codecOf(leg('a')).differs, 'one codec when both directions agree');
check(m.codecOf(leg('a', { formats: { read: 'alaw', write: 'ulaw' } })).text === 'in alaw · out ulaw' && m.codecOf(leg('a', { formats: { read: 'alaw', write: 'ulaw' } })).differs, 'both are named when they differ');
check(m.codecOf(leg('a', { formats: undefined, rtp: { codec: 'g722' } })).text === 'g722' && m.codecOf(leg('a', { formats: undefined })).text === null, 'the RTP codec is the fallback, else none');
const tc = m.transcodingOf(leg('a', { formats: { read_transcode: 'alaw@8000->slin@8000', write_transcode: true } }));
check(tc.active && tc.detail === 'alaw@8000->slin@8000' && !m.transcodingOf(leg('a')).active && !m.transcodingOf({}).active, 'transcoding is told apart, with its path when Asterisk gave one');
check(m.lossText({ lost: 2, packets: 6250, loss_pct: 0 }) === '2 of 6250 lost (0%)' && m.lossText(null) === null, 'loss text');

console.log('== far end, direction, quality ==');
check(m.uriHost('sip:1001@192.168.1.50:5060;ob') === '192.168.1.50:5060' && m.uriHost('sip:+390691602383@ims.vodafone.it') === 'ims.vodafone.it' && m.uriHost('sip:1001@[2a01:827::1]:5060;ob') === '[2a01:827::1]:5060' && m.uriHost('sip:voip.example.it') === 'voip.example.it' && m.uriHost(null) === null, 'the host of a SIP URI');
const pj = { available: true, endpoints: [
  { name: '1001', role: 'phone', state: 'In use', channels: 1, contacts: [{ uri: 'sip:1001@192.168.1.50:5060;ob' }, { uri: 'sip:1001@192.168.1.50:5060;ob' }], identifies: [] },
  { name: 'Vodafone', role: 'trunk', state: 'In use', channels: 1, contacts: [{ uri: 'sip:+39069@ims.vodafone.it' }], identifies: [{ matches: ['10.174.0.36/32', '10.173.0.1/32', '10.0.0.1/32'] }] },
  { name: '1002', role: 'phone', state: 'On Hold', channels: 1, contacts: [], identifies: [] },
  { name: '1003', role: 'phone', state: 'On Hold', channels: 2, contacts: [], identifies: [] }] };
check(j(m.peerAddresses({ endpoint: '1001' }, pj)) === j(['192.168.1.50:5060']) && j(m.peerAddresses({ endpoint: 'Vodafone' }, pj)) === j(['ims.vodafone.it', '10.174.0.36/32', '10.173.0.1/32']) && m.peerAddresses({ endpoint: 'x' }, pj).length === 0 && m.peerAddresses({ endpoint: '1001' }, null).length === 0, 'the far end of a channel: contact hosts, then identifying addresses, no more than three, once each');
check(m.onHold({ endpoint: '1002' }, pj) && !m.onHold({ endpoint: '1001' }, pj) && !m.onHold({ endpoint: '1003' }, pj) && !m.onHold({ endpoint: '1002' }, null), 'a call is on hold when its endpoint says so and has only this channel');
const outgoingCall = { legs: [leg('PJSIP/Vodafone-b', { endpoint: 'Vodafone', app: 'AppDial' }), leg('PJSIP/1001-a', { endpoint: '1001', app: 'Dial' })] };
const incomingCall = { legs: [leg('PJSIP/1001-a', { endpoint: '1001', app: 'AppDial' }), leg('PJSIP/Vodafone-b', { endpoint: 'Vodafone', app: 'Dial' })] };
check(m.callerFirst(outgoingCall)[0].endpoint === '1001' && m.callerFirst(incomingCall)[0].endpoint === 'Vodafone', 'the channel that runs the dialplan is the caller and comes first');
check(m.directionOfActive(outgoingCall, trunks) === 'out' && m.directionOfActive(incomingCall, trunks) === 'in' && m.directionOfActive({ legs: [leg('a', { endpoint: '1001', app: 'Dial' }), leg('b', { endpoint: '1002', app: 'AppDial' })] }, trunks) === 'internal' && m.directionOfActive({ legs: [leg('PJSIP/Vodafone-b', { endpoint: 'Vodafone', app: 'Playback', bridge: '' })] }, trunks) === 'in' && m.directionOfActive(outgoingCall, null) === null, 'direction of a call in progress from the trunk endpoints');
const rtp = (o = {}) => ({ codec: 'alaw', uptime: '00:00:10', rx: { packets: 1000, lost: 0, loss_pct: 0, jitter: 0.002 }, tx: { packets: 1000, lost: 0, loss_pct: 0, jitter: 0.001 }, rtt: 0, ...o });
check(m.qualityOf(null) === null && m.qualityOf(rtp()).kind === 'success' && m.qualityOf(rtp({ rx: { packets: 1000, lost: 12, jitter: 0 } })).kind === 'warning' && m.qualityOf(rtp({ rx: { packets: 100, lost: 6, jitter: 0 } })).kind === 'danger' && m.qualityOf(rtp({ tx: { packets: 1000, lost: 0, jitter: 0.04 } })).kind === 'warning' && m.qualityOf(rtp({ rtt: 0.4 })).kind === 'danger', 'quality by loss, jitter and round trip; a loss under 1% is seen from the counts');
check(Math.abs(m.qualityOf(rtp({ rx: { packets: 1000, lost: 5, jitter: 0.012 } })).loss - 0.5) < 1e-9 && Math.abs(m.qualityOf(rtp({ rx: { packets: 1000, lost: 5, jitter: 0.012 } })).jitter - 12) < 1e-9, 'loss in percent and jitter in milliseconds');
const hist = new Map();
m.recordActive(hist, { available: true, channels: [leg('a', { rtp: rtp() }), leg('b', { rtp: null })] });
m.recordActive(hist, { available: true, channels: [leg('a', { rtp: rtp() })] }, 2);
m.recordActive(hist, { available: true, channels: [leg('a', { rtp: rtp() }), leg('c', { rtp: rtp() })] }, 2);
check(hist.get('a').length === 2 && hist.has('c') && !hist.has('b'), 'jitter history per channel, kept short, dropped when the channel is gone', j([...hist.keys()]));
check(m.hangupKind(null) === null && m.hangupKind(300) === null && m.hangupKind(60) === 'warning' && m.hangupKind(15) === 'danger' && m.hangupKind(-3) === 'danger', 'a hangup within a minute warns, within 15 s is urgent');
const sum = m.summarizeActive([outgoingCall, { legs: [leg('PJSIP/1002-z', { endpoint: '1002', bridge: '', formats: { native: ['alaw'], read: 'alaw', write: 'slin', write_transcode: true } })] }], trunks, pj);
check(sum.calls === 2 && sum.channels === 3 && sum.out === 1 && sum.internal === 1 && sum.transcoding === 1 && sum.between === 0 && sum.held === 1, 'the tiles count calls by direction, converting channels and calls on hold', j(sum));

console.log('== clock times ==');
const at = new Date(2026, 10, 25, 13, 2, 10).getTime() / 1000;
check(m.stamp(at) === '2026-11-25 13:02:10' && m.stamp(at + 75, at) === '13:03:25' && m.stamp(at + 86400, at) === '2026-11-26 13:02:10' && m.stamp(null) === '', 'start and end as clock times, the end without its date on the same day');

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll Calls model checks passed');
