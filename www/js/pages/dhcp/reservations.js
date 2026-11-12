// The reservations card of the DHCP page: an editable table with one row per `host` section of /etc/config/dhcp.
// A reservation gives a client a fixed IPv4 address (by MAC address) and/or IPv6 host ID (by DUID), and a name.
// Editing happens in the draft (see model.js); nothing is written until the review banner's Save.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { fmtSpan } from '../../core/format.js';
import { badge, button, card, mono, muted } from '../../core/ui.js';
import { legend } from '../../core/forms.js';
import { HOST_FIELDS } from './schema.js';
import { hostNorm, macOf, newHost } from './model.js';

// The key of the row whose name input is focused after the next redraw (set when a row was just added).
let focusKey = null;

// The active DHCPv4 lease of a reservation (matched by MAC, or by address), or null.
function leaseOf(data, row) {
  const norm = hostNorm(row.values);
  const macs = norm.mac.split(' ').filter(Boolean);
  return data.leases4.find(l => macs.includes(l.mac) || (norm.ip && l.address === norm.ip)) ?? null;
}

// One row of the table: an input per option, the lease it holds right now, and Remove (or Undo for a row that is
// marked for removal).
function reservationRow(ctx, row) {
  const disabled = !ctx.canEdit || row.removed;
  const cells = HOST_FIELDS.map(f => {
    const input = h('input', { className: 'form-control form-control-sm mono', placeholder: f.placeholder ?? '', value: row.values[f.key], disabled,
      spellcheck: false, autocomplete: 'off', title: f.label, oninput: e => { row.values[f.key] = e.target.value; ctx.touched(); } });
    ctx.inputs[`host:${row.key}:${f.key}`] = input;
    return h('td', {}, input);
  });
  const lease = row.section == null ? null : leaseOf(ctx.data, row);
  const state = row.removed ? badge('to be removed', 'danger')
    : row.section == null ? badge('new', 'info', 'not saved yet')
    : lease ? h('span', { title: `${lease.iface}, expires in ${lease.valid == null ? 'an unknown time' : fmtSpan(Math.max(0, lease.valid))}` }, badge('leased', 'success'), ' ', mono(lease.address))
    : muted('no lease now');
  const action = row.removed
    ? button('Undo', 'arrow-clockwise', () => { row.removed = false; ctx.redraw(); })
    : h('button', { type: 'button', className: 'btn btn-sm btn-fl', title: 'Remove this reservation', disabled: !ctx.canEdit, onclick: () => {
      if (row.section == null) ctx.draft.hosts.splice(ctx.draft.hosts.indexOf(row), 1);
      else row.removed = true;
      ctx.redraw();
    } }, icon('x-lg'));
  return h('tr', { id: `dhcp-host-${row.key}`, className: row.removed ? 'dhcp-removed' : row.section == null ? 'dhcp-new' : '' }, ...cells, h('td', {}, state), h('td', {}, action));
}

// The whole card.
export function reservationsCard(ctx) {
  const rows = ctx.draft.hosts.map(row => reservationRow(ctx, row));
  const add = button('Add reservation', 'plus-lg', () => { focusKey = newHost(ctx.draft).key; ctx.redraw(); });
  add.disabled = !ctx.canEdit;
  if (focusKey) {
    const key = focusKey;
    focusKey = null;
    requestAnimationFrame(() => ctx.inputs[`host:${key}:name`]?.focus());
  }
  const count = ctx.draft.hosts.filter(r => !r.removed).length;
  return card(
    [icon('person'), h('span', {}, 'Reservations'), h('span', { className: 'sub' }, `${count} static lease${count === 1 ? '' : 's'}`)],
    h('div', {},
      legend([
        'A reservation gives a client a fixed IPv4 address (matched by its MAC address) and/or a fixed IPv6 host ID (matched by its DUID), and a name. One with only a name and a MAC keeps the address dynamic. Several MAC addresses or DUIDs go in the same box, separated by spaces. The address "ignore" makes odhcpd ignore that client; "pool default" is the lease time of the interface.',
        'Dynamic leases above have a Reserve button that adds the client here. Changes are applied with the review banner at the top.']),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-sm align-middle dhcp-hosts' },
        h('thead', {}, h('tr', {}, ...HOST_FIELDS.map(f => h('th', { title: f.hint }, f.label)), h('th', {}, 'Lease now'), h('th', {}))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: HOST_FIELDS.length + 2, className: 'muted' }, 'No reservations.'))))),
      h('div', { className: 'card-body' }, add)));
}

// A new reservation prefilled from a dynamic lease (name, address and MAC), added to the draft.
export function reserveFrom(draft, lease) {
  const row = newHost(draft);
  row.values.name = lease.hostname;
  row.values.ip = lease.address;
  row.values.mac = macOf(lease.mac).toUpperCase();
  return row;
}
