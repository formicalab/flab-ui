// Live-update test for the network-related pages (Wired network, Bridges, Devices and Interfaces, Wi-Fi, Mesh,
// WireGuard, Firewall and Logs). A real browser opens the deployed UI; the status calls of the flab.network,
// flab.radio, flab.mesh, flab.wireguard, flab.firewall and flab.logs plugins are intercepted and answered with
// the scenario JSON produced by the backend run, so every page can be driven through link loss, STP changes,
// new bridges, radios going down, DFS, a stale VPN peer, a stopped firewall, secret-looking log lines and so on
// WITHOUT touching the router. Everything else (login, the netifd interface dump) goes to the real router.
// Usage: node live.mjs <dir with scenario JSON>   (env: FLAB_SID, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;   // a session made by tests/TestSession.ps1, so no password is needed
const acls = JSON.parse(process.env.FLAB_ACLS);   // what that session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;
// Reads <scenario>.flab.<plugin>.json from the backend run.
const scenario = (n, plugin) => JSON.parse(fs.readFileSync(path.join(out, `${n}.flab.${plugin}.json`), 'utf8'));

let failed = 0;
// Prints PASS/FAIL for one condition (with detail on failure) and counts failures for the exit code.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

const mock = { network: null, radio: null, mesh: null, wireguard: null, firewall: null, logs: null };   // null = pass through to the real router
let tick = null;                                // optional per-poll mutation, used to simulate traffic and airtime
// The cable-test answers by port (the harness results), or null; the ports a test was asked for; and any test that would have reached
// the real router (a test can drop the link, so one must never get there).
let cableMock = null;
const cableCalls = [];
const unsafeCable = [];
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// ubus object name -> the key of `mock` that may answer it.
const PLUGINS = { 'flab.network': 'network', 'flab.radio': 'radio', 'flab.mesh': 'mesh', 'flab.wireguard': 'wireguard', 'flab.firewall': 'firewall', 'flab.logs': 'logs' };
// Answers a plugin call with the staged scenario (after applying `tick`), lets every other call through. A cable test is answered
// from `cableMock` and never reaches the router.
const handleUbus = async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  if (body?.params?.[1] === 'flab.network' && body.params[2] === 'cable_test') {
    const port = body.params[3]?.port;
    cableCalls.push(port);
    if (!cableMock) unsafeCable.push(port);
    const result = cableMock?.[port] ?? { ok: false, port, supported: null, error: 'no such test in the mock' };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, result] }) });
  }
  const plugin = PLUGINS[body?.params?.[1]] ?? null;
  if (plugin && mock[plugin]) {
    if (tick) tick(plugin, mock[plugin]);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, mock[plugin]] }) });
  }
  return route.continue();
};
await page.route('**/ubus', handleUbus);

// Text of the i-th summary tile value.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// Whether the first element matching `a` comes before the first matching `b` in the document.
const before = (a, b) => page.evaluate(([x, y]) => { const A = document.querySelector(x), B = document.querySelector(y); return !!A && !!B && !!(A.compareDocumentPosition(B) & Node.DOCUMENT_POSITION_FOLLOWING); }, [a, b]);
// All visible text of every element matching a selector, joined by newlines.
const text = sel => page.locator(sel).allInnerTexts().then(t => t.join('\n'));
// Clicks Refresh and gives the page a moment to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
// Switches one plugin's mock to a scenario (null = back to the live router), refreshes and takes a screenshot.
const stage = async (label, plugin, name) => {
  console.log(`\n== ${label} ==`);
  mock[plugin] = name ? scenario(name, plugin) : null;
  tick = null;
  await refresh();
  if (shots) await page.screenshot({ path: path.join(shots, `${plugin}-${label.replace(/\W+/g, '-')}.png`), fullPage: true });
};
// CSS classes of a port tile on the Wired network page.
const portClass = async name => (await page.locator(`.port:has(.pname:text-is("${name}"))`).first().getAttribute('class')) ?? '';

// Start signed in, the way a real sign-in leaves the tab: the session id and its ACLs in sessionStorage.
await page.addInitScript(([id, granted]) => {
  sessionStorage.setItem('sid', id);
  sessionStorage.setItem('acls', JSON.stringify(granted));
}, [sid, acls]);
await page.goto(baseUrl);
await page.waitForSelector('.tile');
check((await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim()).join(' | ') === ['Overview', 'Wired network', 'Bridges', 'Wi-Fi', 'Mesh', 'IPsec VPN', 'WireGuard', 'Firewall', 'DHCP', 'DNS', 'Dynamic DNS', 'Devices and Interfaces', 'Routing', 'Traffic', 'Services', 'Toolbox', 'Logs', 'System settings'].join(' | '), 'navigation order: network layers, Firewall, DHCP, DNS, Dynamic DNS, Devices and Interfaces recap, Routing, Traffic, Services, Toolbox, Logs, then System settings by Sign out', (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).join(' | '));
//#region Wired network page
await page.click('a[href="#network"]');
await page.waitForSelector('.port');

console.log('== live router (pass-through) ==');
const livePorts = await page.locator('.port').count();
check(livePorts >= 5, 'port tiles drawn from the live router', String(livePorts));
check(await page.locator('.br-card').count() === 0 && await page.locator('.layers-table').count() === 0, 'bridges and layers are not on this page any more');
check(/^\d+ \/ \d+$/.test(await tile(0)), 'ports-linked tile', await tile(0));
check(await before('.topo-legend', '.topo'), 'the port diagram key is above the diagram');
const liveLinked = await tile(0);

await stage('a link goes down', 'network', 'n-linkdown');
check((await portClass('lan1')).includes('down'), 'lan1 turns into a down tile', await portClass('lan1'));
check(await tile(0) !== liveLinked || (await portClass('lan1')).includes('down'), 'ports-linked tile follows');
const noLink = page.locator('.port-table tr:has(strong:text-is("lan1")) .fl-badge:text-is("no link")');
check(await noLink.count() === 1 && !/danger|warning/.test(await noLink.getAttribute('class')), 'a missing link is a neutral tag, not an error color', await noLink.getAttribute('class'));
check(await page.locator('.port-table tr:has(strong:text-is("lan1")) .dot.idle').count() === 1 && await page.locator('.port-table tr:has(strong:text-is("lan1")) .dot.down').count() === 0, 'its status dot is gray, not red');

await stage('a port logs errors', 'network', 'n-errors');
check(await page.locator('.topo-box.phy').count() >= 1 && /RTL8221B/.test(await text('.topo-box.phy')), 'topology shows the external PHY chipset', await text('.topo-box.phy'));
check(/PHY.*MT7531/.test(await text('.port-table tr:has(strong:text-is("lan2")) .hw-lines')) && /Switch\s+MediaTek MT7531/.test(await text('.port-table tr:has(strong:text-is("lan2")) .hw-lines')), 'port table lists PHY, switch, driver and medium');
check(await page.locator('.diag').count() === 0, 'the breakdown starts closed');
await page.click('tr:has(strong:text-is("lan2")) .diag-btn');
await page.waitForTimeout(300);
check(/CRC errors/.test(await text('.diag')) && /Link is Down/.test(await text('.diag')) && /rx_crc_errors/.test(await text('.diag')), 'Details opens kernel counters, driver counters and log lines', await text('.diag'));
await refresh();
check(await page.locator('.diag').count() === 1, 'the open breakdown survives the next poll');
await page.click('tr:has(strong:text-is("lan2")) .diag-btn');
check(await page.locator('.diag').count() === 0, 'Hide details closes it');

await stage('downshifted link', 'network', 'n-downshift');
check(/check the cable/.test(await text('.net-health')), 'health banner names the downshifted link', await text('.net-health'));
check((await portClass('lan2')).includes('warn'), 'its tile turns amber');

await stage('router reports no devices', 'network', 'n-nodevices');
check(await page.locator('.port').count() === 0 && await tile(0) === '0 / 0', 'page copes with an empty device list', await tile(0));

await stage('back to normal', 'network', 'base');
check(await page.locator('.topo .port').count() === livePorts, 'jacks are back (the CPU link is a MAC box, not a jack)', `${await page.locator('.topo .port').count()} / ${livePorts}`);
check(/MT7531/.test(await text('.topo-box.chip')) && /^CPU port/.test(await text('.vl-cap')) && await text('.vl:has(.vl-cap) .swnum') === '6', 'topology shows the switch chip and its CPU port, whose number sits in a circle on the CPU link like the user ports');
check(/\d+ user ports \(up to [\d.]+ [GM]bit\/s\)/.test(await text('.topo-box.chip')) && /up to [\d.]+ [GM]bit\/s/.test(await text('.topo-box.phy')), 'the lines under the switch and the external PHY are computed from what the router reports (user ports, fastest speed), not from a table of known chips', await text('.topo-box.chip') + ' | ' + await text('.topo-box.phy'));
check((await page.locator('.topo .swport .swnum').allInnerTexts()).join() === '5,0,1,2,3', 'switch port numbers under the chip, in jack order', (await page.locator('.topo .swport .swnum').allInnerTexts()).join());
check((await page.locator('.topo .port .pname').allInnerTexts()).join() === 'lan1,lan2,lan3,lan4,lan5,eth1' && /WAN/.test(await text('.topo .port:has(.pname:text-is("eth1")) .prole')), 'jacks follow the board order with LAN/WAN labels');
check(await page.locator('.topo-box.phy').count() === 2 && /RTL8221B/.test(await text('.topo-box.phy')), 'external PHYs drawn for lan1 and eth1');

await stage('another router: four LAN ports, no external PHY', 'network', 'n-board');
check((await page.locator('.topo .port .pname').allInnerTexts()).join() === 'lan4,lan3,lan2,lan1,eth1', 'jack order follows the other board', (await page.locator('.topo .port .pname').allInnerTexts()).join());
check(/Other Router/.test(await text('.topo-soc')) && await page.locator('.topo-box.phy').count() === 1, 'model name and PHYs follow the data');

await stage('a router without a switch', 'network', 'n-nodsa');
check(await page.locator('.topo-box.chip').count() === 0 && await page.locator('.topo .port').count() === 2, 'no switch chip, two plain MAC columns', `${await page.locator('.topo-box.chip').count()} / ${await page.locator('.topo .port').count()}`);

await stage('back to normal again', 'network', 'base');
check(await page.locator('.port').count() === livePorts, 'ports are back');

console.log('\n== MAC addresses in the diagram ==');
const baseNet = scenario('base', 'network');
// The MAC address of port `n` in the captured data.
const macOf = n => baseNet.ports.find(p => p.name === n).mac;
check(JSON.stringify(await page.locator('.topo .tb-mac').allInnerTexts()) === JSON.stringify([macOf('eth0'), macOf('eth1')]), 'the MAC boxes of the SoC show their addresses', JSON.stringify(await page.locator('.topo .tb-mac').allInnerTexts()));
check(JSON.stringify(await page.locator('.topo .port .pmac').allInnerTexts()) === JSON.stringify(['lan1', 'lan2', 'lan3', 'lan4', 'lan5', 'eth1'].filter(n => macOf(n) !== macOf('eth0')).map(macOf)), 'a jack shows its MAC only when it differs from the MAC of the SoC port that feeds its switch (the switch ports inherit it, so the MAC box shows it once)', JSON.stringify(await page.locator('.topo .port .pmac').allInnerTexts()));
check((await page.locator('.port:has(.pname:text-is("lan1"))').getAttribute('title')).includes(macOf('lan1')), 'the tooltip of every jack still gives its MAC');

console.log('\n== the CPU link ==');
check(/CPU link [\d.]+ [GM]bit\/s · [\d.]+% used/.test(await text('.topo-box.chip')), 'the switch box says how much of the CPU link is used', await text('.topo-box.chip'));
const busy = scenario('base', 'network');
tick = (plugin, d) => { if (plugin === 'network') for (const p of d.ports) { p.stats.rx_bytes += p.name === 'eth0' ? 600_000_000 : 1000; p.stats.tx_bytes += 1000; } };
mock.network = busy;
await refresh(); await refresh(); await refresh();
check(/9\d% used|100% used/.test(await text('.topo-box.chip')) && /text-danger/.test(await page.locator('.topo-box.chip .tb-sub').last().getAttribute('class')) && /CPU is|between MediaTek MT7531 and the SoC is \d+% used/.test(await text('.net-health')), 'a busy CPU link is called out in the box and in the health banner', `${await text('.topo-box.chip')} | ${await text('.net-health')}`);
tick = null;
mock.network = scenario('base', 'network');
await refresh();
const oversub = scenario('base', 'network');
for (const p of oversub.ports) if (p.role === 'switch') { p.carrier = true; p.speed = 2500; }
mock.network = oversub;
await refresh();
check(/linked ports can send up to 12\.5 Gbit\/s \(5\.0× oversubscribed\)/.test(await text('.topo-box.chip')), 'ports that could send more than the CPU link carries are called oversubscribed', await text('.topo-box.chip'));

await stage('an optical module with an alarm', 'network', 'n-sfp');
check(/SFP/.test(await text('.topo .port:has(.pname:text-is("eth1")) .ptags')) && (await portClass('eth1')).includes('warn'), 'the port with a module is tagged SFP and turns amber on an alarm', await portClass('eth1'));
check(/optical module in eth1 reports: Laser rx power low/.test(await text('.net-health')), 'the health banner names the alarm', await text('.net-health'));
const eth1Row = page.locator('.port-table tr:has(strong:text-is("eth1"))');
check(/Module\s+FS SFP-GE-LX · Ethernet: 1000BASE-LX · LC · 1310 nm/.test(await eth1Row.locator('.hw-lines').innerText()) && /Optics\s+Tx -3\.0 dBm · Rx -30\.0 dBm · 41\.5 °C · 3\.30 V · 18\.5 mA/.test(await eth1Row.locator('.hw-lines').innerText()), 'the port table lists the module and its optics', await eth1Row.locator('.hw-lines').innerText());
check(await eth1Row.locator('.fl-badge.danger:text-is("optical alarm")').count() === 1 && await eth1Row.locator('.cable-btn').count() === 0, 'an alarm badge in the Link column, and no cable test for an optical port');
check(/Module\s+none inserted/.test(await page.locator('.port-table tr:has(strong:text-is("lan3")) .hw-lines').innerText()) && /DAC-Maker DAC-10G-1M/.test(await page.locator('.port-table tr:has(strong:text-is("lan4")) .hw-lines').innerText()), 'an empty cage says so, a direct-attach cable shows its part', await page.locator('.port-table tr:has(strong:text-is("lan4")) .hw-lines').innerText());
check(await page.locator('.port-table tr:has(strong:text-is("lan4")) .cable-btn').count() === 0 && await page.locator('.port-table tr:has(strong:text-is("lan3")) .cable-btn').count() === 0, 'optical cages have no cable test, even when empty');

console.log('\n== energy-efficient Ethernet ==');
await stage('back to normal', 'network', 'base');
const eeeBadges = await page.locator('.port-table .neg .fl-badge').allInnerTexts();
check(baseNet.ports.filter(p => p.eee).every(p => eeeBadges.some(t => /^EEE (active|idle|off)$/.test(t.trim()))) && (baseNet.ports.some(p => p.eee) ? eeeBadges.some(t => /^EEE/.test(t.trim())) : true), 'EEE shows as a badge next to the negotiation (active, idle or off) for ports that have it', eeeBadges.join(' | '));

console.log('\n== VLAN tables ==');
check(await page.locator('.vlan-table').count() === 0, 'a router without VLANs has no VLAN card');
await stage('the bridge VLAN table from the kernel', 'network', 'n-vlantable');
const vcard = page.locator('.card:has(.card-header:has-text("VLANs"))');
check(/Bridge br-lan · VLANs/.test(await vcard.locator('.card-header').innerText()) && /VLAN filtering on/.test(await vcard.locator('.card-header').innerText()) && /bridge vlan show/.test(await vcard.locator('.card-header').innerText()), 'the card names the bridge, that VLAN filtering is on and where the table was read', await vcard.locator('.card-header').innerText());
check((await vcard.locator('thead th').allInnerTexts()).join() === 'VLAN,lan1,lan2,lan5,br-lan' && (await vcard.locator('tbody tr').allInnerTexts()).length === 3, 'one column per port that is in a VLAN (members first, the bridge itself last), one row per VLAN', (await vcard.locator('thead th').allInnerTexts()).join());
check(/untagged\s*PVID/.test(await vcard.locator('tbody tr').first().locator('td').nth(1).innerText()) && /^tagged$/.test((await vcard.locator('tbody tr').nth(1).locator('td').nth(1).innerText()).trim()) && /^–$/.test((await vcard.locator('tbody tr').nth(2).locator('td').nth(1).innerText()).trim()), 'tagged, untagged and PVID are told apart; a port outside the VLAN shows a dash');
await stage('the bridge VLAN table from the network config', 'network', 'n-vlanconfig');
check(/network config \(bridge-vlan sections\)/.test(await vcard.locator('.card-header').innerText()) && (await vcard.locator('tbody tr').allInnerTexts()).length === 2, 'without the bridge tool the card says the table comes from the config', await vcard.locator('.card-header').innerText());
await stage('VLAN filtering without a VLAN', 'network', 'n-vlanfilter');
check(/VLAN filtering is on but no VLAN is configured/.test(await text('main')), 'an empty table with filtering on is said so');

console.log('\n== a switch driven through swconfig ==');
await stage('an older board with swconfig', 'network', 'n-swconfig');
check(/AR8327 switch/.test(await text('.topo-box.chip')) && (await page.locator('.topo .port .pname').allInnerTexts()).join() === 'port1,port2,port3,port4,port5,eth1', 'the switch is drawn with its user ports as jacks (eth0, the CPU netdev, is not one)', (await page.locator('.topo .port .pname').allInnerTexts()).join());
check((await page.locator('.topo .swport .swnum').allInnerTexts()).join() === '1,2,3,4,5' && await text('.vl:has(.vl-cap) .swnum') === '0' && /CPU link [\d.]+ [GM]bit\/s/.test(await text('.topo-box.chip')), 'switch port numbers, the CPU port circle and the CPU link follow swconfig', `${(await page.locator('.topo .swport .swnum').allInnerTexts()).join()} | ${await text('.topo-box.chip')}`);
check(/WAN/.test(await text('.topo .port:has(.pname:text-is("port1")) .prole')) && (await portClass('port2')).includes('up') && (await portClass('port3')).includes('down'), 'roles from board.json, link state from the switch');
const p2row = page.locator('.port-table tr:has(strong:text-is("port2"))');
check(/no per-port counters/.test(await text('.port:has(.pname:text-is("port2")) .prate')) && await page.locator('.port:has(.pname:text-is("port2")) .spark').count() === 0 && /no counters/.test(await p2row.locator('td.num').first().innerText()), 'a port without counters says so instead of "measuring" forever', await text('.port:has(.pname:text-is("port2")) .prate'));
check(/link up/.test(await p2row.innerText()) && /100 Mbit\/s half/.test(await p2row.innerText()) && !/total/.test(await p2row.innerText()) && await p2row.locator('.cable-btn').count() === 0 && /br-lan/.test(await p2row.innerText()) && /eth0\.1/.test(await p2row.innerText()), 'the port table shows what swconfig reports, no counters, no cable test, and the bridge and VLAN device', await p2row.innerText());
const sc = page.locator('.card:has(.card-header:has-text("VLAN groups"))');
check(/Switch AR8327 · VLAN groups/.test(await sc.locator('.card-header').innerText()) && /VLANs on/.test(await sc.locator('.card-header').innerText()) && (await sc.locator('thead th').allInnerTexts()).join() === 'VLAN,port1,port2,port3,port4,port5' && (await sc.locator('tbody tr').allInnerTexts()).length === 2, 'the swconfig VLAN groups are a matrix of VLANs and ports', (await sc.locator('thead th').allInnerTexts()).join());
check(/PVID/.test(await sc.locator('tbody tr').nth(1).locator('td').nth(1).innerText()) && /PVID/.test(await sc.locator('tbody tr').first().locator('td').nth(2).innerText()), 'the PVID of each port is marked in its VLAN');
await stage('back to normal', 'network', 'base');
check(await page.locator('.vlan-table').count() === 0 && await page.locator('.port').count() === livePorts, 'and the DSA board is back');

console.log('\n== cable test (answered by the fixtures: no cable is ever tested) ==');
cableMock = JSON.parse(fs.readFileSync(path.join(out, 'cable.json'), 'utf8'));
// The cable-test button in the row of port `n`, the confirmation dialog, and a helper that runs the test of a port.
const cableBtn = n => page.locator(`.port-table tr:has(strong:text-is("${n}")) .cable-btn`);
const dlg = page.locator('dialog.fl-dialog[open]');
// Runs the cable test of port `n` through the confirmation and waits for its result panel.
const runCable = async n => {
  await cableBtn(n).click();
  await dlg.locator('button:has-text("Run the test")').click();
  await page.locator(`.cable-panel:has-text("Cable test of ${n}")`).locator('table, .text-danger').first().waitFor();
};
check(await page.locator('.port-table .cable-btn').count() === baseNet.ports.filter(p => p.role !== 'conduit').length && await cableBtn('eth0').count() === 0, 'a cable test button on every twisted-pair port, none on the internal link to the switch');
await cableBtn('lan1').click();
await dlg.waitFor();
if (shots) await page.screenshot({ path: path.join(shots, 'network-cable-test-dialog.png') });
check(/drops the link on lan1 for several seconds/.test(await dlg.innerText()) && /your connection to the router/.test(await dlg.innerText()) && cableCalls.length === 0, 'the confirmation says what the test does to a link that is up, and nothing has been asked yet', await dlg.innerText());
await dlg.locator('button:has-text("Cancel")').click();
check(await dlg.count() === 0 && cableCalls.length === 0, 'Cancel runs nothing');
await stage('a link goes down', 'network', 'n-linkdown');
await cableBtn('lan1').click();
await dlg.waitFor();
check(/lan1 has no link, so nothing is interrupted/.test(await dlg.innerText()), 'for a port without link the confirmation says nothing is interrupted', await dlg.innerText());
await dlg.locator('button:has-text("Cancel")').click();
await stage('back to normal', 'network', 'base');
await runCable('lan1');
check(cableCalls.join() === 'lan1' && await page.locator('.cable-panel tbody tr').count() === 4 && await page.locator('.cable-panel .fl-badge.success').count() === 4 && /All four pairs are intact/.test(await text('.cable-panel')), 'the result lists the four pairs and says the cable is intact', await text('.cable-panel'));
await refresh();
check(await page.locator('.cable-panel').count() === 1, 'the result survives the next poll');
await page.click('.cable-panel button:has-text("Close")');
check(await page.locator('.cable-panel').count() === 0, 'Close hides it');
await runCable('lan2');
check(await page.locator('.cable-panel .fl-badge.warning:text-is("Open Circuit")').count() === 2 && /enough for 10 and 100 Mbit\/s/.test(await text('.cable-panel')), 'open pairs C and D on a gigabit link are a plain warning', await text('.cable-panel'));
await page.click('.cable-panel button:has-text("Close")');
await stage('downshifted link', 'network', 'n-downshift');
check(/A cable test on its row shows which pair is at fault/.test(await text('.net-health')), 'a downshifted link points to the cable test');
await runCable('lan2');
check(/cannot carry 1 Gbit\/s/.test(await text('.cable-panel')) && /Pairs A and B are intact and C and D are open/.test(await text('.cable-panel')), 'on a downshifted link open C and D are named as the reason', await text('.cable-panel'));
await page.click('.cable-panel button:has-text("Close")');
await runCable('lan3');
check(await page.locator('.cable-panel .fl-badge.danger:text-is("Short within Pair")').count() === 1 && /fault at about 12\.5 m/.test(await text('.cable-panel')), 'a fault is shown with its distance', await text('.cable-panel'));
await page.click('.cable-panel button:has-text("Close")');
await runCable('lan4');
check(/does not support cable testing/.test(await text('.cable-panel')), 'a PHY that cannot test is told so', await text('.cable-panel'));
await page.click('.cable-panel button:has-text("Close")');
await runCable('lan5');
check(/did not complete: something odd happened/.test(await text('.cable-panel')), 'output that is not a result is an error');
await page.click('.cable-panel button:has-text("Close")');
check(cableCalls.join() === 'lan1,lan2,lan2,lan3,lan4,lan5' && unsafeCable.length === 0, 'every test went to the mock, none to the router', cableCalls.join());
// A port that the plugin has found cannot be tested loses its button.
const noTest = scenario('base', 'network');
noTest.ports.find(p => p.name === 'lan4').cable_test = false;
mock.network = noTest;
await refresh();
check(await cableBtn('lan4').count() === 0 && await cableBtn('lan5').count() === 1, 'a port known not to support the test has no button');
// A login that may read but not run the test sees no buttons.
const ro = await ctx.newPage();
await ro.route('**/ubus', handleUbus);
await ro.addInitScript(([id]) => {
  sessionStorage.setItem('sid', id);
  sessionStorage.setItem('acls', JSON.stringify({ ubus: { 'flab.network': ['status'], system: ['board', 'info'], service: ['list'], session: ['access', 'destroy'], 'network.interface': ['dump'] } }));
}, [sid]);
await ro.goto(`${baseUrl}#network`);
await ro.waitForSelector('.port');
check(await ro.locator('.port-table .cable-btn').count() === 0, 'a login that may not run the test sees no cable-test buttons');
await ro.close();
cableMock = null;
await stage('back to normal', 'network', 'base');

console.log('\n== live throughput ==');
mock.network = scenario('base', 'network');
tick = (plugin, d) => { if (plugin === 'network') for (const p of d.ports) { p.stats.rx_bytes += 5_000_000; p.stats.tx_bytes += 1_000_000; } };
await refresh(); await refresh(); await refresh();
check(/^↓ [1-9]/.test(await tile(1)) && !/0 bit/.test((await tile(1)).split('\n')[0]), 'throughput tile shows a measured rate', await tile(1));
check(/Mbit\/s/.test(await text('.port.up .prate')), 'port tiles show live rates', await text('.port.up .prate'));
//#endregion

//#region Bridges page
await page.click('a[href="#bridges"]');
await page.waitForSelector('.br-card');
console.log('\n== bridges: live router (pass-through) ==');
mock.network = null;
await refresh();
check(await page.locator('.br-card').count() >= 1 && await page.locator('.port').count() === 0, 'bridge card drawn, no port tiles on this page');
check(await page.locator('.br-card tbody tr').count() >= 3, 'member ports listed');

await stage('this bridge becomes STP root', 'network', 'n-root');
check(await page.locator('.br-stp.root').count() === 1 && /spanning-tree root/.test(await text('.br-stp.root')), 'bridge card says it is the root');
check(await tile(1) === 'Root', 'spanning-tree tile reads Root', await tile(1));
await stage('mesh peers from the capture', 'mesh', 'base');
check(await page.locator('.br-stp.root .br-peer').count() >= 1 && /^([0-9a-f]{2}:){5}[0-9a-f]{2}/.test(await text('.br-stp.root .br-peer')) && /via phy\d+-mesh\d+/.test(await text('.br-stp.root .br-peer')) && /ESTAB/.test(await text('.br-stp.root .br-peer')), 'the root bridge lists the mesh peers that reach the network through it', await text('.br-stp.root'));
check(/Mesh/.test(await text('.br-card tbody')) && /\d+ peers?/.test(await text('.br-card tbody')), 'a mesh member port is labeled Mesh with its number of peers', await text('.br-card tbody'));
await stage('back to the live router', 'mesh', null);

await stage('blocked port and topology change', 'network', 'n-blocked');
check(/blocked by spanning tree/.test(await text('.net-health')), 'health banner reports the blocked port', await text('.net-health'));
check(/topology change/.test(await text('.br-head')), 'bridge header shows the topology change');

await stage('STP switched off', 'network', 'n-nostp');
check(/STP off/.test(await text('.br-head')) && await page.locator('.br-stp.off').count() === 1, 'bridge shows STP off');

await stage('second bridge appears', 'network', 'n-newbridge');
check(await page.locator('.br-card').count() === 2 && /br-guest/.test(await text('.br-card')), 'a second bridge card appears');
check(await tile(0) === '2', 'bridges tile counts two', await tile(0));

await stage('router reports no devices', 'network', 'n-nodevices');
check(await page.locator('.br-card').count() === 0 && /No bridges are configured/.test(await text('main')), 'empty state when there are no bridges');

await stage('back to normal', 'network', 'base');
check(await page.locator('.br-card').count() === 1, 'the bridge is back');
//#endregion

//#region Devices and Interfaces page
await page.click('a[href="#interfaces"]');
await page.waitForSelector('.layers-table');
console.log('\n== interfaces: live router (pass-through) ==');
mock.network = null;
await refresh();
// The row of the layers table whose name (third column) is `n`.
const layerRow = n => page.locator(`.layers-table tr:has(td:nth-child(3) strong:text-is("${n}"))`);
check(await page.locator('.port').count() === 0 && await page.locator('.br-card').count() === 0, 'no ports or bridge cards on this page');
check(await layerRow('lan').count() === 1 && /br-lan/.test(await layerRow('lan').innerText()) && await layerRow('lan').locator('.cn.k-port, .cn.k-wifi, .cn.k-mesh').count() >= 3, 'layers: lan sits on br-lan, which groups ports and Wi-Fi');
check(await layerRow('lan').locator('.cn.k-wifi .cn-sub').first().innerText().then(t => /radio\d/.test(t)), 'layers: a Wi-Fi interface shows the radio it is on');
check(await layerRow('lan').locator('.cn.k-mesh').count() >= 1 && await layerRow('lan').locator('a.cn-link[href="#mesh"]').count() >= 1, 'layers: the mesh interface is listed and links to the Mesh page');
check(/Radios/.test(await text('.tile')) && /Wireless interfaces/.test(await text('.tile')), 'radio and wireless interface tiles');
check(/eth1\.1036/.test(await layerRow('wan').innerText()) && /pppoe-wan/.test(await layerRow('wan').innerText()) && /VLAN 1036/.test(await layerRow('wan').innerText()), 'layers: wan is PPPoE over the VLAN on eth1');
check(/protocol device of wan/.test(await layerRow('wan6').innerText()), 'layers: wan6 is shown riding on the PPPoE session of wan');
check(/runs over interface\s+wan/.test(await layerRow('xfrm0').innerText()), 'layers: the IPsec interface runs over wan');
check(/^\d+ \/ \d+$/.test(await tile(0)), 'interfaces-up tile', await tile(0));
check(await before('.layers-legend', '.layers-table') && /How to read a row/.test(await text('.layers-legend')) && await page.locator('.layers-foot').count() === 0, 'the "how to read" legend is above the table, not below it');
check(await layerRow('lan100').locator('.cn-same').count() === 1 && /same \d+ ports and radios as lan/.test(await layerRow('lan100').innerText()) && await layerRow('lan100').locator('.cn.k-port').count() === 0, 'layers: lan100 does not repeat the ports, it says they are the same as lan');
check(/untagged/.test(await layerRow('lan').innerText()) && /only frames tagged VLAN 100 on br-lan/.test(await layerRow('lan100').innerText()), 'layers: each row says which frames it carries (untagged vs VLAN 100)');
check(/\blan\b/.test(await layerRow('lan').locator('td:nth-child(6)').innerText()) && /DHCPv4/.test(await layerRow('lan').locator('td:nth-child(6)').innerText()), 'zone and DHCP service of lan');
check(/\bwan\b/.test(await layerRow('wan').locator('td:nth-child(6)').innerText()) && /NAT/.test(await layerRow('wan').locator('td:nth-child(6)').innerText()), 'the WAN zone is shown with NAT');
check(/\bvpn\b/.test(await layerRow('xfrm0').locator('td:nth-child(6)').innerText()) && /\bwg\b/.test(await layerRow('wg0').locator('td:nth-child(6)').innerText()), 'tunnel interfaces show their firewall zone');
check(/route\s+10\.0\.0\.0\/8 via/.test(await layerRow('voip').innerText()) && /route\s+192\.168\.8\.0\/24 on link/.test(await layerRow('wg0').innerText()), 'static routes are listed under their interface (on-link ones say so)');
check(/prefix\s+[0-9a-f:]+\/60/.test(await layerRow('lan').innerText()), 'delegated prefixes are listed');

await stage('router reports no devices', 'network', 'n-nodevices');
check(await layerRow('lan').locator('.cn.k-device').count() === 1, 'an undescribed device is kept as an unknown device, not dropped');

await stage('back to normal', 'network', 'base');

await stage('a Wi-Fi interface on a network that does not exist', 'radio', 'r-newssid');
check(await page.locator('.layers-table tr:has(td:nth-child(3):has-text("not attached"))').count() === 1, 'layers: a wireless interface that reaches no network interface gets its own row');
check(/guest_2g.*not attached to any network interface/.test(await text('.net-health')), 'findings name the unattached wireless interface', await text('.net-health'));
await stage('radios back to the live router', 'radio', null);
check(await page.locator('.layers-table tr:has(td:nth-child(3):has-text("not attached"))').count() === 0, 'the unattached row is gone again');
//#endregion

//#region Mesh page
await page.click('a[href="#mesh"]');
await page.waitForSelector('.mesh-card');
console.log('\n== mesh: live router (pass-through) ==');
mock.mesh = null; mock.network = null;
await refresh();
check(await page.locator('.mesh-card').count() >= 1 && await page.locator('.mesh-card .mesh-table').count() >= 2, 'mesh card with peers and paths tables from the live router');
check(/Peers established/.test(await text('.tile')), 'mesh summary tiles');

await stage('a second peer, one not established', 'mesh', 'm-twopeers');
check(await page.locator('.mesh-card .mesh-table').first().locator('tbody tr').count() === 2, 'two peer rows');
check(await tile(1) === '1 / 2', 'peers-established tile counts 1 of 2', await tile(1));
check(/not established/.test(await text('.net-health')), 'health banner names the peer that is not established', await text('.net-health'));
check(await page.locator('.mesh-card .mesh-table').nth(1).locator('tbody tr').count() >= 2, 'mesh paths listed, including multi-hop and unresolved ones');

await stage('a weak, lossy link', 'mesh', 'm-weak');
check(/Weak link/.test(await text('.net-health')) && /failed/.test(await text('.net-health')), 'weak signal and transmission failures reported', await text('.net-health'));

await stage('forwarding switched off', 'mesh', 'm-fwdoff');
check(/forwarding is off/.test(await text('.net-health')) && await tile(4) === 'Off', 'forwarding off is called out', await text('.net-health'));

await stage('no peers', 'mesh', 'm-nopeer');
check(/no mesh peer/.test(await text('.net-health')), 'no peers is reported');

await stage('mesh interface not running', 'mesh', 'm-down');
check(await page.locator('.mesh-card.is-down').count() === 1 && /not running/.test(await text('.net-health')), 'a mesh interface that is down is shown as such');

await stage('no mesh configured', 'mesh', 'm-nomesh');
check(await page.locator('.mesh-card').count() === 0 && /No 802\.11s mesh interface/.test(await text('main')), 'empty state when no mesh interface exists');

await stage('back to normal', 'mesh', 'base');
check(await page.locator('.mesh-card').count() === 1, 'the mesh interface is back');
//#endregion

//#region WireGuard page
await page.click('a[href="#wireguard"]');
await page.waitForSelector('.wg-card');
console.log('\n== wireguard: live router (pass-through) ==');
mock.wireguard = null;
await refresh();
check(await page.locator('.wg-table tbody tr').count() >= 2, 'peers listed from the live router');
check(/^\d+ \/ \d+$/.test(await tile(1)) && /Interfaces up/.test(await text('.tile')), 'summary tiles', await tile(1));
check(await page.locator('.wg-ip.net').count() >= 1 && /site/.test(await text('.wg-table')) && /client/.test(await text('.wg-table')), 'a network behind a peer is marked as a site, single hosts as clients');
check(!/CANARY|private/i.test(await text('main')), 'no key material on the page');

await stage('one site peer connected', 'wireguard', 'base');
const wgRows = await page.locator('.wg-table tbody tr').count();
check(/^1 \/ \d+$/.test(await tile(1)) && /healthy|has not connected/.test(await text('.net-health')), 'one connected peer', await tile(1));

await stage('peer silent for a long time', 'wireguard', 'w-stale');
check(/^0 \/ \d+$/.test(await tile(1)) && /last handshake .* ago/.test(await text('.net-health')), 'a stale handshake is called out', `${await tile(1)} ${await text('.net-health')}`);
check(/no recent handshake/.test(await text('.wg-table')), 'the peer shows as not recently connected');

await stage('interface not running', 'wireguard', 'w-down');
check(await page.locator('.wg-card.is-down').count() === 1 && /configured but not running/.test(await text('.net-health')) && /not loaded/.test(await text('.wg-table')), 'a WireGuard interface that is down is shown as such', await text('.net-health'));

await stage('a peer added at run time', 'wireguard', 'w-newpeer');
check(await page.locator('.wg-table tbody tr').count() === wgRows + 1 && /not in the configuration/.test(await text('.wg-table')) && /203\.0\.113\.7:51820/.test(await text('.wg-table')), 'a peer the configuration does not know is listed and flagged');

await stage('routes for a site not installed', 'wireguard', 'w-noroutes');
check(/route_allowed_ips is off/.test(await text('.net-health')) && /routes not installed/.test(await text('.wg-table')), 'a site peer without routes is warned about', await text('.net-health'));

await stage('interface without a firewall zone', 'wireguard', 'w-nozone');
check(/no firewall zone/.test(await text('.net-health')) && /no firewall zone/.test(await text('.wg-head')), 'a missing firewall zone is warned about');

await stage('no WireGuard at all', 'wireguard', 'w-nowg');
check(await page.locator('.wg-card').count() === 0 && /No WireGuard interface/.test(await text('main')), 'empty state when WireGuard is not configured');

console.log('\n== wireguard: live traffic ==');
mock.wireguard = scenario('base', 'wireguard');
tick = (plugin, d) => { if (plugin === 'wireguard') for (const i of d.interfaces) for (const p of i.peers) if (p.state === 'connected') { p.rx_bytes += 3_000_000; p.tx_bytes += 500_000; } };
await refresh(); await refresh(); await refresh();
check(/Mbit\/s|kbit\/s/.test(await text('.wg-table tbody')) && /[1-9]/.test((await tile(3)).split('\n')[0]) && !/^0 bit/.test(await tile(3)), 'peer traffic shows a measured rate', await tile(3));
await stage('back to the live router', 'wireguard', null);
//#endregion

//#region Firewall page
await page.click('a[href="#firewall"]');
await page.waitForSelector('.fwm');
console.log('\n== firewall: live router (pass-through) ==');
mock.firewall = null;
await refresh();
const zoneNames = (await page.locator('.fwm thead th').allInnerTexts()).slice(1).filter(t => t !== 'Router itself');
check(zoneNames.length >= 2 && await page.locator('.fwm tbody tr').count() === zoneNames.length + 1, 'the matrix has the router plus every zone', zoneNames.join());
check(await before('.fw-zones-legend', '.fw-table') && /refuse everything by default except what a specific rule/.test(await text('.fw-zones-legend')) && /Input policy/.test(await text('.fw-table thead')), 'the zones card explains that reject/drop are defaults, above the table, and the columns say "policy"');
check(await page.locator('.fwm-open').count() >= 3 && await page.locator('.fwm-partial').count() >= 1 && await page.locator('.fwm-closed').count() >= 1, 'open, partial and closed cells');
check(await page.locator('.fw-matrix-legend').count() === 1 && await before('.fw-matrix-legend', '.fwm'), 'the matrix legend is above the matrix');
check(await page.locator('.fw-table').count() >= 3 && /Zones/.test(await text('.card-header')) && /Traffic rules/.test(await text('.card-header')), 'zones, exposure, rules and port-forward tables');
check(await page.locator('.fw-table').nth(2).locator('tbody tr').count() >= 10, 'the traffic rules are listed', String(await page.locator('.fw-table').nth(2).locator('tbody tr').count()));
check(/Reachable from the Internet/.test(await text('.card-header')) && /UDP 51820/.test(await text('main')), 'the exposure table lists what the Internet can reach (the WireGuard port)');
check(/^\d+ \/ \d+$/.test(await tile(1)) && /^\d+$/.test((await tile(0)).trim()), 'summary tiles', `${await tile(0)} ${await tile(1)}`);

await stage('a port forward from the Internet', 'firewall', 'f-redirect');
check(await tile(2) === '1' && /Web/.test(await text('.fw-table')) && /8080/.test(await text('.fw-table')) && /192\.168\.1\.10:80/.test(await text('.fw-table')), 'the port forward is listed with what it forwards to');
check(/Reachable from the Internet/.test(await text('.card-header')) && /port forward/.test(await text('main')), 'and appears among what the Internet can reach');
check(/7/.test(await text('.fw-table tbody')) , 'its hit counter is shown');

await stage('Internet-facing zone wide open', 'firewall', 'f-exposed');
check(/accepts all traffic to the router/.test(await text('.net-health')) && /Open-All accepts every TCP\/UDP port/.test(await text('.net-health')) && await page.locator('.net-health.bad').count() === 1, 'an open WAN is a red finding', await text('.net-health'));

await stage('a disabled rule', 'firewall', 'f-disabled');
check(/1 rule is disabled: Allow-Ping/.test(await text('.net-health')) && await page.locator('.fw-table tr.fw-off').count() === 1, 'a disabled rule is grayed out and reported');

await stage('an unnamed rule', 'firewall', 'f-anonymous');
check(/@rule\[\d+\]/.test(await text('.fw-table')) && /unnamed/.test(await text('.fw-table')) && /TCP 2222/.test(await text('.fw-table')), 'an unnamed rule is listed by its position');

await stage('an interface in no zone', 'firewall', 'f-unzoned');
check(/lan100 is in no firewall zone/.test(await text('.net-health')), 'an unzoned interface is reported');

await stage('connection table nearly full', 'firewall', 'f-conntrack');
check(/Connection tracking is \d+ % full/.test(await text('.net-health')) && /text-warning/.test(await page.locator('.tile .value').nth(4).getAttribute('class')), 'a nearly full connection table is reported');

await stage('firewall not loaded', 'firewall', 'f-stopped');
check(/not loaded/.test(await text('.net-health')) && await page.locator('.net-health.bad').count() === 1, 'a stopped firewall is a red finding');

console.log('\n== firewall: live counters ==');
mock.firewall = scenario('base', 'firewall');
tick = (plugin, d) => { if (plugin === 'firewall') { for (const r of d.rules) if (r.hits) { r.hits.packets += 50; r.hits.bytes += 5000; } for (const z of d.zones) if (z.blocked_from) { z.blocked_from.packets += 200; z.blocked_from.bytes += 20000; } } };
await refresh(); await refresh(); await refresh();
check(await page.locator('.fw-pps').count() >= 1 && /pkt\/s/.test(await text('.fw-pps')), 'zones show a live rate of turned-away packets', await text('.fw-pps'));
check(await page.locator('.fw-table .dot.up').count() >= 1, 'rules with traffic show an activity dot');
check(/pkt\/s/.test(await tile(3)) || /pkt\/s/.test(await text('.tile')), 'the summary tile shows the rate');
await stage('back to the live router', 'firewall', null);
//#endregion

//#region Logs page
await page.click('a[href="#logs"]');
await page.waitForSelector('.log-table');
console.log('\n== logs: live router (pass-through) ==');
mock.logs = null;
await refresh();
// The rows of the log table.
const logRows = () => page.locator('.log-table tbody tr');
// Whether the log pane is scrolled to (within 30 px of) its bottom.
const atBottom = () => page.evaluate(() => { const p = document.querySelector('.log-pane'); return p.scrollHeight - p.scrollTop - p.clientHeight < 30; });
// Picks `value` in the toolbar select with the given title.
const choose = (title, value) => page.selectOption(`select[title="${title}"]`, value);
const SOURCE = 'Which log to read', LEVEL = 'Hide entries below this severity', PROGRAM = 'Show one source only', LINES = 'How many of the newest lines to load';
check(await logRows().count() >= 20, 'system log entries from the live router', String(await logRows().count()));
check(await before('.log-legend', '.log-pane') && /System log \(logread\)/.test(await text('.log-legend')) && /redacted/.test(await text('.log-legend')), 'the legend sits above the entries and mentions redaction');
check(/^\d+ \/ \d+$/.test(await tile(0)) && /Errors/.test(await text('.tile')) && /Newest entry/.test(await text('.tile')), 'summary tiles', await tile(0));
check(await atBottom(), 'the newest entries are in view: the pane opens scrolled to the bottom');

await page.evaluate(() => { document.querySelector('.log-pane').scrollTop = 0; });
await page.waitForTimeout(200);
await refresh();
check(!(await atBottom()), 'after scrolling up the view stays where it is on refresh');
await page.click('button:has-text("Newest")');
await page.waitForTimeout(300);
check(await atBottom(), 'Newest jumps back to the newest entry and resumes following');

await choose(LINES, '200');
await page.waitForTimeout(900);
check(await logRows().count() <= 200, 'asking for 200 lines loads at most 200', String(await logRows().count()));
await choose(LINES, '500');

await choose(SOURCE, 'kernel');
await page.waitForTimeout(900);
check(/Kernel log \(dmesg\)/.test(await text('.log-legend')) && (await page.locator('.log-origin').allInnerTexts()).every(t => t.trim() === 'kernel') && await logRows().count() > 10, 'the kernel log: every entry comes from the kernel');
await choose(SOURCE, 'system');
await page.waitForTimeout(900);

console.log('\n== logs: filtering and states ==');
await stage('the captured system log', 'logs', 'base');
const total = await logRows().count();
await choose(LEVEL, 'err');
check(await logRows().count() < total && await page.locator('.log-table tbody tr:not(.lv-err)').count() === 0, 'the level filter keeps only errors', `${await logRows().count()} of ${total}`);
await choose(LEVEL, 'all');
await page.fill('.search input', 'dropbear');
check(await logRows().count() > 0 && (await page.locator('.log-origin').allInnerTexts()).every(t => /dropbear/.test(t)) && /^\d+ \/ \d+$/.test(await tile(0)) && (await text('.tile')).includes('matching the filter'), 'the text filter narrows the entries and says so', await tile(0));
await page.fill('.search input', 'zzz-no-such-text');
check(await logRows().count() === 0 && /No entries match the filter/.test(await text('main')), 'a filter that matches nothing says so');
await page.fill('.search input', '');
await choose(PROGRAM, 'dropbear');
check(await logRows().count() > 0 && (await page.locator('.log-origin').allInnerTexts()).every(t => /^dropbear/.test(t)), 'the source filter shows one program');
await choose(PROGRAM, 'all');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download")')]);
check(dl.suggestedFilename() === 'system-log.txt', 'Download saves the entries as a text file', dl.suggestedFilename());

await stage('a secret and odd lines', 'logs', 'l-odd');
const odd = await text('.log-table');
check(!odd.includes('CANARY') && /password=<redacted>/.test(odd), 'a redacted secret is shown as <redacted>, never the value');
check(await page.locator('.log-table tr.lv-none').count() >= 1 && /kept whole/.test(await text('.log-table tr.lv-none')), 'a line without a header is shown whole, dimmed');
check(await page.locator('.log-table tr.lv-err').count() >= 1 && await page.locator('.log-table tr.lv-err .fl-badge.danger').count() >= 1, 'errors are tinted and carry a red level badge');

await stage('an empty log', 'logs', 'l-empty');
check(await page.locator('.log-table').count() === 0 && /The log is empty/.test(await text('main')), 'an empty log has an empty state');
await stage('back to the live router', 'logs', null);
//#endregion

//#region Wi-Fi page
await page.click('a[href="#wifi"]');
await page.waitForSelector('.rd-card');

console.log('\n== live router (pass-through) ==');
mock.radio = null;
await refresh();
check(await page.locator('.rd-card').count() >= 1, 'radio cards drawn from the live router');
check(await page.locator('.rd-card table tbody tr').count() >= 1, 'interfaces listed');
check(!/formicalabmesh|\bmesh\b/.test(await text('.rd-card table')) && await page.locator('.rd-card a[href="#mesh"]').count() >= 1, 'the mesh interface is not in the Wi-Fi tables, only linked to the Mesh page');
check(!/\bmesh\b/.test(await text('main .card-header')), 'no mesh client group on the Wi-Fi page');
check(await before('details.legend', '.card-header .ms-auto'), 'the client legend sits above the client tables');

await stage('a radio goes down', 'radio', 'r-down');
check(await page.locator('.rd-card.is-down').count() === 1, 'one radio card switches to the down style');
check(/not running/.test(await text('.rd-find')), 'findings explain it', await text('.rd-find'));

await stage('DFS availability check', 'radio', 'r-dfs');
check(/radar channel availability check/.test(await text('.rd-find')), 'DFS wait is explained', await text('.rd-find'));

await stage('channel change', 'radio', 'r-channel');
check(/Running on channel 11 but configured for 6/.test(await text('.rd-find')), 'channel mismatch reported', await text('.rd-find'));
check(await page.locator('.chn.cur:text-is("11"), .chn.cur:has(.n:text-is("11"))').count() === 1, 'channel strip highlights the new channel');

await stage('radio disabled', 'radio', 'r-disabled');
check(/disabled in the configuration/.test(await text('.rd-find')), 'disabled radio explained', await text('.rd-find'));

await stage('base radios', 'radio', 'base');
const baseRows = await page.locator('.rd-card').first().locator('tbody tr').count();
await stage('new SSID', 'radio', 'r-newssid');
check(await page.locator('.rd-card').first().locator('tbody tr').count() === baseRows + 1, 'new SSID row appears', String(baseRows));
check(/guest is an open network/.test(await text('.rd-find')), 'open network warned about', await text('.rd-find'));

console.log('\n== live channel utilization ==');
mock.radio = scenario('base', 'radio');
tick = (plugin, d) => { if (plugin === 'radio') for (const r of d.radios) if (r.survey) { r.survey.active += 1000; r.survey.busy += 250; r.survey.rx += 100; r.survey.tx += 50; } };
await refresh(); await refresh(); await refresh();
check(/25\.0 %/.test(await text('.rd-air .big')), 'airtime counters become a utilization percentage', await text('.rd-air .big'));
//#endregion

check(unsafeCable.length === 0, 'no cable test reached the real router', unsafeCable.join());
check(errors.length === 0, 'no console or page errors', errors.join(' | '));
await browser.close();
if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall Network / Wi-Fi live-update checks passed');
