// The Static routes tab of the Routing page: the `route` and `route6` sections of /etc/config/network as two editable tables (IPv4 and
// IPv6), with what the kernel holds of each. What a route may hold, the validation, the review list, the UCI operations and the check
// after a save are in static-model.js; the draft, the review banner and saving are shared with the other editing pages
// (core/editpage.js).
//
// It reads the sections by type (core/uci.js getByType): the network config also holds the keys and passwords of the interfaces, so
// the page never asks for the whole config. It writes through core/uci.js applyChange(): stage, apply with the rollback countdown, read
// the sections back, confirm. A router that does not keep the change goes back to its previous routes by itself. The page redraws on
// every poll, so polling is suspended while there is something to lose: unsaved edits, a focused control or a save in progress (the
// Routing page's isPaused asks `staticEditor.paused`). A change to a default route is confirmed first.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { optional, ubus } from '../../core/ubus.js';
import { badge, button, card, tile, tiles } from '../../core/ui.js';
import { legend, note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { openDialog } from '../../core/modal.js';
import { APPLY_TIMEOUT_S, uci } from '../../core/uci.js';
import { CONFIG, FAMILIES, FIELDS, ROUTE_TYPES, changesOf, checkApplied, counts, draftFrom, interfaceChoices, isDirty, kernelState, newRow, plan, problems, readStatic, risksOf } from './static-model.js';

// Asks before a change to a default route: lists what it does to the router's way out and resolves to whether the admin wants to go on.
// A change that touches no default route is saved without a question.
function confirmSave(base, draft) {
  const risks = risksOf(base, draft);
  if (!risks.length) return Promise.resolve(true);
  return new Promise(resolve => {
    let go = false;
    const apply = button('Apply the change', 'check2', () => { go = true; dialog.close(); }, 'btn-brand');
    const cancel = button('Cancel', 'x-lg', () => dialog.close());
    const dialog = openDialog({
      title: 'This change affects the default route',
      subtitle: `${risks.length} change${risks.length === 1 ? '' : 's'}`,
      staticBackdrop: true,
      body: h('div', {},
        h('ul', {}, risks.map(r => h('li', {}, r))),
        h('p', { className: 'muted small' }, `The router applies the change and this page then checks that the routes were kept. If they were not, or if you close the page, the router restores the previous configuration by itself after ${APPLY_TIMEOUT_S} seconds. The page itself stays reachable through your LAN, but anything that goes through the default route (the internet) is affected until the change is undone.`)),
      footer: [cancel, apply],
      onClose: () => resolve(go),
    });
  });
}

// Reads the route and route6 sections by type. Used for the check after a save, so a failed read is an error, not a missing config.
async function readSections() {
  const [cfg4, cfg6] = await Promise.all([uci.getByType(CONFIG, 'route'), uci.getByType(CONFIG, 'route6')]);
  return readStatic(cfg4, cfg6);
}

// The editor: the draft, the review banner, saving and discarding (core/editpage.js).
export const staticEditor = createEditor({
  config: CONFIG,
  readAfter: readSections,
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => checkApplied(after, draft),
  confirmSave,
});
const editor = staticEditor;

//#region Loading

// Reads what the tab shows: the two kinds of route section (null where the login may not read them), the kernel's routes and the
// interface list (both optional: without them the page still edits, but cannot say what is installed or check a gateway), and how
// many changes are already staged in this session.
export async function loadStatic() {
  const [cfg4, cfg6, status, dump] = await Promise.all([
    optional(uci.getByType(CONFIG, 'route')),
    optional(uci.getByType(CONFIG, 'route6')),
    optional(ubus('flab.routing', 'status')),
    optional(ubus('network.interface', 'dump')),
  ]);
  return editor.withStaged({ ...readStatic(cfg4, cfg6, { status, dump }), tab: 'static' });
}

//#endregion

//#region The tables

// The key of the row whose target input is focused after the next redraw (set when a row was just added).
let focusKey = null;

// A text input of a route cell, bound to the row's value; `width` is a CSS class that sizes the column.
function textCell(ctx, row, f, width) {
  const input = h('input', {
    className: `form-control form-control-sm mono ${width}`, placeholder: f.placeholder ?? '', value: row.values[f.key], spellcheck: false, autocomplete: 'off',
    disabled: !ctx.canEdit || row.removed, title: f.label, oninput: e => { row.values[f.key] = e.target.value; ctx.touched(); },
  });
  ctx.inputs[`route:${row.key}:${f.key}`] = input;
  return input;
}

// A drop-down of a route cell, bound to the row's value. `options` are [value, label]; a value that is not among them is kept as one.
function selectCell(ctx, row, f, options, width) {
  const known = options.some(([v]) => v === row.values[f.key]);
  const all = known ? options : [...options, [row.values[f.key], row.values[f.key]]];
  const select = h('select', {
    className: `form-select form-select-sm ${width}`, disabled: !ctx.canEdit || row.removed, title: f.label,
    onchange: e => { row.values[f.key] = e.target.value; ctx.touched(); },
  }, all.map(([v, label]) => h('option', { value: v }, label)));
  select.value = row.values[f.key];
  ctx.inputs[`route:${row.key}:${f.key}`] = select;
  return select;
}

// A checkbox of a route cell, bound to the row's boolean value.
function checkCell(ctx, row, f) {
  const box = h('input', {
    type: 'checkbox', className: 'form-check-input', checked: row.values[f.key], disabled: !ctx.canEdit || row.removed, title: f.hint,
    onchange: e => { row.values[f.key] = e.target.checked; ctx.touched(); },
  });
  ctx.inputs[`route:${row.key}:${f.key}`] = box;
  return box;
}

// What the state column says about a route: what the page knows of it, in one badge.
function stateBadge(ctx, row) {
  if (row.removed) return badge('to be removed', 'danger');
  if (row.section == null) return badge('new', 'info', 'not saved yet');
  if (changesOf(ctx.base, { rows: [row], next: 0 }).length > 0) return badge('edited', 'info', 'not saved yet');
  const k = kernelState(row, ctx.data);
  if (k === 'active') return badge('installed', 'success', 'the kernel holds this route');
  if (k === 'missing') return badge('not installed', 'warning', 'the kernel does not hold this route: its interface may be down or its gateway unreachable');
  if (k === 'disabled') return badge('disabled', '', 'switched off in the config');
  return null;
}

// One row of a table: a cell per option, the state, and Remove (or Undo for a row that is marked for removal).
function routeRow(ctx, row, choices) {
  const widths = { target: 'rt-s-target', gateway: 'rt-s-gw', metric: 'rt-s-num', table: 'rt-s-tab', mtu: 'rt-s-num', source: 'rt-s-src' };
  const cells = FIELDS.map(f => {
    let control;
    if (f.key === 'interface') control = selectCell(ctx, row, f, [['', 'choose…'], ...choices.map(n => [n, n])], 'rt-s-if');
    else if (f.key === 'type') control = selectCell(ctx, row, f, ROUTE_TYPES, 'rt-s-type');
    else if (f.bool) control = checkCell(ctx, row, f);
    else control = textCell(ctx, row, f, widths[f.key]);
    return h('td', { className: f.bool ? 'rt-s-check' : '' }, control);
  });
  const action = row.removed
    ? button('Undo', 'arrow-clockwise', () => { row.removed = false; ctx.redraw(); })
    : h('button', { type: 'button', className: 'btn btn-sm btn-fl', title: 'Remove this route', disabled: !ctx.canEdit, onclick: () => {
      if (row.section == null) ctx.draft.rows.splice(ctx.draft.rows.indexOf(row), 1);
      else row.removed = true;
      ctx.redraw();
    } }, icon('x-lg'));
  return h('tr', { id: `rt-static-${row.key}`, className: row.removed ? 'rt-s-removed' : row.section == null ? 'rt-s-new' : '' }, ...cells, h('td', {}, stateBadge(ctx, row)), h('td', {}, action));
}

// The card of one address family: its routes, and a button that adds one.
function familyCard(ctx, fam, choices) {
  const rows = ctx.draft.rows.filter(r => r.family === fam.family);
  const add = button(`Add ${fam.label} route`, 'plus-lg', () => { focusKey = newRow(ctx.draft, fam.family).key; ctx.redraw(); });
  add.disabled = !ctx.canEdit;
  if (focusKey && rows.some(r => r.key === focusKey)) {
    const key = focusKey;
    focusKey = null;
    requestAnimationFrame(() => ctx.inputs[`route:${key}:target`]?.focus());
  }
  const count = rows.filter(r => !r.removed).length;
  return card(
    [icon('signpost-split'), h('span', {}, `${fam.label} static routes`), h('span', { className: 'sub' }, `${count} route${count === 1 ? '' : 's'}`)],
    h('div', {},
      h('div', { className: 'grid-wrap' }, h('table', { className: 'table table-sm align-middle rt-static-table' },
        h('thead', {}, h('tr', {}, ...FIELDS.map(f => h('th', { title: f.hint }, f.label)), h('th', {}, 'State'), h('th', {}))),
        h('tbody', {}, rows.length ? rows.map(r => routeRow(ctx, r, choices)) : h('tr', {}, h('td', { colSpan: FIELDS.length + 2, className: 'muted' }, `No ${fam.label} static routes.`))))),
      h('div', { className: 'card-body' }, add)));
}

//#endregion

// The summary tiles: how many routes are configured and what the kernel makes of them.
function summary(data) {
  const c = counts(draftFrom(data), data);
  const v4 = data.routes.filter(r => r.family === 4).length;
  return tiles(
    tile('Static routes', String(c.total), `${v4} IPv4 · ${c.total - v4} IPv6`),
    tile('Installed', data.kernel ? String(c.active) : '–', data.kernel ? 'held by the kernel now' : 'the kernel state is not available'),
    tile('Not installed', data.kernel ? String(c.missing) : '–', c.missing ? 'configured, but not in the kernel' : 'every enabled route is installed', c.missing ? 'text-warning' : ''),
    tile('Disabled', String(c.disabled), 'switched off in the config'));
}

// The nodes of the Static routes tab for one poll. `data` is what loadStatic returned.
export function staticView(data, rerender) {
  if (!data.available) {
    return [note('bad', 'The routes in /etc/config/network cannot be read: this login may not read the network configuration, or the router did not answer.')];
  }
  const canEdit = editor.begin(data, rerender);
  const ctx = { data, base: editor.state.base, draft: editor.state.draft, canEdit, inputs: {}, sync: () => {}, touched: () => {}, redraw: () => editor.redraw() };
  ctx.touched = editor.touched(ctx);
  // Called after every edit: marks the controls that hold an error and refreshes the banner (the form itself is not redrawn, so the
  // focus stays where it is).
  ctx.sync = () => editor.markErrors(ctx.inputs, canEdit);
  const choices = interfaceChoices(ctx.base, ctx.draft);
  // The wrapper is what the page's isPaused looks in for a focused control.
  const form = h('div', { className: 'rt-static' },
    legend([
      'Static routes are the route and route6 sections of /etc/config/network. netifd installs a route while its interface is up. Routes learned by a routing daemon (BGP, OSPF), by DHCP or by the kernel itself show on the Routes tab and are not edited here. Changes are applied with the review banner at the top.',
      'A target without a prefix length is one host. Leave the gateway empty for a network that is directly connected to the interface. A route in another table is only used where a policy rule sends traffic to that table; "From" limits the route to packets from one source.']),
    ...FAMILIES.map(fam => familyCard(ctx, fam, choices)));
  ctx.sync();
  return [summary(data), ...editor.notes(data).filter(Boolean), form];
}
