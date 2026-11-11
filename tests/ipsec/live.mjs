// Live-update test for the IPsec page. A real browser opens the deployed UI; the flab.ipsec status call is
// intercepted and answered with the scenario JSON produced by the backend run, so the page can be driven
// through "tunnel down", "second IKE SA", "SA without configuration", IPv6 and a stopped daemon WITHOUT
// touching the router's tunnels. Usage: node live.mjs <dir with scenario JSON>   (env: FLAB_URL, FLAB_PASSWORD, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const password = process.env.FLAB_PASSWORD ?? 'flab';
const shots = process.env.FLAB_SHOTS;
const scenario = n => JSON.parse(fs.readFileSync(path.join(out, `${n}.json`), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));

let failed = 0;
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

let current = null;   // null = pass through to the real router
let tick = null;      // optional per-poll mutation, used to simulate traffic
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  if (current && body?.params?.[1] === 'flab.ipsec' && body?.params?.[2] === 'status') {
    if (tick) tick(current);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, current] }) });
  }
  return route.continue();
});

const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
const cards = () => page.locator('.vpn-card').count();
const text = () => page.locator('main').innerText();
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
const stage = async (label, data) => { console.log(`\n== ${label} ==`); current = data; tick = null; await refresh(); if (shots) await page.screenshot({ path: path.join(shots, `ipsec-${label.replace(/\W+/g, '-')}.png`) }); };

await page.goto(baseUrl);
await page.fill('input[name=password]', password);
await page.click('button[type=submit]');
await page.waitForSelector('.tile');
await page.click('a[href="#ipsec"]');
await page.waitForSelector('.vpn-card');

console.log('== live router (pass-through) ==');
check(await cards() === 4, '4 connection cards from the live router', String(await cards()));
check(await tile(0) === '4 / 4', 'tunnels tile 4 / 4', await tile(0));

await stage('a tunnel goes down', scenario('down'));
check(await tile(0) === '3 / 4', 'tunnels tile updates to 3 / 4', await tile(0));
check(await page.locator('.vpn-card.is-down').count() === 1 && await cards() === 4, 'exactly one card switches to the down style');
check(/Tunnel is not established/.test(await page.locator('.vpn-card.is-down').innerText()), 'its flow diagram says the tunnel is not established');

await stage('a second IKE SA appears', scenario('multi'));
check(await cards() === 5 && await tile(0) === '5 / 5', 'five cards, tunnels tile 5 / 5', `${await cards()} / ${await tile(0)}`);
check(await page.locator('.vpn-head :text("IKE SA #900")').count() === 1, 'the extra IKE SA is labelled with its id');

await stage('SAs without configuration', scenario('orphan'));
check(await page.locator('.vpn-head :text("Not in configuration")').count() === 1, 'one card is flagged "Not in configuration"');
check(await page.locator(':text("(not in configuration)")').count() >= 2, 'orphan child tunnels are labelled', String(await page.locator(':text("(not in configuration)")').count()));
check(/not in the loaded configuration/.test(await page.locator('.vpn-card:has(.vpn-head :text("Not in configuration")) .warnings').innerText()), 'the card explains why it cannot be fully rated');

await stage('child rekey overlap', scenario('rekey'));
check(await page.locator(':text("2 SAs (rekeying)")').count() === 1, 'the rekey overlap is announced on the tunnel');
check(await page.locator('.vpn-head :text("Not in configuration")').count() === 0, 'orphan flags are gone again once the configuration is whole');

await stage('IPv6 on the xfrm interface', scenario('ipv6'));
const body6 = await text();
check(/IPv6 address/.test(body6) && body6.includes('fd00:ab::1/64') && body6.includes('fd00:cd::1 ⇄ fd00:cd::2'), 'global IPv6 addresses are shown');

await stage('charon stopped', scenario('daemondown'));
check(await cards() === 0 && /No IPsec connections are configured/.test(await text()), 'no cards and an empty-state message');
check(/charon is not running/.test(await text()), 'daemon card reports charon is not running');

await stage('back to normal', scenario('base'));
check(await cards() === 4 && await tile(0) === '4 / 4', 'everything is back after the daemon returns', `${await cards()} / ${await tile(0)}`);

console.log('\n== live throughput ==');
const traffic = clone(scenario('base'));
current = traffic;
tick = d => { for (const c of d.connections) for (const ch of c.children) for (const sa of ch.sas) if (sa.iface) { sa.iface.rx_bytes += 5_000_000; sa.iface.tx_bytes += 1_000_000; } };
await refresh(); await refresh(); await refresh();
check((await tile(2)).startsWith('↓') && !/^↓ 0 ?b/i.test(await tile(2)) && !(await tile(2)).includes('–'), 'throughput tile shows a measured rate', await tile(2));
check(await page.locator('.vpn-card .rate b').first().innerText() !== '–', 'per-tunnel rate is shown');

check(errors.length === 0, 'no console or page errors', errors.join(' | '));
await browser.close();
if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall IPsec live-update checks passed');
