// Browser test of the side panels and the "New network" wizard of the Devices and Interfaces page. A real browser opens harness.html, a page that mounts the
// REAL panels (www/js/pages/interfaces/panels.js) in the REAL drawer over the REAL stylesheets, against a stateful mock of the router's network
// configuration (harness.mjs, fixture.mjs): the draft is the model's draft, Save turns it into the model's UCI operations, applies them to the mock and
// reads them back through the model's own check. The page is served by a tiny local web server; no request ever goes to a router, and the test fails if the
// page tries to reach /ubus or any other host.
// Usage: node live.mjs   (env: FLAB_ROOT the flab-ui folder, FLAB_SHOTS a folder for screenshots)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.FLAB_ROOT);
const shots = process.env.FLAB_SHOTS;
let failed = 0, passed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts them.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (cond) passed++; else failed++; };

//#region The local web server
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
// Serves the UI (www) and this suite's folder, nothing else.
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !(rel.startsWith('/www/') || rel.startsWith('/tests/netpanels/'))) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
//#endregion

const browser = await chromium.launch({ channel: 'msedge' });
const bctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
const errors = [], outside = [];
// Everything that is not the local server is refused; a call to a router's ubus fails the test.
await bctx.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(origin)) return route.continue();
  outside.push(url);
  return route.abort();
});
const page = await bctx.newPage();
page.on('pageerror', e => { errors.push(String(e)); console.log(`PAGE ERROR ${e}`); });
page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log(`CONSOLE ERROR ${m.text()}`); } });
await page.goto(`${origin}/tests/netpanels/harness.html`);
await page.waitForFunction(() => window.H?.ready, null, { timeout: 15000 });

//#region Helpers
const H = (fn, ...args) => page.evaluate(([name, a]) => window.H[name](...a), [fn, args]);
const drawer = page.locator('aside.fl-drawer');
const body = drawer.locator('.fl-drawer-body');
const dialog = page.locator('dialog.fl-dialog[open]');
// A section of the panel by its heading.
const sec = title => body.locator('.np-sec').filter({ has: page.locator('.np-h', { hasText: title }) });
// A field of `scope` by its label: a control with its own label, or a checkbox row whose text starts with the label.
const field = (scope, label) => scope.locator('.set-field').filter({ has: page.locator('label', { hasText: new RegExp(`^\\s*${label.replace(/[()]/g, '\\$&')}\\s*$`) }) })
  .or(scope.locator('label.set-check', { hasText: label })).first();
// The input of that field.
const input = (scope, label) => field(scope, label).locator('input, select').first();
// The strong name of an option row of a device chooser, as an exact filter.
const nameOf = n => page.locator('strong', { hasText: new RegExp(`^${n.replace(/[.@]/g, '\\$&')}$`) });
// The text of the review.
const reviewText = () => page.locator('#review').innerText();
// Gives a redraw a moment.
const settle = () => page.waitForTimeout(150);
// Opens a panel and waits for it.
const openIface = async id => { await H('openInterface', id); await drawer.waitFor(); await settle(); };
const openDev = async ref => { await H('openDevice', ref); await drawer.waitFor(); await settle(); };
// Saves a screenshot of the page when a folder is set.
const shot = async label => { if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, `np-${label.replace(/\W+/g, '-')}.png`) }); } };
// The widest the content of the panel gets beyond its own box (should be 0): nothing may overflow sideways.
const overflow = () => body.evaluate(el => {
  const box = el.getBoundingClientRect();
  let over = Math.max(0, el.scrollWidth - el.clientWidth);
  for (const c of el.querySelectorAll('*')) { const r = c.getBoundingClientRect(); if (r.width && r.right > box.right + 1) over = Math.max(over, Math.round(r.right - box.right)); }
  return over;
});
// Whether every control of the open panel is disabled.
const allDisabled = () => page.evaluate(() => [...document.querySelectorAll('aside.fl-drawer input, aside.fl-drawer select, aside.fl-drawer textarea, aside.fl-drawer .np-proto, aside.fl-drawer .np-remove')].every(e => e.disabled));
//#endregion

console.log('== interface panel: lan (static) ==');
await openIface('lan');
check(await drawer.locator('.fl-drawer-title').innerText() === 'lan' && /Static address/.test(await drawer.locator('.fl-drawer-sub').innerText()), 'the header names the interface and its protocol');
check((await body.locator('.np-sec .np-h').allInnerTexts()).map(t => t.replace(/^\d\s*/, '')).join('|') === 'Connects through|Protocol|Settings|Used by', 'the sections are: connects through, protocol, settings, used by', (await body.locator('.np-sec .np-h').allInnerTexts()).join('|'));
check(/logical network/.test(await sec('Connects through').innerText()) && /device section is optional/.test(await sec('Connects through').innerText()), 'the lead explains devices and interfaces in the documentation\'s words');
check(await body.locator('input[name="np-dev-lan"]:checked').getAttribute('value') === 'br-lan', 'the device chooser has the interface\'s device selected');
check(await body.locator('.np-proto').count() === 5 && await body.locator('.np-proto[aria-checked=true]').getAttribute('data-proto') === 'static', 'five protocol cards, the current one selected');
const settings = sec('Settings');
check(await field(settings, 'IPv4 addresses').isVisible() && await field(settings, 'IPv4 gateway').isVisible() && await field(settings, 'DNS servers').isVisible(), 'the essential options of a static interface are shown');
check(!await input(settings, 'IPv4 netmask').isVisible() && !await input(settings, 'MTU').isVisible(), 'the other options are folded under Advanced');
check(/\d+ set/.test(await settings.locator('details.np-adv > summary').innerText()), 'Advanced says how many of its options hold a value');
await settings.locator('details.np-adv > summary').click();
check(await input(settings, 'IPv4 netmask').inputValue() === '255.255.255.0' && await input(settings, 'Delegate a prefix of length').inputValue() === '60', 'Advanced holds the netmask and the prefix delegation');
const uses = sec('Used by');
check(/lan/.test(await uses.locator('.fl-badge').first().innerText()) && /input accept/.test(await uses.innerText()) && /DHCPv4 pool \.100–\.249 · 12h/.test(await uses.innerText()), 'used by: the firewall zone with its policy and the DHCP pool');
check(await uses.locator('a[href="#firewall"]').count() === 1 && await uses.locator('a[href="#dhcp"]').count() === 1 && await uses.locator('a[href="#routing"]').count() === 1, 'used by links to the Firewall, DHCP and Routing pages');
check(await drawer.locator('.fl-drawer-foot button', { hasText: 'Remove interface' }).isEnabled(), 'the footer has Remove interface');
check(/^\s*$/.test(await page.locator('#review .set-bar-summary').innerText()) === false && /No unsaved changes/.test(await reviewText()), 'opening a panel changes nothing');
await shot('lan-panel');

console.log('\n== changing the protocol ==');
const dhcpCard = body.locator('.np-proto[data-proto=dhcp]');
check(/Switching drops: .*IPv4 addresses/.test(await dhcpCard.innerText()), 'a protocol card says what switching to it drops, before the click');
await dhcpCard.click(); await settle();
check((await H('draft')).ifaces.lan.proto === 'dhcp', 'a click on a protocol card changes the protocol in the draft');
check(await field(sec('Settings'), 'IPv4 addresses').count() === 0 && await field(sec('Settings'), 'Use the provider\'s DNS servers').isVisible(), 'the settings follow the protocol');
check(/Changed from Static address: saving removes IPv4 addresses, IPv4 netmask/.test(await sec('Protocol').innerText()), 'the panel says what the save removes');
const ops = await H('ops');
check(JSON.stringify(ops.find(o => o.op === 'delete' && o.section === 'lan')?.options.sort()) === JSON.stringify(['ipaddr', 'netmask']) && /options of static/.test(await reviewText()), 'the plan deletes the old protocol\'s options and the review says so', JSON.stringify(ops));
await body.locator('.np-proto[data-proto=static]').click(); await settle();
check(!await H('dirty') && !/Changed from/.test(await sec('Protocol').innerText()), 'switching back leaves nothing to save');

console.log('\n== the device chooser ==');
await body.locator('input[name="np-dev-lan"][value="lan5"]').check(); await settle();
check((await H('draft')).ifaces.lan.device === 'lan5' && (await H('risks')).some(r => /can cut your connection/.test(r)), 'choosing another device for the management network changes the draft and warns');
check(/Port of br-lan/.test(await body.locator('.np-opt', { has: nameOf('lan1') }).innerText()), 'a port of a bridge is flagged as one');
check(/no link/.test(await body.locator('.np-opt', { has: nameOf('lan5') }).innerText()), 'the chooser says what a device is (link state)');
check(await body.locator('.np-opt', { has: nameOf('@wan') }).count() === 1, 'the device of another interface is offered as @name');
await H('reset');
await openIface('lan100');
check(/Used by: lan/.test(await body.locator('.np-opt', { has: nameOf('br-lan') }).innerText()), 'the chooser says which interface already uses a device');

console.log('\n== PPPoE: the write-only password ==');
await H('reset');
await openIface('wan');
const wset = sec('Settings');
const pw = input(wset, 'PAP/CHAP password');
check(await pw.getAttribute('type') === 'password' && await pw.inputValue() === '' && /stored; leave empty/.test(await pw.getAttribute('placeholder')), 'the password box is masked and empty, and says one is stored');
check(await field(wset, 'PAP/CHAP username').isVisible() && !await input(wset, 'Access concentrator').isVisible(), 'only the login is essential; the rest of the PPPoE options are advanced');
check(/pppoe-wan/.test(await body.innerText()), 'the panel names the device the protocol creates');
check(/wan6, xfrm0|wan6/.test(await sec('Used by').innerText()) && /borrows its device/.test(await sec('Used by').innerText()) && /runs over it/.test(await sec('Used by').innerText()), 'used by lists the interfaces that ride on it');
check(/wan6 depends on this interface/.test(await drawer.locator('.fl-drawer-foot').innerText()), 'the footer warns that another interface depends on it');
await pw.fill('Sup3rSecret!'); await settle();
const typed = JSON.stringify(await H('changes'));
check(/new value \(hidden\)/.test(typed) && !typed.includes('Sup3rSecret') && !(await reviewText()).includes('Sup3rSecret'), 'the review hides the typed password');
check((await H('ops')).some(o => o.op === 'set' && o.section === 'wan' && o.values.password === 'Sup3rSecret!'), 'the plan sets the password');
const saved = await H('save');
check(saved.ok, 'saving reads back what was asked for', saved.error);
await settle();
check(await input(sec('Settings'), 'PAP/CHAP password').inputValue() === '' && !(await page.content()).includes('Sup3rSecret') && (await H('reply')).interfaces.find(s => s.section === 'wan').secrets.password === true, 'after the save the box is empty again and the page never holds the password');
await body.locator('.np-proto[data-proto=pppoe]').waitFor();
await drawer.locator('.fl-drawer-foot button', { hasText: 'Remove interface' }).click(); await settle();
check(/removed when you save/.test(await body.innerText()) && (await H('problems')).errors.some(e => /wan6: the interface wan it borrows its device from is removed/.test(e.text)) && await page.locator('#save').isDisabled(), 'removing it shows the removed notice, and the model refuses to save it while wan6 borrows its device');
await body.locator('button', { hasText: 'Undo' }).click(); await settle();
check(!await H('dirty'), 'Undo takes the removal back');
await shot('wan-panel');

console.log('\n== interfaces this page does not edit ==');
await openIface('wg0');
check(await body.locator('input, select, textarea').count() === 0 && /does not edit this protocol/.test(await body.innerText()) && await body.locator('a[href="#wireguard"]').count() === 1, 'WireGuard is read only, with a link to its page');
check(/private_key/.test(await body.innerText()) && /hidden \(a secret\)/.test(await body.innerText()) && await drawer.locator('.fl-drawer-foot button').count() === 0, 'its key is only said to be hidden and it cannot be removed here');
await openIface('xfrm0');
check(await body.locator('a[href="#ipsec"]').count() === 1 && await body.locator('input, select').count() === 0, 'IPsec is read only, with a link to its page');

console.log('\n== a bridge ==');
await openDev({ name: 'br-lan' });
check(await drawer.locator('.fl-drawer-title').innerText() === 'br-lan' && /Bridge device · up/.test(await drawer.locator('.fl-drawer-sub').innerText()), 'the bridge panel is named and says it is a bridge device');
const ticked = await body.locator('.ne-port input:checked').evaluateAll(els => els.map(e => e.closest('label').querySelector('strong').textContent).sort());
check(JSON.stringify(ticked) === JSON.stringify(['lan1', 'lan2', 'lan3', 'lan4']), 'the ports picker ticks the bridge\'s ports', ticked.join());
await body.locator('.ne-port', { hasText: 'lan5' }).locator('input').check(); await settle();
check(JSON.stringify((await H('draft')).devices.cfg030f15.ports) === JSON.stringify(['lan1', 'lan2', 'lan3', 'lan4', 'lan5']) && /ports/i.test(await reviewText()), 'ticking a port adds it to the draft');
await body.locator('.ne-port', { hasText: 'lan5' }).locator('input').uncheck(); await settle();
check(!await H('dirty'), 'unticking it takes it back');
await page.waitForSelector('.np-live .bl', { timeout: 5000 }).then(() => check(true, 'the live bridge information (members, STP, MACs) is in the panel'), () => check(false, 'the live bridge information is in the panel'));
const bset = sec('Settings');
check(await field(bset, 'Spanning tree (STP)').isVisible() && await field(bset, 'VLAN filtering').isVisible() && await field(bset, 'IGMP snooping').isVisible() && await field(bset, 'MTU').isVisible() && await field(bset, 'MAC address').isVisible(), 'STP, VLAN filtering, multicast, MTU and MAC are essential');
check(!await input(bset, 'Forward delay (s)').isVisible(), 'the timers are advanced');
await field(bset, 'VLAN filtering').locator('input').check(); await settle();
check((await reviewText()).includes('Switching VLAN filtering on'), 'switching VLAN filtering on warns that it can cut the connection');
await H('reset'); await openDev({ name: 'br-lan' });
check(/lan, br-lan\.100 run on this device/.test(await drawer.locator('.fl-drawer-foot').innerText()), 'the footer names what runs on the bridge');
await drawer.locator('.fl-drawer-foot button', { hasText: 'Remove bridge' }).click(); await settle();
check((await H('problems')).errors.some(e => /lan: the device br-lan it runs on is removed/.test(e.text)) && await page.locator('#save').isDisabled(), 'removing a bridge an interface runs on blocks the save');
await H('reset'); await openDev({ name: 'br-lan' });
await shot('bridge-panel');

console.log('\n== a VLAN device ==');
await openDev({ name: 'br-lan.100' });
const tag = sec('VLAN tag');
check(await input(tag, 'Base device').inputValue() === 'br-lan' && await input(tag, 'VLAN ID').inputValue() === '100' && /802\.1Q/.test(await tag.innerText()), 'the VLAN panel shows the base device, the ID and the type');
check(await field(sec('Settings'), 'MTU').isVisible() && await field(sec('Settings'), 'MAC address').isVisible(), 'MTU and MAC are the VLAN device\'s settings');
await H('reset');
const vid = await H('addDevice', '8021q'); await settle();
const vtag = sec('VLAN tag');
await input(vtag, 'Base device').selectOption('eth1'); await settle();
await input(vtag, 'VLAN ID').fill('200'); await settle();
const nameBox = body.locator('input[placeholder="eth1.200"]').first();
check(await nameBox.inputValue() === 'eth1.200' && (await H('draft')).devices[vid].vid === '200', 'the name follows the base device and the ID');
await body.locator('select').filter({ has: page.locator('option[value="8021ad"]') }).selectOption('8021ad'); await settle();
check((await H('ops')).some(o => o.op === 'add' && o.values.type === '8021ad'), 'the type can be 802.1ad');
await input(sec('VLAN tag'), 'VLAN ID').fill('5000'); await settle();
check((await H('problems')).errors.some(e => /VLAN ID/.test(e.text)) && await page.locator('#save').isDisabled() && await input(sec('VLAN tag'), 'VLAN ID').evaluate(e => e.classList.contains('is-invalid')), 'a bad VLAN ID is marked and blocks the save');
await input(sec('VLAN tag'), 'VLAN ID').fill('200'); await settle();
const vsave = await H('save');
check(vsave.ok && (await H('reply')).devices.some(s => s.values.name === 'eth1.200' && s.values.type === '8021ad' && s.values.vid === '200' && s.values.ifname === 'eth1'), 'a new VLAN device is saved and read back', vsave.error);

console.log('\n== a port ==');
await H('reset');
await openDev({ name: 'lan5' });
check(await drawer.locator('.fl-drawer-title').innerText() === 'lan5' && /no link/.test(await body.innerText()) && /which is normal/.test(await body.innerText()), 'a port without a device section shows its link and says that having none is normal');
await body.locator('button', { hasText: 'Add settings for this device' }).click(); await settle();
const portSet = sec('Settings');
check((await H('draft')).devices && /Add settings of device lan5/.test(await reviewText()) && await field(portSet, 'Speed (Mbit/s)').isVisible() && await field(portSet, 'Auto-negotiation').isVisible() && await field(portSet, 'Energy-Efficient Ethernet').isVisible(), 'adding settings gives the link options (speed, auto-negotiation, pause, EEE)');
await input(portSet, 'MTU').fill('1400'); await settle();
const portSave = await H('save');
check(portSave.ok && portSave.ops.some(o => o.op === 'add' && o.type === 'device' && o.values.name === 'lan5' && o.values.mtu === '1400') && (await H('reply')).devices.some(s => s.values.name === 'lan5' && s.values.mtu === '1400'), 'the port settings are saved without a type', portSave.error);
await openDev({ name: 'lan1' });
check(/Port of/.test(await body.innerText()) && /br-lan/.test(await sec('Used by').innerText()), 'a bridge port says which bridge it is in');
await openDev({ name: 'eth1' });
check(/up, 2\.5 Gbit\/s/.test(await body.innerText()) && /eth1\.1036/.test(await sec('Used by').innerText()), 'a port with a link shows its speed and the VLAN device on it');

console.log('\n== network-wide settings ==');
await H('reset');
await H('openGlobals'); await settle();
check(await drawer.locator('.fl-drawer-title').innerText() === 'Network-wide settings' && await input(body, 'IPv6 ULA prefix').inputValue() === 'fd92:cdf9:fb3f::/48' && await input(body, 'Packet steering').inputValue() === '2', 'the globals panel shows the options of the globals section');
check(await field(body, 'netifd log level').isVisible() && await field(body, 'TCP sockets reachable across VRFs').isVisible() && /0004abcd/.test(await body.innerText()) && /custom_opt/.test(await body.innerText()), 'it lists every option, the DHCP DUID and the options without a control read only');
await input(body, 'IPv6 ULA prefix').fill('fc00::/48'); await settle();
check((await H('problems')).errors.some(e => e.key === 'gl:ula_prefix') && await page.locator('#save').isDisabled() && await input(body, 'IPv6 ULA prefix').evaluate(e => e.classList.contains('is-invalid')), 'a bad ULA prefix is marked and blocks the save');
await input(body, 'IPv6 ULA prefix').fill('auto');
await input(body, 'Packet steering').selectOption('1'); await settle();
const gsave = await H('save');
check(gsave.ok && JSON.stringify(gsave.ops) === JSON.stringify([{ op: 'set', config: 'network', section: 'globals', values: { ula_prefix: 'auto', packet_steering: '1' } }]) && (await H('reply')).globals.values.ula_prefix === 'auto' && (await H('reply')).globals.values.dhcp_default_duid === '0004abcd', 'saving writes only the changed options and keeps the rest', gsave.error);
await H('reset');
await H('tweak', 'd.cfg.globals = undefined;');
await H('openGlobals'); await settle();
check(await body.locator('input, select').count() === 0 && /does not report the globals section/.test(await body.innerText()), 'a router whose plugin does not report the section gets a description and no controls');

console.log('\n== a login that may not write ==');
await H('setCanEdit', false);
await openIface('lan');
check(await allDisabled(), 'every control of an interface panel is disabled');
await openDev({ name: 'br-lan' });
check(await allDisabled(), 'every control of a bridge panel is disabled');
await H('openWizard'); await page.waitForTimeout(300);
check(/not allowed to change the configuration/.test(await dialog.innerText()), 'the wizard says so instead of opening');
await dialog.locator('button', { hasText: 'Close' }).click();
await H('setCanEdit', true);

console.log('\n== the wizard: a new bridge with a static network ==');
await H('reset');
await H('openWizard'); await dialog.waitFor();
check(await H('wizardOpen') && await dialog.locator('.np-steps li').count() === 3 && await dialog.locator('.np-proto').count() === 3, 'the wizard opens on step 1 with its three steps and three ways to connect');
check(/logical network/.test(await dialog.innerText()), 'step 1 explains the interface in the documentation\'s words');
await dialog.locator('[data-where=bridge]').click(); await settle();
const bname = dialog.locator('input[placeholder="br-guest"]');
check(await bname.inputValue() === 'br-new', 'a free bridge name is suggested');
await bname.fill('br-guest');
await dialog.locator('.ne-port', { hasText: 'lan5' }).locator('input').check(); await settle();
check(await dialog.locator('button', { hasText: 'Next' }).isEnabled(), 'step 1 is complete');
await shot('wizard-1');
await dialog.locator('button', { hasText: 'Next' }).click(); await settle();
check(await dialog.locator('.np-proto[aria-checked=true]').getAttribute('data-proto') === 'static', 'step 2 offers the protocol cards, static selected');
await shot('wizard-2');
await dialog.locator('button', { hasText: 'Next' }).click(); await settle();
check(await dialog.locator('input[placeholder="guest"]').inputValue() === 'guest' && await dialog.locator('input[placeholder="192.168.10.1/24"]').inputValue() === '192.168.10.1/24', 'step 3 suggests a name and a free /24');
check(/A new bridge br-guest with the ports lan5/.test(await dialog.innerText()) && /interface guest on br-guest with a static address 192\.168\.10\.1\/24/.test(await dialog.innerText()), 'step 3 summarizes what Finish adds');
check(!await H('dirty'), 'the draft is untouched until Finish');
await shot('wizard-3');
await dialog.locator('button', { hasText: 'Finish' }).click(); await settle();
check(await H('dirty') && /Nothing is saved yet/.test(await dialog.innerText()), 'Finish adds to the draft and says nothing is saved');
check(await dialog.locator('a[href="#firewall"]').count() === 1 && await dialog.locator('a[href="#dhcp"]').count() === 1 && /What this did not do/.test(await dialog.innerText()), 'the last page lists what the flow does not do, with links to the Firewall and DHCP pages');
await shot('wizard-4');
await dialog.locator('button', { hasText: 'Close' }).click(); await settle();
const done = await H('done');
check(done?.iface && done?.device && !await H('wizardOpen'), 'onDone got the ids of the interface and the device, and the wizard is closed', JSON.stringify(done));
check(await drawer.locator('.fl-drawer-title').innerText() === 'guest', 'the board can open the new interface\'s panel');
const wsave = await H('save');
check(wsave.ok, 'the draft saves and reads back', wsave.error);
const added = wsave.ok ? wsave.ops.filter(o => o.op === 'add') : [];
check(JSON.stringify(added[0]?.values) === JSON.stringify({ name: 'br-guest', type: 'bridge', ports: ['lan5'] }) && added[1]?.name === 'guest' && added[1]?.values.device === 'br-guest' && JSON.stringify(added[1]?.values.ipaddr) === JSON.stringify(['192.168.10.1/24']) && added[1]?.values.proto === 'static', 'the plan adds the bridge, then the interface on it', JSON.stringify(added));

console.log('\n== the wizard: validation ==');
await H('reset');
await H('openWizard'); await dialog.waitFor();
await dialog.locator('[data-where=bridge]').click(); await settle();
await dialog.locator('input[placeholder="br-guest"]').fill('br-lan'); await settle();
check(await dialog.locator('button', { hasText: 'Next' }).isDisabled() && /already a device called "br-lan"/.test(await dialog.locator('.np-problems').innerText()), 'a taken bridge name blocks Next and says why');
await dialog.locator('input[placeholder="br-guest"]').fill('br-iot'); await settle();
check(await dialog.locator('button', { hasText: 'Next' }).isEnabled() && /no ports/.test(await dialog.locator('.np-problems').innerText()), 'a bridge without ports is allowed, with a warning');
await dialog.locator('button', { hasText: 'Next' }).click(); await dialog.locator('button', { hasText: 'Next' }).click(); await settle();
const nm = dialog.locator('input[placeholder="guest"]');
await nm.fill('lan'); await settle();
check(await dialog.locator('button', { hasText: 'Finish' }).isDisabled() && /already a section called "lan"/.test(await dialog.locator('.np-problems').innerText()) && await nm.evaluate(e => e.classList.contains('is-invalid')), 'a taken interface name blocks Finish, is said and is marked');
await nm.fill('iot');
const addr = dialog.locator('input[placeholder="192.168.10.1/24"]');
await addr.fill('192.168.1.5/24'); await settle();
check(await dialog.locator('button', { hasText: 'Finish' }).isDisabled() && /same subnet/.test(await dialog.locator('.np-problems').innerText()), 'an address on the subnet of another interface blocks Finish');
await addr.fill('nonsense'); await settle();
check(await dialog.locator('button', { hasText: 'Finish' }).isDisabled() && await addr.evaluate(e => e.classList.contains('is-invalid')), 'a bad address blocks Finish');
await addr.fill(''); await settle();
check(await dialog.locator('button', { hasText: 'Finish' }).isDisabled(), 'a static network without an address blocks Finish');
await dialog.locator('button', { hasText: 'Use the suggestion' }).click(); await settle();
check(await addr.inputValue() === '192.168.10.1/24' && await dialog.locator('button', { hasText: 'Finish' }).isEnabled(), 'the suggestion fills the address and Finish is allowed');
await dialog.locator('button', { hasText: 'Cancel' }).click(); await settle();
check(!await H('dirty') && !await H('wizardOpen'), 'Cancel leaves the draft as it was');

console.log('\n== the wizard: a new VLAN device with PPPoE ==');
await H('reset');
await H('openWizard'); await dialog.waitFor();
await dialog.locator('[data-where=vlan]').click(); await settle();
check(await dialog.locator('button', { hasText: 'Next' }).isDisabled(), 'without a base device Next is blocked');
await dialog.locator('.np-opt', { has: page.locator('strong', { hasText: /^eth1$/ }) }).click(); await settle();
check(await dialog.locator('input[placeholder="1 to 4094"]').inputValue() === '10' && await dialog.locator('input[placeholder="eth1.200"]').inputValue() === 'eth1.10', 'the base device suggests a free ID and the name');
await dialog.locator('input[placeholder="1 to 4094"]').fill('1036'); await settle();
check(await dialog.locator('button', { hasText: 'Next' }).isDisabled() && /already is VLAN 1036 on eth1/.test(await dialog.locator('.np-problems').innerText()), 'a VLAN that exists blocks Next');
await dialog.locator('input[placeholder="1 to 4094"]').fill('300'); await settle();
check(await dialog.locator('input[placeholder="eth1.200"]').inputValue() === 'eth1.300' && await dialog.locator('button', { hasText: 'Next' }).isEnabled(), 'the name follows the ID');
await dialog.locator('button', { hasText: 'Next' }).click(); await settle();
await dialog.locator('.np-proto[data-proto=pppoe]').click(); await settle();
await dialog.locator('button', { hasText: 'Next' }).click(); await settle();
check(await dialog.locator('input[placeholder="guest"]').inputValue() === 'vlan300', 'the name is suggested from the VLAN');
const ppw = dialog.locator('input[type=password]');
check(await ppw.count() === 1 && await field(dialog, 'PAP/CHAP username').isVisible(), 'step 3 asks for the PPPoE login, the password masked');
await field(dialog, 'PAP/CHAP username').locator('input').fill('me@isp');
await ppw.fill('wizard-secret-77'); await settle();
check(!(await dialog.innerText()).includes('wizard-secret-77'), 'the password is not written anywhere on the page');
await dialog.locator('button', { hasText: 'Finish' }).click(); await settle();
await dialog.locator('button', { hasText: 'Close' }).click(); await settle();
const typedChanges = JSON.stringify(await H('changes'));
check(!typedChanges.includes('wizard-secret-77') && !(await page.locator('body').innerText()).includes('wizard-secret-77'), 'the review and the page do not show the password');
const psave = await H('save');
const wiz = await H('reply');
check(psave.ok && wiz.interfaces.find(s => s.section === 'vlan300')?.secrets.password === true && wiz.interfaces.find(s => s.section === 'vlan300')?.values.username === 'me@isp' && wiz.devices.some(s => s.values.name === 'eth1.300'), 'the new VLAN device and PPPoE interface are saved; the password is stored and reported only as set', psave.error);

console.log('\n== the wizard: an existing device with DHCP ==');
await H('reset');
await H('openWizard'); await dialog.waitFor();
check(await dialog.locator('input[name="np-w-dev"]').count() >= 1 && !await dialog.locator('.np-opt', { has: page.locator('strong', { hasText: /^br-lan$/ }) }).count(), 'only devices without an interface are offered');
await dialog.locator('.np-opt', { has: page.locator('strong', { hasText: /^lan5$/ }) }).click(); await settle();
await dialog.locator('button', { hasText: 'Next' }).click(); await dialog.locator('.np-proto[data-proto=dhcp]').click(); await dialog.locator('button', { hasText: 'Next' }).click(); await settle();
check(await field(dialog, 'Address of the router, with prefix length').count() === 0 && /Nothing else to fill in/.test(await dialog.innerText()), 'a DHCP client asks for nothing more');
await dialog.locator('button', { hasText: 'Finish' }).click(); await settle();
await dialog.locator('button', { hasText: 'Close' }).click(); await settle();
const dsave = await H('save');
const dop = dsave.ok ? dsave.ops.find(o => o.op === 'add' && o.type === 'interface') : null;
check(dsave.ok && dop?.values.proto === 'dhcp' && dop?.values.device === 'lan5' && !('ipaddr' in dop.values), 'the plan adds a DHCP interface on lan5 without addresses', JSON.stringify(dsave));

console.log('\n== wrapping ==');
await H('reset');
const LONG6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334', LONGNAME = 'a_very_long_interface_name_that_cannot_be_broken_anywhere_at_all';
await H('tweak', `
  const i = d.cfg.interfaces.find(s => s.name === 'lan');
  i.values.dns = ['${LONG6}', '${LONG6.replace('2001', '2002')}', '9.9.9.9'];
  d.ifs.find(x => x.interface === 'lan')['ipv6-address'] = [{ address: '${LONG6}', mask: 64 }, { address: 'fd92:cdf9:fb3f:0:1111:2222:3333:4444', mask: 128 }];
  d.ifs.find(x => x.interface === 'lan')['dns-server'] = ['${LONG6}', '${LONG6.replace('2001', '2003')}'];
  d.cfg.interfaces.push({ section: '${LONGNAME}', name: '${LONGNAME}', anonymous: false, values: { proto: 'static', device: 'br-lan', ipaddr: ['10.5.5.1/24'] }, secrets: {} });
`);
for (const width of [1920, 1280, 900, 480]) {
  await page.setViewportSize({ width, height: 900 });
  await openIface('lan');
  const over = await overflow();
  check(over === 0, `no horizontal overflow in the interface panel at ${width} px`, `${over}px`);
  await openIface(LONGNAME);
  check(await overflow() === 0, `a very long interface name wraps at ${width} px`, `${await overflow()}px`);
  await openDev({ name: 'br-lan' });
  check(await overflow() === 0, `no horizontal overflow in the bridge panel at ${width} px`, `${await overflow()}px`);
  if (width === 1280) { await openIface('lan'); await shot('wrap-lan-1280'); }
  if (width === 900) { await openIface('lan'); await shot('wrap-lan-900'); }
}
await page.setViewportSize({ width: 1280, height: 900 });
await H('openWizard'); await dialog.waitFor();
await dialog.locator('[data-where=bridge]').click();
check(await dialog.evaluate(d => d.querySelector('.modal-body').scrollWidth <= d.querySelector('.modal-body').clientWidth + 1), 'the wizard does not overflow sideways');
await dialog.locator('button', { hasText: 'Cancel' }).click();

console.log('\n== dark theme ==');
await H('reset'); await H('theme', 'dark');
await openIface('wan'); await shot('dark-wan');
await H('openWizard'); await dialog.waitFor(); await dialog.locator('[data-where=bridge]').click(); await settle(); await shot('dark-wizard');
await dialog.locator('button', { hasText: 'Cancel' }).click();
await H('theme', 'light');

console.log('\n== nothing reached a router ==');
check(errors.length === 0, 'no script or console errors', errors.join(' | '));
check(outside.length === 0, 'the page made no request outside the local server (so none to a router)', outside.join(' | '));

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED'); process.exit(1); }
console.log('all netpanels browser checks passed');
