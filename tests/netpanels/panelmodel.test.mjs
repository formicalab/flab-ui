// Unit tests of the side panels' and the wizard's pure model (www/js/pages/interfaces: panelmodel.js, wizardmodel.js). No router, no browser.
// Usage: node panelmodel.test.mjs
import assert from 'node:assert/strict';
import { ESSENTIAL_DEVICE, ESSENTIAL_IFACE, PROTO_CARDS, deviceItems, deviceSettings, droppedBy, interfaceSettings, suggestBridgeName, suggestInterfaceName, suggestSubnet,
  suggestVlanId, usedByDevice, usedByInterface, usedSubnets, vlanName } from '../../www/js/pages/interfaces/panelmodel.js';
import { applyChoice, chooseVid, chooseVlanBase, defaultChoice, existingDevices, nameFor, notDone, previewChoice, stepErrors, summaryLines } from '../../www/js/pages/interfaces/wizardmodel.js';
import { EDITABLE_PROTOS, deviceFields, idOf, ifaceFields } from '../../www/js/pages/interfaces/schema.js';
import { addInterface, changesOf, checkApplied, draftFrom, plan, problems, readNetwork, setProto } from '../../www/js/pages/interfaces/model.js';
import { REPLY, applyOps, clone, dataOf } from './fixture.mjs';

let passed = 0;
const failures = [];
// Runs one named test and prints the outcome; the failures are counted for the exit code.
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failures.push(name); console.log(`FAIL  ${name}  -> ${e.message}`); }
}
// A data object and a draft of it, ready to edit.
const fresh = () => { const d = dataOf(); return { d, draft: draftFrom(d) }; };
// The error texts of a draft.
const errs = (d, draft) => problems(d, draft).errors.map(e => e.text);

//#region Protocol cards and essential options
test('there is one protocol card per editable protocol, with a title, a description and what it asks for', () => {
  assert.deepEqual(PROTO_CARDS.map(c => c.id), EDITABLE_PROTOS);
  for (const c of PROTO_CARDS) assert.ok(c.title && c.blurb.length > 20 && c.asks, c.id);
});

test('every essential option exists for its protocol or device type, and the advanced ones are the rest', () => {
  for (const [proto, ids] of Object.entries(ESSENTIAL_IFACE)) {
    const have = ifaceFields(proto).map(idOf);
    for (const id of ids) assert.ok(have.includes(id), `${proto}: ${id}`);
  }
  for (const [type, ids] of Object.entries(ESSENTIAL_DEVICE)) {
    const have = deviceFields(type).map(idOf);
    for (const id of ids) assert.ok(have.includes(id), `${type}: ${id}`);
  }
  const { d, draft } = fresh();
  const s = interfaceSettings('static', draft.ifaces.lan);
  const all = ifaceFields('static', draft.ifaces.lan).map(idOf).filter(id => id !== 'proto' && id !== 'device');
  assert.deepEqual([...s.essential.map(idOf), ...s.advanced.map(idOf)].sort(), [...all].sort());
  assert.deepEqual(s.essential.map(idOf), ['ipaddr', 'gateway', 'dns']);
  assert.ok(s.advanced.map(idOf).includes('netmask') && s.advanced.map(idOf).includes('mtu') && !s.advanced.map(idOf).includes('proto'));
  assert.deepEqual(interfaceSettings('pppoe', draft.ifaces.wan).essential.map(idOf), ['username', 'password']);
  assert.deepEqual(interfaceSettings('none', draft.ifaces.lan).essential, []);
  assert.deepEqual(deviceSettings('bridge').essential.map(idOf), ['stp', 'vlan_filtering', 'igmp_snooping', 'mtu', 'macaddr']);
  assert.ok(deviceSettings('plain').essential.map(idOf).includes('speed') && deviceSettings('8021q').essential.map(idOf).includes('vid'));
  assert.ok(s.groups.every(g => g.fields.length) && d);
});

test('the advanced options of an interface are grouped like the card, and a hidden option stays hidden', () => {
  const { draft } = fresh();
  const hidden = interfaceSettings('static', { ...draft.ifaces.lan, ip6assign: '' });
  assert.ok(!hidden.advanced.map(idOf).includes('ip6hint'));
  assert.ok(interfaceSettings('static', draft.ifaces.lan).advanced.map(idOf).includes('ip6hint'));
});

test('a change of protocol names what it drops', () => {
  const { d, draft } = fresh();
  // lan is static with an address, a netmask and an IPv6 assignment; none of those belongs to DHCP.
  assert.deepEqual(droppedBy(draft.ifaces.lan, 'static', 'dhcp', Object.keys(d.cfg.interfaces.find(s => s.name === 'lan').values)).sort(), ['IPv4 addresses', 'IPv4 netmask'].sort());
  // The PPPoE password is not in the form but stored: it is dropped too.
  assert.ok(droppedBy(draft.ifaces.wan, 'pppoe', 'dhcp', ['password', 'username']).includes('PAP/CHAP password'));
  assert.ok(droppedBy(draft.ifaces.wan, 'pppoe', 'dhcp', ['password', 'username']).includes('PAP/CHAP username'));
  // Nothing typed, nothing stored: nothing dropped.
  const blank = addInterface(d, draft);
  assert.deepEqual(droppedBy(draft.ifaces[blank], 'static', 'dhcp'), []);
  assert.deepEqual(droppedBy(draft.ifaces.lan, 'static', 'static'), []);
});

test('the protocol change of the model drops what droppedBy announced', () => {
  const { d, draft } = fresh();
  setProto(d, draft, 'lan', 'dhcp');
  const lines = changesOf(d, draft).map(c => `${c.label}=${c.to}`).join('|');
  assert.match(lines, /options of static=removed/);
  assert.deepEqual(plan(d, draft).find(o => o.op === 'delete' && o.section === 'lan').options.sort(), ['ipaddr', 'netmask']);
});
//#endregion

//#region The device chooser and the uses
test('the device chooser says what each device is and what uses it', () => {
  const { d, draft } = fresh();
  const items = deviceItems(d, draft, 'lan');
  const by = Object.fromEntries(items.map(i => [i.value, i]));
  assert.equal(by['br-lan'].kind, 'bridge');
  assert.match(by['br-lan'].what, /joins the ports lan1, lan2, lan3, lan4 and 1 Wi-Fi network/);
  assert.deepEqual(by['br-lan'].usedBy, []);   // lan itself does not count
  assert.deepEqual(deviceItems(d, draft, 'lan100').find(i => i.value === 'br-lan').usedBy, ['lan']);
  assert.match(by.eth1.what, /Ethernet port, link up at 2\.5 Gbit\/s/);
  assert.match(by.lan5.what, /no link/);
  assert.ok(by.lan1.warn && /Port of br-lan/.test(by.lan1.warn));
  assert.match(by['br-lan.100'].what, /VLAN 100 of br-lan/);
  assert.deepEqual(by['eth1.1036'].usedBy, ['wan']);
  assert.equal(by.eth0.kind, 'conduit');
  assert.equal(by['@wan'].kind, 'alias');
  assert.deepEqual(by['@wan'].usedBy, ['wan6']);
  assert.match(by['@wan'].what, /device of the interface wan \(eth1\.1036\)/);
  assert.ok(!('@lan' in by), 'an interface cannot borrow its own device');
});

test('a bridge and a VLAN device that exist only in the form are offered with their ports and tag', () => {
  const { d, draft } = fresh();
  const choice = defaultChoice(d, draft);
  Object.assign(choice, { where: 'bridge', bridgeName: 'br-guest', ports: ['lan5'], name: 'guest' });
  applyChoice(d, draft, choice);
  const item = deviceItems(d, draft, 'lan').find(i => i.value === 'br-guest');
  assert.match(item.what, /the port lan5/);
  assert.deepEqual(item.usedBy, ['guest']);
});

test('what an interface and a device are used by', () => {
  const { d, draft } = fresh();
  const lan = usedByInterface(d, draft, 'lan');
  assert.equal(lan.zone.name, 'lan');
  assert.deepEqual(lan.services, ['DHCPv4 pool .100–.249 · 12h', 'Router advertisements server']);
  assert.deepEqual(lan.riders, []);
  const wan = usedByInterface(d, draft, 'wan');
  assert.deepEqual(wan.riders, [{ name: 'wan6', how: 'borrows its device' }, { name: 'xfrm0', how: 'runs over it' }]);
  assert.equal(usedByInterface(d, draft, 'wg0').zone, null);
  const dev = usedByDevice(d, draft, 'br-lan');
  assert.deepEqual(dev.interfaces, ['lan']);
  assert.deepEqual(dev.vlans, ['br-lan.100']);
  assert.deepEqual(dev.wifi, ['phy0-ap0']);
  assert.equal(usedByDevice(d, draft, 'lan1').bridge, 'br-lan');
  assert.deepEqual(usedByDevice(d, draft, 'eth1').vlans, ['eth1.1036']);
});
//#endregion

//#region Suggestions
test('a suggested /24 overlaps no interface, route, tunnel address or address typed in the form', () => {
  const { d, draft } = fresh();
  const used = usedSubnets(d, draft);
  assert.ok(used.length >= 6);
  const first = suggestSubnet(d, draft);
  assert.deepEqual(first, { address: '192.168.10.1/24', network: '192.168.10.0/24' });
  // Occupy 192.168.10.0/24 in the form and the next free one is suggested.
  const id = addInterface(d, draft);
  draft.ifaces[id].ipaddr = ['192.168.10.5/24'];
  assert.equal(suggestSubnet(d, draft).network, '192.168.20.0/24');
  // A wider network that contains the candidates blocks them all: a /16 on 192.168.0.0 sends the suggestion to 172.16.
  draft.ifaces[id].ipaddr = ['192.168.77.5'];
  draft.ifaces[id].netmask = '255.255.0.0';
  assert.equal(suggestSubnet(d, draft).network, '172.16.0.0/24');
  // The WireGuard address (an option the interface table has no control for) and a route target count too.
  const e = dataOf(), draft2 = draftFrom(e);
  e.ifs.push({ interface: 'x', up: true, route: [{ target: '192.168.10.0', mask: 24, nexthop: '1.1.1.1' }] });
  e.cfg.interfaces.find(s => s.name === 'wg0').values.addresses = ['192.168.20.1/24'];
  assert.equal(suggestSubnet(e, draft2).network, '192.168.30.0/24');
});

test('a suggested subnet is never a /24 that overlaps; none is suggested when everything is taken', () => {
  const { d, draft } = fresh();
  const id = addInterface(d, draft);
  draft.ifaces[id].ipaddr = ['10.0.0.1/8', '172.16.0.1/12', '192.168.0.1/16'];
  assert.equal(suggestSubnet(d, draft), null);
});

test('name suggestions are free, valid and short enough', () => {
  const { d, draft } = fresh();
  assert.equal(suggestInterfaceName(d, draft, ['guest']), 'guest');
  assert.equal(suggestInterfaceName(d, draft, ['lan', 'wan']), 'network');
  assert.equal(suggestInterfaceName(d, draft, ['br-guest 2']), 'br_guest_2');
  assert.equal(suggestInterfaceName(d, draft, ['averyveryverylongname'], 9), 'averyvery');
  const id = addInterface(d, draft);
  draft.ifaceAdded.find(a => a.id === id).name = 'guest';
  assert.equal(suggestInterfaceName(d, draft, ['guest']), 'network');
  assert.equal(suggestBridgeName(d, draft), 'br-new');
  assert.equal(suggestBridgeName(d, draft, 'lan'), 'br-lan2');
  assert.equal(suggestBridgeName(d, draft, 'a very long stem indeed').length <= 15, true);
  assert.equal(vlanName('eth1', '200'), 'eth1.200');
  assert.equal(vlanName('eth1', ''), '');
  assert.equal(vlanName('averylongdevice', '100'), '');
  assert.equal(suggestVlanId(d, draft, 'eth1'), '10');
  assert.equal(suggestVlanId(d, draft, 'br-lan'), '10');
});
//#endregion

//#region The wizard's effects on the draft
// A choice for a new network on a new bridge with one free port.
const bridgeChoice = (d, draft, extra = {}) => Object.assign(defaultChoice(d, draft), { where: 'bridge', bridgeName: 'br-guest', ports: ['lan5'], name: 'guest', address: '192.168.10.1/24' }, extra);

test('the first choice is a free device when there is one and suggests a free subnet', () => {
  const { d, draft } = fresh();
  const free = existingDevices(d, draft);
  assert.ok(free.free.some(i => i.value === 'lan5') && free.free.some(i => i.value === 'br-lan.100') === false && free.hidden >= 3);
  assert.ok(!free.free.some(i => i.kind === 'conduit'));
  const c = defaultChoice(d, draft);
  assert.equal(c.where, 'device');
  assert.equal(c.device, 'lan5', 'a port of a bridge is not the default, and comes last in the list');
  assert.equal(free.free.at(-1).value.startsWith('lan'), true);
  assert.equal(c.address, '192.168.10.1/24');
  assert.equal(c.proto, 'static');
});

test('a new bridge with a static network: the draft gets the bridge, its ports and the interface, and the plan writes them', () => {
  const { d, draft } = fresh();
  const ids = applyChoice(d, draft, bridgeChoice(d, draft));
  assert.ok(ids.device && ids.iface);
  const ops = plan(d, draft);
  const bridge = ops.find(o => o.op === 'add' && o.type === 'device');
  assert.deepEqual(bridge.values, { name: 'br-guest', type: 'bridge', ports: ['lan5'] });
  const iface = ops.find(o => o.op === 'add' && o.type === 'interface');
  assert.equal(iface.name, 'guest');
  assert.equal(iface.values.proto, 'static');
  assert.equal(iface.values.device, 'br-guest');
  assert.deepEqual(iface.values.ipaddr, ['192.168.10.1/24']);
  assert.deepEqual(errs(d, draft), []);
  // Saving and reading back satisfies the model's own check.
  const after = readNetwork(applyOps(REPLY, ops));
  checkApplied({ cfg: after, ifs: [] }, draft, d);
});

test('a port moved into the new bridge leaves its old bridge, and the preview warns about the old network', () => {
  const { d, draft } = fresh();
  const preview = previewChoice(d, draft, bridgeChoice(d, draft, { ports: ['lan4'] }));
  assert.deepEqual(preview.errors, []);
  assert.ok(preview.warnings.some(w => /Removing lan4 from br-lan/.test(w)), preview.warnings.join('|'));
  // The preview left the real draft alone.
  assert.equal(draft.devAdded.length + draft.ifaceAdded.length, 0);
});

test('a new VLAN device: base, ID and name follow each other; a taken ID and a bad one are errors', () => {
  const { d, draft } = fresh();
  const c = Object.assign(defaultChoice(d, draft), { where: 'vlan', name: 'iot' });
  chooseVlanBase(d, draft, c, 'eth1');
  assert.deepEqual([c.vlanBase, c.vid, c.vlanName], ['eth1', '10', 'eth1.10']);
  chooseVid(c, '200');
  assert.equal(c.vlanName, 'eth1.200');
  c.vlanName = 'iot200';
  chooseVid(c, '300');
  assert.equal(c.vlanName, 'iot200');
  applyChoice(d, draft, c);
  const op = plan(d, draft).find(o => o.op === 'add' && o.type === 'device');
  assert.deepEqual(op.values, { name: 'iot200', type: '8021q', ifname: 'eth1', vid: '300' });
  assert.equal(plan(d, draft).find(o => o.type === 'interface').values.device, 'iot200');
  const { d: d2, draft: draft2 } = fresh();
  const dup = Object.assign(defaultChoice(d2, draft2), { where: 'vlan', vlanBase: 'eth1', vid: '1036', vlanName: 'eth1.2000', name: 'iot' });
  assert.ok(previewChoice(d2, draft2, dup).errors.some(e => e.part === 'device' && e.field === 'vid' && /already is VLAN 1036/.test(e.text)));
  const bad = Object.assign(defaultChoice(d2, draft2), { where: 'vlan', vlanBase: 'eth1', vid: '5000', vlanName: 'x', name: 'iot' });
  assert.ok(stepErrors(previewChoice(d2, draft2, bad), 1).some(e => e.field === 'vid'));
  const none = Object.assign(defaultChoice(d2, draft2), { where: 'vlan', name: 'iot' });
  assert.ok(stepErrors(previewChoice(d2, draft2, none), 1).some(e => e.field === 'ifname'));
});

test('an existing device: the interface runs on it; an alias borrows another interface\'s device', () => {
  const { d, draft } = fresh();
  const c = Object.assign(defaultChoice(d, draft), { where: 'device', device: 'lan5', name: 'iot' });
  applyChoice(d, draft, c);
  assert.equal(plan(d, draft).find(o => o.type === 'interface').values.device, 'lan5');
  const { d: d2, draft: draft2 } = fresh();
  const a = Object.assign(defaultChoice(d2, draft2), { where: 'device', device: '@wan', proto: 'dhcpv6', name: 'wan7' });
  assert.deepEqual(previewChoice(d2, draft2, a).errors, []);
  const none = Object.assign(defaultChoice(d2, draft2), { where: 'device', device: '', name: 'x' });
  assert.ok(stepErrors(previewChoice(d2, draft2, none), 1).some(e => e.field === 'device'));
});

test('the protocol decides what the draft holds: DHCP drops the address row, PPPoE takes the login and needs a device', () => {
  const { d, draft } = fresh();
  const dhcp = Object.assign(defaultChoice(d, draft), { where: 'device', device: 'lan5', proto: 'dhcp', name: 'up2', address: '192.168.10.1/24' });
  applyChoice(d, draft, dhcp);
  const op = plan(d, draft).find(o => o.type === 'interface');
  assert.equal(op.values.proto, 'dhcp');
  assert.ok(!('ipaddr' in op.values));
  const { d: d2, draft: draft2 } = fresh();
  const ppp = Object.assign(defaultChoice(d2, draft2), { where: 'device', device: 'lan5', proto: 'pppoe', name: 'dsl', username: 'me', password: 'sekret-1' });
  applyChoice(d2, draft2, ppp);
  const pop = plan(d2, draft2).find(o => o.type === 'interface');
  assert.deepEqual([pop.values.proto, pop.values.username, pop.values.password], ['pppoe', 'me', 'sekret-1']);
  // The review hides the password.
  assert.ok(!JSON.stringify(changesOf(d2, draft2)).includes('sekret-1'));
  // A PPPoE name over 9 characters is refused by the model's own rule.
  const long = Object.assign(defaultChoice(d2, draft2), { where: 'device', device: 'lan5', proto: 'pppoe', name: 'uplinknumber', username: 'me' });
  assert.ok(previewChoice(d2, draft2, long).errors.some(e => e.field === 'name' && /over the 15 characters/.test(e.text)));
  assert.equal(nameFor(d2, draft2, { where: 'bridge', bridgeName: 'br-uplinknumber1', proto: 'pppoe', device: '', vid: '' }).length <= 8, true);
  // The model accepts pppoe-<9 characters> (15), the documentation's limit of 14 does not: a warning, not an error.
  const nine = previewChoice(d2, draft2, { ...ppp, name: 'ninechars' });
  assert.deepEqual(nine.errors, []);
  assert.ok(nine.warnings.some(w => /pppoe-ninechars \(15 characters\)/.test(w)));
  assert.ok(!previewChoice(d2, draft2, { ...ppp, name: 'eightchr' }).warnings.some(w => /characters\)/.test(w)));
});

test('validation feedback: a taken name, a bad or clashing address, a gateway outside the subnet, a missing address', () => {
  const { d, draft } = fresh();
  const base = () => Object.assign(defaultChoice(d, draft), { where: 'device', device: 'lan5', name: 'iot', address: '192.168.10.1/24' });
  assert.deepEqual(previewChoice(d, draft, base()).errors, []);
  assert.ok(previewChoice(d, draft, { ...base(), name: 'lan' }).errors.some(e => e.field === 'name' && /already a section called "lan"/.test(e.text)));
  assert.ok(previewChoice(d, draft, { ...base(), name: 'two words' }).errors.some(e => e.field === 'name'));
  assert.ok(previewChoice(d, draft, { ...base(), name: '' }).errors.some(e => e.field === 'name'));
  assert.ok(previewChoice(d, draft, { ...base(), address: 'nonsense' }).errors.some(e => e.field === 'ipaddr'));
  assert.ok(previewChoice(d, draft, { ...base(), address: '192.168.1.5/24' }).errors.some(e => e.field === 'ipaddr' && /same subnet/.test(e.text)));
  assert.ok(previewChoice(d, draft, { ...base(), address: '192.168.10.1' }).errors.some(e => e.field === 'ipaddr' && /no prefix length/.test(e.text)));
  assert.ok(previewChoice(d, draft, { ...base(), gateway: '10.9.9.9' }).errors.some(e => e.field === 'gateway'));
  assert.ok(previewChoice(d, draft, { ...base(), address: '' }).errors.some(e => e.field === 'ipaddr'));
  // Errors the draft already had are not blamed on the wizard.
  draft.ifaces.lan100.ipaddr = ['not-an-address'];
  const existing = errs(d, draft);
  assert.ok(existing.length > 0);
  assert.ok(!previewChoice(d, draft, base()).errors.some(e => existing.includes(e.text)));
});

test('the last page lists what the flow does not do, with links', () => {
  const s = notDone('static'), o = notDone('dhcp');
  assert.deepEqual(s.map(x => x.href), ['#firewall', '#dhcp', '#radios', '#routing']);
  assert.deepEqual(o.map(x => x.href), ['#firewall', '#routing']);
  const { d, draft } = fresh();
  const lines = summaryLines(bridgeChoice(d, draft));
  assert.match(lines[0], /bridge br-guest with the ports lan5/);
  assert.match(lines[1], /interface guest on br-guest with a static address 192\.168\.10\.1\/24/);
});
//#endregion

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log('all panelmodel tests passed');
