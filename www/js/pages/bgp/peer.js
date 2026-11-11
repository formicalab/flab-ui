// One card per BGP peer: session, negotiated capabilities (both directions) and the IPv4 channel.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, chip, kv, section, meter } from '../../core/ui.js';
import { fmtNum, fmtBytes } from '../../core/format.js';
import { peerClass, peerTitle, isUp, stateKind, isPrivateAs } from './util.js';

const muted = t => h('span', { className: 'muted' }, t);
const mono = t => h('span', { className: 'mono' }, t);

const CAP_HELP = {
  'Multiprotocol': 'Address families exchanged over the session (RFC 4760)',
  'Route refresh': 'Peer can be asked to resend its routes without resetting the session (RFC 2918)',
  'Graceful restart': 'Forwarding continues while the BGP control plane restarts (RFC 4724)',
  '4-octet AS numbers': 'Full 32-bit AS numbers (RFC 6793)',
  'Enhanced refresh': 'Route refresh with begin/end markers (RFC 7313)',
  'Long-lived graceful restart': 'Stale routes are kept for hours instead of minutes (RFC 9494)',
};

const SESSION_WORDS = { external: ['eBGP', 'Different AS'], internal: ['iBGP', 'Same AS'], multihop: ['multihop', 'Peer is not directly connected; TTL is raised'],
  direct: ['direct', 'Peer is on a directly connected network'], AS4: ['4-octet AS', 'Session uses 32-bit AS numbers'] };

function timer(t, what) {
  if (!t) return muted('–');
  return h('div', {}, meter(t.left, t.total, t.left / t.total < 0.25 ? 'fair' : 'good'),
    h('div', { className: 'muted small', title: what }, `${t.left.toFixed(0)} s left of ${t.total} s`));
}

function sessionChips(session) {
  return h('div', { className: 'chips' }, (session ?? '').split(' ').filter(Boolean).map(w => {
    const [label, title] = SESSION_WORDS[w] ?? [w, ''];
    return chip(label, 'info', title);
  }));
}

function sessionBlock(p) {
  return section('BGP session', kv([
    ['State', h('span', {}, badge(p.state, stateKind(p.state)), p.state !== p.protocol_state && p.protocol_state ? badge(`protocol ${p.protocol_state}`, '') : null)],
    ['Neighbor', h('span', {}, mono(p.neighbor ?? '–'), ` · AS ${p.neighbor_as ?? '–'}`, isPrivateAs(p.neighbor_as) ? ' (private)' : '')],
    ['Neighbor ID', mono(p.router_id ?? '–')],
    ['Local', h('span', {}, mono(p.source_address ?? '–'), ` · AS ${p.local_as ?? '–'}`)],
    ['Session type', sessionChips(p.session)],
    ['Carried over', p.iface ? h('span', {}, mono(p.iface), ' (xfrm interface of an IPsec tunnel)') : muted('unknown')],
    ['Since', h('span', { title: 'BIRD prints only the date for sessions older than a day' }, p.since ?? '–')],
    ['Hold timer', timer(p.hold_timer, 'Session is declared dead when this reaches zero')],
    ['Keepalive timer', timer(p.keepalive_timer, 'Time until the next keepalive is sent')],
    ['Send hold timer', timer(p.send_hold_timer, 'Closes the session if the peer stops reading our messages')],
    ['TX queue', p.tx_pending != null ? `${fmtBytes(p.tx_pending)} pending` : '–'],
    p.last_error ? ['Last error', h('span', { className: 'text-danger' }, p.last_error)] : null,
    p.connect_delay ? ['Next connect attempt', timer(p.connect_delay, 'BIRD retries the TCP connection when this reaches zero')] : null,
  ]));
}

function capDetail(cap) {
  if (!cap) return null;
  const d = cap.details ?? {};
  const parts = [];
  if (d.af_announced) parts.push(d.af_announced);
  if (d.restart_time) parts.push(`restart ${d.restart_time}s`);
  return parts.length ? parts.join(' · ') : null;
}

function capCell(cap) {
  return h('td', { className: 'cap-cell' },
    cap ? h('span', { className: 'cap-yes' }, icon('check-circle', 15)) : h('span', { className: 'cap-no' }, icon('x-circle', 15)),
    capDetail(cap) ? h('small', { className: 'muted' }, capDetail(cap)) : null);
}

function capsBlock(p) {
  const names = [...new Set([...p.local_caps.map(c => c.name), ...p.neighbor_caps.map(c => c.name)])];
  const find = (list, name) => list.find(c => c.name === name);
  const rows = names.map(name => {
    const l = find(p.local_caps, name), n = find(p.neighbor_caps, name);
    return h('tr', { className: l && n ? '' : 'mismatch', title: l && n ? '' : 'Only one side offers this capability, so it is not in use' },
      h('td', {}, h('span', { title: CAP_HELP[name] ?? '' }, name)), capCell(l), capCell(n));
  });
  return section('Capabilities', h('div', { className: 'grid-wrap' }, h('table', { className: 'table cap-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Capability'), h('th', {}, 'This router'), h('th', {}, 'Neighbor'))),
    h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 3, className: 'muted' }, 'No capabilities negotiated'))))));
}

const STAT_ROWS = [['import_updates', 'Import updates'], ['import_withdraws', 'Import withdraws'], ['export_updates', 'Export updates'], ['export_withdraws', 'Export withdraws']];
const STAT_COLS = [['received', 'received'], ['rejected', 'rejected'], ['filtered', 'filtered'], ['ignored', 'ignored'], ['accepted', 'accepted']];

function statsTable(stats) {
  const cell = (v, col) => h('td', { className: v > 0 && (col === 'rejected' || col === 'filtered') ? 'stat-warn' : '' }, v == null ? '–' : fmtNum(v));
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table stats-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Route changes'), STAT_COLS.map(([, l]) => h('th', {}, l)))),
    h('tbody', {}, STAT_ROWS.map(([key, label]) => h('tr', {}, h('td', {}, label), STAT_COLS.map(([col]) => cell(stats?.[key]?.[col], col)))))));
}

function channelBlock(ch, peer) {
  if (!ch) return section('Routing', muted('No channel.'));
  const r = ch.routes ?? {};
  const upState = s => badge(s ?? '–', /UP|READY/.test(s ?? '') ? 'success' : 'warning');
  return section(`Routing · ${ch.afi}`, h('div', {},
    kv([
      ['Channel', upState(ch.state)],
      ['Import / export', h('span', {}, upState(ch.import_state), ' ', upState(ch.export_state))],
      ['Table', mono(ch.table ?? '–')],
      ['Preference', ch.preference ?? '–'],
      ['Import filter', ch.input_filter ? chip(ch.input_filter, 'info', 'Applied to every received route') : muted('none')],
      ['Export filter', ch.output_filter ? chip(ch.output_filter, 'info', 'Decides what is announced to the peer') : muted('none')],
      ['BGP next hop', mono(ch.bgp_next_hop ?? '–')],
      ['Routes', h('div', {}, `${fmtNum(r.imported ?? 0)} imported · ${fmtNum(r.exported ?? 0)} announced · ${fmtNum(r.preferred ?? 0)} best`,
        meter(r.preferred ?? 0, r.imported || 1, 'good'))],
    ]),
    h('div', { className: 'mt-3' }, statsTable(ch.stats))));
}

export function peerCard(p, data) {
  const up = isUp(p);
  return h('div', { className: `card bgp-card ${peerClass(data, p.name)} ${up ? 'is-up' : 'is-down'}` },
    h('div', { className: 'bgp-card-head' },
      h('span', { className: `dot ${up ? 'up' : 'down'}` }),
      h('strong', { className: 'name' }, peerTitle(p)),
      badge(p.name, ''),
      badge(p.state, stateKind(p.state)),
      badge(p.neighbor ?? '–', 'info')),
    h('div', { className: 'bgp-cols' }, sessionBlock(p), capsBlock(p),
      h('div', { className: 'bgp-channels' }, p.channels.length ? p.channels.map(c => channelBlock(c, p)) : channelBlock(null, p))));
}
