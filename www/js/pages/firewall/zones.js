// The zones table: for every firewall zone its interfaces (configured, and the kernel devices the firewall
// really matches), the three default policies, NAT, where it may forward to, and the traffic its reject/drop
// chains have turned away (with a live rate).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';
import { fmtBytes, fmtNum } from '../../core/format.js';
import { packetsPerSec, fmtPps } from './util.js';

const muted = t => h('span', { className: 'muted' }, t);
const mono = t => h('span', { className: 'mono' }, t);

export const policyBadge = (p, title = '') => badge(String(p).toLowerCase(), p === 'ACCEPT' ? 'success' : 'info', title);

function blockedLine(z, dir, text) {
  const b = dir === 'from' ? z.blocked_from : z.blocked_to;
  if (!b) return null;
  const pps = fmtPps(packetsPerSec(`zone/${z.name}/${dir}`));
  return h('div', { className: 'small' }, h('b', {}, fmtNum(b.packets)), ` ${b.action === 'drop' ? 'dropped' : 'rejected'} ${text}`,
    h('span', { className: 'muted' }, ` · ${fmtBytes(b.bytes)}`), pps ? h('span', { className: 'fw-pps' }, pps) : null);
}

function zoneRow(z) {
  return h('tr', { className: z.enabled ? '' : 'fw-off' },
    h('td', {}, h('strong', {}, z.name), z.masq ? [' ', badge('NAT', 'info', 'Outgoing traffic is masqueraded: this zone faces the Internet')] : null,
      z.mtu_fix ? h('div', { className: 'muted small' }, 'MSS clamping') : null),
    h('td', {}, z.networks.length ? h('div', { className: 'fw-chips' }, z.networks.map(n => h('span', { className: 'fw-chip' }, n))) : muted('none')),
    h('td', {}, z.devices.length ? h('div', { className: 'fw-chips' }, z.devices.map(d => h('span', { className: 'fw-chip mono' }, d))) : muted('none loaded')),
    h('td', {}, policyBadge(z.input, 'Traffic from this zone to the router itself')),
    h('td', {}, policyBadge(z.output, 'Traffic from the router itself into this zone')),
    h('td', {}, policyBadge(z.forward, 'Traffic between interfaces of this zone')),
    h('td', {}, z.forwards.length ? h('div', { className: 'fw-chips' }, z.forwards.map(f => h('span', { className: 'fw-chip' }, f))) : muted('no other zone')),
    h('td', {}, blockedLine(z, 'from', 'from the zone to the router'), blockedLine(z, 'to', 'on the way to the zone'),
      !z.blocked_from && !z.blocked_to ? muted('nothing counted') : null));
}

export function zonesCard(fw) {
  // [label, tooltip]: the three policy columns are defaults, which the tooltips and the legend spell out.
  const cols = [
    ['Zone'], ['Interfaces'], ['Kernel devices'],
    ['Input policy', 'Default for traffic from this zone to the router itself. reject/drop: refused unless a rule below allows it.'],
    ['Output policy', 'Default for traffic from the router itself into this zone.'],
    ['Forward policy (inside zone)', 'Default for traffic between two interfaces of this same zone. Traffic to other zones is governed by "May forward to".'],
    ['May forward to', 'Other zones this zone may send traffic to (forwarding sections). Anything else is blocked unless a rule or port forward allows it.'],
    ['Turned away'],
  ];
  return card([icon('shield-check'), h('span', {}, 'Zones'), h('span', { className: 'sub' }, `${fw.zones.length} zones · policies are defaults, specific rules are exceptions`)],
    h('div', {},
      h('div', { className: 'muted small fw-legend fw-zones-legend' },
        h('p', {}, h('b', {}, 'accept'), ' lets everything through by default. ', h('b', {}, 'reject'), ' and ', h('b', {}, 'drop'), ' refuse everything by default except what a specific rule or forwarding allows (reject answers the sender with an error, drop silently discards); replies to connections that were allowed are always let back in.'),
        h('p', {}, h('b', {}, 'Input'), ' = zone to the router itself · ', h('b', {}, 'Output'), ' = router to the zone · ', h('b', {}, 'Forward'), ' = between interfaces of the same zone only; reaching other zones is the "May forward to" column. So a wan input of reject means: nothing from the Internet reaches the router except the rules listed under "Reachable from the Internet".')),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table fw-table' },
        h('thead', {}, h('tr', {}, cols.map(([label, title]) => h('th', { title: title ?? '' }, label)))),
        h('tbody', {}, fw.zones.length ? fw.zones.map(zoneRow) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No zones are configured.')))))));
}
