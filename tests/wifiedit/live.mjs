// Browser test for editing the wireless configuration on the Wi-Fi page. A real browser opens the deployed UI.
// 1. Against the real router, read only: the radio cards show the settings of each radio and an editor for each of its wireless
//    networks, built from what flab.radio config reports (no password is ever filled in), and any uci write or `uci get` the
//    page might send in this phase is blocked and fails the test.
// 2. Against a mock of the flab.radio and flab.wifi plugins and a stateful mock of rpcd's `uci` object: the whole editing flow -
//    radio settings, the mode that decides which channels fit, changing, adding and removing networks, the write-only
//    passwords, validation, the warnings about dangerous changes, saving, a change the router does not keep, a radio or a
//    network that does not come back up, a login that may not write, a plugin that cannot report the configuration, a plugin that is
//    missing, the dark theme and an expired session - WITHOUT touching the router's wireless config.
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
// The modes each radio's hardware lists.
const HTMODES = { radio0: ['HT20', 'HT40', 'HE20', 'HE40'], radio1: ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'VHT160', 'HE20', 'HE40', 'HE80', 'HE160'] };
const PHY = { radio0: 'phy0', radio1: 'phy1' };
const BAND = { radio0: '2g', radio1: '5g' };
// Options that hold a secret, as the plugin decides (rpcd/ucode/flab.radio.uc SECRET_OPTION).
const SECRET = /^(key[1-4]?|identity|r0kh|r1kh|wps_pin|[a-z0-9_]*(passw|pwd|passphrase|secret|token)[a-z0-9_]*)$/i;
// How many clients each network has.
const CLIENTS = { ap_2g: 3, ap_5g: 1 };

// A wireless config section: its options and its secrets (the values stay in the mock; the page is only told which are set).
const sec = (section, type, values, secrets = {}, anonymous = false) => ({ section, type, anonymous, values, secrets });
// The wireless config the mock starts from.
const BASE = () => [
  sec('radio0', 'wifi-device', { type: 'mac80211', band: '2g', channel: '6', htmode: 'HE40', country: 'IT' }),
  sec('radio1', 'wifi-device', { type: 'mac80211', band: '5g', channel: '104', htmode: 'HE160', country: 'IT', noscan: '1' }),
  sec('ap_2g', 'wifi-iface', { device: 'radio0', mode: 'ap', ssid: 'home', network: 'lan', encryption: 'sae-mixed', ieee80211r: '1', mobility_domain: '40f9', ft_over_ds: '0' }, { key: 'secret-2g-pass' }),
  sec('mesh_2g', 'wifi-iface', { device: 'radio0', mode: 'mesh', mesh_id: 'formicalabmesh', encryption: 'sae', network: 'lan' }, { key: 'secret-mesh-pass' }),
  sec('ap_5g', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'home', network: 'lan', encryption: 'sae-mixed' }, { key: 'secret-5g-pass' }),
  sec('cfg0a1b2c', 'wifi-iface', { device: 'radio1', mode: 'ap', ssid: 'guest', network: 'guest', encryption: 'psk2' }, { key: 'guest-pass-1' }, true),
];
// Every secret value the mock holds, which must never reach the page.
const SECRET_VALUES = ['secret-2g-pass', 'secret-mesh-pass', 'secret-5g-pass', 'guest-pass-1'];

const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
const mock = { on: false, secs: BASE(), staged: [], restage: [], snapshot: null, calls: [], dropWrites: false, confirmFails: false, expired: false, radioDown: false, ifaceDown: null,
  noConfig: false, noPlugin: false, unsafe: [], gets: [], renames: 0, configCalls: 0 };

// Applies the staged operations to the mock's config the way rpcd's uci apply does: an anonymous section whose options change gets
// a new generated name (as libuci derives it from the content).
function commit() {
  for (const o of mock.staged) {
    const target = mock.secs.find(s => s.section === o.section);
    if (o.op === 'add') mock.secs.push(sec(o.name, o.type, Object.fromEntries(Object.entries(o.values).filter(([k]) => !SECRET.test(k))), Object.fromEntries(Object.entries(o.values).filter(([k]) => SECRET.test(k)))));
    else if (!target) continue;
    else if (o.op === 'delete' && !o.options) mock.secs = mock.secs.filter(s => s !== target);
    else {
      if (o.op === 'set') for (const [k, v] of Object.entries(o.values)) (SECRET.test(k) ? target.secrets : target.values)[k] = v;
      else for (const k of o.options) { delete target.values[k]; delete target.secrets[k]; }
      if (target.anonymous) target.section = `cfg${(0xa00000 + ++mock.renames).toString(16)}`;
    }
  }
}

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') { mock.gets.push(`${args.config}${args.section ? '.' + args.section : ''}`); return [0, { values: {} }]; }
  if (method === 'changes') {
    const list = args.config && args.config !== 'wireless' ? [] : mock.staged.flatMap(o => (o.op === 'set' ? Object.entries(o.values).map(([k, v]) => ['set', o.section, k, v]) : [[o.op, o.section]]));
    return [0, { changes: args.config ? list : (list.length ? { wireless: list } : {}) }];
  }
  if (method === 'set') { mock.staged.push({ op: 'set', section: args.section, values: args.values }); return [0, {}]; }
  if (method === 'add') { mock.staged.push({ op: 'add', type: args.type, name: args.name, values: args.values }); return [0, { section: args.name }]; }
  if (method === 'delete') { mock.staged.push({ op: 'delete', section: args.section, options: args.options }); return [0, {}]; }
  if (method === 'revert') { if (args.config !== 'wireless') return [4]; mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.snapshot = clone(mock.secs);
    mock.restage = mock.staged;
    if (!mock.dropWrites) commit();
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
    if (!mock.snapshot) return [5];
    if (mock.confirmFails) { mock.secs = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; return [1]; }
    mock.snapshot = null;
    return [0, {}];
  }
  if (method === 'rollback') {
    if (!mock.snapshot) return [5];
    mock.secs = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null;
    return [0, {}];
  }
  return [0, {}];
}

// The center frequency of the block a radio runs on when it is on channel `c` at `width` MHz, for the widths this test uses.
const centerOf = (name, c, width) => name === 'radio0' ? c.freq + (c.channel < 7 ? 10 : -10) : width >= 160 ? (c.channel <= 64 ? 5250 : 5570) : width === 80 ? (c.channel <= 48 ? 5210 : 5530) : c.freq;

// The flab.radio status reply from the mock config.
function radioStatus() {
  const radios = mock.secs.filter(s => s.type === 'wifi-device').map(r => {
    const v = r.values, name = r.section, band = BAND[name];
    const channels = band === '2g' ? Array.from({ length: 13 }, (_, i) => chan('2g', i + 1)) : BAND5;
    const c = channels.find(x => String(x.channel) === v.channel);
    const width = Number(/(\d+)$/.exec(v.htmode ?? '')?.[1] ?? 20);
    // While a change is applied and not yet confirmed, a radio that is made to fail does not come up.
    const failing = mock.radioDown && mock.snapshot;
    const enabled = v.disabled !== '1';
    const interfaces = mock.secs.filter(s => s.type === 'wifi-iface' && s.values.device === name).map((s, k) => {
      const on = s.values.disabled !== '1';
      const up = on && enabled && !failing && mock.ifaceDown !== s.section;
      return { section: s.section, ifname: up ? `${PHY[name]}-${s.values.mode}${k}` : undefined, mode: s.values.mode, ssid: s.values.mode === 'mesh' ? s.values.mesh_id : s.values.ssid,
        networks: [].concat(s.values.network ?? []), encryption: s.values.encryption ?? 'none', security: 'WPA3', enabled: on, hidden: false, isolate: false, max_clients: null, macfilter: null,
        features: {}, up, bssid: '94:83:C4:A2:15:C5', bss_status: 'ENABLED', clients: CLIENTS[s.section] ?? 0, rx_bytes: 1000, tx_bytes: 2000 };
    });
    return { name, phy: PHY[name], band, enabled, up: enabled && !failing, pending: false, retry_failed: false,
      config: { channel: v.channel ?? 'auto', htmode: v.htmode, country: v.country, txpower: v.txpower ? +v.txpower : null, cell_density: 0, noscan: v.noscan === '1', legacy_rates: false, beacon_int: null, path: 'platform/soc/18000000.wifi' },
      interfaces, antennas: { tx: 4, rx: 4 }, standards: ['802.11n', '802.11ax'], channels,
      live: c ? { channel: c.channel, freq: c.freq, width, center: centerOf(name, c, width), txpower: 20 } : {}, survey: { freq: c?.freq, noise: -92, active: 1000, busy: 100, rx: 50, tx: 20 }, hardware: { hardware: 'MediaTek MT7986' } };
  });
  return { radios, regdomain: { country: 'IT', dfs: 'DFS-ETSI' } };
}

// The flab.radio config reply from the mock config: every option without its secrets, and which secrets are set.
function radioConfig() {
  mock.configCalls++;
  const view = (s, i) => ({ section: s.section, anonymous: s.anonymous, index: i, type: s.type, values: clone(s.values), secrets: Object.fromEntries(Object.entries(s.secrets).filter(([, v]) => v !== '').map(([k]) => [k, true])) });
  const sections = mock.secs.map((s, i) => [s, i]);
  return {
    radios: sections.filter(([s]) => s.type === 'wifi-device').map(([s, i]) => ({ ...view(s, i), phy: PHY[s.section], htmodes: { source: 'iwinfo', modes: HTMODES[s.section] } })),
    interfaces: sections.filter(([s]) => s.type === 'wifi-iface').map(([s, i]) => view(s, i)),
    others: [], networks: [{ name: 'lan', proto: 'static' }, { name: 'guest', proto: 'static' }, { name: 'wwan', proto: 'dhcp' }],
    countries: [{ code: 'DE', name: 'Germany' }, { code: 'IT', name: 'Italy' }, { code: 'US', name: 'United States' }],
    features: { eap: true, sae: true, owe: true, ft: true, wps: true },
  };
}

// The flab.wifi reply: the radios with their access points and no clients.
function clientsReply() {
  const radios = radioStatus().radios;
  return { radios: radios.map(r => ({ name: r.name, band: r.band, channel: r.live.channel, htmode: r.config.htmode, interfaces: r.interfaces.map(i => ({ ...i, clients: [] })) })) };
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // A JSON-RPC reply for the ubus status `code`, carrying `data` when there is any.
  const ok = ([code, data]) => ({ jsonrpc: '2.0', id: body.id, result: data === undefined ? [code] : [code, data] });
  const denied = { jsonrpc: '2.0', id: body.id, error: { code: -32002, message: 'Access denied' } };

  if (!mock.on) {
    // Real router: reads only. A write would change its configuration, and `uci get` would read the Wi-Fi keys: both are blocked
    // and fail the test.
    if (obj === 'uci' && (WRITES.includes(method) || method === 'get')) { mock.unsafe.push(`${obj}.${method}${args?.config ? ' ' + args.config : ''}`); return ok([6]); }
    return null;
  }
  if (mock.expired && ['uci', 'flab.radio', 'flab.wifi', 'system', 'session'].includes(obj)) return denied;
  // A method the login may not call: the page asks the session whether it has expired, which it has not.
  if (obj === 'session' && method === 'access') return ok([0, { access: true }]);
  if (obj === 'uci') { mock.calls.push(`uci.${method}${args?.section ? ':' + args.section : ''}`); return ok(uci(method, args)); }
  if (obj === 'flab.radio') {
    if (mock.noPlugin) return ok([4]);
    if (method === 'config') { mock.calls.push('flab.radio.config'); return mock.noConfig ? denied : ok([0, radioConfig()]); }
    return ok([0, radioStatus()]);
  }
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
// Opens the Wi-Fi radios page (the radios' own settings and channel) or, with `route` 'wifi', the Wi-Fi page (the wireless networks) with a session in
// sessionStorage, the way a real sign-in leaves the tab.
const open = async (acls, selector = '.rd-card, .login-form', route = 'radios') => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#${route}`);
  await p.waitForSelector(selector, { timeout: 20000 });
  return p;
};
let page = await open();
// Goes to the other page of the pair without reloading: the draft of the shared editor stays. 'radios' has the radios' settings and channel pickers, 'wifi' the
// wireless networks.
const go = async route => { await page.evaluate(r => { location.hash = `#${r}`; }, route); await page.waitForSelector(route === 'radios' ? '.rd-hero' : '.rd-ifaces', { timeout: 20000 }); await page.waitForTimeout(400); };

// Helpers: a radio's card, its settings block, a network's editor, the controls of a block, the banner, and screenshots.
const card = name => page.locator('.rd-card').filter({ has: page.locator('.rd-head .name', { hasText: new RegExp(`^${name}$`) }) });
const settings = name => card(name).locator('details.wf-block');
// The editor of the network whose summary holds `title` (its SSID), on radio `name` when given.
const net = (title, name) => (name ? card(name) : page).locator('details.wf-iface').filter({ has: page.locator('summary strong', { hasText: new RegExp(`^${title}$`) }) });
// Opens every details element inside (and including) `scope`, so its controls can be used. The page remembers what is open.
const openAll = async scope => { await scope.evaluate(e => { e.open = true; e.querySelectorAll('details').forEach(d => { d.open = true; }); }); await page.waitForTimeout(100); };
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The labeled control of a field (text, number, select, secret) or the check box of a boolean field, inside `scope`.
const field = (scope, label) => scope.locator('.set-field').filter({ has: page.locator('label.form-label', { hasText: new RegExp(`^${esc(label)}$`) }) });
const input = (scope, label) => field(scope, label).locator('input, select, textarea').first();
const checkbox = (scope, label) => scope.locator('label.set-check').filter({ hasText: label }).locator('input[type=checkbox]');
// The check box of network `name` in the list a wireless network is attached to.
const netBox = (scope, name) => scope.locator('label.wf-net').filter({ hasText: new RegExp(`^${name}`) }).locator('input[type=checkbox]');
// Sets a text control and lets the page react.
const type = async (scope, label, value) => { await input(scope, label).fill(value); await page.waitForTimeout(50); };
// Chooses an option of a drop-down by its value; the page redraws after a change that adds or removes controls.
const choose = async (scope, label, value) => { await input(scope, label).selectOption(value); await page.waitForTimeout(250); };
// Sets a check box.
const toggle = async (scope, label, on) => { await checkbox(scope, label).setChecked(on); await page.waitForTimeout(250); };
// The summary line of a block (not the summaries of the groups inside it).
const head = scope => scope.locator(':scope > summary');
// The notes under the banner, joined with " | ", the banner itself and the Save button.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
const bar = () => page.locator('.set-bar');
const saveBtn = () => page.locator('button:has-text("Save and apply")');
const summaryText = () => page.locator('.set-bar-summary').innerText();
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `wifiedit-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Saves a screenshot of one element (a settings block, a network editor), only when a screenshot directory is configured.
const shotOf = async (loc, label) => { if (shots) await loc.screenshot({ path: path.join(shots, `wifiedit-${label.replace(/\W+/g, '-')}.png`) }); };
// Waits for the save to end and returns its outcome message.
const outcome = async () => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout: 40000 }); return (await n.innerText()).trim(); };
// Clicks Refresh and waits for the page to settle.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
// The banner disappears only after the discarded draft has been reloaded from the router.
const discard = async () => { await page.click('button:has-text("Discard edits")'); await bar().waitFor({ state: 'hidden' }); };
// The text of the whole page without the nodes that hold the live values.
const bodyText = () => page.locator('main').innerText();

//#region The real router (read only)
console.log('== the real router: the editors from its own configuration (read only) ==');
const cards = await page.locator('.rd-card').count();
check(cards >= 1 && await page.locator('details.wf-block').count() === cards, 'every radio card has a "Radio settings" block', `${cards} cards, ${await page.locator('details.wf-block').count()} blocks`);
check(await page.locator('details.wf-iface').count() === 0, 'the Wi-Fi radios page has no editor of the wireless networks: they are on the Wi-Fi page');
await go('wifi');
check(await page.locator('details.wf-block').count() === 0 && await page.locator('details.wf-iface').count() >= 1, 'the wireless networks of the router have an editor each, on the Wi-Fi page', String(await page.locator('details.wf-iface').count()));
await openAll(page.locator('.rd-grid'));
check(await page.locator('.wf-nets-editor').count() === cards && await page.locator('.wf-addbar button').count() === cards * 2, 'each radio has its buttons to add an access point or a client network');
const ssids = await page.locator('.wf-iface .set-field:has(> label.form-label:text-is("SSID")) input').evaluateAll(e => e.map(x => x.value));
check(ssids.length >= 1 && ssids.every(s => s.length > 0), 'every network editor shows its SSID', ssids.join());
const pw = page.locator('.wf-iface input[type=password]');
check(await pw.count() >= 1 && (await pw.evaluateAll(e => e.every(x => x.value === ''))) && (await pw.evaluateAll(e => e.some(x => /stored; leave empty to keep it/.test(x.placeholder)))), 'password fields are empty and say that one is stored: the page never receives it', String(await pw.count()));
check(await page.locator('.wf-group .set-hint').count() > 20 && (await page.locator('.wf-group .set-hint').allInnerTexts()).every(t => t.trim().length > 20), 'every option has a hint');
check(await bar().isHidden() && await saveBtn().isHidden(), 'nothing is pending, so the banner is hidden');
check(!/null|undefined/.test(await bodyText()), 'no stray "null" or "undefined" text on the page');
check(mock.gets.length === 0 && mock.unsafe.length === 0, 'the page read nothing with uci get and wrote nothing', mock.unsafe.join());
await shot('real');
//#endregion

//#region The mock router
console.log('\n== the mock router: the radio settings ==');
mock.on = true;
await refresh();
await go('radios');
const r1 = settings('radio1');
check(await settings('radio0').count() === 1 && /Radio settings/.test(await head(settings('radio0')).innerText()) && /HE40 · IT/.test(await head(settings('radio0')).innerText()), 'a radio\'s settings fold to a line with its mode and country', await head(settings('radio0')).innerText());
await openAll(r1);
const modes = await input(r1, 'Mode and channel width').locator('option').evaluateAll(o => o.map(x => x.value));
check(modes.join() === ',HT20,HT40,VHT20,VHT40,VHT80,VHT160,HE20,HE40,HE80,HE160,NOHT', 'the mode drop-down lists exactly what the hardware reports (and NOHT)', modes.join());
const modes0 = await input(settings('radio0'), 'Mode and channel width').locator('option').evaluateAll(o => o.map(x => x.value));
check(modes0.includes('HT40+') && modes0.includes('HT40-') && !modes0.includes('VHT80'), 'on 2.4 GHz the explicit HT40+ and HT40- are offered, and no mode the radio lacks', modes0.join());
check(await input(r1, 'Mode and channel width').inputValue() === 'HE160' && await input(r1, 'Country').inputValue() === 'IT' && (await input(r1, 'Country').locator('option').allInnerTexts()).some(t => /DE · Germany/.test(t)), 'the current values are selected, the countries come from the driver');
check(await checkbox(settings('radio0'), 'Allow legacy 802.11b rates').count() === 1 && await checkbox(r1, 'Allow legacy 802.11b rates').count() === 0 && await checkbox(r1, 'Skip the coexistence scan').count() === 1, 'options that apply to one band only are shown on that band (legacy rates on 2.4 GHz; the 5 GHz radio keeps the noscan it has set)');
await openAll(settings('radio0'));
check((await settings('radio0').locator('.set-hint').allInnerTexts()).every(t => t.length > 25), 'the radio options have hints');
await shotOf(settings('radio1'), 'radio-settings');

console.log('\n== choosing a mode changes what the channels can carry ==');
await choose(r1, 'Mode and channel width', 'HE80');
check(/1 unsaved change: radio1: Mode and channel width/.test(await summaryText()) && /radar \(DFS\)/.test(await notes()), 'the banner names the change and warns about the radar channel the radio is on', await notes());
await card('radio1').locator('.rd-pick .chans button').filter({ has: page.locator('.n', { hasText: /^44$/ }) }).hover();
check(/would use channels 36–48 \(5170–5250 MHz\)/.test(await card('radio1').locator('.rd-pick-sum').innerText()) && /80 MHz/.test(await card('radio1').locator('.rd-pick-sum').innerText()), 'the channel picker previews 80 MHz blocks with the new mode', await card('radio1').locator('.rd-pick-sum').innerText());
await page.mouse.move(5, 5);
await card('radio1').locator('.rd-pick .chans button').filter({ has: page.locator('.n', { hasText: /^149$/ }) }).click();
await page.mouse.move(5, 5);
check(!/cannot carry/.test(await notes()) && /104 → 149/.test(await card('radio1').locator('.rd-pick-sum').innerText()), 'a channel the new width fits can be chosen (149 cannot carry 160 MHz but can carry 80)', await notes());
await choose(r1, 'Mode and channel width', 'HE160');
check(/cannot carry HE160/.test(await notes()) && await card('radio1').locator('.rd-pick.is-invalid').count() === 1 && await saveBtn().isDisabled(), 'going back to 160 MHz with channel 149 chosen is an error on the picker, and Save is disabled', await notes());
await discard();
check(await bar().isHidden() && await input(settings('radio1'), 'Mode and channel width').inputValue() === 'HE160', 'Discard edits returns to what the router has');

console.log('\n== validation of the radio settings ==');
await openAll(settings('radio1'));
await type(settings('radio1'), 'Transmit power (dBm)', '99');
check(await input(settings('radio1'), 'Transmit power (dBm)').evaluate(e => e.classList.contains('is-invalid')) && await saveBtn().isDisabled() && /Transmit power \(dBm\) must be at most 40/.test(await notes()), 'a power over 40 dBm marks the control and blocks Save', await notes());
await type(settings('radio1'), 'Transmit power (dBm)', '30');
check(/30 dBm is above the regulatory limit of 23 dBm on channel 104/.test(await notes()) && await saveBtn().isEnabled(), 'a power above the regulatory limit only warns', await notes());
await type(settings('radio1'), 'Transmit power (dBm)', '');
await type(settings('radio1'), 'Beacon interval', '5');
check(/Beacon interval must be at least 15/.test(await notes()), 'a beacon interval under 15 is an error', await notes());
await discard();
await openAll(settings('radio0'));
await toggle(settings('radio0'), 'Disable this radio', true);
check(/radio0: this radio will be switched off: its 1 network \(home\) stops and 3 clients lose the connection/.test(await notes()) && /undoes the change by itself 30 seconds/.test(await notes()) && await saveBtn().isEnabled(), 'disabling a radio warns how many networks and clients go down and that the router undoes it', await notes());
await shot('radio-disable');
await discard();

console.log('\n== saving a radio change ==');
await openAll(settings('radio1'));
await choose(settings('radio1'), 'Mode and channel width', 'HE80');
await type(settings('radio1'), 'Transmit power (dBm)', '17');
await choose(settings('radio1'), 'Coverage cell density', '2');
mock.calls = [];
await saveBtn().click();
const done = await outcome();
check(/^Saved/.test(done), 'a successful save says so', done);
check(/^uci\.changes( uci\.set:radio1)+ uci\.apply flab\.radio\.config uci\.confirm/.test(mock.calls.join(' ')), 'checked for leftovers, staged, applied, read the config back through the plugin, confirmed', mock.calls.join(' '));
check(mock.gets.length === 0, 'the wireless config was never read with uci get', mock.gets.join());
const radio1 = mock.secs.find(s => s.section === 'radio1').values;
check(radio1.htmode === 'HE80' && radio1.txpower === '17' && radio1.cell_density === '2' && radio1.channel === '104' && radio1.country === 'IT' && radio1.noscan === '1', 'only the changed options were written, the rest is untouched', JSON.stringify(radio1));
await page.waitForTimeout(700);
check(await bar().locator('.set-outcome.ok').count() === 1 && await saveBtn().isHidden() && await input(settings('radio1'), 'Mode and channel width').inputValue() === 'HE80', 'the page shows the new values and keeps the outcome, without Save and Discard');
await shot('saved-radio');

console.log('\n== editing a wireless network ==');
await go('wifi');
const home = net('home', 'radio0');
await openAll(home);
check(await head(home).innerText().then(t => /home/.test(t) && /access point/.test(t) && /WPA2\/WPA3-Personal/.test(t) && /running/.test(t)), 'the summary says what the network is and that it runs', await head(home).innerText());
check(await input(home, 'SSID').inputValue() === 'home' && await input(home, 'Encryption').inputValue() === 'sae-mixed' && await netBox(home, 'lan').isChecked() && !await netBox(home, 'guest').isChecked() && await field(home, 'Password').locator('input').getAttribute('placeholder') === 'stored; leave empty to keep it', 'its values are filled in; the password is not');
const encs = await input(home, 'Encryption').locator('option').evaluateAll(o => o.map(x => x.value));
check(encs.join() === ',sae,sae-mixed,psk2,psk2+ccmp,owe,wpa3,wpa3-mixed,wpa2', 'the encryption drop-down offers what hostapd can do (open is the empty choice)', encs.join());
await input(home, 'SSID').fill('home-2g');
await page.waitForTimeout(50);
check(/this change \(the name\) disconnects 3 clients connected now.*you lose access, and the router undoes the change by itself 30 seconds/.test(await notes()) && /home: this change/.test(await notes()), 'renaming a network with clients warns that they are disconnected and that the admin may lose access', await notes());
await field(home, 'Password').locator('input').fill('a-new-passphrase');
check(/this change \(the name, the password\) disconnects 3 clients.*with the new password/.test(await notes()), 'a new password is named in the warning', await notes());
check(!(await bar().innerText()).includes('a-new-passphrase'), 'the banner never shows the password');
await page.click('.set-bar button:has-text("Details")');
const changes = await page.locator('.set-changes').innerText();
check(/home: SSID: home → home-2g/.test(changes) && /home: Password: set \(hidden\) → new value \(hidden\)/.test(changes) && !changes.includes('a-new-passphrase'), 'Details lists the change and says only that the password is replaced', changes);
await page.click('.set-bar button:has-text("Hide details")');
await shotOf(home, 'edit-network');
await shotOf(page.locator('.cmdbar'), 'banner');
mock.calls = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saved');
const ap2g = mock.secs.find(s => s.section === 'ap_2g');
check(ap2g.values.ssid === 'home-2g' && ap2g.secrets.key === 'a-new-passphrase' && ap2g.values.network === 'lan' && ap2g.values.encryption === 'sae-mixed' && ap2g.values.ieee80211r === '1', 'the SSID and the password were written, everything else kept', JSON.stringify(ap2g));
await page.waitForTimeout(700);
check(await field(net('home-2g', 'radio0'), 'Password').locator('input').inputValue() === '' && !(await bodyText()).includes('a-new-passphrase') && !(await page.content()).includes('a-new-passphrase'), 'the password field is empty again and the password is nowhere in the page');
check(mock.calls.includes('flab.radio.config') && mock.gets.length === 0, 'it was read back through the plugin');

console.log('\n== an unnamed section ==');
const guest = net('guest', 'radio1');
await openAll(guest);
check(/unnamed/.test(await guest.locator('.wf-actions').textContent()) && /cfg0a1b2c/.test(await guest.locator('.wf-actions').textContent()), 'a network in an unnamed section says so and shows the generated name', await guest.locator('.wf-actions').textContent());
await type(guest, 'SSID', 'guests');
mock.calls = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving a change to an unnamed section works although its generated name changes with its content', await bodyText());
check(mock.calls.includes('uci.set:cfg0a1b2c') && mock.secs.some(s => s.values.ssid === 'guests' && s.anonymous), 'the section was addressed by its generated name', mock.calls.join(' '));
await page.waitForTimeout(700);

console.log('\n== validation of a network ==');
await openAll(net('home-2g', 'radio0'));
const h2 = net('home-2g', 'radio0');
await type(h2, 'SSID', '');
check(/enter the network name/.test(await notes()) && await saveBtn().isDisabled(), 'an empty SSID blocks Save');
await type(h2, 'SSID', 'x'.repeat(33));
check(/SSID is 33 bytes long/.test(await notes()), 'an SSID over 32 bytes is an error');
await type(h2, 'SSID', 'home-2g');
await field(h2, 'Password').locator('input').fill('short');
check(await field(h2, 'Password').locator('input').evaluate(e => e.classList.contains('is-invalid')) && /Password must be at least 8 characters/.test(await notes()), 'a short password marks the field and blocks Save', await notes());
await field(h2, 'Password').locator('input').fill('x'.repeat(64));
check(/hexadecimal/.test(await notes()), 'a 64-character password must be hexadecimal');
await field(h2, 'Password').locator('input').fill('0123456789abcdef'.repeat(4));
check(!/Password/.test(await notes()), '64 hexadecimal digits are a valid key');
await discard();
await openAll(net('home-2g', 'radio0'));
await netBox(net('home-2g', 'radio0'), 'lan').setChecked(false);
check(/choose a network to attach it to/.test(await notes()) && await field(net('home-2g', 'radio0'), 'Attached to').locator('.wf-nets.is-invalid').count() === 1, 'a network attached to nothing is an error on the network list');
await discard();
await openAll(net('home-2g', 'radio0'));
await choose(net('home-2g', 'radio0'), 'Encryption', 'sae');
await choose(net('home-2g', 'radio0'), 'Protected management frames (802.11w)', '0');
check(/WPA3 and Enhanced Open need protected management frames/.test(await notes()), 'WPA3 with protected frames disabled is an error');
await discard();

console.log('\n== the dangerous changes ==');
await openAll(net('guests', 'radio1'));
const g = net('guests', 'radio1');
await choose(g, 'Encryption', '');
check(/guests: this network is open: anyone in range can join it and reach guest/.test(await notes()) && await field(g, 'Password').count() === 0, 'choosing open warns who can join, and the password field goes away', await notes());
await shotOf(g, 'open-network');
await choose(g, 'Encryption', 'psk2');
check(!/is open/.test(await notes()) && await bar().isHidden(), 'and the warning goes with it, with the change');
await openAll(net('guests', 'radio1'));
await choose(net('guests', 'radio1'), 'Encryption', 'owe');
check(await field(net('guests', 'radio1'), 'Password').count() === 0 && !/is open/.test(await notes()), 'Enhanced Open needs no password and is not called open');
await discard();
await openAll(net('guests', 'radio1'));
await toggle(net('guests', 'radio1'), 'Hide the SSID', true);
check(/a hidden SSID is not a protection/.test(await notes()), 'hiding the SSID warns');
await discard();
await openAll(net('home-2g', 'radio0'));
await toggle(net('home-2g', 'radio0'), 'Disable this network', true);
check(/this change \(switching it off\) disconnects 3 clients/.test(await notes()), 'disabling a network warns');
await discard();

console.log('\n== the MAC filter, 802.11r and enterprise options appear when they apply ==');
const hh = net('home-2g', 'radio0');
await openAll(hh);
check(await field(hh, 'MAC addresses').count() === 0 && await field(hh, 'Mobility domain').count() === 1 && await field(hh, 'RADIUS server').count() === 0, 'the MAC list and the RADIUS options are hidden, the 802.11r ones shown (it is on)');
await choose(hh, 'MAC address filter', 'allow');
check(await field(hh, 'MAC addresses').count() === 1 && /only allows the listed devices and the list is empty/.test(await notes()), 'choosing a filter shows the list and warns that an empty allow list blocks everybody');
await hh.locator('.set-field:has(label.form-label:text-is("MAC addresses")) button:has-text("Add address")').click();
await page.waitForTimeout(250);
await hh.locator('.set-field:has(label.form-label:text-is("MAC addresses")) input').first().fill('00:11:22');
check(/is not a MAC address/.test(await notes()), 'a malformed MAC address is an error');
await hh.locator('.set-field:has(label.form-label:text-is("MAC addresses")) input').first().fill('00:11:22:33:44:55');
await page.waitForTimeout(100);
check(!/MAC address/.test(await notes()) && !/list is empty/.test(await notes()), 'a valid one clears both');
await toggle(hh, 'Fast transition (802.11r)', false);
check(await field(hh, 'Mobility domain').count() === 0, 'switching 802.11r off hides its options');
await toggle(hh, 'Fast transition (802.11r)', true);
await choose(hh, 'Encryption', 'wpa2');
check(await field(hh, 'RADIUS server').count() === 1 && await field(hh, 'RADIUS secret').count() === 1 && await field(hh, 'Password').count() === 0 && /enter the RADIUS server/.test(await notes()) && /enter the secret shared with the RADIUS server/.test(await notes()), 'WPA2-Enterprise swaps the password for the RADIUS options and requires them', await notes());
await type(hh, 'RADIUS server', 'radius.example.com');
await field(hh, 'RADIUS secret').locator('input').fill('shared-secret');
check(!/RADIUS/.test(await notes()), 'filling them in clears the errors');
await shotOf(hh, 'enterprise');
await discard();

console.log('\n== adding and removing networks ==');
await card('radio1').locator('.wf-addbar button:has-text("Add access point")').click();
await page.waitForTimeout(300);
const fresh = card('radio1').locator('details.wf-new');
check(await fresh.count() === 1 && /New network/.test(await head(fresh).innerText()) && /new/.test(await head(fresh).innerText()) && await fresh.evaluate(e => e.open), 'a new network opens its editor, marked new');
check(/enter the network name/.test(await notes()) && /needs a password/.test(await notes()) && await saveBtn().isDisabled(), 'it needs an SSID and a password before it can be saved');
check(await input(fresh, 'Encryption').inputValue() === 'sae-mixed' && await netBox(fresh, 'lan').isChecked(), 'it starts protected (WPA2/WPA3) and attached to lan');
await type(fresh, 'SSID', 'iot');
await field(fresh, 'Password').locator('input').fill('iot-network-pass');
await netBox(fresh, 'lan').setChecked(false);
await netBox(fresh, 'guest').setChecked(true);
check(/1 unsaved change: New network "iot" on radio1/.test(await summaryText()) && !/enter/.test(await notes()), 'the banner has one line for it');
await card('radio1').locator('.wf-addbar button:has-text("Add client network")').click();
await page.waitForTimeout(300);
check(await card('radio1').locator('details.wf-new').count() === 2 && /share its channel: the access point moves/.test(await notes()), 'a client network can be added next to an access point, with a warning that they share a channel', await notes());
await card('radio1').locator('details.wf-new').nth(1).locator('button:has-text("Discard network")').click();
await page.waitForTimeout(300);
check(await card('radio1').locator('details.wf-new').count() === 1, 'a network that was only added can be discarded');
mock.calls = [];
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving the new network');
const added = mock.secs.find(s => s.section === 'wifinet0');
check(added && added.values.ssid === 'iot' && added.values.device === 'radio1' && added.values.mode === 'ap' && added.values.network === 'guest' && added.values.encryption === 'sae-mixed' && added.secrets.key === 'iot-network-pass' && mock.calls.includes('uci.apply'), 'it was added as a named wifi-iface section with its options', JSON.stringify(added));
await page.waitForTimeout(700);
check(await net('iot', 'radio1').count() === 1 && /running/.test(await head(net('iot', 'radio1')).innerText()), 'it shows up running after the save');
await openAll(net('iot', 'radio1'));
await net('iot', 'radio1').locator('button:has-text("Remove network")').click();
await page.waitForTimeout(300);
check(/Remove network "iot"/.test(await page.locator('.set-bar-summary').innerText()) && /to be removed/.test(await head(net('iot', 'radio1')).innerText()) && /is removed when you save/.test(await net('iot', 'radio1').innerText()), 'removing marks the network and offers Undo');
await net('iot', 'radio1').locator('button:has-text("Undo")').click();
await page.waitForTimeout(300);
check(await bar().isHidden(), 'Undo takes the removal back');
await net('iot', 'radio1').locator('button:has-text("Remove network")').click();
await page.waitForTimeout(300);
await saveBtn().click();
check(/^Saved/.test(await outcome()) && !mock.secs.some(s => s.section === 'wifinet0'), 'the network is removed from the config');
await page.waitForTimeout(700);

console.log('\n== a change the router does not keep ==');
await go('radios');
mock.dropWrites = true;
await openAll(settings('radio0'));
await type(settings('radio0'), 'Transmit power (dBm)', '15');
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /radio0: Transmit power \(dBm\) was not saved/.test(lost), 'a change that does not read back is rolled back and reported', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0, 'rollback is called, confirm is not, and nothing stays staged', mock.calls.join(' '));
check(await input(settings('radio0'), 'Transmit power (dBm)').inputValue() === '15', 'the edit stays in the form for a retry');
mock.dropWrites = false;
await discard();
check(await input(settings('radio0'), 'Transmit power (dBm)').inputValue() === '' && await saveBtn().isHidden(),
  'discard reloads the unchanged radio settings before the next edit');

console.log('\n== a radio or a network that does not come back ==');
mock.radioDown = true;
await openAll(settings('radio0'));
await type(settings('radio0'), 'Transmit power (dBm)', '15');
mock.calls = [];
await saveBtn().click();
const down = await outcome();
check(/radio0 did not come back up/.test(down) && /rolled back/.test(down) && mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm'), 'a radio that stays down after the change makes the router undo it', down);
check(!mock.secs.find(s => s.section === 'radio0').values.txpower, 'and the power is back');
mock.radioDown = false;
await discard();
await go('wifi');
await card('radio1').locator('.wf-addbar button:has-text("Add access point")').click();
await page.waitForTimeout(300);
const broken = card('radio1').locator('details.wf-new');
await type(broken, 'SSID', 'broken');
await field(broken, 'Password').locator('input').fill('broken-network-pass');
mock.ifaceDown = 'wifinet0';
mock.calls = [];
await saveBtn().click();
const nodown = await outcome();
check(/radio1 did not come back up/.test(nodown) && mock.calls.includes('uci.rollback') && !mock.secs.some(s => s.section === 'wifinet0'), 'a new network that does not start makes the router undo the change', nodown);
mock.ifaceDown = null;
await discard();
await go('radios');
mock.confirmFails = true;
await openAll(settings('radio0'));
await type(settings('radio0'), 'Transmit power (dBm)', '15');
await saveBtn().click();
const nc = await outcome();
check(/^Confirmation failed; the outcome is uncertain\./.test(nc) && /Rollback could not be confirmed/.test(nc) && !/was rolled back/.test(nc)
  && !mock.secs.find(s => s.section === 'radio0').values.txpower, 'the mock restored the config, but the page reports uncertainty without a rollback acknowledgement', nc);
mock.confirmFails = false;
await discard();

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [{ op: 'set', section: 'radio0', values: { channel: '1' } }];
await refresh();
check(/1 change\(s\) are already staged/.test(await bodyText()), 'staged changes in the session are shown');
await page.getByRole('button', { name: "Discard this page's staged changes", exact: true }).click();
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await bodyText()), "Discard clears this page's staged changes");
//#endregion

//#region Logins and plugins
console.log('\n== a login that may not write ==');
const readOnly = { ubus: { system: ['board', 'info'], 'flab.radio': ['status', 'config'], 'flab.wifi': ['clients'], uci: ['changes'] } };
const ro = await open(readOnly, '.wf-block');
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('details.wf-block').count() === 2 && await ro.locator('.rd-pick').count() === 0, 'the settings are shown, read only, with a note saying why');
await ro.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
await ro.waitForTimeout(200);
await ro.evaluate(() => { location.hash = '#wifi'; });
await ro.waitForSelector('.wf-iface');
await ro.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
await ro.waitForTimeout(200);
check((await ro.locator('.wf-iface input:not([type=hidden]), .wf-iface select, .wf-block input, .wf-block select').evaluateAll(e => e.every(x => x.disabled))) && await ro.locator('.wf-addbar button').evaluateAll(e => e.every(b => b.disabled)), 'every control and the add buttons are disabled');
await ro.close();

console.log('\n== a plugin that cannot report the configuration ==');
mock.noConfig = true;
const old = await open(undefined, '.rd-card');
check(/cannot report the wireless configuration/.test(await old.locator('main').innerText()) && await old.locator('details.wf-block').count() === 0 && await old.locator('.rd-pick').count() === 0 && await old.locator('.rd-chan .chn').count() > 0, 'the radios stay read only with the plain channel strip, and a note says how to fix it');
await old.close();
mock.noConfig = false;

console.log('\n== a router without the Wi-Fi plugins ==');
mock.noPlugin = true;
const none = await open(undefined, 'main');
await none.waitForTimeout(1500);
check(await none.locator('details.wf-block').count() === 0 && await none.locator('.rd-card').count() === 0, 'the page does not offer editing without radios');
await none.close();
mock.noPlugin = false;

console.log('\n== theme ==');
await go('wifi');
await refresh();
await openAll(net('guests', 'radio1'));
await page.emulateMedia({ colorScheme: 'dark' });
await choose(net('guests', 'radio1'), 'Encryption', '');
await page.waitForTimeout(300);
await shotOf(net('guests', 'radio1'), 'dark');
await page.emulateMedia({ colorScheme: 'light' });
await discard();

console.log('\n== the session expires ==');
await go('radios');
await openAll(settings('radio0'));
await type(settings('radio0'), 'Transmit power (dBm)', '12');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 40000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0 && mock.gets.length === 0, 'no uci write or read reached the real router, and the wireless config was never read with uci get', `${mock.unsafe.join()} ${mock.gets.join()}`);
check(errors.length === 0, 'no console errors', errors.join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall Wi-Fi editing checks passed');
process.exit(failed ? 1 : 0);
