// The dialog that adds or edits one zone, traffic rule or port forward. It works on a copy of the item's form values and checks them as the
// user types; "Add to the changes" puts the copy into the page's draft, and the review banner at the top of the page saves everything at
// once. The fields come from the option tables in schema.js through core/forms.js, with the controls of controls.js for the ones it has no
// type for. What a field's value does to the others (a control that shows only for some values) is applied without redrawing, so typing is
// never interrupted.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { openDialog } from '../../core/modal.js';
import { fieldRow, note } from '../../core/forms.js';
import { REDIRECT_GROUPS, RULE_GROUPS, ZONE_GROUPS, PROTOCOLS } from './schema.js';
import { KINDS, fieldFor, findItem, forwardLinks, isShown, live, newValues, zoneName } from './edit.js';
import { redirectWords, ruleWords } from './describe.js';
import { itemProblems } from './validate.js';
import { checkField, weekdaysField } from './controls.js';

// The groups of each kind's dialog.
const GROUPS = { zones: ZONE_GROUPS, rules: RULE_GROUPS, redirects: REDIRECT_GROUPS };
// What the dialog's title says it is.
const TITLES = { zones: 'zone', rules: 'traffic rule', redirects: 'port forward' };
// The options whose value changes how the other fields are worded (a source NAT words them differently), so the form is built again.
const REBUILD = new Set(['target']);

// Which groups of which dialog are open, kept while the page lives: id `<kind>:<group>` to open or closed.
const opened = new Map();

// A copy of form values that can be edited without touching the draft.
const copyOf = values => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));

// Opens the dialog for the item `id` of the list `key` of the draft (null: a new one). `data` is what the router has, `getDraft()` the
// page's draft as it is when the dialog needs it (the other zones decide which interfaces are free, the zones decide what a rule may
// refer to), `onSave(values, links)` receives the copy when the user accepts it (for a zone, `links` is { to, from }: the zones it may forward
// to and the zones that may forward to it), and `onClose()` runs when the dialog is gone.
export function openItemDialog({ key, id, data, getDraft, onSave, onClose }) {
  const isNew = id == null;
  const item = isNew ? null : findItem(getDraft(), key, id);
  const values = isNew ? newValues(key, data) : copyOf(item.values);
  // The forwardings of a zone, kept apart from its values: the checked zones in each direction (only zones that exist, so a forwarding that
  // names "any zone" is neither shown nor changed).
  const links = { to: [], from: [] };
  const fields = KINDS[key].fields;
  const inputs = {};
  let touchedOnce = !isNew;
  let dialog = null;

  const errorsBox = h('div', { className: 'set-notes' });
  const words = h('div', { className: 'fw-words' });
  const save = h('button', { type: 'button', className: 'btn btn-sm btn-brand', onclick: () => { onSave(values, links); dialog.close(); } }, icon('check2'), isNew ? 'Add to the changes' : 'Update the changes');
  const cancel = h('button', { type: 'button', className: 'btn btn-sm btn-fl', onclick: () => dialog.close() }, 'Cancel');
  // The wrappers of the controls (field key to element) and of the groups, to show and hide them as the values change.
  let wrappers = {};
  let groupBoxes = [];

  // The zones of the draft the other fields may refer to, for the drop-downs.
  const zoneNames = () => live(getDraft().zones).map(zoneName).filter(Boolean);
  if (!isNew) {
    const found = forwardLinks(getDraft(), zoneName(item));
    for (const k of ['to', 'from']) links[k] = found[k].filter(n => zoneNames().includes(n));
  }

  // Checks the copy: Save follows, the messages and the marked controls show once the user has started to edit.
  function validate() {
    const found = itemProblems(key, id, values, getDraft(), data);
    const errors = found.filter(p => p.level === 'error');
    save.disabled = errors.length > 0;
    for (const el of Object.values(inputs).flat()) el?.classList.remove('is-invalid');
    errorsBox.replaceChildren(...(touchedOnce ? [...errors.map(p => note('bad', p.text)), ...found.filter(p => p.level === 'warn').map(p => note('warn', p.text))] : []));
    if (touchedOnce) {
      for (const p of errors) {
        const el = inputs[p.key];
        (Array.isArray(el) ? el[p.index] ?? el.find(Boolean) : el)?.classList.add('is-invalid');
      }
    }
    if (key === 'rules') words.textContent = ruleWords(values);
    else if (key === 'redirects') words.textContent = redirectWords(values);
  }

  // Shows the controls that apply to the values and hides the rest (a hidden control keeps its value and is not checked).
  function sync() {
    for (const f of fields) if (wrappers[f.key]) wrappers[f.key].hidden = !isShown(f, values);
    for (const g of groupBoxes) g.el.hidden = g.fields.every(f => !isShown(f, values));
    validate();
  }
  // Called after every edit: from then on the problems are shown.
  const touched = () => { touchedOnce = true; sync(); };

  // The connection of one field to the form (see core/forms.js fieldRow).
  const io = f => ({
    id: `${key}-${f.key}`, get: () => values[f.key], set: v => { values[f.key] = v; },
    disabled: false, touched: REBUILD.has(f.key) ? () => { touched(); render(); } : touched, redraw: () => render(),
    register: (el, i) => { if (i == null) inputs[f.key] = el; else (inputs[f.key] ??= [])[i] = el; },
  });

  // The control of one field.
  function control(base) {
    const f = fieldFor(base, values);
    const c = io(f);
    const d = getDraft();
    if (f.control === 'networks') {
      const owner = new Map(live(d.zones).filter(z => z.id !== id).flatMap(z => z.values.network.map(n => [n, zoneName(z)])));
      const items = data.networks.filter(n => n.name !== 'loopback' || values.network.includes('loopback')).map(n => ({
        value: n.name, note: owner.has(n.name) ? `now in zone ${owner.get(n.name)}: choosing it moves it here` : (n.addrs ?? [])[0] ?? '',
      }));
      return checkField(f, c, items);
    }
    if (f.control === 'zones') return checkField(f, c, zoneNames().map(value => ({ value })));
    if (f.control === 'choices') return checkField(f, c, PROTOCOLS.map(value => ({ value })), { free: true });
    if (f.control === 'weekdays') return weekdaysField(f, c);
    let g = f;
    if (f.zone) {
      const names = zoneNames();
      const any = f.zone === 'src' || f.zone === 'dest';
      const blank = { src: 'None: the traffic comes from the router itself', dest: 'None: the traffic goes to the router itself', srcOnly: 'Choose a zone', destOnly: values.target === 'SNAT' ? 'Choose a zone' : 'Automatic: the zone of the internal address' }[f.zone];
      g = { ...f, options: [...(any ? ['*'] : []), ...names], labels: { '*': 'Any zone' }, blank };
    } else if (key === 'zones' && ['input', 'output', 'forward'].includes(f.key)) {
      g = { ...f, blank: `Default (${d.defaults[f.key] || 'DROP'}, from the global settings)` };
    }
    const node = fieldRow(g, c);
    if (f.fallback != null && f.type === 'enum') {
      // An option that is always set has no "default" choice.
      inputs[f.key].querySelector?.('option[value=""]')?.remove();
    }
    if (f.suggest) {
      const list = h('datalist', { id: `fw-suggest-${f.key}` }, f.suggest.map(v => h('option', { value: v })));
      for (const input of node.querySelectorAll('input.form-control')) input.setAttribute('list', list.id);
      node.append(list);
    }
    if (key === 'zones' && f.key === 'name' && !isNew) {
      inputs.name.disabled = true;
      inputs.name.title = 'A zone cannot be renamed here: rules and forwardings refer to it by name.';
    }
    if (f.type === 'list' && !f.control) node.classList.add('full');
    return node;
  }

  // The body for the current values: the groups of the kind, each a fold-away box with its controls.
  function bodyNodes() {
    for (const k of Object.keys(inputs)) delete inputs[k];
    wrappers = {};
    groupBoxes = [];
    const parts = [];
    if (key !== 'zones') parts.push(h('div', { className: 'fw-what' }, h('div', { className: 'muted small' }, 'What it does'), words));
    for (const g of GROUPS[key]) {
      const list = fields.filter(f => f.group === g.id);
      if (!list.length) continue;
      const gid = `${key}:${g.id}`;
      const nodes = list.map(f => { const n = control(f); wrappers[f.key] = n; return n; });
      const el = h('details', { className: 'fw-group', open: opened.get(gid) ?? Boolean(g.open), ontoggle: e => opened.set(gid, e.target.open) },
        h('summary', {}, g.title), h('div', { className: 'fw-group-body' }, h('p', { className: 'muted small' }, g.legend), h('div', { className: 'set-fields' }, nodes)));
      groupBoxes.push({ el, fields: list });
      parts.push(el);
      if (key === 'zones' && g.id === 'members') parts.push(forwardingGroup());
    }
    return parts;
  }

  // The zones this zone may send traffic to, and the zones that may send traffic to it: one check box per other zone. A forwarding covers one
  // direction only, so each direction is its own box; the page turns them into forwarding sections when the zone is added to the changes.
  function forwardingGroup() {
    const self = values.name.trim();
    const items = zoneNames().filter(n => n !== self).map(value => ({ value }));
    const direction = (list, label, hint) => checkField({ label, hint }, { get: () => list, disabled: false, touched, register: () => {}, redraw: () => {} }, items);
    const gid = 'zones:forwardings';
    return h('details', { className: 'fw-group', open: opened.get(gid) ?? true, ontoggle: e => opened.set(gid, e.target.open) },
      h('summary', {}, 'Traffic to and from other zones'),
      h('div', { className: 'fw-group-body' },
        h('p', { className: 'muted small' }, 'A forwarding lets one zone send new connections to another, in one direction only (replies are always let back in). To let two zones talk both ways, tick both boxes. Traffic between interfaces of this same zone is the Forward policy above.'),
        h('div', { className: 'set-fields' },
          direction(links.to, 'May forward to', 'Hosts in this zone may start connections to these zones.'),
          direction(links.from, 'May receive from', 'Hosts in these zones may start connections to this zone.'))));
  }

  // Draws the body again (a control that changes the shape of the form was used), then checks it.
  function render() {
    shown.setBody(h('div', {}, ...bodyNodes()));
    sync();
  }

  const shown = openDialog({
    title: isNew ? `Add a ${TITLES[key]}` : `Edit ${TITLES[key]}${key === 'zones' ? ` ${values.name}` : values.name?.trim() ? ` “${values.name.trim()}”` : ''}`,
    subtitle: key === 'zones' ? 'A group of interfaces with one set of default policies' : key === 'rules' ? 'A rule of /etc/config/firewall' : 'A redirect section of /etc/config/firewall',
    size: 'lg',
    staticBackdrop: true,
    body: h('div', {}),
    footer: [errorsBox, cancel, save],
    onClose,
  });
  dialog = shown.dialog;
  // The messages take a row of their own above the buttons.
  errorsBox.style.flex = '1 0 100%';
  render();
  return shown;
}
