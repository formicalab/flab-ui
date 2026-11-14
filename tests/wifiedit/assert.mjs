// Checks the output of flab.radio for each scenario built by mkfx.mjs, and (when present) a read-only run on the real router.
// Usage: node assert.mjs <dir with <scenario>.json files>
//   real.json, real-leaks.txt and real-checked.txt (optional): `config` and `status` run for real (they only read), how many times
//   a stored secret of the router's wireless config appears in what the plugin returned, and how many secrets were looked for.
import fs from 'node:fs';
import path from 'node:path';
import { SECRETS, SECRET_NAMES } from './cases.mjs';

const dir = process.argv[2];
// Loads one scenario's results (a JSON object keyed by call id).
const load = n => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

const main = load('main');
const cfg = main.config;
// The section called `n` among the radios or the interfaces of a reply.
const radio = (r, n) => r.radios.find(x => x.section === n);
const iface = (r, n) => r.interfaces.find(x => x.section === n);

console.log('== config: the reply ==');
check(Object.keys(cfg).sort().join() === 'countries,features,generated,interfaces,networks,others,radios' && typeof cfg.generated === 'number', 'the reply has only the documented fields', Object.keys(cfg).join());
check(cfg.radios.map(r => r.section).join() === 'radio0,radio1,radio2' && cfg.radios.every(r => Object.keys(r).sort().join() === 'anonymous,htmodes,index,phy,secrets,section,type,values'), 'every radio, in file order, with the documented fields', cfg.radios.map(r => Object.keys(r).join()).join(' | '));
check(radio(cfg, 'radio0').values.channel === '6' && radio(cfg, 'radio0').values.htmode === 'HE40' && radio(cfg, 'radio0').values.country === 'IT' && radio(cfg, 'radio1').values.disabled === '1' && radio(cfg, 'radio0').type === 'wifi-device', 'a radio carries every option of its section', j(radio(cfg, 'radio0')));
check(cfg.interfaces.map(i => i.section).join() === 'ap_2g,ap_5g,cfg0a1b2c,mesh_2g,sta_5g,odd', 'the wireless networks in file order', cfg.interfaces.map(i => i.section).join());
check(iface(cfg, 'cfg0a1b2c').anonymous === true && iface(cfg, 'ap_2g').anonymous === false && iface(cfg, 'cfg0a1b2c').values.ssid === 'corp', 'an unnamed section is reported with its generated name and flagged anonymous');
check(iface(cfg, 'ap_5g').values.network.join() === 'lan,guest' && iface(cfg, 'ap_2g').values.network === 'lan' && iface(cfg, 'ap_2g').values.maclist.length === 2, 'lists stay lists and a single value stays a string; the MAC list is returned for editing');
check(j(cfg.others) === j([{ section: 'vlan1', type: 'wifi-vlan' }, { section: 'stn1', type: 'wifi-station' }]) || j(cfg.others.slice().reverse()) === j([{ section: 'vlan1', type: 'wifi-vlan' }, { section: 'stn1', type: 'wifi-station' }]), 'sections of other types are listed by name and type only', j(cfg.others));
check(cfg.networks.map(n => n.name).join() === 'lan,wan,wwan,guest' && cfg.networks.find(n => n.name === 'wwan').proto === 'dhcp', 'the networks of the router, without loopback and without sections that are not interfaces', j(cfg.networks));

console.log('\n== config: secrets never leave the router ==');
const names = Object.fromEntries(cfg.interfaces.map(i => [i.section, Object.keys(i.secrets).sort()]));
check(Object.entries(SECRET_NAMES).every(([s, list]) => j(names[s]) === j([...list].sort())), 'each network says which of its secrets are set, by option name', j(names));
check(Object.keys(iface(cfg, 'odd').secrets).sort().join() === 'api_token,note_secret' && !('key' in iface(cfg, 'odd').secrets) && !('key' in iface(cfg, 'odd').values), 'an option named like a secret is hidden, an empty secret is not reported as set');
check(Object.values(iface(cfg, 'ap_2g').secrets).every(v => v === true) && !('key' in iface(cfg, 'ap_2g').values) && !('r0kh' in iface(cfg, 'ap_2g').values) && !('r1kh' in iface(cfg, 'ap_2g').values), 'a secret is only true, and its option is not among the values');
const visible = iface(cfg, 'ap_2g').values;
check(visible.wpa_psk_file === '/etc/hostapd.wpa_psk' && visible.ft_psk_generate_local === '0' && visible.r1_key_holder === 'AABBCC' && visible.nasid === 'AABBCC' && visible.pmk_r1_push === '1', 'options that only look like secrets (a file path, a key holder id, FT switches) are returned', j(visible));
for (const id of ['config', 'config-args', 'status']) {
  const text = j(main[id]);
  check(!text.includes('CANARY') && Object.values(SECRETS).every(s => !text.includes(s)), `${id}: no secret appears anywhere in the reply`, Object.values(SECRETS).filter(s => text.includes(s)).join());
}
const strip = r => ({ ...r, generated: 0 });
check(j(strip(main['config-args'])) === j(strip(cfg)), 'arguments sent to config are ignored');

console.log('\n== config: what the hardware supports ==');
check(j(radio(cfg, 'radio0').htmodes) === j({ source: 'iwinfo', modes: ['HT20', 'HT40', 'HE20', 'HE40'] }) && radio(cfg, 'radio0').phy === 'phy0', 'a running radio gets the htmode list of iwinfo, ordered by generation and width', j(radio(cfg, 'radio0').htmodes));
check(j(radio(cfg, 'radio1').htmodes) === j({ source: 'phy', modes: ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'VHT160', 'HE20', 'HE40', 'HE80', 'HE160'] }) && radio(cfg, 'radio1').phy === 'phy1', 'a radio that is down gets the modes its phy advertises for its band', j(radio(cfg, 'radio1').htmodes));
check(j(radio(cfg, 'radio2').htmodes) === j({ source: null, modes: [] }) && radio(cfg, 'radio2').phy === null, 'a radio whose phy is unknown reports no modes instead of guessing', j(radio(cfg, 'radio2')));
check(j(cfg.countries) === j([{ code: '00', name: 'World' }, { code: 'DE', name: 'Germany' }, { code: 'IT', name: 'Italy' }, { code: 'US', name: 'United States' }]), 'the countries come from the driver (a line that is not one is skipped)', j(cfg.countries));
check(j(cfg.features) === j({ eap: true, sae: true, owe: true, ft: true, wps: true }), 'the features hostapd was built with', j(cfg.features));
const basic = load('basic').config, none = load('nohostapd').config;
check(j(basic.features) === j({ eap: false, sae: true, owe: false, ft: false, wps: false }), 'a hostapd without enterprise, OWE and 802.11r says so', j(basic.features));
check(Object.values(none.features).every(v => v === null) && none.radios.length === 3, 'without hostapd nothing is known (null), so the page does not restrict anything', j(none.features));

console.log('\n== a router without radios, and the status method ==');
const empty = load('empty').config;
check(empty.radios.length === 0 && empty.interfaces.length === 0 && empty.others.length === 0 && empty.countries.length === 0 && empty.networks.length === 4, 'no radio, no network, no country; the router\'s networks are still listed', j(empty));
const st = main.status;
check(Object.keys(st).sort().join() === 'generated,radios,regdomain' && st.radios.map(r => r.name).join() === 'radio0,radio1,radio2' && st.radios[0].interfaces.length === 3 && st.radios[0].interfaces[0].encryption === 'psk2' && st.radios[1].enabled === false, 'the status method still reports the radios and their interfaces', j({ keys: Object.keys(st), ifaces: st.radios[0].interfaces.length }));
check(st.radios.every(r => r.interfaces.every(i => !('key' in i) && !('maclist' in i) && !('maclist' in (i.macfilter ?? {})))), 'the status method still reports a MAC filter only as its policy and entry count', j(st.radios[0].interfaces[0].macfilter));

const real = path.join(dir, 'real.json');
if (fs.existsSync(real)) {
  console.log('\n== the real router (read only) ==');
  const r = JSON.parse(fs.readFileSync(real, 'utf8'));
  const leaks = +fs.readFileSync(path.join(dir, 'real-leaks.txt'), 'utf8');
  const looked = +fs.readFileSync(path.join(dir, 'real-checked.txt'), 'utf8');
  check(Array.isArray(r.config.radios) && r.config.radios.length >= 1 && r.config.radios.every(x => Array.isArray(x.htmodes.modes) && x.section), 'config reports the radios of the real router', j(Object.keys(r.config)));
  check(looked > 0, `the router's wireless config holds secrets to look for (${looked} of them)`, String(looked));
  check(leaks === 0, 'none of the router\'s stored Wi-Fi secrets appears in the config or status reply', String(leaks));
  check(r.config.interfaces.every(i => !('key' in i.values) && !('sae_password' in i.values) && !('r0kh' in i.values) && !('r1kh' in i.values)), 'no key option is among the values of the real router\'s networks');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall Wi-Fi backend checks passed');
process.exit(failed ? 1 : 0);
