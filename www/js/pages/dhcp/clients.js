// The clients card of the DHCP page: the static leases (the `host` sections of /etc/config/dhcp) and the leases handed out right
// now, as one list with one row per client (model.js clientList). A row shows the client's name and identity, its DHCPv4 address
// and its DHCPv6 addresses and delegated prefixes, whether it is static or dynamic, and when its lease expires. A static lease has an
// editor that opens under its row, with every option of the host section; a dynamic client has a Make static button that creates
// the static lease from what is known of it. Editing happens in the draft (see model.js); nothing is written until the review
// banner's Save.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { fmtSpan } from '../../core/format.js';
import { badge, button, card, mono, muted } from '../../core/ui.js';
import { openTool, toolboxAvailable } from '../index.js';
import { HOST_FIELDS } from './schema.js';
import { clientList, hostNorm, newHost, problems, staticFrom } from './model.js';
import { inputBox, rowClass } from './rows.js';

// The keys of the static leases whose editor is open, kept across redraws; the editor of a new static lease, and of one that has an
// error, is always open.
const editing = new Set();

// The key of the static lease whose name box is focused after the next redraw (set when a lease was just added).
let focusKey = null;

// What the type filter offers, as [value, label] pairs.
export const CLIENT_TYPES = [['all', 'All clients'], ['static', 'Static leases'], ['dynamic', 'Dynamic leases'], ['idle', 'Static, no lease now']];

// Whether a client passes the filter ({ q, iface, type }): the interface and the type must match, and every word of the text
// must appear somewhere in the client's texts.
export function passes(filter, client, texts) {
  const held = client.v4.length + client.v6.length > 0;
  if (filter.iface !== 'all' && filter.iface !== client.iface) return false;
  if (filter.type === 'static' && !client.row) return false;
  if (filter.type === 'dynamic' && client.row) return false;
  if (filter.type === 'idle' && !(client.row && !held)) return false;
  const hay = texts.join(' ').toLowerCase();
  return filter.q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

// How long a lease or lifetime still lasts.
const expires = seconds => (seconds == null ? muted('–') : fmtSpan(Math.max(0, seconds)));

// How many ordinary /64 LAN prefixes fit in a delegated prefix. Very large legacy allocations are left unlabelled.
const prefixSize = length => Number.isInteger(length) && length >= 48 && length <= 64
  ? `${2 ** (64 - length)} × /64`
  : '';

// The preferred and valid lifetimes of an address or prefix, as a readable line.
const lifetimes = x => `preferred ${x.preferred == null ? '–' : fmtSpan(Math.max(0, x.preferred))}, valid ${x.valid == null ? '–' : fmtSpan(Math.max(0, x.valid))}`;

// The words a client can be found by in the search box.
function searchText(c) {
  const v6 = c.v6.flatMap(l => [...l.addresses.map(a => a.address), ...l.prefixes.map(p => `${p.address}/${p.length}`)]);
  return [c.name, c.iface, c.ip, ...c.macs, ...c.duids, ...c.v4.map(l => l.address), ...v6, c.row ? 'static' : 'dynamic',
    c.v6.some(l => l.addresses.length) ? 'IA_NA' : '', c.v6.some(l => l.prefixes.length) ? 'IA_PD' : ''];
}

// The first cell: the name and, under it, the MAC address (or the DUID of a client known only by DHCPv6).
function identity(c) {
  const id = c.macs.length ? c.macs.join(' ') : c.duids[0] ?? '';
  return h('div', { className: 'dhcp-client' },
    h('span', { className: 'dhcp-client-name' }, c.name || muted('unnamed')),
    id ? h('span', { className: 'mono dhcp-client-id', title: c.macs.length ? 'MAC address' : 'DHCPv6 client identifier (DUID)' }, id) : null);
}

// The DHCPv4 cell: the addresses the client holds, or the address its static lease gives it.
function addressV4(c) {
  if (c.v4.length) return h('div', { className: 'dhcp-addrs' }, c.v4.map(l => h('div', { title: l.iface }, mono(l.address))));
  if (c.ip === 'ignore') return badge('ignored', 'warning', 'odhcpd ignores DHCPv4 requests from this client');
  if (c.ip) return h('div', { title: 'The address this static lease gives the client' }, mono(c.ip));
  return muted('–');
}

// The DHCPv6 cell: addresses (IA_NA) and delegated prefixes (IA_PD) with their size, or the host ID a static lease gives.
function addressV6(c) {
  const rows = c.v6.flatMap(l => [
    ...l.addresses.map(a => h('div', { title: lifetimes(a) }, mono(a.address))),
    ...l.prefixes.map(p => h('div', { className: 'dhcp-prefix', title: lifetimes(p) },
      mono(`${p.address}/${p.length}`), prefixSize(p.length) ? h('span', { className: 'dhcp-prefix-size' }, prefixSize(p.length)) : null)),
  ]);
  if (rows.length) return h('div', { className: 'dhcp-addrs' }, rows);
  const hostid = c.row ? hostNorm(c.row.values).hostid : '';
  if (hostid === 'ignore') return badge('ignored', 'warning', 'odhcpd ignores DHCPv6 requests from this client');
  return hostid ? h('div', { title: 'The interface identifier this static lease gives the client' }, mono(`::${hostid}`)) : muted('–');
}

// The state cell: static or dynamic, what the client holds from DHCPv6, and what is pending in the draft.
function states(c) {
  const row = c.row;
  const held = c.v4.length + c.v6.length > 0;
  return h('span', { className: 'dhcp-badges' },
    row ? badge([icon('pin-angle-fill', 11), 'static'], 'success', 'a static lease in the configuration') : badge('dynamic', 'info', 'handed out from a pool'),
    row && !held && !row.removed && row.section != null ? badge('no lease now', '', 'the client does not hold a lease at the moment') : null,
    c.v6.some(l => l.addresses.length) ? badge('IA_NA', 'info', 'the client has an IPv6 address association') : null,
    c.v6.some(l => l.prefixes.length) ? badge('IA_PD', 'info', 'the client requested and received delegated IPv6 prefixes') : null,
    c.v4.some(l => l.flags.includes('broken-hostname')) || c.v6.some(l => l.flags.includes('broken-hostname')) ? badge('bad hostname', 'warning', 'the client sent a hostname that odhcpd could not use') : null,
    row?.section == null && row ? badge('new', 'info', 'not saved yet') : null,
    row?.removed ? badge('to be removed', 'danger') : null);
}

// The Toolbox buttons of a client (the Toolbox is an optional package): Ping when it holds an IPv4 address, and Wake for a saved
// static lease with a MAC address that holds no lease now.
function toolButtons(c) {
  if (!toolboxAvailable()) return [];
  const address = c.v4[0]?.address;
  const mac = c.row && c.row.section != null && !c.row.removed && !c.v4.length && !c.v6.length ? c.macs[0] : null;
  return [
    address ? button('', 'activity', () => openTool('ping', address), 'btn-outline-secondary', { title: `Ping ${address} in the Toolbox`, ariaLabel: `Ping ${address}` }) : null,
    mac ? button('', 'lightning-charge-fill', () => openTool('wol', mac), 'btn-outline-secondary', { title: 'Send a Wake-on-LAN packet to this client in the Toolbox', ariaLabel: 'Wake this client' }) : null,
  ];
}

// The buttons of a row: the Toolbox ones, then edit and remove (or undo) for a static lease, Make static for a dynamic client.
function actions(ctx, c, open, make) {
  const row = c.row;
  const tools = toolButtons(c);
  if (!row) return h('span', { className: 'dhcp-badges dhcp-actions' }, ...tools, ctx.canEdit ? button('Make static', 'pin-angle-fill', () => make(c), 'btn-outline-secondary', { title: 'Keep this client\'s address and name with a static lease' }) : null);
  if (row.removed) return button('Undo', 'arrow-counterclockwise', () => { row.removed = false; ctx.redraw(); });
  const toggle = row.section == null ? null : button('', open ? 'chevron-up' : 'pencil', () => {
    if (editing.has(row.key)) editing.delete(row.key); else editing.add(row.key);
    ctx.redraw();
  }, 'btn-outline-secondary', { title: open ? 'Close the editor' : 'Edit this static lease', ariaLabel: open ? 'Close the editor' : 'Edit this static lease', ariaExpanded: String(open) });
  const remove = button('', 'x-lg', () => {
    if (row.section == null) ctx.draft.hosts.splice(ctx.draft.hosts.indexOf(row), 1);
    else row.removed = true;
    editing.delete(row.key);
    ctx.redraw();
  }, 'btn-outline-secondary', { title: 'Remove this static lease', ariaLabel: 'Remove this static lease', disabled: !ctx.canEdit });
  return h('span', { className: 'dhcp-badges dhcp-actions' }, ...tools, toggle, remove);
}

// The editor under a static lease: a labelled box for every option of the host section.
function editor(ctx, c, bad) {
  const row = c.row;
  const boxes = HOST_FIELDS.map(f => {
    const input = inputBox(ctx, f, 'host', row);
    input.id = `dhcp-host-${row.key}-${f.key}`;
    return h('div', { className: 'col-12 col-md-6 col-xl-4' },
      h('label', { className: 'form-label small mb-1', htmlFor: input.id }, f.label), input, h('div', { className: 'form-text' }, f.hint));
  });
  const done = row.section == null ? null : button('Done', 'check2', () => {
    // The editor stays open (and is remembered as open) while the lease holds an error, which the form may not show yet.
    if (!problems(ctx.data, ctx.draft).errors.some(e => e.key.startsWith(`host:${row.key}:`))) editing.delete(row.key);
    ctx.redraw();
  }, 'btn-primary', { disabled: bad });
  return h('tr', { className: `dhcp-edit-row ${rowClass(row)}`.trim() },
    h('td', { colSpan: 7 }, h('div', { className: 'dhcp-edit' },
      h('div', { className: 'row g-3' }, boxes),
      h('div', { className: 'dhcp-edit-foot' },
        h('span', { className: 'muted small' }, 'A name, and a MAC address or a DUID, identify the client; several of either go in the same box, separated by spaces. The IPv4 address "ignore" makes odhcpd ignore the client. With only a name and a MAC the address stays dynamic.'),
        done))));
}

// One client: a <tbody> holding its row and, when open, the editor.
function clientRow(ctx, c, bad, make) {
  const open = c.row != null && !c.row.removed && (c.row.section == null || editing.has(c.row.key) || bad);
  const expiry = expires(c.v4[0]?.valid ?? c.v6[0]?.valid ?? null);
  const attrs = c.row ? { id: `dhcp-host-${c.row.key}` } : {};
  return h('tbody', { className: 'dhcp-client-body', ...attrs },
    h('tr', { className: c.row ? rowClass(c.row) : '' },
      h('td', {}, identity(c)), h('td', {}, c.iface || muted('–')), h('td', {}, addressV4(c)), h('td', {}, addressV6(c)),
      h('td', {}, states(c)), h('td', {}, expiry), h('td', { className: 'text-end' }, actions(ctx, c, open, make))),
    open ? editor(ctx, c, bad) : null);
}

// The whole card. `filter` is { q, iface, type }, `controls` the search box and the two selects that edit it.
export function clientsCard(ctx, filter, { controls }) {
  const bad = new Set(problems(ctx.data, ctx.draft).errors.map(e => /^host:([^:]+):/.exec(e.key)?.[1]).filter(Boolean));
  const all = clientList(ctx.data, ctx.draft);
  const shown = all.filter(c => passes(filter, c, searchText(c)));
  const make = c => { const row = staticFrom(ctx.draft, c); focusKey = row.key; ctx.touched(); ctx.redraw(); };
  const add = button('Add static lease', 'plus-lg', () => { focusKey = newHost(ctx.draft).key; ctx.redraw(); }, 'btn-outline-secondary', { disabled: !ctx.canEdit });
  if (focusKey) {
    const key = focusKey;
    focusKey = null;
    requestAnimationFrame(() => ctx.inputs[`host:${key}:name`]?.focus());
  }
  const statics = all.filter(c => c.row && !c.row.removed).length;
  const body = shown.length
    ? shown.map(c => clientRow(ctx, c, c.row != null && bad.has(c.row.key), make))
    : [h('tbody', {}, h('tr', {}, h('td', { colSpan: 7, className: 'muted' }, all.length ? 'No client matches the filter.' : 'No clients and no static leases.')))];
  return card(
    [icon('laptop'), h('span', {}, 'DHCP clients'), h('span', { className: 'sub' }, `${shown.length} of ${all.length} · ${statics} static lease${statics === 1 ? '' : 's'}`)],
    h('div', {},
      h('div', { className: 'dhcp-lease-controls' }, controls.search, controls.iface.node, controls.type.node, h('span', { className: 'dhcp-grow' }), add),
      h('div', { className: 'table-responsive' }, h('table', { className: 'table align-middle dhcp-clients' },
        h('thead', {}, h('tr', {}, ['Client', 'Interface', 'IPv4', 'IPv6', 'State', 'Expires in', ''].map(t => h('th', {}, t)))),
        ...body)),
      h('p', { className: 'muted small dhcp-legend' },
        'Each client is one row: the DHCPv4 and DHCPv6 leases it holds now, joined to its static lease when it has one. Make static keeps a dynamic client\'s name and address; Edit opens every option of a static lease. Changes are applied with the review banner at the top.')),
    'dhcp-tbl');
}
