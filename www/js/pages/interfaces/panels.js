// The contents of the side panel (drawer) of the Devices and Interfaces page, and the "New network" wizard. The board (board.js) opens a
// panel for the item the user clicked and builds its contents here; every panel edits the one shared draft of editor.js through the editing
// context `ctx` (editor.js editContext): a control calls ctx.touched() after an edit and ctx.redraw() when the shape of the form changes.
//
// Contract (the board depends on exactly this):
//   interfacePanel(ctx, id)     the panel of the interface whose draft id is `id` (ifaceList(...).id): { title, subtitle, body, footer }
//   devicePanel(ctx, ref)       the panel of a device: `ref` is { id } for a section of the draft (deviceList(...).id) or { name } for a
//                               device that exists on the router without a section (a port, a bridge the config does not hold)
//   globalsPanel(ctx)           the panel of the network-wide settings (the `globals` section), same shape
//   openWizard(ctx, onDone)     opens the "New network" dialog; `onDone({ iface, device })` gets the draft ids it added
// `title` and `subtitle` are strings, `body` is a node, `footer` is an array of nodes (or empty).
//
// The words follow the OpenWrt documentation (/docs/guide-user/network/network_configuration): a network DEVICE (a NIC or a switch port) or a
// bridge device carries frames; an INTERFACE (a "logical network") holds the IP configuration and sits on one device; a firewall zone groups
// interfaces. A `device` section is optional when the interface can sit on the port itself, so a port without one is normal.
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { badge, button, kv, mono, muted } from '../../core/ui.js';
import { note } from '../../core/forms.js';
import { fmtDur } from '../../core/format.js';
import { DEVICE_FIELDS, DEVICE_TYPES, GLOBALS_FIELDS, GLOBALS_READONLY, IFACE_FIELDS, idOf } from './schema.js';
import { addDevice, deviceList, ifaceList, protoLabel, removeDevice, removeInterface, restoreDevice, restoreInterface, setProto } from './model.js';
import { controlFor, deviceField, extraOptions, interfaceField, nameControl, portsPicker, stateBadge } from './controls.js';
import {
  DEVICE_NAME_MAX, OWNER_PAGES, SETTINGS_LEAD, deviceItems, deviceSettings, droppedBy, effectiveDevice, interfaceNameMax, interfaceSettings, isSet, otherProtoText,
  usedByDevice, usedByInterface, vlanName, zoneText,
} from './panelmodel.js';
import { infoList, optionList, pageLink, protoCards, section } from './panelparts.js';

export { openWizard } from './wizard.js';

// Which Advanced blocks are open, kept across the rebuilds of the panel (every poll and every edit that changes the form rebuilds it): key to open or closed.
const advOpen = new Map();

//#region Shared parts

// The panel for an item that is gone (removed in the form, or no longer on the router).
const gone = (title, text) => ({ title, subtitle: '', body: h('div', { className: 'ne-form np-panel' }, muted(text)), footer: [] });

// The body of a panel: the sections in a column that wraps. Every panel uses it so the styles of `np-panel` apply.
const panelBody = (...sections) => h('div', { className: 'ne-form np-panel' }, ...sections.filter(Boolean));

// The Advanced block of a panel: the groups of `groups` ([{ group, fields }]) built by `controlOf(field)`, with the count of options that hold a value in
// the title, folded until opened. `values` are the draft values and `extra` an optional node (the options this page has no control for).
function advancedBlock(key, groups, controlOf, values, extra) {
  if (!groups.length && !extra) return null;
  const set = groups.flatMap(g => g.fields).filter(f => isSet(f, values[idOf(f)])).length;
  return h('details', { className: 'np-adv', open: advOpen.get(key) ?? false, ontoggle: e => advOpen.set(key, e.target.open) },
    h('summary', {}, 'Advanced', set ? badge(`${set} set`, 'info', 'Advanced options that hold a value') : null),
    h('div', { className: 'np-adv-body' },
      groups.map(({ group, fields }) => h('div', { className: 'np-adv-group' }, h('h4', {}, group.title), h('p', { className: 'muted small' }, group.legend),
        h('div', { className: 'set-fields' }, fields.map(controlOf)))),
      extra ?? null));
}

// The "Used by" rows of a panel as a section, or a muted line when nothing uses the item.
const usedSection = (num, rows, empty) => section(num, 'Used by', null, rows.filter(Boolean).length ? infoList(rows) : muted(empty));

// A footer button that removes (or discards) the item; `warn` is a sentence shown above it when other things depend on the item.
function removeFooter(ctx, label, tip, onRemove, warn) {
  const b = h('button', { type: 'button', className: 'btn btn-sm btn-fl np-remove', disabled: !ctx.canEdit, title: tip, onclick: onRemove }, icon('trash'), label);
  return [warn ? h('div', { className: 'np-foot-note small' }, warn) : null, b].filter(Boolean);
}

// The notice and Undo button of an item the form removes.
const removedBody = (what, undo) => panelBody(note('warn', `${what} is removed when you save.`), h('div', {}, button('Undo', 'arrow-clockwise', undo)));

// A list of values, one per line, that wraps.
const lines = list => h('span', { className: 'np-wrap' }, list.map(t => h('div', {}, mono(t))));

//#endregion

//#region Interface panel

// The live facts of an interface as rows: its state, the device it runs on now (and the one its protocol creates), addresses, gateway and DNS.
function liveRows(s, v, live) {
  if (!live) return [['State', muted('netifd has no running interface of this name.')]];
  const addrs = [...(live['ipv4-address'] ?? []), ...(live['ipv6-address'] ?? [])].map(a => `${a.address}/${a.mask}`);
  const prefixes = (live['ipv6-prefix-assignment'] ?? []).map(p => `${p.address}/${p.mask}`);
  const gateway = (live.route ?? []).find(r => r.mask === 0 && String(r.target).includes('.'))?.nexthop;
  const created = live.l3_device && live.l3_device !== live.device ? live.l3_device : v.proto === 'pppoe' ? effectiveDevice('pppoe', s.name) : null;
  return [
    ['State', h('span', {}, stateBadge(live), live.up && live.uptime != null ? muted(` up ${fmtDur(live.uptime)}`) : null)],
    live.device || created ? ['Device now', h('span', {}, mono(live.device ?? '–'), created ? h('span', {}, ' → creates ', mono(created)) : null)] : null,
    addrs.length ? ['Addresses', lines(addrs)] : null,
    prefixes.length ? ['Prefixes', lines(prefixes)] : null,
    gateway ? ['Gateway', mono(gateway)] : null,
    (live['dns-server'] ?? []).length ? ['DNS', lines(live['dns-server'])] : null,
  ];
}

// The "Used by" section of an interface: its firewall zone, the services run on it, the interfaces that ride on it, with links to the pages that edit them.
function interfaceUses(data, draft, s) {
  const u = usedByInterface(data, draft, s.id);
  const rows = [
    ['Firewall zone', u.zone ? h('span', {}, badge(u.zone.name, u.zone.input === 'ACCEPT' ? 'success' : 'info'), ' ', h('span', { className: 'muted small' }, zoneText(u.zone)), ' ', pageLink('#firewall', 'Firewall page'))
      : h('span', {}, badge('no zone', '', 'Not in any firewall zone'), ' ', pageLink('#firewall', 'Firewall page'))],
    ['Services', u.services.length ? h('span', { className: 'np-wrap' }, u.services.map(t => h('div', {}, t)), pageLink('#dhcp', 'DHCP page')) : h('span', {}, muted('none '), pageLink('#dhcp', 'DHCP page'))],
    ['Routes', h('span', {}, muted('Static routes that name this interface are on the '), pageLink('#routing', 'Routing page'))],
    u.riders.length ? ['Others on it', h('span', { className: 'np-wrap' }, u.riders.map(r => h('div', {}, mono(r.name), muted(` ${r.how}`))))] : null,
  ];
  return { section: s.isNew ? null : usedSection(4, rows, ''), riders: u.riders };
}

// The read-only panel of an interface whose protocol this page does not edit: the options as they are in the file and the page that owns it.
function readOnlyInterface(ctx, s) {
  const proto = s.raw.proto ?? '';
  const owner = OWNER_PAGES[proto];
  const rows = [...Object.entries(s.raw).map(([k, v]) => [mono(k), mono(Array.isArray(v) ? v.join(', ') : String(v))]), ...Object.keys(s.secrets ?? {}).map(k => [mono(k), muted('hidden (a secret)')])];
  const live = ctx.live.ifs.find(i => i.interface === s.name);
  const uses = interfaceUses(ctx.base, ctx.draft, s);
  return {
    title: s.name, subtitle: `Interface · ${protoLabel(proto)}`,
    body: panelBody(
      section(null, protoLabel(proto), `${otherProtoText(proto)}. This page does not edit this protocol: its options are shown as they are in the file, and it cannot be removed here.`,
        owner ? h('div', {}, h('a', { href: owner.href, className: 'btn btn-sm btn-fl' }, icon('arrow-right'), owner.label)) : null),
      section(null, 'State', null, infoList(liveRows(s, { proto }, live))),
      section(null, 'Options in the file', null, rows.length ? kv(rows) : muted('No options.')),
      uses.section ?? null),
    footer: [],
  };
}

// The panel of an interface: where it connects, the protocol, its settings, and what uses it.
export function interfacePanel(ctx, id) {
  const s = ifaceList(ctx.base, ctx.draft).find(x => x.id === id);
  if (!s) return gone('Interface', 'This interface is gone.');
  if (s.removed) return { title: s.name, subtitle: 'Interface · to be removed', body: removedBody(`The interface ${s.name}`, () => { restoreInterface(ctx.draft, id); ctx.touched(); ctx.redraw(); }), footer: [] };
  if (!s.editable) return readOnlyInterface(ctx, s);

  const v = ctx.draft.ifaces[id];
  const live = ctx.live.ifs.find(i => i.interface === s.name);
  const entry = ctx.draft.ifaceAdded.find(a => a.id === id);
  const known = new Set(IFACE_FIELDS.map(f => f.key));
  const stored = [...Object.keys(s.raw), ...Object.keys(s.secrets ?? {})];
  const nameMax = interfaceNameMax(v.proto);

  // The control of one option of this interface.
  const control = f => controlFor(ctx, interfaceField(ctx, s, f), `if:${id}:${idOf(f)}`, v, false);
  const settings = interfaceSettings(v.proto, v);

  // Section 1: the device the interface sits on, as a list with what each device is and what already uses it.
  const items = deviceItems(ctx.base, ctx.draft, id);
  const current = v.device.trim();
  if (current && !items.some(i => i.value === current)) items.push({ value: current, title: current, kind: 'unknown', what: 'The router has no device of this name at the moment.', usedBy: [] });
  const connects = section(1, 'Connects through',
    'An interface holds the IP configuration of one network (a "logical network") and sits on one device: a network device (a port or NIC), a bridge device that groups ports, or a VLAN device that carries one tag. It can also borrow the device of another interface (@name). A device section is optional: an interface can sit on a port directly.',
    optionList({ name: `np-dev-${id}`, items, value: current, disabled: !ctx.canEdit,
      none: { value: '', title: 'No device', what: 'The protocol creates its own device, or only Wi-Fi networks use this interface.' },
      onPick: value => { v.device = value; ctx.touched(); ctx.redraw(); } }));

  // Section 2: the protocol cards; what a switch drops is announced before the click and stays visible after it.
  const was = s.isNew ? null : s.raw.proto ?? '';
  const switched = was !== null && was !== v.proto ? droppedBy(v, was, v.proto, stored) : [];
  const protocol = section(2, 'Protocol', 'The protocol is what the interface speaks on its device. It decides which settings below apply.',
    protoCards({ current: v.proto, disabled: !ctx.canEdit, onPick: proto => { setProto(ctx.base, ctx.draft, id, proto); ctx.touched(); ctx.redraw(); },
      dropped: proto => droppedBy(v, v.proto, proto, stored) }),
    v.proto === '' ? note('warn', 'This interface has no protocol, so netifd ignores it and its device stays down, even with a cable plugged in. Pick one.') : null,
    v.proto === 'none' ? muted('Protocol "none" brings the device up without any IP configuration.') : null,
    switched.length ? note('info', `Changed from ${protoLabel(was)}: saving removes ${switched.join(', ')} from the file (the review lists it).`) : null,
    v.proto === 'pppoe' ? muted(`The PPP session is a device of its own called ${effectiveDevice('pppoe', s.name.trim() || '<name>')}; another interface can ride on it with @${s.name.trim() || '<name>'}.`) : null);

  // Section 3: the essential options, then the rest folded.
  const extra = extraOptions(s.raw, s.secrets, known, 'interface');
  const settingsSection = section(3, 'Settings', SETTINGS_LEAD[v.proto] ?? 'This interface has no protocol yet.',
    settings.essential.length ? h('div', { className: 'set-fields np-fields' }, settings.essential.map(control)) : null,
    advancedBlock(`if:${id}`, settings.groups, control, v, extra));

  const nameBox = s.isNew ? nameControl(ctx, entry, `if:${id}:name`, 'Interface name',
    `How the interface is called in /etc/config/network, by the firewall and the DHCP server: letters, digits and underscores, at most ${nameMax} characters for this protocol (the kernel limits a device name to ${DEVICE_NAME_MAX} characters including prefixes such as pppoe-). It cannot be changed once saved.`, 'guest') : null;

  const uses = interfaceUses(ctx.base, ctx.draft, s);
  const rows = s.isNew ? [] : liveRows(s, v, live);
  const dependants = uses.riders.filter(r => r.how === 'borrows its device').map(r => r.name);
  const removable = s.name !== 'loopback';
  return {
    title: s.name.trim() || 'New interface',
    subtitle: `Interface · ${protoLabel(v.proto)}${s.isNew ? ' · not saved yet' : ''}`,
    body: panelBody(rows.length ? infoList(rows) : null, nameBox ? h('div', { className: 'set-fields np-fields' }, nameBox) : null, connects, protocol, settingsSection, uses.section),
    footer: removable ? removeFooter(ctx, s.isNew ? 'Discard interface' : 'Remove interface', `Delete the interface ${s.name || ''}`,
      () => { removeInterface(ctx.draft, id); ctx.touched(); ctx.redraw(); },
      dependants.length ? `${dependants.join(', ')} ${dependants.length > 1 ? 'depend' : 'depends'} on this interface: removing it is refused until ${dependants.length > 1 ? 'they are' : 'it is'} rebound or removed.` : null)
      : [muted('The loopback interface cannot be removed here.')],
  };
}

//#endregion

//#region Device panel

// The words for a link speed in Mbit/s.
const speedText = mbit => (mbit >= 1000 ? `${mbit / 1000} Gbit/s` : `${mbit} Mbit/s`);

// The live facts of a port as rows.
function portRows(net, name) {
  const p = (net?.ports ?? []).find(x => x.name === name);
  if (!p) return [['State', muted('The router reports no port of this name.')]];
  return [
    ['Link', p.carrier ? badge(`up${p.speed ? `, ${speedText(p.speed)}` : ''}${p.duplex ? `, ${p.duplex} duplex` : ''}`, 'success') : badge('no link', '')],
    p.role ? ['Role', p.role === 'conduit' ? 'the link between the CPU and the switch chip' : p.role === 'nic' ? 'a network card' : `a ${p.role} port`] : null,
    p.max_speed ? ['Capability', `up to ${speedText(p.max_speed)}`] : null,
  ];
}

// The "Used by" section of a device and how many interfaces and VLAN devices depend on it.
function deviceUses(ctx, name, kind) {
  const u = usedByDevice(ctx.base, ctx.draft, name);
  const rows = [
    u.interfaces.length ? ['Interfaces', lines(u.interfaces)] : null,
    u.vlans.length ? ['VLAN devices', lines(u.vlans)] : null,
    u.bridge ? ['Port of', mono(u.bridge)] : null,
    u.wifi.length ? ['Wi-Fi interfaces', h('span', { className: 'np-wrap' }, u.wifi.map(n => h('div', {}, mono(n))), pageLink('#wifi', 'Wi-Fi page'))] : null,
  ];
  return { node: usedSection(null, rows, kind === 'port' ? 'No interface, VLAN device or bridge uses this port.' : 'Nothing uses this device yet.'), names: [...u.interfaces, ...u.vlans] };
}

// The live information of a bridge from the page's bridge module (bridgelive.js), put into `box` when the module exists: members with link, spanning-tree
// role, learned MACs and throughput. Without the module there is no live section.
function addBridgeLive(ctx, name, box) {
  import('./bridgelive.js').then(m => {
    const node = m.bridgeLive?.(ctx.live.net, ctx.live.mesh, name);
    if (node) box.replaceChildren(section(null, 'Live', 'What the bridge is doing now.', node));
  }).catch(() => {});
}

// The panel of a device section: a bridge, a VLAN device, or the settings of an existing port. A device of another type is shown read only.
function sectionPanel(ctx, d) {
  const v = ctx.draft.devices[d.id];
  const type = DEVICE_TYPES.find(t => t.id === d.type);
  const live = d.type === 'bridge' ? (ctx.live.net?.bridges ?? []).find(b => b.name === d.name) : (ctx.live.net?.vlans ?? []).find(x => x.name === d.name);
  const state = d.isNew ? 'not saved yet' : live ? (live.up ? 'up' : 'down') : 'not present';
  const subtitle = `${d.type === 'bridge' ? 'Bridge device' : d.type === 'plain' ? 'Network device settings' : 'VLAN device'} · ${state}`;
  if (d.removed) return { title: d.name, subtitle, body: removedBody(`The device section for ${d.name}`, () => { restoreDevice(ctx.draft, d.id); ctx.touched(); ctx.redraw(); }), footer: [] };
  if (!d.editable) {
    return { title: d.name, subtitle: `Device · ${d.type}`, footer: [],
      body: panelBody(section(null, `A ${d.type} device`, 'This page does not edit this type of device: its options are shown as they are in the file.',
        kv(Object.entries(d.raw).map(([k, val]) => [mono(k), mono(Array.isArray(val) ? val.join(', ') : String(val))])))) };
  }
  const known = new Set([...DEVICE_FIELDS.map(f => f.key), 'name', 'type', 'ports']);
  const entry = ctx.draft.devAdded.find(a => a.id === d.id);
  const settings = deviceSettings(d.type);
  const vlan = d.type === '8021q' || d.type === '8021ad';
  const tagIds = ['ifname', 'vid'];

  // A VLAN device's name follows its base device and ID while the user has not typed another one (a name the model made up counts as not typed).
  const onVlanSet = f => value => {
    const before = vlanName(v.ifname, v.vid);
    v[idOf(f)] = value;
    if (d.isNew && entry && (!entry.name || entry.name === before || /^vlan\d*$/.test(entry.name))) entry.name = vlanName(v.ifname, v.vid) || entry.name;
    const box = ctx.inputs[`dev:${d.id}:name`];
    if (box && entry) box.value = entry.name;
  };
  // The control of one option of this device.
  const control = f => controlFor(ctx, deviceField(ctx, d, f), `dev:${d.id}:${idOf(f)}`, v, false, vlan && tagIds.includes(idOf(f)) ? onVlanSet(f) : undefined);
  const hints = {
    bridge: [`The name of the bridge device, usually br-<something>. At most ${DEVICE_NAME_MAX} characters; it cannot be changed once saved.`, 'br-guest'],
    plain: ['The name of the port or device the settings are for (for example lan1 or eth1). It cannot be changed once saved.', 'lan1'],
  };
  const [hint, placeholder] = hints[d.type] ?? [`The name of the VLAN device, usually base.id (eth1.200). At most ${DEVICE_NAME_MAX} characters; it cannot be changed once saved.`, 'eth1.200'];
  const nameBox = d.isNew ? nameControl(ctx, entry, `dev:${d.id}:name`, 'Device name', hint, placeholder, d.type === 'plain' ? (ctx.base.net?.ports ?? []).map(p => p.name) : []) : null;

  // A new VLAN device can still be 802.1Q or 802.1ad; an existing section's type is not rewritten by a save.
  const typeBox = vlan ? h('div', { className: 'set-field' }, h('label', { className: 'form-label' }, 'VLAN type'),
    d.isNew ? h('select', { className: 'form-select form-select-sm', disabled: !ctx.canEdit, onchange: e => { entry.type = e.target.value; ctx.touched(); ctx.redraw(); } },
      ['8021q', '8021ad'].map(t => h('option', { value: t, selected: t === d.type }, DEVICE_TYPES.find(x => x.id === t).label))) : h('div', {}, badge(type.label, 'info')),
    h('div', { className: 'muted small set-hint' }, type.hint)) : null;

  const liveBox = h('div', { className: 'np-live' });
  let main;
  if (d.type === 'bridge') {
    addBridgeLive(ctx, d.name, liveBox);
    main = [section(1, 'Ports', 'A bridge device joins ports (network devices) and Wi-Fi interfaces into one layer 2 network, like a software switch. An interface then sits on the bridge, not on its ports.',
      h('div', { className: 'set-fields np-fields' }, portsPicker(ctx, d))), liveBox];
  } else if (vlan) {
    main = [section(1, 'VLAN tag', 'A VLAN device carries only the frames of one VLAN tag of its base device (a port or a bridge), as a device of its own. An interface can then sit on it.',
      h('div', { className: 'set-fields np-fields' }, typeBox, ...tagIds.map(id => control(settings.essential.find(f => idOf(f) === id)))))];
  } else {
    main = [section(1, 'Link now', 'Settings here change how the network device itself behaves. The device section is optional: without one the port works with its defaults.',
      infoList(portRows(ctx.live.net, d.name)))];
  }
  const rest = vlan ? settings.essential.filter(f => !tagIds.includes(idOf(f))) : settings.essential;
  const groups = settings.groups.map(g => ({ group: g.group, fields: g.fields.filter(f => !vlan || !tagIds.includes(idOf(f))) })).filter(g => g.fields.length);
  const settingsSection = section(2, 'Settings', null,
    rest.length ? h('div', { className: 'set-fields np-fields' }, rest.map(control)) : null,
    advancedBlock(`dev:${d.id}`, groups, control, v, extraOptions(d.raw, d.secrets, known, 'device section')));
  const uses = deviceUses(ctx, d.name.trim(), d.type === 'plain' ? 'port' : d.type);
  return {
    title: d.name.trim() || 'New device', subtitle,
    body: panelBody(nameBox ? h('div', { className: 'set-fields np-fields' }, nameBox) : null, ...main, settingsSection, uses.node),
    footer: removeFooter(ctx, d.isNew ? 'Discard device' : d.type === 'plain' ? 'Remove the settings' : d.type === 'bridge' ? 'Remove bridge' : 'Remove VLAN device',
      `Delete the device section ${d.name || ''}`, () => { removeDevice(ctx.draft, d.id); ctx.touched(); ctx.redraw(); },
      uses.names.length ? `${uses.names.join(', ')} run${uses.names.length > 1 ? '' : 's'} on this device: removing it is refused until ${uses.names.length > 1 ? 'they are' : 'it is'} rebound or removed.` : null),
  };
}

// The panel of a device that exists on the router but has no device section: its live facts, and the means to give it settings of its own.
function livePanel(ctx, name) {
  const net = ctx.live.net;
  const bridge = (net?.bridges ?? []).find(b => b.name === name);
  const vlan = (net?.vlans ?? []).find(v => v.name === name);
  const port = (net?.ports ?? []).find(p => p.name === name);
  const kind = bridge ? 'Bridge device' : vlan ? 'VLAN device' : 'Network device';
  const rows = bridge ? [['State', badge(bridge.up ? 'up' : 'down', bridge.up ? 'success' : 'danger')], ['Members', lines(bridge.members.map(m => m.name))]]
    : vlan ? [['State', badge(vlan.up ? 'up' : 'down', vlan.up ? 'success' : 'danger')], ['Tag', `VLAN ${vlan.vid} on ${vlan.parent}`]] : portRows(net, name);
  const uses = deviceUses(ctx, name, port ? 'port' : 'device');
  const add = button('Add settings for this device', 'plus-lg', () => {
    const id = addDevice(ctx.base, ctx.draft, 'plain');
    ctx.draft.devAdded.find(a => a.id === id).name = name;
    ctx.touched();
    ctx.redraw();
  });
  add.disabled = !ctx.canEdit;
  const liveBox = h('div', { className: 'np-live' });
  if (bridge) addBridgeLive(ctx, name, liveBox);
  return {
    title: name, subtitle: kind,
    body: panelBody(
      section(null, 'Now', `A ${kind.toLowerCase()} the router reports. It has no device section in the configuration, which is normal: it works with its defaults, and an interface can sit on it directly.`, infoList(rows)),
      bridge ? liveBox : null,
      section(null, 'Settings', 'Give the device settings of its own (MTU, MAC address, link speed, flow control) by adding a device section for it.', h('div', {}, add)),
      uses.node),
    footer: [],
  };
}

// The panel of a device: `ref` is { id } for a section of the draft or { name } for a device by name (a section of that name is used when there is one).
export function devicePanel(ctx, ref) {
  const all = deviceList(ctx.base, ctx.draft);
  const d = ref.id ? all.find(x => x.id === ref.id) : all.find(x => x.name === ref.name);
  if (d) return sectionPanel(ctx, d);
  if (ref.id) return gone('Device', 'This device is gone.');
  return livePanel(ctx, ref.name ?? '');
}

//#endregion

//#region Network-wide settings

// The panel of the network-wide settings (the `globals` section of /etc/config/network): the ULA prefix, packet steering, the netifd log level and the VRF
// socket options are editable; the default DHCP DUID and any other option of the section are shown read only. A router whose plugin does not report the
// section gets the same options as a description, so the panel never pretends to know the values.
export function globalsPanel(ctx) {
  const g = ctx.base.cfg?.globals;
  const lead = 'The globals section of /etc/config/network holds options that belong to no interface and affect the whole network stack.';
  if (g === undefined || !ctx.draft?.globals) {
    return {
      title: 'Network-wide settings', subtitle: 'The globals section', footer: [],
      body: panelBody(
        section(null, 'What it is', lead, note('info', 'This router does not report the globals section to this page (the flab.network plugin is out of date), so its values are not shown and it is not edited here.')),
        section(null, 'Options', null, kv([...GLOBALS_FIELDS, ...GLOBALS_READONLY].map(f => [mono(f.key), f.hint])))),
    };
  }
  const values = ctx.draft.globals;
  const control = f => controlFor(ctx, f, `gl:${idOf(f)}`, values, false);
  const known = new Set([...GLOBALS_FIELDS, ...GLOBALS_READONLY].map(f => f.key));
  const extra = extraOptions(g?.values ?? {}, g?.secrets, known, 'globals section');
  const readOnly = GLOBALS_READONLY.map(f => [f.label, g?.values[f.key] != null ? mono(String(g.values[f.key])) : muted('not set'), f.hint]);
  return {
    title: 'Network-wide settings', subtitle: g ? 'The globals section' : 'The globals section · not in the file yet',
    body: panelBody(
      section(null, 'What it is', lead, g ? null : note('info', 'The router has no globals section yet; saving a change creates it.')),
      section(1, 'Settings', 'Nothing is written until you press "Save and apply".', h('div', { className: 'set-fields np-fields' }, GLOBALS_FIELDS.map(control))),
      section(2, 'Read only', 'Options of the section this page shows but does not edit.', infoList(readOnly.map(([label, value, hint]) => [label, h('span', {}, value, h('div', { className: 'muted small' }, hint))])), extra)),
    footer: [],
  };
}

//#endregion
