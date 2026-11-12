// The Traffic page's model: which interfaces to show and how much they carry, what the connection table and
// nlbwmon's usage say, what looks wrong, and how names, endpoints and states are written. Pure functions with no DOM
// and no network, so they are unit-tested directly.
//
// Data shapes (rpcd/ucode/flab.traffic.uc):
//   status       { conntrack, count, max, acct, nlbw, nlbwmon_running }
//   connections  { ok, available, count, max, acct, total, parsed, truncated, matched, entries, names, aggregates }
//                entry: { family, proto, state, timeout, flags, src, dst, sport, dport, nat, bytes: [orig, reply], packets }
//                aggregates: { protocols: [{ name, count }], states, unreplied, nat, sources / destinations:
//                { by_connections, by_bytes: [{ addr, connections, bytes, unreplied }] }, unreplied_sources }
//   usage        { ok, period, group, rows: [{ mac, ip, conns, rx_bytes, tx_bytes, ... }], totals, names: { ip, mac } }
// The live interface list comes from flab.network status and netifd's interface dump (see network/shared.js).
import { fmtBytes, fmtNum, fmtSpan } from '../../core/format.js';

//#region Thresholds

// Connection tracking is called nearly full from this share of its limit, and full from the second one (percent).
export const NEAR_LIMIT = 80;
export const AT_LIMIT = 95;
// A host is flagged when it holds at least this many connections and this share of the analyzed table, or this many
// connections whatever the share.
export const HOST_MIN = 100;
export const HOST_SHARE = 0.4;
export const HOST_VERY_MANY = 3000;
// Unanswered connections are flagged when there are at least UNREPLIED_MIN of them and they make up this share of the
// analyzed table, or when one host has at least UNREPLIED_HOST of them.
export const UNREPLIED_MIN = 50;
export const UNREPLIED_SHARE = 0.25;
export const UNREPLIED_HOST = 20;
// An IP packet is at least this many bytes (an IPv4 ICMP echo or UDP datagram with no payload), so a counter that
// averages less per packet cannot be right. It is judged only for a host with at least COUNTER_SAMPLE packets in that
// direction, so a handful of packets is never flagged.
export const MIN_PACKET_BYTES = 28;
export const COUNTER_SAMPLE = 100000;
// The filter the Connections tab sends is limited to this many characters of the alphabet below.
export const FILTER_MAX = 64;
const FILTER_OK = /^[A-Za-z0-9.:_/ -]*$/;
// The all-zero MAC address nlbwmon uses for traffic with no local device behind it.
export const ZERO_MAC = '00:00:00:00:00:00';

//#endregion

//#region Live: interfaces and totals

// A natural order for names such as eth0, eth1, eth10: letters, then the number.
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// Interface names by device, from netifd's interface dump: { device: [logical interface, ...] }. A PPPoE interface
// has both its own device (pppoe-wan) and the device it runs on (eth1.1036), and both lead to "wan".
export function logicalNames(ifs) {
  const map = new Map();
  const add = (dev, name) => { if (dev && !(map.get(dev) ?? []).includes(name)) map.set(dev, [...(map.get(dev) ?? []), name]); };
  for (const i of ifs ?? []) {
    if (i.interface === 'loopback') continue;
    add(i.l3_device, i.interface);
    add(i.device, i.interface);
  }
  return map;
}

// Every network device the router reports (flab.network status), once each: Ethernet ports, the CPU conduit of a
// switch, bridges, their members (wired, Wi-Fi, VLAN) and VLAN devices, as
// { name, kind: port | conduit | bridge | vlan | wifi | other, up, carrier, speed, rxBytes, txBytes, bridge, parent,
//   ssid, logical }. Ports come first so a port that is also a bridge member keeps its own entry.
export function deviceRows(net, ifs) {
  const names = logicalNames(ifs);
  const rows = new Map();
  const add = (d, kind, extra = {}) => {
    if (rows.has(d.name)) return;
    rows.set(d.name, {
      name: d.name, kind, up: Boolean(d.up), carrier: Boolean(d.carrier), speed: d.speed ?? null,
      rxBytes: d.stats?.rx_bytes ?? null, txBytes: d.stats?.tx_bytes ?? null, logical: names.get(d.name) ?? [], ...extra,
    });
  };
  for (const p of net?.ports ?? []) add(p, p.role === 'conduit' ? 'conduit' : 'port');
  for (const b of net?.bridges ?? []) {
    add(b, 'bridge');
    for (const m of b.members ?? []) add(m, { ethernet: 'port', wifi: 'wifi', vlan: 'vlan' }[m.kind] ?? 'other', { bridge: b.name, ssid: m.ssid ?? null });
  }
  for (const v of net?.vlans ?? []) add(v, 'vlan', { parent: v.parent });
  return [...rows.values()];
}

// The kinds whose traffic is counted in the totals: a bridge, a VLAN device and the CPU conduit carry what their
// ports already carry.
const LEAF = new Set(['port', 'wifi', 'other']);
export const isLeaf = row => LEAF.has(row.kind);

// How rows are ordered: the WAN first, then ports, Wi-Fi, other members, VLANs, bridges and the CPU conduit.
const RANK = { port: 1, wifi: 2, other: 3, vlan: 4, bridge: 5, conduit: 6 };

// The rows in display order (stable, so a row never jumps with the traffic); `wan` is the set of row names that
// are a WAN device.
export function orderRows(rows, wan) {
  const rank = r => (wan.has(r.name) ? 0 : RANK[r.kind] ?? 7);
  return [...rows].sort((a, b) => rank(a) - rank(b) || natural(a.name, b.name));
}

// The WAN links: the interfaces that are up and have a default route (IPv4 or IPv6), or else one called "wan", as
// [{ iface, l3, device, row }]. `row` is the tracked device that carries the link: the L3 device (pppoe-wan, eth0) when
// the page tracks it, else the device it runs on (eth1.1036); null when neither is tracked. Links that share a
// device are listed once.
export function wanLinks(ifs, rows) {
  const names = new Set(rows.map(r => r.name));
  const hasDefault = i => (i.route ?? []).some(r => r.mask === 0 && (r.target === '0.0.0.0' || r.target === '::'));
  let list = (ifs ?? []).filter(i => i.up && hasDefault(i));
  if (!list.length) list = (ifs ?? []).filter(i => i.interface === 'wan');
  const seen = new Set();
  const out = [];
  for (const i of list) {
    const row = [i.l3_device, i.device].find(n => n && names.has(n)) ?? null;
    const key = row ?? `${i.interface}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ iface: i.interface, l3: i.l3_device ?? null, device: i.device ?? null, row });
  }
  return out;
}

// The sum of the current rates (bytes/s) over the rows that count (see isLeaf); `rateOf(name)` gives { rxNow, txNow }.
export function liveTotals(rows, rateOf) {
  let rx = 0, tx = 0, n = 0;
  for (const r of rows) {
    if (!isLeaf(r)) continue;
    const t = rateOf(r.name);
    rx += t.rxNow ?? 0;
    tx += t.txNow ?? 0;
    n++;
  }
  return { rx, tx, n };
}

// The row that carries the most traffic right now (download plus upload) among the rows that count, or null while
// everything is idle or no rate is known yet.
export function busiestRow(rows, rateOf) {
  let best = null, top = 0;
  for (const r of rows) {
    if (!isLeaf(r)) continue;
    const t = rateOf(r.name);
    const sum = (t.rxNow ?? 0) + (t.txNow ?? 0);
    if (sum > top) { top = sum; best = { row: r, rx: t.rxNow ?? 0, tx: t.txNow ?? 0 }; }
  }
  return best;
}

// How much of a link's speed the busier direction uses, in percent; null when the speed is unknown.
export function utilization(row, rate) {
  if (!row.speed || row.speed <= 0) return null;
  const bits = Math.max(rate.rxNow ?? 0, rate.txNow ?? 0) * 8;
  return Math.min(100, bits / (row.speed * 1e6) * 100);
}

// What a row is, in words.
export function kindLabel(row) {
  switch (row.kind) {
    case 'port': return 'Ethernet port';
    case 'conduit': return 'CPU port';
    case 'bridge': return 'Bridge';
    case 'vlan': return row.parent ? `VLAN on ${row.parent}` : 'VLAN';
    case 'wifi': return row.ssid ? `Wi-Fi · ${row.ssid}` : 'Wi-Fi';
    default: return 'Bridge member';
  }
}

//#endregion

//#region Connection tracking load and findings

// The fill of the connection table: { pct, level } with level ok, warn (from NEAR_LIMIT) or bad (from AT_LIMIT); pct is
// null while the limit is unknown.
export function tableLoad(count, max) {
  if (count == null || !max) return { pct: null, level: 'ok' };
  const pct = count / max * 100;
  return { pct, level: pct >= AT_LIMIT ? 'bad' : pct >= NEAR_LIMIT ? 'warn' : 'ok' };
}

// A percentage with one decimal below ten, none above ("3.4", "42").
export const fmtPct = p => (p == null ? '–' : p < 10 ? p.toFixed(1) : Math.round(p).toString());

// The name of a host when the router knows one, else its address.
export const hostName = (names, addr) => names?.[addr] ?? addr;

// "name (address)" when the host has a name, else the address.
export const hostLabel = (names, addr) => (names?.[addr] ? `${names[addr]} (${addr})` : addr);

// The finding for a connection table that is close to its limit, or null.
function tableFinding(count, max) {
  const load = tableLoad(count, max);
  if (load.level === 'ok') return null;
  return { level: load.level, text: `The connection table is ${fmtPct(load.pct)}% full (${fmtNum(count)} of ${fmtNum(max)}): when it is full the router drops new connections.` };
}

// The findings of the connection table: a table close to its limit, an analysis that did not cover everything, a
// host holding most of the connections or very many of them, connections nobody answered, and counters that are off.
// Each is { level: bad | warn | info, text }.
export function connectionFindings(data) {
  if (!data) return [];
  if (!data.available) return [{ level: 'info', text: 'Connection tracking is not available on this router.' }];
  const out = [];
  const full = tableFinding(data.count, data.max);
  if (full) out.push(full);
  if (data.truncated) out.push({ level: 'info', text: `Only the first ${fmtNum(data.parsed)} of ${fmtNum(data.total)} entries were analyzed, so the figures below describe those.` });
  const a = data.aggregates;
  const names = data.names;
  const top = a?.sources?.by_connections?.[0];
  let flagged = null;
  if (top && data.parsed) {
    const part = top.connections / data.parsed;
    if (top.connections >= HOST_VERY_MANY || (top.connections >= HOST_MIN && part >= HOST_SHARE)) {
      flagged = top.addr;
      out.push({ level: 'warn', text: `${hostLabel(names, top.addr)} holds ${fmtNum(top.connections)} of ${fmtNum(data.parsed)} connections (${fmtPct(part * 100)}%): a download manager, a scan or a runaway application opens that many.` });
    }
  }
  if (a && data.parsed && a.unreplied >= UNREPLIED_MIN && a.unreplied / data.parsed >= UNREPLIED_SHARE) {
    out.push({ level: 'warn', text: `${fmtNum(a.unreplied)} connections (${fmtPct(a.unreplied / data.parsed * 100)}%) have never been answered: unreachable destinations, a blocked port or a scan.` });
  }
  const lost = a?.unreplied_sources?.[0];
  if (lost && lost.unreplied >= UNREPLIED_HOST) {
    out.push({ level: 'warn', text: `${hostLabel(names, lost.addr)} has ${fmtNum(lost.unreplied)} connections that were never answered${lost.addr === flagged ? ' (see above)' : ''}.` });
  }
  if (data.acct === false) out.push({ level: 'info', text: 'Per-connection packet and byte counters are off (nf_conntrack_acct is 0), so the sizes of connections are not shown.' });
  return out;
}

// The findings of the Live tab: the connection table close to its limit, and nlbwmon installed but not running.
export function liveFindings(status) {
  if (!status) return [];
  const out = [];
  const full = tableFinding(status.count, status.max);
  if (full) out.push(full);
  if (status.nlbw && !status.nlbwmon_running) out.push({ level: 'warn', text: 'nlbwmon is installed but not running, so per-host data usage is not being counted.' });
  return out;
}

// The findings of the Usage tab: nlbwmon not running, a period with nothing counted, rows left out, counters that cannot be
// right.
export function usageFindings(status, hosts) {
  if (status?.nlbw && !status.nlbwmon_running) return [{ level: 'warn', text: 'nlbwmon is installed but not running, so nothing is being counted. Start it on the Services page; the stored periods are listed once it runs.' }];
  if (hosts && hosts.ok === false) return [{ level: 'warn', text: hosts.error }];
  if (hosts && !hosts.rows?.length) return [{ level: 'info', text: 'nlbwmon has not counted any traffic in this period yet.' }];
  const out = [];
  const bad = mergeHosts(hosts?.rows, hosts?.names).filter(x => x.suspect);
  if (bad.length) {
    const worst = Math.min(...bad.map(x => Math.min(...[[x.rx, x.rxPkts], [x.tx, x.txPkts]].filter(([, p]) => p >= COUNTER_SAMPLE).map(([b, p]) => b / p))));
    out.push({ level: 'warn', text: `nlbwmon's counters look wrong: ${bad.length === 1 ? '1 host averages' : `${fmtNum(bad.length)} hosts average`} as little as ${worst < 10 ? worst.toFixed(1) : Math.round(worst)} bytes per packet, and an IP packet is at least ${MIN_PACKET_BYTES} bytes, so the byte totals below are inflated. A known cause is flow offloading (flow_offloading and flow_offloading_hw in /etc/config/firewall), which can feed nlbwmon wrong counts. Treat these numbers as unreliable.` });
  }
  if (hosts?.truncated) out.push({ level: 'info', text: `Only the ${fmtNum(hosts.rows.length)} entries with the most traffic of ${fmtNum(hosts.total_rows)} are listed.` });
  return out;
}

// Whether a filter text may be sent to the router (see FILTER_MAX); returns the reason when it may not, else null.
export function filterError(q) {
  if (q.length > FILTER_MAX) return `The filter is limited to ${FILTER_MAX} characters.`;
  if (!FILTER_OK.test(q)) return 'The filter may hold letters, digits and . : - _ / and spaces only.';
  return null;
}

//#endregion

//#region Connection entries

// An address with an optional port: "10.0.0.1:443", "[2001:db8::1]:443", or the address alone without a port.
export function endpoint(addr, port) {
  if (port == null) return addr;
  return addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`;
}

// What network address translation did to an entry, or null: { kind: source | destination | both, text }. The plugin
// reports the original tuple as the other side sees it (`nat`); a difference in the source address or port is source
// NAT (masquerade), in the destination address or port destination NAT (a port forward).
export function natSummary(e) {
  if (!e.nat) return null;
  const src = e.nat.src !== e.src || (e.sport != null && e.nat.sport !== e.sport);
  const dst = e.nat.dst !== e.dst || (e.dport != null && e.nat.dport !== e.dport);
  if (!src && !dst) return null;
  const parts = [];
  if (src) parts.push(`source becomes ${endpoint(e.nat.src, e.sport != null ? e.nat.sport : null)}`);
  if (dst) parts.push(`destination becomes ${endpoint(e.nat.dst, e.dport != null ? e.nat.dport : null)}`);
  return { kind: src && dst ? 'both' : src ? 'source' : 'destination', text: parts.join(', ') };
}

// Names of the ICMP types that show up in a router's table.
const ICMP = { 0: 'echo reply', 3: 'unreachable', 8: 'echo request', 11: 'time exceeded' };
const ICMP6 = { 1: 'unreachable', 3: 'time exceeded', 128: 'echo request', 129: 'echo reply', 133: 'router solicitation', 134: 'router advertisement', 135: 'neighbor solicitation', 136: 'neighbor advertisement' };

// The protocol as shown: "TCP", "UDP", "ICMP echo request", "GRE", ... (unknown protocols keep their name).
export function protoLabel(e) {
  const name = e.proto.toUpperCase();
  if (e.icmp == null) return name;
  const what = (e.proto === 'icmpv6' ? ICMP6 : ICMP)[e.icmp];
  return what ? `${name} ${what}` : `${name} type ${e.icmp}`;
}

// Badge kind of a TCP state word.
const STATE_KIND = { ESTABLISHED: 'success', SYN_SENT: 'info', SYN_RECV: 'info', SYN_SENT2: 'info' };

// The badges an entry shows, as [{ text, kind }]: its state word (TCP), what the flags say (never answered, offloaded)
// and, for a flow without a state word that was answered, "replied".
export function stateBadges(e) {
  const out = [];
  if (e.state) out.push({ text: e.state, kind: STATE_KIND[e.state] ?? '' });
  const flags = e.flags ?? [];
  if (flags.includes('UNREPLIED')) out.push({ text: 'UNREPLIED', kind: 'warning' });
  else if (!e.state) out.push({ text: flags.includes('ASSURED') ? 'assured' : 'replied', kind: '' });
  if (flags.includes('OFFLOAD') || flags.includes('HW_OFFLOAD')) out.push({ text: 'offloaded', kind: 'info' });
  return out;
}

// The remaining life of an entry: "4m 10s", or "offloaded" for a flow in the flow table (it has no timeout), or a dash.
export function fmtTimeout(e) {
  if (e.timeout != null) return fmtSpan(e.timeout);
  return (e.flags ?? []).some(f => f.includes('OFFLOAD')) ? 'offloaded' : '–';
}

// An entry's size in each direction ("sent" is the original direction) as { sent, received, total }, or null when the
// router keeps no counters.
export function entrySize(e) {
  if (!e.bytes) return null;
  return { sent: e.bytes[0], received: e.bytes[1], total: e.bytes[0] + e.bytes[1] };
}

// The bytes and packets of an entry as two short strings ("1.2 KiB ↑ · 3.4 KiB ↓"), or null without counters.
export function fmtSize(e) {
  const s = entrySize(e);
  if (!s) return null;
  return { bytes: `${fmtBytes(s.sent)} ↑ · ${fmtBytes(s.received)} ↓`, packets: `${fmtNum(e.packets[0])} ↑ · ${fmtNum(e.packets[1])} ↓` };
}

// The options of the protocol selector: all, then the protocols the table holds (most connections first).
export function protocolOptions(aggregates) {
  return [['all', 'All protocols'], ...(aggregates?.protocols ?? []).map(p => [p.name, p.name.toUpperCase()])];
}

// Counts for the summary tiles: { tcp, udp, icmp (v4 and v6), other, total }.
export function protocolSummary(aggregates) {
  const by = Object.fromEntries((aggregates?.protocols ?? []).map(p => [p.name, p.count]));
  const total = (aggregates?.protocols ?? []).reduce((n, p) => n + p.count, 0);
  const tcp = by.tcp ?? 0, udp = by.udp ?? 0, icmp = (by.icmp ?? 0) + (by.icmpv6 ?? 0);
  return { tcp, udp, icmp, other: total - tcp - udp - icmp, total };
}

// How many entries are in one TCP state.
export const stateCount = (aggregates, name) => (aggregates?.states ?? []).find(s => s.name === name)?.count ?? 0;

//#endregion

//#region Usage: hosts and protocols

// The addresses of one device ordered IPv4 first, then IPv6, each once.
const orderAddresses = list => [...new Set(list)].sort((a, b) => (a.includes(':') - b.includes(':')) || natural(a, b));

// Whether the byte and packet counts of one device cannot both be right: in a direction with at least COUNTER_SAMPLE
// packets, fewer than MIN_PACKET_BYTES bytes per packet on average.
export function suspectCounters({ rx, rxPkts, tx, txPkts }) {
  return (rxPkts >= COUNTER_SAMPLE && rx / rxPkts < MIN_PACKET_BYTES) || (txPkts >= COUNTER_SAMPLE && tx / txPkts < MIN_PACKET_BYTES);
}

// One row per device from nlbwmon rows grouped by MAC and IP (or by IP alone): the rows of one MAC (its IPv4 and IPv6
// addresses) are summed. Traffic with the all-zero MAC has no device behind it, so each of its addresses stays its own
// host. A host is { key, mac, ips, name, rx, tx, rxPkts, txPkts, total, conns, suspect }; rx is what the host downloaded
// and tx what it uploaded, and `suspect` says the counters are impossible (see suspectCounters). `names` is { ip, mac }
// from the plugin. Largest total first.
export function mergeHosts(rows, names) {
  const hosts = new Map();
  for (const r of rows ?? []) {
    const mac = r.mac && r.mac !== ZERO_MAC ? r.mac : null;
    const key = mac ?? r.ip ?? r.mac ?? '?';
    const h = hosts.get(key) ?? { key, mac, ips: [], rx: 0, tx: 0, rxPkts: 0, txPkts: 0, conns: 0 };
    if (r.ip) h.ips.push(r.ip);
    h.rx += r.rx_bytes ?? 0;
    h.tx += r.tx_bytes ?? 0;
    h.rxPkts += r.rx_pkts ?? 0;
    h.txPkts += r.tx_pkts ?? 0;
    h.conns += r.conns ?? 0;
    hosts.set(key, h);
  }
  return [...hosts.values()].map(h => {
    const ips = orderAddresses(h.ips);
    const name = (h.mac && names?.mac?.[h.mac]) || ips.map(ip => names?.ip?.[ip]).find(Boolean) || null;
    return { ...h, ips, name, total: h.rx + h.tx, suspect: suspectCounters(h) };
  }).sort((a, b) => b.total - a.total || natural(a.key, b.key));
}

// The hosts that match a filter text: every word must appear in the name, the MAC or one of the addresses.
export function filterHosts(hosts, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return hosts;
  return hosts.filter(h => {
    const text = `${h.name ?? ''} ${h.mac ?? ''} ${h.ips.join(' ')}`.toLowerCase();
    return words.every(w => text.includes(w));
  });
}

// What each sortable column of the hosts table compares.
const HOST_KEY = { name: h => (h.name ?? h.ips[0] ?? h.key).toLowerCase(), download: h => h.rx, upload: h => h.tx, total: h => h.total, conns: h => h.conns };

// The hosts sorted by `sort` = { key, dir } (dir 1 ascending, -1 descending); equal values keep the order of the
// total, largest first.
export function sortHosts(hosts, sort) {
  const value = HOST_KEY[sort.key] ?? HOST_KEY.total;
  return [...hosts].sort((a, b) => {
    const x = value(a), y = value(b);
    const c = typeof x === 'string' ? natural(x, y) : x - y;
    return c * sort.dir || b.total - a.total;
  });
}

// A part of a whole as a fraction from 0 to 1 (0 when the whole is empty).
export const share = (part, whole) => (whole > 0 ? part / whole : 0);

// The totals of a usage reply: { rx, tx, total, conns }, from the plugin's totals (which cover every row, also the
// ones left out of the reply).
export function usageTotals(usage) {
  const t = usage?.totals ?? {};
  return { rx: t.rx_bytes ?? 0, tx: t.tx_bytes ?? 0, total: (t.rx_bytes ?? 0) + (t.tx_bytes ?? 0), conns: t.conns ?? 0 };
}

// The protocol of a row grouped by layer 7: nlbwmon's own name (HTTPS, DNS, ...), else the transport and port ("TCP
// 8443"), else "Other IP" for traffic that has no port.
export function protocolName(r) {
  if (r.layer7) return r.layer7;
  if (r.port) return `${r.proto} ${r.port}`;
  return r.proto === 'IP' ? 'Other IP' : r.proto ?? 'Other';
}

// The rows grouped by layer 7 as one entry per protocol name, largest total first, the `max` largest kept and the
// rest summed as "Other": [{ label, rx, tx, total, conns, share }]; the share is of everything the rows hold.
export function protocolRows(rows, max = 12) {
  const by = new Map();
  for (const r of rows ?? []) {
    const label = protocolName(r);
    const p = by.get(label) ?? { label, rx: 0, tx: 0, conns: 0 };
    p.rx += r.rx_bytes ?? 0;
    p.tx += r.tx_bytes ?? 0;
    p.conns += r.conns ?? 0;
    by.set(label, p);
  }
  const all = [...by.values()].map(p => ({ ...p, total: p.rx + p.tx })).sort((a, b) => b.total - a.total || natural(a.label, b.label));
  const grand = all.reduce((n, p) => n + p.total, 0);
  const kept = all.slice(0, max);
  const rest = all.slice(max);
  if (rest.length) {
    kept.push(rest.reduce((o, p) => ({ ...o, rx: o.rx + p.rx, tx: o.tx + p.tx, conns: o.conns + p.conns, total: o.total + p.total }),
      { label: `Other (${rest.length} more)`, rx: 0, tx: 0, conns: 0, total: 0 }));
  }
  return kept.map(p => ({ ...p, share: share(p.total, grand) }));
}

// The options of the period selector: the running period (with its start date), then the periods nlbwmon has stored, newest
// first as the plugin lists them. The running period is stored too once nlbwmon has committed it; it is not listed twice
// (its stored copy is only as new as the last commit, so the live one is the better of the two).
export function periodOptions(periods, current = null) {
  return [['current', current ? `Current period (since ${current})` : 'Current period'],
    ...(periods ?? []).filter(p => p !== current).map(p => [p, `Period from ${p}`])];
}

// The words for an accounting window as { title, detail, ongoing }: "2026-11-01 to now · 12 days" with the end of the period
// underneath for the running one, "2026-10-01 to 2026-11-01 · 31 days" for a finished one. `w` is the plugin's window
// ({ start, end, today, ongoing, days }), or null when it could not be worked out.
export function describePeriod(w) {
  if (!w) return null;
  const n = `${fmtNum(w.days)} day${w.days === 1 ? '' : 's'}`;
  const left = Math.max(0, Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.today}T00:00:00Z`)) / 86400000));
  return w.ongoing
    ? { ongoing: true, title: `${w.start} to now`, days: n, detail: `Counting since ${w.start}. The period ends on ${w.end}, in ${left} day${left === 1 ? '' : 's'}, and counting starts again from zero.` }
    : { ongoing: false, title: `${w.start} to ${w.end}`, days: n, detail: `A finished period: it ran from ${w.start} up to, not including, ${w.end}.` };
}

//#endregion
