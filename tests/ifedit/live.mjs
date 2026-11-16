// Browser test for the network board (the Devices and Interfaces page, which also holds the bridges) and its editing panels in the drawer. A real browser opens the
// deployed UI.
// 1. Against the real router, read only: the board shows the router's own interfaces, devices and bridges, and every uci write that
//    might be sent in this phase is blocked and fails the test.
// 2. Against a stateful mock of rpcd's `uci` object and mocked flab.network and netifd replies (derived from what the real router
//    reported, with a configuration of the same shape): the whole editing flow - validation, the write-only password, a protocol change,
//    adding and removing interfaces and devices, moving a port between bridges, the warnings and the confirmation before a risky
//    change, saving with the longer rollback countdown, a change the router does not keep, an interface that does not come up, staged
//    leftovers, a login that may not write, a missing plugin method, an expired session - WITHOUT touching the router's configuration.
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
// A deep copy, so a test can edit a fixture without touching the original.
const clone = o => JSON.parse(JSON.stringify(o));

//#region The mock router
const SECRET = 'mock-pppoe-secret-1234';
const SECRET2 = 'mock-wg-private-key-5678';
const TYPED = 'typed-new-pass-9876';
const WRITES = ['set', 'add', 'delete', 'apply', 'confirm', 'rollback', 'revert', 'commit', 'order', 'rename'];
// The options the plugin reports as secrets (the same rule as flab.network.uc).
const SECRET_OPTION = /^(password|passwd|pin|pincode|[a-z0-9_]*(passw|secret|psk|key|token|credential)[a-z0-9_]*)$/i;

// A section of the mock config.
const S = (name, type, values, anonymous = false) => ({ name, type, anonymous, values });
// The network config of the mock router: the shape of a real router with a bridge on five ports, PPPoE over a VLAN, a second VLAN network, an IPsec
// and a WireGuard interface, and a route (which the page must never touch).
const baseCfg = () => [
  S('loopback', 'interface', { device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' }),
  S('globals', 'globals', { ula_prefix: 'fd92:cdf9:fb3f::/48', packet_steering: '2', dhcp_default_duid: '0004abcd', custom_opt: 'x' }),
  S('cfg030f15', 'device', { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2', 'lan3', 'lan4', 'lan5'], stp: '1' }, true),
  S('lan', 'interface', { device: 'br-lan', proto: 'static', ipaddr: '192.168.1.1', netmask: '255.255.255.0', ip6assign: '60', ip6hint: '0' }),
  S('cfg040f15', 'device', { type: '8021q', ifname: 'eth1', vid: '1036', name: 'eth1.1036', macaddr: '74:36:6D:C0:9B:83' }, true),
  S('wan', 'interface', { device: 'eth1.1036', proto: 'pppoe', username: 'user1', password: SECRET, ipv6: '0', peerdns: '0', vlandid: '1036', odd_option: 'x' }),
  S('wan6', 'interface', { proto: 'dhcpv6', device: '@wan', reqaddress: 'try', reqprefix: 'auto', norelease: '1' }),
  S('cfg050f15', 'device', { type: '8021q', ifname: 'br-lan', vid: '100', name: 'br-lan.100' }, true),
  S('lan100', 'interface', { proto: 'static', device: 'br-lan.100', ipaddr: '192.168.100.1', netmask: '255.255.255.0', ip6assign: '64', ip6hint: '64' }),
  S('xfrm0', 'interface', { proto: 'xfrm', ifid: '357', tunlink: 'wan', mtu: '1438', zone: 'vpn' }),
  S('wg0', 'interface', { proto: 'wireguard', private_key: SECRET2, listen_port: '51820', addresses: ['192.168.2.1/24'] }),
  S('voip_private', 'route', { interface: 'wan', target: '10.0.0.0/8', gateway: '1.2.3.4' }),
];
const mock = {
  on: false, cfg: baseCfg(), staged: [], restage: [], snapshot: null, calls: [], applyArgs: [], dropWrites: false, confirmFails: false, expired: false,
  noConfig: false, configIsStatus: false, reads: [], unsafe: [], dumpDown: [], realStatus: null, realDump: null, statusEdit: null,
};
let nextId = 1;

// The reply of `flab.network config` for the mock's config (secrets are only flagged, never returned).
function configReply() {
  const options = s => {
    const values = {}, secrets = {};
    for (const [k, v] of Object.entries(s.values)) { if (SECRET_OPTION.test(k)) { if (v) secrets[k] = true; } else values[k] = v; }
    return { section: s.name, anonymous: s.anonymous, values, secrets };
  };
  const other = {};
  for (const s of mock.cfg) if (s.type !== 'interface' && s.type !== 'device' && s.type !== 'globals') other[s.type] = (other[s.type] ?? 0) + 1;
  const globals = mock.cfg.find(s => s.type === 'globals');
  return { generated: Math.floor(Date.now() / 1000), interfaces: mock.cfg.filter(s => s.type === 'interface').map(options), devices: mock.cfg.filter(s => s.type === 'device').map(options), globals: globals ? options(globals) : null, other, bridge_vlans: [] };
}
// The reply of `flab.network status`: what the real router reported, with `statusEdit` applied.
function status() {
  const s = clone(mock.realStatus);
  mock.statusEdit?.(s);
  return s;
}
// The reply of netifd's interface dump: the real router's interfaces, those of the mock's config that the router lacks, without the ones it removed, the listed ones down.
function dump() {
  const names = new Set(mock.cfg.filter(s => s.type === 'interface').map(s => s.name));
  const list = mock.realDump.filter(i => names.has(i.interface)).map(clone);
  for (const s of mock.cfg.filter(x => x.type === 'interface' && !list.some(i => i.interface === x.name))) list.push({ interface: s.name, up: true, pending: false, available: true, proto: s.values.proto, device: s.values.device });
  for (const i of list) if (mock.dumpDown.includes(i.interface)) i.up = false;
  return list;
}

// Applies the staged edits to the mock's config, the way rpcd's uci apply does.
function commit() {
  for (const [op, section, option, value] of mock.staged) {
    const s = mock.cfg.find(x => x.name === section);
    if (op === 'set') s.values[option] = value;
    else if (op === 'delete' && option) delete s.values[option];
    else if (op === 'delete') mock.cfg.splice(mock.cfg.indexOf(s), 1);
    else if (op === 'add') mock.cfg.push(S(section, option, clone(value.values), value.anonymous));
  }
}
// What a rollback or a failed confirmation puts back.
const restore = () => { mock.cfg = mock.snapshot; mock.staged = mock.restage; mock.snapshot = null; };

// One uci method of the mock: [ubus status, data].
function uci(method, args) {
  if (method === 'get') { mock.reads.push(`${args.config}`); return [6]; }
  if (method === 'changes') {
    const list = args.config && args.config !== 'network' ? [] : mock.staged.map(c => c.slice(0, 4));
    return [0, { changes: args.config ? list : (list.length ? { network: list } : {}) }];
  }
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${100 + nextId++}`;
    mock.staged.push(['add', name, args.type, { values: args.values ?? {}, anonymous: !args.name }]);
    return [0, { section: name }];
  }
  if (method === 'delete') { for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o, undefined]); return [0, {}]; }
  if (method === 'revert') { if (args.config !== 'network') return [4]; mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.applyArgs.push(args);
    mock.snapshot = clone(mock.cfg);
    mock.restage = mock.staged;
    if (!mock.dropWrites) commit();
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
    if (!mock.snapshot) return [5];
    if (mock.confirmFails) { restore(); return [1]; }
    mock.snapshot = null;
    return [0, {}];
  }
  if (method === 'rollback') {
    if (!mock.snapshot) return [5];
    restore();
    return [0, {}];
  }
  return [0, {}];
}

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // Wraps a ubus status code and optional data as a JSON-RPC result.
  const ok = ([code, data]) => ({ jsonrpc: '2.0', id: body.id, result: data === undefined ? [code] : [code, data] });
  const denied = { jsonrpc: '2.0', id: body.id, error: { code: -32002, message: 'Access denied' } };

  if (!mock.on) {
    // Real router: reads only. A write would change something, so it is blocked and the test fails.
    if ((obj === 'uci' && WRITES.includes(method)) || (obj === 'flab.network' && method === 'cable_test')) { mock.unsafe.push(`${obj}.${method}`); return ok([6]); }
    if (obj === 'uci' && method === 'get') mock.reads.push(`real:${args.config}`);
    return null;
  }
  if (mock.expired && ['uci', 'flab.network', 'network.interface', 'system', 'service', 'session', 'flab.radio', 'flab.mesh'].includes(obj)) return denied;
  if (obj === 'uci') { mock.calls.push(`uci.${method}`); return ok(uci(method, args)); }
  if (obj === 'flab.network') {
    if (method === 'status') return ok([0, status()]);
    if (method === 'config') {
      mock.calls.push('plugin.config');
      if (mock.noConfig) return ok([4]);
      return ok([0, mock.configIsStatus ? status() : configReply()]);
    }
    mock.unsafe.push(`${obj}.${method}`);
    return ok([6]);
  }
  if (obj === 'network.interface' && method === 'dump') return ok([0, { interface: dump() }]);
  if (obj === 'flab.radio' && method === 'status') return ok([0, { radios: [] }]);
  if (obj === 'flab.mesh' && method === 'status') return ok([0, { nodes: [] }]);
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
// Opens a page of the UI with a session in sessionStorage, the way a real sign-in leaves the tab.
const open = async (route, acls) => {
  const p = await ctx.newPage();
  p.on('pageerror', e => { errors.push(String(e)); console.log(`PAGE ERROR ${e}`); });
  p.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log(`CONSOLE ERROR ${m.text()}`); } });
  await p.addInitScript(([id, a]) => {
    sessionStorage.setItem('sid', id);
    sessionStorage.setItem('acls', JSON.stringify(a));
  }, [sid, acls ?? rootAcls]);
  await p.goto(`${baseUrl}#${route}`);
  await p.waitForSelector('.tile, main .set-note, .login-form', { timeout: 20000 });
  return p;
};
let page = await open('interfaces');

// Helpers: the board, the open panel, fields, the banner and screenshots. The selectors of the contents of the panels (inside the drawer) are all here,
// so a change to the panels needs a change in this block only.
// The panel of the item that is open, header, body and footer.
const card = () => page.locator('.fl-drawer');
// The ports of a bridge that are ticked in the panel, by name.
const tickedPorts = c => c.locator('.ne-port input:checked').evaluateAll(els => els.map(e => e.closest('label').querySelector('strong').textContent));
// The port row of the ports picker in the panel.
const portRow = (c, name) => c.locator(`.ne-port:has(strong:text-is("${name}"))`);
// The board card of an item by its id (interfaces: if:<name>, devices: dev:<section>), of a device or interface by name, of a port.
const boardCard = id => page.locator(`.nb-card[data-id="${id}"]`);
const ifaceCard = name => page.locator(`.nb-lane-interfaces .nb-card:has(.nb-name:text-is("${name}"))`);
const deviceCardOf = name => page.locator(`.nb-lane-devices .nb-card:has(.nb-name:text-is("${name}"))`);
const portCardOf = name => page.locator(`.nb-lane-ports .nb-card:has(.nb-name:text-is("${name}"))`);
// Opens a board card in the drawer (a click near its corner, clear of the "details" toggle) and waits for the panel.
const openCard = async c => { await c.click({ position: { x: 6, y: 6 } }); await page.waitForSelector('.fl-drawer.show'); await page.waitForTimeout(300); };
const openIf = name => openCard(ifaceCard(name));
const openDevice = name => openCard(deviceCardOf(name));
// The title of the open drawer.
const drawerTitle = () => page.locator('.fl-drawer .fl-drawer-title').innerText();
// Adds a device of a kind ('Bridge', 'VLAN device', 'Port settings') from the Device menu; the new device opens in the drawer.
const addDevice = async kind => { await page.locator('.nb-lane-devices .nb-menu-wrap > button').click(); await page.locator(`.nb-menu-item:has(strong:text-is("${kind}"))`).click(); await page.waitForSelector('.fl-drawer.show'); await page.waitForTimeout(400); };
// Opens every Advanced block of the open panel (they are folded until opened).
const unfold = async () => { await page.locator('.fl-drawer details.np-adv').evaluateAll(ds => ds.forEach(d => { d.open = true; })); await page.waitForTimeout(100); };
// The form field labeled `label` within `scope`: a control with a label of its own, or a checkbox row whose text starts with the label.
const field = (scope, label) => scope.locator('.set-field').filter({ has: page.locator('label', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) }).or(scope.locator('label.set-check', { hasText: new RegExp(`^\\s*${label}`) })).first();
// The input of that field.
const input = (scope, label) => field(scope, label).locator('input, select').first();
// The checkbox row labeled `label` within `scope`.
const box = (scope, label) => scope.locator('label.set-check', { hasText: label }).first().locator('input');
// The protocol card of a protocol id in the open panel.
const protoCard = id => page.locator(`.fl-drawer .np-proto[data-proto="${id}"]`);
// The wizard dialog and a button of its footer.
const wizard = () => page.locator('dialog.fl-dialog[open]');
const wizBtn = text => wizard().locator('.modal-footer button', { hasText: text });
// Starts the wizard from the Interfaces lane header.
const startWizard = async () => { await page.locator('.nb-lane-interfaces .nb-lane-head button').click(); await wizard().waitFor(); await page.waitForTimeout(300); };
// All the notes in the banner, joined into one string; and how many are errors.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
const errorCount = () => page.locator('.set-notes .set-note.bad').count();
// The save bar, its summary and the save button.
const bar = () => page.locator('.set-bar:not([hidden])');
const saveBtn = () => page.locator('.set-bar:not([hidden]) button:has-text("Save and apply")');
const summaryText = () => page.locator('.set-bar:not([hidden]) .set-bar-summary').innerText();
// The text of the review of pending changes.
const changes = async () => { if (await page.locator('.set-bar:not([hidden]) .set-bar-details').isHidden()) await page.click('.set-bar:not([hidden]) button:has-text("Details")'); return page.locator('.set-bar:not([hidden]) .set-changes').evaluate(e => e.textContent); };
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `ifedit-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save bar to report the result of a save and returns its text.
const outcome = async (timeout = 25000) => { const n = page.locator('.set-bar:not([hidden]) .set-outcome.ok, .set-bar:not([hidden]) .set-outcome.bad').first(); await n.waitFor({ timeout }); return (await n.innerText()).trim(); };
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
// Clicks something that redraws the form and gives the page a moment to do it.
const tap = async locator => { await locator.click(); await page.waitForTimeout(350); };
// The text of the open confirmation dialog.
const dialogText = () => page.locator('dialog.fl-dialog').innerText();
// Clicks Save and, when the risk dialog appears, answers it.
const saveAndConfirm = async () => { await saveBtn().click(); await page.waitForSelector('dialog.fl-dialog[open]', { timeout: 5000 }); await page.click('dialog.fl-dialog button:has-text("Apply the change")'); };

//#region The real router (read only)
console.log('== the real router (read only, nothing is written) ==');
const real = await page.evaluate(async () => {
  const sid = sessionStorage.getItem('sid');
  // One ubus call from the page, through the session.
  const call = async (obj, method) => (await (await fetch('/ubus', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, obj, method, {}] }) })).json()).result?.[1];
  return { cfg: await call('flab.network', 'config'), status: await call('flab.network', 'status'), dump: (await call('network.interface', 'dump')).interface };
});
mock.realStatus = real.status;
mock.realDump = real.dump;
check(Array.isArray(real.cfg?.interfaces) && real.cfg.interfaces.length >= 2, 'the plugin returns the router\'s network config', JSON.stringify(real.cfg).slice(0, 200));
check(/br-lan/.test(await page.locator('.nb-lane-devices').innerText()) && await page.locator('.nb-svg path').count() >= 3, 'the board shows the router\'s bridge and draws connectors between the cards');
const realIfCards = await page.locator('.nb-lane-interfaces .nb-card').count();
const realDevCards = await page.locator('.nb-lane-devices .nb-card').count();
check(realIfCards >= real.cfg.interfaces.length - 1 && realDevCards >= real.cfg.devices.filter(d => ['bridge', '8021q', '8021ad'].includes(d.values.type)).length, 'every interface (but the loopback) and every bridge and VLAN device section has a card', `${realIfCards} interface cards for ${real.cfg.interfaces.length} interfaces, ${realDevCards} device cards for ${real.cfg.devices.length} sections`);
check(await bar().isHidden() && await page.locator('.nb-lane-interfaces .nb-lane-head button').isEnabled() && await page.locator('.nb-lane-devices .nb-menu-wrap > button').isEnabled(), 'nothing is pending and the editor is enabled for this login');
check(await page.locator('.fl-drawer').count() === 0, 'no panel is open until a card is clicked');
// Every PPPoE interface: its panel has an empty password box (the password is never shown).
let pwBoxes = 0, pwEmpty = true;
for (const s of real.cfg.interfaces.filter(s => s.values.proto === 'pppoe')) {
  await openIf(s.section);
  await unfold();
  const boxes = page.locator('.fl-drawer input[type=password]');
  pwBoxes += await boxes.count();
  pwEmpty &&= await boxes.evaluateAll(els => els.every(e => e.value === ''));
}
check(pwBoxes === real.cfg.interfaces.filter(s => s.values.proto === 'pppoe').length && pwEmpty, 'a PPPoE password box exists per PPPoE interface and is empty: the password is never shown', `${pwBoxes} boxes`);
check((await page.content()).indexOf('REDACTED') < 0, 'nothing in the page is a redacted secret placeholder');
await shot('real-interfaces');
const lanBridge = real.cfg.devices.find(d => d.values.type === 'bridge');
if (lanBridge) {
  await openDevice(lanBridge.values.name);
  const c = card();
  const ticked = await tickedPorts(c);
  check(JSON.stringify(ticked.sort()) === JSON.stringify([...(lanBridge.values.ports ?? [])].sort()), 'the ports picker ticks the ports of the bridge\'s configuration', JSON.stringify(ticked));
  await shot('real-bridge-panel');
}
if (real.cfg.globals) {
  await page.locator('.nb-toolbar button:has-text("Network-wide settings")').click();
  await page.waitForSelector('.fl-drawer.show');
  await page.waitForTimeout(300);
  check(await input(card(), 'IPv6 ULA prefix').inputValue() === (real.cfg.globals.values.ula_prefix ?? '') && await input(card(), 'Packet steering').inputValue() === (real.cfg.globals.values.packet_steering ?? ''), 'the network-wide settings show the router\'s own globals section', JSON.stringify(real.cfg.globals.values));
  await shot('real-globals');
}
await page.keyboard.press('Escape');
check(await page.locator('.fl-drawer').count() === 0, 'Escape closes the panel');
check(mock.unsafe.length === 0 && !mock.reads.some(r => r.startsWith('real:network')), 'nothing was written, and the page never read the network config with uci get', `${mock.unsafe.join()} ${mock.reads.join()}`);
//#endregion

//#region Mock: the Devices and Interfaces page
mock.on = true;
// The firewall zones of the mock router are its own, so which interfaces count as the management network does not depend on the real router.
mock.statusEdit = s => { s.zones = [{ name: 'lan', networks: ['lan'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', masq: false, forwards: ['wan'] }, { name: 'wan', networks: ['wan', 'wan6'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: true, forwards: [] }]; };
await page.goto(`${baseUrl}#interfaces`);
await page.reload();
await page.waitForSelector('.nb-card');
console.log('\n== reading (mock router) ==');
const ifNames = await page.locator('.nb-lane-interfaces .nb-name').allInnerTexts();
check(['lan', 'wan', 'wan6', 'lan100', 'xfrm0', 'wg0'].every(n => ifNames.includes(n)) && !ifNames.includes('loopback'), 'one card per logical interface, the loopback left out', ifNames.join());
const devNames = await page.locator('.nb-lane-devices .nb-name').allInnerTexts();
check(devNames.includes('eth1.1036') && devNames.includes('br-lan.100') && devNames.includes('br-lan'), 'the bridge and the VLAN devices have cards in the devices lane', devNames.join());
check(/PPPoE/.test(await ifaceCard('wan').innerText()) && /on eth1\.1036/.test(await ifaceCard('wan').innerText()) && /on the PPPoE session of wan|on the device of wan/.test(await ifaceCard('wan6').innerText()) && /runs over wan/.test(await ifaceCard('xfrm0').innerText()), 'an interface card says what it sits on: a VLAN device, the session of another interface, the interface a tunnel runs over');
check(await page.locator('.nb-lane-zones .nb-card:has(.nb-name:text-is("wan"))').count() === 1 && /NAT/.test(await page.locator('.nb-lane-zones').innerText()), 'the firewall zones are on the last lane, the WAN zone with NAT');
await openIf('lan');
check(await drawerTitle() === 'lan' && await boardCard('if:lan').evaluate(e => e.classList.contains('nb-sel')) && await page.locator('.nb-card.nb-rel').count() >= 4, 'a click opens the interface in the drawer and highlights what it is connected to');
const lan = card();
check(await page.locator('.fl-drawer .np-proto[aria-checked=true]').getAttribute('data-proto') === 'static' && await page.locator('.fl-drawer input[name="np-dev-lan"]:checked').getAttribute('value') === 'br-lan', 'the protocol card and the device chosen for lan', await page.locator('.fl-drawer .np-proto[aria-checked=true]').getAttribute('data-proto'));
check(await input(lan, 'IPv4 addresses').inputValue() === '192.168.1.1', 'the address of lan is an essential option');
await unfold();
check(await input(lan, 'IPv4 netmask').inputValue() === '255.255.255.0', 'the netmask is under Advanced');
check(await field(lan, 'IPv4 addresses').locator('.set-hint').count() === 1 && /netmask below/.test(await field(lan, 'IPv4 addresses').locator('.set-hint').innerText()), 'every option has a hint');
check(await field(lan, 'PAP/CHAP username').count() === 0 && await field(lan, 'Client identifier').count() === 0, 'options of other protocols are not shown');
await openIf('wan');
const wan = card();
await unfold();
const pw = input(wan, 'PAP/CHAP password');
check(await pw.getAttribute('type') === 'password' && await pw.inputValue() === '' && /stored; leave empty/.test(await pw.getAttribute('placeholder')) && !(await page.content()).includes(SECRET), 'the stored PPPoE password is not in the page: its box is empty, with a note that one is stored');
check(await input(wan, 'PAP/CHAP username').inputValue() === 'user1' && /odd_option/.test(await wan.locator('.ne-extra').innerText()), 'the options show their values, and one the page has no control for is listed read only');
await openIf('wg0');
const wg = card();
check(/does not edit this protocol/.test(await wg.innerText()) && await wg.locator('input, select').count() === 0 && !(await page.content()).includes(SECRET2) && /private_key/.test(await wg.innerText()) && /hidden \(a secret\)/.test(await wg.innerText()), 'WireGuard is read only, and its private key is only said to be hidden');
await openIf('xfrm0');
check(await card().locator('input, select').count() === 0, 'the IPsec interface is read only');
check(await bar().isHidden(), 'the banner is hidden while nothing is edited');
check(!/(^|\s)null(\s|$)/.test(await page.locator('main').innerText()) && !/nullnull/.test(await page.locator('main').innerText()), 'no stray "null" text from an empty note');
check(!/already staged/.test(await page.locator('main').innerText()), 'no leftovers are announced');
await shot('mock-interfaces');

console.log('\n== validation ==');
await openIf('lan');
await unfold();
await input(lan, 'IPv4 addresses').fill('192.168.1.300');
check(/IPv4 addresses: "192\.168\.1\.300" is not an IPv4 address/.test(await notes()) && await saveBtn().isDisabled() && await input(lan, 'IPv4 addresses').evaluate(e => e.classList.contains('is-invalid')), 'a bad address is marked and blocks Save', await notes());
await input(lan, 'IPv4 addresses').fill('192.168.100.7');
check(/lan and lan100 are on the same subnet 192\.168\.100\.0\/24|lan100 and lan are on the same subnet/.test(await notes()) && await saveBtn().isDisabled(), 'two interfaces on one subnet are refused', await notes());
await input(lan, 'IPv4 addresses').fill('192.168.1.1');
await input(lan, 'IPv4 gateway').fill('10.1.1.1');
check(/gateway 10\.1\.1\.1 is outside the interface's subnet \(192\.168\.1\.0\/24\)/.test(await notes()) && await saveBtn().isDisabled(), 'a gateway outside the subnet is refused', await notes());
await input(lan, 'IPv4 gateway').fill('');
await input(lan, 'MTU').fill('40');
check(/lan: MTU must be at least 68/.test(await notes()), 'an MTU out of range is refused', await notes());
await input(lan, 'MTU').fill('1400');
check(await errorCount() === 0 && /MTU/.test(await summaryText()), 'a valid MTU is a change (the banner counts it)', await notes());
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);
check(await bar().isHidden(), 'Discard edits returns to what the router has');

console.log('\n== a protocol change ==');
await openIf('lan100');
const l100 = card();
await protoCard('dhcp').click();
await page.waitForTimeout(300);
await unfold();
check(await field(l100, 'IPv4 addresses').count() === 0 && await field(l100, 'Client identifier').count() === 1 && await field(l100, 'Host name to send').count() === 1, 'the static options give way to the DHCP client options');
check(/Changed from Static address: saving removes IPv4 addresses, IPv4 netmask/.test(await l100.innerText()), 'the panel says what the save removes');
const review = await changes();
check(/lan100: Protocol/.test(review) && /options of static/.test(review) && /ipaddr, netmask/.test(review), 'the review says the options of the old protocol are removed', review);
await input(l100, 'Client identifier').fill('xyz');
check(/Client identifier must be hexadecimal digits in pairs/.test(await notes()) && await saveBtn().isDisabled(), 'a DHCP option is validated', await notes());
await input(l100, 'Client identifier').fill('0a0b');
await shot('mock-dhcp');
mock.calls = [];
await saveBtn().click();
const doneDhcp = await outcome();
check(/^Saved/.test(doneDhcp), 'the protocol change is saved', doneDhcp);
const savedL100 = mock.cfg.find(s => s.name === 'lan100').values;
check(savedL100.proto === 'dhcp' && savedL100.clientid === '0a0b' && !('ipaddr' in savedL100) && !('netmask' in savedL100) && savedL100.ip6assign === '64', 'proto and client id were written, the static options removed, the shared ones kept', JSON.stringify(savedL100));
check(mock.applyArgs.at(-1).rollback === true && mock.applyArgs.at(-1).timeout === 90, 'the change is applied with the rollback and a 90 second countdown (per call)', JSON.stringify(mock.applyArgs.at(-1)));
check(/^(plugin\.config )*uci\.changes( uci\.(set|add|delete))+ uci\.apply( plugin\.config)+ uci\.confirm/.test(mock.calls.join(' ')), 'checked for leftovers, staged, applied, read back through the plugin, confirmed', mock.calls.join(' '));
check(mock.reads.length === 0, 'the page never reads the config with uci get', mock.reads.join());

console.log('\n== the PPPoE password is write-only ==');
await openIf('wan');
const wan2 = card();
await input(wan2, 'PAP/CHAP password').fill(TYPED);
check(/1 unsaved change/.test(await summaryText()), 'typing a password is a change');
const reviewPw = await changes();
check(/new value \(hidden\)/.test(reviewPw) && !reviewPw.includes(TYPED) && !reviewPw.includes(SECRET), 'the review shows it only as "new value (hidden)"', reviewPw);
check(/within 90 seconds/.test(await page.locator('.set-bar:not([hidden]) .set-bar-details').innerText()), 'the review promises the 90 second rollback');
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'it is saved without a question (nothing risky)');
check(mock.cfg.find(s => s.name === 'wan').values.password === TYPED && mock.cfg.find(s => s.name === 'wan').values.odd_option === 'x', 'the password was stored and the other options kept');
check(await input(card(), 'PAP/CHAP password').inputValue() === '' && !(await page.content()).includes(TYPED), 'afterwards the box is empty again and the page does not hold the password');
check(await page.locator('.fl-drawer').count() === 1 && await drawerTitle() === 'wan', 'the open panel survives the redraw after a save');

console.log('\n== adding and removing interfaces (the wizard) ==');
await startWizard();
check(/New network/.test(await wizard().innerText()) && await wizard().locator('.np-steps li').count() === 3 && await page.locator('.nb-lane-interfaces .nb-card.nb-new').count() === 0, '+ Network opens the wizard, and nothing is in the draft before Finish');
await wizard().locator('[data-where=vlan]').click();
await wizard().locator('.np-opt', { has: page.locator('strong', { hasText: /^eth1$/ }) }).click();
await wizard().locator('input[placeholder="1 to 4094"]').fill('300');
await page.waitForTimeout(250);
check(await wizard().locator('input[placeholder="eth1.200"]').inputValue() === 'eth1.300' && await wizBtn('Next').isEnabled(), 'a new VLAN device: the base device and ID give its name');
await wizBtn('Next').click();
await wizBtn('Next').click();
await page.waitForTimeout(250);
const wname = wizard().locator('input[placeholder="guest"]');
await wname.fill('lan');
check(/already a section called "lan"/.test(await wizard().locator('.np-problems').innerText()) && await wizBtn('Finish').isDisabled(), 'the wizard refuses a name that is taken', await wizard().locator('.np-problems').innerText());
await wname.fill('guest');
await wizard().locator('input[placeholder="192.168.10.1/24"]').fill('10.9.9.1/24');
await page.waitForTimeout(250);
check(await wizBtn('Finish').isEnabled() && /A new VLAN device eth1\.300: VLAN 300 of eth1/.test(await wizard().innerText()), 'a valid network can be finished, and the wizard says what it adds');
await shot('mock-wizard');
await wizBtn('Finish').click();
await page.waitForTimeout(500);
check(/Nothing is saved yet/.test(await wizard().innerText()) && await wizard().locator('a[href="#firewall"]').count() === 1 && await wizard().locator('a[href="#dhcp"]').count() === 1, 'the last page says nothing is saved and links to the Firewall and DHCP pages');
await wizBtn('Close').click();
await page.waitForTimeout(500);
check(await page.locator('.nb-lane-interfaces .nb-card.nb-new').count() === 1 && await drawerTitle() === 'guest' && /Not saved yet|not saved yet/.test(await card().innerText()), 'the new interface is on the board marked new, and its panel is open');
check(/on eth1\.300/.test(await page.locator('.nb-lane-interfaces .nb-card.nb-new').innerText()) && await page.locator('.nb-lane-devices .nb-card.nb-new .nb-name:text-is("eth1.300")').count() === 1, 'the board shows the new interface on the new VLAN device');
const nameBox = card().locator('input[placeholder="guest"]');
await nameBox.fill('my-net');
check(/letters, digits and underscores/.test(await notes()) && await saveBtn().isDisabled(), 'in the panel a name with a dash is refused', await notes());
await nameBox.fill('guest');
check(await errorCount() === 0, 'a valid new interface has no errors', await notes());
await shot('mock-new-interface');
await startWizard();
await wizBtn('Next').click();
await wizBtn('Next').click();
await page.waitForTimeout(250);
await wizBtn('Finish').click();
await page.waitForTimeout(400);
await wizBtn('Close').click();
await page.waitForTimeout(500);
check(await page.locator('.nb-lane-interfaces .nb-card.nb-new').count() === 2, 'a second network appears');
await tap(card().locator('button:has-text("Discard interface")'));
check(await page.locator('.nb-lane-interfaces .nb-card.nb-new').count() === 1 && await page.locator('.fl-drawer').count() === 0, 'a new interface can be discarded (its panel closes with it)');
await openIf('wan6');
await tap(card().locator('button:has-text("Remove interface")'));
check(/is removed when you save/.test(await card().innerText()) && /to be removed/.test(await ifaceCard('wan6').innerText()), 'Remove marks an interface (it is not gone until saved), in the panel and on the board');
await tap(card().locator('button:has-text("Undo")'));
check(!/is removed when you save/.test(await card().innerText()) && !/to be removed/.test(await ifaceCard('wan6').innerText()), 'Undo brings it back');
await tap(card().locator('button:has-text("Remove interface")'));
const review2 = await changes();
check(/Add interface guest/.test(review2) && /Remove interface wan6/.test(review2), 'the review lists the new and the removed interface', review2);
check(/removed|firewall zones, DHCP pools and routes that name it/.test(await notes()), 'removing an interface warns about what refers to it', await notes());
await saveBtn().click();
await page.waitForSelector('dialog.fl-dialog[open]', { timeout: 5000 });
check(/Removing the interface wan6/.test(await dialogText()) && mock.applyArgs.length === 2, 'removing an interface asks first, and nothing has been applied yet', await dialogText());
await page.click('dialog.fl-dialog button:has-text("Apply the change")');
check(/^Saved/.test(await outcome()), 'saving the new and the removed interface works');
const guest = mock.cfg.find(s => s.name === 'guest');
const vlan300 = mock.cfg.find(s => s.type === 'device' && s.values.name === 'eth1.300');
check(guest?.type === 'interface' && guest.values.proto === 'static' && guest.values.device === 'eth1.300' && JSON.stringify(guest.values.ipaddr) === '["10.9.9.1/24"]' && !mock.cfg.some(s => s.name === 'wan6'), 'the new interface was added with its options and the removed one is gone', JSON.stringify(guest));
check(vlan300?.anonymous && vlan300.values.type === '8021q' && vlan300.values.ifname === 'eth1' && vlan300.values.vid === '300', 'the wizard\'s VLAN device was added as an anonymous device section', JSON.stringify(vlan300));
check(mock.cfg.some(s => s.name === 'voip_private') && mock.cfg.some(s => s.name === 'globals'), 'sections the page does not know were not touched');
check(await ifaceCard('guest').count() === 1 && await ifaceCard('wan6').count() === 0, 'the board lists the saved interfaces');
check(await page.locator('.fl-drawer').count() === 0, 'the panel of an interface that is gone closes by itself');
await shot('mock-added');

console.log('\n== VLAN devices and device settings ==');
await addDevice('VLAN device');
const vl = card();
await vl.locator('input[placeholder="eth1.200"]').first().fill('eth1.200');
check(/base device/.test(await notes()) && /VLAN ID/.test(await notes()), 'a VLAN device needs its base device and ID', await notes());
await input(vl, 'Base device').selectOption('eth1');
await input(vl, 'VLAN ID').fill('1036');
check(/already is VLAN 1036 on eth1|VLAN 1036 on eth1/.test(await notes()), 'the same VLAN twice on a device is refused', await notes());
await input(vl, 'VLAN ID').fill('200');
check(await errorCount() === 0, 'a valid VLAN device has no errors', await notes());
check(await page.locator('.nb-lane-devices .nb-card.nb-new').count() === 1 && /VLAN 200 on eth1/.test(await page.locator('.nb-lane-devices .nb-card.nb-new').innerText()), 'the new VLAN device is on the board, marked new, with its ID and base device');
await addDevice('Port settings');
const ds = card();
await ds.locator('input[placeholder="lan1"]').first().fill('lan1');
await input(ds, 'MTU').fill('1500');
await unfold();
await box(ds, 'Isolate port').click();
check(await errorCount() === 0 && /Add settings of device lan1/.test(await changes()), 'device settings for a port are accepted', await notes());
check(/new settings/.test(await portCardOf('lan1').innerText()), 'the settings show as a mark on the port\'s board card');
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving the VLAN device and the device settings works');
const newDevs = mock.cfg.filter(s => s.type === 'device' && ['eth1.200', 'lan1'].includes(s.values.name));
check(newDevs.length === 2 && newDevs.find(s => s.values.name === 'eth1.200').values.type === '8021q' && newDevs.find(s => s.values.name === 'eth1.200').values.vid === '200' && newDevs.find(s => s.values.name === 'lan1').values.isolate === '1' && !('type' in newDevs.find(s => s.values.name === 'lan1').values) && newDevs.every(s => s.anonymous), 'both were added as anonymous device sections, the settings without a type', JSON.stringify(newDevs));
await openDevice('br-lan.100');
await tap(card().locator('button:has-text("Remove VLAN device")'));
check(/lan100: the device br-lan\.100 it runs on is removed in this form/.test(await notes()) && await saveBtn().isDisabled(), 'a device that an interface runs on cannot be removed', await notes());
await tap(card().locator('button:has-text("Undo")'));
check(await errorCount() === 0 && await bar().isHidden(), 'Undo clears the error');
await shot('mock-devices');

console.log('\n== a risky change asks first ==');
await openIf('lan');
await input(card(), 'IPv4 addresses').fill('192.168.7.1');
check(/can cut your connection/.test(await notes()) && /IPv4 addresses of lan, the network this page is most likely reached through/.test(await notes()), 'the banner warns about changing the address of lan', await notes());
mock.calls = [];
const appliedBefore = mock.applyArgs.length;
await saveBtn().click();
await page.waitForSelector('dialog.fl-dialog[open]');
const dlg = await dialogText();
check(/cut your connection/.test(dlg) && /restores the previous configuration by itself after 90 seconds/.test(dlg), 'the confirmation names the risk and the 90 second rollback', dlg);
await page.click('dialog.fl-dialog button:has-text("Cancel")');
await page.waitForTimeout(500);
check(mock.applyArgs.length === appliedBefore && !mock.calls.includes('uci.set') && await bar().isVisible() && await input(card(), 'IPv4 addresses').inputValue() === '192.168.7.1', 'Cancel applies nothing and keeps the edit');
await saveAndConfirm();
check(/^Saved/.test(await outcome()) && mock.cfg.find(s => s.name === 'lan').values.ipaddr.join() === '192.168.7.1', 'confirming applies the change');

console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await openIf('lan100');
await unfold();
await input(card(), 'MTU').fill('1480');
mock.calls = [];
await saveBtn().click();
const lost = await outcome();
check(/rolled back/.test(lost) && /lan100: MTU/.test(lost), 'a change that does not read back is rolled back and named', lost);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && mock.staged.length === 0 && !('mtu' in mock.cfg.find(s => s.name === 'lan100').values), 'rollback is called, confirm is not, nothing stays staged, and the router is unchanged', mock.calls.join(' '));
mock.dropWrites = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);

console.log('\n== an interface that does not come up ==');
// After the apply the router reports lan down: the config is stored, but the network is not working.
await openIf('guest');
await unfold();
await input(card(), 'MTU').fill('1400');
mock.dumpDown = ['lan'];
mock.calls = [];
await saveBtn().click();
const downMsg = await outcome(60000);
check(/rolled back/.test(downMsg) && /lan is not up after the change/.test(downMsg), 'a stored config whose interface is down is rolled back too', downMsg);
check(mock.calls.includes('uci.rollback') && !mock.calls.includes('uci.confirm') && !('mtu' in mock.cfg.find(s => s.name === 'guest').values), 'and the router is back on the previous configuration', mock.calls.join(' '));
mock.dumpDown = [];
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);

console.log('\n== the router refuses the confirmation ==');
mock.confirmFails = true;
await openIf('guest');
await unfold();
await input(card(), 'MTU').fill('1400');
mock.calls = [];
await saveBtn().click();
const refused = await outcome();
check(/^Confirmation failed; the outcome is uncertain\./.test(refused) && /Rollback could not be confirmed/.test(refused) && !/was rolled back/.test(refused)
  && !('mtu' in mock.cfg.find(s => s.name === 'guest').values), 'the mock restores the config, but the page reports uncertainty without a rollback acknowledgement', refused);
mock.confirmFails = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [['set', 'lan', 'mtu', '1400']];
await refresh();
check(/1 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.getByRole('button', { name: "Discard this page's staged changes", exact: true }).click();
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), "Discard clears this page's staged changes");
//#endregion

//#region Mock: bridges in the board
console.log('\n== network-wide settings ==');
await page.locator('.nb-toolbar button:has-text("Network-wide settings")').click();
await page.waitForSelector('.fl-drawer.show');
await page.waitForTimeout(300);
const gl = card();
check(await drawerTitle() === 'Network-wide settings' && await input(gl, 'IPv6 ULA prefix').inputValue() === 'fd92:cdf9:fb3f::/48' && await input(gl, 'Packet steering').inputValue() === '2', 'the button opens the network-wide settings with the values of the globals section');
check(/0004abcd/.test(await gl.innerText()) && await gl.locator('.np-info input').count() === 0 && /custom_opt/.test(await gl.locator('.ne-extra').innerText()), 'the DHCP DUID and an option the page has no control for are shown read only');
await input(gl, 'IPv6 ULA prefix').fill('fc00::/48');
check(/IPv6 ULA prefix must be inside fd00::\/8/.test(await notes()) && await saveBtn().isDisabled() && await input(gl, 'IPv6 ULA prefix').evaluate(e => e.classList.contains('is-invalid')), 'a ULA prefix outside fd00::/8 is marked and blocks Save', await notes());
await input(gl, 'IPv6 ULA prefix').fill('fd11:2222:3333::/48');
check(/renumbers the local IPv6 addresses/.test(await notes()) && await errorCount() === 0, 'a valid new prefix only warns that it renumbers the local addresses', await notes());
await input(gl, 'IPv6 ULA prefix').fill('fd92:cdf9:fb3f::/48');
await input(gl, 'Packet steering').selectOption('1');
await box(gl, 'TCP sockets reachable across VRFs').click();
const glReview = await changes();
check(/Network-wide: Packet steering/.test(glReview) && /2 → 1|2.*1/.test(glReview) && /TCP sockets reachable across VRFs/.test(glReview), 'the review lists the changed options', glReview);
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving the network-wide settings works (no risk question)');
const glSaved = mock.cfg.find(s => s.type === 'globals').values;
check(glSaved.packet_steering === '1' && glSaved.tcp_l3mdev === '1' && glSaved.ula_prefix === 'fd92:cdf9:fb3f::/48' && glSaved.dhcp_default_duid === '0004abcd' && glSaved.custom_opt === 'x', 'the options were written and the ones the page does not edit were kept', JSON.stringify(glSaved));
check(await input(card(), 'Packet steering').inputValue() === '1' && await page.locator('.fl-drawer').count() === 1, 'the panel stays open with the saved values');
await page.keyboard.press('Escape');
console.log('\n== the old Bridges route and the bridge panel ==');
await page.evaluate(() => { location.hash = 'bridges'; });
await page.waitForFunction(() => location.hash === '#interfaces', null, { timeout: 5000 });
await page.waitForSelector('.nb-card');
check(await page.locator('.nav-pane a[href="#bridges"]').count() === 0 && await page.locator('.nav-pane a.active:has-text("Devices and Interfaces")').count() === 1, '#bridges opens the Devices and Interfaces page, which the navigation no longer lists separately');
await openDevice('br-lan');
const br = card();
check(/STP/.test(await deviceCardOf('br-lan').innerText()) && /\d+ ports?/.test(await deviceCardOf('br-lan').innerText()), 'the board card of a bridge shows its ports and spanning tree');
const portState = () => tickedPorts(br);
check(JSON.stringify(await portState()) === JSON.stringify(['lan1', 'lan2', 'lan3', 'lan4', 'lan5']), 'the ports of the bridge are ticked');
check(/Wi-Fi interfaces on this bridge/.test(await br.innerText()), 'the Wi-Fi interfaces of the bridge are explained, not listed as ports');
check(await box(br, 'Spanning tree').isChecked(), 'spanning tree is on, and it is an essential option');
check(await page.locator('.fl-drawer .np-live .bl').count() === 1, 'the live bridge information (members, spanning tree, learned MACs) is in the panel');
check(!(await br.locator('.ne-port strong').allInnerTexts()).some(n => n === 'eth0' || n === 'br-lan' || n === 'br-lan.100'), 'the CPU link, the bridge itself and a VLAN device on it are not offered as ports');
await shot('mock-bridges');

console.log('\n== moving a port between bridges ==');
await tap(portRow(br, 'lan5').locator('input'));
check(/Removing lan5 from br-lan, which carries the management network/.test(await notes()), 'taking a port out of the management bridge is flagged', await notes());
await addDevice('Bridge');
const gb = card();
await gb.locator('input[placeholder="br-guest"]').first().fill('br-guest');
await tap(portRow(gb, 'lan5').locator('input'));
check(JSON.stringify(await tickedPorts(gb)) === '["lan5"]', 'the new bridge takes lan5');
await tap(portRow(gb, 'lan1').locator('input'));
check(await portRow(gb, 'lan1').locator('.fl-badge:text-is("in br-lan")').count() === 0, 'ticking a port that is in another bridge takes it');
await openDevice('br-lan');
check(JSON.stringify(await portState()) === '["lan2","lan3","lan4"]', 'and moves it out of that one', JSON.stringify(await portState()));
check(await errorCount() === 0 && /br-guest/.test(await summaryText()), 'a port in one bridge only: no error', await notes());
check(await page.locator('.nb-lane-devices .nb-card.nb-new').count() === 1 && /2 ports/.test(await page.locator('.nb-lane-devices .nb-card.nb-new').innerText()) && /\d+ ports/.test(await deviceCardOf('br-lan').innerText()), 'the board follows: the new bridge is a card marked new with its ports');
await openDevice('br-guest');
await gb.locator('input[placeholder="another device, e.g. eth0.5"]').fill('ethX');
await tap(gb.locator('button:text-is("Add")'));
check(/ethX is not a device of the router/.test(await notes()) && await saveBtn().isDisabled(), 'a device that does not exist cannot be a port', await notes());
check(await page.locator('.nb-lane-devices .nb-card:has(.nb-name:text-is("ethX"))').count() === 1, 'the board shows it as a device the router does not describe');
await tap(portRow(gb, 'ethX').locator('input'));
check(await errorCount() === 0, 'unticking it clears the error', await notes());
await openDevice('br-lan');
await unfold();
await input(br, 'Query response interval \\(1/100 s\\)').fill('20000');
check(/query response interval \(20000\) must be below the query interval \(12500\)/.test(await notes()) && await saveBtn().isDisabled(), 'multicast timers are cross-checked', await notes());
await input(br, 'Query response interval \\(1/100 s\\)').fill('');
await box(br, 'VLAN filtering').click();
check(/Switching VLAN filtering on on br-lan/.test(await notes()), 'switching VLAN filtering on is flagged', await notes());
await shot('mock-bridge-edited');
await saveAndConfirm();
check(/^Saved/.test(await outcome()), 'the bridge changes are saved');
const lanDev = mock.cfg.find(s => s.name === 'cfg030f15').values, guestDev = mock.cfg.find(s => s.type === 'device' && s.values.name === 'br-guest');
check(lanDev.ports.join() === 'lan2,lan3,lan4' && lanDev.vlan_filtering === '1' && lanDev.stp === '1', 'br-lan lost lan1 and lan5, gained VLAN filtering, and kept the rest', JSON.stringify(lanDev));
check(guestDev?.values.type === 'bridge' && guestDev.values.ports.join() === 'lan5,lan1' && guestDev.anonymous, 'br-guest was added with its ports', JSON.stringify(guestDev));
check(await deviceCardOf('br-guest').count() === 1 && await page.locator('.nb-lane-devices .nb-card.nb-new').count() === 0, 'the new bridge is a saved card on the board');

console.log('\n== a login that may not write, a missing plugin method, an expired session ==');
const readOnlyAcls = { ubus: { system: ['board', 'info'], service: ['list'], 'flab.network': ['status', 'config'], 'flab.radio': ['status'], 'flab.mesh': ['status'], 'network.interface': ['dump'], session: ['access', 'destroy'], uci: ['get', 'changes'] } };
const ro = await open('interfaces', readOnlyAcls);
await ro.waitForSelector('.nb-card');
await ro.locator('.nb-lane-devices .nb-card:has(.nb-name:text-is("br-lan"))').click({ position: { x: 6, y: 6 } });
await ro.waitForSelector('.fl-drawer.show .ne-form input', { state: 'attached' });
await ro.waitForTimeout(300);
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('.nb-lane-devices .nb-menu-wrap > button').isDisabled() && await ro.locator('.nb-lane-interfaces .nb-lane-head button').isDisabled() && await ro.locator('.fl-drawer .ne-form input').first().isDisabled(), 'a login that may not write sees the controls disabled and the reason');
await ro.close();
const noPlug = await open('interfaces', { ubus: { system: ['board', 'info'], service: ['list'], 'flab.network': ['status'], 'flab.radio': ['status'], 'network.interface': ['dump'], session: ['access', 'destroy'] } });
await noPlug.waitForSelector('.nb-card');
check(/cannot be edited here/.test(await noPlug.locator('main').innerText()) && await noPlug.locator('.nb').count() === 1 && await noPlug.locator('.nb-lane-head button').count() === 0 && await noPlug.locator('.nb-toolbar').count() === 0, 'a login without the config call gets the board and a note, no editor');
await noPlug.locator('.nb-lane-interfaces .nb-card').first().click({ position: { x: 6, y: 6 } });
await noPlug.waitForSelector('.fl-drawer.show');
check(await noPlug.locator('.fl-drawer .ne-form').count() === 0 && /State/.test(await noPlug.locator('.fl-drawer').innerText()), 'its cards open a read-only summary of what the router reports');
await noPlug.close();
mock.noConfig = true;
await refresh();
check(/cannot be edited here/.test(await page.locator('main').innerText()) && await page.locator('.nb-lane-devices .nb-card').count() >= 1 && await page.locator('.fl-drawer').count() === 0, 'a router whose plugin lacks the config call still shows the board (an open editing panel closes)');
mock.noConfig = false;
mock.configIsStatus = true;
await refresh();
check(/cannot be edited here/.test(await page.locator('main').innerText()), 'a reply of another shape is not mistaken for the config');
mock.configIsStatus = false;
await refresh();

console.log('\n== theme ==');
await openIf('lan');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== edits survive a switch between the pages, and the session expires ==');
await openDevice('br-guest');
await unfold();
await input(card(), 'MAC aging time \\(s\\)').fill('600');
await page.evaluate(() => { location.hash = '#network'; });
await page.waitForSelector('.port-ic');
check(await page.locator('.fl-drawer').count() === 0, 'leaving the page closes the panel');
console.log('\n== Settings on an Ethernet port opens it in the board\'s drawer ==');
check(await page.locator('.port-table tr:has(.port-role:text-is("CPU link")) .port-settings').count() === 0 && await page.locator('.port-table .port-settings').count() >= 5, 'every front-panel port has a Settings button, the internal CPU link has none');
await page.locator('.port-table tr:has(strong:text-is("lan1")) .port-settings').click();
await page.waitForSelector('.fl-drawer.show');
check(await page.evaluate(() => location.hash) === '#interfaces' && /lan1/.test(await drawerTitle()) && await page.locator('.fl-drawer .ne-form').count() === 1, 'it goes to Devices and Interfaces with the port\'s own editing panel open', `${await page.evaluate(() => location.hash)} | ${await drawerTitle()}`);
check(await page.locator('.nb-card.nb-sel').count() === 1 && /lan1/.test(await page.locator('.nb-card.nb-sel').innerText()), 'and the port\'s card on the board is highlighted');
check((await page.locator('.fl-drawer .pl dt').allInnerTexts()).join() === 'Hardware,Role,MAC,Link,Negotiation,Throughput,Errors / drops,Bridge / STP,VLAN devices' && /Port details/.test(await page.locator('.fl-drawer').innerText()), 'the drawer also carries the details the Ethernet page had for the port: link, negotiation, hardware, throughput, errors, bridge and VLAN devices');
await page.evaluate(() => { document.querySelector('.fl-drawer .pl dl').dataset.mark = '1'; document.querySelector('.fl-drawer .ne-form').dataset.mark = '1'; });
await page.waitForFunction(() => !document.querySelector('.fl-drawer .pl dl')?.dataset.mark, null, { timeout: 8000 });
check(await page.locator('.fl-drawer .ne-form[data-mark="1"]').count() === 1, 'the details refresh by themselves while the form is open, and the form is not rebuilt');
await page.keyboard.press('Escape');
check(await page.locator('.fl-drawer').count() === 0, 'Escape closes it and the next visit does not reopen it');
await page.click('a[href="#interfaces"]');
await page.waitForSelector('.nb-card');
check(await bar().isVisible() && /1 unsaved change/.test(await summaryText()) && /br-guest: MAC aging time/.test(await changes()), 'unsaved edits are still pending when the page is opened again');
mock.expired = true;
// A poll may notice the expiry before the click lands; either way the sign-in screen must appear.
await saveBtn().click({ timeout: 5000 }).catch(() => {});
await page.waitForSelector('.login-form', { timeout: 30000 });
check(/Session expired/.test(await page.locator('.login-error').innerText()), 'an expired session returns to the sign-in screen');
//#endregion

check(mock.unsafe.length === 0, 'no uci write and no call the test does not mock reached the real router', mock.unsafe.join());
check(!mock.reads.some(r => r.startsWith('real:network')), 'the page never read the real network config with uci get', mock.reads.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall network editor browser checks passed');
process.exit(failed ? 1 : 0);
