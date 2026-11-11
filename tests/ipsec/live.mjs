// Live-update test for the IPsec page. A real browser opens the deployed UI; the flab.ipsec status call is
// intercepted and answered with the scenario JSON produced by the backend run, so the page can be driven
// through "tunnel down", "second IKE SA", "SA without configuration", IPv6 and a stopped daemon WITHOUT
// touching the router's tunnels. Usage: node live.mjs <dir with scenario JSON>   (env: FLAB_SID, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;   // a session made by tests/TestSession.ps1, so no password is needed
const acls = JSON.parse(process.env.FLAB_ACLS);   // what that session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;
// Loads one backend scenario (see mkfx.mjs / assert.mjs) as the object the page would receive from flab.ipsec status.
const scenario = n => JSON.parse(fs.readFileSync(path.join(out, `${n}.json`), 'utf8'));
// Deep copy, so a mutating `tick` never alters the loaded scenario.
const clone = o => JSON.parse(JSON.stringify(o));

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

let current = null;   // null = pass through to the real router
let tick = null;      // optional per-poll mutation, used to simulate traffic
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// Answers the page's flab.ipsec status ubus call with the current scenario (after the optional tick); everything else goes to the real router.
await page.route('**/ubus', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { /* not JSON */ }
  if (current && body?.params?.[1] === 'flab.ipsec' && body?.params?.[2] === 'status') {
    if (tick) tick(current);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, current] }) });
  }
  return route.continue();
});

// Text of the i-th summary tile's value.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// Number of connection cards currently drawn.
const cards = () => page.locator('.vpn-card').count();
// Full text of the page body.
const text = () => page.locator('main').innerText();
// Clicks Refresh and waits for the page to re-render.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
// Switches the intercepted backend response to `data`, clears any tick, refreshes and optionally saves a screenshot.
const stage = async (label, data) => { console.log(`\n== ${label} ==`); current = data; tick = null; await refresh(); if (shots) await page.screenshot({ path: path.join(shots, `ipsec-${label.replace(/\W+/g, '-')}.png`) }); };

// Start signed in, the way a real sign-in leaves the tab: the session id and its ACLs in sessionStorage.
await page.addInitScript(([id, granted]) => {
  sessionStorage.setItem('sid', id);
  sessionStorage.setItem('acls', JSON.stringify(granted));
}, [sid, acls]);
await page.goto(baseUrl);
await page.waitForSelector('.tile');
await page.click('a[href="#ipsec"]');
await page.waitForSelector('.vpn-card');

console.log('== live router (pass-through) ==');
check(await cards() === 4, '4 connection cards from the live router', String(await cards()));
check(await tile(0) === '4 / 4', 'tunnels tile 4 / 4', await tile(0));
check(await page.evaluate(() => { const A = document.querySelector('details.legend'), B = document.querySelector('.vpn-grid'); return !!A && !!B && !!(A.compareDocumentPosition(B) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'the score explanation sits above the connection cards');

await stage('a tunnel goes down', scenario('down'));
check(await tile(0) === '3 / 4', 'tunnels tile updates to 3 / 4', await tile(0));
check(await page.locator('.vpn-card.is-down').count() === 1 && await cards() === 4, 'exactly one card switches to the down style');
check(/Tunnel is not established/.test(await page.locator('.vpn-card.is-down').innerText()), 'its flow diagram says the tunnel is not established');

await stage('a second IKE SA appears', scenario('multi'));
check(await cards() === 5 && await tile(0) === '5 / 5', 'five cards, tunnels tile 5 / 5', `${await cards()} / ${await tile(0)}`);
check(await page.locator('.vpn-head :text("IKE SA #900")').count() === 1, 'the extra IKE SA is labeled with its id');

await stage('SAs without configuration', scenario('orphan'));
check(await page.locator('.vpn-head :text("Not in configuration")').count() === 1, 'one card is flagged "Not in configuration"');
check(await page.locator(':text("(not in configuration)")').count() >= 2, 'orphan child tunnels are labeled', String(await page.locator(':text("(not in configuration)")').count()));
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
check(await page.locator('.card-body.text-danger:has-text("charon is not running")').count() === 1, 'with connections configured the message is an error');

await stage('charon stopped, nothing configured', scenario('unconfigured'));
check(/no connection is configured/.test(await text()) && await page.locator('.text-danger').count() === 0, 'with nothing configured the message is a plain note, not an error');

await stage('back to normal', scenario('base'));
check(await cards() === 4 && await tile(0) === '4 / 4', 'everything is back after the daemon returns', `${await cards()} / ${await tile(0)}`);

console.log('\n== live throughput ==');
const traffic = clone(scenario('base'));
current = traffic;
// Each poll adds 5 MB rx / 1 MB tx to every SA's interface counters, so the page can derive a non-zero rate.
tick = d => { for (const c of d.connections) for (const ch of c.children) for (const sa of ch.sas) if (sa.iface) { sa.iface.rx_bytes += 5_000_000; sa.iface.tx_bytes += 1_000_000; } };
await refresh(); await refresh(); await refresh();
check((await tile(2)).startsWith('↓') && !/^↓ 0 ?b/i.test(await tile(2)) && !(await tile(2)).includes('–'), 'throughput tile shows a measured rate', await tile(2));
check(await page.locator('.vpn-card .rate b').first().innerText() !== '–', 'per-tunnel rate is shown');

check(errors.length === 0, 'no console or page errors', errors.join(' | '));
await browser.close();
if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall IPsec live-update checks passed');
