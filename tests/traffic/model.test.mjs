// Unit test for the Traffic page's model (www/js/pages/traffic/model.js): the interface rows and totals, the WAN, the
// findings, endpoints and NAT, states, merging nlbwmon rows by MAC, filtering and sorting hosts, protocol rows. Pure
// functions: no router and no browser. Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/traffic/model.js')).href);

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// The text without the thousands separators the machine's locale adds ("26,000" or "26.000").
const plain = s => s.replace(/(\d)[.,\u00a0\u202f](?=\d{3}\b)/g, '$1');

//#region Interfaces
console.log('== interface rows ==');
const dev = (name, over = {}) => ({ name, up: true, carrier: true, speed: 1000, stats: { rx_bytes: 100, tx_bytes: 50 }, ...over });
const net = {
  ports: [dev('eth0', { role: 'nic' }), dev('eth1', { role: 'nic' }), dev('eth10', { role: 'switch', carrier: false, speed: null }), dev('lan1', { role: 'switch' }), dev('eth2', { role: 'conduit' })],
  bridges: [{ ...dev('br-lan'), members: [dev('lan1', { kind: 'ethernet' }), dev('phy0-ap0', { kind: 'wifi', ssid: 'home' }), dev('tap0', { kind: 'other' }), dev('eth1.20', { kind: 'vlan' })] }],
  vlans: [{ ...dev('eth1.1036'), parent: 'eth1' }, { ...dev('eth1.20'), parent: 'eth1' }],
};
const ifs = [
  { interface: 'loopback', up: true, l3_device: 'lo', device: 'lo' },
  { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan' },
  { interface: 'wan', up: true, l3_device: 'pppoe-wan', device: 'eth1.1036', route: [{ target: '0.0.0.0', mask: 0, nexthop: '10.0.0.1' }] },
  { interface: 'wan6', up: true, l3_device: 'pppoe-wan', device: 'eth1.1036', route: [{ target: '::', mask: 0 }] },
  { interface: 'backup', up: false, l3_device: 'eth0', device: 'eth0', route: [{ target: '0.0.0.0', mask: 0 }] },
];
let rows = m.deviceRows(net, ifs);
const by = n => rows.find(r => r.name === n);
check(rows.length === 10 && new Set(rows.map(r => r.name)).size === rows.length, 'every device once, ports, bridge members and VLANs together', rows.map(r => r.name).join());
check(by('lan1').kind === 'port' && by('lan1').bridge === undefined, 'a port that is also a bridge member keeps its own entry');
check(by('phy0-ap0').kind === 'wifi' && by('phy0-ap0').ssid === 'home' && by('phy0-ap0').bridge === 'br-lan' && by('tap0').kind === 'other' && by('eth1.20').kind === 'vlan', 'bridge members by kind');
check(by('eth2').kind === 'conduit' && by('br-lan').kind === 'bridge' && by('eth1.1036').parent === 'eth1', 'conduit, bridge and VLAN rows');
check(by('eth1.1036').logical.join() === 'wan,wan6' && by('br-lan').logical.join() === 'lan' && by('eth0').logical.join() === 'backup' && by('lan1').logical.length === 0, 'logical interface names by device (loopback ignored)', j(by('eth1.1036').logical));
check(by('eth0').rxBytes === 100 && by('eth0').txBytes === 50 && by('eth10').speed === null, 'counters and speeds are carried');
check(m.deviceRows(null, null).length === 0 && m.deviceRows({}, []).length === 0, 'no network data gives no rows');

console.log('\n== WAN, totals, busiest ==');
let wan = m.wanLinks(ifs, rows);
check(wan.length === 1 && wan[0].iface === 'wan' && wan[0].row === 'eth1.1036' && wan[0].l3 === 'pppoe-wan', 'the WAN with a default route; the PPPoE device is not tracked, so its VLAN carries it; wan and wan6 share one row', j(wan));
check(m.wanLinks([{ interface: 'wan', up: true, l3_device: 'eth0', device: 'eth0' }], rows)[0].row === 'eth0', 'without a default route an interface called wan counts, and a tracked L3 device is preferred');
check(m.wanLinks(ifs.slice(0, 2), rows).length === 0, 'no WAN when nothing has a default route');
check(m.wanLinks([{ interface: 'wwan', up: true, l3_device: 'wwan0', device: 'wwan0', route: [{ target: '0.0.0.0', mask: 0 }] }], rows)[0].row === null, 'a WAN whose device is not tracked has no row');
check(m.wanLinks([{ interface: 'a', up: true, l3_device: 'eth0', route: [{ target: '0.0.0.0', mask: 0 }] }, { interface: 'b', up: true, l3_device: 'eth1', route: [{ target: '::', mask: 0 }] }], rows).length === 2, 'two WANs on two devices are both listed');
const wanSet = new Set(['eth1.1036']);
check(m.orderRows(rows, wanSet).map(r => r.name).join() === 'eth1.1036,eth0,eth1,eth10,lan1,phy0-ap0,tap0,eth1.20,br-lan,eth2'.replace('eth1.20,br-lan', 'eth1.20,br-lan'), 'order: the WAN, ports (natural order: eth10 after eth1), Wi-Fi, other, VLANs, bridges, the conduit', m.orderRows(rows, wanSet).map(r => r.name).join());
const rates = { eth0: { rxNow: 1000, txNow: 500 }, eth1: { rxNow: 4000, txNow: 100 }, lan1: { rxNow: 0, txNow: 0 }, 'phy0-ap0': { rxNow: null, txNow: 2000 }, 'br-lan': { rxNow: 99999, txNow: 99999 }, 'eth1.1036': { rxNow: 99999, txNow: 99999 } };
const rateOf = n => rates[n] ?? { rxNow: null, txNow: null };
const tot = m.liveTotals(rows, rateOf);
check(tot.rx === 5000 && tot.tx === 2600 && tot.n === 6, 'totals add ports, Wi-Fi and other members only, not bridges, VLANs or the conduit; an unknown rate counts as zero', j(tot));
const busy = m.busiestRow(rows, rateOf);
check(busy.row.name === 'eth1' && busy.rx === 4000 && busy.tx === 100, 'the busiest interface by download plus upload', j(busy));
check(m.busiestRow(rows, () => ({ rxNow: 0, txNow: 0 })) === null && m.busiestRow(rows, () => ({ rxNow: null, txNow: null })) === null, 'nothing is busiest while all is idle or unknown');
check(m.utilization({ speed: 1000 }, { rxNow: 12.5e6, txNow: 1e6 }) === 10 && m.utilization({ speed: 100 }, { rxNow: 50e6, txNow: 0 }) === 100 && m.utilization({ speed: null }, { rxNow: 1 }) === null && m.utilization({ speed: 1000 }, { rxNow: null, txNow: null }) === 0, 'link utilization: the busier direction against the speed, capped, unknown without a speed');
check(m.kindLabel(by('phy0-ap0')) === 'Wi-Fi · home' && m.kindLabel(by('eth1.1036')) === 'VLAN on eth1' && m.kindLabel(by('br-lan')) === 'Bridge' && m.kindLabel(by('eth2')) === 'CPU port' && m.kindLabel(by('lan1')) === 'Ethernet port' && m.kindLabel(by('tap0')) === 'Bridge member', 'what each kind is called');
//#endregion

//#region Connection tracking
console.log('\n== connection table load and findings ==');
check(m.tableLoad(100, 1000).level === 'ok' && m.tableLoad(800, 1000).level === 'warn' && m.tableLoad(799, 1000).level === 'ok' && m.tableLoad(950, 1000).level === 'bad' && m.tableLoad(null, 1000).pct === null && m.tableLoad(5, 0).pct === null, 'the table is warned about from 80% and critical from 95%');
check(m.fmtPct(3.456) === '3.5' && m.fmtPct(42.4) === '42' && m.fmtPct(null) === '–' && m.fmtPct(0) === '0.0', 'percent formatting');
check(m.hostName({ '10.0.0.1': 'nas' }, '10.0.0.1') === 'nas' && m.hostName({}, '10.0.0.2') === '10.0.0.2' && m.hostLabel({ '10.0.0.1': 'nas' }, '10.0.0.1') === 'nas (10.0.0.1)' && m.hostLabel(undefined, '10.0.0.2') === '10.0.0.2', 'host names fall back to the address');
const host = (addr, connections, bytes = 0, unreplied = 0) => ({ addr, connections, bytes, unreplied });
const table = (over = {}) => ({
  ok: true, available: true, count: 1000, max: 31232, acct: true, total: 1000, parsed: 1000, truncated: false, names: { '192.168.1.50': 'nas' },
  aggregates: { protocols: [], states: [], unreplied: 0, nat: 0, sources: { by_connections: [host('192.168.1.10', 100)], by_bytes: [] }, destinations: { by_connections: [], by_bytes: [] }, unreplied_sources: [] }, ...over,
});
check(m.connectionFindings(table()).length === 0, 'a calm table has no findings');
check(m.connectionFindings(null).length === 0 && m.connectionFindings(table({ available: false }))[0].text.includes('not available'), 'no table, no findings; no tracking says so');
let f = m.connectionFindings(table({ count: 26000 }));
check(f.length === 1 && f[0].level === 'warn' && /83% full \(26000 of 31232\)/.test(plain(f[0].text)), 'a table over 80% full is a warning', j(f));
check(m.connectionFindings(table({ count: 31000 }))[0].level === 'bad', 'over 95% is critical');
f = m.connectionFindings(table({ truncated: true, parsed: 20000, total: 60000 }));
check(f.length === 1 && f[0].level === 'info' && /first 20000 of 60000/.test(plain(f[0].text)), 'a cut analysis is called out', j(f));
let agg = { ...table().aggregates, sources: { by_connections: [host('192.168.1.50', 450)], by_bytes: [] } };
f = m.connectionFindings(table({ aggregates: agg }));
check(f.length === 1 && f[0].level === 'warn' && /nas \(192\.168\.1\.50\) holds 450 of 1[.,\u00a0\u202f]?000 connections \(45%\)/.test(f[0].text), 'a host holding 40% of the connections (and at least 100) is flagged, by name', j(f));
agg = { ...table().aggregates, sources: { by_connections: [host('192.168.1.50', 399)], by_bytes: [] } };
check(m.connectionFindings(table({ aggregates: agg })).length === 0, 'below 40% it is not');
agg = { ...table().aggregates, sources: { by_connections: [host('192.168.1.50', 99)], by_bytes: [] } };
check(m.connectionFindings(table({ parsed: 150, aggregates: agg })).length === 0, 'a share of 66% with fewer than 100 connections is not flagged (a quiet router)');
agg = { ...table().aggregates, sources: { by_connections: [host('10.1.1.1', 3000)], by_bytes: [] } };
check(m.connectionFindings(table({ parsed: 20000, aggregates: agg })).length === 1, 'very many connections are flagged whatever the share');
agg = { ...table().aggregates, unreplied: 200 };
f = m.connectionFindings(table({ aggregates: agg }));
check(f.length === 0, 'unanswered connections below a quarter of the table are not flagged', j(f));
f = m.connectionFindings(table({ parsed: 1000, aggregates: { ...agg, unreplied: 260 } }));
check(f.length === 1 && /260 connections \(26%\) have never been answered/.test(f[0].text), 'a quarter of the table unanswered is flagged', j(f));
check(m.connectionFindings(table({ parsed: 100, aggregates: { ...agg, unreplied: 40, sources: { by_connections: [host('10.1.1.1', 10)], by_bytes: [] } } })).length === 0, 'fewer than 50 unanswered are not flagged');
agg = { ...table().aggregates, unreplied_sources: [host('192.168.1.77', 40, 0, 35)] };
f = m.connectionFindings(table({ aggregates: agg }));
check(f.length === 1 && /192\.168\.1\.77 has 35 connections that were never answered/.test(f[0].text), 'one host with 20 or more unanswered connections is flagged');
agg = { ...table().aggregates, sources: { by_connections: [host('192.168.1.50', 450, 0, 30)], by_bytes: [] }, unreplied_sources: [host('192.168.1.50', 450, 0, 30)] };
f = m.connectionFindings(table({ aggregates: agg }));
check(f.length === 2 && /\(see above\)/.test(f[1].text), 'the same host in both findings points to the first');
f = m.connectionFindings(table({ acct: false }));
check(f.length === 1 && f[0].level === 'info' && /counters are off/.test(f[0].text), 'switched-off byte counters are explained');
check(m.liveFindings(null).length === 0 && m.liveFindings({ count: 10, max: 100, nlbw: false }).length === 0, 'the Live tab is calm for a quiet table and no nlbw');
f = m.liveFindings({ count: 90, max: 100, nlbw: true, nlbwmon_running: false });
check(f.length === 2 && f[0].level === 'warn' && /90% full/.test(f[0].text) && /nlbwmon is installed but not running/.test(f[1].text), 'the Live tab reports a nearly full table and a stopped nlbwmon', j(f));
check(m.liveFindings({ count: 10, max: 100, nlbw: true, nlbwmon_running: true }).length === 0, 'a running nlbwmon is fine');
check(m.filterError('a-b_c.d:e/f 0') === null && m.filterError('a'.repeat(64)) === null && m.filterError('a'.repeat(65)).includes('64') && m.filterError('a;b') && m.filterError('a,b') && m.filterError('é') && m.filterError('a\nb') && m.filterError('[x]'), 'the filter is checked against the same alphabet and length as the plugin\'s');
check(m.filterError('') === null, 'an empty filter is fine');
//#endregion

//#region Entries
console.log('\n== entries ==');
check(m.endpoint('10.0.0.1', 443) === '10.0.0.1:443' && m.endpoint('2001:db8::1', 443) === '[2001:db8::1]:443' && m.endpoint('10.0.0.1', null) === '10.0.0.1' && m.endpoint('::1', undefined) === '::1' && m.endpoint('10.0.0.1', 0) === '10.0.0.1:0', 'endpoints: IPv6 in brackets with a port, no port for ICMP');
const flow = (over = {}) => ({ family: 4, proto: 'tcp', state: 'ESTABLISHED', timeout: 300, flags: ['ASSURED'], src: '192.168.1.10', dst: '93.184.216.34', sport: 51234, dport: 443, nat: null, bytes: [100, 2000], packets: [3, 4], ...over });
check(m.natSummary(flow()) === null, 'no NAT, no summary');
let n = m.natSummary(flow({ nat: { src: '203.0.113.9', dst: '93.184.216.34', sport: 51234, dport: 443 } }));
check(n.kind === 'source' && n.text === 'source becomes 203.0.113.9:51234', 'masquerade is source NAT', j(n));
n = m.natSummary(flow({ nat: { src: '203.0.113.9', dst: '93.184.216.34', sport: 40000, dport: 443 } }));
check(n.kind === 'source' && n.text === 'source becomes 203.0.113.9:40000', 'a changed source port is source NAT too');
n = m.natSummary(flow({ src: '198.51.100.99', dst: '203.0.113.9', sport: 60000, dport: 8080, nat: { src: '198.51.100.99', dst: '192.168.1.20', sport: 60000, dport: 80 } }));
check(n.kind === 'destination' && n.text === 'destination becomes 192.168.1.20:80', 'a port forward is destination NAT', j(n));
n = m.natSummary(flow({ nat: { src: '203.0.113.9', dst: '10.9.9.9', sport: 51234, dport: 8443 } }));
check(n.kind === 'both' && n.text === 'source becomes 203.0.113.9:51234, destination becomes 10.9.9.9:8443', 'both rewritten');
n = m.natSummary(flow({ proto: 'icmp', sport: null, dport: null, nat: { src: '203.0.113.9', dst: '1.1.1.1', sport: null, dport: null }, dst: '1.1.1.1' }));
check(n.kind === 'source' && n.text === 'source becomes 203.0.113.9', 'ICMP translation has no port', j(n));
n = m.natSummary(flow({ family: 6, src: 'fd00::10', dst: '2606:4700::1', nat: { src: '2001:db8:1::10', dst: '2606:4700::1', sport: 51234, dport: 443 } }));
check(n.text === 'source becomes [2001:db8:1::10]:51234', 'an IPv6 translation writes the bracketed endpoint', j(n));
check(m.natSummary(flow({ nat: { src: '192.168.1.10', dst: '93.184.216.34', sport: 51234, dport: 443 } })) === null, 'a "nat" equal to the original is not a translation');
check(m.protoLabel(flow()) === 'TCP' && m.protoLabel(flow({ proto: 'icmp', icmp: 8 })) === 'ICMP echo request' && m.protoLabel(flow({ proto: 'icmpv6', icmp: 134 })) === 'ICMPV6 router advertisement' && m.protoLabel(flow({ proto: 'icmp', icmp: 99 })) === 'ICMP type 99' && m.protoLabel(flow({ proto: 'gre' })) === 'GRE', 'protocol labels, with ICMP types');
check(j(m.stateBadges(flow())) === j([{ text: 'ESTABLISHED', kind: 'success' }]), 'an established TCP flow');
check(j(m.stateBadges(flow({ state: 'SYN_SENT', flags: ['UNREPLIED'] }))) === j([{ text: 'SYN_SENT', kind: 'info' }, { text: 'UNREPLIED', kind: 'warning' }]), 'a TCP flow without a reply');
check(j(m.stateBadges(flow({ proto: 'udp', state: null, flags: ['ASSURED'] }))) === j([{ text: 'assured', kind: '' }]) && j(m.stateBadges(flow({ proto: 'udp', state: null, flags: [] }))) === j([{ text: 'replied', kind: '' }]) && j(m.stateBadges(flow({ proto: 'udp', state: null, flags: ['UNREPLIED'] }))) === j([{ text: 'UNREPLIED', kind: 'warning' }]), 'UDP has no state word: assured, replied or unreplied');
check(j(m.stateBadges(flow({ state: null, timeout: null, flags: ['OFFLOAD'] }))) === j([{ text: 'replied', kind: '' }, { text: 'offloaded', kind: 'info' }]) && m.stateBadges(flow({ state: 'TIME_WAIT' }))[0].kind === '', 'an offloaded flow; other TCP states are neutral');
check(m.fmtTimeout(flow({ timeout: 250 })) === '4m 10s' && m.fmtTimeout(flow({ timeout: null, flags: ['OFFLOAD'] })) === 'offloaded' && m.fmtTimeout(flow({ timeout: null, flags: [] })) === '–' && m.fmtTimeout(flow({ timeout: 0 })) === '0s', 'the remaining life');
check(m.entrySize(flow({ bytes: undefined })) === null && m.entrySize(flow()).total === 2100 && m.fmtSize(flow({ bytes: undefined })) === null && m.fmtSize(flow()).bytes === '100 B ↑ · 2.0 KiB ↓' && m.fmtSize(flow()).packets === '3 ↑ · 4 ↓', 'sizes in both directions, nothing without counters');
check(j(m.protocolOptions({ protocols: [{ name: 'tcp', count: 5 }, { name: 'icmpv6', count: 1 }] })) === j([['all', 'All protocols'], ['tcp', 'TCP'], ['icmpv6', 'ICMPV6']]) && m.protocolOptions(undefined).length === 1, 'protocol selector options');
const ps = m.protocolSummary({ protocols: [{ name: 'tcp', count: 50 }, { name: 'udp', count: 30 }, { name: 'icmp', count: 3 }, { name: 'icmpv6', count: 2 }, { name: 'gre', count: 1 }] });
check(ps.tcp === 50 && ps.udp === 30 && ps.icmp === 5 && ps.other === 1 && ps.total === 86 && m.protocolSummary(undefined).total === 0, 'protocol totals for the tiles');
check(m.stateCount({ states: [{ name: 'ESTABLISHED', count: 7 }] }, 'ESTABLISHED') === 7 && m.stateCount({ states: [] }, 'TIME_WAIT') === 0 && m.stateCount(undefined, 'x') === 0, 'state counts');
//#endregion

//#region Usage
console.log('\n== usage ==');
const row = (mac, ip, rx, tx, conns = 1, over = {}) => ({ mac, ip, rx_bytes: rx, tx_bytes: tx, rx_pkts: 10, tx_pkts: 5, conns, ...over });
const rowsUsage = [
  row('aa:bb:cc:00:00:10', '192.168.1.10', 5000, 800, 120),
  row('aa:bb:cc:00:00:10', '2001:db8:1::10', 2000, 300, 30),
  row('aa:bb:cc:00:00:10', '192.168.1.11', 100, 10, 2),
  row('aa:bb:cc:00:00:11', '192.168.1.5', 9000, 100, 10),
  row('00:00:00:00:00:00', '10.133.106.38', 238, 448, 4),
  row('00:00:00:00:00:00', '10.133.106.39', 1, 1, 1),
  row('aa:bb:cc:00:00:12', 'fe80::1', 10, 10),
];
const names = { mac: { 'aa:bb:cc:00:00:10': 'laptop' }, ip: { '192.168.1.5': 'tv', 'fe80::1': 'phone' } };
let hosts = m.mergeHosts(rowsUsage, names);
check(hosts.length === 5 && hosts[0].key === 'aa:bb:cc:00:00:11', 'rows are merged by MAC: one device is one row, the heaviest first', hosts.map(h => h.key).join());
const laptop = hosts.find(x => x.mac === 'aa:bb:cc:00:00:10');
check(laptop.rx === 7100 && laptop.tx === 1110 && laptop.total === 8210 && laptop.conns === 152 && laptop.rxPkts === 30 && laptop.name === 'laptop', 'the IPv4 and IPv6 rows of a MAC are summed, and the MAC gives the name', j(laptop));
check(laptop.ips.join() === '192.168.1.10,192.168.1.11,2001:db8:1::10', 'addresses: IPv4 first, then IPv6', laptop.ips.join());
check(hosts.find(x => x.key === 'aa:bb:cc:00:00:11').name === 'tv' && hosts.find(x => x.key === 'aa:bb:cc:00:00:12').name === 'phone', 'a name known only by IP is used');
const zero = hosts.filter(x => x.mac === null);
check(zero.length === 2 && zero.every(x => x.ips.length === 1) && zero.map(x => x.key).sort().join() === '10.133.106.38,10.133.106.39', 'traffic with the all-zero MAC stays one host per address');
check(m.mergeHosts(null, names).length === 0 && m.mergeHosts([{ ip: '10.0.0.1', rx_bytes: 5, tx_bytes: 1 }], null)[0].key === '10.0.0.1' && m.mergeHosts([{ ip: '10.0.0.1', rx_bytes: 5, tx_bytes: 1 }, { ip: '10.0.0.1', rx_bytes: 1, tx_bytes: 1 }], null)[0].total === 8, 'rows grouped by IP only merge by address; missing data is fine');
check(m.filterHosts(hosts, '').length === 5 && m.filterHosts(hosts, 'LAPTOP').length === 1 && m.filterHosts(hosts, 'bb:cc:00:00:11').length === 1 && m.filterHosts(hosts, '2001:db8').length === 1 && m.filterHosts(hosts, '192.168.1').length === 2 && m.filterHosts(hosts, '192.168.1 laptop').length === 1 && m.filterHosts(hosts, 'nothing').length === 0, 'the host filter: name, MAC or address, every word must match');
check(m.sortHosts(hosts, { key: 'name', dir: 1 }).map(x => x.name ?? x.ips[0]).join() === '10.133.106.38,10.133.106.39,laptop,phone,tv', 'sort by name, ascending');
check(m.sortHosts(hosts, { key: 'download', dir: -1 })[0].rx === 9000 && m.sortHosts(hosts, { key: 'upload', dir: 1 })[0].tx === 1 && m.sortHosts(hosts, { key: 'conns', dir: -1 })[0].conns === 152 && m.sortHosts(hosts, { key: 'total', dir: 1 }).at(-1).total === 9100 && m.sortHosts(hosts, { key: 'bogus', dir: -1 })[0].total === 9100, 'sort by download, upload, connections and total; an unknown key sorts by total');
check(m.sortHosts(hosts, { key: 'conns', dir: 1 })[0] !== undefined && hosts[0].key === 'aa:bb:cc:00:00:11', 'sorting returns a copy');
check(m.share(25, 100) === 0.25 && m.share(5, 0) === 0, 'shares');
check(j(m.usageTotals({ totals: { rx_bytes: 7, tx_bytes: 3, conns: 2 } })) === j({ rx: 7, tx: 3, total: 10, conns: 2 }) && m.usageTotals(undefined).total === 0, 'totals come from the plugin');
check(m.protocolName({ layer7: 'HTTPS', proto: 'TCP', port: 443 }) === 'HTTPS' && m.protocolName({ layer7: null, proto: 'TCP', port: 8443 }) === 'TCP 8443' && m.protocolName({ layer7: null, proto: 'IP', port: 0 }) === 'Other IP' && m.protocolName({ layer7: null, proto: 'GRE', port: 0 }) === 'GRE', 'protocol names');
const l7 = [
  { proto: 'TCP', port: 443, layer7: 'HTTPS', rx_bytes: 900, tx_bytes: 100, conns: 5 }, { proto: 'UDP', port: 443, layer7: 'HTTPS', rx_bytes: 100, tx_bytes: 0, conns: 1 },
  { proto: 'TCP', port: 8443, layer7: null, rx_bytes: 50, tx_bytes: 10, conns: 2 }, { proto: 'IP', port: 0, layer7: null, rx_bytes: 10, tx_bytes: 10, conns: 1 },
  { proto: 'TCP', port: 1, layer7: null, rx_bytes: 5, tx_bytes: 5, conns: 1 }, { proto: 'TCP', port: 2, layer7: null, rx_bytes: 4, tx_bytes: 4, conns: 1 },
];
let pr = m.protocolRows(l7, 12);
check(pr.length === 5 && pr[0].label === 'HTTPS' && pr[0].rx === 1000 && pr[0].tx === 100 && pr[0].conns === 6 && pr[0].total === 1100, 'rows of the same protocol are merged', j(pr));
check(Math.abs(pr.reduce((s, p) => s + p.share, 0) - 1) < 1e-9 && Math.abs(pr[0].share - 1100 / 1198) < 1e-9, 'shares add up to one');
pr = m.protocolRows(l7, 2);
check(pr.length === 3 && pr[2].label === 'Other (3 more)' && pr[2].total === 20 + 10 + 8 && pr[2].conns === 3 && Math.abs(pr.reduce((s, p) => s + p.share, 0) - 1) < 1e-9, 'beyond the limit the rest is summed as "Other"', j(pr));
check(m.protocolRows(null).length === 0 && m.protocolRows([]).length === 0, 'no rows, no protocols');
check(j(m.periodOptions(['2026-11-01', '2026-10-01'])) === j([['current', 'Current period'], ['2026-11-01', 'Period from 2026-11-01'], ['2026-10-01', 'Period from 2026-10-01']]) && m.periodOptions(undefined).length === 1, 'period options: the current one, then the stored ones in the order the plugin gives');
check(j(m.periodOptions(['2026-11-01', '2026-10-01'], '2026-11-01')) === j([['current', 'Current period (since 2026-11-01)'], ['2026-10-01', 'Period from 2026-10-01']]) && j(m.periodOptions(['2026-10-01'], '2026-11-01')) === j([['current', 'Current period (since 2026-11-01)'], ['2026-10-01', 'Period from 2026-10-01']]), 'the running period names its start and is not listed a second time as a stored one (its stored copy is only as new as the last commit)');
const win = { start: '2026-11-01', end: '2026-12-01', today: '2026-11-12', ongoing: true, days: 12 };
let dp = m.describePeriod(win);
check(dp.ongoing && dp.title === '2026-11-01 to now' && dp.days === '12 days' && /^Counting since 2026-11-01\. The period ends on 2026-12-01, in 19 days, and counting starts again from zero\.$/.test(dp.detail), 'the running period: its dates, its length and when it ends', j(dp));
dp = m.describePeriod({ start: '2026-10-01', end: '2026-11-01', today: '2026-11-12', ongoing: false, days: 31 });
check(!dp.ongoing && dp.title === '2026-10-01 to 2026-11-01' && dp.days === '31 days' && /A finished period/.test(dp.detail), 'a finished period shows both dates');
dp = m.describePeriod({ start: '2026-11-12', end: '2026-11-13', today: '2026-11-12', ongoing: true, days: 1 });
check(dp.days === '1 day' && /in 1 day,/.test(dp.detail) && m.describePeriod(null) === null && m.describePeriod(undefined) === null, 'singular days; no window, nothing to show');
const big1 = { rx_pkts: 6408312050900, tx_pkts: 2860496513949, rx_bytes: 6741957078881, tx_bytes: 2869885992733 };
check(m.suspectCounters({ rx: big1.rx_bytes, rxPkts: big1.rx_pkts, tx: big1.tx_bytes, txPkts: big1.tx_pkts }) === true && m.suspectCounters({ rx: 9000000000, rxPkts: 6000000, tx: 1e8, txPkts: 800000 }) === false, 'counters of about one byte per packet are impossible; ordinary ones are fine');
check(m.suspectCounters({ rx: 238, rxPkts: 3, tx: 448, txPkts: 3 }) === false && m.suspectCounters({ rx: 5000, rxPkts: 99999, tx: 0, txPkts: 0 }) === false && m.suspectCounters({ rx: 1e6, rxPkts: 1e6, tx: 9e9, txPkts: 6e6 }) === true && m.suspectCounters({ rx: 9e9, rxPkts: 6e6, tx: 1e5, txPkts: 1e5 }) === true && m.suspectCounters({ rx: 1e5 * 28, rxPkts: 1e5, tx: 0, txPkts: 0 }) === false, 'a handful of packets is never judged; either direction can be wrong; 28 bytes per packet is the limit');
const bad = [row('aa:bb:cc:00:00:20', '10.0.0.20', 6741957078881, 2869885992733, 7956, { rx_pkts: 6408312050900, tx_pkts: 2860496513949 }), row('aa:bb:cc:00:00:21', '10.0.0.21', 9e9, 1e8, 10, { rx_pkts: 6e6, tx_pkts: 8e5 })];
check(m.mergeHosts(bad, null).find(x => x.mac.endsWith('20')).suspect === true && m.mergeHosts(bad, null).find(x => x.mac.endsWith('21')).suspect === false && m.mergeHosts(rowsUsage, names).every(x => x.suspect === false), 'a host is flagged when its own counters are impossible');
const ufBad = m.usageFindings({ nlbw: true, nlbwmon_running: true }, { ok: true, rows: bad });
check(ufBad.length === 1 && ufBad[0].level === 'warn' && /counters look wrong: 1 host averages as little as 1\.0 bytes per packet/.test(ufBad[0].text) && /flow_offloading_hw/.test(ufBad[0].text) && /at least 28 bytes/.test(ufBad[0].text), 'impossible counters are a warning that says how bad, why it cannot be right and a known cause', j(ufBad));
check(m.usageFindings({ nlbw: true, nlbwmon_running: true }, { ok: true, rows: bad.concat(row('aa:bb:cc:00:00:22', '10.0.0.22', 500000, 500000, 1, { rx_pkts: 500000, tx_pkts: 500000 })) })[0].text.includes('2 hosts average'), 'the warning counts the hosts');
let uf = m.usageFindings({ nlbw: true, nlbwmon_running: false }, undefined);
check(uf.length === 1 && uf[0].level === 'warn' && /installed but not running/.test(uf[0].text), 'nlbwmon installed but not running is a warning');
check(m.usageFindings({ nlbw: true, nlbwmon_running: true }, { ok: true, rows: [row('a', 'b', 1, 1)] }).length === 0, 'a running nlbwmon with data has no findings');
check(m.usageFindings({ nlbw: true, nlbwmon_running: true }, { ok: true, rows: [] })[0].level === 'info' && m.usageFindings({ nlbw: true, nlbwmon_running: true }, { ok: false, error: 'No data' })[0].text === 'No data', 'an empty period and an error from nlbw are explained');
check(/Only the 3000 entries .* of 3500/.test(plain(m.usageFindings({ nlbw: true, nlbwmon_running: true }, { ok: true, rows: new Array(3000).fill(row('a', 'b', 1, 1)), total_rows: 3500, truncated: true })[0].text)), 'rows left out are mentioned');
//#endregion

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
