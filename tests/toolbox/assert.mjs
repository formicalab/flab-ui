// Checks what the flab.diag plugin did on the router (real jobs against loopback, run by run.ps1). Usage:
// node assert.mjs <dir with out-diag-*.json and the small text files>. Nothing here touches the network beyond
// 127.0.0.1 and localhost, and every refused request is checked to have run nothing.
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/toolbox/diagmodel.js')).href);
const ip = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/toolbox/iperfmodel.js')).href);
const dt = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/toolbox/dnstracemodel.js')).href);
const pm = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/toolbox/pathmodel.js')).href);

const dir = process.argv[2];
// The path of output file `f` inside the work directory.
const file = f => path.join(dir, f);
// Loads one output file as JSON, or null when the step did not produce it.
const load = f => fs.existsSync(file(f)) ? JSON.parse(fs.readFileSync(file(f), 'utf8')) : null;
let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

console.log('== status ==');
const st = load('out-diag-status.json');
check(st.tools.ping === true && st.tools.traceroute === true && typeof st.dns_tool === 'string' && st.dns_tool !== '' && Array.isArray(st.devices) && st.devices.includes('lo'), 'the router reports its tools, the DNS tool it would use and its interfaces', j(st).slice(0, 200));
check(st.types.join() === 'A,AAAA,MX,TXT,NS,CNAME,SOA,PTR,SRV,CAA' && st.limits.ping === 25 && st.limits.traceroute === 60 && st.limits.dns === 15 && st.limits.tls === 25 && st.limits.compare === 60 && st.limits.check === 75 && st.limits.trace === 60 && st.limits.mtr === 15, 'the record types and the time limits');
check(st.max_pings === 60 && j(st.mtr_cycles) === '[3,60,10]' && typeof st.tools.mtr === 'boolean' && typeof st.tools.iperf3 === 'boolean' && typeof st.asn === 'boolean', 'the status gives the ping and mtr limits and whether mtr, iperf3 and the AS lookup exist', j(st).slice(0, 300));
check(!st.tools.iperf3 || (j(st.iperf.minutes) === '[1,2,5,15,30]' && st.iperf.port === 5201 && st.iperf.min_port === 1024 && Array.isArray(st.iperf.addresses) && st.iperf.addresses.every(x => m.isAddress(x.ip) && !/^127\./.test(x.ip) && !/^fe[89ab]/i.test(x.ip) && ['ACCEPT', 'REJECT', 'DROP'].includes(x.input)) && Array.isArray(st.iperf.exposed)), 'the iperf3 server\'s times, default port, the router\'s own addresses with what their zone does with traffic, and the zones that face the internet', j(st.iperf).slice(0, 300));
check(typeof st.tools.openssl === 'boolean' && st.starttls.join() === 'smtp,imap,pop3,ftp' && st.check_host === 'example.com' && Array.isArray(st.upstream) && st.upstream.length <= 4 && st.upstream.every(a => m.isAddress(a) && !/^(127\.|::1$)/.test(a)), 'the status also tells whether openssl exists, the STARTTLS protocols, the default check host and the upstream resolvers (never loopback)', j(st.upstream));
check(st.devices.every(d => /^[A-Za-z0-9_.:-]+$/.test(d) && !d.startsWith('-')), 'every interface name is a safe word');

console.log('== Wake-on-LAN ==');
check(['etherwake', 'socat', ''].includes(st.wol) && Array.isArray(st.hosts) && st.hosts.length <= 300 && st.hosts.every(x => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(x.mac) && (x.ip === undefined || m.isAddress(x.ip)) && (x.dev === undefined || /^[A-Za-z0-9_.:-]+$/.test(x.dev)) && (x.reserved === undefined || x.reserved === true)) && new Set(st.hosts.map(x => x.mac)).size === st.hosts.length, 'the status says how a packet can be sent and lists the known hosts: one entry per MAC, lowercase, with an address and the interface where known', j(st.hosts?.slice(0, 2)));
const w1 = load('out-diag-wake.json'), w2 = load('out-diag-wake2.json');
check(st.wol === '' || (w1.ok === true && w1.mac === '02:00:00:00:00:01' && w1.iface === 'lo' && w1.method === st.wol && typeof w1.sent === 'number' && (st.wol === 'etherwake' ? w1.command === 'etherwake -i lo 02:00:00:00:00:01' : /^UDP broadcast to 255\.255\.255\.255:9 on lo \(socat\)$/.test(w1.command))), 'a magic packet goes out of the loopback device and the reply says how', j(w1));
check(st.wol === '' || (w2.ok === true && w2.mac === '02:00:00:00:00:02'), 'a MAC written with dashes is accepted and normalized', j(w2));
const wakeRefusals = fs.readFileSync(path.join(import.meta.dirname, 'wake-refusals.txt'), 'utf8').split('\n').filter(Boolean);
const wakeRefused = wakeRefusals.map((_, i) => load(`out-diag-wakerefused-${i + 1}.json`));
check(wakeRefusals.length >= 15 && wakeRefused.every(r => r !== null && r.ok === false && typeof r.error === 'string' && r.error.length > 5), `all ${wakeRefusals.length} bad wake requests were refused with a reason`, wakeRefused.map((r, i) => r?.ok ? wakeRefusals[i] : null).filter(Boolean).join(' || '));

console.log('== a ping, read while it runs and after it ended ==');
const ps = load('out-diag-ping.start.json');
check(ps.ok && /^[0-9a-f]{12}$/.test(ps.id) && ps.tool === 'ping' && ps.command === 'ping -c 5 -W 2 -w 10 -s 56 127.0.0.1' && ps.limit === 15, 'start returns a job id and the exact command line', j(ps));
const run = load('out-diag-ping.running.json');
check(run.ok && run.running === true && run.exit === null && /^PING 127\.0\.0\.1/.test(run.text) && /seq=0/.test(run.text) && !/statistics/.test(run.text), 'read while it runs: the output so far, still running', j(run).slice(0, 200));
const done = load('out-diag-ping.done.json');
check(done.ok && done.running === false && done.exit === 0 && /5 packets transmitted, 5 packets received, 0% packet loss/.test(done.text) && done.size === done.text.length && !done.stopped && !done.timed_out, 'read after it ended: the whole output, exit 0', j(done).slice(0, 200));
check(done.text.length > run.text.length && done.text.startsWith(run.text.slice(0, 40)), 'the output grew between the two reads');
const tail = load('out-diag-ping.tail.json');
check(tail.ok && tail.text === '' && tail.size === done.size, 'reading from the end of the output returns nothing new');
const part = load('out-diag-ping.part.json');
check(part.ok && part.text === done.text.slice(done.size - 40) && part.text.length === 40, 'reading from an offset returns the rest', j(part).slice(0, 160));

console.log('== stopping a job ==');
const sstart = load('out-diag-stop.start.json'), sstop = load('out-diag-stop.stop.json'), sread = load('out-diag-stop.read.json');
check(sstart.ok && sstop.ok && sstop.running === false, 'stop answers at once');
check(sread.running === false && sread.exit === 143 && sread.stopped === true && sread.timed_out === false && /seq=0/.test(sread.text) && !/statistics/.test(sread.text), 'the job ended with exit 143 and is reported as stopped, with the output it had', j(sread).slice(0, 200));
check(fs.readFileSync(file('out-diag-stop.procs.txt'), 'utf8').trim() === '0', 'no ping process is left behind');
const sagain = load('out-diag-stop.again.json');
check(sagain.ok && sagain.running === false, 'stopping a job that has ended is harmless');

console.log('== DNS and traceroute ==');
const dns = load('out-diag-dns.read.json'), dnsStart = load('out-diag-dns.start.json');
check(dnsStart.ok && /^(dig|kdig|drill|nslookup) /.test(dnsStart.command) && dnsStart.dns_tool === dnsStart.command.split(' ')[0] && dnsStart.limit === 15, 'the lookup uses the best tool the router has', dnsStart.command);
check(dns.running === false && dns.exit === 0 && /127\.0\.0\.1/.test(dns.text), 'localhost resolves to 127.0.0.1', j(dns).slice(0, 200));
const tr = load('out-diag-trace.read.json'), trStart = load('out-diag-trace.start.json');
check(trStart.ok && trStart.command === 'traceroute -n -w 2 -q 1 -m 3 127.0.0.1' && trStart.limit === 60, 'a traceroute is numeric, with the hop limit and probe count asked for', trStart.command);
check(tr.running === false && tr.exit === 0 && /^traceroute to 127\.0\.0\.1 \(127\.0\.0\.1\), 3 hops max/.test(tr.text) && /\n\s*1\s+127\.0\.0\.1\s/.test(tr.text), 'the first hop is the destination itself', j(tr).slice(0, 200));
const rsStart = load('out-diag-resolve.start.json'), rs = load('out-diag-resolve.read.json');
check(rsStart.ok && rsStart.command === 'traceroute -w 2 -q 1 -m 3 127.0.0.1', 'asking for names leaves out -n and nothing else changes', rsStart.command);
check(rs.running === false && rs.exit === 0 && /\n\s*1\s+\S+ \(127\.0\.0\.1\)\s+[\d.]+ ms/.test(rs.text), 'with names looked up the router is printed as "name (address)"', j(rs).slice(0, 220));

console.log('== certificate check, comparison and connectivity check ==');
const tlsStart = load('out-diag-tls.start.json'), tlsRead = load('out-diag-tls.read.json');
check(tlsStart.ok && tlsStart.command === 'openssl s_client -connect 127.0.0.1:443' && tlsStart.limit === 25, 'the certificate check names its command and time limit', tlsStart.command);
check(tlsRead.running === false && tlsRead.exit === 0 && /^### BEGIN tls [\d.]+ 127\.0\.0\.1 443\n/.test(tlsRead.text) && /\n### END 0 [\d.]+\n$/.test(tlsRead.text) && /### CERT 1\n/.test(tlsRead.text), 'the job is one block with the handshake and a ### CERT section per certificate', tlsRead.text.slice(0, 200));
const tls = m.parseTls(tlsRead.text, { target: '127.0.0.1:443' });
check(tls.chain.length >= 1 && /^TLS/.test(tls.protocol ?? '') && tls.chain.every(c => /^-----BEGIN CERTIFICATE-----\n/.test(c.pem) && /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(c.sha256 ?? '') && /^[0-9A-F]+$/.test(c.serial ?? '') && c.notAfter != null && c.subject !== '' && c.issuer !== ''), 'the chain, the session and every certificate\'s serial, SHA-256 and dates are read', j(tls.chain.map(c => [c.subject, c.sha256])));
check(tls.chain.every(c => new X509Certificate(c.pem).fingerprint256 === c.sha256 && new X509Certificate(c.pem).serialNumber.replace(/^0+/, '') === c.serial.replace(/^0+/, '')), 'the fingerprints and serial numbers the router printed match the certificates in the output');
check(tls.chain.every(c => Math.abs(new Date(new X509Certificate(c.pem).validTo).getTime() - c.notAfter) < 1000), 'the dates of the chain match the certificates');
const tls2 = load('out-diag-tls2.start.json'), tls2r = load('out-diag-tls2.read.json');
check(tls2.ok && tls2.command === 'openssl s_client -connect 127.0.0.1:9 -starttls smtp' && /refused/.test(m.parseTls(tls2r.text, { target: '127.0.0.1:9' }).error ?? ''), 'a STARTTLS check against a closed port reports a refusal', tls2.command);
const cmpStart = load('out-diag-compare.start.json'), cmp = load('out-diag-compare.read.json');
check(cmpStart.ok && /^(dig|kdig|drill|nslookup) localhost A @router @127\.0\.0\.1$/.test(cmpStart.command) && cmpStart.limit === 60, 'the comparison names the servers once each, in order', cmpStart.command);
const cr = m.parseCompare(cmp.text, 2);
check(cmp.running === false && cmp.exit === 0 && cr.rows.length === 2 && cr.rows.map(r => r.server).join() === 'router,127.0.0.1' && cr.rows.every(r => r.verdict === 'ok' && r.data.includes('127.0.0.1')) && cr.agree === true && cr.done, 'both servers answer 127.0.0.1 for localhost and agree', j(cr.rows.map(r => [r.server, r.verdict, r.data])));
const chkStart = load('out-diag-check.start.json'), chk = load('out-diag-check.read.json');
check(chkStart.ok && chkStart.command === 'connectivity check (localhost)' && chkStart.limit === 75, 'the connectivity check names itself and its time limit', chkStart.command);
const order = m.parseBlocks(chk.text).map(b => b.id).join();
check(chk.running === false && chk.exit === 0 && order === 'route4,route6,gateway,internet4,internet4,dns_router,dns_public,internet6,dns6,tls' && m.parseBlocks(chk.text).every(b => !b.running && b.exit !== null), 'every step ran in order and ended', `${chk.running} ${chk.exit} ${order}`);
const ck = m.parseCheck(chk.text, false, { name: 'localhost' });
check(ck.done && ck.steps.length === 8 && ck.steps.every(s => ['ok', 'warn', 'bad', 'skip'].includes(s.state)) && ck.verdict && ['ok', 'warn', 'bad'].includes(ck.verdict.level), 'the output is understood: every step has a state and there is a verdict', j(ck.steps.map(s => [s.id, s.state])));
const c2 = load('out-diag-check2.read.json');
check(fs.readFileSync(file('out-diag-check.cr'), 'utf8').trim() === '0', 'the script carries no carriage return, even though the plugin source has CRLF line endings (BusyBox sh rejects them)');
check(c2 && c2.running === false && c2.exit === 143 && c2.stopped === true && /^### BEGIN route4 /.test(c2.text), 'a script job can be stopped: exit 143, reported as stopped, with the blocks it had run');
check(fs.readFileSync(file('out-diag-check2.procs.txt'), 'utf8').trim() === '0', 'stopping the connectivity check leaves no ping or openssl behind');

console.log('== mtr, traceroute with AS lookups, DNS trace ==');
const mtrStart = load('out-diag-mtr.start.json'), mtrRead = load('out-diag-mtr.read.json');
check(mtrStart.ok && mtrStart.command === 'mtr --raw -n -c 3 -i 1 -G 2 127.0.0.1' && mtrStart.limit === 18, 'mtr runs in raw mode with the rounds asked for', j(mtrStart));
const mtr = pm.parseMtr(mtrRead.text, false);
check(mtrRead.running === false && mtrRead.exit === 0 && mtr.hops.length === 1 && mtr.hops[0].addr === '127.0.0.1' && mtr.hops[0].sent === 3 && mtr.hops[0].recv === 3 && mtr.reached, 'the path to loopback is one hop that answered all three rounds', j(mtrRead).slice(0, 200));
const asnStart = load('out-diag-asn.start.json'), asnRead = load('out-diag-asn.read.json');
check(asnStart.ok && /^traceroute .* 127\.0\.0\.1 \(with AS lookups\)$/.test(asnStart.command), 'a traceroute with AS lookups says so', asnStart.command);
check(asnRead.running === false && asnRead.exit === 0 && /^### BEGIN trace [\d.]+ \n/.test(asnRead.text) && /\n### END 0 [\d.]+\n/.test(asnRead.text) && !/### BEGIN asn /.test(asnRead.text) && m.parseTraceroute(asnRead.text).hops[0].addrs[0] === '127.0.0.1', 'the traceroute is one block; loopback is private, so no AS lookup is made', asnRead.text.slice(0, 200));
check(fs.readFileSync(file('out-diag-asn.cr'), 'utf8').trim() === '0' && fs.readFileSync(file('out-diag-dnstrace.cr'), 'utf8').trim() === '0', 'the scripts of both carry no carriage return');
const dtStart = load('out-diag-dnstrace.start.json'), dtRead = load('out-diag-dnstrace.read.json');
check(dtStart.ok && dtStart.command === 'DNS trace example.com A' && dtStart.limit === 60 && dtStart.tool === 'trace', 'the DNS trace names itself and its time limit', j(dtStart));
const dtr = dt.parseDnsTrace(dtRead.text, { name: 'example.com', type: 'A' });
check(dtRead.running === false && dtRead.exit === 0 && dtr.done && dtr.outcome === 'answer' && dtr.segments[0].steps.length >= 2 && dtr.segments[0].steps[0].zone === '.' && dtr.resolver !== null, 'the trace walks from the root to an answer and ends with the router\'s resolver', j(dtr.segments[0].steps.map(s => [s.kind, s.zone])));

console.log('== the iperf3 server ==');
const ipStart = load('out-diag-iperf.start.json'), ipRead = load('out-diag-iperf.read.json');
check(ipStart.ok && ipStart.tool === 'iperf' && ipStart.limit === 60 && /^iperf3 -s -p 5399 \(stops after 1 minute\)$/.test(ipStart.command), 'the server names its port and its time limit', j(ipStart));
const ipr = ip.parseIperf(ipRead.text);
check(ipRead.running === true && ipr.tests.length === 1 && ipr.tests[0].client.host === '127.0.0.1' && ipr.tests[0].protocol === 'TCP' && ipr.tests[0].done && ipr.tests[0].summary.bps > 1e6, 'a client on loopback ran a test that the server reported, while it keeps listening', j(ipr.tests).slice(0, 200));
const ip2 = load('out-diag-iperf.second.json');
check(ip2.ok === false && /already running/.test(ip2.error), 'a second server is refused while one runs', j(ip2));
const ipStop = load('out-diag-iperf.stop.json'), ipAfter = load('out-diag-iperf.after.json');
check(ipStop.ok && ipAfter.running === false && ipAfter.exit === 0 && ipAfter.timed_out === false, 'the server ends cleanly when asked (iperf3 exits 0 on SIGTERM, so the page tracks the stop itself)', j(ipAfter).slice(0, 200));
check(fs.readFileSync(file('out-diag-iperf.procs.txt'), 'utf8').trim() === '0', 'no iperf3 process is left behind');

console.log('== the options that are allowed ==');
const v1 = load('out-diag-variant1.json'), v2 = load('out-diag-variant2.json'), v3 = load('out-diag-variant3.json'), v4 = load('out-diag-variant4.json');
check(v1.ok && v1.command === 'ping -c 1 -W 2 -w 6 -s 100 -4 -I lo 127.0.0.1', 'ping with a size, a family and an interface as source', v1.command);
check(v2.ok && v2.command === 'traceroute -n -w 2 -q 3 -m 5 -I -4 -s 127.0.0.1 127.0.0.1', 'traceroute with ICMP, a family and an address as source', v2.command);
check(v3.ok && (/-x 127\.0\.0\.1$/.test(v3.command) || /^nslookup -type=PTR 127\.0\.0\.1$/.test(v3.command)), 'a reverse lookup of an address', v3.command);
check(v4.ok && / (@|)127\.0\.0\.1/.test(v4.command) && /\bMX\b|type=MX/.test(v4.command), 'a lookup of another record type against a named server', v4.command);

console.log('== requests that must be refused ==');
const refusals = fs.readFileSync(path.join(import.meta.dirname, 'refusals.txt'), 'utf8').split('\n').filter(Boolean);
const refused = refusals.map((_, i) => load(`out-diag-refused-${i + 1}.json`));
check(refusals.length >= 30 && refused.every(r => r !== null), `all ${refusals.length} requests were answered`);
const accepted = refused.map((r, i) => r && r.ok !== false ? refusals[i] : null).filter(Boolean);
check(accepted.length === 0, 'every one was refused', accepted.join(' || '));
check(refused.every(r => typeof r.error === 'string' && r.error.length > 5), 'every refusal says why');
const counts = fs.readFileSync(file('out-diag-refused.count'), 'utf8').trim().split(/\s+/).map(Number);
check(counts[0] === counts[1], 'no job was created by a refused request', counts.join(' -> '));
check(fs.readFileSync(file('out-diag-canary.txt'), 'utf8').trim() === 'no', 'the canary file was never created: nothing in a refused request reached the shell');
const ids = [0, 1, 2, 3, 4, 5].map(i => [load(`out-diag-badid-${i}.read.json`), load(`out-diag-badid-${i}.stop.json`)]);
check(ids.every(([r, s]) => r && s && r.ok === false && s.ok === false && /no such job/.test(r.error) && /no such job/.test(s.error)), 'job ids that are not ones the plugin made (paths, wrong length, empty) are refused by read and stop', j(ids[0]));

console.log('== at most three at once ==');
const before = fs.readFileSync(file('out-diag-cap.before'), 'utf8').trim();
check(before === '0', 'no earlier job was still running when the cap was tried', before);
const cap = [1, 2, 3, 4].map(i => load(`out-diag-cap-${i}.json`));
check(cap[0].ok && cap[1].ok && cap[2].ok && cap[3].ok === false && /3 diagnostics are already running/.test(cap[3].error), 'three jobs run, the fourth is refused with an explanation', j(cap.map(c => c.ok ? 'ok' : c.error)));
check(new Set(cap.slice(0, 3).map(c => c.id)).size === 3, 'job ids are distinct');
const left = fs.readFileSync(file('out-diag-cap.procs.txt'), 'utf8').trim();
check(left === '0', 'stopping all three leaves no process behind', left);

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall Diagnostics backend checks passed');
