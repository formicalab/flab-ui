// The editing cards of the network pages: one foldable card per logical interface, per bridge and per other device section (a VLAN device, the
// settings of an existing port), with the add and remove controls. The controls come from the option tables in schema.js through core/forms.js; the
// values, the rules and the descriptions are in model.js. The cards are built from an editing context (editor.js editContext) and are shared by the
// Devices and Interfaces page and the Bridges page, which show different sets of them.
import { h } from '../../core/dom.js';
import { chevron, foldable } from '../../core/fold.js';
import { icon } from '../../core/icons.js';
import { badge, button, card, kv, mono, muted } from '../../core/ui.js';
import { fieldRow, legend } from '../../core/forms.js';
import {
  DEVICE_FIELDS, DEVICE_GROUPS, DEVICE_TYPES, IFACE_FIELDS, IFACE_GROUPS, deviceFields, idOf, ifaceFields,
} from './schema.js';
import {
  addDevice, addInterface, aliasChoices, describeDevice, describeInterface, deviceChoices, deviceList, ifaceList, portChoices, portOwners, protoLabel, removeDevice,
  removeInterface, restoreDevice, restoreInterface, setPort, setProto,
} from './model.js';

//#region State that survives a redraw

// Which option groups are expanded, kept across redraws: `<card>:<group>` to open or closed.
const opened = new Map();
// Which cards are folded down to their header: `if:<id>` or `dev:<id>` to true or false. Existing sections start folded, new ones open.
const folds = new Map();

// Makes the card of `key` foldable and remembers whether the user folded it.
const foldCard = (el, key, startFolded = true) => foldable(el, folds.get(key) ?? startFolded, folded => folds.set(key, folded));

//#endregion

//#region Controls

// The option ids whose value changes which controls are shown or what they offer, so changing one redraws the form.
const REDRAWS = new Set(['proto', 'ip6assign']);

// The interface field `f` with its drop-down choices filled in from what the router reported and the texts that depend on the form's values.
function interfaceField(ctx, s, f) {
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
function deviceField(ctx, d, f) {
  if (f.dynamic !== 'parents') return f;
  const choices = deviceChoices(ctx.base, ctx.draft).filter(c => c.name !== d.name.trim());
  return { ...f, options: choices.map(c => c.name), labels: Object.fromEntries(choices.map(c => [c.name, `${c.name} · ${c.label}`])) };
}

// Connects the control of one field to the draft values, under the control name `name` (also used to mark errors).
function controlFor(ctx, f, name, values, disabled, onSet) {
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
function nameControl(ctx, entry, key, label, hint, placeholder, suggestions = []) {
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

// The groups of a card as `<details>` blocks. `groups` is the group table, `fieldsOf(group)` the controls of one group, `id` the card's id.
function groupBlocks(id, groups, fieldsOf, lead = {}) {
  return groups.map(g => {
    const controls = fieldsOf(g.id);
    const extra = lead[g.id];
    if (!controls.length && !extra) return null;
    const key = `${id}:${g.id}`;
    return h('details', { className: 'ne-group', open: opened.get(key) ?? Boolean(g.open), ontoggle: e => opened.set(key, e.target.open) },
      h('summary', {}, g.title),
      h('div', { className: 'ne-group-body' }, h('p', { className: 'muted small' }, g.legend), extra ?? null, controls.length ? h('div', { className: 'set-fields' }, controls) : null));
  });
}

// The options of a section that the option tables do not describe, read only. `secrets` are only reported as hidden.
function extraOptions(raw, secrets, known, what) {
  const rows = [
    ...Object.entries(raw).filter(([k]) => !known.has(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
    ...Object.keys(secrets ?? {}).filter(k => !known.has(k)).map(k => [k, 'hidden (a secret)']),
  ];
  if (!rows.length) return null;
  return h('div', { className: 'ne-extra' },
    h('p', { className: 'muted small' }, `Other options of this ${what} in /etc/config/network. This page has no control for them; they are kept as they are.`),
    h('dl', { className: 'kv' }, rows.flatMap(([k, v]) => [h('dt', { className: 'mono' }, k), h('dd', { className: 'mono' }, v)])));
}

//#endregion

//#region Interface cards

// The state of an interface on the router now, from netifd's dump: a badge.
function stateBadge(live) {
  if (!live) return badge('not running', '', 'netifd has no running interface of this name');
  return live.up ? badge('up', 'success') : badge(live.pending ? 'pending' : 'down', live.pending ? 'warning' : 'danger');
}

// The card of one logical interface. Clicking the header folds it. An interface whose protocol the page does not edit is shown read only.
export function interfaceCard(ctx, s) {
  const v = ctx.draft.ifaces[s.id];
  const off = s.removed;
  const live = ctx.live.ifs.find(i => i.interface === s.name);
  const proto = s.editable ? v.proto : (s.raw.proto ?? '');
  const known = new Set(IFACE_FIELDS.map(f => f.key));

  // The controls of one group for the protocol the form holds now.
  const fieldsOf = group => (s.editable ? ifaceFields(proto, v).filter(f => f.group === group).map(f => controlFor(ctx, interfaceField(ctx, s, f), `if:${s.id}:${idOf(f)}`, v, off,
    f.key === 'proto' ? p => setProto(ctx.base, ctx.draft, s.id, p) : undefined)) : []);
  const lead = s.isNew ? { general: nameControl(ctx, ctx.draft.ifaceAdded.find(a => a.id === s.id), `if:${s.id}:name`, 'Interface name',
    'How the interface is called in /etc/config/network, by the firewall and the DHCP server. Letters, digits and underscores; it cannot be changed once saved.', 'guest') } : {};
  const groups = s.editable ? groupBlocks(`if:${s.id}`, IFACE_GROUPS, fieldsOf, lead) : [];

  let actions;
  if (off) actions = h('div', { className: 'ne-actions' }, muted(`The interface ${s.name} is removed when you save.`), button('Undo', 'arrow-clockwise', () => { restoreInterface(ctx.draft, s.id); ctx.touched(); ctx.redraw(); }));
  else if (!s.editable) {
    actions = h('div', { className: 'ne-actions' }, muted(`This interface runs ${protoLabel(proto)}. This page does not edit its protocol; its options are shown as they are in the file.`),
      proto === 'wireguard' ? h('a', { href: '#wireguard', className: 'btn btn-sm btn-fl' }, icon('shield-lock'), 'WireGuard page') : null);
  } else {
    actions = h('div', { className: 'ne-actions' }, muted(s.isNew ? 'Not saved yet.' : `The interface section "${s.name}".`),
      s.name === 'loopback' ? muted('The loopback interface cannot be removed here.')
        : h('button', { type: 'button', className: 'btn btn-sm btn-fl', disabled: !ctx.canEdit, title: `Delete the interface ${s.name || ''}`,
          onclick: () => { removeInterface(ctx.draft, s.id); ctx.touched(); ctx.redraw(); } }, icon('trash'), s.isNew ? 'Discard interface' : 'Remove interface'));
  }

  // A new interface is named in the form, so its name is read from the draft each time.
  const nameNow = () => (s.isNew ? ctx.draft.ifaceAdded.find(a => a.id === s.id)?.name ?? s.name : s.name);
  const subNode = h('span', { className: 'sub' }, describeInterface(s, ctx.draft, ctx.live.ifs));
  const nameNode = h('span', {}, nameNow() || 'New interface');
  ctx.refresh(() => {
    // The card of an interface the form has just discarded is still on screen until the redraw.
    if (!ctx.draft.ifaces[s.id]) return;
    subNode.textContent = describeInterface(s, ctx.draft, ctx.live.ifs);
    nameNode.textContent = nameNow() || 'New interface';
  });
  const state = s.isNew ? badge('new', 'info', 'not saved yet') : off ? badge('to be removed', 'danger') : stateBadge(live);
  const el = card(
    [chevron(), icon('diagram-3'), nameNode, badge(protoLabel(proto), 'info'), state, subNode],
    h('div', { className: `card-body ne-groups${off ? ' ne-removed' : ''}` },
      s.editable ? null : kv(Object.entries(s.raw).map(([k, val]) => [mono(k), mono(Array.isArray(val) ? val.join(', ') : String(val))])),
      actions, groups,
      s.editable ? extraOptions(s.raw, s.secrets, known, 'interface') : extraOptions({}, s.secrets, known, 'interface')),
    s.isNew ? 'ne-new' : '');
  return foldCard(el, `if:${s.id}`, !s.isNew);
}

// The row below the interface cards for adding one.
export function addInterfaceBar(ctx) {
  const add = button('Add interface', 'plus-lg', () => { folds.set(`if:${addInterface(ctx.base, ctx.draft)}`, false); ctx.touched(); ctx.redraw(); });
  add.disabled = !ctx.canEdit;
  return h('div', { className: 'ne-addbar' }, add, muted('A logical interface holds the protocol and addresses of one network. Give it a device (a bridge, a VLAN device or a port) after adding it.'));
}

// All interface cards in order.
export const interfaceCards = ctx => ifaceList(ctx.base, ctx.draft).map(s => interfaceCard(ctx, s));

//#endregion

//#region Device cards

// The ports picker of a bridge: a checkbox for every port the router has (and every device the bridge lists that it does not), what bridge a port
// is in now, a box to add a device by name, and a note about the Wi-Fi networks that join the bridge through the wireless config instead.
function portsPicker(ctx, d) {
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
    wifi.length ? h('div', { className: 'muted small' }, `Wi-Fi interfaces on this bridge (${wifi.map(m => m.name).join(', ')}) join through the "network" option of their Wi-Fi network (Wi-Fi page), not through this list.`) : null);
  ctx.inputs[`dev:${d.id}:ports`] = box;
  return h('div', { className: 'set-field wide' }, h('label', { className: 'form-label' }, 'Ports'),
    box, h('div', { className: 'muted small set-hint' }, 'The devices the bridge joins. A port can be in one bridge only: ticking a port that is in another bridge moves it. Ethernet ports of the router are listed; a VLAN device can be a port too.'));
}

// The card of one device section: a bridge, a VLAN device, or the settings of an existing device. A device the page cannot edit is shown read only.
export function deviceCard(ctx, d) {
  const v = ctx.draft.devices[d.id];
  const off = d.removed;
  const type = DEVICE_TYPES.find(t => t.id === d.type);
  const runtime = d.type === 'bridge' ? (ctx.live.net?.bridges ?? []).find(b => b.name === d.name) : (ctx.live.net?.vlans ?? []).find(x => x.name === d.name);
  const known = new Set([...DEVICE_FIELDS.map(f => f.key), 'name', 'type', 'ports']);

  // The controls of one group for this device's type; the first group starts with the name (of a new device) and the ports of a bridge.
  const fieldsOf = group => {
    const controls = d.editable ? deviceFields(d.type).filter(f => f.group === group).map(f => controlFor(ctx, deviceField(ctx, d, f), `dev:${d.id}:${idOf(f)}`, v, off)) : [];
    if (group !== 'general' || !d.editable) return controls;
    const hints = {
      bridge: ['The name of the bridge device, usually br-<something>. At most 15 characters; it cannot be changed once saved.', 'br-guest'],
      plain: ['The name of the port or device the settings are for (for example lan1 or eth1). It cannot be changed once saved.', 'lan1'],
    };
    const [hint, placeholder] = hints[d.type] ?? ['The name of the VLAN device, usually base.id (eth1.200). At most 15 characters; it cannot be changed once saved.', 'eth1.200'];
    return [
      d.isNew ? nameControl(ctx, ctx.draft.devAdded.find(a => a.id === d.id), `dev:${d.id}:name`, 'Device name', hint, placeholder, d.type === 'plain' ? (ctx.base.net?.ports ?? []).map(p => p.name) : []) : null,
      d.type === 'bridge' ? portsPicker(ctx, d) : null,
      ...controls,
    ].filter(Boolean);
  };
  const groups = d.editable ? groupBlocks(`dev:${d.id}`, DEVICE_GROUPS, fieldsOf) : [];

  let actions;
  if (off) actions = h('div', { className: 'ne-actions' }, muted(`The device section for ${d.name} is removed when you save.`), button('Undo', 'arrow-clockwise', () => { restoreDevice(ctx.draft, d.id); ctx.touched(); ctx.redraw(); }));
  else if (!d.editable) actions = h('div', { className: 'ne-actions' }, muted(`A device of type ${d.type}. This page does not edit it; its options are shown as they are in the file.`));
  else {
    actions = h('div', { className: 'ne-actions' }, muted(d.isNew ? 'Not saved yet.' : `${type?.label ?? d.type}: the device section for ${d.name}.`),
      h('button', { type: 'button', className: 'btn btn-sm btn-fl', disabled: !ctx.canEdit, title: `Delete the device section ${d.name || ''}`,
        onclick: () => { removeDevice(ctx.draft, d.id); ctx.touched(); ctx.redraw(); } }, icon('trash'), d.isNew ? 'Discard device' : d.type === 'plain' ? 'Remove the settings' : 'Remove device'));
  }

  // A new device is named in the form, so its name is read from the draft each time.
  const nameNow = () => (d.isNew ? ctx.draft.devAdded.find(a => a.id === d.id)?.name ?? d.name : d.name);
  const subNode = h('span', { className: 'sub' }, describeDevice(d, ctx.draft));
  const nameNode = h('span', {}, nameNow() || 'New device');
  ctx.refresh(() => {
    // The card of a device the form has just discarded is still on screen until the redraw.
    if (!ctx.draft.devices[d.id]) return;
    subNode.textContent = describeDevice(d, ctx.draft);
    nameNode.textContent = nameNow() || 'New device';
  });
  const state = d.isNew ? badge('new', 'info', 'not saved yet') : off ? badge('to be removed', 'danger')
    : runtime ? badge(runtime.up ? 'up' : 'down', runtime.up ? 'success' : 'danger') : badge('not present', '', 'The router has no device of this name at the moment');
  const el = card(
    [chevron(), icon(d.type === 'bridge' ? 'diagram-2' : 'ethernet'), nameNode, badge(type?.label ?? d.type, 'info'), state, subNode],
    h('div', { className: `card-body ne-groups${off ? ' ne-removed' : ''}` },
      d.editable ? null : kv(Object.entries(d.raw).map(([k, val]) => [mono(k), mono(Array.isArray(val) ? val.join(', ') : String(val))])),
      actions, groups, d.editable ? extraOptions(d.raw, d.secrets, known, 'device section') : null),
    d.isNew ? 'ne-new' : '');
  return foldCard(el, `dev:${d.id}`, !d.isNew);
}

// The device cards of the types `wanted` accepts, in order.
export const deviceCards = (ctx, wanted) => deviceList(ctx.base, ctx.draft).filter(d => wanted(d)).map(d => deviceCard(ctx, d));

// The row for adding devices: one button per kind in `types` (ids from DEVICE_TYPES).
export function addDeviceBar(ctx, types, text) {
  const buttons = types.map(id => {
    const type = DEVICE_TYPES.find(t => t.id === id);
    const label = id === 'bridge' ? 'Add bridge' : id === 'plain' ? 'Add device settings' : 'Add VLAN device';
    const b = button(label, 'plus-lg', () => { folds.set(`dev:${addDevice(ctx.base, ctx.draft, id)}`, false); ctx.touched(); ctx.redraw(); });
    b.disabled = !ctx.canEdit;
    b.title = type.hint;
    return b;
  });
  return h('div', { className: 'ne-addbar' }, buttons, muted(text));
}

//#endregion

// A heading with its explanation for a group of editing cards.
export function editSection(title, text, ...body) {
  return h('div', { className: 'ne-section' }, h('h3', {}, title), legend([text]), ...body);
}
