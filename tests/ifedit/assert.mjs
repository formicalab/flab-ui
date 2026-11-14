// Assertions on the output of the flab.network `config` call: the editable part of /etc/config/network without any secret.
// Usage: node assert.mjs <fixtures dir> <out dir>   (out dir: <scenario>.json from the harness, real.json from the real router, and
//        real-counts.txt and real-leaks.txt written on the router)
import fs from 'node:fs';
import path from 'node:path';

const [fx, out] = process.argv.slice(2);
const canaries = JSON.parse(fs.readFileSync(path.join(fx, 'canaries.json'), 'utf8'));

let failed = 0, passed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (cond) passed++; else failed++; };
// The text and the parsed `config` reply of a scenario.
const read = name => { const text = fs.readFileSync(path.join(out, `${name}.json`), 'utf8'); return { text, cfg: JSON.parse(text).config }; };

//#region The main scenario
{
  const { text, cfg } = read('main');
  console.log('== main: a router with secrets in every kind of place ==');
  check(canaries.every(c => !text.includes(c)), 'no canary secret appears anywhere in the reply', canaries.filter(c => text.includes(c)).join(', '));
  check(typeof cfg.generated === 'number', 'the reply carries its time');
  check(cfg.interfaces.map(s => s.section).join() === 'loopback,lan,wan,wan6,lte,wg0,guest', 'interfaces come in file order, not in the order of the keys', cfg.interfaces.map(s => s.section).join());
  check(cfg.devices.map(s => s.section).join() === 'cfg030f15,cfg040f15,guest_br', 'device sections come in file order', cfg.devices.map(s => s.section).join());
  const iface = n => cfg.interfaces.find(s => s.section === n);
  const dev = n => cfg.devices.find(s => s.section === n);

  const wan = iface('wan');
  check(wan.secrets.password === true && !('password' in wan.values), 'the PPPoE password is reported as set and its value is gone');
  check(wan.values.username === 'v-user' && wan.values.keepalive === '5 1' && wan.values.host_uniq === '5231' && wan.values.device === 'eth1.1036', 'the options around it are kept (keepalive is not mistaken for a key)', JSON.stringify(wan.values));
  const wg = iface('wg0');
  check(wg.secrets.private_key === true && !('private_key' in wg.values) && wg.values.listen_port === '51820' && Array.isArray(wg.values.addresses), 'a WireGuard private key is only flagged; its other options stay', JSON.stringify(wg));
  const lte = iface('lte');
  check(lte.secrets.pincode === true && lte.secrets.password === true && !('pincode' in lte.values) && lte.values.apn === 'internet' && lte.values.username === 'u', 'a SIM PIN and a modem password are flagged, the APN and the user name stay', JSON.stringify(lte));
  const guest = iface('guest');
  check(guest.secrets.psk === true && guest.secrets.key === true && !('psk' in guest.values) && !('key' in guest.values), 'psk and key options are flagged', JSON.stringify(guest));
  check(!guest.secrets.password && !('password' in guest.values) && guest.values.note === '', 'an empty password is not reported as set', JSON.stringify(guest));
  check(Array.isArray(iface('lan').values.ipaddr) && iface('lan').values.dns.length === 2, 'list options stay lists');
  check(iface('loopback').anonymous === false && dev('cfg030f15').anonymous === true && dev('guest_br').anonymous === false, 'anonymous and named sections are told apart');
  check(dev('cfg030f15').values.name === 'br-lan' && dev('cfg030f15').values.ports.join() === 'lan1,lan2' && dev('cfg040f15').values.vid === '1036', 'device options are kept');
  check(cfg.devices.every(s => typeof s.secrets === 'object') && cfg.interfaces.every(s => typeof s.values === 'object'), 'every section has values and secrets');
  check(cfg.other.globals === 1 && cfg.other.wireguard_wg0 === 2 && cfg.other['bridge-vlan'] === 2 && cfg.other.route === 2 && cfg.other.rule === 1 && Object.keys(cfg.other).length === 5, 'the other sections are only counted, by type', JSON.stringify(cfg.other));
  check(!('interface' in cfg.other) && !('device' in cfg.other), 'interfaces and devices are not among the others');
  check(cfg.bridge_vlans.length === 2 && cfg.bridge_vlans[0].device === 'br-lan' && cfg.bridge_vlans.map(v => v.vlan).sort().join() === '10,20', 'the bridge VLAN sections name their device and VLAN', JSON.stringify(cfg.bridge_vlans));
  check(!text.includes('public_key') && !text.includes('allowed_ips'), 'WireGuard peer sections are not part of the reply');
}
//#endregion

//#region The empty scenarios
for (const name of ['empty', 'missing']) {
  const { cfg } = read(name);
  console.log(`\n== ${name}: nothing to edit ==`);
  check(Array.isArray(cfg.interfaces) && cfg.interfaces.length === 0 && Array.isArray(cfg.devices) && cfg.devices.length === 0, 'both lists are empty arrays', JSON.stringify(cfg));
  check(Object.keys(cfg.other).length === 0 && cfg.bridge_vlans.length === 0, 'no other sections and no bridge VLANs');
}
//#endregion

//#region The real router (only read)
{
  const real = read('real');
  const counts = Object.fromEntries(fs.readFileSync(path.join(out, 'real-counts.txt'), 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, v]) => [k, +v]));
  const leaks = +fs.readFileSync(path.join(out, 'real-leaks.txt'), 'utf8').trim();
  console.log('\n== the real router (read only) ==');
  check(real.cfg.interfaces.length === counts.interface && real.cfg.devices.length === counts.device, `the reply has the router's ${counts.interface} interface and ${counts.device} device sections`, `${real.cfg.interfaces.length}/${real.cfg.devices.length}`);
  check(real.cfg.interfaces.some(s => s.section === 'lan') && real.cfg.interfaces.every(s => typeof s.values.proto === 'string' || s.values.proto === undefined), 'the interfaces include lan and have their protocols');
  check(leaks === 0, 'none of the router\'s stored secrets (4 characters or more) appears in the reply', `${leaks} occurrence(s)`);
  const secretKeys = real.cfg.interfaces.flatMap(s => Object.keys(s.values)).filter(k => /passw|private_key|preshared|psk|secret|token|^key$/i.test(k));
  check(secretKeys.length === 0, 'no option with a secret-looking name is in the reply', secretKeys.join());
  const pppoe = real.cfg.interfaces.filter(s => s.values.proto === 'pppoe');
  check(pppoe.every(s => s.secrets.password === true) , 'a PPPoE interface reports that its password is set', JSON.stringify(pppoe.map(s => [s.section, s.secrets])));
}
//#endregion

console.log(failed ? `\n${failed} of ${passed + failed} checks FAILED` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
