// The model of the network board (board.js): how an OpenWrt network is built, resolved into four lanes of items and the edges between them:
//
//   ports and radios (physical)  ->  devices (bridge, VLAN)  ->  interfaces (protocol and addresses)  ->  zones and services
//
// A bridge groups ports and Wi-Fi interfaces, an 802.1q VLAN device sits on a port or a bridge, a netifd interface binds to one device (or
// to another interface's device with `@name`) and holds the protocol and addresses, and some protocols (PPPoE, tunnels) create a device
// of their own on top. An interface can also ride on another interface's protocol device (wan6 on the PPPoE session of wan) or run over
// another interface (an XFRM or GRE tunnel over wan: `tunlink`). The firewall zones group interfaces on the last lane.
//
// Everything is derived from what the router reports (flab.network status, netifd's interface dump, flab.radio) plus, when the page can
// edit, the editor's draft: a device or interface that exists only in the draft is shown as new, one the draft removes as "to be removed",
// and a changed device of an interface moves its connector at once. Pure data in, plain objects out: unit-tested without a browser
// (tests/netboard/boardmodel.test.mjs).
import { deviceList, ifaceList } from './model.js';
import { hwSummary } from '../network/util.js';

// Description of the device a netifd protocol creates under its interface, by protocol name.
const PROTO_DEVICE = {
  pppoe: 'PPPoE session', pppoa: 'PPPoA session', wireguard: 'WireGuard tunnel', xfrm: 'IPsec (XFRM) interface',
  gre: 'GRE tunnel', gretap: 'GRE tunnel', vti: 'VTI tunnel', vxlan: 'VXLAN', '6in4': '6in4 tunnel', '6to4': '6to4 tunnel',
  '6rd': '6rd tunnel', openvpn: 'OpenVPN tunnel', l2tp: 'L2TP session', pptp: 'PPTP session', wwan: 'Mobile broadband', qmi: 'Mobile broadband',
};

// The short name of a protocol for a badge: the ones the editor offers, then the others by what they are; an unknown protocol is shown by its id.
const PROTO_SHORT = {
  static: 'static', dhcp: 'DHCP', dhcpv6: 'DHCPv6', pppoe: 'PPPoE', none: 'unmanaged', wireguard: 'WireGuard', xfrm: 'IPsec XFRM', ppp: 'PPP', pppoa: 'PPPoA', '3g': '3G', qmi: 'QMI',
  ncm: 'NCM', mbim: 'MBIM', wwan: 'mobile', gre: 'GRE', gretap: 'GRE tap', grev6: 'GRE v6', vti: 'VTI', vxlan: 'VXLAN', '6in4': '6in4', '6to4': '6to4', '6rd': '6rd', dslite: 'DS-Lite',
  l2tp: 'L2TP', pptp: 'PPTP', relay: 'relay', hnet: 'HNCP', map: 'MAP', openvpn: 'OpenVPN', batadv: 'batman-adv', bonding: 'bonding',
};

// The order the kinds of device take in the devices lane.
const DEVICE_ORDER = { bridge: 0, vlan: 1, other: 2, unknown: 3 };

// An interface's IPv4 and IPv6 addresses as "address/prefix" strings.
const addressesOf = (i, key) => (i?.[key] ?? []).map(a => `${a.address}/${a.mask}`);

// Default route's next hop (0.0.0.0/0 or ::/0), shown as the gateway.
const gatewayOf = i => (i?.route ?? []).find(r => r.mask === 0 && (r.target === '0.0.0.0' || r.target === '::'))?.nexthop ?? null;

// A route that is not a default route, as text: "10.0.0.0/8 via 1.2.3.4" or "192.168.8.0/24 on link".
function routeText(r) {
  const direct = !r.nexthop || r.nexthop === '0.0.0.0' || r.nexthop === '::';
  return `${r.target}/${r.mask} ${direct ? 'on link' : `via ${r.nexthop}`}${r.metric ? ` (metric ${r.metric})` : ''}`;
}

// The editor's view of its draft, in the plain shape buildBoard() reads: `ifaces` ({ id, name, isNew, removed, editable, proto, device })
// and `devices` ({ id, name, type, isNew, removed, editable, parent, vid, ports, stp, vlanFiltering }). `base` and `draft` are the editor's.
export function editSource(base, draft) {
  const trim = s => String(s ?? '').trim();
  return {
    ifaces: ifaceList(base, draft).map(s => {
      const v = draft.ifaces[s.id] ?? {};
      return { id: s.id, name: trim(s.name), isNew: s.isNew, removed: s.removed, editable: s.editable, proto: s.editable ? trim(v.proto) : trim(s.raw.proto), device: s.editable ? trim(v.device) : trim(s.raw.device) };
    }),
    devices: deviceList(base, draft).map(d => {
      const v = draft.devices[d.id] ?? {};
      return { id: d.id, name: trim(d.name), type: d.type, isNew: d.isNew, removed: d.removed, editable: d.editable,
        parent: trim(v.ifname ?? d.raw.ifname), vid: trim(v.vid ?? d.raw.vid), ports: (v.ports ?? []).map(trim).filter(Boolean), stp: Boolean(v.stp), vlanFiltering: Boolean(v.vlan_filtering) };
    }),
  };
}

// Builds the board. `data` is { net (flab.network status), ifs (netifd's interfaces), radios (flab.radio `radios`, optional) }; `edit` is
// editSource() or null when the page cannot edit (then only what the router reports is shown). Returns
//   items    Map(id -> item), every item with `id`, `kind` (port, wifi, mesh, radio, device, interface, zone) and `lane`
//   edges    [{ id, from, to, kind }] from the left item to the right one (kind: carry, rides, tunlink, zone)
//   lanes    { ports: [{ id, title, band, up, enabled, items, radio }] (groups; `radio` is the radio's own item, null for the Ethernet ports), devices: [item], interfaces: [item], zones: [item] }
//   findings [{ level, text }]      stats  the counts behind the summary tiles
export function buildBoard(data, edit = null) {
  const net = data.net ?? {};
  const ifs = (data.ifs ?? []).filter(i => i.interface !== 'loopback');
  const radios = data.radios ?? [];
  const tunlinks = net.tunlinks ?? {};
  const items = new Map();
  // Device name -> item id, for everything that is a netdev: ports, Wi-Fi interfaces, bridges, VLAN devices, other devices.
  const byName = new Map();
  const edges = new Map();
  const groups = new Map();

  // Adds an item and indexes it by its device name when it has one.
  const add = item => { items.set(item.id, item); if (item.devName) byName.set(item.devName, item.id); return item; };
  // Adds the edge from -> to once.
  const link = (from, to, kind = 'carry') => { if (from && to && from !== to && !edges.has(`${from}>${to}`)) edges.set(`${from}>${to}`, { id: `${from}>${to}`, from, to, kind }); };
  // The group of Wi-Fi interfaces that no radio data describes.
  const looseGroup = () => { if (!groups.has('rg:')) groups.set('rg:', { id: 'rg:', title: 'Wi-Fi interfaces', band: null, up: null, enabled: true, items: [] }); return groups.get('rg:'); };

  //#region Ports and radios
  const portsGroup = { id: 'pg', title: 'Ethernet ports', band: null, up: null, enabled: true, items: [] };
  for (const p of net.ports ?? []) {
    const item = add({ id: `port:${p.name}`, kind: 'port', lane: 'ports', devName: p.name, name: p.name, up: Boolean(p.carrier), speed: p.speed ?? null, role: p.board?.role ?? null,
      index: p.board?.index ?? null, hw: hwSummary(p), hidden: p.role === 'conduit' || p.type === 'swconfig', settings: null });
    portsGroup.items.push(item);
  }
  // One group per radio: the radio is an item of its own (`group.radio`, its interfaces are its `children`) and its Wi-Fi and mesh interfaces are the items.
  for (const r of radios) {
    const group = { id: `rg:${r.name}`, title: r.name, band: r.band ?? null, up: Boolean(r.up), enabled: r.enabled !== false, items: [], radio: null };
    groups.set(group.id, group);
    for (const w of r.interfaces ?? []) {
      const name = w.ifname ?? w.section;
      const item = add({ id: `wifi:${name}`, kind: w.mode === 'mesh' ? 'mesh' : 'wifi', lane: 'ports', devName: w.ifname ?? null, name, mode: w.mode, ssid: w.ssid ?? null, radio: r.name, band: r.band ?? null,
        up: Boolean(w.up && r.up), enabled: w.enabled !== false, running: Boolean(w.ifname), networks: w.networks ?? [] });
      group.items.push(item);
    }
    group.radio = add({ id: `radio:${r.name}`, kind: 'radio', lane: 'ports', devName: null, name: r.name, radio: r.name, band: r.band ?? null, phy: r.phy ?? null, hw: r.hardware?.hardware ? [r.hardware.hardware] : [],
      up: Boolean(r.up), enabled: r.enabled !== false, networks: [], children: group.items.map(i => i.id) });
  }
  //#endregion

  //#region Devices
  // A device item; `type` is bridge, vlan, other or unknown.
  const device = (id, type, name, extra = {}) => add({ id, kind: 'device', lane: 'devices', type, devName: name || null, name, section: null, up: null, isNew: false, removed: false, editable: false,
    members: [], parent: null, vid: null, stp: false, vlanFiltering: false, runtime: null, ...extra });
  // Merges what a section of the draft says into a device item.
  const fromSection = d => {
    const type = d.type === 'bridge' ? 'bridge' : d.type === '8021q' || d.type === '8021ad' ? 'vlan' : 'other';
    return device(`dev:${d.id}`, type, d.name, { section: d.id, isNew: d.isNew, removed: d.removed, editable: d.editable, sectionType: d.type,
      members: d.type === 'bridge' ? d.ports : [], parent: type === 'vlan' ? d.parent : null, vid: type === 'vlan' ? d.vid : null, stp: d.stp, vlanFiltering: d.vlanFiltering });
  };
  const plain = [];
  for (const d of edit?.devices ?? []) {
    if (d.type === 'plain') plain.push(d);
    else fromSection(d);
  }
  // The router's bridges and VLAN devices: merged into the section that defines them, or items of their own.
  for (const b of net.bridges ?? []) {
    const known = items.get(byName.get(b.name));
    const item = known ?? device(`dev:name:${b.name}`, 'bridge', b.name);
    item.runtime = b;
    item.up = Boolean(b.up);
    if (!known || !known.section) {
      item.members = b.members.map(m => m.name);
      item.stp = Boolean(b.stp);
      item.vlanFiltering = Boolean(b.vlan_filtering);
    } else {
      // The ports come from the form, except the Wi-Fi interfaces, which join through the wireless config.
      item.members = [...item.members, ...b.members.filter(m => m.kind === 'wifi' && !item.members.includes(m.name)).map(m => m.name)];
    }
  }
  for (const v of net.vlans ?? []) {
    const known = items.get(byName.get(v.name));
    const item = known ?? device(`dev:name:${v.name}`, 'vlan', v.name);
    item.runtime = v;
    item.up = Boolean(v.up && v.carrier !== false);
    if (!item.parent) item.parent = v.parent;
    if (!item.vid) item.vid = String(v.vid);
  }
  // The settings of an existing device (a `device` section with no type) belong on the port they are for; for any other device they stay a card of their own.
  for (const d of plain) {
    const target = items.get(byName.get(d.name));
    const info = { id: d.id, removed: d.removed, isNew: d.isNew, editable: d.editable };
    if (target && target.kind === 'port') target.settings = info;
    else if (target && target.kind === 'device') target.settingsSection = info;
    else device(`dev:${d.id}`, 'other', d.name, { section: d.id, isNew: d.isNew, removed: d.removed, editable: d.editable, sectionType: 'plain', settingsOnly: true });
  }

  // The item of a device name, created as an unknown device (or a Wi-Fi interface the radio data does not know) when nothing has it. `hint` is the
  // kind a bridge reports for a member.
  function resolve(name, hint = null) {
    if (!name) return null;
    if (byName.has(name)) return byName.get(name);
    if (hint === 'wifi') {
      const item = add({ id: `wifi:${name}`, kind: 'wifi', lane: 'ports', devName: name, name, mode: null, ssid: null, radio: null, band: null, up: true, enabled: true, running: true, networks: [] });
      looseGroup().items.push(item);
      return item.id;
    }
    return device(`dev:name:${name}`, 'unknown', name).id;
  }

  // A bridge's members and a VLAN device's parent are the edges into the devices lane.
  for (const item of [...items.values()].filter(i => i.kind === 'device')) {
    if (item.type === 'bridge') {
      const hints = new Map((item.runtime?.members ?? []).map(m => [m.name, m.kind]));
      for (const m of item.members) link(resolve(m, hints.get(m)), item.id);
    } else if (item.type === 'vlan' && item.parent) link(resolve(item.parent), item.id);
  }
  //#endregion

  //#region Interfaces
  const byIface = new Map();
  // Devices an interface's protocol creates (pppoe-wan, wg0), by the interface that owns them.
  const owner = new Map();
  for (const i of ifs) if (i.l3_device && i.l3_device !== i.device) owner.set(i.l3_device, i.interface);
  const liveOf = new Map(ifs.map(i => [i.interface, i]));
  const rows = [];
  if (edit) {
    for (const s of edit.ifaces) if (s.name !== 'loopback') rows.push({ id: s.id, name: s.name, isNew: s.isNew, removed: s.removed, editable: s.editable, proto: s.proto, device: s.device, section: s.id });
    for (const i of ifs) if (!edit.ifaces.some(s => s.name === i.interface)) rows.push({ id: i.interface, name: i.interface, isNew: false, removed: false, editable: false, proto: i.proto, device: '', section: null });
  } else {
    for (const i of ifs) rows.push({ id: i.interface, name: i.interface, isNew: false, removed: false, editable: false, proto: i.proto, device: '', section: null });
  }
  for (const r of rows) {
    const live = liveOf.get(r.name) ?? null;
    // A section with no `proto` is ignored by netifd and its device stays down; the board says so.
    const noProto = Boolean(r.section) && !r.removed && !r.proto;
    const proto = r.proto || live?.proto || '';
    const deviceName = r.device || live?.device || '';
    // The device a protocol created under this interface (pppoe-wan), or the one it shares with the interface that owns it.
    let protoDevice = null;
    if (live?.l3_device && live.l3_device !== live.device) protoDevice = { name: live.l3_device, label: PROTO_DEVICE[proto] ?? null, shared: false };
    else if (live?.l3_device && owner.has(live.l3_device)) protoDevice = { name: live.l3_device, label: PROTO_DEVICE[liveOf.get(owner.get(live.l3_device))?.proto] ?? null, shared: true };
    const item = add({
      id: `if:${r.id}`, kind: 'interface', lane: 'interfaces', devName: null, name: r.name || 'New network', section: r.section, isNew: r.isNew, removed: r.removed, editable: r.editable,
      proto, noProto, protoText: PROTO_SHORT[proto] ?? (proto || 'no protocol'), device: deviceName, deviceText: null, over: null, protoDevice, live,
      up: Boolean(live?.up), pending: Boolean(live?.pending), running: Boolean(live), uptime: live?.uptime ?? null,
      v4: addressesOf(live, 'ipv4-address'), v6: addressesOf(live, 'ipv6-address'), gateway: gatewayOf(live), dns: live?.['dns-server'] ?? [],
      routes: (live?.route ?? []).filter(x => !(x.mask === 0 && (x.target === '0.0.0.0' || x.target === '::'))).map(routeText),
      prefixes: [...(live?.['ipv6-prefix-assignment'] ?? []).map(p => `${p.address}/${p.mask}`), ...(live?.['ipv6-prefix'] ?? []).map(p => `${p.address}/${p.mask} (received)`)],
    });
    byIface.set(r.name, item.id);
  }
  // Where each interface connects: a device, another interface's device (`@name`, or a protocol device another interface owns) or the interface a tunnel runs over.
  for (const item of [...items.values()].filter(i => i.kind === 'interface')) {
    const name = item.device;
    if (name.startsWith('@')) {
      item.over = name.slice(1);
      item.deviceText = `on the ${PROTO_DEVICE[liveOf.get(item.over)?.proto] ?? 'device'} of ${item.over}`;
      link(byIface.get(item.over), item.id, 'rides');
    } else if (name && owner.has(name)) {
      item.over = owner.get(name);
      const label = PROTO_DEVICE[liveOf.get(item.over)?.proto];
      item.deviceText = `on the ${label ?? 'device'} of ${item.over}`;
      link(byIface.get(item.over), item.id, 'rides');
    } else if (name) {
      item.deviceText = `on ${name}`;
      link(resolve(name), item.id);
    } else if (tunlinks[item.name] && byIface.has(tunlinks[item.name])) {
      item.over = tunlinks[item.name];
      item.deviceText = `runs over ${item.over}`;
      link(byIface.get(item.over), item.id, 'tunlink');
    }
  }
  // A Wi-Fi interface that is configured but not running has no name yet: its `network` option says which interface it will join, which in
  // a bridge means joining the bridge.
  for (const w of [...items.values()].filter(i => i.kind === 'wifi' || i.kind === 'mesh')) {
    if (w.running) continue;
    for (const n of w.networks) {
      const target = items.get(byIface.get(n));
      if (!target) continue;
      const dev = items.get(byName.get(target.device));
      link(w.id, dev?.type === 'bridge' ? dev.id : target.id);
    }
  }
  // A Wi-Fi interface that runs and is not bridged is an interface's device by its own name; that is covered by resolve() above.
  //#endregion

  //#region Zones and services
  const zoneItems = [];
  const zoned = new Set();
  for (const z of net.zones ?? []) {
    const members = [...new Set(z.networks ?? [])];
    const item = add({ id: `zone:${z.name}`, kind: 'zone', lane: 'zones', devName: null, name: z.name, zone: z, networks: members, services: {} });
    for (const n of members) {
      if (byIface.has(n)) { link(byIface.get(n), item.id, 'zone'); zoned.add(n); }
      const d = net.dhcp?.[n];
      if (d) item.services[n] = d;
    }
    zoneItems.push(item);
  }
  const loose = rows.filter(r => !zoned.has(r.name) && !r.removed).map(r => r.name);
  if (loose.length) {
    const item = add({ id: 'zone:none', kind: 'zone', lane: 'zones', devName: null, name: 'No zone', zone: null, networks: loose, services: {} });
    for (const n of loose) { link(byIface.get(n), item.id, 'zone'); if (net.dhcp?.[n]) item.services[n] = net.dhcp[n]; }
    zoneItems.push(item);
  }
  //#endregion

  const edgeList = [...edges.values()];
  const board = { items, edges: edgeList, lanes: null, findings: [], stats: null };

  //#region Order and hide
  // The lowest front-panel position of the ports and radios an item is built on (tunnels with no port rank last), so chains of the same ports stay together.
  const rankCache = new Map();
  const into = new Map();
  for (const e of edgeList) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  const rank = (id, seen = new Set()) => {
    if (rankCache.has(id)) return rankCache.get(id);
    if (seen.has(id)) return 999;
    seen.add(id);
    const it = items.get(id);
    let r = 999;
    if (it?.kind === 'port') r = it.index ?? 998;
    else if (it?.kind === 'wifi' || it?.kind === 'mesh' || it?.kind === 'radio') r = 997;
    for (const from of into.get(id) ?? []) r = Math.min(r, rank(from, seen));
    rankCache.set(id, r);
    return r;
  };
  const byRankName = (a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);

  // A conduit or swconfig "port" is no place to attach anything: shown only when something is attached to it.
  const used = new Set(edgeList.flatMap(e => [e.from, e.to]));
  portsGroup.items = portsGroup.items.filter(p => !p.hidden || used.has(p.id)).sort((a, b) => (a.index ?? 999) - (b.index ?? 999) || a.name.localeCompare(b.name));
  const radioGroups = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title)).map(g => ({ ...g, items: g.items.sort((a, b) => a.name.localeCompare(b.name)) }));
  board.lanes = {
    ports: [...(portsGroup.items.length ? [portsGroup] : []), ...radioGroups.filter(g => g.radio || g.items.length)],
    devices: [...items.values()].filter(i => i.kind === 'device').sort((a, b) => rank(a.id) - rank(b.id) || DEVICE_ORDER[a.type] - DEVICE_ORDER[b.type] || a.name.localeCompare(b.name)),
    interfaces: [...items.values()].filter(i => i.kind === 'interface').sort(byRankName),
    zones: zoneItems,
  };
  //#endregion

  //#region Findings and counts
  const ifaces = board.lanes.interfaces.filter(i => i.running && !i.removed);
  for (const i of ifaces) if (!i.up) board.findings.push({ level: i.pending ? 'warn' : 'bad', text: `Interface ${i.name} (${i.proto}) is ${i.pending ? 'pending' : 'down'}.` });
  for (const i of board.lanes.interfaces) if (i.noProto) board.findings.push({ level: 'warn', text: `Interface ${i.name} has no protocol: netifd ignores all its settings and its device stays down.` });
  for (const w of items.values()) {
    if ((w.kind === 'wifi' || w.kind === 'mesh') && !used.has(w.id)) board.findings.push({ level: 'warn', text: `Wireless interface ${w.name}${w.radio ? ` (radio ${w.radio})` : ''} is not attached to any network interface.` });
  }
  const wl = radios.flatMap(r => r.interfaces ?? []);
  const mesh = wl.filter(w => w.mode === 'mesh').length;
  board.stats = {
    interfacesUp: ifaces.filter(i => i.up).length, interfaces: ifaces.length,
    bridges: (net.bridges ?? []).length, vlans: (net.vlans ?? []).length, vlanNames: (net.vlans ?? []).map(v => v.name),
    protocolDevices: ifaces.filter(i => i.protoDevice && !i.protoDevice.shared).length,
    tunnels: ifaces.filter(i => !i.device).length,
    radiosUp: radios.filter(r => r.up).length, radios: radios.length, bands: radios.map(r => r.band).filter(Boolean),
    wireless: wl.length, mesh,
  };
  //#endregion
  return board;
}

// Everything connected to an item, for highlighting: the items it is built on (to the left, transitively) and the items built on it (to the
// right, transitively), and the edges between them. A bridge's other ports and a VLAN's sibling are not related to a port, only its own chain is. A radio is
// related to everything its wireless interfaces are.
export function related(board, id) {
  const start = [id, ...(board.items.get(id)?.children ?? [])];
  const ids = new Set(start);
  // Adds everything reachable from the item in one direction: `forward` follows from -> to, otherwise to -> from.
  const walk = forward => {
    const queue = [...start];
    const seen = new Set(start);
    while (queue.length) {
      const at = queue.shift();
      for (const e of board.edges) {
        const [here, there] = forward ? [e.from, e.to] : [e.to, e.from];
        if (here !== at || seen.has(there)) continue;
        seen.add(there);
        ids.add(there);
        queue.push(there);
      }
    }
  };
  walk(true);
  walk(false);
  return { ids, edges: new Set(board.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map(e => e.id)) };
}
