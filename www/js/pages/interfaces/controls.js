// The controls of the network editor that the side panels and the wizard (panels.js, wizard.js) share: the control of one
// option of the schema tables, the name box of a section that is not saved yet, the ports picker of a bridge, the list of options the page has
// no control for and the state badge of an interface. They are built from an editing context (editor.js editContext) and read and write the
// draft; the values and rules are in model.js, the option tables in schema.js.
import { h } from '../../core/dom.js';
import { badge, button } from '../../core/ui.js';
import { fieldRow } from '../../core/forms.js';
import { idOf } from './schema.js';
import { aliasChoices, deviceChoices, portChoices, portOwners, setPort } from './model.js';

// The option ids whose value changes which controls are shown or what they offer, so changing one redraws the form.
export const REDRAWS = new Set(['proto', 'ip6assign']);

// The interface field `f` with its drop-down choices filled in from what the router reported and the texts that depend on the form's values.
export function interfaceField(ctx, s, f) {
  let g = f;
  if (f.dynamic === 'devices') {
    const choices = deviceChoices(ctx.base, ctx.draft);
    const aliases = aliasChoices(ctx.base, ctx.draft, s.id).map(n => `@${n}`);
    g = { ...f, options: [...choices.map(c => c.name), ...aliases],
      labels: { ...Object.fromEntries(choices.map(c => [c.name, `${c.name} · ${c.label}`])), ...Object.fromEntries(aliases.map(a => [a, `${a} · the device of the interface ${a.slice(1)}`])) } };
  }
  if (f.secret) g = { ...g, placeholder: s.secrets?.[f.key] ? 'stored; leave empty to keep it' : 'not set' };
  return g;
}

// The device field `f` for a device entry, with the choices of a base device.
export function deviceField(ctx, d, f) {
  if (f.dynamic !== 'parents') return f;
  const choices = deviceChoices(ctx.base, ctx.draft).filter(c => c.name !== d.name.trim());
  return { ...f, options: choices.map(c => c.name), labels: Object.fromEntries(choices.map(c => [c.name, `${c.name} · ${c.label}`])) };
}

// Connects the control of one field to the draft values, under the control name `name` (also used to mark errors). `onSet` replaces the plain
// store of the value for a field whose change has side effects (the protocol of an interface).
export function controlFor(ctx, f, name, values, disabled, onSet) {
  return fieldRow(f, {
    id: name,
    get: () => values[idOf(f)],
    set: v => { onSet ? onSet(v) : (values[idOf(f)] = v); if (REDRAWS.has(idOf(f))) queueMicrotask(() => ctx.redraw()); },
    disabled: !ctx.canEdit || disabled,
    touched: ctx.touched,
    redraw: ctx.redraw,
    register: (el, index) => { if (index == null) ctx.inputs[name] = el; else (ctx.inputs[name] ??= [])[index] = el; },
  });
}

// The "Section name" control of a section that is not saved yet: the name is typed once and cannot change afterwards. `suggestions` are offered
// as the names to pick from.
export function nameControl(ctx, entry, key, label, hint, placeholder, suggestions = []) {
  const listId = `ne-names-${key.replace(/\W/g, '-')}`;
  const input = h('input', { className: 'form-control form-control-sm', value: entry.name, placeholder, spellcheck: false, autocomplete: 'off', disabled: !ctx.canEdit,
    oninput: e => { entry.name = e.target.value; ctx.touched(); } });
  // `list` is a read-only property of the element, so it is set as an attribute.
  if (suggestions.length) input.setAttribute('list', listId);
  ctx.inputs[key] = input;
  return h('div', { className: 'set-field' }, h('label', { className: 'form-label' }, label), input,
    suggestions.length ? h('datalist', { id: listId }, suggestions.map(s => h('option', { value: s }))) : null,
    h('div', { className: 'muted small set-hint' }, hint));
}

// The options of a section that the option tables do not describe, read only. `secrets` are only reported as hidden.
export function extraOptions(raw, secrets, known, what) {
  const rows = [
    ...Object.entries(raw).filter(([k]) => !known.has(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
    ...Object.keys(secrets ?? {}).filter(k => !known.has(k)).map(k => [k, 'hidden (a secret)']),
  ];
  if (!rows.length) return null;
  return h('div', { className: 'ne-extra' },
    h('p', { className: 'muted small' }, `Other options of this ${what} in /etc/config/network. This page has no control for them; they are kept as they are.`),
    h('dl', { className: 'kv' }, rows.flatMap(([k, v]) => [h('dt', { className: 'mono' }, k), h('dd', { className: 'mono' }, v)])));
}

// The state of an interface on the router now, from netifd's dump: a badge.
export function stateBadge(live) {
  if (!live) return badge('not running', '', 'netifd has no running interface of this name');
  return live.up ? badge('up', 'success') : badge(live.pending ? 'pending' : 'down', live.pending ? 'warning' : 'danger');
}

// The ports picker of a bridge: a checkbox for every port the router has (and every device the bridge lists that it does not), what bridge a port
// is in now, a box to add a device by name, and a note about the Wi-Fi networks that join the bridge through the wireless config instead.
export function portsPicker(ctx, d) {
  const v = ctx.draft.devices[d.id];
  const choices = portChoices(ctx.base, ctx.draft, d.name.trim());
  const known = new Set(choices.map(c => c.name));
  const owners = portOwners(ctx.base, ctx.draft);
  const wifi = (ctx.live.net?.bridges ?? []).find(b => b.name === d.name)?.members.filter(m => m.kind === 'wifi') ?? [];
  // One row of the picker: the checkbox, the name, a dot for the link, and where the port is now.
  const row = (name, label, up, unknown) => {
    const mine = v.ports.some(p => p.trim() === name);
    const others = (owners.get(name) ?? []).filter(b => b.id !== d.id).map(b => b.name.trim() || 'another bridge');
    const box = h('input', { className: 'form-check-input', type: 'checkbox', checked: mine, disabled: !ctx.canEdit || d.removed,
      onchange: e => { setPort(ctx.base, ctx.draft, d.id, name, e.target.checked); ctx.touched(); ctx.redraw(); } });
    return h('label', { className: `form-check ne-port${mine ? ' on' : ''}` }, box,
      h('span', { className: `dot ${up ? 'up' : 'idle'}` }), h('strong', {}, name), h('span', { className: 'muted small' }, label),
      unknown ? badge('not found', 'warning', 'The router has no device of this name at the moment') : null,
      others.length ? badge(`in ${others.join(', ')}`, 'info', 'Ticking it here moves it out of that bridge') : null);
  };
  const extra = v.ports.map(p => p.trim()).filter(p => p && !known.has(p));
  const typed = h('input', { className: 'form-control form-control-sm', placeholder: 'another device, e.g. eth0.5', spellcheck: false, autocomplete: 'off', disabled: !ctx.canEdit,
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } } });
  // Adds the typed device name as a port.
  const addTyped = () => {
    const name = typed.value.trim();
    if (!name) return;
    setPort(ctx.base, ctx.draft, d.id, name, true);
    ctx.touched();
    ctx.redraw();
  };
  const box = h('div', { className: 'ne-ports' },
    h('div', { className: 'ne-port-grid' }, [...choices.map(c => row(c.name, c.label, c.up, false)), ...extra.map(n => row(n, 'device', false, true))]),
    h('div', { className: 'set-row ne-port-add' }, typed, button('Add', 'plus-lg', addTyped)),
    wifi.length ? h('div', { className: 'muted small' }, `Wi-Fi interfaces on this bridge (${wifi.map(m => m.name).join(', ')}) join through the "network" option of their Wi-Fi network (Wi-Fi radios page), not through this list.`) : null);
  ctx.inputs[`dev:${d.id}:ports`] = box;
  return h('div', { className: 'set-field wide' }, h('label', { className: 'form-label' }, 'Ports'),
    box, h('div', { className: 'muted small set-hint' }, 'The devices the bridge joins. A port can be in one bridge only: ticking a port that is in another bridge moves it. Ethernet ports of the router are listed; a VLAN device can be a port too.'));
}
