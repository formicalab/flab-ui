// Unit tests of the network editor's pure model (www/js/pages/interfaces: checks.js, schema.js, model.js). No router, no browser.
// Usage: node model.test.mjs
import assert from 'node:assert/strict';
import { parseCidr, subnetOf, subnetText, overlaps, contains, VERIFY } from '../../www/js/pages/interfaces/checks.js';
import { maskPrefix } from '../../www/js/core/ip.js';
import { DEVICE_FIELDS, IFACE_FIELDS, deviceFields, idOf, ifaceFields } from '../../www/js/pages/interfaces/schema.js';
import {
  addDevice, addInterface, changesOf, checkApplied, deviceChoices, deviceList, downAfter, draftFrom, ifaceList, isDirty, managementInterfaces, plan, portChoices,
  portOwners, problems, readNetwork, removeDevice, removeInterface, restoreInterface, risksOf, runtimeDevices, setPort, setProto,
} from '../../www/js/pages/interfaces/model.js';

let passed = 0;
// Runs one named test and prints the outcome; the failures are counted for the exit code.
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failures.push(name); console.log(`FAIL  ${name}  -> ${e.message}`); }
}
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

//#region A router like the real one: a bridge on five ports, PPPoE over a VLAN, a second VLAN network, a WireGuard tunnel
// A section of the plugin's reply: options without the secrets, and which secrets are set.
const sec = (section, values, secrets = {}, anonymous = false) => ({ section, anonymous, values, secrets });
const REPLY = {
  generated: 1,
  interfaces: [
    sec('loopback', { device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' }),
    sec('lan', { device: 'br-lan', proto: 'static', ipaddr: '192.168.1.1', netmask: '255.255.255.0', ip6assign: '60', ip6hint: '0' }),
    sec('wan', { device: 'eth1.1036', proto: 'pppoe', username: 'user1', ipv6: '0', peerdns: '0', vlandid: '1036', host_uniq: '5231' }, { password: true }),
    sec('wan6', { proto: 'dhcpv6', device: '@wan', reqaddress: 'try', reqprefix: 'auto', norelease: '1' }),
    sec('lan100', { proto: 'static', device: 'br-lan.100', ipaddr: '192.168.100.1', netmask: '255.255.255.0', ip6assign: '64', ip6hint: '64' }),
    sec('xfrm0', { proto: 'xfrm', ifid: '357', tunlink: 'wan', mtu: '1438', zone: 'vpn' }),
    sec('wg0', { proto: 'wireguard', listen_port: '51820', addresses: ['192.168.2.1/24'] }, { private_key: true }),
  ],
  devices: [
    sec('cfg030f15', { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3', 'lan4', 'lan5'], stp: '1' }, {}, true),
    sec('cfg040f15', { type: '8021q', ifname: 'eth1', vid: '1036', name: 'eth1.1036', macaddr: '74:36:6D:C0:9B:83' }, {}, true),
    sec('cfg050f15', { type: '8021q', ifname: 'br-lan', vid: '100', name: 'br-lan.100' }, {}, true),
  ],
  globals: sec('globals', { ula_prefix: 'fd92:cdf9:fb3f::/48', packet_steering: '2', dhcp_default_duid: '0004abcd', custom_opt: 'x' }),
  other: { route: 1, wireguard_wg0: 2 },
  bridge_vlans: [],
};
// The runtime the pages load next to the config: the plugin's status (ports, bridge, VLAN devices, zones) and netifd's interface dump.
const NET = {
  ports: [
    ...['lan1', 'lan2', 'lan3', 'lan4', 'lan5'].map(name => ({ name, role: 'switch', carrier: true })),
    { name: 'eth1', role: 'nic', carrier: true }, { name: 'eth0', role: 'conduit', carrier: true }, { name: 'wlan-x', role: 'nic', carrier: false, type: 'swconfig' },
  ],
  bridges: [{ name: 'br-lan', up: true, members: ['lan1', 'lan2', 'lan3', 'lan4', 'lan5'].map(name => ({ name, kind: 'ethernet', carrier: true })).concat([{ name: 'phy0-ap0', kind: 'wifi', carrier: true }]) }],
  vlans: [{ name: 'eth1.1036', parent: 'eth1', vid: 1036, up: true }, { name: 'br-lan.100', parent: 'br-lan', vid: 100, up: true }],
  zones: [{ name: 'lan', networks: ['lan'], input: 'ACCEPT', masq: false }, { name: 'wan', networks: ['wan', 'wan6'], input: 'REJECT', masq: true }],
};
const IFS = ['loopback', 'lan', 'wan', 'wan6', 'lan100', 'xfrm0', 'wg0'].map(name => ({ interface: name, up: true, device: name === 'lan' ? 'br-lan' : undefined }));
// The data object a page hands to the model.
const data = () => ({ cfg: readNetwork(clone(REPLY)), net: clone(NET), ifs: clone(IFS) });
// A data object and a draft of it, ready to edit.
function fresh() { const d = data(); return { d, draft: draftFrom(d) }; }
// The values of one interface of a draft, by section name.
const ifv = (draft, name) => draft.ifaces[name];
// The section name of the device called `name`.
const devByName = (d, name) => d.cfg.devices.find(x => x.name === name).section;
// The error texts of a draft.
const errs = (d, draft) => problems(d, draft).errors.map(e => e.text);
// The warning texts of a draft.
const warns = (d, draft) => problems(d, draft).warnings;
//#endregion

//#region Checks
test('netmasks and prefixes', () => {
  assert.equal(maskPrefix('255.255.255.0'), 24);
  assert.equal(maskPrefix('255.255.255.255'), 32);
  assert.equal(maskPrefix('0.0.0.0'), 0);
  assert.equal(maskPrefix('255.0.255.0'), null);
  assert.equal(maskPrefix('255.255.255'), null);
  assert.equal(maskPrefix('255.255.255.256'), null);
  assert.equal(parseCidr('192.168.1.1/24').prefix, 24);
  assert.equal(parseCidr('192.168.1.1/255.255.255.0').prefix, 24);
  assert.equal(parseCidr('192.168.1.1', '255.255.0.0').prefix, 16);
  assert.equal(parseCidr('192.168.1.1').hasPrefix, false);
  assert.equal(parseCidr('192.168.1.1/33'), null);
  assert.equal(parseCidr('2001:db8::1/64').prefix, 64);
  assert.equal(parseCidr('2001:db8::1/129'), null);
  assert.equal(parseCidr('nope'), null);
  assert.equal(parseCidr('1.2.3.4/8/9'), null);
});

test('subnets: network, containment, overlap, text', () => {
  const a = subnetOf(parseCidr('192.168.1.77/24')), b = subnetOf(parseCidr('192.168.0.0/16')), c = subnetOf(parseCidr('10.0.0.1/8'));
  assert.equal(subnetText(a), '192.168.1.0/24');
  assert.equal(subnetText(subnetOf(parseCidr('fd92:cdf9:fb3f:100::1/64'))), 'fd92:cdf9:fb3f:100::/64');
  assert.ok(overlaps(a, b) && !overlaps(a, c));
  assert.ok(contains(a, parseCidr('192.168.1.254').value) && !contains(a, parseCidr('192.168.2.1').value));
  assert.equal(subnetOf(parseCidr('192.168.1.1')), null);
});

test('value checks', () => {
  assert.equal(VERIFY.ip4cidr('10.0.0.1/8'), null);
  assert.notEqual(VERIFY.ip4cidr('2001:db8::1'), null);
  assert.equal(VERIFY.ip6cidr('2001:db8::1/64'), null);
  assert.notEqual(VERIFY.ip6cidr('10.0.0.1'), null);
  assert.equal(VERIFY.hexpairs('0a1B'), null);
  assert.notEqual(VERIFY.hexpairs('abc'), null);
  assert.equal(VERIFY.keepalive('5 1'), null);
  assert.equal(VERIFY.keepalive('5,1'), null);
  assert.notEqual(VERIFY.keepalive('five'), null);
  assert.equal(VERIFY.reqprefix('auto'), null);
  assert.equal(VERIFY.reqprefix('56'), null);
  assert.equal(VERIFY.reqprefix('2001:db8::/56'), null);
  assert.notEqual(VERIFY.reqprefix('65'), null);
  assert.notEqual(VERIFY.reqprefix('2001:db8::'), null);
  assert.equal(VERIFY.ifaceid('eui64'), null);
  assert.equal(VERIFY.ifaceid('::1:2'), null);
  assert.notEqual(VERIFY.ifaceid('1:2'), null);
  assert.equal(VERIFY.hostname('*'), null);
  assert.equal(VERIFY.hostname('myhost'), null);
  assert.notEqual(VERIFY.hostname('bad host'), null);
  assert.equal(VERIFY.sendopts('60:vendor 77:cls'), null);
  assert.notEqual(VERIFY.sendopts('vendor'), null);
  assert.equal(VERIFY.mac('74:36:6d:c0:9b:83'), null);
  assert.notEqual(VERIFY.mac('74:36:6d:c0:9b'), null);
});

test('the schema: ids are unique per protocol and device type, every verify check exists, every field has a hint', () => {
  for (const proto of ['static', 'dhcp', 'dhcpv6', 'pppoe', 'none', '']) {
    const ids = ifaceFields(proto).map(idOf);
    assert.equal(new Set(ids).size, ids.length, `ids of ${proto}`);
    const keys = ifaceFields(proto).map(f => f.key);
    assert.equal(new Set(keys).size, keys.length, `options of ${proto}`);
  }
  for (const type of ['bridge', '8021q', '8021ad', 'plain']) {
    const ids = deviceFields(type).map(idOf);
    assert.equal(new Set(ids).size, ids.length, `ids of ${type}`);
  }
  for (const f of [...IFACE_FIELDS, ...DEVICE_FIELDS]) {
    if (f.verify) assert.ok(VERIFY[f.verify], `${f.key} names the check ${f.verify}`);
    assert.ok(f.hint, `${f.key} has a hint`);
  }
});
//#endregion

//#region Reading
test('a reply of another shape is unavailable, a real one is read', () => {
  assert.equal(readNetwork(null).available, false);
  assert.equal(readNetwork({ ports: [], bridges: [] }).available, false);
  const cfg = readNetwork(clone(REPLY));
  assert.equal(cfg.available, true);
  assert.equal(cfg.interfaces.length, 7);
  assert.deepEqual(cfg.devices.map(x => [x.name, x.type]), [['br-lan', 'bridge'], ['eth1.1036', '8021q'], ['br-lan.100', '8021q']]);
  assert.equal(cfg.interfaces.find(s => s.name === 'wan').secrets.password, true);
});

test('the router\'s own devices: ports, the bridge and its Wi-Fi members, VLANs; not a swconfig port', () => {
  const rt = runtimeDevices(data());
  assert.equal(rt.get('lan1').kind, 'port');
  assert.equal(rt.get('eth0').kind, 'conduit');
  assert.equal(rt.get('br-lan').kind, 'bridge');
  assert.equal(rt.get('phy0-ap0').kind, 'wifi');
  assert.equal(rt.get('eth1.1036').kind, 'vlan');
  assert.equal(rt.has('wlan-x'), false);
  assert.ok(rt.has('lo'));
});
//#endregion

//#region Draft and plan
test('an untouched draft changes nothing and has no problems on a normal router', () => {
  const { d, draft } = fresh();
  assert.deepEqual(changesOf(d, draft), []);
  assert.deepEqual(plan(d, draft), []);
  assert.equal(isDirty(d, draft), false);
  assert.deepEqual(problems(d, draft).errors, []);
  assert.deepEqual(warns(d, draft), []);
});

test('changing a static address writes the one option, as a list, and keeps the netmask', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan').ipaddr = ['192.168.7.1'];
  assert.deepEqual(plan(d, draft), [{ op: 'set', config: 'network', section: 'lan', values: { ipaddr: ['192.168.7.1'] } }]);
  const c = changesOf(d, draft);
  assert.equal(c.length, 1);
  assert.match(c[0].label, /lan: IPv4 addresses/);
  assert.equal(c[0].from, '192.168.1.1');
  assert.equal(c[0].to, '192.168.7.1');
});

test('an emptied option is deleted, a cleared one that does not exist is not', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan').ip6hint = '';
  ifv(draft, 'lan').gateway = '';
  assert.deepEqual(plan(d, draft), [{ op: 'delete', config: 'network', section: 'lan', options: ['ip6hint'] }]);
});

test('a flag is written as 1 or 0, and an unchanged default is not written', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan').disabled = true;
  ifv(draft, 'lan').delegate = true;
  assert.deepEqual(plan(d, draft), [{ op: 'set', config: 'network', section: 'lan', values: { disabled: '1' } }]);
});

test('the PPPoE password is written only when typed, never shown in the review', () => {
  const { d, draft } = fresh();
  assert.deepEqual(plan(d, draft), []);
  ifv(draft, 'wan').password = 's3cret pass';
  assert.deepEqual(plan(d, draft), [{ op: 'set', config: 'network', section: 'wan', values: { password: 's3cret pass' } }]);
  const c = changesOf(d, draft);
  assert.equal(c[0].to, 'new value (hidden)');
  assert.equal(c[0].from, 'stored value (hidden)');
  assert.ok(!JSON.stringify(c).includes('s3cret'));
});

test('an interface whose protocol the page does not edit is never written', () => {
  const { d, draft } = fresh();
  assert.equal(ifaceList(d, draft).find(s => s.name === 'wg0').editable, false);
  assert.equal(ifaceList(d, draft).find(s => s.name === 'xfrm0').editable, false);
  assert.deepEqual(plan(d, draft), []);
});

test('switching static to DHCP removes the static options and keeps the shared ones', () => {
  const { d, draft } = fresh();
  setProto(d, draft, 'lan100', 'dhcp');
  const ops = plan(d, draft);
  assert.deepEqual(ops.map(o => o.op), ['delete', 'set']);
  assert.deepEqual([...ops[0].options].sort(), ['ipaddr', 'netmask']);
  assert.deepEqual(ops[1].values, { proto: 'dhcp' });
  assert.ok(changesOf(d, draft).some(c => /options of static/.test(c.label)));
});

test('switching to a protocol that shares an option name with the old one (broadcast) deletes it first', () => {
  const d = data();
  d.cfg.interfaces.find(s => s.name === 'lan100').values.broadcast = '192.168.100.255';
  const draft = draftFrom(d);
  setProto(d, draft, 'lan100', 'dhcp');
  draft.ifaces.lan100.dhcp_broadcast = true;
  const ops = plan(d, draft);
  const del = ops.findIndex(o => o.op === 'delete'), set = ops.findIndex(o => o.op === 'set');
  assert.ok(del >= 0 && set > del);
  assert.ok(ops[del].options.includes('broadcast'));
  assert.equal(ops[set].values.broadcast, '1');
});

test('a protocol change follows the new default of a flag the router does not set', () => {
  const { d, draft } = fresh();
  assert.equal(ifv(draft, 'wan6').force_link, false);
  setProto(d, draft, 'wan6', 'static');
  assert.equal(ifv(draft, 'wan6').force_link, true, 'on for a static interface');
  assert.equal(plan(d, draft).some(o => o.values?.force_link !== undefined), false, 'but not written: it is the default');
  setProto(d, draft, 'wan6', 'none');
  assert.equal(ifv(draft, 'wan6').auto, false);
});

test('an ipv6 choice a protocol does not offer goes back to the default', () => {
  const { d, draft } = fresh();
  ifv(draft, 'wan').ipv6 = 'auto';
  setProto(d, draft, 'wan', 'static');
  assert.equal(ifv(draft, 'wan').ipv6, '');
});

test('adding an interface: an add operation with the name, the protocol and the settings that are not defaults', () => {
  const { d, draft } = fresh();
  const id = addInterface(d, draft);
  const v = draft.ifaces[id];
  assert.equal(draft.ifaceAdded[0].name, 'network1');
  draft.ifaceAdded[0].name = 'guest';
  v.device = 'br-lan.100';
  v.ipaddr = ['10.9.9.1/24'];
  v.ip6assign = '64';
  assert.deepEqual(plan(d, draft), [{ op: 'add', config: 'network', type: 'interface', name: 'guest', values: { proto: 'static', device: 'br-lan.100', ipaddr: ['10.9.9.1/24'], ip6assign: '64' } }]);
  assert.match(changesOf(d, draft)[0].label, /Add interface guest/);
  assert.deepEqual(errs(d, draft), []);
});

test('removing an interface deletes the section; undo takes it back; a new one is simply dropped', () => {
  const { d, draft } = fresh();
  removeInterface(draft, 'lan100');
  assert.deepEqual(plan(d, draft), [{ op: 'delete', config: 'network', section: 'lan100' }]);
  restoreInterface(draft, 'lan100');
  assert.deepEqual(plan(d, draft), []);
  const id = addInterface(d, draft);
  removeInterface(draft, id);
  assert.deepEqual(plan(d, draft), []);
  assert.equal(draft.ifaceAdded.length, 0);
});

test('a bridge: ports are written as a list in the order of the draft', () => {
  const { d, draft } = fresh();
  const s = devByName(d, 'br-lan');
  setPort(d, draft, s, 'lan5', false);
  draft.devices[s].stp = false;
  draft.devices[s].priority = '4096';
  assert.deepEqual(plan(d, draft), [{ op: 'set', config: 'network', section: 'cfg030f15', values: { stp: '0', priority: '4096', ports: ['lan1', 'lan2', 'lan3', 'lan4'] } }]);
});

test('a new bridge and a new VLAN device are anonymous device sections', () => {
  const { d, draft } = fresh();
  const br = addDevice(d, draft, 'bridge');
  assert.equal(draft.devAdded[0].name, 'br-new');
  draft.devices[br].ports = [];
  setPort(d, draft, br, 'eth1', true);
  draft.devices[br].igmp_snooping = true;
  const vl = addDevice(d, draft, '8021q');
  draft.devAdded[1].name = 'eth1.200';
  draft.devices[vl].ifname = 'eth1';
  draft.devices[vl].vid = '200';
  assert.deepEqual(plan(d, draft), [
    { op: 'add', config: 'network', type: 'device', values: { name: 'br-new', type: 'bridge', igmp_snooping: '1', ports: ['eth1'] } },
    { op: 'add', config: 'network', type: 'device', values: { name: 'eth1.200', type: '8021q', ifname: 'eth1', vid: '200' } },
  ]);
  assert.deepEqual(errs(d, draft), []);
});

test('device settings of an existing port: a plain device section has no type', () => {
  const { d, draft } = fresh();
  const id = addDevice(d, draft, 'plain');
  draft.devAdded[0].name = 'lan1';
  draft.devices[id].mtu = '1500';
  draft.devices[id].isolate = true;
  assert.deepEqual(plan(d, draft), [{ op: 'add', config: 'network', type: 'device', values: { name: 'lan1', mtu: '1500', isolate: '1' } }]);
  assert.deepEqual(errs(d, draft), []);
});

test('moving a port from one bridge to another takes it out of the first', () => {
  const { d, draft } = fresh();
  const br = addDevice(d, draft, 'bridge');
  draft.devAdded[0].name = 'br-guest';
  setPort(d, draft, br, 'lan5', true);
  const lan = devByName(d, 'br-lan');
  assert.deepEqual(draft.devices[lan].ports, ['lan1', 'lan2', 'lan3', 'lan4']);
  assert.deepEqual(portOwners(d, draft).get('lan5').map(b => b.name), ['br-guest']);
  assert.deepEqual(errs(d, draft), []);
  assert.ok(risksOf(d, draft).some(r => /Removing lan5 from br-lan/.test(r)));
});

test('removing a device section deletes it', () => {
  const { d, draft } = fresh();
  const s = devByName(d, 'br-lan.100');
  removeInterface(draft, 'lan100');
  removeDevice(draft, s);
  assert.deepEqual(plan(d, draft).map(o => [o.op, o.section]), [['delete', 'lan100'], ['delete', s]]);
  assert.deepEqual(errs(d, draft), []);
});
//#endregion

//#region Validation
test('static addresses: not an address, no prefix and no netmask, a netmask that is not one', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan').ipaddr = ['192.168.1.300'];
  assert.ok(errs(d, draft).some(e => /IPv4 addresses: "192.168.1.300" is not an IPv4 address/.test(e)));
  ifv(draft, 'lan').ipaddr = ['192.168.1.1'];
  ifv(draft, 'lan').netmask = '';
  assert.ok(errs(d, draft).some(e => /no prefix length and there is no netmask/.test(e)));
  ifv(draft, 'lan').netmask = '255.0.255.0';
  assert.ok(errs(d, draft).some(e => /netmask such as 255.255.255.0/.test(e)));
});

test('a gateway outside the subnet, or the interface itself, is an error; one inside is fine', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan100').gateway = '10.1.1.1';
  assert.ok(errs(d, draft).some(e => /gateway 10.1.1.1 is outside the interface's subnet \(192.168.100.0\/24\)/.test(e)));
  ifv(draft, 'lan100').gateway = '192.168.100.1';
  assert.ok(errs(d, draft).some(e => /address of the interface itself/.test(e)));
  ifv(draft, 'lan100').gateway = '192.168.100.254';
  assert.deepEqual(errs(d, draft), []);
});

test('two interfaces on the same subnet, with the same address, or overlapping', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan100').ipaddr = ['192.168.1.9/24'];
  ifv(draft, 'lan100').netmask = '';
  assert.ok(errs(d, draft).some(e => /same subnet 192.168.1.0\/24/.test(e)));
  ifv(draft, 'lan100').ipaddr = ['192.168.1.1/24'];
  assert.ok(errs(d, draft).some(e => /address 192.168.1.1\/24 is also used by lan/.test(e)));
  ifv(draft, 'lan100').ipaddr = ['192.168.0.9/16'];
  assert.deepEqual(errs(d, draft), []);
  assert.ok(warns(d, draft).some(w => /overlaps lan/.test(w)));
  ifv(draft, 'lan100').disabled = true;
  assert.ok(!warns(d, draft).some(w => /overlaps/.test(w)), 'a disabled interface does not count');
});

test('a device that does not exist is an error, a device the interface already had is only a warning', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan100').device = 'nope0';
  assert.ok(errs(d, draft).some(e => /device nope0 does not exist/.test(e)));
  const d2 = data();
  d2.cfg.interfaces.find(s => s.name === 'lan100').values.device = 'usb0';
  const draft2 = draftFrom(d2);
  assert.deepEqual(errs(d2, draft2), []);
  assert.ok(warns(d2, draft2).some(w => /usb0 does not exist on the router at the moment/.test(w)));
});

test('an alias to an interface that exists is fine, to one that does not is not', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan100').device = '@wan';
  assert.deepEqual(errs(d, draft), []);
  ifv(draft, 'lan100').device = '@gone';
  assert.ok(errs(d, draft).some(e => /interface gone does not exist/.test(e)));
});

test('numbers: MTU range, metric, delegated prefix length, PPPoE keepalive', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan').mtu = '40';
  ifv(draft, 'lan').metric = '-1';
  ifv(draft, 'lan').ip6assign = '200';
  ifv(draft, 'wan').keepalive = 'often';
  const e = errs(d, draft);
  assert.ok(e.some(x => /lan: MTU must be at least 68/.test(x)));
  assert.ok(e.some(x => /Route metric must be a whole number/.test(x)));
  assert.ok(e.some(x => /Delegate a prefix of length must be at most 128/.test(x)));
  assert.ok(e.some(x => /LCP echo/.test(x)));
});

test('warnings: MTU below the IPv6 minimum, PPPoE overhead, no PPPoE password, a delegated prefix over /64', () => {
  const d = data();
  d.cfg.interfaces.find(s => s.name === 'wan').secrets = {};
  const draft = draftFrom(d);
  ifv(draft, 'wan').mtu = '1500';
  ifv(draft, 'lan').mtu = '1000';
  ifv(draft, 'lan').ip6assign = '72';
  const w = warns(d, draft);
  assert.ok(w.some(x => /MTU above 1492/.test(x)));
  assert.ok(w.some(x => /no PPPoE password is stored/.test(x)));
  assert.ok(w.some(x => /below the 1280 bytes IPv6 needs/.test(x)));
  assert.ok(w.some(x => /longer than \/64/.test(x)));
});

test('DHCP and DHCPv6 options are checked', () => {
  const { d, draft } = fresh();
  setProto(d, draft, 'lan100', 'dhcp');
  ifv(draft, 'lan100').dhcp_clientid = 'xyz';
  ifv(draft, 'lan100').hostname = 'bad host';
  ifv(draft, 'lan100').dhcp_sendopts = 'oops';
  let e = errs(d, draft);
  assert.ok(e.some(x => /Client identifier must be hexadecimal digits in pairs/.test(x)));
  assert.ok(e.some(x => /Host name to send/.test(x)));
  assert.ok(e.some(x => /Extra options to send/.test(x)));
  ifv(draft, 'wan6').reqprefix = '65';
  e = errs(d, draft);
  assert.ok(e.some(x => /wan6: Request a prefix must be auto, no/.test(x)));
});

test('a new interface: the name is checked (characters, length, taken, the PPPoE device name), PPPoE needs a device', () => {
  const { d, draft } = fresh();
  const id = addInterface(d, draft);
  // The errors with the new interface called `n`.
  const name = n => { draft.ifaceAdded[0].name = n; return errs(d, draft); };
  assert.ok(name('').some(e => /give the interface a name/.test(e)));
  assert.ok(name('my-net').some(e => /letters, digits and underscores/.test(e)));
  assert.ok(name('a'.repeat(16)).some(e => /at most 15/.test(e)));
  assert.ok(name('lan').some(e => /already a section called "lan"/.test(e)));
  assert.deepEqual(name('guest'), []);
  draft.ifaces[id].proto = 'pppoe';
  assert.ok(name('abcdefghij').some(e => /pppoe-abcdefghij/.test(e)));
  assert.ok(name('abc').some(e => /PPPoE needs the device/.test(e)));
});

test('bridge ports: a port is in one bridge only, a bridge is not a port, an unknown device is not a port', () => {
  const { d, draft } = fresh();
  const br = addDevice(d, draft, 'bridge');
  draft.devAdded[0].name = 'br-x';
  draft.devices[br].ports = ['lan1'];
  assert.ok(errs(d, draft).some(e => /lan1 is also a port of br-lan/.test(e)));
  draft.devices[br].ports = ['br-lan'];
  assert.ok(errs(d, draft).some(e => /br-lan is a bridge/.test(e)));
  draft.devices[br].ports = ['ethX'];
  assert.ok(errs(d, draft).some(e => /ethX is not a device of the router/.test(e)));
  draft.devices[br].ports = ['eth1.1036', 'eth1.1036'];
  assert.ok(errs(d, draft).some(e => /listed twice/.test(e)));
  draft.devices[br].ports = [];
  assert.ok(warns(d, draft).some(w => /br-x: the bridge has no ports/.test(w)));
});

test('a port the config already lists but the router lacks is a warning, not an error', () => {
  const d = data();
  d.cfg.devices[0].values.ports = [...d.cfg.devices[0].values.ports, 'lan6'];
  const draft = draftFrom(d);
  assert.deepEqual(errs(d, draft), []);
  assert.ok(warns(d, draft).some(w => /port lan6 does not exist/.test(w)));
});

test('VLAN devices: base device and ID are required, the base must exist, the same VLAN twice is an error', () => {
  const { d, draft } = fresh();
  const id = addDevice(d, draft, '8021q');
  draft.devAdded[0].name = 'v1';
  let e = errs(d, draft);
  assert.ok(e.some(x => /choose the base device/.test(x)));
  assert.ok(e.some(x => /enter the VLAN ID/.test(x)));
  draft.devices[id].ifname = 'nope';
  draft.devices[id].vid = '5000';
  e = errs(d, draft);
  assert.ok(e.some(x => /base device nope does not exist/.test(x)));
  assert.ok(e.some(x => /VLAN ID must be at most 4094/.test(x)));
  draft.devices[id].ifname = 'br-lan';
  draft.devices[id].vid = '100';
  assert.ok(errs(d, draft).some(x => /already is VLAN 100 on br-lan/.test(x)));
  draft.devices[id].vid = '101';
  assert.deepEqual(errs(d, draft), []);
});

test('a device name that exists already, or is not a valid name, is an error', () => {
  const { d, draft } = fresh();
  addDevice(d, draft, 'bridge');
  // The errors with the new bridge called `n`.
  const name = n => { draft.devAdded[0].name = n; return errs(d, draft); };
  assert.ok(name('lan1').some(e => /already a device called "lan1"/.test(e)));
  assert.ok(name('br lan').some(e => /may only contain letters/.test(e)));
  assert.ok(name('br-0123456789abc').some(e => /at most 15/.test(e)));
  assert.ok(name('br-ok').every(e => !/device called|letters|at most/.test(e)));
});

test('timers: the query response interval must be below the query interval; a low forward delay with STP is a warning', () => {
  const { d, draft } = fresh();
  const s = devByName(d, 'br-lan');
  draft.devices[s].query_response_interval = '20000';
  assert.ok(errs(d, draft).some(e => /query response interval \(20000\) must be below the query interval \(12500\)/.test(e)));
  draft.devices[s].query_response_interval = '';
  draft.devices[s].forward_delay = '3';
  assert.ok(warns(d, draft).some(w => /forward delay below 4/.test(w)));
});

test('removing a device that an interface or a VLAN device uses is an error', () => {
  const { d, draft } = fresh();
  removeDevice(draft, devByName(d, 'br-lan.100'));
  assert.ok(errs(d, draft).some(e => /lan100: the device br-lan.100 it runs on is removed/.test(e)));
  const { d: d2, draft: draft2 } = fresh();
  removeDevice(draft2, devByName(d2, 'br-lan'));
  const e = errs(d2, draft2);
  assert.ok(e.some(x => /lan: the device br-lan it runs on is removed/.test(x)));
  assert.ok(e.some(x => /br-lan.100: the base device br-lan is removed/.test(x)));
});

test('removing an interface that another one borrows its device from is an error', () => {
  const { d, draft } = fresh();
  removeInterface(draft, 'wan');
  assert.ok(errs(d, draft).some(e => /wan6: the interface wan it borrows its device from is removed/.test(e)));
});

test('two interfaces with a default route and the same metric are warned about; a different metric is fine', () => {
  const { d, draft } = fresh();
  setProto(d, draft, 'lan100', 'dhcp');
  assert.ok(warns(d, draft).some(w => /wan and lan100 both install a default route with metric 0|lan100 and wan both install/.test(w)));
  ifv(draft, 'lan100').metric = '20';
  assert.ok(!warns(d, draft).some(w => /both install a default route/.test(w)));
});
//#endregion

//#region Dangerous changes
test('the management interfaces: lan, and the interfaces of a zone that accepts input without NAT', () => {
  const d = data();
  assert.deepEqual([...managementInterfaces(d)], ['lan']);
  d.net.zones.push({ name: 'admin', networks: ['lan100'], input: 'ACCEPT', masq: false });
  assert.deepEqual([...managementInterfaces(d)].sort(), ['lan', 'lan100']);
});

test('changing the address of lan, or removing it, is flagged; other changes of lan and any change of wan are not', () => {
  const { d, draft } = fresh();
  assert.deepEqual(risksOf(d, draft), []);
  ifv(draft, 'lan').ip6assign = '56';
  assert.deepEqual(risksOf(d, draft), []);
  ifv(draft, 'lan').ipaddr = ['192.168.9.1'];
  let r = risksOf(d, draft);
  assert.equal(r.length, 1);
  assert.match(r[0], /IPv4 addresses of lan, the network this page is most likely reached through can cut your connection/);
  assert.match(risksOf(d, draft, '192.168.1.1')[0], /You are connected at 192.168.1.1/);
  ifv(draft, 'wan').username = 'other';
  assert.equal(risksOf(d, draft).length, 1);
  removeInterface(draft, 'lan');
  r = risksOf(d, draft);
  assert.match(r[0], /Removing the interface lan, the network this page is most likely reached through/);
  assert.ok(problems(d, draft).warnings.includes(r[0]), 'the banner shows it too');
});

test('removing a port from the management bridge and switching VLAN filtering are flagged', () => {
  const { d, draft } = fresh();
  const s = devByName(d, 'br-lan');
  setPort(d, draft, s, 'lan2', false);
  draft.devices[s].vlan_filtering = true;
  const r = risksOf(d, draft);
  assert.ok(r.some(x => /Removing lan2 from br-lan, which carries the management network/.test(x)));
  assert.ok(r.some(x => /Switching VLAN filtering on on br-lan[\s\S]*can cut your connection/.test(x)));
});

test('removing any interface is flagged for what refers to it', () => {
  const { d, draft } = fresh();
  removeInterface(draft, 'lan100');
  assert.match(risksOf(d, draft)[0], /firewall zones, DHCP pools and routes that name it/);
});
//#endregion

//#region The check after a save
// The config the router would have after the plan was applied, built independently from the draft: an interface or device section per entry.
function applyPlan(d, ops) {
  const cfg = clone(d.cfg);
  let n = 100;
  for (const o of ops) {
    const list = cfg.interfaces.some(s => s.section === o.section) ? cfg.interfaces : cfg.devices;
    if (o.op === 'add') {
      const secrets = {}, values = clone(o.values);
      if ('password' in values) { secrets.password = true; delete values.password; }
      if (o.type === 'interface') cfg.interfaces.push({ section: o.name, name: o.name, anonymous: false, values, secrets });
      else cfg.devices.push({ section: `cfg${n++}`, anonymous: true, values, secrets, name: values.name, type: values.type ?? 'plain' });
    } else if (o.op === 'delete') {
      const i = list.findIndex(s => s.section === o.section);
      if (o.options) for (const k of o.options) delete list[i].values[k]; else list.splice(i, 1);
    } else {
      const s = list.find(x => x.section === o.section);
      for (const [k, v] of Object.entries(o.values)) { if (k === 'password') s.secrets.password = true; else s.values[k] = v; }
    }
  }
  return cfg;
}

test('the check accepts what the plan produces, for every kind of edit', () => {
  const { d, draft } = fresh();
  ifv(draft, 'lan').ipaddr = ['192.168.7.1'];
  ifv(draft, 'wan').password = 'pw';
  ifv(draft, 'wan').keepalive = '4 2';
  setProto(d, draft, 'lan100', 'dhcp');
  const br = addDevice(d, draft, 'bridge');
  draft.devAdded[0].name = 'br-g';
  setPort(d, draft, br, 'lan5', true);
  const id = addInterface(d, draft);
  draft.ifaceAdded[0].name = 'guest';
  draft.ifaces[id].device = 'br-g';
  draft.ifaces[id].ipaddr = ['10.5.5.1/24'];
  removeInterface(draft, 'wan6');
  assert.deepEqual(errs(d, draft), []);
  checkApplied({ cfg: applyPlan(d, plan(d, draft)) }, draft, d);
});

test('the check names what the router did not keep', () => {
  const d = data();
  d.cfg.interfaces.find(s => s.name === 'wan').secrets = {};
  const draft = draftFrom(d);
  ifv(draft, 'lan').ipaddr = ['192.168.7.1'];
  ifv(draft, 'wan').password = 'pw';
  removeInterface(draft, 'lan100');
  assert.throws(() => checkApplied({ cfg: clone(d.cfg) }, draft, d), /lan: IPv4 addresses, wan: PAP\/CHAP password, Interface lan100 were not saved/);
});

test('the check also fails when a device the draft adds is missing', () => {
  const { d, draft } = fresh();
  addDevice(d, draft, 'bridge');
  assert.throws(() => checkApplied({ cfg: clone(d.cfg) }, draft, d), /Device br-new was not saved/);
});

test('interfaces that were up and are down after the change are reported', () => {
  const { d, draft } = fresh();
  const after = clone(IFS).map(i => (i.interface === 'lan' ? { ...i, up: false } : i));
  assert.deepEqual(downAfter(d, draft, after), ['lan']);
  ifv(draft, 'lan').auto = false;
  assert.deepEqual(downAfter(d, draft, after), []);
  ifv(draft, 'lan').auto = true;
  removeInterface(draft, 'lan');
  assert.deepEqual(downAfter(d, draft, after), []);
  assert.throws(() => checkApplied({ cfg: clone(d.cfg), down: ['lan'] }, draftFrom(d), d), /lan is not up after the change/);
});
//#endregion

//#region Choices
test('device choices: bridges, ports and VLAN devices, the new ones of the form, not the removed', () => {
  const { d, draft } = fresh();
  let names = deviceChoices(d, draft).map(c => c.name);
  assert.ok(names.indexOf('br-lan') < names.indexOf('lan1') && names.includes('eth1.1036') && !names.includes('phy0-ap0'), 'a Wi-Fi interface is not offered');
  assert.ok(!names.includes('lo'));
  addDevice(d, draft, 'bridge');
  draft.devAdded[0].name = 'br-n';
  names = deviceChoices(d, draft).map(c => c.name);
  assert.ok(names.includes('br-n'));
  removeDevice(draft, devByName(d, 'br-lan.100'));
  assert.ok(!deviceChoices(d, draft).map(c => c.name).includes('br-lan.100'));
  assert.equal(deviceList(d, draft).length, 4);
});

test('port choices: ports and VLAN devices, no bridge, no CPU link, no Wi-Fi', () => {
  const { d, draft } = fresh();
  const names = portChoices(d, draft).map(c => c.name);
  assert.deepEqual(names.slice(0, 6), ['lan1', 'lan2', 'lan3', 'lan4', 'lan5', 'eth1']);
  assert.ok(names.includes('eth1.1036') && !names.includes('br-lan') && !names.includes('eth0') && !names.includes('phy0-ap0'));
  assert.ok(!portChoices(d, draft, 'br-lan').some(c => c.name === 'br-lan.100'), 'a VLAN device on the bridge itself is not one of its ports');
  assert.ok(names.includes('br-lan.100'), 'but it is for another bridge');
});
//#endregion

//#region Network-wide settings
test('the globals section is read into the data and the draft; an older plugin reports none', () => {
  const { d, draft } = fresh();
  assert.equal(d.cfg.globals.section, 'globals');
  assert.equal(d.cfg.globals.values.ula_prefix, 'fd92:cdf9:fb3f::/48');
  assert.deepEqual(draft.globals, { ula_prefix: 'fd92:cdf9:fb3f::/48', packet_steering: '2', netifd_loglevel: '', tcp_l3mdev: false, udp_l3mdev: false });
  const old = clone(REPLY); delete old.globals;
  const o = { cfg: readNetwork(old), net: clone(NET), ifs: clone(IFS) };
  assert.equal(o.cfg.globals, undefined);
  assert.equal(draftFrom(o).globals, null);
  assert.deepEqual(plan(o, draftFrom(o)), []);
  const none = clone(REPLY); none.globals = null;
  const n = { cfg: readNetwork(none), net: clone(NET), ifs: clone(IFS) };
  assert.equal(n.cfg.globals, null);
  assert.equal(draftFrom(n).globals.ula_prefix, '');
});

test('the ULA prefix must be auto or a /48 inside fd00::/8', () => {
  for (const ok of ['auto', 'fd12:3456:789a::/48', 'fdff:0:0::/48']) assert.equal(VERIFY.ula(ok), null, ok);
  for (const bad of ['fc00::/48', 'fd12:3456:789a::/64', 'fd12:3456:789a::', '2001:db8::/48', '192.168.0.0/24', 'nonsense', 'fe80::/48']) assert.notEqual(VERIFY.ula(bad), null, bad);
});

test('a change to the globals is a review line and a set operation; an unchanged draft plans nothing', () => {
  const { d, draft } = fresh();
  assert.deepEqual(changesOf(d, draft), []);
  assert.deepEqual(plan(d, draft), []);
  draft.globals.packet_steering = '1';
  draft.globals.tcp_l3mdev = true;
  draft.globals.netifd_loglevel = '3';
  assert.deepEqual(changesOf(d, draft).map(c => `${c.label}: ${c.from} -> ${c.to}`),
    ['Network-wide: Packet steering: 2 -> 1', 'Network-wide: netifd log level: default -> 3', 'Network-wide: TCP sockets reachable across VRFs: off -> on']);
  assert.deepEqual(plan(d, draft), [{ op: 'set', config: 'network', section: 'globals', values: { packet_steering: '1', netifd_loglevel: '3', tcp_l3mdev: '1' } }]);
  assert.ok(isDirty(d, draft));
});

test('emptying an option deletes it; the options the page does not edit are left alone', () => {
  const { d, draft } = fresh();
  draft.globals.packet_steering = '';
  draft.globals.ula_prefix = '';
  assert.deepEqual(plan(d, draft), [{ op: 'delete', config: 'network', section: 'globals', options: ['ula_prefix', 'packet_steering'] }]);
  assert.ok(!JSON.stringify(plan(d, draft)).includes('dhcp_default_duid') && !JSON.stringify(plan(d, draft)).includes('custom_opt'));
});

test('a router without a globals section gets one when something is set', () => {
  const none = clone(REPLY); none.globals = null;
  const d = { cfg: readNetwork(none), net: clone(NET), ifs: clone(IFS) };
  const draft = draftFrom(d);
  assert.deepEqual(plan(d, draft), []);
  draft.globals.ula_prefix = 'auto';
  assert.deepEqual(plan(d, draft), [{ op: 'add', config: 'network', type: 'globals', name: 'globals', values: { ula_prefix: 'auto' } }]);
});

test('globals validation: a bad ULA prefix is an error on its control; changing or removing it warns', () => {
  const { d, draft } = fresh();
  draft.globals.ula_prefix = 'fc00::/48';
  const found = problems(d, draft);
  assert.ok(found.errors.some(e => e.key === 'gl:ula_prefix' && /Network-wide: IPv6 ULA prefix must be inside fd00::\/8/.test(e.text)));
  draft.globals.ula_prefix = 'fd11:2222:3333::/48';
  assert.deepEqual(problems(d, draft).errors, []);
  assert.ok(problems(d, draft).warnings.some(w => /renumbers the local IPv6 addresses/.test(w)));
  draft.globals.ula_prefix = '';
  assert.ok(problems(d, draft).warnings.some(w => /without a ULA prefix/.test(w)));
  draft.globals.ula_prefix = 'fd92:cdf9:fb3f::/48';
  assert.deepEqual(problems(d, draft).warnings, []);
  draft.globals.netifd_loglevel = '9';
  assert.ok(problems(d, draft).errors.some(e => e.key === 'gl:netifd_loglevel'));
});

test('the check after a save needs the globals to read back', () => {
  const { d, draft } = fresh();
  draft.globals.packet_steering = '1';
  const after = clone(REPLY);
  after.globals.values.packet_steering = '1';
  checkApplied({ cfg: readNetwork(after), ifs: [] }, draft, d);
  assert.throws(() => checkApplied({ cfg: readNetwork(clone(REPLY)), ifs: [] }, draft, d), /Network-wide: Packet steering was not saved/);
});
//#endregion

console.log(failures.length ? `\n${failures.length} of ${passed + failures.length} tests FAILED: ${failures.join('; ')}` : `\nall ${passed} tests passed`);
process.exit(failures.length ? 1 : 0);
