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

const mock = { network: null, radio: null };   // null = pass through to the real router
let tick = null;                                // optional per-poll mutation, used to simulate traffic and airtime
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  const plugin = body?.params?.[1] === 'flab.network' ? 'network' : body?.params?.[1] === 'flab.radio' ? 'radio' : null;
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

//#region Network page
await page.click('a[href="#network"]');
await page.waitForSelector('.port');

console.log('== live router (pass-through) ==');
const livePorts = await page.locator('.port').count();
check(livePorts >= 5, 'port tiles drawn from the live router', String(livePorts));
check(await page.locator('.br-card').count() >= 1, 'bridge card drawn');
check(/^\d+ \/ \d+$/.test(await tile(0)), 'ports-linked tile', await tile(0));
const liveLinked = await tile(0);

await stage('a link goes down', 'network', 'n-linkdown');
check((await portClass('lan1')).includes('down'), 'lan1 turns into a down tile', await portClass('lan1'));
check(await tile(0) !== liveLinked || (await portClass('lan1')).includes('down'), 'ports-linked tile follows');
const noLink = page.locator('.port-table tr:has(strong:text-is("lan1")) .fl-badge:text-is("no link")');
check(await noLink.count() === 1 && !/danger|warning/.test(await noLink.getAttribute('class')), 'a missing link is a neutral tag, not an error colour', await noLink.getAttribute('class'));
check(await page.locator('.port-table tr:has(strong:text-is("lan1")) .dot.idle').count() === 1 && await page.locator('.port-table tr:has(strong:text-is("lan1")) .dot.down').count() === 0, 'its status dot is grey, not red');

await stage('a port logs errors', 'network', 'n-errors');
check(/MT7531 PHY/.test(await text('.port:has(.pname:text-is("lan2")) .phw')), 'port tile shows the PHY chipset', await text('.port:has(.pname:text-is("lan2")) .phw'));
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

await stage('this bridge becomes STP root', 'network', 'n-root');
check(await page.locator('.br-stp.root').count() === 1 && /spanning-tree root/.test(await text('.br-stp.root')), 'bridge card says it is the root');
check(await tile(3) === 'Root', 'spanning-tree tile reads Root', await tile(3));

await stage('blocked port and topology change', 'network', 'n-blocked');
check(/blocked by spanning tree/.test(await text('.net-health')), 'health banner reports the blocked port', await text('.net-health'));
check(/topology change/.test(await text('.br-head')), 'bridge header shows the topology change');

await stage('STP switched off', 'network', 'n-nostp');
check(/STP off/.test(await text('.br-head')) && await page.locator('.br-stp.off').count() === 1, 'bridge shows STP off');

await stage('second bridge appears', 'network', 'n-newbridge');
check(await page.locator('.br-card').count() === 2 && /br-guest/.test(await text('.br-card')), 'a second bridge card appears');

await stage('router reports no devices', 'network', 'n-nodevices');
check(await page.locator('.port').count() === 0 && await tile(0) === '0 / 0', 'page copes with an empty device list', await tile(0));

await stage('back to normal', 'network', 'base');
check(await page.locator('.port').count() === livePorts, 'ports are back');

console.log('\n== live throughput ==');
mock.network = scenario('base', 'network');
tick = (plugin, d) => { if (plugin === 'network') for (const p of d.ports) { p.stats.rx_bytes += 5_000_000; p.stats.tx_bytes += 1_000_000; } };
await refresh(); await refresh(); await refresh();
check(/^↓ [1-9]/.test(await tile(1)) && !/0 bit/.test((await tile(1)).split('\n')[0]), 'throughput tile shows a measured rate', await tile(1));
check(/Mbit\/s/.test(await text('.port.up .prate')), 'port tiles show live rates', await text('.port.up .prate'));
//#endregion

//#region Wi-Fi page
await page.click('a[href="#wifi"]');
await page.waitForSelector('.rd-card');

console.log('\n== live router (pass-through) ==');
check(await page.locator('.rd-card').count() >= 1, 'radio cards drawn from the live router');
check(await page.locator('.rd-card table tbody tr').count() >= 1, 'interfaces listed');

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

await stage('new SSID', 'radio', 'r-newssid');
check(await page.locator('.rd-card').first().locator('tbody tr').count() === 3, 'new SSID row appears');
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
