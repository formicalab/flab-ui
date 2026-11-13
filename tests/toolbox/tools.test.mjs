// Unit test of the Toolbox's newer tools (www/js/pages/toolbox/{iperfmodel,dnstracemodel,pathmodel}.js and the requests the
// form builds for them): the iperf3 server's events, the DNS trace's blocks, the mtr table and the AS data of a traceroute.
// The fixtures in fixtures/ are real output captured on the GL-MT6000 (2026-11-13): iperf3 3.22 with --json-stream, the trace
// script's job output for five names, mtr --raw, and a traceroute with AS lookups. Pure functions: no router and no browser.
// Usage: node tools.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Imports the page module `f` from www/js/pages/toolbox.
const mod = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/toolbox', f)).href);
// The text of the real capture fixtures/`f`, with LF line endings.
const fixture = f => fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', f), 'utf8').replace(/\r/g, '');
const m = await mod('diagmodel.js');
const ip = await mod('iperfmodel.js');
const dt = await mod('dnstracemodel.js');
const pm = await mod('pathmodel.js');

let failed = 0;
// Prints PASS or FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// A blank form aimed at a host, with `over` applied on top.
const form = over => ({ ...m.blankForm(), host: 'www.example.com', ...over });
// Whether `a` and `b` are equal within `eps`.
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('== requests for the new tools ==');
let r = m.requestOf(form({ tool: 'mtr' }));
check(j(r.args) === j({ tool: 'mtr', host: 'www.example.com', cycles: 10 }), 'mtr asks for the host and the number of rounds (ICMP is the default and is not sent)', j(r));
r = m.requestOf(form({ tool: 'mtr', cycles: '20', mtrMethod: 'udp', family: '6', source: 'br-lan', count: '999' }));
check(j(r.args) === j({ tool: 'mtr', host: 'www.example.com', cycles: 20, method: 'udp', family: '6' }), 'mtr sends UDP and the family, but no source and none of the ping fields', j(r));
check(m.requestOf(form({ tool: 'mtr', cycles: '2' })).error && m.requestOf(form({ tool: 'mtr', cycles: '61' })).error && m.requestOf(form({ tool: 'mtr', host: '' })).error && m.requestOf(form({ tool: 'mtr', host: '1.1.1.1; reboot' })).error, 'mtr refuses rounds outside 3 to 60 and a bad host');
r = m.requestOf(form({ tool: 'trace', type: 'AAAA', family: '6', server: '9.9.9.9', source: 'wan' }));
check(j(r.args) === j({ tool: 'trace', host: 'www.example.com', type: 'AAAA', family: '6' }), 'a DNS trace asks for the name, the type and the family only', j(r));
check(j(m.requestOf(form({ tool: 'trace' })).args) === j({ tool: 'trace', host: 'www.example.com', type: 'A' }) && m.requestOf(form({ tool: 'trace', host: '' })).error && m.requestOf(form({ tool: 'trace', host: '$(id)' })).error, 'the trace defaults to type A (IPv4 is not sent) and needs a safe name');
r = m.requestOf(form({ tool: 'iperf', host: '' }));
check(j(r.args) === j({ tool: 'iperf', minutes: 2 }), 'the iperf3 server needs no host, runs 2 minutes by default and leaves the default port out', j(r));
r = m.requestOf(form({ tool: 'iperf', host: 'ignored; reboot', minutes: '15', iperfPort: '5300', bind: '192.168.1.1' }));
check(j(r.args) === j({ tool: 'iperf', minutes: 15, port: 5300, bind: '192.168.1.1' }), 'minutes, a different port and one address to listen on are sent; the host field is ignored', j(r));
check([m.requestOf(form({ tool: 'iperf', minutes: '3' })), m.requestOf(form({ tool: 'iperf', minutes: '0' })), m.requestOf(form({ tool: 'iperf', iperfPort: '80' })), m.requestOf(form({ tool: 'iperf', iperfPort: '70000' })), m.requestOf(form({ tool: 'iperf', iperfPort: 'x' })), m.requestOf(form({ tool: 'iperf', bind: 'lan' })), m.requestOf(form({ tool: 'iperf', bind: '1.2.3.4; reboot' }))].every(x => x.error), 'the iperf3 server refuses a time that is not offered, a port below 1024 or above 65535, and an address that is not one');
check(m.IPERF_MINUTES.join() === '2,1,5,15,30' && m.blankForm().minutes === '2' && m.blankForm().iperfPort === '5201', 'the times offered and the defaults');
check(m.scriptProblem({ tool: 'trace', text: '', running: false, exit: 0 }) === 'The job produced no output.' && m.scriptProblem({ tool: 'traceroute', asn: true, text: '', running: false, exit: 0 }) === 'The job produced no output.' && m.scriptProblem({ tool: 'traceroute', text: '', running: false, exit: 0 }) === null, 'a trace and a traceroute with AS lookups are scripts; a plain traceroute is not');
check(m.endOf({ tool: 'iperf', timedOut: true }, 120).text === 'Time is up' && m.endOf({ tool: 'iperf', exit: 0, stopRequested: true }, 120).kind === 'stopped' && m.endOf({ tool: 'ping', timedOut: true }, 25).kind === 'limit', 'an iperf3 server that runs out of time ended normally; one the user stopped says so; other tools hit a limit');

console.log('== iperf3: formatting ==');
check(ip.fmtBitrate(6.65e9) === '6.65 Gbit/s' && ip.fmtBitrate(941e6) === '941 Mbit/s' && ip.fmtBitrate(12.34e6) === '12.3 Mbit/s' && ip.fmtBitrate(812e3) === '812 kbit/s' && ip.fmtBitrate(0) === '0.00 bit/s' && ip.fmtBitrate(null) === '–', 'bit rates in the unit that keeps them readable, with three digits');
check(ip.fmtClock(125) === '2:05' && ip.fmtClock(0) === '0:00' && ip.fmtClock(-3) === '0:00' && ip.remaining(120, 30.4) === 90 && ip.remaining(60, 99) === 0, 'the countdown');
check(ip.clientCommand('192.168.1.1') === 'iperf3 -c 192.168.1.1' && ip.clientCommand('192.168.1.1', { reverse: true, port: 5300 }) === 'iperf3 -c 192.168.1.1 -p 5300 -R' && ip.clientCommand('10.0.0.1', { udp: true, rate: '500M', streams: 4 }) === 'iperf3 -c 10.0.0.1 -u -b 500M -P 4', 'the commands a client runs');

console.log('== iperf3: the events of the server ==');
const tests = ip.parseIperf(fixture('iperf-tests.txt'));
check(tests.tests.length === 4 && tests.version === 'iperf 3.22' && tests.errors.length === 0, 'four tests and the version are read', j(tests.tests.map(t => t.protocol)));
let t = tests.tests[0];
check(t.protocol === 'TCP' && t.direction === 'upload' && !t.reverse && t.streams === 2 && t.duration === 2 && t.client.host === '127.0.0.1' && t.client.port === 54956 && t.startedAt === 1794552177000 && t.done && !t.aborted, 'a TCP upload with two streams: who, how and when', j(t));
check(t.intervals.length === 2 && t.intervals[0].t0 === 0 && near(t.intervals[0].t1, 1.007971) && near(t.intervals[1].t1, 2.001199) && t.intervals[0].bps > 6e9 && t.intervals.every(x => x.retransmits === null), 'one point per second; the sliver iperf3 prints at the end is left out', j(t.intervals));
check(near(t.summary.bps, 6983634598.42, 1) && t.summary.bytes === 1747582976 && near(t.summary.seconds, 2.001918) && t.summary.jitter === null && t.summary.cpuServer > 100, 'the totals are what the receiver (the router) measured, with the router\'s CPU use', j(t.summary));
t = tests.tests[1];
check(t.protocol === 'UDP' && t.direction === 'upload' && t.target === 20000000 && t.intervals.length === 2 && near(t.intervals[0].jitter, 0.022, 0.01) && t.intervals[0].lost === 0 && t.intervals[0].packets === 77, 'a UDP test with its target rate, jitter, and loss per second', j(t.intervals[0]));
check(t.summary.lost === 0 && t.summary.packets === 153 && t.summary.lostPct === 0 && near(t.summary.jitter, 0.0185, 1e-3) && t.summary.retransmits === null && near(t.summary.bps, 20039347.2, 1), 'UDP totals: loss, packets and jitter instead of retransmits', j(t.summary));
t = tests.tests[2];
check(t.reverse && t.direction === 'download' && t.protocol === 'TCP' && t.intervals.every(x => x.retransmits === 0) && t.summary.retransmits === 0, 'a reverse test (iperf3 -R) is a download, and shows the retransmits of the router sending', j(t.summary));
check(tests.tests[3].protocol === 'UDP' && tests.tests[3].intervals.length === 1 && tests.tests[3].summary.bps > 1e8, 'a fast UDP test');
const aborted = ip.parseIperf(fixture('iperf-aborted.txt'));
check(aborted.tests.length === 2 && aborted.tests[0].aborted && aborted.tests[0].error === 'the client has terminated' && aborted.tests[0].intervals.length === 1 && !aborted.tests[1].aborted && aborted.tests[1].done, 'a client that goes away: the test is interrupted with iperf3\'s reason, the repeated last interval is dropped, and the next test is fine', j(aborted.tests.map(x => [x.aborted, x.error, x.intervals.length])));
const busy = ip.parseIperf(fixture('iperf-portbusy.txt'));
check(busy.tests.length === 0 && j(busy.errors) === j(['unable to start listener for connections: Address in use']), 'a port that is taken is an error of the server, worded without iperf3\'s prefix', j(busy));
const live = fixture('iperf-tests.txt').split('\n').slice(0, 2).join('\n') + '\n{"event":"interval","data":{"stre';
const running = ip.parseIperf(live);
check(running.tests.length === 1 && !running.tests[0].done && !running.tests[0].aborted && running.tests[0].summary === null && running.tests[0].intervals.length === 1, 'a test that is still running has points but no totals, and a half-written last line is ignored', j(running));
check(ip.parseIperf('iperf3: error - unable to start listener for connections: Address already in use\n').errors.length === 1 && ip.parseIperf('').tests.length === 0 && ip.parseIperf(null).errors.length === 0, 'a plain-text error counts, and no output is no tests');
check(ip.describeTest(tests.tests[0]) === 'Upload · TCP · 2 streams' && ip.describeTest(tests.tests[2]) === 'Download · TCP', 'a test is described by direction, protocol and streams');

console.log('== DNS trace: one query ==');
const kdig = dt.parseKdig(`;; ->>HEADER<<- opcode: QUERY; status: NOERROR; id: 24481
;; Flags: qr aa; QUERY: 1; ANSWER: 3; AUTHORITY: 0; ADDITIONAL: 1

;; QUESTION SECTION:
;; www.example.com.    \t\tIN\tA

;; ANSWER SECTION:
www.example.com.    \t300\tIN\tA\t172.66.147.243
www.example.com.    \t300\tIN\tRRSIG\tA 13 3 300 20261114074424 20261112054424 34505 example.com. O9et0PGYqjyVyRG2

;; Received 183 B
;; Time 2026-11-13 07:44:24 CET
;; From 108.162.192.162@53(UDP) in 5.1 ms
`);
check(kdig.rcode === 'NOERROR' && j(kdig.flags) === '["qr","aa"]' && kdig.answer.length === 2 && kdig.answer[0].type === 'A' && kdig.answer[0].ttl === 300 && kdig.answer[0].data === '172.66.147.243' && kdig.rttMs === 5.1 && kdig.bytes === 183 && kdig.from.address === '108.162.192.162' && kdig.from.proto === 'UDP', 'kdig\'s answer: the status, flags, records, size, who answered and how long it took', j(kdig));
// One block of the DNS trace script's output: step `n` against a server of the zone test., with `body` as kdig's output.
const step = (n, body, end = 0) => `### BEGIN step 100.0 ${n} 192.0.2.1 ns.test. test.\n${body}\n### END ${end} 103.0\n`;
const lost = dt.parseDnsTrace(step(1, ';; WARNING: response timeout for 192.0.2.1@53(UDP)\n;; ERROR: failed to query server 192.0.2.1@53(UDP)', 1), { name: 'x.test', type: 'A' });
check(lost.segments[0].steps[0].kind === 'timeout' && lost.outcome === 'timeout' && lost.segments[0].steps[0].problem.startsWith('response timeout'), 'a server that does not answer is a timeout, with kdig\'s words', j(lost.segments[0].steps[0]));
const refused = dt.parseDnsTrace(step(1, ';; ->>HEADER<<- opcode: QUERY; status: REFUSED; id: 38896\n;; Flags: qr; QUERY: 1; ANSWER: 0; AUTHORITY: 0; ADDITIONAL: 0\n\n;; Received 35 B\n;; From 192.0.2.1@53(UDP) in 5.5 ms'), { name: 'x.test', type: 'A' });
check(refused.segments[0].steps[0].kind === 'refused' && dt.stepVerdict(refused.segments[0].steps[0]).join() === 'danger,Refused' && dt.zoneLabel('.') === '. (root)' && dt.zoneLabel('com.') === 'com', 'a refusal, its words, and the label of the root zone');

console.log('== DNS trace: whole traces ==');
let tr = dt.parseDnsTrace(fixture('trace-example.txt'), { name: 'www.example.com', type: 'A' });
let steps = tr.segments[0].steps;
check(tr.segments.length === 1 && steps.length === 3 && j(steps.map(s => s.kind)) === '["referral","referral","answer"]' && j(steps.map(s => s.zone)) === '[".","com.","example.com."]' && steps[0].server === 'a.root-servers.net' && steps[1].server === 'l.gtld-servers.net.' && steps[0].address === '198.41.0.4' && tr.done && tr.outcome === 'answer', 'a plain trace: root, .com, then the zone\'s own server answers', j(steps.map(s => [s.kind, s.zone, s.server])));
check(steps[0].delegatedTo === 'com.' && steps[0].nameServers.length === 13 && steps[0].nameServers.every(n => n.glue.length === 2) && steps[0].rttMs === 19.4 && steps[0].proto === 'UDP', 'the root refers to the 13 .com servers, each with its IPv4 and IPv6 address, in 19.4 ms');
check(steps[0].signedDelegation && steps[0].ds[0].tag === 19718 && steps[0].ds[0].algorithm === 'ECDSAP256SHA256' && steps[0].ds[0].digest === 'SHA-256' && steps[1].ds[0].tag === 2371 && steps[1].delegatedTo === 'example.com.' && steps[1].nameServers.length === 2, 'the DS records of the signed delegations are read with their algorithm and digest');
check(steps[2].authoritative && steps[2].answer.length === 2 && steps[2].answer.every(a => a.type === 'A') && steps[2].signed && steps[2].signatures[0].signer === 'example.com.' && steps[2].signatures[0].tag === 34505 && steps[2].signatures[0].expires === 1794643040000, 'the final answer is authoritative and signed, with the signer, key and expiry', j(steps[2].signatures));
check(near(tr.networkMs, 19.4 + 18.7 + 5.6, 0.01) && tr.dnssec.level === 'signed' && tr.dnssec.signed === 2 && tr.dnssec.total === 2 && tr.dnssec.answerSigned && tr.dnssec.validatedByResolver === true, 'the network time adds up and the chain of trust is complete', j(tr.dnssec));
check(tr.resolver.ad && tr.resolver.rcode === 'NOERROR' && tr.resolver.rttMs === 9.3 && tr.resolver.ttl === 300 && tr.resolver.sameAnswer === true && tr.resolver.records.length === 2, 'the router\'s own resolver validated the answer and gave the same records');

tr = dt.parseDnsTrace(fixture('trace-ibm.txt'), { name: 'www.ibm.com', type: 'A' });
check(tr.segments.length === 3 && j(tr.segments.map(s => s.steps.length)) === '[3,3,4]' && tr.segments[1].aliasOf === 'www.ibm.com' && tr.segments[1].name === 'outer-global-dual.ibmcom-tls12.edgekey.net.' && tr.segments[2].aliasOf === 'outer-global-dual.ibmcom-tls12.edgekey.net.' && tr.outcome === 'answer', 'two aliases are followed, each starting over from the root', j(tr.segments.map(s => [s.name, s.aliasOf, s.steps.length])));
steps = tr.segments[0].steps;
check(steps[1].kind === 'referral' && steps[1].delegatedTo === 'ibm.com.' && steps[1].nameServers.length === 4 && steps[1].nameServers.every(n => n.glue.length === 0) && !steps[1].signedDelegation, 'a delegation with no addresses and no DS record: name servers without glue, an unsigned delegation');
check(steps[2].kind === 'cname' && steps[2].server === 'dns1.p05.nsone.net.' && steps[2].lookup.address === '198.51.44.5' && steps[2].answer[0].type === 'CNAME' && steps[2].answer[0].data === 'outer-global-dual.ibmcom-tls12.edgekey.net.', 'the server found by a lookup (its address came from the router\'s resolver) answers with an alias', j(steps[2].lookup));
check(tr.dnssec.level === 'partial' && tr.resolver.sameAnswer === false && !tr.resolver.ad, 'the chain is not complete, and a CDN\'s changing addresses differ from the resolver\'s', j([tr.dnssec, tr.resolver.sameAnswer]));

tr = dt.parseDnsTrace(fixture('trace-github.txt'), { name: 'www.github.com', type: 'A' });
steps = tr.segments[0].steps;
check(tr.segments.length === 1 && steps[2].kind === 'answer' && j(steps[2].answer.map(a => a.type)) === '["CNAME","A"]' && steps[1].nameServers.length === 8 && steps[1].nameServers.filter(n => n.glue.length).length === 1 && tr.resolver.sameAnswer === true, 'an alias inside the zone is answered in one step; only one of eight name servers came with an address', j(steps[1].nameServers.map(n => n.glue.length)));

tr = dt.parseDnsTrace(fixture('trace-nxdomain.txt'), { name: 'nope-flab-test.example.com', type: 'A' });
steps = tr.segments[0].steps;
check(steps[2].kind === 'nxdomain' && steps[2].soa.name === 'example.com.' && steps[2].soa.data.startsWith('elliott.ns.cloudflare.com.') && steps[2].signed && tr.outcome === 'nxdomain' && tr.dnssec.level === 'signed' && tr.resolver.records.length === 0, 'a name that does not exist: Cloudflare\'s compact denial (NOERROR with NSEC NXNAME) is read as nxdomain, with the zone\'s SOA and its signature', j(steps[2]));

tr = dt.parseDnsTrace(fixture('trace-v6.txt'), { name: 'www.example.com', type: 'AAAA' });
check(tr.segments[0].steps[0].address === '2001:503:ba3e::2:30' && tr.segments[0].steps[2].answer.every(a => a.type === 'AAAA') && tr.outcome === 'answer', 'over IPv6 the servers and the answer are IPv6');

tr = dt.parseDnsTrace(fixture('trace-example.txt').split('\n').slice(0, 12).join('\n'), { name: 'www.example.com', type: 'A' });
check(tr.segments[0].steps.length === 1 && tr.segments[0].steps[0].kind === 'running' && !tr.done && tr.outcome === null && tr.resolver === null && tr.dnssec.level !== null, 'a trace that is still running shows the step being asked and no outcome', j(tr.segments[0].steps.map(s => s.kind)));
check(dt.parseDnsTrace('', { name: 'x', type: 'A' }).segments[0].steps.length === 0 && dt.parseDnsTrace('', { name: 'x', type: 'A' }).dnssec.level === null, 'no output yet is an empty trace');

console.log('== mtr and AS data ==');
const mt = pm.parseMtr(fixture('mtr.txt'), false);
check(mt.hops.length === 7 && mt.reached && j(mt.hops.map(x => x.addr)) === '["37.179.98.1",null,null,"185.210.48.76","185.210.48.77","172.68.196.21","1.1.1.1"]', 'seven hops, the destination\'s repeats are cut, silent hops have no address', j(mt.hops.map(x => x.addr)));
check(mt.hops[0].sent === 6 && mt.hops[0].recv === 6 && mt.hops[0].lossPct === 0 && near(mt.hops[0].best, 3.8, 0.2) && mt.hops[0].worst > mt.hops[0].avg && mt.hops[0].stdev > 0 && mt.hops[0].history.length === 6, 'a hop\'s sent and received probes, loss, best, average, worst and spread');
check(mt.hops[1].recv === 0 && mt.hops[1].lossPct === 100 && mt.hops[1].avg === null && pm.lossKind(mt.hops[1], mt.hops) === 'silent', 'a hop that never answers while later ones do is silent');
check(mt.hops[4].lossPct === 33.3 && pm.lossKind(mt.hops[4], mt.hops) === 'limited' && pm.lossKind(mt.hops[0], mt.hops) === '' && pm.lossKind(mt.hops[6], mt.hops) === '', 'loss at a middle hop that the destination does not share is rate limiting', j(mt.hops[4]));
const notes = pm.pathNotes(mt.hops, false);
check(notes.some(n => n.level === 'ok' && /No probe to the destination was lost/.test(n.text)) && notes.some(n => /Hop 5 .* limits its own replies/.test(n.text)) && pm.pathNotes(mt.hops, true).every(n => !/destination/.test(n.text)), 'the findings say the destination lost nothing and explain the middle hop, and wait for the end of the run');
const fake = pm.parseMtr('x 0 1\nh 0 10.0.0.1\np 0 1000 1\nx 1 1\nh 1 20.0.0.1\np 1 90000 1\nx 0 2\nx 1 2\n', true);
check(fake.hops[0].sent === 2 && fake.hops[0].lossPct === 0 && fake.hops[1].lossPct === 0 && pm.parseMtr('x 0 1\nh 0 10.0.0.1\np 0 1000 1\nx 0 2\n', false).hops[0].lossPct === 50, 'the probe still in flight is not counted as lost while the run goes on, and is once it has ended');
check(pm.pathNotes(fake.hops, false).some(n => /delay rises by 89 ms between hop 1 and hop 2/.test(n.text)) && pm.parseMtr('', false).hops.length === 0 && pm.parseMtr('mtr: failed to start', false).error === 'mtr: failed to start', 'a jump in delay is pointed out; no output is no hops; a failure is reported');

const asn = pm.parseAsn(fixture('traceroute-asn.txt'));
check(asn.any && !asn.pending && asn.byAddr.get('37.179.98.1').asn === '30722' && asn.byAddr.get('37.179.98.1').prefix === '37.179.96.0/19' && asn.byAddr.get('37.179.98.1').country === 'IT' && asn.byAddr.get('37.179.98.1').registry === 'ripencc', 'the origin of an address: AS number, prefix, country and registry', j([...asn.byAddr.entries()][0]));
check(asn.byAddr.get('185.210.48.76').asn === null && asn.byAddr.get('185.210.48.76').name === null && asn.byAddr.get('1.1.1.1').asn === '13335' && asn.byAddr.get('1.1.1.1').name === 'CLOUDFLARENET - Cloudflare, Inc., US', 'an address without an origin record has no AS; names are joined from the AS name lookups');
check(j(pm.asName('CLOUDFLARENET - Cloudflare, Inc., US')) === j({ short: 'CLOUDFLARENET', org: 'Cloudflare, Inc.' }) && pm.asName('Plain Name, IT').org === 'Plain Name' && pm.asName(null).org === null, 'an AS name is split into its short name and the organization');
const hops = m.parseTraceroute(fixture('traceroute-asn.txt')).hops;
check(hops.length === 7 && j(pm.asPath(hops, asn).map(p => [p.asn, p.name])) === j([['30722', 'Fastweb SpA'], ['13335', 'Cloudflare, Inc.']]), 'the traceroute inside the script job is still read, and the networks it crosses are listed in order', j(pm.asPath(hops, asn)));
check(pm.parseAsn(fixture('traceroute-asn.txt').split('### END')[0]).any === false && pm.parseAsn('### BEGIN trace 1.0 \n### END 0 2.0\n### BEGIN asn 2.0 8.8.8.8\n').pending, 'lookups still running are pending');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall new-tool checks passed');
process.exit(failed ? 1 : 0);
