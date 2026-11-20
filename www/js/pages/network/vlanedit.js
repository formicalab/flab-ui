// The editable VLAN cards of the Ethernet ports view (shown while the editor is open): one matrix per VLAN-filtering bridge and per
// swconfig switch, each cell a choice of how a port takes part in a VLAN. The cards edit the draft of vlanmodel.js; saving,
// the review banner and the rollback countdown are the shared editor's (vlanpage.js). Styles are in css/network.css.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, muted } from '../../core/ui.js';
import { legend, note } from '../../core/forms.js';
import { STATE_LABEL, addRow, cellKey, removeRow, switchVid } from './vlanmodel.js';

// What was typed into each table's "add a VLAN" box and the problem with it, by table key, so a redraw keeps them.
const adding = {};

// The options of a cell's drop-down: the states a bridge port can have in a VLAN (a state the config has that is not listed, such
// as tagged + PVID, stays selectable) or the two a swconfig port can have.
function optionsFor(table, current) {
  const states = table.kind === 'bridge' ? ['', 't', 'u', 'u*'] : ['', 't', 'u'];
  if (current && !states.includes(current)) states.push(current);
  return states.map(s => [s, s === '' ? '–' : table.kind === 'bridge' ? STATE_LABEL[s] : s === 't' ? 'tagged' : 'untagged']);
}

// The drop-down of one port in one VLAN.
function cellSelect(ctx, table, row, col) {
  const current = row.cells[col.id] ?? '';
  const select = h('select', {
    className: 'form-select form-select-sm vlan-cell', disabled: !ctx.canEdit, title: `${col.label} in VLAN ${table.kind === 'switch' ? switchVid(row) : row.vid}`,
    onchange: e => { if (e.target.value) row.cells[col.id] = e.target.value; else delete row.cells[col.id]; ctx.touched(); },
  }, optionsFor(table, current).map(([value, label]) => h('option', { value }, label)));
  select.value = current;
  ctx.inputs[cellKey(table, row, col.id)] = select;
  return h('td', {}, select);
}

// The first cell of a row: the VLAN id (a swconfig group that has another number says so).
function nameCell(ctx, table, row) {
  const td = h('td', { className: 'vlan-edit-vid' }, h('strong', {}, table.kind === 'switch' ? switchVid(row) : row.vid),
    table.kind === 'switch' && switchVid(row) !== row.vlan ? h('div', { className: 'muted small' }, `group ${row.vlan}`) : null,
    row.sec ? null : h('div', {}, badge('new', 'info')));
  ctx.inputs[`row:${table.key}|${row.key}`] = td;
  return td;
}

// The matrix: one row per VLAN, one column per port (the bridge itself, or the switch's CPU port, is a column too), and a remove
// button at the end of each row.
function matrix(ctx, table, d) {
  const cpu = table.columns.filter(c => c.cpu);
  const ports = table.columns.filter(c => !c.cpu);
  const head = h('tr', {}, h('th', {}, 'VLAN'), ports.map(c => h('th', { title: c.member === false ? 'Not a member of this bridge' : '' }, c.label, c.member === false ? badge('not a member', 'warning') : null)),
    table.kind === 'bridge' ? h('th', { title: 'The router itself is a member of the VLAN: it can have an address on it (a device named after the bridge and the VLAN id)' }, 'Router') : cpu.map(c => h('th', { title: 'The switch port that faces the router' }, c.label)),
    h('th', {}));
  const body = d.rows.map(row => h('tr', {},
    nameCell(ctx, table, row),
    ports.map(c => cellSelect(ctx, table, row, c)),
    table.kind === 'bridge'
      ? h('td', {}, h('input', { className: 'form-check-input', type: 'checkbox', checked: row.local, disabled: !ctx.canEdit, title: 'The router itself is a member of this VLAN (option local)',
        ariaLabel: `The router in VLAN ${row.vid}`, onchange: e => { row.local = e.target.checked; ctx.touched(); } }))
      : cpu.map(c => cellSelect(ctx, table, row, c)),
    h('td', {}, button('', 'x-lg', () => { removeRow(ctx.draft, table.key, row.key); ctx.touched(); ctx.redraw(); }, 'btn-outline-secondary',
      { title: `Remove VLAN ${table.kind === 'switch' ? switchVid(row) : row.vid}`, ariaLabel: `Remove VLAN ${table.kind === 'switch' ? switchVid(row) : row.vid}`, disabled: !ctx.canEdit }))));
  return h('div', { className: 'table-responsive' }, h('table', { className: 'table vlan-table vlan-edit-table' }, h('thead', {}, head), h('tbody', {}, body)));
}

// The box that adds a VLAN to a table.
function addBar(ctx, table) {
  const s = adding[table.key] ??= { text: '', error: null };
  const input = h('input', { className: 'form-control form-control-sm vlan-add-id', type: 'number', min: 1, max: 4094, step: 1, placeholder: 'VLAN id', value: s.text, disabled: !ctx.canEdit,
    ariaLabel: `VLAN id to add to ${table.name}`, oninput: e => { s.text = e.target.value; } });
  // Adds the typed VLAN, or keeps the box and shows what is wrong with it.
  const add = () => {
    s.error = addRow(ctx.data, ctx.draft, table.key, s.text);
    if (!s.error) { s.text = ''; ctx.touched(); }
    ctx.redraw();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const go = button('Add VLAN', 'plus-lg', add, 'btn-outline-secondary', { disabled: !ctx.canEdit });
  return h('div', { className: 'vlan-add' }, input, go, s.error ? h('span', { className: 'vlan-add-error' }, s.error) : null);
}

// The interfaces of the router that sit on VLANs of this table, so the admin sees what an edit can reach.
function carriersNote(table) {
  if (!table.carriers.length) return null;
  return h('div', { className: 'muted small vlan-carriers' }, 'The router has addresses on: ',
    table.carriers.map((c, i) => h('span', {}, i ? ', ' : '', h('span', { className: 'mono' }, c.iface), ` (${c.addresses[0]}, VLAN ${c.vid})`)));
}

// A check box that sets one switch of the table: VLAN filtering of a bridge, or VLANs of a swconfig switch.
function switchRow(ctx, label, hint, checked, onChange) {
  const input = h('input', { className: 'form-check-input', type: 'checkbox', checked, disabled: !ctx.canEdit, onchange: e => { onChange(e.target.checked); ctx.touched(); ctx.redraw(); } });
  return h('label', { className: 'form-check set-check vlan-switch' }, input, h('span', {}, label, h('div', { className: 'muted small set-hint' }, hint)));
}

// The editable card of a bridge.
function bridgeEdit(ctx, table) {
  const d = ctx.draft.tables[table.key];
  const filter = table.filtering === null
    ? note('info', `${table.name} has no device section in the network config (it is defined in its interface section), so VLAN filtering cannot be switched here; set the vlan_filtering option of the bridge by hand.`)
    : switchRow(ctx, h('b', {}, 'VLAN filtering'), 'Option vlan_filtering of the bridge device. Without it the table below is stored but not enforced: every port forwards between all the others. Turning it on is a separate change: it applies the whole table at once.', d.filtering, v => { d.filtering = v; });
  return card([icon('diagram-2'), h('span', {}, `${table.label} · VLANs`), badge(table.filteringLive ? 'VLAN filtering on' : 'VLAN filtering off', table.filteringLive ? 'success' : ''),
    h('span', { className: 'sub' }, 'editing the network config (bridge-vlan sections)'),
    h('span', { className: 'ms-auto' }, doneButton(ctx))],
  h('div', { className: 'vlan-edit' },
    legend([
      'Each row is a VLAN, each column a port of the bridge. Choose for every port: not a member, tagged (frames carry the VLAN id), untagged (frames leave without a tag) or untagged + PVID (the same, and untagged frames that arrive on the port join this VLAN). A port has one PVID. The Router column makes the router itself a member, which is what lets it have an address on the VLAN.',
      'This edits the config. Nothing is saved until Save and apply; the router then applies it and puts the old settings back by itself if it cannot confirm the change.',
    ]),
    table.live ? note('warn', `The table the kernel runs differs from this config: ${table.live.slice(0, 4).join('; ')}${table.live.length > 4 ? `; and ${table.live.length - 4} more` : ''}. The config may have been changed without being applied, or by something else; saving makes both agree.`) : null,
    h('div', { className: 'p-3 pb-0' }, filter),
    d.rows.length ? matrix(ctx, table, d) : h('div', { className: 'p-3' }, muted('No VLAN in the config yet.')),
    h('div', { className: 'p-3 pt-2' }, carriersNote(table), addBar(ctx, table))));
}

// The editable card of a swconfig switch.
function switchEdit(ctx, table) {
  const d = ctx.draft.tables[table.key];
  const toggle = table.enable === null
    ? note('info', `The network config has no switch section for ${table.name}, so enable_vlan cannot be changed here.`)
    : switchRow(ctx, h('b', {}, 'VLANs on this switch'), 'Option enable_vlan of the switch section. Without it the switch ignores the groups below and forwards between all its ports.', d.enable, v => { d.enable = v; });
  return card([icon('diagram-2'), h('span', {}, `${table.label} · VLAN groups`), badge(table.enableLive ? 'VLANs on' : 'VLANs off', table.enableLive ? 'success' : 'warning'),
    h('span', { className: 'sub' }, 'editing the network config (switch_vlan sections)'),
    h('span', { className: 'ms-auto' }, doneButton(ctx))],
  h('div', { className: 'vlan-edit' },
    legend([
      'Each row is a VLAN group of the switch, each column a port; the CPU column is the switch port that faces the router. A tagged port (the number followed by t) keeps the VLAN id on its frames, an untagged one removes it, and a port can be untagged in only one VLAN. Tag the CPU port to give the router one interface per VLAN (eth0.1, eth0.2, ...).',
      'This edits the config. Nothing is saved until Save and apply; the router then applies it and puts the old settings back by itself if it cannot confirm the change.',
      table.pvids.length ? `A switch_port section sets the PVID of ${table.pvids.map(p => `port ${p.port} (VLAN ${p.pvid})`).join(', ')}; this editor leaves those sections as they are.` : null,
    ].filter(Boolean)),
    h('div', { className: 'p-3 pb-0' }, toggle),
    d.rows.length ? matrix(ctx, table, d) : h('div', { className: 'p-3' }, muted('No VLAN group in the config yet.')),
    h('div', { className: 'p-3 pt-2' }, carriersNote(table), addBar(ctx, table))));
}

// Enables the "Done" button only while nothing is unsaved or being saved (Discard edits in the banner throws unsaved edits away).
export function syncDone(ctx, done) {
  done.disabled = ctx.dirty() || ctx.busy();
  done.title = ctx.dirty() ? 'Save or discard the edits first' : 'Close the editor';
}

// The button that closes the editor; ctx.sync() keeps its state current as the form changes.
function doneButton(ctx) {
  const done = button('Done', 'check2', ctx.close);
  syncDone(ctx, done);
  ctx.dones.push(done);
  return done;
}

// The cards of the editor, with the notes of the shared editor (a login that may not write, changes staged already) above them.
// `ctx.data.vlan.tables` holds a table for every bridge that has Ethernet ports or VLANs and every swconfig switch.
export function editCards(ctx) {
  const tables = ctx.data.vlan.tables;
  const cards = tables.map(t => (t.kind === 'bridge' ? bridgeEdit(ctx, t) : switchEdit(ctx, t)));
  const page = [
    ...ctx.notes,
    ctx.data.vlanFailed ? note('bad', 'The network config could not be read, so the VLANs cannot be edited. Check that the login may read it, then reload.') : null,
    !cards.length && !ctx.data.vlanFailed ? note('info', 'This router has no bridge with Ethernet ports and no swconfig switch, so there is no VLAN table to edit.') : null,
    ...cards,
    cards.length ? null : h('div', {}, doneButton(ctx)),
  ].filter(Boolean);
  // Marks the controls that hold an error and refreshes the review banner.
  ctx.sync();
  return page;
}
