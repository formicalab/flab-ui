// Pieces shared by the two editable tables of the DHCP page (reservations and network boot entries): rows of the draft that have an
// input per option, a state cell and a remove or undo button. A row has `section` null until it is saved and `removed` once it is
// marked for removal (a saved row is deleted on Save, an unsaved one is simply dropped).
import { h } from '../../core/dom.js';
import { button } from '../../core/ui.js';

// The class of a row's <tr>: tinted when it is new or going to be removed.
export const rowClass = row => (row.removed ? 'dhcp-removed' : row.section == null ? 'dhcp-new' : '');

// One <td> per field of the table, each holding an input. The inputs are registered in `ctx.inputs` as `<prefix>:<row key>:<field key>`,
// which is how errors find the control to mark.
export function inputCells(ctx, fields, prefix, row) {
  const disabled = !ctx.canEdit || row.removed;
  return fields.map(f => {
    const input = h('input', { className: 'form-control form-control-sm mono', placeholder: f.placeholder ?? '', value: row.values[f.key], disabled,
      spellcheck: false, autocomplete: 'off', title: f.label, oninput: e => { row.values[f.key] = e.target.value; ctx.touched(); } });
    ctx.inputs[`${prefix}:${row.key}:${f.key}`] = input;
    return h('td', {}, input);
  });
}

// The button of a row: Undo for a row marked for removal, otherwise a remove button (`title` says what it removes). `list` is the
// draft's array that holds the row.
export function rowAction(ctx, row, list, title) {
  if (row.removed) return button('Undo', 'arrow-counterclockwise', () => { row.removed = false; ctx.redraw(); });
  return button('', 'x-lg', () => {
    if (row.section == null) list.splice(list.indexOf(row), 1);
    else row.removed = true;
    ctx.redraw();
  }, 'btn-fl', { title, ariaLabel: title, disabled: !ctx.canEdit });
}
