// Live-update test for the BGP tab of the Routing page. A real browser opens the deployed UI; the flab.bgp status call is
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
// The actions the page asked for (they are never sent to the router: a restart would drop a real BGP session), the reply to give
// them, and a time to put on the configuration file's reply to simulate a file changed after BIRD read it (null = unchanged).
const actions = [];
let actionReply = null;
let fileModified = null;
const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

// Answers the page's flab.bgp status ubus call with the current scenario and every action with a canned reply; the configuration
// file and its check are the real router's (read only). Everything else goes to the real router.
let realConfigText = '';
await page.route('**/ubus', async route => {
  const req = route.request();
  let body = null;
  try { body = req.postDataJSON(); } catch { /* not JSON */ }
  const [, object, method, args] = body?.params ?? [];
  const reply = result => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [0, result] }) });
  if (object === 'flab.bgp' && method === 'action') {
    actions.push(args);
    return reply(actionReply ?? { name: args.name, action: args.action, ok: true, output: `${args.name}: done (mock)`, error: null });
  }
  if (current && object === 'flab.bgp' && method === 'status') return reply(current);
  if (object === 'flab.bgp' && method === 'config') {
    const real = await (await route.fetch()).json();
    realConfigText = real.result?.[1]?.text ?? realConfigText;
    return reply(fileModified != null ? { ...real.result[1], mtime: fileModified } : real.result[1]);
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
await page.waitForSelector('.cmdbar h1');
await page.click('a[href="#routing"]');
await page.click('.seg-tab:has-text("BGP")');
await page.waitForSelector('.bgp-card');

console.log('== live router (pass-through) ==');
const liveColors = await colors();
check(Object.keys(liveColors).length === 4, '4 peers drawn from the live router');
check(await tile(0) === '4 / 4', 'sessions tile 4 / 4', await tile(0));
const baseline = { ...liveColors };

console.log('\n== configuration file (read only) ==');
const cfgCard = page.locator('.card', { has: page.locator('.card-header', { hasText: 'BIRD configuration' }) });
check(await cfgCard.count() === 1 && await cfgCard.evaluate(e => e.classList.contains('fl-folded')), 'the configuration card is there, folded at first');
await cfgCard.locator('.card-header').click();
check(await cfgCard.locator('.cfg-line').count() >= 170 && /router id 192\.168\.1\.1/.test(await cfgCard.innerText()), 'unfolded, it shows the file with line numbers');
const chipsText = await cfgCard.locator('.cfg-chip').allInnerTexts();
check(chipsText.includes('template azure_vwan') && chipsText.includes('azure_xfrm0') && chipsText.includes('filter bgp_azure_import'), 'the block index lists protocols, template and filters', chipsText.join());
await cfgCard.locator('.cfg-chip', { hasText: 'azure_xfrm1' }).click();
const hit = await page.locator('.cfg-hit').allInnerTexts();
check(hit.length >= 5 && hit.length <= 8 && hit.some(t => /10\.0\.0\.13/.test(t)), 'a click on a block highlights its lines', hit.join(' | '));
check(await page.evaluate(() => { const b = document.querySelector('.cfg-code'); return b.scrollTop > 0; }), 'and scrolls the file to them');
await page.click('#bgp-cfg-check');
await page.waitForSelector('.cfg-check.ok, .cfg-check.bad');
check(await page.locator('.cfg-check.ok').count() === 1 && /accepts this configuration/.test(await page.locator('.cfg-check').innerText()), 'Check asks BIRD to parse the file and reports that it is accepted', await page.locator('.cfg-check').innerText());
await page.waitForTimeout(6000);
check(await page.locator('.cfg-check.ok').count() === 1 && await page.locator('.cfg-line').count() >= 170 && await page.locator('.cfg-hit').count() > 0, 'the outcome, the highlight and the file survive the redraw of a poll');
await page.click('#bgp-cfg-outcome-close');
check(await page.locator('.cfg-check').count() === 0 && await page.locator('.cfg-line').count() >= 170, 'the check outcome can be closed, and the file stays');
await page.waitForTimeout(6000);
check(await page.locator('.cfg-check').count() === 0, 'a closed outcome does not come back with the next poll');

console.log('\n== where a peer comes from ==');
const peerCfg = page.locator('.bgp-card').first().locator('.blk', { has: page.locator('h3', { hasText: 'Configuration' }) });
check(await peerCfg.count() === 1 && /azure_vwan/.test(await peerCfg.innerText()) && /lines 14\d–14\d/.test(await peerCfg.innerText()), 'each peer card names its template and its lines in the file', await peerCfg.innerText());
await peerCfg.locator('summary', { hasText: 'Protocol block' }).click();
check(/neighbor 10\.0\.0\.12 as AZURE_AS/.test(await peerCfg.locator('pre').first().innerText()), 'the protocol block source is shown', await peerCfg.locator('pre').first().innerText());
await peerCfg.locator('summary', { hasText: 'Filter bgp_azure_export' }).click();
check(/net = 192\.168\.0\.0\/16/.test(await peerCfg.locator('pre').last().innerText()), 'and the source of its export filter');
await page.waitForTimeout(6000);
check(await peerCfg.locator('details[open]').count() === 2, 'the open folds stay open across a poll');

console.log('\n== protocol filters ==');
const protoCard = page.locator('.card', { has: page.locator('.card-header', { hasText: 'BIRD protocols' }) });
check((await cfgCard.boundingBox()).y < (await protoCard.boundingBox()).y, 'the configuration card sits above the BIRD protocols card');
const importChip = protoCard.locator('button.cfg-chip-link', { hasText: 'bgp_azure_import' }).first();
const importTip = await importChip.getAttribute('title');
check(/Import filter: applied to every route received from the peer/.test(importTip) && /Validate every prefix received from an Azure Virtual WAN peer\./.test(importTip), 'a named filter explains itself: what an import filter is, then its own comment from the file', importTip);
check(/Export filter: decides which routes of the table are announced to the peer/.test(await protoCard.locator('button.cfg-chip-link', { hasText: 'bgp_azure_export' }).first().getAttribute('title')), 'the export filter says it decides what is announced');
check(/does not decide what BGP peers are sent/.test(await protoCard.locator('table .alg-chip', { hasText: 'REJECT' }).first().getAttribute('title')) || /does not decide what BGP peers are sent/.test(await protoCard.locator('tr', { hasText: 'direct1' }).first().locator('.alg-chip').last().getAttribute('title')), 'a Direct or Static REJECT says it is not what BGP peers are sent');
check(/imports all routes \(except for external BGP\)/.test(await protoCard.locator('#bgp-flow-caption').innerText()) && /exports none \(except for external BGP and L3VPN\)/.test(await protoCard.locator('#bgp-flow-caption').innerText()), 'the diagram\'s caption says where ACCEPT · REJECT come from: the defaults of the BIRD guide');
check(/ACCEPT lets every route through/.test(await protoCard.locator('table .alg-chip', { hasText: 'ACCEPT' }).first().getAttribute('title')), 'ACCEPT explains itself');
check(/RFC 8212/.test(await protoCard.locator('.bgp-legend').innerText()) && /import.*export/s.test(await protoCard.locator('.bgp-legend').innerText()), 'a legend above the table says what in and out mean');
const typeNames = await protoCard.locator('.bgp-types dt').allInnerTexts();
check(typeNames.join() === 'Kernel,Device,Direct,Static,BGP' && /BGP[\s\S]*One session with one neighbor/.test(await protoCard.locator('.bgp-types').innerText()), 'and explains each protocol type the router runs, once', typeNames.join());
check(/RFC 8212/.test(await protoCard.locator('.bgp-types dd', { hasText: 'One session with one neighbor' }).innerText()) && await protoCard.locator('.bgp-note').evaluate(e => getComputedStyle(e).textDecorationLine.includes('underline')), 'the RFC 8212 remark is part of the BGP type description, underlined');
check(await protoCard.locator('.bgp-types').count() === 1 && (await protoCard.locator('.bgp-legend').innerText()).split('RFC 8212').length === 2, 'and it appears only there');
check(/RFC 8212/.test(await protoCard.locator('tbody td span[title]', { hasText: 'BGP' }).first().getAttribute('title')), 'the BGP Type cell\'s tooltip has it too');
check(/Linux routing table/.test(await protoCard.locator('tbody td span[title]', { hasText: 'Kernel' }).first().getAttribute('title')), 'a Type cell carries the same explanation as a tooltip');
check(await protoCard.locator('.bgp-legend').evaluate(e => e.getBoundingClientRect().bottom <= e.parentElement.querySelector('table').getBoundingClientRect().top + 1), 'and it comes before the list');
check(await protoCard.locator('table.table-hover > thead th[title]').count() === 8, 'every column heading has a tooltip');
await importChip.click();
await page.waitForTimeout(300);
check(!(await cfgCard.evaluate(e => e.classList.contains('fl-folded'))) && (await page.locator('.cfg-hit').allInnerTexts()).some(t => /filter bgp_azure_import/.test(t)), 'a click on a filter chip opens the configuration at that filter');

console.log('\n== the flow diagram ==');
const flowSvg = protoCard.locator('#bgp-flow');
check(await flowSvg.count() === 1 && (await flowSvg.boundingBox()).y < (await protoCard.locator('table.table-hover').boundingBox()).y, 'the diagram is in the protocols card, above the table');
check(await flowSvg.locator('.flow-lane').count() === 5 && await flowSvg.locator('.flow-lane', { hasText: '×4' }).count() === 1, 'one lane per protocol, the four BGP sessions in one lane');
check(await flowSvg.locator('.flow-table', { hasText: 'master4' }).count() === 1 && /45 routes/.test((await flowSvg.locator('.flow-table text').allTextContents()).join(' ')), 'the routing table master4 with the routes it holds');
const outsideTitles = await flowSvg.locator('.flow-outside .flow-title').allTextContents();
check(outsideTitles.join() === 'Linux kernel,Network interfaces,AS 65515', 'outside BIRD: the kernel, the interfaces and the neighbors', outsideTitles.join());
check(await flowSvg.locator('.flow-edge').count() === 8 && await flowSvg.locator('.flow-edge.blocked').count() === 3, 'eight edges, three of them blocked (kernel import, direct and static export)');
const tagTexts = await flowSvg.locator('.flow-tag text').allTextContents();
check(tagTexts.includes('→ bgp_azure_import') && tagTexts.includes('← bgp_azure_export') && tagTexts.includes('← accept all') && tagTexts.filter(t => /default/.test(t)).length === 4, 'the tags name the filters and mark the four defaults', tagTexts.join(' | '));
const kernelIn = await flowSvg.locator('.flow-tag[data-edge="kernel1:ipv4:in"] text').textContent();
check(kernelIn === '→ reject all', 'what the file sets explicitly (kernel: import none) is not called a default', kernelIn);
const counts = (await flowSvg.locator('.flow-count').allTextContents()).join(' | ');
check(/16 routes/.test(counts) && /40 routes/.test(counts) && /1 each/.test(counts), 'the counts are on the splines (16 into the kernel, 40 imported, 1 each exported)', counts);
const tagBox = await flowSvg.locator('.flow-tag[data-edge="kernel1:ipv4:out"] rect').boundingBox();
const tableBox = await flowSvg.locator('.flow-table rect').boundingBox();
check(tableBox.x - (tagBox.x + tagBox.width) >= 0 && tableBox.x - (tagBox.x + tagBox.width) < 40, 'the filter tags of the flowing edges sit against the master4 table', `${tableBox.x} - ${tagBox.x + tagBox.width}`);
await flowSvg.locator('.flow-count', { hasText: '16 routes' }).click();
await page.waitForSelector('.fl-drawer.show');
check(/Routes exported to kernel1/.test(await page.locator('.fl-drawer-title').innerText()) && await page.locator('.bgp-edge-list tbody tr').count() === 16, 'a click on the 16 routes to the kernel lists them (what the table hands to kernel1)');
const firstListed = (await page.locator('.bgp-edge-list .link-prefix').first().innerText()).trim();
await page.locator('.bgp-edge-list .link-prefix').first().click();
await page.waitForSelector('.bgp-why-item');
check((await page.locator('.fl-drawer-title').innerText()).trim() === firstListed, 'a prefix in the list opens the explanation of how BIRD chose it', firstListed);
await page.keyboard.press('Escape');
await flowSvg.locator('.flow-count', { hasText: '40 routes' }).click();
await page.waitForSelector('.bgp-edge-list');
const importedPeers = await page.locator('.bgp-edge-list tbody tr td:nth-child(2)').allInnerTexts();
check(await page.locator('.bgp-edge-list tbody tr').count() === 40 && new Set(importedPeers.map(t => t.trim())).size === 4 && /4 sessions/.test(await page.locator('.fl-drawer-title').innerText()), 'a click on the 40 routes lists the paths of the four sessions, with their next hop and AS path');
await page.keyboard.press('Escape');
await flowSvg.locator('.flow-count[data-edge="direct1:ipv4:in"]').click();
await page.waitForSelector('.bgp-local');
check(await page.locator('.fl-drawer .bgp-local tbody tr').count() === 4 && /Routes imported from direct1/.test(await page.locator('.fl-drawer-title').innerText()), 'a click on the 4 routes of direct1 lists them');
await page.keyboard.press('Escape');
check(await flowSvg.locator('.flow-count.link').count() === 5, 'every count is a button that lists its routes');
check(/BIRD's default/.test(await flowSvg.locator('.flow-tag[data-edge="direct1:ipv4:in"] title').textContent()), 'a tag\'s tooltip explains it');
await flowSvg.locator('.flow-tag.link', { hasText: 'bgp_azure_import' }).click();
await page.waitForTimeout(300);
check(!(await cfgCard.evaluate(e => e.classList.contains('fl-folded'))) && (await page.locator('.cfg-hit').allInnerTexts()).some(t => /filter bgp_azure_import/.test(t)), 'a click on a filter tag opens the configuration at that filter');
await flowSvg.locator('.flow-lane', { hasText: '×4' }).click();
check(await flowSvg.locator('.flow-lane').count() === 8 && await flowSvg.locator('.flow-edge').count() === 14, 'a click on the group shows its four sessions with their own edges');
await page.waitForTimeout(6000);
check(await flowSvg.locator('.flow-lane').count() === 8, 'and it stays open across a poll');
await flowSvg.locator('.flow-lane', { hasText: 'azure_xfrm2' }).click();
check(await flowSvg.locator('.flow-lane').count() === 5, 'a click on one of the sessions groups them again');
await flowSvg.locator('.flow-lane', { hasText: 'direct1' }).click();
await page.waitForTimeout(400);
check(await page.locator('#bgp-row-direct1.bgp-row-flash').count() === 1, 'a click on a single protocol\'s lane goes to its row in the table and flashes it');
check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow with the diagram');

console.log('\n== routes of a protocol, under its row ==');
check(await page.locator('.card', { hasText: 'Local & connected routes' }).count() === 0, 'there is no separate card of local routes any more');
check(await protoCard.locator('#bgp-proto-direct1[aria-expanded="true"]').count() === 1 && await protoCard.locator('#bgp-proto-static1[aria-expanded="true"]').count() === 1, 'Direct and Static have an arrow and start open (few routes)');
check(await protoCard.locator('#bgp-proto-kernel1, #bgp-proto-azure_xfrm0').count() === 0, 'protocols without routes of their own have no arrow');
const nameX = await protoCard.locator('table.table-hover > tbody > tr:not(.bgp-sub) > td:first-child b').evaluateAll(bs => [...new Set(bs.map(b => Math.round(b.getBoundingClientRect().left)))]);
check(nameX.length === 1, 'every protocol name starts at the same place, so none looks like a child of another', nameX.join());
const rowHeights = await protoCard.locator('table.table-hover > tbody > tr:not(.bgp-sub)').evaluateAll(rows => rows.map(r => Math.round(r.getBoundingClientRect().height)));
check(Math.max(...rowHeights) - Math.min(...rowHeights) <= 2, 'the protocol rows have the same height with or without an arrow', rowHeights.join());
check(/Linux kernel.s routing table/.test(await protoCard.locator('.bgp-local th[title]', { hasText: 'Kernel' }).first().getAttribute('title')), 'the Kernel column of the routes says what it means');
const directRoutes = await protoCard.locator('tr.bgp-sub').nth(0).innerText();
const staticRoutes = await protoCard.locator('tr.bgp-sub').nth(1).innerText();
check(/10\.0\.0\.12\/32/.test(directRoutes) && /xfrm3/.test(directRoutes) && (directRoutes.match(/\/32/g) ?? []).length === 4, 'direct1 lists its four routes right under its row', directRoutes);
check(/192\.168\.0\.0\/16/.test(staticRoutes) && /blackhole/.test(staticRoutes), 'static1 lists the blackhole aggregate under its row', staticRoutes);
check(/5 local routes/.test(await protoCard.locator('.card-header').innerText()), 'the card header counts the local routes');
await protoCard.locator('#bgp-proto-static1').click();
check(await protoCard.locator('#bgp-proto-static1[aria-expanded="false"]').count() === 1 && await protoCard.locator('tr.bgp-sub').count() === 1, 'a click on the name hides the routes of that protocol only');
await page.waitForTimeout(6000);
check(await protoCard.locator('#bgp-proto-static1[aria-expanded="false"]').count() === 1 && await protoCard.locator('tr.bgp-sub').count() === 1, 'and it stays hidden across a poll');
await protoCard.locator('#bgp-proto-static1').click();
check(await protoCard.locator('tr.bgp-sub').count() === 2, 'and opens again');

console.log('\n== review of the configuration ==');
const reviewed = await findings();
// The router's own file decides what the review can find: a limit in it (as a hardened file has) removes that finding.
const fileHasLimit = /^\s*(import|receive) limit\b/m.test(realConfigText);
check((fileHasLimit || reviewed.some(t => /No route limit .*azure_xfrm0.*azure_xfrm3/.test(t))) && (!fileHasLimit || !reviewed.some(t => /No route limit/.test(t))) && reviewed.some(t => /No TCP authentication/.test(t)), `the health card reviews the file: ${fileHasLimit ? 'a route limit is set, so no warning about one' : 'no route limit'}, no authentication`, reviewed.join(' | '));
check(!reviewed.some(t => /changed after BIRD last read/.test(t)), 'no drift warning while BIRD has read the file');
fileModified = Math.floor(Date.now() / 1000) + 3600;
await refresh();
check((await findings()).some(t => /changed after BIRD last read/.test(t)) && /changed after BIRD read it/.test(await cfgCard.innerText()), 'a file newer than BIRD\'s last reconfiguration is reported in the findings and on the card');
fileModified = null;
await refresh();

console.log('\n== how BIRD chose a route ==');
const firstPrefix = (await page.locator('.routes-table .link-prefix').first().innerText()).trim();
const pathsForIt = await page.locator('.routes-table .link-prefix', { hasText: firstPrefix }).count();
await page.locator('.routes-table .link-prefix').first().click();
await page.waitForSelector('.fl-drawer.show');
check((await page.locator('.fl-drawer-title').innerText()).trim() === firstPrefix, 'a prefix opens the drawer for it', firstPrefix);
check(await page.locator('.bgp-why-item').count() >= pathsForIt && await page.locator('.bgp-why-item .badge', { hasText: 'Best' }).count() === 1, 'one card per route, exactly one of them Best', `${await page.locator('.bgp-why-item').count()} cards, ${pathsForIt} paths`);
check(/Lost on|equal-cost next hop|only route/.test(await page.locator('.bgp-why-list').innerText()), 'every card says why', await page.locator('.bgp-why-list').innerText());
check(await page.evaluate(() => { const d = document.querySelector('.fl-drawer-body'); return d.scrollWidth <= d.clientWidth + 1; }) && await page.locator('.bgp-why').first().isVisible(), 'the explanation fits the drawer without sideways scrolling');
await page.keyboard.press('Escape');
check(await page.locator('.fl-drawer').count() === 0, 'Escape closes the drawer');

console.log('\n== peer actions (answered by the test, never sent to the router) ==');
check(await page.locator('#bgp-azure_xfrm0-restart').isVisible() && await page.locator('#bgp-azure_xfrm0-refresh_in').isEnabled() && await page.locator('#bgp-azure_xfrm0-enable').count() === 0, 'an Established peer offers refresh, restart and disable, not enable');
await page.click('#bgp-azure_xfrm0-restart');
await page.waitForSelector('dialog[open]');
check(/Restart azure_xfrm0\?/.test(await page.locator('dialog[open]').innerText()) && /routes learned from this peer are withdrawn/.test(await page.locator('dialog[open]').innerText()) && actions.length === 0, 'Restart asks first and says what it will do; nothing is sent yet');
await page.click('#bgp-act-cancel');
check(await page.locator('dialog[open]').count() === 0 && actions.length === 0, 'Cancel sends nothing');
await page.click('#bgp-azure_xfrm0-restart');
await page.click('#bgp-act-go');
await page.waitForSelector('#bgp-act-outcome');
check(JSON.stringify(actions) === JSON.stringify([{ name: 'azure_xfrm0', action: 'restart' }]) && /Restart: done/.test(await page.locator('#bgp-act-outcome').innerText()), 'confirming sends exactly one action and shows BIRD\'s answer', JSON.stringify(actions));
await page.click('#bgp-act-close');
actionReply = { name: 'azure_xfrm1', action: 'refresh_in', ok: false, output: '', error: 'BIRD has no BGP protocol of that name.' };
await page.click('#bgp-azure_xfrm1-refresh_in');
await page.click('#bgp-act-go');
await page.waitForSelector('#bgp-act-outcome');
check(/failed/.test(await page.locator('#bgp-act-outcome').innerText()) && /no BGP protocol of that name/.test(await page.locator('#bgp-act-outcome').innerText()), 'a refused action shows the error', await page.locator('#bgp-act-outcome').innerText());
await page.click('#bgp-act-close');
actionReply = null;
actions.length = 0;

// A protocol that was disabled: no session, so only Enable is offered; and a session that is not Established cannot refresh.
const disabled = clone(base);
Object.assign(disabled.peers.find(p => p.name === 'azure_xfrm2'), { protocol_state: 'down', state: '', hold_timer: null, keepalive_timer: null, local_caps: [], neighbor_caps: [] });
Object.assign(disabled.peers.find(p => p.name === 'azure_xfrm3'), { state: 'Active', protocol_state: 'start' });
await stage('a disabled protocol and a session that is Active', disabled);
check(await page.locator('#bgp-azure_xfrm2-enable').isVisible() && await page.locator('#bgp-azure_xfrm2-restart').count() === 0 && await page.locator('#bgp-azure_xfrm2-disable').count() === 0, 'a disabled protocol offers only Enable');
check(await page.locator('#bgp-azure_xfrm3-refresh_in').isDisabled() && await page.locator('#bgp-azure_xfrm3-restart').isEnabled(), 'a session that is not Established cannot refresh but can restart');
await page.click('#bgp-azure_xfrm2-enable');
await page.click('#bgp-act-go');
await page.waitForSelector('#bgp-act-outcome');
check(JSON.stringify(actions) === JSON.stringify([{ name: 'azure_xfrm2', action: 'enable' }]), 'Enable sends the enable action', JSON.stringify(actions));
await page.click('#bgp-act-close');
current = null;
await refresh();

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
check(await page.locator('#bgp-flow .flow-table').count() === 2 && await page.locator('#bgp-flow .flow-table', { hasText: 'master6' }).count() === 1, 'the diagram shows master6 as a second routing table');
const chips = await page.locator('.bgp-node.router .alg-chip').allInnerTexts();
check(chips.includes('2001:db8:f00d::/48') && chips.includes('192.168.0.0/16'), 'router node announces both IPv4 and IPv6 prefixes', chips.join());

await stage('announcements change', scenario('announce'));
const chips2 = await page.locator('.bgp-node.router .alg-chip').allInnerTexts();
check(chips2.includes('10.0.0.12/32') && chips2.includes('192.168.50.0/24') && chips2.includes('192.168.0.0/16'), 'router node follows announcements from direct and ospf protocols too', chips2.join());
const matrixRows = await page.locator('.card', { hasText: 'Announced routes' }).locator('tbody tr').first().innerText();
check(await page.locator('.card', { hasText: 'Announced routes' }).locator('thead th').count() >= 6, 'matrix has a column per peer');
const exportRows = page.locator('.card', { hasText: 'Announced routes' }).locator('table', { hasText: 'Announced now' }).locator('tbody tr');
check(await exportRows.count() === 8 || await exportRows.count() === 4 || await exportRows.count() === 5, 'one row per peer in the export filter results', String(await exportRows.count()));
const nowValues = await exportRows.evaluateAll(trs => trs.map(tr => tr.children[2].textContent.trim()));
const exportedNow = scenario('announce').peers.map(p => String(p.channels[0].routes.exported));
check(JSON.stringify(nowValues) === JSON.stringify(exportedNow), '"Announced now" is the number of routes each peer is sent, not a counter', `${nowValues} vs ${exportedNow}`);
check(/each session has its own age/.test(await page.locator('#bgp-export-note').innerText()) && await page.locator('.card', { hasText: 'Announced routes' }).locator('th[title]', { hasText: 'Accepted' }).count() === 1, 'a note and the heading tooltips say that the other columns count updates since the session came up');
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
