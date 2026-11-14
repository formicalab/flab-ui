// The router the netpanels tests run against: a config of the shape of a real router (a bridge on four ports, PPPoE over a VLAN, a second VLAN network,
// IPsec and WireGuard interfaces), its runtime data (ports, bridge, VLAN devices, firewall zones, DHCP services, netifd's interfaces) and a small mock of
// what rpcd does with the UCI operations of model.js plan(). Used by the node tests and, served as a module, by the browser harness.
import { readNetwork } from '../../www/js/pages/interfaces/model.js';

// A section of the plugin's reply: options without the secrets, and which secrets are set.
export const sec = (section, values, secrets = {}, anonymous = false) => ({ section, anonymous, values, secrets });

export const REPLY = {
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
    sec('cfg030f15', { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3', 'lan4'], stp: '1' }, {}, true),
    sec('cfg040f15', { type: '8021q', ifname: 'eth1', vid: '1036', name: 'eth1.1036', macaddr: '74:36:6D:C0:9B:83' }, {}, true),
    sec('cfg050f15', { type: '8021q', ifname: 'br-lan', vid: '100', name: 'br-lan.100' }, {}, true),
  ],
  globals: sec('globals', { ula_prefix: 'fd92:cdf9:fb3f::/48', packet_steering: '2', dhcp_default_duid: '0004abcd', custom_opt: 'x' }),
  other: { route: 1, wireguard_wg0: 2 },
  bridge_vlans: [],
};

// The runtime data the pages load next to the config: the plugin's status (ports, bridges, VLAN devices, zones, DHCP services). `lan5` is a free port.
export const NET = {
  ports: [
    ...['lan1', 'lan2', 'lan3', 'lan4'].map(name => ({ name, role: 'switch', carrier: true, speed: 1000 })),
    { name: 'lan5', role: 'switch', carrier: false }, { name: 'eth1', role: 'nic', carrier: true, speed: 2500 }, { name: 'eth0', role: 'conduit', carrier: true },
    { name: 'wlan-x', role: 'nic', carrier: false, type: 'swconfig' },
  ],
  bridges: [{
    name: 'br-lan', up: true, stp: true, members: ['lan1', 'lan2', 'lan3', 'lan4'].map(name => ({ name, kind: 'ethernet', carrier: true })).concat([{ name: 'phy0-ap0', kind: 'wifi', carrier: true }]),
  }],
  vlans: [{ name: 'eth1.1036', parent: 'eth1', vid: 1036, up: true }, { name: 'br-lan.100', parent: 'br-lan', vid: 100, up: true }],
  zones: [{ name: 'lan', networks: ['lan', 'lan100'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', masq: false, forwards: ['wan'] },
    { name: 'wan', networks: ['wan', 'wan6'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: true, forwards: [] }],
  dhcp: { lan: { v4: 'server', start: 100, limit: 150, leasetime: '12h', v6: 'disabled', ra: 'server' } },
};

// netifd's interface dump.
export const IFS = [
  { interface: 'loopback', up: true, device: 'lo', 'ipv4-address': [{ address: '127.0.0.1', mask: 8 }] },
  { interface: 'lan', up: true, device: 'br-lan', 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }] },
  { interface: 'wan', up: true, device: 'eth1.1036', l3_device: 'pppoe-wan', 'ipv4-address': [{ address: '100.64.3.9', mask: 32 }],
    route: [{ target: '0.0.0.0', mask: 0, nexthop: '100.64.0.1' }, { target: '10.99.0.0', mask: 16, nexthop: '100.64.0.1' }] },
  { interface: 'wan6', up: true, device: 'pppoe-wan' },
  { interface: 'lan100', up: true, device: 'br-lan.100', 'ipv4-address': [{ address: '192.168.100.1', mask: 24 }] },
  { interface: 'xfrm0', up: true }, { interface: 'wg0', up: true, 'ipv4-address': [{ address: '192.168.2.1', mask: 24 }] },
];

// A deep copy, so a test can edit a fixture without touching the original.
export const clone = o => JSON.parse(JSON.stringify(o));

// The data object a page hands to the model: the config as readNetwork reads it, the runtime and netifd's dump.
export const dataOf = (reply = REPLY) => ({ cfg: readNetwork(clone(reply)), net: clone(NET), ifs: clone(IFS) });

// What rpcd's uci object does with the operations of model.js plan() (core/ops.js): the config reply `reply` after the operations. A new interface is
// named by its operation, a new device section is anonymous and gets a generated name.
export function applyOps(reply, ops) {
  const out = clone(reply);
  const list = type => (type === 'interface' ? out.interfaces : out.devices);
  const find = section => [...out.interfaces, ...out.devices, ...(out.globals ? [out.globals] : [])].find(s => s.section === section);
  // The options the plugin reports as secrets (the same rule as flab.network.uc): only that they are set.
  const secret = /^(password|passwd|pin|pincode|[a-z0-9_]*(passw|secret|psk|key|token|credential)[a-z0-9_]*)$/i;
  // Stores one option of a section the way the plugin reports it.
  const put = (s, k, v) => { if (secret.test(k)) s.secrets[k] = true; else s.values[k] = v; };
  let n = 0;
  for (const op of ops) {
    if (op.op === 'add') {
      const s = { section: op.name ?? `cfg${(0x100 + n++).toString(16)}`, anonymous: !op.name, values: {}, secrets: {} };
      for (const [k, v] of Object.entries(op.values ?? {})) put(s, k, v);
      if (op.type === 'globals') out.globals = s; else list(op.type).push(s);
    } else if (op.op === 'set') {
      for (const [k, v] of Object.entries(op.values)) put(find(op.section), k, v);
    } else if (op.op === 'delete') {
      const s = find(op.section);
      if (op.options) for (const k of op.options) { delete s.values[k]; delete s.secrets[k]; }
      else { out.interfaces = out.interfaces.filter(x => x !== s); out.devices = out.devices.filter(x => x !== s); }
    }
  }
  return out;
}
