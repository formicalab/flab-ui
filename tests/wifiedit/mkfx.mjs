// Builds the fixtures of the Wi-Fi editing backend test. Every scenario is a directory with the file names flab.radio reads when
// FLAB_FIXTURES is set (see rpcd/lib/flab/util.uc), so the plugin never runs a command: it only finds, in the fixture folder, what
// the command would have printed. Also writes cases.json for harness.uc.
// The `main` scenario is a router with three radios: radio0 (2.4 GHz, running, with an access point that carries every kind of
// secret, a mesh interface and an odd section), radio1 (5 GHz, switched off, so its modes come from the phy's capabilities, with a
// WPA-Enterprise access point in an unnamed section and a client network) and radio2 (6 GHz, whose phy is not found). The
// others differ in what hostapd can do (`nohostapd`: it is not installed) and `empty` is a router without any radio.
// Usage: node mkfx.mjs <output dir>
import fs from 'node:fs';
import path from 'node:path';
import { CASES, CMD, SECRETS, slug } from './cases.mjs';

const root = process.argv[2];

// A uci section in the form the uci module returns it.
const sec = (type, name, index, values, anonymous = false) => ({ '.anonymous': anonymous, '.type': type, '.name': name, '.index': index, ...values });

// The wireless config of the main scenario.
const WIRELESS = {
  radio0: sec('wifi-device', 'radio0', 0, { type: 'mac80211', path: 'platform/soc/18000000.wifi', band: '2g', channel: '6', htmode: 'HE40', country: 'IT', cell_density: '0' }),
  radio1: sec('wifi-device', 'radio1', 1, { type: 'mac80211', path: 'platform/soc/18000000.wifi+1', band: '5g', channel: '104', htmode: 'HE160', country: 'IT', noscan: '1', disabled: '1' }),
  radio2: sec('wifi-device', 'radio2', 2, { type: 'mac80211', path: 'pci0000:00/0000:00:00.0', band: '6g', channel: 'auto' }),
  ap_2g: sec('wifi-iface', 'ap_2g', 3, {
    device: 'radio0', mode: 'ap', ssid: 'home', encryption: 'psk2', network: 'lan', key: SECRETS.key, r0kh: [SECRETS.r0kh], r1kh: [SECRETS.r1kh],
    ieee80211r: '1', ft_psk_generate_local: '0', nasid: 'AABBCC', r1_key_holder: 'AABBCC', pmk_r1_push: '1', macfilter: 'deny', maclist: ['d8:d6:68:07:fb:78', 'aa:bb:cc:dd:ee:ff'],
    wpa_psk_file: '/etc/hostapd.wpa_psk', time_zone: 'CET-1CEST,M3.5.0,M10.5.0/3',
  }),
  ap_5g: sec('wifi-iface', 'ap_5g', 4, { device: 'radio1', mode: 'ap', ssid: 'home', encryption: 'sae-mixed', network: ['lan', 'guest'], sae_password: SECRETS.sae_password, wps_pin: SECRETS.wps_pin, ieee80211w: '1' }),
  cfg0a1b2c: sec('wifi-iface', 'cfg0a1b2c', 5, { device: 'radio1', mode: 'ap', ssid: 'corp', encryption: 'wpa2', network: 'lan', auth_server: 'radius.example.com', auth_port: '1812', auth_secret: SECRETS.auth_secret, acct_secret: SECRETS.acct_secret }, true),
  mesh_2g: sec('wifi-iface', 'mesh_2g', 6, { device: 'radio0', mode: 'mesh', mesh_id: 'meshy', encryption: 'sae', key: SECRETS.hex, network: 'lan' }),
  sta_5g: sec('wifi-iface', 'sta_5g', 7, { device: 'radio2', mode: 'sta', ssid: 'upstream', encryption: 'wpa2', eap_type: 'peap', identity: SECRETS.identity, password: SECRETS.password, priv_key_pwd: SECRETS.priv_key_pwd, key1: SECRETS.key1, key2: SECRETS.key2, network: 'wwan' }),
  odd: sec('wifi-iface', 'odd', 8, { device: 'radio0', mode: 'ap', ssid: 'x', encryption: 'none', note_secret: SECRETS.note_secret, api_token: SECRETS.api_token, key: '' }),
  vlan1: sec('wifi-vlan', 'vlan1', 9, { iface: 'ap_2g', vid: '10', network: 'lan', name: 'v10' }),
  stn1: sec('wifi-station', 'stn1', 10, { iface: 'ap_2g', psk: SECRETS.station_psk, vid: '10' }),
};

// The network config: logical interfaces (loopback is left out by the plugin) and a section of another type.
const NETWORK = {
  loopback: sec('interface', 'loopback', 0, { device: 'lo', proto: 'static' }),
  lan: sec('interface', 'lan', 1, { device: 'br-lan', proto: 'static' }), wan: sec('interface', 'wan', 2, { device: 'eth0', proto: 'dhcp' }),
  wwan: sec('interface', 'wwan', 3, { proto: 'dhcp' }), guest: sec('interface', 'guest', 4, { device: 'br-guest', proto: 'static' }),
  dev: sec('device', 'dev', 5, { name: 'br-lan' }),
};

// netifd's wireless status: radio0 runs with its access point and mesh interface; the others are down. The state holds the keys
// (netifd's does), which the plugin must never copy.
const STATUS = {
  radio0: { up: true, pending: false, retry_setup_failed: false, config: { band: '2g', key: SECRETS.key }, interfaces: [
    { section: 'ap_2g', ifname: 'phy0-ap0', config: { ssid: 'home', key: SECRETS.key } }, { section: 'mesh_2g', ifname: 'phy0-mesh0', config: { key: SECRETS.hex } }] },
  radio1: { up: false, pending: false, retry_setup_failed: false, interfaces: [] },
  radio2: { up: false, pending: false, retry_setup_failed: false, interfaces: [] },
};

// `iw phy <phy> info` of the 5 GHz phy (down: no interface to ask iwinfo about), cut to what the plugin reads: one band with HT40,
// VHT with 160 MHz and HE with 40, 80 and 160 MHz.
const PHY1 = `Wiphy phy1
\twiphy index: 1
\tAvailable Antennas: TX 0xf RX 0xf
\tBand 2:
\t\tCapabilities: 0x9ff
\t\t\tHT20/HT40
\t\tVHT Capabilities (0x339b79f6):
\t\t\tSupported Channel Width: 160 MHz
\t\tHE Iftypes: AP
\t\t\tHE PHY Capabilities: (0x0c204e926f1bafd0000c00):
\t\t\t\tHE40/HE80/5GHz
\t\t\t\tHE160/5GHz
\t\tFrequencies:
\t\t\t* 5180 MHz [36] (23.0 dBm)
\t\t\t* 5260 MHz [52] (23.0 dBm) (radar detection)
\tSupported commands:
\t\t * new_interface
`;
// The 2.4 GHz phy: HT40 and HE40 only.
const PHY0 = `Wiphy phy0
\twiphy index: 0
\tAvailable Antennas: TX 0xf RX 0xf
\tBand 1:
\t\tCapabilities: 0x9ff
\t\t\tHT20/HT40
\t\tHE Iftypes: AP
\t\t\t\tHE40/2.4GHz
\t\tFrequencies:
\t\t\t* 2412 MHz [1] (20.0 dBm)
\t\t\t* 2437 MHz [6] (20.0 dBm)
`;

// Writes one scenario: `features` is the set of hostapd features it has (null: hostapd is not installed) and `radios` whether the
// router has any.
function scenario(name, { features, radios }) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Writes `text` as the fixture of command `cmd`.
  const put = (cmd, text) => fs.writeFileSync(path.join(dir, slug(cmd)), text);
  // Writes `value` as the fixture file `file`.
  const putJson = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  putJson('uci_wireless.json', { values: radios ? WIRELESS : {} });
  putJson('uci_network.json', { values: NETWORK });
  putJson('network_wireless_status.json', radios ? STATUS : {});
  putJson('files.json', { '/sys/class/net/phy0-ap0/phy80211/name': 'phy0\n', '/sys/class/net/phy0-mesh0/phy80211/name': 'phy0\n' });
  if (radios) {
    put(CMD.phys, 'phy0\nphy1\n');
    put(CMD.phyDevice('phy0'), '/sys/devices/platform/soc/18000000.wifi\n');
    put(CMD.phyDevice('phy1'), '/sys/devices/platform/soc/18000000.wifi\n');
    put(CMD.phyInfo('phy0'), PHY0);
    put(CMD.phyInfo('phy1'), PHY1);
    put(CMD.htmodes('phy0-ap0'), 'HT20 HE20 HT40 HE40\n');
    put(CMD.countries('phy0-ap0'), '    00 "World"\n    DE "Germany"\n    IT "Italy"\n    US "United States"\nnot a country line\n');
  }
  if (features) {
    put(CMD.hostapd, 'hostapd v2.12\nUser space daemon for IEEE 802.11 AP management\n');
    for (const [f, on] of Object.entries(features)) put(CMD.feature(f), on ? 'yes\n' : '');
  }
}

fs.mkdirSync(root, { recursive: true });
scenario('main', { features: { eap: true, sae: true, owe: true, '11r': true, wps: true }, radios: true });
scenario('basic', { features: { eap: false, sae: true, owe: false, '11r': false, wps: false }, radios: true });
scenario('nohostapd', { features: null, radios: true });
scenario('empty', { features: null, radios: false });
fs.writeFileSync(path.join(root, 'cases.json'), JSON.stringify(CASES));
