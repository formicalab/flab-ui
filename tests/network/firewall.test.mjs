// Unit test for the firewall page's pure parts (www/js/pages/firewall/model.js and util.js): the zone matrix
// and the findings. Usage: node firewall.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Imports one module of the firewall page by file name.
const page = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/firewall', f)).href);
const { buildMatrix, ROUTER } = await page('model.js');
const { findings, describeMatch } = await page('util.js');

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

// A router like the lab one: lan reaches wan and vpn; vpn reaches lan; wan is closed except for rules.
// A zone as flab.firewall reports it; `forwards` lists the destination zones it may forward to.
const zone = (name, input, output, forward, forwards = [], extra = {}) => ({ name, networks: [name], devices: [name], input, output, forward, forwards, masq: false, mtu_fix: false, enabled: true, blocked_from: null, blocked_to: null, ...extra });
// A traffic rule with no match restrictions; `extra` adds protocol, ports, family and so on. An undefined src or dest means the router itself.
const rule = (name, src, dest, target, extra = {}) => ({ name, key: name, src, dest, proto: [], src_ip: [], dest_ip: [], src_port: [], dest_port: [], icmp_type: [], family: 'any', target, enabled: true, hits: null, ...extra });
// Builds a fresh baseline firewall state (a new object each call, so tests can mutate it freely).
const base = () => ({
  running: true,
  defaults: { synflood_protect: true, flow_offloading: true, flow_offloading_hw: false },
  zones: [
    zone('lan', 'ACCEPT', 'ACCEPT', 'ACCEPT', ['wan', 'vpn']),
    zone('wan', 'REJECT', 'ACCEPT', 'REJECT', [], { masq: true }),
    zone('vpn', 'ACCEPT', 'ACCEPT', 'ACCEPT', ['lan']),
  ],
  rules: [
    rule('Allow-Ping', 'wan', undefined, 'ACCEPT', { proto: ['icmp'], icmp_type: ['echo-request'] }),
    rule('Allow-WG', 'wan', undefined, 'ACCEPT', { proto: ['udp'], dest_port: ['51820'] }),
    rule('Reject-Squid-VPN', 'vpn', undefined, 'REJECT', { proto: ['tcp'], dest_port: ['3128'] }),
    rule('Allow-ICMPv6-Forward', 'wan', '*', 'ACCEPT', { proto: ['icmp'], family: 'ipv6' }),
    rule('Router-DNS-Out', undefined, 'wan', 'ACCEPT', { proto: ['udp'], dest_port: ['53'] }),
  ],
  redirects: [],
  unzoned: [], conntrack: { count: 100, max: 1000 },
});

console.log('== matrix ==');
const m = buildMatrix(base());
// The matrix cell for traffic from `s` to `d` (zone names or ROUTER) in the baseline matrix.
const cell = (s, d) => m.rows.find(r => r.src === s).cells[m.ends.indexOf(d)];
check(m.ends.join() === `${ROUTER},lan,wan,vpn` && m.rows.length === 4, 'the router plus every zone, as source and destination');
check(cell(ROUTER, ROUTER) === null, 'router to router is not a thing');
check(cell('lan', 'wan').state === 'open' && cell('lan', 'vpn').state === 'open' && cell('vpn', 'lan').state === 'open', 'a forwarding opens that direction only');
check(cell('vpn', 'wan').state === 'closed' && cell('vpn', 'wan').policy === 'BLOCKED' && cell('lan', 'wan').policy === 'ACCEPT', 'no forwarding: blocked');
check(cell('lan', 'lan').state === 'open' && cell('wan', 'wan').policy === 'REJECT', "the zone's forward policy governs traffic within the zone");
check(cell('lan', ROUTER).state === 'open' && cell(ROUTER, 'wan').state === 'open', 'input and output policies: zone to router, router to zone');
const wanRouter = cell('wan', ROUTER);
check(wanRouter.state === 'partial' && wanRouter.policy === 'REJECT' && wanRouter.accepts.join() === 'Allow-Ping,Allow-WG', 'rules without a destination open specific traffic to the router: partial', JSON.stringify(wanRouter));
check(cell('wan', 'lan').accepts.join() === 'Allow-ICMPv6-Forward' && cell('wan', 'lan').state === 'partial' && cell('wan', 'vpn').state === 'partial', 'a rule with dest "*" applies to every zone', JSON.stringify(cell('wan', 'lan')));
check(cell('wan', 'wan').accepts.join() === 'Allow-ICMPv6-Forward', 'dest "*" includes the source zone itself');
check(cell('vpn', ROUTER).state === 'open' && cell('vpn', ROUTER).blocks.join() === 'Reject-Squid-VPN', 'a reject rule is noted on an open cell as blocking part of it');
check(cell(ROUTER, 'wan').state === 'open' && cell(ROUTER, 'lan').accepts.length === 0, 'rules without a source concern the router itself');

console.log('== matrix: port forwards, disabled rules, bad rules ==');
const fw2 = base();
fw2.redirects.push({ name: 'Web', key: 'Web', kind: 'redirect', src: 'wan', dest: 'lan', target: 'DNAT', enabled: true, proto: ['tcp'], src_dport: ['8080'], src_dip: [], dest_port: ['80'], dest_ip: '192.168.1.10' });
fw2.redirects.push({ name: 'Off', key: 'Off', kind: 'redirect', src: 'wan', dest: 'vpn', target: 'DNAT', enabled: false });
fw2.rules.find(r => r.name === 'Allow-WG').enabled = false;
fw2.rules.push(rule('Ghost', 'nowhere', 'lan', 'ACCEPT'), rule('Empty', undefined, undefined, 'ACCEPT'));
const m2 = buildMatrix(fw2);
// Same lookup as cell(), on the matrix with port forwards and odd rules.
const c2 = (s, d) => m2.rows.find(r => r.src === s).cells[m2.ends.indexOf(d)];
check(c2('wan', 'lan').accepts.includes('Web (port forward)') && c2('wan', 'vpn').accepts.join() === 'Allow-ICMPv6-Forward', 'an enabled port forward opens wan to its destination zone; a disabled one does not');
check(!c2('wan', ROUTER).accepts.includes('Allow-WG'), 'a disabled rule is ignored');
check(m2.rows.every(r => r.cells.every(c => !c || c.accepts.every(a => a !== 'Ghost' && a !== 'Empty'))), 'rules naming an unknown zone, or neither side, are ignored');
const fw3 = base();
fw3.zones[2].enabled = false;
check(buildMatrix(fw3).ends.join() === `${ROUTER},lan,wan`, 'a disabled zone is left out');

console.log('== describing a rule ==');
check(describeMatch(rule('a', 'wan', undefined, 'ACCEPT', { proto: ['udp'], dest_port: ['500', '4500'] })) === 'UDP 500, 4500', 'protocol and ports');
check(describeMatch(rule('a', 'wan', undefined, 'ACCEPT', { proto: ['tcp'], dest_port: ['3128'], src_ip: ['192.168.100.0/24'] })) === 'TCP 3128 from 192.168.100.0/24', 'source address');
check(describeMatch(rule('a', 'wan', undefined, 'ACCEPT', { proto: ['icmp'], icmp_type: ['echo-request'], family: 'ipv4' })) === 'ICMP echo-request · IPv4 only', 'ICMP type and family');
check(describeMatch(rule('a', 'wan', undefined, 'ACCEPT', { proto: ['icmp'], icmp_type: ['a', 'b', 'c', 'd', 'e'], limit: '1000/sec' })) === 'ICMP 5 message types (limited to 1000/sec)', 'many ICMP types are counted, a limit is shown');
check(describeMatch(rule('a', 'wan', undefined, 'ACCEPT')) === 'TCP/UDP', 'a rule without a protocol means TCP and UDP');

console.log('== findings ==');
// All finding texts of a firewall state, joined for regex matching.
const texts = fw => findings(fw).map(f => f.text).join(' | ');
check(findings(base()).length === 0, 'the sensible setup has no findings', texts(base()));
check(findings({ ...base(), running: false })[0].level === 'bad' && /not loaded/.test(texts({ ...base(), running: false })), 'no fw4 table: the firewall is not loaded');
const wide = base(); wide.zones[1].input = 'ACCEPT';
check(findings(wide).some(f => f.level === 'bad' && /accepts all traffic to the router/.test(f.text)), 'an Internet-facing zone that accepts input is called out');
const openRule = base(); openRule.rules.push(rule('Open-All', 'wan', undefined, 'ACCEPT'));
check(/Open-All accepts every TCP\/UDP port/.test(texts(openRule)), 'a rule opening all ports from the Internet is called out');
check(!/accepts every/.test(texts(base())), 'port-restricted accepts are fine');
const unzoned = base(); unzoned.unzoned = ['lan100'];
check(/lan100 is in no firewall zone/.test(texts(unzoned)), 'an interface in no zone is reported');
const ghost = base(); ghost.rules.push(rule('Ghost', 'nowhere', 'lan', 'ACCEPT'));
check(/refers to zone "nowhere"/.test(texts(ghost)), 'a rule naming an unknown zone is reported');
const off = base(); off.rules[0].enabled = false;
check(/1 rule is disabled: Allow-Ping/.test(texts(off)), 'disabled rules are listed');
const full = base(); full.conntrack = { count: 900, max: 1000 };
check(/Connection tracking is 90 % full/.test(texts(full)), 'a nearly full connection table is reported');
const nosyn = base(); nosyn.defaults.synflood_protect = false;
check(/SYN-flood protection is off/.test(texts(nosyn)), 'SYN-flood protection off is reported when a zone faces the Internet');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall firewall model checks passed');
