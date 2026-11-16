// The read-only panels of the drawer that the board builds itself: a firewall zone (policies in words, networks, services, links to the Firewall
// and DHCP pages) and the live summary of any other item (an interface, a device or a port) when the page cannot edit, or when the item is not
// part of the configuration (an interface netifd runs that /etc/config/network does not name). Every panel is { title, subtitle, body, footer }.
import { h } from '../../core/dom.js';
import { badge, kv, mono, muted } from '../../core/ui.js';
import { fmtDur } from '../../core/format.js';
import { bridgeLive } from './bridgelive.js';

// What a firewall policy means in words.
const POLICY = { ACCEPT: 'accepted', REJECT: 'rejected, with an error reply', DROP: 'dropped silently' };

// A link button to another page.
const pageLink = (href, label) => h('a', { href, className: 'btn btn-sm btn-fl' }, label);

// A list of values as monospace lines, or "none".
const lines = list => (list.length ? h('div', {}, list.map(v => h('div', { className: 'mono' }, v))) : muted('none'));

// The panel of a firewall zone. Zones and services are edited on the Firewall and DHCP pages.
export function zonePanel(item) {
  const z = item.zone;
  const nets = item.networks.map(n => {
    const d = item.services[n];
    const parts = d ? [
      d.v4 && d.v4 !== 'disabled' ? `DHCPv4 ${d.v4}${d.start != null && d.limit ? ` (.${d.start}–.${d.start + d.limit - 1}${d.leasetime ? `, lease ${d.leasetime}` : ''})` : ''}` : null,
      d.v6 && d.v6 !== 'disabled' ? `DHCPv6 ${d.v6}` : null,
      d.ra && d.ra !== 'disabled' ? `router advertisements ${d.ra}` : null,
    ].filter(Boolean) : [];
    return h('div', {}, mono(n), parts.length ? muted(` · ${parts.join(' · ')}`) : null);
  });
  const rows = z ? [
    ['Traffic to the router', POLICY[z.input] ?? z.input],
    ['Traffic from the router', POLICY[z.output] ?? z.output],
    ['Traffic between its networks', POLICY[z.forward] ?? z.forward],
    ['Address translation', z.masq ? 'NAT (masquerading): the zone\'s traffic leaves with the router\'s address' : 'none'],
    ['May forward to', z.forwards?.length ? z.forwards.join(', ') : 'no other zone'],
  ] : [];
  return {
    title: item.name,
    subtitle: z ? 'Firewall zone' : 'Interfaces without a firewall zone',
    body: h('div', { className: 'nb-panel' },
      kv([...rows, ['Networks', nets.length ? h('div', {}, nets) : muted('none')]]),
      h('p', { className: 'muted small' }, z ? 'A firewall zone groups interfaces and gives them one set of rules. Zones, forwardings and rules are edited on the Firewall page; the DHCP server and router advertisements of an interface on the DHCP page.'
        : 'Interfaces that are in no zone are not covered by any zone rules. Put them in a zone on the Firewall page.')),
    footer: [pageLink('#firewall', 'Firewall page'), pageLink('#dhcp', 'DHCP page')],
  };
}

// The live summary of an item the page does not edit: what netifd and the kernel report about it now.
export function livePanel(item, data) {
  if (item.kind === 'interface') {
    return {
      title: item.name, subtitle: `Interface · ${item.protoText}`,
      body: h('div', { className: 'nb-panel' },
        item.noProto ? h('p', { className: 'set-note warn' }, 'This interface has no protocol: netifd ignores all its settings and its device stays down.') : null,
        kv([
          ['State', item.running ? (item.up ? badge('up', 'success') : badge(item.pending ? 'pending' : 'down', item.pending ? 'warning' : 'danger')) : muted('not running')],
          item.up && item.uptime != null ? ['Uptime', fmtDur(item.uptime)] : null,
          ['Protocol', item.protoText],
          ['Device', item.deviceText ?? 'none'],
          item.protoDevice ? ['Protocol device', `${item.protoDevice.name}${item.protoDevice.label ? ` · ${item.protoDevice.label}` : ''}${item.protoDevice.shared ? ' (shared)' : ''}`] : null,
          ['IPv4 addresses', lines(item.v4)], ['IPv6 addresses', lines(item.v6)],
          item.gateway ? ['Gateway', mono(item.gateway)] : null,
          ['DNS servers', lines(item.dns)],
          item.routes.length ? ['Other routes', lines(item.routes)] : null,
          item.prefixes.length ? ['IPv6 prefixes', lines(item.prefixes)] : null,
        ]),
        item.editable === false && item.section ? h('p', { className: 'muted small' }, 'This page does not edit the protocol of this interface; its options are in /etc/config/network.') : null),
      footer: item.proto === 'wireguard' ? [pageLink('#wireguard', 'WireGuard page')] : item.proto === 'xfrm' ? [pageLink('#ipsec', 'IPsec page')] : [],
    };
  }
  // A device: its type and relations, and for a bridge the live bridge information.
  const live = item.type === 'bridge' ? bridgeLive(data.net, data.mesh, item.name) : null;
  return {
    title: item.name || 'Device', subtitle: item.type === 'bridge' ? 'Bridge device' : item.type === 'vlan' ? 'VLAN device' : 'Network device',
    body: h('div', { className: 'nb-panel' },
      kv([
        ['State', item.up === true ? badge('up', 'success') : item.up === false ? badge('down', 'danger') : muted('not present')],
        item.type === 'vlan' ? ['VLAN', `${item.vid || '?'} on ${item.parent || '?'}`] : null,
        item.type === 'bridge' ? ['Ports', item.members.length ? item.members.join(', ') : 'none'] : null,
        item.type === 'unknown' ? ['Note', 'The router has no description of this device: an interface names it, but it is no port, bridge or VLAN device the router reports.'] : null,
      ]),
      live),
    footer: [],
  };
}
