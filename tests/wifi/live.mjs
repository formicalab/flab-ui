// Browser test for changing a radio's channel on the Wi-Fi page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the radio cards show the channel picker built from the router's own
//    channel lists, hovering previews the block a channel would use, and any uci write the page might send in this
//    phase is blocked and fails the test.
// 2. Against a mock of the flab.radio and flab.wifi plugins and a stateful mock of rpcd's `uci` object: the whole
//    editing flow - hover previews, choosing a channel that fits, one that does not, Auto, the review banner and
//    its warnings, a successful save, a change the router does not keep, a radio that does not come back up, a
//    login that may not write, the dark theme and an expired session - WITHOUT touching the router's wireless config.
// Usage: node live.mjs   (env: FLAB_SID and FLAB_ACLS from tests/TestSession.ps1, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import path from 'node:path';

const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;
const rootAcls = JSON.parse(process.env.FLAB_ACLS);   // what the session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };
// A deep copy of `o`, so each scenario can mutate its own state.
const clone = o => JSON.parse(JSON.stringify(o));

//#region The mock router
// A channel entry like the flab.radio reply's.
const chan = (band, n, flags = {}) => ({ channel: n, freq: (band === '2g' ? 2407 : 5000) + 5 * n, max_power: 23, disabled: false, dfs: Boolean(flags.dfs), no_ir: false });
const BAND5 = [...[36, 40, 44, 48].map(n => chan('5g', n)), ...[52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140].map(n => chan('5g', n, { dfs: true })), ...[149, 153, 157, 161, 165].map(n => chan('5g', n))];
// An access point interface as the plugin reports it.
const ap = (ifname, section) => ({ section, ifname, mode: 'ap', ssid: 'home', networks: ['lan'], encryption: 'sae-mixed', security: 'WPA3', enabled: true, hidden: false, isolate: false, max_clients: null, macfilter: null,
  features: { roaming_11r: true, neighbor_11k: true, bss_transition_11v: true, wps: false, ocv: false, proxy_arp: false, wnm_sleep: false }, up: true, bssid: '94:83:C4:A2:15:C5', bss_status: 'ENABLED', clients: 0, rx_bytes: 1000, tx_bytes: 2000 });
// The mock radios, built fresh for each scenario.
const RADIOS = () => [
  { name: 'radio0', phy: 'phy0', band: '2g', enabled: true, up: true, pending: false, retry_failed: false,
    config: { channel: '6', htmode: 'HE40', country: 'IT', txpower: null, cell_density: 0, noscan: false, legacy_rates: false, beacon_int: null, path: 'platform/soc/18000000.wifi' },
    interfaces: [ap('phy0-ap0', 'ap_2g'), { ...ap('phy0-mesh0', 'mesh_2g'), mode: 'mesh', ssid: 'formicalabmesh' }],
    antennas: { tx: 4, rx: 4 }, standards: ['802.11n', '802.11ax'], channels: Array.from({ length: 13 }, (_, i) => chan('2g', i + 1)),
    live: { channel: 6, freq: 2437, width: 40, center: 2447, txpower: 20 }, survey: { freq: 2437, noise: -92, active: 1000, busy: 100, rx: 50, tx: 20 }, hardware: { hardware: 'MediaTek MT7986', hwmodes: 'ax/n' } },
  { name: 'radio1', phy: 'phy1', band: '5g', enabled: true, up: true, pending: false, retry_failed: false,
    config: { channel: '104', htmode: 'HE160', country: 'IT', txpower: null, cell_density: 0, noscan: true, legacy_rates: false, beacon_int: null, path: 'platform/soc/18000000.wifi+1' },
    interfaces: [ap('phy1-ap0', 'ap_5g')],
    antennas: { tx: 4, rx: 4 }, standards: ['802.11n', '802.11ac', '802.11ax'], channels: BAND5,
    live: { channel: 104, freq: 5520, width: 160, center: 5570, txpower: 23 }, survey: { freq: 5520, noise: -95, active: 1000, busy: 80, rx: 40, tx: 10 }, hardware: { hardware: 'MediaTek MT7986', hwmodes: 'ax/ac/n' } },
];
// The wireless config as `uci get wireless <radio>` returns it: only the radios' own sections are ever read.
const baseCfg = () => Object.fromEntries(RADIOS().map(r => [r.name, { '.anonymous': false, '.type': 'wifi-device', '.name': r.name, ...r.config, channel: r.config.channel, band: r.band }]));

const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
const mock = { on: false, cfg: baseCfg(), staged: [], restage: [], snapshot: null, calls: [], dropWrites: false, confirmFails: false, expired: false, radioDown: false, unsafe: [], radioCalls: 0 };

// Applies the staged edits to the mock's config, the way rpcd's uci apply does.
function commit() {
  for (const [op, section, option, value] of mock.staged) if (op === 'set') mock.cfg[section][option] = value;
}

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') return [0, { values: clone(args.section ? mock.cfg[args.section] : mock.cfg) }];
  if (method === 'changes') return [0, { changes: mock.staged.map(c => c.slice(0, 4)) }];
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'revert') { mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.snapshot = clone(mock.cfg);
    mock.restage = mock.staged;
    if (!mock.dropWrites) commit();
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
    if (mock.confirmFails) { mock.cfg = mock.snapshot; mock.staged = mock.restage; return [1]; }
    mock.snapshot = null;
    return [0, {}];
  }
  if (method === 'rollback') {
    if (mock.snapshot) { mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; }
    return [0, {}];
  }
  return [0, {}];
}

// The center frequency of the block a radio runs on when it is on channel `c`, for the widths this test uses:
// 40 MHz on 2.4 GHz is the channel plus the one four above it (channels 1-6) or below it (7-13), as netifd decides;
// 160 MHz on 5 GHz is 36-64 or 100-128.
const centerOf = (r, c) => r.band === '2g' ? c.freq + (c.channel < 7 ? 10 : -10) : c.channel <= 64 ? 5250 : 5570;

// The flab.radio reply from the mock config: what is configured is reported, and the radio runs on that channel.
function radioStatus() {
  mock.radioCalls++;
  const radios = RADIOS().map(r => {
    const channel = mock.cfg[r.name].channel;
    r.config.channel = channel;
    const c = r.channels.find(x => String(x.channel) === channel);
    if (c) r.live = { ...r.live, channel: c.channel, freq: c.freq, center: centerOf(r, c) };
    // While a change is applied and not yet confirmed, a radio that is made to fail does not come up.
    if (mock.radioDown && mock.snapshot) r.up = false;
    return r;
  });
  return { radios, regdomain: { country: 'IT', dfs: 'DFS-ETSI' } };
}

// The flab.wifi reply: the radios with their access points and no clients.
function clientsReply() {
  const radios = radioStatus().radios;
  mock.radioCalls--;
  return { radios: radios.map(r => ({ name: r.name, band: r.band, channel: r.live.channel, htmode: r.config.htmode, interfaces: r.interfaces.map(i => ({ ...i, clients: [] })) })) };
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // A JSON-RPC reply for the ubus status `code`, carrying `data` when there is any.
  const ok = ([code, data]) => ({ jsonrpc: '2.0', id: body.id, result: data === undefined ? [code] : [code, data] });
  const denied = { jsonrpc: '2.0', id: body.id, error: { code: -32002, message: 'Access denied' } };

  if (!mock.on) {
    // Real router: reads only. A write would change its configuration, so it is blocked and the test fails.
    if (obj === 'uci' && WRITES.includes(method)) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    return null;
  }
  if (mock.expired && ['uci', 'flab.radio', 'flab.wifi', 'system', 'session'].includes(obj)) return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}${args?.section ? ':' + args.section : ''}`); return ok(uci(method, args)); }
  if (obj === 'flab.radio') return ok([0, radioStatus()]);
  if (obj === 'flab.wifi') return ok([0, clientsReply()]);
  if (obj === 'system' && method === 'board') return ok([0, { hostname: 'openwrt', model: 'GL.iNet GL-MT6000' }]);
  return null;
}
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const errors = [];
await ctx.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const reply = body ? answer(body) : null;
  return reply ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) }) : route.continue();
});
// Opens the Wi-Fi page with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async acls => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#wifi`);
  await p.waitForSelector('.rd-card, .login-form', { timeout: 20000 });
  return p;
};
let page = await open();

// Helpers: a radio's card, its channel tiles, the banner, and screenshots.
const card = name => page.locator('.rd-card').filter({ has: page.locator('.rd-head .name', { hasText: new RegExp(`^${name}$`) }) });
// The channel tile `n` in the picker of radio `name`.
const tile = (name, n) => card(name).locator('.rd-pick .chans button').filter({ has: page.locator('.n', { hasText: new RegExp(`^${n}$`) }) });
// Whether the element `loc` has CSS class `cls`.
const has = (loc, cls) => loc.evaluate((e, c) => e.classList.contains(c), cls);
// How many channel tiles of radio `name` have CSS class `cls`.
const count = (name, cls) => card(name).locator(`.rd-pick .chn.${cls}`).count();
// The channel summary text under the picker of radio `name`.
const summary = name => card(name).locator('.rd-pick-sum').innerText();
// The notes under the settings banner, joined with " | ".
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
// The pending-changes banner.
const bar = () => page.locator('.set-bar');
// The Save and apply button.
const saveBtn = () => page.locator('button:has-text("Save and apply")');
// Saves a full-page screenshot named after `label`, only when a screenshot directory is configured.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `wifi-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save to end and returns its outcome message.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 40000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and waits for the page to settle.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };

//#region The real router (read only)
console.log('== the real router: the picker from its own channel lists ==');
const pickers = await page.locator('.rd-pick').count();
check(pickers >= 1 && pickers === await page.locator('.rd-card').count(), 'every radio card has a channel picker', String(pickers));
const heads = await page.locator('.rd-pick-head .label').allInnerTexts();
check(heads.every(t => /channel · \d+ allowed · frequency in MHz/i.test(t)), 'each picker says how many channels are allowed and that frequencies are in MHz', heads.join());
check(await page.locator('.rd-pick .chn.cur').count() >= 1 && await page.locator('.rd-pick .chn.span').count() >= 1, 'the running channel and the span of its width are marked');
const firstTile = page.locator('.rd-pick .chans button:not([disabled])').first();
await firstTile.hover();
check(await page.locator('.rd-pick .chn.pv, .rd-pick .chn.pv-bad').count() >= 1 && !/^Hover a channel/.test(await page.locator('.rd-pick-sum').first().innerText()), 'hovering a channel previews the block it would use and says so');
await page.mouse.move(5, 5);
check(await page.locator('.rd-pick .chn.pv, .rd-pick .chn.pv-bad').count() === 0, 'the preview goes away when the pointer leaves');
check(await bar().isHidden(), 'nothing is pending, so the banner is hidden');
check(!/null|undefined/.test(await page.locator('main').innerText()), 'no stray "null" or "undefined" text on the page');
await shot('real');
//#endregion

//#region The mock router
console.log('\n== the mock router: radios ==');
mock.on = true;
await refresh();
check(await card('radio0').locator('.rd-pick .chans button').count() === 13 && await card('radio1').locator('.rd-pick .chans button').count() === 24, 'the pickers list the channels of each radio (13 on 2.4 GHz, 24 on 5 GHz)');
check(await card('radio1').locator('.rd-pick .chans button .f').first().innerText() === '5180' && await tile('radio0', 6).locator('.f').innerText() === '2437', 'every tile shows its frequency in MHz under the channel number');
check(await has(tile('radio0', 6), 'cur') && await has(tile('radio1', 104), 'cur') && !(await has(tile('radio1', 104), 'cfg')), 'the running channel is marked, and is not "configured" as well while it matches');
check(await has(tile('radio1', 52), 'dfs') && await tile('radio1', 52).getAttribute('title').then(t => /DFS/.test(t)), 'radar channels are marked');
check(await has(tile('radio1', 149), 'nofit') && !await has(tile('radio1', 36), 'nofit'), 'a channel whose 160 MHz block is not allowed is dimmed, one that fits is not');
check(/Hover a channel to see the 160 MHz/.test(await summary('radio1')), 'the picker says what to do');
check(await bar().isHidden() && await saveBtn().isDisabled(), 'the banner is hidden and Save is disabled until something changes');

console.log('\n== hovering previews the block ==');
await tile('radio1', 44).hover();
check(await count('radio1', 'pv') === 8 && await has(tile('radio1', 36), 'pv') && await has(tile('radio1', 64), 'pv') && await has(tile('radio1', 44), 'pv-main'), 'hovering 44 at 160 MHz highlights the block 36-64');
check(/Channel 44 at 160 MHz would use channels 36–64 \(5170–5330 MHz\)/.test(await summary('radio1')), 'and the sentence gives the channels and the frequencies', await summary('radio1'));
await shot('hover');
await tile('radio1', 149).hover();
check(await count('radio1', 'pv-bad') >= 1 && await count('radio1', 'pv') === 0 && /cannot carry 160 MHz/.test(await summary('radio1')), 'a block that does not fit is previewed in red with the reason');
await tile('radio0', 6).hover();
check(await count('radio0', 'pv') === 2 && await has(tile('radio0', 6), 'pv') && await has(tile('radio0', 10), 'pv') && await count('radio0', 'in') === 3 && await count('radio0', 'ov') === 6, 'on 2.4 GHz a 40 MHz channel is two channels (6 and 10), the three between them are covered and the three on each side only partly overlapped');
check(/Channel 6 at 40 MHz would use channel 6 with channel 10 above it \(2427–2467 MHz\), covering channels 6–10 and partly overlapping 6 more/.test(await summary('radio0')), 'and the sentence says so', await summary('radio0'));
await tile('radio0', 4).hover();
check(await count('radio0', 'pv') === 2 && await has(tile('radio0', 8), 'pv') && /channel 4 with channel 8 above it \(2417–2457 MHz\), covering channels 4–8/.test(await summary('radio0')), 'channel 4 at 40 MHz is channels 4 and 8 side by side in frequency', await summary('radio0'));
await tile('radio0', 9).hover();
check(await count('radio0', 'pv') === 2 && await has(tile('radio0', 5), 'pv') && /channel 9 with channel 5 below it \(2422–2462 MHz\)/.test(await summary('radio0')), 'from channel 7 up the second half is the channel below, as netifd decides', await summary('radio0'));
check(await count('radio0', 'span') === 2 && await has(tile('radio0', 10), 'span') && await count('radio0', 'span-in') === 3, 'the running block of radio0 is its two channels and the three between them');
await page.mouse.move(5, 5);
check(await count('radio1', 'pv') + await count('radio1', 'pv-bad') + await count('radio0', 'pv') === 0, 'leaving the tiles clears the preview');
await tile('radio1', 44).focus();
check(await count('radio1', 'pv') === 8, 'focusing a tile with the keyboard previews it too');
await page.mouse.move(5, 5);
await page.evaluate(() => document.activeElement?.blur());

console.log('\n== choosing a channel ==');
await tile('radio1', 149).click();
check(await bar().isHidden() && await count('radio1', 'sel') === 0, 'a channel that does not fit cannot be chosen');
await tile('radio1', 36).click();
await page.mouse.move(5, 5);
check(await has(tile('radio1', 36), 'sel') && await count('radio1', 'pend') === 8 && await has(tile('radio1', 104), 'cur'), 'the choice is marked, with the block it would take, while the running channel stays marked');
check(/104 → 36/.test(await summary('radio1')) && /would use channels 36–64/.test(await summary('radio1')), 'the sentence says from, to and the block', await summary('radio1'));
const barText = await page.locator('.set-bar-summary').innerText();
const barColor = await bar().evaluate(e => getComputedStyle(e).backgroundColor);
check(await bar().isVisible() && /1 unsaved change: radio1: channel/.test(barText) && barColor === 'rgb(255, 244, 206)', 'the yellow banner names the change', `${barText} ${barColor}`);
check(/radar \(DFS\)/.test(await notes()), 'a block that reaches the radar channels warns about them', await notes());
check(await saveBtn().isEnabled(), 'Save is enabled');
await shot('chosen');
await tile('radio1', 36).click();
await page.mouse.move(5, 5);
check(await bar().isHidden() && await count('radio1', 'sel') === 0 && await count('radio1', 'pend') === 0, 'clicking the choice again undoes it', `${await bar().isHidden()} ${await count('radio1', 'sel')} ${await count('radio1', 'pend')}`);
await tile('radio0', 11).click();
check(/formicalabmesh/.test(await notes()) && /must be moved to the same channel/.test(await notes()), 'a radio that carries the mesh interface warns that the other nodes must follow', await notes());
await page.locator('.rd-pick-head .rd-auto').first().click();
check(await has(page.locator('.rd-pick-head .rd-auto').first(), 'on') && /Auto selected/.test(await summary('radio0')) && /radio0: channel/.test(await page.locator('.set-bar-summary').innerText()) && await count('radio0', 'sel') === 0, 'Auto is chosen with its own chip and no tile selected');
check(/picks its own channel/.test(await notes()), 'and it says the radio picks its own channel');
await page.locator('.rd-pick-head .rd-auto').first().click();
check(!await has(page.locator('.rd-pick-head .rd-auto').first(), 'on') && await bar().isHidden(), 'the chip toggles back to the configured channel, and with it the change');
await tile('radio0', 11).click();
await tile('radio1', 36).click();
check(/2 unsaved changes/.test(await page.locator('.set-bar-summary').innerText()), 'two radios are two changes');
await page.click('.set-bar button:has-text("Details")');
check(/radio0: channel: 6 → 11/.test(await page.locator('.set-changes').innerText()) && /radio1: channel: 104 → 36/.test(await page.locator('.set-changes').innerText()), 'Details list each change from and to');
await page.click('.set-bar button:has-text("Hide details")');
//#endregion

//#region Saving
console.log('\n== saving ==');
const before = mock.radioCalls;
await page.waitForTimeout(11000);
check(await has(tile('radio1', 36), 'sel') && mock.radioCalls === before, 'the page does not poll over unsaved edits');
mock.calls = [];
await saveBtn().click();
const done = await outcome();
check(/^Saved/.test(done), 'a successful save says so', done);
check(/^uci\.changes:?\S*( uci\.set:\S+)+ uci\.apply uci\.get:radio\d( uci\.get:radio\d)* uci\.confirm/.test(mock.calls.join(' ')), 'checked for leftovers, staged, applied, read back the radios\' own sections, confirmed', mock.calls.join(' '));
check(!mock.calls.includes('uci.get'), 'the whole wireless config (which holds the Wi-Fi keys) is never read', mock.calls.join(' '));
check(mock.cfg.radio0.channel === '11' && mock.cfg.radio1.channel === '36' && mock.cfg.radio1.htmode === 'HE160', 'only the channels were written, the width and the rest are untouched', JSON.stringify(mock.cfg));
await page.waitForTimeout(600);
check(await has(tile('radio1', 36), 'cur') && await bar().locator('.set-outcome.ok').count() === 1 && await saveBtn().isHidden() && await page.locator('button:has-text("Discard edits")').isHidden(), 'the page shows the new running channel and keeps the outcome, without Save and Discard buttons');
check(!/null|undefined/.test(await bar().innerText()) && /No unsaved changes/.test(await page.locator('.set-bar-summary').innerText()), 'the banner says nothing is unsaved, with no stray "null"');
check(/configured 36/.test(await card('radio1').locator('.rd-cols').innerText()), 'the configuration block says configured 36');
await shot('saved');

console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await tile('radio1', 100).click();
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /radio1: channel was not saved/.test(lost), 'a change that does not read back is rolled back and reported', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0, 'rollback is called, confirm is not, and nothing stays staged', mock.calls.join(' '));
check(await has(tile('radio1', 100), 'sel') && mock.cfg.radio1.channel === '36', 'the choice stays in the form for a retry, the router is unchanged');
mock.dropWrites = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
check(await bar().isHidden() && await count('radio1', 'sel') === 0, 'Discard edits returns to what the router has and hides the banner');

console.log('\n== a radio that does not come back ==');
mock.radioDown = true;
await tile('radio1', 100).click();
mock.calls = [];
await saveBtn().click();
const down = await outcome();
check(/radio1 did not come back up/.test(down) && /rolled back/.test(down), 'a radio that stays down after the change makes the router undo it', down);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.cfg.radio1.channel === '36', 'rollback is called, confirm is not, and the channel is back', mock.calls.join(' '));
mock.radioDown = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [['set', 'radio0', 'channel', '1']];
await refresh();
check(/1 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.click('button:has-text("Discard them")');
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), 'Discard them clears the session\'s staging area');
//#endregion

//#region A login that may not write, theme, expiry
console.log('\n== a login that may not write ==');
const ro = await open({ ubus: { system: ['board', 'info'], 'flab.radio': ['status'], 'flab.wifi': ['clients'], uci: ['get', 'changes'] } });
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('.rd-pick').count() === 0 && await ro.locator('.rd-chan .chn').count() > 0, 'a read-only login gets the plain channel strip and a note saying why');
await ro.close();

console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await tile('radio1', 44).hover();
await page.waitForTimeout(300);
await shot('dark');
await page.mouse.move(5, 5);
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== the session expires ==');
await tile('radio1', 40).click();
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 40000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write reached the real router', mock.unsafe.join());
check(errors.length === 0, 'no console errors', errors.join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall Wi-Fi channel checks passed');
process.exit(failed ? 1 : 0);
