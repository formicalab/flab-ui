// Unit test for the DHCP model (www/js/pages/dhcp/{schema,model}.js): reading the config and the odhcpd lease data,
// the draft, validation, the change list, the UCI plan and the read-back check. Pure functions: no router and no
// browser. Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Imports a module of the DHCP page by file name.
const page = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/dhcp', f)).href);
const m = await page('model.js');
const { CONFIG, GLOBAL_CONFIG, DAEMON_FIELDS, GLOBAL_FIELDS, POOL_FIELDS, POOL_GROUPS, HOST_FIELDS, BOOT6_FIELDS } = await page('schema.js');
const { CHECKS } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/core/fields.js')).href);

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// A `uci get dhcp` reply shaped like the real router's: two pools, the daemon, and four reservations (one without
// an address, one with two MACs).
const section = (name, type, values) => ({ '.anonymous': false, '.type': type, '.name': name, ...values });
// The `uci get dhcp` reply above, with `over` overriding the daemon section or a pool.
const cfg = (over = {}) => ({
  odhcpd: section('odhcpd', 'odhcpd', { maindhcp: '1', leasefile: '/tmp/odhcpd.leases', loglevel: '6', ...over.daemon }),
  lan: section('lan', 'dhcp', { interface: 'lan', start: '128', limit: '120', leasetime: '8h', dhcpv4: 'server', dhcpv6: 'server', ra: 'server', ra_slaac: '0', ra_flags: ['managed-config', 'other-config'], dns: '192.168.1.1', domain: 'lab.example.com', ...over.lan }),
  lan100: section('lan100', 'dhcp', { interface: 'lan100', start: '128', limit: '120', dhcpv4: 'server', ra: 'server', ...over.lan100 }),
  cfg1: section('cfg1', 'host', { mac: '88:AE:DD:66:16:05', ip: '192.168.1.2', name: 'flabn01' }),
  cfg2: section('cfg2', 'host', { mac: '38:A6:CE:49:BF:D6', name: 'SkyQ-L2-Mesh' }),
  cfg3: section('cfg3', 'host', { mac: ['02:F0:F4:50:6B:7D', '02:F0:F4:50:6B:7E'], ip: '192.168.1.3', name: 'homeassistant', leasetime: '1h' }),
  cfg4: section('cfg4', 'host', { duid: '000100011ee0f1ed4cbad7bba6ae', hostid: '11', name: 'soundbar' }),
});
const dump = { interface: [
  { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }] },
  { interface: 'lan100', up: true, l3_device: 'br-lan.100', 'ipv4-address': [{ address: '192.168.100.1', mask: 24 }] },
  { interface: 'wan', up: true, l3_device: 'eth1', 'ipv4-address': [{ address: '203.0.113.7', mask: 29 }] },
  { interface: 'loopback', up: true, l3_device: 'lo' },
] };
const v4 = { device: { 'br-lan': { leases: [
  { mac: '88aedd661605', hostname: 'flabn01', 'accept-reconf': true, flags: ['bound', 'static'], address: '192.168.1.2', valid: 19688 },
  { mac: 'aabbccddeeff', hostname: 'laptop', flags: ['bound'], address: '192.168.1.150', valid: 3600 },
  { mac: '112233445566', hostname: '', flags: ['bound', 'broken-hostname'], address: '192.168.1.140', valid: 100 },
] } } };
const v6 = { device: { 'br-lan': { leases: [
  { duid: '0001000130b378f788aedd661605', iaid: 7, hostname: 'flabn01', flags: ['bound', 'static'], valid: 4544,
    'ipv6-addr': [{ address: '2a01:827::2', 'preferred-lifetime': 1844, 'valid-lifetime': 4544 }], 'ipv6-prefix': [{ address: 'fd00:1:2:3::', 'prefix-length': 64, 'preferred-lifetime': 10, 'valid-lifetime': 20 }] },
] } } };
const ra = { interfaces: { 'br-lan': [{ prefix: '2a01:827::1', length: 60, stale: false }, { prefix: 'fd00::1', length: 60, stale: true }] } };
const svc = { odhcpd: { instances: { instance1: { running: true } } } };
// The page model read from the fixture config (with `over` applied) and the lease, prefix and service fixtures.
const data = (over) => m.readDhcp(cfg(over), v4, v6, ra, dump, svc);
// A draft of `d`, with `edit` applied to it.
const draftOf = (d, edit) => { const dr = m.draftFrom(d); edit?.(dr); return dr; };
// The reservation of a draft that comes from config section `section`.
const host = (dr, section) => dr.hosts.find(r => r.section === section);

console.log('== the schema ==');
const all = [...DAEMON_FIELDS, ...GLOBAL_FIELDS, ...POOL_FIELDS, ...HOST_FIELDS, ...BOOT6_FIELDS];
check(new Set(DAEMON_FIELDS.map(f => f.key)).size === DAEMON_FIELDS.length && new Set(POOL_FIELDS.map(f => f.key)).size === POOL_FIELDS.length, 'every option appears once per section type');
check(all.every(f => ['string', 'text', 'bool', 'int', 'enum', 'list'].includes(f.type) && f.label) && POOL_FIELDS.every(f => POOL_GROUPS.some(g => g.id === f.group)), 'every field has a known type, a label and (for pools) a group');
check(all.filter(f => f.check).every(f => CHECKS[f.check]) && all.filter(f => f.type === 'enum').every(f => f.options.includes(f.default)) && all.filter(f => f.type === 'bool').every(f => typeof f.default === 'boolean'), 'checks exist, enums list their default, switches have a boolean default');
// The options of odhcpd's own tables (src/config.c of https://github.com/openwrt/odhcpd): the dhcp section ...
const documentedPool = ['interface', 'ifname', 'networkid', 'master', 'ra', 'dhcpv6', 'dhcpv4', 'ndp', 'dynamicdhcp', 'dhcpv4_forcereconf', 'dhcpv6_assignall', 'dhcpv6_hostidlength', 'dhcpv6_na', 'dhcpv6_pd', 'dhcpv6_pd_preferred', 'dhcpv6_pd_min_len', 'dhcpv6_relay_servers', 'router', 'dns', 'dnr', 'dns_service', 'domain', 'leasetime', 'start', 'limit', 'max_preferred_lifetime', 'max_valid_lifetime', 'ra_default', 'ra_flags', 'ra_slaac', 'ra_advrouter', 'ra_offlink', 'ra_preference', 'ra_maxinterval', 'ra_mininterval', 'ra_lifetime', 'ra_reachabletime', 'ra_retranstime', 'ra_hoplimit', 'ra_mtu', 'ra_dns', 'ra_pref64', 'ndproxy_routing', 'ndproxy_slave', 'ndp_from_link_local', 'prefix_filter', 'ntp', 'upstream', 'captive_portal_uri', 'ipv6_only_preferred'];
// ... of which only `interface` is not edited (it is what binds the pool to its interface; the page shows it in the header).
// dhcpv6_raw is undocumented there and shown read only.
const missing = documentedPool.filter(k => k !== 'interface' && !POOL_FIELDS.some(f => f.key === k));
check(missing.length === 0 && POOL_FIELDS.every(f => documentedPool.includes(f.key)), 'every option of odhcpd\'s dhcp section is edited, except the one that binds the pool, and nothing odhcpd no longer reads is offered', missing.join());
check(['maindhcp', 'leasefile', 'leasetrigger', 'hostsdir', 'piodir', 'loglevel', 'enable_tz'].every(k => DAEMON_FIELDS.some(f => f.key === k)) && DAEMON_FIELDS.length === 7, 'every daemon option is there');
check(GLOBAL_FIELDS.map(f => f.key).join() === 'dhcp_default_duid' && GLOBAL_CONFIG === 'network' && BOOT6_FIELDS.map(f => f.key).join() === 'url,arch', 'the server DUID (network config) and the boot6 options (url, arch) are edited');
check(all.every(f => f.label && f.hint && f.hint.length > 15), 'every option has a label and an explanation', all.filter(f => !f.hint).map(f => f.key).join());
check(HOST_FIELDS.map(f => f.key).join() === 'name,ip,mac,duid,hostid,leasetime' && CONFIG === 'dhcp', 'the reservation options are the documented ones');
check(CHECKS.dnr('1 dns.example.com') === null && CHECKS.dnr('1 dns.example.com 192.0.2.1,192.0.2.2 alpn=h2') === null && CHECKS.dnr('dns.example.com') !== null && CHECKS.dnr('70000 dns.example.com') !== null && CHECKS.url('tftp://[fd11::1]/pxe.efi') === null && CHECKS.url('pxe.efi') !== null, 'encrypted DNS entries need a priority and a domain; boot addresses need a scheme');

console.log('== addresses ==');
check(m.ipToInt('192.168.1.1') === 3232235777 && m.ipToInt('256.1.1.1') === null && m.ipToInt('1.2.3') === null && m.intToIp(3232235777) === '192.168.1.1', 'IPv4 addresses to and from numbers');
let r = m.poolRange('192.168.1.1', 24, 128, 120);
check(r.first === '192.168.1.128' && r.last === '192.168.1.247' && r.count === 120 && !r.clamped, 'a pool is counted from the start of the subnet (start 128, limit 120 is .128 to .247)', j(r));
r = m.poolRange('192.168.1.1', 24, 200, 100);
check(r.last === '192.168.1.254' && r.clamped && r.count === 55, 'a pool that is too long ends at the last host address', j(r));
check(m.poolRange('192.168.1.1', 24, 300, 10).outside === true && m.poolRange('10.1.2.3', 8, 100, 150).first === '10.0.0.100' && m.poolRange('x', 24, 1, 1) === null && m.poolRange('192.168.1.1', 31, 1, 1) === null, 'a start beyond the subnet is outside; other subnet sizes work; bad input gives none');
check(m.inSubnet('192.168.1.200', '192.168.1.1', 24) && !m.inSubnet('192.168.2.1', '192.168.1.1', 24) && m.inSubnet('10.9.9.9', '10.0.0.1', 8), 'subnet membership');
check(m.macOf('88AEDD661605') === '88:ae:dd:66:16:05' && m.macOf('88-AE-DD-66-16-05') === '88:ae:dd:66:16:05' && m.macOf('88:AE:DD:66:16:05') === '88:ae:dd:66:16:05' && m.macOf('nonsense') === 'nonsense', 'MACs in one spelling');
check(m.macFromDuid('0001000130b378f788aedd661605') === '88:ae:dd:66:16:05' && m.macFromDuid('00030001aed3314dc32f') === 'ae:d3:31:4d:c3:2f' && m.macFromDuid('00020000ab11e99a4ef83f664cfe') === '', 'DUID-LLT and DUID-LL expose their MAC; DUID-EN does not');

console.log('== reading ==');
let d = data();
check(d.pools.length === 2 && d.pools[0].iface === 'lan' && d.pools[0].info.v4.address === '192.168.1.1' && d.pools[1].info.v4.mask === 24 && d.hosts.length === 4 && d.daemon.section === 'odhcpd', 'pools are bound to their interface, with its address; reservations and the daemon found');
check(d.daemonRunning === true && m.readDhcp(cfg(), null, null, null, null, null).daemonRunning === null && m.readDhcp(cfg(), null, null, null, null, { odhcpd: { instances: {} } }).daemonRunning === false, 'the daemon state: running, unknown, stopped');
check(d.leases4.length === 3 && d.leases4[0].iface === 'lan' && d.leases4[0].mac === '88:ae:dd:66:16:05' && d.leases4[0].static && !d.leases4[1].static && d.leases4[2].flags.includes('broken-hostname'), 'IPv4 leases: interface from the device, MAC spelled out, reserved or dynamic', j(d.leases4[0]));
check(d.leases6.length === 1 && d.leases6[0].addresses[0].address === '2a01:827::2' && d.leases6[0].prefixes[0].length === 64 && d.leases6[0].static, 'IPv6 leases keep their addresses and delegated prefixes');
const anonymous6 = { device: { 'br-lan': { leases: [{ ...v6.device['br-lan'].leases[0], hostname: '' }] } } };
const correlated = m.readDhcp(cfg(), v4, anonymous6, ra, dump, svc).leases6[0];
check(correlated.hostname === 'flabn01' && correlated.mac === '88:ae:dd:66:16:05', 'a DHCPv6 lease with a link-layer DUID is named from the matching DHCPv4 client');
check(d.ra[0].iface === 'lan' && d.ra[0].prefixes.length === 2 && d.ra[0].prefixes[1].stale === true, 'announced prefixes per interface');
const empty = m.readDhcp({}, null, null, null, null, null);
check(empty.pools.length === 0 && empty.hosts.length === 0 && empty.daemon.section === null && empty.leases4.length === 0, 'nothing known: everything empty, no error');
check(d.hosts[2].values.mac.length === 2 && m.draftFrom(d).hosts[2].values.mac === '02:F0:F4:50:6B:7D 02:F0:F4:50:6B:7E', 'a list of MACs is edited as one text');

console.log('== who serves DHCPv4 ==');
const dnsmasqSvc = { dnsmasq: { instances: { cfg01: { running: true } } } };
const stopped = { dnsmasq: { instances: { cfg01: { running: false } } } };
// The fixture config with the daemon's main DHCP switched off, so that dnsmasq serves DHCP.
const split = over => cfg({ ...over, daemon: { maindhcp: '0', ...over?.daemon } });
const NOW = 1_800_000_000;
const leaseFile = [
  `${NOW + 3000} 88:ae:dd:66:16:05 192.168.1.2 flabn01 01:88:ae:dd:66:16:05`,
  `${NOW + 600} AA:BB:CC:DD:EE:FF 192.168.1.150 * *`,
  '0 de:ad:be:ef:00:01 192.168.100.20 infinite *',
  `${NOW - 10} 11:22:33:44:55:66 10.99.0.5 outside *`,
  'duid 00:01:00:01:aa:bb',
  `${NOW + 100} 5 fd00::5 v6host 00:01`,
  '',
].join('\n');
check(m.dhcpv4Server(cfg(), dnsmasqSvc) === 'odhcpd' && m.dhcpv4Server(split(), dnsmasqSvc) === 'dnsmasq' && m.dhcpv4Server(split(), stopped) === 'other' && m.dhcpv4Server(split(), null) === 'other', 'DHCPv4 is odhcpd\'s when it is the main server, dnsmasq\'s when that runs, otherwise unknown');
check(m.dhcpv4Server({ lan: cfg().lan }, dnsmasqSvc) === 'dnsmasq', 'without an odhcpd section odhcpd is not the main server');
check(m.dnsmasqLeaseFile(cfg()) === '/tmp/dhcp.leases' && m.dnsmasqLeaseFile({ x: section('x', 'dnsmasq', { leasefile: '/tmp/other.leases' }) }) === '/tmp/other.leases', 'the lease file is dnsmasq\'s option, with OpenWrt\'s default');
const dd = m.readDhcp(split(), null, v6, ra, dump, svc, { svc: dnsmasqSvc, leases: leaseFile, now: NOW });
check(dd.server === 'dnsmasq' && dd.leases4.length === 4 && !dd.leasesUnreadable, 'dnsmasq\'s IPv4 leases are listed (IPv6 and "duid" lines skipped)', j(dd.leases4.map(l => l.address)));
check(dd.leases4[0].iface === 'lan' && dd.leases4[0].device === 'br-lan' && dd.leases4[0].mac === '88:ae:dd:66:16:05' && dd.leases4[0].hostname === 'flabn01' && dd.leases4[0].valid === 3000, 'a lease gets its interface from the subnet, a MAC in one spelling and the time left', j(dd.leases4[0]));
check(dd.leases4[0].static && dd.leases4[0].flags.includes('static') && !dd.leases4[1].static && dd.leases4[1].hostname === '' && dd.leases4[1].mac === 'aa:bb:cc:dd:ee:ff', 'a lease matching a reservation is reserved; "*" means no hostname');
check(dd.leases4[2].iface === 'lan100' && dd.leases4[2].valid === null && dd.leases4[3].iface === '' && dd.leases4[3].valid === 0, 'a lease that never expires has no time left, one outside every subnet no interface, an expired one 0');
check(m.readDhcp(split(), null, v6, ra, dump, svc, { svc: dnsmasqSvc, leases: null, now: NOW }).leasesUnreadable === true && m.readDhcp(split(), null, v6, ra, dump, svc, { svc: dnsmasqSvc, leases: '', now: NOW }).leasesUnreadable === false, 'an unreadable lease file is flagged, an empty one is not');
check(m.readDhcp(cfg(), v4, v6, ra, dump, svc, { svc: dnsmasqSvc, leases: leaseFile, now: NOW }).leases4.length === 3 && m.readDhcp(split(), v4, v6, ra, dump, svc).leases4.length === 3, 'odhcpd\'s own leases are shown when it is the main server, or when no other server is known');

console.log('== no edit, no change ==');
check(m.changesOf(d, m.draftFrom(d)).length === 0 && !m.isDirty(d, m.draftFrom(d)) && m.plan(d, m.draftFrom(d)).length === 0, 'an untouched form has no changes and writes nothing');
check(m.problems(d, m.draftFrom(d)).errors.length === 0, 'the router\'s own configuration is valid (a reservation with only a name and a MAC included)', j(m.problems(d, m.draftFrom(d)).errors));
check(m.changesOf(d, draftOf(d, x => { host(x, 'cfg1').values.mac = '88-ae-dd-66-16-05'; host(x, 'cfg1').values.name = ' flabn01 '; })).length === 0, 'another spelling of the same MAC, or stray spaces, is not a change');
check(m.isDirty(d, draftOf(d, x => { m.newHost(x); })) && m.plan(d, draftOf(d, x => { m.newHost(x); })).length === 0 && m.problems(d, draftOf(d, x => { m.newHost(x); })).errors.length === 0, 'an empty new reservation is dirty (it can be discarded) but writes and complains about nothing');

console.log('== pools and the daemon: plan ==');
let ops = m.plan(d, draftOf(d, x => { x.pools.lan.limit = '100'; x.pools.lan.leasetime = '12h'; x.pools.lan.dynamicdhcp = false; x.pools.lan.dns = ['192.168.1.1', '1.1.1.1']; }));
check(j(ops) === j([{ op: 'set', config: 'dhcp', section: 'lan', values: { dynamicdhcp: '0', limit: '100', leasetime: '12h', dns: ['192.168.1.1', '1.1.1.1'] } }]), 'a pool\'s changed options are set in one operation, switches as 0/1, lists as arrays', j(ops));
ops = m.plan(d, draftOf(d, x => { x.pools.lan.domain = []; x.pools.lan.ra_flags = ['other-config']; }));
check(j(ops) === j([{ op: 'set', config: 'dhcp', section: 'lan', values: { ra_flags: ['other-config'] } }, { op: 'delete', config: 'dhcp', section: 'lan', options: ['domain'] }]), 'an emptied option is deleted, not set to an empty list', j(ops));
ops = m.plan(d, draftOf(d, x => { x.pools.lan100.leasetime = '1d'; x.daemon.loglevel = '5'; x.daemon.enable_tz = false; }));
check(j(ops) === j([{ op: 'set', config: 'dhcp', section: 'odhcpd', values: { loglevel: '5', enable_tz: '0' } }, { op: 'set', config: 'dhcp', section: 'lan100', values: { leasetime: '1d' } }]), 'the daemon and each pool get their own operation', j(ops));
check(m.plan(d, draftOf(d, x => { x.pools.lan.dhcpv6 = ''; })).some(o => o.op === 'delete' && o.options.includes('dhcpv6')), 'an enum set back to its default (empty) is deleted');
const noDaemon = m.readDhcp({ lan: cfg().lan }, null, null, null, dump, null);
check(j(m.plan(noDaemon, draftOf(noDaemon, x => { x.daemon.loglevel = '3'; }))) === j([{ op: 'add', config: 'dhcp', type: 'odhcpd', name: 'odhcpd', values: { loglevel: '3' } }]), 'a missing odhcpd section is created');

console.log('== reservations: plan ==');
ops = m.plan(d, draftOf(d, x => { host(x, 'cfg1').values.ip = '192.168.1.20'; host(x, 'cfg1').values.leasetime = '2h'; }));
check(j(ops) === j([{ op: 'set', config: 'dhcp', section: 'cfg1', values: { ip: '192.168.1.20', leasetime: '2h' } }]), 'a changed reservation sets only what changed', j(ops));
ops = m.plan(d, draftOf(d, x => { host(x, 'cfg1').values.name = ''; }));
check(j(ops) === j([{ op: 'delete', config: 'dhcp', section: 'cfg1', options: ['name'] }]), 'an emptied field is deleted');
ops = m.plan(d, draftOf(d, x => { host(x, 'cfg2').removed = true; }));
check(j(ops) === j([{ op: 'delete', config: 'dhcp', section: 'cfg2' }]), 'a removed reservation deletes its section');
ops = m.plan(d, draftOf(d, x => { const n = m.newHost(x); n.values.name = 'printer'; n.values.ip = '192.168.1.21'; n.values.mac = 'dc:cd:2f:a8:b1:7a'; }));
check(j(ops) === j([{ op: 'add', config: 'dhcp', type: 'host', values: { name: 'printer', ip: '192.168.1.21', mac: 'DC:CD:2F:A8:B1:7A' } }]), 'a new reservation is added with its non-empty options, the MAC in capitals', j(ops));
ops = m.plan(d, draftOf(d, x => { const n = m.newHost(x); n.values.mac = 'aa:bb:cc:dd:ee:01, aa:bb:cc:dd:ee:02'; n.values.ip = '192.168.1.22'; n.removed = false; }));
check(Array.isArray(ops[0].values.mac) && ops[0].values.mac.length === 2, 'several MACs (spaces or commas) are written as a list');
ops = m.plan(d, draftOf(d, x => { const n = m.newHost(x); n.values.mac = 'aa:bb:cc:dd:ee:01'; n.removed = true; }));
check(ops.length === 0, 'a new reservation that is removed again writes nothing');
ops = m.plan(d, draftOf(d, x => { host(x, 'cfg3').values.mac = '02:F0:F4:50:6B:7D'; }));
check(j(ops) === j([{ op: 'set', config: 'dhcp', section: 'cfg3', values: { mac: '02:F0:F4:50:6B:7D' } }]), 'a list cut down to one MAC is written as a single value');
const rv = m.changesOf(d, draftOf(d, x => { host(x, 'cfg1').values.ip = '192.168.1.20'; host(x, 'cfg2').removed = true; const n = m.newHost(x); n.values.name = 'new'; n.values.mac = 'aa:bb:cc:dd:ee:01'; x.pools.lan.limit = '90'; }));
check(rv.length === 4 && rv.some(c => c.label === 'Reservation flabn01: IPv4 address' && c.from === '192.168.1.2' && c.to === '192.168.1.20') && rv.some(c => /^Remove reservation SkyQ-L2-Mesh/.test(c.label)) && rv.some(c => /^New reservation new/.test(c.label)) && rv.some(c => c.label === 'lan: Pool size'), 'the review lists each change by what it is', j(rv));

console.log('== validation ==');
// The errors that validating `edit` applied to a draft of `base` reports.
const errs = (edit, base = d) => m.problems(base, draftOf(base, edit)).errors;
// The warnings that validating `edit` applied to a draft of `base` reports.
const warns = (edit, base = d) => m.problems(base, draftOf(base, edit)).warnings;
check(errs(x => { x.pools.lan.start = 'x'; }).some(e => e.key === 'pool:lan:start') && errs(x => { x.pools.lan.limit = '0'; }).length === 1 && errs(x => { x.pools.lan.leasetime = 'soon'; }).length === 1 && errs(x => { x.pools.lan.leasetime = 'infinite'; }).length === 0, 'numbers and lease times are checked');
check(errs(x => { x.pools.lan.dns = ['1.1.1.1', 'not an ip']; }).some(e => e.key === 'pool:lan:dns' && e.index === 1) && errs(x => { x.pools.lan.router = ['fd00::1']; }).length === 1 && errs(x => { x.pools.lan.dhcpv6_relay_servers = ['192.168.1.1']; }).length === 1, 'list items are checked by kind: DNS any IP, gateways IPv4, relay servers IPv6');
check(errs(x => { x.pools.lan.ra_flags = ['managed-config', 'bogus']; }).length === 1 && errs(x => { x.pools.lan.ra_preference = 'urgent'; }).length === 1 && errs(x => { x.pools.lan.prefix_filter = '2001:db8::/200'; }).length === 1 && errs(x => { x.pools.lan.captive_portal_uri = 'ftp://x'; }).length === 1, 'flags, enums, prefixes and URIs');
check(errs(x => { x.pools.lan.dhcpv6_hostidlength = '8'; }).length === 1 && errs(x => { x.pools.lan.ra_mtu = '1000'; }).length === 1 && errs(x => { x.daemon.loglevel = '9'; }).length === 1 && errs(x => { x.daemon.leasefile = 'tmp/x'; }).length === 1, 'bounds and paths');
check(errs(x => { x.pools.lan.start = '300'; }).some(e => /beyond the end of the subnet/.test(e.text)) && warns(x => { x.pools.lan.start = '200'; x.pools.lan.limit = '100'; }).some(w => /ends at 192\.168\.1\.254/.test(w)), 'a pool beyond the subnet is an error; a pool that overruns it only warns');
check(warns(x => { x.pools.lan.ra_mininterval = '500'; x.pools.lan.ra_maxinterval = '600'; }).length === 1 && warns(x => { x.pools.lan.ra_flags = ['none', 'other-config']; }).length === 1, 'RA interval and flag combinations that make no sense warn');
check(warns(x => { x.pools.lan.dhcpv6 = 'disabled'; }).some(w => /DHCPv6, which is disabled/.test(w)) && !warns(x => { x.pools.lan.dhcpv6 = 'server'; }).some(w => /DHCPv6, which is disabled/.test(w)), 'clients told to use a disabled DHCPv6 warn');
check(warns(x => { x.daemon.maindhcp = false; }).some(w => /no longer the main DHCPv4 server/.test(w)), 'switching odhcpd off as the main DHCPv4 server warns');
check(errs(x => { host(x, 'cfg1').values.ip = 'nope'; }).some(e => e.key === 'host:h0:ip') && errs(x => { host(x, 'cfg1').values.ip = 'ignore'; }).length === 0 && errs(x => { host(x, 'cfg1').values.mac = 'zz:zz'; }).some(e => e.key === 'host:h0:mac'), 'a reservation\'s address and MACs are checked ("ignore" is allowed)');
check(errs(x => { host(x, 'cfg1').values.mac = ''; }).some(e => /needs a MAC address or a DUID/.test(e.text)) && errs(x => { host(x, 'cfg4').values.duid = 'xyz'; }).some(e => e.key === 'host:h3:duid'), 'a reservation needs a MAC or a DUID, and the DUID must be hexadecimal');
check(errs(x => { host(x, 'cfg2').values.ip = '192.168.1.2'; }).some(e => /also reserved for flabn01/.test(e.text)) && errs(x => { host(x, 'cfg2').values.mac = '88:ae:dd:66:16:05'; }).some(e => /also used by flabn01/.test(e.text)), 'an address or MAC used twice is an error');
check(errs(x => { host(x, 'cfg2').values.ip = '192.168.1.1'; }).some(e => /router's own address/.test(e.text)) && warns(x => { host(x, 'cfg2').values.ip = '172.16.0.5'; }).some(w => /outside every subnet/.test(w)), 'the router\'s address is refused; an address outside the served subnets warns');
check(errs(x => { const n = m.newHost(x); n.values.name = 'bad name!'; n.values.mac = 'aa:bb:cc:dd:ee:01'; }).length === 1 && errs(x => { const n = m.newHost(x); n.values.name = 'x'; }).length === 1, 'a new reservation is validated like the others (a name with spaces; no MAC)');
check(errs(x => { host(x, 'cfg1').removed = true; host(x, 'cfg2').values.ip = '192.168.1.2'; }).length === 0, 'a removed reservation frees its address and MAC');

console.log('== pools, network boot entries and the server DUID ==');
// The message of the error that verifying the saved config `after` against `draft` throws, or null if it passes.
const verdictX = (after, draft) => { try { m.checkApplied(after, draft); return null; } catch (e) { return e.message; } };
{
// The config with options the tables do not describe, a network boot entry, a third interface without a pool and the
// network config's globals section.
const cfgX = () => ({
  ...cfg({ daemon: { weird: 'x' }, lan: { dhcpv6_raw: 'abc', force: '1', dhcp_option: ['3,1.2.3.4', '6,8.8.8.8'] } }),
  boot1: section('boot1', 'boot6', { url: 'tftp://[fd11::1]/pxe.efi', arch: '07' }),
});
const dumpX = { interface: [...dump.interface, { interface: 'guest', up: true, l3_device: 'br-guest', 'ipv4-address': [{ address: '192.168.50.1', mask: 24 }] }] };
const globalsX = { '.anonymous': false, '.type': 'globals', '.name': 'globals', ula_prefix: 'fd00::/48', dhcp_default_duid: '0004b324b3332b47450aaa442f1f235bff2b' };
const dx = m.readDhcp(cfgX(), v4, v6, ra, dumpX, svc, {}, globalsX);
check(dx.globals.section === 'globals' && dx.globals.values.dhcp_default_duid === '0004b324b3332b47450aaa442f1f235bff2b' && d.globals.section === null && m.draftFrom(dx).globals.dhcp_default_duid === '0004b324b3332b47450aaa442f1f235bff2b', 'the server DUID is read from the globals section of the network config, and is empty without it');
check(dx.boot6.length === 1 && dx.boot6[0].values.arch === '07' && m.draftFrom(dx).boot6[0].values.url === 'tftp://[fd11::1]/pxe.efi' && d.boot6.length === 0, 'network boot entries are read');
check(j(dx.pools[0].extra.map(e => e.key).sort()) === '["dhcp_option","dhcpv6_raw","force"]' && dx.pools[0].extra.find(e => e.key === 'dhcp_option').value === '3,1.2.3.4, 6,8.8.8.8' && dx.pools[1].extra.length === 0 && j(dx.daemon.extra) === '[{"key":"weird","value":"x"}]', 'options the tables do not describe are listed read only, lists joined, `interface` left out');
check(j(m.freeInterfaces(dx, m.draftFrom(dx))) === '["wan","guest"]', 'an interface without a pool can get one (loopback and interfaces with a pool cannot)', j(m.freeInterfaces(dx, m.draftFrom(dx))));

// A pool for another interface
const withGuest = edit => { const dr = m.draftFrom(dx); const section = m.addPool(dx, dr, 'guest'); edit?.(dr, section); return dr; };
let dr = withGuest();
check(dr.added[0].section === 'guest' && dr.pools.guest.dhcpv4 === 'server' && dr.pools.guest.ra === 'server' && dr.pools.guest.start === '' && m.poolList(dx, dr).length === 3 && m.poolList(dx, dr)[2].isNew && m.poolList(dx, dr)[2].info.v4.address === '192.168.50.1' && j(m.freeInterfaces(dx, dr)) === '["wan"]', 'adding a pool starts it as a server for DHCPv4, DHCPv6 and RA with every other option at its default');
let ch = m.changesOf(dx, dr);
check(ch.length === 1 && ch[0].label === 'New pool guest' && /DHCPv4 server, DHCPv6 server, Router advertisements \(RA\) server/.test(ch[0].to) && m.isDirty(dx, dr), 'the review lists the new pool with the options it starts with', j(ch));
let ops = m.plan(dx, dr);
check(ops.length === 1 && j(ops[0]) === '{"op":"add","config":"dhcp","type":"dhcp","name":"guest","values":{"interface":"guest","dhcpv4":"server","dhcpv6":"server","ra":"server"}}', 'it is written as a new dhcp section named after the interface, with the interface option', j(ops));
dr = withGuest((x, s) => { x.pools[s].start = '50'; x.pools[s].limit = '100'; x.pools[s].dns = ['192.168.50.1']; x.pools[s].ra_slaac = false; });
ops = m.plan(dx, dr);
check(j(ops[0].values) === '{"interface":"guest","dhcpv4":"server","dhcpv6":"server","ra":"server","start":"50","limit":"100","dns":["192.168.50.1"],"ra_slaac":"0"}', 'options changed on a new pool are written with it (a list as a list, a switch as 0)', j(ops[0].values));
check(m.problems(dx, withGuest((x, s) => { x.pools[s].start = '300'; })).errors.some(e => e.key === 'pool:guest:start' && /beyond the end of the subnet/.test(e.text)) && m.problems(dx, withGuest()).errors.length === 0, 'a new pool is validated like the others, against its interface\'s subnet');
const taken = { ...cfgX(), guest: section('guest', 'host', { mac: 'aa:bb:cc:dd:ee:09' }) };
const dTaken = m.readDhcp(taken, v4, v6, ra, dumpX, svc);
const drTaken = m.draftFrom(dTaken);
check(m.addPool(dTaken, drTaken, 'guest') === 'guest_pool' && m.addPool(dTaken, drTaken, 'wan') === 'wan', 'a section name that is taken by another section is not reused');
const savedX = { ...cfgX(), guest: section('guest', 'dhcp', { interface: 'guest', dhcpv4: 'server', dhcpv6: 'server', ra: 'server' }) };
check(verdictX(m.readDhcp(savedX, null, null, null, dumpX, null, {}, globalsX), withGuest()) === null && /Pool guest was not saved/.test(verdictX(dx, withGuest())), 'a pool is verified by its section name: found with its options, or reported missing');
m.removePool(dr, 'guest');
check(dr.added.length === 0 && dr.pools.guest === undefined && !m.isDirty(dx, dr), 'removing a pool that was only added in the form drops it');

// Removing a pool
dr = m.draftFrom(dx);
m.removePool(dr, 'lan100');
ch = m.changesOf(dx, dr);
check(ch.length === 1 && ch[0].label === 'Remove pool lan100' && ch[0].to === 'removed' && m.poolList(dx, dr)[1].removed && m.isDirty(dx, dr), 'removing a pool is a change in the review', j(ch));
check(j(m.plan(dx, dr)) === '[{"op":"delete","config":"dhcp","section":"lan100"}]' && m.problems(dx, dr).warnings.some(w => /Pool lan100 is removed: DHCP and router advertisements stop/.test(w)), 'the section is deleted, and the warning says what stops');
const goneCfg = cfgX();
delete goneCfg.lan100;
check(verdictX(m.readDhcp(goneCfg, null, null, null, dumpX, null, {}, globalsX), dr) === null && /Pool lan100 was not saved/.test(verdictX(dx, dr)), 'a removed pool must be gone when read back');
m.restorePool(dr, 'lan100');
check(!m.isDirty(dx, dr) && m.plan(dx, dr).length === 0, 'restoring it undoes the removal');
dr = m.draftFrom(dx);
m.removePool(dr, 'lan');
dr.pools.lan.start = 'not a number';
check(m.problems(dx, dr).errors.length === 0 && m.plan(dx, dr).length === 1, 'a removed pool\'s options are neither validated nor written');

// The new network and device options
dr = m.draftFrom(dx);
dr.pools.lan.dnr = ['1 dns.example.com 192.0.2.1 alpn=h2'];
dr.pools.lan.ifname = 'br-lan';
ops = m.plan(dx, dr);
check(ops.length === 1 && j(ops[0].values) === '{"dnr":["1 dns.example.com 192.0.2.1 alpn=h2"],"ifname":"br-lan"}' && m.problems(dx, dr).errors.length === 0, 'encrypted DNS servers and the network device are written');
dr.pools.lan.dnr = ['dns.example.com'];
check(m.problems(dx, dr).errors.some(e => e.key === 'pool:lan:dnr' && e.index === 0), 'an encrypted DNS entry without a priority is refused');

// The server DUID
dr = m.draftFrom(dx);
dr.globals.dhcp_default_duid = '0004aabbccdd';
check(j(m.plan(dx, dr)) === '[{"op":"set","config":"network","section":"globals","values":{"dhcp_default_duid":"0004aabbccdd"}}]' && m.changesOf(dx, dr)[0].label === 'odhcpd: Server DUID', 'a changed server DUID is written to the network config, and named in the review');
dr.globals.dhcp_default_duid = '';
check(j(m.plan(dx, dr)) === '[{"op":"delete","config":"network","section":"globals","options":["dhcp_default_duid"]}]', 'an emptied one is deleted from the globals section');
dr.globals.dhcp_default_duid = 'xyz';
check(m.problems(dx, dr).errors.some(e => e.key === 'globals:dhcp_default_duid' && /hexadecimal/.test(e.text)) , 'a DUID must be hexadecimal');
const noGlobals = m.readDhcp(cfgX(), v4, v6, ra, dumpX, svc);
dr = m.draftFrom(noGlobals);
dr.globals.dhcp_default_duid = '0004aabb';
check(j(m.plan(noGlobals, dr)) === '[{"op":"add","config":"network","type":"globals","name":"globals","values":{"dhcp_default_duid":"0004aabb"}}]', 'without a globals section one is added');
dr = m.draftFrom(dx);
dr.globals.dhcp_default_duid = '0004aabb';
check(/odhcpd: Server DUID was not saved/.test(verdictX(dx, dr)), 'a DUID that did not read back is reported');

// Network boot entries
dr = m.draftFrom(dx);
let b = m.newBoot(dr);
check(m.isDirty(dx, dr) && m.changesOf(dx, dr).length === 0 && m.plan(dx, dr).length === 0 && m.problems(dx, dr).errors.length === 0, 'an empty new boot row is dirty but changes nothing and is not complained about');
b.values.url = 'tftp://[fd11::1]/arm.efi';
b.values.arch = '11';
check(m.changesOf(dx, dr)[0].label === 'New network boot entry tftp://[fd11::1]/arm.efi' && j(m.plan(dx, dr)) === '[{"op":"add","config":"dhcp","type":"boot6","values":{"url":"tftp://[fd11::1]/arm.efi","arch":"11"}}]', 'a new boot entry is added with its address and architecture');
b.values.url = '';
check(m.problems(dx, dr).errors.some(e => e.key === 'boot6:b1:url' && /needs an address/.test(e.text)), 'an entry needs an address');
b.values.url = 'pxe.efi';
check(m.problems(dx, dr).errors.some(e => e.key === 'boot6:b1:url'), 'the address needs a scheme');
b.values.url = 'tftp://[fd11::1]/arm.efi';
b.values.arch = 'efi';
check(m.problems(dx, dr).errors.some(e => e.key === 'boot6:b1:arch'), 'the architecture code is a number');
b.values.arch = '7';
check(m.problems(dx, dr).warnings.some(w => /already serves architecture 7/.test(w)) && m.problems(dx, dr).errors.length === 0, 'two entries for the same architecture only warn ("07" and "7" are the same)');
b.values.arch = '';
dr.boot6[0].values.arch = '';
check(m.problems(dx, dr).warnings.some(w => /already serves every client/.test(w)), 'two entries for every client warn too');
dr = m.draftFrom(dx);
dr.boot6[0].values.arch = '';
check(j(m.plan(dx, dr)) === '[{"op":"delete","config":"dhcp","section":"boot1","options":["arch"]}]' && /architecture code/i.test(m.changesOf(dx, dr)[0].label) && m.changesOf(dx, dr)[0].from === '07' && m.changesOf(dx, dr)[0].to === 'not set', 'a cleared architecture is deleted from the entry');
dr.boot6[0].values.arch = '07';
dr.boot6[0].values.url = 'tftp://[fd11::2]/pxe.efi';
check(j(m.plan(dx, dr)) === '[{"op":"set","config":"dhcp","section":"boot1","values":{"url":"tftp://[fd11::2]/pxe.efi"}}]', 'a changed address is set');
dr = m.draftFrom(dx);
dr.boot6[0].removed = true;
check(j(m.plan(dx, dr)) === '[{"op":"delete","config":"dhcp","section":"boot1"}]' && /^Remove network boot entry/.test(m.changesOf(dx, dr)[0].label), 'a removed entry is deleted');
check(/Network boot entries was not saved/.test(verdictX(dx, dr)) && verdictX(m.readDhcp(cfgX(), null, null, null, dumpX, null, {}, globalsX), m.draftFrom(dx)) === null, 'boot entries are verified by content');
}

console.log('== staging and reading back ==');

const calls = [];
const { stageOps } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/core/ops.js')).href);
const ed = { set: async (...a) => calls.push(['set', ...a]), add: async (...a) => calls.push(['add', ...a]), delete: async (...a) => calls.push(['delete', ...a]) };
await stageOps(ed, m.plan(d, draftOf(d, x => { x.pools.lan.limit = '90'; host(x, 'cfg2').removed = true; const n = m.newHost(x); n.values.mac = 'aa:bb:cc:dd:ee:01'; n.values.name = 'n'; })));
check(j(calls.map(c => c[0])) === '["set","delete","add"]' && calls[2][2] === 'host' && calls[2][3].name === 'n', 'each operation becomes one uci call', j(calls));
const want = draftOf(d, x => { x.pools.lan.limit = '90'; host(x, 'cfg2').removed = true; const n = m.newHost(x); n.values.mac = 'aa:bb:cc:dd:ee:01'; n.values.name = 'n'; n.values.ip = '192.168.1.40'; });
const savedCfg = cfg({ lan: { limit: '90' } });
delete savedCfg.cfg2;
savedCfg.cfg9 = section('cfg9', 'host', { mac: 'AA:BB:CC:DD:EE:01', name: 'n', ip: '192.168.1.40' });
// The message of the error that verifying the saved config `after` against `draft` throws, or null if it passes.
const verdict = (after, draft = want) => { try { m.checkApplied(after, draft); return null; } catch (e) { return e.message; } };
check(verdict(m.readDhcp(savedCfg, null, null, null, dump, null)) === null, 'matching data passes, a new reservation found by its content under the name uci gave it');
check(/lan: Pool size/.test(verdict(data())) && /Reservations/.test(verdict(data())), 'options and reservations that did not stick are named', verdict(data()));
const noNew = { ...savedCfg }; delete noNew.cfg9;
check(/Reservations/.test(verdict(m.readDhcp(noNew, null, null, null, dump, null))) && /Reservations/.test(verdict(m.readDhcp({ ...savedCfg, cfg2: section('cfg2', 'host', { mac: '38:A6:CE:49:BF:D6', name: 'SkyQ-L2-Mesh' }) }, null, null, null, dump, null))), 'a missing new reservation, or one that was not removed, is reported');
check(m.checkApplied(d, m.draftFrom(d)) === undefined, 'an untouched draft always verifies');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall DHCP model checks passed');
process.exit(failed ? 1 : 0);
