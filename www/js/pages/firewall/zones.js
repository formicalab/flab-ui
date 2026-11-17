// The zones table: for every firewall zone its interfaces (configured, and the kernel devices the loaded rules really match), the three default
// policies, NAT, where it may forward to, and the traffic its reject/drop chains have turned away (with a live rate). With editing on, each row has
// Edit and Remove (Undo after a removal), a button adds a zone, and a row shows when it was changed and not saved yet.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, muted } from '../../core/ui.js';
import { fmtBytes, fmtNum } from '../../core/format.js';
import { packetsPerSec, fmtPps } from './util.js';
import { addButton, iconButton, pendingBadge } from './parts.js';

// A zone's policy as a badge: accept is green, reject/drop are neutral (refusing by default is normal).
const policyBadge = (p, title = '') => badge(String(p).toLowerCase(), p === 'ACCEPT' ? 'success' : 'info', title);

// One line counting what the zone's reject/drop chains turned away in a direction ('from' the zone to the
// router, or 'to' the zone), with the byte total and a live packet rate; null when nft has no such counter.
function blockedLine(z, dir, text) {
  const b = dir === 'from' ? z.blocked_from : z.blocked_to;
  if (!b) return null;
  const pps = fmtPps(packetsPerSec(`zone/${z.name}/${dir}`));
  return h('div', { className: 'small' }, h('b', {}, fmtNum(b.packets)), ` ${b.action === 'drop' ? 'dropped' : 'rejected'} ${text}`,
    h('span', { className: 'muted' }, ` · ${fmtBytes(b.bytes)}`), pps ? h('span', { className: 'fw-pps' }, pps) : null);
}

// The Edit / Remove (or Undo) buttons of a zone row.
function actionsCell(z, ctx) {
  if (z.removed) return h('td', { className: 'fw-actions' }, iconButton('arrow-counterclockwise', 'Keep this zone (undo the removal)', () => ctx.restore('zones', z.id)));
  return h('td', { className: 'fw-actions' }, iconButton('pencil', `Edit zone ${z.name}`, () => ctx.edit('zones', z.id)), iconButton('x-lg', `Remove zone ${z.name}`, () => ctx.remove('zones', z.id)));
}

// One table row per zone: interfaces, kernel devices, the three default policies, forwarding targets and
// the traffic turned away. Disabled zones are dimmed.
function zoneRow(z, ctx) {
  const members = [...z.networks, ...(z.values ? [...z.values.device, ...z.values.subnet] : [])];
  return h('tr', { className: `${z.enabled ? '' : 'fw-off'}${z.removed ? ' fw-removed' : ''}` },
    h('td', {}, h('strong', {}, z.name), z.masq ? [' ', badge('NAT', 'info', 'Outgoing traffic is masqueraded: this zone faces the Internet')] : null,
      z.removed || z.pending ? [' ', pendingBadge(z)] : null, z.enabled ? null : [' ', badge('disabled')],
      z.mtu_fix ? h('div', { className: 'muted small' }, 'MSS clamping') : null),
    h('td', {}, members.length ? h('div', { className: 'fw-chips' }, members.map(n => h('span', { className: `fw-chip${z.networks.includes(n) ? '' : ' mono'}` }, n))) : muted('none')),
    h('td', {}, z.devices.length ? h('div', { className: 'fw-chips' }, z.devices.map(d => h('span', { className: 'fw-chip mono' }, d))) : muted(z.pending ? 'not loaded yet' : 'none loaded')),
    h('td', {}, policyBadge(z.input, 'Traffic from this zone to the router itself')),
    h('td', {}, policyBadge(z.output, 'Traffic from the router itself into this zone')),
    h('td', {}, policyBadge(z.forward, 'Traffic between interfaces of this zone')),
    h('td', {}, z.forwards.length ? h('div', { className: 'fw-chips' }, z.forwards.map(f => h('span', { className: 'fw-chip' }, f))) : muted('no other zone')),
    h('td', {}, blockedLine(z, 'from', 'from the zone to the router'), blockedLine(z, 'to', 'on the way to the zone'),
      !z.blocked_from && !z.blocked_to ? muted('nothing counted') : null),
    ctx ? actionsCell(z, ctx) : null);
}

// The zones card: a legend explaining the policy semantics, then the zones table. `ctx` (null: read only) carries the edit actions.
export function zonesCard(fw, ctx = null) {
  // [label, tooltip]: the three policy columns are defaults, which the tooltips and the legend spell out.
  const cols = [
    ['Zone'], ['Interfaces'], ['Kernel devices'],
    ['Input policy', 'Default for traffic from this zone to the router itself. reject/drop: refused unless a rule below allows it.'],
    ['Output policy', 'Default for traffic from the router itself into this zone.'],
    ['Forward policy (inside zone)', 'Default for traffic between two interfaces of this same zone. Traffic to other zones is governed by "May forward to".'],
    ['May forward to', 'Other zones this zone may send traffic to (forwarding sections). Anything else is blocked unless a rule or port forward allows it.'],
    ['Turned away'],
    ...(ctx ? [['']] : []),
  ];
  const rows = fw.rows?.zones ?? fw.zones;
  return card([icon('shield-check'), h('span', {}, 'Zones'), h('span', { className: 'sub' }, `${fw.zones.length} zones · policies are defaults, specific rules are exceptions`), ctx ? addButton('Add zone', () => ctx.edit('zones', null), ctx.canEdit) : null],
    h('div', {},
      h('div', { className: 'muted small fw-legend fw-zones-legend' },
        h('p', {}, h('b', {}, 'accept'), ' lets everything through by default. ', h('b', {}, 'reject'), ' and ', h('b', {}, 'drop'), ' refuse everything by default except what a specific rule or forwarding allows (reject answers the sender with an error, drop silently discards); replies to connections that were allowed are always let back in.'),
        h('p', {}, h('b', {}, 'Input'), ' = zone to the router itself · ', h('b', {}, 'Output'), ' = router to the zone · ', h('b', {}, 'Forward'), ' = between interfaces of the same zone only; reaching other zones is the "May forward to" column. So a wan input of reject means: nothing from the Internet reaches the router except what the traffic rules and port forwards below allow.')),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table fw-table' },
        h('thead', {}, h('tr', {}, cols.map(([label, title]) => h('th', { title: title ?? '' }, label)))),
        h('tbody', {}, rows.length ? rows.map(z => zoneRow(z, ctx)) : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No zones are configured.')))))));
}
