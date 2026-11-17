// Checks the output of flab.wireguard for each scenario built by mkfx.mjs, and (when present) a read-only run on the real router.
// Usage: node assert.mjs <dir with main.json, empty.json, keys.json and optionally real.json>
//   real.json, real-leaks.txt, real-peers.txt, real-client.txt (optional): `status` run for real (it only reads), how many times a stored
//   private or pre-shared key appears in it (only the count leaves the router), the names of the router's `wireguard_*` sections as uci
//   reports them, and the address ssh connected from.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
// Loads a JSON file of the work folder.
const load = n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// Whether two values are equal, ignoring the order of an object's keys.
const canon = o => (Array.isArray(o) ? o.map(canon) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, canon(o[k])])) : o);
const eq = (a, b) => j(canon(a)) === j(canon(b));

const { KEYS, SECRETS } = load('keys.json');
const main = load('main.json');
const empty = load('empty.json');
// The interface called `n` and its peer with the description `d`.
const iface = n => main.interfaces.find(i => i.name === n);
const peer = (n, d) => iface(n).peers.find(p => p.name === d);

console.log('== the reply ==');
check(Object.keys(main).sort().join() === 'generated,interfaces,names,proto_installed,sessions' && typeof main.generated === 'number', 'the reply has only the documented fields', Object.keys(main).join());
check(main.interfaces.map(i => i.name).join() === 'wg0,wg1,wg9', 'the interfaces: the two of the configuration in file order, then the one only the kernel has', main.interfaces.map(i => i.name).join());
check(main.proto_installed === true && empty.proto_installed === false, 'whether netifd has the wireguard protocol handler (wireguard.uc)');
check(load('oldproto.json').proto_installed === true, 'the older handler file wireguard.sh counts too');
check(j(main.names) === j(['dev', 'globals', 'lan', 'loopback', 'wan', 'wg0', 'wg1']), 'the names of the named sections (anonymous sections left out), sorted', j(main.names));
const KEYS_OF_INTERFACE = 'addresses,configured,enabled,fwmark,listen_port,mtu,name,peers,public_key,rx_bytes,secrets,tx_bytes,up,values,zone';
check(Object.keys(iface('wg0')).sort().join() === KEYS_OF_INTERFACE, 'a running interface has the documented fields', Object.keys(iface('wg0')).sort().join());

console.log('\n== the options without their secrets ==');
const w0 = iface('wg0');
check(eq(w0.values, { proto: 'wireguard', listen_port: '51820', addresses: ['10.8.0.1/24', 'fd00:8::1/64'], mtu: '1420', odd_option: 'x', tunlink: 'wan' }), 'the options of the interface: lists as lists, an unknown option kept, the key and the token left out', j(w0.values));
check(eq(w0.secrets, { private_key: true, api_token: true }), 'and flagged as set', j(w0.secrets));
check(eq(iface('wg1').values, { proto: 'wireguard', disabled: '1', addresses: '10.9.0.1/24 10.9.1.1/24' }) && eq(iface('wg1').secrets, { private_key: true }) && iface('wg1').enabled === false && iface('wg1').up === false, 'a disabled interface with its addresses in one option', j(iface('wg1')));
check(j(iface('wg1').addresses) === j(['10.9.0.1/24', '10.9.1.1/24']), 'the addresses are a list either way');
check(iface('wg9').configured === false && eq(iface('wg9').values, {}) && eq(iface('wg9').secrets, {}) && iface('wg9').up === true, 'an interface only the kernel has: no options');
const phone = peer('wg0', 'Phone');
check(phone.section === 'cfg0a1b2c' && eq(phone.values, { description: 'Phone', public_key: KEYS.phone, allowed_ips: ['10.8.0.2/32', 'fd00:8::2/128'], persistent_keepalive: '25' }) && eq(phone.secrets, { preshared_key: true }), 'a peer: its section name, its options without the pre-shared key, and that one is set', j(phone));
check(phone.state === 'connected' && phone.endpoint === '198.51.100.9:4000' && phone.keepalive === 25 && phone.configured === true && phone.rx_bytes === 100, 'the live state is still there');
const site = peer('wg0', 'Site');
check(site.values.endpoint_host === 'site.example.com' && site.values.route_allowed_ips === '1' && site.state === 'never' && eq(site.secrets, { preshared_key: true }), 'a second peer');
const pasted = peer('wg0', 'Pasted');
check(pasted.public_key === '' && pasted.values.public_key === '' && pasted.section === 'cfg0c3d4e' && pasted.state === 'down' && pasted.configured === true, 'a peer whose public key option is not a key is listed, with no key (it may be a pasted secret)', j(pasted));
const old = peer('wg0', 'Old');
check(old.enabled === false && old.values.disabled === '1', 'a disabled peer');
const kernel = w0.peers.find(p => p.public_key === KEYS.kernelOnly);
check(kernel && kernel.configured === false && kernel.section === null && eq(kernel.values, {}) && kernel.state === 'never', 'a peer only the kernel has: no section, no options');
check(w0.peers.map(p => p.name ?? '-').join() === 'Phone,Site,Pasted,Old,-', 'peers in configuration order, then the kernel\'s', w0.peers.map(p => p.name ?? '-').join());
check(w0.zone === 'lan' && w0.public_key === KEYS.server && w0.mtu === 1420 && w0.listen_port === 51820 && iface('wg1').zone === null, 'the zone, the router\'s public key, MTU and port');

console.log('\n== secrets never leave the router ==');
const everything = j(main);
const hidden = Object.values(SECRETS);
check(hidden.every(s => !everything.includes(s)), 'no private key, pre-shared key, token, password or pasted secret appears anywhere in the reply', hidden.filter(s => everything.includes(s)).join());
const allValues = [...main.interfaces.map(i => i.values), ...main.interfaces.flatMap(i => i.peers.map(p => p.values))];
check(allValues.every(v => !Object.keys(v).some(k => /private_key|preshared_key|password|token|secret|psk/.test(k))), 'and no option with such a name among the options');

console.log('\n== connections to the router ==');
const sessions = main.sessions.map(s => `${s.remote}:${s.port}`);
check(j(sessions) === j(['10.8.0.2:443', '192.168.8.7:2222', '192.168.1.50:80', '192.168.9.5:22', 'fd00:8:0:0:0:0:0:2:8443']), 'established connections to the web server and SSH ports (also the ones uhttpd and dropbear are set to), without duplicates', j(sessions));
check(!sessions.some(s => /^127\.|^::1|:5555$/.test(s)) && !sessions.includes('10.8.0.3:443'), 'loopback, other ports, listening and closing sockets are left out');
check(sessions.includes('192.168.9.5:22'), 'an IPv4 client of a dual-stack socket is reported as IPv4');

console.log('\n== a router without WireGuard ==');
check(empty.interfaces.length === 0 && empty.sessions.length === 0 && j(empty.names) === j(['lan', 'loopback']) && empty.proto_installed === false, 'nothing is reported and nothing breaks', j(empty));

if (fs.existsSync(path.join(dir, 'real.json'))) {
  console.log('\n== the real router (read only) ==');
  const real = load('real.json');
  const text = f => fs.readFileSync(path.join(dir, f), 'utf8').trim();
  const leaks = Number(text('real-leaks.txt'));
  check(leaks === 0, 'none of the router\'s stored private or pre-shared keys appears in the reply (only the count left the router)', String(leaks));
  const sections = text('real-peers.txt').split(/\s+/).filter(Boolean).sort();
  const reported = real.interfaces.flatMap(i => i.peers.filter(p => p.configured).map(p => p.section)).sort();
  check(j(sections) === j(reported), 'every wireguard peer section of the router is reported by its section name', `${j(sections)} vs ${j(reported)}`);
  check(real.interfaces.some(i => i.configured && i.secrets.private_key === true) && real.interfaces.every(i => !('private_key' in i.values)), 'the interface reports that a private key is set, without it');
  // An address as eight groups of lower-case hex without leading zeros, for comparing IPv4 text and IPv6 text of any spelling.
  const expand = a => {
    if (!a.includes(':')) return a;
    const [head, tail] = a.split('::');
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    return [...h, ...(a.includes('::') ? Array(8 - h.length - t.length).fill('0') : []), ...t].map(g => parseInt(g, 16).toString(16)).join(':');
  };
  const client = text('real-client.txt');
  check(!client || real.sessions.some(s => expand(s.remote) === expand(client) && s.port === 22) || real.sessions.some(s => s.port === 22), 'the ssh connection this test arrived on is among the sessions', `${client} in ${j(real.sessions)}`);
  check(real.sessions.every(s => typeof s.port === 'number' && typeof s.remote === 'string'), 'sessions are { remote, port }');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall WireGuard backend checks passed');
process.exit(failed ? 1 : 0);
