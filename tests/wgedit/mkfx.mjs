// Builds the fixtures of the WireGuard backend test. Every scenario is a directory with the file names flab.wireguard reads when
// FLAB_FIXTURES is set (see rpcd/lib/flab/util.uc), so the plugin never runs a command: it only finds, in the fixture folder, what the
// command would have printed.
// The `main` scenario is a router with a running interface (wg0: a private key, three peers with pre-shared keys, one with a public key
// option that holds a pasted secret, one disabled), a disabled one without a key (wg1), an interface only the kernel has (wg9), a
// firewall zone, lan and wan sections, and the connections /proc/net/tcp and /proc/net/tcp6 list (to the web interface and SSH, also on
// the ports uhttpd and dropbear are configured for, from tunnel addresses, loopback and a native IPv6 address; sockets that are
// listening or closing or on another port are ignored). The `empty` scenario is a router without WireGuard and without the protocol
// handler. Every secret is a canary that must never appear in a reply.
// Usage: node mkfx.mjs <output dir>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];

// The fixture file name of a command: the command with every run of non-alphanumerics turned into "_".
const slug = cmd => cmd.replace(/ 2>\/dev\/null$/, '').replace(/[^A-Za-z0-9]+/g, '_') + '.txt';

// The secrets of the fake router: they must never appear in any reply.
const SECRETS = {
  iface: 'PRIVATE-KEY-CANARY-aaaaaaaaaaaaaaaaaaaaaaaa=', iface1: 'PRIVATE-KEY-CANARY-bbbbbbbbbbbbbbbbbbbbbbbb=',
  psk1: 'PSK-CANARY-1111111111111111111111111111=', psk2: 'PSK-CANARY-2222222222222222222222222222=',
  pasted: 'PASTED-PRIVATE-KEY-CANARY-ccccccccccccc=', other: 'SECRET-CANARY-OTHER-OPTION', token: 'TOKEN-CANARY-1234',
};
// A real-looking public key from a number.
const key = n => Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => (n * 37 + i * 11) & 255)).toString('base64');
const KEYS = { server: key(1), phone: key(2), site: key(3), off: key(4), kernel: key(5), kernelOnly: key(6) };

// A uci section in the form the uci module returns it.
const sec = (type, name, index, values, anonymous = false) => ({ '.anonymous': anonymous, '.type': type, '.name': name, '.index': index, ...values });

// The network config of the main scenario.
const NETWORK = {
  globals: sec('globals', 'globals', 0, { ula_prefix: 'fd00:aaaa::/48' }),
  loopback: sec('interface', 'loopback', 1, { device: 'lo', proto: 'static' }),
  lan: sec('interface', 'lan', 2, { device: 'br-lan', proto: 'static', ipaddr: '192.168.1.1', netmask: '255.255.255.0' }),
  wan: sec('interface', 'wan', 3, { device: 'eth1', proto: 'pppoe', username: 'me', password: SECRETS.other }),
  wg0: sec('interface', 'wg0', 4, {
    proto: 'wireguard', private_key: SECRETS.iface, listen_port: '51820', addresses: ['10.8.0.1/24', 'fd00:8::1/64'], mtu: '1420', odd_option: 'x', tunlink: 'wan', api_token: SECRETS.token,
  }),
  cfg0a1b2c: sec('wireguard_wg0', 'cfg0a1b2c', 5, { description: 'Phone', public_key: KEYS.phone, preshared_key: SECRETS.psk1, allowed_ips: ['10.8.0.2/32', 'fd00:8::2/128'], persistent_keepalive: '25' }, true),
  cfg0b2c3d: sec('wireguard_wg0', 'cfg0b2c3d', 6, { description: 'Site', public_key: KEYS.site, allowed_ips: ['192.168.8.0/24'], route_allowed_ips: '1', endpoint_host: 'site.example.com', endpoint_port: '51820', preshared_key: SECRETS.psk2 }, true),
  cfg0c3d4e: sec('wireguard_wg0', 'cfg0c3d4e', 7, { description: 'Pasted', public_key: SECRETS.pasted, allowed_ips: ['10.8.0.7/32'] }, true),
  cfg0d4e5f: sec('wireguard_wg0', 'cfg0d4e5f', 8, { description: 'Old', public_key: KEYS.off, allowed_ips: ['10.8.0.9/32'], disabled: '1' }, true),
  wg1: sec('interface', 'wg1', 9, { proto: 'wireguard', disabled: '1', private_key: SECRETS.iface1, addresses: '10.9.0.1/24 10.9.1.1/24' }),
  cfg0e5f6a: sec('wireguard_wg1', 'cfg0e5f6a', 10, { public_key: KEYS.kernel, allowed_ips: ['10.9.0.2/32'] }, true),
  dev: sec('device', 'dev', 11, { name: 'br-lan', type: 'bridge' }),
};
const FIREWALL = { lan: sec('zone', 'lan', 0, { name: 'lan', network: ['lan', 'wg0'] }) };
const UHTTPD = { main: sec('uhttpd', 'main', 0, { listen_http: ['0.0.0.0:80', '[::]:80'], listen_https: ['0.0.0.0:443', '[::]:8443'] }) };
const DROPBEAR = { cfg: sec('dropbear', 'cfg', 0, { Port: '2222' }, true) };

// An IPv4 address as /proc/net/tcp prints it: the four bytes as one little-endian number in hex.
const v4 = text => text.split('.').reverse().map(n => (+n).toString(16).padStart(2, '0')).join('').toUpperCase();
// An IPv6 address (16 bytes) as /proc/net/tcp6 prints it: four words, each one little-endian.
const v6 = bytes => [0, 4, 8, 12].map(o => bytes.slice(o, o + 4).reverse().map(b => b.toString(16).padStart(2, '0')).join('')).join('').toUpperCase();
// The bytes of an IPv4-mapped IPv6 address.
const mapped = text => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...text.split('.').map(Number)];
// The bytes of fd00:8::2.
const ULA = [0xfd, 0x00, 0x00, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
// One line of /proc/net/tcp or tcp6: slot, local and remote addresses with ports, and the socket state in hex.
const sock = (n, local, lport, remote, rport, state) => `  ${String(n).padStart(3)}: ${local}:${lport.toString(16).toUpperCase().padStart(4, '0')} ${remote}:${rport.toString(16).toUpperCase().padStart(4, '0')} ${state} 00000000:00000000 00:00000000 00000000     0        0 ${10000 + n} 1 0000000000000000 100 0 0 10 0`;
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const ZERO6 = '00000000000000000000000000000000';

// The files of the main scenario (path to contents), as files.json. `handler` is the netifd protocol handler: wireguard.uc on current
// releases, wireguard.sh on older ones (scenario `oldproto`).
function files(handler = 'wireguard.uc') {
  return {
    [`/lib/netifd/proto/${handler}`]: '# proto handler\n',
    '/sys/class/net/wg0/mtu': '1420\n', '/sys/class/net/wg0/statistics/rx_bytes': '1000\n', '/sys/class/net/wg0/statistics/tx_bytes': '2000\n',
    '/sys/class/net/wg9/mtu': '1420\n', '/sys/class/net/wg9/statistics/rx_bytes': '0\n', '/sys/class/net/wg9/statistics/tx_bytes': '0\n',
    '/proc/net/tcp': [
      HEADER,
      sock(0, v4('0.0.0.0'), 443, v4('0.0.0.0'), 0, '0A'),
      sock(1, v4('192.168.1.1'), 443, v4('10.8.0.2'), 50001, '01'),
      sock(2, v4('192.168.1.1'), 443, v4('10.8.0.2'), 50002, '01'),
      sock(3, v4('192.168.1.1'), 22, v4('127.0.0.1'), 50003, '01'),
      sock(4, v4('192.168.1.1'), 5555, v4('10.8.0.2'), 50004, '01'),
      sock(5, v4('192.168.1.1'), 443, v4('10.8.0.3'), 50005, '06'),
      sock(6, v4('192.168.1.1'), 2222, v4('192.168.8.7'), 50006, '01'),
      sock(7, v4('192.168.1.1'), 80, v4('192.168.1.50'), 50007, '01'),
      'this line is not a socket',
    ].join('\n') + '\n',
    '/proc/net/tcp6': [
      HEADER,
      sock(0, ZERO6, 8443, ZERO6, 0, '0A'),
      sock(1, v6(mapped('192.168.1.1')), 22, v6(mapped('192.168.9.5')), 50010, '01'),
      sock(2, v6([0xfd, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), 8443, v6(ULA), 50011, '01'),
      sock(3, '00000000000000000000000001000000', 443, '00000000000000000000000001000000', 50012, '01'),
    ].join('\n') + '\n',
  };
}

// The `wg show` output of wg0 (one single-field command per file): the router's key, three of the peers loaded, one of them with a
// recent handshake, and a peer that only the kernel has.
const WG0 = {
  'public-key': KEYS.server, 'listen-port': '51820', peers: [KEYS.phone, KEYS.site, KEYS.kernelOnly].join('\n'),
  endpoints: `${KEYS.phone}\t198.51.100.9:4000\n${KEYS.site}\tsite.example.com:51820\n${KEYS.kernelOnly}\t(none)`,
  'allowed-ips': `${KEYS.phone}\t10.8.0.2/32 fd00:8::2/128\n${KEYS.site}\t192.168.8.0/24\n${KEYS.kernelOnly}\t(none)`,
  'latest-handshakes': `${KEYS.phone}\t@NOW@\n${KEYS.site}\t0\n${KEYS.kernelOnly}\t0`,
  transfer: `${KEYS.phone}\t100\t200\n${KEYS.site}\t0\t0\n${KEYS.kernelOnly}\t0\t0`,
  'persistent-keepalive': `${KEYS.phone}\t25\n${KEYS.site}\toff\n${KEYS.kernelOnly}\toff`,
};

// Writes one scenario; `main` is the router with WireGuard (handler wireguard.uc), `oldproto` the same with the older wireguard.sh,
// `empty` one without.
function scenario(name) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Writes `text` as the fixture of command `cmd`.
  const put = (cmd, text) => fs.writeFileSync(path.join(dir, slug(cmd)), text);
  // Writes `value` as the fixture file `file`.
  const putJson = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  if (name === 'empty') {
    putJson('uci_network.json', { values: { loopback: NETWORK.loopback, lan: NETWORK.lan } });
    putJson('files.json', {});
    return;
  }
  putJson('uci_network.json', { values: NETWORK });
  putJson('uci_firewall.json', { values: FIREWALL });
  putJson('uci_uhttpd.json', { values: UHTTPD });
  putJson('uci_dropbear.json', { values: DROPBEAR });
  putJson('files.json', files(name === 'oldproto' ? 'wireguard.sh' : 'wireguard.uc'));
  put('wg show interfaces', 'wg0 wg9\n');
  const now = Math.floor(Date.now() / 1000) - 30;
  for (const ifname of ['wg0', 'wg9']) {
    for (const [field, text] of Object.entries(WG0)) put(`wg show ${ifname} ${field}`, ifname === 'wg0' ? text.replace('@NOW@', String(now)) + '\n' : (field === 'public-key' ? KEYS.kernel : field === 'listen-port' ? '51900' : '') + '\n');
  }
}

fs.mkdirSync(root, { recursive: true });
for (const name of ['main', 'empty', 'oldproto']) scenario(name);
fs.writeFileSync(path.join(root, 'keys.json'), JSON.stringify({ KEYS, SECRETS }));
