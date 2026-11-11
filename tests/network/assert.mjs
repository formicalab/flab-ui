// Checks the backend JSON produced for each Network / Wi-Fi radio scenario.
// Usage: node assert.mjs <dir with <scenario>.<plugin>.json files and expect.json>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const net = n => read(`${n}.flab.network.json`);
const rad = n => read(`${n}.flab.radio.json`);
const mesh = n => read(`${n}.flab.mesh.json`);
const wg = n => read(`${n}.flab.wireguard.json`);
const fwr = n => read(`${n}.flab.firewall.json`);
const expect = read('expect.json');
let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const port = (d, n) => d.ports.find(p => p.name === n);
const bridgeOf = (d, n = expect.bridge) => d.bridges.find(b => b.name === n);
const memberOf = (d, n, b = expect.bridge) => bridgeOf(d, b).members.find(m => m.name === n);
const radio = (d, n) => d.radios.find(r => r.name === n);
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

console.log('== network: base (real captured state) ==');
const base = net('base');
const bridge = bridgeOf(base);
check(same(base.ports.map(p => p.name), expect.ports), 'every Ethernet device is a port', base.ports.map(p => p.name).join());
check(/^(switch,)+nic,conduit$/.test(base.ports.map(p => p.role).join()), 'switch ports first, then the adapter, then the CPU link', base.ports.map(p => p.role).join());
check(base.ports.filter(p => p.role === 'switch').map(p => p.name).join() === [...base.ports.filter(p => p.role === 'switch').map(p => p.name)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(), 'switch ports in natural order (lan2 before lan10)');
check(base.ports.every(p => typeof p.carrier === 'boolean' && p.stats && typeof p.stats.rx_bytes === 'number'), 'every port has link state and counters');
check(base.ports.every(p => !p.downshifted), 'no link is downshifted');
check(base.bridges.length === 1 && bridge && same(bridge.members.map(m => m.name), expect.members), 'one bridge with the configured members', JSON.stringify(bridge?.members.map(m => m.name)));
check(bridge.members.every(m => m.kind === (/^phy/.test(m.name) ? 'wifi' : 'ethernet')), 'members classified as Ethernet or Wi-Fi');
check(bridge.members.filter(m => m.kind === 'wifi').every(m => /^phy\d+$/.test(m.phy)), 'Wi-Fi members know their phy');
check(bridge.members.every(m => m.macs === (expect.learned[m.name] ?? 0) && m.local_macs === 2), 'learned and local MACs per member parsed from the forwarding table', JSON.stringify(bridge.members.map(m => [m.name, m.macs, m.local_macs])));
check(bridge.macs === sum(expect.learned), 'bridge total of learned MACs', String(bridge.macs));
check(bridge.stp === true && bridge.bridge_id && bridge.root_id, 'STP data present');
const rootMember = bridge.members.find(m => m.brport?.port_no === bridge.root_port);
check(bridge.is_root === false && rootMember && bridge.root_port_name === rootMember.name && rootMember.brport.role === 'root', 'root port found by port number', `${bridge.root_port_name} / ${rootMember?.name}`);
check(bridge.members.filter(m => m !== rootMember).every(m => ['designated', 'disabled'].includes(m.brport.role)), 'other members are designated or disabled');
check(bridge.ageing_time === 300 && bridge.forward_delay === 8 && bridge.hello_time === 1 && bridge.max_age === 10, 'STP timers converted from kernel ticks to seconds', JSON.stringify([bridge.ageing_time, bridge.forward_delay, bridge.hello_time, bridge.max_age]));
check(base.vlans.length >= 1 && base.vlans.every(v => v.parent && v.vid), 'VLAN devices listed with parent and VID');
check(base.ports.filter(p => p.vlans.length).every(p => p.vlans.every(v => v.parent === p.name)) && bridge.vlans.every(v => v.parent === bridge.name), 'VLAN devices attached to their parent');
check(bridge.members.some(m => m.kind === 'wifi' && m.ssid), 'Wi-Fi members show their SSID from hostapd');
check(Array.isArray(base.zones) && base.zones.every(z => z.name && Array.isArray(z.networks) && Array.isArray(z.forwards) && ['input', 'output', 'forward'].every(k => /^(ACCEPT|REJECT|DROP)$/.test(z[k]))), 'firewall zones with their networks, policies and allowed forwardings', JSON.stringify(base.zones));
check(base.zones.some(z => z.networks.includes('lan') && z.input === 'ACCEPT') && base.zones.some(z => z.masq === true && z.networks.includes('wan')), 'the LAN zone accepts input, the WAN zone does NAT');
check(base.dhcp && Object.values(base.dhcp).length >= 1 && Object.values(base.dhcp).every(d => typeof d.v4 === 'string' && typeof d.v6 === 'string' && typeof d.ra === 'string'), 'DHCP and router-advertisement service per interface', JSON.stringify(base.dhcp));
check(base.dhcp.lan?.v4 === 'server' && base.dhcp.lan.start > 0 && base.dhcp.lan.limit > 0, 'DHCPv4 pool of the LAN interface');
check(!JSON.stringify(base).includes(expect.canary), 'no secret in the network output');

console.log('== network: hardware of the ports ==');
check(base.ports.every(p => p.hardware?.driver), 'every port reports its driver', JSON.stringify(base.ports.map(p => p.hardware?.driver)));
check(base.ports.filter(p => p.role === 'switch').every(p => /MT7531/.test(p.hardware.switch ?? '')), 'switch ports name their switch chip from the device tree', JSON.stringify(base.ports.filter(p => p.role === 'switch').map(p => p.hardware.switch)));
check(/RTL8221B/.test(port(base, 'lan1').hardware.phy?.name ?? '') && ['lan2', 'lan3', 'lan4', 'lan5'].every(n => /MT7531 PHY/.test(port(base, n).hardware.phy?.name ?? '')), 'PHYs matched by address, internal ones preferred over the same address on the other bus', JSON.stringify(['lan1', 'lan2', 'lan3'].map(n => port(base, n).hardware.phy)));
check(base.ports.filter(p => p.role !== 'switch' && p.hardware.phy).every(p => p.hardware.phy.name), 'adapters with an attached PHY name it');
const conduit = base.ports.find(p => p.role === 'conduit');
check(!conduit.hardware.phy && /MT7986/.test(conduit.hardware.soc ?? ''), 'the CPU link has no PHY and names the SoC MAC (it must not borrow a switch PHY with the same address)', JSON.stringify(conduit.hardware));

console.log('== network: wiring (topology data) ==');
const sw = base.switches[0];
check(base.switches.length === 1 && /MT7531/.test(sw.label) && same(sw.ports, base.ports.filter(p => p.role === 'switch').map(p => p.name)), 'one switch with all the DSA ports', JSON.stringify(base.switches));
check(sw.cpu_ports.length === 1 && sw.cpu_ports[0].port === 6 && sw.cpu_ports[0].conduit === 'eth0' && sw.cpu_ports[0].speed === 2500 && sw.cpu_ports[0].mode === '2500base-x', 'CPU port, its conduit, mode and speed from the device tree', JSON.stringify(sw.cpu_ports));
check(['lan2', 'lan3', 'lan4', 'lan5'].every((n, i) => port(base, n).hardware.switch_port === i) && port(base, 'lan1').hardware.switch_port === 5, 'switch port numbers (reg) per user port: lan2-5 on 0-3, lan1 on 5', JSON.stringify(base.ports.map(p => [p.name, p.hardware.switch_port])));
check(port(base, 'lan1').hardware.external_phy === true && ['lan2', 'lan3', 'lan4', 'lan5'].every(n => port(base, n).hardware.external_phy === false), 'external PHY only where the device tree has a phy-handle');
check(base.ports.filter(p => p.board).every(p => p.board.role === 'lan' || p.board.role === 'wan') && port(base, 'lan1').board.index === 0 && port(base, 'lan5').board.index === 4 && port(base, 'eth1').board.role === 'wan', 'LAN/WAN role and order from /etc/board.json', JSON.stringify(base.ports.map(p => [p.name, p.board])));
check(base.model && typeof base.model === 'string', 'board model name', String(base.model));
check(typeof base.tunlinks === 'object' && Object.values(base.tunlinks).every(v => typeof v === 'string') && Object.keys(base.tunlinks).every(k => /^xfrm\d+$|^[a-z]/.test(k)), 'tunnel underlays (tunlink) from UCI, interface names only', JSON.stringify(base.tunlinks));

console.log('== network: a different router ==');
const other = net('n-board');
check(other.model === 'Other Router' && other.switches[0].ports.length === 4, 'model and port count follow the board', JSON.stringify([other.model, other.switches[0].ports]));
check(['lan4', 'lan3', 'lan2', 'lan1'].every((n, i) => port(other, n).board.index === i) && port(other, 'eth1').board.index === 4, 'jack order follows the board file', JSON.stringify(other.ports.map(p => [p.name, p.board?.index])));
check(other.ports.every(p => p.hardware.external_phy !== true), 'no external PHY without phy-handle');

console.log('== network: a router without a switch ==');
const nodsa = net('n-nodsa');
check(nodsa.switches.length === 0 && same(nodsa.ports.map(p => p.name), ['eth0', 'eth1']) && nodsa.ports.every(p => p.role === 'nic'), 'plain MACs, no switch', JSON.stringify([nodsa.switches, nodsa.ports.map(p => [p.name, p.role])]));
const withProblems = base.ports.filter(p => (p.stats.rx_errors + p.stats.tx_errors + p.stats.rx_crc_errors + p.stats.rx_dropped + p.stats.tx_dropped) > 0);
check(withProblems.length >= 1 && withProblems.every(p => p.diagnostics && Object.keys(p.diagnostics.counters).length), 'ports with errors or drops carry a breakdown of non-zero counters', withProblems.map(p => p.name).join());
check(base.ports.filter(p => !withProblems.includes(p)).every(p => p.diagnostics === undefined), 'clean ports carry none (no needless work)');
check(withProblems.every(p => !('rx_bytes' in p.diagnostics.counters) && !('tx_packets' in p.diagnostics.counters)), 'traffic totals are not mistaken for errors');
check(base.ports.every(p => p.stats && Object.keys(p.stats).length > 11), 'all kernel counters are passed through', String(Object.keys(base.ports[0].stats).length));

console.log('== network: link down ==');
const down = net('n-linkdown');
check(port(down, 'lan1').carrier === false && port(down, 'lan1').speed === null && port(down, 'lan1').duplex === null, 'port reports no link, no speed');
check(port(down, 'lan1').brport.state_name === 'disabled' && port(down, 'lan1').brport.role === 'disabled', 'STP state follows the link');
check(down.ports.length === base.ports.length && port(down, 'lan2').carrier === true, 'other ports unchanged');

console.log('== network: downshifted link ==');
const slow = net('n-downshift');
check(port(slow, 'lan2').downshifted === true && port(slow, 'lan2').speed === 100, 'a 100 Mbit/s link on a gigabit-capable pair is flagged', JSON.stringify([port(slow, 'lan2').speed, port(slow, 'lan2').downshifted]));
check(!port(slow, 'lan1').downshifted, 'healthy links are not flagged');

console.log('== network: this bridge is the STP root ==');
const root = net('n-root');
check(bridgeOf(root).is_root === true && bridgeOf(root).root_port_name == null, 'root bridge, no root port');
check(bridgeOf(root).members.every(m => m.brport.role !== 'root'), 'no member is a root port');

console.log('== network: blocked port and topology change ==');
const blocked = net('n-blocked');
check(memberOf(blocked, 'phy1-ap0').brport.state_name === 'blocking' && memberOf(blocked, 'phy1-ap0').brport.role === 'alternate', 'blocked port is an alternate port');
check(bridgeOf(blocked).topology_change === true, 'topology change flag');

console.log('== network: STP off ==');
const nostp = net('n-nostp');
check(bridgeOf(nostp).stp === false && bridgeOf(nostp).members.every(m => m.brport.role === undefined), 'no STP roles are invented when STP is off');

console.log('== network: VLAN filtering ==');
check(bridgeOf(net('n-vlanfilter')).vlan_filtering === true && bridgeOf(net('n-vlanfilter')).default_pvid === 1, 'VLAN filtering and default PVID');

console.log('== network: a second bridge appears ==');
const two = net('n-newbridge');
check(two.bridges.length === 2 && two.bridges.some(b => b.name === 'br-guest'), 'new bridge discovered');
check(bridgeOf(two, 'br-guest').members.map(m => m.name).join() === 'lan5' && !bridgeOf(two).members.some(m => m.name === 'lan5'), 'lan5 moved to the new bridge');
check(port(two, 'lan5').bridge === 'br-guest', 'the port reports its new bridge');
check(bridgeOf(two, 'br-guest').is_root === true, 'new bridge computed from its own data');

console.log('== network: bridge port number above 255 ==');
const high = net('n-highport');
check(memberOf(high, 'lan5').macs === 4 && memberOf(high, 'lan2').macs === 1, 'high byte of the port number is honoured', JSON.stringify([memberOf(high, 'lan5').macs, memberOf(high, 'lan2').macs]));

console.log('== network: netifd reports nothing ==');
const none = net('n-nodevices');
check(none.ports.length === 0 && none.bridges.length === 0 && none.vlans.length === 0, 'empty lists, no crash');

console.log('== network: a port starts logging errors ==');
const err = port(net('n-errors'), 'lan2');
check(err.diagnostics?.counters.rx_crc_errors === 5 && err.diagnostics.counters.rx_errors === 5, 'kernel counters', JSON.stringify(err.diagnostics));
check(err.diagnostics.driver.rx_crc_errors === 5 && !('rx_pp_alloc_slow' in err.diagnostics.driver) && !('tx_packets' in err.diagnostics.driver), 'driver counters: error-like ones only', JSON.stringify(err.diagnostics.driver));
check(err.diagnostics.log.length === 2 && /Link is Down/.test(err.diagnostics.log[0]), 'recent log lines about the port', JSON.stringify(err.diagnostics.log));
check(port(net('n-errors'), 'lan3').diagnostics === undefined, 'other ports unaffected');

console.log('== radio: base (real captured state) ==');
const rb = rad('base');
check(same(rb.radios.map(r => r.name), expect.radios), 'every configured radio listed', rb.radios.map(r => r.name).join());
check(rb.regdomain?.country && rb.regdomain.dfs, 'regulatory domain parsed', JSON.stringify(rb.regdomain));
check(rb.radios.every(r => /^phy\d+$/.test(r.phy) && r.up === true && r.enabled === true), 'each radio mapped to its phy and running');
check(rb.radios.every(r => r.live?.channel > 0 && r.live.freq > 0 && r.live.width > 0 && r.live.txpower > 0), 'live channel, frequency, width and tx power');
check(rb.radios.every(r => r.survey?.freq === r.live.freq && r.survey.active > 0 && typeof r.survey.noise === 'number'), 'airtime survey of the channel in use', JSON.stringify(rb.radios.map(r => r.survey)));
check(rb.radios.every(r => r.antennas?.tx > 0 && r.standards.length && r.channels.length), 'antennas, standards and allowed channels');
check(rb.radios.every(r => r.channels.some(c => c.freq === r.live.freq)), 'the running channel is in the allowed list');
check(rb.radios.some(r => r.channels.some(c => c.dfs)) && rb.radios.some(r => r.channels.some(c => c.disabled)), 'DFS and disabled channels flagged');
check(rb.radios.every(r => /MediaTek/.test(r.hardware?.hardware ?? '')), 'hardware name from iwinfo');
check(rb.radios.every(r => r.interfaces.length >= 1 && r.interfaces.every(i => i.up && i.ifname && i.bssid)), 'interfaces up with BSSID');
check(rb.radios.flatMap(r => r.interfaces).filter(i => i.mode === 'ap').every(i => i.bss_status === 'ENABLED' && typeof i.clients === 'number'), 'AP interfaces: BSS status and client count');
check(rb.radios.flatMap(r => r.interfaces).some(i => i.mode === 'mesh' && i.ssid), 'mesh interface listed with its mesh id');
check(rb.radios.flatMap(r => r.interfaces).every(i => typeof i.rx_bytes === 'number' && typeof i.tx_bytes === 'number'), 'interface counters');
check(rb.radios.flatMap(r => r.interfaces).filter(i => i.mode === 'ap').every(i => i.security && i.features), 'security label and feature flags');
const filtered = rb.radios.flatMap(r => r.interfaces).find(i => i.macfilter);
check(!expect.maclist.length || (filtered && filtered.macfilter.entries === expect.maclist.length && !('maclist' in filtered)), 'MAC filter: only the number of entries', JSON.stringify(filtered?.macfilter));

console.log('== radio: secrets ==');
const radioScenarios = ['base', 'r-down', 'r-dfs', 'r-channel', 'r-disabled', 'r-newssid'];
for (const n of radioScenarios) {
  const text = JSON.stringify(rad(n));
  check(!text.includes(expect.canary) && !/"(key|sae_password|r0kh|r1kh|maclist)"/.test(text) && !expect.maclist.some(m => text.includes(m)), `${n}: no key, FT key material or MAC list in the output`);
}

console.log('== radio: a radio is down ==');
const rdown = rad('r-down');
const r1 = radio(rdown, 'radio1');
check(r1.up === false && r1.interfaces.length === 1 && r1.interfaces[0].up === false && !r1.interfaces[0].ifname, 'radio and its SSID are reported down');
check(r1.phy === 'phy1' && r1.channels.length > 0 && r1.live === undefined, 'phy found from the device path; capabilities listed, no live data');
check(radio(rdown, 'radio0').up === true && radio(rdown, 'radio0').live.channel > 0, 'the other radio is unaffected');

console.log('== radio: DFS availability check ==');
check(radio(rad('r-dfs'), 'radio1').interfaces[0].bss_status === 'DFS', 'BSS status DFS surfaced');

console.log('== radio: channel change ==');
const ch = radio(rad('r-channel'), 'radio0');
check(ch.live.channel === 11 && ch.live.freq === 2462 && ch.live.width === 20 && ch.survey.freq === 2462, 'live channel follows the driver while the configuration still says 6', JSON.stringify([ch.live, ch.survey?.freq]));
check(ch.config.channel === '6', 'configured channel is reported separately');

console.log('== radio: radio disabled in the configuration ==');
const dis = radio(rad('r-disabled'), 'radio1');
check(dis.enabled === false && dis.up === false, 'disabled radio reported as such');

console.log('== radio: a new SSID appears in the configuration ==');
const ns = radio(rad('r-newssid'), 'radio0');
const guest = ns.interfaces.find(i => i.ssid === 'guest');
check(ns.interfaces.length === 3 && guest && guest.up === false && guest.security === 'Open/None' && guest.networks.join() === 'guest', 'new SSID listed as not running, open, on its network', JSON.stringify(guest));

console.log('== mesh: base (real captured state) ==');
const mb = mesh('base');
const mn = mb.nodes[0];
check(mb.nodes.length === 1 && mn.mesh_id === expect.mesh.id && mn.ifname === expect.mesh.ifname && mn.up === true && mn.enabled === true, 'the configured mesh interface, with its mesh id and interface name', JSON.stringify([mn.mesh_id, mn.ifname]));
check(/WPA3/.test(mn.security) && mn.encryption === 'sae', 'security label from the encryption setting', JSON.stringify([mn.security, mn.encryption]));
check(mn.live?.channel > 0 && mn.live.freq > 0 && mn.live.width > 0, 'channel and width of the mesh interface', JSON.stringify(mn.live));
check(mn.peers.length >= 1 && mn.peers.every(p => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(p.mac) && typeof p.plink === 'string'), 'peers parsed with MAC and link state', JSON.stringify(mn.peers.map(p => [p.mac, p.plink])));
const p0 = mn.peers[0];
check(p0.plink === 'ESTAB' && typeof p0.signal === 'number' && p0.tx_rate?.mbit > 0 && p0.rx_rate?.mbit > 0 && typeof p0.airtime_metric === 'number' && typeof p0.connected_s === 'number', 'peer link quality: signal, bit rates, airtime metric, connected time', JSON.stringify(p0));
check(typeof p0.rx_bytes === 'number' && typeof p0.tx_retries === 'number' && typeof p0.tx_failed === 'number', 'peer counters');
check(Array.isArray(mn.paths) && mn.paths.every(p => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(p.dest) && Array.isArray(p.flags)), 'mesh paths parsed');
check(mn.params.mesh_fwding === '1' && mn.params.mesh_ttl && mn.params.mesh_hwmp_rootmode != null, 'mesh parameters read', JSON.stringify(mn.params));
check(Array.isArray(mn.proxied) && typeof mn.rx_bytes === 'number', 'proxied destinations list and interface counters');

console.log('== mesh: other states ==');
const m2 = mesh('m-twopeers').nodes[0];
const second = m2.peers.find(p => p.mac === 'aa:bb:cc:dd:ee:01');
check(m2.peers.length === mn.peers.length + 1 && second?.plink === 'LISTEN' && second.gate === true, 'a second peer in LISTEN state that is a mesh gate', JSON.stringify(second));
const multi = m2.paths.find(p => p.dest === 'aa:bb:cc:dd:ee:01');
check(multi && multi.hop_count === 2 && multi.metric === 222 && multi.next_hop === p0.mac && multi.flags.includes('resolved') && multi.flags.includes('sn_valid') && !multi.flags.includes('fixed'), 'a two-hop path through the first peer, flags decoded', JSON.stringify(multi));
const open = m2.paths.find(p => p.dest === '5a:00:00:00:00:01');
check(open && open.next_hop === null && open.flags.length === 0, 'an unresolved path has no next hop and no flags', JSON.stringify(open));
const mw = mesh('m-weak').nodes[0].peers[0];
check(mw.signal === -82 && mw.signal_avg === -82 && mw.tx_failed === 600 && mw.tx_packets === 1000, 'weak signal and failed transmissions parsed', JSON.stringify(mw));
check(mesh('m-fwdoff').nodes[0].params.mesh_fwding === '0', 'forwarding off from the parameters');
check(mesh('m-nopeer').nodes[0].peers.length === 0 && mesh('m-nopeer').nodes[0].up === true, 'no peers, interface still up');
const md = mesh('m-down').nodes[0];
check(md.up === false && md.ifname == null && md.peers === undefined && md.mesh_id === expect.mesh.id, 'a mesh section without a running interface has no live data', JSON.stringify(md));
check(mesh('m-nomesh').nodes.length === 0, 'no mesh configured: empty list');
for (const n of ['base', 'm-twopeers', 'm-weak', 'm-fwdoff', 'm-nopeer', 'm-down']) {
  const text = JSON.stringify(mesh(n));
  check(!text.includes(expect.canary) && !/"(key|sae_password|r0kh|r1kh)"/.test(text), `${n}: no key in the mesh output`);
}

console.log('== wireguard ==');
const wb = wg('base');
const wi = wb.interfaces[0];
const wpeer = (d, key = expect.wg.site) => d.interfaces[0].peers.find(p => p.public_key === key);
check(wb.interfaces.length === 1 && wi.name === expect.wg.name && wi.up === true && wi.enabled === true && wi.configured === true, 'the WireGuard interface found from the configuration');
check(/^[A-Za-z0-9+/]{43}=$/.test(wi.public_key) && wi.listen_port > 0 && wi.mtu > 0 && wi.addresses.length >= 1 && typeof wi.rx_bytes === 'number', 'public key, listen port, MTU, addresses and counters', JSON.stringify([wi.public_key, wi.listen_port, wi.mtu, wi.addresses]));
check(typeof wi.zone === 'string' && wi.zone.length > 0, 'firewall zone of the interface', String(wi.zone));
check(same(wi.peers.map(p => p.public_key), expect.wg.peers.map(p => p.key)) && wi.peers.map(p => p.name).join() === expect.wg.peers.map(p => p.name).join(), 'peers in configuration order with their descriptions', JSON.stringify(wi.peers.map(p => p.name)));
const site = wpeer(wb);
check(site.state === 'connected' && site.handshake_age >= 0 && site.handshake_age < 180 && site.endpoint && site.allowed_ips.length >= 1 && site.route_allowed_ips === true && site.keepalive > 0 && site.configured === true && typeof site.rx_bytes === 'number' && typeof site.tx_bytes === 'number', 'a connected peer: recent handshake, endpoint, allowed IPs, routes, keepalive, traffic', JSON.stringify(site));
check(wi.peers.filter(p => p !== site).every(p => ['never', 'connected', 'stale'].includes(p.state) && (p.state !== 'never' || (p.handshake_age === null && p.endpoint === null))), 'the other peers are connected, stale or never connected without an endpoint');
for (const n of ['base', 'w-stale', 'w-down', 'w-newpeer', 'w-noroutes', 'w-nozone']) {
  const text = JSON.stringify(wg(n));
  check(!text.includes(expect.canary) && !/"(private_key|preshared_key|key)"/.test(text), `${n}: no private or pre-shared key in the WireGuard output`);
}
const stale = wpeer(wg('w-stale'));
check(stale.state === 'stale' && stale.handshake_age > 900 && stale.handshake_age < 1200, 'a handshake older than 3 minutes is stale', JSON.stringify(stale));
const wdown = wg('w-down').interfaces[0];
check(wdown.up === false && wdown.public_key === undefined && wdown.peers.length === expect.wg.peers.length && wdown.peers.every(p => p.state === 'down' && p.configured), 'a configured interface that is not running lists its peers as not loaded', JSON.stringify(wdown));
const added = wpeer(wg('w-newpeer'), expect.wg.newKey);
check(added && added.configured === false && added.name == null && added.endpoint === '203.0.113.7:51820' && added.allowed_ips.join() === '10.99.0.2/32' && added.state === 'connected' && added.tx_bytes === 2000 && added.keepalive === null, 'a peer the kernel has but the configuration does not is still listed', JSON.stringify(added));
check(wg('w-newpeer').interfaces[0].peers.at(-1).public_key === expect.wg.newKey, 'run-time peers come after the configured ones');
check(wpeer(wg('w-noroutes')).route_allowed_ips === false, 'route_allowed_ips off is reported');
check(wg('w-nozone').interfaces[0].zone === null, 'an interface in no firewall zone has zone null');
check(wg('w-nowg').interfaces.length === 0, 'no WireGuard configured or running: empty list');

console.log('== firewall ==');
const fb = fwr('base');
const zone = (d, n) => d.zones.find(z => z.name === n);
const frule = (d, n) => d.rules.find(r => r.name === n || r.key === n);
check(fb.engine === 'nftables' && fb.running === true && fb.hooks.input === 'drop' && fb.hooks.forward === 'drop' && fb.hooks.output === 'accept', 'nftables loaded, with its base chain policies', JSON.stringify(fb.hooks));
check(same(fb.zones.map(z => z.name), expect.fw.zones) && fb.zones.every(z => z.enabled && ['input', 'output', 'forward'].every(k => /^(ACCEPT|REJECT|DROP)$/.test(z[k])) && Array.isArray(z.networks) && Array.isArray(z.forwards)), 'every configured zone with its policies', JSON.stringify(fb.zones.map(z => z.name)));
check(fb.zones.filter(z => z.networks.length).every(z => z.devices.length > 0), 'the kernel devices behind each zone are read from the loaded rules', JSON.stringify(fb.zones.map(z => [z.name, z.devices])));
check(zone(fb, expect.fw.wan).masq === true && zone(fb, expect.fw.wan).blocked_from?.packets > 0 && /^(reject|drop)$/.test(zone(fb, expect.fw.wan).blocked_from.action), 'the NAT zone counts the packets it turned away', JSON.stringify(zone(fb, expect.fw.wan).blocked_from));
check(fb.zones.filter(z => z.input === 'ACCEPT').every(z => z.blocked_from === null), 'a zone that accepts input has no reject counter');
check(fb.rules.length === expect.fw.rules && same(fb.rules.map(r => r.name), expect.fw.ruleNames), 'every traffic rule, in configuration order', JSON.stringify(fb.rules.map(r => r.name)));
check(fb.rules.every(r => r.enabled && r.hits && r.hits.packets >= 0 && r.hits.bytes >= 0), 'live hit counters matched to every rule by its nft comment');
check(frule(fb, 'Allow-WireGuard').dest_port.join() === '51820' && frule(fb, 'Allow-WireGuard').proto.join() === 'udp' && frule(fb, 'Allow-WireGuard').target === 'ACCEPT' && frule(fb, 'Allow-WireGuard').dest == null, 'a rule keeps its match fields; no destination means the router itself', JSON.stringify(frule(fb, 'Allow-WireGuard')));
check(frule(fb, 'Allow-ICMPv6-Forward').dest === '*' && frule(fb, 'Allow-IPSec-IKE-UDP-500-4500').dest_port.join() === '500,4500', 'dest "*" and multi-value options');
check(fb.defaults.input && typeof fb.defaults.synflood_protect === 'boolean' && typeof fb.defaults.flow_offloading === 'boolean', 'firewall defaults');
check((!fb.defaults.flow_offloading) || (Array.isArray(fb.flowtable?.devices) && fb.flowtable.devices.length > 0), 'the flow-offload devices are read from the loaded flowtable', JSON.stringify(fb.flowtable));
check(fb.conntrack.count > 0 && fb.conntrack.max >= fb.conntrack.count, 'connection tracking usage', JSON.stringify(fb.conntrack));
check(Array.isArray(fb.unzoned) && fb.unzoned.length === 0 && fb.redirects.length === 0 && fb.nft.rules > 10 && fb.nft.chains > 10, 'no unzoned interface, no port forwards, ruleset size', JSON.stringify([fb.unzoned, fb.redirects.length, fb.nft]));

const fstop = fwr('f-stopped');
check(fstop.running === false && fstop.engine === 'none' && fstop.hooks === null && fstop.rules.length === fb.rules.length && fstop.rules.every(r => r.hits === null) && fstop.zones.every(z => z.devices.length === 0 && z.blocked_from === null), 'with no nftables the configuration is still reported, without live data');
const fred = fwr('f-redirect');
const web = fred.redirects.find(r => r.name === 'Web');
check(fred.redirects.length === 1 && web.kind === 'redirect' && web.target === 'DNAT' && web.src === 'wan' && web.dest === 'lan' && web.proto.join() === 'tcp' && web.src_dport.join() === '8080' && web.dest_ip === '192.168.1.10' && web.dest_port.join() === '80' && web.enabled === true, 'a port forward with its match fields', JSON.stringify(web));
check(web.hits.packets === 7 && web.hits.bytes === 700, 'its hit counter is read from the nat chain', JSON.stringify(web.hits));
const fexp = fwr('f-exposed');
check(zone(fexp, expect.fw.wan).input === 'ACCEPT' && frule(fexp, 'Open-All').src === expect.fw.wan && frule(fexp, 'Open-All').proto.length === 0 && frule(fexp, 'Open-All').hits === null, 'zone input and a rule with no restrictions are reported as configured (the rule is not in the loaded ruleset)', JSON.stringify(frule(fexp, 'Open-All')));
const fdis = fwr('f-disabled');
check(frule(fdis, 'Allow-Ping').enabled === false && frule(fdis, 'Allow-Ping').hits === null && frule(fdis, 'Allow-WireGuard').hits !== null, 'a disabled rule has no counters, the others keep theirs');
const fanon = fwr('f-anonymous');
const anon = fanon.rules.at(-1);
check(anon.name === null && anon.key === `@rule[${expect.fw.rules}]` && anon.hits?.packets === 3 && anon.hits.bytes === 300, 'an unnamed rule is matched through the @rule[N] comment', JSON.stringify(anon));
check(same(fwr('f-unzoned').unzoned, ['lan100']), 'an interface in no zone is listed', JSON.stringify(fwr('f-unzoned').unzoned));
check(fwr('f-conntrack').conntrack.count === 60000, 'connection tracking follows the kernel counter');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall Network / Wi-Fi radio backend checks passed');
