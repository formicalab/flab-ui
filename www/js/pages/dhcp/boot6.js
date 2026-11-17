// The network boot card of the DHCPv6 side of the DHCP page: an editable table with one row per `boot6` section of
// /etc/config/dhcp. odhcpd gives a DHCPv6 client that asks for a boot file (IPv6 PXE) the address of one, by the
// client's architecture code. Editing happens in the draft (see model.js); nothing is written until the review
// banner's Save.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, muted } from '../../core/ui.js';
import { legend } from '../../core/forms.js';
import { BOOT6_FIELDS } from './schema.js';
import { newBoot } from './model.js';
import { inputCells, rowAction, rowClass } from './rows.js';

// The key of the row whose address input is focused after the next redraw (set when a row was just added).
let focusKey = null;

// One row of the table: an input per option, and Remove (or Undo for a row that is marked for removal).
function bootRow(ctx, row) {
  const state = row.removed ? badge('to be removed', 'danger') : row.section == null ? badge('new', 'info', 'not saved yet') : muted('saved');
  return h('tr', { id: `dhcp-boot-${row.key}`, className: rowClass(row) },
    ...inputCells(ctx, BOOT6_FIELDS, 'boot6', row), h('td', {}, state), h('td', {}, rowAction(ctx, row, ctx.draft.boot6, 'Remove this entry')));
}

// The whole card.
export function bootCard(ctx) {
  const rows = ctx.draft.boot6.map(row => bootRow(ctx, row));
  const add = button('Add entry', 'plus-lg', () => { focusKey = newBoot(ctx.draft).key; ctx.redraw(); }, 'btn-fl', { disabled: !ctx.canEdit });
  if (focusKey) {
    const key = focusKey;
    focusKey = null;
    requestAnimationFrame(() => ctx.inputs[`boot6:${key}:url`]?.focus());
  }
  const count = ctx.draft.boot6.filter(r => !r.removed).length;
  return card(
    [icon('download'), h('span', {}, 'Network boot (PXE)'), h('span', { className: 'sub' }, `${count} boot file${count === 1 ? '' : 's'} for DHCPv6 clients`)],
    h('div', {},
      legend([
        'The boot file address odhcpd hands to DHCPv6 clients that ask for one (IPv6 PXE), for example tftp://[fd11::1]/pxe.efi. The architecture code is the one the client reports: 7 is EFI x64, 11 is EFI Arm 64. An entry without a code is used for every client that has no entry of its own.']),
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-sm align-middle dhcp-boot' },
        h('thead', {}, h('tr', {}, ...BOOT6_FIELDS.map(f => h('th', { title: f.hint }, f.label)), h('th', {}, 'State'), h('th', {}))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colSpan: BOOT6_FIELDS.length + 2, className: 'muted' }, 'No network boot entries.'))))),
      h('div', { className: 'card-body' }, add)));
}
