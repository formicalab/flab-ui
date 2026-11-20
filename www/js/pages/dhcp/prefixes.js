// The read-only card of the DHCP page that is not about one client: the IPv6 prefixes odhcpd announces on each interface
// in its router advertisements. (The DHCPv4 and DHCPv6 leases are in the clients card, clients.js.)
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, card, mono, table } from '../../core/ui.js';

// The IPv6 prefixes announced on each interface (from the router advertisements), with a warning for stale ones.
export function announcedCard(data) {
  const rows = data.ra
    .flatMap(a => a.prefixes.map(p => ({ iface: a.iface, device: a.device, ...p })))
    .sort((a, b) => a.iface.localeCompare(b.iface) || a.prefix.localeCompare(b.prefix));
  return card(
    [icon('broadcast'), h('span', {}, 'IPv6 prefixes advertised to clients'),
      h('span', { className: 'sub' }, 'Sent in router advertisements; clients build their IPv6 addresses from these. A stale prefix is being withdrawn.')],
    table(['Interface', 'Device', 'Prefix', 'State'], rows.map(p => [
      p.iface, mono(p.device), mono(`${p.prefix}/${p.length}`),
      p.stale ? badge('stale', 'warning', 'the prefix is no longer valid upstream and is being phased out') : badge('current', 'success'),
    ])), 'dhcp-tbl');
}
