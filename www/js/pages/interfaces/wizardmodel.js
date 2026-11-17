// Pure model of the "New network" wizard (wizard.js): what the user chose (`choice`), the changes that choice makes to the draft, the validation of the
// result and the lists of devices to pick from. The wizard never edits the draft while the user is still choosing: every step shows what the draft
// WOULD look like (applyChoice on a copy, checked with problems() of model.js) and Finish applies the choice to the real draft once, through the same
// model.js functions (addDevice, addInterface, setPort, setProto) the editing panels use. No DOM and no network (tests/netpanels/panelmodel.test.mjs).
import { addDevice, addInterface, portChoices, problems, setPort, setProto } from './model.js';
import { DEVICE_NAME_MAX, deviceItems, effectiveDevice, interfaceNameMax, suggestBridgeName, suggestInterfaceName, suggestSubnet, suggestVlanId, vlanName } from './panelmodel.js';

// The three ways a new network connects to a device, in the order of the first step.
export const WHERE = [
  { id: 'device', title: 'An existing device', blurb: 'A bridge, port or VLAN device that has no interface yet, or the device of another interface.' },
  { id: 'vlan', title: 'A new VLAN device', blurb: 'Carry one VLAN tag of a port or bridge as a device of its own.' },
  { id: 'bridge', title: 'A new bridge', blurb: 'Join ports (and later Wi-Fi networks) into a new Layer 2 network of their own.' },
];

// What the wizard does not do, by protocol: [{ text, href, link }]. The last page of the wizard lists it.
export function notDone(proto) {
  const firewall = { text: 'No firewall zone. Until the network is in a zone it has no rules: the router treats it with its default policy.', href: '#firewall', link: 'Firewall page' };
  const dhcp = { text: 'No DHCP server and no router advertisements. Clients of this network will not get an address until one is set up.', href: '#dhcp', link: 'DHCP page' };
  const wifi = { text: 'No Wi-Fi network. A Wi-Fi network joins this one by naming it in its "network" option.', href: '#radios', link: 'Wi-Fi radios page' };
  const routes = { text: 'No static routes or policy rules. Anything that must reach this network through another router needs a route.', href: '#routing', link: 'Routing page' };
  return proto === 'static' ? [firewall, dhcp, wifi, routes] : [firewall, routes];
}

//#region The choice

// The devices a new network can run on as they are listed in step 1 for an existing device: { free, hidden } where `free` are the items of
// panelmodel.deviceItems nothing runs on (the CPU link is left out; the ports of a bridge come last, since an interface on one bypasses the bridge)
// and `hidden` is how many others already carry an interface.
export function existingDevices(data, draft) {
  const all = deviceItems(data, draft, null).filter(i => i.kind !== 'conduit');
  const free = all.filter(i => !i.usedBy.length);
  return { free: [...free.filter(i => !i.warn), ...free.filter(i => i.warn)], hidden: all.filter(i => i.usedBy.length).length };
}

// The devices a VLAN device can be made on, as the items of panelmodel.deviceItems (bridges, ports and VLAN devices; not the CPU link, not an alias).
export const vlanBases = (data, draft) => deviceItems(data, draft, null).filter(i => i.kind !== 'conduit' && i.kind !== 'alias');

// The first choice: the first way that has something to pick from, a free subnet, and free names.
export function defaultChoice(data, draft) {
  const free = existingDevices(data, draft).free;
  const where = free.length ? 'device' : vlanBases(data, draft).length ? 'vlan' : 'bridge';
  const bridgeName = suggestBridgeName(data, draft);
  return {
    where, device: free.find(i => !i.warn)?.value ?? '', vlanBase: '', vid: '', vlanName: '', ports: [], bridgeName, proto: 'static',
    name: suggestInterfaceName(data, draft, []), nameChosen: false, address: suggestSubnet(data, draft)?.address ?? '', gateway: '', username: '', password: '',
  };
}

// Changes the choice of the base device of a VLAN device: the ID and the name follow it unless the user typed them.
export function chooseVlanBase(data, draft, choice, base) {
  const oldName = vlanName(choice.vlanBase, choice.vid);
  const autoId = !choice.vid || choice.vid === suggestVlanId(data, draft, choice.vlanBase);
  choice.vlanBase = base;
  if (autoId) choice.vid = base ? suggestVlanId(data, draft, base) : '';
  if (!choice.vlanName || choice.vlanName === oldName) choice.vlanName = vlanName(base, choice.vid);
}

// Changes the VLAN ID: the name follows it unless the user typed one.
export function chooseVid(choice, vid) {
  const oldName = vlanName(choice.vlanBase, choice.vid);
  choice.vid = vid;
  if (!choice.vlanName || choice.vlanName === oldName) choice.vlanName = vlanName(choice.vlanBase, vid);
}

// The name the interface gets by default for the chosen way: the VLAN device or bridge it is made for, or the device it runs on.
export function nameFor(data, draft, choice) {
  const stem = choice.where === 'bridge' ? choice.bridgeName.replace(/^br-/, '') : choice.where === 'vlan' ? `vlan${choice.vid}` : choice.device.replace(/^[@]|^br-/g, '');
  return suggestInterfaceName(data, draft, [stem], interfaceNameMax(choice.proto));
}

//#endregion

//#region Applying and checking

// Makes the changes of `choice` to `draft` (which it mutates) with the editing functions of model.js, and returns the draft ids it added:
// { iface, device } (device is null when the network runs on a device that exists). A new bridge or VLAN device comes first, then the interface on it.
export function applyChoice(data, draft, choice) {
  let device = null, deviceName = choice.device;
  if (choice.where === 'bridge') {
    device = addDevice(data, draft, 'bridge');
    deviceName = choice.bridgeName.trim();
    draft.devAdded.find(a => a.id === device).name = choice.bridgeName;
    for (const p of choice.ports) setPort(data, draft, device, p, true);
  } else if (choice.where === 'vlan') {
    device = addDevice(data, draft, '8021q');
    deviceName = choice.vlanName.trim();
    draft.devAdded.find(a => a.id === device).name = choice.vlanName;
    draft.devices[device].ifname = choice.vlanBase;
    draft.devices[device].vid = choice.vid;
  }
  const iface = addInterface(data, draft);
  draft.ifaceAdded.find(a => a.id === iface).name = choice.name;
  const v = draft.ifaces[iface];
  v.device = deviceName;
  setProto(data, draft, iface, choice.proto);
  v.ipaddr = choice.proto === 'static' && choice.address.trim() ? [choice.address.trim()] : [];
  if (choice.proto === 'static') v.gateway = choice.gateway.trim();
  if (choice.proto === 'pppoe') { v.username = choice.username.trim(); v.password = choice.password; }
  return { iface, device };
}

// The errors and warnings the choice would add to the draft: { ids, errors, warnings } from problems() of the draft with the choice applied, minus what
// the draft already had. An error is { key, text, part, field, index? } where `part` is 'device', 'iface' or 'other' and `field` the option it is on.
export function previewChoice(data, draft, choice) {
  const copy = structuredClone(draft);
  const ids = applyChoice(data, copy, choice);
  const before = problems(data, draft), after = problems(data, copy);
  const had = new Set([...before.errors.map(e => e.text), ...before.warnings]);
  const part = key => (ids.device && key.startsWith(`dev:${ids.device}:`) ? 'device' : key.startsWith(`if:${ids.iface}:`) ? 'iface' : 'other');
  const errors = after.errors.filter(e => !had.has(e.text)).map(e => ({ ...e, part: part(e.key), field: e.key.split(':')[2] }));
  // The wizard asks for an address the model only warns about, because a static network without one is of no use.
  if (choice.proto === 'static' && !choice.address.trim()) errors.push({ key: `if:${ids.iface}:ipaddr`, text: 'Enter the address of the router on this network, for example 192.168.10.1/24.', part: 'iface', field: 'ipaddr' });
  if (choice.where === 'device' && !choice.device) errors.push({ key: `if:${ids.iface}:device`, text: 'Choose the device the network runs on.', part: 'iface', field: 'device' });
  const warnings = after.warnings.filter(w => !had.has(w));
  // The documentation's limit of 14 characters is stricter than the 15 the model enforces: say so instead of letting the device silently not be created.
  const names = [[effectiveDevice(choice.proto, choice.name.trim(), ''), 'interface'], [choice.where === 'device' ? '' : deviceNameOf(choice), 'device']];
  for (const [dev, what] of names) {
    if (dev.length > DEVICE_NAME_MAX && !errors.some(e => e.field === 'name')) warnings.push(`The ${what} would be called ${dev} (${dev.length} characters); the OpenWrt documentation says the kernel limits a device name to ${DEVICE_NAME_MAX} characters, and a longer one can silently fail to be created.`);
  }
  return { ids, errors, warnings };
}

// The errors that stop the user at a step ('where', 'proto' or 'details'): the ones on the device section at the first step, none at the second, all at the last.
export function stepErrors(preview, step) {
  if (step === 1) return preview.errors.filter(e => e.part === 'device' || e.field === 'device');
  if (step === 2) return [];
  return preview.errors;
}

// The device name the choice runs the interface on.
export const deviceNameOf = choice => (choice.where === 'bridge' ? choice.bridgeName.trim() : choice.where === 'vlan' ? choice.vlanName.trim() : choice.device);

// What Finish adds, as sentences for the summary: the new device (if any) and the interface.
export function summaryLines(choice) {
  const dev = deviceNameOf(choice);
  const lines = [];
  if (choice.where === 'bridge') lines.push(`A new bridge ${dev} with ${choice.ports.length ? `the ports ${choice.ports.join(', ')}` : 'no ports yet'}.`);
  if (choice.where === 'vlan') lines.push(`A new VLAN device ${dev}: VLAN ${choice.vid || '?'} of ${choice.vlanBase || '?'}.`);
  const how = { static: `a static address ${choice.address.trim() || '(none yet)'}${choice.gateway.trim() ? ` and the gateway ${choice.gateway.trim()}` : ''}`, dhcp: 'a DHCP client', dhcpv6: 'a DHCPv6 client',
    pppoe: `a PPPoE login${choice.username.trim() ? ` as ${choice.username.trim()}` : ''}`, none: 'no protocol (unmanaged)' }[choice.proto];
  lines.push(`A new interface ${choice.name.trim() || '(unnamed)'} on ${dev || 'no device'} with ${how}.`);
  return lines;
}

// The bridge ports the first step offers, as portChoices of model.js for the bridge being made.
export const bridgePortChoices = (data, draft, choice) => portChoices(data, draft, choice.bridgeName.trim());

//#endregion
