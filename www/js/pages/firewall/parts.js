// Small pieces the Firewall page shares: the icon buttons of a table row, the badge that says an item has unsaved changes, the enable switch
// and the fold of a group of fields.
import { h } from '../../core/dom.js';
import { disclosure } from '../../core/fold.js';
import { badge, button } from '../../core/ui.js';

// A small icon-only button with its name as the tooltip and accessible label.
export const iconButton = (name, label, onclick, disabled = false) =>
  button('', name, onclick, 'btn-fl fw-act', { title: label, ariaLabel: label, disabled });

// A fold of a group of fields (the card of the global settings, a section of a dialog): the legend, then the fields. `opened` maps the
// group's `id` to whether it is open, so the choice survives a redraw; `open` is the state of a group that was never toggled.
export const fieldGroup = (opened, id, { title, legend, open }, fields) => disclosure({
  cls: 'fl-disclosure-bar fw-group', summary: title, open: opened.get(id) ?? Boolean(open), onToggle: o => opened.set(id, o),
  body: h('div', { className: 'fw-group-body' }, h('p', { className: 'muted small' }, legend), h('div', { className: 'set-fields' }, fields)),
});

// The button that adds an item to a list, at the right of a card's header; disabled for a login that may not write.
export const addButton = (label, onclick, canEdit) =>
  h('span', { className: 'fw-card-actions' }, button(label, 'plus-lg', onclick, 'btn-fl', { disabled: !canEdit }));

// The badge of an item that was changed in the form and not saved yet ('new', 'edited' or 'removed'); nothing for an item as the router has it.
export function pendingBadge(item) {
  if (item.removed) return badge('removed', 'danger', 'Will be deleted when the changes are saved.');
  if (item.pending === 'new') return badge('new', 'success', 'Not saved yet.');
  if (item.pending === 'edited') return badge('edited', 'warning', 'Changed, not saved yet.');
  return null;
}

// The on/off switch of an item: `onchange(checked)` runs when it is clicked.
export const enableSwitch = (checked, label, onchange, disabled) => h('label', { className: 'form-check form-switch fw-switch', title: label },
  h('input', { className: 'form-check-input', type: 'checkbox', role: 'switch', checked, disabled, ariaLabel: label, onchange: e => onchange(e.target.checked) }));
