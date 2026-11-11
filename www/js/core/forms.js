// DOM building blocks shared by the pages that edit a config (System settings, DHCP): the control for one field
// of a schema table, a legend, a note line and the sticky review banner. Styles are in css/forms.css, which those
// pages load with their own. The values and rules are in core/fields.js; nothing here knows what is being edited.
import { h } from './dom.js';
import { icon } from './icons.js';
import { button, mono, muted } from './ui.js';

// The explanation at the top of a card.
export const legend = paragraphs => h('div', { className: 'muted small set-legend' }, paragraphs.map(p => h('p', {}, p)));

// A note line: kind is bad | warn | ok | info.
export const note = (kind, text, ...extra) => h('div', { className: `set-note ${kind}` },
  icon(kind === 'ok' ? 'check-circle' : kind === 'bad' || kind === 'warn' ? 'exclamation-triangle' : kind === 'info' ? 'info-circle' : 'hourglass-split'), text, ...extra);

// The id of the list input to focus after the next redraw (set when a row was just added).
let focusId = null;

// One row of a list field (a server, an interface): the text input and its remove button.
function listRow(f, io, list, index) {
  const input = h('input', { className: 'form-control form-control-sm', placeholder: f.placeholder ?? '', value: list[index], disabled: io.disabled,
    spellcheck: false, autocomplete: 'off', oninput: e => { list[index] = e.target.value; io.touched(); } });
  io.register(input, index);
  const remove = h('button', { type: 'button', className: 'btn btn-sm btn-fl', title: 'Remove', disabled: io.disabled,
    onclick: () => { list.splice(index, 1); io.redraw(); } }, icon('x-lg'));
  return { input, node: h('div', { className: 'set-row' }, input, remove) };
}

// The control for one schema field, with its label and hint. `io` connects it to the page:
//   id          a unique name for the field (used to focus a new list row after the redraw)
//   get()       the draft value (a string, a boolean, or the array of a list, which is edited in place)
//   set(value)  stores a new draft value
//   disabled    whether the control is read-only
//   touched()   called after every edit
//   redraw()    redraws the page (after a list row was added or removed)
//   register(element, index?)  receives the input element(s), so the page can mark the ones that hold an error
export function fieldRow(f, io) {
  const change = value => { io.set(value); io.touched(); };
  const hint = f.hint ? h('div', { className: 'muted small set-hint' }, f.hint) : null;
  const placeholder = f.default != null ? `default: ${f.default}` : f.placeholder ?? '';

  if (f.type === 'bool') {
    const input = h('input', { className: 'form-check-input', type: 'checkbox', role: 'switch', checked: io.get(), disabled: io.disabled, onchange: e => change(e.target.checked) });
    io.register(input);
    return h('label', { className: 'form-check form-switch set-switch' }, input, h('span', {}, f.label, hint));
  }

  let input;
  if (f.type === 'list') {
    const list = io.get();
    const rows = list.map((_, i) => listRow(f, io, list, i));
    const add = button(f.addLabel ?? 'Add', 'plus-lg', () => { list.push(''); focusId = io.id; io.redraw(); });
    add.disabled = io.disabled;
    input = h('div', {}, h('div', { className: 'set-list' }, rows.length ? rows.map(r => r.node) : muted('None.')), add);
    if (focusId === io.id) {
      focusId = null;
      requestAnimationFrame(() => rows.at(-1)?.input.focus());
    }
  } else if (f.type === 'enum') {
    // A value the router has that the documentation does not list is kept selectable, so it is not silently replaced.
    const current = io.get();
    const options = [['', f.default != null ? `Default (${f.default})` : 'Default'], ...f.options.map(o => [o, o])];
    if (current && !f.options.includes(current)) options.push([current, current]);
    input = h('select', { className: 'form-select form-select-sm', disabled: io.disabled, onchange: e => change(e.target.value) }, options.map(([v, label]) => h('option', { value: v }, label)));
    input.value = current;
    io.register(input);
  } else if (f.type === 'text') {
    input = h('textarea', { className: 'form-control form-control-sm', rows: 3, value: io.get(), disabled: io.disabled, spellcheck: false, oninput: e => change(e.target.value) });
    io.register(input);
  } else {
    input = h('input', { className: 'form-control form-control-sm', placeholder, value: io.get(), disabled: io.disabled, spellcheck: false, autocomplete: 'off',
      ...(f.type === 'int' ? { inputMode: 'numeric' } : {}), oninput: e => change(e.target.value) });
    io.register(input);
  }
  return h('div', { className: `set-field${f.type === 'text' ? ' wide' : ''}` }, h('label', { className: 'form-label' }, f.label), input, hint);
}

// The review banner: it lives in the sticky command bar, so Save is always on screen however far the form is
// scrolled, and it is hidden while there is nothing to report. It is yellow while edits are pending (red when one
// is invalid), shows how many edits are pending and which, the errors and warnings, the outcome of the last
// save, and the buttons; a toggle opens the full list of what changes from what to what.
// Returns { node, render(view) }: put `node` among the page's command-bar controls and call render() after every
// edit, without redrawing the form (which would lose the focus). `view` is
//   { changes: [{ label, from, to }], errors: [{ text }], warnings: [text], message: { kind, text } | null,
//     busy, canEdit, dirty, dismiss() }
export function reviewBanner({ onSave, onDiscard }) {
  let open = false;
  const summaryNode = h('span', { className: 'set-bar-summary' });
  const detailsToggle = h('button', { type: 'button', className: 'btn btn-sm btn-fl' });
  const discard = h('button', { type: 'button', className: 'btn btn-sm btn-fl', onclick: onDiscard }, icon('arrow-clockwise'), 'Discard edits');
  const saveButton = h('button', { type: 'button', className: 'btn btn-sm btn-brand', onclick: onSave }, icon('check2'), 'Save and apply');
  const dismiss = h('button', { type: 'button', className: 'btn btn-sm btn-fl', title: 'Dismiss' }, icon('x-lg'));
  const outcome = h('div', { className: 'set-bar-outcome' });
  const notes = h('div', { className: 'set-notes' });
  const list = h('ul', { className: 'set-changes' });
  const details = h('div', { className: 'set-bar-details' },
    h('p', { className: 'muted small' }, 'Save applies the change and checks that the router kept it. If the check fails, or the page is closed before it finishes, the router puts the previous settings back by itself within 30 seconds.'),
    list);
  const root = h('div', { className: 'set-bar', hidden: true },
    h('div', { className: 'set-bar-head' }, icon('check-circle'), summaryNode, h('span', { className: 'set-bar-spacer' }), detailsToggle, discard, saveButton, dismiss),
    outcome, notes, details);

  let last = null;
  const banner = {
    node: root,
    render(view) {
      last = view;
      const { changes, errors, warnings, message } = view;
      root.hidden = !(changes.length || message || errors.length);
      // Yellow while edits are pending, red when one of them is invalid, so unsaved work cannot be missed.
      root.classList.toggle('pending', changes.length > 0);
      root.classList.toggle('invalid', errors.length > 0);

      summaryNode.replaceChildren(
        changes.length ? h('b', {}, `${changes.length} unsaved change${changes.length > 1 ? 's' : ''}`) : muted('No unsaved changes'),
        changes.length ? muted(`: ${changes.map(c => c.label).join(', ')}`) : null);
      detailsToggle.replaceChildren(icon(open ? 'chevron-up' : 'chevron-down'), open ? 'Hide details' : 'Details');
      detailsToggle.hidden = !changes.length;
      details.hidden = !open || !changes.length;
      list.replaceChildren(...changes.map(c => h('li', {}, h('b', {}, c.label), ': ', mono(c.from), ' → ', mono(c.to))));
      notes.replaceChildren(...errors.map(e => note('bad', e.text)), ...warnings.map(t => note('warn', t)));

      const outcomeNote = message ? note(message.kind, message.text) : null;
      outcomeNote?.classList.add('set-outcome');
      outcome.replaceChildren(...(outcomeNote ? [outcomeNote] : []));
      dismiss.hidden = !message || view.busy;
      saveButton.disabled = !view.canEdit || !changes.length || errors.length > 0;
      discard.disabled = view.busy || !view.dirty;
    },
  };
  detailsToggle.onclick = () => { open = !open; banner.render(last); };
  dismiss.onclick = () => last.dismiss();
  return banner;
}
