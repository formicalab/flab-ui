// Unit test for the Wi-Fi channel model (www/js/pages/wifi/channels.js): the width, the span a channel would
// occupy, what the draft changes, the errors and warnings, the operations and the read-back check. Pure
// functions: no router and no browser. Usage: node model.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const m = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../www/js/pages/wifi/channels.js')).href);

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
const j = JSON.stringify;

// A channel entry of the flab.radio reply; `flags` may hold { disabled, dfs }.
const ch = (band, n, flags = {}) => ({ channel: n, freq: (band === '6g' ? 5950 : band === '2g' ? 2407 : 5000) + 5 * n, max_power: flags.disabled ? null : 23, disabled: Boolean(flags.disabled), dfs: Boolean(flags.dfs), no_ir: false });
// A 2.4 GHz radio like the router's radio0 (channels 1-13), and a 5 GHz radio like radio1 (Italy: 36-64, 100-140 with radar detection, 149-165).
const radio2g = (config = {}, extra = {}) => ({ name: 'radio0', band: '2g', enabled: true, up: true, config: { channel: '6', htmode: 'HE40', ...config },
  channels: Array.from({ length: 13 }, (_, i) => ch('2g', i + 1)), interfaces: [{ mode: 'ap', ssid: 'home' }], ...extra });
const band5 = [...[36, 40, 44, 48, 52, 56, 60, 64].map(n => ch('5g', n, n >= 52 ? { dfs: true } : {})), ...[100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140].map(n => ch('5g', n, { dfs: true })), ...[149, 153, 157, 161, 165].map(n => ch('5g', n))];
// A 5 GHz radio with the full channel list and one AP, with `config` and `extra` applied on top.
const radio5g = (config = {}, extra = {}) => ({ name: 'radio1', band: '5g', enabled: true, up: true, config: { channel: '104', htmode: 'HE160', ...config }, channels: band5, interfaces: [{ mode: 'ap', ssid: 'home' }], ...extra });
// A hardware description holding `radios`.
const hwOf = (...radios) => ({ radios });
// A draft taken from `hw`, then modified by `edit`.
const draftOf = (hw, edit) => { const d = m.draftFrom(hw); edit?.(d); return d; };

console.log('== width ==');
check(m.widthOf('HE160') === 160 && m.widthOf('VHT80') === 80 && m.widthOf('HT40+') === 40 && m.widthOf('HT20') === 20 && m.widthOf('EHT320') === 320, 'the width comes from the htmode');
check(m.widthOf(undefined) === 20 && m.widthOf('NOHT') === 20, 'an htmode without a number is 20 MHz');

console.log('== the span a channel would occupy ==');
const r5 = radio5g();
let s = m.spanOf(r5, 36, 80);
check(s.fits && j(s.channels) === '[36,40,44,48]' && s.lo === 5170 && s.hi === 5250, '80 MHz at channel 36 is the block 36-48 (5170-5250 MHz)', j(s));
s = m.spanOf(r5, 44, 80);
check(j(s.channels) === '[36,40,44,48]', 'any channel of a block gives the whole block', j(s));
s = m.spanOf(r5, 104, 160);
check(s.fits && j(s.channels) === '[100,104,108,112,116,120,124,128]' && s.lo === 5490 && s.hi === 5650, '160 MHz at channel 104 is the block 100-128', j(s));
check(!m.spanOf(r5, 132, 160).fits, '160 MHz does not fit at channel 132 (the block would run past 144)');
check(m.spanOf(r5, 149, 80).fits && !m.spanOf(r5, 149, 160).fits, '80 MHz fits at 149-161, 160 MHz does not exist there');
check(j(m.spanOf(r5, 100, 20).channels) === '[100]' && m.spanOf(r5, 100, 20).lo === 5490, '20 MHz is the channel alone');
check(!m.spanOf(radio5g({}, { channels: band5.map(c => c.channel === 52 ? { ...c, disabled: true } : c) }), 36, 160).fits, 'a block with one disabled channel does not fit');
check(!m.spanOf(r5, 7, 20).fits && m.spanOf(r5, 7, 20).channels.length === 0, 'an unknown channel fits nowhere');
const r2 = radio2g();
s = m.spanOf(r2, 6, 20);
check(s.fits && s.lo === 2427 && s.hi === 2447 && j(s.channels) === '[6]' && j(s.inside) === '[]' && j(s.overlap) === '[3,4,5,7,8,9]' && s.secondary === null, 'a 20 MHz channel on 2.4 GHz is that channel; the three on each side are partly overlapped', j(s));
s = m.spanOf(r2, 6, 40);
check(s.fits && s.secondary === 'above' && s.lo === 2427 && s.hi === 2467 && j(s.channels) === '[6,10]' && j(s.inside) === '[7,8,9]' && j(s.overlap) === '[3,4,5,11,12,13]', '40 MHz on channel 6 is channel 6 and the one above it (10), covering 6-10 with three channels partly overlapped on each side', j(s));
s = m.spanOf(r2, 4, 40);
check(j(s.channels) === '[4,8]' && j(s.inside) === '[5,6,7]' && s.lo === 2417 && s.hi === 2457, '40 MHz on channel 4 is channels 4 and 8 side by side in frequency (2417-2457 MHz), covering 4-8', j(s));
s = m.spanOf(r2, 7, 40);
check(s.secondary === 'below' && j(s.channels) === '[3,7]' && s.lo === 2412 && s.hi === 2452, 'channels from 7 up use the channel below as the second half, as netifd does', j(s));
s = m.spanOf(r2, 13, 40);
check(s.fits && s.secondary === 'below' && s.lo === 2442 && s.hi === 2482 && j(s.channels) === '[9,13]' && j(s.inside) === '[10,11,12]', '40 MHz on channel 13 is channels 9 and 13', j(s));
check(m.spanOf(radio2g({ htmode: 'HT40-' }), 9, 40).secondary === 'below' && m.spanOf(radio2g({ htmode: 'HT40+' }), 9, 40).secondary === 'above' && j(m.spanOf(radio2g({ htmode: 'HT40+' }), 9, 40).channels) === '[9,13]', 'an explicit HT40+ or HT40- in the htmode decides the side');
check(!m.spanOf(radio2g({ htmode: 'HT40-' }), 2, 40).fits, 'a second half that does not exist (below channel 2) does not fit');
const only = radio2g({}, { channels: [ch('2g', 1), ch('2g', 6)] });
check(!m.spanOf(only, 6, 40).fits, '40 MHz does not fit without the second channel four numbers away');
const r6 = { name: 'radio2', band: '6g', config: { htmode: 'EHT80' }, channels: [1, 5, 9, 13, 17].map(n => ch('6g', n)) };
s = m.spanOf(r6, 5, 80);
check(s.fits && j(s.channels) === '[1,5,9,13]' && s.lo === 5945 && s.hi === 6025, '6 GHz blocks start at channel 1 in steps of four channels', j(s));

console.log('== the channels a radio runs on ==');
let run = m.runningBlock(radio2g({}, { live: { channel: 6, width: 40, center: 2447 } }));
check(j(run.channels) === '[6,10]' && j(run.inside) === '[7,8,9]', 'a 40 MHz radio on 2.4 GHz runs on two channels and covers the three between them');
check(j(m.runningBlock(radio5g({}, { live: { channel: 104, width: 160, center: 5570 } })).channels) === '[100,104,108,112,116,120,124,128]', 'a 160 MHz radio runs on the eight channels of its block');
check(j(m.runningBlock(radio5g({}, { live: { channel: 36, width: 20, center: 5180 } })).channels) === '[36]' && m.runningBlock(radio5g({}, { live: undefined })).channels.length === 0, 'a 20 MHz radio runs on one channel, a radio that is down on none');

console.log('== the draft and what it changes ==');
const hw = hwOf(radio2g(), radio5g());
const d0 = m.draftFrom(hw);
check(j(d0) === j({ radios: { radio0: { channel: '6' }, radio1: { channel: '104' } } }), 'the draft holds the configured channel of every radio');
check(j(m.draftFrom(hwOf(radio2g({ channel: undefined })))) === j({ radios: { radio0: { channel: 'auto' } } }), 'a radio with no channel option is on auto');
check(!m.isDirty(hw, d0) && m.changesOf(hw, d0).length === 0 && m.plan(hw, d0).length === 0, 'an untouched draft changes nothing');
const d1 = draftOf(hw, x => { x.radios.radio1.channel = '36'; });
check(j(m.changesOf(hw, d1)) === j([{ key: 'radio1:channel', label: 'radio1: channel', from: '104', to: '36' }]) && m.isDirty(hw, d1), 'a new channel is one change with its from and to');
check(j(m.plan(hw, d1)) === j([{ op: 'set', config: 'wireless', section: 'radio1', values: { channel: '36' } }]), 'the plan sets only that radio\'s channel option');
const d2 = draftOf(hw, x => { x.radios.radio0.channel = 'auto'; x.radios.radio1.channel = '40'; });
check(m.plan(hw, d2).length === 2 && m.plan(hw, d2)[0].values.channel === 'auto', 'two radios are two operations, auto included');

console.log('== errors and warnings ==');
let p = m.problems(hw, d0);
check(!p.errors.length && !p.warnings.length, 'nothing to report while nothing changes');
const hw80 = hwOf(radio5g({ htmode: 'HE80' }));
p = m.problems(hw80, draftOf(hw80, x => { x.radios.radio1.channel = '36'; }));
check(!p.errors.length && !p.warnings.length, 'a free channel that fits and is not DFS is fine', j(p));
p = m.problems(hw, draftOf(hw, x => { x.radios.radio1.channel = '36'; }));
check(!p.errors.length && /radar \(DFS\)/.test(p.warnings.join()), 'a 160 MHz block starting at 36 reaches the DFS channels, so it warns too', j(p));
p = m.problems(hw, draftOf(hw, x => { x.radios.radio1.channel = '52'; }));
check(!p.errors.length && /radar \(DFS\)/.test(p.warnings.join()), 'a DFS block gets the radar warning', j(p));
p = m.problems(hw, draftOf(hw, x => { x.radios.radio1.channel = '149'; }));
check(p.errors.length === 1 && p.errors[0].key === 'radio1:channel' && /cannot carry HE160/.test(p.errors[0].text), 'a channel that cannot carry the width is an error on its control', j(p));
p = m.problems(hw, draftOf(hw, x => { x.radios.radio1.channel = '999'; }));
check(p.errors.length === 1 && /not allowed/.test(p.errors[0].text), 'a channel the radio does not list is an error', j(p));
p = m.problems(hw, draftOf(hw, x => { x.radios.radio1.channel = 'abc'; }));
check(p.errors.length === 1, 'text that is not a channel is an error');
const off = hwOf(radio5g({}, { channels: band5.map(c => c.channel === 36 ? { ...c, disabled: true } : c) }));
check(m.problems(off, draftOf(off, x => { x.radios.radio1.channel = '36'; })).errors.length === 1, 'a channel the regulatory domain disables is an error');
const meshHw = hwOf(radio2g({}, { interfaces: [{ mode: 'ap', ssid: 'home' }, { mode: 'mesh', ssid: 'mesh-id' }] }));
p = m.problems(meshHw, draftOf(meshHw, x => { x.radios.radio0.channel = '11'; }));
check(!p.errors.length && /mesh interface mesh-id/.test(p.warnings.join()), 'a mesh interface on the radio is a warning to move the other nodes', j(p));
p = m.problems(hw, draftOf(hw, x => { x.radios.radio0.channel = 'auto'; }));
check(!p.errors.length && /auto/.test(p.warnings.join()), 'auto is allowed, with a note');
p = m.problems(hw, draftOf(hw, x => { x.radios.radio0.channel = '11'; x.radios.radio1.channel = '149'; }));
check(p.errors.length === 1 && p.errors[0].key === 'radio1:channel', 'each radio is judged on its own');
const odd = hwOf(radio5g({ channel: '149' }));
check(m.problems(odd, m.draftFrom(odd)).errors.length === 0, 'a configuration that is already odd is not reported until it is changed');

console.log('== usable channels ==');
check(m.canUse(r5, 36) && !m.canUse(r5, 149) && !m.canUse(r5, 7), 'canUse says whether a channel can be chosen at the configured width');
check(m.editable(r5) && !m.editable({ name: 'x' }) && !m.editable({ name: 'x', channels: [] }), 'a radio is editable when the phy listed its channels');

console.log('== reading back after apply ==');
const after = m.readChannels({ radio0: { channel: '6', htmode: 'HE40' }, radio1: { channel: '36' }, radio2: {} });
check(j(after) === j({ radio0: { channel: '6' }, radio1: { channel: '36' }, radio2: { channel: 'auto' } }), 'the channel of each radio is read from its own section');
let msg = null;
try { m.checkApplied(after, d1); } catch (e) { msg = e.message; }
check(msg === null, 'the draft was stored');
try { m.checkApplied(m.readChannels({ radio1: { channel: '104' } }), d1); } catch (e) { msg = e.message; }
check(/radio1: channel was not saved/.test(msg ?? ''), 'a channel that did not stick is reported', String(msg));

console.log(failed ? `\n${failed} check(s) failed` : '\nall Wi-Fi channel checks passed');
process.exit(failed ? 1 : 0);
