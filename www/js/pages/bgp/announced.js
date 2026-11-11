// What this router announces: a prefix x peer matrix, the export-filter results per peer, and the
// locally originated / connected routes.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, chip } from '../../core/ui.js';
import { fmtNum } from '../../core/format.js';
import { peerDot, peerTitle, cmpPrefix, isUp, peerLabels } from './util.js';

const muted = t => h('span', { className: 'muted' }, t);
const yes = () => h('span', { className: 'cap-yes', title: 'Announced' }, icon('check-circle', 17));
const no = () => h('span', { className: 'muted', title: 'Not announced' }, '–');

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

  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Prefix'), h('th', {}, 'Origin'),
      data.peers.map(p => h('th', { className: 'text-center', title: peerTitle(p) }, h('span', { className: 'peer-label justify-content-center' }, peerDot(data, p.name), labels.get(p.name))))),
    ),
    h('tbody', {}, rows.length ? rows.map(r => h('tr', {},
      h('td', {}, h('span', { className: 'mono fw-semibold' }, r.prefix)),
      h('td', {}, chip(`${r.protocol} · ${r.kind}`, 'info')),
      data.peers.map(p => h('td', { className: 'text-center' }, r.peers.has(p.name) ? yes() : no())))) :
      h('tr', {}, h('td', { colSpan: 2 + data.peers.length, className: 'muted' }, 'Nothing is announced to any peer')))));
}

const FILTER_COLS = [['received', 'Considered'], ['filtered', 'Blocked by filter'], ['rejected', 'Rejected'], ['accepted', 'Announced']];

// BIRD's export statistics are cumulative since the session came up; one row per peer and channel.
function filterResults(data) {
  const rows = data.peers.flatMap(p => (p.channels.length ? p.channels : [null]).map(ch => ({ p, ch })));
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Peer'), h('th', {}, 'Export filter'), FILTER_COLS.map(([, l]) => h('th', { className: 'text-end' }, l)))),
    h('tbody', {}, rows.map(({ p, ch }) => {
      const s = ch?.stats?.export_updates ?? {};
      return h('tr', {},
        h('td', {}, h('span', { className: 'peer-label' }, peerDot(data, p.name), p.name, ch && p.channels.length > 1 ? h('small', { className: 'muted' }, ch.afi) : null)),
        h('td', {}, ch?.output_filter ? chip(ch.output_filter, 'info') : muted('none')),
        FILTER_COLS.map(([k]) => h('td', { className: 'text-end' }, s[k] == null ? '–' : fmtNum(s[k]))));
    }))));
}

export function announcedCard(data) {
  const total = new Set(data.peers.flatMap(p => p.exported.map(e => e.prefix))).size;
  return card([icon('megaphone'), 'Announced routes', h('span', { className: 'sub' }, `${total} prefix${total === 1 ? '' : 'es'} to ${data.peers.filter(isUp).length} established peers`)],
    h('div', {}, matrix(data), h('div', { className: 'blk-pad' }, h('h3', { className: 'sec-title' }, 'Export filter results'), filterResults(data))),
    'h-100');
}

export function localCard(data) {
  const rows = [...data.local].sort((a, b) => cmpPrefix(a.prefix, b.prefix)).map(r => h('tr', {},
    h('td', {}, h('span', { className: 'mono fw-semibold' }, r.prefix)),
    h('td', {}, badge(r.protocol, '')),
    h('td', {}, chip(r.kind, r.kind === 'blackhole' ? 'fair' : ''), ' ', r.source ? h('small', { className: 'muted' }, r.source) : null),
    h('td', {}, r.dev ? h('span', { className: 'mono' }, r.dev) : muted('–')),
    h('td', {}, r.in_kernel ? h('span', { className: 'cap-yes', title: 'Installed in the kernel' }, icon('check-circle', 17)) : muted('–'))));
  return card([icon('signpost-split'), 'Local & connected routes', h('span', { className: 'sub' }, `${data.local.length} routes`)],
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover' },
      h('thead', {}, h('tr', {}, ['Prefix', 'Protocol', 'Type', 'Device', 'Kernel'].map(c => h('th', {}, c)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 5, className: 'muted' }, 'No local routes'))))),
    'h-100');
}
