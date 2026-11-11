// Checks the backend JSON produced for each IPsec scenario. Usage: node assert.mjs <dir with <scenario>.json and names.json>
// Scenarios (built by mkfx.mjs from the captured router output, parsed by flab.ipsec on the router):
//   base       - real captured state: four ESTABLISHED IKEv2 connections, one child SA each
//   down       - one connection loses its IKE SA (configured but not established)
//   rekey      - one connection shows two child SAs while a rekey overlaps
//   multi      - two IKE SAs under one connection name (distinct keys per IKE SA)
//   orphan     - SAs whose connection / child is missing from the loaded configuration
//   ipv6       - global IPv6 addresses on an xfrm interface
//   daemondown - charon not running (no stats output), connections configured
//   unconfigured - charon not running because /etc/config/swanctl has no sections
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
// Loads the parsed flab.ipsec status JSON of one scenario (or names.json) from the output directory.
const load = n => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
// names = configured connection names (sorted); iface = the xfrm interface that mkfx adds IPv6 addresses to.
const { names, iface } = load('names');
let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
// All connection entries of a scenario with the given connection name (several when it has multiple IKE SAs).
const byName = (d, n) => d.connections.filter(c => c.name === n);
// Texts of the rating warnings of one connection.
const warnings = c => c.rating.warnings.map(w => w.text);
// The connection whose first child SA is bound to the xfrm interface `iface`.
const onIface = d => d.connections.find(c => c.children[0]?.sas[0]?.iface?.name === iface);

console.log('== base (real captured output) ==');
const base = load('base');
check(base.connections.length === 4, 'four connections, as on the live router', String(base.connections.length));
check(base.connections.map(c => c.name).join() === names.join(), 'one entry per configured connection, sorted', base.connections.map(c => c.name).join());
check(base.connections.every(c => c.key === c.name && c.instance === null && c.orphan === false), 'plain keys, no instance, not orphan');
check(base.connections.every(c => c.state === 'ESTABLISHED' && c.version === 'IKEv2'), 'all ESTABLISHED over IKEv2');
check(base.connections.every(c => c.children.length === 1 && c.children[0].sas.length === 1 && c.children[0].orphan === false), 'one configured child with one SA each');
check(base.connections.every(c => /^xfrm\d+$/.test(c.children[0].sas[0].iface?.name ?? '')), 'each child SA is bound to its xfrm interface by if_id');
check(base.connections.every(c => c.children[0].sas[0].kernel.inbound?.dir === 'in' && c.children[0].sas[0].kernel.outbound?.dir === 'out'), 'kernel SAs matched by SPI');
check(base.connections.every(c => c.rating.parts.length === 7 && c.rating.score > 0 && c.rating.score <= 100), 'rating has 7 parts and a 0..100 score');
check(!JSON.stringify(base).includes('deadbeef'), 'key material from ip xfrm never reaches the output');
check(base.daemon.running === true && /^\d+\.\d+/.test(base.daemon.version) && typeof base.daemon.workers.total === 'number', 'daemon data parsed', JSON.stringify(base.daemon).slice(0, 160));
check(base.connections.every(c => Array.isArray(c.children[0].sas[0].iface.addrs6) && c.children[0].sas[0].iface.addrs6.length === 0), 'only link-local IPv6 on the interfaces, so none listed');

console.log('== down (one connection loses its IKE SA) ==');
const down = load('down');
const d1 = byName(down, names[1])[0];
check(down.connections.length === 4 && byName(down, names[1]).length === 1, 'connection stays listed');
check(d1.state === 'DOWN' && d1.ike === null && d1.children[0].sas.length === 0, 'DOWN, no IKE SA, no child SA', JSON.stringify([d1.state, d1.ike, d1.children[0].sas.length]));
check(d1.rating.parts.length === 7 && d1.rating.score > 0, 'still rated from the configured proposals');
check(down.connections.filter(c => c.state === 'ESTABLISHED').length === 3, 'the other three stay ESTABLISHED');

console.log('== rekey (two child SAs during the overlap) ==');
const rekey = load('rekey');
const r0 = byName(rekey, names[0])[0];
check(rekey.connections.length === 4 && r0.children[0].sas.length === 2, 'two child SAs on one connection', String(r0.children[0].sas.length));
check(r0.children[0].sas[0].spi_in === 'aaaa1111' && r0.children[0].sas[0].install_time < r0.children[0].sas[1].install_time, 'newest SA first');
check(r0.children[0].sas[0].if_id === r0.children[0].sas[1].if_id, 'both SAs share the xfrm interface');

console.log('== multi (two IKE SAs under one connection name) ==');
const multi = load('multi');
const m2 = byName(multi, names[2]);
const originalId = byName(base, names[2])[0].ike.uniqueid;
check(multi.connections.length === 5 && m2.length === 2, 'five entries, two for the doubled connection', `${multi.connections.length}/${m2.length}`);
check(m2.map(c => c.instance).join() === `${originalId},900`, 'both IKE SAs listed, oldest first', m2.map(c => c.instance).join());
check(m2[0].key === `${names[2]}#${originalId}` && m2[1].key === `${names[2]}#900` && m2[0].key !== m2[1].key, 'distinct keys per IKE SA', m2.map(c => c.key).join());
check(m2[0].ike.established > m2[1].ike.established, 'ordered by age');
check(m2[1].children[0].sas.length === 1 && m2[1].children[0].sas[0].spi_in === 'cccc3333', 'each IKE SA carries only its own child SAs');
check(multi.connections.filter(c => c.name !== names[2]).every(c => c.instance === null && c.key === c.name), 'other connections keep plain keys');

console.log('== orphan (SAs without configuration) ==');
const orphan = load('orphan');
const o3 = byName(orphan, names[3])[0];
check(orphan.connections.length === 4, 'orphan SA is still listed');
check(o3.orphan === true && o3.state === 'ESTABLISHED' && o3.version === 'IKEv2' && o3.key === names[3], 'flagged orphan, live state and version taken from the SA', JSON.stringify([o3.orphan, o3.state, o3.version]));
check(o3.children.length === 1 && o3.children[0].orphan === true && o3.children[0].sas.length === 1, 'its child SA is listed too');
check(o3.children[0].local_ts.length > 0 && o3.children[0].mode, 'traffic selectors and mode fall back to the SA');
check(warnings(o3).some(t => /not in the loaded configuration/.test(t)), 'explains why it cannot be fully rated', warnings(o3).join(' | '));
check(!warnings(o3).some(t => /pre-shared|IKEv1/.test(t)) && o3.rating.parts.find(p => p.key === 'ike_auth').value === 'unknown', 'no false pre-shared-key or IKEv1 advice', warnings(o3).join(' | '));
const o0 = byName(orphan, names[0])[0];
check(o0.orphan === false && o0.children[0].orphan === true && o0.children[0].sas.length === 1, 'child SA of a connection whose child config is gone is kept and flagged', JSON.stringify([o0.orphan, o0.children.map(c => [c.name, c.orphan, c.sas.length])]));
check(warnings(o0).some(t => /pre-shared/.test(t)) && byName(orphan, names[1])[0].orphan === false && byName(orphan, names[2])[0].orphan === false, 'configured connections are unaffected');

console.log('== ipv6 (global addresses on an xfrm interface) ==');
const v6 = load('ipv6');
const iv = onIface(v6).children[0].sas[0].iface;
check(iv.addrs6.length === 2, 'global IPv6 addresses listed, link-local skipped', JSON.stringify(iv.addrs6));
check(iv.addrs6[0].addr === 'fd00:ab::1' && iv.addrs6[0].prefix === 64 && iv.addrs6[0].peer === null, 'address with prefix', JSON.stringify(iv.addrs6[0]));
check(iv.addrs6[1].addr === 'fd00:cd::1' && iv.addrs6[1].peer === 'fd00:cd::2', 'point-to-point address with peer', JSON.stringify(iv.addrs6[1]));
check(iv.local === onIface(base).children[0].sas[0].iface.local, 'IPv4 tunnel address unchanged');

console.log('== daemon down ==');
const dd = load('daemondown');
check(dd.daemon.running === false && dd.connections.length === 0, 'no connections and running=false without charon');
check(dd.daemon.configured === true && base.daemon.configured === true, 'connections are configured in the base and the stopped-daemon scenarios');
const uc = load('unconfigured');
check(uc.daemon.running === false && uc.daemon.configured === false && uc.connections.length === 0, 'a stopped daemon with an empty swanctl config is reported as not configured');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall IPsec backend checks passed');
