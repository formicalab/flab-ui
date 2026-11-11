// Network layers: one row per logical interface showing what it is built on, from the physical layer up:
//   ports / radios and their Wi-Fi or mesh interfaces  ›  devices (bridge, VLAN)  ›  interface (protocol, addresses)  ›  protocol device
// The data model (layers.js) is resolved from the flab.network devices and netifd's network.interface
// dump, so a new bridge, VLAN or tunnel shows up as a new chain without any page change.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card } from '../../core/ui.js';
import { fmtDur } from '../../core/format.js';
import { buildLayers } from './layers.js';
import { addressesOf } from '../network/shared.js';

const mono = t => h('div', { className: 'mono small' }, t);
const muted = t => h('span', { className: 'muted' }, t);

const gatewayOf = i => (i.route ?? []).find(r => r.mask === 0 && (r.target === '0.0.0.0' || r.target === '::'))?.nexthop;

// A node of a chain: status dot, name and what kind of thing it is. Wireless nodes carry their radio, so the
// radio layer (radio › Wi-Fi/mesh interface) is visible in the same chip and link to their pages.
function node(n, sub) {
  const dot = n.up ? 'up' : 'idle';
  const glyph = n.kind === 'wifi' ? icon('wifi', 12) : n.kind === 'mesh' ? icon('arrow-left-right', 12) : n.kind === 'radio' ? icon('broadcast', 12)
    : n.kind === 'port' ? icon('ethernet', 12) : n.kind === 'bridge' ? icon('diagram-2', 12) : null;
  const wireless = n.kind === 'wifi' || n.kind === 'mesh' || n.kind === 'radio';
  const detail = wireless ? [n.kind === 'mesh' ? `mesh ${n.ssid ?? ''}`.trim() : n.ssid, n.radio ? `${n.radio}${n.band ? ' ' + n.band : ''}` : null, n.enabled === false ? 'disabled' : null].filter(Boolean).join(' · ') : sub;
  const chip = h('span', { className: `cn k-${n.kind ?? 'device'}`, title: detail ?? '' },
    h('span', { className: `dot ${dot}` }), glyph, h('span', { className: 'cn-name' }, n.name),
    detail ? h('span', { className: 'cn-sub' }, detail) : null);
  return wireless ? h('a', { href: n.kind === 'mesh' ? '#mesh' : '#wifi', className: 'cn-link' }, chip) : chip;
}

const sepNode = () => h('span', { className: 'cn-sep' }, '›');

function physicalCell(row) {
  if (row.roots.length) return h('div', { className: 'cn-group' }, row.roots.map(r => node(r)));
  if (row.over) return h('span', { className: 'cn-over' }, 'runs over interface ', h('b', {}, row.over));
  return muted('–');
}

function devicesCell(row) {
  if (!row.devices.length) return muted(row.roots.length && !row.orphan ? 'directly on the port' : '–');
  const out = [];
  row.devices.forEach((d, i) => {
    if (i) out.push(sepNode());
    out.push(node(d, d.kind === 'vlan' ? `VLAN ${d.vid}` : d.kind === 'bridge' ? (d.stp ? 'bridge · STP' : 'bridge') : ''));
  });
  return h('div', { className: 'cn-group' }, out);
}

function interfaceCell(row) {
  if (row.orphan) return muted(row.roots[0].kind === 'radio' ? 'radio with no interface configured' : 'not attached to a network interface');
  return h('div', {},
    h('strong', {}, row.name), ' ', badge(row.proto ?? '?', 'info'),
    row.over && row.roots.length ? h('div', { className: 'muted small' }, 'on the protocol device of ', h('b', {}, row.over)) : null);
}

function protoCell(row) {
  const d = row.protoDevice;
  if (!d) return muted('–');
  return h('div', {}, node({ name: d.name, kind: 'protocol', up: row.up }, ''), d.label ? h('div', { className: 'muted small' }, d.shared ? `${d.label} (shared)` : d.label) : null);
}

function addressingCell(r) {
  if (!r.iface) return muted('–');
  return [h('div', {}, addressesOf(r.iface).map(mono)), gatewayOf(r.iface) ? h('div', { className: 'muted small' }, 'gateway ', h('span', { className: 'mono' }, gatewayOf(r.iface))) : null,
    (r.iface['dns-server'] ?? []).length ? h('div', { className: 'muted small' }, 'DNS ', h('span', { className: 'mono' }, r.iface['dns-server'].join(', '))) : null];
}

function stateCell(r) {
  if (!r.iface) return badge(r.up ? 'up' : 'down', r.up ? 'success' : '');
  return [badge(r.up ? 'up' : r.iface.pending ? 'pending' : 'down', r.up ? 'success' : r.iface.pending ? 'warning' : 'danger'), r.up ? h('div', { className: 'muted small' }, fmtDur(r.iface.uptime)) : null];
}

export function interfacesCard(ifs, net, tunlinks, radios) {
  const rows = buildLayers(net, ifs, tunlinks, radios).map(r => h('tr', {},
    h('td', {}, physicalCell(r)),
    h('td', {}, devicesCell(r)),
    h('td', {}, interfaceCell(r)),
    h('td', {}, protoCell(r)),
    h('td', {}, addressingCell(r)),
    h('td', {}, stateCell(r))));

  const cols = ['Ports, radios and Wi-Fi', 'Devices', 'Interface', 'Protocol device', 'Addressing', 'State'];
  return card([icon('diagram-3'), h('span', {}, 'Network layers'), h('span', { className: 'sub' }, `${rows.length} rows, built up from the physical ports and radios`)],
    h('div', {},
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table layers-table' },
        h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No interfaces are configured.'))))),
      h('div', { className: 'muted small layers-foot' }, 'Ports and Wi-Fi or mesh interfaces (each on its radio) are grouped into bridges or tagged into VLAN devices; an interface (netifd) binds to one device and holds the protocol and addresses; PPPoE and tunnels add a protocol device on top. Wireless that belongs to no network interface, and radios with no interface, are listed at the end.')));
}
