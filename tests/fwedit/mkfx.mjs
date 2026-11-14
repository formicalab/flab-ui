// Builds the fixtures of the Firewall backend test. Every scenario is a directory with the file names flab.firewall reads when FLAB_FIXTURES is
// set (see rpcd/lib/flab/util.uc), so the plugin never runs a command or touches the router: it finds, in the fixture folder, what the command
// would have printed. Usage: node mkfx.mjs <output dir>
//
// Scenarios:
//   main       a router like the lab one: defaults, zones lan/wan/vpn, forwardings, anonymous and named rules, a port forward, a NAT section, an
//              include, an ipset, interfaces with addresses, the ruleset loaded with counters; a canary private key in the network config
//   nodefaults no defaults section and zones without policies of their own (firewall4 drops), the legacy syn_flood option
//   stopped    nftables has no fw4 table
//   nonet      netifd gives no interface dump
//   partial    a zone that the firewall did not load (no input_ chain)
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];

// A UCI section in the form the uci module returns it, as a [name, section] pair for Object.fromEntries.
const sec = (type, name, index, values, anonymous = name.startsWith('cfg')) => [name, { '.anonymous': anonymous, '.type': type, '.name': name, '.index': index, ...values }];

// The canary: a value that must never appear in the output.
const CANARY = 'canary-private-key-0001';

// The firewall config of the main scenario.
const firewall = () => Object.fromEntries([
  sec('defaults', 'cfg01', 0, { input: 'reject', output: 'ACCEPT', forward: 'REJECT', synflood_protect: '1', flow_offloading: '1', flow_offloading_hw: '1' }),
  sec('zone', 'cfg02', 1, { name: 'lan', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', network: ['lan', 'lan100'] }),
  sec('zone', 'cfg03', 2, { name: 'wan', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1', mtu_fix: '1', network: ['wan', 'wan6'] }),
  sec('forwarding', 'cfg04', 3, { src: 'lan', dest: 'wan' }),
  sec('rule', 'cfg05', 4, { name: 'Allow-Ping', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' }),
  sec('rule', 'cfg06', 5, { src: 'lan', proto: ['tcp'], dest_port: '2222', target: 'ACCEPT' }),
  sec('rule', 'wg', 6, { name: 'Allow-WireGuard', src: 'wan', dest_port: '51820', proto: 'udp', target: 'ACCEPT' }, false),
  sec('zone', 'cfg07', 7, { name: 'vpn', mtu_fix: '1', network: ['xfrm0'] }),
  sec('forwarding', 'cfg08', 8, { src: 'lan', dest: 'vpn', enabled: '0' }),
  sec('rule', 'cfg09', 9, { src: 'vpn', proto: 'tcp', dest_port: '3128', target: 'REJECT', enabled: '0' }),
  sec('redirect', 'cfg0a', 10, { name: 'Web', src: 'wan', src_dport: '8080', dest: 'lan', dest_ip: '192.168.1.10', dest_port: '80', proto: 'tcp', target: 'DNAT' }),
  sec('redirect', 'cfg0b', 11, { src: 'wan', src_dport: '2200', dest_ip: '192.168.1.11', dest_port: '22', proto: ['tcp'] }),
  sec('nat', 'cfg0c', 12, { name: 'Masq-Guest', src: 'lan', snat_ip: '203.0.113.5', proto: 'all' }),
  sec('include', 'cfg0d', 13, { path: '/etc/firewall.user' }),
  sec('ipset', 'cfg0e', 14, { name: 'blocked', match: 'src_ip' }),
]);

// The network config of the main scenario.
const network = () => Object.fromEntries([
  sec('interface', 'loopback', 0, { device: 'lo', proto: 'static' }, false),
  sec('interface', 'lan', 1, { device: 'br-lan', proto: 'static' }, false),
  sec('interface', 'lan100', 2, { device: 'br-lan.100', proto: 'static' }, false),
  sec('interface', 'wan', 3, { device: 'eth1', proto: 'dhcp' }, false),
  sec('interface', 'wan6', 4, { device: 'eth1', proto: 'dhcpv6' }, false),
  sec('interface', 'guest', 5, { proto: 'static', disabled: '1' }, false),
  sec('interface', 'wg0', 6, { proto: 'wireguard', private_key: CANARY }, false),
  sec('device', 'dev0', 7, { name: 'br-lan', type: 'bridge' }),
]);

// What netifd reports: the router's addresses on the interfaces that are up (wg0 is down and absent).
const dump = () => ({ interface: [
  { interface: 'loopback', up: true, 'ipv4-address': [{ address: '127.0.0.1', mask: 8 }] },
  { interface: 'lan', up: true, 'ipv4-address': [{ address: '192.168.1.1', mask: 24 }], 'ipv6-address': [{ address: 'fd00::1', mask: 64 }] },
  { interface: 'lan100', up: true, 'ipv4-address': [{ address: '192.168.100.1', mask: 24 }] },
  { interface: 'wan', up: true, 'ipv4-address': [{ address: '203.0.113.7', mask: 24 }] },
  { interface: 'wan6', up: true },
] });

// An nft rule of the fw4 table in the JSON `nft -j` prints.
const nftRule = (chain, expr, comment) => ({ rule: { family: 'inet', table: 'fw4', chain, ...(comment ? { comment } : {}), expr } });
// A base chain or a zone chain.
const nftChain = (name, extra = {}) => ({ chain: { family: 'inet', table: 'fw4', name, ...extra } });
// A device match followed by a jump, the way the base chains select the chain of a zone.
const jump = (base, dev, target) => nftRule(base, [{ match: { op: '==', left: { meta: { key: 'iifname' } }, right: dev } }, { jump: { target } }]);
// A rule with a counter.
const counted = (chain, comment, packets, bytes) => nftRule(chain, [{ match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 22 } }, { counter: { packets, bytes } }, { accept: null }], comment);

// The ruleset of the main scenario: base chains, a chain set per zone, the counters of three rules and the reject chains.
const ruleset = zones => ({ nftables: [
  { metainfo: { version: '1.1.0' } },
  { table: { family: 'inet', name: 'fw4' } },
  nftChain('input', { type: 'filter', hook: 'input', prio: 0, policy: 'drop' }),
  nftChain('forward', { type: 'filter', hook: 'forward', prio: 0, policy: 'drop' }),
  nftChain('output', { type: 'filter', hook: 'output', prio: 0, policy: 'drop' }),
  ...zones.flatMap(z => [nftChain(`input_${z}`), nftChain(`forward_${z}`), nftChain(`output_${z}`)]),
  nftChain('reject_from_wan'), nftChain('drop_to_vpn'),
  jump('input', 'br-lan', 'input_lan'), jump('input', 'eth1', 'input_wan'), jump('forward', 'br-lan', 'forward_lan'),
  counted('input_wan', '!fw4: Allow-Ping', 3, 300),
  counted('input_wan', '!fw4: Allow-Ping', 4, 400),
  counted('input_lan', '!fw4: @rule[1]', 7, 7000),
  counted('input_wan', '!fw4: Allow-WireGuard', 9, 900),
  counted('dstnat_wan', '!fw4: Web', 1, 60),
  counted('reject_from_wan', null, 11, 1100),
  { flowtable: { family: 'inet', table: 'fw4', name: 'ft', dev: ['eth0', 'eth1'] } },
] });

// A scenario: the files of its fixture directory, by name.
function scenario(over = {}) {
  const files = {
    'uci_firewall.json': JSON.stringify({ values: firewall() }),
    'uci_network.json': JSON.stringify({ values: network() }),
    'network_interface_dump.json': JSON.stringify(dump()),
    'nft_j_list_ruleset.txt': JSON.stringify(ruleset(['lan', 'wan', 'vpn'])),
    'files.json': JSON.stringify({ '/proc/sys/net/netfilter/nf_conntrack_count': '10\n', '/proc/sys/net/nf_conntrack_max': '100\n' }),
  };
  return { ...files, ...over };
}

// The scenarios by name.
const SCENARIOS = {
  main: scenario(),
  nodefaults: (() => {
    const fw = firewall();
    delete fw.cfg01;
    delete fw.cfg02.input; delete fw.cfg02.output; delete fw.cfg02.forward;
    fw.cfg03.input = 'reject';
    return scenario({ 'uci_firewall.json': JSON.stringify({ values: fw }) });
  })(),
  legacy: (() => {
    const fw = firewall();
    delete fw.cfg01.synflood_protect;
    fw.cfg01.syn_flood = '1';
    return scenario({ 'uci_firewall.json': JSON.stringify({ values: fw }) });
  })(),
  stopped: scenario({ 'nft_j_list_ruleset.txt': '' }),
  nonet: scenario({ 'network_interface_dump.json': '' }),
  partial: scenario({ 'nft_j_list_ruleset.txt': JSON.stringify(ruleset(['lan', 'wan'])) }),
};

for (const [name, files] of Object.entries(SCENARIOS)) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
}
fs.writeFileSync(path.join(root, 'scenarios.json'), JSON.stringify(Object.keys(SCENARIOS)));
