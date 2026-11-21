// What this router announces: a prefix x peer matrix and the export-filter results per peer. (The routes of the non-BGP protocols
// are drawn under their rows of the protocols card; localRoutesTable below makes the table.)

import { h } from '../../../core/dom.js';
import { icon } from '../../../core/icons.js';
import { card, chip, muted } from '../../../core/ui.js';
import { fmtNum } from '../../../core/format.js';
import { peerDot, peerTitle, cmpPrefix, isUp, peerLabels } from './util.js';

// Matrix cell contents: a check mark when the prefix is announced to the peer, a dash otherwise.
const yes = () => h('span', { className: 'cap-yes', title: 'Announced' }, icon('check-circle', 17));
// Matrix cell for a prefix that is not announced to the peer.
const no = () => h('span', { className: 'muted', title: 'Not announced' }, '–');

// Table with one row per announced prefix and one column per peer; a prefix appears once even when
// several peers receive it. Rows come from each peer's `exported` list (routes passing its export filter).
function matrix(data) {
  const byPrefix = new Map();
  for (const p of data.peers) {
    for (const e of p.exported) {
      const row = byPrefix.get(e.prefix) ?? { prefix: e.prefix, protocol: e.protocol, kind: e.kind, peers: new Set() };
      row.peers.add(p.name);
      byPrefix.set(e.prefix, row);
    }
  }
  const rows = [...byPrefix.values()].sort((a, b) => cmpPrefix(a.prefix, b.prefix));
  const labels = peerLabels(data.peers);

  return h('div', { className: 'table-responsive' }, h('table', { className: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Prefix'), h('th', {}, 'Origin'),
      data.peers.map(p => h('th', { className: 'text-center', title: peerTitle(p) }, h('span', { className: 'peer-label justify-content-center' }, peerDot(data, p.name), labels.get(p.name))))),
    ),
    h('tbody', {}, rows.length ? rows.map(r => h('tr', {},
      h('td', {}, h('span', { className: 'mono fw-semibold' }, r.prefix)),
      h('td', {}, chip(`${r.protocol} · ${r.kind}`, 'info')),
      data.peers.map(p => h('td', { className: 'text-center' }, r.peers.has(p.name) ? yes() : no())))) :
      h('tr', {}, h('td', { colSpan: 2 + data.peers.length, className: 'muted' }, 'Nothing is announced to any peer')))));
}

// Export statistics shown per channel: [key in channel.stats.export_updates, column heading, what it counts].
const FILTER_COLS = [
  ['received', 'Considered', 'Export updates BIRD offered to the export filter since the session came up (a route counts again each time it is re-sent: a refresh, a change of its attributes, a refeed of the table)'],
  ['filtered', 'Blocked by filter', 'Of those, the updates the export filter rejected on purpose'],
  ['rejected', 'Rejected', 'Of those, the updates the BGP protocol itself refused before the export filter was applied (for example a route that was learned from that same peer, which is never sent back)'],
  ['accepted', 'Accepted', 'Of those, the updates that were sent to the peer, counted each time, so one route can add several'],
];

// One row per peer and channel. "Announced now" is how many routes the peer is sent at this moment; the other columns are BIRD's
// counters of export updates, cumulative since the session came up, so they differ from peer to peer (each session has its own age,
// refreshes and refeeds) and one route announced again adds to "Accepted" again.
function filterResults(data) {
  const rows = data.peers.flatMap(p => (p.channels.length ? p.channels : [null]).map(ch => ({ p, ch })));
  return h('div', {},
    h('div', { className: 'table-responsive' }, h('table', { className: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Peer'), h('th', {}, 'Export filter'),
        h('th', { className: 'text-end', title: 'How many routes this peer is sent right now' }, 'Announced now'),
        FILTER_COLS.map(([, l, tip]) => h('th', { className: 'text-end', title: tip }, l)))),
      h('tbody', {}, rows.map(({ p, ch }) => {
        const s = ch?.stats?.export_updates ?? {};
        const now = ch?.routes?.exported;
        return h('tr', {},
          h('td', {}, h('span', { className: 'peer-label' }, peerDot(data, p.name), p.name, ch && p.channels.length > 1 ? h('small', { className: 'muted' }, ch.afi) : null)),
          h('td', {}, ch?.output_filter ? chip(ch.output_filter, 'info') : muted('none')),
          h('td', { className: 'text-end fw-semibold' }, now == null ? '–' : fmtNum(now)),
          FILTER_COLS.map(([k]) => h('td', { className: 'text-end' }, s[k] == null ? '–' : fmtNum(s[k]))));
      })))),
    h('p', { className: 'muted small mb-0 mt-2', id: 'bgp-export-note' },
      '"Announced now" is the number of routes the peer is sent at this moment. The four columns after it are counters of export ',
      h('i', {}, 'updates'), ' since the session came up: a route that is sent again (after a refresh, a change of its attributes or a refeed of the table) is counted again, and each session has its own age, so the figures differ from peer to peer and are larger than the number of routes.'));
}

// Card combining the announcement matrix with the per-peer export filter results; the subtitle counts
// distinct announced prefixes against the peers whose session is established.
export function announcedCard(data) {
  const total = new Set(data.peers.flatMap(p => p.exported.map(e => e.prefix))).size;
  return card([icon('megaphone'), 'Announced routes', h('span', { className: 'sub' }, `${total} prefix${total === 1 ? '' : 'es'} to ${data.peers.filter(isUp).length} established peers`)],
    h('div', {}, matrix(data), h('div', { className: 'blk-pad' }, h('h3', { className: 'sec-title' }, 'Export filter results'), filterResults(data))),
    'h-100');
}

// The routes of one non-BGP protocol (direct, static, ...) as a small table: the prefix, its kind, the device it points at and whether
// the kernel has it. The protocols card shows it under the protocol's own row.
export function localRoutesTable(routes) {
  const rows = [...routes].sort((a, b) => cmpPrefix(a.prefix, b.prefix)).map(r => h('tr', {},
    h('td', {}, h('span', { className: 'mono fw-semibold' }, r.prefix)),
    h('td', {}, chip(r.kind, r.kind === 'blackhole' ? 'fair' : ''), ' ', r.source ? h('small', { className: 'muted' }, r.source) : null),
    h('td', {}, r.dev ? h('span', { className: 'mono' }, r.dev) : muted('–')),
    h('td', {}, r.in_kernel ? h('span', { className: 'cap-yes', title: 'Installed in the Linux kernel\'s routing table by the kernel protocol: the system really forwards with this route' }, icon('check-circle', 17)) : muted('–', 'Not installed in the kernel routing table'))));
  // The column headings explain themselves: what the kind and the source are, and what "Kernel" means.
  const heads = [
    ['Prefix', 'The network the route is for'],
    ['Type', 'The kind of route (unicast: forward; blackhole: discard) and where BIRD got it: device = from an interface, static = from the configuration'],
    ['Device', 'The network interface the route points at'],
    ['Kernel', 'Whether the route is also installed in the Linux kernel\'s routing table (BIRD\'s kernel protocol copies the table there). Only routes installed there are used to forward packets'],
  ];
  return h('div', { className: 'table-responsive' }, h('table', { className: 'table table-sm bgp-local' },
    h('thead', {}, h('tr', {}, heads.map(([c, tip]) => h('th', { title: tip }, c)))),
    h('tbody', {}, rows)));
}
