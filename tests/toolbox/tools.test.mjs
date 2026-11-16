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
check(j(r.args) === j({ tool: 'mtr', host: 'www.example.com', cycles: 10, asn: true }), 'mtr asks for the host, the number of rounds and the AS lookup (ICMP, addresses only and no port or size are not sent)', j(r));
r = m.requestOf(form({ tool: 'mtr', asn: '' }));
check(j(r.args) === j({ tool: 'mtr', host: 'www.example.com', cycles: 10 }), 'mtr without the AS lookup is just the host and the rounds', j(r));
r = m.requestOf(form({ tool: 'mtr', asn: '', cycles: '20', mtrMethod: 'udp', family: '6', source: 'br-lan', resolve: '1', mtrSize: '100', count: '999' }));
check(j(r.args) === j({ tool: 'mtr', host: 'www.example.com', cycles: 20, method: 'udp', size: 100, resolve: true, family: '6', source: 'br-lan' }), 'mtr sends UDP, the size, the names switch, the family and the source, but none of the ping fields', j(r));
r = m.requestOf(form({ tool: 'mtr', asn: '', mtrMethod: 'tcp', mtrPort: '443', mtrSize: '100', source: '192.168.1.1' }));
check(j(r.args) === j({ tool: 'mtr', host: 'www.example.com', cycles: 10, method: 'tcp', port: 443, source: '192.168.1.1' }), 'mtr over TCP sends the port and an address as the source, and no size (SYN packets carry none)', j(r));
r = m.requestOf(form({ tool: 'mtr', asn: '', mtrPort: '443', mtrSize: '100' }));
check(j(r.args) === j({ tool: 'mtr', host: 'www.example.com', cycles: 10, size: 100 }), 'with ICMP the port is not sent', j(r));
check(m.requestOf(form({ tool: 'mtr', cycles: '2' })).error && m.requestOf(form({ tool: 'mtr', cycles: '61' })).error && m.requestOf(form({ tool: 'mtr', host: '' })).error && m.requestOf(form({ tool: 'mtr', host: '1.1.1.1; reboot' })).error, 'mtr refuses rounds outside 3 to 60 and a bad host');
check(m.requestOf(form({ tool: 'mtr', mtrSize: '27' })).error && m.requestOf(form({ tool: 'mtr', mtrSize: '1401' })).error && m.requestOf(form({ tool: 'mtr', mtrSize: 'x' })).error && m.requestOf(form({ tool: 'mtr', mtrMethod: 'tcp', mtrPort: '0' })).error && m.requestOf(form({ tool: 'mtr', mtrMethod: 'tcp', mtrPort: '70000' })).error && m.requestOf(form({ tool: 'mtr', source: 'br lan' })).error, 'mtr refuses a size outside 28 to 1400, a port outside 1 to 65535 and a bad source');
r = m.requestOf(form({ tool: 'check', host: '', checkPort: '25' }));
check(j(r.args) === j({ tool: 'check', port: 25 }) && j(m.requestOf(form({ tool: 'check', checkPort: '8443' })).args) === j({ tool: 'check', host: 'www.example.com', port: 8443 }) && j(m.requestOf(form({ tool: 'check', checkPort: '443' })).args) === j({ tool: 'check', host: 'www.example.com' }) && j(m.requestOf(form({ tool: 'check', host: '' })).args) === j({ tool: 'check' }), 'the connectivity check sends a port other than 443, and none for 443 or an empty field', j(r));
check(m.requestOf(form({ tool: 'check', checkPort: '0' })).error && m.requestOf(form({ tool: 'check', checkPort: '65536' })).error && m.requestOf(form({ tool: 'check', checkPort: '25; reboot' })).error, 'the check refuses a port outside 1 to 65535 and one that is not a number');
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
const term = ip.parseIperf(fixture('iperf-terminated.txt'));
const termMid = ip.parseIperf(fixture('iperf-tests.txt').split('\n').slice(0, 2).join('\n') + '\n' + fixture('iperf-terminated.txt'));
check(term.errors.length === 0 && term.terminated && term.tests.length === 0 && termMid.errors.length === 0 && termMid.terminated && termMid.tests[0].aborted && termMid.tests[0].error === null, 'a server ended by a signal (Stop or the end of its time) is not an error, with or without a test running', j([term, termMid.errors]));
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
const named = pm.parseMtr('x 0 1\nh 0 10.0.0.1\nd 0 gw.example.net\np 0 1000 1\nx 1 1\nh 1 20.0.0.1\nd 1 20.0.0.1\np 1 2000 1\nx 2 1\nh 2 30.0.0.1\n', false);
check(named.hops[0].name === 'gw.example.net' && named.hops[1].name === null && named.hops[2].name === null && mt.hops.every(x => x.name === null), 'a hop with a name from mtr has it, one that mtr could only name by its address or has no name for has none');
check(pm.asPath(named.hops, { byAddr: new Map([['10.0.0.1', { asn: '64500', name: 'EXAMPLE - Example Net, US', country: 'US' }], ['20.0.0.1', { asn: '64500', name: 'EXAMPLE - Example Net, US', country: 'US' }], ['30.0.0.1', { asn: '64501', name: 'OTHER - Other Ltd, DE', country: 'DE' }]]) }).map(p => p.asn).join() === '64500,64501', 'the networks of an mtr path are read from its hops\' addresses, one entry per run of hops in the same network');
const withAsn = fixture('mtr.txt') + '### BEGIN asn 9.0 1.1.1.1\n"13335 | 1.1.1.0/24 | AU | apnic | 2011-08-11"\n### END 0 9.5\n';
check(pm.parseMtr(withAsn, false).hops.length === 7 && pm.parseAsn(withAsn).byAddr.get('1.1.1.1').asn === '13335', 'the AS blocks that follow mtr\'s output in a script job do not disturb its table');

const asn = pm.parseAsn(fixture('traceroute-asn.txt'));
check(asn.any && !asn.pending && asn.byAddr.get('37.179.98.1').asn === '30722' && asn.byAddr.get('37.179.98.1').prefix === '37.179.96.0/19' && asn.byAddr.get('37.179.98.1').country === 'IT' && asn.byAddr.get('37.179.98.1').registry === 'ripencc', 'the origin of an address: AS number, prefix, country and registry', j([...asn.byAddr.entries()][0]));
check(asn.byAddr.get('185.210.48.76').asn === null && asn.byAddr.get('185.210.48.76').name === null && asn.byAddr.get('1.1.1.1').asn === '13335' && asn.byAddr.get('1.1.1.1').name === 'CLOUDFLARENET - Cloudflare, Inc., US', 'an address without an origin record has no AS; names are joined from the AS name lookups');
check(j(pm.asName('CLOUDFLARENET - Cloudflare, Inc., US')) === j({ short: 'CLOUDFLARENET', org: 'Cloudflare, Inc.' }) && pm.asName('Plain Name, IT').org === 'Plain Name' && pm.asName(null).org === null, 'an AS name is split into its short name and the organization');
const hops = m.parseTraceroute(fixture('traceroute-asn.txt')).hops;
check(hops.length === 7 && j(pm.asPath(hops, asn).map(p => [p.asn, p.name])) === j([['30722', 'Fastweb SpA'], ['13335', 'Cloudflare, Inc.']]), 'the traceroute inside the script job is still read, and the networks it crosses are listed in order', j(pm.asPath(hops, asn)));
check(pm.parseAsn(fixture('traceroute-asn.txt').split('### END')[0]).any === false && pm.parseAsn('### BEGIN trace 1.0 \n### END 0 2.0\n### BEGIN asn 2.0 8.8.8.8\n').pending, 'lookups still running are pending');
const cut = fixture('traceroute-asn-timeout.txt');
const asn2 = pm.parseAsn(cut);
check(asn2.byAddr.get('37.179.98.1').asn === '30722' && asn2.byAddr.get('37.179.98.1').net === null && asn2.byAddr.get('185.210.48.132').asn === null && j(asn2.byAddr.get('185.210.48.132').net) === j({ range: '185.210.48.0 - 185.210.48.255', netname: 'VODAFONE-IT', country: 'IT', descr: null }), 'an address no AS announces is described by the registry\'s record of its range (here the router\'s next hop at Fastweb, a trace that hit its time limit with 13 silent hops)', j([...asn2.byAddr.entries()]));
check(m.parseTraceroute(cut).hops.length === 17 && m.parseTraceroute(cut).hops[3].addrs[0] === '185.210.48.132' && pm.parseAsn(cut.split('### BEGIN net')[0] + '### BEGIN net 1.0 185.210.48.132\n').pending && pm.parseAsn('### BEGIN asn 1.0 8.8.8.8\n\n### END 0 2.0\n### BEGIN net 2.0 8.8.8.8\nnetname:        NON-RIPE-NCC-MANAGED-ADDRESS-BLOCK\n\n### END 0 3.0\n').byAddr.get('8.8.8.8').net === null, 'the trace that was cut by its time limit is still read; a whois answer for a range the registry does not manage says nothing; a running whois is pending');

console.log('== networks along an mtr path ==');
// A hop as parseMtr gives it: `avg` in ms, `loss` in percent (the hop answers unless avg is null).
const hop = (n, addr, avg, loss = 0) => ({ n, addr, addrs: addr ? [addr] : [], name: null, sent: 10, recv: avg == null ? 0 : Math.round(10 * (1 - loss / 100)), lossPct: avg == null ? 100 : loss, last: avg, avg, best: avg, worst: avg, stdev: 0, history: [] });
// The AS data of `list` ([address, AS number, name]) in the shape parseAsn gives.
const asnOf = list => ({ byAddr: new Map(list.map(([a, n, name, net]) => [a, { asn: n, name: name ?? null, country: n ? 'US' : null, prefix: null, registry: null, net: net ?? null }])), asns: new Map(), pending: false, any: true });
const fixtureMtr = pm.parseMtr(fixture('mtr.txt'), false).hops;
const segs = pm.networkSegments(fixtureMtr, asn);
check(segs.length === 3 && segs[0].asn === '30722' && segs[0].org === 'Fastweb SpA' && segs[0].first === 1 && segs[0].last === 1 && segs[1].gap && segs[1].first === 2 && segs[1].last === 5 && segs[2].asn === '13335' && segs[2].org === 'Cloudflare, Inc.' && segs[2].first === 6 && segs[2].last === 7, 'the real path is the ISP, a stretch that never answers, and Cloudflare', j(segs.map(s => [s.key, s.first, s.last])));
check(near(segs[0].addMs, fixtureMtr[0].avg) && segs[1].addMs != null && segs[2].endMs === fixtureMtr[6].avg && segs[0].loss === null && segs[2].loss === null, 'each network adds the delay between the last hop before it and its own last hop; the gap\'s hops that answered count for the gap', j(segs.map(s => [s.addMs, s.endMs])));
const same = pm.networkSegments([hop(1, 'a', 5), hop(2, null, null), hop(3, 'c', 7)], asnOf([['a', '1', 'ONE - One Net, US'], ['c', '1', 'ONE - One Net, US']]));
check(same.length === 1 && same[0].first === 1 && same[0].last === 3, 'a silent hop between two hops of the same network belongs to it');
const unann = pm.networkSegments([hop(1, 'a', 5), hop(2, 'b', 6), hop(3, 'c', 7)], asnOf([['a', '1', 'ONE - One Net, US'], ['b', null, null, { netname: 'VODAFONE-IT', country: 'IT' }], ['c', '2', 'TWO - Two Net, US']]));
check(unann.length === 3 && unann[1].unannounced && unann[1].netname === 'VODAFONE-IT' && unann[1].country === 'IT' && pm.segmentLabel(unann[1]) === 'VODAFONE-IT (not announced)' && pm.segmentLabel(unann[0]) === 'AS1 One Net' && pm.segmentLabel(segs[1]) === 'no reply', 'an address no AS announces is a network of its own under the registry\'s name');
const ab = asnOf([['a', '1', 'ONE - One Net, US'], ['b', '2', 'TWO - Two Net, US'], ['c', '2', 'TWO - Two Net, US'], ['d', '3', 'THREE - Three Net, US']]);

let nn = pm.networkNotes(pm.networkSegments([hop(1, 'a', 5), hop(2, 'b', 60), hop(3, 'c', 61), hop(4, 'd', 62)], ab), [], false);
check(nn.some(n => n.kind === 'jump' && /rises by 55 ms where the path passes from AS1 One Net to AS2 Two Net \(hop 1 to hop 2\)/.test(n.text)) && nn.some(n => n.kind === 'share' && /90% of the delay \(56 of 62 ms\) is added in AS2 Two Net/.test(n.text)), 'a jump in delay is placed at the handoff between two networks, and the network that adds most of the delay is named', j(nn));
nn = pm.networkNotes(pm.networkSegments([hop(1, 'a', 5), hop(2, 'b', 6), hop(3, 'c', 130), hop(4, 'd', 132)], ab), [], false);
check(nn.some(n => n.kind === 'jump' && /rises by 124 ms inside AS2 Two Net \(hops 2 to 3\)/.test(n.text)) && !nn.some(n => /passes from/.test(n.text)), 'a jump between two hops of the same network is placed inside it', j(nn));
nn = pm.networkNotes(pm.networkSegments([hop(1, 'a', 5), hop(2, 'b', 6), hop(3, 'c', 8), hop(4, 'd', 10)], ab), [], false);
check(nn.length === 0, 'a path with no jump and no loss has nothing to say');
let lossHops = [hop(1, 'a', 5), hop(2, 'b', 6), hop(3, 'c', 8, 20), hop(4, 'd', 10, 20)];
nn = pm.networkNotes(pm.networkSegments(lossHops, ab), lossHops, false);
check(nn.length === 1 && nn[0].kind === 'loss' && nn[0].level === 'bad' && /Loss of 20% starts at hop 3 in AS2 Two Net and reaches the destination \(20%\)\. That is a network between the ISP and the destination\./.test(nn[0].text), 'loss that reaches the destination is placed in the network where it starts', j(nn));
lossHops = [hop(1, 'a', 5, 5), hop(2, 'b', 6, 5), hop(3, 'c', 8, 5), hop(4, 'd', 10, 5)];
nn = pm.networkNotes(pm.networkSegments(lossHops, ab), lossHops, false);
check(nn.length === 1 && nn[0].level === 'warn' && /Loss of 5% starts at hop 1 in AS1 One Net .* the first network after the router, usually the ISP's access link/.test(nn[0].text), 'loss from the first hop is the ISP side, and under 10% is a warning');
lossHops = [hop(1, 'a', 5), hop(2, 'b', 6, 40), hop(3, 'c', 8), hop(4, 'd', 10)];
check(pm.networkNotes(pm.networkSegments(lossHops, ab), lossHops, false).every(n => n.kind !== 'loss'), 'a hop that loses probes while the destination does not is rate limiting, not a network fault');
check(pm.networkNotes(pm.networkSegments(lossHops, ab), lossHops, true).length === 0 && pm.networkNotes([], [], false).length === 0, 'nothing is said while the run goes on or before there are networks');
const report = pm.mtrReport({ host: '1.1.1.1', command: 'mtr --raw -n -c 10 1.1.1.1', when: '16/11/2026, 13:00:00', hops: fixtureMtr, asn, segments: segs, notes: pm.pathNotes(fixtureMtr, false) });
const rl = report.split('\n');
check(rl[0] === 'MTR to 1.1.1.1' && rl[1] === 'mtr --raw -n -c 10 1.1.1.1' && /^Hop +Address +Network +Loss +Sent +Last +Avg +Best +Worst +StDev$/.test(rl[4]) && /^ +1  37\.179\.98\.1 +AS30722 Fastweb SpA \(IT\) +0% +6 /.test(rl[5]) && /^ +2  \?\?\? /.test(rl[6]) && /^ +7  1\.1\.1\.1 +AS13335 Cloudflare, Inc\. \(AU\) /.test(rl[11]), 'the report has a header, an aligned table with the network of each hop and ??? for the silent ones', report);
check(/\nNetworks: AS30722 Fastweb SpA \(hop 1, \+\d+\.\d ms\) > no reply \(hops 2-5\) > AS13335 Cloudflare, Inc\. \(hops 6-7, \+\d+\.\d ms\)\n/.test(report) && /\nFindings:\n- No probe to the destination was lost\.\n/.test(report) && report.endsWith('\n') && !report.includes('\r'), 'it lists the networks crossed with the delay each adds, then the findings');
check(!/Networks:/.test(pm.mtrReport({ host: 'x', command: 'c', when: 'w', hops: fixtureMtr, asn: null, segments: [], notes: [] })) && !/Findings:/.test(pm.mtrReport({ host: 'x', command: 'c', when: 'w', hops: fixtureMtr, asn: null, segments: [], notes: [] })), 'without AS data or findings those parts are left out');

console.log('== packet capture ==');
const cm = await mod('capturemodel.js');
const CAPTURE_TEXT = `### BEGIN capture 100.00 br-lan tcp and host 192.168.1.50
1794843326.000000 IP 192.168.1.50.54321 > 93.184.216.34.443: Flags [S], seq 1, win 64240, options [mss 1460,sackOK,TS val 1 ecr 0,nop,wscale 7], length 0
1794843326.020000 IP 93.184.216.34.443 > 192.168.1.50.54321: Flags [S.], seq 10, ack 2, win 65535, length 0
1794843326.020100 IP 192.168.1.50.54321 > 93.184.216.34.443: Flags [.], ack 1, win 502, length 0
1794843326.030000 IP 192.168.1.50.54321 > 93.184.216.34.443: Flags [P.], seq 1:518, ack 1, win 502, length 517
1794843326.500000 IP 192.168.1.50.54400 > 10.0.0.5.22: Flags [R.], seq 1, ack 1, win 0, length 0
1794843326.600000 IP 192.168.1.50.5353 > 224.0.0.251.5353: 0 PTR (QM)? _services._dns-sd._udp.local. (46)
1794843326.700000 IP 192.168.1.50.40000 > 192.168.1.1.53: 12345+ A? example.com. (29)
1794843326.800000 IP 192.168.1.1 > 192.168.1.50: ICMP echo reply, id 1, seq 1, length 64
1794843326.900000 IP6 fe80::1 > ff02::1: ICMP6, router advertisement, length 56
1794843327.000000 ARP, Request who-has 192.168.1.1 tell 192.168.1.50, length 28
1794843327.100000 wan In IP 1.2.3.4.51820 > 5.6.7.8.51820: UDP, length 148
1794843327.200000 IP 192.168.1.50 > 8.8.8.8: GREv0, length 100: IP 10.0.0.1 > 10.0.0.2: ICMP echo request, id 2, seq 1, length 64
1794843327.300000 IP6 2001:db8::1.443 > 2001:db8::2.51234: Flags [S.], seq 5, ack 1, win 65535, length 0
### MORE 12

### END 0 110.00
### BEGIN stats 110.01 
dropped privs to root
tcpdump: listening on br-lan, link-type EN10MB (Ethernet), snapshot length 96 bytes
25 packets captured
30 packets received by filter
0 packets dropped by kernel

### END 0 110.02
`;
let pk = cm.parsePacket('1794843326.000000 IP 192.168.1.50.54321 > 93.184.216.34.443: Flags [S], seq 1, win 64240, length 0');
check(pk.proto === 'TCP' && pk.src === '192.168.1.50' && pk.sport === 54321 && pk.dst === '93.184.216.34' && pk.dport === 443 && pk.len === 0 && pk.iface === null && /^Flags \[S\]/.test(pk.info), 'a TCP packet: protocol, both endpoints with their ports, length and the tool\'s own words', j(pk));
check(cm.parsePacket('1794843326.600000 IP 192.168.1.50.5353 > 224.0.0.251.5353: 0 PTR (QM)? _services._dns-sd._udp.local. (46)').proto === 'mDNS' && cm.parsePacket('1794843326.700000 IP 192.168.1.50.40000 > 192.168.1.1.53: 12345+ A? example.com. (29)').proto === 'DNS' && cm.parsePacket('1794843326.700000 IP 192.168.1.50.40000 > 192.168.1.1.53: 12345+ A? example.com. (29)').len === 29, 'mDNS and DNS are told by their ports; a payload length in parentheses is the length');
pk = cm.parsePacket('1794843326.800000 IP 192.168.1.1 > 192.168.1.50: ICMP echo reply, id 1, seq 1, length 64');
check(pk.proto === 'ICMP' && pk.sport === null && pk.src === '192.168.1.1' && pk.len === 64 && cm.parsePacket('1794843326.900000 IP6 fe80::1 > ff02::1: ICMP6, router advertisement, length 56').proto === 'ICMPv6', 'ICMP and ICMPv6 have no ports');
pk = cm.parsePacket('1794843327.300000 IP6 2001:db8::1.443 > 2001:db8::2.51234: Flags [S.], seq 5, ack 1, win 65535, length 0');
check(pk.proto === 'TCP' && pk.src === '2001:db8::1' && pk.sport === 443 && pk.dst === '2001:db8::2' && pk.dport === 51234, 'an IPv6 endpoint carries its port after a dot');
pk = cm.parsePacket('1794843327.000000 ARP, Request who-has 192.168.1.1 tell 192.168.1.50, length 28');
check(pk.proto === 'ARP' && pk.src === '192.168.1.50' && pk.dst === '192.168.1.1' && pk.len === 28 && cm.parsePacket('1794843327.000000 ARP, Reply 192.168.1.1 is-at aa:bb:cc:dd:ee:ff, length 28').src === '192.168.1.1', 'ARP: who asks whom, or who answers');
pk = cm.parsePacket('1794843327.100000 wan In IP 1.2.3.4.51820 > 5.6.7.8.51820: UDP, length 148');
check(pk.iface === 'wan' && pk.dir === 'In' && pk.proto === 'UDP' && pk.src === '1.2.3.4' && pk.len === 148 && cm.parsePacket('1794843327.200000 IP 192.168.1.50 > 8.8.8.8: GREv0, length 100: IP 10.0.0.1 > 10.0.0.2: ICMP echo request').proto === 'GRE', 'a capture on every interface names the interface and the direction; tunnels are named by their protocol');
check(cm.parsePacket('not a packet') === null && cm.parsePacket('') === null && cm.parsePacket('1794843327.5 something unknown here').proto === '?', 'a line that is not a packet is ignored; an unknown format keeps its text');

const cc = cm.parseCapture(CAPTURE_TEXT);
check(cc.packets.length === 13 && cc.more === 12 && cc.done && cc.captured === 25 && cc.received === 30 && cc.dropped === 0 && cc.snaplen === 96 && cc.listening === 'br-lan' && cc.error === null, 'the packets, the ones left out, and the summary of the capture (without the "dropped privs" line)', j([cc.packets.length, cc.more, cc.captured, cc.received, cc.dropped, cc.error]));
check(cc.packets[0].rel === 0 && Math.abs(cc.packets[3].rel - 0.03) < 1e-6 && Math.abs(cc.span - 1.3) < 1e-6, 'times are counted from the first packet');
check(cc.syn === 1 && cc.rst === 1 && cc.tcp === 6 && cc.protocols[0][0] === 'TCP' && cc.protocols[0][1] === 6 && cc.protocols.some(([n, c]) => n === 'ARP' && c === 1), 'connection attempts, resets and the protocols are counted over the packets shown', j([cc.syn, cc.rst, cc.tcp, cc.protocols]));
check(cc.conversations[0].a === '192.168.1.50' && cc.conversations[0].b === '93.184.216.34' && cc.conversations[0].packets === 4 && cc.conversations[0].bytes === 517 && cc.conversations.length <= 5, 'the busiest conversation is counted in both directions', j(cc.conversations[0]));
const midway = cm.parseCapture(CAPTURE_TEXT.split('### BEGIN stats')[0].replace('\n### MORE 12\n\n### END 0 110.00\n', '\n'));
check(!midway.done && midway.captured === null && midway.packets.length === 13 && cm.captureNotes(midway, { packets: 2000 }).length === 0, 'a running capture has packets but no summary, and nothing is said yet');
let cn = cm.captureNotes(cc, { packets: 2000, seconds: 30 });
check(cn.length === 1 && /table and the figures cover the first 13 packets; the file has all 25/.test(cn[0].text), 'when packets were left out of the table the page says the file has them all', j(cn));
cn = cm.captureNotes({ ...cc, more: 0, dropped: 7, captured: 2000 }, { packets: 2000, seconds: 30 });
check(cn.some(n => n.level === 'warn' && /dropped 7 packets/.test(n.text)) && cn.some(n => /ended at its limit of 2000 packets/.test(n.text)), 'dropped packets are a warning, and the packet limit is named as the reason it ended');
cn = cm.captureNotes({ ...cc, more: 0, rst: 5, tcp: 20 }, { packets: 2000, seconds: 30 });
check(cn.some(n => n.level === 'warn' && /5 of 20 TCP packets are resets/.test(n.text)) && !cm.captureNotes({ ...cc, more: 0, rst: 1, tcp: 20 }, {}).some(n => /resets/.test(n.text)), 'a tenth of the TCP packets being resets is a warning, fewer is not');
const empty = cm.parseCapture('### BEGIN capture 1.0 br-lan\n\n### END 0 2.0\n### BEGIN stats 2.0 \ntcpdump: listening on br-lan, link-type EN10MB (Ethernet), snapshot length 96 bytes\n0 packets captured\n0 packets received by filter\n0 packets dropped by kernel\n\n### END 0 2.0\n');
check(empty.done && empty.captured === 0 && cm.captureNotes(empty, {})[0].level === 'warn' && /No packet matched/.test(cm.captureNotes(empty, {})[0].text), 'a capture that saw nothing says so, with where to look');
const bad = cm.parseCapture('### BEGIN capture 1.0 nope0\n\n### END 0 2.0\n### BEGIN stats 2.0 \ntcpdump: nope0: No such device exists\n\n### END 0 2.0\n');
check(bad.error === 'nope0: No such device exists' && cm.captureNotes(bad, {})[0].level === 'bad' && /capture failed: nope0: No such device exists/.test(cm.captureNotes(bad, {})[0].text), 'tcpdump\'s own complaint is shown as the failure');
check(!cm.parseCapture('').done && cm.parseCapture('').packets.length === 0, 'no output yet is an empty capture');

console.log('== requests for a capture ==');
r = m.requestOf(form({ tool: 'capture', host: '', capIface: 'br-lan' }));
check(j(r.args) === j({ tool: 'capture', iface: 'br-lan', seconds: 30, packets: 2000, snaplen: 96 }), 'a capture with the defaults sends only the interface and the limits', j(r));
r = m.requestOf(form({ tool: 'capture', host: '192.168.1.50', capIface: 'any', capProto: 'tcp', capPort: '443', capSeconds: '120', capPackets: '10000', capSnap: '1514' }));
check(j(r.args) === j({ tool: 'capture', iface: 'any', proto: 'tcp', host: '192.168.1.50', port: 443, seconds: 120, packets: 10000, snaplen: 1514 }), 'the protocol, the address, the port and the limits are sent', j(r));
r = m.requestOf(form({ tool: 'capture', host: '', capIface: 'wan', capProto: 'icmp', capPort: '443' }));
check(j(r.args) === j({ tool: 'capture', iface: 'wan', proto: 'icmp', seconds: 30, packets: 2000, snaplen: 96 }), 'a port that is left in the form is not sent when the protocol has none');
check(m.requestOf(form({ tool: 'capture', host: 'example.com', capIface: 'lan' })).error && m.requestOf(form({ tool: 'capture', host: '1.1.1.1; reboot', capIface: 'lan' })).error && m.requestOf(form({ tool: 'capture', host: '', capIface: '' })).error && m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan; reboot' })).error && m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capPort: '0' })).error && m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capPort: '70000' })).error && m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capProto: 'tcp or udp' })).error && m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capSeconds: '7' })).error && m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capSnap: '100' })).error, 'a capture refuses a name instead of an address, injections, a bad interface, port, protocol, duration or size');

r = m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capFilter: '  not port 443 and (len > 100 or tcp[tcpflags] & tcp-syn != 0)  ' }));
check(j(r.args) === j({ tool: 'capture', iface: 'lan', filter: 'not port 443 and (len > 100 or tcp[tcpflags] & tcp-syn != 0)', seconds: 30, packets: 2000, snaplen: 96 }), 'the advanced filter is sent trimmed, after the choices of the form', j(r));
check(j(m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capFilter: '   ' })).args) === j({ tool: 'capture', iface: 'lan', seconds: 30, packets: 2000, snaplen: 96 }) && j(m.requestOf(form({ tool: 'capture', host: '10.0.0.1', capIface: 'lan', capProto: 'udp', capPort: '53', capFilter: 'net 10.0.0.0/8' })).args) === j({ tool: 'capture', iface: 'lan', proto: 'udp', host: '10.0.0.1', port: 53, filter: 'net 10.0.0.0/8', seconds: 30, packets: 2000, snaplen: 96 }), 'an empty advanced filter is not sent; it goes with every other choice');
const badFilters = ['-w /tmp/x', 'port 80; reboot', '$(id)', 'a`id`', 'x\'y', 'a\\b', 'host "x"', 'port 80\nport 81', 'x'.repeat(201)];
check(badFilters.every(f => m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capFilter: f })).error), 'the advanced filter refuses an option, shell characters, quotes, backslashes, line breaks and more than 200 characters', j(badFilters.filter(f => !m.requestOf(form({ tool: 'capture', host: '', capIface: 'lan', capFilter: f })).error)));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall new-tool checks passed');process.exit(failed ? 1 : 0);
