// Unit test of the WireGuard page's pure parts (www/js/pages/wireguard): the address math (addr.js), the keys (keys.js), and the
// model (model.js, schema.js): reading the plugin's reply, the draft, the review list, validation, the UCI operations, the check after a
// save, the warnings about cutting your own tunnel, and the "add a client" helpers. No router and no browser. Usage: node model.test.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Imports one module of the page.
const mod = f => import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/wireguard', f)).href);
const a = await mod('addr.js');
const k = await mod('keys.js');
const m = await mod('model.js');
const { IFACE_FIELDS, PEER_FIELDS } = await mod('schema.js');

let failed = 0;
// Prints PASS or FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

//#region Addresses
console.log('== addresses ==');
const c4 = a.parseCidr('192.168.8.5/24');
check(c4.family === 4 && c4.prefix === 24 && a.networkText(c4) === '192.168.8.0/24' && a.addressText(c4) === '192.168.8.5', 'an IPv4 CIDR: network and host address');
check(a.parseCidr('fd00:8::2/64').family === 6 && a.networkText(a.parseCidr('fd00:8::2/64')) === 'fd00:8::/64', 'an IPv6 CIDR');
check(a.parseCidr('10.0.0.1') === null && a.parseCidr('10.0.0.1', { bare: true }).prefix === 32 && a.parseCidr('fd00::1', { bare: true }).prefix === 128, 'a prefix is required unless a bare host is allowed');
check(a.parseCidr('10.0.0.1/33') === null && a.parseCidr('fd00::1/129') === null && a.parseCidr('10.0.0.1/-1') === null && a.parseCidr('10.0.0.256/24') === null && a.parseCidr('x/24') === null && a.parseCidr('10.0.0.1/24/1') === null, 'bad prefixes and addresses are refused');
check(a.parseCidr('192.168.1.1/255.255.255.0', { mask: true })?.prefix === 24 && a.parseCidr('192.168.1.1/255.255.255.0') === null && a.parseCidr('192.168.1.1/255.0.255.0', { mask: true }) === null, 'a dotted netmask is accepted only where netifd takes one, and only if it is a real netmask');
check(a.formatAddress(6, a.parseCidr('2001:0db8:0:0:1:0:0:1', { bare: true }).value) === '2001:db8::1:0:0:1' && a.formatAddress(6, 0n) === '::' && a.formatAddress(6, 1n) === '::1' && a.formatAddress(6, a.parseCidr('fd00:0:0:0:0:0:0:2', { bare: true }).value) === 'fd00::2', 'IPv6 text uses the longest run of zeros');
check(a.overlaps(a.parseCidr('10.0.0.0/24'), a.parseCidr('10.0.0.128/25')) && !a.overlaps(a.parseCidr('10.0.0.0/24'), a.parseCidr('10.0.1.0/24')) && !a.overlaps(a.parseCidr('10.0.0.0/8'), a.parseCidr('fd00::/8')), 'overlap, also across families');
check(a.covers(a.parseCidr('0.0.0.0/0'), a.parseCidr('8.8.8.8/32')) && !a.covers(a.parseCidr('10.0.0.0/25'), a.parseCidr('10.0.0.0/24')), 'covers');
const net = a.parseCidr('10.8.0.1/24');
check(a.nextFreeHost(net, []) === '10.8.0.2/32', 'the first client address is the one after the router\'s');
check(a.nextFreeHost(net, ['10.8.0.2/32', '10.8.0.3/32'].map(x => a.parseCidr(x))) === '10.8.0.4/32', 'addresses that peers hold are skipped');
check(a.nextFreeHost(net, [a.parseCidr('10.8.0.0/25')]) === '10.8.0.128/32', 'so is everything a broader allowed IP covers');
check(a.nextFreeHost(a.parseCidr('10.8.0.254/24'), []) === '10.8.0.1/32', 'at the end of the network it wraps to the first host (not the broadcast address)', a.nextFreeHost(a.parseCidr('10.8.0.254/24'), []));
check(a.nextFreeHost(a.parseCidr('10.8.0.1/31'), []) === null && a.nextFreeHost(a.parseCidr('10.8.0.1/30'), [a.parseCidr('10.8.0.2/32')]) === null, 'a network with no room gives nothing (a /31, and a /30 whose one other host is taken)');
check(a.nextFreeHost(a.parseCidr('fd00:8::1/64'), []) === 'fd00:8::2/128', 'IPv6 clients get the next address too');
check(a.endpointProblems('vpn.example.com').length === 0 && a.endpointProblems('203.0.113.7').length === 0 && a.endpointProblems('2001:db8::1').length === 0, 'ordinary endpoints are fine');
check(a.endpointProblems('127.0.0.1').length === 1 && a.endpointProblems('0.0.0.0').length === 1 && a.endpointProblems('169.254.1.1').length === 1 && a.endpointProblems('224.0.0.1').length === 1 && a.endpointProblems('::1').length === 1 && a.endpointProblems('::').length === 1 && a.endpointProblems('fe80::1').length === 1 && a.endpointProblems('[::1]').length === 1, 'loopback, unspecified, link-local and multicast endpoints are called out');
check(a.endpointProblems('localhost').length === 1 && a.endpointProblems('router').length === 1 && a.endpointProblems('nas.local').length === 1 && a.endpointProblems('nas.lan').length === 1, 'so are names that cannot be public');
check(a.endpointProblems('10.8.0.9', [a.parseCidr('10.8.0.0/24')]).length === 1 && a.endpointProblems('10.9.0.9', [a.parseCidr('10.8.0.0/24')]).length === 0, 'an endpoint inside the router\'s own tunnel network is called out');
check(a.isHostname('vpn.example.com') && a.isHostname('a-b.c1') && !a.isHostname('bad host') && !a.isHostname('-a.com') && !a.isHostname('a..com') && !a.isHostname(''), 'host names');
//#endregion

//#region Keys
console.log('\n== keys ==');
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const out = k.x25519(hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'), hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'));
check(Buffer.from(out).toString('hex') === 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552', 'X25519 in plain JavaScript gives the RFC 7748 test vector');
// RFC 7748 section 6.1: Alice's private key and public key.
const alicePriv = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
check(Buffer.from(k.publicFromPrivateJs(alicePriv)).toString('hex') === '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'the public key of the RFC 7748 private key');
check(k.isKey(k.toBase64(alicePriv)) && k.isKey(`${'A'.repeat(42)}A=`) && !k.isKey('') && !k.isKey('abc') && !k.isKey('A'.repeat(43)) && !k.isKey(`${'A'.repeat(42)}B=`) && !k.isKey(`${'*'.repeat(43)}=`), 'a key is 43 base64 characters, a final character that carries four zero bits, and "="');
const support = await k.keySupport();
check(support === 'webcrypto' || support === 'js', 'this runtime can make keys', String(support));
const pair = await k.generateKeyPair();
check(k.isKey(pair.privateKey) && k.isKey(pair.publicKey) && pair.privateKey !== pair.publicKey, 'a generated pair is two valid keys');
check(k.toBase64(k.publicFromPrivateJs(k.fromBase64(pair.privateKey))) === pair.publicKey && await k.publicKeyOf(pair.privateKey) === pair.publicKey, 'the public key of the generated private key is the one reported, by WebCrypto and by the plain implementation');
const raw = k.fromBase64(pair.privateKey);
check((raw[0] & 7) === 0 && (raw[31] & 128) === 0 && (raw[31] & 64) === 64, 'the private key is clamped like wg genkey does');
check(k.isKey(k.generatePresharedKey()) && k.generatePresharedKey() !== k.generatePresharedKey(), 'a pre-shared key is 32 random bytes');
//#endregion

//#region The plugin's reply and the draft
// A valid key from a number, for fixtures.
const key = n => k.toBase64(Uint8Array.from({ length: 32 }, (_, i) => (n * 37 + i * 11) & 255));
const SERVER = key(1), PHONE = key(2), SITE = key(3), OFF = key(4), NEW = key(5);
const NOW = 1794600000;
// A reply of flab.wireguard status like the real router's: one interface with a phone (connected), a site and a disabled peer; the
// router's web interface is in use from the phone's tunnel address.
const status = () => ({
  generated: NOW, proto_installed: true, names: ['globals', 'lan', 'loopback', 'wan', 'wg0'], sessions: [{ remote: '10.8.0.2', port: 443 }],
  interfaces: [{
    name: 'wg0', configured: true, enabled: true, up: true, zone: 'lan', listen_port: 51820, mtu: 1420, addresses: ['10.8.0.1/24', 'fd00:8::1/64'], public_key: SERVER, rx_bytes: 10, tx_bytes: 20,
    values: { proto: 'wireguard', listen_port: '51820', addresses: ['10.8.0.1/24', 'fd00:8::1/64'], odd_option: 'x' }, secrets: { private_key: true },
    peers: [
      { name: 'Phone', public_key: PHONE, section: 'cfg111111', values: { description: 'Phone', public_key: PHONE, allowed_ips: ['10.8.0.2/32', 'fd00:8::2/128'], persistent_keepalive: '25' }, secrets: { preshared_key: true }, endpoint: '198.51.100.9:4000', allowed_ips: ['10.8.0.2/32', 'fd00:8::2/128'], route_allowed_ips: false, keepalive: 25, handshake_age: 20, state: 'connected', configured: true, enabled: true },
      { name: 'Site', public_key: SITE, section: 'cfg222222', values: { description: 'Site', public_key: SITE, allowed_ips: ['192.168.8.0/24'], route_allowed_ips: '1', endpoint_host: 'site.example.com', endpoint_port: '51820' }, secrets: {}, endpoint: 'site.example.com:51820', allowed_ips: ['192.168.8.0/24'], route_allowed_ips: true, keepalive: null, handshake_age: 300, state: 'stale', configured: true, enabled: true },
      { name: 'Old', public_key: OFF, section: 'cfg333333', values: { description: 'Old', public_key: OFF, allowed_ips: ['10.8.0.9/32'], disabled: '1' }, secrets: {}, endpoint: null, allowed_ips: ['10.8.0.9/32'], route_allowed_ips: false, keepalive: null, handshake_age: null, state: 'down', configured: true, enabled: false },
    ],
  }],
});
const data0 = m.readWireguard(status());
check(data0.interfaces.length === 1 && data0.names.includes('lan') && data0.sessions.length === 1 && data0.protoInstalled === true, 'the reply is read');
const old = m.readWireguard({ generated: 1, interfaces: [{ name: 'wg0', configured: true, enabled: true, up: false, peers: [{ public_key: PHONE, configured: true, enabled: true }] }] });
check(old.interfaces[0].values && old.interfaces[0].peers[0].section === null && old.names.length === 0 && old.sessions.length === 0 && old.protoInstalled === true && m.readWireguard(null).interfaces.length === 0, 'a reply from a plugin without the new fields still reads');
const draft0 = () => m.draftFrom(data0);
check(m.changesOf(data0, draft0()).length === 0 && !m.isDirty(data0, draft0()) && m.plan(data0, draft0()).length === 0, 'the draft starts equal to the router: nothing to change, nothing to write');
const d0 = draft0();
check(j(d0.interfaces.wg0.values.addresses) === j(['10.8.0.1/24', 'fd00:8::1/64']) && d0.interfaces.wg0.values.private_key === '' && d0.interfaces.wg0.values.disabled === false && Object.keys(d0.interfaces.wg0.peers).join() === 'cfg111111,cfg222222,cfg333333' && d0.interfaces.wg0.peers.cfg222222.route_allowed_ips === true && d0.interfaces.wg0.peers.cfg333333.disabled === true, 'the form values come from the options; a key field is empty');
check(m.ifaceList(data0, d0).length === 1 && m.peerList(m.ifaceList(data0, d0)[0], d0).length === 3 && m.peerList(m.ifaceList(data0, d0)[0], d0).every(p => p.editable), 'one interface with three editable peers');
const kernelOnly = clone(status());
kernelOnly.interfaces.push({ name: 'wg9', configured: false, enabled: true, up: true, listen_port: 51821, addresses: [], peers: [{ public_key: key(9), configured: false, enabled: true, state: 'never', allowed_ips: [] }] });
const dk = m.readWireguard(kernelOnly);
check(m.ifaceList(dk, m.draftFrom(dk)).find(i => i.name === 'wg9').editable === false && !m.draftFrom(dk).interfaces.wg9 && m.plan(dk, m.draftFrom(dk)).length === 0, 'an interface only the kernel has is listed but is not editable');
//#endregion

//#region Review and the UCI plan
console.log('\n== review and plan ==');
// Applies edits to a fresh draft and returns the draft.
const edited = fn => { const d = draft0(); fn(d, d.interfaces.wg0); return d; };
let d = edited((_, w) => { w.values.listen_port = '51821'; w.values.addresses.push('10.9.0.1/24'); w.values.mtu = '1380'; });
let ch = m.changesOf(data0, d);
check(ch.map(c => c.label).join() === 'wg0: Listen port,wg0: Addresses,wg0: MTU' && ch[0].from === '51820' && ch[0].to === '51821' && /10\.9\.0\.1\/24/.test(ch[1].to), 'the review lists the changed options with before and after', j(ch));
check(j(m.plan(data0, d)) === j([{ op: 'set', config: 'network', section: 'wg0', values: { listen_port: '51821', addresses: ['10.8.0.1/24', 'fd00:8::1/64', '10.9.0.1/24'], mtu: '1380' } }]), 'the plan writes only what changed, lists as lists', j(m.plan(data0, d)));
d = edited((_, w) => { w.values.mtu = ''; w.values.listen_port = ''; });
check(j(m.plan(data0, d)) === j([{ op: 'delete', config: 'network', section: 'wg0', options: ['listen_port'] }]), 'an emptied option is deleted, and only when it exists (the MTU never was)', j(m.plan(data0, d)));
d = edited((_, w) => { w.values.private_key = 'typed'; });
ch = m.changesOf(data0, d);
check(ch.length === 1 && ch[0].from === 'set (hidden)' && ch[0].to === 'new value (hidden)' && !j(ch).includes('typed') && j(m.plan(data0, d)) === j([{ op: 'set', config: 'network', section: 'wg0', values: { private_key: 'typed' } }]), 'a private key is written only when typed, and the review never shows it');
d = edited((_, w) => { w.peers.cfg111111.preshared_key = 'psk'; w.peers.cfg222222.persistent_keepalive = '25'; w.peers.cfg222222.route_allowed_ips = false; w.peers.cfg111111.disabled = true; });
const pl = m.plan(data0, d);
check(pl.length === 2 && j(pl[0]) === j({ op: 'set', config: 'network', section: 'cfg111111', values: { disabled: '1', preshared_key: 'psk' } }) && j(pl[1]) === j({ op: 'set', config: 'network', section: 'cfg222222', values: { route_allowed_ips: '0', persistent_keepalive: '25' } }), 'peer edits are written to the peer\'s own section', j(pl));
check(m.changesOf(data0, d).some(c => c.label === 'wg0 peer Phone: Pre-shared key' && c.to === 'new value (hidden)') && m.changesOf(data0, d).some(c => c.label === 'wg0 peer Site: Keepalive (seconds)'), 'and reviewed under the peer\'s name');
d = edited(dd => { m.removePeer(dd, 'wg0', 'cfg333333'); });
check(j(m.plan(data0, d)) === j([{ op: 'delete', config: 'network', section: 'cfg333333' }]) && /Remove peer Old from wg0/.test(m.changesOf(data0, d)[0].label), 'a removed peer is deleted by its section');
d = edited(dd => { m.removePeer(dd, 'wg0', 'cfg333333'); m.restorePeer(dd, 'wg0', 'cfg333333'); });
check(m.plan(data0, d).length === 0, 'Undo takes it back');
d = edited(dd => { const id = m.addPeer(dd, 'wg0', { description: 'Tablet', public_key: NEW, allowed_ips: ['10.8.0.3/32'] }); dd.interfaces.wg0.peers[id].preshared_key = 'p'; });
check(j(m.plan(data0, d)) === j([{ op: 'add', config: 'network', type: 'wireguard_wg0', values: { description: 'Tablet', public_key: NEW, preshared_key: 'p', allowed_ips: ['10.8.0.3/32'] } }]), 'a new peer is an anonymous wireguard_<interface> section with only the options that are set', j(m.plan(data0, d)));
d = edited(dd => { const id = m.addPeer(dd, 'wg0'); m.removePeer(dd, 'wg0', id); });
check(m.plan(data0, d).length === 0 && !m.isDirty(data0, d), 'a peer added and discarded in the form leaves nothing');
d = edited(dd => { m.removeInterface(dd, 'wg0'); });
check(j(m.plan(data0, d).map(o => `${o.op}:${o.section}`)) === j(['delete:cfg111111', 'delete:cfg222222', 'delete:cfg333333', 'delete:wg0']) && /Remove interface wg0/.test(m.changesOf(data0, d)[0].label), 'removing an interface deletes its peers and then the interface');
d = draft0();
const id = m.addInterface(data0, d);
check(d.added[0].name === 'wg1' && d.interfaces[id].values.listen_port === '51821' && d.interfaces[id].values.addresses.length === 1, 'a new interface gets the next free name and port', j(d.added));
d.added[0].name = 'vpn2';
d.interfaces[id].values.private_key = PHONE;
d.interfaces[id].values.addresses = ['10.9.0.1/24'];
d.interfaces[id].values.nohostroute = true;
m.addPeer(d, id, { description: 'A', public_key: NEW, allowed_ips: ['10.9.0.2/32'], route_allowed_ips: true });
const pl2 = m.plan(data0, d);
check(j(pl2[0]) === j({ op: 'add', config: 'network', type: 'interface', name: 'vpn2', values: { proto: 'wireguard', private_key: PHONE, listen_port: '51821', addresses: ['10.9.0.1/24'], nohostroute: '1' } }) && j(pl2[1]) === j({ op: 'add', config: 'network', type: 'wireguard_vpn2', values: { description: 'A', public_key: NEW, allowed_ips: ['10.9.0.2/32'], route_allowed_ips: '1' } }), 'a new interface is added by name with proto wireguard, then its peers', j(pl2));
check(!j(m.changesOf(data0, d)).includes(PHONE) && m.changesOf(data0, d).length === 2, 'the review of a new interface does not show its key', j(m.changesOf(data0, d)));
m.removeInterface(d, id);
check(m.plan(data0, d).length === 0, 'discarding a new interface drops it with its peers');
//#endregion

//#region Validation
console.log('\n== validation ==');
// The error and warning texts of an edited draft, joined, and the keys of the errors.
const prob = dd => m.problems(data0, dd);
const errs = dd => prob(dd).errors.map(e => e.text).join(' | ');
const warns = dd => prob(dd).warnings.join(' | ');
check(prob(draft0()).errors.length === 0, 'the router\'s own configuration has no errors');
check(/Listen port must be at most 65535/.test(errs(edited((_, w) => { w.values.listen_port = '70000'; }))) && /Listen port must be a whole number/.test(errs(edited((_, w) => { w.values.listen_port = 'abc'; }))) && prob(edited((_, w) => { w.values.listen_port = '0'; })).errors.length === 1, 'the listen port is a number from 1 to 65535');
check(/"10\.8\.0\.300\/24" is not an address with a prefix length/.test(errs(edited((_, w) => { w.values.addresses[0] = '10.8.0.300/24'; }))) && prob(edited((_, w) => { w.values.addresses[0] = '10.8.0.1/24'; w.values.addresses.push('10.8.0.1/24'); })).errors.some(e => /listed twice/.test(e.text) && e.index === 2), 'an address needs a valid prefix; a repeated one is marked');
check(prob(edited((_, w) => { w.values.addresses.push('192.168.1.1/255.255.255.0'); })).errors.length === 0, 'a dotted netmask is accepted for an interface address');
check(/must be a number, decimal or hexadecimal/.test(errs(edited((_, w) => { w.values.fwmark = 'zz'; }))) && prob(edited((_, w) => { w.values.fwmark = '0x51820'; })).errors.length === 0, 'the firewall mark is a number');
check(/MTU must be at least 68/.test(errs(edited((_, w) => { w.values.mtu = '10'; }))), 'the MTU has a range');
check(/must be a WireGuard key/.test(errs(edited((_, w) => { w.values.private_key = 'short'; }))) && prob(edited((_, w) => { w.values.private_key = SITE; })).errors.length === 0, 'a typed private key must look like one');
check(/a new private key means a new public key/.test(warns(edited((_, w) => { w.values.private_key = SITE; }))) && /Your connection through it would break/.test(warns(edited((_, w) => { w.values.private_key = SITE; }))), 'replacing a stored key warns, and says so when it is your own tunnel');
check(/public key must be 44 characters/.test(errs(edited((_, w) => { w.peers.cfg111111.public_key = 'nope'; }))) && /enter the peer's public key/.test(errs(edited((_, w) => { w.peers.cfg111111.public_key = ''; }))), 'a peer needs a public key that is a key');
check(/same public key/.test(errs(edited((_, w) => { w.peers.cfg111111.public_key = SITE; }))), 'two peers of one interface may not share a public key');
check(/public key of the interface itself/.test(errs(edited((_, w) => { w.peers.cfg111111.public_key = SERVER; }))), 'a peer may not be the interface itself');
check(/pre-shared key must be 44 characters/.test(errs(edited((_, w) => { w.peers.cfg111111.preshared_key = 'x'; }))), 'a typed pre-shared key must look like one');
check(/"10\.8\.0\.2" is not an address with a prefix length/.test(errs(edited((_, w) => { w.peers.cfg111111.allowed_ips[0] = '10.8.0.2'; }))) && /"nope\/32"/.test(errs(edited((_, w) => { w.peers.cfg111111.allowed_ips[0] = 'nope/32'; }))), 'allowed IPs need a prefix length (netifd cannot route a bare address)');
check(/Endpoint port must be at most 65535/.test(errs(edited((_, w) => { w.peers.cfg222222.endpoint_port = '99999'; }))) && /Keepalive \(seconds\) must be at most 65535/.test(errs(edited((_, w) => { w.peers.cfg222222.persistent_keepalive = '99999'; }))), 'the peer\'s numbers have ranges');
check(/not a host name or an IP address/.test(errs(edited((_, w) => { w.peers.cfg222222.endpoint_host = 'bad host'; }))) && /without square brackets/.test(errs(edited((_, w) => { w.peers.cfg222222.endpoint_host = '[2001:db8::1]'; }))) && prob(edited((_, w) => { w.peers.cfg222222.endpoint_host = '2001:db8::1'; })).errors.length === 0, 'the endpoint is a host name or an IP address, an IPv6 one without brackets');
const dup = draft0();
const id2 = m.addInterface(data0, dup);
dup.interfaces[id2].values.listen_port = '51820';
dup.interfaces[id2].values.private_key = PHONE;
check(prob(dup).errors.some(e => /also the listen port of wg0/.test(e.text) && e.key === `if:${id2}:listen_port` && e.also === 'if:wg0:listen_port'), 'two enabled interfaces may not share a listen port; both controls are marked');
dup.interfaces[id2].values.disabled = true;
check(!/listen port of/.test(errs(dup)), 'a disabled interface may share it');
const nm = draft0();
const id3 = m.addInterface(data0, nm);
nm.interfaces[id3].values.private_key = PHONE;
// The error for the new interface's name when it is typed as `n`.
const nameErr = n => { nm.added[0].name = n; return m.nameError(data0, nm, id3); };
check(nameErr('') && nameErr('wg-1') && nameErr('a'.repeat(16)) && nameErr('wg0') && nameErr('lan') && nameErr('loopback') && nameErr('lo') && nameErr('globals') && nameErr('my vpn'), 'an interface name must be new, short and made of letters, digits and underscores (any named section is taken)');
check(nameErr('vpn_2') === null && nameErr('a'.repeat(15)) === null, 'a good name');
check(!/needs a private key/.test(errs(nm)), 'the new interface has the key generated by the page');
nm.interfaces[id3].values.private_key = '';
check(/an interface needs a private key/.test(errs(nm)), 'a new interface needs a key');
check(!/no private key/.test(warns(draft0())), 'a stored key is enough');
const nokey = clone(status());
nokey.interfaces[0].secrets = {};
check(/has no private key, so it cannot start/.test(m.problems(m.readWireguard(nokey), m.draftFrom(m.readWireguard(nokey))).warnings.join()), 'an existing interface without a key is a warning, not an error');
check(/is in no firewall zone yet/.test(warns(nm)) && /has no address/.test(warns(nm)), 'a new interface is warned about the firewall zone and a missing address');
check(/no prefix length/.test(warns(edited((_, w) => { w.values.addresses.push('10.9.0.1'); }))), 'an address without a prefix is a warning (a single host)');
const clash = draft0();
const idc = m.addInterface(data0, clash);
clash.interfaces[idc].values.addresses = ['10.8.0.5/24'];
clash.interfaces[idc].values.private_key = PHONE;
clash.interfaces[idc].values.listen_port = '51900';
check(/overlaps the one of wg0/.test(m.problems(data0, clash).warnings.join()), 'overlapping tunnel networks of two interfaces are called out');
check(/MTU above 1420/.test(warns(edited((_, w) => { w.values.mtu = '1500'; }))) && /MTU below 1280 is too small for IPv6/.test(warns(edited((_, w) => { w.values.mtu = '1200'; }))), 'MTU warnings');
check(/without a listen port WireGuard picks a random one/.test(warns(edited((_, w) => { w.values.listen_port = ''; }))), 'no listen port on a router that peers connect to is a warning');
// Peers' warnings.
check(/0\.0\.0\.0\/0 makes this peer the default route/.test(warns(edited((_, w) => { w.peers.cfg222222.allowed_ips.push('0.0.0.0/0'); }))), '0.0.0.0/0 with routes on is the default route');
check(/no route is created for it/.test(warns(edited((_, w) => { w.peers.cfg111111.allowed_ips.push('::/0'); }))), 'a /0 without routes is explained');
check(/no routes are created for these networks/.test(warns(edited((_, w) => { w.peers.cfg222222.route_allowed_ips = false; }))), 'a site peer without routes is warned about');
check(/the peers Phone and Site overlap/.test(warns(edited((_, w) => { w.peers.cfg222222.allowed_ips.push('10.8.0.0/24'); }))) && /broader one only gets/.test(warns(edited((_, w) => { w.peers.cfg222222.allowed_ips.push('10.8.0.0/24'); }))), 'a network that holds another peer\'s address is a warning');
check(/belong to one peer only/.test(warns(edited((_, w) => { w.peers.cfg222222.allowed_ips.push('10.8.0.2/32'); }))), 'the same address for two peers is a warning that says which wins');
check(!/overlap/.test(warns(edited((_, w) => { w.peers.cfg333333.allowed_ips = ['10.8.0.2/32']; }))), 'a disabled peer does not count');
check(/no allowed IPs/.test(warns(edited((_, w) => { w.peers.cfg222222.allowed_ips = []; }))), 'a peer without allowed IPs is a warning');
check(/endpoint 127\.0\.0\.1 is this router itself/.test(warns(edited((_, w) => { w.peers.cfg222222.endpoint_host = '127.0.0.1'; }))) && /inside one of this router's own tunnel networks/.test(warns(edited((_, w) => { w.peers.cfg222222.endpoint_host = '10.8.0.77'; }))) && /name without a dot/.test(warns(edited((_, w) => { w.peers.cfg222222.endpoint_host = 'router'; }))), 'an endpoint that does not look reachable is warned about');
check(/endpoint port is set but no endpoint host/.test(warns(edited((_, w) => { w.peers.cfg111111.endpoint_port = '51820'; }))), 'a port without a host is a warning');
//#endregion

//#region Changes that cut your own tunnel
console.log('\n== your own tunnel ==');
const links = m.adminLinks(data0);
check(links.length === 1 && links[0].iface === 'wg0' && links[0].peer.name === 'Phone' && links[0].remote === '10.8.0.2' && links[0].port === 443, 'a web session from the phone\'s tunnel address is attributed to the phone\'s peer', j(links));
const lan = clone(status()); lan.sessions = [{ remote: '192.168.1.50', port: 443 }, { remote: '203.0.113.5', port: 22 }, { remote: '10.8.0.99', port: 443 }];
check(m.adminLinks(m.readWireguard(lan)).length === 0, 'sessions from outside every peer\'s allowed IPs are not tunnel sessions');
const site = clone(status()); site.sessions = [{ remote: '192.168.8.7', port: 22 }];
check(m.adminLinks(m.readWireguard(site)).length === 1 && m.adminLinks(m.readWireguard(site))[0].peer.name === 'Site', 'a session from a network behind a site peer is attributed to that peer');
const full = clone(status()); full.interfaces[0].peers[1].allowed_ips = ['0.0.0.0/0']; full.sessions = [{ remote: '192.168.1.50', port: 443 }];
check(m.adminLinks(m.readWireguard(full)).length === 0, 'a /0 peer does not claim every session');
const v6 = clone(status()); v6.sessions = [{ remote: 'fd00:8:0:0:0:0:0:2', port: 22 }];
check(m.adminLinks(m.readWireguard(v6)).length === 1 && m.adminLinks(m.readWireguard(v6))[0].peer.name === 'Phone', 'an IPv6 session matches an IPv6 allowed IP written another way');
const down = clone(status()); down.interfaces[0].up = false;
check(m.adminLinks(m.readWireguard(down)).length === 0, 'an interface that is not running carries no session');
const rm = warns(edited(dd => { m.removeInterface(dd, 'wg0'); }));
check(/Removing wg0 cuts your own connection\. This looks like your own connection: the router's web interface or SSH is in use from 10\.8\.0\.2, an address of peer Phone on wg0/.test(rm), 'removing the interface that carries your session says so, and names the peer', rm);
check(/Removing peer Phone from wg0 cuts your own connection/.test(warns(edited(dd => { m.removePeer(dd, 'wg0', 'cfg111111'); }))), 'so does removing that peer');
check(!/connected right now/.test(warns(edited(dd => { m.removePeer(dd, 'wg0', 'cfg222222'); }))), 'a peer that is stale is not "connected right now"');
const noSessions = clone(status()); noSessions.sessions = [];
const dn = m.readWireguard(noSessions);
const dnd = m.draftFrom(dn); m.removePeer(dnd, 'wg0', 'cfg111111');
check(/Peer Phone is connected right now; removing it from wg0 disconnects it/.test(m.problems(dn, dnd).warnings.join()) && !/your own connection/.test(m.problems(dn, dnd).warnings.join()), 'without a session the warning is generic');
const dni = m.draftFrom(dn); m.removeInterface(dni, 'wg0');
check(/disconnects its 1 connected peer/.test(m.problems(dn, dni).warnings.join()) && /listed in the firewall zone lan/.test(m.problems(dn, dni).warnings.join()), 'removing an interface with connected peers is a generic warning, and the zone that names it is mentioned');
check(/Disabling peer Phone on wg0 cuts your own connection/.test(warns(edited((_, w) => { w.peers.cfg111111.disabled = true; }))), 'disabling the peer');
check(/Disabling wg0 cuts your own connection/.test(warns(edited((_, w) => { w.values.disabled = true; }))), 'disabling the interface');
check(/Applying a change to wg0 restarts the tunnel/.test(warns(edited((_, w) => { w.peers.cfg222222.persistent_keepalive = '25'; }))) && !/restarts the tunnel/.test(warns(draft0())), 'any change to a tunnel that carries your session says it restarts');
//#endregion

//#region The check after a save
console.log('\n== the check after a save ==');
// A reply of the plugin after a save that kept `draft` (the router's config rebuilt from the draft).
const applied = draft => {
  const reply = clone(status());
  const w = reply.interfaces[0];
  const dv = draft.interfaces.wg0.values;
  w.values = { proto: 'wireguard', ...(dv.listen_port ? { listen_port: dv.listen_port } : {}), addresses: dv.addresses.filter(Boolean), ...(dv.mtu ? { mtu: dv.mtu } : {}), ...(dv.disabled ? { disabled: '1' } : {}) };
  if (dv.private_key) w.secrets.private_key = true;
  w.peers = Object.entries(draft.interfaces.wg0.peers).filter(([pid]) => !draft.interfaces.wg0.removed[pid]).map(([pid, v]) => ({
    name: v.description, public_key: v.public_key, section: pid.startsWith('p') ? `cfg9${pid}` : pid, configured: true, enabled: !v.disabled, state: 'never', allowed_ips: v.allowed_ips.filter(Boolean),
    values: { description: v.description, public_key: v.public_key, allowed_ips: v.allowed_ips.filter(Boolean), ...(v.route_allowed_ips ? { route_allowed_ips: '1' } : {}), ...(v.disabled ? { disabled: '1' } : {}), ...(v.persistent_keepalive ? { persistent_keepalive: v.persistent_keepalive } : {}), ...(v.endpoint_host ? { endpoint_host: v.endpoint_host } : {}), ...(v.endpoint_port ? { endpoint_port: v.endpoint_port } : {}) },
    secrets: v.preshared_key ? { preshared_key: true } : {},
  }));
  return m.readWireguard(reply);
};
// Whether checkApplied accepts `after` for `draft`, else its message.
const verdict = (draft, after) => { try { m.checkApplied(after, draft, data0); return 'ok'; } catch (e) { return e.message; } };
d = edited((_, w) => { w.values.listen_port = '51821'; w.peers.cfg222222.persistent_keepalive = '25'; });
check(verdict(d, applied(d)) === 'ok', 'a change that was kept passes');
check(/did not keep wg0: Listen port/.test(verdict(d, data0)), 'a change that was not kept is named', verdict(d, data0));
d = edited((_, w) => { w.values.private_key = SITE; });
check(/Private key/.test(verdict(d, m.readWireguard(nokey))) && verdict(d, applied(d)) === 'ok', 'a typed key must be stored afterwards');
d = edited(dd => { m.addPeer(dd, 'wg0', { description: 'Tablet', public_key: NEW, allowed_ips: ['10.8.0.3/32'], preshared_key: 'x' }); });
check(verdict(d, applied(d)) === 'ok' && /Tablet/.test(verdict(d, data0)), 'a new peer is found again by its public key');
d = edited(dd => { m.removePeer(dd, 'wg0', 'cfg333333'); });
check(verdict(d, applied(d)) === 'ok' && /peer Old/.test(verdict(d, data0)), 'a removed peer must be gone');
d = draft0(); m.removeInterface(d, 'wg0');
const gone = clone(status()); gone.interfaces = [];
check(verdict(d, m.readWireguard(gone)) === 'ok' && /Interface wg0/.test(verdict(d, data0)), 'a removed interface must be gone');
// A saved new interface.
const nd = draft0();
const nid = m.addInterface(data0, nd);
nd.added[0].name = 'wg5';
nd.interfaces[nid].values.private_key = PHONE;
nd.interfaces[nid].values.addresses = ['10.5.0.1/24'];
m.addPeer(nd, nid, { public_key: NEW, allowed_ips: ['10.5.0.2/32'] });
// The plugin's reply once wg5 exists and `up` says whether it came up and `loaded` whether its peer is in the kernel.
const withNew = (up, loaded) => {
  const r = clone(status());
  r.interfaces.push({ name: 'wg5', configured: true, enabled: true, up, zone: null, listen_port: 51821, addresses: ['10.5.0.1/24'], values: { proto: 'wireguard', listen_port: '51821', addresses: ['10.5.0.1/24'] }, secrets: { private_key: true },
    peers: [{ public_key: NEW, section: 'cfg555555', configured: true, enabled: true, state: loaded ? 'never' : 'down', allowed_ips: ['10.5.0.2/32'], values: { public_key: NEW, allowed_ips: ['10.5.0.2/32'] }, secrets: {} }] });
  return m.readWireguard(r);
};
// Whether the new-interface draft passes against `after`, else the message.
const newVerdict = after => { try { m.checkApplied(after, nd, data0); return 'ok'; } catch (e) { return e.message; } };
check(newVerdict(withNew(true, true)) === 'ok', 'a new interface that came up with its peer passes');
check(/wg5 did not come up/.test(newVerdict(withNew(false, false))) && /wireguard-tools/.test(newVerdict(withNew(false, false))), 'a new interface that did not come up fails, with a hint', newVerdict(withNew(false, false)));
check(/was not loaded into wg5/.test(newVerdict(withNew(true, false))), 'a peer that did not load fails');
check(m.notRunning(data0, nd, withNew(false, false)).join() === 'wg5 did not come up' && m.notRunning(data0, nd, withNew(true, true)).length === 0, 'notRunning lists what has not started (the page waits while this is not empty), and is empty once it all runs', m.notRunning(data0, nd, withNew(false, false)).join());
// An interface that was down before and stays down is not this save's doing.
const downBefore = clone(status()); downBefore.interfaces[0].up = false;
const dd0 = m.readWireguard(downBefore);
const ddd = m.draftFrom(dd0); ddd.interfaces.wg0.values.mtu = '1400';
check(m.expectations(dd0, ddd).up.length === 0, 'an interface that was down before and stays enabled is not expected up');
ddd.interfaces.wg0.values.disabled = true;
check(m.expectations(dd0, ddd).up.length === 0, 'a disabled one is not expected up');
const enabling = clone(downBefore); enabling.interfaces[0].values.disabled = '1'; enabling.interfaces[0].enabled = false;
const de = m.readWireguard(enabling), ded = m.draftFrom(de); ded.interfaces.wg0.values.disabled = false;
check(m.expectations(de, ded).up.join() === 'wg0', 'one that is being enabled must come up');
const touched = draft0(); touched.interfaces.wg0.values.mtu = '1400';
check(m.expectations(data0, touched).up.join() === 'wg0' && m.expectations(data0, touched).loaded.length === 0, 'a running interface that is edited must stay up; its untouched peers are not re-checked');
touched.interfaces.wg0.peers.cfg111111.public_key = NEW;
check(m.expectations(data0, touched).loaded.length === 1 && m.expectations(data0, touched).loaded[0].key === NEW, 'a peer with a new key must be loaded');
//#endregion

//#region Adding a client
console.log('\n== adding a client ==');
const plan = m.clientPlan(data0, draft0(), 'wg0');
check(!plan.error && j(plan.addresses) === j(['10.8.0.3/32', 'fd00:8::3/128']) && j(plan.tunnels) === j(['10.8.0.0/24', 'fd00:8::/64']) && plan.serverKey === SERVER && plan.port === '51820', 'the next free address of each family (the phone has .2 and ::2, the disabled peer holds .9 only), the tunnel networks, the server key and the port', j(plan));
const withP = draft0(); m.addPeer(withP, 'wg0', { allowed_ips: ['10.8.0.3/32'] });
check(m.clientPlan(data0, withP, 'wg0').addresses[0] === '10.8.0.4/32', 'a client added in the form takes the address too');
const twoNets = m.clientPlan(data0, edited((_, w) => { w.values.addresses.push('10.8.5.1/24'); }), 'wg0');
check(j(twoNets.addresses) === j(['10.8.0.3/32', 'fd00:8::3/128']) && twoNets.tunnels.length === 3, 'a client gets one address per family, but is told about every tunnel network', j(twoNets));
const dis = draft0(); dis.interfaces.wg0.peers.cfg333333.disabled = false;
check(m.clientPlan(data0, dis, 'wg0').addresses[0] === '10.8.0.3/32', 'an enabled peer\'s .9 does not block .3');
check(/new private key/.test(m.clientPlan(data0, edited((_, w) => { w.values.private_key = SITE; }), 'wg0').error), 'a private key that is not saved yet blocks it: the device would be given the old public key');
check(/not running yet/.test(m.clientPlan(data0, nd, nid).error) && /not running yet/.test(m.clientPlan(dd0, m.draftFrom(dd0), 'wg0').error), 'a new interface and one that is down cannot take a device');
const noPort = clone(status()); noPort.interfaces[0].listen_port = null;
check(/no listen port/.test(m.clientPlan(m.readWireguard(noPort), edited((_, w) => { w.values.listen_port = ''; }), 'wg0').error) && m.clientPlan(m.readWireguard(noPort), draft0(), 'wg0').port === '51820', 'the listen port comes from the form, else from the running interface; without one there is no device');
check(/no address with a prefix length/.test(m.clientPlan(data0, edited((_, w) => { w.values.addresses = ['10.8.0.1']; }), 'wg0').error), 'an interface without a tunnel network cannot take a device');
check(/no free address/.test(m.clientPlan(data0, edited((_, w) => { w.values.addresses = ['10.8.0.1/30']; w.peers.cfg111111.allowed_ips = ['10.8.0.2/32', '10.8.0.3/32']; }), 'wg0').error), 'a full network cannot take a device');
check(j(m.clientAllowedIps('tunnel', ['10.8.0.0/24'], '').list) === j(['10.8.0.0/24']) && j(m.clientAllowedIps('all', [], '').list) === j(['0.0.0.0/0', '::/0']) && j(m.clientAllowedIps('custom', [], '192.168.1.0/24, 10.0.0.0/8').list) === j(['192.168.1.0/24', '10.0.0.0/8']) && m.clientAllowedIps('custom', [], 'nope').error && m.clientAllowedIps('custom', [], '').error, 'what the device routes into the tunnel');
check(m.endpointText('vpn.example.com', '51820') === 'vpn.example.com:51820' && m.endpointText('2001:db8::1', '51820') === '[2001:db8::1]:51820' && m.endpointText('203.0.113.7', '1') === '203.0.113.7:1', 'the endpoint line brackets an IPv6 address');
const conf = m.clientConfig({ privateKey: 'PRIV', addresses: ['10.8.0.3/32', 'fd00:8::3/128'], dns: '10.8.0.1', serverKey: SERVER, presharedKey: 'PSK', endpoint: 'vpn.example.com:51820', allowedIps: ['10.8.0.0/24'], keepalive: '25' });
check(conf === `[Interface]\nPrivateKey = PRIV\nAddress = 10.8.0.3/32, fd00:8::3/128\nDNS = 10.8.0.1\n\n[Peer]\nPublicKey = ${SERVER}\nPresharedKey = PSK\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.8.0.0/24\nPersistentKeepalive = 25\n`, 'the device\'s configuration text', conf);
check(!m.clientConfig({ privateKey: 'P', addresses: ['a'], dns: '', serverKey: 'S', presharedKey: '', endpoint: 'e:1', allowedIps: ['x'], keepalive: '' }).match(/DNS|PresharedKey|PersistentKeepalive/), 'optional lines are left out');
check(m.clientFileName('wg0', 'My phone') === 'wg0-My-phone.conf' && m.clientFileName('wg0', 'A very long client name') === 'wg0-A-very-long.conf' && m.clientFileName('', '') === 'wireguard.conf' && m.clientFileName('wg0', '../x') === 'wg0-x.conf', 'the file name is safe and short', m.clientFileName('wg0', 'A very long client name'));
check(m.ownAddress({ addresses: ['10.8.0.1/24'] }) === '10.8.0.1' && m.ownAddress({ addresses: [''] }) === '', 'the router\'s own tunnel address');
//#endregion

// Every option of both tables has a hint and a label.
check([...IFACE_FIELDS, ...PEER_FIELDS].every(f => f.label && f.hint && f.key && f.type), 'every option has a key, a type, a label and a hint');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall WireGuard model checks passed');
process.exit(failed ? 1 : 0);
