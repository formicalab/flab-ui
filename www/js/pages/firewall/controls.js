// Controls of the Firewall dialogs that core/forms.js has no field type for: a set of check boxes over a list of choices (the router's
// interfaces, the zones, the protocols) and the days of the week of a schedule. Each returns the same kind of node as core/forms.js
// fieldRow() (a `.set-field` with its label and hint) and works on the draft value in place, so the dialog can use them next to the others.
import { h } from '../../core/dom.js';
import { button } from '../../core/ui.js';
import { WEEKDAYS } from './schema.js';

// A set of check boxes over `items` ([{ value, label?, note? }]) for a list value `io.get()` that is edited in place: checking a box adds
// the value, unchecking removes it. Values of the list that are not among the items (a protocol the page does not know, an interface that
// no longer exists) get a checked box of their own, so they are never lost. With `free`, a text box adds any other value.
//   io is the connection of core/forms.js fieldRow(): { id, get(), disabled, touched(), redraw(), register(element) }.
export function checkField(f, io, items, { free = false } = {}) {
  const list = io.get();
  const known = new Set(items.map(i => i.value));
  const all = [...items, ...list.filter(v => v.trim() && !known.has(v)).map(value => ({ value, note: 'not in the list above' }))];
  const boxes = all.map(item => {
    const input = h('input', { className: 'form-check-input', type: 'checkbox', checked: list.includes(item.value), disabled: io.disabled,
      onchange: e => {
        const at = list.indexOf(item.value);
        if (e.target.checked && at < 0) list.push(item.value);
        else if (!e.target.checked && at >= 0) list.splice(at, 1);
        io.touched();
      } });
    return h('label', { className: 'form-check fw-check' }, input, h('span', {}, item.label ?? item.value, item.note ? h('span', { className: 'muted small fw-check-note' }, ` ${item.note}`) : null));
  });
  const group = h('div', { className: 'fw-checks' }, boxes.length ? boxes : h('span', { className: 'muted small' }, 'Nothing to choose from.'));
  io.register(group);
  let more = null;
  if (free) {
    const input = h('input', { className: 'form-control form-control-sm', placeholder: f.placeholder ?? 'another name or number', spellcheck: false, autocomplete: 'off', disabled: io.disabled });
    // Adds what was typed to the list, unless it is empty or already there.
    const add = () => {
      const v = input.value.trim();
      if (!v || list.includes(v)) { input.value = ''; return; }
      list.push(v);
      io.touched();
      io.redraw();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    more = h('div', { className: 'set-row fw-more' }, input, button('Add', 'plus-lg', add, 'btn-outline-secondary', { disabled: io.disabled }));
  }
  return h('div', { className: 'set-field full' }, h('label', { className: 'form-label' }, f.label), group, more, f.hint ? h('div', { className: 'muted small set-hint' }, f.hint) : null);
}

// The days of the week of a schedule: seven check boxes and "every day except the selected". The value is the string the firewall reads
// ("mon tue", or "! sat sun" to turn the list round); it is only rewritten when a box is clicked.
export function weekdaysField(f, io) {
  const text = io.get().trim();
  const inverted = text.startsWith('!');
  const words = text.replace(/^!/, '').trim().split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
  // The listed days of the value, by their first letters (the firewall reads "Mon", "monday" and "mon" alike).
  const chosen = new Set(WEEKDAYS.map(([v]) => v).filter(v => words.some(w => v.startsWith(w.slice(0, 3)) || w.startsWith(v))));
  const state = { inverted, days: chosen };
  // Writes the boxes' state back as the option's string.
  const write = () => {
    const days = WEEKDAYS.map(([v]) => v).filter(v => state.days.has(v));
    io.set(days.length ? `${state.inverted ? '! ' : ''}${days.join(' ')}` : '');
    io.touched();
  };
  const boxes = WEEKDAYS.map(([value, label]) => h('label', { className: 'form-check fw-check' },
    h('input', { className: 'form-check-input', type: 'checkbox', checked: state.days.has(value), disabled: io.disabled,
      onchange: e => { if (e.target.checked) state.days.add(value); else state.days.delete(value); write(); } }),
    h('span', {}, label)));
  const invert = h('label', { className: 'form-check fw-check' },
    h('input', { className: 'form-check-input', type: 'checkbox', checked: state.inverted, disabled: io.disabled, onchange: e => { state.inverted = e.target.checked; write(); } }),
    h('span', {}, 'Every day except the selected'));
  const group = h('div', { className: 'fw-checks' }, boxes, invert);
  io.register(group);
  return h('div', { className: 'set-field full' }, h('label', { className: 'form-label' }, f.label), group, f.hint ? h('div', { className: 'muted small set-hint' }, f.hint) : null);
}
