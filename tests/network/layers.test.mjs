// Unit test for the network layer model (www/js/pages/interfaces/layers.js): pure data, no router or browser.
// Usage: node layers.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { buildLayers } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/interfaces/layers.js')).href);

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
// Comma-joined names of a list of layer nodes, for compact comparisons.
const names = list => list.map(x => x.name).join();

// A router like the lab one: switch ports in a bridge (plus Wi-Fi), a VLAN on the bridge, VLANs on the WAN
// port carrying PPPoE, wan6 riding on the PPPoE session, a WireGuard tunnel and tunnels over wan.
// A front-panel port; `index` is its position on the board (absent for a port without a board entry, e.g. eth0).
const port = (name, carrier, index) => ({ name, carrier, board: { index } });
const net = {
  ports: [port('lan1', true, 0), port('lan2', false, 1), port('eth1', true, 5), port('eth0', true)],
  bridges: [{ name: 'br-lan', up: true, stp: true, members: [{ name: 'lan1', kind: 'ethernet', carrier: true }, { name: 'lan2', kind: 'ethernet', carrier: false }, { name: 'phy0-ap0', kind: 'wifi', carrier: true }] }],
  vlans: [
    { name: 'br-lan.100', parent: 'br-lan', vid: 100, up: true, carrier: true },
    { name: 'eth1.1036', parent: 'eth1', vid: 1036, up: true, carrier: true },
    { name: 'eth1.1035', parent: 'eth1', vid: 1035, up: true, carrier: true },
  ],
};
// A netifd interface record as the plugin reports it: `device` is the L2 device, `l3` the device carrying addresses.
const iface = (interfaceName, proto, device, l3, extra = {}) => ({ interface: interfaceName, proto, device, l3_device: l3, up: true, ...extra });
const ifs = [
  iface('loopback', 'static', 'lo', 'lo'),
  iface('lan', 'static', 'br-lan', 'br-lan'),
  iface('lan100', 'static', 'br-lan.100', 'br-lan.100'),
  iface('wan', 'pppoe', 'eth1.1036', 'pppoe-wan'),
  iface('voip', 'pppoe', 'eth1.1035', 'pppoe-voip'),
  iface('wan6', 'dhcpv6', 'pppoe-wan', 'pppoe-wan'),
  iface('wg0', 'wireguard', undefined, 'wg0'),
  iface('xfrm0', 'xfrm', undefined, 'xfrm0'),
  iface('direct', 'static', 'lan2', 'lan2'),
  iface('ghost', 'static', 'nope0', 'nope0'),
];
const rows = buildLayers(net, ifs, { xfrm0: 'wan' });
// The layer row of the named interface.
const row = n => rows.find(r => r.name === n);

console.log('== layers ==');
check(!row('loopback'), 'the loopback interface is left out');
check(names(row('lan').roots) === 'lan1,lan2,phy0-ap0' && row('lan').roots.map(r => r.kind).join() === 'port,port,wifi' && names(row('lan').devices) === 'br-lan' && row('lan').protoDevice === null, 'a bridge groups its ports and Wi-Fi; no protocol device when it is the device itself', JSON.stringify(row('lan')));
check(names(row('lan100').roots) === 'lan1,lan2,phy0-ap0' && names(row('lan100').devices) === 'br-lan,br-lan.100' && row('lan100').devices[1].vid === 100, 'a VLAN on a bridge stacks on the bridge: ports > br-lan > br-lan.100');
check(names(row('wan').roots) === 'eth1' && names(row('wan').devices) === 'eth1.1036' && row('wan').protoDevice.name === 'pppoe-wan' && row('wan').protoDevice.label === 'PPPoE session' && !row('wan').protoDevice.shared, 'PPPoE over a VLAN over a port: eth1 > eth1.1036 > wan > pppoe-wan');
check(names(row('voip').devices) === 'eth1.1035' && row('voip').protoDevice.name === 'pppoe-voip', 'a second VLAN on the same port gets its own chain');
check(row('wan6').over === 'wan' && names(row('wan6').roots) === 'eth1' && row('wan6').protoDevice.shared === true && row('wan6').protoDevice.name === 'pppoe-wan', 'wan6 rides on the PPPoE session of wan and shows the same ports and device', JSON.stringify(row('wan6')));
check(row('wg0').roots.length === 0 && row('wg0').devices.length === 0 && row('wg0').protoDevice.label === 'WireGuard tunnel' && row('wg0').over === null, 'a tunnel with no underlay is just its protocol device');
check(row('xfrm0').over === 'wan' && row('xfrm0').roots.length === 0 && row('xfrm0').protoDevice.name === 'xfrm0', 'a tunnel with tunlink runs over that interface');
check(names(row('direct').roots) === 'lan2' && row('direct').devices.length === 0, 'an interface directly on a port has no device layer');
check(names(row('ghost').devices) === 'nope0' && row('ghost').devices[0].kind === 'device' && row('ghost').roots.length === 0, 'a device the router does not describe is kept as an unknown device');
check(rows[0].name === 'lan' || rows[0].name === 'lan100' || rows[0].name === 'direct', 'interfaces on the first front-panel ports come first', rows.map(r => r.name).join());
check(rows.findIndex(r => r.name === 'wan') > rows.findIndex(r => r.name === 'lan'), 'WAN chains follow LAN chains (board order)');
check(rows.at(-1).roots.length === 0, 'tunnels without ports come last', rows.map(r => r.name).join());

console.log('== wireless ==');
const radios = [
  { name: 'radio0', band: '2g', up: true, enabled: true, interfaces: [
    { section: 'a0', ifname: 'phy0-ap0', mode: 'ap', ssid: 'home', up: true, enabled: true, networks: ['lan'] },
    { section: 'm0', ifname: 'phy0-mesh0', mode: 'mesh', ssid: 'meshid', up: true, enabled: true, networks: ['lan'] },
    { section: 'g0', ifname: null, mode: 'ap', ssid: 'guest', up: false, enabled: true, networks: ['lan'] },
    { section: 'x0', ifname: 'phy0-ap1', mode: 'ap', ssid: 'stray', up: true, enabled: true, networks: ['nowhere'] },
  ] },
  { name: 'radio1', band: '5g', up: false, enabled: true, interfaces: [] },
  { name: 'radio2', band: '6g', up: true, enabled: true, interfaces: [{ section: 's0', ifname: 'phy2-sta0', mode: 'sta', ssid: 'up', up: true, enabled: true, networks: ['uplink'] }] },
];
const wnet = { ...net, bridges: [{ ...net.bridges[0], members: [...net.bridges[0].members, { name: 'phy0-mesh0', kind: 'wifi', carrier: true }] }] };
const wrows = buildLayers(wnet, [...ifs, iface('uplink', 'dhcp', 'phy2-sta0', 'phy2-sta0')], { xfrm0: 'wan' }, radios);
// The layer row of the named interface in the wireless-aware model.
const wrow = n => wrows.find(r => r.name === n);
const ap = wrow('lan').roots.find(r => r.name === 'phy0-ap0');
check(ap?.kind === 'wifi' && ap.radio === 'radio0' && ap.band === '2g' && ap.ssid === 'home' && ap.up === true, 'a bridged Wi-Fi interface knows its radio, band and SSID', JSON.stringify(ap));
const mesh = wrow('lan').roots.find(r => r.name === 'phy0-mesh0');
check(mesh?.kind === 'mesh' && mesh.ssid === 'meshid' && mesh.radio === 'radio0', 'a mesh interface is its own kind', JSON.stringify(mesh));
const queued = wrow('lan').roots.find(r => r.name === 'g0');
check(queued?.kind === 'wifi' && queued.up === false, 'a configured but not running interface joins the network named in its config', JSON.stringify(queued));
check(names(wrow('lan').roots.filter(r => r.kind === 'wifi' || r.kind === 'mesh')) === 'phy0-ap0,phy0-mesh0,g0', 'no wireless node is listed twice', names(wrow('lan').roots));
check(wrow('uplink').roots.length === 1 && wrow('uplink').roots[0].kind === 'wifi' && wrow('uplink').roots[0].radio === 'radio2' && wrow('uplink').devices.length === 0, 'an interface directly on a station interface sits on that Wi-Fi node');
const orph = wrows.filter(r => r.orphan);
check(orph.length === 2 && orph.map(r => r.name).join() === 'phy0-ap1,radio1' && wrows.slice(-2).every(r => r.orphan), 'a wireless interface nothing uses, and a radio without interfaces, get rows at the end', orph.map(r => r.name).join());
check(orph.every(r => r.iface === null && r.devices.length === 0 && r.over === null && r.protoDevice === null) && orph[1].roots[0].kind === 'radio' && orph[1].up === false, 'such rows have no netifd interface');
check(buildLayers(net, ifs, { xfrm0: 'wan' }, undefined).length === rows.length && buildLayers(net, ifs, {}, []).every(r => !r.orphan), 'without radio data nothing changes');

console.log('== robustness ==');
const loop = buildLayers({ ports: [], bridges: [], vlans: [{ name: 'a.1', parent: 'a.2', vid: 1, up: true }, { name: 'a.2', parent: 'a.1', vid: 2, up: true }] }, [iface('x', 'static', 'a.1', 'a.1')], {});
check(loop.length === 1, 'a parent loop does not hang');
check(buildLayers({ ports: [], bridges: [], vlans: [] }, [], {}).length === 0, 'no interfaces, no rows');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall network-layer checks passed');
