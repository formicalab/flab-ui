// Health findings, BIRD protocol list, daemon details and memory use.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, kv, chip, meter, muted } from '../../core/ui.js';
import { fmtBytes, fmtNum, fmtSpan } from '../../core/format.js';
import { peerDot } from './util.js';

// Icon per finding level (the levels produced by flab.bgp.uc: good, info, warn, bad).
const LEVEL_ICON = { good: 'check-circle', info: 'info-circle', warn: 'exclamation-triangle', bad: 'shield-exclamation' };

// How many prefixes use each peer as an installed (active) next hop: shows how traffic is spread.
function nextHopShare(data) {
  const total = new Set(data.paths.map(p => p.prefix)).size;
  if (!total) return null;
  return h('div', { className: 'share' },
    h('h3', { className: 'sec-title' }, 'Active next hops per peer'),
    data.peers.map(p => {
      const active = data.paths.filter(r => r.peer === p.name && r.in_kernel).length;
      return h('div', { className: 'share-row' },
        h('span', { className: 'peer-label' }, peerDot(data, p.name), p.name),
        meter(active, total, active ? 'good' : 'weak'),
        h('span', { className: 'mv', title: 'Prefixes for which this peer is an installed next hop' }, `${active} / ${total}`));
    }),
    h('div', { className: 'muted small' }, 'Prefixes whose traffic can leave through each peer (equal-cost multipath).'));
}

// Health card: the backend's findings list (data.findings, computed server-side) under a verdict badge
// that summarizes the worst level, followed by the next-hop distribution.
export function healthCard(data) {
  const f = data.findings;
  const bad = f.filter(x => x.level === 'bad').length, warn = f.filter(x => x.level === 'warn').length;
  const verdict = bad ? badge(`${bad} problem${bad > 1 ? 's' : ''}`, 'danger') : warn ? badge(`${warn} warning${warn > 1 ? 's' : ''}`, 'warning') : badge('Healthy', 'success');
  return card([icon('activity'), 'Health', verdict],
    h('div', {},
      h('ul', { className: 'findings' }, f.length ? f.map(x => h('li', { className: x.level }, icon(LEVEL_ICON[x.level] ?? 'info-circle', 17), h('span', {}, x.text))) : h('li', { className: 'info' }, 'No findings.')),
      nextHopShare(data)),
    'h-100');
}

// "N in · N out · N best" for a channel's route counters, or a dash when BIRD reports none.
function routesText(ch) {
  const r = ch?.routes;
  return r && Object.keys(r).length ? `${r.imported ?? 0} in · ${r.exported ?? 0} out · ${r.preferred ?? 0} best` : '–';
}

// One line per channel; the address family prefixes the numbers when a protocol has several.
function channelLines(p, text) {
  if (!p.channels.length) return muted('–');
  return h('div', {}, p.channels.map(ch => h('div', {}, p.channels.length > 1 ? h('small', { className: 'muted' }, `${ch.afi} `) : null, text(ch))));
}

// Table of every BIRD protocol instance (BGP sessions, kernel, direct, ...): state, routing table, and
// per-channel route counts, preference and import/export filters.
export function protocolsCard(data) {
  const stateKind = s => s === 'up' ? 'success' : 'warning';
  const filterChips = ch => h('span', { className: 'chips' }, [ch.input_filter, ch.output_filter].map(f => f ? chip(f, f === 'ACCEPT' ? 'good' : f === 'REJECT' ? 'fair' : 'info') : muted('–')));
  const rows = data.protocols.map(p => h('tr', {},
    h('td', {}, h('b', {}, p.name)),
    h('td', {}, p.proto),
    h('td', { className: 'mono' }, (p.table ?? [...new Set(p.channels.map(c => c.table).filter(Boolean))].join(', ')) || '–'),
    h('td', {}, badge(p.state, stateKind(p.state)), p.info ? ' ' : null, p.info ? h('small', { className: 'muted' }, p.info) : null),
    h('td', {}, p.since),
    h('td', {}, channelLines(p, routesText)),
    h('td', {}, channelLines(p, ch => ch.preference ?? '–')),
    h('td', {}, channelLines(p, filterChips))));
  return card([icon('hdd-stack'), 'BIRD protocols', h('span', { className: 'sub' }, `${data.protocols.length} instances`)],
    h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-hover' },
      h('thead', {}, h('tr', {}, ['Name', 'Type', 'Table', 'State', 'Since', 'Routes', 'Pref', 'Filters (in · out)'].map(c => h('th', {}, c)))),
      h('tbody', {}, rows))));
}

// BIRD daemon facts; `started` and `reconfigured` are epoch seconds shown in the browser's locale.
export function daemonCard(data) {
  const d = data.daemon;
  return card([icon('cpu'), 'BIRD daemon'], h('div', { className: 'card-body' }, kv([
    ['Status', badge(d.state ?? 'unknown', d.state === 'up and running' ? 'success' : 'warning')],
    ['Version', `BIRD ${d.version ?? '?'}`],
    ['Router ID', h('span', { className: 'mono' }, d.router_id ?? '–')],
    ['Hostname', d.hostname ?? '–'],
    ['Uptime', d.uptime ? fmtSpan(d.uptime) : '–'],
    ['Started', d.started ? new Date(d.started * 1000).toLocaleString() : '–'],
    ['Last reconfiguration', d.reconfigured ? new Date(d.reconfigured * 1000).toLocaleString() : '–'],
    ['Routing table', `${fmtNum(d.routes)} routes for ${fmtNum(d.prefixes)} prefixes`],
  ])), 'h-100');
}

// BIRD memory by pool: stacked bars of effective (used) bytes plus allocator overhead, all scaled to the
// largest pool so they are comparable; the "Total" row has no bar, only the text.
export function memoryCard(data) {
  const rows = data.memory.filter(m => m.overhead != null);
  const max = Math.max(1, ...rows.filter(m => m.name !== 'Total').map(m => m.effective + m.overhead));
  const total = data.memory.find(m => m.name === 'Total');
  return card([icon('cpu'), 'BIRD memory', total ? h('span', { className: 'sub' }, `${fmtBytes(total.effective)} in use`) : null],
    h('div', { className: 'card-body' }, h('div', { className: 'membars' }, rows.map(m => h('div', { className: `membar ${m.name === 'Total' ? 'total' : ''}` },
      h('div', { className: 'ml' }, m.name),
      h('div', { className: 'track', title: `${fmtBytes(m.effective)} used · ${fmtBytes(m.overhead)} overhead` },
        m.name === 'Total' ? null : [h('i', { className: 'eff', style: `width:${m.effective / max * 100}%` }), h('i', { className: 'ovh', style: `width:${m.overhead / max * 100}%` })]),
      h('div', { className: 'mv' }, `${fmtBytes(m.effective)} + ${fmtBytes(m.overhead)}`)))),
    h('div', { className: 'muted small mt-2' }, 'Bars show used memory plus allocator overhead.')),
    'h-100');
}
