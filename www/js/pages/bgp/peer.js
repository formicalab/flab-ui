// One card per BGP peer: session, negotiated capabilities (both directions) and one routing block per channel.

import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, chip, kv, section, meter, muted, mono } from '../../core/ui.js';
import { fmtNum, fmtBytes } from '../../core/format.js';
import { peerClass, peerTitle, isUp, stateKind, isPrivateAs } from './util.js';

// Tooltip text for each capability name BIRD reports, with the defining RFC.
const CAP_HELP = {
  'Multiprotocol': 'Address families exchanged over the session (RFC 4760)',
  'Route refresh': 'Peer can be asked to resend its routes without resetting the session (RFC 2918)',
  'Graceful restart': 'Forwarding continues while the BGP control plane restarts (RFC 4724)',
  '4-octet AS numbers': 'Full 32-bit AS numbers (RFC 6793)',
  'Enhanced refresh': 'Route refresh with begin/end markers (RFC 7313)',
  'Long-lived graceful restart': 'Stale routes are kept for hours instead of minutes (RFC 9494)',
};

// Words in BIRD's "Session:" line mapped to [chip label, tooltip]; unknown words are shown as-is.
const SESSION_WORDS = { external: ['eBGP', 'Different AS'], internal: ['iBGP', 'Same AS'], multihop: ['multihop', 'Peer is not directly connected; TTL is raised'],
  direct: ['direct', 'Peer is on a directly connected network'], AS4: ['4-octet AS', 'Session uses 32-bit AS numbers'] };

// Countdown for a BGP timer ({ left, total } in seconds): a meter that turns "fair" in the last quarter,
// plus the remaining time; a dash when the timer is not running.
function timer(t, what) {
  if (!t) return muted('–');
  return h('div', {}, meter(t.left, t.total, t.left / t.total < 0.25 ? 'fair' : 'good'),
    h('div', { className: 'muted small', title: what }, `${t.left.toFixed(0)} s left of ${t.total} s`));
}

// Chips for the space-separated session flags (e.g. "external multihop AS4").
function sessionChips(session) {
  return h('div', { className: 'chips' }, (session ?? '').split(' ').filter(Boolean).map(w => {
    const [label, title] = SESSION_WORDS[w] ?? [w, ''];
    return chip(label, 'info', title);
  }));
}

// Key/value block for the session: FSM state, both endpoints, timers, TX queue, and the last error or
// the next connect attempt when the session is down. Optional rows are null and skipped by kv().
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

// One-line detail of a capability (announced address families, graceful-restart time), or null.
function capDetail(cap) {
  if (!cap) return null;
  const d = cap.details ?? {};
  const parts = [];
  if (d.af_announced) parts.push(d.af_announced);
  if (d.restart_time) parts.push(`restart ${d.restart_time}s`);
  return parts.length ? parts.join(' · ') : null;
}

// Table cell: check mark when this side offers the capability, cross otherwise, plus its detail.
function capCell(cap) {
  return h('td', { className: 'cap-cell' },
    cap ? h('span', { className: 'cap-yes' }, icon('check-circle', 15)) : h('span', { className: 'cap-no' }, icon('x-circle', 15)),
    capDetail(cap) ? h('small', { className: 'muted' }, capDetail(cap)) : null);
}

// Capability comparison, one row per capability offered by either side. A capability is only in use
// when both sides send it, so one-sided rows are highlighted as mismatches.
function capsBlock(p) {
  const names = [...new Set([...p.local_caps.map(c => c.name), ...p.neighbor_caps.map(c => c.name)])];
  const find = (list, name) => list.find(c => c.name === name);
  // One row per capability offered by either side.
  const rows = names.map(name => {
    const l = find(p.local_caps, name), n = find(p.neighbor_caps, name);
    return h('tr', { className: l && n ? '' : 'mismatch', title: l && n ? '' : 'Only one side offers this capability, so it is not in use' },
      h('td', {}, h('span', { title: CAP_HELP[name] ?? '' }, name)), capCell(l), capCell(n));
  });
  return section('Capabilities', h('div', { className: 'grid-wrap' }, h('table', { className: 'table cap-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Capability'), h('th', {}, 'This router'), h('th', {}, 'Neighbor'))),
    h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: 3, className: 'muted' }, 'No capabilities negotiated'))))));
}

// Rows ([stats key, label]) and columns ([counter key, heading]) of the per-channel route statistics.
const STAT_ROWS = [['import_updates', 'Import updates'], ['import_withdraws', 'Import withdraws'], ['export_updates', 'Export updates'], ['export_withdraws', 'Export withdraws']];
const STAT_COLS = [['received', 'received'], ['rejected', 'rejected'], ['filtered', 'filtered'], ['ignored', 'ignored'], ['accepted', 'accepted']];

// Import/export update counters of a channel (cumulative since the session came up); non-zero
// "rejected" and "filtered" counts are highlighted because they mean routes were dropped by policy.
function statsTable(stats) {
  const cell = (v, col) => h('td', { className: v > 0 && (col === 'rejected' || col === 'filtered') ? 'stat-warn' : '' }, v == null ? '–' : fmtNum(v));
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table stats-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Route changes'), STAT_COLS.map(([, l]) => h('th', {}, l)))),
    h('tbody', {}, STAT_ROWS.map(([key, label]) => h('tr', {}, h('td', {}, label), STAT_COLS.map(([col]) => cell(stats?.[key]?.[col], col)))))));
}

// Section for one address-family channel: state, table, filters, route counts and statistics. A peer
// without channels gets a "No channel." placeholder (ch = null).
function channelBlock(ch) {
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

// The card for one peer: header (colored with the peer's palette class from util.js), then session,
// capabilities and one routing block per channel.
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
      h('div', { className: 'bgp-channels' }, p.channels.length ? p.channels.map(c => channelBlock(c)) : channelBlock(null))));
}
