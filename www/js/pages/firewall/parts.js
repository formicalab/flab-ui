// Small pieces the Firewall page's tables share: the icon buttons of a row, the badge that says an item has unsaved changes, and the
// enable switch.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge } from '../../core/ui.js';

// A small icon-only button with its name as the tooltip and accessible label.
export const iconButton = (name, label, onclick, disabled = false) =>
  h('button', { type: 'button', className: 'btn btn-sm btn-fl fw-act', title: label, ariaLabel: label, disabled, onclick }, icon(name));

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
