// Unit test for the editing model of the Wi-Fi page (www/js/pages/wifi/model.js and schema.js): reading the plugins' replies, the
// draft, the review list, validation, the UCI operations, the check after a save and what to wait for. Pure functions: no router
// and no browser. The channel geometry is tested in tests/wifi. Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const page = name => import(pathToFileURL(path.resolve(import.meta.dirname, `../../www/js/pages/wifi/${name}.js`)).href);
const m = await page('model');
const s = await page('schema');

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

//#region A fake router
// A channel entry of the flab.radio status reply.
const ch = (band, n, flags = {}) => ({ channel: n, freq: (band === '2g' ? 2407 : 5000) + 5 * n, max_power: 23, disabled: false, dfs: Boolean(flags.dfs), no_ir: false });
const BAND5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 149, 153, 157, 161, 165].map(n => ch('5g', n, { dfs: n >= 52 && n <= 128 }));
// A status interface of the plugin: `up` and `clients` are what netifd and hostapd report.
const live = (section, extra = {}) => ({ section, ifname: `phy-${section}`, mode: 'ap', ssid: 'home', enabled: true, up: true, clients: 0, ...extra });

// The status reply: radio0 on 2.4 GHz (an access point with 3 clients and a mesh interface) and radio1 on 5 GHz.
const STATUS = () => ({ regdomain: { country: 'IT', dfs: 'DFS-ETSI' }, radios: [
  { name: 'radio0', band: '2g', enabled: true, up: true, config: { channel: '6', htmode: 'HE40' }, channels: Array.from({ length: 13 }, (_, i) => ch('2g', i + 1)),
    interfaces: [live('ap_2g', { clients: 3 }), live('mesh_2g', { mode: 'mesh', ssid: 'meshy' })] },
  { name: 'radio1', band: '5g', enabled: true, up: true, config: { channel: '104', htmode: 'HE160' }, channels: BAND5, interfaces: [live('ap_5g', { clients: 1 })] },
] });
// A section as the config reply returns it.
const sec = (section, values, secrets = {}, extra = {}) => ({ section, anonymous: false, index: 0, type: 'wifi-iface', values, secrets, ...extra });
// The config reply: the options of the sections, which secrets are set and what each radio supports.
const CONFIG = () => ({
  radios: [
    sec('radio0', { type: 'mac80211', band: '2g', channel: '6', htmode: 'HE40', country: 'IT', noscan: '1' }, {}, { type: 'wifi-device', htmodes: { source: 'iwinfo', modes: ['HT20', 'HT40', 'HE20', 'HE40'] } }),
    sec('radio1', { type: 'mac80211', band: '5g', channel: '104', htmode: 'HE160', country: 'IT', txpower: '20' }, {}, { type: 'wifi-device', htmodes: { source: 'iwinfo', modes: ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'VHT160', 'HE20', 'HE40', 'HE80', 'HE160'] } }),
  ],
  interfaces: [
    sec('ap_2g', { device: 'radio0', mode: 'ap', ssid: 'home', network: 'lan', encryption: 'sae-mixed', ieee80211w: '1', ieee80211r: '1', mobility_domain: '40f9', ft_over_ds: '0' }, { key: true }),
    sec('mesh_2g', { device: 'radio0', mode: 'mesh', mesh_id: 'meshy', encryption: 'sae', network: 'lan' }, { key: true }),
    sec('ap_5g', { device: 'radio1', mode: 'ap', ssid: 'home', network: ['lan', 'guest'], encryption: 'sae-mixed', hidden: '0' }, { key: true }),
    sec('cfg0a1b2c', { device: 'radio1', mode: 'ap', ssid: 'open', encryption: 'none', network: 'guest' }, {}, { anonymous: true }),
  ],
  others: [{ section: 'vlan1', type: 'wifi-vlan' }],
  networks: [{ name: 'lan', proto: 'static' }, { name: 'guest', proto: 'static' }, { name: 'wwan', proto: 'dhcp' }],
  countries: [{ code: 'DE', name: 'Germany' }, { code: 'IT', name: 'Italy' }],
  features: { eap: true, sae: true, owe: true, ft: true, wps: true },
});
// The page's data from the fake status and config, with `edit` applied to the config first.
const world = (edit, status) => { const c = CONFIG(); edit?.(c); return m.readWifi(status ?? STATUS(), c); };
// A draft of `w`, modified by `edit`.
const draftOf = (w, edit) => { const d = m.draftFrom(w); edit?.(d); return d; };
// The first error whose key is `key`, and whether any warning matches `re`.
const errorOf = (p, key) => p.errors.find(e => e.key === key);
// The radio field of the schema with this key.
const RADIO_FIELD = key => s.RADIO_FIELDS.find(f => f.key === key);
const warned = (p, re) => p.warnings.some(t => re.test(t));
//#endregion

console.log('== reading the replies ==');
const w = world();
check(w.editable && w.radios.length === 2 && w.ifaces.length === 4 && w.networks.join() === 'lan,guest,wwan', 'the radios, the wireless networks and the networks of the router', j(w.networks));
check(w.ifaces.map(i => `${i.section}:${i.mode}:${i.editable}`).join() === 'ap_2g:ap:true,mesh_2g:mesh:true,ap_5g:ap:true,cfg0a1b2c:ap:true', 'access points, client networks and mesh points are editable');
check(w.ifaces[0].live.clients === 3 && w.ifaces[3].live === null && w.ifaces[3].anonymous && w.ifaces[2].device === 'radio1', 'each network is joined with its live interface by section name; an unnamed section is flagged');
check(!m.readWifi(STATUS(), null).editable && !m.readWifi(null, CONFIG()).editable && m.readWifi(null, null).radios.length === 0, 'without the configuration, or without any radio, nothing is editable');
check(w.radios[0].htmodes.modes.includes('HE40') && w.radios[0].values.country === 'IT' && j(w.radios[0].secrets) === '{}', 'a radio carries its options and the modes the hardware reports');

console.log('\n== the draft ==');
const d0 = m.draftFrom(w);
check(d0.radios.radio0.channel === '6' && d0.radios.radio0.htmode === 'HE40' && d0.radios.radio0.noscan === true && d0.radios.radio0.disabled === false && d0.radios.radio0.txpower === '', 'the draft holds the radio values: strings, booleans, empty for not set');
check(j(d0.ifaces.ap_5g.network) === '["lan","guest"]' && d0.ifaces.ap_2g.network.join() === 'lan' && d0.ifaces.cfg0a1b2c.encryption === '' && d0.ifaces.ap_2g.key === '' && d0.ifaces.mesh_2g.mesh_id === 'meshy' && d0.ifaces.mesh_2g.encryption === 'sae', 'networks are lists, "none" is the open choice, a secret starts empty, a mesh point has its Mesh ID');
check(d0.ifaces.ap_2g.wmm === true && d0.ifaces.ap_2g.disabled === false && d0.ifaces.ap_2g.ieee80211r === true, 'a boolean takes the OpenWrt default when the option is absent');
check(!m.isDirty(w, d0) && m.changesOf(w, d0).length === 0 && m.plan(w, d0).length === 0, 'an untouched draft changes nothing');
const p0 = m.problems(w, d0);
check(!p0.errors.length && !p0.warnings.length, 'and reports nothing, although the open network is odd: only what changes is judged', j(p0));

console.log('\n== radio settings: operations and review ==');
let d = draftOf(w, x => { x.radios.radio1.htmode = 'HE80'; x.radios.radio1.txpower = '17'; x.radios.radio1.cell_density = '2'; x.radios.radio1.beacon_int = '200'; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'radio1', values: { htmode: 'HE80', txpower: '17', cell_density: '2', beacon_int: '200' } }]), 'only the changed options are written, to the radio\'s section', j(m.plan(w, d)));
check(j(m.changesOf(w, d).map(c => [c.label, c.from, c.to])) === j([['radio1: Mode and channel width', 'HE160 · 802.11ax, 160 MHz'.slice(0, 5), 'HE80'], ['radio1: Transmit power (dBm)', '20', '17'], ['radio1: Coverage cell density', 'default', 'high'], ['radio1: Beacon interval', 'default', '200']]), 'the review lists each change with from and to', j(m.changesOf(w, d)));
d = draftOf(w, x => { x.radios.radio1.txpower = ''; x.radios.radio0.channel = 'auto'; x.radios.radio0.country = ''; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'radio0', values: { channel: 'auto' } }, { op: 'delete', config: 'wireless', section: 'radio0', options: ['country'] }, { op: 'delete', config: 'wireless', section: 'radio1', options: ['txpower'] }]), 'an emptied option is deleted, not set to an empty string', j(m.plan(w, d)));
d = draftOf(w, x => { x.radios.radio0.disabled = true; x.radios.radio1.legacy_rates = true; x.radios.radio0.noscan = false; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'radio0', values: { disabled: '1', noscan: '0' } }]), 'booleans are written as 0 or 1, and an option that does not apply to the band (legacy rates on 5 GHz) is not written', j(m.plan(w, d)));

console.log('\n== radio settings: validation ==');
let p = m.problems(w, draftOf(w, x => { x.radios.radio1.htmode = 'HE80'; }));
check(!p.errors.length && warned(p, /channel 104 is a radar \(DFS\) channel/), 'a mode the hardware lists, that the current channel can carry, is fine (the radar warning stays, since the radio restarts)', j(p));
p = m.problems(w, draftOf(w, x => { x.radios.radio0.htmode = 'VHT80'; }));
check(errorOf(p, 'radio0:htmode') && /does not report support for VHT80/.test(errorOf(p, 'radio0:htmode').text) && /HT20, HT40, HE20, HE40/.test(p.errors[0].text), 'a mode the hardware does not list is an error that says what it supports', j(p));
p = m.problems(w, draftOf(w, x => { x.radios.radio0.htmode = 'HT40+'; }));
check(!p.errors.length, 'on 2.4 GHz the explicit HT40+ is accepted when HT40 is supported', j(p));
p = m.problems(w, draftOf(w, x => { x.radios.radio1.htmode = 'NOHT'; }));
check(!p.errors.length, 'NOHT is always accepted');
const blind = world(c => { c.radios[1].htmodes = { source: null, modes: [] }; c.countries = []; });
p = m.problems(blind, draftOf(blind, x => { x.radios.radio1.htmode = 'HE80'; x.radios.radio1.country = 'it'; }));
check(!errorOf(p, 'radio1:htmode') && errorOf(p, 'radio1:country'), 'when the hardware reported no modes the value is only checked for its form; a country must be two capital letters', j(p));
p = m.problems(blind, draftOf(blind, x => { x.radios.radio1.htmode = 'FAST'; }));
check(errorOf(p, 'radio1:htmode'), 'an htmode of no known form is an error', j(p));
p = m.problems(w, draftOf(w, x => { x.radios.radio0.country = 'XX'; }));
check(errorOf(p, 'radio0:country') && /does not know the country code XX/.test(p.errors[0].text), 'a country the driver does not list is an error');
p = m.problems(w, draftOf(w, x => { x.radios.radio0.country = 'DE'; }));
check(!p.errors.length && warned(p, /changing the country/), 'a valid country warns that channels and power change');
p = m.problems(w, draftOf(w, x => { x.radios.radio1.txpower = '99'; x.radios.radio1.beacon_int = '5'; x.radios.radio1.cell_density = '9'; }));
check(errorOf(p, 'radio1:txpower') && errorOf(p, 'radio1:beacon_int') && errorOf(p, 'radio1:cell_density') && p.errors.length === 3, 'a power above 40 dBm, a beacon interval below 15 and a cell density that is not 0 to 3 are errors', j(p));
console.log('\n== radio options of the OpenWrt wireless documentation (wifi-device) ==');
// Every option of a wifi-device section that the documentation lists for mac80211 is a field: the lists (channels, rates, capabilities, hostapd options) and the
// antenna, coexistence and narrow-width options too.
d = draftOf(w, x => { x.radios.radio0.channel = 'auto'; x.radios.radio0.channels = ['1-11']; x.radios.radio1.basic_rate = ['6000', '12000']; x.radios.radio1.supported_rates = ['6000', '12000', '24000']; x.radios.radio1.hostapd_options = ['vendor_elements=dd0a0017f206010103010000']; x.radios.radio1.ht_capab = ['LDPC']; x.radios.radio1.diversity = false; x.radios.radio1.rxantenna = '1'; x.radios.radio1.txantenna = '1'; x.radios.radio0.ht_coex = true; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'radio0', values: { channels: ['1-11'], ht_coex: '1', channel: 'auto' } }, { op: 'set', config: 'wireless', section: 'radio1', values: { basic_rate: ['6000', '12000'], supported_rates: ['6000', '12000', '24000'], diversity: '0', rxantenna: '1', txantenna: '1', ht_capab: ['LDPC'], hostapd_options: ['vendor_elements=dd0a0017f206010103010000'] } }]), 'the channels of automatic selection, the rate lists, the capabilities, the antennas, the coexistence flag and the hostapd options are written, lists as lists', j(m.plan(w, d)));
p = m.problems(w, draftOf(w, x => { x.radios.radio0.channel = 'auto'; x.radios.radio0.channels = ['11-1', 'abc']; x.radios.radio1.basic_rate = ['6 Mbit']; x.radios.radio1.supported_rates = ['0']; x.radios.radio1.ht_capab = ['no good']; }));
check(errorOf(p, 'radio0:channels') && errorOf(p, 'radio1:basic_rate') && errorOf(p, 'radio1:supported_rates') && errorOf(p, 'radio1:ht_capab') && p.errors.length === 5, 'a reversed range, a word that is not a channel, a rate that is not kb/s, and a capability with a space are errors', j(p));
check(!m.isShown(RADIO_FIELD('channels'), draftOf(w).radios.radio1, m.radioCtx(w.radios[1])) && m.isShown(RADIO_FIELD('channels'), { ...draftOf(w).radios.radio1, channel: 'auto' }, m.radioCtx(w.radios[1])), 'the channels for automatic selection are offered while the channel is automatic');
check(!m.isShown(RADIO_FIELD('chanbw'), draftOf(w).radios.radio1, m.radioCtx(w.radios[1])), 'the narrow channel width is offered only where the file already sets it (ath9k and ath5k only)');

p = m.problems(w, draftOf(w, x => { x.radios.radio1.txpower = '30'; }));
check(!p.errors.length && warned(p, /30 dBm is above the regulatory limit of 23 dBm on channel 104/), 'a power above the regulatory limit of the channel warns', j(p));
p = m.problems(w, draftOf(w, x => { x.radios.radio1.htmode = 'HE80'; x.radios.radio1.channel = '149'; }));
check(!p.errors.length && !warned(p, /radar/), 'an 80 MHz block that fits needs no radar warning outside DFS');
p = m.problems(w, draftOf(w, x => { x.radios.radio1.channel = '149'; }));
check(errorOf(p, 'radio1:channel') && /cannot carry HE160/.test(p.errors[0].text), 'a channel that cannot carry the current width is an error');
const w149 = world(c => { c.radios[1].values.channel = '149'; }, (() => { const st = STATUS(); st.radios[1].config.channel = '149'; return st; })());
p = m.problems(w149, draftOf(w149, x => { x.radios.radio1.htmode = 'VHT80'; }));
check(!p.errors.length, 'a narrower mode fits on a channel the wider one could not use');
const w149b = world(c => { c.radios[1].values.channel = '149'; c.radios[1].values.htmode = 'HE80'; }, (() => { const st = STATUS(); st.radios[1].config = { channel: '149', htmode: 'HE80' }; return st; })());
p = m.problems(w149b, draftOf(w149b, x => { x.radios.radio1.htmode = 'HE160'; }));
check(errorOf(p, 'radio1:htmode') && errorOf(p, 'radio1:htmode').also === 'radio1:channel' && /cannot carry HE160/.test(errorOf(p, 'radio1:htmode').text), 'widening the mode so the current channel no longer fits is an error on the mode and the channel picker', j(p));
p = m.problems(w, draftOf(w, x => { x.radios.radio0.htmode = 'HE20'; x.radios.radio0.channel = '11'; }));
check(!p.errors.length && warned(p, /mesh interface meshy.*must be moved to the same channel/), 'a radio with a mesh interface warns when its channel changes');
p = m.problems(w, draftOf(w, x => { x.radios.radio0.htmode = 'HE20'; }));
check(warned(p, /mesh interface meshy.*same channel width/), 'and when its width changes');
p = m.problems(w, draftOf(w, x => { x.radios.radio0.htmode = 'HT40'; x.radios.radio0.channel = '1'; }));
check(warned(p, /40 MHz channel on 2\.4 GHz/), 'a 40 MHz channel on 2.4 GHz warns about the crowded band');
p = m.problems(w, draftOf(w, x => { x.radios.radio0.disabled = true; }));
check(!p.errors.length && warned(p, /radio0: this radio will be switched off: its 1 network \(home\) stops and 3 clients lose the connection.*30 seconds/), 'switching a radio off warns how many networks and clients it takes down, and that the router undoes it', j(p));
p = m.problems(w, draftOf(w, x => { x.radios.radio1.legacy_rates = true; x.radios.radio1.require_mode = 'ac'; }));
check(!warned(p, /legacy/) && warned(p, /Apple/), 'legacy rates are not offered on 5 GHz (nothing is written for them); requiring 802.11ac warns');
d = draftOf(w, x => { x.radios.radio1.legacy_rates = true; });
check(m.plan(w, d).length === 0 && m.changesOf(w, d).length === 0, 'a hidden option whose value was edited changes nothing');
const odd = world(c => { c.radios[1].values.htmode = 'VHT80+80'; });
check(!m.problems(odd, m.draftFrom(odd)).errors.length, 'a mode the hardware does not list but the config already holds is not reported until it is changed');

console.log('\n== wireless networks: operations and review ==');
d = draftOf(w, x => { x.ifaces.ap_5g.ssid = 'home-5'; x.ifaces.ap_5g.hidden = true; x.ifaces.ap_5g.network = ['lan']; x.ifaces.ap_5g.dtim_period = '3'; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'ap_5g', values: { ssid: 'home-5', network: 'lan', hidden: '1', dtim_period: '3' } }]), 'a name, networks (one value is a plain option), a boolean and a number are the only operations', j(m.plan(w, d)));
check(m.changesOf(w, d).map(c => c.label).join() === 'home: SSID,home: Attached to,home: Hide the SSID,home: DTIM period' && m.changesOf(w, d)[1].from === 'lan, guest', 'the review names the network by its saved SSID, with from and to', j(m.changesOf(w, d)));
d = draftOf(w, x => { x.ifaces.ap_5g.network = ['lan', 'guest', 'wwan']; x.ifaces.ap_5g.maclist = ['aa:bb:cc:dd:ee:ff']; x.ifaces.ap_5g.macfilter = 'allow'; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'ap_5g', values: { network: ['lan', 'guest', 'wwan'], macfilter: 'allow', maclist: ['aa:bb:cc:dd:ee:ff'] } }]), 'several networks and the MAC list are written as lists', j(m.plan(w, d)));
d = draftOf(w, x => { x.ifaces.ap_2g.key = 'a new password'; x.ifaces.ap_2g.ssid = 'home'; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'ap_2g', values: { key: 'a new password' } }]), 'a typed password is written as typed (not trimmed), and only then', j(m.plan(w, d)));
const review = j(m.changesOf(w, d));
check(!review.includes('a new password') && /new value \(hidden\)/.test(review) && /set \(hidden\)/.test(review), 'the review never shows a password, only that it will be replaced', review);
d = draftOf(w, x => { x.ifaces.ap_2g.key = ' spaced '; });
check(m.plan(w, d)[0].values.key === ' spaced ', 'a password keeps its leading and trailing spaces');
d = draftOf(w, x => { x.ifaces.ap_2g.encryption = ''; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'ap_2g', values: { encryption: 'none' } }, { op: 'delete', config: 'wireless', section: 'ap_2g', options: ['key'] }]), 'going open writes none explicitly and removes the password that no longer applies', j(m.plan(w, d)));
d = draftOf(w, x => { x.ifaces.cfg0a1b2c.encryption = 'psk2'; x.ifaces.cfg0a1b2c.key = 'hunter2hunter2'; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'cfg0a1b2c', values: { encryption: 'psk2', key: 'hunter2hunter2' } }]), 'an unnamed section is addressed by its generated name');
d = draftOf(w, x => { x.ifaces.ap_2g.ieee80211r = false; x.ifaces.ap_2g.mobility_domain = 'abcd'; });
check(j(m.plan(w, d)) === j([{ op: 'set', config: 'wireless', section: 'ap_2g', values: { ieee80211r: '0' } }]), 'options that only apply with 802.11r are neither shown nor written when it is off');
d = draftOf(w, x => { m.removeIface(x, 'ap_5g'); });
check(j(m.plan(w, d)) === j([{ op: 'delete', config: 'wireless', section: 'ap_5g' }]) && m.changesOf(w, d)[0].label === 'Remove network "home"', 'a removed network is a delete of its section');
d = draftOf(w, x => { m.removeIface(x, 'ap_5g'); m.restoreIface(x, 'ap_5g'); });
check(m.plan(w, d).length === 0, 'removal can be taken back');

console.log('\n== adding networks ==');
d = draftOf(w);
const id = m.addIface(w, d, 'radio1', 'ap');
check(id === 'new1' && d.added[0].name === 'wifinet0' && d.ifaces[id].encryption === 'sae-mixed' && d.ifaces[id].network.join() === 'lan', 'a new access point is named wifinet0, protected with WPA2/WPA3 and attached to lan');
check(j(m.addIface(w, d, 'radio0', 'sta') && d.added.map(a => a.name)) === '["wifinet0","wifinet1"]' && d.ifaces.new2.encryption === 'psk2' && d.ifaces.new2.network.join() === 'wwan', 'a client network starts as WPA2 on wwan, and names do not repeat');
const taken = world(c => { c.interfaces.push(sec('wifinet0', { device: 'radio0', mode: 'ap', ssid: 'z', encryption: 'psk2' }, { key: true })); });
check(m.draftFrom(taken) && (() => { const t = draftOf(taken); m.addIface(taken, t, 'radio0', 'ap'); return t.added[0].name; })() === 'wifinet1', 'a name already used by a section is skipped');
const basicAp = world(c => { c.features = { eap: false, sae: false, owe: false, ft: false, wps: false }; });
check((() => { const t = draftOf(basicAp); const k = m.addIface(basicAp, t, 'radio0', 'ap'); return t.ifaces[k].encryption; })() === 'psk2', 'without SAE in hostapd a new access point starts as WPA2');
d = draftOf(w);
const nid = m.addIface(w, d, 'radio1', 'ap');
d.ifaces[nid].ssid = 'guest net';
d.ifaces[nid].key = 'guest-password';
d.ifaces[nid].network = ['guest'];
check(j(m.plan(w, d)) === j([{ op: 'add', config: 'wireless', type: 'wifi-iface', name: 'wifinet0', values: { device: 'radio1', mode: 'ap', ssid: 'guest net', network: 'guest', encryption: 'sae-mixed', key: 'guest-password' } }]), 'a new network is an add of a named section with only the options that differ from the defaults', j(m.plan(w, d)));
check(m.changesOf(w, d).length === 1 && /New network "guest net" on radio1/.test(m.changesOf(w, d)[0].label) && !j(m.changesOf(w, d)).includes('guest-password'), 'the review has one line for it, without the password');
m.removeIface(d, nid);
check(m.plan(w, d).length === 0 && !m.isDirty(w, d), 'discarding a network that was only added leaves nothing');

console.log('\n== wireless networks: validation ==');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.ssid = ''; }));
check(errorOf(p, 'if:ap_5g:ssid') && /enter the network name/.test(errorOf(p, 'if:ap_5g:ssid').text), 'an empty SSID is an error');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.ssid = 'é'.repeat(17); }));
check(errorOf(p, 'if:ap_5g:ssid') && /34 bytes/.test(errorOf(p, 'if:ap_5g:ssid').text), 'an SSID longer than 32 bytes is an error (17 two-byte characters are 34)', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.network = []; }));
check(errorOf(p, 'if:ap_5g:network'), 'an enabled network attached to nothing is an error');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.network = []; x.ifaces.ap_5g.disabled = true; }));
check(!errorOf(p, 'if:ap_5g:network'), 'a disabled one may be');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.network = ['lan', 'ghost']; }));
check(!p.errors.length && warned(p, /network "ghost" is not in \/etc\/config\/network/), 'a network that does not exist is a warning');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.key = 'short'; }));
check(errorOf(p, 'if:ap_5g:key') && /at least 8/.test(errorOf(p, 'if:ap_5g:key').text), 'a password under 8 characters is an error');
for (const [pw, ok] of [['x'.repeat(63), true], ['x'.repeat(64), false], ['0123456789abcdef'.repeat(4), true], ['g123456789abcdef'.repeat(4), false], ['p\u00e4ssw\u00f6rd', false], ['with spaces ok', true], ['x'.repeat(8), true]]) {
  p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.key = pw; }));
  check(Boolean(errorOf(p, 'if:ap_5g:key')) === !ok, `a password of ${pw.length} characters${/^[0-9a-f]+$/.test(pw) ? ' (hex)' : ''} is ${ok ? 'accepted' : 'refused'}`, j(p));
}
p = m.problems(w, draftOf(w, x => { x.ifaces.cfg0a1b2c.encryption = 'psk2'; }));
check(errorOf(p, 'if:cfg0a1b2c:key') && /needs a password/.test(errorOf(p, 'if:cfg0a1b2c:key').text), 'protecting an open network needs a password');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.encryption = 'psk2'; }));
check(!errorOf(p, 'if:ap_5g:key'), 'a stored password is kept when the encryption changes between password modes');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_2g.encryption = 'sae'; x.ifaces.ap_2g.ieee80211w = '0'; }));
check(errorOf(p, 'if:ap_2g:ieee80211w') && /WPA3 and Enhanced Open need protected management frames/.test(errorOf(p, 'if:ap_2g:ieee80211w').text), 'WPA3 with protected frames disabled is an error');
p = m.problems(w, draftOf(w, x => { x.ifaces.cfg0a1b2c.encryption = 'owe'; }));
check(!p.errors.length, 'Enhanced Open needs no password');
const lean = world(c => { c.features = { eap: false, sae: false, owe: false, ft: true, wps: false }; });
p = m.problems(lean, draftOf(lean, x => { x.ifaces.cfg0a1b2c.encryption = 'owe'; }));
check(errorOf(p, 'if:cfg0a1b2c:encryption') && /without Enhanced Open \(OWE\) support/.test(errorOf(p, 'if:cfg0a1b2c:encryption').text), 'an encryption the installed hostapd cannot do is an error that names the fix');
const unknown = world(c => { c.features = { eap: null, sae: null, owe: null, ft: null, wps: null }; });
p = m.problems(unknown, draftOf(unknown, x => { x.ifaces.cfg0a1b2c.encryption = 'owe'; }));
check(!p.errors.length, 'when hostapd could not be asked nothing is refused');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.maclist = ['aa:bb:cc', 'AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff']; x.ifaces.ap_5g.macfilter = 'deny'; }));
check(errorOf(p, 'if:ap_5g:maclist') && p.errors.length === 2 && p.errors.some(e => e.index === 0) && p.errors.some(e => /listed twice/.test(e.text)), 'a MAC address must be well formed and listed once', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.macfilter = 'allow'; }));
check(!p.errors.length && warned(p, /only allows the listed devices and the list is empty/), 'an allow filter with an empty list warns that nobody can connect');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.dtim_period = '300'; x.ifaces.ap_5g.maxassoc = '0'; x.ifaces.ap_5g.max_inactivity = 'x'; }));
check(p.errors.length === 3, 'numbers are checked against their ranges', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_2g.mobility_domain = 'xyz'; x.ifaces.ap_2g.nasid = 'x'.repeat(49); x.ifaces.ap_2g.r1_key_holder = '1234'; x.ifaces.ap_2g.reassociation_deadline = '5'; }));
check(errorOf(p, 'if:ap_2g:mobility_domain') && errorOf(p, 'if:ap_2g:nasid') && errorOf(p, 'if:ap_2g:r1_key_holder') && errorOf(p, 'if:ap_2g:reassociation_deadline'), 'the 802.11r identifiers are checked', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_2g.encryption = 'sae'; x.ifaces.ap_2g.pmk_r1_push = true; x.ifaces.ap_2g.ft_psk_generate_local = '1'; }));
check(warned(p, /PMK-R1 push breaks fast transition/) && warned(p, /generating the PSK keys locally breaks fast transition/), 'the 802.11r settings that break it with WPA3 warn');

console.log('\n== wireless networks: enterprise ==');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.encryption = 'wpa2'; }));
check(errorOf(p, 'if:ap_5g:auth_server') && errorOf(p, 'if:ap_5g:auth_secret') && !errorOf(p, 'if:ap_5g:key'), 'an enterprise access point needs a RADIUS server and its secret, not a password');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.encryption = 'wpa2'; x.ifaces.ap_5g.auth_server = 'radius.example.com'; x.ifaces.ap_5g.auth_secret = 'shared'; x.ifaces.ap_5g.auth_port = '1812'; }));
check(!p.errors.length, 'and is fine with them', j(p));
d = draftOf(w, x => { x.ifaces.ap_5g.encryption = 'wpa2'; x.ifaces.ap_5g.auth_server = 'radius.example.com'; x.ifaces.ap_5g.auth_secret = 'shared'; });
check(m.plan(w, d)[0].values.auth_server === 'radius.example.com' && m.plan(w, d)[0].values.auth_secret === 'shared' && m.plan(w, d)[0].values.encryption === 'wpa2' && m.plan(w, d)[1]?.options?.join() === 'key', 'the RADIUS options are written and the old password is removed');
const eapW = world(c => { c.interfaces.push(sec('uplink', { device: 'radio1', mode: 'sta', ssid: 'corp', encryption: 'wpa2', network: 'wwan' }, {})); });
p = m.problems(eapW, draftOf(eapW, x => { x.ifaces.uplink.ssid = 'corp2'; }));
check(errorOf(p, 'if:uplink:eap_type'), 'an enterprise client needs an EAP method');
p = m.problems(eapW, draftOf(eapW, x => { x.ifaces.uplink.eap_type = 'peap'; }));
check(errorOf(p, 'if:uplink:identity') && errorOf(p, 'if:uplink:password'), 'PEAP needs an identity and a password');
p = m.problems(eapW, draftOf(eapW, x => { x.ifaces.uplink.eap_type = 'tls'; }));
check(errorOf(p, 'if:uplink:client_cert') && errorOf(p, 'if:uplink:priv_key') && !errorOf(p, 'if:uplink:identity'), 'TLS needs a client certificate and a key file');
p = m.problems(eapW, draftOf(eapW, x => { x.ifaces.uplink.eap_type = 'peap'; x.ifaces.uplink.identity = 'me'; x.ifaces.uplink.password = 'pw'; x.ifaces.uplink.ca_cert = 'ca.pem'; }));
check(errorOf(p, 'if:uplink:ca_cert') && p.errors.length === 1, 'a certificate path must be absolute', j(p));

console.log('\n== wireless networks: the dangerous changes ==');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.encryption = ''; }));
check(!p.errors.length && warned(p, /home: this network is open: anyone in range can join it and reach lan, guest/), 'opening a network warns who can join and what they reach', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.cfg0a1b2c.ssid = 'still open'; }));
check(!p.errors.length && warned(p, /still open: this network is open/) === false && warned(p, /open: this network is open/), 'an open network that stays open is warned about whenever it is changed', j(p));
for (const [enc, re] of [['wep', /WEP can be broken/], ['psk', /WPA version 1 is outdated/], ['psk2+tkip+ccmp', /TKIP is deprecated/]]) {
  const was = world(c => { c.interfaces[2].values.encryption = 'sae'; });
  p = m.problems(was, draftOf(was, x => { x.ifaces.ap_5g.encryption = enc; }));
  check(warned(p, re), `choosing ${enc} warns about weak protection`, j(p));
}
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.ssid = 'renamed'; }));
check(!p.errors.length && warned(p, /home: this change \(the name\) disconnects 1 client connected now, and they must reconnect.*you lose access, and the router undoes the change by itself 30 seconds/), 'renaming a network warns that its connected clients are disconnected and the admin may lose access', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_2g.key = 'brand-new-pass'; x.ifaces.ap_2g.hidden = true; }));
check(warned(p, /this change \(the password, hiding the name\) disconnects 3 clients.*with the new password/) && warned(p, /a hidden SSID is not a protection/), 'a new password and a hidden name are named in the warning', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_2g.wmm = false; x.ifaces.ap_2g.isolate = true; }));
check(!warned(p, /disconnects/), 'changes that do not drop clients (isolation, WMM) do not warn about it');
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_2g.disabled = true; }));
check(warned(p, /this change \(switching it off\) disconnects 3 clients/), 'disabling a network warns');
p = m.problems(w, draftOf(w, x => { m.removeIface(x, 'ap_2g'); }));
check(warned(p, /home: this network is removed, which disconnects 3 clients/), 'removing a running network warns');
const quiet = world(c => { c.interfaces[0].values.disabled = '1'; });
p = m.problems(quiet, draftOf(quiet, x => { x.ifaces.ap_2g.ssid = 'renamed'; }));
check(!warned(p, /disconnects/), 'changing a network that is switched off disconnects nobody');
p = m.problems(w, draftOf(w, x => { x.ifaces.cfg0a1b2c.ssid = 'home'; x.ifaces.ap_5g.ssid = 'home'; x.ifaces.cfg0a1b2c.encryption = 'psk2'; x.ifaces.cfg0a1b2c.key = 'longenough1'; }));
check(warned(p, /radio1: ap_5g and cfg0a1b2c broadcast the same SSID "home" on the same radio/), 'two networks with one SSID on one radio warn', j(p));
p = m.problems(w, draftOf(w, x => { x.ifaces.ap_5g.ssid = 'home'; }));
check(!warned(p, /same SSID/), 'the same SSID on two radios is normal (roaming) and does not warn');
const idn = draftOf(w);
const k1 = m.addIface(w, idn, 'radio1', 'sta');
idn.ifaces[k1].ssid = 'upstream'; idn.ifaces[k1].key = 'upstream-pass';
p = m.problems(w, idn);
check(!p.errors.length && warned(p, /client network makes this router join/) && warned(p, /share its channel: the access point moves/), 'a client network on a radio that has an access point warns that they share a channel', j(p));

console.log('\n== mesh points ==');
// The flab.mesh status of the mesh point of the fixture: two established peers.
const MESH = { nodes: [{ section: 'mesh_2g', peers: [{ plink: 'ESTAB' }, { plink: 'ESTAB' }, { plink: 'LISTEN' }] }] };
const wm = m.readWifi(STATUS(), CONFIG(), MESH);
const meshCtx = (i, v) => m.ifaceCtx(wm, i, v);
const shownKeys = i => s.IFACE_FIELDS.filter(f => m.isShown(f, m.draftFrom(wm).ifaces[i.section], meshCtx(i, m.draftFrom(wm).ifaces[i.section]))).map(f => f.key);
check(shownKeys(wm.ifaces[1]).join() === 'mesh_id,network,encryption,key,mcast_rate,disabled' && !shownKeys(wm.ifaces[0]).includes('mesh_id') && !shownKeys(wm.ifaces[0]).includes('mcast_rate'), 'a mesh point shows its own options (Mesh ID, encryption, password, networks, multicast rate, disable) and none of an access point\'s');
check(m.ifaceTitle(m.ifaceList(wm, m.draftFrom(wm)).find(i => i.section === 'mesh_2g'), m.draftFrom(wm).ifaces.mesh_2g) === 'meshy', 'a mesh point goes by its Mesh ID');
p = m.problems(wm, draftOf(wm, x => { x.ifaces.mesh_2g.mesh_id = 'renamed'; }));
check(warned(p, /meshy: this change \(the Mesh ID\) disconnects 2 mesh peers connected now, and the other nodes must use the same settings to rejoin/), 'changing the Mesh ID warns with the established peers it cuts off', j(p));
p = m.problems(wm, draftOf(wm, x => { x.ifaces.mesh_2g.key = 'brand-new-pass'; }));
check(!p.errors.length && warned(p, /\(the password\) disconnects 2 mesh peers/), 'a new password warns the same way');
p = m.problems(wm, draftOf(wm, x => { x.ifaces.mesh_2g.encryption = ''; }));
check(!p.errors.length && warned(p, /this mesh is open: any device in range that uses the Mesh ID "meshy"/), 'an open mesh is called out', j(p));
p = m.problems(wm, draftOf(wm, x => { m.removeIface(x, 'mesh_2g'); }));
check(warned(p, /meshy: this mesh point is removed, which disconnects 2 mesh peers/), 'removing a mesh point warns');
const dm = draftOf(wm);
const mid = m.addIface(wm, dm, 'radio1', 'mesh');
check(dm.ifaces[mid].encryption === 'sae' && dm.ifaces[mid].network.join() === 'lan' && m.ifaceTitle(m.ifaceList(wm, dm).find(i => i.id === mid), dm.ifaces[mid]) === 'New mesh point', 'a new mesh point starts with SAE on lan');
p = m.problems(wm, dm);
check(errorOf(p, `if:${mid}:mesh_id`) && errorOf(p, `if:${mid}:key`) && !errorOf(p, `if:${mid}:ssid`), 'it needs a Mesh ID and a password, and never an SSID', j(p));
dm.ifaces[mid].mesh_id = 'x'.repeat(33); dm.ifaces[mid].key = 'long-enough-pw';
check(/at most 32 bytes/.test(errorOf(m.problems(wm, dm), `if:${mid}:mesh_id`)?.text ?? ''), 'a Mesh ID over 32 bytes is an error');
dm.ifaces[mid].mesh_id = 'second';
p = m.problems(wm, dm);
check(!p.errors.length && warned(p, /shares a network with the mesh point on radio0.*layer 2 loop.*mesh11sd/), 'two mesh backhauls on one network warn about the loop spanning tree cannot see', j(p));
dm.ifaces[mid].network = ['guest'];
check(!m.problems(wm, dm).errors.length && warned(m.problems(wm, dm), /spanning tree has no effect on a mesh, so a cable/), 'a mesh on its own network warns about cables instead');
check(j(m.plan(wm, dm)) === j([{ op: 'add', config: 'wireless', type: 'wifi-iface', name: 'wifinet0', values: { device: 'radio1', mode: 'mesh', mesh_id: 'second', network: 'guest', encryption: 'sae', key: 'long-enough-pw' } }]), 'a new mesh point is added with its mesh options only', j(m.plan(wm, dm)));
const noSae = m.readWifi(STATUS(), Object.assign(CONFIG(), { features: { sae: false } }), MESH);
const dn = draftOf(noSae); const nid2 = m.addIface(noSae, dn, 'radio1', 'mesh');
check(dn.ifaces[nid2].encryption === '', 'without SAE a new mesh point starts open, which the checks then warn about');
dn.ifaces[nid2].mesh_id = 'plain'; dn.ifaces[nid2].encryption = 'sae'; dn.ifaces[nid2].key = 'long-enough-pw';
check(/wpad was built without WPA3 \(SAE\) support/.test(errorOf(m.problems(noSae, dn), `if:${nid2}:encryption`)?.text ?? ''), 'SAE on a router whose wpad lacks it is an error that names the package');
d = draftOf(wm, x => { x.ifaces.mesh_2g.mcast_rate = '12000'; });
check(j(m.plan(wm, d)) === j([{ op: 'set', config: 'wireless', section: 'mesh_2g', values: { mcast_rate: '12000' } }]), 'the multicast rate of a mesh point is written as it is');

console.log('\n== the check after a save ==');
// The reply of `flab.radio config` as the router holds it after `plan(w, d)` was applied: the config with the changes made, and
// anonymous sections renamed (their generated name follows their content).
function apply(base, d) {
  const c = CONFIG();
  const ops = m.plan(base, d);
  let renamed = 0;
  for (const o of ops) {
    if (o.op === 'add') c.interfaces.push(sec(o.name, o.values, o.values.key ? { key: true } : {}));
    else if (o.op === 'delete' && !o.options) c.interfaces = c.interfaces.filter(i => i.section !== o.section);
    else {
      const target = [...c.radios, ...c.interfaces].find(x => x.section === o.section);
      if (o.op === 'set') for (const [k, v] of Object.entries(o.values)) { if (s.IFACE_FIELDS.find(f => f.key === k)?.secret) target.secrets[k] = true; else target.values[k] = v; }
      else for (const k of o.options) { delete target.values[k]; delete target.secrets[k]; }
      if (target.anonymous) { target.section = `cfg${(++renamed).toString(16).padStart(6, '0')}`; }
    }
  }
  return c;
}
d = draftOf(w, x => { x.radios.radio1.htmode = 'HE80'; x.ifaces.ap_5g.ssid = 'home-5'; x.ifaces.ap_2g.key = 'brand-new-pass'; x.ifaces.cfg0a1b2c.ssid = 'open too'; });
let msg = null;
try { m.checkApplied(w, d, apply(w, d)); } catch (e) { msg = e.message; }
check(msg === null, 'a change that was kept passes, even when an unnamed section got a new name', String(msg));
const dropped = apply(w, d);
dropped.interfaces[2].values.ssid = 'home';
try { m.checkApplied(w, d, dropped); } catch (e) { msg = e.message; }
check(/home: SSID was not saved/.test(msg ?? ''), 'a value that did not stick is named', String(msg));
const nokey = apply(w, d);
nokey.interfaces[0].secrets = {};
msg = null;
try { m.checkApplied(w, d, nokey); } catch (e) { msg = e.message; }
check(/home: Password was not saved/.test(msg ?? ''), 'a password that was typed and is not stored is reported, without ever reading it', String(msg));
d = draftOf(w);
const nn = m.addIface(w, d, 'radio1', 'ap'); d.ifaces[nn].ssid = 'new one'; d.ifaces[nn].key = 'long-enough-pw'; m.removeIface(d, 'ap_5g');
const after = apply(w, d);
msg = null;
try { m.checkApplied(w, d, after); } catch (e) { msg = e.message; }
check(msg === null && after.interfaces.map(i => i.section).join() === 'ap_2g,mesh_2g,cfg0a1b2c,wifinet0', 'an added network is at the end, a removed one is gone', `${msg} ${after.interfaces.map(i => i.section)}`);
const kept = apply(w, d); kept.interfaces.pop();
try { m.checkApplied(w, d, kept); } catch (e) { msg = e.message; }
check(/wireless networks \(4 expected, 3 found\) was not saved|wireless networks.*not saved/.test(msg ?? ''), 'a network that was not added is reported', String(msg));
const radioLost = apply(w, draftOf(w, x => { x.radios.radio1.txpower = '17'; }));
radioLost.radios[1].values.txpower = '20';
try { m.checkApplied(w, draftOf(w, x => { x.radios.radio1.txpower = '17'; }), radioLost); } catch (e) { msg = e.message; }
check(/radio1: Transmit power \(dBm\) was not saved/.test(msg ?? ''), 'a radio option that did not stick is reported', String(msg));

console.log('\n== what to wait for ==');
d = draftOf(w, x => { x.radios.radio1.htmode = 'HE80'; });
check(j(m.upTargets(w, d, apply(w, d))) === j([{ radio: 'radio1', sections: [] }]), 'only the radio that changed is waited for');
d = draftOf(w, x => { x.ifaces.ap_5g.ssid = 'home-5'; x.ifaces.ap_2g.wmm = false; });
check(j(m.upTargets(w, d, apply(w, d))) === j([{ radio: 'radio0', sections: ['ap_2g'] }, { radio: 'radio1', sections: ['ap_5g'] }]), 'a changed network must be running again', j(m.upTargets(w, d, apply(w, d))));
d = draftOf(w, x => { x.ifaces.ap_5g.disabled = true; x.ifaces.cfg0a1b2c.disabled = true; });
check(j(m.upTargets(w, d, apply(w, d))) === j([]), 'a radio whose networks are all switched off is not waited for', j(m.upTargets(w, d, apply(w, d))));
d = draftOf(w, x => { x.radios.radio0.disabled = true; x.radios.radio1.txpower = '17'; });
check(j(m.upTargets(w, d, apply(w, d)).map(t => t.radio)) === '["radio1"]', 'a radio the draft switches off is not waited for');
d = draftOf(w);
const nw = m.addIface(w, d, 'radio1', 'ap'); d.ifaces[nw].ssid = 'x'; d.ifaces[nw].key = 'long-enough-pw';
check(j(m.upTargets(w, d, apply(w, d))) === j([{ radio: 'radio1', sections: ['wifinet0'] }]), 'an added network is waited for by its section name');
d = draftOf(w, x => { m.removeIface(x, 'ap_5g'); });
check(j(m.upTargets(w, d, apply(w, d))) === j([{ radio: 'radio1', sections: [] }]), 'a radio that lost a network is waited for');

console.log('\n== the encryption values ==');
const e = s.encryptionInfo;
check(e('').kind === 'none' && e('none').kind === 'none' && e('owe').pmf && e('sae').sae && e('sae').key && e('sae-mixed').kind === 'psk-sae' && e('psk2').key && !e('psk2').weak && e('psk2+ccmp').kind === 'psk', 'modes are classified by the part before the first +');
check(e('wep+open').weak && e('psk').weak && e('psk-mixed').weak && e('psk2+tkip').weak && e('psk2+tkip+ccmp').weak && !e('psk2+aes').weak && e('wpa2').kind === 'eap' && e('wpa3').pmf && e('wpa').weak, 'WEP, WPA1 and TKIP are weak');
check(s.keyError('12345678') === null && s.keyError('1234567') !== null && s.ssidError('x'.repeat(32)) === null && s.ssidError('x'.repeat(33)) !== null, 'the value checks for passwords and SSIDs');
check(ENC_ALL(), 'every encryption the page offers is known to encryptionInfo');
function ENC_ALL() { return s.ENCRYPTIONS.every(x => e(x.value).kind !== 'other' && (e(x.value).needs ?? null) === (x.needs ?? null)); }

console.log(failed ? `\n${failed} check(s) failed` : '\nall Wi-Fi editing model checks passed');
process.exit(failed ? 1 : 0);
