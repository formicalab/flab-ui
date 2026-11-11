// One card per 802.11s mesh interface: identity and radio, where the mesh port sits in the bridge's spanning
// tree, the peers with their link quality (live traffic is derived from successive byte counters), the
// mesh paths and the mesh parameters. Also exports the findings (what looks wrong) and the rate recorder.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, kv, meter, section, muted, mono } from '../../core/ui.js';
import { createTracker, latest } from '../../core/rates.js';
import { fmtBytes, fmtLine, fmtNum, fmtSpan } from '../../core/format.js';
import { STP_ROLE, stpKind } from '../network/util.js';

// Module-level so the rate history survives the redraw on every poll; a peer series is keyed by the
// interface and the peer's MAC.
const tracker = createTracker();
const peerKey = (n, p) => `${n.ifname}/${p.mac}`;

// Feeds one poll into the tracker and drops peers that disappeared.
export function recordMesh(mesh) {
  const seen = new Set();
  for (const n of mesh.nodes) {
    for (const p of n.peers ?? []) {
      seen.add(peerKey(n, p));
      tracker.record(peerKey(n, p), { rx: p.rx_bytes, tx: p.tx_bytes, retries: p.tx_retries, packets: p.tx_packets });
    }
  }
  tracker.keep(seen);
}

// Meter color for a peer's signal in dBm: >= -60 good, >= -72 fair, below that weak.
const signalLevel = s => s == null ? '' : s >= -60 ? 'good' : s >= -72 ? 'fair' : 'weak';
// Percentage of a peer's transmitted packets that failed; null below 100 packets (too few to be meaningful).
const failRatio = p => p.tx_packets > 100 ? (p.tx_failed ?? 0) / p.tx_packets * 100 : null;

// The first five octets identify the same physical device (its interfaces use consecutive addresses), which
// is how a mesh peer is recognized as the bridge's root bridge. The comparison drops separators and case
// and looks at the first 10 hex digits.
const sameDevice = (a, b) => a && b && a.replace(/[^0-9a-f]/gi, '').slice(0, 10).toLowerCase() === b.replace(/[^0-9a-f]/gi, '').slice(0, 10).toLowerCase();
// MAC part of an STP bridge ID ("8000.aabbccddeeff" -> "aabbccddeeff"); empty when absent.
const bridgeMac = id => (id ?? '').split('.')[1] ?? '';

// The bridge this mesh interface is a port of, with its STP view.
function bridgeOf(n, net) {
  for (const b of net?.bridges ?? []) {
    const m = b.members.find(x => x.name === n.ifname);
    if (m) return { bridge: b, member: m };
  }
  return null;
}

// What looks wrong on one mesh interface, as { level, text }: disabled or down (returned alone), no peers,
// peers not in ESTAB, signal <= -75 dBm, more than 10 % failed transmissions, forwarding off and
// unresolved mesh paths.
export function findings(n) {
  const out = [];
  const name = n.mesh_id ?? n.ifname ?? n.section;
  if (!n.enabled) return [{ level: 'info', text: `Mesh interface ${name} is disabled in the configuration.` }];
  if (!n.up) return [{ level: 'bad', text: `Mesh interface ${name} is enabled but not running.` }];
  const peers = n.peers ?? [];
  if (!peers.length) out.push({ level: 'warn', text: `${name}: no mesh peer is connected.` });
  for (const p of peers) {
    if (p.plink !== 'ESTAB') out.push({ level: 'warn', text: `Peer ${p.mac} is in link state ${p.plink} (not established).` });
    const s = p.signal_avg ?? p.signal;
    if (p.plink === 'ESTAB' && s != null && s <= -75) out.push({ level: 'warn', text: `Weak link to ${p.mac}: ${s} dBm.` });
    if (failRatio(p) != null && failRatio(p) > 10) out.push({ level: 'warn', text: `${p.mac}: ${failRatio(p).toFixed(0)} % of transmissions failed.` });
  }
  if (n.params?.mesh_fwding === '0') out.push({ level: 'info', text: `${name}: forwarding is off, so this node does not relay frames for other mesh nodes.` });
  const unresolved = (n.paths ?? []).filter(p => !p.flags.includes('resolved')).length;
  if (unresolved) out.push({ level: 'info', text: `${name}: ${unresolved} mesh path${unresolved === 1 ? '' : 's'} not resolved yet (destinations being discovered).` });
  return out;
}

//#region parts
// Card header: state dot, mesh ID, interface, radio, channel, security, state and the port's STP role.
function header(n, link) {
  const state = !n.enabled ? ['disabled', ''] : n.up ? ['up', 'success'] : ['down', 'danger'];
  const role = link?.member.brport?.role;
  return h('div', { className: 'mesh-head' },
    h('span', { className: `dot ${n.up ? 'up' : 'down'}` }),
    icon('diagram-2', 20),
    h('strong', { className: 'name' }, n.mesh_id ?? n.section),
    n.ifname ? badge(n.ifname) : null,
    n.radio ? badge(n.radio) : null,
    n.live?.channel ? badge(`ch ${n.live.channel} · ${n.live.width} MHz`, 'info', `${n.live.freq} MHz`) : null,
    badge(n.security, /WPA3/.test(n.security) ? 'success' : /Open/.test(n.security) ? 'danger' : 'warning'),
    badge(state[0], state[1]),
    link && role ? badge(`${link.bridge.name}: ${STP_ROLE[role]}`, stpKind(link.member.brport.state_name), 'Spanning-tree role of this mesh port in its bridge') : null,
    n.mac ? h('span', { className: 'mesh-mac' }, mono(n.mac)) : null);
}

// How the mesh port relates to the bridge's spanning tree: a root port means the root bridge is reached through the mesh.
function bridgeNote(n, link) {
  if (!link) return null;
  const { bridge: b, member: m } = link;
  const root = m.brport?.role === 'root';
  const rootMac = bridgeMac(b.root_id);
  const via = root ? (n.peers ?? []).find(p => sameDevice(p.mac, rootMac)) : null;
  return h('div', { className: 'mesh-note' }, icon('info-circle'),
    h('span', {}, root
      ? [`This mesh port is the root port of `, h('b', {}, b.name), `: the spanning-tree root bridge `, mono(b.root_id), ' is reached through the mesh', via ? [' (peer ', mono(via.mac), ' is that device)'] : '', `, path cost ${b.root_path_cost}.`]
      : [`This mesh port is a member of `, h('b', {}, b.name), ` (${STP_ROLE[m.brport?.role] ?? 'no STP role'}).`]));
}

// Table of the interface's peers with link state, signal, rates, airtime metric, failures and live traffic.
function peersTable(n) {
  const peers = n.peers ?? [];
  const cols = ['Peer', 'Link', 'Signal', 'Bit rate', 'Expected', 'Airtime metric', 'Tx retries / failed', 'Traffic now', 'Idle', 'Connected'];
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table mesh-table' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
    h('tbody', {}, peers.length ? peers.map(p => peerRow(n, p)) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No peers heard on this interface.')))));
}

// One peer row. Live traffic comes from the rate tracker; idle time is shown in ms below one second.
function peerRow(n, p) {
  const k = peerKey(n, p);
  const rx = latest(tracker.rates(k, 'rx')), tx = latest(tracker.rates(k, 'tx'));
  const sig = p.signal_avg ?? p.signal;
  const fail = failRatio(p);
  return h('tr', {},
    h('td', {}, mono(p.mac), p.gate ? h('div', {}, badge('gate', 'info', 'Connected to a mesh gate')) : null, p.mfp ? h('div', { className: 'muted small' }, 'protected management frames') : null),
    h('td', {}, badge(p.plink ?? '?', p.plink === 'ESTAB' ? 'success' : 'warning', p.plink === 'ESTAB' ? 'Peer link established' : 'Peer link is not established')),
    // The meter maps -90..-30 dBm onto 0..60.
    h('td', { className: 'num' }, sig != null ? h('div', {}, `${sig} dBm`, meter(Math.max(0, Math.min(60, sig + 90)), 60, signalLevel(sig))) : '–'),
    h('td', { className: 'num' }, p.tx_rate ? h('div', {}, h('div', {}, icon('arrow-up', 12), `${p.tx_rate.mbit} Mbit/s`), h('div', { className: 'muted small' }, p.tx_rate.detail)) : '–',
      p.rx_rate ? h('div', {}, h('div', {}, icon('arrow-down', 12), `${p.rx_rate.mbit} Mbit/s`), h('div', { className: 'muted small' }, p.rx_rate.detail)) : null),
    h('td', { className: 'num' }, p.expected_mbit != null ? `${Math.round(p.expected_mbit)} Mbit/s` : '–'),
    h('td', { className: 'num', title: 'Lower is better; derived from the link rate and error rate' }, p.airtime_metric ?? '–'),
    h('td', { className: 'num' }, `${fmtNum(p.tx_retries ?? 0)} / ${fmtNum(p.tx_failed ?? 0)}`, fail != null ? h('div', { className: `small ${fail > 10 ? 'text-danger' : 'muted'}` }, `${fail.toFixed(1)} % failed`) : null),
    h('td', { className: 'num' }, h('div', {}, icon('arrow-down', 12), fmtLine(rx)), h('div', {}, icon('arrow-up', 12), fmtLine(tx)), h('div', { className: 'muted small' }, `total ↓ ${fmtBytes(p.rx_bytes ?? 0)} ↑ ${fmtBytes(p.tx_bytes ?? 0)}`)),
    h('td', { className: 'num' }, p.inactive_ms != null ? (p.inactive_ms < 1000 ? `${p.inactive_ms} ms` : fmtSpan(Math.round(p.inactive_ms / 1000))) : '–'),
    h('td', { className: 'num' }, p.connected_s != null ? fmtSpan(p.connected_s) : '–'));
}

// HWMP mesh path table: destination, next hop (unresolved paths have none yet), hops, metric, expiry and
// flags; destinations that are direct peers are tagged.
function pathsTable(n) {
  const peers = new Set((n.peers ?? []).map(p => p.mac));
  const paths = n.paths ?? [];
  const cols = ['Destination', 'Next hop', 'Hops', 'Metric', 'Expires', 'State'];
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table mesh-table' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
    h('tbody', {}, paths.length ? paths.map(p => h('tr', {},
      h('td', {}, mono(p.dest), peers.has(p.dest) ? badge('peer', 'info') : null),
      h('td', {}, p.next_hop ? mono(p.next_hop) : muted('not resolved')),
      h('td', { className: 'num' }, p.hop_count || '–'),
      h('td', { className: 'num' }, p.metric || '–'),
      h('td', { className: 'num' }, p.exptime_ms ? fmtSpan(Math.round(p.exptime_ms / 1000)) : '–'),
      h('td', {}, p.flags.length ? p.flags.map(f => badge(f.replace('_', ' '), f === 'resolved' || f === 'active' ? 'success' : '')) : badge('discovering', 'warning')))) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No mesh paths.')))));
}

// Mesh parameter (mac80211 mesh config name) -> [label, value formatter] for the configuration block;
// parameters the interface does not report are skipped.
const PARAM_LABELS = {
  mesh_fwding: ['Forwarding', v => (v === '1' ? 'on: relays frames for other nodes' : 'off')],
  mesh_ttl: ['Time to live', v => `${v} hops`],
  mesh_max_peer_links: ['Max peer links', v => v],
  mesh_auto_open_plinks: ['Auto-open peer links', v => (v === '1' ? 'yes' : 'no')],
  mesh_rssi_threshold: ['RSSI threshold', v => v],
  mesh_hwmp_rootmode: ['HWMP root mode', v => ({ 0: 'not a root', 1: 'proactive PREQ, no PREP', 2: 'proactive PREQ with PREP', 3: 'proactive RANN', 4: 'proactive RANN' })[v] ?? v],
  mesh_hwmp_rann_interval: ['RANN interval', v => v],
  mesh_gate_announcements: ['Gate announcements', v => (v === '1' ? 'on' : 'off')],
  mesh_nolearn: ['No address learning', v => (v === '1' ? 'yes' : 'no')],
  mesh_plink_timeout: ['Peer link timeout', v => (parseInt(v) === 0 ? 'never' : v)],
  mesh_power_mode: ['Power mode', v => v],
};

// Mesh ID, security, bridged networks and the reported mesh parameters as key/value rows.
function configBlock(n) {
  const rows = Object.entries(PARAM_LABELS).filter(([k]) => n.params?.[k] != null).map(([k, [label, fmt]]) => [label, fmt(n.params[k])]);
  return kv([
    ['Mesh ID', n.mesh_id ?? '–'],
    ['Security', `${n.security} (${n.encryption})`],
    ['Bridged into', n.networks.length ? n.networks.map(x => badge(x, 'info')) : muted('–')],
    ...rows,
  ]);
}
//#endregion

// The card for one mesh interface. `net` is the optional flab.network status (null when unavailable); a
// down interface shows only the header and an explanation.
export function nodeCard(n, net) {
  const link = bridgeOf(n, net);
  return h('div', { className: `card mesh-card ${n.up ? 'is-up' : 'is-down'}` },
    header(n, link),
    bridgeNote(n, link),
    n.up ? h('div', { className: 'mesh-body' },
      section(`Peers (${(n.peers ?? []).length})`, peersTable(n)),
      h('div', { className: 'mesh-cols' }, section(`Mesh paths (${(n.paths ?? []).length})`, pathsTable(n)), section('Configuration and parameters', configBlock(n)))) : h('div', { className: 'mesh-body muted' }, 'The interface is not running, so there are no peers or paths to show.'));
}
