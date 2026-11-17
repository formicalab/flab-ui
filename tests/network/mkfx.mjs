// Builds the fixture directories for the network-related scenarios (ports, bridges, Wi-Fi radios, mesh,
// WireGuard, firewall and logs) from the output captured on the router. Usage: node mkfx.mjs <work dir containing fx-real/>
// Writes <work>/<scenario>/ with one file per command, ubus call, UCI config and kernel file that
// flab.network, flab.radio, flab.mesh, flab.wireguard, flab.firewall and flab.logs read (see FLAB_FIXTURES in
// rpcd/lib/flab/util.uc), plus <work>/expect.json with the facts the assertions compare against.
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const real = path.join(work, 'fx-real');
// The contents of captured file `f`, without carriage returns.
const text = f => fs.readFileSync(path.join(real, f), 'utf8').replace(/\r/g, '');
// A deep copy of `o`, so a scenario can change it without touching the shared fixture.
const clone = o => JSON.parse(JSON.stringify(o));

// Planted in every wifi-iface so the assertions can prove no secret is ever forwarded.
const CANARY = 'CANARYSECRET';

//#region Parse the capture
// The capture is what the plugins recorded themselves (FLAB_RECORD): <command>.txt, <object>_<method>.json,
// uci_<config>.json, files.json (path -> contents). Keys and passwords were blanked while recording.
const raw = {};
for (const f of fs.readdirSync(real)) if (!['files.json', 'uci_wireless.json'].includes(f) && !f.startsWith('brforward_')) raw[f] = text(f);

// Planted where the real router keeps WireGuard secrets, so the assertions prove they are never forwarded.
// The capture itself must already have them blanked by the recorder.
const uciNet = JSON.parse(raw['uci_network.json']);
for (const s of Object.values(uciNet.values)) {
  if (s.private_key !== undefined && s.private_key !== 'REDACTED') throw new Error('the capture contains a WireGuard private key: the recorder does not scrub it');
  if (s.preshared_key !== undefined && s.preshared_key !== 'REDACTED') throw new Error('the capture contains a WireGuard pre-shared key: the recorder does not scrub it');
  if (s['.type'] === 'interface' && s.proto === 'wireguard') s.private_key = CANARY;
  if (s['.type'].startsWith('wireguard_')) s.preshared_key = CANARY;
}
raw['uci_network.json'] = JSON.stringify(uciNet);

// WireGuard facts from the capture.
const wgIf = Object.values(uciNet.values).find(s => s['.type'] === 'interface' && s.proto === 'wireguard')?.['.name'];
if (!wgIf) throw new Error('the router has no WireGuard interface to test with');
const wgPeers = Object.values(uciNet.values).filter(s => s['.type'] === `wireguard_${wgIf}`);
if (wgPeers.length < 2) throw new Error('the router needs at least two WireGuard peers to test with');
const wgSite = wgPeers.find(p => p.route_allowed_ips === '1') ?? wgPeers[0];
// The name of the captured `wg show` output file for field `f` (e.g. latest_handshakes) of the WireGuard interface.
const wgFile = f => `wg_show_${wgIf}_${f}.txt`;
// Every replay uses this same instant, even when generating and running all scenarios takes several minutes.
const CLOCK = Math.floor(Date.now() / 1000);
const nowS = () => CLOCK;
const NEWKEY = `${'B'.repeat(43)}=`;

// Rewrites (or adds) the "key<TAB>value" line of a `wg show <if> <field>` capture.
function wgSet(fx, field, key, value) {
  const lines = (fx.raw[wgFile(field)] ?? '').split('\n').filter(l => l && !l.startsWith(`${key}\t`));
  fx.raw[wgFile(field)] = [...lines, `${key}\t${value}`].join('\n') + '\n';
}
// A capture's handshake times go stale while the test runs, so the connected peer is pinned to "30 s ago".
const wgNormalize = fx => wgSet(fx, 'latest_handshakes', wgSite.public_key, nowS() - 30);
// Applies `fn` to the values of the UCI dump `file` in fixture `fx`.
const editUci = (fx, file, fn) => { const o = JSON.parse(fx.raw[file]); fn(o.values); fx.raw[file] = JSON.stringify(o); };

// Firewall facts from the capture. `nft -j list ruleset` is saved as nft_j_list_ruleset.txt.
const nftFile = 'nft_j_list_ruleset.txt';
const uciFw = JSON.parse(raw['uci_firewall.json']).values;
const fwZones = Object.values(uciFw).filter(s => s['.type'] === 'zone');
const fwWan = fwZones.find(z => z.masq === '1')?.name;
if (!fwWan) throw new Error('the router has no masquerading (WAN) firewall zone to test with');
const fwRuleCount = Object.values(uciFw).filter(s => s['.type'] === 'rule').length;
// Logs: `logread -l 500` and `dmesg -r` are saved under these names (see FLAB_RECORD in rpcd/lib/flab/util.uc).
const sysLog = 'logread_l_500.txt';
const kernLog = 'dmesg_r.txt';

// The tail of a real log is whatever the router did last (a busy ssh session fills it with a single program), so
// the first captured system log lines are replaced by entries of several programs, one an error and one a warning,
// which keeps the filters testable whatever the router was doing. The number of lines stays the same.
{
  const lines = raw[sysLog].split('\n');
  const synthetic = [
    'Wed Nov 11 00:00:01 2026 daemon.info flab-test[1]: an entry from another program',
    'Wed Nov 11 00:00:02 2026 daemon.err flab-test[1]: an error from another program',
    'Wed Nov 11 00:00:03 2026 daemon.warn flab-test[2]: a warning from another program',
    'Wed Nov 11 00:00:04 2026 auth.info dropbear[3]: a login handled by dropbear',
  ];
  lines.splice(0, synthetic.length, ...synthetic);
  raw[sysLog] = lines.join('\n');
}

// Adds a counting rule with an fw4 comment to a chain of the captured ruleset.
function nftAdd(fx, chain, comment, packets, bytes) {
  const doc = JSON.parse(fx.raw[nftFile]);
  doc.nftables.push({ rule: { family: 'inet', table: 'fw4', chain, handle: 9000 + doc.nftables.length, comment, expr: [{ counter: { packets, bytes } }, { accept: null }] } });
  fx.raw[nftFile] = JSON.stringify(doc);
}

const files = JSON.parse(text('files.json'));
const uci = JSON.parse(text('uci_wireless.json')).values;
for (const s of Object.values(uci)) if (s['.type'] === 'wifi-iface') { s.key = CANARY; s.r0kh = [CANARY]; s.r1kh = [CANARY]; }
const devices = JSON.parse(raw['network_device_status.json']);
const bridgeNames = Object.keys(devices).filter(n => devices[n].devtype === 'bridge');
if (!bridgeNames.length) throw new Error('no bridge captured');
const ifaces = Object.keys(files).map(p => p.match(/^\/sys\/class\/net\/([^/]+)\/phy80211\/name$/)?.[1]).filter(Boolean).sort();
//#endregion

//#region Synthetic bridge forwarding table
// The kernel table is binary, so it is generated: 16 bytes per entry (MAC, port, is_local, aging, port high byte).
const LEARNED = { lan1: 3, lan2: 1, 'phy0-ap0': 11, 'phy0-mesh0': 1, 'phy1-ap0': 5 };
const LOCAL = 2;

// The binary `brforward` file of one bridge: for each member port, LEARNED[port] remote entries plus LOCAL
// local ones (the bridge's own addresses), as the kernel would list them.
function brforward(fx, bridge) {
  const entries = [];
  // Appends n entries on `port`; `local` marks the bridge's own MAC addresses.
  const add = (port, local, n) => {
    for (let k = 0; k < n; k++) {
      const e = Buffer.alloc(16);
      e[0] = 0x02; e[5] = entries.length + 1;
      e[6] = port & 0xff; e[7] = local ? 1 : 0; e[12] = port >> 8;
      entries.push(e);
    }
  };
  for (const m of fx.devices[bridge]?.['bridge-members'] ?? []) {
    const port = parseInt(fx.files[`/sys/class/net/${m}/brport/port_no`] ?? '0', 16);
    add(port, false, fx.learned[m] ?? 0);
    add(port, true, LOCAL);
  }
  return Buffer.concat(entries);
}
//#endregion

//#region Scenarios
// A fresh copy of the captured state that a scenario edits: command output (raw), kernel files, netifd devices,
// the wireless UCI and the learned-MAC counts. The connected WireGuard peer's handshake is pinned to "now".
const baseFx = () => {
  const fx = { raw: clone(raw), files: clone(files), devices: clone(devices), uci: clone(uci), learned: clone(LEARNED) };
  wgNormalize(fx);
  return fx;
};
const member = 'phy1-ap0';
const bridge = bridgeNames[0];
const meshSection = Object.values(uci).find(s => s['.type'] === 'wifi-iface' && s.mode === 'mesh')?.['.name'];
if (!meshSection) throw new Error('the router has no 802.11s mesh interface to test with');
// The path of sysfs file `f` of network device `dev`.
const sys = (dev, f) => `/sys/class/net/${dev}/${f}`;
// The wifi-iface section of `radio` in fixture `fx`.
const radioIf = (fx, radio) => Object.values(fx.uci).find(s => s['.type'] === 'wifi-iface' && s.device === radio);
// The parsed wireless status of fixture `fx`.
const wireless = fx => JSON.parse(fx.raw['network_wireless_status.json']);
// Stores `w` as the wireless status of fixture `fx`.
const setWireless = (fx, w) => { fx.raw['network_wireless_status.json'] = JSON.stringify(w); };

// The calls the cable-test harness makes against the n-cable scenario ({ id, args }); assert.mjs checks the result of each by its id.
const CABLE_CASES = [
  { id: 'lan1', args: { port: 'lan1' } }, { id: 'lan2', args: { port: 'lan2' } }, { id: 'lan3', args: { port: 'lan3' } },
  { id: 'lan4', args: { port: 'lan4' } }, { id: 'lan5', args: { port: 'lan5' } }, { id: 'lan4-again', args: { port: 'lan4' } },
  { id: 'conduit', args: { port: 'eth0' } }, { id: 'bridge', args: { port: 'br-lan' } }, { id: 'unknown', args: { port: 'nosuch' } },
  { id: 'injection', args: { port: 'lan1; reboot' } }, { id: 'newline', args: { port: 'lan1\nid' } }, { id: 'number', args: { port: 5 } }, { id: 'none', args: {} },
];

const scenarios = {
  base: fx => fx,

  // ── Network ──
  'n-linkdown': fx => {
    fx.devices.lan1.carrier = false; delete fx.devices.lan1.speed;
    fx.devices.lan1['link-partner-advertising'] = [];
    fx.files[sys('lan1', 'carrier')] = '0'; fx.files[sys('lan1', 'operstate')] = 'down';
    fx.files[sys('lan1', 'brport/state')] = '0';
    return fx;
  },
  'n-downshift': fx => { fx.devices.lan2.speed = '100F'; return fx; },
  'n-root': fx => {
    fx.files[sys(bridge, 'bridge/root_id')] = fx.files[sys(bridge, 'bridge/bridge_id')];
    fx.files[sys(bridge, 'bridge/root_port')] = '0';
    for (const m of fx.devices[bridge]['bridge-members']) fx.files[sys(m, 'brport/designated_bridge')] = fx.files[sys(bridge, 'bridge/bridge_id')];
    return fx;
  },
  'n-blocked': fx => {
    fx.files[sys(member, 'brport/state')] = '4';
    fx.files[sys(bridge, 'bridge/topology_change')] = '1';
    return fx;
  },
  'n-nostp': fx => { fx.files[sys(bridge, 'bridge/stp_state')] = '0'; return fx; },
  'n-vlanfilter': fx => { fx.files[sys(bridge, 'bridge/vlan_filtering')] = '1'; fx.files[sys(bridge, 'bridge/default_pvid')] = '1'; return fx; },
  // lan5 moves into a second bridge, which must be discovered without any hard-coded name.
  'n-newbridge': fx => {
    const second = 'br-guest';
    fx.devices[second] = clone(fx.devices[bridge]);
    fx.devices[second]['bridge-members'] = ['lan5'];
    fx.devices[bridge]['bridge-members'] = fx.devices[bridge]['bridge-members'].filter(m => m !== 'lan5');
    for (const [p, v] of Object.entries(fx.files)) if (p.startsWith(sys(bridge, 'bridge/'))) fx.files[p.replace(`/${bridge}/`, `/${second}/`)] = v;
    fx.files[sys(second, 'bridge/bridge_id')] = '7000.9483c4a215c9';
    fx.files[sys(second, 'bridge/root_id')] = '7000.9483c4a215c9';
    fx.files[sys(second, 'bridge/root_port')] = '0';
    return fx;
  },
  // A port number above 255 exercises the high byte of the forwarding-table entry.
  'n-highport': fx => { fx.files[sys('lan5', 'brport/port_no')] = '0x102'; fx.learned.lan5 = 4; return fx; },
  'n-nodevices': fx => { fx.devices = {}; return fx; },
  // A different router: four LAN ports in reverse board order, no external PHY, another model name.
  'n-board': fx => {
    delete fx.devices.lan5;
    fx.devices[bridge]['bridge-members'] = fx.devices[bridge]['bridge-members'].filter(m => m !== 'lan5');
    for (const k of Object.keys(fx.files)) if (k.endsWith('/phy-handle')) delete fx.files[k];
    fx.files['/etc/board.json'] = JSON.stringify({ model: { id: 'other,router', name: 'Other Router' }, network: { lan: { ports: ['lan4', 'lan3', 'lan2', 'lan1'], protocol: 'static' }, wan: { device: 'eth1', protocol: 'dhcp' } } });
    return fx;
  },
  // A router without a DSA switch: only the two SoC MACs remain.
  'n-nodsa': fx => {
    for (const n of Object.keys(fx.devices)) if (fx.devices[n].devtype === 'dsa') delete fx.devices[n];
    fx.devices[bridge]['bridge-members'] = fx.devices[bridge]['bridge-members'].filter(m => !/^lan\d$/.test(m));
    return fx;
  },
  // A small router like the AVM FRITZ!Repeater 3000: no ethtool installed, so the driver comes from the device's
  // driver link, and the SoC MAC (the switch's CPU conduit) has no device-tree node on its netdev, only on its parent.
  'n-noethtool': fx => {
    for (const k of Object.keys(fx.raw)) if (k.startsWith('ethtool_') && !k.startsWith('ethtool_S_')) delete fx.raw[k];
    for (const [n, d] of Object.entries(fx.devices)) if (d.devtype === 'dsa' || /^eth\d$/.test(n)) fx.raw[`readlink_sys_class_net_${n}_device_driver.txt`] = `../../../bus/platform/drivers/test-${d.devtype === 'dsa' ? 'switch' : 'mac'}\n`;
    const uevent = sys('eth0', 'uevent');
    const node = fx.files[uevent]?.match(/OF_FULLNAME=[^\n]+/)?.[0];
    if (!node) throw new Error('eth0 has no device-tree node in the capture');
    fx.files[uevent] = fx.files[uevent].replace(/OF_FULLNAME=[^\n]+\n?/, '');
    fx.files[sys('eth0', 'device/uevent')] = `${node}\n`;
    return fx;
  },
  // lan2 starts logging CRC errors: kernel counter, driver counter and two log lines.
  'n-errors': fx => {
    fx.devices.lan2.statistics.rx_crc_errors = 5; fx.devices.lan2.statistics.rx_errors = 5;
    fx.raw['ethtool_S_lan2.txt'] = 'NIC statistics:\n     tx_packets: 100\n     rx_crc_errors: 5\n     rx_pp_alloc_slow: 9\n';
    fx.raw['logread_e_lan2_.txt'] = 'Wed Nov 11 09:00:01 2026 kern.info kernel: [1] mtk_soc_eth: lan2: Link is Down\nWed Nov 11 09:00:05 2026 kern.info kernel: [2] mtk_soc_eth: lan2: Link is Up - 1Gbps/Full\n';
    return fx;
  },

  // eth1 becomes an optical cage with a module that reports alarms, lan3 an empty cage and lan4 a direct-attach cable (no diagnostics).
  'n-sfp': fx => {
    // Makes the captured `ethtool <port>` output say the port is of type `type` (the value of "Supported ports" and "Port").
    const asCage = (port, type, media) => {
      const k = `ethtool_${port}.txt`;
      fx.raw[k] = fx.raw[k].replace(/Supported ports: \[[^\]]*\]/, `Supported ports: [ ${type} ]`).replace(/Port: .*/, `Port: ${media}`);
    };
    asCage('eth1', 'FIBRE', 'FIBRE'); asCage('lan3', 'FIBRE', 'FIBRE'); asCage('lan4', 'FIBRE', 'Direct Attach');
    fx.raw['ethtool_m_eth1.txt'] = [
      '\tIdentifier                                : 0x03 (SFP)',
      '\tExtended identifier                       : 0x04 (GBIC/SFP defined by 2-wire interface ID)',
      '\tConnector                                 : 0x07 (LC)',
      '\tTransceiver type                          : Ethernet: 1000BASE-LX',
      '\tTransceiver type                          : FC: intermediate distance (I)',
      '\tLaser wavelength                          : 1310nm',
      '\tVendor name                               : FS',
      '\tVendor PN                                 : SFP-GE-LX',
      '\tVendor rev                                : A',
      '\tVendor SN                                 : G2010001234',
      '\tDate code                                 : 200101',
      '\tOptical diagnostics support               : Yes',
      '\tLaser bias current                        : 18.502 mA',
      '\tLaser output power                        : 0.5000 mW / -3.01 dBm',
      '\tReceiver signal average optical power     : 0.0010 mW / -30.00 dBm',
      '\tModule temperature                        : 41.50 degrees C / 106.70 degrees F',
      '\tModule voltage                            : 3.2958 V',
      '\tAlarm/warning flags implemented           : Yes',
      '\tLaser bias current high alarm             : Off',
      '\tLaser rx power low alarm                  : On',
      '\tLaser rx power low warning                : On',
      '\tModule temperature high warning           : Off',
      '',
    ].join('\n');
    fx.raw['ethtool_m_lan4.txt'] = [
      '\tIdentifier                                : 0x03 (SFP)',
      '\tConnector                                 : 0x21 (Copper pigtail)',
      '\tVendor name                               : DAC-Maker',
      '\tVendor PN                                 : DAC-10G-1M',
      '\tOptical diagnostics support               : No',
      '',
    ].join('\n');
    return fx;
  },
  // The kernel's VLAN table of the bridge (`bridge vlan show`): lan1 carries VLAN 20 tagged, lan2 has VLAN 1 as PVID and 20 untagged.
  'n-vlantable': fx => {
    fx.files[sys(bridge, 'bridge/vlan_filtering')] = '1';
    fx.raw['bridge_vlan_show.txt'] = [
      'port              vlan-id',
      'lan1              1 PVID Egress Untagged',
      '                  20',
      'lan2              1 PVID Egress Untagged',
      '                  20 Egress Untagged',
      'lan5              30',
      'eth9              1 PVID Egress Untagged',
      `${bridge}            1 PVID Egress Untagged`,
      '',
    ].join('\n');
    return fx;
  },
  // No `bridge` tool: the table comes from the bridge-vlan sections of the network config.
  'n-vlanconfig': fx => {
    fx.files[sys(bridge, 'bridge/vlan_filtering')] = '1';
    editUci(fx, 'uci_network.json', v => {
      v.bv10 = { '.type': 'bridge-vlan', '.name': 'bv10', '.anonymous': true, device: bridge, vlan: '10', ports: ['lan1:t', 'lan2:u*', 'lan3:u'] };
      v.bv20 = { '.type': 'bridge-vlan', '.name': 'bv20', '.anonymous': true, device: bridge, vlan: '20', ports: ['lan1:t'] };
      v.bvother = { '.type': 'bridge-vlan', '.name': 'bvother', '.anonymous': true, device: 'br-other', vlan: '99', ports: ['lan4:u'] };
    });
    return fx;
  },
  // An older board: the switch ports are not network devices but are driven through swconfig. eth0 is the CPU port's netdev and carries
  // VLAN devices eth0.1 (LAN, bridged) and eth0.2 (WAN).
  'n-swconfig': fx => {
    for (const n of Object.keys(fx.devices)) if (fx.devices[n].devtype === 'dsa') delete fx.devices[n];
    // A VLAN device on eth0 with VLAN id `vid`, a member of the bridge when `bridged`.
    const vlanDev = (vid, bridged) => ({ devtype: 'vlan', parent: 'eth0', vid, present: true, up: true, carrier: true, macaddr: '94:83:c4:a2:15:c4', statistics: { rx_bytes: 100, tx_bytes: 100 }, ...(bridged ? { bridge: bridge } : {}) });
    fx.devices['eth0.1'] = vlanDev(1, true);
    fx.devices['eth0.2'] = vlanDev(2, false);
    fx.devices[bridge]['bridge-members'] = ['eth0.1'];
    fx.files['/etc/board.json'] = JSON.stringify({
      model: { id: 'old,router', name: 'Old Router' },
      network: { lan: { device: 'br-lan', protocol: 'static' }, wan: { device: 'eth0.2', protocol: 'dhcp' } },
      switch: { switch0: { enable: true, reset: true, ports: [
        { num: 0, device: 'eth0', need_tag: false, want_untag: false },
        { num: 1, role: 'wan', index: 0 }, { num: 2, role: 'lan', index: 0 }, { num: 3, role: 'lan', index: 1 }, { num: 4, role: 'lan', index: 2 }, { num: 5, role: 'lan', index: 3 },
      ], roles: [{ role: 'lan', ports: '2 3 4 5', device: 'eth0.1' }, { role: 'wan', ports: '1', device: 'eth0.2' }] } },
    });
    fx.raw['swconfig_list.txt'] = 'Found: switch0 - ag71xx-mdio.1\n';
    fx.raw['swconfig_dev_switch0_help.txt'] = 'switch0: ar8327(ag71xx-mdio.1), ports: 6 (cpu @ 0), vlans: 128\n     --switch\n     Attribute 1 (int): enable_vlan (Enable VLAN mode)\n';
    fx.raw['swconfig_dev_switch0_show.txt'] = [
      'Global attributes:', '\tenable_vlan: 1', '\tarl_aging: 1',
      'Port 0:', '\tpvid: 1', '\tlink: port:0 link:up speed:1000baseT full-duplex txflow rxflow',
      'Port 1:', '\tpvid: 2', '\tlink: port:1 link:up speed:1000baseT full-duplex',
      'Port 2:', '\tpvid: 1', '\tlink: port:2 link:up speed:100baseT half-duplex',
      'Port 3:', '\tpvid: 1', '\tlink: port:3 link:down',
      'Port 4:', '\tpvid: 1', '\tlink: port:4 link:down',
      'Port 5:', '\tpvid: 1', '\tlink: port:5 link:down',
      'VLAN 1:', '\tvlan: 1', '\tvid: 1', '\tports: 0t 2 3 4 5',
      'VLAN 2:', '\tvlan: 2', '\tvid: 2', '\tports: 0t 1',
      '',
    ].join('\n');
    return fx;
  },
  // The commands of the cable-test calls (run by cable-harness.uc, see CABLE_CASES): lan1 intact, lan2 pairs C and D open, lan3 a short
  // 12.5 m away, lan4 a PHY that cannot test, lan5 output that is not a result. The ports that must be refused have an intact result
  // as well, so a refused call that ran anyway shows up as ok.
  'n-cable': fx => {
    // The fixture file of the cable-test command of port `p`.
    const file = p => `timeout_30_ethtool_cable_test_${p}_2_1.txt`;
    // The output of a finished cable test of port `p` with the given result lines.
    const done = (p, lines) => `Cable test started for device ${p}.\nCable test completed for device ${p}.\n${lines.join('\n')}\n`;
    // The output for a port whose four pairs are intact.
    const intact = p => done(p, ['A', 'B', 'C', 'D'].map(x => `Pair ${x} code OK`));
    fx.raw[file('lan1')] = intact('lan1');
    fx.raw[file('lan2')] = done('lan2', ['Pair A code OK', 'Pair B code OK', 'Pair C code Open Circuit', 'Pair D code Open Circuit']);
    fx.raw[file('lan3')] = done('lan3', ['Pair A code OK', 'Pair B code Short within Pair', 'Pair B, fault length: 12.50m', 'Pair C code OK', 'Pair D code OK']);
    fx.raw[file('lan4')] = 'netlink error: PHY driver does not support cable testing\nnetlink error: Not supported\n';
    fx.raw[file('lan5')] = 'something odd happened\n';
    for (const p of ['eth0', 'br-lan', 'nosuch']) fx.raw[file(p)] = intact(p);
    fx.raw['cable-cases.json'] = JSON.stringify(CABLE_CASES);
    return fx;
  },

  // ── Wi-Fi radios ──
  'r-down': fx => {
    const w = wireless(fx);
    w.radio1 = { up: false, pending: false, retry_setup_failed: false, disabled: false, autostart: true, interfaces: [] };
    setWireless(fx, w);
    return fx;
  },
  'r-dfs': fx => { const k = 'hostapd_phy1_ap0_get_status.json'; fx.raw[k] = JSON.stringify({ ...JSON.parse(fx.raw[k]), status: 'DFS' }); return fx; },
  'r-channel': fx => {
    fx.raw['iw_dev_phy0_ap0_info.txt'] = fx.raw['iw_dev_phy0_ap0_info.txt'].replace(/channel 6 \(2437 MHz\), width: 40 MHz, center1: 2447 MHz/, 'channel 11 (2462 MHz), width: 20 MHz');
    fx.raw['iw_dev_phy0_ap0_survey_dump.txt'] = fx.raw['iw_dev_phy0_ap0_survey_dump.txt']
      .replace(/(frequency:\s+2437 MHz) \[in use\]/, '$1').replace(/(frequency:\s+2462 MHz)/, '$1 [in use]');
    return fx;
  },
  'r-disabled': fx => {
    fx.uci.radio1.disabled = '1';
    const w = wireless(fx);
    w.radio1 = { up: false, pending: false, retry_setup_failed: false, disabled: true, autostart: true, interfaces: [] };
    setWireless(fx, w);
    return fx;
  },
  'r-newssid': fx => {
    fx.uci.guest_2g = { '.type': 'wifi-iface', '.name': 'guest_2g', '.index': 99, device: 'radio0', mode: 'ap', ssid: 'guest', network: 'guest', encryption: 'none', key: CANARY };
    return fx;
  },
  // A radio on a PCIe card, whose UCI path has no `platform/` prefix while the phy's device path in sysfs does
  // (like the AVM FRITZ!Repeater 3000): the radio is down, so the phy can only be found from the path.
  'r-pci': fx => {
    const link = Object.keys(fx.raw).find(k => /readlink.*ieee80211.*phy1.*device.*\.txt$/.test(k));
    if (!link) throw new Error('no readlink fixture for phy1');
    fx.raw[link] = '/sys/devices/platform/soc/40000000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0\n';
    fx.uci.radio1.path = 'soc/40000000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0';
    const w = wireless(fx);
    w.radio1 = { up: false, pending: false, retry_setup_failed: false, disabled: false, autostart: true, interfaces: [] };
    setWireless(fx, w);
    return fx;
  },

  // ── Mesh ──
  // A second peer whose link is only LISTEN and which is a gate, a path through the first peer, and an unresolved path.
  'm-twopeers': fx => {
    const dump = fx.raw['iw_dev_phy0_mesh0_station_dump.txt'];
    const peer = dump.match(/^Station ([0-9a-f:]{17})/m)?.[1];
    if (!peer) throw new Error('no mesh peer captured');
    const second = dump.slice(dump.indexOf('Station '))
      .replace(/^Station [0-9a-f:]{17}/, 'Station aa:bb:cc:dd:ee:01')
      .replace(/(mesh plink:\s+)\S+/, '$1LISTEN').replace(/(mesh connected to gate:\s+)no/, '$1yes');
    fx.raw['iw_dev_phy0_mesh0_station_dump.txt'] = dump.trimEnd() + '\n' + second.trimEnd() + '\n';
    fx.raw['iw_dev_phy0_mesh0_mpath_dump.txt'] = fx.raw['iw_dev_phy0_mesh0_mpath_dump.txt'].trimEnd()
      + `\naa:bb:cc:dd:ee:01 ${peer} phy0-mesh0\t0\t222\t0\t1500\t0\t0\t0x15\t2\t1`
      + '\n5a:00:00:00:00:01 00:00:00:00:00:00 phy0-mesh0\t0\t0\t0\t0\t1600\t4\t0x0\t0\t0\n';
    return fx;
  },
  'm-weak': fx => {
    fx.raw['iw_dev_phy0_mesh0_station_dump.txt'] = fx.raw['iw_dev_phy0_mesh0_station_dump.txt']
      .replace(/(signal:\s+)-\d+/, '$1-82').replace(/(signal avg:\s+)-\d+/, '$1-82')
      .replace(/(tx failed:\s+)\d+/, '$1600').replace(/(tx packets:\s+)\d+/, '$11000');
    return fx;
  },
  'm-fwdoff': fx => { fx.raw['iw_dev_phy0_mesh0_get_mesh_param_mesh_fwding.txt'] = '0\n'; return fx; },
  'm-nopeer': fx => { fx.raw['iw_dev_phy0_mesh0_station_dump.txt'] = ''; return fx; },
  'm-down': fx => {
    const w = wireless(fx);
    for (const r of Object.values(w)) r.interfaces = r.interfaces.filter(i => i.section !== meshSection);
    setWireless(fx, w);
    return fx;
  },
  'm-nomesh': fx => { delete fx.uci[meshSection]; return fx; },

  // ── WireGuard ──
  // The connected peer has not shaken hands for a long time; a roaming peer connects now.
  'w-stale': fx => {
    wgSet(fx, 'latest_handshakes', wgSite.public_key, nowS() - 1000);
    return fx;
  },
  'w-down': fx => { fx.raw['wg_show_interfaces.txt'] = '\n'; return fx; },
  // A peer the kernel has but the configuration does not (added with `wg set`).
  'w-newpeer': fx => {
    fx.raw[wgFile('peers')] = `${fx.raw[wgFile('peers')].trimEnd()}\n${NEWKEY}\n`;
    wgSet(fx, 'endpoints', NEWKEY, '203.0.113.7:51820');
    wgSet(fx, 'allowed_ips', NEWKEY, '10.99.0.2/32');
    wgSet(fx, 'latest_handshakes', NEWKEY, nowS() - 5);
    wgSet(fx, 'transfer', NEWKEY, '1000\t2000');
    wgSet(fx, 'persistent_keepalive', NEWKEY, 'off');
    return fx;
  },
  'w-noroutes': fx => { editUci(fx, 'uci_network.json', v => { for (const s of Object.values(v)) if (s.public_key === wgSite.public_key) s.route_allowed_ips = '0'; }); return fx; },
  'w-nozone': fx => {
    editUci(fx, 'uci_firewall.json', v => { for (const s of Object.values(v)) if (s['.type'] === 'zone') s.network = [].concat(s.network ?? []).filter(n => n !== wgIf); });
    return fx;
  },
  'w-nowg': fx => {
    editUci(fx, 'uci_network.json', v => { for (const [k, s] of Object.entries(v)) if (k === wgIf || s['.type'] === `wireguard_${wgIf}`) delete v[k]; });
    fx.raw['wg_show_interfaces.txt'] = '\n';
    return fx;
  },

  // ── Firewall ──
  'f-stopped': fx => { fx.raw[nftFile] = ''; return fx; },
  // A port forward from the Internet: the UCI section plus the nft rule firewall4 would have loaded for it.
  'f-redirect': fx => {
    editUci(fx, 'uci_firewall.json', v => { v.cfgweb = { '.type': 'redirect', '.name': 'cfgweb', '.anonymous': true, '.index': 99, name: 'Web', src: 'wan', dest: 'lan', proto: ['tcp'], src_dport: '8080', dest_ip: '192.168.1.10', dest_port: '80', target: 'DNAT' }; });
    nftAdd(fx, 'dstnat', '!fw4: Web', 7, 700);
    return fx;
  },
  // The Internet-facing zone accepts everything to the router, and a rule opens all TCP/UDP ports from it.
  'f-exposed': fx => {
    editUci(fx, 'uci_firewall.json', v => {
      for (const s of Object.values(v)) if (s['.type'] === 'zone' && s.name === fwWan) s.input = 'ACCEPT';
      v.cfgall = { '.type': 'rule', '.name': 'cfgall', '.anonymous': true, '.index': 98, name: 'Open-All', src: fwWan, target: 'ACCEPT' };
    });
    return fx;
  },
  'f-disabled': fx => { editUci(fx, 'uci_firewall.json', v => { for (const s of Object.values(v)) if (s.name === 'Allow-Ping') s.enabled = '0'; }); return fx; },
  // An unnamed rule is commented `@rule[N]` by firewall4, N counting rule sections in configuration order.
  'f-anonymous': fx => {
    editUci(fx, 'uci_firewall.json', v => { v.cfganon = { '.type': 'rule', '.name': 'cfganon', '.anonymous': true, '.index': 97, src: fwWan, proto: ['tcp'], dest_port: '2222', target: 'ACCEPT' }; });
    nftAdd(fx, `input_${fwWan}`, `!fw4: @rule[${fwRuleCount}]`, 3, 300);
    return fx;
  },
  'f-unzoned': fx => {
    editUci(fx, 'uci_firewall.json', v => { for (const s of Object.values(v)) if (s['.type'] === 'zone' && s.name === 'lan') s.network = [].concat(s.network).filter(n => n !== 'lan100'); });
    return fx;
  },
  'f-conntrack': fx => { fx.files['/proc/sys/net/netfilter/nf_conntrack_count'] = '60000\n'; return fx; },

  // ── Logs ──
  // A secret in a daemon line and in a kernel line, an unparsable line, an unknown severity, a kernel line of
  // another facility and one without a priority prefix.
  'l-odd': fx => {
    fx.raw[sysLog] += `Wed Nov 11 12:00:00 2026 daemon.err pppd[99]: auth failed password=${CANARY} user=x\n`
      + 'this line has no syslog header and is kept whole\n'
      + 'Wed Nov 11 12:00:01 2026 daemon.bogus odd[1]: unknown severity\n';
    fx.raw[kernLog] += `<3>[ 9999999.000000] driver key: ${CANARY}\n<30>[ 9999999.500000] daemon-ish kernel line\nraw line without a prefix\n`;
    return fx;
  },
  'l-empty': fx => { fx.raw[sysLog] = ''; fx.raw[kernLog] = ''; return fx; },
  // The system log of 500 lines is longer than the output cap of one command: the plugin asks again for 60% of the complete lines
  // that fit and reports that number as the limit. The kernel log is cut too and is read again through `tail`.
  'l-big': fx => {
    const lines = fx.raw[sysLog].split('\n').filter(Boolean);
    const fewer = Math.max(1, Math.floor((lines.length - 1) * 0.6));
    fx.raw['logread_l_500.result.json'] = JSON.stringify({ code: 0, truncated: true });
    fx.raw[`logread_l_${fewer}.txt`] = lines.slice(-fewer).join('\n') + '\n';
    fx.raw['dmesg_r.result.json'] = JSON.stringify({ code: 0, truncated: true });
    fx.raw['dmesg_r_2_dev_null_tail_n_500.txt'] = fx.raw[kernLog].split('\n').filter(Boolean).slice(-500).join('\n') + '\n';
    return fx;
  },
};
//#endregion

//#region Write
function writeScenario(name, build) {
  const fx = build(baseFx());
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  // Writes `data` to `file` in this scenario's directory.
  const put = (file, data) => fs.writeFileSync(path.join(dir, file), data);
  for (const [file, data] of Object.entries(fx.raw)) put(file, data);
  put('clock.txt', `${CLOCK}\n`);
  put('files.json', JSON.stringify(fx.files));
  put('network_device_status.json', JSON.stringify(fx.devices));
  put('uci_wireless.json', JSON.stringify({ values: fx.uci }));
  for (const b of Object.keys(fx.devices).filter(n => fx.devices[n].devtype === 'bridge')) put(`brforward_${b}`, brforward(fx, b));
}

for (const [name, build] of Object.entries(scenarios)) writeScenario(name, build);
fs.writeFileSync(path.join(work, 'scenarios.json'), JSON.stringify(Object.keys(scenarios)));

const wl = wireless(baseFx());
const meshSec = uci[meshSection];
fs.writeFileSync(path.join(work, 'expect.json'), JSON.stringify({
  bridge,
  members: baseFx().devices[bridge]['bridge-members'],
  learned: LEARNED, local: LOCAL,
  ports: Object.keys(devices).filter(n => ['dsa', 'ethernet'].includes(devices[n].devtype)),
  radios: Object.keys(wl),
  maclist: Object.values(uci).flatMap(s => s.maclist ?? []),
  canary: CANARY,
  phyIfaces: ifaces,
  mesh: { section: meshSection, id: meshSec.mesh_id, ifname: wl[meshSec.device].interfaces.find(i => i.section === meshSection)?.ifname },
  wg: { name: wgIf, peers: wgPeers.map(p => ({ name: p.description, key: p.public_key })), site: wgSite.public_key, siteName: wgSite.description, newKey: NEWKEY },
  fw: { zones: fwZones.map(z => z.name), wan: fwWan, rules: fwRuleCount, ruleNames: Object.values(uciFw).filter(s => s['.type'] === 'rule').map(s => s.name) },
}));
console.log(`built ${Object.keys(scenarios).join(', ')}`);
//#endregion
