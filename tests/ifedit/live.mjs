// Browser test for the Devices and Interfaces and Bridges editors. A real browser opens the deployed UI.
// 1. Against the real router, read only: both pages show the router's own interfaces, devices and bridges, and every uci write that
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
  S('globals', 'globals', { ula_prefix: 'fd92:cdf9:fb3f::/48' }),
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
  for (const s of mock.cfg) if (s.type !== 'interface' && s.type !== 'device') other[s.type] = (other[s.type] ?? 0) + 1;
  return { generated: Math.floor(Date.now() / 1000), interfaces: mock.cfg.filter(s => s.type === 'interface').map(options), devices: mock.cfg.filter(s => s.type === 'device').map(options), other, bridge_vlans: [] };
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
  if (method === 'changes') return [0, { changes: mock.staged.map(c => c.slice(0, 3)) }];
  if (method === 'set') { for (const [k, v] of Object.entries(args.values)) mock.staged.push(['set', args.section, k, v]); return [0, {}]; }
  if (method === 'add') {
    const name = args.name ?? `cfg${100 + nextId++}`;
    mock.staged.push(['add', name, args.type, { values: args.values ?? {}, anonymous: !args.name }]);
    return [0, { section: name }];
  }
  if (method === 'delete') { for (const o of args.options ?? [undefined]) mock.staged.push(['delete', args.section, o, undefined]); return [0, {}]; }
  if (method === 'revert') { mock.staged = []; return [0, {}]; }
  if (method === 'apply') {
    mock.applyArgs.push(args);
    mock.snapshot = clone(mock.cfg);
    mock.restage = mock.staged;
    if (!mock.dropWrites) commit();
    mock.staged = [];
    return [0, {}];
  }
  if (method === 'confirm') {
    if (mock.confirmFails) { restore(); return [1]; }
    mock.snapshot = null;
    return [0, {}];
  }
  if (method === 'rollback') {
    if (mock.snapshot) restore();
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

// Helpers: cards, fields, the banner and screenshots.
// The card of the interface or device called `name` (its header names it).
const card = name => page.locator('.ne-form .card').filter({ has: page.locator(`.card-header > span:text-is("${name}")`) });
// Unfolds a card and opens every group in it.
const unfold = async c => {
  if (await c.evaluate(e => e.classList.contains('fl-folded'))) await c.locator('.card-header').click();
  await c.locator('details').evaluateAll(ds => ds.forEach(d => { d.open = true; }));
};
// The form field labeled `label` within `scope`: a control, or a checkbox row.
const field = (scope, label) => scope.locator('.set-field, .set-check').filter({ has: page.locator('label', { hasText: new RegExp(`^\\s*${label}\\s*$`) }) }).first();
// The input of that field.
const input = (scope, label) => field(scope, label).locator('input, select').first();
// The checkbox row labeled `label` within `scope`.
const box = (scope, label) => scope.locator('label.set-check', { hasText: label }).first().locator('input');
// All the notes in the banner, joined into one string; and how many are errors.
const notes = () => page.locator('.set-notes .set-note').allInnerTexts().then(t => t.join(' | '));
const errorCount = () => page.locator('.set-notes .set-note.bad').count();
// The save bar, its summary and the save button.
const bar = () => page.locator('.set-bar');
const saveBtn = () => page.locator('button:has-text("Save and apply")');
const summaryText = () => page.locator('.set-bar-summary').innerText();
// The text of the review of pending changes.
const changes = async () => { if (await page.locator('.set-bar-details').isHidden()) await page.click('.set-bar button:has-text("Details")'); return page.locator('.set-changes').evaluate(e => e.textContent); };
// Saves a full-page screenshot named after `label`, when a screenshot folder is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `ifedit-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Waits for the save bar to report the result of a save and returns its text.
const outcome = async (timeout = 25000) => { const n = page.locator('.set-bar .set-outcome.ok, .set-bar .set-outcome.bad').first(); await n.waitFor({ timeout }); return (await n.innerText()).trim(); };
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
check(/br-lan/.test(await page.locator('.layers-table').innerText()), 'the runtime table of layers is still there');
const realIfCards = await page.locator('.ne-form .card').count();
check(realIfCards >= real.cfg.interfaces.length + real.cfg.devices.filter(d => d.values.type !== 'bridge').length, 'every interface and every device section that is not a bridge has a card', `${realIfCards} cards for ${real.cfg.interfaces.length} interfaces and ${real.cfg.devices.length} devices`);
check(await bar().isHidden() && await page.locator('button:has-text("Add interface")').isEnabled(), 'nothing is pending and the editor is enabled for this login');
const realPw = page.locator('.ne-form input[type=password]');
await page.locator('.ne-form .card').evaluateAll(cs => cs.forEach(c => { if (c.classList.contains('fl-folded')) c.querySelector('.card-header').click(); }));
await page.locator('.ne-form details').evaluateAll(ds => ds.forEach(d => { d.open = true; }));
check(await realPw.count() === real.cfg.interfaces.filter(s => s.values.proto === 'pppoe').length && await realPw.evaluateAll(els => els.every(e => e.value === '')), 'a PPPoE password box exists per PPPoE interface and is empty: the password is never shown');
check((await page.locator('main').innerHTML()).indexOf('REDACTED') < 0, 'nothing in the page is a redacted secret placeholder');
await shot('real-interfaces');
await page.goto(`${baseUrl}#bridges`);
await page.waitForSelector('.br-card');
check(await page.locator('.br-card').count() >= 1 && await page.locator('.ne-form .card').count() >= 1, 'the Bridges page shows the runtime cards and the configuration of each bridge');
const lanBridge = real.cfg.devices.find(d => d.values.type === 'bridge');
if (lanBridge) {
  const c = card(lanBridge.values.name);
  await unfold(c);
  const ticked = await c.locator('.ne-port input:checked').evaluateAll(els => els.map(e => e.closest('label').querySelector('strong').textContent));
  check(JSON.stringify(ticked.sort()) === JSON.stringify([...(lanBridge.values.ports ?? [])].sort()), 'the ports picker ticks the ports of the bridge\'s configuration', JSON.stringify(ticked));
  await shot('real-bridges');
}
check(mock.unsafe.length === 0 && !mock.reads.some(r => r.startsWith('real:network')), 'nothing was written, and the page never read the network config with uci get', `${mock.unsafe.join()} ${mock.reads.join()}`);
//#endregion

//#region Mock: the Devices and Interfaces page
mock.on = true;
// The firewall zones of the mock router are its own, so which interfaces count as the management network does not depend on the real router.
mock.statusEdit = s => { s.zones = [{ name: 'lan', networks: ['lan'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT', masq: false, forwards: ['wan'] }, { name: 'wan', networks: ['wan', 'wan6'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: true, forwards: [] }]; };
await page.goto(`${baseUrl}#interfaces`);
await page.reload();
await page.waitForSelector('.ne-form .card');
console.log('\n== reading (mock router) ==');
const names = await page.locator('.ne-form .card .card-header > span:nth-of-type(2)').allInnerTexts();
check(['loopback', 'lan', 'wan', 'wan6', 'lan100', 'xfrm0', 'wg0'].every(n => names.includes(n)), 'one card per logical interface', names.join());
check(names.includes('eth1.1036') && names.includes('br-lan.100') && !names.includes('br-lan'), 'the VLAN devices have cards here, the bridge does not (it is on the Bridges page)', names.join());
const lan = card('lan'), wan = card('wan'), wg = card('wg0');
await unfold(lan);
check(await input(lan, 'Protocol').inputValue() === 'static' && await input(lan, 'Device').inputValue() === 'br-lan', 'the protocol and device of lan', await input(lan, 'Protocol').inputValue());
check(await input(lan, 'IPv4 addresses').inputValue() === '192.168.1.1' && await input(lan, 'IPv4 netmask').inputValue() === '255.255.255.0', 'the address and netmask of lan');
check(await field(lan, 'IPv4 addresses').locator('.set-hint').count() === 1 && /netmask below/.test(await field(lan, 'IPv4 addresses').locator('.set-hint').innerText()), 'every option has a hint');
check(await field(lan, 'PAP/CHAP username').count() === 0 && await field(lan, 'Client identifier').count() === 0, 'options of other protocols are not shown');
await unfold(wan);
const pw = input(wan, 'PAP/CHAP password');
check(await pw.getAttribute('type') === 'password' && await pw.inputValue() === '' && /stored; leave empty/.test(await pw.getAttribute('placeholder')) && !(await page.locator('main').innerHTML()).includes(SECRET), 'the stored PPPoE password is not in the page: its box is empty, with a note that one is stored');
check(await input(wan, 'PAP/CHAP username').inputValue() === 'user1' && /odd_option/.test(await wan.locator('.ne-extra').innerText()), 'the options show their values, and one the page has no control for is listed read only');
await unfold(wg);
check(/does not edit its protocol/.test(await wg.innerText()) && await wg.locator('input, select').count() === 0 && !(await page.locator('main').innerHTML()).includes(SECRET2) && /private_key/.test(await wg.innerText()) && /hidden \(a secret\)/.test(await wg.innerText()), 'WireGuard is read only, and its private key is only said to be hidden');
check(await card('xfrm0').locator('input, select').count() === 0, 'the IPsec interface is read only');
check(await bar().isHidden(), 'the banner is hidden while nothing is edited');
check(!/(^|\s)null(\s|$)/.test(await page.locator('main').innerText()) && !/nullnull/.test(await page.locator('main').innerText()), 'no stray "null" text from an empty note');
check(!/already staged/.test(await page.locator('main').innerText()), 'no leftovers are announced');
await shot('mock-interfaces');

console.log('\n== validation ==');
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
const l100 = card('lan100');
await unfold(l100);
await input(l100, 'Protocol').selectOption('dhcp');
await unfold(l100);
check(await field(l100, 'IPv4 addresses').count() === 0 && await field(l100, 'Client identifier').count() === 1 && await field(l100, 'Host name to send').count() === 1, 'the static options give way to the DHCP client options');
await page.waitForTimeout(200);
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
const wan2 = card('wan');
await unfold(wan2);
await input(wan2, 'PAP/CHAP password').fill(TYPED);
check(/1 unsaved change/.test(await summaryText()), 'typing a password is a change');
const reviewPw = await changes();
check(/new value \(hidden\)/.test(reviewPw) && !reviewPw.includes(TYPED) && !reviewPw.includes(SECRET), 'the review shows it only as "new value (hidden)"', reviewPw);
check(/within 90 seconds/.test(await page.locator('.set-bar-details').innerText()), 'the review promises the 90 second rollback');
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'it is saved without a question (nothing risky)');
check(mock.cfg.find(s => s.name === 'wan').values.password === TYPED && mock.cfg.find(s => s.name === 'wan').values.odd_option === 'x', 'the password was stored and the other options kept');
check(await input(card('wan'), 'PAP/CHAP password').inputValue() === '' && !(await page.locator('main').innerHTML()).includes(TYPED), 'afterwards the box is empty again and the page does not hold the password');

console.log('\n== adding and removing interfaces ==');
await tap(page.locator('button:has-text("Add interface")'));
const fresh = page.locator('.ne-new').first();
check(await fresh.count() === 1 && /Not saved yet/.test(await fresh.innerText()), 'Add interface opens a new card');
const nameBox = fresh.locator('input[placeholder="guest"]');
await nameBox.fill('my-net');
check(/letters, digits and underscores/.test(await notes()) && await saveBtn().isDisabled(), 'a name with a dash is refused', await notes());
await nameBox.fill('lan');
check(/already a section called "lan"/.test(await notes()), 'so is a name that is taken', await notes());
await nameBox.fill('guest');
await input(fresh, 'Device').selectOption('br-lan.100');
await input(fresh, 'IPv4 addresses').fill('10.9.9.1/24');
check(await errorCount() === 0, 'a valid new interface has no errors', await notes());
await tap(page.locator('button:has-text("Add interface")'));
check(await page.locator('.ne-new').count() === 2, 'a second new card opens');
await tap(page.locator('.ne-new').nth(1).locator('button:has-text("Discard interface")'));
check(await page.locator('.ne-new').count() === 1, 'a new interface can be discarded');
await unfold(card('wan6'));
await tap(card('wan6').locator('button:has-text("Remove interface")'));
check(/to be removed/.test(await card('wan6').innerText()) && /is removed when you save/.test(await card('wan6').innerText()), 'Remove marks an interface (it is not gone until saved)');
await tap(card('wan6').locator('button:has-text("Undo")'));
check(!/to be removed/.test(await card('wan6').innerText()), 'Undo brings it back');
await tap(card('wan6').locator('button:has-text("Remove interface")'));
const review2 = await changes();
check(/Add interface guest/.test(review2) && /Remove interface wan6/.test(review2), 'the review lists the new and the removed interface', review2);
check(/removed|firewall zones, DHCP pools and routes that name it/.test(await notes()), 'removing an interface warns about what refers to it', await notes());
await saveBtn().click();
await page.waitForSelector('dialog.fl-dialog[open]', { timeout: 5000 });
check(/Removing the interface wan6/.test(await dialogText()) && mock.applyArgs.length === 2, 'removing an interface asks first, and nothing has been applied yet', await dialogText());
await page.click('dialog.fl-dialog button:has-text("Apply the change")');
check(/^Saved/.test(await outcome()), 'saving the new and the removed interface works');
const guest = mock.cfg.find(s => s.name === 'guest');
check(guest?.type === 'interface' && guest.values.proto === 'static' && guest.values.device === 'br-lan.100' && JSON.stringify(guest.values.ipaddr) === '["10.9.9.1/24"]' && !mock.cfg.some(s => s.name === 'wan6'), 'the new interface was added with its options and the removed one is gone', JSON.stringify(guest));
check(mock.cfg.some(s => s.name === 'voip_private') && mock.cfg.some(s => s.name === 'globals'), 'sections the page does not know were not touched');
check(await card('guest').count() === 1 && await card('wan6').count() === 0, 'the page lists the saved interfaces');
await shot('mock-added');

console.log('\n== VLAN devices and device settings ==');
await tap(page.locator('button:has-text("Add VLAN device")'));
const vl = page.locator('.ne-new').first();
await vl.locator('input[placeholder="eth1.200"]').fill('eth1.200');
check(/base device/.test(await notes()) && /VLAN ID/.test(await notes()), 'a VLAN device needs its base device and ID', await notes());
await input(vl, 'Base device').selectOption('eth1');
await input(vl, 'VLAN ID').fill('1036');
check(/already is VLAN 1036 on eth1|VLAN 1036 on eth1/.test(await notes()), 'the same VLAN twice on a device is refused', await notes());
await input(vl, 'VLAN ID').fill('200');
check(await errorCount() === 0, 'a valid VLAN device has no errors', await notes());
await tap(page.locator('button:has-text("Add device settings")'));
const ds = page.locator('.ne-new').nth(1);
await unfold(ds);
await ds.locator('input[placeholder="lan1"]').fill('lan1');
await input(ds, 'MTU').fill('1500');
await box(ds, 'Isolate port').click();
check(await errorCount() === 0 && /Add settings of device lan1/.test(await changes()), 'device settings for a port are accepted', await notes());
await saveBtn().click();
check(/^Saved/.test(await outcome()), 'saving the VLAN device and the device settings works');
const newDevs = mock.cfg.filter(s => s.type === 'device' && ['eth1.200', 'lan1'].includes(s.values.name));
check(newDevs.length === 2 && newDevs.find(s => s.values.name === 'eth1.200').values.type === '8021q' && newDevs.find(s => s.values.name === 'eth1.200').values.vid === '200' && newDevs.find(s => s.values.name === 'lan1').values.isolate === '1' && !('type' in newDevs.find(s => s.values.name === 'lan1').values) && newDevs.every(s => s.anonymous), 'both were added as anonymous device sections, the settings without a type', JSON.stringify(newDevs));
const vlan100 = card('br-lan.100');
await unfold(vlan100);
await tap(vlan100.locator('button:has-text("Remove device")'));
check(/lan100: the device br-lan\.100 it runs on is removed in this form/.test(await notes()) && await saveBtn().isDisabled(), 'a device that an interface runs on cannot be removed', await notes());
await tap(vlan100.locator('button:has-text("Undo")'));
check(await errorCount() === 0 && await bar().isHidden(), 'Undo clears the error');
await shot('mock-devices');

console.log('\n== a risky change asks first ==');
await unfold(card('lan'));
await input(card('lan'), 'IPv4 addresses').fill('192.168.7.1');
check(/can cut your connection/.test(await notes()) && /IPv4 addresses of lan, the network this page is most likely reached through/.test(await notes()), 'the banner warns about changing the address of lan', await notes());
mock.calls = [];
const appliedBefore = mock.applyArgs.length;
await saveBtn().click();
await page.waitForSelector('dialog.fl-dialog[open]');
const dlg = await dialogText();
check(/cut your connection/.test(dlg) && /restores the previous configuration by itself after 90 seconds/.test(dlg), 'the confirmation names the risk and the 90 second rollback', dlg);
await page.click('dialog.fl-dialog button:has-text("Cancel")');
await page.waitForTimeout(500);
check(mock.applyArgs.length === appliedBefore && !mock.calls.includes('uci.set') && await bar().isVisible() && await input(card('lan'), 'IPv4 addresses').inputValue() === '192.168.7.1', 'Cancel applies nothing and keeps the edit');
await saveAndConfirm();
check(/^Saved/.test(await outcome()) && mock.cfg.find(s => s.name === 'lan').values.ipaddr.join() === '192.168.7.1', 'confirming applies the change');

console.log('\n== a change the router does not keep ==');
mock.dropWrites = true;
await unfold(card('lan100'));
await input(card('lan100'), 'MTU').fill('1480');
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
await unfold(card('guest'));
await input(card('guest'), 'MTU').fill('1400');
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
await input(card('guest'), 'MTU').fill('1400');
mock.calls = [];
await saveBtn().click();
const refused = await outcome();
check(/did not accept the confirmation/.test(refused) && !('mtu' in mock.cfg.find(s => s.name === 'guest').values), 'a failed confirmation is reported and the change is not kept', refused);
mock.confirmFails = false;
await page.click('button:has-text("Discard edits")');
await page.waitForTimeout(600);

console.log('\n== leftovers from an earlier attempt ==');
mock.staged = [['set', 'lan', 'mtu', '1400']];
await refresh();
check(/1 change\(s\) are already staged/.test(await page.locator('main').innerText()), 'staged changes in the session are shown');
await page.click('button:has-text("Discard them")');
await page.waitForTimeout(700);
check(mock.staged.length === 0 && !/already staged/.test(await page.locator('main').innerText()), 'Discard them clears the session\'s staging area');
//#endregion

//#region Mock: the Bridges page
console.log('\n== the Bridges page ==');
await page.click('a[href="#bridges"]');
await page.waitForSelector('.br-card');
await page.waitForSelector('.ne-form .card');
const br = card('br-lan');
await unfold(br);
check(await page.locator('.br-card').count() >= 1 && await page.locator('.br-card tbody tr').count() >= 3, 'the runtime view (cards, members) is still there');
const portState = async () => br.locator('.ne-port input:checked').evaluateAll(els => els.map(e => e.closest('label').querySelector('strong').textContent));
check(JSON.stringify(await portState()) === JSON.stringify(['lan1', 'lan2', 'lan3', 'lan4', 'lan5']), 'the ports of the bridge are ticked');
check(/Wi-Fi interfaces on this bridge/.test(await br.innerText()), 'the Wi-Fi interfaces of the bridge are explained, not listed as ports');
check(await box(br, 'Spanning tree').isChecked(), 'spanning tree is on');
check(!(await br.locator('.ne-port strong').allInnerTexts()).some(n => n === 'eth0' || n === 'br-lan' || n === 'br-lan.100'), 'the CPU link, the bridge itself and a VLAN device on it are not offered as ports');
await shot('mock-bridges');

console.log('\n== moving a port between bridges ==');
await tap(br.locator('.ne-port:has(strong:text-is("lan5")) input'));
check(/Removing lan5 from br-lan, which carries the management network/.test(await notes()), 'taking a port out of the management bridge is flagged', await notes());
await tap(page.locator('.ne-addbar button:has-text("Add bridge")'));
const gb = page.locator('.ne-new').first();
await gb.locator('input[placeholder="br-guest"]').fill('br-guest');
await tap(gb.locator('.ne-port:has(strong:text-is("lan5")) input'));
check(JSON.stringify(await gb.locator('.ne-port input:checked').evaluateAll(els => els.map(e => e.closest('label').querySelector('strong').textContent))) === '["lan5"]', 'the new bridge takes lan5');
await tap(gb.locator('.ne-port:has(strong:text-is("lan1")) input'));
check(await gb.locator('.ne-port:has(strong:text-is("lan1")) .fl-badge:text-is("in br-lan")').count() === 0 && JSON.stringify(await br.locator('.ne-port input:checked').evaluateAll(els => els.map(e => e.closest('label').querySelector('strong').textContent))) === '["lan2","lan3","lan4"]', 'ticking a port that is in another bridge moves it out of that one', JSON.stringify(await portState()));
check(await errorCount() === 0 && /br-guest/.test(await summaryText()), 'a port in one bridge only: no error', await notes());
await gb.locator('input[placeholder="another device, e.g. eth0.5"]').fill('ethX');
await tap(gb.locator('button:has-text("Add")'));
check(/ethX is not a device of the router/.test(await notes()) && await saveBtn().isDisabled(), 'a device that does not exist cannot be a port', await notes());
await tap(gb.locator('.ne-port:has(strong:text-is("ethX")) input'));
check(await errorCount() === 0, 'unticking it clears the error', await notes());
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
check(await card('br-guest').count() === 1, 'the new bridge has a card');

console.log('\n== a login that may not write, a missing plugin method, an expired session ==');
const readOnlyAcls = { ubus: { system: ['board', 'info'], service: ['list'], 'flab.network': ['status', 'config'], 'flab.radio': ['status'], 'flab.mesh': ['status'], 'network.interface': ['dump'], session: ['access', 'destroy'], uci: ['get', 'changes'] } };
const ro = await open('bridges', readOnlyAcls);
await ro.waitForSelector('.ne-form .card');
check(/not allowed to change the configuration/.test(await ro.locator('main').innerText()) && await ro.locator('.ne-form button:has-text("Add bridge")').isDisabled() && await ro.locator('.ne-form input').first().isDisabled(), 'a login that may not write sees the controls disabled and the reason');
await ro.close();
const noPlug = await open('interfaces', { ubus: { system: ['board', 'info'], service: ['list'], 'flab.network': ['status'], 'flab.radio': ['status'], 'network.interface': ['dump'], session: ['access', 'destroy'] } });
check(/cannot be edited here/.test(await noPlug.locator('main').innerText()) && await noPlug.locator('.layers-table').count() === 1 && await noPlug.locator('.ne-form').count() === 0, 'a login without the config call gets the runtime view and a note, no editor');
await noPlug.close();
mock.noConfig = true;
await refresh();
check(/cannot be edited here/.test(await page.locator('main').innerText()) && await page.locator('.br-card').count() >= 1, 'a router whose plugin lacks the config call still shows the bridges');
mock.noConfig = false;
mock.configIsStatus = true;
await refresh();
check(/cannot be edited here/.test(await page.locator('main').innerText()), 'a reply of another shape is not mistaken for the config');
mock.configIsStatus = false;
await refresh();

console.log('\n== theme ==');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== edits survive a switch between the pages, and the session expires ==');
await unfold(card('br-guest'));
await input(card('br-guest'), 'MAC aging time \\(s\\)').fill('600');
await page.click('a[href="#interfaces"]');
await page.waitForSelector('.layers-table');
check(await bar().isVisible() && /1 unsaved change/.test(await summaryText()) && /br-guest: MAC aging time/.test(await changes()), 'unsaved edits are still pending on the other page');
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
