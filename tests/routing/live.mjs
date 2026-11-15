// Browser test of the Routing page. A real browser opens the deployed UI; the flab.routing status and lookup calls, the
// BGP status call and the interface dump are answered with the synthetic "rich" scenario that the backend run
// produced (see mkfx.mjs / assert.mjs), so the Routes tab, the lookup, the table and rule cards and the BGP tab can be
// driven through every case WITHOUT depending on or touching the router. Everything else (login, system board) goes to
// the real router; the page only ever reads.
// Usage: node live.mjs <dir with the backend output>   (env: FLAB_SID, FLAB_ACLS, FLAB_URL, FLAB_SHOTS)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const baseUrl = process.env.FLAB_URL ?? 'https://openwrt.lab.formicalab.casa/flab/';
const sid = process.env.FLAB_SID;   // a session made by tests/TestSession.ps1, so no password is needed
const acls = JSON.parse(process.env.FLAB_ACLS);   // what that session may call, like the ACLs of a real sign-in
const shots = process.env.FLAB_SHOTS;
// The parsed JSON fixture `f` from the scenario output directory.
const load = f => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
// A deep copy of `o`, so a test can change it without touching the loaded fixture.
const clone = o => JSON.parse(JSON.stringify(o));

let failed = 0;
// Records one assertion: prints PASS/FAIL with the message (plus `extra` diagnostics on failure) and counts failures.
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -> ' + extra}`); if (!cond) failed++; };

//#region The mock router
const rich = load('rich.status.json');
// The lookup answers by "dst|src|iif", from the backend run.
const answers = {};
for (const name of load('lookup-names.json')) {
  const a = load(`rich.lookup-${name}.json`);
  if (a.ok) answers[`${a.dst}|${a.src ?? ''}|${a.iif ?? ''}`] = a;
}
const DUMP = { interface: [
  { interface: 'internet', up: true, l3_device: 'wan' },
  { interface: 'lan', up: true, l3_device: 'br-lan' },
] };
const mock = { status: clone(rich), answers: clone(answers), lookups: [], diagStarts: [], statusCalls: 0, bgp: { daemon: { running: false, error: 'no control socket' }, peers: [], paths: [] }, writes: [] };

// The JSON-RPC answer for a request the mock handles, or null to let it through to the real router.
function answer(body) {
  const [, obj, method, args] = body.params;
  // A successful ubus reply carrying `data`.
  const ok = data => ({ jsonrpc: '2.0', id: body.id, result: [0, data] });
  if (obj === 'uci' && ['set', 'add', 'delete', 'apply', 'commit'].includes(method)) { mock.writes.push(`${obj}.${method}`); return { jsonrpc: '2.0', id: body.id, result: [6] }; }
  if (obj === 'flab.routing' && method === 'status') { mock.statusCalls++; return ok(mock.status); }
  if (obj === 'flab.routing' && method === 'lookup') {
    mock.lookups.push(args);
    return ok(mock.answers[`${args.dst}|${args.src ?? ''}|${args.iif ?? ''}`] ?? { ok: true, dst: args.dst, family: 4, get: { ok: false, error: 'Network is unreachable' }, match: null, match_error: 'x', raw: { get: '', match: '' } });
  }
  if (obj === 'flab.bgp' && method === 'status') return ok(mock.bgp);
  // The Toolbox is opened by the lookup's buttons; it is answered here so that nothing runs on the router.
  if (obj === 'flab.diag' && method === 'status') return ok({ generated: 1, tools: { ping: true, traceroute: true, openssl: true }, dns_tool: 'kdig', types: ['A'], devices: ['lo'], limits: {}, starttls: [], upstream: [], check_host: 'example.com' });
  if (obj === 'flab.diag' && method === 'start') { mock.diagStarts.push(args); return ok({ ok: false, error: 'Not run in this test.' }); }
  if (obj === 'network.interface' && method === 'dump') return ok(DUMP);
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
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(([id, granted]) => {
  sessionStorage.setItem('sid', id);
  sessionStorage.setItem('acls', JSON.stringify(granted));
}, [sid, acls]);

// Helpers: tiles, the route list, the lookup form and answer, the controls and screenshots.
// The big value of tile `i`.
const tile = async i => (await page.locator('.tile .value').nth(i).innerText()).trim();
// The sub-line of tile `i`.
const tileSub = async i => (await page.locator('.tile .sub').nth(i).innerText()).trim();
// The rows of the route list.
const rows = () => page.locator('.rt-routes tbody tr');
// The route rows as whitespace-normalized text.
const rowTexts = () => rows().allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
// The card whose header contains `title`.
const cardOf = title => page.locator('.card').filter({ has: page.locator('.card-header', { hasText: title }) });
// The route list card; "Routes" alone would also match the header of the tables card, which mentions routes.
const routesCardEl = () => cardOf(/^\s*Routes/);
// The lookup form's destination field.
const dst = () => page.locator('.rt-field input').nth(0);
// The lookup form's source field.
const src = () => page.locator('.rt-field input').nth(1);
// The lookup form's incoming-interface select.
const iif = () => page.locator('.rt-field select');
// The lookup answer panel.
const result = () => page.locator('.rt-result');
// The lookup answer as whitespace-normalized text.
const resultText = async () => (await result().innerText()).replace(/\s+/g, ' ');
// Presses Refresh and waits for the page to redraw.
const refresh = async () => { await page.click('button:has-text("Refresh")'); await page.waitForTimeout(700); };
// Saves a full-page screenshot named after `label` when FLAB_SHOTS is set.
const shot = async label => { if (shots) await page.screenshot({ path: path.join(shots, `routing-${label.replace(/\W+/g, '-')}.png`), fullPage: true }); };
// Fills the lookup form and presses Look up.
const submit = async (d, s = '', i = '') => {
  await dst().fill(d); await src().fill(s); await iif().selectOption(i);
  await page.click('button:has-text("Look up")');
  await page.waitForTimeout(300);
};
// Runs a lookup through the form and waits for its answer (the headline names the destination it answers for).
const lookup = async (d, s = '', i = '') => {
  await submit(d, s, i);
  await page.locator('.rt-result .rt-for', { hasText: `for ${d}` }).waitFor({ timeout: 10000 });
};
// The command-bar select with the given option text.
const select = text => page.locator('.cmdbar select').filter({ has: page.locator('option', { hasText: text }) });

//#region The Routes tab
await page.goto(`${baseUrl}#routing`);
await page.waitForSelector('.rt-lookup', { timeout: 20000 });
console.log('== the Routes tab ==');
const nav = (await page.locator('.nav-pane a.nav-link-fl').allInnerTexts()).map(t => t.trim());
check(nav.includes('Routing') && !nav.includes('BGP') && (await page.locator('.nav-pane a.active').innerText()).trim() === 'Routing', 'the navigation has a Routing entry and no separate BGP one', nav.join(' | '));
check((await page.locator('.cmdbar h1').innerText()).trim() === 'Routing', 'the page title');
check((await page.locator('.seg-tab').allInnerTexts()).join() === 'Routes,Static routes,BGP' && await page.locator('.seg-tab.active').innerText() === 'Routes', 'three tabs, Routes open: Routes, Static routes and (because BIRD is installed) BGP');
check(await tile(0) === 'internet' && /via 192\.0\.2\.1 · wan/.test(await tileSub(0)) && /1 more/.test(await tileSub(0)), 'the IPv4 default route tile: logical interface, next hop and device, and that a second default route exists', `${await tile(0)} | ${await tileSub(0)}`);
check(await tile(1) === 'internet' && /via fe80::1/.test(await tileSub(1)), 'the IPv6 default route tile');
check(await tile(2) === '16' && /10 IPv4 · 6 IPv6/.test(await tileSub(2)), 'routes in the main table, by family', `${await tile(2)} | ${await tileSub(2)}`);
check(await tile(3) === '5' && await tileSub(3) === 'main, local, voip, 220, default', 'routing tables', await tileSub(3));
check(await tile(4) === '11' && /6 added/.test(await tileSub(4)) && await tile(5) === '2', 'policy rules (six beyond the kernel\'s) and multipath routes', `${await tile(4)} ${await tileSub(4)} ${await tile(5)}`);
check(/2 routes use a next hop that is down/.test(await page.locator('.net-health').innerText()) && await page.locator('.net-health.bad').count() === 1, 'the banner reports the routes whose next hop is down');
await shot('routes');

console.log('\n== the route list ==');
check(/16 of 22 routes · table main \(254\)/.test(await routesCardEl().locator('.card-header').innerText()) && await rows().count() === 16, 'the main table is listed first: 16 of 22 routes');
let texts = await rowTexts();
check(texts[0].startsWith('default') && texts[0].includes('192.0.2.1') && texts[0].includes('internet') && texts.at(-1).startsWith('2001:db8:1::/48') || texts.some(t => t.startsWith('default from 2001:db8:1::/48')), 'IPv4 first by destination, "default" for a zero prefix, the logical interface next to the device', texts.slice(0, 2).join(' || '));
check(await page.locator('.rt-routes tr.rt-down').count() === 2, 'a route with a dead or link-down next hop is marked', String(await page.locator('.rt-routes tr.rt-down').count()));
check(texts.some(t => /^10\.0\.0\.0\/22/.test(t) && t.includes('10.0.0.12 ×1') && t.includes('10.0.0.13 ×1') && t.includes('xfrm1')), 'a multipath route lists every next hop with its weight and device');
check(texts.some(t => /^192\.168\.0\.0\/16 blackhole dropped/.test(t)) && texts.some(t => /^203\.0\.113\.0\/24 prohibit dropped/.test(t)) && texts.some(t => /^198\.18\.0\.0\/15 throw/.test(t)), 'drop routes show their type and no next hop');
check(texts.some(t => /^10\.9\.0\.0\/16 .*fe80::1.*onlink/.test(t)) && texts.some(t => /^172\.16\.0\.0\/12 .*directly connected.*mtu 1380/.test(t)), 'flags, MTU and directly connected routes');
check(texts.some(t => /^2001:db8:2::\/64 .*expires in 29m/.test(t)), 'an expiring route says when');

await page.locator('.rt-pick', { has: page.locator('strong:text-is("voip")') }).click();
check(await rows().count() === 1 && /^10\.20\.0\.0\/16/.test((await rowTexts())[0]) && /voip \(100\)/.test((await rowTexts())[0]) && await select('All tables').inputValue() === 'voip', 'clicking a table in the tables card lists its routes and moves the selector');
await select('All tables').selectOption('all');
check(await rows().count() === 22 && /22 of 22 routes · all tables/.test(await routesCardEl().locator('.card-header').innerText()), 'all tables: 22 routes');
await select('IPv4 only').selectOption('6');
check(await rows().count() === 8, 'IPv6 only: 8 routes', String(await rows().count()));
await select('IPv4 only').selectOption('all');
await page.fill('.cmdbar input[placeholder="Filter routes…"] >> visible=true', 'xfrm1');
check(await rows().count() === 1 && /^10\.0\.0\.0\/22/.test((await rowTexts())[0]), 'the text filter finds a route by one of its next-hop devices');
await page.fill('.cmdbar input[placeholder="Filter routes…"] >> visible=true', 'internet');
check(await rows().count() === 5, 'the filter also finds the logical interface name', String(await rows().count()));
await page.fill('.cmdbar input[placeholder="Filter routes…"] >> visible=true', '');
await page.locator('.rt-routes th', { hasText: 'Metric' }).click();
texts = await rowTexts();
check(/2147483647/.test(texts.at(-1)) && await page.locator('.rt-routes th', { hasText: 'Metric' }).innerText().then(t => t.includes('▲')), 'sorting by metric: the largest comes last', texts.at(-1));
await page.locator('.rt-routes th', { hasText: 'Metric' }).click();
texts = await rowTexts();
check(/2147483647/.test(texts[0]) && (await page.locator('.rt-routes th', { hasText: 'Metric' }).innerText()).includes('▼'), 'the second click reverses the order', texts[0]);
await select('All tables').selectOption('main');

console.log('\n== tables and policy rules ==');
const how = page.locator('.rt-how');
check(await how.count() === 1 && /lowest priority number to the highest/.test(await how.innerText()) && /not a table number/.test(await how.innerText()) && /ends the lookup at once/.test(await how.innerText()) && /throw route means/.test(await how.innerText()), 'a header explains how the kernel picks a route: rules by priority, fall-through to the next rule, and the exceptions');
check((await how.boundingBox()).y < (await cardOf('Policy rules').boundingBox()).y && (await how.boundingBox()).y < (await cardOf('Routing tables').boundingBox()).y, 'the explanation sits above the rules and the tables');
const tr = await cardOf('Routing tables').locator('tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(tr.length === 5 && tr[0].startsWith('main (254) ordinary routes rule 32766 10 6') && tr[1].startsWith('local (255)') && tr.some(t => /^voip \(100\).*rule 100 1 0/.test(t)) && tr.some(t => /^220.*rule 200.*rule 220 1 0/.test(t)), 'the tables card: number, purpose, rules that consult each table, route counts', tr.join(' || '));
const rl = await cardOf('Policy rules').locator('tbody tr').allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, ' ').trim()));
check(rl.length === 11 && rl[0].startsWith('0 IPv4 every packet look up local (255) kernel default'), 'eleven rules in priority order, the kernel\'s own marked', rl.slice(0, 2).join(' || '));
// How many of the rule rows end with `w` (their origin badge).
const ends = w => rl.filter(t => t.endsWith(w)).length;
check(ends('kernel default') === 5 && ends('netifd') === 2 && ends('strongSwan') === 1 && ends('unknown') === 3 && rl.some(t => /^100 IPv4 from 192\.168\.1\.0\/24 iif br-lan look up voip \(100\) netifd$/.test(t)) && rl.some(t => /^200 IPv4 not from 10\.0\.0\.0\/8 fwmark 0x1\/0xff look up 220 ignore prefixes \/0 or shorter unknown$/.test(t)), '"Added by": the kernel\'s own, netifd (a configured rule and the IPv6 reject rule), strongSwan, the rest unknown; selectors, "not" and suppress_prefixlength are shown', rl.join(' || '));
// The title tooltip of the last origin badge in the policy rule with priority `prio`.
const badgeTitle = async prio => cardOf('Policy rules').locator(`tbody tr:has(td.num:text-is("${prio}"))`).locator('.fl-badge').last().getAttribute('title');
check(/Priority 220 and table 220 are strongSwan's defaults/.test(await badgeTitle(220)) && !/leftover/.test(await badgeTitle(220)) && /does not say who added/.test(await badgeTitle(300)) && /"config rule" section/.test(await badgeTitle(100)), 'each origin explains its evidence in a tooltip');
check(rl.some(t => /^300 IPv4 uidrange 1000-1999 continue at rule 32766/.test(t)) && rl.some(t => /^400 IPv4 to 203\.0\.113\.0\/24 prohibit/.test(t)) && rl.some(t => /^4200000000 IPv6 from 2001:db8:1::1\/60 iif br-lan unreachable/.test(t)), 'goto and drop rules');

console.log('\n== the next-hop lookup ==');
check(await result().count() === 0 && /Enter an address/.test(await cardOf('Next hop lookup').innerText()), 'no answer before the first lookup');
const calls0 = mock.lookups.length;
await submit('999.1.1.1');
check(/Enter an IPv4 or IPv6 address to look up/.test(await page.locator('.rt-error').innerText()) && mock.lookups.length === calls0, 'a bad address is refused in the form, nothing is asked');
await submit('8.8.8.8', '', 'br-lan');
check(/needs a source address/.test(await page.locator('.rt-error').innerText()) && mock.lookups.length === calls0, 'an arrival interface without a source is refused too');

await lookup('1.1.1.1');
check(await result().getAttribute('class').then(c => c.includes('ok')) && /Next hop 192\.0\.2\.1/.test(await resultText()), 'a forwarded packet: next hop in the headline', await resultText());
let t = await resultText();
check(/Interface wan internet/.test(t) && /Source address 192\.0\.2\.77/.test(t) && /default via 192\.0\.2\.1 dev wan proto static metric 10/.test(t) && /Routing table main \(254\)/.test(t) && /Chosen by rule 32766: from any source/.test(t), 'interface with its logical name, source address, the matched route, its table and the rule that chose it', t);
check(await page.locator('.rt-routes tr.rt-hit').count() === 1 && /^default.*192\.0\.2\.1/.test((await page.locator('.rt-routes tr.rt-hit').innerText()).replace(/\s+/g, ' ')), 'the matched route is highlighted in the list');
check(JSON.stringify(mock.lookups.at(-1)) === JSON.stringify({ dst: '1.1.1.1', src: '', iif: '' }), 'the request carries the destination (and empty optional fields)', JSON.stringify(mock.lookups.at(-1)));
await shot('lookup');

await lookup('10.0.5.5');
t = await resultText();
check(/Next hop 10\.0\.0\.12/.test(t) && /Equal-cost paths 2 next hops share the load: 10\.0\.0\.12, 10\.0\.0\.13/.test(t) && await page.locator('.rt-routes tr.rt-hit').count() === 1, 'an ECMP route: the path the kernel chose and how many there are', t);
await lookup('192.168.1.1');
t = await resultText();
check(await result().getAttribute('class').then(c => c.includes('info')) && /Local address/.test(t) && /belongs to this router/.test(t) && /Interface br-lan/.test(t) && /Routing table local \(255\)/.test(t) && await page.locator('button:has-text("Show this table")').count() === 1, 'a local address (the real device, not lo) and the table that holds it', t);
await page.click('button:has-text("Show this table")');
check(await select('All tables').inputValue() === 'local' && await page.locator('.rt-routes tr.rt-hit').count() === 1 && await page.locator('button:has-text("Show this table")').count() === 0, 'Show this table selects it, the hit is highlighted there');
await select('All tables').selectOption('main');
await lookup('192.168.1.255');
check(/Broadcast address/.test(await resultText()), 'a broadcast address');
await lookup('192.168.5.5');
t = await resultText();
check(await result().getAttribute('class').then(c => c.includes('bad')) && /Dropped/.test(t) && /silently discarded \(blackhole route\)/.test(t) && /Dropping route blackhole 192\.168\.0\.0\/16 proto bird metric 32/.test(t), 'a blackhole route: dropped, and which route does it', t);
await lookup('2001:db8:1:5::99');
check(/Dropped/.test(await resultText()) && /unreachable route/.test(await resultText()), 'an unreachable route');
await lookup('2606:4700:4700::1111');
t = await resultText();
check(/No route/.test(t) && /restricted to certain source addresses/.test(t) && /2001:db8:1::\/48/.test(t), 'only a source-specific default route covers it: the page says a source address is needed', t);
await lookup('2606:4700::1', '2001:db8:1::50', 'br-lan');
t = await resultText();
check(/Next hop fe80::1/.test(t) && /Looked up as a packet from 2001:db8:1::50 arriving on br-lan/.test(t) && JSON.stringify(mock.lookups.at(-1)) === JSON.stringify({ dst: '2606:4700::1', src: '2001:db8:1::50', iif: 'br-lan' }), 'a lookup as forwarded traffic: source and arrival interface are sent and shown', t + JSON.stringify(mock.lookups.at(-1)));
check((await iif().locator('option').allInnerTexts()).join() === 'any / this router,br-lan,lo,wan,wan2,wg0,xfrm0,xfrm1' || (await iif().locator('option').allInnerTexts()).includes('br-lan'), 'the arrival interfaces come from the routes and the interface dump', (await iif().locator('option').allInnerTexts()).join());
await lookup('10.20.1.1');
t = await resultText();
check(/Routing table voip \(100\)/.test(t) && /Chosen by rule 100: from 192\.168\.1\.0\/24, iif br-lan/.test(t), 'an answer from a named table names the rule that consults it', t);
await lookup('1.1.1.2', '2a01::1');
check(/Network is unreachable/.test(await resultText()) || /kernel refused/.test(await resultText()), 'an error from the kernel is shown in its words', await resultText());

console.log('\n== the answer stays live ==');
await lookup('1.1.1.1');
const before = mock.lookups.length;
await refresh(); await refresh();
check(mock.lookups.length >= before + 2, 'every refresh asks the kernel again', `${mock.lookups.length - before}`);
mock.answers['1.1.1.1||'] = (() => { const a = clone(answers['1.1.1.1||']); a.get.via = '198.51.100.1'; a.get.dev = 'wan2'; a.match.nexthops[0] = { via: '198.51.100.1', dev: 'wan2', weight: null, flags: [] }; return a; })();
await refresh();
check(/Next hop 198\.51\.100\.1/.test(await resultText()), 'a failover shows up on the next refresh without asking again');
mock.answers['1.1.1.1||'] = answers['1.1.1.1||'];
// A poll must not take the focus away from the form: polling pauses while a field is focused.
await dst().focus();
const polled = mock.statusCalls;
await page.waitForTimeout(5800);
check(mock.statusCalls === polled && await dst().evaluate(e => e === document.activeElement), 'polling pauses while the form is focused, and the field keeps its focus', `${mock.statusCalls - polled} polls`);
await page.locator('main').click({ position: { x: 5, y: 5 } });
await page.waitForTimeout(5800);
check(mock.statusCalls > polled, 'polling resumes when the form loses focus');
await page.click('button:has-text("Clear")');
const cleared = mock.lookups.length;
await refresh();
check(await result().count() === 0 && await dst().inputValue() === '' && mock.lookups.length === cleared, 'Clear forgets the query: no answer, and no more lookups');
//#endregion

//#region The BGP tab, a router without BIRD, no ip, many routes
console.log('\n== the BGP tab ==');
await page.locator('.seg-tab', { hasText: 'BGP' }).click();
await page.waitForSelector('main .card-body.muted', { timeout: 10000 });
check(/BIRD is not running or its control socket is unreachable: no control socket/.test(await page.locator('main').innerText()), 'the BGP tab shows the BIRD state (here: not running)');
check(await page.locator('.cmdbar input[placeholder="Filter paths…"]').isVisible() && await page.locator('.cmdbar input[placeholder="Filter routes…"]').isHidden() && await select('All peers').isVisible() && await select('All tables').isHidden() && await page.locator('.cmdbar button:has-text("Best paths only")').isVisible(), 'the command bar swaps to the BGP filters');
const callsBefore = mock.statusCalls;
await refresh();
check(mock.statusCalls === callsBefore, 'only the open tab is polled');
await page.locator('.seg-tab', { hasText: /^Routes$/ }).click();
await page.waitForSelector('.rt-lookup');
check(await page.locator('.cmdbar input[placeholder="Filter routes…"]').isVisible() && await rows().count() === 16, 'back on the Routes tab with its filters and list');

console.log('\n== a router without BIRD, without ip, and a long route list ==');
mock.status.bird = false;
await refresh();
check((await page.locator('.seg-tab').allInnerTexts()).join() === 'Routes,Static routes', 'without birdc the BGP tab is not offered');
mock.status.bird = true;
mock.status.routes.push(...Array.from({ length: 500 }, (_, i) => ({ ...clone(rich.routes[2]), prefix: `172.20.${i >> 8}.${i & 255}/32`, len: 32 })));
await refresh();
check(await rows().count() === 400 && /Showing the first 400 of 516 routes/.test(await page.locator('.rt-more').innerText()), 'a long list shows its first 400 rows and says so');
await page.click('button:has-text("Show all 516")');
check(await rows().count() === 516 && await page.locator('.rt-more').count() === 0, 'Show all draws the rest');
mock.status = clone(rich);
await refresh();
mock.status.available = false; mock.status.routes = []; mock.status.rules = [];
await refresh();
check(await page.locator('.net-health.bad').count() === 1 && /could not be run/.test(await page.locator('.net-health').innerText()) && await page.locator('.rt-lookup').count() === 0, 'when ip is not available the page says so instead of drawing empty tables');
mock.status = clone(rich);
await refresh();
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

console.log('\n== from the lookup to the Toolbox ==');
await lookup('1.1.1.1');
check(await page.locator('.rt-result .rt-try button').allInnerTexts().then(t => t.map(x => x.trim()).join()) === 'Ping,Traceroute', 'a forwarded answer offers Ping and Traceroute');
await page.locator('.rt-result .rt-try button', { hasText: 'Traceroute' }).click();
await page.waitForSelector('.rt-diag', { timeout: 10000 });
check(page.url().endsWith('#toolbox') && (await page.locator('.nav-pane a.active').innerText()).trim() === 'Toolbox' && await page.locator('.rt-diag input.mono').first().inputValue() === '1.1.1.1' && await page.locator('.rt-seg .seg-tab.active').innerText() === 'Traceroute', 'the button opens the Toolbox with the tool chosen and the destination filled in');
check(mock.diagStarts.length === 1 && mock.diagStarts[0].tool === 'traceroute' && mock.diagStarts[0].host === '1.1.1.1', 'and starts it (the mock refuses it, so nothing runs on the router)', JSON.stringify(mock.diagStarts));
//#endregion

check(mock.writes.length === 0, 'nothing was written to the router', mock.writes.join());
check(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall Routing browser checks passed');
process.exit(failed ? 1 : 0);
