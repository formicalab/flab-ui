// Builds the fixture directories of the routing suite. Usage: node mkfx.mjs <work dir containing fx-real/>
// Writes <work>/<scenario>/ with one file per command the flab.routing plugin runs (see FLAB_FIXTURES in
// rpcd/lib/flab/util.uc), plus <work>/lookups/<case>.json (the arguments of each lookup case) and
// <work>/scenarios.json. Scenarios:
//   real   - what the router under test reports (captured read-only), used for invariants
//   rich   - synthetic and deterministic: every syntax of `ip route` and `ip rule` the parser handles, and the
//            lookup answers (the text of each is what iproute2 prints, taken from real routers)
//   noip   - the ip tool printed nothing
import fs from 'node:fs';
import path from 'node:path';

const work = process.argv[2];
// File name of a command's fixture, as util.uc derives it: runs of non-alphanumerics become "_".
const slug = cmd => cmd.replace(/[^A-Za-z0-9]+/g, '_') + '.txt';
// The command line of `ip` for address `family` (4 or 6) with the arguments `rest`.
const ip = (family, rest) => `/sbin/ip -${family} ${rest}`;

//#region The rich scenario
const V4_ROUTES = [
  'default via 192.0.2.1 dev wan proto static metric 10 ',
  'default via 198.51.100.1 dev wan2 proto static metric 20 linkdown ',
  '10.0.0.0/22 proto bird metric 32 ',
  '\tnexthop via 10.0.0.12 dev xfrm0 weight 1 ',
  '\tnexthop via 10.0.0.13 dev xfrm1 weight 1 dead linkdown ',
  '10.9.0.0/16 via inet6 fe80::1 dev wan onlink ',
  'blackhole 192.168.0.0/16 proto bird metric 32 ',
  '192.168.1.0/24 dev br-lan proto kernel scope link src 192.168.1.1 ',
  'prohibit 203.0.113.0/24 metric 100 ',
  'throw 198.18.0.0/15 ',
  '172.16.0.0/12 dev wg0 scope link mtu lock 1380 ',
  '192.0.2.1 dev wan proto kernel scope link src 192.0.2.77 ',
  '10.20.0.0/16 via 192.168.1.254 dev br-lan table voip proto static ',
  'default via 192.0.2.1 dev wan table 220 ',
  'local 192.168.1.1 dev br-lan table local proto kernel scope host src 192.168.1.1 ',
  'broadcast 192.168.1.255 dev br-lan table local proto kernel scope link src 192.168.1.1 ',
];
const V6_ROUTES = [
  'default from 2001:db8:1::/48 via fe80::1 dev wan proto static metric 512 pref medium',
  '2001:db8:1::/64 dev br-lan proto static metric 1024 pref medium',
  '2001:db8:2::/64 via fe80::2 dev br-lan proto ra metric 1024 expires 1750sec pref medium',
  'unreachable 2001:db8:1::/48 dev lo proto static metric 2147483647 pref medium',
  'fe80::/64 dev br-lan proto kernel metric 256 pref medium',
  'fd00:1::/64 metric 1024 pref medium',
  '\tnexthop via fe80::a dev br-lan weight 1 ',
  '\tnexthop via fe80::b dev wg0 weight 1 ',
  'local ::1 dev lo table local proto kernel metric 0 pref medium',
  'multicast ff00::/8 dev br-lan table local proto kernel metric 256 pref medium',
];
const V4_RULES = [
  '0:\tfrom all lookup local ',
  '100:\tfrom 192.168.1.0/24 iif br-lan lookup voip ',
  '200:\tnot from 10.0.0.0/8 fwmark 0x1/0xff lookup 220 suppress_prefixlength 0 ',
  '220:\tfrom all lookup 220 ',
  '300:\tfrom all uidrange 1000-1999 goto 32766 ',
  '400:\tfrom all to 203.0.113.0/24 prohibit ',
  '32766:\tfrom all lookup main ',
  '32767:\tfrom all lookup default ',
];
const V6_RULES = [
  '0:\tfrom all lookup local ',
  '32766:\tfrom all lookup main ',
  '4200000000:\tfrom 2001:db8:1::1/60 iif br-lan unreachable ',
];
const RT_TABLES = '#\n# reserved values\n#\n255\tlocal\n254\tmain\n253\tdefault\n0\tunspec\n#\n# local\n#\n100\tvoip\n';
// /etc/config/network as uci reports it: an anonymous `rule` that matches rule 100, a named `rule6` that matches no rule
// in the kernel, and an interface holding a secret that must never leave the plugin.
const UCI_NETWORK = { values: {
  cfg0a1b2c: { '.type': 'rule', '.name': 'cfg0a1b2c', '.anonymous': true, priority: '100', lookup: 'voip', src: '192.168.1.0/24', in: 'br-lan' },
  v6_extra: { '.type': 'rule6', '.name': 'v6_extra', '.anonymous': false, priority: '6000', lookup: 'main' },
  wg0: { '.type': 'interface', '.name': 'wg0', '.anonymous': false, proto: 'wireguard', private_key: 'TOPSECRETKEY' },
} };

// The lookup cases: arguments and the text `ip route get` and `... fibmatch` print for them.
const NOROUTE = 'RTNETLINK answers: Network unreachable\n';
const LOOKUPS = {
  fwd: { args: { dst: '1.1.1.1' }, get: '1.1.1.1 via 192.0.2.1 dev wan src 192.0.2.77 uid 0 \n    cache \n', fib: 'default via 192.0.2.1 dev wan proto static metric 10 \n' },
  ecmp: { args: { dst: '10.0.5.5' }, get: '10.0.5.5 via 10.0.0.12 dev xfrm0 src 192.168.254.196 uid 0 \n    cache \n', fib: '10.0.0.0/22 proto bird metric 32 \n\tnexthop via 10.0.0.12 dev xfrm0 weight 1 \n\tnexthop via 10.0.0.13 dev xfrm1 weight 1 dead linkdown \n' },
  local: { args: { dst: '192.168.1.1' }, get: 'local 192.168.1.1 dev lo table local src 192.168.1.1 uid 0 \n    cache <local> \n', fib: 'local 192.168.1.1 dev br-lan table local proto kernel scope host src 192.168.1.1 \n' },
  broadcast: { args: { dst: '192.168.1.255' }, get: 'broadcast 192.168.1.255 dev br-lan table local src 192.168.1.1 uid 0 \n    cache <local,brd> \n', fib: 'broadcast 192.168.1.255 dev br-lan table local proto kernel scope link src 192.168.1.1 \n' },
  blackhole: { args: { dst: '192.168.5.5' }, get: 'RTNETLINK answers: Invalid argument\n', fib: 'RTNETLINK answers: Invalid argument\n' },
  unreach6: { args: { dst: '2001:db8:1:5::99' }, get: 'RTNETLINK answers: Host is unreachable\n', fib: 'RTNETLINK answers: Host is unreachable\n' },
  noroute6: { args: { dst: '2606:4700:4700::1111' }, get: NOROUTE, fib: NOROUTE },
  iif: { args: { dst: '8.8.8.8', src: '192.168.1.50', iif: 'br-lan' }, get: '8.8.8.8 from 192.168.1.50 via 192.0.2.1 dev wan \n    cache iif br-lan \n', fib: 'default via 192.0.2.1 dev wan proto static metric 10 \n' },
  iif6: { args: { dst: '2606:4700::1', src: '2001:db8:1::50', iif: 'br-lan' }, get: '2606:4700::1 from 2001:db8:1::50 via fe80::1 dev wan proto static src 2001:db8:1::1 metric 512 iif br-lan pref medium\n', fib: 'default from 2001:db8:1::/48 via fe80::1 dev wan proto static metric 512 iif br-lan pref medium\n' },
  table: { args: { dst: '10.20.1.1' }, get: '10.20.1.1 via 192.168.1.254 dev br-lan table voip src 192.168.1.1 uid 0 \n    cache \n', fib: '10.20.0.0/16 via 192.168.1.254 dev br-lan table voip proto static \n' },
  mismatch: { args: { dst: '1.1.1.1', src: '2a01::1' }, get: 'Error: inet prefix is expected rather than "2a01::1".\n', fib: 'Error: inet prefix is expected rather than "2a01::1".\n' },
  // Refused before any command runs, so no fixture exists for them.
  injection: { args: { dst: '1.1.1.1; reboot' } },
  badsrc: { args: { dst: '1.1.1.1', src: 'x y' } },
  badiif: { args: { dst: '1.1.1.1', iif: 'br-lan;ls' } },
};

// The fixture files of the rich scenario.
function rich() {
  const files = {
    [slug(ip(4, 'route show table all'))]: V4_ROUTES.join('\n') + '\n',
    [slug(ip(6, 'route show table all'))]: V6_ROUTES.join('\n') + '\n',
    [slug(ip(4, 'rule show'))]: V4_RULES.join('\n') + '\n',
    [slug(ip(6, 'rule show'))]: V6_RULES.join('\n') + '\n',
    [slug('command -v birdc')]: '/usr/sbin/birdc\n',
    [slug('pidof charon')]: '1234\n',
    'uci_network.json': JSON.stringify(UCI_NETWORK),
    'files.json': JSON.stringify({ '/etc/iproute2/rt_tables': RT_TABLES }),
  };
  for (const { args, get, fib } of Object.values(LOOKUPS)) {
    if (get === undefined) continue;
    const family = args.dst.includes(':') ? 6 : 4;
    const cmd = ip(family, `route get ${args.dst}${args.src ? ` from ${args.src}` : ''}${args.iif ? ` iif ${args.iif}` : ''}`);
    files[slug(`${cmd} 2>&1`)] = get;
    files[slug(`${cmd} fibmatch 2>&1`)] = fib;
  }
  return files;
}
//#endregion

const scenarios = { rich: rich(), noip: { 'files.json': '{}' } };
if (fs.existsSync(path.join(work, 'fx-real'))) {
  scenarios.real = Object.fromEntries(fs.readdirSync(path.join(work, 'fx-real')).map(f => [f, fs.readFileSync(path.join(work, 'fx-real', f), 'utf8').replace(/\r/g, '')]));
}
for (const [name, files] of Object.entries(scenarios)) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
}
fs.mkdirSync(path.join(work, 'lookups'), { recursive: true });
for (const [name, c] of Object.entries(LOOKUPS)) fs.writeFileSync(path.join(work, 'lookups', `${name}.json`), JSON.stringify(c.args));
fs.writeFileSync(path.join(work, 'scenarios.json'), JSON.stringify(Object.keys(scenarios)));
fs.writeFileSync(path.join(work, 'lookup-names.json'), JSON.stringify(Object.keys(LOOKUPS)));
console.log(`built ${Object.keys(scenarios).join(', ')} and ${Object.keys(LOOKUPS).length} lookup cases`);
