// The VLAN membership cards of the Ethernet ports view: one per bridge that filters VLANs or has a VLAN table, and one per switch that
// is driven through swconfig (its VLAN groups). Each is a matrix with one row per VLAN and one column per port, so it reads at a
// glance which ports carry which VLAN, tagged or untagged, and which VLAN a port puts untagged frames into (its PVID). A login that
// may change the network config gets an "Edit VLANs" button on each card (and "Set up VLAN filtering" on a bridge that has no table
// yet), which opens the editable cards of vlanedit.js in their place.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, muted } from '../../core/ui.js';
import { editCards } from './vlanedit.js';

// The cell of one port in one VLAN: tagged or untagged, plus a PVID mark; empty when the port is not in the VLAN.
function cell(entry) {
  if (!entry) return h('td', { className: 'muted' }, '–');
  return h('td', {}, badge(entry.tagged ? 'tagged' : 'untagged', entry.tagged ? 'info' : ''), entry.pvid ? badge('PVID', 'success', 'Untagged frames that arrive on this port join this VLAN') : null);
}

// The matrix of `vlans` ([{ vid, ports: [{ name, tagged, pvid }] }]) over the columns `names`.
function matrix(vlans, names) {
  return h('div', { className: 'grid-wrap' }, h('table', { className: 'table vlan-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'VLAN'), names.map(n => h('th', {}, n)))),
    h('tbody', {}, vlans.map(v => h('tr', {}, h('td', {}, h('strong', {}, v.vid)), names.map(n => cell(v.ports.find(p => p.name === n))))))));
}

// The port names that appear in `vlans`, members of the bridge first in their order, the rest after.
function columns(vlans, order) {
  const seen = new Set(vlans.flatMap(v => v.ports.map(p => p.name)));
  return [...order.filter(n => seen.has(n)), ...[...seen].filter(n => !order.includes(n)).sort()];
}

// The button at the right of a card header that opens the VLAN editor; nothing for a login that may not change the config.
const editButton = (ctx, label = 'Edit VLANs') => (ctx ? h('span', { className: 'ms-auto' }, button(label, 'pencil', ctx.open)) : null);

// The card of a bridge's VLAN table. `table.source` says whether it is the live kernel table or what the network config asks for.
function bridgeCard(b, ctx) {
  const t = b.vlan_table;
  const where = t.source === 'kernel' ? 'read from the kernel (bridge vlan show)' : t.source === 'config' ? 'from the network config (bridge-vlan sections); the live table needs the bridge tool (iproute2 bridge)' : '';
  return card([icon('diagram-2'), h('span', {}, `Bridge ${b.name} · VLANs`), badge(b.vlan_filtering ? 'VLAN filtering on' : 'VLAN filtering off', b.vlan_filtering ? 'success' : ''), h('span', { className: 'sub' }, where), editButton(ctx)],
    h('div', {}, t.vlans.length
      ? matrix(t.vlans, columns(t.vlans, [...b.members.map(m => m.name), b.name]))
      : h('div', { className: 'p-3' }, muted('VLAN filtering is on but no VLAN is configured on this bridge.'))));
}

// The card of a swconfig switch's VLAN groups; the PVID of each port comes from the port's own attribute.
function switchCard(sw, net, ctx) {
  const pvid = new Map(net.ports.map(p => [p.name, p.pvid]));
  const vlans = sw.vlans.map(v => ({ vid: v.vid, ports: v.ports.map(p => ({ ...p, pvid: pvid.get(p.name) === v.vid })) }));
  const order = sw.ports;
  return card([icon('diagram-2'), h('span', {}, `Switch ${sw.label ?? ''} · VLAN groups`), badge(sw.vlan_enabled ? 'VLANs on' : 'VLANs off', sw.vlan_enabled ? 'success' : 'warning'),
    h('span', { className: 'sub' }, 'read with swconfig; the CPU port is not listed'), editButton(ctx)],
  h('div', {}, matrix(vlans, columns(vlans, order))));
}

// The card of a bridge that has Ethernet ports but no VLAN table and does not filter: the way into the editor for setting one up.
// Its header avoids the words "VLANs" and "VLAN groups", which name the cards of the tables that exist.
function setupCard(b, ctx) {
  return card([icon('diagram-2'), h('span', {}, `Bridge ${b.name} · VLAN filtering`), badge('VLAN filtering off', ''),
    h('span', { className: 'sub' }, 'no bridge-vlan section in the network config'), editButton(ctx, 'Set up VLAN filtering')]);
}

// Whether a bridge without a VLAN table could get one: it has an Ethernet port.
const canFilter = b => b.members.some(m => m.kind === 'ethernet');

// The VLAN cards for the page, in order: bridges, then swconfig switches. Empty when nothing on the router uses VLANs. `ctx` is the
// editor's context (vlanpage.js), null for a login that may not change the config; while the editor is open the cards are its own.
export function vlanCards(net, ctx) {
  if (ctx?.edit) return editCards(ctx);
  return [
    ...net.bridges.filter(b => b.vlan_table).map(b => bridgeCard(b, ctx)),
    ...(ctx ? net.bridges.filter(b => !b.vlan_table && canFilter(b)).map(b => setupCard(b, ctx)) : []),
    ...(net.switches ?? []).filter(sw => sw.kind === 'swconfig' && sw.vlans?.length).map(sw => switchCard(sw, net, ctx)),
  ];
}
