// Logical (netifd) interfaces: protocol, device, addresses, gateway, DNS and uptime, from the standard
// network.interface dump call.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, table } from '../../core/ui.js';
import { fmtDur } from '../../core/format.js';

const mono = t => h('div', { className: 'mono small' }, t);

export const addressesOf = i => [...(i['ipv4-address'] ?? []), ...(i['ipv6-address'] ?? [])].map(a => `${a.address}/${a.mask}`);

// L3 addresses by device name, used to label bridges and ports.
export function addressesByDevice(ifs) {
  const map = new Map();
  for (const i of ifs) {
    const dev = i.l3_device || i.device;
    if (dev) map.set(dev, [...(map.get(dev) ?? []), ...addressesOf(i)]);
  }
  return map;
}

const gatewayOf = i => (i.route ?? []).find(r => r.mask === 0 && (r.target === '0.0.0.0' || r.target === '::'))?.nexthop;

export function interfacesCard(ifs) {
  const rows = ifs.filter(i => i.interface !== 'loopback').map(i => [
    h('strong', {}, i.interface),
    badge(i.up ? 'up' : i.pending ? 'pending' : 'down', i.up ? 'success' : i.pending ? 'warning' : 'danger'),
    i.proto,
    i.l3_device || i.device || '',
    h('div', {}, addressesOf(i).map(mono)),
    gatewayOf(i) ? mono(gatewayOf(i)) : '',
    h('div', {}, (i['dns-server'] ?? []).map(mono)),
    i.up ? fmtDur(i.uptime) : '',
  ]);
  return card([icon('diagram-3'), h('span', {}, 'Logical interfaces'), h('span', { className: 'sub' }, `${rows.length} configured`)],
    table(['Interface', 'State', 'Protocol', 'Device', 'Addresses', 'Gateway', 'DNS', 'Uptime'], rows));
}
