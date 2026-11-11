// Builds the fixture directories for the network-related scenarios (ports, bridges, Wi-Fi radios, mesh,
// WireGuard, firewall and logs) from the output captured on the router. Usage: node mkfx.mjs <work dir containing fx-real/>
// Writes <work>/<scenario>/ with one file per command, ubus call, UCI config and kernel file that
// flab.network, flab.radio, flab.mesh, flab.wireguard, flab.firewall and flab.logs read (see FLAB_FIXTURES in
// rpcd/lib/flab/util.uc), plus <work>/expect.json with the facts the assertions compare against.
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
const real = path.join(work, 'fx-real');
const text = f => fs.readFileSync(path.join(real, f), 'utf8').replace(/\r/g, '');
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
const wgFile = f => `wg_show_${wgIf}_${f}.txt`;
const nowS = () => Math.floor(Date.now() / 1000);
const NEWKEY = `${'B'.repeat(43)}=`;

// Rewrites (or adds) the "key<TAB>value" line of a `wg show <if> <field>` capture.
function wgSet(fx, field, key, value) {
  const lines = (fx.raw[wgFile(field)] ?? '').split('\n').filter(l => l && !l.startsWith(`${key}\t`));
  fx.raw[wgFile(field)] = [...lines, `${key}\t${value}`].join('\n') + '\n';
}
// A capture's handshake times go stale while the test runs, so the connected peer is pinned to "30 s ago".
const wgNormalize = fx => wgSet(fx, 'latest_handshakes', wgSite.public_key, nowS() - 30);
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
// The kernel table is binary, so it is generated: 16 bytes per entry (MAC, port, is_local, ageing, port high byte).
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
const sys = (dev, f) => `/sys/class/net/${dev}/${f}`;
const radioIf = (fx, radio) => Object.values(fx.uci).find(s => s['.type'] === 'wifi-iface' && s.device === radio);
const wireless = fx => JSON.parse(fx.raw['network_wireless_status.json']);
const setWireless = (fx, w) => { fx.raw['network_wireless_status.json'] = JSON.stringify(w); };

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
  // lan2 starts logging CRC errors: kernel counter, driver counter and two log lines.
  'n-errors': fx => {
    fx.devices.lan2.statistics.rx_crc_errors = 5; fx.devices.lan2.statistics.rx_errors = 5;
    fx.raw['ethtool_S_lan2.txt'] = 'NIC statistics:\n     tx_packets: 100\n     rx_crc_errors: 5\n     rx_pp_alloc_slow: 9\n';
    fx.raw['logread_e_lan2_.txt'] = 'Wed Nov 11 09:00:01 2026 kern.info kernel: [1] mtk_soc_eth: lan2: Link is Down\nWed Nov 11 09:00:05 2026 kern.info kernel: [2] mtk_soc_eth: lan2: Link is Up - 1Gbps/Full\n';
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
};
//#endregion

//#region Write
function writeScenario(name, build) {
  const fx = build(baseFx());
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  const put = (file, data) => fs.writeFileSync(path.join(dir, file), data);
  for (const [file, data] of Object.entries(fx.raw)) put(file, data);
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
