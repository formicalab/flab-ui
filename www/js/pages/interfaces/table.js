// Network layers: one row per logical interface showing what it is built on, from the physical layer up:
//   ports / radios and their Wi-Fi or mesh interfaces  ›  devices (bridge, VLAN)  ›  interface (protocol, addresses)  ›  protocol device
// The data model (layers.js) is resolved from the flab.network devices and netifd's network.interface
// dump, so a new bridge, VLAN or tunnel shows up as a new chain without any page change.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, muted } from '../../core/ui.js';
import { fmtDur } from '../../core/format.js';
import { buildLayers } from './layers.js';
import { addressesOf } from '../network/shared.js';

// An address line in the Addressing column (smaller than the inline `mono` helper).
const mono = t => h('div', { className: 'mono small' }, t);

// Default route's next hop (0.0.0.0/0 or ::/0), shown as the gateway.
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

// Arrow between two chips of a device chain.
const sepNode = () => h('span', { className: 'cn-sep' }, '›');

// Rows that sit on the very same ports and radios (lan and lan100 on one bridge) show them once: the first row
// lists them, later rows say "same ports as <first>". Single-port rows stay explicit, they are short already.
const signature = row => row.roots.map(r => r.name).sort().join(',');

// First column: the ports and radios under the row, the "same ports as" shortcut, or the interface it runs over.
function physicalCell(row, firstBySignature) {
  if (row.roots.length) {
    const first = row.roots.length > 1 ? firstBySignature.get(signature(row)) : null;
    if (first && first !== row.name) return h('div', { className: 'cn-same' }, icon('arrow-up', 12), h('span', {}, `same ${row.roots.length} ports and radios as `, h('b', {}, first)));
    return h('div', { className: 'cn-group' }, row.roots.map(r => node(r)));
  }
  if (row.over) return h('span', { className: 'cn-over' }, 'runs over interface ', h('b', {}, row.over));
  return muted('–');
}

// What the device layer carries: a bridge or port hands over its untagged frames, a VLAN device picks out the
// frames with its tag, which is how two interfaces share the same wires.
function carries(row) {
  const last = row.devices.at(-1);
  if (!last) return row.roots.length && !row.orphan ? 'directly on the port: its untagged frames' : null;
  if (last.kind === 'vlan') {
    const below = row.devices.at(-2)?.name ?? row.roots[0]?.name;
    return `only frames tagged VLAN ${last.vid}${below ? ` on ${below}` : ''}`;
  }
  return last.kind === 'bridge' ? 'the bridge\'s untagged frames' : null;
}

// Devices column: the chain of bridge/VLAN devices bottom-up, with a note on which frames the layer carries.
function devicesCell(row) {
  if (!row.devices.length) return muted(carries(row) ?? '–');
  const out = [];
  row.devices.forEach((d, i) => {
    if (i) out.push(sepNode());
    out.push(node(d, d.kind === 'vlan' ? `VLAN ${d.vid}` : d.kind === 'bridge' ? (d.stp ? 'bridge · STP' : 'bridge') : ''));
  });
  return [h('div', { className: 'cn-group' }, out), carries(row) ? h('div', { className: 'muted small cn-carries' }, carries(row)) : null];
}

// Interface column: name and protocol; orphan wireless rows say why they have no interface.
function interfaceCell(row) {
  if (row.orphan) return muted(row.roots[0].kind === 'radio' ? 'radio with no interface configured' : 'not attached to a network interface');
  return h('div', {},
    h('strong', {}, row.name), ' ', badge(row.proto ?? '?', 'info'),
    row.over && row.roots.length ? h('div', { className: 'muted small' }, 'on the protocol device of ', h('b', {}, row.over)) : null);
}

// Protocol device column (pppoe-wan, wg0, ...); a device owned by another interface is labeled "(shared)".
function protoCell(row) {
  const d = row.protoDevice;
  if (!d) return muted('–');
  return h('div', {}, node({ name: d.name, kind: 'protocol', up: row.up }, ''), d.label ? h('div', { className: 'muted small' }, d.shared ? `${d.label} (shared)` : d.label) : null);
}

// A default route, i.e. a /0 route to the IPv4 or IPv6 unspecified address.
const isDefault = r => r.mask === 0 && (r.target === '0.0.0.0' || r.target === '::');
// A route whose next hop is the unspecified address is reached directly on the interface.
const onLink = hop => !hop || hop === '0.0.0.0' || hop === '::';

// Addressing column: addresses, gateway, DNS, non-default routes and IPv6 prefixes (assigned and received).
function addressingCell(r) {
  if (!r.iface) return muted('–');
  const i = r.iface;
  const routes = (i.route ?? []).filter(x => !isDefault(x));
  // Prefixes netifd hands out to other interfaces (ip6assign) and prefixes received from the provider.
  const assigned = (i['ipv6-prefix-assignment'] ?? []).map(p => `${p.address}/${p.mask}`);
  const received = (i['ipv6-prefix'] ?? []).map(p => `${p.address}/${p.mask}`);
  const line = (label, v) => h('div', { className: 'muted small' }, `${label} `, h('span', { className: 'mono' }, v));
  return [
    h('div', {}, addressesOf(i).map(mono)),
    gatewayOf(i) ? line('gateway', gatewayOf(i)) : null,
    (i['dns-server'] ?? []).length ? line('DNS', i['dns-server'].join(', ')) : null,
    ...routes.map(x => line('route', `${x.target}/${x.mask} ${onLink(x.nexthop) ? 'on link' : `via ${x.nexthop}`}${x.metric ? ` (metric ${x.metric})` : ''}`)),
    ...assigned.map(p => line('prefix', p)),
    ...received.map(p => line('received prefix', p)),
  ];
}

// Firewall zone (with its policy as a tooltip) and the address services the router runs on the interface.
function zoneCell(r, net) {
  if (!r.iface) return muted('–');
  const zone = (net.zones ?? []).find(z => z.networks.includes(r.name));
  const dhcp = net.dhcp?.[r.name];
  const policy = z => `input ${z.input}, output ${z.output}, forward ${z.forward}${z.masq ? ', NAT' : ''}; may forward to: ${z.forwards.join(', ') || 'nowhere'}`;
  const pool = d => d.start != null && d.limit ? `pool .${d.start}–.${d.start + d.limit - 1}` : null;
  return [
    h('div', {}, zone ? badge(zone.name, zone.input === 'ACCEPT' ? 'success' : 'info', policy(zone)) : badge('no zone', '', 'Not in any firewall zone')),
    zone ? h('div', { className: 'muted small' }, zone.masq ? 'NAT · ' : '', `in ${zone.input.toLowerCase()}`) : null,
    dhcp && dhcp.v4 !== 'disabled' ? h('div', { className: 'muted small' }, 'DHCPv4 ', pool(dhcp) ?? dhcp.v4, dhcp.leasetime ? ` · ${dhcp.leasetime}` : '') : null,
    dhcp && dhcp.v6 !== 'disabled' ? h('div', { className: 'muted small' }, `DHCPv6 ${dhcp.v6}`) : null,
    dhcp && dhcp.ra !== 'disabled' ? h('div', { className: 'muted small' }, `RA ${dhcp.ra}`) : null,
  ];
}

// State column: up, pending (netifd is still bringing it up) or down, with the uptime while up.
function stateCell(r) {
  if (!r.iface) return badge(r.up ? 'up' : 'down', r.up ? 'success' : '');
  return [badge(r.up ? 'up' : r.iface.pending ? 'pending' : 'down', r.up ? 'success' : r.iface.pending ? 'warning' : 'danger'), r.up ? h('div', { className: 'muted small' }, fmtDur(r.iface.uptime)) : null];
}

// The "Network layers" card: legend plus one table row per layers.js row. `first` maps a ports signature to
// the first row that lists those ports, so later rows can refer to it.
export function interfacesCard(ifs, net, tunlinks, radios) {
  const layers = buildLayers(net, ifs, tunlinks, radios);
  const first = new Map();
  for (const r of layers) if (r.roots.length > 1 && !first.has(signature(r))) first.set(signature(r), r.name);

  const rows = layers.map(r => h('tr', {},
    h('td', {}, physicalCell(r, first)),
    h('td', {}, devicesCell(r)),
    h('td', {}, interfaceCell(r)),
    h('td', {}, protoCell(r)),
    h('td', {}, addressingCell(r)),
    h('td', {}, zoneCell(r, net)),
    h('td', {}, stateCell(r))));

  const cols = ['Ports, radios and Wi-Fi', 'Devices', 'Interface', 'Protocol device', 'Addressing', 'Firewall zone and services', 'State'];
  return card([icon('diagram-3'), h('span', {}, 'Network layers'), h('span', { className: 'sub' }, `${rows.length} rows, built up from the physical ports and radios`)],
    h('div', {},
      h('div', { className: 'muted small layers-legend' },
        h('p', {}, h('b', {}, 'How to read a row: '), 'ports and Wi-Fi or mesh interfaces (each on its radio) are grouped into bridges; an 802.1q VLAN device can sit on a port or bridge; a network interface (netifd) binds to one device and holds the protocol and addresses; PPPoE and tunnels add a protocol device on top.'),
        h('p', {}, h('b', {}, 'Several interfaces on the same ports: '), 'a bridge hands its untagged frames to the interface bound to it, while a VLAN device on that bridge picks out only the frames carrying its tag and gives a second, separate interface on the same wires. The ports are listed once, and the other rows say "same ports as …"; the Devices column tells which frames each row carries.'),
        h('p', {}, 'Wireless that belongs to no network interface, and radios with no interface, are listed at the end. The firewall zone and the DHCP and router-advertisement services come from the router configuration.')),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table layers-table' },
        h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: cols.length, className: 'muted' }, 'No interfaces are configured.')))))));
}
