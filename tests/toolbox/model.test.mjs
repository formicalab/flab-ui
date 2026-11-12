// Unit test for the Toolbox model (www/js/pages/toolbox/diagmodel.js): the request the form builds and the
// meaning of the output of ping, traceroute and the DNS tools. The samples are what busybox ping and traceroute and
// the DNS tools printed on the routers (captured 2026-11-12), so a change in a format shows up here.
// Pure functions: no router and no browser. Usage: node diag.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/toolbox/diagmodel.js')).href);

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

import { DRILL, KDIG, KDIG_NX, NSLOOKUP, NSLOOKUP_NX, NSLOOKUP_PTR, PING_DOWN, PING_OK, PING_V6, TRACE, TRACE6, TRACE6_NAMES, TRACE_NAMES } from './samples.mjs';
import { CHECK_OK, COMPARE, COMPARE_NX, TLS_EXAMPLE, TLS_EXPIRED, TLS_GAP, TLS_LEAFONLY, TLS_LOCAL, TLS_REFUSED, TLS_RESET, TLS_SELFSIGNED } from './samples-tools.mjs';

console.log('== the form and its request ==');
const form = over => ({ ...m.blankForm(), host: '1.1.1.1', ...over });
let r = m.requestOf(form());
check(j(r.args) === j({ tool: 'ping', host: '1.1.1.1', count: 4, size: 56 }), 'a ping asks for the host, the count and the size', j(r));
r = m.requestOf(form({ host: '  example.com ', count: '10', size: '1400', family: '6', source: 'br-lan' }));
check(j(r.args) === j({ tool: 'ping', host: 'example.com', count: 10, size: 1400, family: '6', source: 'br-lan' }), 'the host is trimmed; family and source are sent when set', j(r));
r = m.requestOf(form({ tool: 'traceroute', method: 'icmp', hops: '12', probes: '1', source: '192.168.1.1', count: '999' }));
check(j(r.args) === j({ tool: 'traceroute', host: '1.1.1.1', hops: 12, probes: 1, method: 'icmp', source: '192.168.1.1' }), 'a traceroute asks for hops, probes and the method, and leaves the ping fields out', j(r));
check(!('method' in m.requestOf(form({ tool: 'traceroute' })).args), 'the default (UDP) method is not sent');
check(j(m.requestOf(form({ tool: 'traceroute', resolve: '1' })).args) === j({ tool: 'traceroute', host: '1.1.1.1', hops: 20, probes: 2, resolve: true }) && !('resolve' in m.requestOf(form({ tool: 'traceroute' })).args) && !('resolve' in m.requestOf(form({ resolve: '1' })).args), 'looking up names is sent as true only for a traceroute that asks for it');
r = m.requestOf(form({ tool: 'dns', host: 'example.com', type: 'MX', server: '9.9.9.9', family: '6', source: 'wan' }));
check(j(r.args) === j({ tool: 'dns', host: 'example.com', type: 'MX', server: '9.9.9.9' }), 'a DNS lookup asks for the type and the server only', j(r));
check(m.requestOf(form({ host: '' })).error && m.requestOf(form({ host: '-c1' })).error && m.requestOf(form({ host: 'a b' })).error && m.requestOf(form({ host: '1.1.1.1; reboot' })).error && m.requestOf(form({ host: '$(id)' })).error, 'a host with spaces, shell characters or a leading "-" is refused in the form');
check(m.requestOf(form({ count: '0' })).error && m.requestOf(form({ count: '11' })).error && m.requestOf(form({ count: 'x' })).error && m.requestOf(form({ size: '1401' })).error && m.requestOf(form({ tool: 'traceroute', hops: '31' })).error && m.requestOf(form({ tool: 'traceroute', probes: '4' })).error, 'numbers outside their limits are refused', '');
check(m.requestOf(form({ count: '' })).args.count === 4 && m.requestOf(form({ tool: 'x' })).error, 'an empty number is the default; an unknown tool is refused');
check(m.requestOf(form({ source: 'br lan' })).error && m.requestOf(form({ source: 'br-lan' })).args.source === 'br-lan' && m.requestOf(form({ source: '10.0.0.1' })).args.source === '10.0.0.1', 'a source is an interface name or an address');
check(m.requestOf(form({ source: 'x;y' })).error && m.requestOf(form({ tool: 'dns', server: '-x' })).error, 'a source or DNS server with shell characters or a leading "-" is refused');
check(m.isHost('example.com') && m.isHost('2606:4700::1111') && m.isHost('my_host-1') && !m.isHost('') && !m.isHost('a'.repeat(254)) && m.isAddress('10.0.0.1') && m.isAddress('fe80::1') && !m.isAddress('example.com'), 'host and address checks');

console.log('== ping ==');
let p = m.parsePing(PING_OK);
check(p.target.name === '1.1.1.1' && p.replies.length === 4 && p.replies[0].seq === 0 && p.replies[0].ttl === 58 && p.replies[0].rtt === 4.309 && p.replies[0].from === '1.1.1.1', 'replies with sequence, TTL, time and sender', j(p.replies[0]));
check(p.summary.sent === 4 && p.summary.received === 4 && p.summary.loss === 0 && p.sent === 4 && p.lost === 0 && p.lossPct === 0 && m.pingVerdict(p) === 'ok', 'the summary line gives sent, received and loss; the verdict is ok');
check(Math.abs(p.stats.min - 3.782) < 1e-9 && Math.abs(p.stats.max - 4.434) < 1e-9 && Math.abs(p.stats.avg - 4.164) < 1e-3 && p.stats.jitter > 0.3 && p.stats.jitter < 0.7, 'min, average and max come from the replies, with a jitter figure', j(p.stats));
p = m.parsePing(PING_DOWN);
check(p.replies.length === 0 && p.stats === null && p.sent === 3 && p.lost === 3 && p.lossPct === 100 && m.pingVerdict(p) === 'down', '100% loss: no replies, no statistics, verdict down');
p = m.parsePing(PING_V6);
check(p.target.ip === '2606:4700:4700::1111' && p.replies[1].from === '2606:4700:4700::1111' && p.replies.length === 2, 'IPv6 targets and senders (the sender is not cut at its colons)', j(p.replies));
p = m.parsePing(`PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: seq=0 ttl=58 time=4.3 ms
64 bytes from 1.1.1.1: seq=2 ttl=58 time=4.1 ms
64 bytes from 1.1.1.1: seq=3 ttl=58 time=4.2 ms
`);
check(p.summary === null && p.sent === 4 && p.lost === 1 && p.lossPct === 25 && m.pingVerdict(p) === 'lossy', 'while a ping still runs, a gap in the sequence is the sign of a lost packet', j([p.sent, p.lost, p.lossPct]));
p = m.parsePing('PING 1.1.1.1 (1.1.1.1): 56 data bytes\n');
check(p.sent === 0 && p.lossPct === null && p.replies.length === 0, 'a ping that has only just started has nothing yet');
p = m.parsePing("ping: bad address 'no-such-host.invalid'\n");
check(p.error === "bad address 'no-such-host.invalid'" && m.pingVerdict(p) === 'error' && p.target === null, 'a resolver failure is an error');
p = m.parsePing('64 bytes from 1.1.1.1: seq=0 ttl=58 time=4.3 ms (DUP!)\n64 bytes from 1.1.1.1: seq=0 ttl=58 time=4.3 ms\n');
check(p.dups === 1 && p.replies.length === 1, 'duplicate replies are counted, not listed');
check(m.parsePing('').replies.length === 0 && m.parsePing(null).error === null, 'no output, no problem');

console.log('== traceroute ==');
let t = m.parseTraceroute(TRACE);
check(t.target.ip === '1.1.1.1' && t.maxHops === 8 && t.hops.length === 7 && t.reached === true, 'the target, the hop limit and that the destination answered', j(t.target));
check(t.hops[0].addrs.join() === '37.179.98.1' && j(t.hops[0].rtts) === '[4.895,3.445]' && Math.abs(t.hops[0].avg - 4.17) < 1e-9 && !t.hops[0].silent, 'a hop with its address, its probe times and their average');
check(t.hops[1].silent && t.hops[1].addrs.length === 0 && t.hops[1].avg === null && j(t.hops[1].probes) === '[null,null]', 'a hop whose probes got no answer is silent');
t = m.parseTraceroute(TRACE6);
check(t.hops.length === 5 && t.hops[0].addrs.join() === '2a01:827:e000::c:3:11' && t.hops[1].addrs.join() === 'fd00::50:0' && t.reached === false, 'IPv6 hops, and a trace that has not reached the destination yet');
check(t.hops[3].addrs.join() === '2a01:8d0:90e:a:1::a,2001:7f8:10::3:722' && j(t.hops[3].rtts) === '[27.092,5.363]' && t.hops[3].probes[1].addr === '2001:7f8:10::3:722', 'a hop answered by two routers lists both, each probe with its own address');
check(j(t.hops[4].rtts) === '[5.479]' && t.hops[4].probes.length === 2 && t.hops[4].probes[1] === null && !t.hops[4].silent, 'a lost probe among answered ones is a gap, not a silent hop');
t = m.parseTraceroute('traceroute to 10.0.0.1 (10.0.0.1), 30 hops max, 46 byte packets\n 1  192.168.1.1  0.5 ms !H  0.4 ms\n');
check(t.hops[0].probes[0].flags.join() === '!H' && t.hops[0].rtts.length === 2, 'annotations such as !H stay with their probe');
t = m.parseTraceroute('traceroute to 1.1.1.1 (1.1.1.1), 8 hops max, 46 byte packets\n 1  37.179.98.1  4.895 ms  3.445 ms\n');
check(t.hops.length === 1 && t.reached === false && m.parseTraceroute('').hops.length === 0, 'a trace that has only begun shows its first hop; empty output has no hops');
check(m.parseTraceroute("traceroute: bad address 'x'\n").error === "bad address 'x'", 'a resolver failure is an error');
t = m.parseTraceroute(TRACE_NAMES);
check(t.hops.length === 7 && t.reached === true && t.hops[0].routers.length === 1 && t.hops[0].routers[0].name === 'net-37-179-98-1.cust.vodafonedsl.it' && t.hops[0].routers[0].addr === '37.179.98.1' && j(t.hops[0].rtts) === '[5.498,15.551]', 'with names looked up: a hop has the router\'s name and its address', j(t.hops[0]));
check(t.hops[3].routers[0].name === null && t.hops[3].routers[0].addr === '185.210.48.76' && t.hops[3].addrs.join() === '185.210.48.76', '"address (address)" is a router with no reverse record: no name');
check(t.hops[4].probes[0] === null && t.hops[4].routers[0].addr === '185.210.48.77' && j(t.hops[4].rtts) === '[5.402]' && !t.hops[4].silent, 'a lost first probe does not hide the router that answered the second');
check(t.hops[6].routers[0].name === 'one.one.one.one' && t.hops[6].routers[0].addr === '1.1.1.1' && t.hops[6].addrs.includes('1.1.1.1'), 'the destination is still recognized by its address when it has a name');
t = m.parseTraceroute(TRACE6_NAMES);
check(t.hops[0].routers[0].name === null && t.hops[3].routers[0].name === 'vodafone.rom.namex.it' && t.hops[3].routers[0].addr === '2001:7f8:10::3:722' && t.hops[4].routers[0].name === 'cloudflare.rom.namex.it', 'IPv6 routers with and without names');
t = m.parseTraceroute('traceroute to 10.0.0.1 (10.0.0.1), 30 hops max, 46 byte packets\n 1  a.example (10.0.0.2)  1.0 ms  b.example (10.0.0.3)  2.0 ms  *\n');
check(t.hops[0].routers.length === 2 && t.hops[0].routers[1].name === 'b.example' && t.hops[0].routers[1].addr === '10.0.0.3' && t.hops[0].probes.length === 3, 'a hop answered by two named routers lists both, each with its own name');
check(j(m.parseTraceroute(TRACE).hops[0].routers) === '[{"addr":"37.179.98.1","name":null}]', 'numeric output has routers without names');

console.log('== DNS ==');
let d = m.parseDns(NSLOOKUP);
check(d.verdict === 'ok' && d.answers === 4 && d.server === '127.0.0.1', 'nslookup: four answers (the resolver\'s own Address line does not count) and the server', j(d));
d = m.parseDns(NSLOOKUP_NX);
check(d.verdict === 'nxdomain' && d.answers === 0, 'nslookup: NXDOMAIN');
d = m.parseDns(NSLOOKUP_PTR);
check(d.verdict === 'ok' && d.answers === 1, 'nslookup: a reverse lookup is one answer', j(d));
d = m.parseDns(KDIG);
check(d.verdict === 'ok' && d.answers === 2 && d.server === '127.0.0.1', 'kdig: the answer count comes from the header, the server from the footer', j(d));
check(m.parseDns(KDIG_NX).verdict === 'nxdomain' && m.parseDns(DRILL).answers === 2 && m.parseDns(DRILL).server === '127.0.0.1', 'kdig NXDOMAIN; drill answers and server');
check(m.parseDns(';; ->>HEADER<<- status: NOERROR\n;; Flags: qr; QUERY: 1; ANSWER: 0; AUTHORITY: 1\n').verdict === 'empty', 'a valid reply without answers is "empty"');
check(m.parseDns(';; connection timed out; no servers could be reached\n').verdict === 'timeout' && m.parseDns(';; status: SERVFAIL; ANSWER: 0').verdict === 'servfail' && m.parseDns(';; status: REFUSED; ANSWER: 0').verdict === 'refused', 'timeouts, SERVFAIL and REFUSED');
check(m.parseDns('').verdict === 'ok' && m.parseDns('').answers === 0, 'no output yet is not an error');
check(m.WEAK_NSLOOKUP.includes('MX') && !m.WEAK_NSLOOKUP.includes('A') && !m.WEAK_NSLOOKUP.includes('PTR'), 'the record types busybox nslookup cannot show in full');

console.log('== requests of the new tools ==');
r = m.requestOf(form({ tool: 'check', host: '' }));
check(j(r.args) === j({ tool: 'check' }) && j(m.requestOf(form({ tool: 'check', host: 'example.org' })).args) === j({ tool: 'check', host: 'example.org' }) && m.requestOf(form({ tool: 'check', host: 'a b' })).error, 'the connectivity check needs no host; a given one must be valid', j(r));
r = m.requestOf(form({ tool: 'tls', host: 'mail.example.com', port: '465', sni: 'example.com', starttls: 'smtp' }));
check(j(r.args) === j({ tool: 'tls', host: 'mail.example.com', port: 465, sni: 'example.com', starttls: 'smtp' }), 'a certificate check sends the port, the server name and the STARTTLS protocol', j(r));
check(m.requestOf(form({ tool: 'tls', host: 'example.com' })).args.port === 443 && !('sni' in m.requestOf(form({ tool: 'tls', host: 'example.com' })).args) && !('starttls' in m.requestOf(form({ tool: 'tls', host: 'example.com' })).args), 'the port defaults to 443; no SNI or STARTTLS unless asked');
check(m.requestOf(form({ tool: 'tls', port: '0' })).error && m.requestOf(form({ tool: 'tls', port: '65536' })).error && m.requestOf(form({ tool: 'tls', sni: '-x' })).error && m.requestOf(form({ tool: 'tls', starttls: 'telnet' })).error && m.requestOf(form({ tool: 'tls', host: '' })).error, 'a bad port, server name or protocol, or no host, is refused');
r = m.requestOf(form({ tool: 'compare', host: 'example.com', type: 'AAAA', extraServer: '192.168.1.53' }));
check(j(r.args) === j({ tool: 'compare', host: 'example.com', type: 'AAAA', servers: ['router', '1.1.1.1', '8.8.8.8', '192.168.1.53'] }), 'a comparison sends the chosen servers and the extra one', j(r));
check(m.requestOf(form({ tool: 'compare', servers: [] })).error && m.requestOf(form({ tool: 'compare', servers: ['router', '1.1.1.1', '8.8.8.8', '9.9.9.9', '4.4.4.4', '5.5.5.5'], extraServer: '6.6.6.6' })).error && m.requestOf(form({ tool: 'compare', extraServer: 'a b' })).error && j(m.requestOf(form({ tool: 'compare', extraServer: '1.1.1.1' })).args.servers) === j(['router', '1.1.1.1', '8.8.8.8']), 'no servers, too many, a bad extra server are refused; a repeated one is not added twice');

console.log('== Wake-on-LAN ==');
check(m.isMac('aa:bb:cc:dd:ee:ff') && m.isMac('AA-BB-CC-DD-EE-FF') && !m.isMac('aa:bb:cc:dd:ee') && !m.isMac('aa:bb:cc:dd:ee:fg') && !m.isMac('aabbccddeeff') && !m.isMac('aa:bb:cc:dd:ee:ff\n1') && !m.isMac('1.1.1.1;ls'), 'a MAC address is six hex pairs joined by colons or dashes');
check(m.normMac('AA-BB-CC-DD-EE-FF') === 'aa:bb:cc:dd:ee:ff' && m.normMac('nonsense') === 'nonsense' && m.normMac(undefined) === '', 'a MAC is written in lowercase with colons');
check(j(m.requestOf({ ...m.blankForm(), tool: 'wol', host: ' AA-BB-CC-DD-EE-FF ' }).args) === j({ tool: 'wol', mac: 'aa:bb:cc:dd:ee:ff' }) && j(m.requestOf({ ...m.blankForm(), tool: 'wol', host: 'aa:bb:cc:dd:ee:ff', iface: 'br-lan' }).args) === j({ tool: 'wol', mac: 'aa:bb:cc:dd:ee:ff', iface: 'br-lan' }), 'a wake request carries the MAC (normalized) and the interface when one is chosen');
check(m.requestOf({ ...m.blankForm(), tool: 'wol', host: '1.1.1.1' }).error && m.requestOf({ ...m.blankForm(), tool: 'wol', host: '' }).error && m.requestOf({ ...m.blankForm(), tool: 'wol', host: 'aa:bb:cc:dd:ee:ff', iface: 'br lan' }).error && m.requestOf({ ...m.blankForm(), tool: 'wol', host: 'aa:bb:cc:dd:ee:ff', iface: 'x;y' }).error, 'a host name instead of a MAC, an empty field and a bad interface are refused');
const wolHosts = [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'nas', ip: '192.168.1.5', dev: 'br-lan' }];
check(m.hostOf(wolHosts, 'AA-BB-CC-DD-EE-FF').name === 'nas' && m.hostOf(wolHosts, '11:22:33:44:55:66') === null && m.hostOf(undefined, 'aa:bb:cc:dd:ee:ff') === null, 'a known host is found by its MAC, however it is written');

console.log('== script blocks ==');
const blocks = m.parseBlocks('### BEGIN a 10.00 x y\nline1\n\n### END 0 10.50\n### BEGIN b 11.00 \npartial');
check(blocks.length === 2 && blocks[0].id === 'a' && blocks[0].detail === 'x y' && blocks[0].output === 'line1' && blocks[0].exit === 0 && Math.abs(blocks[0].secs - 0.5) < 1e-9 && !blocks[0].running, 'a block has its id, detail, output, exit code and duration', j(blocks[0]));
check(blocks[1].running && blocks[1].exit === null && blocks[1].secs === null && blocks[1].output === 'partial' && m.parseBlocks('').length === 0, 'a block without END is running');

console.log('== DNS comparison ==');
let c = m.parseCompare(COMPARE, 4);
check(c.rows.length === 4 && c.rows.map(x => x.server).join() === 'router,1.1.1.1,8.8.8.8,192.0.2.1' && c.done, 'one row per server, in the order asked', j(c.rows.map(x => x.server)));
check(c.rows[0].verdict === 'ok' && c.rows[0].data.join() === '104.20.23.154,172.66.147.243' && c.rows[0].ms === 0.5 && c.rows[2].ms === 16.3 && c.rows[0].ad === true && c.rows[1].answers[0].ttl === 200, 'answers, the time the tool reports and the DNSSEC flag', j(c.rows[0].ms));
check(c.rows[3].verdict === 'timeout' && c.rows[3].data.length === 0 && c.rows[3].ms === null, 'a server that does not answer is a timeout with no time');
check(c.agree === true && c.fastest === 'router', 'the same addresses in another order still agree; the fastest server is named');
const parts = COMPARE.split('### BEGIN server');
check(m.parseCompare(['', parts[1], parts[2], parts[3].replace('104.20.23.154', '1.2.3.4'), parts[4]].join('### BEGIN server')).agree === false, 'a different set of addresses means the servers disagree');
c = m.parseCompare(COMPARE_NX, 2);
check(c.rows.every(x => x.verdict === 'empty') && c.agree === null, 'servers that give no answer do not "agree"');
c = m.parseCompare(parts.slice(0, 3).join('### BEGIN server') + '### BEGIN server 9.9 8.8.8.8\n;; partial', 4);
check(c.rows.length === 3 && c.rows[2].running && !c.done && c.rows[2].verdict === null, 'a server still being asked is shown as running');
check(m.dnsReply(NSLOOKUP).answers.length === 4 && m.dnsReply(NSLOOKUP).data.length === 4 && m.dnsReply(KDIG).answers[0].type === 'A' && m.dnsReply(DRILL).answers.length === 2, 'answers are read from nslookup, kdig and drill output');

console.log('== certificate check ==');
const NOW = Date.UTC(2026, 10, 12, 8, 0, 0);
check(m.parseCertDate('Sep  3 00:00:00 2025 GMT') === Date.UTC(2025, 8, 3) && m.parseCertDate('Dec 25 22:56:35 2026 GMT') === Date.UTC(2026, 11, 25, 22, 56, 35) && m.parseCertDate('tomorrow') === null, 'dates as openssl prints them (the day may be space-padded)');
check(m.nameMatches('example.com', ['example.com']) && m.nameMatches('www.example.com', ['*.example.com']) && !m.nameMatches('a.b.example.com', ['*.example.com']) && !m.nameMatches('example.com', ['*.example.com']) && m.nameMatches('EXAMPLE.com', ['example.COM']), 'names match exactly or by a one-label wildcard, ignoring case');
let tl = m.parseTls(TLS_EXAMPLE, { name: 'example.com' }, NOW);
check(tl.chain.length === 4 && tl.level === 'ok' && tl.protocol === 'TLSv1.3' && tl.cipher === 'TLS_AES_256_GCM_SHA384' && tl.group === 'X25519MLKEM768' && tl.verify.code === 0 && tl.address === '2606:4700:10::6814:179a', 'a good chain: four certificates, the session, a clean verification', j([tl.level, tl.protocol, tl.verify]));
const leaf = tl.chain[0];
check(leaf.subject === 'CN=example.com' && leaf.issuer.includes('Cloudflare TLS Issuing ECC CA 3') && leaf.key === 'EC prime256v1' && leaf.sigalg === 'ecdsa-with-SHA256' && leaf.sans.join() === 'DNS:example.com,DNS:*.example.com' && leaf.ca === false && leaf.serial === '01EEE6AABB521D5E14FC315FD9985690' && leaf.sha256.startsWith('85:CA:6A:B0') && leaf.daysLeft === 43 && leaf.role === 'Server certificate' && leaf.pem.startsWith('-----BEGIN CERTIFICATE-----') && leaf.pem.endsWith('-----END CERTIFICATE-----'), 'the server certificate: names, key, signature, serial, fingerprint, days left, PEM', j({ ...leaf, pem: '' }));
check(tl.chain[1].ca === true && tl.chain[1].role === 'Intermediate' && tl.chain[2].key === 'EC secp384r1' && tl.chain[1].sans.length === 0, 'the issuers are certificate authorities with no names');
tl = m.parseTls(TLS_LOCAL, { name: null, target: '127.0.0.1:443' }, NOW);
check(tl.chain[0].key === 'RSA 2048 bit' && tl.chain[0].bits === 2048 && tl.level === 'bad' && tl.findings.some(x => x.level === 'bad' && /address/.test(x.text)) && tl.findings.filter(x => x.level === 'bad').length === 1, 'a certificate that does not cover the address is bad, said once', j(tl.findings));
tl = m.parseTls(TLS_EXPIRED, { name: 'expired.badssl.com' }, NOW);
check(tl.level === 'bad' && tl.chain[0].daysLeft < 0 && tl.findings.some(x => /expired 4232 days ago/.test(x.text)) && tl.findings.filter(x => /has expired|expired \d+ days/.test(x.text)).length === 1 && tl.verify.code === 10, 'an expired certificate says how long ago, once');
tl = m.parseTls(TLS_SELFSIGNED, { name: 'self-signed.badssl.com' }, NOW);
check(tl.level === 'bad' && tl.chain[0].selfSigned && tl.chain[0].role === 'Server certificate' && tl.findings.some(x => /self-signed/.test(x.text)), 'a self-signed certificate is called out');
check(tl.findings.every(x => !x.chain), 'a lone self-signed certificate is not called an incomplete chain');
tl = m.parseTls(TLS_EXAMPLE, { name: 'example.com' }, NOW);
check(tl.gaps.length === 0 && tl.findings.some(x => x.chain && x.level === 'ok' && /4 certificates in order/.test(x.text)), 'a chain in order says so');
tl = m.parseTls(TLS_LEAFONLY, { target: '127.0.0.1:24433' }, NOW);
check(tl.chain.length === 1 && tl.gaps.length === 0 && tl.findings.some(x => x.chain && x.level === 'warn' && /only its own certificate, without the certificate of its issuer \(O=Example Lab, CN=Example Lab Issuing CA\)/.test(x.text) && !/CA store/.test(x.text)), 'a server that sends only its own certificate is told so, naming the missing issuer');
tl = m.parseTls(TLS_LEAFONLY.replace('Verify return code: 21 (unable to verify the first certificate)', 'Verify return code: 0 (ok)'), { target: '127.0.0.1:24433' }, Date.UTC(2026, 10, 20));
check(tl.findings.some(x => x.chain && x.level === 'warn' && /only trusts it because its own CA store holds that issuer/.test(x.text)) && tl.level === 'warn', 'when the router\'s CA store makes up for the missing issuer, that is said and the chain is not called trusted on its own');
tl = m.parseTls(TLS_GAP, { target: '127.0.0.1:24434' }, NOW);
check(j(tl.gaps) === '[0]' && tl.chain.length === 2 && tl.findings.some(x => x.chain && x.level === 'warn' && /incomplete or out of order: certificate 0 was issued by O=Example Lab, CN=Example Lab Issuing CA, but the next certificate it sent is O=Example Lab, CN=Example Lab Root/.test(x.text)), 'a gap between the certificates sent is found');
check(m.parseTls(TLS_EXAMPLE.replace(/ 1 s:/, ' 1 s:X'), { name: 'example.com' }, NOW).gaps.join() === '0', 'a certificate that is not the issuer of the one before it is a gap');
tl = m.parseTls(TLS_RESET, { target: 'x.example:443' }, NOW);
check(tl.error && /closed the connection/.test(tl.error) && tl.chain.length === 0 && tl.level === 'bad' && tl.verify === null, 'a server that hangs up has no chain, an error and no verification');
tl = m.parseTls(TLS_REFUSED, { target: '127.0.0.1:9' }, NOW);
check(/refused the connection/.test(tl.error) && tl.level === 'bad', 'a closed port is "refused"');
check(m.parseTls('### BEGIN tls 1.0 a 443\nConnecting to 1.2.3.4\n', {}, NOW).running && m.parseTls('', {}, NOW).running && m.parseTls('', {}, NOW).chain.length === 0, 'a certificate check that has only begun is running');
const soon = m.parseTls(TLS_EXAMPLE, { name: 'example.com' }, Date.UTC(2026, 11, 20));
check(soon.level === 'warn' && soon.findings.some(x => /expires in 5 days/.test(x.text)), 'a certificate that ends within 14 days is a warning');
check(m.parseTls(TLS_EXAMPLE, { name: 'other.example.net' }, NOW).findings.some(x => x.level === 'bad' && /does not cover other.example.net/.test(x.text)), 'a name the certificate does not list is bad');
check(m.parseTls(TLS_EXAMPLE.replace('Protocol: TLSv1.3', 'Protocol: TLSv1.1'), { name: 'example.com' }, NOW).findings.some(x => x.level === 'warn' && /TLSv1.1/.test(x.text)), 'a protocol older than TLS 1.2 is a warning');
check(m.parseTls(TLS_EXAMPLE.replace('a:PKEY: EC, (prime256v1); sigalg: ecdsa-with-SHA256', 'a:PKEY: RSA, 1024 (bit); sigalg: sha1WithRSAEncryption'), { name: 'example.com' }, NOW).findings.filter(x => x.level === 'warn').length === 2, 'a weak key and a SHA-1 signature are warnings');

console.log('== connectivity check ==');
let ck = m.parseCheck(CHECK_OK, false, { name: 'example.com' }, NOW);
check(ck.steps.map(s => s.id).join() === m.CHECK_STEPS.map(s => s[0]).join() && ck.steps.every(s => s.state === 'ok') && ck.verdict.level === 'ok' && ck.done, 'a healthy router: every step ok and a good verdict', j(ck.steps.map(s => [s.id, s.state])));
check(ck.steps[0].text === 'via 37.179.98.1 on pppoe-wan' && /37\.179\.98\.1 answers/.test(ck.steps[1].text) && /1\.1\.1\.1 \(.*\) and 8\.8\.8\.8 \(.*\) answer/.test(ck.steps[2].text) && /answers with 2 addresses in 0\.40 ms/.test(ck.steps[3].text), 'the steps say what they found', j(ck.steps.map(s => s.text)));
check(ck.steps[7].tls.chain.length === 4 && /certificate for example\.com is trusted/.test(ck.steps[7].text), 'the TLS step carries the parsed certificate');
const swapBlock = (text, id, body, nth = 0) => { const parts = text.split(/(?=### BEGIN )/); let seen = -1; return parts.map(p => { if (!p.startsWith(`### BEGIN ${id} `) || ++seen !== nth) return p; const head = p.split('\n')[0]; return `${head}\n${body}\n\n### END 1 ${head.split(' ')[3]}\n`; }).join(''); };
const DOWN = '--- x ping statistics ---\n2 packets transmitted, 0 packets received, 100% packet loss';
const TIMEOUT = ';; WARNING: response timeout for x@53(UDP)\n;; ERROR: failed to query server x@53(UDP)';
ck = m.parseCheck(CHECK_OK.replace(/default via [^\n]*\n/, ''), false, { name: 'example.com' }, NOW);
check(ck.steps[0].state === 'bad' && /no default route/.test(ck.verdict.text) && ck.verdict.level === 'bad', 'no default route: said first');
let broken = swapBlock(swapBlock(swapBlock(CHECK_OK, 'gateway', DOWN), 'internet4', DOWN, 0), 'internet4', DOWN, 1);
ck = m.parseCheck(broken, false, { name: 'example.com' }, NOW);
check(ck.steps[1].state === 'bad' && ck.steps[2].state === 'bad' && /next hop 37\.179\.98\.1 does not answer/.test(ck.verdict.text), 'a dead next hop and no internet: blame the link to the provider', ck.verdict?.text);
broken = swapBlock(swapBlock(CHECK_OK, 'internet4', DOWN, 0), 'internet4', DOWN, 1);
ck = m.parseCheck(broken, false, { name: 'example.com' }, NOW);
check(ck.steps[1].state === 'ok' && ck.steps[2].state === 'bad' && /next hop answers, but nothing/.test(ck.verdict.text), 'the next hop answers but the internet does not');
ck = m.parseCheck(swapBlock(CHECK_OK, 'internet4', DOWN, 1), false, { name: 'example.com' }, NOW);
check(ck.steps[2].state === 'warn' && /8\.8\.8\.8 does not/.test(ck.steps[2].text) && ck.verdict.level === 'warn', 'one of the two public addresses down is a warning');
ck = m.parseCheck(swapBlock(CHECK_OK, 'dns_router', TIMEOUT), false, { name: 'example.com' }, NOW);
check(ck.steps[3].state === 'bad' && ck.steps[4].state === 'ok' && /router's DNS resolver fails while a public one answers/.test(ck.verdict.text), 'a failing router resolver with a working public one');
ck = m.parseCheck(swapBlock(swapBlock(CHECK_OK, 'dns_router', TIMEOUT), 'dns_public', TIMEOUT), false, { name: 'example.com' }, NOW);
check(/no name can be looked up/.test(ck.verdict.text), 'no DNS at all: port 53 may be blocked');
ck = m.parseCheck(CHECK_OK.replace('Verify return code: 0 (ok)', 'Verify return code: 9 (certificate is not yet valid)').replace('Verification: OK', 'Verification error: certificate is not yet valid'), false, { name: 'example.com' }, Date.UTC(2020, 0, 1));
check(ck.steps[7].state === 'bad' && ck.verdict.level === 'warn' && /clock is wrong/.test(ck.verdict.text), 'a certificate "not yet valid" points at the router\'s clock');
ck = m.parseCheck(swapBlock(swapBlock(CHECK_OK, 'internet6', DOWN), 'route6', ''), false, { name: 'example.com' }, NOW);
check(ck.steps[5].state === 'skip' && /not in use/.test(ck.steps[5].text), 'no IPv6 default route is not a fault');
ck = m.parseCheck(swapBlock(CHECK_OK, 'internet6', DOWN), false, { name: 'example.com' }, NOW);
check(ck.steps[5].state === 'bad' && ck.verdict.notes.length === 1 && /IPv4 works, but IPv6 does not/.test(ck.verdict.notes[0]), 'an IPv6 route that leads nowhere is a note, not the verdict');
ck = m.parseCheck(CHECK_OK.split('### BEGIN dns_public')[0] + '### BEGIN dns_public 492210.47 example.com\n;; partial', true, { name: 'example.com' }, NOW);
check(ck.steps[4].state === 'running' && ck.steps[5].state === 'pending' && ck.verdict === null && !ck.done, 'a check that is running shows the running and the waiting steps and no verdict yet');
ck = m.parseCheck(CHECK_OK.split('### BEGIN dns_public')[0], false, { name: 'example.com' }, NOW);
check(ck.steps[5].state === 'skip' && ck.steps[7].state === 'skip', 'steps that never ran (the job was stopped) are skipped, not pending');

console.log('== how a job ended ==');
check(j(m.outsideBlocks(CHECK_OK)) === '[]' && j(m.outsideBlocks('job.sh: line 37: syntax error\n### BEGIN a 1.0 x\nhi\n### END 0 2.0\nstray after\n')) === j(['job.sh: line 37: syntax error', 'stray after']), 'text outside the blocks is found (the shell\'s own complaints)');
const SYNTAX = 'job.sh: line 37: syntax error: unexpected end of file (expecting "fi")\n';
check(/could not run: job\.sh: line 37: syntax error/.test(m.scriptProblem({ tool: 'check', text: SYNTAX, running: false, exit: 2 })) && m.scriptProblem({ tool: 'compare', text: '', running: false, exit: 0 }) === 'The job produced no output.' && m.scriptProblem({ tool: 'check', text: CHECK_OK, running: false, exit: 0 }) === null && m.scriptProblem({ tool: 'check', text: SYNTAX, running: true }) === null && m.scriptProblem({ tool: 'check', text: '', running: false, stopped: true }) === null && m.scriptProblem({ tool: 'ping', text: SYNTAX, running: false }) === null, 'a script that could not run is reported; a stopped, running or simple-tool job is not a script failure');
check(m.endOf({ exit: 0 }, 25).kind === 'ok' && m.endOf({ exit: 1 }, 25).kind === 'ok', 'exit 0, and exit 1 (ping got no reply), are a finished tool');
check(m.endOf({ exit: 143, stopped: true }, 25).kind === 'stopped' && m.endOf({ exit: 124, timedOut: true }, 25).text === 'Stopped at the 25 second limit', 'stopped by the user; stopped by the time limit');
check(m.endOf({ exit: 2 }, 25).text === 'Failed (exit code 2)' && m.endOf({ exit: null }, 25).text === 'Ended' && m.endOf({ error: 'There is no such job.' }, 25).kind === 'failed', 'other ends');
check(m.fmtMs(0.1234) === '0.12 ms' && m.fmtMs(4.309) === '4.3 ms' && m.fmtMs(120.4) === '120 ms' && m.fmtMs(null) === '–', 'times are shown with a sensible precision');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall Diagnostics model checks passed');
