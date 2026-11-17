// Pure helpers of the side panels and the "New network" wizard of the Devices and Interfaces page (panels.js, wizard.js): the protocol cards,
// which options are essential and which are advanced, the items of the device chooser with what each device is and what uses it, what a change
// of protocol drops, what an interface or device is used by, and suggestions (a free private /24, names). No DOM and no network, so they are
// unit-tested on their own (tests/netpanels/panelmodel.test.mjs). The rules and the draft are in model.js, the option tables in schema.js.
import { parseCidr, overlaps, subnetOf, subnetText } from './checks.js';
import { DEVICE_GROUPS, IFACE_FIELDS, IFACE_GROUPS, OTHER_PROTOS, PROTOS, deviceFields, idOf, ifaceFields } from './schema.js';
import { aliasChoices, deviceChoices, deviceList, ifaceList, portOwners, protoLabel, runtimeDevices } from './model.js';

//#region Protocols and essential options

// The protocol cards of the interface panel and the wizard: the protocol's id and label (schema.js PROTOS), what it is for, and what it asks for.
export const PROTO_CARDS = [
  { id: 'static', blurb: 'You type the address yourself. Use it for a network the router serves: a LAN, a guest network, a lab.', asks: 'An address with its prefix length; optionally a gateway and DNS servers.' },
  { id: 'dhcp', blurb: 'A DHCP server on the other side hands out the address, the gateway and the DNS servers. Use it for an uplink.', asks: 'Nothing: everything comes from the server.' },
  { id: 'dhcpv6', blurb: 'The provider hands out an IPv6 address and a prefix to delegate to your networks. Usually used beside a DHCP or PPPoE uplink.', asks: 'Nothing by default; optionally which prefix to request.' },
  { id: 'pppoe', blurb: 'A DSL or fiber login over Ethernet. The router builds a PPP session (a device called pppoe-<name>) on top of the device.', asks: 'The username and password of your provider, on the device that reaches it.' },
  { id: 'none', blurb: 'The interface exists but netifd configures nothing on it. Use it for a device that another program manages.', asks: 'Nothing.' },
].map(c => ({ ...c, title: PROTOS.find(p => p.id === c.id)?.label ?? c.id }));

// The options of an interface that its protocol needs to work, in the order the panel shows them; every other option of the protocol is advanced.
// `proto` and `device` have sections of their own.
export const ESSENTIAL_IFACE = {
  static: ['ipaddr', 'gateway', 'dns'],
  dhcp: ['peerdns', 'defaultroute'],
  dhcpv6: ['reqaddress', 'reqprefix'],
  pppoe: ['username', 'password'],
  none: [],
};

// What each protocol needs, in a sentence for the settings section when it has few essential options.
export const SETTINGS_LEAD = {
  static: 'The address of the router on this network, and where the rest of the world is.',
  dhcp: 'Nothing to fill in: the server supplies the address, the gateway and the DNS servers. These two choose what to take from it.',
  dhcpv6: 'Nothing to fill in: the provider supplies the address and the prefix. These choose what to ask for.',
  pppoe: 'The login your provider gave you. The password is never shown here; leave it empty to keep the stored one.',
  none: 'Nothing to fill in: netifd leaves the interface alone.',
};

// The options of a device that matter most, by device type; the others are advanced.
export const ESSENTIAL_DEVICE = {
  bridge: ['stp', 'vlan_filtering', 'igmp_snooping', 'mtu', 'macaddr'],
  '8021q': ['ifname', 'vid', 'mtu', 'macaddr'],
  '8021ad': ['ifname', 'vid', 'mtu', 'macaddr'],
  plain: ['mtu', 'macaddr', 'autoneg', 'speed', 'duplex', 'rxpause', 'txpause', 'eee'],
};

// Splits `fields` into the essential ones (in the order of `essential`, ids) and the advanced rest (in the table's order); `skip` ids are left out of both.
function splitFields(fields, essential, skip = []) {
  const usable = fields.filter(f => !skip.includes(idOf(f)));
  return { essential: essential.map(id => usable.find(f => idOf(f) === id)).filter(Boolean), advanced: usable.filter(f => !essential.includes(idOf(f))) };
}

// The advanced fields as groups of the card (`groups` is IFACE_GROUPS or DEVICE_GROUPS): [{ group, fields }] without the empty ones.
const groupFields = (fields, groups) => groups.map(group => ({ group, fields: fields.filter(f => f.group === group.id) })).filter(g => g.fields.length);

// The fields of an interface panel for its protocol and form values: { essential, advanced, groups } (advanced grouped as IFACE_GROUPS).
export function interfaceSettings(proto, values) {
  const { essential, advanced } = splitFields(ifaceFields(proto, values), ESSENTIAL_IFACE[proto] ?? [], ['proto', 'device']);
  return { essential, advanced, groups: groupFields(advanced, IFACE_GROUPS) };
}

// The fields of a device panel for its type and values: { essential, advanced, groups }.
export function deviceSettings(type) {
  const { essential, advanced } = splitFields(deviceFields(type), ESSENTIAL_DEVICE[type] ?? []);
  return { essential, advanced, groups: groupFields(advanced, DEVICE_GROUPS) };
}

// Whether a draft value of a field holds something that is not the field's own default (used to say how many advanced options are set).
export function isSet(f, value) {
  if (f.type === 'list') return Array.isArray(value) && value.some(x => String(x).trim());
  if (f.type === 'bool') return value !== (f.default ?? false);
  return String(value ?? '').trim() !== '';
}

// The labels of the options that a change of protocol from `from` to `to` drops: options of the old protocol only that hold a value in the form
// or are stored in the config (`stored` lists the option names the section has, secrets included).
export function droppedBy(values, from, to, stored = []) {
  const keep = new Set(ifaceFields(to).map(idOf));
  const labels = IFACE_FIELDS.filter(f => f.key !== 'proto' && f.protos?.includes(from) && !keep.has(idOf(f)) && (isSet(f, values[idOf(f)]) || stored.includes(f.key))).map(f => f.label);
  return [...new Set(labels)];
}

// The read-only protocols' owning page, as { href, label }, or null when the protocol has none here.
export const OWNER_PAGES = { wireguard: { href: '#wireguard', label: 'WireGuard page' }, xfrm: { href: '#ipsec', label: 'IPsec page' } };

// The words for a protocol the page does not edit.
export const otherProtoText = proto => OTHER_PROTOS[proto] ?? protoLabel(proto);

//#endregion

//#region The device chooser

// The speed of a link in words.
const speedText = mbit => (mbit >= 1000 ? `${mbit / 1000} Gbit/s` : `${mbit} Mbit/s`);

// Up to four names, then "+N more".
const nameList = names => (names.length > 4 ? `${names.slice(0, 4).join(', ')} +${names.length - 4} more` : names.join(', '));

// The interfaces (names) of the form that run on the device `value` ("br-lan" or "@wan"), other than the interface `exceptId`.
const interfacesOn = (data, draft, value, exceptId = null) => ifaceList(data, draft)
  .filter(s => !s.removed && s.editable && s.id !== exceptId && draft.ifaces[s.id]?.device.trim() === value).map(s => s.name.trim() || 'a new interface');

// The items of the device chooser for an interface (`ifaceId`, or null for a network about to be created): every device an interface may sit on and
// the interfaces whose device it may borrow, as { value, title, kind, what, usedBy, up?, warn? }. `what` says in words what the device is; `usedBy` names
// the interfaces that already run on it; `warn` is a sentence when the choice is unusual (a port of a bridge).
export function deviceItems(data, draft, ifaceId = null) {
  const runtime = runtimeDevices(data);
  const owners = portOwners(data, draft);
  const sections = deviceList(data, draft).filter(d => !d.removed);
  const ports = data.net?.ports ?? [];
  const items = deviceChoices(data, draft).map(({ name }) => {
    const r = runtime.get(name);
    const section = sections.find(d => d.name.trim() === name);
    const used = interfacesOn(data, draft, name, ifaceId);
    const item = { value: name, title: name, usedBy: used, up: r?.up };
    if (section?.type === 'bridge' || r?.kind === 'bridge') {
      const listed = section ? draft.devices[section.id].ports.map(p => p.trim()).filter(Boolean) : (data.net?.bridges ?? []).find(b => b.name === name)?.members.filter(m => m.kind !== 'wifi').map(m => m.name) ?? [];
      const wifi = (data.net?.bridges ?? []).find(b => b.name === name)?.members.filter(m => m.kind === 'wifi').length ?? 0;
      const parts = [listed.length ? `joins ${listed.length === 1 ? 'the port' : 'the ports'} ${nameList(listed)}` : 'has no ports yet', wifi ? `and ${wifi} Wi-Fi network${wifi === 1 ? '' : 's'}` : null].filter(Boolean);
      return { ...item, kind: 'bridge', what: `A bridge: a software switch that ${parts.join(' ')}.` };
    }
    if (section?.type === '8021q' || section?.type === '8021ad' || r?.kind === 'vlan') {
      const v = section ? draft.devices[section.id] : null;
      const live = (data.net?.vlans ?? []).find(x => x.name === name);
      return { ...item, kind: 'vlan', what: `A VLAN device: only the frames tagged with VLAN ${v?.vid || live?.vid || '?'} of ${v?.ifname || live?.parent || 'its base device'}.` };
    }
    if (r?.kind === 'port') {
      const p = ports.find(x => x.name === name);
      const bridge = owners.get(name)?.[0]?.name.trim() ?? (data.net?.bridges ?? []).find(b => b.members.some(m => m.name === name))?.name;
      const link = p?.carrier ? `link up${p.speed ? ` at ${speedText(p.speed)}` : ''}` : 'no link';
      return { ...item, kind: 'port', what: `An Ethernet port, ${link}.`,
        ...(bridge ? { warn: `Port of ${bridge}: an interface here would bypass the bridge.` } : {}) };
    }
    if (r?.kind === 'conduit') return { ...item, kind: 'conduit', what: 'The link between the CPU and the switch chip. It is not normally used directly.' };
    return { ...item, kind: 'device', what: `${r?.label ? r.label[0].toUpperCase() + r.label.slice(1) : 'A device'} the router reports.` };
  });
  for (const name of aliasChoices(data, draft, ifaceId)) {
    const other = ifaceList(data, draft).find(s => s.name.trim() === name);
    const dev = other && draft.ifaces[other.id] ? draft.ifaces[other.id].device.trim() : String(other?.raw.device ?? '');
    items.push({ value: `@${name}`, title: `@${name}`, kind: 'alias', usedBy: interfacesOn(data, draft, `@${name}`, ifaceId),
      what: `The device of the interface ${name}${dev && !dev.startsWith('@') ? ` (${dev})` : ''}, whatever its protocol makes of it: a PPPoE session, a tunnel. Use it to put a second protocol on the same link.` });
  }
  return items;
}

//#endregion

//#region What uses an interface or a device

// The sentence for a firewall zone's policy.
export const zoneText = z => `input ${String(z.input ?? '?').toLowerCase()}, output ${String(z.output ?? '?').toLowerCase()}, forward ${String(z.forward ?? '?').toLowerCase()}${z.masq ? ', NAT' : ''}`;

// The DHCP address range of a server record (flab.network `dhcp`: `start` is the offset of the first address, `limit` the count) as ".128–.247", or null
// when the server has none.
export const poolText = d => (d.start != null && d.limit ? `.${d.start}–.${d.start + d.limit - 1}` : null);

// The service lines of an interface's DHCP data (flab.network `dhcp`): "DHCPv4 pool .100–.249 · 12h", "DHCPv6 server", "RA server"; empty when it serves nothing.
function serviceLines(d) {
  if (!d) return [];
  const range = poolText(d);
  const pool = range ? `pool ${range}` : null;
  return [
    d.v4 && d.v4 !== 'disabled' ? `DHCPv4 ${pool ?? d.v4}${d.leasetime ? ` · ${d.leasetime}` : ''}` : null,
    d.v6 && d.v6 !== 'disabled' ? `DHCPv6 ${d.v6}` : null,
    d.ra && d.ra !== 'disabled' ? `Router advertisements ${d.ra}` : null,
  ].filter(Boolean);
}

// What the interface `id` is used by: { zone, services, riders } where `zone` is the firewall zone it is in (or null), `services` the DHCP and RA lines
// and `riders` the other interfaces that borrow its device ("@name") or run over it (`tunlink`), as { name, how }.
export function usedByInterface(data, draft, id) {
  const s = ifaceList(data, draft).find(x => x.id === id);
  const name = s?.name.trim() ?? '';
  const zone = name ? (data.net?.zones ?? []).find(z => (z.networks ?? []).includes(name)) ?? null : null;
  const riders = ifaceList(data, draft).filter(x => !x.removed && x.id !== id && name).flatMap(x => {
    const dev = x.editable ? draft.ifaces[x.id].device.trim() : String(x.raw.device ?? '');
    return [dev === `@${name}` ? { name: x.name.trim(), how: 'borrows its device' } : null, String(x.raw.tunlink ?? '') === name ? { name: x.name.trim(), how: 'runs over it' } : null].filter(Boolean);
  });
  return { zone, services: name ? serviceLines(data.net?.dhcp?.[name]) : [], riders };
}

// What the device `name` is used by: { interfaces, vlans, bridge, wifi }: the interfaces that run on it, the VLAN devices on top of it, the bridge it is a
// port of and the Wi-Fi interfaces that join it (when it is a bridge).
export function usedByDevice(data, draft, name) {
  const sections = deviceList(data, draft).filter(d => !d.removed);
  return {
    interfaces: interfacesOn(data, draft, name),
    vlans: sections.filter(d => (d.type === '8021q' || d.type === '8021ad') && draft.devices[d.id].ifname.trim() === name).map(d => d.name.trim()),
    bridge: portOwners(data, draft).get(name)?.[0]?.name.trim() ?? null,
    wifi: ((data.net?.bridges ?? []).find(b => b.name === name)?.members ?? []).filter(m => m.kind === 'wifi').map(m => m.name),
  };
}

//#endregion

//#region Suggestions

// Every IPv4 subnet in use: the addresses and routes netifd reports, the static addresses of the config (and the `addresses` of a tunnel) and the
// static addresses of the form. A subnet is { family, network, prefix, size }; an address without a prefix counts as a host (/32).
export function usedSubnets(data, draft) {
  const out = [];
  // Adds the subnet of an address text, completed by `netmask` when it has no prefix.
  const add = (text, netmask = '') => {
    const c = parseCidr(String(text ?? '').trim(), netmask);
    if (c?.family !== 4) return;
    const s = subnetOf(c.hasPrefix ? c : { ...c, prefix: 32, hasPrefix: true });
    if (s) out.push(s);
  };
  const list = v => [].concat(v ?? []);
  for (const i of data.ifs ?? []) {
    for (const a of i['ipv4-address'] ?? []) add(`${a.address}/${a.mask}`);
    for (const r of i.route ?? []) if (r.mask > 0 && String(r.target).includes('.')) add(`${r.target}/${r.mask}`);
  }
  for (const s of data.cfg?.interfaces ?? []) {
    for (const a of list(s.values.ipaddr)) add(a, String(s.values.netmask ?? ''));
    for (const a of list(s.values.addresses)) add(a);
  }
  for (const s of ifaceList(data, draft)) if (!s.removed && s.editable && draft.ifaces[s.id].proto === 'static') for (const a of draft.ifaces[s.id].ipaddr) add(a, draft.ifaces[s.id].netmask);
  return out;
}

// The /24 candidates of the private ranges, in the order they are offered: 192.168.10.0, .20.0, ... then the other 192.168 ones, then 172.16 and 10.0.
function* candidates() {
  for (let n = 10; n <= 250; n += 10) yield `192.168.${n}.0/24`;
  for (let n = 2; n <= 254; n++) if (n % 10) yield `192.168.${n}.0/24`;
  for (let n = 0; n <= 255; n++) yield `172.16.${n}.0/24`;
  for (let n = 0; n <= 255; n++) yield `10.0.${n}.0/24`;
}

// A free private /24 for a new static network, as { address: '192.168.10.1/24', network: '192.168.10.0/24' } with the router at .1, or null when none is
// left. It overlaps no subnet of usedSubnets().
export function suggestSubnet(data, draft) {
  const used = usedSubnets(data, draft);
  for (const text of candidates()) {
    const s = subnetOf(parseCidr(text));
    if (used.some(u => overlaps(u, s))) continue;
    const base = text.slice(0, text.lastIndexOf('.'));
    return { address: `${base}.1/24`, network: subnetText(s) };
  }
  return null;
}

// The names taken by a section of the config or the form: the ones a new interface must not use.
function takenNames(data, draft) {
  return new Set(['loopback', 'globals', ...(data.cfg?.interfaces ?? []).map(s => s.section), ...(data.cfg?.devices ?? []).filter(s => !s.anonymous).map(s => s.section),
    ...(draft.ifaceAdded ?? []).map(a => a.name.trim())]);
}

// A name made of the letters, digits and underscores an interface name may hold, at most `max` long.
const cleanName = (text, max) => String(text ?? '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);

// The OpenWrt documentation says the kernel limits a device name to 14 usable characters, prefixes that protocols add included (pppoe-, br-, the .VLAN suffix).
export const DEVICE_NAME_MAX = 14;
// The prefix a protocol puts before an interface's name to name the device it creates.
const PROTO_PREFIX = { pppoe: 'pppoe-' };

// The name of the device an interface of a protocol runs on or creates: pppoe-<name> for PPPoE, the device itself otherwise.
export const effectiveDevice = (proto, name, device = '') => (PROTO_PREFIX[proto] ? `${PROTO_PREFIX[proto]}${name}` : device);

// The longest name an interface of a protocol should have so the device it creates stays within DEVICE_NAME_MAX.
export const interfaceNameMax = proto => DEVICE_NAME_MAX - (PROTO_PREFIX[proto]?.length ?? 0);

// A free interface name: the first of the `hints` that is valid and free, then `network`, `network2`, ... `max` is the longest the name may be (8 for PPPoE,
// whose device is called pppoe-<name>).
export function suggestInterfaceName(data, draft, hints = [], max = DEVICE_NAME_MAX) {
  const taken = takenNames(data, draft);
  for (const hint of hints.map(x => cleanName(x, max)).filter(Boolean)) if (!taken.has(hint)) return hint;
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'network' : `network${n}`;
    if (!taken.has(name)) return name;
  }
}

// The names of every device the router has or the form adds.
const deviceNames = (data, draft) => new Set([...runtimeDevices(data).keys(), ...deviceList(data, draft).map(d => d.name.trim())]);

// A free bridge name: br-<stem> (or br-new), with a number when that is taken; never over DEVICE_NAME_MAX characters.
export function suggestBridgeName(data, draft, stem = '') {
  const taken = deviceNames(data, draft);
  const base = `br-${cleanName(stem, 8) || 'new'}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}${n}`.slice(0, DEVICE_NAME_MAX);
    if (!taken.has(name)) return name;
  }
}

// The name of a VLAN device for a base device and an ID: eth1.100; '' when either is missing or the name would be over DEVICE_NAME_MAX characters.
export const vlanName = (base, vid) => (base && /^\d+$/.test(String(vid).trim()) && `${base}.${String(vid).trim()}`.length <= DEVICE_NAME_MAX ? `${base}.${String(vid).trim()}` : '');

// A free VLAN ID for a base device: the first of 10, 20, 30, ... that no VLAN device on it uses.
export function suggestVlanId(data, draft, base) {
  const used = new Set([...(data.net?.vlans ?? []).filter(v => v.parent === base).map(v => String(v.vid)),
    ...deviceList(data, draft).filter(d => !d.removed && (d.type === '8021q' || d.type === '8021ad') && draft.devices[d.id].ifname.trim() === base).map(d => draft.devices[d.id].vid.trim())]);
  for (let n = 10; n < 4095; n += 10) if (!used.has(String(n))) return String(n);
  return '';
}

//#endregion
