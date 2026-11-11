// The read-only tables of the DHCP page: the DHCPv4 and DHCPv6 leases odhcpd hands out right now, and the IPv6
// prefixes it announces. They share one filter (text and interface) that the command bar edits.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { fmtSpan } from '../../core/format.js';
import { badge, button, card, mono, muted, table } from '../../core/ui.js';
import { ipToInt } from './model.js';

// Whether a row passes the filter ({ q, iface }): the interface must match, and every word of the text must
// appear somewhere in the row's texts.
export function passes(filter, iface, texts) {
  if (filter.iface !== 'all' && filter.iface !== iface) return false;
  const hay = texts.join(' ').toLowerCase();
  return filter.q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

// The type of a lease: reserved (a static lease from a reservation) or dynamic, plus a warning for a client whose
// hostname odhcpd could not use.
function typeBadges(lease) {
  return h('span', { className: 'dhcp-badges' },
    badge(lease.static ? 'reserved' : 'dynamic', lease.static ? 'success' : 'info', lease.static ? 'from a reservation in the configuration' : 'handed out from the pool'),
    lease.flags.includes('broken-hostname') ? badge('bad hostname', 'warning', 'the client sent a hostname that odhcpd could not use') : null);
}

// How long a lease or lifetime still lasts.
const expires = seconds => (seconds == null ? muted('–') : fmtSpan(Math.max(0, seconds)));

// The DHCPv4 leases card. `reservedMacs` is the set of MACs that already have a reservation (in the draft), and
// `reserve(lease)` turns a dynamic lease into a new reservation; it is offered only when `canReserve`.
export function leases4Card(data, filter, { reservedMacs, canReserve, reserve }) {
  const rows = data.leases4
    .filter(l => passes(filter, l.iface, [l.iface, l.address, l.mac, l.hostname, l.static ? 'reserved' : 'dynamic']))
    .sort((a, b) => a.iface.localeCompare(b.iface) || (ipToInt(a.address) ?? 0) - (ipToInt(b.address) ?? 0));
  return card(
    [icon('list-ul'), h('span', {}, 'DHCPv4 leases'), h('span', { className: 'sub' }, `${rows.length} of ${data.leases4.length}`)],
    table(['Interface', 'Address', 'MAC address', 'Hostname', 'Type', 'Expires in', ''], rows.map(l => [
      l.iface, mono(l.address), mono(l.mac), l.hostname || muted('none'), typeBadges(l), expires(l.valid),
      !l.static && canReserve && !reservedMacs.has(l.mac) ? button('Reserve', 'plus-lg', () => reserve(l)) : '',
    ])), 'dhcp-tbl');
}

// The DHCPv6 leases card: one row per client (DUID) with its addresses and delegated prefixes.
export function leases6Card(data, filter) {
  const rows = data.leases6
    .filter(l => passes(filter, l.iface, [l.iface, l.duid, l.hostname, ...l.addresses.map(a => a.address), ...l.prefixes.map(p => `${p.address}/${p.length}`), l.static ? 'reserved' : 'dynamic']))
    .sort((a, b) => a.iface.localeCompare(b.iface) || a.hostname.localeCompare(b.hostname));
  const lifetimes = x => `preferred ${x.preferred == null ? '–' : fmtSpan(Math.max(0, x.preferred))}, valid ${x.valid == null ? '–' : fmtSpan(Math.max(0, x.valid))}`;
  return card(
    [icon('list-ul'), h('span', {}, 'DHCPv6 leases'), h('span', { className: 'sub' }, `${rows.length} of ${data.leases6.length}`)],
    table(['Interface', 'Hostname', 'DUID', 'Addresses', 'Delegated prefixes', 'Type', 'Expires in'], rows.map(l => [
      l.iface, l.hostname || muted('none'), h('span', { className: 'mono dhcp-duid', title: l.duid }, l.duid),
      h('div', { className: 'dhcp-addrs' }, l.addresses.length ? l.addresses.map(a => h('div', { title: lifetimes(a) }, mono(a.address))) : muted('none')),
      h('div', { className: 'dhcp-addrs' }, l.prefixes.length ? l.prefixes.map(p => h('div', { title: lifetimes(p) }, mono(`${p.address}/${p.length}`))) : muted('none')),
      typeBadges(l), expires(l.valid),
    ])), 'dhcp-tbl');
}

// The IPv6 prefixes announced on each interface (from the router advertisements), with a warning for stale ones.
export function announcedCard(data, filter) {
  const rows = data.ra
    .flatMap(a => a.prefixes.map(p => ({ iface: a.iface, device: a.device, ...p })))
    .filter(p => passes(filter, p.iface, [p.iface, p.device, p.prefix]))
    .sort((a, b) => a.iface.localeCompare(b.iface) || a.prefix.localeCompare(b.prefix));
  return card(
    [icon('megaphone'), h('span', {}, 'Announced IPv6 prefixes'), h('span', { className: 'sub' }, 'what the router advertisements tell clients')],
    table(['Interface', 'Device', 'Prefix', 'State'], rows.map(p => [
      p.iface, mono(p.device), mono(`${p.prefix}/${p.length}`),
      p.stale ? badge('stale', 'warning', 'the prefix is no longer valid upstream and is being phased out') : badge('current', 'success'),
    ])), 'dhcp-tbl');
}
