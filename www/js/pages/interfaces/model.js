// Pure model of the network editor of the Devices and Interfaces page: the config the plugin reports,
// the form's draft, the review list, validation, the dangerous changes, the UCI operations a save makes and the check after a
// save. No DOM and no network, so it is unit-tested on its own (tests/ifedit/model.test.mjs).
//
// The config is edited through rpcd's `uci` object but read through the flab.network plugin (`config`), which leaves out the
// secrets (a PPPoE password): they are only reported as set (`secrets`), and a secret field of the draft is empty until the user
// types a value; empty means "keep what is stored".
//
// A draft entry is an object of form values keyed by the id of the schema field (see schema.js); a device entry also holds its
// bridge ports as the list `ports`. Sections the page does not know (routes, rules, WireGuard peers, switch VLANs) are never
// read or written.
import { differs, errorsOf, flag, normalize, show, valueOf } from '../../core/fields.js';
import { parseAddress } from '../../core/ip.js';
import { VERIFY, parseCidr, overlaps, subnetOf, subnetText, contains } from './checks.js';
import {
  CONFIG, DEVICE_FIELDS, DEVICE_TYPES, EDITABLE_PROTOS, GLOBALS_FIELDS, IFACE_FIELDS, OTHER_PROTOS, PROTOS, deviceFields, deviceType, editableDevice, idOf, ifaceField, ifaceFields,
} from './schema.js';

export { CONFIG };

// Seconds of the rollback countdown for a network change (longer than the default: a reload of the network takes a while and the
// admin may have to reconnect), and how long to wait after the apply before looking at the router again.
export const APPLY_SECONDS = 90;
export const SETTLE_MS = 4000;

// The names that must not be taken by a new section: they would collide with a section that exists already.
const RESERVED = new Set(['loopback', 'globals']);

// The pseudo field of a bridge's ports: a list of device names.
export const PORTS_FIELD = { key: 'ports', type: 'list', label: 'Ports' };

//#region Reading

// The reply of `flab.network config` as the page's data. `available` is false for a router without the plugin method, a login that
// may not call it, or an answer of another shape (so the page can tell "cannot edit" from "nothing configured"). `globals` is the
// network-wide section as { section, values, secrets }, null when the router has none, and undefined when the plugin does not report it
// (an older plugin), so the page can tell "nothing to edit" from "cannot edit".
export function readNetwork(reply) {
  const available = Array.isArray(reply?.interfaces) && Array.isArray(reply?.devices);
  // The sections of a list as the page keeps them.
  const sections = list => (list ?? []).map(s => ({ section: s.section, anonymous: Boolean(s.anonymous), values: s.values ?? {}, secrets: s.secrets ?? {} }));
  return {
    available,
    interfaces: available ? sections(reply.interfaces).map(s => ({ ...s, name: s.section })) : [],
    devices: available ? sections(reply.devices).map(s => ({ ...s, name: String(s.values.name ?? ''), type: deviceType(s.values.type) })) : [],
    globals: available && reply.globals !== undefined ? (reply.globals ? sections([reply.globals])[0] : null) : undefined,
    other: reply?.other ?? {},
    bridgeVlans: reply?.bridge_vlans ?? [],
  };
}

// The runtime data a page passes in: `net` (flab.network status), `ifs` (netifd's interface dump) and `cfg` (readNetwork). A data
// object without them (an unavailable plugin) still works.
const netOf = data => ({ ports: data.net?.ports ?? [], bridges: data.net?.bridges ?? [], vlans: data.net?.vlans ?? [], zones: data.net?.zones ?? [] });

// The devices the router has, by name, as { kind, up?, label }: Ethernet ports, bridges and their members, VLAN devices, the devices netifd
// reports for its interfaces and the loopback. A swconfig switch port is not a device (its VLAN device is), and the conduit of a DSA
// switch is one but not a place to attach a bridge port.
export function runtimeDevices(data) {
  const { ports, bridges, vlans } = netOf(data);
  const out = new Map([['lo', { kind: 'loopback', label: 'loopback' }]]);
  for (const p of ports) if (p.type !== 'swconfig') out.set(p.name, { kind: p.role === 'conduit' ? 'conduit' : 'port', up: p.carrier, label: p.role === 'conduit' ? 'CPU link' : 'port' });
  for (const v of vlans) out.set(v.name, { kind: 'vlan', up: v.up, label: `VLAN ${v.vid} on ${v.parent}` });
  for (const b of bridges) {
    out.set(b.name, { kind: 'bridge', up: b.up, label: 'bridge' });
    for (const m of b.members ?? []) if (!out.has(m.name)) out.set(m.name, { kind: m.kind === 'wifi' ? 'wifi' : 'port', up: m.carrier, label: m.kind === 'wifi' ? 'Wi-Fi' : 'port' });
  }
  for (const i of data.ifs ?? []) {
    if (i.device && !out.has(i.device)) out.set(i.device, { kind: 'device', label: 'device' });
    // The device a protocol creates (pppoe-wan, wg0) exists, but another interface reaches it with "@name", not by its name.
    if (i.l3_device && !out.has(i.l3_device)) out.set(i.l3_device, { kind: 'protocol', label: `device of the interface ${i.interface}` });
  }
  return out;
}

//#endregion

//#region The form

// The form values of a list of fields from a section's options. `fieldOf` gives the field as it reads for the section (its defaults).
const valuesOf = (fields, raw, fieldOf = f => f) => Object.fromEntries(fields.map(f => [idOf(f), valueOf(fieldOf(f), raw[f.key])]));

// The form values of an interface section for its protocol.
const ifaceValues = raw => valuesOf(IFACE_FIELDS, raw, f => ifaceField(f, raw.proto ?? ''));
// The form values of a device section: the options for its type and the bridge ports.
const deviceValues = (raw, type) => ({ ...valuesOf(deviceFields(type), raw), ports: valueOf(PORTS_FIELD, raw.ports) });

// The form's starting values: the router's current values. A section added in the form gets an id of its own (`new1`, ...) because its
// name is typed into the form and may change until it is saved. `globals` holds the network-wide options, or null when the plugin does not report them.
export const draftFrom = data => ({
  ifaces: Object.fromEntries(data.cfg.interfaces.map(s => [s.section, ifaceValues(s.values)])),
  devices: Object.fromEntries(data.cfg.devices.map(s => [s.section, deviceValues(s.values, s.type)])),
  globals: data.cfg.globals === undefined ? null : valuesOf(GLOBALS_FIELDS, data.cfg.globals?.values ?? {}),
  ifaceAdded: [],
  ifaceRemoved: {},
  devAdded: [],
  devRemoved: {},
  next: 1,
});

// The interfaces the form shows, in order: the router's, then the ones added in the form. Each has an `id` (the section name or `new1`...),
// its `name`, `isNew`, `removed`, the options of the section as `raw` and which secrets are `secrets`. `editable` is false for an
// interface whose protocol the page does not edit.
export function ifaceList(data, draft) {
  return [
    ...data.cfg.interfaces.map(s => ({ id: s.section, name: s.name, isNew: false, removed: Boolean(draft.ifaceRemoved[s.section]), raw: s.values, secrets: s.secrets,
      editable: s.values.proto === undefined || EDITABLE_PROTOS.includes(s.values.proto) })),
    ...draft.ifaceAdded.map(a => ({ id: a.id, name: a.name, isNew: true, removed: false, raw: {}, secrets: {}, editable: true })),
  ];
}

// The device sections the form shows, in order, like ifaceList; `type` is 'bridge', '8021q', '8021ad', 'plain' or another type's name.
export function deviceList(data, draft) {
  return [
    ...data.cfg.devices.map(s => ({ id: s.section, name: s.name, type: s.type, isNew: false, removed: Boolean(draft.devRemoved[s.section]), raw: s.values, secrets: s.secrets, editable: editableDevice(s.type) })),
    ...draft.devAdded.map(a => ({ id: a.id, name: a.name, type: a.type, isNew: true, removed: false, raw: {}, secrets: {}, editable: true })),
  ];
}

// The protocol an interface has in the form (what the draft says now).
export const protoOf = (draft, id) => draft.ifaces[id].proto;

// Changes the protocol of an interface in the draft. A value that follows the protocol's default (auto, force_link) while the router has
// no option for it follows the new protocol; an `ipv6` choice the new protocol does not offer goes back to the default.
export function setProto(data, draft, id, proto) {
  const values = draft.ifaces[id];
  const raw = ifaceList(data, draft).find(s => s.id === id)?.raw ?? {};
  const old = values.proto;
  values.proto = proto;
  for (const f of IFACE_FIELDS) {
    if (f.type !== 'bool' || raw[f.key] !== undefined) continue;
    const was = ifaceField(f, old).default ?? false, now = ifaceField(f, proto).default ?? false;
    if (values[idOf(f)] === was) values[idOf(f)] = now;
  }
  const ipv6 = ifaceField(IFACE_FIELDS.find(f => f.key === 'ipv6'), proto);
  if (values.ipv6 !== '' && !ipv6.options.includes(values.ipv6)) values.ipv6 = '';
}

// The names taken in the config by a section of any kind the page knows: logical interfaces and named device sections.
const takenSections = (data, draft, exceptId) => new Set([...RESERVED, ...data.cfg.interfaces.map(s => s.section), ...data.cfg.devices.filter(s => !s.anonymous).map(s => s.section),
  ...draft.ifaceAdded.filter(a => a.id !== exceptId).map(a => a.name.trim())]);

// Adds an interface to the draft and returns its id. It starts as a static interface with the default settings.
export function addInterface(data, draft) {
  const id = `new${draft.next++}`;
  const taken = takenSections(data, draft, null);
  let name = 'network1';
  for (let n = 2; taken.has(name); n++) name = `network${n}`;
  draft.ifaceAdded.push({ id, name });
  draft.ifaces[id] = ifaceValues({ proto: 'static' });
  // One empty address row, so the form shows where to type.
  draft.ifaces[id].ipaddr = [''];
  return id;
}

// Marks an interface for removal, or drops it when it was only added in the form.
export function removeInterface(draft, id) {
  const i = draft.ifaceAdded.findIndex(a => a.id === id);
  if (i < 0) { draft.ifaceRemoved[id] = true; return; }
  draft.ifaceAdded.splice(i, 1);
  delete draft.ifaces[id];
}

// Takes an interface back from removal.
export function restoreInterface(draft, id) {
  delete draft.ifaceRemoved[id];
}

// Adds a device of a type ('bridge', '8021q', '8021ad' or 'plain') to the draft and returns its id. A bridge gets a free name; a VLAN
// device is named after its base device and ID once they are chosen (the name stays the user's to change).
export function addDevice(data, draft, type) {
  const id = `new${draft.next++}`;
  const taken = new Set([...runtimeDevices(data).keys(), ...deviceList(data, draft).map(d => d.name.trim())]);
  const stem = type === 'bridge' ? 'br-new' : type === 'plain' ? '' : 'vlan';
  let name = stem;
  if (stem) for (let n = 2; taken.has(name); n++) name = `${stem}${n}`;
  draft.devAdded.push({ id, name, type });
  draft.devices[id] = deviceValues({}, type);
  return id;
}

// Marks a device section for removal, or drops it when it was only added in the form.
export function removeDevice(draft, id) {
  const i = draft.devAdded.findIndex(a => a.id === id);
  if (i < 0) { draft.devRemoved[id] = true; return; }
  draft.devAdded.splice(i, 1);
  delete draft.devices[id];
}

// Takes a device section back from removal.
export function restoreDevice(draft, id) {
  delete draft.devRemoved[id];
}

//#endregion

//#region Choices

// The bridges of the form that are not removed, as device entries.
const formBridges = (data, draft) => deviceList(data, draft).filter(d => d.type === 'bridge' && !d.removed);

// The devices a logical interface or a VLAN device may sit on, as [{ name, label }] in a sensible order: the bridges (those of the form
// too), ports, VLAN devices (those of the form too), then the other devices the router reports. A bridge or VLAN device that the form removes is
// left out; one that it adds is in. Wi-Fi interfaces (they join a bridge through the wireless config) and the devices protocols create are not offered.
export function deviceChoices(data, draft) {
  const runtime = runtimeDevices(data);
  const removed = new Set(deviceList(data, draft).filter(d => d.removed).map(d => d.name));
  const out = new Map();
  // Adds one choice unless it is there or the form removes it.
  const put = (name, label) => { if (name && !out.has(name) && !removed.has(name)) out.set(name, label); };
  for (const d of deviceList(data, draft)) if (d.type === 'bridge' && !d.removed && d.name.trim()) put(d.name.trim(), 'bridge');
  for (const [name, d] of runtime) if (d.kind === 'bridge') put(name, 'bridge');
  for (const [name, d] of runtime) if (d.kind === 'port') put(name, d.label);
  for (const d of deviceList(data, draft)) if ((d.type === '8021q' || d.type === '8021ad') && !d.removed && d.name.trim()) put(d.name.trim(), `VLAN ${draft.devices[d.id]?.vid || '?'}`);
  for (const [name, d] of runtime) if (!['bridge', 'port', 'loopback', 'wifi', 'conduit', 'protocol'].includes(d.kind)) put(name, d.label);
  for (const [name, d] of runtime) if (d.kind === 'conduit') put(name, d.label);
  return [...out].map(([name, label]) => ({ name, label }));
}

// The devices a logical interface may borrow with "@name": the other interfaces that the form keeps.
export const aliasChoices = (data, draft, exceptId) => ifaceList(data, draft).filter(s => !s.removed && s.id !== exceptId && s.name.trim() && s.name !== 'loopback').map(s => s.name.trim());

// The devices a bridge may take as ports, as [{ name, label, up }]: Ethernet ports the router has (not the DSA conduit and not the ports of a
// swconfig switch, which are not devices), VLAN devices (those of the form too), and nothing that is a bridge.
export function portChoices(data, draft, bridge = '') {
  const runtime = runtimeDevices(data);
  const removed = new Set(deviceList(data, draft).filter(d => d.removed).map(d => d.name));
  const parentOf = new Map((data.net?.vlans ?? []).map(v => [v.name, v.parent]));
  const out = new Map();
  for (const [name, d] of runtime) if (d.kind === 'port' && !removed.has(name)) out.set(name, { name, label: d.label, up: d.up });
  // A VLAN device that sits on the bridge itself cannot be one of its ports.
  for (const [name, d] of runtime) if (d.kind === 'vlan' && !removed.has(name) && parentOf.get(name) !== bridge) out.set(name, { name, label: d.label, up: d.up });
  for (const d of deviceList(data, draft)) {
    const v = draft.devices[d.id];
    if ((d.type === '8021q' || d.type === '8021ad') && !d.removed && d.name.trim() && !out.has(d.name.trim()) && v?.ifname !== bridge) out.set(d.name.trim(), { name: d.name.trim(), label: `VLAN ${v?.vid || '?'} on ${v?.ifname || '?'} (new)`, up: null });
  }
  return [...out.values()];
}

// Which bridge of the form holds each port, as Map(port name -> [bridge entries]); a correct form has one bridge per port.
export function portOwners(data, draft) {
  const owners = new Map();
  for (const b of formBridges(data, draft)) for (const p of draft.devices[b.id].ports.map(x => x.trim()).filter(Boolean)) owners.set(p, [...(owners.get(p) ?? []), b]);
  return owners;
}

// Moves a port into a bridge of the form (and out of the other bridges that hold it), or takes it out.
export function setPort(data, draft, bridgeId, port, member) {
  const ports = draft.devices[bridgeId].ports;
  if (!member) { draft.devices[bridgeId].ports = ports.filter(p => p.trim() !== port); return; }
  for (const b of formBridges(data, draft)) if (b.id !== bridgeId) draft.devices[b.id].ports = draft.devices[b.id].ports.filter(p => p.trim() !== port);
  if (!ports.some(p => p.trim() === port)) ports.push(port);
}

//#endregion

//#region Comparing

// The fields of an interface that apply to a protocol, as they read for it.
const ifaceFieldsFor = proto => ifaceFields(proto);

// The raw options an interface section has, with the secrets as a marker the option exists.
const hasOption = (s, key) => s.raw[key] !== undefined || Boolean(s.secrets[key]);

// What saving would do to one interface section: { set, del, lines } where `set` is { option: value }, `del` the options to delete (the
// ones of the old protocol too) and `lines` the review lines { label, from, to }. A section added in the form has every non-default
// value in `set`.
function diffInterface(s, draft) {
  const values = draft.ifaces[s.id];
  const proto = values.proto;
  const oldProto = s.isNew ? proto : (s.raw.proto ?? '');
  const fields = ifaceFieldsFor(proto);
  const ids = new Set(fields.map(idOf));
  // The options that belonged to the old protocol only: they are removed, because they would mean something else (or nothing) now.
  const stale = new Set(s.isNew || oldProto === proto ? [] : IFACE_FIELDS.filter(f => (!f.protos || f.protos.includes(oldProto)) && !ids.has(idOf(f)) && f.key !== 'proto').map(f => f.key));
  const set = {}, del = [], lines = [];
  for (const f of fields) {
    const label = `${s.name || 'New interface'}: ${f.label}`;
    const to = normalize(f, values[idOf(f)]);
    if (f.secret) {
      if (to !== '') { set[f.key] = to; lines.push({ key: `if:${s.id}:${idOf(f)}`, label, from: s.secrets[f.key] ? 'stored value (hidden)' : 'not set', to: 'new value (hidden)' }); }
      continue;
    }
    const from = normalize(f, stale.has(f.key) ? valueOf(f, undefined) : valueOf(f, s.raw[f.key]));
    if (s.isNew && f.key === 'proto') { set.proto = to; continue; }
    if (!differs(f, from, to)) continue;
    lines.push({ key: `if:${s.id}:${idOf(f)}`, label, from: show(f, from), to: show(f, to) });
    if (f.type === 'bool') set[f.key] = flag(to);
    else if (to.length === 0) { if (hasOption(s, f.key) && !stale.has(f.key)) del.push(f.key); }
    else set[f.key] = to;
  }
  for (const key of stale) if (hasOption(s, key)) del.push(key);
  if (stale.size) {
    const removed = [...stale].filter(k => hasOption(s, k));
    if (removed.length) lines.push({ key: `if:${s.id}:proto`, label: `${s.name}: options of ${oldProto || 'the old protocol'}`, from: removed.join(', '), to: 'removed' });
  }
  return { set, del, lines };
}

// What saving would do to the network-wide section: { set, del, lines } like diffInterface. `lines` carry the key `gl:<option>`. Nothing without a draft of it.
function diffGlobals(data, draft) {
  const set = {}, del = [], lines = [];
  const raw = data.cfg.globals?.values ?? {};
  if (!draft.globals) return { set, del, lines };
  for (const f of GLOBALS_FIELDS) {
    const to = normalize(f, draft.globals[idOf(f)]);
    const from = normalize(f, valueOf(f, raw[f.key]));
    if (!differs(f, from, to)) continue;
    lines.push({ key: `gl:${idOf(f)}`, label: `Network-wide: ${f.label}`, from: show(f, from), to: show(f, to) });
    if (f.type === 'bool') set[f.key] = flag(to);
    else if (to.length === 0) { if (raw[f.key] !== undefined) del.push(f.key); }
    else set[f.key] = to;
  }
  return { set, del, lines };
}

// What saving would do to one device section, like diffInterface. A new section writes its name and type as well.
function diffDevice(s, draft) {
  const values = draft.devices[s.id];
  const fields = [...deviceFields(s.type), ...(s.type === 'bridge' ? [PORTS_FIELD] : [])];
  const set = {}, del = [], lines = [];
  for (const f of fields) {
    const label = `${s.name || 'New device'}: ${f.label}`;
    const to = normalize(f, values[idOf(f)]);
    const from = normalize(f, valueOf(f, s.raw[f.key]));
    if (!differs(f, from, to)) continue;
    lines.push({ key: `dev:${s.id}:${idOf(f)}`, label, from: show(f, from), to: show(f, to) });
    if (f.type === 'bool') set[f.key] = flag(to);
    else if (to.length === 0) { if (s.raw[f.key] !== undefined) del.push(f.key); }
    else set[f.key] = to;
  }
  return { set, del, lines };
}

// The review list of the draft: [{ key, label, from, to }] in the order of the page (devices, then interfaces). A section added in the form
// is one line that says so, followed by the settings that are not the defaults.
export function changesOf(data, draft) {
  const out = [];
  for (const d of deviceList(data, draft)) {
    const kind = (DEVICE_TYPES.find(t => t.id === d.type)?.label ?? `${d.type} device`).toLowerCase();
    // What the section is called in a sentence: "bridge br-guest", "settings of device lan1".
    const what = d.type === 'plain' ? `settings of device ${d.name.trim() || '(unnamed)'}` : `${kind} ${d.name.trim() || '(unnamed)'}`;
    if (d.removed) out.push({ key: `dev:${d.id}`, label: `Remove ${d.type === 'plain' ? `settings of device ${d.name}` : `${kind} ${d.name}`}`, from: d.type === 'bridge' ? `ports ${valueOf(PORTS_FIELD, d.raw.ports).join(', ') || 'none'}` : 'configured', to: 'removed' });
    else if (d.isNew) out.push({ key: `dev:${d.id}`, label: `Add ${what}`, from: 'none', to: 'new' }, ...diffDevice(d, draft).lines);
    else if (d.editable) out.push(...diffDevice(d, draft).lines);
  }
  for (const s of ifaceList(data, draft)) {
    if (s.removed) out.push({ key: `if:${s.id}`, label: `Remove interface ${s.name}`, from: s.raw.proto ?? 'configured', to: 'removed' });
    else if (s.isNew) out.push({ key: `if:${s.id}`, label: `Add interface ${s.name.trim() || '(unnamed)'}`, from: 'none', to: `new (${draft.ifaces[s.id].proto || 'no protocol'})` }, ...diffInterface(s, draft).lines);
    else if (s.editable) out.push(...diffInterface(s, draft).lines);
  }
  out.push(...diffGlobals(data, draft).lines);
  return out;
}

// Whether the draft differs from the router in any way.
export const isDirty = (data, draft) => changesOf(data, draft).length > 0;

//#endregion

//#region Validation

// The words that name an interface for the person reading a message.
const ifaceTitle = s => (s.name.trim() ? s.name.trim() : 'New interface');
// The same for a device.
const deviceTitle = d => (d.name.trim() ? d.name.trim() : 'New device');

// The errors of one field's draft value, with the field's own check (checks.js) after the shared type checks (core/fields.js).
// A field filled in from the router's lists (a device) has no fixed set of values for the shared check.
function fieldErrors(f, value, label) {
  const out = f.dynamic ? [] : errorsOf(f, value, label);
  const check = f.verify ? VERIFY[f.verify] : null;
  if (check) {
    const items = f.type === 'list' ? value.map((raw, index) => ({ v: raw.trim(), index })) : [{ v: normalize(f, value), index: undefined }];
    for (const { v, index } of items) {
      const bad = v ? check(v) : null;
      if (bad) out.push({ index, text: f.type === 'list' ? `${label}: "${v}" ${bad}.` : `${label} ${bad}.` });
    }
  }
  return out;
}

// The valid name of a section or device: letters, digits, underscore (and dash, dot for a device) within the 15 characters a kernel interface name has.
function nameErrors(name, kind) {
  if (!name) return `give the ${kind} a name.`;
  if (kind === 'interface' ? !/^[A-Za-z0-9_]+$/.test(name) : !/^[A-Za-z0-9_.:-]+$/.test(name)) {
    return kind === 'interface' ? 'the name may only contain letters, digits and underscores.' : 'the name may only contain letters, digits and _ . : -.';
  }
  if (name.length > 15) return 'the name may have at most 15 characters (the limit of a Linux network device name).';
  return null;
}

// The addresses of a static interface in the form, as { v4: [{ text, cidr }], v6: [...] }; an address without a prefix has none.
function addressesOfForm(values) {
  const out = { v4: [], v6: [] };
  const netmask = values.netmask.trim();
  for (const raw of values.ipaddr) {
    const text = raw.trim(), cidr = text ? parseCidr(text, netmask) : null;
    if (cidr?.family === 4) out.v4.push({ text, cidr });
  }
  for (const raw of values.ip6addr) {
    const text = raw.trim(), cidr = text ? parseCidr(text) : null;
    if (cidr?.family === 6) out.v6.push({ text, cidr });
  }
  return out;
}

// Whether an interface of the form installs an IPv4 default route, and its metric: a static one with a gateway, or a client that takes the
// provider's (unless `defaultroute` is off).
function defaultRoute(values) {
  const proto = values.proto;
  const wants = proto === 'static' ? values.gateway.trim() !== '' : proto === 'dhcp' ? values.defaultroute : proto === 'pppoe' ? values.defaultroute : false;
  return wants && !values.disabled ? (values.metric.trim() === '' ? 0 : +values.metric) : null;
}

// The device an interface of the form is bound to, following "@name" to the interface it borrows from.
function deviceOfInterface(data, draft, s, seen = new Set()) {
  const dev = draft.ifaces[s.id].device.trim();
  if (!dev.startsWith('@') || seen.has(s.id)) return dev;
  seen.add(s.id);
  const other = ifaceList(data, draft).find(x => !x.removed && x.name === dev.slice(1));
  return other ? deviceOfInterface(data, draft, other, seen) : '';
}

// The errors and warnings of the draft: { errors: [{ key, text, index?, also? }], warnings: [text] }. `key` names the control that holds the mistake
// (the same name the page registers it under), so the page can mark it and open the group it is in. Hidden options are not validated.
export function problems(data, draft) {
  const errors = [], warnings = [];
  const runtime = runtimeDevices(data);
  const ifaces = ifaceList(data, draft);
  const devices = deviceList(data, draft);
  const keptIfaces = ifaces.filter(s => !s.removed);
  const keptDevices = devices.filter(d => !d.removed);
  const removedDevices = new Set(devices.filter(d => d.removed).map(d => d.name));
  const formDeviceNames = new Set(keptDevices.filter(d => d.name.trim()).map(d => d.name.trim()));

  // Whether a device name exists now or will exist after the save.
  const deviceKnown = name => (runtime.has(name) || formDeviceNames.has(name)) && !removedDevices.has(name);

  //#region Interfaces
  for (const s of keptIfaces) {
    const v = draft.ifaces[s.id];
    const title = ifaceTitle(s);
    // Adds an error against the control of field `key` of this interface.
    const err = (key, text, extra = {}) => errors.push({ key: `if:${s.id}:${key}`, text: `${title}: ${text}`, ...extra });
    // Records a warning on this interface, prefixed with its name.
    const warn = text => warnings.push(`${title}: ${text}`);
    if (!s.editable) continue;

    if (s.isNew) {
      const name = s.name.trim();
      const bad = nameErrors(name, 'interface');
      if (bad) err('name', bad);
      else if (takenSections(data, draft, s.id).has(name)) err('name', `there is already a section called "${name}".`);
      else if (v.proto === 'pppoe' && `pppoe-${name}`.length > 15) err('name', `the PPPoE device would be called pppoe-${name}, which is over the 15 characters of a device name; use a name of at most 9.`);
    } else if (v.proto === 'pppoe' && `pppoe-${s.name}`.length > 15) warn(`the PPPoE device pppoe-${s.name} is over the 15 characters of a device name.`);

    const proto = v.proto;
    for (const f of ifaceFields(proto, v)) for (const e of fieldErrors(f, v[idOf(f)], `${title}: ${f.label}`)) errors.push({ ...e, key: `if:${s.id}:${idOf(f)}` });
    if (proto === '') warn('no protocol is set, so netifd ignores this interface.');

    // The device.
    const dev = v.device.trim();
    const wasDevice = (s.raw.device ?? '').trim();
    if (dev.startsWith('@')) {
      if (!aliasChoices(data, draft, s.id).includes(dev.slice(1))) err('device', `the interface ${dev.slice(1)} does not exist (or is removed).`);
    } else if (dev && !deviceKnown(dev) && !removedDevices.has(dev)) {
      if (dev === wasDevice) warn(`the device ${dev} does not exist on the router at the moment.`);
      else err('device', `the device ${dev} does not exist on the router.`);
    } else if (dev && runtime.get(dev)?.kind === 'port' && formBridges(data, draft).some(b => draft.devices[b.id].ports.some(p => p.trim() === dev))) {
      warn(`the device ${dev} is a port of a bridge, so the interface would bypass the bridge; bind it to the bridge instead.`);
    }
    if (proto === 'pppoe' && !dev) err('device', 'PPPoE needs the device (usually a port or VLAN device) that reaches the provider.');
    if ((proto === 'dhcp' || proto === 'dhcpv6') && !dev) warn('no device is set; this is only right for an interface that a Wi-Fi network uses.');

    // The addresses of a static interface.
    if (proto === 'static') {
      const addrs = addressesOfForm(v);
      const hasNetmask = v.netmask.trim() !== '' && VERIFY.netmask(v.netmask.trim()) === null;
      v.ipaddr.forEach((raw, index) => {
        const text = raw.trim(), cidr = text ? parseCidr(text) : null;
        if (cidr?.family === 4 && !cidr.hasPrefix && !hasNetmask) err('ipaddr', `"${text}" has no prefix length and there is no netmask: write it as ${text}/24 or fill in the netmask.`, { index });
      });
      const v4 = addrs.v4.filter(a => a.cidr.hasPrefix);
      const gateway = v.gateway.trim();
      if (gateway && VERIFY.ip4(gateway) === null && v4.length) {
        const g = parseAddress(gateway).value;
        const nets = v4.map(a => subnetOf(a.cidr));
        if (v4.some(a => a.cidr.value === g)) err('gateway', `the gateway ${gateway} is the address of the interface itself.`);
        else if (!nets.some(n => n.prefix === 32 || contains(n, g))) err('gateway', `the gateway ${gateway} is outside the interface's subnet (${nets.map(subnetText).join(', ')}), so the router could not reach it.`);
      }
      if (gateway && !addrs.v4.length) warn('a gateway needs an IPv4 address on the same subnet.');
      if (v.ip6gw.trim() && !addrs.v6.length && v.ip6assign === '') warn('an IPv6 gateway is set but the interface has no IPv6 address.');
      if (!v.ipaddr.some(x => x.trim()) && !v.ip6addr.some(x => x.trim()) && v.ip6assign === '') warn('a static interface needs an address (or an IPv6 prefix to delegate to it).');
    }
    // The MTU and IPv6.
    const mtu = v.mtu.trim();
    if (mtu && /^\d+$/.test(mtu) && +mtu < 1280 && v.ipv6 !== '0') warn(`an MTU of ${mtu} is below the 1280 bytes IPv6 needs; disable IPv6 on the interface or raise the MTU.`);
    if (proto === 'pppoe') {
      if (!v.username.trim() && !s.raw.username) warn('PPPoE has no username.');
      if (!v.password && !s.secrets.password) warn('no PPPoE password is stored; type one or the provider will refuse the login.');
      if (mtu && /^\d+$/.test(mtu) && +mtu > 1492) warn(`a PPPoE link carries 8 bytes of overhead on a 1500 byte Ethernet frame, so an MTU above 1492 (${mtu}) will not pass.`);
    }
    if (v.ip6assign !== '' && /^\d+$/.test(v.ip6assign) && +v.ip6assign > 64) warn(`a delegated prefix longer than /64 (${v.ip6assign}) cannot be used for SLAAC addressing by the clients.`);
  }

  // Two interfaces on the same subnet or with the same address (static interfaces that are not disabled).
  const statics = keptIfaces.filter(s => s.editable && s.name !== 'loopback' && draft.ifaces[s.id].proto === 'static' && !draft.ifaces[s.id].disabled);
  for (let i = 0; i < statics.length; i++) {
    for (let j = i + 1; j < statics.length; j++) {
      const a = statics[i], b = statics[j];
      const A = addressesOfForm(draft.ifaces[a.id]), B = addressesOfForm(draft.ifaces[b.id]);
      for (const [family, key] of [['v4', 'ipaddr'], ['v6', 'ip6addr']]) {
        for (const x of A[family]) {
          for (const y of B[family]) {
            // The error is on the row of the address in the second interface, and marks the first interface's field too.
            const at = { key: `if:${b.id}:${key}`, also: `if:${a.id}:${key}`, index: draft.ifaces[b.id][key].findIndex(t => t.trim() === y.text) };
            if (x.cidr.value === y.cidr.value) {
              errors.push({ ...at, text: `${ifaceTitle(b)}: the address ${y.text} is also used by ${ifaceTitle(a)}.` });
              continue;
            }
            const sx = subnetOf(x.cidr), sy = subnetOf(y.cidr);
            if (!sx || !sy) continue;
            if (sx.network === sy.network && sx.prefix === sy.prefix) errors.push({ ...at, text: `${ifaceTitle(b)} and ${ifaceTitle(a)} are on the same subnet ${subnetText(sx)}; the router could not tell which one to use.` });
            else if (overlaps(sx, sy)) warnings.push(`${ifaceTitle(b)} (${subnetText(sy)}) overlaps ${ifaceTitle(a)} (${subnetText(sx)}); routes to the smaller subnet win, and the larger one hides part of the network.`);
          }
        }
      }
    }
  }
  // Two interfaces with the same default route metric.
  const routes = keptIfaces.filter(s => s.editable).map(s => ({ s, metric: defaultRoute(draft.ifaces[s.id]) })).filter(r => r.metric !== null);
  const byMetric = new Map();
  for (const r of routes) byMetric.set(r.metric, [...(byMetric.get(r.metric) ?? []), r.s]);
  for (const [metric, list] of byMetric) if (list.length > 1) warnings.push(`${list.map(ifaceTitle).join(' and ')} both install a default route with metric ${metric}; give them different metrics to choose which is used.`);
  // An interface that borrows the device of an interface the form removes.
  for (const s of keptIfaces) {
    const dev = draft.ifaces[s.id].device.trim();
    const target = dev.startsWith('@') ? ifaces.find(x => x.name === dev.slice(1)) : null;
    if (target?.removed) errors.push({ key: `if:${s.id}:device`, text: `${ifaceTitle(s)}: the interface ${target.name} it borrows its device from is removed in this form.` });
  }
  //#endregion

  //#region Devices
  const byDeviceName = new Map();
  const vlanKeys = new Map();
  for (const d of keptDevices) {
    const v = draft.devices[d.id];
    const title = deviceTitle(d);
    // Adds an error against the control of field `key` of this device.
    const err = (key, text, extra = {}) => errors.push({ key: `dev:${d.id}:${key}`, text: `${title}: ${text}`, ...extra });
    // Records a warning on this device, prefixed with its name.
    const warn = text => warnings.push(`${title}: ${text}`);
    if (!d.editable) continue;
    const name = d.name.trim();

    if (d.isNew) {
      const bad = nameErrors(name, 'device');
      // A plain device section names a device the router already has; a bridge or VLAN device creates a new one.
      const taken = d.type === 'plain' ? data.cfg.devices.some(x => x.name === name) : runtime.has(name) || data.cfg.devices.some(x => x.name === name);
      if (bad) err('name', bad);
      else if (taken || byDeviceName.has(name)) err('name', `there is already a device called "${name}"${d.type === 'plain' ? ' with its own settings' : ''}.`);
    }
    byDeviceName.set(name, d);

    for (const f of deviceFields(d.type)) for (const e of fieldErrors(f, v[idOf(f)], `${title}: ${f.label}`)) errors.push({ ...e, key: `dev:${d.id}:${idOf(f)}` });

    if (d.type === 'bridge') {
      const ports = v.ports.map(p => p.trim());
      const seen = new Set();
      v.ports.forEach((raw, index) => {
        const p = raw.trim();
        if (!p) return;
        if (!/^[A-Za-z0-9_.:-]+$/.test(p) || p.length > 15) err('ports', `"${p}" is not a device name.`, { index });
        else if (p === name) err('ports', `a bridge cannot be its own port.`, { index });
        else if (seen.has(p)) err('ports', `${p} is listed twice.`, { index });
        else if (removedDevices.has(p)) err('ports', `${p} is a device that this form removes.`, { index });
        else if (runtime.get(p)?.kind === 'bridge' || (formBridges(data, draft).some(b => b.name.trim() === p))) err('ports', `${p} is a bridge; a bridge cannot be the port of another.`, { index });
        else if (runtime.get(p)?.kind === 'conduit') warn(`${p} is the link between the CPU and the switch; it is not a port to bridge.`);
        else if (!deviceKnown(p)) {
          if (valueOf(PORTS_FIELD, d.raw.ports).includes(p)) warn(`the port ${p} does not exist on the router at the moment.`);
          else err('ports', `${p} is not a device of the router.`, { index });
        }
        seen.add(p);
      });
      // A port can be in one bridge only.
      for (const p of ports.filter(Boolean)) {
        const owners = portOwners(data, draft).get(p) ?? [];
        if (owners.length > 1 && owners[0].id !== d.id) err('ports', `${p} is also a port of ${owners[0].name.trim() || 'another bridge'}; a port can be in one bridge only.`, { also: `dev:${owners[0].id}:ports` });
      }
      if (!ports.some(Boolean) && !v.bridge_empty) warn('the bridge has no ports; unless Wi-Fi networks join it, it is not created (switch on "Keep the bridge without ports" to keep it).');
      const qi = v.query_interval.trim() === '' ? 12500 : +v.query_interval, qr = v.query_response_interval.trim() === '' ? 1000 : +v.query_response_interval;
      if (/^\d+$/.test(String(qi)) && /^\d+$/.test(String(qr)) && qr >= qi && (v.query_interval.trim() || v.query_response_interval.trim())) err('query_response_interval', `the query response interval (${qr}) must be below the query interval (${qi}).`);
      if (v.stp && /^\d+$/.test(v.forward_delay.trim()) && +v.forward_delay.trim() < 4) warn('with spanning tree on, a forward delay below 4 seconds is below the 802.1D minimum and other vendors\' switches ignore the protocol.');
    }
    if (d.type === '8021q' || d.type === '8021ad') {
      const parent = v.ifname.trim();
      if (!parent) err('ifname', 'choose the base device.');
      else if (!deviceKnown(parent)) err('ifname', `the base device ${parent} does not exist on the router.`);
      else if (parent === name) err('ifname', 'a VLAN device cannot sit on itself.');
      if (!v.vid.trim()) err('vid', 'enter the VLAN ID.');
      if (parent && v.vid.trim()) {
        const key = `${d.type}|${parent}|${+v.vid}`;
        if (vlanKeys.has(key)) err('vid', `${vlanKeys.get(key)} already is VLAN ${+v.vid} on ${parent}.`);
        else vlanKeys.set(key, title);
      }
    }
    if (d.type === 'plain' && d.isNew) {
      if (name && !deviceKnown(name) && !data.cfg.devices.some(x => x.name === name)) warn(`the device ${name} does not exist on the router at the moment.`);
    }
  }
  // The same MAC address on two devices.
  const macs = new Map();
  for (const d of keptDevices.filter(x => x.editable)) {
    const mac = draft.devices[d.id].macaddr.trim().toLowerCase();
    if (!mac || VERIFY.mac(mac) !== null) continue;
    if (macs.has(mac)) warnings.push(`${deviceTitle(d)} and ${deviceTitle(macs.get(mac))} have the same MAC address ${mac}.`);
    else macs.set(mac, d);
  }
  // A device the form removes must not be in use.
  for (const d of devices.filter(x => x.removed)) {
    for (const s of keptIfaces) {
      if (deviceOfInterface(data, draft, s) === d.name) errors.push({ key: `if:${s.id}:device`, text: `${ifaceTitle(s)}: the device ${d.name} it runs on is removed in this form; bind the interface to another device or remove it too.` });
    }
    for (const o of keptDevices) {
      if ((o.type === '8021q' || o.type === '8021ad') && draft.devices[o.id].ifname.trim() === d.name) errors.push({ key: `dev:${o.id}:ifname`, text: `${deviceTitle(o)}: the base device ${d.name} is removed in this form.` });
    }
  }
  //#endregion

  //#region Network-wide settings
  if (draft.globals) {
    for (const f of GLOBALS_FIELDS) for (const e of fieldErrors(f, draft.globals[idOf(f)], `Network-wide: ${f.label}`)) errors.push({ ...e, key: `gl:${idOf(f)}` });
    const ula = GLOBALS_FIELDS.find(f => f.key === 'ula_prefix');
    const was = normalize(ula, valueOf(ula, data.cfg.globals?.values.ula_prefix)), now = normalize(ula, draft.globals.ula_prefix);
    if (was !== now && was !== '' && now === '') warnings.push('Network-wide: without a ULA prefix, interfaces with a delegated prefix length (ip6assign) have only the prefix the provider delegates, so local IPv6 stops working when the provider\'s prefix is gone.');
    else if (was !== now && was !== '' && VERIFY.ula(now) === null) warnings.push(`Network-wide: changing the ULA prefix from ${was} to ${now} renumbers the local IPv6 addresses of every interface that takes a part of it; clients get new addresses and anything that used the old ones (firewall rules, DNS records) stops matching.`);
  }
  //#endregion

  return { errors, warnings: [...warnings, ...risksOf(data, draft)] };
}

//#endregion

//#region Dangerous changes

// The interfaces (names) the admin is most likely connected through: the one called lan and the ones in a firewall zone that accepts input
// and does not translate addresses, which is how a management network looks. Taken from the router's current state.
export function managementInterfaces(data) {
  const names = new Set(data.cfg.interfaces.filter(s => s.name === 'lan').map(s => s.name));
  for (const z of netOf(data).zones) if (z.input === 'ACCEPT' && !z.masq) for (const n of z.networks ?? []) if (data.cfg.interfaces.some(s => s.name === n)) names.add(n);
  return names;
}

// The device an interface of the router's config is bound to, following an "@name" alias.
function baseDevice(data, name, seen = new Set()) {
  const s = data.cfg.interfaces.find(x => x.name === name);
  const dev = String(s?.values.device ?? '').trim();
  if (!dev.startsWith('@') || seen.has(name)) return dev;
  seen.add(name);
  return baseDevice(data, dev.slice(1), seen);
}

// The changes that could cut the admin's connection or leave the router half configured, as sentences for the review banner and the
// confirmation before saving: a list of strings, empty when the draft holds nothing risky. `host` is the name or address the browser
// reaches the router at; when it is one of the addresses being changed the sentence says so.
export function risksOf(data, draft, host = '') {
  const out = [];
  const mgmt = managementInterfaces(data);
  const mgmtDevices = new Set([...mgmt].map(n => baseDevice(data, n)).filter(Boolean));
  // The addresses (without prefix) an interface has on the router now.
  const addressesNow = s => [...valueOf({ type: 'list' }, s.values.ipaddr), ...valueOf({ type: 'list' }, s.values.ip6addr)].map(a => a.split('/')[0]);

  for (const s of ifaceList(data, draft)) {
    if (s.isNew) continue;
    const likely = mgmt.has(s.name);
    const where = likely ? `${s.name}, the network this page is most likely reached through` : s.name;
    const connected = host && addressesNow(data.cfg.interfaces.find(x => x.section === s.id)).includes(host);
    const reach = connected ? ` You are connected at ${host}, one of its addresses.` : '';
    if (s.removed) {
      out.push(`Removing the interface ${where} deletes its addresses, and the firewall zones, DHCP pools and routes that name it keep pointing at nothing.${reach}`);
      continue;
    }
    if (!s.editable) continue;
    const lines = diffInterface(s, draft).lines.map(l => l.key.split(':')[2]);
    const hit = ['proto', 'device', 'ipaddr', 'netmask', 'ip6addr', 'disabled', 'auto', 'mtu', 'macaddr', 'gateway'].filter(k => lines.includes(k));
    if (hit.length && (likely || connected)) out.push(`Changing ${hit.map(k => ifaceFieldLabel(k)).join(', ')} of ${where} can cut your connection to the router, and you would have to reach it at its new address.${reach}`);
  }
  for (const d of deviceList(data, draft)) {
    if (d.isNew) continue;
    const carries = d.type === 'bridge' && mgmtDevices.has(d.name);
    if (d.removed) {
      if (carries) out.push(`Removing the bridge ${d.name}, which carries the management network, takes every port and Wi-Fi network off it.`);
      continue;
    }
    if (d.type !== 'bridge' || !d.editable) continue;
    const lines = diffDevice(d, draft).lines.map(l => l.key.split(':')[2]);
    const before = valueOf(PORTS_FIELD, d.raw.ports), after = draft.devices[d.id].ports.map(p => p.trim()).filter(Boolean);
    const gone = before.filter(p => !after.includes(p));
    if (gone.length) out.push(`Removing ${gone.join(', ')} from ${d.name}${carries ? ', which carries the management network' : ''}: anything reached through ${gone.length > 1 ? 'those ports' : 'that port'} loses its connection${carries ? ', and a computer plugged into it cannot reach the router' : ''}.`);
    if (lines.includes('vlan_filtering')) out.push(`Switching VLAN filtering ${draft.devices[d.id].vlan_filtering ? 'on' : 'off'} on ${d.name} changes how every port of the bridge forwards${carries ? ' and can cut your connection' : ''}; make sure the bridge VLAN table (Ethernet ports tab) lets the management network through.`);
    else if (carries && lines.some(k => ['macaddr', 'mtu'].includes(k))) out.push(`Changing the MAC address or MTU of ${d.name}, which carries the management network, briefly drops its link.`);
  }
  return out;
}

// The label of an interface field by its option name, for the sentences about risks.
function ifaceFieldLabel(key) {
  return IFACE_FIELDS.find(f => f.key === key)?.label ?? key;
}

//#endregion

//#region Writing

// The UCI operations that turn the router's config into the draft, as data (see core/ops.js). Only what changed is written; an emptied
// option is deleted rather than set to ''; options the page does not know are left alone, and so is a secret that was not retyped.
// Removed sections go first, then the new ones (devices before the interfaces on them), then the changes to existing ones.
export function plan(data, draft) {
  const ops = [];
  const devices = deviceList(data, draft), ifaces = ifaceList(data, draft);
  for (const s of ifaces) if (s.removed) ops.push({ op: 'delete', config: CONFIG, section: s.id });
  for (const d of devices) if (d.removed) ops.push({ op: 'delete', config: CONFIG, section: d.id });
  for (const d of devices.filter(x => x.isNew)) {
    const { set } = diffDevice(d, draft);
    ops.push({ op: 'add', config: CONFIG, type: 'device', values: { name: d.name.trim(), ...(d.type === 'plain' ? {} : { type: d.type }), ...set } });
  }
  for (const s of ifaces.filter(x => x.isNew)) {
    const { set } = diffInterface(s, draft);
    ops.push({ op: 'add', config: CONFIG, type: 'interface', name: s.name.trim(), values: set });
  }
  // Queues the delete and set operations of one existing section; deleting comes first because an option of the old protocol may share its
  // name with one of the new protocol's.
  const change = (section, { set, del }) => {
    if (del.length) ops.push({ op: 'delete', config: CONFIG, section, options: del });
    if (Object.keys(set).length) ops.push({ op: 'set', config: CONFIG, section, values: set });
  };
  for (const d of devices.filter(x => !x.isNew && !x.removed && x.editable)) change(d.id, diffDevice(d, draft));
  for (const s of ifaces.filter(x => !x.isNew && !x.removed && x.editable)) change(s.id, diffInterface(s, draft));
  // The network-wide section: changed in place, or created when the router has none.
  const globals = diffGlobals(data, draft);
  if (data.cfg.globals) change(data.cfg.globals.section, globals);
  else if (Object.keys(globals.set).length) ops.push({ op: 'add', config: CONFIG, type: 'globals', name: 'globals', values: globals.set });
  return ops;
}

// Throws unless the config `after` (read back through the plugin once the change is applied) holds what the draft asked for: every
// field of every interface and device the form keeps (a new one by its name, a removed one gone), and that a typed secret is stored.
export function checkApplied(after, draft, base) {
  const left = [];
  const cfg = after.cfg;
  const have = new Map(cfg.interfaces.map(s => [s.name, s]));
  for (const s of ifaceList(base, draft)) {
    const found = have.get(s.name.trim());
    if (s.removed) { if (found) left.push(`Interface ${s.name}`); continue; }
    if (!found) { left.push(`Interface ${s.name.trim()}`); continue; }
    if (!s.editable) continue;
    const values = draft.ifaces[s.id];
    for (const f of ifaceFieldsFor(values.proto)) {
      if (f.secret) { if (normalize(f, values[idOf(f)]) !== '' && !found.secrets[f.key]) left.push(`${s.name.trim()}: ${f.label}`); continue; }
      if (differs(f, normalize(f, valueOf(f, found.values[f.key])), normalize(f, values[idOf(f)]))) left.push(`${s.name.trim()}: ${f.label}`);
    }
  }
  for (const d of deviceList(base, draft)) {
    const found = cfg.devices.find(x => x.name === d.name.trim() && (x.type === d.type || d.removed));
    if (d.removed) { if (found) left.push(`Device ${d.name}`); continue; }
    if (!found) { left.push(`Device ${d.name.trim()}`); continue; }
    if (!d.editable) continue;
    const values = draft.devices[d.id];
    for (const f of [...deviceFields(d.type), ...(d.type === 'bridge' ? [PORTS_FIELD] : [])]) {
      if (differs(f, normalize(f, valueOf(f, found.values[f.key])), normalize(f, values[idOf(f)]))) left.push(`${d.name.trim()}: ${f.label}`);
    }
  }
  if (draft.globals) {
    const found = cfg.globals?.values ?? {};
    for (const f of GLOBALS_FIELDS) {
      if (differs(f, normalize(f, valueOf(f, found[f.key])), normalize(f, draft.globals[idOf(f)]))) left.push(`Network-wide: ${f.label}`);
    }
  }
  if (left.length) throw new Error(`${left.slice(0, 4).join(', ')}${left.length > 4 ? ` and ${left.length - 4} more` : ''} ${left.length > 1 ? 'were' : 'was'} not saved`);
  // Interfaces that carried an address before must still be up: the router answering is not enough when the change left the network dead.
  if (after.down?.length) throw new Error(`${after.down.join(', ')} ${after.down.length > 1 ? 'are' : 'is'} not up after the change`);
}

// The static interfaces that were up on the router and that the draft keeps enabled but are not up in `ifsAfter` (netifd's interface dump
// after the change): the sign that a change took the network down while the config itself was stored.
export function downAfter(data, draft, ifsAfter) {
  const was = new Map((data.ifs ?? []).map(i => [i.interface, i.up]));
  const now = new Map((ifsAfter ?? []).map(i => [i.interface, i.up]));
  return ifaceList(data, draft)
    .filter(s => !s.removed && !s.isNew && s.editable && s.name !== 'loopback')
    .filter(s => draft.ifaces[s.id].proto === 'static' && !draft.ifaces[s.id].disabled && draft.ifaces[s.id].auto && was.get(s.name) === true && now.get(s.name) !== true)
    .map(s => s.name);
}

//#endregion

//#region Descriptions

// A protocol's label.
export const protoLabel = id => PROTOS.find(p => p.id === id)?.label ?? OTHER_PROTOS[id] ?? (id || 'no protocol');

// The one-line description of an interface in its header, from what the form holds now.
export function describeInterface(s, draft, ifs) {
  const v = draft.ifaces[s.id];
  const proto = s.editable ? v.proto : (s.raw.proto ?? '');
  const live = (ifs ?? []).find(i => i.interface === s.name);
  const addrs = proto === 'static' && s.editable ? [...v.ipaddr, ...v.ip6addr].map(a => a.trim()).filter(Boolean) : [...(live?.['ipv4-address'] ?? []), ...(live?.['ipv6-address'] ?? [])].map(a => `${a.address}/${a.mask}`);
  const device = s.editable ? v.device.trim() : String(s.raw.device ?? '');
  return [protoLabel(proto), device ? `on ${device}` : null, addrs.slice(0, 2).join(', ') || null].filter(Boolean).join(' · ');
}

// The one-line description of a device in its header.
export function describeDevice(d, draft) {
  const v = draft.devices[d.id];
  if (d.type === 'bridge') {
    const ports = v.ports.map(p => p.trim()).filter(Boolean);
    return ports.length ? `ports ${ports.join(', ')}` : 'no ports';
  }
  if (d.type === '8021q' || d.type === '8021ad') return `VLAN ${v.vid || '?'} on ${v.ifname || '?'}`;
  return d.type === 'plain' ? 'device settings' : `${d.type} device`;
}

//#endregion

export { DEVICE_FIELDS, IFACE_FIELDS };
