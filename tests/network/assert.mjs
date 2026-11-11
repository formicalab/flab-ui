// Checks the backend JSON produced for each Network / Wi-Fi radio scenario.
// Usage: node assert.mjs <dir with <scenario>.<plugin>.json files and expect.json>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const net = n => read(`${n}.flab.network.json`);
const rad = n => read(`${n}.flab.radio.json`);
const mesh = n => read(`${n}.flab.mesh.json`);
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

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall Network / Wi-Fi radio backend checks passed');
