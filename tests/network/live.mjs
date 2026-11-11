// Live-update test for the Network and Wi-Fi pages. A real browser opens the deployed UI; the
// flab.network and flab.radio status calls are intercepted and answered with the scenario JSON produced by
// the backend run, so both pages can be driven through link loss, STP changes, new bridges, radios going
// down, DFS, channel changes and new SSIDs WITHOUT touching the router. Everything else (login, the
// netifd interface dump) goes to the real router.
// Usage: node live.mjs <dir with scenario JSON>   (env: FLAB_URL, FLAB_PASSWORD, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const password = process.env.FLAB_PASSWORD ?? 'flab';
const shots = process.env.FLAB_SHOTS;
const scenario = (n, plugin) => JSON.parse(fs.readFileSync(path.join(out, `${n}.flab.${plugin}.json`), 'utf8'));

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

const mock = { network: null, radio: null, mesh: null };   // null = pass through to the real router
let tick = null;                                // optional per-poll mutation, used to simulate traffic and airtime
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const PLUGINS = { 'flab.network': 'network', 'flab.radio': 'radio', 'flab.mesh': 'mesh' };
await page.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const plugin = PLUGINS[body?.params?.[1]] ?? null;
  if (plugin && mock[plugin]) {
    if (tick) tick(plugin, mock[plugin]);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, mock[plugin]] }) });
  }
  return route.continue();
});

const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
const text = sel => page.locator(sel).allInnerTexts().then(t => t.join('\n'));
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
const stage = async (label, plugin, name) => {
  console.log(`\n== ${label} ==`);
  mock[plugin] = name ? scenario(name, plugin) : null;
  tick = null;
  await refresh();
  if (shots) await page.screenshot({ path: path.join(shots, `${plugin}-${label.replace(/\W+/g, '-')}.png`), fullPage: true });
};
const portClass = async name => (await page.locator(`.port:has(.pname:text-is("${name}"))`).first().getAttribute('class')) ?? '';

await page.goto(baseUrl);
await page.fill('input[name=password]', password);
await page.click('button[type=submit]');
await page.waitForSelector('.tile');

//#region Wired network page
await page.click('a[href="#network"]');
await page.waitForSelector('.port');

console.log('== live router (pass-through) ==');
const livePorts = await page.locator('.port').count();
check(livePorts >= 5, 'port tiles drawn from the live router', String(livePorts));
check(await page.locator('.br-card').count() === 0 && await page.locator('.layers-table').count() === 0, 'bridges and layers are not on this page any more');
check(/^\d+ \/ \d+$/.test(await tile(0)), 'ports-linked tile', await tile(0));
const liveLinked = await tile(0);

await stage('a link goes down', 'network', 'n-linkdown');
check((await portClass('lan1')).includes('down'), 'lan1 turns into a down tile', await portClass('lan1'));
check(await tile(0) !== liveLinked || (await portClass('lan1')).includes('down'), 'ports-linked tile follows');
const noLink = page.locator('.port-table tr:has(strong:text-is("lan1")) .fl-badge:text-is("no link")');
check(await noLink.count() === 1 && !/danger|warning/.test(await noLink.getAttribute('class')), 'a missing link is a neutral tag, not an error colour', await noLink.getAttribute('class'));
check(await page.locator('.port-table tr:has(strong:text-is("lan1")) .dot.idle').count() === 1 && await page.locator('.port-table tr:has(strong:text-is("lan1")) .dot.down').count() === 0, 'its status dot is grey, not red');

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
check(/MT7531/.test(await text('.topo-box.chip')) && /CPU port 6/.test(await text('.vl-cap')), 'topology shows the switch chip and its CPU port');
check((await page.locator('.topo .swnum').allInnerTexts()).join() === '5,0,1,2,3', 'switch port numbers under the chip, in jack order', (await page.locator('.topo .swnum').allInnerTexts()).join());
check((await page.locator('.topo .port .pname').allInnerTexts()).join() === 'lan1,lan2,lan3,lan4,lan5,eth1' && /WAN/.test(await text('.topo .port:has(.pname:text-is("eth1")) .prole')), 'jacks follow the board order with LAN/WAN labels');
check(await page.locator('.topo-box.phy').count() === 2 && /RTL8221B/.test(await text('.topo-box.phy')), 'external PHYs drawn for lan1 and eth1');

await stage('another router: four LAN ports, no external PHY', 'network', 'n-board');
check((await page.locator('.topo .port .pname').allInnerTexts()).join() === 'lan4,lan3,lan2,lan1,eth1', 'jack order follows the other board', (await page.locator('.topo .port .pname').allInnerTexts()).join());
check(/Other Router/.test(await text('.topo-soc')) && await page.locator('.topo-box.phy').count() === 1, 'model name and PHYs follow the data');

await stage('a router without a switch', 'network', 'n-nodsa');
check(await page.locator('.topo-box.chip').count() === 0 && await page.locator('.topo .port').count() === 2, 'no switch chip, two plain MAC columns', `${await page.locator('.topo-box.chip').count()} / ${await page.locator('.topo .port').count()}`);

await stage('back to normal again', 'network', 'base');
check(await page.locator('.port').count() === livePorts, 'ports are back');

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

await stage('a radio goes down', 'radio', 'r-down');
check(await page.locator('.rd-card.is-down').count() === 1, 'one radio card switches to the down style');
check(/not running/.test(await text('.rd-find')), 'findings explain it', await text('.rd-find'));

await stage('DFS availability check', 'radio', 'r-dfs');
check(/radar channel availability check/.test(await text('.rd-find')), 'DFS wait is explained', await text('.rd-find'));

await stage('channel change', 'radio', 'r-channel');
check(/Running on channel 11 but configured for 6/.test(await text('.rd-find')), 'channel mismatch reported', await text('.rd-find'));
check(await page.locator('.chn.cur:text-is("11")').count() === 1, 'channel strip highlights the new channel');

await stage('radio disabled', 'radio', 'r-disabled');
check(/disabled in the configuration/.test(await text('.rd-find')), 'disabled radio explained', await text('.rd-find'));

await stage('base radios', 'radio', 'base');
const baseRows = await page.locator('.rd-card').first().locator('tbody tr').count();
await stage('new SSID', 'radio', 'r-newssid');
check(await page.locator('.rd-card').first().locator('tbody tr').count() === baseRows + 1, 'new SSID row appears', String(baseRows));
check(/guest is an open network/.test(await text('.rd-find')), 'open network warned about', await text('.rd-find'));

console.log('\n== live channel utilisation ==');
mock.radio = scenario('base', 'radio');
tick = (plugin, d) => { if (plugin === 'radio') for (const r of d.radios) if (r.survey) { r.survey.active += 1000; r.survey.busy += 250; r.survey.rx += 100; r.survey.tx += 50; } };
await refresh(); await refresh(); await refresh();
check(/25\.0 %/.test(await text('.rd-air .big')), 'airtime counters become a utilisation percentage', await text('.rd-air .big'));
//#endregion

check(errors.length === 0, 'no console or page errors', errors.join(' | '));
await browser.close();
if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall Network / Wi-Fi live-update checks passed');
