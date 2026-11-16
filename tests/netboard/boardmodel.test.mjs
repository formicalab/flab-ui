// Unit tests of the network board's model (www/js/pages/interfaces/boardmodel.js): the lanes, the items with stable ids, the edges between them,
// the highlighting set, the draft's new and removed items, wireless, zones, findings and counts. Pure data, no router and no browser.
// Usage: node boardmodel.test.mjs
import assert from 'node:assert/strict';
import { buildBoard, editSource, related } from '../../www/js/pages/interfaces/boardmodel.js';
import {
  addDevice, addInterface, draftFrom, readNetwork, removeDevice, removeInterface, setPort,
} from '../../www/js/pages/interfaces/model.js';

let passed = 0;
const failures = [];
// Runs one named test and prints the outcome; the failures are counted for the exit code.
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failures.push(name); console.log(`FAIL  ${name}  -> ${e.message}`); }
}
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

//#region A router like the lab one: switch ports in a bridge (plus Wi-Fi), a VLAN on the bridge, VLANs on the WAN port carrying PPPoE, wan6 riding on
// the PPPoE session, a WireGuard tunnel, tunnels over wan, an interface directly on a port and one on a device the router does not describe.
// A front-panel port; `index` is its position on the board (absent for a port without a board entry, e.g. eth0).
const port = (name, carrier, index, extra = {}) => ({ name, carrier, speed: carrier ? 1000 : null, role: 'switch', board: index == null ? null : { role: index === 5 ? 'wan' : 'lan', index }, ...extra });
const NET = {
  ports: [port('lan1', true, 0), port('lan2', false, 1), port('eth1', true, 5, { role: 'nic' }), port('eth0', true, undefined, { role: 'conduit' }), port('sw0', false, undefined, { type: 'swconfig' })],
  bridges: [{ name: 'br-lan', up: true, stp: true, vlan_filtering: false, members: [{ name: 'lan1', kind: 'ethernet', carrier: true }, { name: 'lan2', kind: 'ethernet', carrier: false }, { name: 'phy0-ap0', kind: 'wifi', carrier: true }] }],
  vlans: [
    { name: 'br-lan.100', parent: 'br-lan', vid: 100, up: true, carrier: true },
    { name: 'eth1.1036', parent: 'eth1', vid: 1036, up: true, carrier: true },
    { name: 'eth1.1035', parent: 'eth1', vid: 1035, up: true, carrier: true },
  ],
  tunlinks: { xfrm0: 'wan' },
  zones: [
    { name: 'lan', networks: ['lan', 'lan100'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', masq: false, forwards: ['wan'] },
    { name: 'wan', networks: ['wan', 'wan6', 'voip'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: true, forwards: [] },
  ],
  dhcp: { lan: { v4: 'server', v6: 'server', ra: 'server', start: 100, limit: 150, leasetime: '12h' } },
};
// A netifd interface record as the plugin reports it: `device` is the L2 device, `l3` the device carrying addresses.
const iface = (name, proto, device, l3, extra = {}) => ({ interface: name, proto, device, l3_device: l3, up: true, ...extra });
const IFS = [
  iface('loopback', 'static', 'lo', 'lo'),
  iface('lan', 'static', 'br-lan', 'br-lan', { 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }], uptime: 90 }),
  iface('lan100', 'static', 'br-lan.100', 'br-lan.100'),
  iface('wan', 'pppoe', 'eth1.1036', 'pppoe-wan', { route: [{ target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' }, { target: '10.0.0.0', mask: 8, nexthop: '1.2.3.4' }], 'dns-server': ['1.1.1.1'] }),
  iface('voip', 'pppoe', 'eth1.1035', 'pppoe-voip'),
  iface('wan6', 'dhcpv6', 'pppoe-wan', 'pppoe-wan'),
  iface('wg0', 'wireguard', undefined, 'wg0'),
  iface('xfrm0', 'xfrm', undefined, 'xfrm0'),
  iface('direct', 'static', 'lan2', 'lan2'),
  iface('ghost', 'static', 'nope0', 'nope0'),
];
const RADIOS = [
  { name: 'radio0', band: '2g', up: true, enabled: true, interfaces: [
    { section: 'a0', ifname: 'phy0-ap0', mode: 'ap', ssid: 'home', up: true, enabled: true, networks: ['lan'] },
    { section: 'm0', ifname: 'phy0-mesh0', mode: 'mesh', ssid: 'meshid', up: true, enabled: true, networks: ['lan'] },
    { section: 'g0', ifname: null, mode: 'ap', ssid: 'guest', up: false, enabled: true, networks: ['lan'] },
    { section: 'x0', ifname: 'phy0-ap1', mode: 'ap', ssid: 'stray', up: true, enabled: true, networks: ['nowhere'] },
  ] },
  { name: 'radio1', band: '5g', up: false, enabled: true, interfaces: [] },
  { name: 'radio2', band: '6g', up: true, enabled: true, interfaces: [{ section: 's0', ifname: 'phy2-sta0', mode: 'sta', ssid: 'up', up: true, enabled: true, networks: ['uplink'] }] },
];
// The runtime data of a page; `wireless` adds the radios, the Wi-Fi mesh member of the bridge and a station interface.
function runtime(wireless = false) {
  const net = clone(NET), ifs = clone(IFS);
  if (wireless) {
    net.bridges[0].members.push({ name: 'phy0-mesh0', kind: 'wifi', carrier: true });
    ifs.push(iface('uplink', 'dhcp', 'phy2-sta0', 'phy2-sta0'));
  }
  return { net, ifs, radios: wireless ? clone(RADIOS) : [] };
}
// The ids of the edges, joined for compact comparisons.
const edgeIds = board => board.edges.map(e => e.id);
// The edge from one item id to another, or undefined.
const edgeOf = (board, from, to) => board.edges.find(e => e.from === from && e.to === to);
// The names of a list of items, joined.
const names = list => list.map(x => x.name).join();
//#endregion

const base = buildBoard(runtime());

test('the lanes: ports, devices, interfaces and zones, loopback left out', () => {
  assert.equal(names(base.lanes.ports.find(g => g.id === 'pg').items), 'lan1,lan2,eth1');
  assert.ok(base.lanes.interfaces.every(i => i.name !== 'loopback'));
  assert.equal(base.lanes.devices.length, 5);
  assert.equal(base.lanes.zones.map(z => z.name).join(), 'lan,wan,No zone');
});

test('the conduit and a swconfig pseudo port are not shown unless something is attached to them', () => {
  assert.ok(!base.lanes.ports.flatMap(g => g.items).some(p => p.name === 'eth0' || p.name === 'sw0'));
  const net = clone(NET);
  net.vlans.push({ name: 'eth0.5', parent: 'eth0', vid: 5, up: true });
  const used = buildBoard({ net, ifs: clone(IFS), radios: [] });
  assert.ok(used.lanes.ports.flatMap(g => g.items).some(p => p.name === 'eth0'));
});

test('a bridge groups its ports and Wi-Fi; a VLAN on a bridge stacks on the bridge', () => {
  assert.ok(edgeOf(base, 'port:lan1', 'dev:name:br-lan') && edgeOf(base, 'port:lan2', 'dev:name:br-lan'));
  assert.ok(edgeOf(base, 'dev:name:br-lan', 'if:lan')?.kind === 'carry');
  assert.ok(edgeOf(base, 'dev:name:br-lan', 'dev:name:br-lan.100') && edgeOf(base, 'dev:name:br-lan.100', 'if:lan100'));
  const bridge = base.items.get('dev:name:br-lan');
  assert.equal(bridge.type, 'bridge');
  assert.ok(bridge.stp && bridge.members.length === 3);
});

test('a Wi-Fi interface the radio data does not know is kept as a Wi-Fi item, never dropped', () => {
  assert.ok(base.items.get('wifi:phy0-ap0') && edgeOf(base, 'wifi:phy0-ap0', 'dev:name:br-lan'));
  assert.equal(base.lanes.ports.find(g => g.id === 'rg:').title, 'Wi-Fi interfaces');
});

test('PPPoE over a VLAN over a port: eth1 > eth1.1036 > wan, with the protocol device', () => {
  assert.ok(edgeOf(base, 'port:eth1', 'dev:name:eth1.1036') && edgeOf(base, 'dev:name:eth1.1036', 'if:wan'));
  const wan = base.items.get('if:wan');
  assert.deepEqual(wan.protoDevice, { name: 'pppoe-wan', label: 'PPPoE session', shared: false });
  assert.equal(wan.deviceText, 'on eth1.1036');
  assert.equal(wan.gateway, '203.0.113.1');
  assert.deepEqual(wan.routes, ['10.0.0.0/8 via 1.2.3.4']);
  assert.deepEqual(wan.dns, ['1.1.1.1']);
});

test('a second VLAN on the same port has its own chain', () => {
  assert.ok(edgeOf(base, 'dev:name:eth1.1035', 'if:voip') && base.items.get('if:voip').protoDevice.name === 'pppoe-voip');
});

test('wan6 rides on the PPPoE session of wan and shows the shared protocol device', () => {
  const e = edgeOf(base, 'if:wan', 'if:wan6');
  assert.equal(e?.kind, 'rides');
  const wan6 = base.items.get('if:wan6');
  assert.equal(wan6.over, 'wan');
  assert.equal(wan6.deviceText, 'on the PPPoE session of wan');
  assert.deepEqual(wan6.protoDevice, { name: 'pppoe-wan', label: 'PPPoE session', shared: true });
  assert.ok(!edgeIds(base).some(id => id.endsWith('>if:wan6') && !id.startsWith('if:wan>')));
});

test('a tunnel with no underlay is just its protocol device; one with a tunlink runs over that interface', () => {
  assert.ok(!edgeIds(base).some(id => id.endsWith('>if:wg0')));
  assert.equal(base.items.get('if:wg0').protoDevice.label, 'WireGuard tunnel');
  const t = edgeOf(base, 'if:wan', 'if:xfrm0');
  assert.equal(t?.kind, 'tunlink');
  assert.equal(base.items.get('if:xfrm0').deviceText, 'runs over wan');
});

test('an interface directly on a port has no device layer', () => {
  assert.ok(edgeOf(base, 'port:lan2', 'if:direct'));
});

test('a device the router does not describe is kept as an unknown device', () => {
  const ghost = base.items.get('dev:name:nope0');
  assert.equal(ghost?.type, 'unknown');
  assert.ok(edgeOf(base, 'dev:name:nope0', 'if:ghost'));
});

test('interfaces on the first front-panel ports come first, tunnels with no port last', () => {
  const order = names(base.lanes.interfaces).split(',');
  assert.ok(order.indexOf('lan') < order.indexOf('wan'), order.join());
  assert.ok(order.indexOf('wan') < order.indexOf('wg0') && order.indexOf('wan') < order.indexOf('xfrm0'), order.join());
  const devices = names(base.lanes.devices).split(',');
  assert.equal(devices[0], 'br-lan');
});

test('zones list their interfaces and services; interfaces without a zone get a "No zone" card', () => {
  const lan = base.items.get('zone:lan');
  assert.equal(lan.services.lan.start, 100);
  assert.ok(edgeOf(base, 'if:lan', 'zone:lan')?.kind === 'zone' && edgeOf(base, 'if:wan6', 'zone:wan'));
  assert.deepEqual(base.items.get('zone:none').networks.sort(), ['direct', 'ghost', 'wg0', 'xfrm0']);
});

test('highlighting: an item relates to what it is built on and what is built on it, not to its siblings', () => {
  const r = related(base, 'port:lan1');
  assert.ok(r.ids.has('dev:name:br-lan') && r.ids.has('if:lan') && r.ids.has('if:lan100') && r.ids.has('zone:lan') && r.ids.has('dev:name:br-lan.100'));
  assert.ok(!r.ids.has('port:lan2') && !r.ids.has('if:direct') && !r.ids.has('if:wan'));
  const w = related(base, 'if:wan6');
  assert.ok(w.ids.has('if:wan') && w.ids.has('port:eth1') && w.ids.has('dev:name:eth1.1036') && w.ids.has('zone:wan') && !w.ids.has('if:voip'));
  assert.ok(w.edges.has('port:eth1>dev:name:eth1.1036') && !w.edges.has('port:lan1>dev:name:br-lan'));
  assert.deepEqual([...related(base, 'if:wg0').ids].sort(), ['if:wg0', 'zone:none']);
});

test('findings: a down or pending interface; counts for the summary tiles', () => {
  const r = runtime();
  r.ifs.find(i => i.interface === 'wan').up = false;
  r.ifs.find(i => i.interface === 'voip').up = false;
  r.ifs.find(i => i.interface === 'voip').pending = true;
  const b = buildBoard(r);
  assert.deepEqual(b.findings.map(f => `${f.level}:${f.text}`).sort(), ['bad:Interface wan (pppoe) is down.', 'warn:Interface voip (pppoe) is pending.']);
  assert.equal(base.findings.length, 0);
  assert.deepEqual([base.stats.interfaces, base.stats.interfacesUp, base.stats.bridges, base.stats.vlans], [9, 9, 1, 3]);
  assert.equal(base.stats.protocolDevices, 4);
  assert.equal(base.stats.tunnels, 2);
});

test('a parent loop and an empty router do not hang or throw', () => {
  const loop = buildBoard({ net: { ports: [], bridges: [], vlans: [{ name: 'a.1', parent: 'a.2', vid: 1, up: true }, { name: 'a.2', parent: 'a.1', vid: 2, up: true }] }, ifs: [iface('x', 'static', 'a.1', 'a.1')], radios: [] });
  assert.equal(loop.lanes.interfaces.length, 1);
  assert.ok(related(loop, 'if:x').ids.size >= 1);
  const empty = buildBoard({ net: { ports: [], bridges: [], vlans: [] }, ifs: [], radios: [] });
  assert.equal(empty.items.size, 0);
  assert.equal(buildBoard({}).items.size, 0);
});

//#region Wireless
const wb = buildBoard(runtime(true));

test('a bridged Wi-Fi interface knows its radio, band and SSID; a mesh interface is its own kind', () => {
  const ap = wb.items.get('wifi:phy0-ap0');
  assert.deepEqual([ap.kind, ap.radio, ap.band, ap.ssid, ap.up], ['wifi', 'radio0', '2g', 'home', true]);
  assert.equal(wb.items.get('wifi:phy0-mesh0').kind, 'mesh');
  assert.ok(edgeOf(wb, 'wifi:phy0-ap0', 'dev:name:br-lan') && edgeOf(wb, 'wifi:phy0-mesh0', 'dev:name:br-lan'));
});

test('wireless interfaces are grouped by radio, each once', () => {
  const groups = wb.lanes.ports;
  assert.deepEqual(groups.map(g => g.title), ['Ethernet ports', 'radio0', 'radio1', 'radio2']);
  const radio0 = groups.find(g => g.title === 'radio0');
  assert.equal(names(radio0.items), 'g0,phy0-ap0,phy0-ap1,phy0-mesh0');
  assert.equal(new Set(groups.flatMap(g => g.items.map(i => i.id))).size, groups.flatMap(g => g.items).length);
});

test('a port card carries a hardware summary, one line each: PHY, switch port or SoC MAC, optical module', () => {
  const hw = (hardware, extra = {}) => buildBoard({ net: { ports: [port('lan1', true, 0, { hardware, ...extra })], bridges: [], vlans: [] }, ifs: [], radios: [] }).items.get('port:lan1').hw;
  assert.deepEqual(hw({ phy: { name: 'RTL8221B 2.5Gbps PHY', address: 7, bus: 'mdio-bus' }, switch: 'MediaTek MT7531', switch_port: 5 }), ['RTL8221B 2.5Gbps PHY', 'MediaTek MT7531 · port 5']);
  assert.deepEqual(hw({ soc: 'MediaTek', driver: 'mtk_soc_eth' }), ['MediaTek MAC']);
  assert.deepEqual(hw({ phy: { name: 'MediaTek MT7531 PHY', address: 1, bus: 'mdio-bus' }, switch: 'MediaTek MT7531', switch_port: 1 }), ['MediaTek MT7531 PHY · port 1']);
  assert.deepEqual(hw(undefined, { sfp: { present: true, vendor: 'FS', part: 'SFP-10G' } }), ['FS SFP-10G']);
  assert.deepEqual(hw(undefined), []);
});

test('every radio is an item of its own, with its interfaces as children, and is related to what they are', () => {
  const radio = wb.lanes.ports.find(g => g.title === 'radio0');
  assert.equal(radio.radio.id, 'radio:radio0');
  assert.equal(radio.radio.kind, 'radio');
  assert.deepEqual([...radio.radio.children].sort(), radio.items.map(i => i.id).sort());
  const rel = related(wb, 'radio:radio0');
  assert.ok(radio.items.every(i => rel.ids.has(i.id)) && rel.ids.has('dev:name:br-lan'));
});

test('a configured Wi-Fi interface that is not running joins the bridge of the network named in its config', () => {
  assert.ok(edgeOf(wb, 'wifi:g0', 'dev:name:br-lan'));
  assert.equal(wb.items.get('wifi:g0').running, false);
});

test('an interface directly on a station interface sits on that Wi-Fi item', () => {
  assert.ok(edgeOf(wb, 'wifi:phy2-sta0', 'if:uplink'));
});

test('a wireless interface nothing uses is a finding; a radio with no interface is an item without one', () => {
  assert.ok(wb.findings.some(f => /phy0-ap1 \(radio radio0\) is not attached to any network interface/.test(f.text)));
  assert.equal(wb.findings.length, 1);
  assert.equal(wb.items.get('radio:radio1').kind, 'radio');
  assert.deepEqual([wb.stats.radios, wb.stats.radiosUp, wb.stats.wireless, wb.stats.mesh], [3, 2, 5, 1]);
});

test('without radio data nothing wireless is invented', () => {
  assert.equal(base.lanes.ports.some(g => g.id.startsWith('rg:') && g.id !== 'rg:'), false);
});
//#endregion

//#region The editor's draft
// The data and a draft of a small editable network, the shape a page hands the model.
function editable() {
  const section = (name, values, anonymous = false) => ({ section: name, anonymous, values, secrets: {} });
  const cfg = readNetwork({
    interfaces: [section('lan', { device: 'br-lan', proto: 'static', ipaddr: '192.168.1.1/24' }), section('wan', { device: 'eth1', proto: 'dhcp' }), section('wg0', { proto: 'wireguard' })],
    devices: [section('cfg1', { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2'] }, true), section('cfg2', { name: 'lan1', mtu: '1400' }, true)],
  });
  const net = { ports: [port('lan1', true, 0), port('lan2', true, 1), port('eth1', true, 2, { role: 'nic' })], bridges: [{ name: 'br-lan', up: true, members: [{ name: 'lan1', kind: 'ethernet' }, { name: 'lan2', kind: 'ethernet' }] }], vlans: [], zones: [], dhcp: {} };
  const ifs = [iface('loopback', 'static', 'lo', 'lo'), iface('lan', 'static', 'br-lan', 'br-lan'), iface('wan', 'dhcp', 'eth1', 'eth1'), iface('wg0', 'wireguard', undefined, 'wg0')];
  const data = { cfg, net, ifs, radios: [] };
  return { data, draft: draftFrom(data) };
}

test('an untouched draft gives the same board as the router alone, with the sections as the items\' ids', () => {
  const { data, draft } = editable();
  const b = buildBoard(data, editSource(data, draft));
  assert.ok(b.items.has('if:lan') && b.items.has('if:wan') && b.items.has('if:wg0'));
  const bridge = b.items.get('dev:cfg1');
  assert.equal(bridge.name, 'br-lan');
  assert.equal(bridge.section, 'cfg1');
  assert.equal(bridge.up, true);
  assert.ok(edgeOf(b, 'port:lan1', 'dev:cfg1') && edgeOf(b, 'dev:cfg1', 'if:lan'));
  assert.ok(!b.items.has('dev:name:br-lan'));
  assert.equal(b.items.get('if:wg0').editable, false);
  assert.equal(b.items.get('if:lan').editable, true);
});

test('the settings of a port are a mark on the port, not a card of their own', () => {
  const { data, draft } = editable();
  const b = buildBoard(data, editSource(data, draft));
  assert.equal(b.items.get('port:lan1').settings.id, 'cfg2');
  assert.ok(!b.lanes.devices.some(d => d.name === 'lan1'));
});

test('settings of a device nothing else describes stay a card of the devices lane', () => {
  const { data, draft } = editable();
  const id = addDevice(data, draft, 'plain');
  draft.devAdded.find(a => a.id === id).name = 'dummy0';
  const b = buildBoard(data, editSource(data, draft));
  const card = b.items.get(`dev:${id}`);
  assert.equal(card.type, 'other');
  assert.ok(card.isNew && card.settingsOnly);
});

test('moving an interface to another device in the draft moves its edge at once', () => {
  const { data, draft } = editable();
  draft.ifaces.lan.device = 'eth1';
  const b = buildBoard(data, editSource(data, draft));
  assert.ok(edgeOf(b, 'port:eth1', 'if:lan') && !edgeOf(b, 'dev:cfg1', 'if:lan'));
  assert.equal(b.items.get('if:lan').deviceText, 'on eth1');
});

test('a new interface and a new bridge exist only in the draft and are marked new', () => {
  const { data, draft } = editable();
  const bid = addDevice(data, draft, 'bridge');
  draft.devAdded.find(a => a.id === bid).name = 'br-guest';
  setPort(data, draft, bid, 'lan2', true);
  const iid = addInterface(data, draft);
  draft.ifaces[iid].device = 'br-guest';
  const b = buildBoard(data, editSource(data, draft));
  const bridge = b.items.get(`dev:${bid}`), net = b.items.get(`if:${iid}`);
  assert.ok(bridge.isNew && net.isNew && net.up === false && net.running === false);
  assert.ok(edgeOf(b, 'port:lan2', `dev:${bid}`) && edgeOf(b, `dev:${bid}`, `if:${iid}`));
  assert.ok(!edgeOf(b, 'port:lan2', 'dev:cfg1'));
  assert.equal(b.findings.length, 0);
  assert.ok(related(b, `if:${iid}`).ids.has('port:lan2'));
});

test('a name typed into a new device does not change its id, so an open panel stays open', () => {
  const { data, draft } = editable();
  const bid = addDevice(data, draft, 'bridge');
  const before = buildBoard(data, editSource(data, draft)).items.get(`dev:${bid}`);
  draft.devAdded.find(a => a.id === bid).name = 'br-other';
  const after = buildBoard(data, editSource(data, draft)).items.get(`dev:${bid}`);
  assert.equal(before.id, after.id);
  assert.notEqual(before.name, after.name);
});

test('removed sections stay on the board, marked to be removed; a discarded new one is gone', () => {
  const { data, draft } = editable();
  removeInterface(draft, 'wan');
  removeDevice(draft, 'cfg1');
  const iid = addInterface(data, draft);
  removeInterface(draft, iid);
  const b = buildBoard(data, editSource(data, draft));
  assert.ok(b.items.get('if:wan').removed && b.items.get('dev:cfg1').removed);
  assert.ok(!b.items.has(`if:${iid}`));
  assert.ok(b.stats.interfaces === 2);
});

test('a VLAN device of the draft sits on its base device', () => {
  const { data, draft } = editable();
  const vid = addDevice(data, draft, '8021q');
  draft.devAdded.find(a => a.id === vid).name = 'eth1.200';
  draft.devices[vid].ifname = 'eth1';
  draft.devices[vid].vid = '200';
  const b = buildBoard(data, editSource(data, draft));
  const v = b.items.get(`dev:${vid}`);
  assert.deepEqual([v.type, v.vid, v.parent, v.isNew], ['vlan', '200', 'eth1', true]);
  assert.ok(edgeOf(b, 'port:eth1', `dev:${vid}`));
});

test('a bridge that the draft gives a port it does not have shows an unknown device, not a crash', () => {
  const { data, draft } = editable();
  setPort(data, draft, 'cfg1', 'ethX', true);
  const b = buildBoard(data, editSource(data, draft));
  assert.equal(b.items.get('dev:name:ethX').type, 'unknown');
  assert.ok(edgeOf(b, 'dev:name:ethX', 'dev:cfg1'));
});

test('an interface section with no protocol is a finding: its settings are ignored and its device stays down', () => {
  const { data, draft } = editable();
  data.cfg.interfaces.push({ section: 'bare', name: 'bare', anonymous: false, values: { device: 'eth1' }, secrets: {} });
  draft.ifaces.bare = { ...draft.ifaces.lan, proto: '', device: 'eth1' };
  const b = buildBoard(data, editSource(data, draft));
  assert.equal(b.items.get('if:bare').noProto, true);
  assert.ok(b.findings.some(f => /Interface bare has no protocol/.test(f.text)));
  assert.equal(b.items.get('if:lan').noProto, false);
});

test('a router without the editor (no config) still shows interfaces from netifd alone', () => {
  const { data } = editable();
  const b = buildBoard(data, null);
  assert.ok(b.items.has('if:lan') && b.items.has('dev:name:br-lan'));
  assert.equal(b.items.get('if:lan').editable, false);
  assert.equal(b.items.get('if:lan').section, null);
});
//#endregion

console.log(failures.length ? `\n${failures.length} test(s) FAILED: ${failures.join('; ')}` : `\nall ${passed} board model checks passed`);
process.exit(failures.length ? 1 : 0);
