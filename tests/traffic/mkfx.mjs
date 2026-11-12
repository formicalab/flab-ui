// Builds the fixture directories and the expectations of the traffic suite.
// Usage: node mkfx.mjs <work dir containing fx-real/>
// Writes <work>/<scenario>/ with the files the flab.traffic plugin reads (see FLAB_FIXTURES in rpcd/lib/flab/util.uc:
// files.json for procfs and /tmp files, <command>.txt for command output, <object>_<method>.json for ubus calls,
// uci_<config>.json for UCI), <work>/cases.json (every plugin call to run: scenario, method, arguments),
// <work>/expect/<case>.json (what a call must return, computed here by an independent reference) and
// <work>/scenarios.json. Scenarios:
//   real     what the router under test reports (captured read-only), used for invariants only
//   rich     synthetic and deterministic: every protocol, TCP state, NAT form and IPv6 spelling the parser handles,
//            entries without counters and offloaded flows, DHCP/hosts/neighbor names, nlbwmon with three periods
//   big      60000 synthetic entries (the 20000 cap and the speed of a big router) and 3500 usage rows
//   noct     no connection tracking          noacct   entries without counters (nf_conntrack_acct=0)
//   nonlbw   nlbw is not installed           stopped  nlbw is installed but nlbwmon is not running
//   inflated nlbwmon counters that cannot be right (about one byte per packet), as the main router's reported them
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
// File name of a command's fixture, as util.uc derives it: runs of non-alphanumerics become "_".
const slug = cmd => cmd.replace(/[^A-Za-z0-9]+/g, '_') + '.txt';

//#region Addresses
// The eight zero-padded groups conntrack prints for an IPv6 address given in any spelling.
function padded6(text) {
  const [head, tail = null] = text.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = tail === null ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return groups.map(g => g.padStart(4, '0')).join(':');
}
// How conntrack writes an address.
const wire = (family, addr) => (family === 6 ? padded6(addr) : addr);

// Whether an address is local, with the rules the plugin documents.
function isPrivate(addr) {
  if (addr.includes(':')) return addr === '::' || addr === '::1' || /^(fe[89ab]|f[cd]|ff)/.test(addr);
  const [a, b] = addr.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
//#endregion

//#region Entries
// One entry as the tests think of it: { fam, proto, protonum, timeout (null: none), state, flags, o, r (tuples with
// src, dst, sport, dport, type), pk, by (null without counters) }.
const WAN = '203.0.113.9';
let seq = 0;
// A TCP/UDP entry whose reply is the mirror of the original unless `r` overrides fields (NAT).
function flow(fam, proto, timeout, state, o, { r = {}, pk = [1, 1], by = [60, 60], flags = [] } = {}) {
  const mirror = { src: o.dst, dst: o.src, sport: o.dport, dport: o.sport };
  return { id: seq++, fam, proto, protonum: { tcp: 6, udp: 17, icmp: 1, icmpv6: 58, gre: 47, unknown: 2 }[proto], timeout, state, flags, o, r: { ...mirror, ...r }, pk, by };
}
// A masqueraded flow: the reply comes back to the WAN address, on the same port.
const masq = (o, extra = {}) => ({ r: { dst: WAN }, ...extra });

// The synthetic table of the rich scenario.
function richEntries() {
  const E = [];
  // Adds `e` to the table and returns it.
  const add = e => { E.push(e); return e; };
  // A TCP flow in `state` that expires after `timeout` seconds; `o` and `x` are the flow's overrides.
  const tcp = (timeout, state, o, x) => add(flow(4, 'tcp', timeout, state, o, x));
  // A UDP flow that expires after `timeout` seconds; `o` and `x` are the flow's overrides.
  const udp = (timeout, o, x) => add(flow(4, 'udp', timeout, null, o, x));
  tcp(431996, 'ESTABLISHED', { src: '192.168.1.10', dst: '93.184.216.34', sport: 51234, dport: 443 }, { ...masq(), pk: [120, 150], by: [9800, 180000], flags: ['ASSURED'] });
  tcp(118, 'SYN_SENT', { src: '192.168.1.11', dst: '198.51.100.7', sport: 40000, dport: 8443 }, { r: { dst: WAN }, pk: [3, 0], by: [180, 0], flags: ['UNREPLIED'] });
  tcp(90, 'TIME_WAIT', { src: '192.168.1.10', dst: '93.184.216.34', sport: 51235, dport: 443 }, { ...masq(), pk: [40, 50], by: [5000, 20000], flags: ['ASSURED'] });
  tcp(60, 'FIN_WAIT', { src: '192.168.1.10', dst: '151.101.1.69', sport: 51300, dport: 443 }, { ...masq(), pk: [8, 9], by: [800, 1200] });
  tcp(60, 'CLOSE_WAIT', { src: '192.168.1.12', dst: '151.101.1.69', sport: 51301, dport: 443 }, { ...masq(), pk: [4, 4], by: [400, 400] });
  tcp(30, 'LAST_ACK', { src: '192.168.1.12', dst: '151.101.65.69', sport: 51302, dport: 443 }, { ...masq(), pk: [3, 3], by: [300, 300] });
  tcp(60, 'SYN_RECV', { src: '198.51.100.50', dst: WAN, sport: 3333, dport: 2222 }, { r: { src: '192.168.1.20', dport: 3333, sport: 22 }, pk: [1, 1], by: [60, 60] });
  tcp(10, 'CLOSE', { src: '192.168.1.10', dst: '1.1.1.1', sport: 51400, dport: 853 }, { ...masq(), pk: [2, 2], by: [100, 100] });
  tcp(300, 'ESTABLISHED', { src: '198.51.100.99', dst: WAN, sport: 60000, dport: 8080 }, { r: { src: '192.168.1.20', sport: 80 }, pk: [5, 4], by: [700, 2000], flags: ['ASSURED'] });
  udp(25, { src: '192.168.1.12', dst: '192.168.1.1', sport: 53000, dport: 53 }, { pk: [1, 1], by: [70, 120] });
  udp(29, { src: '192.168.1.13', dst: '203.0.113.200', sport: 123, dport: 123 }, { ...masq(), pk: [1, 0], by: [76, 0], flags: ['UNREPLIED'] });
  udp(179, { src: '192.168.1.10', dst: '142.250.180.14', sport: 50000, dport: 443 }, { ...masq(), pk: [30, 700], by: [30000, 900000], flags: ['ASSURED'] });
  udp(179, { src: '100.104.72.33', dst: '100.100.100.100', sport: 40000, dport: 53 }, { pk: [1, 1], by: [60, 90] });
  add({ ...flow(4, 'icmp', 28, null, { src: '192.168.1.10', dst: '1.1.1.1', type: 8 }, { ...masq(), pk: [1, 1], by: [84, 84] }) });
  add({ ...flow(4, 'icmp', 28, null, { src: '192.168.1.12', dst: '192.168.1.1', type: 8 }, { pk: [1, 1], by: [84, 84] }) });
  add(flow(4, 'gre', 179, null, { src: '10.0.0.2', dst: '10.0.0.3' }, { pk: [10, 9], by: [800, 700], flags: ['ASSURED'] }));
  add(flow(4, 'unknown', 598, null, { src: '192.168.1.1', dst: '224.0.0.22' }, { r: { src: '224.0.0.22', dst: '192.168.1.1' }, pk: [1, 0], by: [40, 0], flags: ['UNREPLIED'] }));
  // Offloaded flows have neither a timeout nor a state word.
  tcp(null, null, { src: '192.168.1.10', dst: '151.101.1.69', sport: 52000, dport: 443 }, { ...masq(), pk: [2, 1], by: [182, 142], flags: ['OFFLOAD'] });
  add(flow(4, 'udp', null, null, { src: '192.168.1.12', dst: '81.5.191.227', sport: 53726, dport: 6406 }, { ...masq(), pk: [1, 1], by: [88, 72], flags: ['OFFLOAD'] }));
  // Entries without counters.
  tcp(100, 'ESTABLISHED', { src: '192.168.1.14', dst: '34.120.0.1', sport: 51500, dport: 443 }, { ...masq(), pk: null, by: null, flags: ['ASSURED'] });
  add(flow(4, 'udp', 20, null, { src: '192.168.1.14', dst: '34.120.0.1', sport: 51501, dport: 443 }, { ...masq(), pk: null, by: null }));
  // IPv6: every compression case.
  const v6 = (proto, timeout, state, o, x) => add(flow(6, proto, timeout, state, o, x));
  v6('tcp', 3000, 'ESTABLISHED', { src: '2001:db8:1::10', dst: '2606:4700:4700::1111', sport: 52000, dport: 443 }, { pk: [30, 50], by: [3000, 50000], flags: ['ASSURED'] });
  v6('tcp', 3000, 'ESTABLISHED', { src: '2001:db8:1::12', dst: '2606:4700:4700::1001', sport: 52001, dport: 443 }, { pk: [3, 5], by: [300, 5000], flags: ['ASSURED'] });
  v6('udp', 20, null, { src: '2001:db8:0:1::2', dst: '2001:db8:1::1', sport: 4000, dport: 53 }, { pk: [1, 1], by: [80, 100] });
  v6('udp', 20, null, { src: '2001:db8:1:2:3:4:0:5', dst: '2001:db8:1::1', sport: 4001, dport: 53 }, { pk: [1, 1], by: [80, 100] });
  v6('udp', 20, null, { src: '2001:db8::1:0:0:1', dst: '2001:db8:1::1', sport: 4002, dport: 53 }, { pk: [1, 1], by: [80, 100] });
  v6('udp', 10, null, { src: 'fe80::639e:1bc5:db9e:45b2', dst: 'ff02::1:2', sport: 546, dport: 547 }, { pk: [1, 0], by: [100, 0], flags: ['UNREPLIED'] });
  v6('icmpv6', 29, null, { src: 'fe80::1', dst: 'ff02::1', type: 134 }, { pk: [1, 0], by: [96, 0], flags: ['UNREPLIED'] });
  v6('udp', 30, null, { src: 'fd00::10', dst: '2606:4700::1', sport: 6000, dport: 53 }, { r: { dst: '2001:db8:1::10' }, pk: [1, 1], by: [70, 70] });
  v6('tcp', 3000, 'ESTABLISHED', { src: '::', dst: '::1', sport: 1, dport: 2 }, { pk: [1, 1], by: [60, 60] });
  // One heavy host: 40 connections (10 of them unanswered) to distinct public addresses.
  for (let i = 1; i <= 40; i++) {
    const lost = i <= 10;
    tcp(lost ? 100 : 3000, lost ? 'SYN_SENT' : 'ESTABLISHED', { src: '192.168.1.50', dst: `192.0.2.${i}`, sport: 45000 + i, dport: 443 },
      { ...masq(), pk: lost ? [2, 0] : [5, 5], by: lost ? [120, 0] : [100, 200], flags: lost ? ['UNREPLIED'] : ['ASSURED'] });
  }
  return E;
}

// How the entry reads in /proc/net/nf_conntrack, with the spacing the kernel uses.
function conntrackLine(e) {
  // One direction of the entry as a conntrack tuple: addresses, ports or ICMP fields, then counters for direction `i`.
  const tuple = (t, i) => {
    const ports = t.sport !== undefined ? ` sport=${t.sport} dport=${t.dport}` : (t.type !== undefined ? ` type=${t.type} code=0 id=4242` : (e.proto === 'gre' ? ' srckey=0x0 dstkey=0x0' : ''));
    const counters = e.by ? ` packets=${e.pk[i]} bytes=${e.by[i]}` : '';
    return `src=${wire(e.fam, t.src)} dst=${wire(e.fam, t.dst)}${ports}${counters}`;
  };
  const head = `${(e.fam === 6 ? 'ipv6' : 'ipv4').padEnd(8)} ${e.fam === 6 ? 10 : 2} ${e.proto.padEnd(8)} ${e.protonum}`;
  const unreplied = e.flags.includes('UNREPLIED') ? ' [UNREPLIED]' : '';
  const tail = e.flags.filter(f => f !== 'UNREPLIED').map(f => ` [${f}]`).join('');
  const rt = { ...e.r };
  if (e.o.type !== undefined) rt.type = e.o.type;
  return `${head}${e.timeout == null ? '' : ` ${e.timeout}`}${e.state ? ` ${e.state}` : ''} ${tuple(e.o, 0)}${unreplied} ${tuple(rt, 1)}${tail} mark=0 zone=0 use=2`;
}
//#endregion

//#region The reference: what the plugin must return for a table and a request
// The NAT view of an entry (null when the reply is the mirror of the original), as the plugin reports it.
function natOf(e) {
  const same = e.r.src === e.o.dst && e.r.dst === e.o.src && e.r.sport === e.o.dport && e.r.dport === e.o.sport;
  return same ? null : { src: e.r.dst, dst: e.r.src, sport: e.r.dport, dport: e.r.sport };
}
// The bytes the entry carried in both directions, or 0 without accounting.
const total = e => (e.by ? e.by[0] + e.by[1] : 0);
// Stable sort, largest key first.
const bySize = (list, key) => list.map((e, i) => [e, i]).sort((a, b) => key(b[0]) - key(a[0]) || a[1] - b[1]).map(x => x[0]);
// Tally of a field's values, largest first, ties by name.
const counted = values => {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
};
// The top `n` addresses by one field, ties by address.
function topHosts(entries, side, field, n) {
  const m = new Map();
  for (const e of entries) {
    const a = e.o[side];
    const c = m.get(a) ?? { addr: a, connections: 0, bytes: 0, unreplied: 0 };
    c.connections++; c.bytes += total(e); if (e.flags.includes('UNREPLIED')) c.unreplied++;
    m.set(a, c);
  }
  return [...m.values()].filter(c => c[field] > 0).sort((a, b) => b[field] - a[field] || (a.addr < b.addr ? -1 : 1)).slice(0, n);
}
// What the plugin returns for the first `parseCap` lines of a table with these names (ip -> name).
function reference(entries, names, args = {}, parseCap = 20000) {
  const limit = args.limit ?? 300, sort = args.sort ?? 'bytes', proto = args.proto ?? 'all', scope = args.scope ?? 'all';
  const terms = (args.q ?? '').trim().toLowerCase().split(' ').filter(Boolean);
  const parsed = entries.slice(0, parseCap);
  // The lowercase text a search term is matched against: family, protocol, state, endpoints, names, flags, and NAT.
  const hay = e => {
    const n = natOf(e);
    return `ipv${e.fam} ${e.proto} ${e.state ?? ''} ${e.o.src} ${e.o.dst} ${e.o.sport ?? ''} ${e.o.dport ?? ''} ${names[e.o.src] ?? ''} ${names[e.o.dst] ?? ''} ${e.flags.join(' ')} ${n ? `${n.src} ${n.dst}` : ''} ${n ? `${n.sport ?? ''} ${n.dport ?? ''}` : ''}`.toLowerCase();
  };
  // Whether all four addresses of the entry are private.
  const local = e => [e.o.src, e.o.dst, e.r.src, e.r.dst].every(isPrivate);
  const hits = parsed.filter(e => (proto === 'all' || e.proto === proto)
    && (scope === 'all' || local(e) === (scope === 'internal'))
    && terms.every(t => hay(e).includes(t)));
  const key = { bytes: total, packets: e => (e.pk ? e.pk[0] + e.pk[1] : 0), timeout: e => e.timeout ?? 0 }[sort];
  return {
    matched: hits.length,
    order: bySize(hits, key).slice(0, limit).map(e => e.id),
    parsed: parsed.length,
    protocols: counted(parsed.map(e => e.proto)),
    states: counted(parsed.filter(e => e.state).map(e => e.state)),
    unreplied: parsed.filter(e => e.flags.includes('UNREPLIED')).length,
    nat: parsed.filter(natOf).length,
    sources: { by_connections: topHosts(parsed, 'src', 'connections', 10), by_bytes: topHosts(parsed, 'src', 'bytes', 10) },
    destinations: { by_connections: topHosts(parsed, 'dst', 'connections', 10), by_bytes: topHosts(parsed, 'dst', 'bytes', 10) },
    unreplied_sources: topHosts(parsed, 'src', 'unreplied', 5),
  };
}
//#endregion

//#region Names and nlbwmon data of the rich scenario
const LEASES = [
  '1794469813 aa:bb:cc:00:00:10 192.168.1.10 laptop.lan 01:aa:bb:cc:00:00:10',
  '1794469813 aa:bb:cc:00:00:13 192.168.1.13 * *',
  'duid 00:01:00:01:aa:bb',
].join('\n') + '\n';
const HOSTS_FILE = '# auto-generated config file from /etc/config/dhcp\n192.168.1.1 router\n2001:0db8:0001:0000:0000:0000:0000:0001 router\n';
const ARP = 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.11     0x1         0x2         aa:bb:cc:00:00:11     *        br-lan\n192.168.1.77     0x1         0x0         aa:bb:cc:00:00:77     *        br-lan\n';
const NEIGH = '2001:db8:1::10 dev br-lan lladdr aa:bb:cc:00:00:10 REACHABLE\nfe80::1 dev br-lan lladdr aa:bb:cc:00:00:01 STALE\n2001:db8:1::99 dev br-lan  FAILED\n';
const UCI_DHCP = { values: {
  cfg01: { '.type': 'dnsmasq', '.name': 'cfg01', domain: 'lan' },
  printer: { '.type': 'host', '.name': 'printer', name: 'printer', ip: '192.168.1.20', mac: 'aa:bb:cc:00:00:20' },
  nas: { '.type': 'host', '.name': 'nas', name: 'nas.lan', ip: '192.168.1.50', mac: ['AA:BB:CC:00:00:50'] },
} };
const IPV4LEASES = { device: { 'br-lan': { leases: [{ mac: 'aa:bb:cc:00:00:12', hostname: 'phone', address: '192.168.1.12', valid: 3000 }] } } };
const IPV6LEASES = { device: { 'br-lan': { leases: [{ duid: '0001', hostname: 'phone', 'ipv6-addr': [{ address: '2001:db8:1::12', 'preferred-lifetime': 100 }] }] } } };
const ETHERS = 'aa:bb:cc:00:00:11 tv\n';
// What the plugin must resolve in the rich scenario.
const RICH_NAMES = {
  '192.168.1.10': 'laptop', '2001:db8:1::10': 'laptop', '192.168.1.11': 'tv', '192.168.1.12': 'phone', '2001:db8:1::12': 'phone',
  '192.168.1.20': 'printer', '192.168.1.50': 'nas', '192.168.1.1': 'router', '2001:db8:1::1': 'router',
};

const NL = 'nlbw -c json -g';
// The JSON `nlbw` prints for a group.
const nlbwJson = (columns, data) => JSON.stringify({ columns, data });
// The MAC address of host `n`.
const MAC = n => `aa:bb:cc:00:00:${n}`;
const IP_COLS = ['mac', 'ip', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts'];
const L7_COLS = ['proto', 'port', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts', 'layer7'];
const NLBW_CURRENT = {
  'mac,ip': nlbwJson(IP_COLS, [
    [MAC(12), '192.168.1.12', 15, 50000, 100, 20000, 80],
    [MAC(11), '192.168.1.11', 10, 9000000000, 6000000, 100000000, 800000],
    [MAC(10), '192.168.1.10', 120, 5000000, 4000, 800000, 3000],
    ['00:00:00:00:00:00', '10.133.106.38', 4, 238, 3, 448, 3],
    [MAC(10), '2001:db8:1::10', 30, 2000000, 1500, 300000, 1200],
    [MAC(50), '192.168.1.50', 80, 700000, 900, 90000, 700],
    [MAC(12), '2001:db8:1::12', 5, 10000, 20, 5000, 20],
    [MAC('99'), '192.168.1.99', 3, 1000, 5, 500, 4],
  ]),
  ip: nlbwJson(['ip', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts'], [['192.168.1.11', 10, 9000000000, 6000000, 100000000, 800000], ['192.168.1.10', 120, 5000000, 4000, 800000, 3000]]),
  mac: nlbwJson(['mac', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts'], [[MAC(11), 10, 9000000000, 6000000, 100000000, 800000], [MAC(10), 150, 7000000, 5500, 1100000, 4200]]),
  fam: nlbwJson(['family', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts'], [[4, 230, 9005750238, 6004000, 101610448, 804000], [6, 35, 2010000, 1520, 305000, 1220]]),
  layer7: nlbwJson(L7_COLS, [
    ['TCP', 443, 150, 8000000000, 5000000, 90000000, 600000, 'HTTPS'],
    ['UDP', 443, 40, 900000000, 700000, 30000000, 30000, 'QUIC'],
    ['TCP', 80, 20, 5000000, 4000, 300000, 2000, 'HTTP'],
    ['UDP', 53, 30, 40000, 300, 30000, 280, 'DNS'],
    ['TCP', 8443, 4, 20000, 20, 1000, 10, null],
    ['TCP', 9999, 2, 5000, 5, 500, 5, null],
    ['IP', 0, 15, 1000000, 800, 200000, 700, null],
  ]),
  'ip,layer7': nlbwJson(['proto', 'port', 'ip', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts', 'layer7'], [['TCP', 443, '192.168.1.11', 10, 9000000000, 6000000, 100000000, 800000, 'HTTPS']]),
  'mac,layer7': nlbwJson(['proto', 'port', 'mac', 'conns', 'rx_bytes', 'rx_pkts', 'tx_bytes', 'tx_pkts', 'layer7'], [['TCP', 443, MAC(11), 10, 9000000000, 6000000, 100000000, 800000, 'HTTPS']]),
};
const NLBW_OLD = {
  'mac,ip': nlbwJson(IP_COLS, [[MAC(10), '192.168.1.10', 300, 70000000, 60000, 9000000, 50000], [MAC(12), '192.168.1.12', 10, 100000, 200, 50000, 100]]),
  layer7: nlbwJson(L7_COLS, [['TCP', 443, 310, 70100000, 60200, 9050000, 50100, 'HTTPS']]),
};
// What a router with the nlbwmon counter fault reported (real figures of the main router: about one byte per packet in
// both directions), next to a normal host and a host that moved few packets.
const NLBW_INFLATED = {
  'mac,ip': nlbwJson(IP_COLS, [
    [MAC(11), '192.168.1.9', 7956, 6741957078881, 6408312050900, 2869885992733, 2860496513949],
    [MAC(12), '192.168.1.10', 14616, 3182452572044, 3126773491503, 1599895085449, 1584853748557],
    [MAC(10), '192.168.1.20', 120, 5000000, 4000, 800000, 3000],
    [MAC(10), '2001:db8:1::20', 30, 2000000, 1500, 300000, 1200],
    ['00:00:00:00:00:00', '10.133.106.38', 4, 238, 3, 448, 3],
  ]),
  layer7: nlbwJson(L7_COLS, [['TCP', 443, 310, 9000000000000, 6000000000000, 4000000000000, 3900000000000, 'HTTPS']]),
};
// The nlbwmon configuration with the given database_interval.
const uciNlbwmon = interval => ({ 'uci_nlbwmon.json': JSON.stringify({ values: { cfg0: { '.type': 'nlbwmon', database_interval: interval } } }) });
//#endregion

//#region Scenario files
// The files.json map of a connection table: the table and the netfilter numbers next to it.
function netfilterFiles(lines, { count, max = 31232, acct = 1 } = {}) {
  return {
    '/proc/net/nf_conntrack': lines.length ? lines.join('\n') + '\n' : '',
    '/proc/sys/net/netfilter/nf_conntrack_count': `${count ?? lines.length}\n`,
    '/proc/sys/net/netfilter/nf_conntrack_max': `${max}\n`,
    '/proc/sys/net/netfilter/nf_conntrack_acct': `${acct}\n`,
  };
}
// The command and ubus fixtures of a router with nlbwmon, its periods and the data of each.
function nlbwFiles({ present = true, running = true, periods = [], data = {} } = {}) {
  const f = {
    [slug('command -v nlbw')]: present ? '/usr/sbin/nlbw\n' : '',
    [slug('pidof nlbwmon')]: running ? '3339\n' : '',
    [slug('nlbw -c list')]: periods.join('\n') + (periods.length ? '\n' : ''),
  };
  for (const [group, text] of Object.entries(data)) f[slug(`${NL} ${group}`)] = text;
  return f;
}

// The rich scenario's fixture files.
function richFiles(entries) {
  const files = {
    'files.json': JSON.stringify({
      ...netfilterFiles([...entries.slice(0, 5).map(conntrackLine), 'this is not a conntrack line', ...entries.slice(5).map(conntrackLine)], { count: 141 }),
      '/tmp/dhcp.leases': LEASES, '/tmp/hosts/dhcp.cfg01411c': HOSTS_FILE, '/proc/net/arp': ARP, '/etc/ethers': ETHERS,
    }),
    [slug('ls /tmp/hosts')]: 'dhcp.cfg01411c\n..\nbad name\n',
    [slug('ip -6 neigh show')]: NEIGH,
    'uci_dhcp.json': JSON.stringify(UCI_DHCP),
    'dhcp_ipv4leases.json': JSON.stringify(IPV4LEASES),
    'dhcp_ipv6leases.json': JSON.stringify(IPV6LEASES),
    ...nlbwFiles({ periods: ['2026-09-01', 'junk line', '2026-11-01', '', '2026-10-01'], data: NLBW_CURRENT }),
  };
  for (const [group, text] of Object.entries(NLBW_OLD)) files[slug(`${NL} ${group} -t 2026-10-01`)] = text;
  // A period that is not listed has data too, so a plugin that passed it on would succeed.
  files[slug(`${NL} ip -t 2025-01-01`)] = NLBW_CURRENT.ip;
  return files;
}

// Mulberry32, so the big table is the same on every run.
function prng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 60000 entries: 40 local hosts and one heavy one, 3000 public hosts, IPv4 and IPv6, every kind of flow.
function bigEntries(n = 60000) {
  const rnd = prng(12345);
  // A pseudo-random integer in [0, k).
  const pick = k => Math.floor(rnd() * k);
  const publicV4 = Array.from({ length: 3000 }, () => `${11 + pick(200)}.${pick(256)}.${pick(256)}.${1 + pick(250)}`).filter(a => !isPrivate(a));
  const publicV6 = Array.from({ length: 500 }, () => `2606:4700:${(pick(65535) + 1).toString(16)}::${(pick(65535) + 1).toString(16)}`);
  const E = [];
  for (let i = 0; i < n; i++) {
    const heavy = rnd() < 0.3;
    const host = heavy ? 50 : 2 + pick(40);
    // A pseudo-random byte count, spread over many orders of magnitude.
    const bytes = () => Math.floor(Math.exp(rnd() * 14));
    const kind = rnd();
    const sport = 1024 + pick(60000);
    const remote = publicV4[pick(publicV4.length)];
    const o = { src: `192.168.1.${host}`, dst: remote, sport, dport: [443, 80, 443, 53, 22, 8080][pick(6)] };
    if (kind < 0.45) E.push(flow(4, 'tcp', 1000 + pick(430000), 'ESTABLISHED', o, { ...masq(), pk: [1 + pick(500), 1 + pick(900)], by: [bytes(), bytes()], flags: ['ASSURED'] }));
    else if (kind < 0.6) E.push(flow(4, 'tcp', 1 + pick(120), 'TIME_WAIT', o, { ...masq(), pk: [1 + pick(50), 1 + pick(50)], by: [bytes(), bytes()], flags: ['ASSURED'] }));
    else if (kind < 0.7) E.push(flow(4, 'udp', 1 + pick(180), null, o, { ...masq(), pk: [1 + pick(50), 1 + pick(50)], by: [bytes(), bytes()], flags: ['ASSURED'] }));
    else if (kind < 0.8) E.push(flow(4, 'udp', 1 + pick(30), null, o, { ...masq(), pk: [1, 0], by: [bytes() % 400, 0], flags: ['UNREPLIED'] }));
    else if (kind < 0.83) E.push(flow(4, 'tcp', 1 + pick(120), 'SYN_SENT', o, { ...masq(), pk: [2, 0], by: [120, 0], flags: ['UNREPLIED'] }));
    else if (kind < 0.85) E.push(flow(4, 'icmp', 20, null, { src: o.src, dst: o.dst, type: 8 }, { ...masq(), pk: [1, 1], by: [84, 84] }));
    else if (kind < 0.95) E.push(flow(6, 'tcp', 1000 + pick(430000), 'ESTABLISHED', { src: `2001:db8:1::${(host + 16).toString(16)}`, dst: publicV6[pick(publicV6.length)], sport, dport: 443 }, { pk: [1 + pick(500), 1 + pick(900)], by: [bytes(), bytes()], flags: ['ASSURED'] }));
    else E.push(flow(4, 'udp', 1 + pick(30), null, { src: o.src, dst: '192.168.1.1', sport, dport: 53 }, { pk: [1, 1], by: [70, 120] }));
  }
  return E;
}
// The usage rows of the big scenario: 3500 hosts, so the plugin's cut-off shows.
function bigUsage() {
  const rows = [];
  for (let i = 0; i < 3500; i++) rows.push([`02:00:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}:01`, `10.${i >> 8}.${i & 255}.2`, 1 + (i % 7), 1000 + i * 17, 10 + (i % 5), 500 + i * 3, 5 + (i % 3)]);
  return nlbwJson(IP_COLS, rows);
}
//#endregion

//#region Cases and the scenarios
const rich = richEntries();
const big = bigEntries();
const scenarios = {
  rich: richFiles(rich),
  big: { 'files.json': JSON.stringify(netfilterFiles(big.map(conntrackLine), { count: 59871, max: 65535 })), ...nlbwFiles({ periods: ['2026-11-01'], data: { 'mac,ip': bigUsage() } }) },
  noct: { 'files.json': '{}', ...nlbwFiles({ data: NLBW_CURRENT }), ...uciNlbwmon('2026-10-15/14') },
  noacct: { 'files.json': JSON.stringify(netfilterFiles(rich.slice(0, 12).map(e => conntrackLine({ ...e, by: null, pk: null })), { acct: 0, max: 100 })), ...nlbwFiles({ data: NLBW_CURRENT }), ...uciNlbwmon('-2') },
  inflated: { 'files.json': '{}', ...nlbwFiles({ periods: ['2026-11-01'], data: NLBW_INFLATED }) },
  nonlbw: { 'files.json': JSON.stringify(netfilterFiles([])), ...nlbwFiles({ present: false, running: false }) },
  stopped: { 'files.json': JSON.stringify(netfilterFiles([])), ...nlbwFiles({ running: false, periods: ['2026-10-01'] }) },
};
const cases = [];
const expect = {};
let caseNo = 0;
// Registers a call to run and, when `ref` is given, the expectation of a connections call.
function add(name, scenario, method, args, ref) {
  cases.push({ name, scenario, method, args });
  if (ref) expect[name] = ref;
  caseNo++;
}

// Connections of the rich scenario: filters, sorts and limits, each checked against the reference.
const rich1 = (name, args) => add(name, 'rich', 'connections', args, reference(rich, RICH_NAMES, args));
rich1('rich-default', {});
rich1('rich-limit5', { limit: 5 });
rich1('rich-limit1', { limit: 1 });
rich1('rich-timeout', { sort: 'timeout', limit: 12 });
rich1('rich-packets', { sort: 'packets', limit: 12 });
rich1('rich-tcp', { proto: 'tcp' });
rich1('rich-udp', { proto: 'udp' });
rich1('rich-icmpv6', { proto: 'icmpv6' });
rich1('rich-gre', { proto: 'gre' });
rich1('rich-scope-internet', { scope: 'internet' });
rich1('rich-scope-internal', { scope: 'internal' });
rich1('rich-name', { q: 'laptop' });
rich1('rich-name-sub', { q: 'PHONE' });
rich1('rich-v6text', { q: '2001:db8::1' });
rich1('rich-v6compressed', { q: '2001:db8:0:1::2' });
rich1('rich-dnat-port', { q: '8080' });
rich1('rich-dnat-translated', { q: '192.168.1.20' });
rich1('rich-two-terms', { q: 'tcp established' });
rich1('rich-flag', { q: 'unreplied' });
rich1('rich-family', { q: 'ipv6' });
rich1('rich-combined', { q: '192.168.1', proto: 'tcp', scope: 'internet', sort: 'timeout', limit: 7 });
rich1('rich-nomatch', { q: 'nothing-like-this' });
rich1('rich-alphabet', { q: 'a-b_c.d:e/f 0' });
// The requests the page makes by default and from its selectors and top lists.
rich1('rich-q-nas', { q: '192.168.1.50' });
rich1('rich-limit1000', { limit: 1000 });
rich1('rich-sort-packets', { sort: 'packets' });
rich1('rich-sort-timeout', { sort: 'timeout' });
add('rich-noargs', 'rich', 'connections', undefined);

// Refused requests: each must come back as { ok: false } with the reason, whatever fixtures exist.
const REFUSED_CONNECTIONS = {
  'q-semicolon': { q: '1.1.1.1; reboot' }, 'q-subshell': { q: '$(reboot)' }, 'q-backtick': { q: '`reboot`' }, 'q-pipe': { q: 'a|b' },
  'q-newline': { q: 'a\nb' }, 'q-quote': { q: "a'b" }, 'q-unicode': { q: 'caf\u00e9' }, 'q-too-long': { q: 'a'.repeat(65) }, 'q-number': { q: 5 },
  'limit-zero': { limit: 0 }, 'limit-over': { limit: 2001 }, 'limit-negative': { limit: -1 }, 'limit-text': { limit: '5' }, 'limit-float': { limit: 1.5 },
  'sort-age': { sort: 'age' }, 'sort-injection': { sort: 'bytes; reboot' }, 'sort-case': { sort: 'BYTES' },
  'proto-upper': { proto: 'TCP' }, 'proto-injection': { proto: 'tcp;reboot' }, 'proto-newline': { proto: 'tcp\nudp' }, 'proto-empty': { proto: '' }, 'proto-long': { proto: 'a'.repeat(13) }, 'proto-number': { proto: 6 },
  'scope-unknown': { scope: 'wan' }, 'scope-upper': { scope: 'ALL' },
};
for (const [n, a] of Object.entries(REFUSED_CONNECTIONS)) add(`refused-conn-${n}`, 'rich', 'connections', a);
add('rich-limit-max', 'rich', 'connections', { limit: 2000 }, reference(rich, RICH_NAMES, { limit: 2000 }));
add('rich-q-max', 'rich', 'connections', { q: '1'.repeat(64) }, reference(rich, RICH_NAMES, { q: '1'.repeat(64) }));

// The other scenarios.
add('rich-status', 'rich', 'status');
add('noct-status', 'noct', 'status');
add('noct-connections', 'noct', 'connections', {});
add('noacct-status', 'noacct', 'status');
add('noacct-connections', 'noacct', 'connections', {});
add('nonlbw-status', 'nonlbw', 'status');
add('stopped-status', 'stopped', 'status');
add('big-status', 'big', 'status');
// The big table is cut at 20000 entries; the answers must still match the reference for those lines.
const bigNames = {};
for (const [n, args] of Object.entries({ default: {}, 'limit2000': { limit: 2000 }, timeout: { sort: 'timeout', limit: 50 }, tcp: { proto: 'tcp', limit: 100 }, internet: { scope: 'internet', limit: 100 }, filter: { q: '192.168.1.50 tcp', limit: 100 } }))
  add(`big-${n}`, 'big', 'connections', args, reference(big, bigNames, args));
// With a time budget the plugin stops early; the run script gives every case whose name starts with "budget-" 50 ms.
add('budget-big', 'big', 'connections', {});

// What `usage` must return for the JSON nlbw printed: the rows as objects, largest total first (the first 3000), and
// the totals over every row.
function usageReference(text) {
  const { columns, data } = JSON.parse(text);
  const rows = data.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
  // The total of column `k` over all rows.
  const sum = k => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  const sorted = rows.map((r, i) => [r, i]).sort((a, b) => (b[0].rx_bytes + b[0].tx_bytes) - (a[0].rx_bytes + a[0].tx_bytes) || a[1] - b[1]).map(x => x[0]);
  return { columns, rows: sorted.slice(0, 3000), total_rows: rows.length, truncated: rows.length > 3000,
    totals: { conns: sum('conns'), rx_bytes: sum('rx_bytes'), rx_pkts: sum('rx_pkts'), tx_bytes: sum('tx_bytes'), tx_pkts: sum('tx_pkts') } };
}

// Usage.
add('rich-periods', 'rich', 'usage_periods');
add('nonlbw-periods', 'nonlbw', 'usage_periods');
add('stopped-periods', 'stopped', 'usage_periods');
for (const g of ['mac,ip', 'ip', 'mac', 'fam', 'layer7', 'ip,layer7', 'mac,layer7']) add(`rich-usage-${g.replace(',', '-')}`, 'rich', 'usage', { period: 'current', group: g }, usageReference(NLBW_CURRENT[g]));
add('rich-usage-default-period', 'rich', 'usage', { group: 'mac,ip' }, usageReference(NLBW_CURRENT['mac,ip']));
add('rich-usage-old', 'rich', 'usage', { period: '2026-10-01', group: 'mac,ip' }, usageReference(NLBW_OLD['mac,ip']));
add('rich-usage-old-layer7', 'rich', 'usage', { period: '2026-10-01', group: 'layer7' }, usageReference(NLBW_OLD.layer7));
add('rich-usage-unlisted', 'rich', 'usage', { period: '2025-01-01', group: 'ip' });
add('rich-usage-nodata', 'rich', 'usage', { period: '2026-09-01', group: 'ip' });
add('nonlbw-usage', 'nonlbw', 'usage', { group: 'ip' });
add('stopped-usage', 'stopped', 'usage', { group: 'ip' });
add('big-usage', 'big', 'usage', { period: 'current', group: 'mac,ip' }, usageReference(bigUsage()));
// The accounting window under the three kinds of interval (the suite pins today to 2026-11-12), and counters that cannot be right.
add('noct-usage-window', 'noct', 'usage', { group: 'ip' });
add('noacct-usage-window', 'noacct', 'usage', { group: 'ip' });
add('inflated-periods', 'inflated', 'usage_periods');
add('inflated-usage-mac-ip', 'inflated', 'usage', { group: 'mac,ip' }, usageReference(NLBW_INFLATED['mac,ip']));
add('inflated-usage-layer7', 'inflated', 'usage', { group: 'layer7' }, usageReference(NLBW_INFLATED.layer7));
const REFUSED_USAGE = {
  'group-injection': { period: 'current', group: 'ip;reboot' }, 'group-subshell': { period: 'current', group: '$(reboot)' }, 'group-unknown': { period: 'current', group: 'proto' },
  'group-order': { period: 'current', group: 'ip,mac' }, 'group-space': { period: 'current', group: 'ip, mac' }, 'group-empty': { period: 'current', group: '' }, 'group-missing': { period: 'current' },
  'group-number': { period: 'current', group: 5 }, 'period-injection': { period: '2026-10-01; reboot', group: 'ip' }, 'period-subshell': { period: '$(reboot)', group: 'ip' },
  'period-text': { period: 'last month', group: 'ip' }, 'period-dashes': { period: '2026-10-01 -x', group: 'ip' }, 'period-empty': { period: '', group: 'ip' }, 'period-number': { period: 20261001, group: 'ip' },
};
for (const [n, a] of Object.entries(REFUSED_USAGE)) add(`refused-usage-${n}`, 'rich', 'usage', a);
//#endregion

if (fs.existsSync(path.join(work, 'fx-real')))
  scenarios.real = Object.fromEntries(fs.readdirSync(path.join(work, 'fx-real')).map(f => [f, fs.readFileSync(path.join(work, 'fx-real', f), 'utf8').replace(/\r/g, '')]));
for (const [name, files] of Object.entries(scenarios)) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
}
if (scenarios.real) {
  for (const [name, method, args] of [['status', 'status'], ['connections', 'connections', {}], ['connections-5', 'connections', { limit: 5 }], ['periods', 'usage_periods'],
    ['usage-mac-ip', 'usage', { period: 'current', group: 'mac,ip' }], ['usage-ip', 'usage', { period: 'current', group: 'ip' }], ['usage-layer7', 'usage', { period: 'current', group: 'layer7' }], ['usage-fam', 'usage', { period: 'current', group: 'fam' }]])
    cases.push({ name: `real-${name}`, scenario: 'real', method, args });
}
fs.mkdirSync(path.join(work, 'expect'), { recursive: true });
fs.mkdirSync(path.join(work, 'cases'), { recursive: true });
// The list the router-side loop reads (name scenario method) and the arguments of each call.
fs.writeFileSync(path.join(work, 'cases.txt'), cases.map(c => `${c.name} ${c.scenario} ${c.method}`).join('\n') + '\n');
for (const c of cases) if (c.args !== undefined) fs.writeFileSync(path.join(work, 'cases', `${c.name}.json`), JSON.stringify(c.args));
for (const [name, ref] of Object.entries(expect)) fs.writeFileSync(path.join(work, 'expect', `${name}.json`), JSON.stringify(ref));
// What the assertions need to map an entry back to the table: the order of ids, and each id's identity.
const identity = list => list.map(e => ({ id: e.id, proto: e.proto, src: e.o.src, dst: e.o.dst, sport: e.o.sport ?? null, dport: e.o.dport ?? null, nat: natOf(e), timeout: e.timeout, state: e.state, flags: e.flags, bytes: e.by, packets: e.pk, family: e.fam }));
fs.writeFileSync(path.join(work, 'expect', 'tables.json'), JSON.stringify({ rich: identity(rich), big: identity(big.slice(0, 20000)), richNames: RICH_NAMES, richLines: rich.length + 1 }));
fs.writeFileSync(path.join(work, 'scenarios.json'), JSON.stringify(Object.keys(scenarios)));
fs.writeFileSync(path.join(work, 'cases.json'), JSON.stringify(cases));
console.log(`built ${Object.keys(scenarios).join(', ')} and ${cases.length} cases (${rich.length} rich and ${big.length} big entries)`);
