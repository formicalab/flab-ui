// Assertions of the Firewall backend test: the output of the repository's flab.firewall plugin for every scenario of mkfx.mjs (run on the router
// against fixtures, so nothing was executed), and a read-only run of the plugin on the real router. Usage: node assert.mjs <dir with out/>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
// The canary private key mkfx.mjs plants in the network config.
const CANARY = 'canary-private-key-0001';
let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// The reply of one scenario.
const read = name => JSON.parse(fs.readFileSync(path.join(dir, 'out', `${name}.json`), 'utf8'));
// The raw text of one scenario's reply.
const text = name => fs.readFileSync(path.join(dir, 'out', `${name}.json`), 'utf8');

console.log('== main ==');
{
  const r = read('main');
  check(r.running === true && r.engine === 'nftables', 'the firewall is reported as loaded');
  check(j(r.loaded_zones) === j(['lan', 'vpn', 'wan']), 'the zones that have a chain set are listed, sorted', j(r.loaded_zones));
  check(r.defaults.input === 'REJECT' && r.defaults.output === 'ACCEPT' && r.defaults.forward === 'REJECT' && r.defaults.synflood_protect && r.defaults.flow_offloading && r.defaults.flow_offloading_hw, 'the defaults (a policy written in lower case is reported upper case)', j(r.defaults));
  const vpn = r.zones.find(z => z.name === 'vpn'), lan = r.zones.find(z => z.name === 'lan'), wan = r.zones.find(z => z.name === 'wan');
  check(vpn.input === 'REJECT' && vpn.output === 'ACCEPT' && vpn.forward === 'REJECT', 'a zone without policies of its own takes the ones of the defaults section', j(vpn));
  check(lan.input === 'ACCEPT' && j(lan.forwards) === j(['wan']) && j(lan.networks) === j(['lan', 'lan100']), 'a disabled forwarding is not a way out of the zone');
  check(wan.masq && wan.mtu_fix && j(wan.devices) === j(['eth1']) && wan.blocked_from?.action === 'reject' && wan.blocked_from.packets === 11, 'zones keep their devices and the packets they turned away', j(wan));
  check(j(r.rules.map(x => x.section)) === j(['cfg05', 'cfg06', 'wg', 'cfg09']), 'every rule carries its section name, in file order, a named section included', j(r.rules.map(x => x.section)));
  check(j(r.rules.map(x => x.key)) === j(['Allow-Ping', '@rule[1]', 'Allow-WireGuard', '@rule[3]']), 'the key is the nft comment: the name, or @rule[N] counting rule sections', j(r.rules.map(x => x.key)));
  check(r.rules[0].hits.packets === 7 && r.rules[0].hits.bytes === 700, 'a rule that became two nft rules has its counters added', j(r.rules[0].hits));
  check(r.rules[1].hits.packets === 7 && r.rules[2].hits.packets === 9 && r.rules[3].enabled === false && r.rules[3].hits === null, 'counters are joined by comment; a disabled rule has none');
  check(j(r.redirects.map(x => x.section)) === j(['cfg0a', 'cfg0b', 'cfg0c']) && j(r.redirects.map(x => x.kind)) === j(['redirect', 'redirect', 'nat']), 'port forwards and NAT sections carry their section names and kinds', j(r.redirects.map(x => x.section)));
  check(r.redirects[0].hits.packets === 1 && r.redirects[1].key === '@redirect[1]' && r.redirects[2].target === 'SNAT' && r.redirects[2].dest_ip === '203.0.113.5', 'redirect keys count their own type; a nat section reports its snat address', j(r.redirects));
  check(r.includes.length === 1 && r.ipsets === 1 && r.flowtable.devices.length === 2 && r.conntrack.count === 10 && r.conntrack.max === 100, 'includes, ipsets, the flowtable and connection tracking');
  check(j(r.networks.map(n => n.name)) === j(['guest', 'lan', 'lan100', 'loopback', 'wan', 'wan6', 'wg0']), 'the interfaces of the router (devices are not interfaces)', j(r.networks.map(n => n.name)));
  const net = n => r.networks.find(x => x.name === n);
  check(j(net('lan').addrs) === j(['192.168.1.1', 'fd00::1']) && j(net('wan6').addrs) === j([]) && net('guest').disabled === true && net('wg0').proto === 'wireguard' && j(net('wg0').addrs) === j([]), 'each with the router\'s own addresses, whether it is disabled, and its protocol', j(r.networks));
  check(j(r.unzoned) === j(['wg0']), 'interfaces in no zone: not loopback, not disabled ones', j(r.unzoned));
  check(!text('main').includes(CANARY), 'a private key in the network config is never in the reply');
  check(Object.keys(r.networks[0]).sort().join() === 'addrs,disabled,name,proto', 'an interface is reported with exactly those four fields', Object.keys(r.networks[0]).join());
}

console.log('\n== other routers ==');
{
  const r = read('nodefaults');
  check(r.defaults.input === 'DROP' && r.defaults.synflood_protect === false, 'without a defaults section the firewall drops', j(r.defaults));
  const lan = r.zones.find(z => z.name === 'lan'), wan = r.zones.find(z => z.name === 'wan');
  check(lan.input === 'DROP' && lan.output === 'DROP' && wan.input === 'REJECT', 'a zone without a policy drops, one with its own keeps it', j([lan.input, wan.input]));
  check(read('legacy').defaults.synflood_protect === true, 'the older syn_flood option counts as SYN-flood protection');
  const s = read('stopped');
  check(s.running === false && s.loaded_zones === null && s.rules.every(x => x.hits === null) && s.hooks === null, 'without a fw4 table: not running, no loaded zones, no counters', j([s.running, s.loaded_zones]));
  check(s.rules.length === 4 && s.rules[0].section === 'cfg05', 'the configuration is still reported');
  const n = read('nonet');
  check(n.networks.length === 7 && n.networks.every(x => x.addrs.length === 0), 'without a netifd dump the interfaces are listed without addresses', j(n.networks));
  check(j(read('partial').loaded_zones) === j(['lan', 'wan']), 'a zone the firewall did not load is missing from loaded_zones');
}

console.log('\n== the real router (read only) ==');
{
  const real = read('real');
  const facts = Object.fromEntries(fs.readFileSync(path.join(dir, 'out', 'real-facts.txt'), 'utf8').split('\n').filter(Boolean).map(l => l.split('=')));
  check(real.rules.length === +facts.rules && real.zones.length === +facts.zones && real.redirects.length === +facts.redirects, 'the plugin finds as many rules, zones and port forwards as uci show does', j([real.rules.length, facts.rules, real.zones.length, facts.zones, real.redirects.length, facts.redirects]));
  check(real.rules.every(x => /^[A-Za-z0-9_]+$/.test(x.section)) && new Set(real.rules.map(x => x.section)).size === real.rules.length, 'every rule has a distinct section name');
  check(real.networks.length >= 1 && real.networks.every(n => n.name && Array.isArray(n.addrs)) && Array.isArray(real.loaded_zones) === real.running, 'interfaces are listed, and loaded_zones is there when the firewall is loaded', j(real.loaded_zones));
  check(!real.running || real.zones.filter(z => z.enabled).every(z => real.loaded_zones.includes(z.name)), 'every enabled zone of the router has its chains loaded', j(real.loaded_zones));
  check(+facts.privatekeys === 0, 'no private key of the router appears in the reply', facts.privatekeys);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall firewall backend checks passed');
process.exit(failed ? 1 : 0);
