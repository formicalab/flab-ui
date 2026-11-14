// Builds the fixtures of the flab.network `config` backend test: UCI network configs the plugin reads through FLAB_FIXTURES (uci_network.json),
// and the list of calls the harness makes. Every place a router keeps a secret holds a canary string, so assert.mjs can prove that none of
// them is ever returned.
// Usage: node mkfx.mjs <output dir>
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];

// The canary secrets, by where they sit.
const CANARY = {
  pppoe: 'canary-pppoe-pass-7f3a',
  wgKey: 'canary-wg-private-key-91b2',
  wgPsk: 'canary-wg-preshared-key-44cd',
  modem: 'canary-modem-password-0e55',
  pin: 'canary-sim-pin-6612',
  psk: 'canary-psk-secret-d1a9',
  other: 'canary-wpa-key-3b7e',
};

// A UCI section as the uci module's get_all returns it.
const section = (name, type, index, options = {}, anonymous = false) => ({ '.name': name, '.type': type, '.index': index, '.anonymous': anonymous, ...options });

// The sections of a scenario as get_all returns them: an object keyed by section name, here in an order that differs from the file order
// (`.index`), so the test also proves the plugin sorts by file position.
const config = sections => {
  const shuffled = [...sections].sort((a, b) => (b['.index'] % 3) - (a['.index'] % 3) || a['.index'] - b['.index']);
  return { values: Object.fromEntries(shuffled.map(s => [s['.name'], s])) };
};

// The scenarios: name -> sections.
const scenarios = {
  // A router with a secret in every kind of place: a PPPoE login, a WireGuard tunnel and its peers, a 4G modem with a SIM PIN, a pre-shared key,
  // other sections that must only be counted, anonymous and named device sections, bridge VLAN sections, a list option, an empty password.
  main: config([
    section('loopback', 'interface', 0, { device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' }),
    section('globals', 'globals', 1, { ula_prefix: 'fd00:1::/48', dhcp_default_duid: '0004aa', packet_steering: '1', netifd_loglevel: '4', tcp_l3mdev: '1', custom_opt: 'x' }),
    section('cfg030f15', 'device', 2, { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2'], stp: '1' }, true),
    section('lan', 'interface', 3, { device: 'br-lan', proto: 'static', ipaddr: ['192.168.1.1/24'], dns: ['9.9.9.9', '1.1.1.1'], ip6assign: '60' }),
    section('cfg040f15', 'device', 4, { type: '8021q', ifname: 'eth1', vid: '1036', name: 'eth1.1036', macaddr: '74:36:6D:C0:9B:83' }, true),
    section('wan', 'interface', 5, { device: 'eth1.1036', proto: 'pppoe', username: 'v-user', password: CANARY.pppoe, keepalive: '5 1', host_uniq: '5231' }),
    section('wan6', 'interface', 6, { proto: 'dhcpv6', device: '@wan', reqprefix: 'auto' }),
    section('lte', 'interface', 7, { proto: '3g', device: '/dev/ttyUSB0', apn: 'internet', pincode: CANARY.pin, username: 'u', password: CANARY.modem, service: 'umts' }),
    section('wg0', 'interface', 8, { proto: 'wireguard', private_key: CANARY.wgKey, listen_port: '51820', addresses: ['10.0.0.1/24'] }),
    section('cfg0a0f15', 'wireguard_wg0', 9, { description: 'phone', public_key: 'pub1', preshared_key: CANARY.wgPsk, allowed_ips: ['10.0.0.2/32'] }, true),
    section('cfg0b0f15', 'wireguard_wg0', 10, { description: 'laptop', public_key: 'pub2', allowed_ips: ['10.0.0.3/32'] }, true),
    section('guest_br', 'device', 11, { name: 'br-guest', type: 'bridge', ports: [] }),
    section('guest', 'interface', 12, { device: 'br-guest', proto: 'static', ipaddr: '10.9.9.1', netmask: '255.255.255.0', psk: CANARY.psk, key: CANARY.other, note: '', password: '' }),
    section('cfg0c0f15', 'bridge-vlan', 13, { device: 'br-lan', vlan: '10', ports: ['lan1:u*'] }, true),
    section('cfg0d0f15', 'bridge-vlan', 14, { device: 'br-lan', vlan: '20', ports: ['lan2:t'] }, true),
    section('r1', 'route', 15, { interface: 'wan', target: '10.0.0.0/8', gateway: '1.2.3.4' }),
    section('cfg0e0f15', 'route', 16, { interface: 'wan', target: '172.16.0.0/12', gateway: '1.2.3.4' }, true),
    section('cfg0f0f15', 'rule', 17, { src: '192.168.1.0/24', lookup: '100' }, true),
  ]),
  // A config with nothing in it.
  empty: { values: {} },
  // No network config at all (the fixture file is missing).
  missing: null,
};

fs.mkdirSync(out, { recursive: true });
for (const [name, data] of Object.entries(scenarios)) {
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  if (data) fs.writeFileSync(path.join(dir, 'uci_network.json'), JSON.stringify(data));
}
fs.writeFileSync(path.join(out, 'cases.json'), JSON.stringify([{ id: 'config', method: 'config', args: {} }]));
fs.writeFileSync(path.join(out, 'scenarios.json'), JSON.stringify(Object.keys(scenarios)));
fs.writeFileSync(path.join(out, 'canaries.json'), JSON.stringify(Object.values(CANARY)));
