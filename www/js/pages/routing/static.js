// Static routes on the Routing page: the `route` and `route6` sections of /etc/config/network as two editable tables (IPv4 and
// IPv6), with what the kernel holds of each. What a route may hold, the validation, the review list, the UCI operations and the check
// after a save are in static-model.js; the draft, the review banner and saving are shared with the other editing pages
// (core/editpage.js).
//
// It reads the sections by type (core/uci.js getByType): the network config also holds the keys and passwords of the interfaces, so
// the page never asks for the whole config. It writes through core/uci.js applyChange(): stage, apply with the rollback countdown, read
// the sections back, verify installation on running interfaces, confirm. This does not prove end-to-end connectivity. The page redraws on
// every poll, so polling is suspended while there is something to lose: unsaved edits, a focused control or a save in progress (the
// Routing page's isPaused asks `staticEditor.paused`). A change to a default route is confirmed first.
import { h, sleep } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { AuthError, optional, ubus } from '../../core/ubus.js';
import { badge, button, card, mono, tile } from '../../core/ui.js';
import { legend, note } from '../../core/forms.js';
import { createEditor } from '../../core/editpage.js';
import { openDialog } from '../../core/modal.js';
import { APPLY_TIMEOUT_S, uci } from '../../core/uci.js';
import { tag } from './tables.js';
import { CONFIG, FAMILIES, FIELDS, ROUTE_TYPES, changesOf, checkApplied, checkInstalled, counts, draftFrom, interfaceChoices, isDirty, kernelState, newRow, plan, problems, reachedBy, readStatic, risksOf } from './static-model.js';

// Asks before a change to a default route: lists what it does to the router's way out and resolves to whether the admin wants to go on.
// A change that touches no default route is saved without a question.
function confirmSave(base, draft) {
  const risks = risksOf(base, draft);
  if (!risks.length) return Promise.resolve(true);
  return new Promise(resolve => {
    let go = false;
    const apply = button('Apply the change', 'check2', () => { go = true; dialog.close(); }, 'btn-primary');
    const cancel = button('Cancel', 'x-lg', () => dialog.close());
    const dialog = openDialog({
      title: 'This change affects the default route',
      subtitle: `${risks.length} change${risks.length === 1 ? '' : 's'}`,
      staticBackdrop: true,
      body: h('div', {},
        h('ul', {}, risks.map(r => h('li', {}, r))),
        h('p', { className: 'muted small' }, `This page checks the saved configuration and installation of changed, enabled routes on running interfaces, not that the gateway or internet works. Unless the page confirms the apply, rpcd is set to restore the previous configuration after ${APPLY_TIMEOUT_S} seconds. A default-route change can also interrupt a routed management connection. Keep a second way to reach the router.`)),
      footer: [cancel, apply],
      onClose: () => resolve(go),
    });
  });
}

// Reads the route and route6 sections by type. Used for the check after a save, so a failed read is an error, not a missing config.
async function readSections() {
  for (let attempt = 0; ; attempt++) {
    try {
      const [cfg4, cfg6, status, dump] = await Promise.all([
        uci.getByType(CONFIG, 'route'), uci.getByType(CONFIG, 'route6'),
        ubus('flab.routing', 'status'), ubus('network.interface', 'dump'),
      ]);
      const data = readStatic(cfg4, cfg6, { status, dump });
      checkApplied(data, staticEditor.state.draft);
      checkInstalled(staticEditor.state.base, staticEditor.state.draft, data);
      return data;
    } catch (e) {
      if (e instanceof AuthError || attempt === 5) throw e;
      await sleep(750);
    }
  }
}

// The editor: the draft, the review banner, saving and discarding (core/editpage.js).
export const staticEditor = createEditor({
  config: CONFIG,
  readAfter: readSections,
  model: { draftFrom, changesOf, isDirty, problems, plan },
  verify: (base, draft, after) => { checkApplied(after, draft); checkInstalled(base, draft, after); },
  confirmSave,
});
const editor = staticEditor;

//#region Loading

// Reads what the tab shows: the two kinds of route section (null where the login may not read them), the kernel's routes and the
// interface list (both optional: without them the page still edits, but cannot say what is installed or check a gateway), and how
// many changes are already staged in this session.
export async function loadStatic(live) {
  const [cfg4, cfg6, status, dump] = await Promise.all([
    optional(uci.getByType(CONFIG, 'route')),
    optional(uci.getByType(CONFIG, 'route6')),
    live ? live.status : optional(ubus('flab.routing', 'status')),
    live ? live.dump : optional(ubus('network.interface', 'dump')),
  ]);
  return editor.withStaged(readStatic(cfg4, cfg6, { status, dump }));
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

// What the "Consulted by" column says about a route: the table it lands in and the policy rules that send lookups there. A table no
// rule consults is never used, which is called out because it is the usual reason for a route that is installed but does nothing.
function reachCell(ctx, row) {
  if (row.removed) return [];
  const { table, rules } = reachedBy(row, ctx.data);
  if (!rules) return [mono(table)];
  if (!rules.length) return [mono(table), ' ', badge('no rule', 'warning', 'No policy rule looks up this table, so the route is never used')];
  return [mono(table), ' ', ...rules.map(p => tag(`rule ${p}`, 'A policy rule that consults this table'))];
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
    ? button('Undo', 'arrow-counterclockwise', () => { row.removed = false; ctx.redraw(); })
    : button('', 'x-lg', () => {
      if (row.section == null) ctx.draft.rows.splice(ctx.draft.rows.indexOf(row), 1);
      else row.removed = true;
      ctx.redraw();
    }, 'btn-outline-secondary', { title: 'Remove this route', ariaLabel: 'Remove this route', disabled: !ctx.canEdit });
  const state = h('td', {}, stateBadge(ctx, row));
  ctx.states.set(row, state);
  const reach = h('td', { className: 'rt-s-reach' }, ...reachCell(ctx, row));
  ctx.reach.set(row, reach);
  return h('tr', { id: `rt-static-${row.key}`, className: row.removed ? 'rt-s-removed' : row.section == null ? 'rt-s-new' : '' }, ...cells, reach, state, h('td', {}, action));
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
      h('div', { className: 'table-responsive' }, h('table', { className: 'table table-sm align-middle rt-static-table' },
        h('thead', {}, h('tr', {}, ...FIELDS.map(f => h('th', { title: f.hint }, f.label)), h('th', { title: 'The table the route lands in, and the policy rules that look it up' }, 'Consulted by'), h('th', {}, 'State'), h('th', {}))),
        h('tbody', {}, rows.length ? rows.map(r => routeRow(ctx, r, choices)) : h('tr', {}, h('td', { colSpan: FIELDS.length + 3, className: 'muted' }, `No ${fam.label} static routes.`))))),
      h('div', { className: 'card-body' }, add)));
}

//#endregion

// The summary tile: how many routes are configured, and in its sub line how many of them the kernel holds, does not hold or
// has switched off. It joins the other tiles at the top of the Routes view; nothing is returned when the config cannot be read
// (the editor shows a message instead). An array is returned so the caller can spread it among the other tiles.
export function staticTiles(data) {
  if (!data.available) return [];
  const c = counts(draftFrom(data), data);
  const sub = data.kernel ? `${c.active} installed · ${c.missing} not installed · ${c.disabled} disabled` : `kernel state not available · ${c.disabled} disabled`;
  return [tile('Static routes', String(c.total), sub, c.missing ? 'text-warning' : '')];
}

// The nodes of the static routes for one poll. `data` is what loadStatic returned.
export function staticView(data, rerender) {
  if (!data.available) {
    return [note('bad', 'The routes in /etc/config/network cannot be read: this login may not read the network configuration, or the router did not answer.')];
  }
  const canEdit = editor.begin(data, rerender);
  const ctx = { data, base: editor.state.base, draft: editor.state.draft, canEdit, inputs: {}, states: new Map(), reach: new Map(), sync: () => {}, touched: () => {}, redraw: () => editor.redraw() };
  ctx.touched = editor.touched(ctx);
  // Called after every edit: marks the controls that hold an error and refreshes the banner (the form itself is not redrawn, so the
  // focus stays where it is).
  ctx.sync = () => {
    editor.markErrors(ctx.inputs, canEdit);
    for (const [row, cell] of ctx.states) cell.replaceChildren(...[stateBadge(ctx, row)].filter(Boolean));
    for (const [row, cell] of ctx.reach) cell.replaceChildren(...reachCell(ctx, row));
  };
  const choices = interfaceChoices(ctx.base, ctx.draft);
  // The wrapper is what the page's isPaused looks in for a focused control.
  const form = h('div', { className: 'rt-static' },
    legend(['A target without a prefix length is one host. Leave the gateway empty for a network that is directly connected to the interface. "From" limits the route to packets from one source. How static routes fit with the policy rules is explained in "How the kernel picks a route" above.']),
    ...FAMILIES.map(fam => familyCard(ctx, fam, choices)));
  ctx.sync();
  return [h('section', { className: 'rt-static-section' }, ...editor.notes(data).filter(Boolean), form)];
}
