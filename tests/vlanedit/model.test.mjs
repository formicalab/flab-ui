// Unit test of the VLAN editor's model (www/js/pages/network/vlanmodel.js): reading the VLAN sections of the network config, the
// editable tables, the draft, the review list, validation, the UCI operations and the check after a save. Pure functions: no router
// and no browser. Usage: node model.test.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/network/vlanmodel.js')).href);

let failed = 0;
// Prints PASS or FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));
// Whether running `fn` throws an error whose message matches `re`.
const throwsLike = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

//#region Fixtures
// A section of `uci get` by type: anonymous sections get names like cfg020f15 and an index.
const sec = (index, type, options, name) => {
  const id = name ?? `cfg${index.toString(16).padStart(2, '0')}0f15`;
  return [id, { '.anonymous': !name, '.type': type, '.name': id, '.index': index, ...options }];
};

// The raw config of a DSA router: a bridge with four ports and VLAN filtering on, VLAN 1 (lan1 and lan2 untagged and PVID, lan3
// untagged, lan4 tagged), VLAN 20 (lan3 and lan4 tagged), VLAN 90 for an unused native VLAN on lan4 without the router, and a
// bridge-vlan of another bridge.
const rawBridge = () => ({
  'bridge-vlan': Object.fromEntries([
    sec(1, 'bridge-vlan', { device: 'br-lan', vlan: '1', ports: ['lan1:u*', 'lan2:u*', 'lan3', 'lan4:t'] }, 'lan_vlan'),
    sec(2, 'bridge-vlan', { device: 'br-lan', vlan: '20', ports: ['lan3:t', 'lan4:t'] }),
    sec(3, 'bridge-vlan', { device: 'br-lan', vlan: '90', ports: ['lan4:u*'], local: '0' }),
    sec(4, 'bridge-vlan', { device: 'br-guest', vlan: '5', ports: ['lan9:t'] }),
  ]),
  device: Object.fromEntries([sec(5, 'device', { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3', 'lan4'], vlan_filtering: '1' }), sec(6, 'device', { name: 'br-lan.20', type: '8021q', ifname: 'br-lan', vid: '20' })]),
  switch: {}, switch_vlan: {}, switch_port: {},
});
// The device sections of a bridge that does not filter.
const devicesOff = () => { const d = rawBridge().device; delete d.cfg050f15.vlan_filtering; return d; };
// The flab.network status of that router: the bridge with four Ethernet ports and a wifi port, a VLAN device on it.
const member = (name, kind = 'ethernet') => ({ name, kind });
const net = () => ({
  bridges: [{ name: 'br-lan', vlan_filtering: true, default_pvid: 1, members: ['lan1', 'lan2', 'lan3', 'lan4'].map(n => member(n)).concat(member('phy0-ap0', 'wifi')), vlans: [], vlan_table: { source: 'config', vlans: [] } }],
  vlans: [{ name: 'br-lan.20', parent: 'br-lan', vid: 20 }], switches: [],
});
// netifd's interface list: the LAN on the bridge itself (VLAN 1 untagged), an interface on VLAN 20, a WAN that is not on the bridge, an
// interface that is down.
const ifs = () => [
  { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }] },
  { interface: 'iot', up: true, l3_device: 'br-lan.20', device: 'br-lan.20', 'ipv4-address': [{ address: '192.168.20.1', mask: 24 }] },
  { interface: 'wan', up: true, l3_device: 'eth1', device: 'eth1', 'ipv4-address': [{ address: '203.0.113.9', mask: 24 }] },
  { interface: 'off', up: false, l3_device: 'br-lan.30', device: 'br-lan.30', 'ipv4-address': [{ address: '192.168.30.1', mask: 24 }] },
];
// The page's data for a router: `vlan` as vlanpage.js adds it.
const dataOf = (n = net(), raw = rawBridge(), host = 'openwrt.lab') => ({ net: n, ifs: ifs(), vlan: m.dataOf(n, raw, ifs(), host) });
const rowOf = (draft, key, vid) => draft.tables[key].rows.find(r => r.vid === vid);

// The raw config and status of an older board whose switch is driven through swconfig: CPU port 0 (eth0), user ports 1 to 4; VLAN 1
// is the LAN (ports 1 to 3 untagged, the CPU tagged), group 2 carries VLAN 1036 for the WAN (port 4), and a switch_port section sets
// the PVID of port 4.
const rawSwitch = () => ({
  'bridge-vlan': {}, device: {},
  switch: Object.fromEntries([sec(1, 'switch', { name: 'switch0', reset: '1', enable_vlan: '1' }, 'sw0')]),
  switch_vlan: Object.fromEntries([
    sec(2, 'switch_vlan', { device: 'switch0', vlan: '1', ports: '0t 1 2 3' }),
    sec(3, 'switch_vlan', { device: 'switch0', vlan: '2', vid: '1036', ports: '0t 4' }),
  ]),
  switch_port: Object.fromEntries([sec(4, 'switch_port', { device: 'switch0', port: '4', pvid: '1036' })]),
});
const netSwitch = () => ({
  bridges: [], vlans: [{ name: 'eth0.1', parent: 'eth0', vid: 1 }, { name: 'eth0.1036', parent: 'eth0', vid: 1036 }],
  switches: [{ node: 'swconfig:switch0', kind: 'swconfig', label: 'AR8327', ports: ['port1', 'port2', 'port3', 'port4'], cpu_ports: [{ port: 0, conduit: 'eth0' }], vlan_enabled: true, vlans: [] }],
});
const ifsSwitch = () => [{ interface: 'lan', up: true, l3_device: 'eth0.1', device: 'eth0.1', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }] }];
const dataSwitch = (raw = rawSwitch()) => ({ net: netSwitch(), ifs: ifsSwitch(), vlan: m.dataOf(netSwitch(), raw, ifsSwitch(), 'openwrt.lab') });
// The row of a swconfig draft by its VLAN id (the vid option, else the group number).
const swRow = (draft, vid) => draft.tables['switch:switch0'].rows.find(r => m.switchVid(r) === vid);
//#endregion

//#region Reading
console.log('== reading the config ==');
check(j(m.parseEntry('lan2:u*')) === j({ port: 'lan2', state: 'u*' }) && j(m.parseEntry('lan4:t')) === j({ port: 'lan4', state: 't' }) && j(m.parseEntry('lan1')) === j({ port: 'lan1', state: 'u' }) && j(m.parseEntry('lan1:t*')) === j({ port: 'lan1', state: 't*' }) && j(m.parseEntry('lan1:u')) === j({ port: 'lan1', state: 'u' }), 'bridge-vlan port entries: no flag is untagged without a PVID, t is tagged, * is the PVID');
check(m.formatEntry('lan2', 'u*') === 'lan2:u*' && m.formatEntry('lan2', 't') === 'lan2:t' && m.formatEntry('lan2', '') === null, 'and are written back in the same notation');
check(j(m.parseToken('3t')) === j({ port: '3', state: 't' }) && j(m.parseToken('5')) === j({ port: '5', state: 'u' }) && m.parseToken('x') === null, 'swconfig port tokens: a bare number is untagged, a trailing t is tagged');
const conf = m.readConfig(rawBridge());
check(conf.bridgeVlans.length === 4 && conf.bridgeVlans[0].sec === 'lan_vlan' && conf.bridgeVlans[0].entries.length === 4 && conf.bridgeVlans[2].local === false && conf.bridgeVlans[1].local === true, 'bridge-vlan sections come in file order with their ports and the local option (default on)', j(conf.bridgeVlans));
check(conf.devices['br-lan']?.filtering === true && conf.devices['br-lan']?.ports.join() === 'lan1,lan2,lan3,lan4' && !conf.devices['br-lan.20'], 'only bridge device sections are kept, found by their name option', j(conf.devices));
const sconf = m.readConfig(rawSwitch());
check(sconf.switches.switch0?.sec === 'sw0' && sconf.switches.switch0.enable === true && sconf.switchVlans[1].vid === '1036' && sconf.switchVlans[0].tokens.join() === '0t,1,2,3' && sconf.switchPorts[0].pvid === '1036', 'switch sections are keyed by the switch name; switch_vlan ports are split into tokens', j(sconf));
check(m.readConfig(null).bridgeVlans.length === 0 && m.readConfig({ 'bridge-vlan': [] }).bridgeVlans.length === 0, 'missing or empty replies are an empty config');
//#endregion

//#region Bridge tables
console.log('\n== bridge tables ==');
const d0 = dataOf();
const t0 = d0.vlan.tables[0];
check(d0.vlan.tables.length === 1 && t0.key === 'bridge:br-lan' && t0.filtering === true && t0.filteringLive === true && t0.deviceSection === 'cfg050f15', 'a table for the bridge with its device section and filtering');
check(t0.columns.map(c => c.id).join() === 'lan1,lan2,lan3,lan4' && t0.columns.every(c => c.member), 'columns are the ports of the bridge (not the wifi port), in the config order', j(t0.columns));
check(t0.rows.length === 3 && t0.rows[0].cells.lan3 === 'u' && t0.rows[0].cells.lan1 === 'u*' && t0.rows[2].local === false, 'rows hold the cells and the router membership; the other bridge\'s VLAN is not here');
check(t0.carriers.map(c => `${c.iface}:${c.vid}`).join() === 'lan:1,iot:20', 'the router\'s interfaces on the bridge are known: the untagged one on the default VLAN and the VLAN device\'s; a down interface and a WAN are not', j(t0.carriers));
check(!t0.carriers.some(c => c.mgmt) && dataOf(net(), rawBridge(), '192.168.20.1').vlan.tables[0].carriers.find(c => c.iface === 'iot').mgmt, 'the interface that has the address the page was opened with is the management one');
const emptyNet = net();
emptyNet.bridges[0].members = [member('phy0-ap0', 'wifi')];
emptyNet.bridges[0].vlan_table = null;
check(m.dataOf(emptyNet, { 'bridge-vlan': {} }, [], 'h').tables.length === 0, 'a bridge with no Ethernet port and no VLAN has no table');
const offNet = net();
offNet.bridges[0].vlan_filtering = false;
offNet.bridges[0].vlan_table = null;
const dOff = { net: offNet, ifs: ifs(), vlan: m.dataOf(offNet, { 'bridge-vlan': {}, device: devicesOff() }, ifs(), 'h') };
check(dOff.vlan.tables[0].rows.length === 0 && dOff.vlan.tables[0].filteringLive === false && dOff.vlan.tables[0].filtering === false, 'a bridge that does not filter and has no VLAN still gets a (empty) table to set up');
const noDevice = m.dataOf(offNet, { 'bridge-vlan': {}, device: {} }, [], 'h').tables[0];
check(noDevice.filtering === null && noDevice.deviceSection === null, 'a bridge without a device section cannot have its filtering switched (null)');
const strange = rawBridge();
strange['bridge-vlan'].cfgff = { '.type': 'bridge-vlan', '.name': 'cfgff', '.index': 9, device: 'br-lan', vlan: '30', ports: ['lan9:t'] };
check(m.dataOf(net(), strange, [], 'h').tables[0].columns.map(c => `${c.id}:${c.member}`).join() === 'lan1:true,lan2:true,lan3:true,lan4:true,lan9:false', 'a port that a VLAN names but the bridge does not have is a column flagged as not a member');
// The live table of the kernel against the config.
const kernelNet = net();
kernelNet.bridges[0].vlan_table = { source: 'kernel', vlans: [
  { vid: 1, ports: [{ name: 'lan1', tagged: false, pvid: true }, { name: 'lan2', tagged: false, pvid: true }, { name: 'lan3', tagged: false, pvid: false }, { name: 'lan4', tagged: true, pvid: false }, { name: 'br-lan', tagged: false, pvid: false }] },
  { vid: 20, ports: [{ name: 'lan3', tagged: true, pvid: false }, { name: 'lan4', tagged: true, pvid: false }] },
  { vid: 90, ports: [{ name: 'lan4', tagged: false, pvid: true }] }] };
check(m.dataOf(kernelNet, rawBridge(), [], 'h').tables[0].live === null, 'a kernel table that agrees with the config reports no difference (the bridge itself is not compared)');
kernelNet.bridges[0].vlan_table.vlans[1].ports[0].tagged = false;
kernelNet.bridges[0].vlan_table.vlans.push({ vid: 77, ports: [] });
kernelNet.bridges[0].vlan_table.vlans[0].ports.splice(1, 1);
const live = m.dataOf(kernelNet, rawBridge(), [], 'h').tables[0].live;
check(live?.length === 3 && live.some(x => /lan3 is untagged in VLAN 20/.test(x)) && live.some(x => /lan2 is not in VLAN 1/.test(x)) && live.some(x => /VLAN 77 is in the kernel but not in the config/.test(x)), 'a kernel table that differs is described: tagging, a missing port, an extra VLAN', j(live));
//#endregion

//#region Editing a bridge table
console.log('\n== editing a bridge table ==');
const KEY = 'bridge:br-lan';
let d = m.draftFrom(d0);
check(m.changesOf(d0, d).length === 0 && !m.isDirty(d0, d) && m.plan(d0, d).length === 0 && m.problems(d0, d).errors.length === 0 && m.problems(d0, d).warnings.length === 0, 'an untouched draft has no change, no operation and no problem');
rowOf(d, KEY, '20').cells.lan3 = 'u*';
delete rowOf(d, KEY, '20').cells.lan4;
let ch = m.changesOf(d0, d);
check(ch.length === 1 && ch[0].label === 'br-lan VLAN 20' && ch[0].from === 'lan3 tagged, lan4 tagged, router' && ch[0].to === 'lan3 untagged + PVID, router', 'the review says what a row was and becomes', j(ch));
let ops = m.plan(d0, d);
check(j(ops) === j([{ op: 'set', config: 'network', section: 'cfg020f15', values: { ports: ['lan3:u*'] } }]), 'only the ports of that section are set, as a list', j(ops));

d = m.draftFrom(d0);
rowOf(d, KEY, '1').cells.lan3 = 'u*';
delete rowOf(d, KEY, '1').cells.lan4;
rowOf(d, KEY, '1').cells.lan2 = 't';
ops = m.plan(d0, d);
check(j(ops[0].values.ports) === j(['lan1:u*', 'lan2:t', 'lan3:u*']), 'ports the edit did not touch keep their spelling and place; a changed one is rewritten; a removed one leaves', j(ops));
rowOf(d, KEY, '1').cells.lan3 = 'u';
check(j(m.plan(d0, d)[0].values.ports) === j(['lan1:u*', 'lan2:t', 'lan3']), 'an unchanged untagged port written without flags stays that way', j(m.plan(d0, d)));

d = m.draftFrom(d0);
rowOf(d, KEY, '90').local = true;
rowOf(d, KEY, '20').local = false;
ops = m.plan(d0, d);
check(j(ops) === j([{ op: 'set', config: 'network', section: 'cfg020f15', values: { local: '0' } }, { op: 'delete', config: 'network', section: 'cfg030f15', options: ['local'] }]), 'the router membership is the local option: off is 0, on deletes the option (its default)', j(ops));
ch = m.changesOf(d0, d);
check(ch.map(c => c.label).join() === 'br-lan VLAN 20,br-lan VLAN 90' && /router/.test(ch[1].to) && !/router/.test(ch[0].to), 'and shows in the review');

d = m.draftFrom(d0);
for (const k of Object.keys(rowOf(d, KEY, '20').cells)) delete rowOf(d, KEY, '20').cells[k];
check(j(m.plan(d0, d)) === j([{ op: 'delete', config: 'network', section: 'cfg020f15', options: ['ports'] }]), 'a row emptied of ports loses its ports option');

d = m.draftFrom(d0);
check(m.addRow(d0, d, KEY, '') && m.addRow(d0, d, KEY, 'abc') && m.addRow(d0, d, KEY, '0') && m.addRow(d0, d, KEY, '4095') && m.addRow(d0, d, KEY, '1.5'), 'a VLAN id must be a whole number from 1 to 4094');
check(/already/.test(m.addRow(d0, d, KEY, '20') ?? '') && /already/.test(m.addRow(d0, d, KEY, ' 020 ') ?? ''), 'a VLAN that is in the table cannot be added again (leading zeros do not make it another)');
check(m.addRow(d0, d, KEY, '30') === null && m.addRow(d0, d, KEY, '40') === null && d.tables[KEY].rows.length === 5 && d.tables[KEY].rows[3].local === true && d.tables[KEY].rows[3].sec === null, 'a new VLAN starts with no port and the router as a member');
rowOf(d, KEY, '30').cells.lan1 = 't';
rowOf(d, KEY, '30').cells.lan2 = 'u*';
m.removeRow(d, KEY, 'new:2');
ops = m.plan(d0, d);
check(j(ops) === j([{ op: 'add', config: 'network', type: 'bridge-vlan', values: { device: 'br-lan', vlan: '30', ports: ['lan1:t', 'lan2:u*'] } }]), 'a new VLAN becomes a bridge-vlan section (device, vlan, ports; local only when off); one added and removed again leaves nothing', j(ops));
ch = m.changesOf(d0, d);
check(ch.length === 1 && ch[0].label === 'br-lan VLAN 30 added' && ch[0].from === 'none' && ch[0].to === 'lan1 tagged, lan2 untagged + PVID, router', j(ch));
rowOf(d, KEY, '30').local = false;
check(m.plan(d0, d)[0].values.local === '0', 'a new VLAN without the router sets local to 0');

d = m.draftFrom(d0);
m.removeRow(d, KEY, 'lan_vlan');
ops = m.plan(d0, d);
check(j(ops) === j([{ op: 'delete', config: 'network', section: 'lan_vlan' }]) && m.changesOf(d0, d)[0].label === 'br-lan VLAN 1 removed', 'removing a VLAN deletes its section (a named one too)', j(ops));

d = m.draftFrom(d0);
d.tables[KEY].filtering = false;
check(j(m.plan(d0, d)) === j([{ op: 'delete', config: 'network', section: 'cfg050f15', options: ['vlan_filtering'] }]) && m.changesOf(d0, d)[0].label === 'br-lan VLAN filtering' && m.changesOf(d0, d)[0].to === 'off', 'turning VLAN filtering off deletes the option of the bridge device and is its own line in the review');
let off = m.draftFrom(dOff);
off.tables[KEY].filtering = true;
check(j(m.plan(dOff, off)) === j([{ op: 'set', config: 'network', section: 'cfg050f15', values: { vlan_filtering: '1' } }]), 'turning it on sets vlan_filtering to 1 on the device section');
//#endregion

//#region Validation of a bridge table
console.log('\n== validation of a bridge table ==');
// The problems of an edited draft as [error texts, warnings].
const probs = (data, draft) => { const p = m.problems(data, draft); return [p.errors.map(e => e.text), p.warnings]; };
d = m.draftFrom(d0);
rowOf(d, KEY, '20').cells.lan1 = 'u*';
let [errs, warns] = probs(d0, d);
check(errs.some(e => /lan1 is the PVID of VLAN 1 and VLAN 20/.test(e)) && m.problems(d0, d).errors.find(e => /PVID/.test(e.text)).also, 'two PVIDs on one port are an error naming both VLANs, and mark both cells', j(errs));
d = m.draftFrom(d0);
d.tables[KEY].rows.push({ key: 'new:9', sec: null, vid: '20', local: true, cells: {}, orig: [] });
d.tables[KEY].rows.push({ key: 'new:10', sec: null, vid: 'x', local: true, cells: {}, orig: [] });
d.tables[KEY].rows.push({ key: 'new:11', sec: null, vid: '5000', local: true, cells: {}, orig: [] });
[errs] = probs(d0, d);
check(errs.some(e => /VLAN 20 is in the table twice/.test(e)) && errs.some(e => /"x" is not a VLAN id/.test(e)) && errs.some(e => /"5000"/.test(e)), 'a duplicate or invalid VLAN id is an error', j(errs));
d = m.draftFrom(d0);
const ghost = clone(d0);
ghost.vlan.tables[0].columns.push({ id: 'lan9', label: 'lan9', member: false });
rowOf(d, KEY, '20').cells.lan9 = 't';
[errs] = probs(ghost, d);
check(errs.some(e => /lan9 is not a member of the bridge/.test(e)), 'putting a port that is not a member of the bridge into a VLAN is an error');
d = m.draftFrom(d0);
rowOf(d, KEY, '20').cells.lan1 = 'u';
[errs, warns] = probs(d0, d);
check(!errs.length && warns.some(w => /lan1 is untagged in VLAN 1 and VLAN 20/.test(w)) && warns.some(w => /lan3 is untagged in VLAN 1 but no VLAN is marked as its PVID/.test(w)), 'a port untagged in two VLANs and one untagged without a PVID are warnings', j(warns));
d = m.draftFrom(d0);
delete rowOf(d, KEY, '1').cells.lan2;
[, warns] = probs(d0, d);
check(warns.some(w => /lan2 is in no VLAN, so it carries no traffic/.test(w)), 'a member port that is in no VLAN carries no traffic (warned while filtering is on)');
d = m.draftFrom(d0);
rowOf(d, KEY, '90').cells = {};
[, warns] = probs(d0, d);
check(warns.some(w => /VLAN 90 has no member at all/.test(w)), 'a VLAN with no port and without the router is reported');
// VLAN filtering off: the table has no effect.
off = m.draftFrom(dOff);
m.addRow(dOff, off, KEY, '10');
[errs, warns] = probs(dOff, off);
check(!errs.length && warns.some(w => /VLAN filtering is off on br-lan, so this table has no effect until it is turned on/.test(w)), 'editing a table while the bridge does not filter warns that it has no effect', j(warns));
off.tables[KEY].filtering = true;
[, warns] = probs(dOff, off);
check(warns.some(w => /Turning VLAN filtering on changes how every port of br-lan forwards at once/.test(w)) && !warns.some(w => /has no effect/.test(w)), 'turning it on is flagged as a change of its own, and the no-effect warning goes');
check(warns.some(w => /br-lan\.20 is a VLAN device on br-lan: with VLAN filtering on it carries nothing unless VLAN 20/.test(w)) && warns.some(w => /VLAN 1 carries lan \(192\.168\.1\.1\/24\); without this VLAN in the table/.test(w)), 'with filtering on, the VLAN devices and the router\'s untagged interface that the table does not cover are named', j(warns));
// Lockout.
d = m.draftFrom(d0);
m.removeRow(d, KEY, rowOf(d, KEY, '20').key);
[, warns] = probs(d0, d);
check(warns.some(w => /VLAN 20 carries iot \(192\.168\.20\.1\/24\); without this VLAN in the table the interface loses its traffic\./.test(w)) && !warns.some(w => /You are connected/.test(w)), 'removing a VLAN that carries an interface of the router warns');
const mgmtData = dataOf(net(), rawBridge(), '192.168.20.1');
d = m.draftFrom(mgmtData);
m.removeRow(d, KEY, rowOf(d, KEY, '20').key);
check(probs(mgmtData, d)[1].some(w => /You are connected through this address \(192\.168\.20\.1\)/.test(w)), 'and says so when it is the address the page is open on');
d = m.draftFrom(d0);
rowOf(d, KEY, '90').local = true;
check(!probs(d0, d)[1].some(w => /carries/.test(w)), 'changing a VLAN that carries no interface of the router is not a lockout');
d = m.draftFrom(d0);
rowOf(d, KEY, '20').local = false;
check(probs(d0, d)[1].some(w => /VLAN 20 carries iot .*the router leaves this VLAN/.test(w)), 'the router leaving a VLAN that carries an interface is');
d = m.draftFrom(d0);
delete rowOf(d, KEY, '20').cells.lan3;
check(probs(d0, d)[1].some(w => /VLAN 20 carries iot .*lan3 changes here, so devices behind it may lose the router/.test(w)), 'a port that leaves such a VLAN may cut off the devices behind it');
d = m.draftFrom(dOff);
m.addRow(dOff, d, KEY, '10');
check(!probs(dOff, d)[1].some(w => /carries/.test(w)), 'while the bridge does not filter, its table cannot cut anything off');
d = m.draftFrom(d0);
d.tables[KEY].filtering = false;
check(probs(d0, d)[1].some(w => /Turning VLAN filtering off removes the separation between the VLANs of br-lan/.test(w)), 'turning filtering off is warned');
//#endregion

//#region The check after a save
console.log('\n== the check after a save ==');
// The raw config after the draft was applied the way the router would: the plan's operations on a copy.
function applied(data, draft, raw) {
  const out = clone(raw);
  let n = 100;
  for (const o of m.plan(data, draft)) {
    if (o.op === 'delete' && !o.options) { for (const t of Object.keys(out)) delete out[t][o.section]; continue; }
    if (o.op === 'add') { out[o.type][`cfg${n}`] = { '.type': o.type, '.name': `cfg${n}`, '.index': n++, ...o.values }; continue; }
    for (const t of Object.keys(out)) {
      const s = out[t][o.section];
      if (!s) continue;
      if (o.op === 'set') Object.assign(s, o.values);
      else for (const opt of o.options) delete s[opt];
    }
  }
  return out;
}
d = m.draftFrom(d0);
rowOf(d, KEY, '20').cells.lan3 = 'u*';
delete rowOf(d, KEY, '20').cells.lan4;
m.addRow(d0, d, KEY, '30');
rowOf(d, KEY, '30').cells.lan2 = 't';
m.removeRow(d, KEY, 'lan_vlan');
d.tables[KEY].filtering = false;
check(!throwsLike(() => m.checkApplied(d0, d, applied(d0, d, rawBridge())), /./), 'a config that holds the draft passes');
check(throwsLike(() => m.checkApplied(d0, d, rawBridge()), /did not keep the change: .*VLAN 30 is not in the config.*VLAN 1 is still in the config/), 'a router that kept nothing fails and says what is missing');
const half = applied(d0, d, rawBridge());
Object.values(half['bridge-vlan']).find(s => s.vlan === '30').ports = ['lan2:u'];
check(throwsLike(() => m.checkApplied(d0, d, half), /VLAN 30 was stored differently/), 'a row stored with other members fails');
const filt = applied(d0, d, rawBridge());
filt.device.cfg050f15.vlan_filtering = '1';
check(throwsLike(() => m.checkApplied(d0, d, filt), /VLAN filtering on br-lan is not off in the config/), 'a switch that stayed as it was fails');
check(!throwsLike(() => m.checkApplied(d0, m.draftFrom(d0), rawBridge()), /./) && !throwsLike(() => m.checkApplied(dOff, off, applied(dOff, off, { 'bridge-vlan': {}, device: devicesOff() })), /./), 'a draft without edits passes, and so does a new VLAN with filtering turned on');
//#endregion

//#region swconfig tables
console.log('\n== swconfig tables ==');
const ds = dataSwitch();
const ts = ds.vlan.tables[0];
const SKEY = 'switch:switch0';
check(ds.vlan.tables.length === 1 && ts.kind === 'switch' && ts.enable === true && ts.enableSection === 'sw0' && ts.label === 'Switch AR8327', 'a table for the switch with its enable_vlan');
check(ts.columns.map(c => `${c.id}${c.cpu ? 'c' : ''}`).join() === '1,2,3,4,0c' && ts.columns.at(-1).label === 'CPU (0)', 'columns are the user ports, then the CPU port', j(ts.columns));
check(ts.rows.length === 2 && ts.rows[0].cells['0'] === 't' && ts.rows[0].cells['1'] === 'u' && ts.rows[1].vid === '1036' && ts.rows[1].vlan === '2' && m.switchVid(ts.rows[1]) === '1036' && m.switchVid(ts.rows[0]) === '1', 'rows are the groups: the id is the vid option, else the group number');
check(ts.pvids.length === 1 && ts.pvids[0].pvid === '1036' && ts.carriers.map(c => `${c.iface}:${c.vid}`).join() === 'lan:1', 'switch_port PVIDs and the interfaces on the CPU\'s VLAN devices are known', j(ts));
const bareNet = netSwitch();
bareNet.vlans = [];
check(m.dataOf(bareNet, rawSwitch(), ifsSwitch(), 'h').tables[0].carriers.map(c => c.iface).join() === 'lan', 'an interface on the CPU\'s VLAN device is found by its name even when the plugin lists no VLAN device');
let sd = m.draftFrom(ds);
check(!m.isDirty(ds, sd), 'an untouched switch draft is clean');
swRow(sd, '1').cells['3'] = 't';
delete swRow(sd, '1').cells['2'];
ch = m.changesOf(ds, sd);
ops = m.plan(ds, sd);
check(ch.length === 1 && ch[0].label === 'switch0 VLAN 1' && ch[0].from === 'port1 untagged, port2 untagged, port3 untagged, CPU (0) tagged' && ch[0].to === 'port1 untagged, port3 tagged, CPU (0) tagged', 'the review of a group', j(ch));
check(j(ops) === j([{ op: 'set', config: 'network', section: 'cfg020f15', values: { ports: '0t 1 3t' } }]), 'the ports option is rewritten as a string of tokens, keeping the order', j(ops));
sd = m.draftFrom(ds);
check(m.addRow(ds, sd, SKEY, '0') && m.addRow(ds, sd, SKEY, '1') && m.addRow(ds, sd, SKEY, '1036'), 'a VLAN id that is invalid or already used cannot be added (the vid option counts)');
check(m.addRow(ds, sd, SKEY, '3') === null && m.addRow(ds, sd, SKEY, '100') === null, 'new groups get the lowest free group number');
swRow(sd, '100').cells['2'] = 'u';
ops = m.plan(ds, sd);
check(j(ops) === j([
  { op: 'add', config: 'network', type: 'switch_vlan', values: { device: 'switch0', vlan: '3', ports: '0t' } },
  { op: 'add', config: 'network', type: 'switch_vlan', values: { device: 'switch0', vlan: '4', vid: '100', ports: '0t 2' } }]), 'a new group is a switch_vlan section with the CPU port tagged; the vid option only when it differs from the group number', j(ops));
sd = m.draftFrom(ds);
m.removeRow(sd, SKEY, 'cfg030f15');
check(j(m.plan(ds, sd)) === j([{ op: 'delete', config: 'network', section: 'cfg030f15' }]) && m.changesOf(ds, sd)[0].label === 'switch0 VLAN 1036 (group 2) removed', 'removing a group deletes its section');
sd = m.draftFrom(ds);
sd.tables[SKEY].enable = false;
check(j(m.plan(ds, sd)) === j([{ op: 'set', config: 'network', section: 'sw0', values: { enable_vlan: '0' } }]) && m.changesOf(ds, sd)[0].label === 'switch0 enable_vlan', 'enable_vlan is set on the switch section');
sd = m.draftFrom(ds);
swRow(sd, '1').cells['4'] = 'u';
[errs] = probs(ds, sd);
check(errs.some(e => /port4 is untagged in VLAN 1 and VLAN 1036, but an untagged port can only be in one VLAN/.test(e)), 'a port untagged in two groups is an error', j(errs));
sd = m.draftFrom(ds);
sd.tables[SKEY].rows.push({ key: 'new:5', sec: null, vlan: '2', vid: '', cells: {}, orig: [] });
sd.tables[SKEY].rows.push({ key: 'new:6', sec: null, vlan: 'x', vid: '1', cells: {}, orig: [] });
[errs] = probs(ds, sd);
check(errs.some(e => /group 2 is in the table twice/.test(e)) && errs.some(e => /"x" is not a VLAN group number/.test(e)) && errs.some(e => /VLAN 1 is in the table twice/.test(e)), 'duplicate groups and ids are errors', j(errs));
sd = m.draftFrom(ds);
delete swRow(sd, '1').cells['0'];
delete swRow(sd, '1036').cells['0'];
[, warns] = probs(ds, sd);
check(warns.some(w => /the CPU port is in no VLAN, so the router cannot reach any port/.test(w)) && warns.some(w => /VLAN 1 carries lan \(192\.168\.1\.1\/24\); the CPU port no longer carries it the same way/.test(w)), 'the CPU port leaving every group, and leaving the group of the router\'s interface, are warned', j(warns));
sd = m.draftFrom(ds);
sd.tables[SKEY].enable = false;
[, warns] = probs(ds, sd);
check(warns.some(w => /Turning VLANs off on switch0/.test(w)), 'turning the switch\'s VLANs off is warned');
sd = m.draftFrom(ds);
swRow(sd, '1').cells['3'] = 't';
sd.tables[SKEY].rows.push({ key: 'new:7', sec: null, vlan: '5', vid: '', cells: { 1: 'u' }, orig: [], foreign: [] });
const swApplied = applied(ds, sd, rawSwitch());
check(!throwsLike(() => m.checkApplied(ds, sd, swApplied), /./) && throwsLike(() => m.checkApplied(ds, sd, rawSwitch()), /VLAN 5 is not in the config/), 'the check after a save works for switch groups too');
swApplied.switch.sw0.enable_vlan = '1';
sd.tables[SKEY].enable = false;
check(throwsLike(() => m.checkApplied(ds, sd, swApplied), /enable_vlan of switch0 is not off in the config/), 'and for enable_vlan');
const foreign = rawSwitch();
foreign.switch_vlan.cfg020f15.ports = '0t 1 2 3 5*';
const fd = dataSwitch(foreign);
sd = m.draftFrom(fd);
swRow(sd, '1').cells['3'] = 't';
check(j(m.plan(fd, sd)[0].values.ports) === '"0t 1 2 3t 5*"', 'a token that is not a port number is kept as it is');
//#endregion

console.log(failed ? `\nFAILED: ${failed}` : '\nall VLAN editor model tests passed');
process.exit(failed ? 1 : 0);
