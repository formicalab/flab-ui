// Live-update test for the BGP page. A real browser opens the deployed UI; the flab.bgp status call is
// intercepted and answered with the scenario JSON produced by the backend run, so the page can be driven
// through "peer down", IPv6, changed announcements and peer add/remove WITHOUT touching the router's BGP.
// Usage: node live.mjs <dir with scenario JSON>   (env: FLAB_SID, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;   // a session made by tests/TestSession.ps1, so no password is needed
const acls = JSON.parse(process.env.FLAB_ACLS);   // what that session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;
// Loads one backend scenario (see mkfx.mjs / assert.mjs) as the object the page would receive from flab.bgp status.
const scenario = n => JSON.parse(fs.readFileSync(path.join(out, `${n}.json`), 'utf8'));
// Deep copy, so derived scenarios never mutate the baseline.
const clone = o => JSON.parse(JSON.stringify(o));

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

// Derived scenarios built from the captured baseline.
const base = scenario('base');
// Returns a copy of `d` without the named peer and the paths learned from it.
const dropPeer = (d, name) => { const c = clone(d); c.peers = c.peers.filter(p => p.name !== name); c.paths = c.paths.filter(p => p.peer !== name); return c; };
// Returns a copy of `d` with a new peer cloned from peer `from` (same channels), plus non-best copies of its paths.
const addPeer = (d, name, from) => {
  const c = clone(d);
  const src = c.peers.find(p => p.name === from);
  c.peers.push({ ...clone(src), name, description: `Added peer ${name}`, neighbor: '10.9.9.9' });
  for (const p of c.paths.filter(p => p.peer === from)) c.paths.push({ ...clone(p), peer: name, best: false });
  return c;
};
// Eight peers (the baseline's four plus four clones of azure_xfrm0): more peers than the six palette colors.
const manyPeers = ['x1', 'x2', 'x3', 'x4'].reduce((d, n) => addPeer(d, n, 'azure_xfrm0'), base);

let current = null;   // null = pass through to the real router
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// Answers the page's flab.bgp status ubus call with the current scenario; everything else goes to the real router.
await page.route('**/ubus', async route => {
  const req = route.request();
  let body = null;
  try { body = req.postDataJSON(); } catch { /* not JSON */ }
  if (current && body?.params?.[1] === 'flab.bgp' && body?.params?.[2] === 'status') {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, current] }) });
  }
  return route.continue();
});

// Maps each topology peer's name to its palette class (pc-N), to verify colors stay stable across updates.
const colors = () => page.$$eval('.bgp-peer', els => Object.fromEntries(els.map(e => [e.querySelector('b').title, [...e.classList].find(c => c.startsWith('pc-'))])));
// Text of the i-th summary tile's value.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// Texts of the health-card findings.
const findings = () => page.locator('.findings li').allInnerTexts();
// Clicks Refresh and waits for the page to re-render.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
// Switches the intercepted backend response to `data` (null = real router) and refreshes the page.
const stage = async (label, data) => { console.log(`\n== ${label} ==`); current = data; await refresh(); };

// Start signed in, the way a real sign-in leaves the tab: the session id and its ACLs in sessionStorage.
await page.addInitScript(([id, granted]) => {
  sessionStorage.setItem('sid', id);
  sessionStorage.setItem('acls', JSON.stringify(granted));
}, [sid, acls]);
await page.goto(baseUrl);
await page.waitForSelector('.tile');
await page.click('a[href="#bgp"]');
await page.waitForSelector('.bgp-card');

console.log('== live router (pass-through) ==');
const liveColors = await colors();
check(Object.keys(liveColors).length === 4, '4 peers drawn from the live router');
check(await tile(0) === '4 / 4', 'sessions tile 4 / 4', await tile(0));
const baseline = { ...liveColors };

await stage('a peer goes down', scenario('down'));
check(await tile(0) === '3 / 4', 'sessions tile updates to 3 / 4', await tile(0));
check(await page.locator('.bgp-peer.is-down').count() === 1, 'topology marks exactly one peer down');
check(await page.locator('.bgp-links .link.down').count() >= 1, 'its connector turns into a dashed "down" link');
check(await page.locator('.bgp-card.is-down').count() === 1, 'peer card switches to the down style');
const cardText = await page.locator('.bgp-card.is-down').innerText();
check(/Active/.test(cardText) && /Connection refused/.test(cardText) && /Next connect attempt/.test(cardText), 'down card shows state, last error and retry timer', cardText.slice(0, 200));
check(/No capabilities negotiated/.test(cardText), 'capability table degrades gracefully');
check((await findings()).some(t => /azure_xfrm1 is Active/.test(t)), 'health card reports the down peer', (await findings()).join(' | '));
check(await page.locator('.routes-table tbody tr').count() === 30, 'learned routes drop to 30 paths', String(await page.locator('.routes-table tbody tr').count()));
const afterDown = await colors();
check(Object.entries(baseline).every(([n, c]) => afterDown[n] === c), 'peer colors unchanged while a peer is down', JSON.stringify(afterDown));

await stage('dual-stack with IPv6 routes', scenario('dual'));
check(await page.locator('.bgp-card').first().locator('.blk h3', { hasText: 'Routing' }).count() === 2, 'first peer card shows two routing blocks (ipv4 + ipv6)');
const routeTexts = await page.locator('.routes-table tbody tr td:first-child').allInnerTexts();
const firstV6 = routeTexts.findIndex(t => t.includes(':'));
const lastV4 = routeTexts.map(t => !t.includes(':')).lastIndexOf(true);
check(firstV6 > lastV4 && firstV6 > 0, 'IPv4 prefixes sort before IPv6 prefixes', `firstV6=${firstV6} lastV4=${lastV4}`);
const table = await page.locator('.routes-table').innerText();
check(/not in kernel/.test(table), 'best IPv6 route missing from the kernel is flagged in the table');
check((await findings()).some(t => /2001:db8:300::\/48/.test(t)), 'health card lists the missing IPv6 prefix', (await findings()).join(' | '));
check(/static2/.test(await page.locator('.card', { hasText: 'BIRD protocols' }).innerText()), 'new IPv6 static protocol appears');
check(/master6/.test(await page.locator('.card', { hasText: 'BIRD protocols' }).innerText()), 'protocol table shows the master6 table');
const chips = await page.locator('.bgp-node.router .alg-chip').allInnerTexts();
check(chips.includes('2001:db8:f00d::/48') && chips.includes('192.168.0.0/16'), 'router node announces both IPv4 and IPv6 prefixes', chips.join());

await stage('announcements change', scenario('announce'));
const chips2 = await page.locator('.bgp-node.router .alg-chip').allInnerTexts();
check(chips2.includes('10.0.0.12/32') && chips2.includes('192.168.50.0/24') && chips2.includes('192.168.0.0/16'), 'router node follows announcements from direct and ospf protocols too', chips2.join());
const matrixRows = await page.locator('.card', { hasText: 'Announced routes' }).locator('tbody tr').first().innerText();
check(await page.locator('.card', { hasText: 'Announced routes' }).locator('thead th').count() >= 6, 'matrix has a column per peer');
check((await findings()).some(t => /azure_xfrm3/.test(t) && /announcement/.test(t)), 'health card warns that one peer receives nothing', (await findings()).join(' | '));
check(await page.locator('.card', { hasText: 'Announced routes' }).locator('tbody tr').count() >= 4, 'matrix lists the changed prefix set');

await stage('a peer is removed', dropPeer(base, 'azure_xfrm1'));
const rm = await colors();
check(Object.keys(rm).length === 3 && !('azure_xfrm1' in rm), 'topology drops the removed peer');
check(['azure_xfrm0', 'azure_xfrm2', 'azure_xfrm3'].every(n => rm[n] === baseline[n]), 'remaining peers keep their colors', JSON.stringify(rm));
const opts = await page.locator('select option').allInnerTexts();
check(!opts.includes('azure_xfrm1') && opts.includes('azure_xfrm0'), 'peer dropdown follows the peer list', opts.join());

await stage('a peer is added', addPeer(dropPeer(base, 'azure_xfrm1'), 'azure_new', 'azure_xfrm0'));
const added = await colors();
check(Object.keys(added).length === 4 && 'azure_new' in added, 'topology shows the new peer');
check(['azure_xfrm0', 'azure_xfrm2', 'azure_xfrm3'].every(n => added[n] === baseline[n]), 'existing peers still keep their colors', JSON.stringify(added));
check(added.azure_new === baseline.azure_xfrm1, 'the new peer takes the freed color', JSON.stringify(added));
check((await page.locator('select option').allInnerTexts()).includes('azure_new'), 'dropdown lists the new peer');
check(await page.locator('.bgp-card').count() === 4, 'a card is created for the new peer');

await stage('eight peers (more peers than colors)', manyPeers);
const many = await colors();
check(Object.keys(many).length === 8 && Object.values(many).every(c => /^pc-[0-5]$/.test(c)), '8 peers render with colors from the palette', JSON.stringify(many));
check(['azure_xfrm0', 'azure_xfrm1', 'azure_xfrm2', 'azure_xfrm3'].every(n => many[n] === baseline[n] || n === 'azure_xfrm1'), 'earlier peers are not recolored', JSON.stringify(many));
check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow with 8 peers');

console.log('\n== back to the live router ==');
current = null;
await refresh();
check(await tile(0) === '4 / 4' && Object.keys(await colors()).length === 4, 'page returns to the live state (4 / 4)');
check(errors.length === 0, 'no console or page errors during the whole run', errors.join(' | '));

if (shots) await page.screenshot({ path: path.join(shots, 'bgp-final.png') });
await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall live-update checks passed');
process.exit(failed ? 1 : 0);
